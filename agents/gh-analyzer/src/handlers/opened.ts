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
  | { action: "commented"; issueId: string }
  | { action: "closed"; issueId: string }
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
