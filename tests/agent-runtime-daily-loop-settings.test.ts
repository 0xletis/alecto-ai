import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { buildServer, clearAgentRuntimeMocks, getAgentSession, mockPlan, op, prisma, sendAgentMessage, seedUser, type MockPlan } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * Agent Runtime v3 daily-loop settings flow — migrating on/off + morning-brief/evening-review
 * time changes from the legacy /messages/process brain
 * (apps/api/src/legacy/daily-conversation.ts's handleNaturalDailyLoopSettings, which mutates
 * NotificationSettings immediately with no confirmation and has no "off" support at all) into
 * v3's own typed daily_loop.settings_show/settings_propose_update/settings_apply_update tools
 * (apps/api/src/agent-runtime/tool-catalog.ts). The underlying read/write
 * (getOrCreateNotificationSettings/updateNotificationSettings from @operator-agent/db) and the
 * pure time helpers (apps/api/src/operator/daily-loop-settings.ts, split out of legacy) are
 * reused as-is. Scope is deliberately narrow: dailyLoopEnabled + morningTimeMinutes +
 * eveningTimeMinutes only — the same three fields legacy's own natural-language handler covers,
 * nothing else (no delivery channel, no other reminder types).
 */

function dailyLoopShowPlan(): MockPlan {
  return { topic: "daily_loop_settings", intent: "show_daily_loop_settings", operations: [op("daily_loop.settings_show")], needsClarification: false, clarificationQuestion: null, replyDraft: "" };
}

function dailyLoopProposeUpdatePlan(args: { enabled?: boolean; morningTimeText?: string; eveningTimeText?: string }): MockPlan {
  return {
    topic: "daily_loop_settings",
    intent: "propose_daily_loop_settings_update",
    operations: [op("daily_loop.settings_propose_update", args)],
    needsClarification: false,
    clarificationQuestion: null,
    replyDraft: ""
  };
}

