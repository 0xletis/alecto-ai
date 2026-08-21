import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createGoal } from "../packages/db/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, mockGuardrail, mockPlan, op, prisma, sendAgentMessage, seedUser, type MockGuardrailClassification } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * Real Telegram smoke test found the goal-avoidance guardrail (goal-guardrails.ts) hijacking
 * plain goal-MANAGEMENT commands — "pause my Meditations goal," "remove the meditations goal" —
 * as avoidance/lapse of the very goal being paused/archived, because checkGoalGuardrail ran on
 * every message before the LLM planner ever got a chance to route it to goal.archive_propose
 * (§29). Root cause: no deterministic domain shortcut recognized goal-lifecycle phrasing the way
 * Gmail domain shortcuts already do (see runtime.ts's own comment ahead of its guardrail check,
 * added for an identical earlier "check gmail every hour" hijack bug) — so unlike Gmail
 * sync/autonomy/review commands, a goal-lifecycle command had no way to reach the executor before
 * the guardrail intercepted it. Fix: a new deterministic `goalLifecycleShortcutOperation`
 * (runtime.ts), checked before checkGoalGuardrail, exactly mirroring the existing Gmail shortcut
 * pattern. Also closes two smaller issues surfaced by the same transcript: goal.list's closing
 * line was stale (still said editing/deleting wasn't wired, after §29 shipped it), and a bare
 * pronoun follow-up ("okay pause it") after a cancelled lifecycle attempt must still resolve via
 * conversational focus rather than falling back to the guardrail.
 */

async function seedGoal(userId: string, title: string, category: string, priority: "low" | "medium" | "high" | "critical" = "medium") {
  const result = await createGoal(userId, { title, category, priority });
  if (result.duplicate) throw new Error("unexpected duplicate goal in test setup");
  return result.goal;
}

function guardrailClassification(overrides: Partial<MockGuardrailClassification> & Pick<MockGuardrailClassification, "conflict">): MockGuardrailClassification {
  return { goalId: null, pattern: null, clarifyingQuestion: null, reason: "test", ...overrides };
}

test("A. 'pause my Meditations goal' bypasses the guardrail, opens a confirmation, and pausing sticks", async () => {
  const server = buildServer();
  const userId = `lifecycle-guardrail-a-${randomUUID()}`;

  try {
    await seedUser(userId);
    const goal = await seedGoal(userId, "Finish reading Meditations by Marcus Aurelius", "learning");

    // Forces exactly what the reported bug showed if the guardrail were reached — proves the
    // deterministic shortcut never even calls it, rather than merely getting lucky with a mock
    // that would have said "allow" anyway.
    mockGuardrail(guardrailClassification({ conflict: "soft_warn", goalId: goal.id, pattern: "avoidance" }));
    const proposeReply = await sendAgentMessage(server, userId, "pause my Meditations goal");

    assert.doesNotMatch(proposeReply.reply, /avoidance|conflicts with your goal/i);
    assert.equal(proposeReply.debug.conversationTopic, "goal_lifecycle");
    assert.equal(proposeReply.debug.llmPlannerAttempted, false, "a deterministic shortcut must never even reach the planner/guardrail turn");
    assert.match(proposeReply.reply, /pause "finish reading meditations by marcus aurelius"/i);
    assert.match(proposeReply.reply, /stop appearing as active, but history stays/i);
    assert.equal(proposeReply.needsConfirmation, true);
    assert.equal(proposeReply.debug.mutationExecuted, false);

    const confirmReply = await sendAgentMessage(server, userId, "yes");
    assert.match(confirmReply.reply, /paused "finish reading meditations by marcus aurelius"/i);
    assert.equal(confirmReply.debug.mutationExecuted, true);

    const row = await prisma.goal.findUnique({ where: { id: goal.id } });
    assert.equal(row?.status, "paused");

    const active = await prisma.goal.findMany({ where: { userId, status: "active" } });
    assert.ok(!active.some((g) => g.id === goal.id), "the paused goal must no longer appear in active goals");

    // The same goal no longer being active means checkGoalGuardrail short-circuits to allow
    // before ever reaching classification — no mock needed to prove this, since a stale mock left
    // over from above would make a false pass here impossible to occur by accident.
    clearAgentRuntimeMocks();
    mockPlan({ topic: "general", intent: "log_intent", operations: [], needsClarification: false, clarificationQuestion: null, replyDraft: "Okay, noted." });
    const laterReply = await sendAgentMessage(server, userId, "I don't want to read Meditations, I'll scroll TikTok instead");
    assert.doesNotMatch(laterReply.reply, /avoidance|conflicts with your goal/i);
    assert.equal(laterReply.debug.llmPlannerAttempted, true, "must reach normal planning once the only related goal is paused");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("B. 'remove the meditations goal' maps to archive intent, not a guardrail hard-refuse", async () => {
  const server = buildServer();
  const userId = `lifecycle-guardrail-b-${randomUUID()}`;

  try {
    await seedUser(userId);
    const goal = await seedGoal(userId, "Finish reading Meditations by Marcus Aurelius", "learning");

    mockGuardrail(guardrailClassification({ conflict: "hard_block", goalId: goal.id, pattern: "active_violation" }));
    const reply = await sendAgentMessage(server, userId, "i dont wanna do it anymore, remove the meditations goal");

    assert.doesNotMatch(reply.reply, /^no\./i);
    assert.doesNotMatch(reply.reply, /conflicts with your goal/i);
    assert.equal(reply.debug.llmPlannerAttempted, false);
    assert.match(reply.reply, /finish reading meditations by marcus aurelius/i);
    assert.match(reply.reply, /won't permanently delete the history|not permanently delete the history/i);
    assert.equal(reply.needsConfirmation, true);
    assert.equal(reply.debug.mutationExecuted, false);

    const row = await prisma.goal.findUnique({ where: { id: goal.id } });
    assert.equal(row?.status, "active", "nothing may be archived before confirmation");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("C. a bare 'okay pause it' after a cancelled lifecycle attempt still resolves via focus, never avoidance", async () => {
  const server = buildServer();
  const userId = `lifecycle-guardrail-c-${randomUUID()}`;

  try {
    await seedUser(userId);
    const goal = await seedGoal(userId, "Finish reading Meditations by Marcus Aurelius", "learning");

    mockPlan({ topic: "goals", intent: "list_goals", operations: [op("goal.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "list my goals");

    mockGuardrail(guardrailClassification({ conflict: "soft_warn", goalId: goal.id, pattern: "avoidance" }));
    const proposeReply = await sendAgentMessage(server, userId, "pause my Meditations goal");
    assert.equal(proposeReply.needsConfirmation, true);

    const cancelReply = await sendAgentMessage(server, userId, "cancel");
    assert.equal(cancelReply.reply, "Cancelled — I won't do that.");

    const followUpReply = await sendAgentMessage(server, userId, "okay pause it");
    assert.doesNotMatch(followUpReply.reply, /avoidance|conflicts with your goal/i);
    assert.equal(followUpReply.debug.llmPlannerAttempted, false);
    assert.match(followUpReply.reply, /finish reading meditations by marcus aurelius/i);
    assert.equal(followUpReply.needsConfirmation, true);

    const row = await prisma.goal.findUnique({ where: { id: goal.id } });
    assert.equal(row?.status, "active", "still nothing may be archived before this second confirmation");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("D. goal list copy no longer says editing/deleting isn't wired, and shows natural lifecycle examples", async () => {
  const server = buildServer();
  const userId = `lifecycle-guardrail-d-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedGoal(userId, "Finish reading Meditations by Marcus Aurelius", "learning");

    mockPlan({ topic: "goals", intent: "list_goals", operations: [op("goal.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "list my goals");

    assert.doesNotMatch(reply.reply, /isn't wired yet/i);
    assert.doesNotMatch(reply.reply, /editing or deleting/i);
    assert.match(reply.reply, /pause the meditations goal/i);
    assert.match(reply.reply, /archive the car goal/i);
    assert.match(reply.reply, /show progress on job search/i);
    assert.match(reply.reply, /log 20 pages for reading/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("E. an archived goal no longer triggers the guardrail, but a different still-active goal is cited correctly", async () => {
  const server = buildServer();
  const userId = `lifecycle-guardrail-e-${randomUUID()}`;

  try {
    await seedUser(userId);
    const meditations = await seedGoal(userId, "Finish reading Meditations by Marcus Aurelius", "learning");
    const readMore = await seedGoal(userId, "Read more", "learning");

    mockGuardrail(guardrailClassification({ conflict: "soft_warn", goalId: meditations.id, pattern: "avoidance" }));
    await sendAgentMessage(server, userId, "archive my Meditations goal");
    await sendAgentMessage(server, userId, "yes");

    const row = await prisma.goal.findUnique({ where: { id: meditations.id } });
    assert.equal(row?.status, "archived");

    // Same shape of message as the real bug report — must not cite the now-archived Meditations
    // goal, but a genuinely different, still-active goal ("Read more") may still be cited.
    mockGuardrail(guardrailClassification({ conflict: "soft_warn", goalId: readMore.id, pattern: "avoidance" }));
    const reply = await sendAgentMessage(server, userId, "i dont want to read Meditations, i'll scroll tiktok");

    assert.doesNotMatch(reply.reply, /finish reading meditations by marcus aurelius/i);
    assert.match(reply.reply, /read more/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("F. archiving a critical-priority goal is not hard-blocked, but gets an extra friction confirmation", async () => {
  const server = buildServer();
  const userId = `lifecycle-guardrail-f-${randomUUID()}`;

  try {
    await seedUser(userId);
    const goal = await seedGoal(userId, "Finish reading Meditations by Marcus Aurelius", "learning", "critical");

    const proposeReply = await sendAgentMessage(server, userId, "archive my Meditations goal");
    assert.equal(proposeReply.needsConfirmation, true, "friction is not a hard block — the user can still confirm");
    assert.match(proposeReply.reply, /marked critical/i);
    assert.match(proposeReply.reply, /won't archive it silently/i);
    assert.match(proposeReply.reply, /reply yes to confirm or cancel/i);
    assert.equal(proposeReply.debug.mutationExecuted, false);

    const confirmReply = await sendAgentMessage(server, userId, "yes");
    assert.match(confirmReply.reply, /archived "finish reading meditations by marcus aurelius"/i);

    const row = await prisma.goal.findUnique({ where: { id: goal.id } });
    assert.equal(row?.status, "archived");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
