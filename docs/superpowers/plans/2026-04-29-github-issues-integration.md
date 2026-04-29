# GitHub Issues → Paperclip Integration Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire GitHub issue events through a Paperclip routine into a `gh-analyzer` agent that mirrors them into Paperclip issues, then through a human approval gate into a `gh-codador` agent that develops a fix and opens a draft PR.

**Architecture:** Each connected repo registers one `Issues, Issue comments` webhook pointed at a per-repo Paperclip routine. The routine fires (HMAC-validated via `signingMode: github_hmac`) → creates an ephemeral routine-execution issue assigned to the global `gh-analyzer` agent. The analyzer (process adapter, Haiku 4.5) fetches the routine run, dispatches by `payload.action`, and creates/updates/closes a *mirror* Paperclip issue dedup'd by an `<!-- gh-ref: owner/repo#N -->` HTML comment marker in the mirror's description. A human approves the mirror by reassigning to `gh-codador` and flipping `todo → in_progress`; the codador (claude_local adapter, Sonnet/Opus) develops the fix in a workspace branch and opens a draft PR.

**Tech Stack:** TypeScript (strict), Node 20, pnpm workspaces, Vitest, Drizzle ORM (existing), Express (existing), `@anthropic-ai/sdk` for the analyzer's triage call.

**Spec:** [`docs/specs/github-issues-integration.md`](../../specs/github-issues-integration.md)

---

## Architecture map

```
GitHub repo  --webhook(Issues|Issue comments)-->  POST /api/routine-triggers/public/{publicId}/fire
                                                  ↓ (HMAC validate, github_hmac mode)
                                                  ↓
Paperclip routine `gh-issue-watcher-<slug>`       ↓
  assigneeAgentId = gh-analyzer                   ↓
  concurrencyPolicy = always_enqueue              ↓
  description template embeds the GH payload     ↓
                                                  ↓
            dispatchRoutineRun() creates routine-execution Issue
            (originKind=routine_execution, originRunId=<routineRun.id>)
                                                  ↓
            heartbeat invokes gh-analyzer (process adapter)
                                                  ↓
                          PAPERCLIP_RUN_ID env var
                                                  ↓
            gh-analyzer Node script
              ├─ GET /heartbeat-runs/:runId       → issueId
              ├─ GET /issues/:issueId/heartbeat-context → originRunId
              ├─ GET /routine-runs/:originRunId   → triggerPayload (full GH payload)
              ├─ filter: action ∈ {opened, edited, closed, issue_comment.created}
              ├─ filter: labels include "agent-eligible"
              ├─ search project for marker  →  mirror issue (or none)
              ├─ dispatch:
              │    opened              → create mirror w/ marker + triage summary
              │    edited|comment      → comment on mirror (skip trivial)
              │    closed              → mirror.status = done
              └─ PATCH routine-execution issue → status=done
```

---

## File Structure

**New files:**
- `agents/gh-analyzer/package.json` — workspace package, `@paperclipai/gh-analyzer`, bin `gh-analyzer`.
- `agents/gh-analyzer/tsconfig.json`
- `agents/gh-analyzer/vitest.config.ts`
- `agents/gh-analyzer/src/index.ts` — entry; reads `PAPERCLIP_RUN_ID`, orchestrates fetch → dispatch.
- `agents/gh-analyzer/src/marker.ts` — `formatMarker`, `parseMarker`, `findMarker`.
- `agents/gh-analyzer/src/marker.test.ts`
- `agents/gh-analyzer/src/payload.ts` — type guards for GH webhook payload + `getGhRef`.
- `agents/gh-analyzer/src/payload.test.ts`
- `agents/gh-analyzer/src/label-gate.ts` — `hasAgentEligibleLabel`.
- `agents/gh-analyzer/src/label-gate.test.ts`
- `agents/gh-analyzer/src/trivial-delta.ts` — classify whether a `edited` event is content-bearing.
- `agents/gh-analyzer/src/trivial-delta.test.ts`
- `agents/gh-analyzer/src/api-client.ts` — Paperclip API wrapper.
- `agents/gh-analyzer/src/api-client.test.ts`
- `agents/gh-analyzer/src/triage.ts` — Haiku call returning `{ summary, suggestedPriority }`.
- `agents/gh-analyzer/src/triage.test.ts`
- `agents/gh-analyzer/src/handlers/opened.ts`
- `agents/gh-analyzer/src/handlers/opened.test.ts`
- `agents/gh-analyzer/src/handlers/updated.ts`
- `agents/gh-analyzer/src/handlers/updated.test.ts`
- `agents/gh-analyzer/src/handlers/closed.ts`
- `agents/gh-analyzer/src/handlers/closed.test.ts`
- `agents/gh-analyzer/src/dispatch.ts`
- `agents/gh-analyzer/src/dispatch.test.ts`
- `agents/gh-analyzer/src/index.test.ts` — integration test, mocks fetch + SDK.
- `agents/gh-analyzer/AGENT.md` — operator-facing description (model, adapter, tools, env contract).
- `agents/gh-codador/AGENT.md` — codador prompt + branch/PR conventions.
- `scripts/gh-integration/ensure-agents.ts` — idempotent bootstrap for the two global agent records.
- `scripts/gh-integration/connect-repo.md` — operator runbook mirroring spec §6.

**Modified files:**
- `pnpm-workspace.yaml` — add `agents/*` to workspaces.
- `Dockerfile` — copy `agents/gh-analyzer/package.json` for `deps` stage and `agents/` source for `build` stage; build the package; production stage retains `agents/gh-analyzer/dist/`.
- `server/src/adapters/process/execute.ts` — inject `PAPERCLIP_RUN_ID` into the spawned env (mirror `claude-local`).
- `server/src/services/routines.ts` — add `getRunById(runId, companyId)` returning the run incl. `triggerPayload`.
- `server/src/routes/routines.ts` — add `GET /routine-runs/:runId` route exposing `getRunById`.
- `server/src/services/routines.test.ts` (or new `routine-runs-route.test.ts`) — coverage for the new route.

**No file changes required for:**
- The HMAC validation (already supports `github_hmac` and `X-Hub-Signature-256`).
- Issue create/update/comment APIs (already exist).
- claude_local adapter (already used).

---

## Task list

### Task 1: Inject PAPERCLIP_RUN_ID into the process adapter

**Files:**
- Modify: `server/src/adapters/process/execute.ts:14-25`
- Test: `server/src/adapters/process/execute.test.ts` (new)

The current process adapter only sets `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_API_URL` (via `buildPaperclipEnv`). It receives `runId` in `ctx` (line 15) but never propagates it. Mirror what `packages/adapters/claude-local/src/server/execute.ts:149` does.

- [ ] **Step 1: Write the failing test**

`server/src/adapters/process/execute.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { execute } from "./execute.js";
import * as utils from "../utils.js";

vi.mock("../utils.js", async () => {
  const actual = await vi.importActual<typeof utils>("../utils.js");
  return {
    ...actual,
    runChildProcess: vi.fn(async (_runId, _cmd, _args, opts) => {
      // capture env for assertion
      (globalThis as any).__capturedEnv = opts.env;
      return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" };
    }),
    resolveCommandForLogs: vi.fn(async (cmd) => cmd),
  };
});

describe("process adapter env injection", () => {
  it("includes PAPERCLIP_RUN_ID in spawned env", async () => {
    await execute({
      runId: "run-abc-123",
      agent: { id: "agent-1", companyId: "co-1" },
      config: { command: "echo" },
      onLog: async () => {},
      onMeta: async () => {},
    } as any);

    const env = (globalThis as any).__capturedEnv as Record<string, string>;
    expect(env.PAPERCLIP_RUN_ID).toBe("run-abc-123");
    expect(env.PAPERCLIP_AGENT_ID).toBe("agent-1");
    expect(env.PAPERCLIP_COMPANY_ID).toBe("co-1");
  });
});
```

- [ ] **Step 2: Run test, expect FAIL**

`pnpm --filter @paperclipai/server test src/adapters/process/execute.test.ts`
Expected: FAIL — `PAPERCLIP_RUN_ID` is `undefined`.

- [ ] **Step 3: Implement**

Modify `server/src/adapters/process/execute.ts:22`:
```ts
  const env: Record<string, string> = { ...buildPaperclipEnv(agent) };
  env.PAPERCLIP_RUN_ID = runId;
  for (const [k, v] of Object.entries(envConfig)) {
    if (typeof v === "string") env[k] = v;
  }
```

- [ ] **Step 4: Run test, expect PASS**

`pnpm --filter @paperclipai/server test src/adapters/process/execute.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/adapters/process/execute.ts server/src/adapters/process/execute.test.ts
git commit -m "feat(adapters/process): inject PAPERCLIP_RUN_ID into spawned env"
```

---

### Task 2: Add GET /routine-runs/:runId service method

**Files:**
- Modify: `server/src/services/routines.ts` (add `getRunById` to the service object — the file already has `listRuns` near line 1560 to mirror)
- Test: `server/src/services/routines-get-run.test.ts` (new)

The analyzer needs the full `triggerPayload`; only `listRuns` exists today. Add `getRunById(runId, companyId)`.

- [ ] **Step 1: Write the failing test**

`server/src/services/routines-get-run.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createRoutineService } from "./routines.js";
import { setupTestDb } from "../testing/test-db.js"; // existing helper
import { seedRoutine, fireRoutine } from "../testing/routine-fixtures.js"; // existing helpers

describe("routineService.getRunById", () => {
  let svc: ReturnType<typeof createRoutineService>;
  let companyId: string;

  beforeEach(async () => {
    const ctx = await setupTestDb();
    svc = ctx.routineService;
    companyId = ctx.companyId;
  });

  it("returns run with triggerPayload", async () => {
    const { routine } = await seedRoutine(companyId);
    const run = await fireRoutine(routine.id, { hello: "world" });
    const fetched = await svc.getRunById(run.id, companyId);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(run.id);
    expect(fetched!.triggerPayload).toEqual({ hello: "world" });
  });

  it("returns null when run does not exist", async () => {
    const fetched = await svc.getRunById("00000000-0000-0000-0000-000000000000", companyId);
    expect(fetched).toBeNull();
  });

  it("returns null when run belongs to a different company", async () => {
    const { routine } = await seedRoutine(companyId);
    const run = await fireRoutine(routine.id, {});
    const fetched = await svc.getRunById(run.id, "00000000-0000-0000-0000-000000000000");
    expect(fetched).toBeNull();
  });
});
```

