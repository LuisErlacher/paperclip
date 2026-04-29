import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRoutineService = vi.hoisted(() => ({
  getRunById: vi.fn(),
  get: vi.fn(),
  getDetail: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  listRuns: vi.fn(),
  getTrigger: vi.fn(),
  createTrigger: vi.fn(),
  updateTrigger: vi.fn(),
  deleteTrigger: vi.fn(),
  rotateTriggerSecret: vi.fn(),
  runRoutine: vi.fn(),
  firePublicTrigger: vi.fn(),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

vi.mock("../services/index.js", () => ({
  routineService: () => mockRoutineService,
  accessService: () => mockAccessService,
  logActivity: mockLogActivity,
}));

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: () => null,
}));

async function createApp(actor: Record<string, unknown>) {
  const [{ routineRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/routines.js"),
    import("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as typeof req.actor;
    next();
  });
  app.use("/api", routineRoutes({} as any));
  app.use(errorHandler);
  return app;
}

const COMPANY_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const COMPANY_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RUN_ID = "11111111-1111-4111-8111-111111111111";

const agentActorA = {
  type: "agent",
  agentId: "22222222-2222-4222-8222-222222222222",
  companyId: COMPANY_A,
  runId: null,
  source: "agent_key",
};

const agentActorB = {
  type: "agent",
  agentId: "33333333-3333-4333-8333-333333333333",
  companyId: COMPANY_B,
  runId: null,
  source: "agent_key",
};

describe("GET /routine-runs/:runId", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 200 with triggerPayload for an existing run in same company", async () => {
    const run = {
      id: RUN_ID,
      companyId: COMPANY_A,
      routineId: "44444444-4444-4444-8444-444444444444",
      triggerId: null,
      source: "manual",
      status: "queued",
      triggeredAt: new Date().toISOString(),
      idempotencyKey: null,
      triggerPayload: { action: "opened", number: 1 },
      dispatchFingerprint: null,
      linkedIssueId: null,
      coalescedIntoRunId: null,
      failureReason: null,
      completedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      linkedIssue: null,
      triggerKind: null,
      triggerLabel: null,
    };
    mockRoutineService.getRunById.mockResolvedValue(run);

    const app = await createApp(agentActorA);
    const res = await request(app).get(`/api/routine-runs/${RUN_ID}`);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(RUN_ID);
    expect(res.body.triggerPayload).toEqual({ action: "opened", number: 1 });
    expect(mockRoutineService.getRunById).toHaveBeenCalledWith(RUN_ID, COMPANY_A);
  });

  it("returns 404 for a non-existent run", async () => {
    mockRoutineService.getRunById.mockResolvedValue(null);

    const app = await createApp(agentActorA);
    const res = await request(app).get(`/api/routine-runs/00000000-0000-0000-0000-000000000000`);

    expect(res.status).toBe(404);
  });

  it("returns 404 for a run belonging to a different company", async () => {
    // Agent from company B cannot see runs belonging to company A.
    // getRunById filters by companyId at the DB level, so it returns null.
    mockRoutineService.getRunById.mockResolvedValue(null);

    const app = await createApp(agentActorB);
    const res = await request(app).get(`/api/routine-runs/${RUN_ID}`);

    expect(res.status).toBe(404);
    expect(mockRoutineService.getRunById).toHaveBeenCalledWith(RUN_ID, COMPANY_B);
  });

  it("returns 403 for a board actor", async () => {
    const boardActor = {
      type: "board",
      userId: "u1",
      companyIds: ["c1"],
      source: "session",
    };

    const app = await createApp(boardActor);
    const res = await request(app).get(`/api/routine-runs/${RUN_ID}`);

    expect(res.status).toBe(403);
    expect(mockRoutineService.getRunById).not.toHaveBeenCalled();
  });
});
