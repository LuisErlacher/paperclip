# Connect a GitHub repo to Paperclip

Per-repo manual setup. Automate with a CLI later (see spec §6 footnote).

## Prerequisites

- The two global agents exist: `gh-analyzer`, `gh-codador`. If not, run `scripts/gh-integration/ensure-agents.ts`.
- Operator has admin access to the GitHub repo.
- Operator has a Paperclip API key with `companyId` scope.
- Two Paperclip secrets exist for the company:
  - `paperclip/anthropic-api-key` — Anthropic API key used by the analyzer's Haiku call.
  - `paperclip/github-token` — GitHub PAT with `contents:write`, `pull_requests:write`, `issues:write`. Used by the codador to push branches and open draft PRs. Create via `POST /api/companies/$COMPANY_ID/secrets`.

## Steps

### 1. Create the project

```bash
curl -X POST $PAPERCLIP_API_URL/api/companies/$COMPANY_ID/projects \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "<repo-name>",
    "repoUrl": "https://github.com/<owner>/<repo>",
    "repoRef": "main",
    "isPrimary": true
  }'
```

Capture the returned `id` as `PROJECT_ID`.

### 2. Create the routine + webhook trigger

The routine description template embeds the GitHub payload so the analyzer can re-read it via `originRunId`.

```bash
ROUTINE_RES=$(curl -X POST $PAPERCLIP_API_URL/api/companies/$COMPANY_ID/routines \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d @- <<EOF
{
  "projectId": "$PROJECT_ID",
  "title": "gh-issue-watcher (\${{payload.repository.full_name}})",
  "description": "Trigger run from GitHub webhook. Action: \${{payload.action}}.",
  "assigneeAgentId": "$GH_ANALYZER_AGENT_ID",
  "priority": "medium",
  "concurrencyPolicy": "always_enqueue",
  "status": "active"
}
EOF
)
ROUTINE_ID=$(echo "$ROUTINE_RES" | jq -r '.id')

TRIGGER_RES=$(curl -X POST $PAPERCLIP_API_URL/api/routines/$ROUTINE_ID/triggers \
  -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "kind": "webhook", "label": "github", "enabled": true, "signingMode": "github_hmac" }')
TRIGGER_PUBLIC_ID=$(echo "$TRIGGER_RES" | jq -r '.publicId')
TRIGGER_SECRET=$(echo "$TRIGGER_RES" | jq -r '.generatedSecret') # check actual response field name
```

Capture both `TRIGGER_PUBLIC_ID` and the generated `TRIGGER_SECRET`.

### 3. Configure the GitHub webhook

In GitHub repo Settings → Webhooks → Add webhook:

- **Payload URL:** `$PAPERCLIP_PUBLIC_URL/api/routine-triggers/public/$TRIGGER_PUBLIC_ID/fire`
- **Content type:** `application/json`
- **Secret:** `$TRIGGER_SECRET`
- **SSL verification:** enabled
- **Events:** select "Let me select individual events" → check **Issues** and **Issue comments** only.
- Active: yes.

### 4. Ensure the `agent-eligible` label exists in the GitHub repo

Create it manually if not present (any color).

### 5. Smoke test

1. Create a new GitHub issue in the repo with the `agent-eligible` label.
2. Wait ~10s. In Paperclip, open the project — a new issue with marker `<!-- gh-ref: <owner>/<repo>#<N> -->` should appear with title `[gh#N] <issue title>`.
3. Add a comment on the GitHub issue. Within ~10s a comment appears on the Paperclip mirror.
4. Close the GitHub issue. Within ~10s the Paperclip mirror status flips to `done`.

If any step fails, check `routine_runs.failureReason` for the routine's recent runs and the heartbeat run logs for the analyzer.

## Troubleshooting

- **Webhook returns 401:** HMAC mismatch — confirm the secret matches what GitHub is sending.
- **Routine fires but mirror not created:** check the analyzer's heartbeat run logs (`/api/heartbeat-runs/:id/log`) — likely a missing env or API error.
- **Mirror duplicates:** marker not preserved as first non-empty line — confirm no manual edit reordered the description.

## Webhook URL gotcha

If your container has hairpin NAT issues (cannot reach its own public hostname), `PAPERCLIP_API_URL` inside the container may be set to `http://localhost:3100`. The routine's webhook fire URL is constructed from `PAPERCLIP_API_URL`, so the URL returned by the trigger creation API may be `http://localhost:3100/...`. **Manually replace** the host with the public URL before pasting into GitHub.
