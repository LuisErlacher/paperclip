import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  companies,
  companySecrets,
  companySecretVersions,
  createDb,
  executionWorkspaces,
  heartbeatRuns,
  instanceSettings,
  issueInboxArchives,
  issueReadStates,
  issues,
  projectWorkspaces,
  projects,
  routineRuns,
  routines,
  routineTriggers,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../__tests__/helpers/embedded-postgres.js";
import { routineService } from "./routines.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping getRunById tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("routineService.getRunById", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-get-run-by-id-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issueInboxArchives);
    await db.delete(issueReadStates);
    await db.delete(routineRuns);
    await db.delete(routineTriggers);
    await db.delete(routines);
    await db.delete(companySecretVersions);
    await db.delete(companySecrets);
    await db.delete(heartbeatRuns);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(agents);
    await db.delete(companies);
    await db.delete(instanceSettings);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedFixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "TestAgent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Test Project",
      status: "in_progress",
    });

    const svc = routineService(db, {
      heartbeat: { wakeup: async () => null },
    });

    const routine = await svc.create(
      companyId,
      {
        projectId,
        goalId: null,
        parentIssueId: null,
        title: "test routine",
        description: "A test routine",
        assigneeAgentId: agentId,
        priority: "medium",
        status: "active",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        variables: [],
      },
      {},
    );

    return { companyId, routine, svc };
  }

  it("returns run with triggerPayload", async () => {
    const { companyId, routine, svc } = await seedFixture();

    const runId = randomUUID();
    await db.insert(routineRuns).values({
      id: runId,
      companyId,
      routineId: routine.id,
      triggerId: null,
      source: "manual",
      status: "pending",
      triggeredAt: new Date(),
      triggerPayload: { hello: "world" },
    });

    const fetched = await svc.getRunById(runId, companyId);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(runId);
    expect(fetched!.triggerPayload).toEqual({ hello: "world" });
  });

  it("returns null when run does not exist", async () => {
    const { companyId, svc } = await seedFixture();

    const fetched = await svc.getRunById("00000000-0000-0000-0000-000000000000", companyId);
    expect(fetched).toBeNull();
  });

  it("returns null when run belongs to a different company", async () => {
    const { companyId, routine, svc } = await seedFixture();

    const runId = randomUUID();
    await db.insert(routineRuns).values({
      id: runId,
      companyId,
      routineId: routine.id,
      triggerId: null,
      source: "manual",
      status: "pending",
      triggeredAt: new Date(),
      triggerPayload: {},
    });

    const fetched = await svc.getRunById(runId, "00000000-0000-0000-0000-000000000000");
    expect(fetched).toBeNull();
  });
});
