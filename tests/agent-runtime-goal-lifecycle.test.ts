import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createGoal } from "../packages/db/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, mockGuardrail, mockPlan, op, prisma, sendAgentMessage, seedUser, type MockGuardrailClassification } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * V3-native goal lifecycle tools (goal.archive_propose/goal.archive_apply) — closes the gap found
 * in the prior V3 core-operator audit: normal V3 chat could create, list, and log evidence against
 * goals, but had no way to archive/pause one, even though Goal.status already had all three states
 * (active/paused/archived) and the legacy/slash routes already supported it. Mirrors the existing
 * gmail.rule.propose_update/apply_update propose-then-confirm pattern exactly, reusing the same
 * goal-reference resolver goal.status/goal.tracking_show already rely on (goal-reference.ts's
 * resolveActiveGoalReference), with a deliberately stricter sibling (resolveGoalForLifecycleAction)
 * that never falls back to "the newest goal" for a bare/ambiguous reference — a mutation must
 * either resolve to exactly one goal or ask, never guess.
 */

async function seedGoal(userId: string, title: string, category: string) {
  const result = await createGoal(userId, { title, category, priority: "medium" });
  if (result.duplicate) throw new Error("unexpected duplicate goal in test setup");
  return result.goal;
}

function guardrailClassification(overrides: Partial<MockGuardrailClassification> & Pick<MockGuardrailClassification, "conflict">): MockGuardrailClassification {
  return { goalId: null, pattern: null, clarifyingQuestion: null, reason: "test", ...overrides };
}

