import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildServer,
  clearAgentRuntimeMocks,
  getAgentSession,
  mockPlan,
  op,
  prisma,
  sendAgentMessage,
  seedUser,
  type MockPlan
} from "./helpers/agent-runtime-test-helpers.ts";

/**
 * Agent Runtime v3 Gmail autonomy (scheduled sync) settings — found via a real Telegram smoke
 * test where "can u check email sync every 1h?" was ignored in a compound turn, and the
 * follow-up "review my emails every 1h" was misrouted into gmail.rule.propose_update (pausing
 * the "Work action emails" rule) because rule-target resolution treated "review my emails" as a
 * rule reference. These deterministic shortcuts (apps/api/src/agent-runtime/runtime.ts's
 * gmailAutonomyStatusShortcutOperation/gmailAutonomyCompoundShortcutOperations, reusing the
 * legacy /messages/process parser apps/api/src/legacy/gmail-conversation.ts's
 * parseGmailAutonomyPreference — that file itself is unmodified) route Gmail sync-frequency
 * language to the new gmail.autonomy.status/propose_update/apply_update tools instead, writing
 * to the SAME IntegrationConnection.config.gmailAutonomy field the worker's own
 * evaluateGmailBackgroundSyncEligibility (packages/core/src/gmail-autonomy.ts) reads — no new
 * table, no fake persistence. No Gmail OAuth, sync classification, review triage, or mailbox
 * mutation code was touched.
 */

async function seedGmailUser(userId: string): Promise<string> {
  await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
  const connection = await prisma.integrationConnection.create({ data: { userId, integrationId: "gmail", status: "active", config: {} } });
  return connection.id;
}

async function seedReview(userId: string, connectionId: string, ruleId: string, subject: string, providerMessageId: string) {
  return prisma.emailReviewItem.create({
    data: {
      userId,
      connectionId,
      ruleId,
      adapterId: "custom_email_review",
      provider: "gmail",
      providerMessageId,
      externalId: `gmail-review:${ruleId}:${providerMessageId}`,
      subject,
      snippet: subject,
      evidence: subject,
      confidence: 0.8,
      reason: "custom_rule_match",
      extracted: {},
      status: "pending"
    }
  });
}

function gmailRuleProposeUpdatePlan(ref: string, operation: "pause" | "resume" | "archive"): MockPlan {
  return {
    topic: "gmail_rule_management",
    intent: "propose_gmail_rule_update",
    operations: [op("gmail.rule.propose_update", { ref, operation })],
    needsClarification: false,
    clarificationQuestion: null,
    replyDraft: ""
  };
}

