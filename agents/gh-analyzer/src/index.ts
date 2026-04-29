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