test("agent/message: 'what are my daily loop settings?' shows the real current settings", async () => {
  const server = buildServer();
  const userId = `daily-loop-show-${randomUUID()}`;

  try {
    await seedUser(userId);

    mockPlan(dailyLoopShowPlan());
    const reply = await sendAgentMessage(server, userId, "what are my daily loop settings?");

    assert.match(reply.reply, /daily loop settings:/i);
    assert.match(reply.reply, /daily review: off/i);
    assert.match(reply.reply, /morning brief: 09:00/i);
    assert.match(reply.reply, /evening review: 19:00/i);
    assert.equal(reply.debug.mutationExecuted, false);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: 'turn off daily review' proposes disabling it and mutates nothing before 'yes'", async () => {
  const server = buildServer();
  const userId = `daily-loop-propose-off-${randomUUID()}`;

  try {
    await seedUser(userId);
    await prisma.notificationSettings.create({ data: { userId, dailyLoopEnabled: true } });

    mockPlan(dailyLoopProposeUpdatePlan({ enabled: false }));
    const reply = await sendAgentMessage(server, userId, "turn off daily review");

    assert.match(reply.reply, /about to turn off daily review reminders/i);
    assert.match(reply.reply, /reply yes to confirm or cancel/i);
    assert.equal(reply.debug.mutationExecuted, false);
    assert.ok(reply.debug.pendingOperation, "a pending daily-loop settings change must be open");

    const unchanged = await prisma.notificationSettings.findUnique({ where: { userId } });
    assert.equal(unchanged?.dailyLoopEnabled, true, "must not mutate before confirmation");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: 'yes' applies the pending daily-loop disable", async () => {
  const server = buildServer();
  const userId = `daily-loop-apply-off-${randomUUID()}`;

  try {
    await seedUser(userId);
    await prisma.notificationSettings.create({ data: { userId, dailyLoopEnabled: true } });

    mockPlan(dailyLoopProposeUpdatePlan({ enabled: false }));
    await sendAgentMessage(server, userId, "turn off daily review");

    // No mockPlan: exact "yes" is handled deterministically before the planner runs.
    const reply = await sendAgentMessage(server, userId, "yes");

    assert.equal(reply.debug.mutationExecuted, true);
    assert.match(reply.reply, /done — daily review reminders are now off/i);
    assert.equal(reply.debug.pendingOperation, false, "the pending change clears once applied");

    const updated = await prisma.notificationSettings.findUnique({ where: { userId } });
    assert.equal(updated?.dailyLoopEnabled, false);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: 'cancel' clears the pending daily-loop change and mutates nothing", async () => {
  const server = buildServer();
  const userId = `daily-loop-cancel-${randomUUID()}`;

  try {
    await seedUser(userId);
    await prisma.notificationSettings.create({ data: { userId, dailyLoopEnabled: true } });

    mockPlan(dailyLoopProposeUpdatePlan({ enabled: false }));
    await sendAgentMessage(server, userId, "turn off daily review");

    const cancelReply = await sendAgentMessage(server, userId, "cancel");
    assert.equal(cancelReply.debug.plannerUsed, "none");
    assert.equal(cancelReply.debug.mutationExecuted, false);
    assert.equal(cancelReply.debug.pendingOperation, false);

    const unchanged = await prisma.notificationSettings.findUnique({ where: { userId } });
    assert.equal(unchanged?.dailyLoopEnabled, true);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: 'turn daily check-ins back on' works, and re-enabling an already-on loop is a truthful no-op", async () => {
  const server = buildServer();
  const userId = `daily-loop-on-${randomUUID()}`;

  try {
    await seedUser(userId);
    await prisma.notificationSettings.create({ data: { userId, dailyLoopEnabled: false } });

    mockPlan(dailyLoopProposeUpdatePlan({ enabled: true }));
    const proposeReply = await sendAgentMessage(server, userId, "turn daily check-ins back on");
    assert.match(proposeReply.reply, /about to turn daily loop reminders on/i);

    await sendAgentMessage(server, userId, "yes");
    const enabled = await prisma.notificationSettings.findUnique({ where: { userId } });
    assert.equal(enabled?.dailyLoopEnabled, true);

    // Already on — must not claim it will change anything, and must not open a pending change.
    mockPlan(dailyLoopProposeUpdatePlan({ enabled: true }));
    const alreadyReply = await sendAgentMessage(server, userId, "turn daily check-ins back on");
    assert.match(alreadyReply.reply, /already how it's set/i);
    assert.equal(alreadyReply.debug.mutationExecuted, false);
    assert.equal(alreadyReply.debug.pendingOperation, false, "nothing to confirm when already in the target state");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: 'set my daily review to mornings at 8am' proposes and applies a morning-time change", async () => {
  const server = buildServer();
  const userId = `daily-loop-morning-time-${randomUUID()}`;

  try {
    await seedUser(userId);
    await prisma.notificationSettings.create({ data: { userId, dailyLoopEnabled: true } });

    mockPlan(dailyLoopProposeUpdatePlan({ morningTimeText: "8am" }));
    const proposeReply = await sendAgentMessage(server, userId, "set my morning brief to 8am");
    assert.match(proposeReply.reply, /move the morning brief to 08:00/i);
    assert.equal(proposeReply.debug.mutationExecuted, false);

    const applyReply = await sendAgentMessage(server, userId, "yes");
    assert.equal(applyReply.debug.mutationExecuted, true);
    assert.match(applyReply.reply, /done — the morning brief is now at 08:00/i);

    const updated = await prisma.notificationSettings.findUnique({ where: { userId } });
    assert.equal(updated?.morningTimeMinutes, 8 * 60);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: a daily-loop request with no field specified asks for clarification and mutates nothing", async () => {
  const server = buildServer();
  const userId = `daily-loop-unspecified-${randomUUID()}`;

  try {
    await seedUser(userId);
    await prisma.notificationSettings.create({ data: { userId, dailyLoopEnabled: true } });

    mockPlan(dailyLoopProposeUpdatePlan({}));
    const reply = await sendAgentMessage(server, userId, "change my daily review");

    assert.match(reply.reply, /what would you like to change/i);
    assert.equal(reply.debug.mutationExecuted, false);
    assert.equal(reply.debug.pendingOperation, false, "an unspecified change must not open a pending confirmation");

    const unchanged = await prisma.notificationSettings.findUnique({ where: { userId } });
    assert.equal(unchanged?.dailyLoopEnabled, true);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: a request for an unsupported daily-loop setting is declined honestly and mutates nothing", async () => {
  const server = buildServer();
  const userId = `daily-loop-unsupported-${randomUUID()}`;

  try {
    await seedUser(userId);
    await prisma.notificationSettings.create({ data: { userId, dailyLoopEnabled: true } });

    mockPlan({
      topic: "daily_loop_settings",
      intent: "unsupported_daily_loop_setting",
      operations: [],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: "The daily loop only supports on/off plus the morning-brief and evening-review times — I can't change the delivery channel."
    });
    const reply = await sendAgentMessage(server, userId, "send my daily review by SMS instead");

    assert.match(reply.reply, /can't change the delivery channel/i);
    assert.equal(reply.debug.mutationExecuted, false);

    const unchanged = await prisma.notificationSettings.findUnique({ where: { userId } });
    assert.equal(unchanged?.dailyLoopEnabled, true);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: 'yes' with no pending daily-loop change gives the fixed no-pending reply", async () => {
  const server = buildServer();
  const userId = `daily-loop-yes-no-pending-${randomUUID()}`;

  try {
    await seedUser(userId);

    const reply = await sendAgentMessage(server, userId, "yes");
    assert.equal(reply.reply, "I don't have anything pending to confirm.");
    assert.equal(reply.debug.mutationExecuted, false);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: daily_loop.settings_apply_update can never be planned by the LLM directly, only reached via the confirm whitelist", async () => {
  const server = buildServer();
  const userId = `daily-loop-no-direct-apply-${randomUUID()}`;

  try {
    await seedUser(userId);
    await prisma.notificationSettings.create({ data: { userId, dailyLoopEnabled: true } });

    mockPlan(dailyLoopProposeUpdatePlan({ enabled: false }));
    await sendAgentMessage(server, userId, "turn off daily review");

    mockPlan({
      topic: "daily_loop_settings",
      intent: "apply_daily_loop_settings_update",
      operations: [op("daily_loop.settings_apply_update", { enabled: false })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "please just do it now");

    assert.equal(reply.debug.toolValidationPassed, false, "a direct daily_loop.settings_apply_update plan must be rejected");
    assert.equal(reply.debug.mutationExecuted, false);

    const unchanged = await prisma.notificationSettings.findUnique({ where: { userId } });
    assert.equal(unchanged?.dailyLoopEnabled, true);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