If `setupTestDb`/`seedRoutine`/`fireRoutine` helpers do not exist with these exact names, look at `server/src/services/heartbeat-stop-metadata.test.ts` for the actual fixture pattern in this repo and adapt. The shape of the assertion (returns the run with `triggerPayload`) does not change.

- [ ] **Step 2: Run test, expect FAIL**

`pnpm --filter @paperclipai/server test src/services/routines-get-run.test.ts`
Expected: FAIL — `svc.getRunById is not a function`.

- [ ] **Step 3: Implement service method**

Add inside the returned service object in `server/src/services/routines.ts` (alongside `listRuns` near line 1560):
```ts
    getRunById: async (runId: string, companyId: string): Promise<RoutineRunSummary | null> => {
      const rows = await db
        .select({
          id: routineRuns.id,
          companyId: routineRuns.companyId,
          routineId: routineRuns.routineId,
          triggerId: routineRuns.triggerId,
          source: routineRuns.source,
          status: routineRuns.status,
          triggeredAt: routineRuns.triggeredAt,
          idempotencyKey: routineRuns.idempotencyKey,
          triggerPayload: routineRuns.triggerPayload,
          dispatchFingerprint: routineRuns.dispatchFingerprint,
          linkedIssueId: routineRuns.linkedIssueId,
          coalescedIntoRunId: routineRuns.coalescedIntoRunId,
          failureReason: routineRuns.failureReason,
          completedAt: routineRuns.completedAt,
          createdAt: routineRuns.createdAt,
          updatedAt: routineRuns.updatedAt,
        })
        .from(routineRuns)
        .where(and(eq(routineRuns.id, runId), eq(routineRuns.companyId, companyId)))
        .limit(1);
      const row = rows[0];
      if (!row) return null;
      return {
        ...row,
        triggerPayload: row.triggerPayload as Record<string, unknown> | null,
      };
    },
```

If the local `RoutineRunSummary` type does not include all those fields, return a minimal `{ id, routineId, triggerPayload, linkedIssueId, status, completedAt, source }` — the analyzer only uses `triggerPayload` and `linkedIssueId`.

- [ ] **Step 4: Run test, expect PASS**

`pnpm --filter @paperclipai/server test src/services/routines-get-run.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/services/routines.ts server/src/services/routines-get-run.test.ts
git commit -m "feat(routines): add getRunById service method"
```

---

### Task 3: Expose GET /routine-runs/:runId route

**Files:**
- Modify: `server/src/routes/routines.ts` (add route alongside the `/routines/:id/runs` list route at line 149)
- Test: `server/src/routes/routine-runs-route.test.ts` (new)

- [ ] **Step 1: Write the failing test**

`server/src/routes/routine-runs-route.test.ts`:
```ts
import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { buildTestApp } from "../testing/test-app.js"; // existing helper, see other route tests
import { seedRoutine, fireRoutine } from "../testing/routine-fixtures.js";

describe("GET /routine-runs/:runId", () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  beforeEach(async () => { app = await buildTestApp(); });

  it("returns 200 with triggerPayload for an existing run in same company", async () => {
    const { routine } = await seedRoutine(app.companyId);
    const run = await fireRoutine(routine.id, { action: "opened", number: 1 });
    const res = await request(app.server)
      .get(`/api/routine-runs/${run.id}`)
      .set("Authorization", `Bearer ${app.companyToken}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(run.id);
    expect(res.body.triggerPayload).toEqual({ action: "opened", number: 1 });
  });

  it("returns 404 for non-existent run", async () => {
    const res = await request(app.server)
      .get(`/api/routine-runs/00000000-0000-0000-0000-000000000000`)
      .set("Authorization", `Bearer ${app.companyToken}`);
    expect(res.status).toBe(404);
  });

  it("returns 404 for a run in a different company", async () => {
    const { routine } = await seedRoutine(app.companyId);
    const run = await fireRoutine(routine.id, {});
    const otherToken = await app.makeOtherCompanyToken();
    const res = await request(app.server)
      .get(`/api/routine-runs/${run.id}`)
      .set("Authorization", `Bearer ${otherToken}`);
    expect(res.status).toBe(404);
  });
});
```

Adapt the helper names to whatever `server/src/testing/` actually exports. Read one or two existing `*.test.ts` route files to mirror the pattern.

- [ ] **Step 2: Run test, expect FAIL**

`pnpm --filter @paperclipai/server test src/routes/routine-runs-route.test.ts`
Expected: FAIL — 404 (route not registered).

- [ ] **Step 3: Implement route**

Add to `server/src/routes/routines.ts` near line 149 (after `/routines/:id/runs`):
```ts
  router.get("/routine-runs/:runId", async (req, res) => {
    const runId = req.params.runId as string;
    const companyId = req.actor.companyId;
    if (!companyId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const run = await svc.getRunById(runId, companyId);
    if (!run) {
      res.status(404).json({ error: "Routine run not found" });
      return;
    }
    res.json(run);
  });
```

If `req.actor.companyId` is not the existing pattern in this file, mirror what `/routines/:id` (line 94) uses — likely `assertCompanyAccess(req, run.companyId)` after fetching.

- [ ] **Step 4: Run test, expect PASS**

`pnpm --filter @paperclipai/server test src/routes/routine-runs-route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/routines.ts server/src/routes/routine-runs-route.test.ts
git commit -m "feat(routes): expose GET /routine-runs/:runId"
```

---

### Task 4: Scaffold the gh-analyzer package

**Files:**
- Create: `agents/gh-analyzer/package.json`
- Create: `agents/gh-analyzer/tsconfig.json`
- Create: `agents/gh-analyzer/vitest.config.ts`
- Create: `agents/gh-analyzer/src/index.ts` (stub)
- Modify: `pnpm-workspace.yaml` — add `agents/*`

- [ ] **Step 1: Add `agents/*` to the pnpm workspace**

Read `pnpm-workspace.yaml`, then add `agents/*` to the `packages:` list. Example final state:
```yaml
packages:
  - "cli"
  - "server"
  - "ui"
  - "packages/*"
  - "packages/adapters/*"
  - "packages/plugins/*"
  - "packages/plugins/sandbox-providers/*"
  - "agents/*"
```

- [ ] **Step 2: Write `agents/gh-analyzer/package.json`**

```json
{
  "name": "@paperclipai/gh-analyzer",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": {
    "gh-analyzer": "./dist/index.js"
  },
  "main": "./dist/index.js",
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.40.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 3: Write `agents/gh-analyzer/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": false,
    "sourceMap": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["**/*.test.ts", "dist", "node_modules"]
}
```

- [ ] **Step 4: Write `agents/gh-analyzer/vitest.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
```

- [ ] **Step 5: Write `agents/gh-analyzer/src/index.ts` (stub)**

```ts
#!/usr/bin/env node
async function main(): Promise<void> {
  throw new Error("not implemented");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 6: Install and typecheck**

```bash
pnpm install
pnpm --filter @paperclipai/gh-analyzer typecheck
```

Expected: install succeeds, typecheck passes.

- [ ] **Step 7: Commit**

```bash
git add pnpm-workspace.yaml pnpm-lock.yaml agents/gh-analyzer/package.json agents/gh-analyzer/tsconfig.json agents/gh-analyzer/vitest.config.ts agents/gh-analyzer/src/index.ts
git commit -m "feat(gh-analyzer): scaffold package"
```

---

### Task 5: Marker library

**Files:**
- Create: `agents/gh-analyzer/src/marker.ts`
- Create: `agents/gh-analyzer/src/marker.test.ts`

The marker is `<!-- gh-ref: owner/repo#N -->`. It MUST be the first non-empty line of a description and is used as the dedup key.

- [ ] **Step 1: Write the failing test**

`agents/gh-analyzer/src/marker.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { formatMarker, parseMarker, hasMarker } from "./marker.js";

describe("formatMarker", () => {
  it("formats owner/repo#N", () => {
    expect(formatMarker({ owner: "simplafy", repo: "hub", number: 42 }))
      .toBe("<!-- gh-ref: simplafy/hub#42 -->");
  });
});

describe("parseMarker", () => {
  it("parses a description that starts with the marker", () => {
    const desc = "<!-- gh-ref: simplafy/hub#42 -->\n\n## Análise\n...";
    expect(parseMarker(desc)).toEqual({ owner: "simplafy", repo: "hub", number: 42 });
  });

  it("ignores leading blank lines", () => {
    const desc = "\n\n<!-- gh-ref: a/b#1 -->\nbody";
    expect(parseMarker(desc)).toEqual({ owner: "a", repo: "b", number: 1 });
  });

  it("returns null when no marker present", () => {
    expect(parseMarker("plain body")).toBeNull();
  });

  it("returns null when marker is not on the first non-empty line", () => {
    const desc = "## Title\n<!-- gh-ref: a/b#1 -->";
    expect(parseMarker(desc)).toBeNull();
  });

  it("returns null when ref shape is invalid", () => {
    expect(parseMarker("<!-- gh-ref: bad -->")).toBeNull();
  });
});

describe("hasMarker", () => {
  it("matches by full marker substring (for list-and-filter dedup)", () => {
    const target = "<!-- gh-ref: simplafy/hub#42 -->";
    expect(hasMarker("anything\n" + target + "\nmore", target)).toBe(true);
    expect(hasMarker("nope", target)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test, expect FAIL**

`pnpm --filter @paperclipai/gh-analyzer test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `agents/gh-analyzer/src/marker.ts`**

```ts
export type GhRef = { owner: string; repo: string; number: number };

const MARKER_RE = /^<!-- gh-ref: ([^/\s]+)\/([^#\s]+)#(\d+) -->$/;

export function formatMarker(ref: GhRef): string {
  return `<!-- gh-ref: ${ref.owner}/${ref.repo}#${ref.number} -->`;
}

