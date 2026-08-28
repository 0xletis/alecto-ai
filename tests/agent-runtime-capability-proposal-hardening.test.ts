import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../packages/db/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, mockPlan, op, sendAgentMessage, seedUser, type MockPlan } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * fix/private-alpha-launch-hardening-flakes-and-pending-clarity: launch-hardening follow-up to
 * feat/private-alpha-capability-proposal-queue. Covers what that branch's own audit flagged as
 * remaining gaps: an ambiguous reply to an open capability queue now gets a queue-specific
 * clarification instead of falling through to the generic pending-operation firewall (Task 2);
 * selective matching is generalized to alias lists + a numbered index rather than two hardcoded
 * proposal ids, verified here with a synthetic THIRD proposal the real product doesn't have yet
 * (Task 3); and a declined/deferred proposal is durably (but never permanently) recorded (Task 4).
 * See agent-runtime-capability-proposal-queue.test.ts for the original combined-offer/selective-
 * confirm/multilingual coverage this file deliberately does not repeat.
 */

function jobGoalPlan(overrides: Record<string, unknown> = {}): MockPlan["operations"] {
  return [
    op("goal.create_propose", {
      title: "Find a fully remote Web3 job",
      category: "career",
      signals: [
        { key: "applications_sent", label: "applications sent", cadence: "daily" },
        { key: "interviews", label: "interviews", cadence: "daily" }
      ],
      firstActions: [],
      ...overrides
    })
  ];
}

async function seedGmailConnection(userId: string) {
  return prisma.integrationConnection.create({ data: { userId, integrationId: "gmail", status: "active", config: { email: "letis@example.com" } } });
}

async function proposeCombinedQueue(server: Awaited<ReturnType<typeof buildServer>>, userId: string) {
  mockPlan({
    topic: "goals",
    intent: "propose_goal_creation",
    operations: jobGoalPlan({ dailyCoachingInterest: true }),
    needsClarification: false,
    clarificationQuestion: null,
    replyDraft: ""
  });
  await sendAgentMessage(server, userId, "I want to find a fully remote Web3 job and I want daily motivation");
  return sendAgentMessage(server, userId, "yes");
}

async function currentGoalId(userId: string): Promise<string> {
  const goal = await prisma.goal.findFirstOrThrow({ where: { userId, status: "active" } });
  return goal.id;
}