test("A. list goals, then archive the Meditations one by name, confirm, and it becomes archived", async () => {
  const server = buildServer();
  const userId = `goal-lifecycle-a-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedGoal(userId, "Finish reading Meditations", "learning");
    await seedGoal(userId, "Drink more water", "health");

    mockPlan({ topic: "goals", intent: "list_goals", operations: [op("goal.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const listReply = await sendAgentMessage(server, userId, "what are my goals?");
    assert.match(listReply.reply, /finish reading meditations/i);

    mockPlan({
      topic: "goal_lifecycle",
      intent: "propose_archive",
      operations: [op("goal.archive_propose", { goalRef: "Meditations", operation: "archive" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const proposeReply = await sendAgentMessage(server, userId, "archive my Meditations goal");
    assert.equal(
      proposeReply.reply,
      'You\'re about to archive "Finish reading Meditations". It will stop appearing as active, but history stays. Reply yes to confirm or cancel.'
    );
    assert.equal(proposeReply.needsConfirmation, true);
    assert.equal(proposeReply.debug.mutationExecuted, false);

    const confirmReply = await sendAgentMessage(server, userId, "yes");
    assert.equal(confirmReply.reply, 'Archived "Finish reading Meditations".');
    assert.equal(confirmReply.debug.mutationExecuted, true);

    const goal = await prisma.goal.findFirst({ where: { userId, title: "Finish reading Meditations" } });
    assert.equal(goal?.status, "archived");

    const other = await prisma.goal.findFirst({ where: { userId, title: "Drink more water" } });
    assert.equal(other?.status, "active", "an unrelated goal must never be touched by archiving a different one");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("B. 'delete this goal' after a focused goal archives it honestly, not as a real delete", async () => {
  const server = buildServer();
  const userId = `goal-lifecycle-b-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedGoal(userId, "Learn guitar", "hobby");

    mockPlan({ topic: "goals", intent: "goal_status", operations: [op("goal.status", { goalRef: "guitar" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "how's my guitar goal going?");

    mockPlan({
      topic: "goal_lifecycle",
      intent: "propose_archive",
      operations: [op("goal.archive_propose", { goalRef: "this goal", operation: "archive" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "delete this goal");

    assert.match(reply.reply, /learn guitar/i);
    assert.match(reply.reply, /i'll archive it so it stops being active, not permanently delete the history/i);
    assert.equal(reply.needsConfirmation, true);
    assert.equal(reply.debug.mutationExecuted, false);

    const goal = await prisma.goal.findFirst({ where: { userId, title: "Learn guitar" } });
    assert.equal(goal?.status, "active", "nothing may be archived before confirmation");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("C. an ambiguous goal name asks which goal instead of guessing, and archives nothing", async () => {
  const server = buildServer();
  const userId = `goal-lifecycle-c-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedGoal(userId, "Read more", "learning");
    await seedGoal(userId, "Read the Bible", "faith");

    mockPlan({
      topic: "goal_lifecycle",
      intent: "propose_archive",
      operations: [op("goal.archive_propose", { goalRef: "read", operation: "archive" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "archive my read goal");

    assert.match(reply.reply, /do you mean/i);
    assert.match(reply.reply, /read more/i);
    assert.match(reply.reply, /read the bible/i);
    assert.equal(reply.needsConfirmation, false, "an ambiguous match must never open a pending confirmation");
    assert.equal(reply.debug.mutationExecuted, false);

    const active = await prisma.goal.count({ where: { userId, status: "active" } });
    assert.equal(active, 2, "an ambiguous archive request must never mutate any candidate goal");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("D. cancelling a pending archive leaves the goal untouched", async () => {
  const server = buildServer();
  const userId = `goal-lifecycle-d-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedGoal(userId, "Finish reading Meditations", "learning");

    mockPlan({
      topic: "goal_lifecycle",
      intent: "propose_archive",
      operations: [op("goal.archive_propose", { goalRef: "Meditations", operation: "archive" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    await sendAgentMessage(server, userId, "archive my Meditations goal");

    const cancelReply = await sendAgentMessage(server, userId, "cancel");
    assert.equal(cancelReply.reply, "Cancelled — I won't do that.");
    assert.equal(cancelReply.debug.mutationExecuted, false);

    const goal = await prisma.goal.findFirst({ where: { userId, title: "Finish reading Meditations" } });
    assert.equal(goal?.status, "active");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("E. Spanish 'pausa este objetivo' after a focused goal pauses it, resumably", async () => {
  const server = buildServer();
  const userId = `goal-lifecycle-e-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedGoal(userId, "Meditar cada dia", "wellbeing");

    mockPlan({ topic: "goals", intent: "goal_status", operations: [op("goal.status", { goalRef: "Meditar" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "como va mi objetivo de meditar?");

    mockPlan({
      topic: "goal_lifecycle",
      intent: "propose_pause",
      operations: [op("goal.archive_propose", { goalRef: "este objetivo", operation: "pause" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const proposeReply = await sendAgentMessage(server, userId, "pausa este objetivo");
    assert.match(proposeReply.reply, /meditar cada dia/i);
    assert.match(proposeReply.reply, /it will stop appearing as active until you resume it/i);

    const confirmReply = await sendAgentMessage(server, userId, "yes");
    assert.match(confirmReply.reply, /paused "meditar cada dia"/i);

    const goal = await prisma.goal.findFirst({ where: { userId, title: "Meditar cada dia" } });
    assert.equal(goal?.status, "paused");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("F. an archived goal no longer triggers the V3 goal guardrail", async () => {
  const server = buildServer();
  const userId = `goal-lifecycle-f-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedGoal(userId, "Stop gambling", "wellbeing");

    mockPlan({
      topic: "goal_lifecycle",
      intent: "propose_archive",
      operations: [op("goal.archive_propose", { goalRef: "Stop gambling", operation: "archive" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    await sendAgentMessage(server, userId, "archive my stop gambling goal");
    await sendAgentMessage(server, userId, "yes");

    // Same message shape as the guardrail suite's own "hard-blocked while active" case — now
    // must reach normal planning instead, since getActiveGoals no longer returns this goal once
    // its status is "archived" and checkGoalGuardrail short-circuits to allow with zero active goals.
    mockPlan({ topic: "general", intent: "log_intent", operations: [], needsClarification: false, clarificationQuestion: null, replyDraft: "Got it, let me know how it goes." });
    const reply = await sendAgentMessage(server, userId, "I want to bet 1000 because it's safe");

    assert.equal(reply.debug.llmPlannerAttempted, true, "must reach the normal tool planner once the only related goal is archived");
    assert.doesNotMatch(reply.reply, /conflicts with your goal/i);

    const risk = await prisma.memoryEntry.count({ where: { userId, type: "risk_pattern" } });
    assert.equal(risk, 0, "nothing is logged as a risk incident once the goal it would have conflicted with is archived");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("G. archiving one goal never suppresses the guardrail for a different, still-active goal", async () => {
  const server = buildServer();
  const userId = `goal-lifecycle-g-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedGoal(userId, "Stop gambling", "wellbeing");
    const trainingGoal = await seedGoal(userId, "Train 3 times per week", "health");

    mockPlan({
      topic: "goal_lifecycle",
      intent: "propose_archive",
      operations: [op("goal.archive_propose", { goalRef: "Stop gambling", operation: "archive" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    await sendAgentMessage(server, userId, "archive my stop gambling goal");
    await sendAgentMessage(server, userId, "yes");

    mockGuardrail(guardrailClassification({ conflict: "soft_warn", goalId: trainingGoal.id, pattern: "avoidance" }));
    const reply = await sendAgentMessage(server, userId, "I'm going to skip the gym and watch TV all week instead");

    assert.match(reply.reply, /train 3 times per week/i);
    assert.deepEqual(reply.operationsPlanned, [], "the guardrail must still intercept before the planner runs for the goal that is still active");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("adversarial 1: goal.archive_apply can never be planned by the LLM directly, only reached via the confirm whitelist", async () => {
  const server = buildServer();
  const userId = `goal-lifecycle-adv-direct-apply-${randomUUID()}`;

  try {
    await seedUser(userId);
    const goal = await seedGoal(userId, "Finish reading Meditations", "learning");

    mockPlan({
      topic: "goal_lifecycle",
      intent: "apply_archive",
      operations: [op("goal.archive_apply", { goalId: goal.id, goalTitle: goal.title, operation: "archive" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "please just archive it now");

    assert.equal(reply.debug.toolValidationPassed, false, "a direct goal.archive_apply plan must be rejected");
    assert.equal(reply.debug.mutationExecuted, false);

    const row = await prisma.goal.findUnique({ where: { id: goal.id } });
    assert.equal(row?.status, "active");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("adversarial 2: confirming right after an ambiguous archive request does nothing, since no pending operation was ever opened", async () => {
  const server = buildServer();
  const userId = `goal-lifecycle-adv-ambiguous-confirm-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedGoal(userId, "Read more", "learning");
    await seedGoal(userId, "Read the Bible", "faith");

    mockPlan({
      topic: "goal_lifecycle",
      intent: "propose_archive",
      operations: [op("goal.archive_propose", { goalRef: "read", operation: "archive" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    await sendAgentMessage(server, userId, "archive my read goal");

    const confirmReply = await sendAgentMessage(server, userId, "yes");
    assert.equal(confirmReply.debug.pendingOperation, false, "there was never a pending operation to confirm");
    assert.equal(confirmReply.debug.mutationExecuted, false);

    const active = await prisma.goal.count({ where: { userId, status: "active" } });
    assert.equal(active, 2, "an ambiguous request followed by 'yes' must never archive either candidate");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
