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