export function parseMarker(description: string): GhRef | null {
  const firstLine = description.split("\n").find((l) => l.trim().length > 0);
  if (!firstLine) return null;
  const m = firstLine.trim().match(MARKER_RE);
  if (!m) return null;
  const [, owner, repo, n] = m;
  const number = Number(n);
  if (!Number.isInteger(number) || number <= 0) return null;
  return { owner, repo, number };
}

export function hasMarker(description: string, marker: string): boolean {
  return description.includes(marker);
}
```

- [ ] **Step 4: Run test, expect PASS**

`pnpm --filter @paperclipai/gh-analyzer test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add agents/gh-analyzer/src/marker.ts agents/gh-analyzer/src/marker.test.ts
git commit -m "feat(gh-analyzer): marker library"
```

---

### Task 6: Webhook payload typing + label gate

**Files:**
- Create: `agents/gh-analyzer/src/payload.ts`
- Create: `agents/gh-analyzer/src/payload.test.ts`
- Create: `agents/gh-analyzer/src/label-gate.ts`
- Create: `agents/gh-analyzer/src/label-gate.test.ts`

- [ ] **Step 1: Write the failing payload test**

`agents/gh-analyzer/src/payload.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { extractGhRef, extractAction, extractLabels } from "./payload.js";

const opened = {
  action: "opened",
  repository: { full_name: "simplafy/hub" },
  issue: { number: 7, labels: [{ name: "bug" }, { name: "agent-eligible" }], body: "x", title: "t" },
  sender: { login: "alice" },
};

describe("extractGhRef", () => {
  it("returns owner/repo/number", () => {
    expect(extractGhRef(opened)).toEqual({ owner: "simplafy", repo: "hub", number: 7 });
  });
  it("returns null when full_name is missing", () => {
    expect(extractGhRef({ action: "x", issue: { number: 1, labels: [] } })).toBeNull();
  });
});

describe("extractAction", () => {
  it("returns issue_comment.created when present", () => {
    expect(extractAction({ action: "created", comment: { body: "c" }, issue: { number: 1, labels: [] }, repository: { full_name: "a/b" }, sender: { login: "x" } }))
      .toBe("issue_comment.created");
  });
  it("returns the issue action otherwise", () => {
    expect(extractAction(opened)).toBe("opened");
  });
});

describe("extractLabels", () => {
  it("returns label name list", () => {
    expect(extractLabels(opened)).toEqual(["bug", "agent-eligible"]);
  });
  it("handles missing labels", () => {
    expect(extractLabels({ issue: { number: 1 }, action: "x", repository: { full_name: "a/b" }, sender: { login: "x" } })).toEqual([]);
  });
});
```

- [ ] **Step 2: Implement `agents/gh-analyzer/src/payload.ts`**

```ts
import type { GhRef } from "./marker.js";

export type GhAction = "opened" | "edited" | "closed" | "issue_comment.created" | "ignored";

export type GhPayload = {
  action: string;
  repository?: { full_name?: string };
  issue?: {
    number?: number;
    title?: string;
    body?: string | null;
    labels?: Array<{ name?: string }>;
    user?: { login?: string };
    state?: string;
    state_reason?: string | null;
  };
  comment?: { body?: string; user?: { login?: string }; id?: number };
  changes?: Record<string, unknown>;
  sender?: { login?: string };
};

export function extractGhRef(payload: GhPayload): GhRef | null {
  const fullName = payload.repository?.full_name;
  const number = payload.issue?.number;
  if (!fullName || typeof number !== "number") return null;
  const [owner, repo] = fullName.split("/");
  if (!owner || !repo) return null;
  return { owner, repo, number };
}

export function extractAction(payload: GhPayload): GhAction {
  if (payload.comment && payload.action === "created") return "issue_comment.created";
  if (payload.action === "opened") return "opened";
  if (payload.action === "edited") return "edited";
  if (payload.action === "closed") return "closed";
  return "ignored";
}

export function extractLabels(payload: GhPayload): string[] {
  const labels = payload.issue?.labels ?? [];
  return labels
    .map((l) => l?.name)
    .filter((n): n is string => typeof n === "string");
}
```

- [ ] **Step 3: Run payload test, expect PASS**

`pnpm --filter @paperclipai/gh-analyzer test src/payload.test.ts`
Expected: PASS.

- [ ] **Step 4: Write the failing label-gate test**

`agents/gh-analyzer/src/label-gate.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { hasAgentEligibleLabel } from "./label-gate.js";

describe("hasAgentEligibleLabel", () => {
  it("returns true when 'agent-eligible' is present", () => {
    expect(hasAgentEligibleLabel(["bug", "agent-eligible"])).toBe(true);
  });
  it("is case-sensitive — 'Agent-Eligible' does not count", () => {
    expect(hasAgentEligibleLabel(["Agent-Eligible"])).toBe(false);
  });
  it("returns false on empty", () => {
    expect(hasAgentEligibleLabel([])).toBe(false);
  });
});
```

- [ ] **Step 5: Implement `agents/gh-analyzer/src/label-gate.ts`**

```ts
export const AGENT_ELIGIBLE_LABEL = "agent-eligible";

export function hasAgentEligibleLabel(labels: string[]): boolean {
  return labels.includes(AGENT_ELIGIBLE_LABEL);
}
```

- [ ] **Step 6: Run label-gate test, expect PASS**

`pnpm --filter @paperclipai/gh-analyzer test`
Expected: PASS for all tests so far.

- [ ] **Step 7: Commit**

```bash
git add agents/gh-analyzer/src/payload.ts agents/gh-analyzer/src/payload.test.ts agents/gh-analyzer/src/label-gate.ts agents/gh-analyzer/src/label-gate.test.ts
git commit -m "feat(gh-analyzer): payload typing + agent-eligible label gate"
```

---

### Task 7: Trivial-delta filter

**Files:**
- Create: `agents/gh-analyzer/src/trivial-delta.ts`
- Create: `agents/gh-analyzer/src/trivial-delta.test.ts`

Per spec §8.3: "Default: simple rules first; LLM fallback only for content edits." We implement the simple rules. An `edited` payload is **trivial** if `payload.changes` only mentions label/assignee/state-only fields. A comment event is never trivial (the comment body is the delta).

- [ ] **Step 1: Write the failing test**

`agents/gh-analyzer/src/trivial-delta.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { isTrivialDelta } from "./trivial-delta.js";

describe("isTrivialDelta", () => {
  it("marks label-only changes as trivial", () => {
    expect(isTrivialDelta("edited", { changes: { labels: { from: [] } } } as any)).toBe(true);
  });
  it("marks assignee-only changes as trivial", () => {
    expect(isTrivialDelta("edited", { changes: { assignees: { from: [] } } } as any)).toBe(true);
  });
  it("marks empty changes object as trivial", () => {
    expect(isTrivialDelta("edited", { changes: {} } as any)).toBe(true);
  });
  it("does NOT mark title changes as trivial", () => {
    expect(isTrivialDelta("edited", { changes: { title: { from: "old" } } } as any)).toBe(false);
  });
  it("does NOT mark body changes as trivial", () => {
    expect(isTrivialDelta("edited", { changes: { body: { from: "old" } } } as any)).toBe(false);
  });
  it("comments are never trivial", () => {
    expect(isTrivialDelta("issue_comment.created", { comment: { body: "" } } as any)).toBe(false);
  });
  it("opened/closed are never trivial", () => {
    expect(isTrivialDelta("opened", {} as any)).toBe(false);
    expect(isTrivialDelta("closed", {} as any)).toBe(false);
  });
});
```

- [ ] **Step 2: Implement `agents/gh-analyzer/src/trivial-delta.ts`**

```ts
import type { GhAction, GhPayload } from "./payload.js";

const TRIVIAL_CHANGE_KEYS = new Set(["labels", "assignees", "milestone", "state"]);

export function isTrivialDelta(action: GhAction, payload: GhPayload): boolean {
  if (action !== "edited") return false;
  const changes = payload.changes;
  if (!changes || typeof changes !== "object") return true;
  const keys = Object.keys(changes);
  if (keys.length === 0) return true;
  return keys.every((k) => TRIVIAL_CHANGE_KEYS.has(k));
}
```

- [ ] **Step 3: Run, expect PASS**

`pnpm --filter @paperclipai/gh-analyzer test`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add agents/gh-analyzer/src/trivial-delta.ts agents/gh-analyzer/src/trivial-delta.test.ts
git commit -m "feat(gh-analyzer): trivial-delta filter for edited events"
```

---

### Task 8: Paperclip API client

**Files:**
- Create: `agents/gh-analyzer/src/api-client.ts`
- Create: `agents/gh-analyzer/src/api-client.test.ts`

The client wraps the endpoints the analyzer needs. Auth: bearer token from `PAPERCLIP_API_KEY` (set by the heartbeat dispatcher when invoking the agent — same convention as claude-local).

- [ ] **Step 1: Write the failing test**

