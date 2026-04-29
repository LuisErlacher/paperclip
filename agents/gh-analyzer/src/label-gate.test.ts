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
