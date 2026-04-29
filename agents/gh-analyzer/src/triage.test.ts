import { describe, it, expect, vi } from "vitest";
import { triage, derivePriorityFromLabels } from "./triage.js";

describe("derivePriorityFromLabels", () => {
  it("bug → high", () => expect(derivePriorityFromLabels(["bug"])).toBe("high"));
  it("critical → critical", () => expect(derivePriorityFromLabels(["critical"])).toBe("critical"));
  it("enhancement → medium", () => expect(derivePriorityFromLabels(["enhancement"])).toBe("medium"));
  it("nothing matches → medium", () => expect(derivePriorityFromLabels(["foo"])).toBe("medium"));
  it("critical wins over bug", () => expect(derivePriorityFromLabels(["bug", "critical"])).toBe("critical"));
});

describe("triage", () => {
  it("calls Anthropic and returns summary", async () => {
    const create = vi.fn().mockResolvedValue({
      content: [{ type: "text", text: "Resumo curto do bug." }],
    });
    const fakeClient = { messages: { create } } as any;
    const out = await triage(
      { title: "App crashes", body: "When clicking X" },
      { client: fakeClient, model: "claude-haiku-4-5-20251001" },
    );
    expect(out).toBe("Resumo curto do bug.");
    expect(create).toHaveBeenCalledOnce();
    const args = create.mock.calls[0][0];
    expect(args.model).toBe("claude-haiku-4-5-20251001");
    expect(args.messages[0].content).toContain("App crashes");
  });

  it("returns a fallback when SDK fails", async () => {
    const create = vi.fn().mockRejectedValue(new Error("boom"));
    const fakeClient = { messages: { create } } as any;
    const out = await triage(
      { title: "x", body: "y" },
      { client: fakeClient, model: "claude-haiku-4-5-20251001" },
    );
    expect(out).toMatch(/Triagem indisponível/i);
  });
});
