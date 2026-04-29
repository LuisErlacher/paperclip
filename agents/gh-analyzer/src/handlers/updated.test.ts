import { describe, it, expect, vi } from "vitest";
import { handleUpdated } from "./updated.js";

const editedPayload = {
  action: "edited" as const,
  repository: { full_name: "simplafy/hub" },
  issue: { number: 7, title: "new", body: "new body", labels: [] },
  changes: { title: { from: "old" }, body: { from: "old body" } },
  sender: { login: "alice" },
};

const commentPayload = {
  action: "created" as const,
  repository: { full_name: "simplafy/hub" },
  issue: { number: 7, title: "t", body: "b", labels: [] },
  comment: { body: "Mais detalhes aqui.", user: { login: "bob" }, id: 1 },
  sender: { login: "bob" },
};

const mirror = { id: "i-mirror", description: "<!-- gh-ref: simplafy/hub#7 -->\nbody", status: "todo", priority: "high", projectId: "p1", companyId: "c1" };

describe("handleUpdated", () => {
  it("returns skipped when no mirror exists", async () => {
    const client = {
      listProjectIssues: vi.fn().mockResolvedValue([]),
      addComment: vi.fn(),
    };
    const r = await handleUpdated({ action: "edited", payload: editedPayload as any, client: client as any, companyId: "c1", projectId: "p1" });
    expect(r.action).toBe("skipped");
    expect(client.addComment).not.toHaveBeenCalled();
  });

  it("returns skipped on trivial edit (label-only)", async () => {
    const trivial = { ...editedPayload, changes: { labels: { from: [] } } };
    const client = {
      listProjectIssues: vi.fn().mockResolvedValue([mirror]),
      addComment: vi.fn(),
    };
    const r = await handleUpdated({ action: "edited", payload: trivial as any, client: client as any, companyId: "c1", projectId: "p1" });
    expect(r.action).toBe("skipped");
    expect(client.addComment).not.toHaveBeenCalled();
  });

  it("posts edit summary on content change", async () => {
    const client = {
      listProjectIssues: vi.fn().mockResolvedValue([mirror]),
      addComment: vi.fn().mockResolvedValue({ id: "c1" }),
    };
    const r = await handleUpdated({ action: "edited", payload: editedPayload as any, client: client as any, companyId: "c1", projectId: "p1" });
    expect(r.action).toBe("commented");
    const [issueId, body] = client.addComment.mock.calls[0];
    expect(issueId).toBe("i-mirror");
    expect(body).toContain("GH update");
    expect(body).toContain("alice");
    expect(body).toMatch(/title|body/);
  });

  it("posts comment body verbatim on issue_comment.created", async () => {
    const client = {
      listProjectIssues: vi.fn().mockResolvedValue([mirror]),
      addComment: vi.fn().mockResolvedValue({ id: "c1" }),
    };
    const r = await handleUpdated({ action: "issue_comment.created", payload: commentPayload as any, client: client as any, companyId: "c1", projectId: "p1" });
    expect(r.action).toBe("commented");
    const [, body] = client.addComment.mock.calls[0];
    expect(body).toContain("bob");
    expect(body).toContain("Mais detalhes aqui.");
  });
});