test("2A/2B/2C/2D: an ambiguous reply gets a queue-specific clarification, keeps the queue pending, and a later clear reply still resolves it", async () => {
  const server = buildServer();
  const userId = `cap-hardening-ambiguous-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedGmailConnection(userId);
    await proposeCombinedQueue(server, userId);

    for (const phrase of ["maybe", "do the useful one", "the second maybe", "enable it", "only one", "later"]) {
      const reply = await sendAgentMessage(server, userId, phrase);
      assert.match(reply.reply, /not sure which capability/i, `"${phrase}" should get the queue-specific clarification — got: ${reply.reply}`);
      assert.match(reply.reply, /"both"/);
      assert.match(reply.reply, /"not now"/);
      assert.equal(reply.debug.pendingOperation, true, `"${phrase}" must keep the queue pending`);
      assert.equal(reply.debug.mutationExecuted, false, `"${phrase}" must not apply anything`);
    }

    const settingsAfterAmbiguity = await prisma.notificationSettings.findFirst({ where: { userId } });
    assert.equal(settingsAfterAmbiguity?.morningBriefEnabled, false, "no silent mutation from any ambiguous reply");
    assert.equal(await prisma.emailSignalRule.count({ where: { userId } }), 0, "no silent mutation from any ambiguous reply");

    const confirm = await sendAgentMessage(server, userId, "only Gmail");
    assert.equal(confirm.debug.mutationExecuted, true, "the next clear reply still resolves the original queue");
    assert.ok(await prisma.emailSignalRule.findFirst({ where: { userId, status: "active" } }));
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2E/2F: 'cancel' still clears the queue and applies nothing", async () => {
  const server = buildServer();
  const userId = `cap-hardening-cancel-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedGmailConnection(userId);
    await proposeCombinedQueue(server, userId);

    const cancelled = await sendAgentMessage(server, userId, "cancel");
    assert.equal(cancelled.debug.pendingOperation, false);
    assert.match(cancelled.reply, /won't enable/i);
    assert.match(cancelled.reply, /later/i);

    const settings = await prisma.notificationSettings.findFirst({ where: { userId } });
    assert.equal(settings?.morningBriefEnabled, false);
    assert.equal(await prisma.emailSignalRule.count({ where: { userId } }), 0);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3B/3C: 'only 1' and 'only 2' select proposals by their numbered position", async () => {
  const server1 = buildServer();
  const userId1 = `cap-hardening-index1-${randomUUID()}`;
  try {
    await seedUser(userId1);
    await seedGmailConnection(userId1);
    await proposeCombinedQueue(server1, userId1);

    const confirm = await sendAgentMessage(server1, userId1, "only 1");
    assert.match(confirm.reply, /morning brief is now on/i, "index 1 must select daily coaching (listed first)");
    const settings = await prisma.notificationSettings.findFirst({ where: { userId: userId1 } });
    assert.equal(settings?.morningBriefEnabled, true);
    assert.equal(await prisma.emailSignalRule.count({ where: { userId: userId1 } }), 0);
  } finally {
    clearAgentRuntimeMocks();
    await server1.close();
    await prisma.user.deleteMany({ where: { id: userId1 } });
  }

  const server2 = buildServer();
  const userId2 = `cap-hardening-index2-${randomUUID()}`;
  try {
    await seedUser(userId2);
    await seedGmailConnection(userId2);
    await proposeCombinedQueue(server2, userId2);

    const confirm = await sendAgentMessage(server2, userId2, "only 2");
    assert.match(confirm.reply, /I'm now using Gmail readonly/i, "index 2 must select Gmail support (listed second)");
    const settings = await prisma.notificationSettings.findFirst({ where: { userId: userId2 } });
    assert.equal(settings?.morningBriefEnabled, false);
  } finally {
    clearAgentRuntimeMocks();
    await server2.close();
    await prisma.user.deleteMany({ where: { id: userId2 } });
  }
});

test("3E: a synthetic THIRD proposal (not a real product capability yet) is correctly selected via 'only 3', proving selection is generalized rather than hardcoded to two ids", async () => {
  const server = buildServer();
  const userId = `cap-hardening-third-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedGmailConnection(userId);
    await proposeCombinedQueue(server, userId);
    const goalId = await currentGoalId(userId);

    // Inject a synthetic third proposal directly onto the pending queue's own JSON — the runtime's
    // selection matcher must handle this using ONLY the generic proposalId/proposalAliases/
    // proposalIndex fields already on it, with no code changes and no per-capability keyword table.
    const existing = await prisma.agentConversationSession.findFirstOrThrow({ where: { userId, channel: "telegram" } });
    const pending = existing.pendingOperation as any;
    assert.equal(pending.topic, "capability_proposals");
    pending.operations.push({
      tool: "action.create",
      args: { title: "Synthetic third capability action" },
      status: "valid",
      requiresConfirmation: false,
      proposalId: "weekly_review_reminder",
      proposalLabel: "Weekly review reminder",
      proposalAliases: ["weekly review", "review reminder"],
      proposalIndex: 3,
      proposalGoalId: goalId
    });
    await prisma.agentConversationSession.update({ where: { id: existing.id }, data: { pendingOperation: pending } });

    const confirm = await sendAgentMessage(server, userId, "only 3");
    assert.equal(confirm.debug.mutationExecuted, true);
    const action = await prisma.actionItem.findFirst({ where: { userId, title: "Synthetic third capability action" } });
    assert.ok(action, "the synthetic third proposal must have been the one applied");

    // Neither of the two real proposals should have been applied.
    const settings = await prisma.notificationSettings.findFirst({ where: { userId } });
    assert.equal(settings?.morningBriefEnabled, false);
    assert.equal(await prisma.emailSignalRule.count({ where: { userId } }), 0);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3F: an out-of-range index ('only 5' with just two proposals) asks for clarification instead of silently doing nothing or guessing", async () => {
  const server = buildServer();
  const userId = `cap-hardening-badindex-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedGmailConnection(userId);
    await proposeCombinedQueue(server, userId);

    const reply = await sendAgentMessage(server, userId, "only 5");
    assert.match(reply.reply, /not sure which capability/i);
    assert.equal(reply.debug.pendingOperation, true);
    assert.equal(reply.debug.mutationExecuted, false);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4A/4B/4C/4F: declining/deferring records a durable marker per proposal+goal, never a permanent-suppression flag", async () => {
  const server = buildServer();
  const userId = `cap-hardening-deferred-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedGmailConnection(userId);
    await proposeCombinedQueue(server, userId);
    const goalId = await currentGoalId(userId);

    await sendAgentMessage(server, userId, "only Gmail");

    const row = await prisma.agentConversationSession.findFirstOrThrow({ where: { userId, channel: "telegram" } });
    const deferred = row.deferredCapabilityProposals as Array<Record<string, unknown>>;
    assert.equal(deferred.length, 1, "daily coaching (the unselected side) must be recorded as deferred");
    assert.equal(deferred[0].proposalId, "daily_coaching");
    assert.equal(deferred[0].goalId, goalId);
    assert.equal(typeof deferred[0].decidedAt, "string");
    const recordedKeys = Object.keys(deferred[0]).sort();
    assert.deepEqual(recordedKeys, ["decidedAt", "goalId", "proposalId"], "no permanent/never-ask-again flag exists on the marker at all");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4C (not now): declining the whole queue records BOTH proposals as deferred", async () => {
  const server = buildServer();
  const userId = `cap-hardening-deferred-both-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedGmailConnection(userId);
    await proposeCombinedQueue(server, userId);

    await sendAgentMessage(server, userId, "not now");

    const row = await prisma.agentConversationSession.findFirstOrThrow({ where: { userId, channel: "telegram" } });
    const deferred = row.deferredCapabilityProposals as Array<Record<string, unknown>>;
    const ids = deferred.map((d) => d.proposalId).sort();
    assert.deepEqual(ids, ["daily_coaching", "gmail_support"]);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4E: after deferring daily coaching, an explicit later 'turn on morning brief' request still works normally", async () => {
  const server = buildServer();
  const userId = `cap-hardening-explicit-later-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedGmailConnection(userId);
    await proposeCombinedQueue(server, userId);

    await sendAgentMessage(server, userId, "only Gmail");
    const settingsAfterDecline = await prisma.notificationSettings.findFirst({ where: { userId } });
    assert.equal(settingsAfterDecline?.morningBriefEnabled, false);

    mockPlan({
      topic: "proactive_settings",
      intent: "propose_proactive_settings_update",
      operations: [op("proactive.settings_propose_update", { morningBriefEnabled: true })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const propose = await sendAgentMessage(server, userId, "turn on morning brief");
    assert.equal(propose.debug.pendingOperation, true, "the explicit direct request must never be blocked by the earlier deferral");
    const confirm = await sendAgentMessage(server, userId, "yes");
    assert.equal(confirm.debug.mutationExecuted, true);

    const settings = await prisma.notificationSettings.findFirst({ where: { userId } });
    assert.equal(settings?.morningBriefEnabled, true, "the explicit request must actually apply, unaffected by the earlier defer marker");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("5A/5B/5C: partial-selection copy names what changed and what stays off, using 'for now' rather than a permanent tone", async () => {
  const server = buildServer();
  const userId = `cap-hardening-copy-partial-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedGmailConnection(userId);
    await proposeCombinedQueue(server, userId);

    const confirm = await sendAgentMessage(server, userId, "only Gmail");
    assert.match(confirm.reply, /Gmail readonly/i, "names what changed");
    assert.match(confirm.reply, /Daily coaching stays off for now\./, "names what stayed off, with a non-permanent 'for now'");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("5D: 'not now' copy reads as a deferral, not a permanent rejection", async () => {
  const server = buildServer();
  const userId = `cap-hardening-copy-cancel-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedGmailConnection(userId);
    await proposeCombinedQueue(server, userId);

    const cancelled = await sendAgentMessage(server, userId, "not now");
    assert.doesNotMatch(cancelled.reply, /never|permanently|forever/i);
    assert.match(cancelled.reply, /later/i);
    assert.match(cancelled.reply, /turn on daily coaching/i);
    assert.match(cancelled.reply, /turn on gmail support/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
