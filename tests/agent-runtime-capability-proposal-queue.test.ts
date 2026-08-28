import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../packages/db/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, mockPlan, op, sendAgentMessage, seedUser, type MockPlan } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * feat/private-alpha-capability-proposal-queue: goal.create_apply previously chained AT MOST one
 * follow-up pendingOperationUpdate per turn — dailyCoachingInterest's own chain won unconditionally
 * whenever both it and a Gmail-relevant goal applied in the same turn, so the Gmail offer was
 * silently never computed that turn (see goal-driven-gmail-operator.test.ts and
 * post-goal-coaching-confirmation.test.ts for the single-offer paths this file doesn't re-cover).
 * This file covers the NEW combined "capability_proposals" queue: both offers surviving together,
 * selective ("only X") confirmation, multilingual replies, and safe multi-op execution/reporting.
 */

async function seedGmailConnection(userId: string) {
  return prisma.integrationConnection.create({ data: { userId, integrationId: "gmail", status: "active", config: { email: "letis@example.com" } } });
}

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

test("2A/3A/4A: job goal + daily coaching + Gmail connected offers both as a numbered list, and mutates nothing before confirmation", async () => {
  const server = buildServer();
  const userId = `cap-queue-both-offer-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedGmailConnection(userId);

    const offer = await proposeCombinedQueue(server, userId);

    assert.equal(offer.debug.mutationExecuted, true);
    assert.equal(offer.debug.pendingOperation, true);
    assert.match(offer.reply, /1\. Daily coaching:/);
    assert.match(offer.reply, /2\. Gmail support: watch/i);
    assert.match(offer.reply, /Want me to enable both\?/);

    const settings = await prisma.notificationSettings.findFirst({ where: { userId } });
    assert.equal(settings?.morningBriefEnabled, false, "nothing mutated before confirmation");
    assert.equal(await prisma.emailSignalRule.count({ where: { userId } }), 0, "nothing mutated before confirmation");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2C/4A/6A: 'yes' applies both proposals and reports both outcomes truthfully", async () => {
  const server = buildServer();
  const userId = `cap-queue-yes-both-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedGmailConnection(userId);
    await proposeCombinedQueue(server, userId);

    const confirm = await sendAgentMessage(server, userId, "yes");

    assert.equal(confirm.debug.mutationExecuted, true);
    assert.equal(confirm.debug.pendingOperation, false);
    assert.match(confirm.reply, /morning brief is now on/i);
    assert.match(confirm.reply, /I'm now using Gmail readonly/i);

    const settings = await prisma.notificationSettings.findFirst({ where: { userId } });
    assert.equal(settings?.morningBriefEnabled, true);
    assert.equal(settings?.eveningCheckinEnabled, true);
    const rule = await prisma.emailSignalRule.findFirst({ where: { userId, status: "active" } });
    assert.ok(rule, "confirming both must create the Gmail watcher too");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4B/7A: 'both' (and Spanish 'ambos') apply the full queue exactly like 'yes'", async () => {
  const server = buildServer();
  const userId = `cap-queue-both-word-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedGmailConnection(userId);
    await proposeCombinedQueue(server, userId);

    const confirm = await sendAgentMessage(server, userId, "both");

    assert.equal(confirm.debug.mutationExecuted, true);
    const settings = await prisma.notificationSettings.findFirst({ where: { userId } });
    assert.equal(settings?.morningBriefEnabled, true);
    assert.equal(settings?.eveningCheckinEnabled, true);
    assert.ok(await prisma.emailSignalRule.findFirst({ where: { userId, status: "active" } }));
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2D/4C: 'only Gmail' enables Gmail support only — daily coaching stays off", async () => {
  const server = buildServer();
  const userId = `cap-queue-only-gmail-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedGmailConnection(userId);
    await proposeCombinedQueue(server, userId);

    const confirm = await sendAgentMessage(server, userId, "only Gmail");

    assert.equal(confirm.debug.mutationExecuted, true);
    assert.equal(confirm.debug.pendingOperation, false);
    assert.match(confirm.reply, /I'm now using Gmail readonly/i);
    assert.match(confirm.reply, /Daily coaching stays off for now\./);

    const settings = await prisma.notificationSettings.findFirst({ where: { userId } });
    assert.equal(settings?.morningBriefEnabled, false, "daily coaching must not be enabled");
    assert.equal(settings?.eveningCheckinEnabled, false, "daily coaching must not be enabled");
    assert.ok(await prisma.emailSignalRule.findFirst({ where: { userId, status: "active" } }));
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4D: 'only daily coaching' enables daily coaching only — Gmail support stays off", async () => {
  const server = buildServer();
  const userId = `cap-queue-only-daily-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedGmailConnection(userId);
    await proposeCombinedQueue(server, userId);

    const confirm = await sendAgentMessage(server, userId, "only daily coaching");

    assert.equal(confirm.debug.mutationExecuted, true);
    assert.match(confirm.reply, /morning brief is now on/i);
    assert.match(confirm.reply, /Gmail support stays off for now\./);

    const settings = await prisma.notificationSettings.findFirst({ where: { userId } });
    assert.equal(settings?.morningBriefEnabled, true);
    assert.equal(await prisma.emailSignalRule.count({ where: { userId } }), 0, "Gmail must not be enabled");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2D/4E: 'not now' and 'cancel' enable neither proposal", async () => {
  const server = buildServer();
  const userId = `cap-queue-not-now-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedGmailConnection(userId);
    await proposeCombinedQueue(server, userId);

    const cancelled = await sendAgentMessage(server, userId, "not now");

    assert.equal(cancelled.debug.pendingOperation, false);
    const settings = await prisma.notificationSettings.findFirst({ where: { userId } });
    assert.equal(settings?.morningBriefEnabled, false);
    assert.equal(await prisma.emailSignalRule.count({ where: { userId } }), 0);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("7B/7C: Spanish 'solo Gmail' and Catalan 'només Gmail' both apply Gmail support only", async () => {
  for (const phrase of ["solo Gmail", "només Gmail"]) {
    const server = buildServer();
    const userId = `cap-queue-lang-gmail-${randomUUID()}`;
    try {
      await seedUser(userId);
      await seedGmailConnection(userId);
      await proposeCombinedQueue(server, userId);

      const confirm = await sendAgentMessage(server, userId, phrase);

      assert.match(confirm.reply, /I'm now using Gmail readonly/i, `phrase "${phrase}" should enable Gmail`);
      const settings = await prisma.notificationSettings.findFirst({ where: { userId } });
      assert.equal(settings?.morningBriefEnabled, false, `phrase "${phrase}" must not enable daily coaching`);
    } finally {
      clearAgentRuntimeMocks();
      await server.close();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  }
});

test("7D/7E: Catalan 'tots dos' and 'cancel·la' apply/cancel the full queue", async () => {
  const server = buildServer();
  const userId = `cap-queue-catalan-both-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedGmailConnection(userId);
    await proposeCombinedQueue(server, userId);

    const confirm = await sendAgentMessage(server, userId, "tots dos");
    assert.equal(confirm.debug.mutationExecuted, true);
    const settings = await prisma.notificationSettings.findFirst({ where: { userId } });
    assert.equal(settings?.morningBriefEnabled, true);
    assert.ok(await prisma.emailSignalRule.findFirst({ where: { userId, status: "active" } }));
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }

  const server2 = buildServer();
  const userId2 = `cap-queue-catalan-cancel-${randomUUID()}`;
  try {
    await seedUser(userId2);
    await seedGmailConnection(userId2);
    await proposeCombinedQueue(server2, userId2);

    const cancelled = await sendAgentMessage(server2, userId2, "cancel·la");
    assert.equal(cancelled.debug.pendingOperation, false);
    const settings2 = await prisma.notificationSettings.findFirst({ where: { userId: userId2 } });
    assert.equal(settings2?.morningBriefEnabled, false);
  } finally {
    clearAgentRuntimeMocks();
    await server2.close();
    await prisma.user.deleteMany({ where: { id: userId2 } });
  }
});

test("2E/6B: Gmail disconnected between proposal and confirmation fails that half safely, daily coaching still applies", async () => {
  const server = buildServer();
  const userId = `cap-queue-invalid-mid-${randomUUID()}`;
  try {
    await seedUser(userId);
    const connection = await seedGmailConnection(userId);
    await proposeCombinedQueue(server, userId);

    // Gmail disconnects between the offer and the confirmation. "error" (not an arbitrary string
    // like "revoked") is the real status packages/db's normalizeIntegrationStatus recognizes as
    // disconnected — anything else it doesn't recognize is normalized back to "active".
    await prisma.integrationConnection.update({ where: { id: connection.id }, data: { status: "error" } });

    const confirm = await sendAgentMessage(server, userId, "yes");

    assert.match(confirm.reply, /morning brief is now on/i, "daily coaching must still apply");
    assert.match(confirm.reply, /couldn't enable Gmail support|Gmail is not connected/i);

    const settings = await prisma.notificationSettings.findFirst({ where: { userId } });
    assert.equal(settings?.morningBriefEnabled, true);
    assert.equal(await prisma.emailSignalRule.count({ where: { userId } }), 0, "no Gmail rule created when the connection is gone");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("6C: confirming 'both' after a watcher for the goal was already created independently doesn't duplicate it", async () => {
  const server = buildServer();
  const userId = `cap-queue-idempotent-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedGmailConnection(userId);
    await proposeCombinedQueue(server, userId);

    const goal = await prisma.goal.findFirst({ where: { userId, status: "active" } });
    assert.ok(goal);
    await prisma.emailSignalRule.create({
      data: {
        userId,
        goalId: goal!.id,
        connectionId: (await prisma.integrationConnection.findFirstOrThrow({ where: { userId, integrationId: "gmail" } })).id,
        adapterId: "job_search_email",
        name: "Job search email",
        status: "active",
        fetchStrategy: "query",
        lookbackDays: 30,
        maxMessagesPerSync: 25,
        maxEventsPerSync: 5,
        classifierMode: "rules",
        minAutoLogConfidence: 1,
        minReviewConfidence: 0.65,
        reviewBeforeLogging: true,
        notifyPolicy: "review_only",
        createdBy: "user"
      }
    });

    await sendAgentMessage(server, userId, "yes");

    const rules = await prisma.emailSignalRule.findMany({ where: { userId, goalId: goal!.id, status: "active" } });
    assert.equal(rules.length, 1, "must not create a second, duplicate watcher");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3F: daily coaching already fully on + a newly Gmail-relevant goal offers Gmail alone, using its existing single-proposal focused copy", async () => {
  const server = buildServer();
  const userId = `cap-queue-daily-already-on-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedGmailConnection(userId);

    // Turn on daily coaching broadly first, unrelated to any goal. proactive.settings_apply_update
    // can never be planned directly (only reached via the confirm whitelist), so this goes
    // through the real propose -> yes flow like every other proactive-settings test does.
    mockPlan({
      topic: "proactive_settings",
      intent: "propose_proactive_settings_update",
      operations: [op("proactive.settings_propose_update", { morningBriefEnabled: true, eveningCheckinEnabled: true })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    await sendAgentMessage(server, userId, "turn on morning brief and evening check-in");
    await sendAgentMessage(server, userId, "yes");

    mockPlan({
      topic: "goals",
      intent: "propose_goal_creation",
      operations: jobGoalPlan({ dailyCoachingInterest: true }),
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    await sendAgentMessage(server, userId, "I want to find a fully remote Web3 job and I want daily motivation");
    const offer = await sendAgentMessage(server, userId, "yes");

    // Daily coaching is already on — only Gmail is left to offer, and it must use the EXACT
    // existing single-offer copy/topic, not the new numbered-list format meant for 2+ proposals.
    assert.doesNotMatch(offer.reply, /Daily coaching:/, "must not re-offer daily coaching once already on");
    assert.doesNotMatch(offer.reply, /Want me to enable both\?/);
    assert.match(offer.reply, /already on/i);
    assert.match(offer.reply, /I can use Gmail readonly for "Find a fully remote Web3 job"/);
    assert.equal(offer.debug.pendingOperation, true);

    await sendAgentMessage(server, userId, "yes");
    assert.ok(await prisma.emailSignalRule.findFirst({ where: { userId, status: "active" } }));
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4F/5C: an ambiguous reply neither applies nor drops the queue, and 'yes' still works afterward", async () => {
  const server = buildServer();
  const userId = `cap-queue-ambiguous-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedGmailConnection(userId);
    await proposeCombinedQueue(server, userId);

    mockPlan({
      topic: "goals",
      intent: "smalltalk",
      operations: [],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: "Not sure what you mean."
    });
    const ambiguous = await sendAgentMessage(server, userId, "hmm not sure");

    assert.equal(ambiguous.debug.pendingOperation, true, "the queue must survive an ambiguous reply, never silently resolved");
    const settingsAfterAmbiguous = await prisma.notificationSettings.findFirst({ where: { userId } });
    assert.equal(settingsAfterAmbiguous?.morningBriefEnabled, false, "nothing silently applied on an ambiguous reply");

    const confirm = await sendAgentMessage(server, userId, "yes");
    assert.equal(confirm.debug.mutationExecuted, true);
    const settings = await prisma.notificationSettings.findFirst({ where: { userId } });
    assert.equal(settings?.morningBriefEnabled, true, "'yes' after the ambiguous reply still applies the originally-offered queue");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
