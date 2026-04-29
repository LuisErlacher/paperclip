import { describe, it, expect, vi, beforeEach } from "vitest";
import { PaperclipClient } from "./api-client.js";

describe("PaperclipClient", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let client: PaperclipClient;

  beforeEach(() => {
    fetchMock = vi.fn();
    client = new PaperclipClient({
      apiUrl: "http://localhost:3100",
      apiKey: "k",
      fetchImpl: fetchMock as any,
    });
  });

  it("getHeartbeatRun → GET /heartbeat-runs/:id with bearer", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "r1", issueId: "i1", companyId: "c1" }), { status: 200 }));
    const r = await client.getHeartbeatRun("r1");
    expect(r).toEqual({ id: "r1", issueId: "i1", companyId: "c1" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3100/api/heartbeat-runs/r1",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer k" }) }),
    );
  });

  it("getRoutineRun → GET /routine-runs/:id", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "rr1", triggerPayload: { action: "opened" } }), { status: 200 }));
    const r = await client.getRoutineRun("rr1");
    expect(r.triggerPayload).toEqual({ action: "opened" });
  });

  it("getIssue → GET /issues/:id", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "i1", description: "d", originRunId: "rr1", projectId: "p1", companyId: "c1" }), { status: 200 }));
    const i = await client.getIssue("i1");
    expect(i.originRunId).toBe("rr1");
  });

  it("listProjectIssues → GET /companies/:cid/issues?projectId=:pid&limit=200", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ items: [{ id: "i1", description: "<!-- gh-ref: a/b#1 -->\nbody" }] }), { status: 200 }));
    const items = await client.listProjectIssues("c1", "p1");
    expect(items).toHaveLength(1);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("/api/companies/c1/issues");
    expect(url).toContain("projectId=p1");
  });

  it("createIssue → POST /companies/:cid/issues", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "i2" }), { status: 201 }));
    await client.createIssue("c1", { projectId: "p1", title: "t", description: "d", priority: "high" });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:3100/api/companies/c1/issues");
    expect((opts as any).method).toBe("POST");
    expect(JSON.parse((opts as any).body)).toMatchObject({ projectId: "p1", title: "t", priority: "high" });
  });

  it("addComment → POST /issues/:id/comments", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "c1" }), { status: 201 }));
    await client.addComment("i1", "hello");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3100/api/issues/i1/comments",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("updateIssue → PATCH /issues/:id", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "i1" }), { status: 200 }));
    await client.updateIssue("i1", { status: "done" });
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:3100/api/issues/i1",
      expect.objectContaining({ method: "PATCH" }),
    );
  });

  it("throws PaperclipApiError on non-2xx", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "nope" }), { status: 500 }));
    await expect(client.getIssue("i1")).rejects.toThrow(/500/);
  });
});