`agents/gh-analyzer/src/api-client.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PaperclipClient } from "./api-client.js";

describe("PaperclipClient", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let client: PaperclipClient;

  beforeEach(() => {
    fetchMock = vi.fn();
    client = new PaperclipClient({
      apiUrl: "http://localhost:3100",
      apiKey: "k",
      fetchImpl: fetchMock as any,
    });
  });

  it("getHeartbeatRun → GET /heartbeat-runs/:id with bearer", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "r1", issueId: "i1", companyId: "c1" }), { status: 200 }));
    const r = await client.getHeartbeatRun("r1");
    expect(r).toEqual({ id: "r1", issueId: "i1", companyId: "c1" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3100/api/heartbeat-runs/r1",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer k" }) }),
    );
  });

  it("getRoutineRun → GET /routine-runs/:id", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "rr1", triggerPayload: { action: "opened" } }), { status: 200 }));
    const r = await client.getRoutineRun("rr1");
    expect(r.triggerPayload).toEqual({ action: "opened" });
  });

  it("getIssue → GET /issues/:id", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "i1", description: "d", originRunId: "rr1", projectId: "p1", companyId: "c1" }), { status: 200 }));
    const i = await client.getIssue("i1");
    expect(i.originRunId).toBe("rr1");
  });

  it("listProjectIssues → GET /companies/:cid/issues?projectId=:pid&limit=200", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ items: [{ id: "i1", description: "<!-- gh-ref: a/b#1 -->\nbody" }] }), { status: 200 }));
    const items = await client.listProjectIssues("c1", "p1");
    expect(items).toHaveLength(1);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("/api/companies/c1/issues");
    expect(url).toContain("projectId=p1");
  });

  it("createIssue → POST /companies/:cid/issues", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "i2" }), { status: 201 }));
    await client.createIssue("c1", { projectId: "p1", title: "t", description: "d", priority: "high" });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:3100/api/companies/c1/issues");
    expect((opts as any).method).toBe("POST");
    expect(JSON.parse((opts as any).body)).toMatchObject({ projectId: "p1", title: "t", priority: "high" });
  });

  it("addComment → POST /issues/:id/comments", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "c1" }), { status: 201 }));
    await client.addComment("i1", "hello");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3100/api/issues/i1/comments",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("updateIssue → PATCH /issues/:id", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "i1" }), { status: 200 }));
    await client.updateIssue("i1", { status: "done" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3100/api/issues/i1",
      expect.objectContaining({ method: "PATCH" }),
    );
  });

  it("throws PaperclipApiError on non-2xx", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "nope" }), { status: 500 }));
    await expect(client.getIssue("i1")).rejects.toThrow(/500/);
  });
});
```

- [ ] **Step 2: Implement `agents/gh-analyzer/src/api-client.ts`**

```ts
export type PaperclipClientOptions = {
  apiUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
};

export type HeartbeatRun = { id: string; issueId: string | null; companyId: string };
export type RoutineRun = { id: string; triggerPayload: Record<string, unknown> | null; linkedIssueId: string | null };
export type IssueSummary = {
  id: string;
  description: string | null;
  status: string;
  priority: string | null;
  projectId: string | null;
  companyId: string;
  originRunId?: string | null;
};
export type CreateIssueInput = {
  projectId: string;
  title: string;
  description: string;
  priority: "critical" | "high" | "medium" | "low";
  status?: "todo" | "backlog" | "in_progress" | "in_review" | "done" | "blocked" | "cancelled";
};

export class PaperclipApiError extends Error {
  constructor(public status: number, public body: string) {
    super(`Paperclip API ${status}: ${body.slice(0, 500)}`);
  }
}

export class PaperclipClient {
  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: PaperclipClientOptions) {
    this.apiUrl = opts.apiUrl.replace(/\/$/, "");
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.apiUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: body == null ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new PaperclipApiError(res.status, await res.text());
    return (await res.json()) as T;
  }

  getHeartbeatRun(runId: string): Promise<HeartbeatRun> {
    return this.request("GET", `/api/heartbeat-runs/${encodeURIComponent(runId)}`);
  }

  getRoutineRun(runId: string): Promise<RoutineRun> {
    return this.request("GET", `/api/routine-runs/${encodeURIComponent(runId)}`);
  }

  async getIssue(issueId: string): Promise<IssueSummary> {
    const res = await this.request<{ issue: IssueSummary } | IssueSummary>(
      "GET",
      `/api/issues/${encodeURIComponent(issueId)}`,
    );
    return "issue" in (res as object) ? (res as { issue: IssueSummary }).issue : (res as IssueSummary);
  }

  async listProjectIssues(companyId: string, projectId: string): Promise<IssueSummary[]> {
    const path = `/api/companies/${encodeURIComponent(companyId)}/issues?projectId=${encodeURIComponent(projectId)}&limit=200`;
    const res = await this.request<{ items: IssueSummary[] } | IssueSummary[]>("GET", path);
    if (Array.isArray(res)) return res;
    return res.items ?? [];
  }

  createIssue(companyId: string, input: CreateIssueInput): Promise<{ id: string }> {
    return this.request("POST", `/api/companies/${encodeURIComponent(companyId)}/issues`, input);
  }

  addComment(issueId: string, body: string): Promise<{ id: string }> {
    return this.request("POST", `/api/issues/${encodeURIComponent(issueId)}/comments`, { body });
  }

  updateIssue(issueId: string, patch: Partial<{ status: string; priority: string; title: string }>): Promise<{ id: string }> {
    return this.request("PATCH", `/api/issues/${encodeURIComponent(issueId)}`, patch);
  }
}
```

- [ ] **Step 3: Run, expect PASS**

`pnpm --filter @paperclipai/gh-analyzer test src/api-client.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add agents/gh-analyzer/src/api-client.ts agents/gh-analyzer/src/api-client.test.ts
git commit -m "feat(gh-analyzer): Paperclip API client"
```

---

### Task 9: Triage helper (Haiku)

**Files:**
- Create: `agents/gh-analyzer/src/triage.ts`
- Create: `agents/gh-analyzer/src/triage.test.ts`

The triage call returns a one-paragraph summary (pt-BR) and a label-derived priority. Use `@anthropic-ai/sdk` with `claude-haiku-4-5-20251001`. Mock the SDK in tests.

- [ ] **Step 1: Write the failing test**

`agents/gh-analyzer/src/triage.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { triage, derivePriorityFromLabels } from "./triage.js";

describe("derivePriorityFromLabels", () => {
  it("bug → high", () => expect(derivePriorityFromLabels(["bug"])).toBe("high"));
  it("critical → critical", () => expect(derivePriorityFromLabels(["critical"])).toBe("critical"));
  it("enhancement → medium", () => expect(derivePriorityFromLabels(["enhancement"])).toBe("medium"));
  it("nothing matches → medium", () => expect(derivePriorityFromLabels(["foo"])).toBe("medium"));
  it("critical wins over bug", () => expect(derivePriorityFromLabels(["bug", "critical"])).toBe("critical"));
});

describe("triage", () => {
  it("calls Anthropic and returns summary", async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "Resumo curto do bug." }],
    });
    const fakeClient = { messages: { create } } as any;
    const out = await triage(
      { title: "App crashes", body: "When clicking X" },
      { client: fakeClient, model: "claude-haiku-4-5-20251001" },
    );
    expect(out).toBe("Resumo curto do bug.");
    expect(create).toHaveBeenCalledOnce();
    const args = create.mock.calls[0][0];
    expect(args.model).toBe("claude-haiku-4-5-20251001");
    expect(args.messages[0].content).toContain("App crashes");
  });

  it("returns a fallback when SDK fails", async () => {
    const create = vi.fn().mockRejectedValue(new Error("boom"));
    const fakeClient = { messages: { create } } as any;
    const out = await triage(
      { title: "x", body: "y" },
      { client: fakeClient, model: "claude-haiku-4-5-20251001" },
    );
    expect(out).toMatch(/Triagem indisponível/i);
  });
});
```

- [ ] **Step 2: Implement `agents/gh-analyzer/src/triage.ts`**

```ts
import type Anthropic from "@anthropic-ai/sdk";

export type TriagePriority = "critical" | "high" | "medium" | "low";

export function derivePriorityFromLabels(labels: string[]): TriagePriority {
  if (labels.includes("critical")) return "critical";
  if (labels.includes("bug")) return "high";
  if (labels.includes("enhancement")) return "medium";
  if (labels.includes("low")) return "low";
  return "medium";
}

export type TriageInput = { title: string; body: string };
export type TriageOptions = { client: Anthropic; model: string };

const PROMPT = `Você é um analista de triagem. Resuma o problema descrito em PORTUGUÊS, em UM parágrafo curto (3-5 frases). Aponte o que parece ser o sintoma observável e qualquer reprodução mencionada. Não invente detalhes. Não proponha solução.`;

export async function triage(input: TriageInput, opts: TriageOptions): Promise<string> {
  try {
    const res = await opts.client.messages.create({
      model: opts.model,
      max_tokens: 400,
      system: PROMPT,
      messages: [
        {
          role: "user",
          content: `Título: ${input.title}\n\nDescrição:\n${input.body || "(vazio)"}`,
        },
      ],
    });
    const text = res.content
      .map((b: any) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();
    return text || "Triagem indisponível: resposta vazia.";
  } catch (err) {
    return `Triagem indisponível: ${(err as Error).message}`;
  }
}
```

- [ ] **Step 3: Run, expect PASS**

`pnpm --filter @paperclipai/gh-analyzer test src/triage.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add agents/gh-analyzer/src/triage.ts agents/gh-analyzer/src/triage.test.ts
git commit -m "feat(gh-analyzer): triage helper using Haiku"
```

---

### Task 10: opened handler

**Files:**
- Create: `agents/gh-analyzer/src/handlers/opened.ts`
- Create: `agents/gh-analyzer/src/handlers/opened.test.ts`

Per spec §4.1: search for marker → if found, idempotent return; else create mirror issue with marker + triage summary + original body.

- [ ] **Step 1: Write the failing test**

