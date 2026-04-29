import { describe, it, expect, vi } from "vitest";
import { execute } from "./execute.js";
import * as utils from "../utils.js";

vi.mock("../utils.js", async () => {
  const actual = await vi.importActual<typeof utils>("../utils.js");
  return {
    ...actual,
    runChildProcess: vi.fn(async (_runId, _cmd, _args, opts) => {
      // capture env for assertion
      (globalThis as any).__capturedEnv = opts.env;
      return { exitCode: 0, signal: null, timedOut: false, stdout: "", stderr: "" };
    }),
    resolveCommandForLogs: vi.fn(async (cmd) => cmd),
  };
});

describe("process adapter env injection", () => {
  it("includes PAPERCLIP_RUN_ID in spawned env", async () => {
    await execute({
      runId: "run-abc-123",
      agent: { id: "agent-1", companyId: "co-1" },
      config: { command: "echo" },
      onLog: async () => {},
      onMeta: async () => {},
    } as any);

    const env = (globalThis as any).__capturedEnv as Record<string, string>;
    expect(env.PAPERCLIP_RUN_ID).toBe("run-abc-123");
    expect(env.PAPERCLIP_AGENT_ID).toBe("agent-1");
    expect(env.PAPERCLIP_COMPANY_ID).toBe("co-1");
  });
});
