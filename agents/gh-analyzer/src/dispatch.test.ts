import { describe, it, expect, vi } from "vitest";
import { dispatch } from "./dispatch.js";

const base = {
  repository: { full_name: "simplafy/hub" },
  issue: { number: 7, title: "t", body: "b", labels: [{ name: "agent-eligible" }] },
  sender: { login: "x" },
};

describe("dispatch", () => {
  it("skips payloads without agent-eligible label", async () => {
    const handlers = { onOpened: vi.fn(), onUpdated: vi.fn(), onClosed: vi.fn() };
    const r = await dispatch({ payload: { ...base, action: "opened", issue: { ...base.issue, labels: [] } } as any, handlers, companyId: "c1", projectId: "p1" });
    expect(r.action).toBe("skipped");
    expect(handlers.onOpened).not.toHaveBeenCalled();
  });

  it("routes opened → onOpened", async () => {
    const handlers = { onOpened: vi.fn().mockResolvedValue({ action: "created", issueId: "i" }), onUpdated: vi.fn(), onClosed: vi.fn() };
    await dispatch({ payload: { ...base, action: "opened" } as any, handlers, companyId: "c1", projectId: "p1" });
    expect(handlers.onOpened).toHaveBeenCalledOnce();
  });

  it("routes edited → onUpdated", async () => {
    const handlers = { onOpened: vi.fn(), onUpdated: vi.fn().mockResolvedValue({ action: "skipped", reason: "x" }), onClosed: vi.fn() };
    await dispatch({ payload: { ...base, action: "edited", changes: { title: { from: "old" } } } as any, handlers, companyId: "c1", projectId: "p1" });
    expect(handlers.onUpdated).toHaveBeenCalledWith(expect.objectContaining({ action: "edited" }));
  });

  it("routes comment.created → onUpdated", async () => {
    const handlers = { onOpened: vi.fn(), onUpdated: vi.fn().mockResolvedValue({ action: "skipped", reason: "x" }), onClosed: vi.fn() };
    await dispatch({ payload: { ...base, action: "created", comment: { body: "hi" } } as any, handlers, companyId: "c1", projectId: "p1" });
    expect(handlers.onUpdated).toHaveBeenCalledWith(expect.objectContaining({ action: "issue_comment.created" }));
  });

  it("routes closed → onClosed", async () => {
    const handlers = { onOpened: vi.fn(), onUpdated: vi.fn(), onClosed: vi.fn().mockResolvedValue({ action: "skipped", reason: "x" }) };
    await dispatch({ payload: { ...base, action: "closed" } as any, handlers, companyId: "c1", projectId: "p1" });
    expect(handlers.onClosed).toHaveBeenCalledOnce();
  });

  it("returns skipped for ignored actions (e.g. labeled)", async () => {
    const handlers = { onOpened: vi.fn(), onUpdated: vi.fn(), onClosed: vi.fn() };
    const r = await dispatch({ payload: { ...base, action: "labeled" } as any, handlers, companyId: "c1", projectId: "p1" });
    expect(r.action).toBe("skipped");
  });
});