`agents/gh-analyzer/src/handlers/opened.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { handleOpened } from "./opened.js";

const ghPayload = {
  action: "opened" as const,
  repository: { full_name: "simplafy/hub" },
  issue: { number: 7, title: "Crash on submit", body: "When I click X", labels: [{ name: "bug" }] },
  sender: { login: "alice" },
};

describe("handleOpened", () => {
  it("creates a new mirror issue when no marker matches", async () => {
    const client = {
      listProjectIssues: vi.fn().mockResolvedValue([{ id: "i-old", description: "<!-- gh-ref: simplafy/hub#999 -->\nx" }]),
      createIssue: vi.fn().mockResolvedValue({ id: "i-new" }),
    };
    const result = await handleOpened({
      payload: ghPayload as any,
      client: client as any,
      companyId: "c1",
      projectId: "p1",
      triage: async () => "RESUMO",
    });
    expect(result.action).toBe("created");
    expect(client.createIssue).toHaveBeenCalledOnce();
    const [, input] = client.createIssue.mock.calls[0];
    expect(input.projectId).toBe("p1");
    expect(input.title).toBe("[gh#7] Crash on submit");
    expect(input.priority).toBe("high"); // bug → high
    expect(input.description).toMatch(/^<!-- gh-ref: simplafy\/hub#7 -->/);
    expect(input.description).toContain("RESUMO");
    expect(input.description).toContain("When I click X");
  });

  it("returns idempotent skip when marker already exists", async () => {
    const existing = "<!-- gh-ref: simplafy/hub#7 -->\nbody";
    const client = {
      listProjectIssues: vi.fn().mockResolvedValue([{ id: "i-existing", description: existing }]),
      createIssue: vi.fn(),
    };
    const result = await handleOpened({
      payload: ghPayload as any,
      client: client as any,
      companyId: "c1",
      projectId: "p1",
      triage: async () => "irrelevant",
    });
    expect(result.action).toBe("skipped");
    expect(client.createIssue).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Implement `agents/gh-analyzer/src/handlers/opened.ts`**

```ts
import type { GhPayload } from "../payload.js";
import type { PaperclipClient, IssueSummary } from "../api-client.js";
import { extractGhRef, extractLabels } from "../payload.js";
import { formatMarker, hasMarker } from "../marker.js";
import { derivePriorityFromLabels } from "../triage.js";

export type OpenedDeps = {
  payload: GhPayload;
  client: Pick<PaperclipClient, "listProjectIssues" | "createIssue">;
  companyId: string;
  projectId: string;
  triage: (input: { title: string; body: string }) => Promise<string>;
};

export type HandlerResult =
  | { action: "created"; issueId: string }
  | { action: "skipped"; reason: string };

export async function handleOpened(deps: OpenedDeps): Promise<HandlerResult> {
  const ref = extractGhRef(deps.payload);
  if (!ref) return { action: "skipped", reason: "no gh-ref" };
  const marker = formatMarker(ref);

  const existing: IssueSummary[] = await deps.client.listProjectIssues(deps.companyId, deps.projectId);
  const dup = existing.find((i) => i.description != null && hasMarker(i.description, marker));
  if (dup) return { action: "skipped", reason: "duplicate marker" };

  const labels = extractLabels(deps.payload);
  const priority = derivePriorityFromLabels(labels);
  const title = `[gh#${ref.number}] ${deps.payload.issue?.title ?? "(sem título)"}`;
  const summary = await deps.triage({
    title: deps.payload.issue?.title ?? "",
    body: deps.payload.issue?.body ?? "",
  });
  const description = [
    marker,
    "",
    "## Análise",
    summary,
    "",
    "## Original",
    deps.payload.issue?.body ?? "(sem corpo)",
  ].join("\n");

  const created = await deps.client.createIssue(deps.companyId, {
    projectId: deps.projectId,
    title,
    description,
    priority,
    status: "todo",
  });
  return { action: "created", issueId: created.id };
}
```

- [ ] **Step 3: Run, expect PASS**

`pnpm --filter @paperclipai/gh-analyzer test src/handlers/opened.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add agents/gh-analyzer/src/handlers/opened.ts agents/gh-analyzer/src/handlers/opened.test.ts
git commit -m "feat(gh-analyzer): opened handler"
```

---

### Task 11: updated handler (edited + comment.created)

**Files:**
- Create: `agents/gh-analyzer/src/handlers/updated.ts`
- Create: `agents/gh-analyzer/src/handlers/updated.test.ts`

Per spec §4.2: find mirror by marker; if not found, return (close-before-open race). For `edited`, build a delta summary from `payload.changes` keys and post as comment. For `issue_comment.created`, post the comment body verbatim. **Never edit the mirror's description.**

- [ ] **Step 1: Write the failing test**

`agents/gh-analyzer/src/handlers/updated.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { handleUpdated } from "./updated.js";

const editedPayload = {
  action: "edited" as const,
  repository: { full_name: "simplafy/hub" },
  issue: { number: 7, title: "new", body: "new body", labels: [] },
  changes: { title: { from: "old" }, body: { from: "old body" } },
  sender: { login: "alice" },
};

const commentPayload = {
  action: "created" as const,
  repository: { full_name: "simplafy/hub" },
  issue: { number: 7, title: "t", body: "b", labels: [] },
  comment: { body: "Mais detalhes aqui.", user: { login: "bob" }, id: 1 },
  sender: { login: "bob" },
};

const mirror = { id: "i-mirror", description: "<!-- gh-ref: simplafy/hub#7 -->\nbody", status: "todo", priority: "high", projectId: "p1", companyId: "c1" };

describe("handleUpdated", () => {
  it("returns skipped when no mirror exists", async () => {
    const client = {
      listProjectIssues: vi.fn().mockResolvedValue([]),
      addComment: vi.fn(),
    };
    const r = await handleUpdated({ action: "edited", payload: editedPayload as any, client: client as any, companyId: "c1", projectId: "p1" });
    expect(r.action).toBe("skipped");
    expect(client.addComment).not.toHaveBeenCalled();
  });

  it("returns skipped on trivial edit (label-only)", async () => {
    const trivial = { ...editedPayload, changes: { labels: { from: [] } } };
    const client = {
      listProjectIssues: vi.fn().mockResolvedValue([mirror]),
      addComment: vi.fn(),
    };
    const r = await handleUpdated({ action: "edited", payload: trivial as any, client: client as any, companyId: "c1", projectId: "p1" });
    expect(r.action).toBe("skipped");
    expect(client.addComment).not.toHaveBeenCalled();
  });

  it("posts edit summary on content change", async () => {
    const client = {
      listProjectIssues: vi.fn().mockResolvedValue([mirror]),
      addComment: vi.fn().mockResolvedValue({ id: "c1" }),
    };
    const r = await handleUpdated({ action: "edited", payload: editedPayload as any, client: client as any, companyId: "c1", projectId: "p1" });
    expect(r.action).toBe("commented");
    const [issueId, body] = client.addComment.mock.calls[0];
    expect(issueId).toBe("i-mirror");
    expect(body).toContain("GH update");
    expect(body).toContain("alice");
    expect(body).toMatch(/title|body/);
  });

  it("posts comment body verbatim on issue_comment.created", async () => {
    const client = {
      listProjectIssues: vi.fn().mockResolvedValue([mirror]),
      addComment: vi.fn().mockResolvedValue({ id: "c1" }),
    };
    const r = await handleUpdated({ action: "issue_comment.created", payload: commentPayload as any, client: client as any, companyId: "c1", projectId: "p1" });
    expect(r.action).toBe("commented");
    const [, body] = client.addComment.mock.calls[0];
    expect(body).toContain("bob");
    expect(body).toContain("Mais detalhes aqui.");
  });
});
```

- [ ] **Step 2: Implement `agents/gh-analyzer/src/handlers/updated.ts`**

```ts
import type { GhPayload, GhAction } from "../payload.js";
import type { PaperclipClient, IssueSummary } from "../api-client.js";
import { extractGhRef } from "../payload.js";
import { formatMarker, hasMarker } from "../marker.js";
import { isTrivialDelta } from "../trivial-delta.js";
import type { HandlerResult } from "./opened.js";

export type UpdatedDeps = {
  action: Extract<GhAction, "edited" | "issue_comment.created">;
  payload: GhPayload;
  client: Pick<PaperclipClient, "listProjectIssues" | "addComment">;
  companyId: string;
  projectId: string;
};

export async function handleUpdated(deps: UpdatedDeps): Promise<HandlerResult> {
  const ref = extractGhRef(deps.payload);
  if (!ref) return { action: "skipped", reason: "no gh-ref" };
  const marker = formatMarker(ref);

  const issues: IssueSummary[] = await deps.client.listProjectIssues(deps.companyId, deps.projectId);
  const mirror = issues.find((i) => i.description != null && hasMarker(i.description, marker));
  if (!mirror) return { action: "skipped", reason: "no mirror" };

  if (isTrivialDelta(deps.action, deps.payload)) return { action: "skipped", reason: "trivial delta" };

  const author = deps.payload.sender?.login ?? "unknown";
  const ts = new Date().toISOString();
  let body: string;
  if (deps.action === "edited") {
    const fields = Object.keys(deps.payload.changes ?? {}).join(", ") || "(none)";
    body = `GH update (${ts}, by @${author}): edited fields — ${fields}.`;
  } else {
    const c = deps.payload.comment?.body ?? "";
    body = `GH comment (${ts}, by @${author}):\n\n${c}`;
  }
  await deps.client.addComment(mirror.id, body);
  return { action: "commented", issueId: mirror.id };
}
```

Note `HandlerResult` from `opened.ts` is `created | skipped`; extend it. Add a third variant in `opened.ts` and re-export:

Modify `agents/gh-analyzer/src/handlers/opened.ts` — change `HandlerResult` to:
```ts
export type HandlerResult =
  | { action: "created"; issueId: string }
  | { action: "commented"; issueId: string }
  | { action: "closed"; issueId: string }
  | { action: "skipped"; reason: string };
