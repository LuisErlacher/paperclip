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