test("A. 'check Gmail every hour' proposes scheduled sync at 60 minutes, and 'yes' persists it", async () => {
  const server = buildServer();
  const userId = `gmail-autonomy-every-hour-${randomUUID()}`;

  try {
    const connectionId = await seedGmailUser(userId);

    const reply = await sendAgentMessage(server, userId, "check Gmail every hour");

    assert.match(reply.reply, /about to check gmail every hour/i);
    assert.match(reply.reply, /reply yes to confirm or cancel/i);
    assert.equal(reply.debug.mutationExecuted, false);
    assert.ok(reply.debug.pendingOperation, "must open a pending confirmation, not mutate directly");

    const unchanged = await prisma.integrationConnection.findUnique({ where: { id: connectionId } });
    assert.deepEqual((unchanged?.config as Record<string, unknown> | null)?.gmailAutonomy ?? null, null, "must not persist before confirmation");

    const confirmReply = await sendAgentMessage(server, userId, "yes");
    assert.equal(confirmReply.debug.mutationExecuted, true);
    assert.match(confirmReply.reply, /done — gmail scheduled checks are now on every hour/i);

    const updated = await prisma.integrationConnection.findUnique({ where: { id: connectionId } });
    const gmailAutonomy = (updated?.config as Record<string, unknown> | null)?.gmailAutonomy as Record<string, unknown> | undefined;
    assert.equal(gmailAutonomy?.syncMode, "scheduled");
    assert.equal(gmailAutonomy?.syncIntervalMinutes, 60);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("B. 'review my emails every 1h' proposes scheduled Gmail sync, not a Work action rule pause", async () => {
  const server = buildServer();
  const userId = `gmail-autonomy-review-my-emails-${randomUUID()}`;

  try {
    const connectionId = await seedGmailUser(userId);
    await prisma.emailSignalRule.create({ data: { userId, connectionId, adapterId: "custom_email_review", name: "Work action emails", status: "active", createdBy: "user" } });

    const reply = await sendAgentMessage(server, userId, "review my emails every 1h");

    assert.doesNotMatch(reply.reply, /work action emails/i, "must not misroute into pausing the named rule");
    assert.match(reply.reply, /about to check gmail every hour/i);
    assert.equal(reply.debug.mutationExecuted, false);

    const rule = await prisma.emailSignalRule.findFirst({ where: { userId, name: "Work action emails" } });
    assert.equal(rule?.status, "active", "the unrelated rule must be untouched");

    await sendAgentMessage(server, userId, "yes");
    const updated = await prisma.integrationConnection.findUnique({ where: { id: connectionId } });
    const gmailAutonomy = (updated?.config as Record<string, unknown> | null)?.gmailAutonomy as Record<string, unknown> | undefined;
    assert.equal(gmailAutonomy?.syncMode, "scheduled");
    assert.equal(gmailAutonomy?.syncIntervalMinutes, 60);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("C. 'make Gmail manual only' proposes manual_only, and 'yes' persists it", async () => {
  const server = buildServer();
  const userId = `gmail-autonomy-manual-only-${randomUUID()}`;

  try {
    const connectionId = await seedGmailUser(userId);
    await prisma.integrationConnection.update({
      where: { id: connectionId },
      data: { config: { gmailAutonomy: { syncMode: "scheduled", syncIntervalMinutes: 30 } } }
    });

    const reply = await sendAgentMessage(server, userId, "make Gmail manual only");
    assert.match(reply.reply, /about to make gmail manual only/i);
    assert.equal(reply.debug.mutationExecuted, false);

    await sendAgentMessage(server, userId, "yes");
    const updated = await prisma.integrationConnection.findUnique({ where: { id: connectionId } });
    const gmailAutonomy = (updated?.config as Record<string, unknown> | null)?.gmailAutonomy as Record<string, unknown> | undefined;
    assert.equal(gmailAutonomy?.syncMode, "manual_only");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("D. compound 'delete it nothing important, and can u check email sync every 1h?' rejects the visible review and proposes scheduled sync in one turn", async () => {
  const server = buildServer();
  const userId = `gmail-autonomy-compound-${randomUUID()}`;

  try {
    const connectionId = await seedGmailUser(userId);
    const rule = await prisma.emailSignalRule.create({ data: { userId, connectionId, adapterId: "custom_email_review", name: "Meetings", status: "active", createdBy: "user" } });
    const review = await seedReview(userId, connectionId, rule.id, "Standup tomorrow", "standup-1");

    await sendAgentMessage(server, userId, "show me the reviews");

    const reply = await sendAgentMessage(server, userId, "delete it nothing important, and can u check email sync every 1h?");

    assert.match(reply.reply, /ignored review.*standup tomorrow/i);
    assert.match(reply.reply, /about to check gmail every hour/i);
    assert.match(reply.reply, /reply yes to confirm or cancel/i);
    assert.equal(reply.debug.mutationExecuted, true, "the review rejection itself is a real mutation");
    assert.ok(reply.debug.pendingOperation, "the sync-schedule change still needs confirmation");

    const rejectedReview = await prisma.emailReviewItem.findUnique({ where: { id: review.id } });
    assert.equal(rejectedReview?.status, "rejected");

    const confirmReply = await sendAgentMessage(server, userId, "yes");
    assert.equal(confirmReply.debug.mutationExecuted, true);
    const updated = await prisma.integrationConnection.findUnique({ where: { id: connectionId } });
    const gmailAutonomy = (updated?.config as Record<string, unknown> | null)?.gmailAutonomy as Record<string, unknown> | undefined;
    assert.equal(gmailAutonomy?.syncMode, "scheduled");
    assert.equal(gmailAutonomy?.syncIntervalMinutes, 60);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("E. 'when do you check Gmail?' reports the current sync mode without listing rules", async () => {
  const server = buildServer();
  const userId = `gmail-autonomy-status-${randomUUID()}`;

  try {
    const connectionId = await seedGmailUser(userId);
    await prisma.integrationConnection.update({
      where: { id: connectionId },
      data: { config: { gmailAutonomy: { syncMode: "scheduled", syncIntervalMinutes: 60 } } }
    });
    await prisma.emailSignalRule.create({ data: { userId, connectionId, adapterId: "custom_email_review", name: "Endesa bills", status: "active", createdBy: "user" } });

    const reply = await sendAgentMessage(server, userId, "when do you check Gmail?");

    assert.match(reply.reply, /every hour/i);
    assert.match(reply.reply, /alerts are (on|off)/i);
    assert.doesNotMatch(reply.reply, /endesa bills/i, "must not list generic rules unless asked");
    assert.equal(reply.debug.mutationExecuted, false);

    const secondReply = await sendAgentMessage(server, userId, "is Gmail sync scheduled?");
    assert.match(secondReply.reply, /every hour/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("F. regression: 'pause Work action emails' and 'stop tracking Endesa bills' still target the named rule, not global sync", async () => {
  const server = buildServer();
  const userId = `gmail-autonomy-regression-rules-${randomUUID()}`;

  try {
    const connectionId = await seedGmailUser(userId);
    const workRule = await prisma.emailSignalRule.create({ data: { userId, connectionId, adapterId: "custom_email_review", name: "Work action emails", status: "active", createdBy: "user" } });
    const endesaRule = await prisma.emailSignalRule.create({ data: { userId, connectionId, adapterId: "custom_email_review", name: "Endesa bills", status: "active", createdBy: "user" } });

    mockPlan(gmailRuleProposeUpdatePlan("Work action", "pause"));
    const workReply = await sendAgentMessage(server, userId, "pause Work action emails");
    assert.match(workReply.reply, /about to pause work action emails/i);
    assert.equal(workReply.debug.mutationExecuted, false);
    await sendAgentMessage(server, userId, "yes");
    const workAfter = await prisma.emailSignalRule.findUnique({ where: { id: workRule.id } });
    assert.equal(workAfter?.status, "paused");

    mockPlan(gmailRuleProposeUpdatePlan("Endesa", "pause"));
    const endesaReply = await sendAgentMessage(server, userId, "stop tracking Endesa bills");
    assert.match(endesaReply.reply, /about to pause endesa bills/i);
    await sendAgentMessage(server, userId, "yes");
    const endesaAfter = await prisma.emailSignalRule.findUnique({ where: { id: endesaRule.id } });
    assert.equal(endesaAfter?.status, "paused");

    const connection = await prisma.integrationConnection.findUnique({ where: { id: connectionId } });
    assert.deepEqual((connection?.config as Record<string, unknown> | null)?.gmailAutonomy ?? null, null, "global sync settings must be untouched by rule-scoped requests");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("regression: 'turn off daily review' does not get reinterpreted as a Gmail daily sync request", async () => {
  const server = buildServer();
  const userId = `gmail-autonomy-daily-review-guard-${randomUUID()}`;

  try {
    await seedUser(userId);

    mockPlan({
      topic: "daily_loop",
      intent: "propose_daily_loop_update",
      operations: [op("daily_loop.settings_propose_update", { field: "dailyReviewEnabled", value: false })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "turn off daily review");

    assert.doesNotMatch(reply.reply, /gmail/i, "must not be reinterpreted as a Gmail autonomy request");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