```

(This anticipates the closed handler in Task 12.)

- [ ] **Step 3: Run all gh-analyzer tests, expect PASS**

`pnpm --filter @paperclipai/gh-analyzer test`
Expected: PASS for all so far.

- [ ] **Step 4: Commit**

```bash
git add agents/gh-analyzer/src/handlers/opened.ts agents/gh-analyzer/src/handlers/updated.ts agents/gh-analyzer/src/handlers/updated.test.ts
git commit -m "feat(gh-analyzer): updated handler with trivial-delta filter"
```

---

### Task 12: closed handler

**Files:**
- Create: `agents/gh-analyzer/src/handlers/closed.ts`
- Create: `agents/gh-analyzer/src/handlers/closed.test.ts`

Per spec §4.5: find mirror; if absent or already done, return; else PATCH status=done and post a closure comment.

- [ ] **Step 1: Write the failing test**

`agents/gh-analyzer/src/handlers/closed.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { handleClosed } from "./closed.js";

const closedPayload = {
  action: "closed" as const,
  repository: { full_name: "simplafy/hub" },
  issue: { number: 7, title: "x", body: "", labels: [], state_reason: "completed" },
  sender: { login: "alice" },
};

describe("handleClosed", () => {
  it("skips when no mirror", async () => {
    const client = {
      listProjectIssues: vi.fn().mockResolvedValue([]),
      updateIssue: vi.fn(),
      addComment: vi.fn(),
    };
    const r = await handleClosed({ payload: closedPayload as any, client: client as any, companyId: "c1", projectId: "p1" });
    expect(r.action).toBe("skipped");
  });

  it("is idempotent when mirror already done", async () => {
    const mirror = { id: "i", description: "<!-- gh-ref: simplafy/hub#7 -->", status: "done", priority: "high", projectId: "p1", companyId: "c1" };
    const client = {
      listProjectIssues: vi.fn().mockResolvedValue([mirror]),
      updateIssue: vi.fn(),
      addComment: vi.fn(),
    };
    const r = await handleClosed({ payload: closedPayload as any, client: client as any, companyId: "c1", projectId: "p1" });
    expect(r.action).toBe("skipped");
    expect(client.updateIssue).not.toHaveBeenCalled();
  });

  it("sets status=done and comments otherwise", async () => {
    const mirror = { id: "i", description: "<!-- gh-ref: simplafy/hub#7 -->", status: "in_review", priority: "high", projectId: "p1", companyId: "c1" };
    const client = {
      listProjectIssues: vi.fn().mockResolvedValue([mirror]),
      updateIssue: vi.fn().mockResolvedValue({ id: "i" }),
      addComment: vi.fn().mockResolvedValue({ id: "c" }),
    };
    const r = await handleClosed({ payload: closedPayload as any, client: client as any, companyId: "c1", projectId: "p1" });
    expect(r.action).toBe("closed");
    expect(client.updateIssue).toHaveBeenCalledWith("i", { status: "done" });
    expect(client.addComment).toHaveBeenCalledOnce();
    const body = client.addComment.mock.calls[0][1] as string;
    expect(body).toContain("Closed via GH");
    expect(body).toContain("completed");
  });
});
```

- [ ] **Step 2: Implement `agents/gh-analyzer/src/handlers/closed.ts`**

```ts
import type { GhPayload } from "../payload.js";
import type { PaperclipClient, IssueSummary } from "../api-client.js";
import { extractGhRef } from "../payload.js";
import { formatMarker, hasMarker } from "../marker.js";
import type { HandlerResult } from "./opened.js";

export type ClosedDeps = {
  payload: GhPayload;
  client: Pick<PaperclipClient, "listProjectIssues" | "updateIssue" | "addComment">;
  companyId: string;
  projectId: string;
};

export async function handleClosed(deps: ClosedDeps): Promise<HandlerResult> {
  const ref = extractGhRef(deps.payload);
  if (!ref) return { action: "skipped", reason: "no gh-ref" };
  const marker = formatMarker(ref);
  const issues: IssueSummary[] = await deps.client.listProjectIssues(deps.companyId, deps.projectId);
  const mirror = issues.find((i) => i.description != null && hasMarker(i.description, marker));
  if (!mirror) return { action: "skipped", reason: "no mirror" };
  if (mirror.status === "done") return { action: "skipped", reason: "already done" };

  await deps.client.updateIssue(mirror.id, { status: "done" });
  const reason = deps.payload.issue?.state_reason ?? "closed";
  await deps.client.addComment(mirror.id, `Closed via GH issue close (${reason}).`);
  return { action: "closed", issueId: mirror.id };
}
```

- [ ] **Step 3: Run, expect PASS**

`pnpm --filter @paperclipai/gh-analyzer test`

- [ ] **Step 4: Commit**

```bash
git add agents/gh-analyzer/src/handlers/closed.ts agents/gh-analyzer/src/handlers/closed.test.ts
git commit -m "feat(gh-analyzer): closed handler"
```

---

### Task 13: Action dispatcher

**Files:**
- Create: `agents/gh-analyzer/src/dispatch.ts`
- Create: `agents/gh-analyzer/src/dispatch.test.ts`

The dispatcher is the funnel: it applies the label gate, dispatches to the right handler.

- [ ] **Step 1: Write the failing test**

`agents/gh-analyzer/src/dispatch.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { dispatch } from "./dispatch.js";

const base = {
  repository: { full_name: "simplafy/hub" },
  issue: { number: 7, title: "t", body: "b", labels: [{ name: "agent-eligible" }] },
  sender: { login: "x" },
};

describe("dispatch", () => {
  it("skips payloads without agent-eligible label", async () => {
    const handlers = { onOpened: vi.fn(), onUpdated: vi.fn(), onClosed: vi.fn() };
    const r = await dispatch({ payload: { ...base, action: "opened", issue: { ...base.issue, labels: [] } } as any, handlers, companyId: "c1", projectId: "p1" });
    expect(r.action).toBe("skipped");
    expect(handlers.onOpened).not.toHaveBeenCalled();
  });

  it("routes opened → onOpened", async () => {
    const handlers = { onOpened: vi.fn().mockResolvedValue({ action: "created", issueId: "i" }), onUpdated: vi.fn(), onClosed: vi.fn() };
    await dispatch({ payload: { ...base, action: "opened" } as any, handlers, companyId: "c1", projectId: "p1" });
    expect(handlers.onOpened).toHaveBeenCalledOnce();
  });

  it("routes edited → onUpdated", async () => {
    const handlers = { onOpened: vi.fn(), onUpdated: vi.fn().mockResolvedValue({ action: "skipped", reason: "x" }), onClosed: vi.fn() };
    await dispatch({ payload: { ...base, action: "edited", changes: { title: { from: "old" } } } as any, handlers, companyId: "c1", projectId: "p1" });
    expect(handlers.onUpdated).toHaveBeenCalledWith(expect.objectContaining({ action: "edited" }));
  });

  it("routes comment.created → onUpdated", async () => {
    const handlers = { onOpened: vi.fn(), onUpdated: vi.fn().mockResolvedValue({ action: "skipped", reason: "x" }), onClosed: vi.fn() };
    await dispatch({ payload: { ...base, action: "created", comment: { body: "hi" } } as any, handlers, companyId: "c1", projectId: "p1" });
    expect(handlers.onUpdated).toHaveBeenCalledWith(expect.objectContaining({ action: "issue_comment.created" }));
  });

  it("routes closed → onClosed", async () => {
    const handlers = { onOpened: vi.fn(), onUpdated: vi.fn(), onClosed: vi.fn().mockResolvedValue({ action: "skipped", reason: "x" }) };
    await dispatch({ payload: { ...base, action: "closed" } as any, handlers, companyId: "c1", projectId: "p1" });
    expect(handlers.onClosed).toHaveBeenCalledOnce();
  });

  it("returns skipped for ignored actions (e.g. labeled)", async () => {
    const handlers = { onOpened: vi.fn(), onUpdated: vi.fn(), onClosed: vi.fn() };
    const r = await dispatch({ payload: { ...base, action: "labeled" } as any, handlers, companyId: "c1", projectId: "p1" });
    expect(r.action).toBe("skipped");
  });
});
```

- [ ] **Step 2: Implement `agents/gh-analyzer/src/dispatch.ts`**

```ts
import type { GhPayload, GhAction } from "./payload.js";
import { extractAction, extractLabels } from "./payload.js";
import { hasAgentEligibleLabel } from "./label-gate.js";
import type { HandlerResult } from "./handlers/opened.js";

export type DispatchHandlers = {
  onOpened: (input: { payload: GhPayload; companyId: string; projectId: string }) => Promise<HandlerResult>;
  onUpdated: (input: { payload: GhPayload; action: Extract<GhAction, "edited" | "issue_comment.created">; companyId: string; projectId: string }) => Promise<HandlerResult>;
  onClosed: (input: { payload: GhPayload; companyId: string; projectId: string }) => Promise<HandlerResult>;
};

export type DispatchInput = {
  payload: GhPayload;
  handlers: DispatchHandlers;
  companyId: string;
  projectId: string;
};

export async function dispatch(input: DispatchInput): Promise<HandlerResult> {
  const action = extractAction(input.payload);
  if (action === "ignored") return { action: "skipped", reason: `action ignored: ${input.payload.action}` };

  const labels = extractLabels(input.payload);
  if (!hasAgentEligibleLabel(labels)) return { action: "skipped", reason: "missing agent-eligible label" };

  switch (action) {
    case "opened":
      return input.handlers.onOpened({ payload: input.payload, companyId: input.companyId, projectId: input.projectId });
    case "edited":
    case "issue_comment.created":
      return input.handlers.onUpdated({ payload: input.payload, action, companyId: input.companyId, projectId: input.projectId });
    case "closed":
      return input.handlers.onClosed({ payload: input.payload, companyId: input.companyId, projectId: input.projectId });
  }
}
```

- [ ] **Step 3: Run, expect PASS**

`pnpm --filter @paperclipai/gh-analyzer test`

- [ ] **Step 4: Commit**

```bash
git add agents/gh-analyzer/src/dispatch.ts agents/gh-analyzer/src/dispatch.test.ts
git commit -m "feat(gh-analyzer): action dispatcher"
```

---

### Task 14: Entry script (orchestration)

**Files:**
- Modify: `agents/gh-analyzer/src/index.ts` (replace stub)
- Create: `agents/gh-analyzer/src/index.test.ts`

The entry reads env, fetches the heartbeat run → issue → routine run → payload, runs dispatch, marks the routine-execution issue done.

Required env: `PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY`, `PAPERCLIP_RUN_ID`, `ANTHROPIC_API_KEY`.

- [ ] **Step 1: Write the failing test**

`agents/gh-analyzer/src/index.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { runAnalyzer } from "./index.js";

