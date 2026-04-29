import { describe, it, expect, vi } from "vitest";
import { handleClosed } from "./closed.js";

const closedPayload = {
  action: "closed" as const,
  repository: { full_name: "simplafy/hub" },
  issue: { number: 7, title: "x", body: "", labels: [], state_reason: "completed" },
  sender: { login: "alice" },
};

describe("handleClosed", () => {
  it("skips when no mirror", async () => {
    const client = {
      listProjectIssues: vi.fn().mockResolvedValue([]),
      updateIssue: vi.fn(),
      addComment: vi.fn(),
    };
    const r = await handleClosed({ payload: closedPayload as any, client: client as any, companyId: "c1", projectId: "p1" });
    expect(r.action).toBe("skipped");
  });

  it("is idempotent when mirror already done", async () => {
    const mirror = { id: "i", description: "<!-- gh-ref: simplafy/hub#7 -->", status: "done", priority: "high", projectId: "p1", companyId: "c1" };
    const client = {
      listProjectIssues: vi.fn().mockResolvedValue([mirror]),
      updateIssue: vi.fn(),
      addComment: vi.fn(),
    };
    const r = await handleClosed({ payload: closedPayload as any, client: client as any, companyId: "c1", projectId: "p1" });
    expect(r.action).toBe("skipped");
    expect(client.updateIssue).not.toHaveBeenCalled();
  });

  it("sets status=done and comments otherwise", async () => {
    const mirror = { id: "i", description: "<!-- gh-ref: simplafy/hub#7 -->", status: "in_review", priority: "high", projectId: "p1", companyId: "c1" };
    const client = {
      listProjectIssues: vi.fn().mockResolvedValue([mirror]),
      updateIssue: vi.fn().mockResolvedValue({ id: "i" }),
      addComment: vi.fn().mockResolvedValue({ id: "c" }),
    };
    const r = await handleClosed({ payload: closedPayload as any, client: client as any, companyId: "c1", projectId: "p1" });
    expect(r.action).toBe("closed");
    expect(client.updateIssue).toHaveBeenCalledWith("i", { status: "done" });
    expect(client.addComment).toHaveBeenCalledOnce();
    const body = client.addComment.mock.calls[0][1] as string;
    expect(body).toContain("Closed via GH");
    expect(body).toContain("completed");
  });
});
