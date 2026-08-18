import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../packages/db/src/index.ts";
import { buildServer } from "../apps/api/src/server.ts";

interface MockPlan {
  topic: string;
  intent: string;
  operations: Array<{ tool: string; args: unknown; rationale?: string }>;
  needsClarification: boolean;
  clarificationQuestion: string | null;
  replyDraft: string;
}

function op(tool: string, args: unknown = {}, rationale?: string) {
  return { tool, args, rationale };
}

function mockPlan(plan: MockPlan): void {
  process.env.AGENT_RUNTIME_PLANNER_MOCK_RESPONSE = JSON.stringify(plan);
}

function clearMocks(): void {
  delete process.env.AGENT_RUNTIME_PLANNER_MOCK_RESPONSE;
  delete process.env.AGENT_RUNTIME_PLANNER_MOCK_THROW;
}

async function send(server: ReturnType<typeof buildServer>, userId: string, message: string) {
  const response = await server.inject({
    method: "POST",
    url: "/agent/message",
    payload: { userId, message, channel: "telegram" }
  });
  assert.equal(response.statusCode, 200, message);
  return response.json();
}

async function seedGmailUser(userId: string): Promise<void> {
  await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
  await prisma.integrationConnection.create({ data: { userId, integrationId: "gmail", status: "active", config: {} } });
}

function mockGmailRulePlan(label: string): void {
  mockPlan({
    topic: "gmail_tracking",
    intent: "create_review_first_gmail_rule",
    operations: [op("gmail.rule.create", { label })],
    needsClarification: false,
    clarificationQuestion: null,
    replyDraft: `I can create a review-first Gmail tracking rule for ${label}. Would you like to proceed?`
  });
}

/**
 * "Simulate a restart" by closing and rebuilding the Fastify server between
 * turns. Agent Runtime v3 no longer keeps any module-level session cache —
 * every /agent/message call loads and saves via AgentConversationSession —
 * so this is a faithful proxy for a real process restart: nothing but the
 * DB row could possibly carry state across it.
 */
async function restart(server: ReturnType<typeof buildServer>): Promise<ReturnType<typeof buildServer>> {
  await server.close();
  return buildServer();
}

