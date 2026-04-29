# GitHub Issues → Paperclip Integration

## Context

Today, GlitchTip aggregates errors by trace fingerprint and creates a single GitHub issue per fingerprint, updating it (comments / edits) when the same trace recurs. When the GitHub issue is closed, GlitchTip resolves the corresponding event via webhook. GitHub is the source of truth for issue state.

We want to extend that pipeline so the Paperclip control plane participates in triage and development:

1. New GitHub issue → Paperclip task is created automatically with a triage analysis.
2. Updates / comments on the GitHub issue → existing Paperclip task is updated only when the delta carries new information.
3. A human approves the task → a coding agent develops a fix on a branch and opens a draft PR.
4. Human reviews and merges the PR → the GitHub issue closes (`Closes #N` or manual) → the Paperclip task is marked `done` → GlitchTip resolves (existing flow, untouched).

The design has two automatic boundaries (mirror/triage and closure) and two human gates (approve the analysis, review the PR). The coding agent is never dispatched without explicit human approval.

This spec covers the wiring: webhooks, routines, agents, linking convention, and the lifecycle. It does not cover the agent prompts themselves (those live in `AGENT.md` files when the agents are created).

---

## 1. External boundary

### 1.1 GitHub webhook configuration (per repo)

Each repo connected to the integration registers **one webhook** in GitHub repo settings:

| Webhook | Events | Target URL |
|---|---|---|
| `paperclip-watcher` | `Issues`, `Issue comments` | `https://paper.simplafy.com.br/api/routine-triggers/public/{watcherPublicId}/fire` |

Configuration:
- Content type: `application/json`
- Secret: the HMAC secret of the Paperclip routine trigger
- SSL verification: enabled

GitHub webhooks filter by event type (`Issues`, `Issue comments`), not by sub-action (`opened`, `edited`, `closed`). The single routine therefore receives every action and the analyzer agent dispatches on `payload.action`:

| `payload.action` | Handler (see §4) |
|---|---|
| `opened` | §4.1 — create task |
| `edited`, plus any `issue_comment.created` | §4.2 — update task |
| `closed` | §4.5 — close task |
| anything else (`labeled`, `assigned`, `pinned`, …) | ignore |

### 1.2 Filter — `agent-eligible` label

Only GitHub issues carrying the label `agent-eligible` are processed. The watcher routine fires for every event from GitHub (label filtering at the GitHub side is not granular enough), and the **analyzer agent** drops payloads whose `issue.labels` do not include `agent-eligible`.

This is a soft gate, not a hard block. It exists so that:
- spam / questions / issues outside the agent's scope can be created freely on GitHub;
- a human curator promotes an issue into the pipeline by adding the label;
- GlitchTip-generated issues can carry the label automatically (configurable on the GlitchTip side).

---

## 2. Paperclip components

### 2.1 Per-repo resources

For each connected repo, the integration provisions:

| Resource | Notes |
|---|---|
| **Project** | Workspace pinned to `repoUrl`, default `repoRef` (typically `main`), `isPrimary: true` |
| **Routine `gh-issue-watcher-<repo-slug>`** | Webhook trigger, `signingMode: github_hmac`. Assignee: `gh-analyzer` agent. Project: the per-repo project. Handles `opened`, `edited`, `closed`, and `issue_comment.created`. |

Each repo's routine has its own HMAC secret. Rotating one repo does not affect the others.

### 2.2 Global resources (created once)

| Resource | Notes |
|---|---|
| **Agent `gh-analyzer`** | Model: Haiku 4.5. Adapter: `process` or `http` (lightweight — does not need a code workspace). Tools: read run payload, search Paperclip issues, create issue, comment on issue, update issue. |
| **Agent `gh-codador`** | Model: Sonnet 4.6 / Opus 4.7. Adapter: `claude_local` (or `openclaw`). Full code execution in the project workspace. |
| **Secret `paperclip/github-token`** | GitHub PAT with `contents:write`, `pull_requests:write`, `issues:write` scopes. Used by the codador to push branches and open PRs. |