const ghPayload = {
  action: "opened" as const,
  repository: { full_name: "simplafy/hub" },
  issue: { number: 7, title: "t", body: "b", labels: [{ name: "agent-eligible" }] },
  sender: { login: "x" },
};

describe("runAnalyzer", () => {
  let client: any;
  let triage: any;

  beforeEach(() => {
    triage = vi.fn().mockResolvedValue("RESUMO");
    client = {
      getHeartbeatRun: vi.fn().mockResolvedValue({ id: "hr1", issueId: "i-trigger", companyId: "c1" }),
      getIssue: vi.fn().mockResolvedValue({
        id: "i-trigger",
        description: "(trigger)",
        status: "todo",
        priority: "medium",
        projectId: "p1",
        companyId: "c1",
        originRunId: "rr1",
      }),
      getRoutineRun: vi.fn().mockResolvedValue({ id: "rr1", triggerPayload: ghPayload, linkedIssueId: "i-trigger" }),
      listProjectIssues: vi.fn().mockResolvedValue([]),
      createIssue: vi.fn().mockResolvedValue({ id: "i-mirror" }),
      updateIssue: vi.fn().mockResolvedValue({ id: "i-trigger" }),
      addComment: vi.fn(),
    };
  });

  it("fetches run → issue → routineRun, dispatches, finalizes the trigger issue", async () => {
    const result = await runAnalyzer({ runId: "hr1", client, triage });
    expect(result.outcome).toBe("created");
    expect(client.createIssue).toHaveBeenCalledOnce();
    expect(client.updateIssue).toHaveBeenLastCalledWith("i-trigger", { status: "done" });
  });

  it("finalizes trigger issue even when handler skips", async () => {
    client.listProjectIssues.mockResolvedValue([{ id: "x", description: "<!-- gh-ref: simplafy/hub#7 -->" }]);
    const result = await runAnalyzer({ runId: "hr1", client, triage });
    expect(result.outcome).toBe("skipped");
    expect(client.updateIssue).toHaveBeenCalledWith("i-trigger", { status: "done" });
  });

  it("throws if originRunId is missing", async () => {
    client.getIssue.mockResolvedValue({ id: "i-trigger", description: null, status: "todo", priority: null, projectId: "p1", companyId: "c1", originRunId: null });
    await expect(runAnalyzer({ runId: "hr1", client, triage })).rejects.toThrow(/originRunId/);
  });

  it("throws if triggerPayload is missing", async () => {
    client.getRoutineRun.mockResolvedValue({ id: "rr1", triggerPayload: null, linkedIssueId: "i-trigger" });
    await expect(runAnalyzer({ runId: "hr1", client, triage })).rejects.toThrow(/triggerPayload/);
  });
});
```

- [ ] **Step 2: Implement `agents/gh-analyzer/src/index.ts`**

```ts
#!/usr/bin/env node
import Anthropic from "@anthropic-ai/sdk";
import { PaperclipClient } from "./api-client.js";
import { dispatch } from "./dispatch.js";
import { handleOpened } from "./handlers/opened.js";
import { handleUpdated } from "./handlers/updated.js";
import { handleClosed } from "./handlers/closed.js";
import { triage as defaultTriage } from "./triage.js";
import type { GhPayload } from "./payload.js";

const HAIKU_MODEL = "claude-haiku-4-5-20251001";

export type AnalyzerDeps = {
  runId: string;
  client: Pick<
    PaperclipClient,
    "getHeartbeatRun" | "getIssue" | "getRoutineRun" | "listProjectIssues" | "createIssue" | "updateIssue" | "addComment"
  >;
  triage: (input: { title: string; body: string }) => Promise<string>;
};

export type AnalyzerResult = { outcome: "created" | "commented" | "closed" | "skipped"; reason?: string };

export async function runAnalyzer(deps: AnalyzerDeps): Promise<AnalyzerResult> {
  const hb = await deps.client.getHeartbeatRun(deps.runId);
  if (!hb.issueId) throw new Error("heartbeat run has no issueId");

  const triggerIssue = await deps.client.getIssue(hb.issueId);
  if (!triggerIssue.originRunId) throw new Error("trigger issue has no originRunId");
  if (!triggerIssue.projectId) throw new Error("trigger issue has no projectId");

  const routineRun = await deps.client.getRoutineRun(triggerIssue.originRunId);
  if (!routineRun.triggerPayload) throw new Error("routine run has no triggerPayload");

  const payload = routineRun.triggerPayload as GhPayload;
  const handlerResult = await dispatch({
    payload,
    companyId: triggerIssue.companyId,
    projectId: triggerIssue.projectId,
    handlers: {
      onOpened: ({ payload, companyId, projectId }) =>
        handleOpened({
          payload,
          client: deps.client,
          companyId,
          projectId,
          triage: deps.triage,
        }),
      onUpdated: ({ payload, action, companyId, projectId }) =>
        handleUpdated({ payload, action, client: deps.client, companyId, projectId }),
      onClosed: ({ payload, companyId, projectId }) =>
        handleClosed({ payload, client: deps.client, companyId, projectId }),
    },
  });

  // Finalize the routine-execution (trigger) issue regardless of outcome.
  await deps.client.updateIssue(triggerIssue.id, { status: "done" });

  const outcome = handlerResult.action === "skipped" ? "skipped" : handlerResult.action;
  return { outcome, reason: handlerResult.action === "skipped" ? handlerResult.reason : undefined };
}

async function main(): Promise<void> {
  const apiUrl = mustEnv("PAPERCLIP_API_URL");
  const apiKey = mustEnv("PAPERCLIP_API_KEY");
  const runId = mustEnv("PAPERCLIP_RUN_ID");
  const anthropicKey = mustEnv("ANTHROPIC_API_KEY");

  const anthropic = new Anthropic({ apiKey: anthropicKey });
  const client = new PaperclipClient({ apiUrl, apiKey });

  const result = await runAnalyzer({
    runId,
    client,
    triage: (input) => defaultTriage(input, { client: anthropic, model: HAIKU_MODEL }),
  });

  console.log(JSON.stringify({ ok: true, ...result }));
}

function mustEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`Missing required env: ${name}`);
    process.exit(2);
  }
  return v;
}

