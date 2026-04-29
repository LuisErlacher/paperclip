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
