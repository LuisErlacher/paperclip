import { describe, it, expect, vi, beforeEach } from "vitest";
import { runAnalyzer } from "./index.js";

const ghPayload = {
  action: "opened" as const,
  repository: { full_name: "simplafy/hub" },
  issue: { number: 7, title: "t", body: "b", labels: [{ name: "agent-eligible" }] },
  sender: { login: "x" },
};

describe("runAnalyzer", () => {
  let client: any;
  let triage: any;

  beforeEach(() => {
    triage = vi.fn().mockResolvedValue("RESUMO");
    client = {
      getHeartbeatRun: vi.fn().mockResolvedValue({ id: "hr1", issueId: "i-trigger", companyId: "c1" }),
      getIssue: vi.fn().mockResolvedValue({
        id: "i-trigger",
        description: "(trigger)",
        status: "todo",
        priority: "medium",
        projectId: "p1",
        companyId: "c1",
        originRunId: "rr1",
      }),
      getRoutineRun: vi.fn().mockResolvedValue({ id: "rr1", triggerPayload: ghPayload, linkedIssueId: "i-trigger" }),
      listProjectIssues: vi.fn().mockResolvedValue([]),
      createIssue: vi.fn().mockResolvedValue({ id: "i-mirror" }),
      updateIssue: vi.fn().mockResolvedValue({ id: "i-trigger" }),
      addComment: vi.fn(),
    };
  });

  it("fetches run → issue → routineRun, dispatches, finalizes the trigger issue", async () => {
    const result = await runAnalyzer({ runId: "hr1", client, triage });
    expect(result.outcome).toBe("created");
    expect(client.createIssue).toHaveBeenCalledOnce();
    expect(client.updateIssue).toHaveBeenLastCalledWith("i-trigger", { status: "done" });
  });

  it("finalizes trigger issue even when handler skips", async () => {
    client.listProjectIssues.mockResolvedValue([{ id: "x", description: "<!-- gh-ref: simplafy/hub#7 -->" }]);
    const result = await runAnalyzer({ runId: "hr1", client, triage });
    expect(result.outcome).toBe("skipped");
    expect(client.updateIssue).toHaveBeenCalledWith("i-trigger", { status: "done" });
  });

  it("throws if originRunId is missing", async () => {
    client.getIssue.mockResolvedValue({ id: "i-trigger", description: null, status: "todo", priority: null, projectId: "p1", companyId: "c1", originRunId: null });
    await expect(runAnalyzer({ runId: "hr1", client, triage })).rejects.toThrow(/originRunId/);
  });

  it("throws if triggerPayload is missing", async () => {
    client.getRoutineRun.mockResolvedValue({ id: "rr1", triggerPayload: null, linkedIssueId: "i-trigger" });
    await expect(runAnalyzer({ runId: "hr1", client, triage })).rejects.toThrow(/triggerPayload/);
  });
});
