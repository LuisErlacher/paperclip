import { describe, it, expect, vi, afterEach } from "vitest";
import { execute } from "./execute.js";
import * as utils from "../utils.js";

const mockRunChildProcess = vi.hoisted(() =>
  vi.fn(
    async (
      _runId: string,
      _cmd: string,
      _args: string[],
      _opts: {
        cwd: string;
        env: Record<string, string>;
        timeoutSec: number;
        graceSec: number;
        onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
      },
    ) => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
    }),
  ),
);

vi.mock("../utils.js", async () => {
  const actual = await vi.importActual<typeof utils>("../utils.js");
  return {
    ...actual,
    runChildProcess: mockRunChildProcess,
    // prevent real shell resolution from leaking into the test
    resolveCommandForLogs: vi.fn(async (cmd: string) => cmd),
  };
});

afterEach(() => {
  vi.clearAllMocks();
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

    expect(mockRunChildProcess).toHaveBeenCalledOnce();
    const opts = mockRunChildProcess.mock.calls[0]![3];
    expect(opts.env.PAPERCLIP_RUN_ID).toBe("run-abc-123");
    expect(opts.env.PAPERCLIP_AGENT_ID).toBe("agent-1");
    expect(opts.env.PAPERCLIP_COMPANY_ID).toBe("co-1");
  });
});
