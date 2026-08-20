import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../packages/db/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, mockPlan, op, sendAgentMessage, seedUser } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * "Alecto can suggest proactive support, but never enable it unprompted." Product correction
 * (docs/10-v3-readiness-audit.md §15): when a user describes a daily/recurring goal, planner.ts
 * guidance now permits the planner to ALSO plan proactive.settings_propose_update in that same
 * turn — but it's still just a propose_update, which never mutates by itself; the exact same
 * confirm whitelist every other settings change already goes through is the only way it becomes
 * real. This test proves the suggestion path is indistinguishable, safety-wise, from any other
 * settings proposal — it opens a pending confirmation and nothing else.
 */

test("11. discussing a daily gym goal can surface a proactive-support suggestion, but never enables it by itself", async () => {
  const server = buildServer();
  const userId = `proactive-suggestion-${randomUUID()}`;

  try {
    await seedUser(userId);
    await prisma.notificationSettings.create({ data: { userId, morningBriefEnabled: false, eveningCheckinEnabled: false } });

    // Simulates what planner.ts's new suggestion guidance would realistically produce for "my
    // goal is to go to the gym every day": a memory.create (or nothing else) plus a courteous
    // proactive.settings_propose_update, exactly like any other settings proposal.
    mockPlan({
      topic: "proactive_settings",
      intent: "suggest_proactive_support",
      operations: [op("proactive.settings_propose_update", { morningBriefEnabled: true, eveningCheckinEnabled: true })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "my goal is to go to the gym every day");

    assert.match(reply.reply, /about to turn on the morning brief and turn on the evening check-in/i);
    assert.match(reply.reply, /reply yes to confirm or cancel/i);
    assert.equal(reply.debug.mutationExecuted, false, "a suggestion must never mutate settings by itself");
    assert.ok(reply.debug.pendingOperation, "the suggestion opens a pending confirmation, same as any other settings proposal");

    const unchanged = await prisma.notificationSettings.findUnique({ where: { userId } });
    assert.equal(unchanged?.morningBriefEnabled, false);
    assert.equal(unchanged?.eveningCheckinEnabled, false);

    // Only once the user actually confirms does anything become real.
    const confirmReply = await sendAgentMessage(server, userId, "yes");
    assert.equal(confirmReply.debug.mutationExecuted, true);
    const updated = await prisma.notificationSettings.findUnique({ where: { userId } });
    assert.equal(updated?.morningBriefEnabled, true);
    assert.equal(updated?.eveningCheckinEnabled, true);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("11b. a suggestion is not forced — an ordinary goal statement can also plan nothing but memory.create, with no settings change at all", async () => {
  const server = buildServer();
  const userId = `proactive-suggestion-declined-${randomUUID()}`;

  try {
    await seedUser(userId);
    await prisma.notificationSettings.create({ data: { userId, morningBriefEnabled: false, eveningCheckinEnabled: false } });

    mockPlan({
      topic: "memory",
      intent: "store_goal_context",
      operations: [op("memory.create", { summary: "Wants to read more books", type: "goal_context" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: "Got it — I'll remember that."
    });
    const reply = await sendAgentMessage(server, userId, "I want to read more books this year");

    assert.equal(reply.debug.pendingOperation, false, "a non-recurring goal statement is not required to trigger a proactive suggestion");
    const unchanged = await prisma.notificationSettings.findUnique({ where: { userId } });
    assert.equal(unchanged?.morningBriefEnabled, false);
    assert.equal(unchanged?.eveningCheckinEnabled, false);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