The same `gh-analyzer` and `gh-codador` agents serve every connected repo. Routines carry the `projectId`, so context is scoped per run.

---

## 3. Linking convention

Every Paperclip issue created by the integration includes a marker in its `description`:

```html
<!-- gh-ref: simplafy/some-repo#123 -->
```

Rules:
- The marker is the **first non-empty line** of the description.
- The format is exact: `<!-- gh-ref: {repository.full_name}#{issue.number} -->`.
- The analyzer searches for tasks by querying issues in the project and filtering descriptions for the marker (substring match).
- The marker is preserved across edits (the analyzer never rewrites the first line; updates go through comments).

Why HTML comment instead of a structured field: it survives the existing markdown rendering, it is searchable through the standard issues API, it is exported by `paperclipai company export`, and it does not require a Paperclip schema change.

---

## 4. Data flow

### 4.1 New issue

```
GitHub: issues.opened (label "agent-eligible")
  → POST /api/routine-triggers/public/{watcherPublicId}/fire
    Header: X-Hub-Signature-256
  → Paperclip validates HMAC (signingMode: github_hmac)
  → Routine fires run on gh-analyzer
  → analyzer:
      filter: labels include "agent-eligible"  → continue
      gh_ref = "simplafy/some-repo#123"
      task = search by marker in projectId → none
      create issue:
        title: "[gh#123] {issue.title}"
        description: "<!-- gh-ref: ... -->\n\n## Análise\n{triage summary}\n\n## Original\n{issue.body}"
        status: todo
        priority: derived from issue.labels (e.g. "bug" → high)
```

### 4.2 Issue update (edit or comment)

```
GitHub: issues.edited | issue_comment.created
  → same webhook as 4.1
  → analyzer:
      gh_ref = "..."
      task = search by marker → found
      if action == "edited":
        delta = diff(payload.changes, task.description)
      if action == "issue_comment.created":
        delta = payload.comment.body
      if delta empty or trivial (e.g. typo, label-only change):
        return  // economy of tokens
      else:
        comment on task: "GH update ({timestamp}, by @{author}): {delta summary}"
```

The analyzer **never edits the task description** after creation. All updates are comments. This preserves the codador's working context if the task is already `in_progress`.

### 4.3 Approval (manual)

The human reviews the analyzer's task in the Paperclip UI. To approve, they:
1. Set `assigneeAgentId = gh-codador`.
2. Transition `status: todo → in_progress`.

The status change wakes the codador (standard heartbeat behavior). No `request_confirmation` interaction — the status transition itself is the gate.

### 4.4 Development (automatic, gated by approval)

The codador runs in an isolated execution workspace (per-issue branch). Standard Paperclip behavior:
- Reads the task and the linked workspace.
- Creates a branch (e.g. `agent/gh-123-fix-foo`).
- Edits, runs tests, commits.
- Opens a **draft PR** referencing the issue: body includes `Closes #123`.
- Comments on the Paperclip task with the PR URL.
- Transitions task to `in_review`.

Implementation detail of the codador (branch naming, PR template, etc.) is part of its `AGENT.md`, not this spec.

### 4.5 Closure

```
GitHub: issues.closed (triggered by PR merge with Closes #N, or manual close)
  → same webhook as 4.1
  → routine fires run on gh-analyzer
  → analyzer:
      gh_ref = "..."
      task = search by marker
      if not task: return
      if task.status == "done": return  // idempotent
      patch task: status=done, comment="Closed via GH issue close ({reason})"
```

GlitchTip resolution happens through the existing GitHub → GlitchTip webhook and is unaffected by Paperclip.

---

## 5. Idempotency and error handling

