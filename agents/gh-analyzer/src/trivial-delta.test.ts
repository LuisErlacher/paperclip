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
