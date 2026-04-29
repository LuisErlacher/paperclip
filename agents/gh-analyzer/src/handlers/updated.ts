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