| Scenario | Behavior |
|---|---|
| Same `issues.opened` delivered twice (GitHub retry) | Second delivery: analyzer finds existing task by marker → returns. No duplicate. |
| Issue edited many times in a short window | Each update is its own analyzer run. Trivial deltas return immediately (cheap call). |
| Analyzer fails mid-run | Routine run is recorded as `failed`. GitHub will retry on its own delivery schedule. Marker-based dedup ensures a successful retry does not duplicate. |
| Codador crashes during development | Standard Paperclip recovery via `expectedStatuses: ["in_progress"]` checkout. New run resumes. |
| `issues.closed` arrives before the corresponding `issues.opened` finished processing (rare reorder) | Closer branch finds no task and returns. The opened event, when processed, creates a task already-stale. The next `closed` event (or human close) reconciles. Acceptable. |
| HMAC mismatch | `401 Unauthorized` returned to GitHub. GitHub marks delivery as failed and retries. Operator rotates the secret. |
| Issue lacks `agent-eligible` label | Analyzer returns silently. Run logged but produces no side effect. |

Routine `concurrencyPolicy` for the watcher: `always_enqueue` (we want every event processed; the marker dedup handles duplication).

---

## 6. Setup checklist (per repo)

Order of operations to connect a new repo:

1. **In Paperclip** — create the project with `repoUrl` set.
2. **In Paperclip** — create routine `gh-issue-watcher-<slug>` with a webhook trigger using `signingMode: github_hmac`. Capture the `publicId` and the generated secret.
3. **In GitHub** — repo Settings → Webhooks → add `paperclip-watcher` (events: Issues, Issue comments) with the watcher URL and secret.
4. **In GitHub** — confirm the `agent-eligible` label exists in the repo (or create it).
5. **Smoke test** — create a test issue with the `agent-eligible` label; confirm the Paperclip task appears with the marker and analysis. Add a comment; confirm a comment appears on the Paperclip task. Close the GH issue; confirm the Paperclip task is `done`.

This checklist is the seed of an automation script (`scripts/connect-repo.ts`) but is out of scope for the first iteration — the manual flow is acceptable while we test with one repo.

---

## 7. Out of scope

- **Auto-merge.** The codador never merges its own PR. PR review and merge happen in GitHub by a human.
- **Auto-labeling on GitHub.** Adding the `agent-eligible` label is a human (or GlitchTip) decision.
- **Bidirectional comment sync.** Comments on the Paperclip task do not propagate back to GitHub. The Paperclip task is a working surface for the agents, not a mirror.
- **GlitchTip integration changes.** The GlitchTip ↔ GitHub bridge is unchanged. Paperclip is purely a downstream consumer of GitHub state.
- **Multi-org GitHub support.** All repos are assumed to belong to the same GitHub installation/PAT. Multi-org would require routing tokens by `repository.owner.login`.
- **Issue priority inference beyond labels.** We map a small set of labels to priority (e.g. `bug` → high, `enhancement` → medium). No LLM-based prioritization.
- **Provisioning script.** Setup is manual per the checklist in §6 for the first iteration.

---

## 8. Open questions for the implementation plan

These are not blockers for the spec but should be answered when writing the plan:

1. **Adapter for `gh-analyzer`** — `process` (a small Node script invoking Haiku via SDK) or `http` (a microservice)? `process` is lighter; `http` is more inspectable. Default: `process` unless we want a UI.
2. **Where does the analyzer's prompt live** — embedded in the agent's `AGENT.md`, or in a separate `prompts/gh-analyzer.md` referenced by it? Follow whatever pattern the existing agents use in this repo.
3. **Trivial-delta heuristic** — is "trivial" decided by the LLM (cheaper but ambiguous) or by simple rules (label-only changes, whitespace-only edits)? Default: simple rules first; LLM fallback only for content edits.
4. **Branch naming and PR template for the codador** — defined in the codador's `AGENT.md`. Spec only requires: branch is unique per issue and PR body contains `Closes #{issue.number}`.
