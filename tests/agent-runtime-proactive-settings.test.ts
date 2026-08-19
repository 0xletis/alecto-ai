import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../packages/db/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, mockPlan, op, sendAgentMessage, seedUser, type MockPlan } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * Agent Runtime v3's user-facing proactive preference/consent layer
 * (proactive.settings_show/settings_propose_update/settings_apply_update). Product correction:
 * PROACTIVE_OPERATOR_DELIVERY_ENABLED/PROACTIVE_OPERATOR_ALLOWLIST remain developer-only rollout
 * controls (docs/10-v3-readiness-audit.md §14) — they are not, and were never meant to be, the
 * product UX. This is the actual product UX: three independent NotificationSettings booleans
 * (morningBriefEnabled/eveningCheckinEnabled/gmailNudgeEnabled), controllable only through the
 * same propose → confirm flow every other settings-mutating V3 tool already uses, and never
 * silently enabled by the planner — see also tests/agent-runtime-proactive-suggestion.test.ts
 * for the "Alecto can suggest, but only the user can confirm" half of this.
 */

async function seedNotificationSettings(userId: string, overrides: Partial<{ morningBriefEnabled: boolean; eveningCheckinEnabled: boolean; gmailNudgeEnabled: boolean }> = {}) {
  await prisma.notificationSettings.create({
    data: {
      userId,
      morningBriefEnabled: overrides.morningBriefEnabled ?? false,
      eveningCheckinEnabled: overrides.eveningCheckinEnabled ?? false,
      gmailNudgeEnabled: overrides.gmailNudgeEnabled ?? false
    }
  });
}

function proactiveShowPlan(): MockPlan {
  return { topic: "proactive_settings", intent: "show_proactive_settings", operations: [op("proactive.settings_show")], needsClarification: false, clarificationQuestion: null, replyDraft: "" };
}

function proactiveProposeUpdatePlan(args: Record<string, unknown>): MockPlan {
  return { topic: "proactive_settings", intent: "propose_proactive_settings_update", operations: [op("proactive.settings_propose_update", args)], needsClarification: false, clarificationQuestion: null, replyDraft: "" };
}

