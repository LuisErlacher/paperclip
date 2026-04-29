import { describe, it, expect, vi } from "vitest";
import { handleOpened } from "./opened.js";

const ghPayload = {
  action: "opened" as const,
  repository: { full_name: "simplafy/hub" },
  issue: { number: 7, title: "Crash on submit", body: "When I click X", labels: [{ name: "bug" }] },
  sender: { login: "alice" },
};

describe("handleOpened", () => {
  it("creates a new mirror issue when no marker matches", async () => {
    const client = {
      listProjectIssues: vi.fn().mockResolvedValue([{ id: "i-old", description: "<!-- gh-ref: simplafy/hub#999 -->\nx" }]),
      createIssue: vi.fn().mockResolvedValue({ id: "i-new" }),
    };
    const result = await handleOpened({
      payload: ghPayload as any,
      client: client as any,
      companyId: "c1",
      projectId: "p1",
      triage: async () => "RESUMO",
    });
    expect(result.action).toBe("created");
    expect(client.createIssue).toHaveBeenCalledOnce();
    const [, input] = client.createIssue.mock.calls[0];
    expect(input.projectId).toBe("p1");
    expect(input.title).toBe("[gh#7] Crash on submit");
    expect(input.priority).toBe("high"); // bug → high
    expect(input.description).toMatch(/^<!-- gh-ref: simplafy\/hub#7 -->/);
    expect(input.description).toContain("RESUMO");
    expect(input.description).toContain("When I click X");
  });

  it("returns idempotent skip when marker already exists", async () => {
    const existing = "<!-- gh-ref: simplafy/hub#7 -->\nbody";
    const client = {
      listProjectIssues: vi.fn().mockResolvedValue([{ id: "i-existing", description: existing }]),
      createIssue: vi.fn(),
    };
    const result = await handleOpened({
      payload: ghPayload as any,
      client: client as any,
      companyId: "c1",
      projectId: "p1",
      triage: async () => "irrelevant",
    });
    expect(result.action).toBe("skipped");
    expect(client.createIssue).not.toHaveBeenCalled();
  });
});
