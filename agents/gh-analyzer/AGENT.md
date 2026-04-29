# gh-analyzer

Watches GitHub Issue webhook payloads and mirrors them into Paperclip issues. Cheap, deterministic, single Haiku 4.5 call per fire.

## Adapter

`process` — invoked by the heartbeat dispatcher, runs once per routine-execution issue, exits.

## Agent record (created by `scripts/gh-integration/ensure-agents.ts`)

| Field | Value |
|---|---|
| `name` | `gh-analyzer` |
| `adapterType` | `process` |
| `adapterConfig.command` | `node` |
| `adapterConfig.args` | `["/app/agents/gh-analyzer/dist/index.js"]` |
| `adapterConfig.timeoutSec` | `120` |
| `adapterConfig.env.ANTHROPIC_API_KEY` | secret reference `paperclip/anthropic-api-key` |
| `model` | `claude-haiku-4-5-20251001` (informational; the script reads it from a constant) |
| `executionPolicy` | inherits — no workspace checkout required |

## Required env injected by adapter (process adapter)

- `PAPERCLIP_API_URL` — base URL the script calls back into.
- `PAPERCLIP_API_KEY` — bearer token issued by Paperclip for this agent.
- `PAPERCLIP_RUN_ID` — heartbeat run id.

## Required env from `adapterConfig.env`

- `ANTHROPIC_API_KEY` — for the Haiku triage call.

## Behavior

1. Fetch heartbeat run → trigger issue → routine run.
2. Dispatch by `payload.action`:
   - `opened` → create mirror Paperclip issue with `<!-- gh-ref: owner/repo#N -->` marker, triage summary, original body. Priority derived from labels.
   - `edited` → if delta is non-trivial (anything beyond labels/assignees/milestone/state), comment on mirror.
   - `issue_comment.created` → comment on mirror with the GH comment body.
   - `closed` → set mirror status to `done` (idempotent).
   - anything else → skip.
3. Skip silently if `agent-eligible` label is missing.
4. Always finalize the routine-execution (trigger) issue with `status: done` before exit.

## Idempotency

Marker substring lookup against project issue list dedups duplicate `opened` events. `closed` is no-op when mirror already done.
