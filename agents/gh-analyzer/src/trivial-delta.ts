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
