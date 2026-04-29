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