if (process.argv[1] && process.argv[1].endsWith("/dist/index.js")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
```

- [ ] **Step 3: Run all tests**

`pnpm --filter @paperclipai/gh-analyzer test`
Expected: PASS for everything.

- [ ] **Step 4: Build**

`pnpm --filter @paperclipai/gh-analyzer build`
Expected: `dist/index.js` exists.

- [ ] **Step 5: Commit**

```bash
git add agents/gh-analyzer/src/index.ts agents/gh-analyzer/src/index.test.ts
git commit -m "feat(gh-analyzer): orchestrating entry script"
```

---

### Task 15: Dockerfile updates

**Files:**
- Modify: `Dockerfile`

The image must include the compiled analyzer at `/app/agents/gh-analyzer/dist/`.

- [ ] **Step 1: Add deps copy**

After line 32 (`packages/plugins/sdk/package.json`) and before the `--parents` copy, add:
```
COPY agents/gh-analyzer/package.json agents/gh-analyzer/
```

- [ ] **Step 2: Add build step**

After line 45 (`RUN pnpm --filter @paperclipai/server build`), add:
```
RUN pnpm --filter @paperclipai/gh-analyzer build
RUN test -f agents/gh-analyzer/dist/index.js || (echo "ERROR: gh-analyzer build output missing" && exit 1)
```

- [ ] **Step 3: Build the image**

```bash
docker compose -f docker/docker-compose.quickstart.yml --env-file .env build paperclip
```

Expected: build completes; the `gh-analyzer build` step produces output.

- [ ] **Step 4: Verify the artifact lives in the image**

```bash
docker compose -f docker/docker-compose.quickstart.yml --env-file .env run --rm paperclip ls /app/agents/gh-analyzer/dist
```

Expected: lists `index.js`.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile
git commit -m "build(docker): include gh-analyzer in image"
```

---

### Task 16: gh-analyzer AGENT.md

**Files:**
- Create: `agents/gh-analyzer/AGENT.md`

This is operator-facing — describes how to register the agent and what env it needs.

- [ ] **Step 1: Write the file**

```markdown
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
```

- [ ] **Step 2: Commit**

```bash
git add agents/gh-analyzer/AGENT.md
git commit -m "docs(gh-analyzer): operator AGENT.md"
```

---

### Task 17: gh-codador AGENT.md

**Files:**
- Create: `agents/gh-codador/AGENT.md`

Per spec §4.4 + §8.4: branch unique per issue, PR body contains `Closes #{issue.number}`. The codador uses the existing `claude_local` adapter — there is no companion Node package; the agent's behavior is driven by Claude Code + the prompt below.

- [ ] **Step 1: Write the file**

```markdown
# gh-codador

Develops fixes for Paperclip mirror issues that originated from GitHub. Triggered when a human reassigns a mirror to this agent and flips status `todo → in_progress`.

## Adapter

`claude_local` — full code workspace, session persistence, branch checkouts.

## Agent record

| Field | Value |
|---|---|
| `name` | `gh-codador` |
| `adapterType` | `claude_local` |
| `model` | `claude-sonnet-4-6` (default; bump to `claude-opus-4-7` for complex issues) |
| `executionPolicy` | per-issue branch from project's `repoUrl` + `repoRef` |

## Working agreement (system prompt seed — full prompt is the entire file below)

You are a coding agent assigned a Paperclip task that mirrors a GitHub issue (look for the `<!-- gh-ref: owner/repo#N -->` marker as the first non-empty line of the issue description).

### Your job

1. Read the mirror issue's description (`## Análise` and `## Original` sections) and any comments.
2. Locate the relevant code, propose a minimal fix, write tests if the project has a test runner.
3. Create a branch named `agent/gh-{N}-{short-slug}` (where `{N}` is the GH issue number from the marker, and `{short-slug}` is a 3-5 word kebab-case summary).
4. Commit your changes with a message that ends with `Refs gh#{N}`.
5. Push the branch and open a **draft PR** against the project's default branch. The PR body MUST start with `Closes #{N}` so that GitHub auto-closes the issue when the PR merges.
6. Comment on the Paperclip task with the PR URL.
7. Transition the Paperclip task to `in_review`.

### Constraints

- Never merge your own PR.
- Never push to the default branch directly.
- Never resolve the Paperclip task to `done` yourself — the GitHub `closed` webhook will do that via the analyzer.
- If you cannot reproduce or scope the issue, transition the task to `blocked` and explain in a comment.

### Tools

You have access to Paperclip's MCP server (issue search, comment, status update) plus the host's git, bash, and language-specific tooling.
```

- [ ] **Step 2: Commit**

```bash
git add agents/gh-codador/AGENT.md
git commit -m "docs(gh-codador): operator AGENT.md and prompt"
```

---

### Task 18: Bootstrap script for the global agents

**Files:**
- Create: `scripts/gh-integration/ensure-agents.ts`

Idempotent script that creates/updates the two global agent records. Run via `pnpm tsx scripts/gh-integration/ensure-agents.ts` against a Paperclip API.

- [ ] **Step 1: Write the script**

```ts
#!/usr/bin/env -S pnpm tsx
/**
 * Idempotently ensures the global gh-analyzer and gh-codador agent records exist
 * for a given company.
 *
 * Usage:
 *   PAPERCLIP_API_URL=http://localhost:3100 \
 *   PAPERCLIP_API_KEY=<admin-token> \
 *   PAPERCLIP_COMPANY_ID=<uuid> \
 *   ANTHROPIC_API_KEY_SECRET_ID=<secret-uuid> \
 *   pnpm tsx scripts/gh-integration/ensure-agents.ts
 */

type AgentSpec = {
  name: string;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  model: string;
};

const ANALYZER: AgentSpec = {
  name: "gh-analyzer",
  adapterType: "process",
  adapterConfig: {
    command: "node",
    args: ["/app/agents/gh-analyzer/dist/index.js"],
    timeoutSec: 120,
    env: {
      ANTHROPIC_API_KEY: { secretRef: process.env.ANTHROPIC_API_KEY_SECRET_ID ?? "" },
    },
  },
  model: "claude-haiku-4-5-20251001",
};

const CODADOR: AgentSpec = {
  name: "gh-codador",
  adapterType: "claude_local",
  adapterConfig: { model: "claude-sonnet-4-6" },
  model: "claude-sonnet-4-6",
};

async function main(): Promise<void> {
  const apiUrl = mustEnv("PAPERCLIP_API_URL").replace(/\/$/, "");
  const apiKey = mustEnv("PAPERCLIP_API_KEY");
  const companyId = mustEnv("PAPERCLIP_COMPANY_ID");

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  for (const spec of [ANALYZER, CODADOR]) {
    const existing = await fetchExistingByName(apiUrl, headers, companyId, spec.name);
    if (existing) {
      console.log(`[ensure-agents] ${spec.name} exists (id=${existing.id}); patching adapter config.`);
      const res = await fetch(`${apiUrl}/api/agents/${existing.id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({
          adapterType: spec.adapterType,
          adapterConfig: spec.adapterConfig,
          model: spec.model,
        }),
      });
      if (!res.ok) throw new Error(`PATCH ${spec.name}: ${res.status} ${await res.text()}`);
    } else {
      console.log(`[ensure-agents] creating ${spec.name}`);
      const res = await fetch(`${apiUrl}/api/companies/${companyId}/agents`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: spec.name, ...spec }),
      });
      if (!res.ok) throw new Error(`POST ${spec.name}: ${res.status} ${await res.text()}`);
      const created = (await res.json()) as { id: string };
      console.log(`[ensure-agents] created ${spec.name} (id=${created.id})`);
    }
  }
  console.log("[ensure-agents] done.");
}

async function fetchExistingByName(
  apiUrl: string,
  headers: Record<string, string>,
  companyId: string,
  name: string,
): Promise<{ id: string } | null> {
  const res = await fetch(`${apiUrl}/api/companies/${companyId}/agents`, { headers });
  if (!res.ok) throw new Error(`list agents: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { items?: Array<{ id: string; name: string }> } | Array<{ id: string; name: string }>;
  const items = Array.isArray(body) ? body : body.items ?? [];
  return items.find((a) => a.name === name) ?? null;
}

function mustEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`Missing env: ${name}`);
    process.exit(2);
  }
  return v;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 2: Smoke run against the dev instance**

```bash
PAPERCLIP_API_URL=http://localhost:3100 \
  PAPERCLIP_API_KEY=<admin-token> \
  PAPERCLIP_COMPANY_ID=<uuid> \
  ANTHROPIC_API_KEY_SECRET_ID=<secret-uuid> \
  pnpm tsx scripts/gh-integration/ensure-agents.ts
```

Expected output: `[ensure-agents] creating gh-analyzer ... created ... creating gh-codador ... created ... done.`

If the create-agent route signature differs from what's assumed (POST `/api/companies/:companyId/agents` with `{ name, adapterType, adapterConfig, model }`), fix the script to match `server/src/routes/agents.ts:1660` (the existing `createAgentSchema` validator).

- [ ] **Step 3: Verify idempotency**

Re-run the same command. Expected output: `[ensure-agents] gh-analyzer exists ... patching ... gh-codador exists ... patching ... done.` No errors, no duplicates.

- [ ] **Step 4: Commit**

```bash
git add scripts/gh-integration/ensure-agents.ts
git commit -m "feat(scripts): ensure-agents bootstrap for gh-analyzer and gh-codador"
```

---

### Task 19: Connect-repo runbook

**Files:**
- Create: `scripts/gh-integration/connect-repo.md`

Captures the manual setup checklist (spec §6) as a step-by-step that an operator follows once per new repo. **No code change** — just the runbook.

- [ ] **Step 1: Write the runbook**

```markdown
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
```

- [ ] **Step 2: Commit**

```bash
git add scripts/gh-integration/connect-repo.md
git commit -m "docs(gh-integration): per-repo connect runbook"
```

---

### Task 20: End-to-end smoke test against a real GitHub repo

**Files:** none (operational verification).

This is the §6 smoke test from the spec, run as the final acceptance for the integration.

- [ ] **Step 1: Pick a test repo and run `ensure-agents.ts`**

Use a low-stakes repo (e.g. a sandbox or fork). Run the bootstrap if not already.

- [ ] **Step 2: Provision the repo**

Follow the runbook from Task 19 — capture `TRIGGER_PUBLIC_ID` and configure the GH webhook with the secret.

- [ ] **Step 3: Open a test issue with `agent-eligible` label**

GitHub UI → New issue. Title: `Smoke test #1 from {your-handle}`. Body: a paragraph describing a fake bug (something the codador *would* be able to handle if invoked, but we won't invoke it here).

- [ ] **Step 4: Verify mirror creation**

Within ~10s:
- Mirror issue appears in Paperclip with title `[gh#N] Smoke test #1 from ...`.
- Description first line is `<!-- gh-ref: <owner>/<repo>#N -->`.
- Description has `## Análise` (the Haiku summary) and `## Original` (raw body).
- Priority is `medium` (no `bug`/`critical` label) or `high` (if `bug` label was added alongside).

- [ ] **Step 5: Add a comment on the GH issue**

Body: `Mais um detalhe — só acontece em Firefox.`

Within ~10s, a comment on the Paperclip mirror reads `GH comment (... by @{you}): Mais um detalhe — só acontece em Firefox.`

- [ ] **Step 6: Edit the GH issue title**

Within ~10s, a comment reads `GH update (... by @{you}): edited fields — title.`

- [ ] **Step 7: Add a label only**

(no edit beyond label change). Within ~10s, NO new comment on the mirror — the trivial-delta filter must drop it.

- [ ] **Step 8: Close the GH issue**

Within ~10s, the Paperclip mirror status flips to `done` and a comment reads `Closed via GH issue close (completed).`

- [ ] **Step 9: Re-deliver the close webhook (idempotency)**

GitHub repo Settings → Webhooks → recent delivery → Redeliver. The mirror remains `done`; the analyzer skips with reason `already done`. No new comment.

- [ ] **Step 10: Document the test results**

Open a new Paperclip issue (or update an existing tracking task) with the smoke test summary (which steps passed, which routine run ids, any unexpected behavior). This issue is the acceptance record.

---

## Self-review

After implementing, run end-to-end checks:

1. `pnpm install && pnpm -r typecheck && pnpm test` — full repo green.
2. `pnpm --filter @paperclipai/gh-analyzer test` — agent unit tests green.
3. `docker compose -f docker/docker-compose.quickstart.yml --env-file .env build paperclip` — image builds.
4. `docker compose -f docker/docker-compose.quickstart.yml --env-file .env run --rm paperclip ls /app/agents/gh-analyzer/dist/index.js` — artifact present.
5. Smoke test from Task 20 passes.

## Out of scope (deferred from spec §7)

- Auto-merge / branch policy enforcement.
- Auto-labeling on GitHub.
- Bidirectional comment sync (Paperclip → GitHub).
- GlitchTip integration changes.
- Multi-org GitHub support.
- A provisioning CLI command (replaces the manual runbook in Task 19).