test("agent conversation session: pending Gmail rule confirmation survives a simulated restart", async () => {
  let server = buildServer();
  const userId = `agent-persist-pending-${randomUUID()}`;

  try {
    await seedGmailUser(userId);
    mockGmailRulePlan("Naturgy invoices");

    const turn1 = await send(server, userId, "track Naturgy invoices from Gmail");
    assert.equal(turn1.debug.pendingOperation, true);

    const row = await prisma.agentConversationSession.findUnique({ where: { userId_channel: { userId, channel: "telegram" } } });
    assert.ok(row, "session row must exist after the first turn");
    assert.ok(row?.pendingOperation, "pendingOperation must be persisted, not just held in memory");

    server = await restart(server);

    // No mockPlan needed: exact "yes" is resolved deterministically, without the planner.
    const turn2 = await send(server, userId, "yes");
    assert.equal(turn2.debug.mutationExecuted, true);
    assert.equal(turn2.debug.pendingOperation, false);
    assert.equal(turn2.operationsExecuted[0]?.tool, "gmail.rule.create");
    assert.equal(turn2.operationsExecuted[0]?.status, "executed");

    const rules = await prisma.emailSignalRule.findMany({ where: { userId } });
    assert.equal(rules.length, 1);
    assert.match(rules[0].name, /Naturgy/i);

    const rowAfter = await prisma.agentConversationSession.findUnique({ where: { userId_channel: { userId, channel: "telegram" } } });
    assert.equal(rowAfter?.pendingOperation, null, "pendingOperation must be cleared in the persisted row, not just in memory");
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent conversation session: cancel survives a simulated restart, no mutation", async () => {
  let server = buildServer();
  const userId = `agent-persist-cancel-${randomUUID()}`;

  try {
    await seedGmailUser(userId);
    mockGmailRulePlan("Naturgy invoices");
    await send(server, userId, "track Naturgy invoices from Gmail");

    server = await restart(server);

    const turn2 = await send(server, userId, "cancel");
    assert.equal(turn2.debug.mutationExecuted, false);
    assert.equal(turn2.debug.pendingOperation, false);

    const rules = await prisma.emailSignalRule.count({ where: { userId } });
    assert.equal(rules, 0);

    const row = await prisma.agentConversationSession.findUnique({ where: { userId_channel: { userId, channel: "telegram" } } });
    assert.equal(row?.pendingOperation, null);
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent conversation session: recent mutations survive a simulated restart", async () => {
  let server = buildServer();
  const userId = `agent-persist-mutations-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });

    mockPlan({
      topic: "progress_log",
      intent: "log_progress",
      operations: [
        op("event.log_job_applications", { count: 2 }, "2 CVs sent"),
        op("event.log_workout", { minutes: 45 }, "45 minutes training")
      ],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    await send(server, userId, "I sent two CVs and trained 45 minutes");

    server = await restart(server);

    mockPlan({
      topic: "progress_log",
      intent: "answer_recent_changes",
      operations: [op("operator.recent_changes")],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await send(server, userId, "qué has cambiado?");

    assert.match(reply.reply, /2 job application/i);
    assert.match(reply.reply, /45 minutes/i);
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent conversation session: an expired pending confirmation is never executed", async () => {
  const server = buildServer();
  const userId = `agent-persist-expired-${randomUUID()}`;

  try {
    await seedGmailUser(userId);

    const pendingOperation = {
      id: "agent-pending-expired-test",
      topic: "gmail_rule_creation",
      summary: 'a Gmail tracking rule for "Naturgy invoices"',
      createdAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
      expiresAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      operations: [
        {
          tool: "gmail.rule.create",
          args: { label: "Naturgy invoices" },
          status: "needs_confirmation",
          requiresConfirmation: true
        }
      ]
    };

    await prisma.agentConversationSession.create({
      data: {
        userId,
        channel: "telegram",
        topic: "gmail_rule_creation",
        pendingOperation,
        messages: [],
        visibleEntities: [],
        recentMutations: [],
        // The session row itself is expired — this is what the runtime must honor, not the
        // informational expiresAt nested inside pendingOperation.
        expiresAt: new Date(Date.now() - 60 * 60 * 1000)
      }
    });

    const reply = await send(server, userId, "yes");

    assert.equal(reply.reply, "I don't have anything pending to confirm.");
    assert.equal(reply.debug.pendingOperation, false);
    assert.equal(reply.debug.mutationExecuted, false);
    assert.equal(reply.debug.plannerUsed, "none");

    const rules = await prisma.emailSignalRule.count({ where: { userId } });
    assert.equal(rules, 0);
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent conversation session: message history is persisted bounded to the last 20 entries", async () => {
  const server = buildServer();
  const userId = `agent-persist-history-${randomUUID()}`;
  // All exact-whitelist confirm words — each is resolved deterministically with no pending
  // operation ever created, so no mockPlan is needed for any of these turns.
  const words = ["yes", "y", "yep", "confirm", "do it", "ok", "okay", "sure", "vale", "va", "sí", "si"];

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });

    for (const word of words) {
      await send(server, userId, word);
    }

    const row = await prisma.agentConversationSession.findUnique({ where: { userId_channel: { userId, channel: "telegram" } } });
    const messages = row?.messages as Array<{ role: string; text: string }> | null;

    assert.ok(messages);
    assert.equal(messages!.length, 20, "history must be capped at 20 entries, not left unbounded");
    assert.ok(!messages!.some((m) => m.text === "yes"), "the earliest turns must have been evicted");
    assert.equal(messages![messages!.length - 2]?.text, "si", "the most recent user turn must be the last one kept");
    assert.equal(messages![messages!.length - 1]?.role, "assistant");
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent conversation session: concurrent turns for different users never cross-contaminate persisted state", async () => {
  const server = buildServer();
  const userIdA = `agent-persist-multiuser-a-${randomUUID()}`;
  const userIdB = `agent-persist-multiuser-b-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userIdA }, update: {}, create: { id: userIdA } });
    await prisma.user.upsert({ where: { id: userIdB }, update: {}, create: { id: userIdB } });

    mockPlan({
      topic: "memory",
      intent: "create_memory",
      operations: [op("memory.create", { summary: "User A's memory" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const [replyA, replyB] = await Promise.all([
      send(server, userIdA, "remember user A's thing"),
      send(server, userIdB, "yes") // deterministic, no pending — doesn't touch the mocked plan at all
    ]);

    assert.equal(replyA.debug.mutationExecuted, true);
    assert.equal(replyB.reply, "I don't have anything pending to confirm.");

    const rowA = await prisma.agentConversationSession.findUnique({ where: { userId_channel: { userId: userIdA, channel: "telegram" } } });
    const rowB = await prisma.agentConversationSession.findUnique({ where: { userId_channel: { userId: userIdB, channel: "telegram" } } });

    assert.equal(rowA?.userId, userIdA);
    assert.equal(rowB?.userId, userIdB);
    assert.notDeepEqual(rowA?.messages, rowB?.messages);
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: { in: [userIdA, userIdB] } } });
  }
});