test("6. 'turn on morning briefs' proposes the change and mutates nothing before 'yes'", async () => {
  const server = buildServer();
  const userId = `proactive-settings-propose-on-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedNotificationSettings(userId);

    mockPlan(proactiveProposeUpdatePlan({ morningBriefEnabled: true }));
    const reply = await sendAgentMessage(server, userId, "turn on morning briefs");

    assert.match(reply.reply, /about to turn on the morning brief/i);
    assert.match(reply.reply, /reply yes to confirm or cancel/i);
    assert.equal(reply.debug.mutationExecuted, false);
    assert.ok(reply.debug.pendingOperation, "a pending proactive settings change must be open");

    const unchanged = await prisma.notificationSettings.findUnique({ where: { userId } });
    assert.equal(unchanged?.morningBriefEnabled, false, "must not mutate before confirmation");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("7. 'yes' enables morning briefs", async () => {
  const server = buildServer();
  const userId = `proactive-settings-apply-on-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedNotificationSettings(userId);

    mockPlan(proactiveProposeUpdatePlan({ morningBriefEnabled: true }));
    await sendAgentMessage(server, userId, "turn on morning briefs");

    // No mockPlan: exact "yes" is handled deterministically before the planner runs.
    const reply = await sendAgentMessage(server, userId, "yes");

    assert.equal(reply.debug.mutationExecuted, true);
    assert.match(reply.reply, /done — the morning brief is now on/i);
    assert.equal(reply.debug.pendingOperation, false, "the pending change clears once applied");

    const updated = await prisma.notificationSettings.findUnique({ where: { userId } });
    assert.equal(updated?.morningBriefEnabled, true);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("8. 'stop morning briefs' proposes turning it off, and 'yes' turns it off", async () => {
  const server = buildServer();
  const userId = `proactive-settings-off-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedNotificationSettings(userId, { morningBriefEnabled: true });

    mockPlan(proactiveProposeUpdatePlan({ morningBriefEnabled: false }));
    const proposeReply = await sendAgentMessage(server, userId, "stop morning briefs");
    assert.match(proposeReply.reply, /about to turn off the morning brief/i);
    assert.equal(proposeReply.debug.mutationExecuted, false);

    const applyReply = await sendAgentMessage(server, userId, "yes");
    assert.equal(applyReply.debug.mutationExecuted, true);
    assert.match(applyReply.reply, /done — the morning brief is now off/i);

    const updated = await prisma.notificationSettings.findUnique({ where: { userId } });
    assert.equal(updated?.morningBriefEnabled, false);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("8b. 'stop evening check-ins' and 'turn on Gmail nudges' each toggle only their own field", async () => {
  const server = buildServer();
  const userId = `proactive-settings-independent-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedNotificationSettings(userId, { morningBriefEnabled: true, eveningCheckinEnabled: true, gmailNudgeEnabled: false });

    mockPlan(proactiveProposeUpdatePlan({ eveningCheckinEnabled: false }));
    await sendAgentMessage(server, userId, "stop evening check-ins");
    await sendAgentMessage(server, userId, "yes");

    mockPlan(proactiveProposeUpdatePlan({ gmailNudgeEnabled: true }));
    await sendAgentMessage(server, userId, "turn on Gmail nudges");
    await sendAgentMessage(server, userId, "yes");

    const updated = await prisma.notificationSettings.findUnique({ where: { userId } });
    assert.equal(updated?.morningBriefEnabled, true, "untouched fields must stay as they were");
    assert.equal(updated?.eveningCheckinEnabled, false);
    assert.equal(updated?.gmailNudgeEnabled, true);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("9. 'what proactive messages are on?' shows the real current settings", async () => {
  const server = buildServer();
  const userId = `proactive-settings-show-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedNotificationSettings(userId, { morningBriefEnabled: true, eveningCheckinEnabled: false, gmailNudgeEnabled: true });

    mockPlan(proactiveShowPlan());
    const reply = await sendAgentMessage(server, userId, "what proactive messages are on?");

    assert.match(reply.reply, /morning brief: on/i);
    assert.match(reply.reply, /evening check-in: off/i);
    assert.match(reply.reply, /gmail nudge: on/i);
    assert.equal(reply.debug.mutationExecuted, false);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("10. 'yes' with no pending proactive settings change gives the fixed no-pending reply", async () => {
  const server = buildServer();
  const userId = `proactive-settings-yes-no-pending-${randomUUID()}`;

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

test("a request with no field specified asks for clarification and mutates nothing", async () => {
  const server = buildServer();
  const userId = `proactive-settings-unspecified-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedNotificationSettings(userId);

    mockPlan(proactiveProposeUpdatePlan({}));
    const reply = await sendAgentMessage(server, userId, "change my proactive settings");

    assert.match(reply.reply, /what would you like to change/i);
    assert.equal(reply.debug.mutationExecuted, false);
    assert.equal(reply.debug.pendingOperation, false);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("proactive.settings_apply_update can never be planned by the LLM directly, only reached via the confirm whitelist", async () => {
  const server = buildServer();
  const userId = `proactive-settings-no-direct-apply-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedNotificationSettings(userId);

    mockPlan(proactiveProposeUpdatePlan({ morningBriefEnabled: true }));
    await sendAgentMessage(server, userId, "turn on morning briefs");

    mockPlan({
      topic: "proactive_settings",
      intent: "apply_proactive_settings_update",
      operations: [op("proactive.settings_apply_update", { morningBriefEnabled: true })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "please just do it now");

    assert.equal(reply.debug.toolValidationPassed, false, "a direct proactive.settings_apply_update plan must be rejected");
    assert.equal(reply.debug.mutationExecuted, false);

    const unchanged = await prisma.notificationSettings.findUnique({ where: { userId } });
    assert.equal(unchanged?.morningBriefEnabled, false);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
