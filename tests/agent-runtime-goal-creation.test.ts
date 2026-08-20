import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../packages/db/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, mockPlan, op, sendAgentMessage, seedUser, type MockPlan } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * Adaptive Goal Creation / Goal Operating Plan MVP (docs/10-v3-readiness-audit.md §21). The
 * product correction this closes: the prior Goal Evidence Loop pass could only evidence a goal
 * whose targetMetrics were already declared — via a template (career.job_search) or manually —
 * meaning any genuinely novel goal ("I want to drink more tea") had nowhere to go but a fixed
 * template or a decline. This suite proves the ADAPTIVE path: the LLM proposes a full custom
 * operating plan (title/category/signals/check-in/first actions) grounded in what the user
 * actually said, a deterministic executor creates nothing until an exact confirmation, and once
 * created, a genuinely custom signal (no EventType registry entry, no template) can be logged
 * against by key — proving Goal.targetMetrics[].eventType's sibling field, signalKey, needed no
 * database migration (targetMetrics is stored as JSON) to support arbitrary per-goal signals.
 */

function teaGoalPlan(): MockPlan["operations"] {
  return [
    op("goal.create_propose", {
      title: "Drink more tea",
      category: "health",
      successCriteria: "2 cups/day, 5 days/week",
      signals: [{ key: "tea_cups_drunk", label: "cups of tea drunk", unit: "cups", cadence: "daily" }],
      checkIn: { cadence: "evening", question: "how many cups today?" },
      firstActions: ["Buy tea"]
    })
  ];
}

test("1. 'I want to drink more tea' proposes a full custom operating plan and creates nothing before confirmation", async () => {
  const server = buildServer();
  const userId = `goal-create-tea-propose-${randomUUID()}`;

  try {
    await seedUser(userId);

    mockPlan({ topic: "goals", intent: "propose_goal_creation", operations: teaGoalPlan(), needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "I want to drink more tea");

    assert.match(reply.reply, /goal: drink more tea/i);
    assert.match(reply.reply, /target: 2 cups\/day, 5 days\/week/i);
    assert.match(reply.reply, /cups of tea drunk/i);
    assert.match(reply.reply, /evening.*how many cups today/i);
    assert.match(reply.reply, /buy tea/i);
    assert.match(reply.reply, /want me to create this goal/i);
    assert.equal(reply.debug.mutationExecuted, false);

    const goals = await prisma.goal.count({ where: { userId } });
    assert.equal(goals, 0, "nothing is created before an exact confirmation");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2. confirming the tea plan creates the real goal, its custom signal, check-in, and first action", async () => {
  const server = buildServer();
  const userId = `goal-create-tea-apply-${randomUUID()}`;

  try {
    await seedUser(userId);

    mockPlan({ topic: "goals", intent: "propose_goal_creation", operations: teaGoalPlan(), needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "I want to drink more tea");

    const reply = await sendAgentMessage(server, userId, "yes");
    assert.equal(reply.debug.mutationExecuted, true);
    assert.match(reply.reply, /done.*drink more tea/i);
    assert.match(reply.reply, /cups of tea drunk/i);
    assert.match(reply.reply, /created 1 first action/i);

    const goal = await prisma.goal.findFirst({ where: { userId, title: "Drink more tea" } });
    assert.ok(goal, "a real Goal row must exist");
    assert.equal(goal?.category, "health");
    const metrics = goal?.targetMetrics as Array<{ key: string; label: string; signalKey?: string }> | null;
    assert.ok(metrics?.some((metric) => metric.signalKey === "tea_cups_drunk"), "the custom signal key must be stored on the goal's own targetMetrics — no schema migration, just JSON");

    const action = await prisma.actionItem.findFirst({ where: { userId, title: "Buy tea" } });
    assert.equal(action?.goalId, goal?.id, "the first action must be linked to the new goal");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3. 'had 2 teas today' logs progress against the custom tea signal, grounded and linked", async () => {
  const server = buildServer();
  const userId = `goal-create-tea-log-${randomUUID()}`;

  try {
    await seedUser(userId);

    mockPlan({ topic: "goals", intent: "propose_goal_creation", operations: teaGoalPlan(), needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "I want to drink more tea");
    await sendAgentMessage(server, userId, "yes");

    mockPlan({ topic: "goal_evidence", intent: "log_evidence", operations: [op("goal.log_evidence", { signalKey: "tea_cups_drunk", count: 2 })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "had 2 teas today");

    assert.match(reply.reply, /2 cups of tea drunk/i);
    assert.match(reply.reply, /counts toward your "drink more tea" goal/i);
    assert.equal(reply.debug.mutationExecuted, true);

    const events = await prisma.event.findMany({ where: { userId, type: "custom.goal_progress_logged" } });
    assert.equal(events.length, 2, "each cup is its own grounded event, matching how event.log_job_applications already logs one event per unit");
    assert.ok(events.every((event) => (event.data as { signalKey?: string })?.signalKey === "tea_cups_drunk"));
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4. goal.log_evidence rejects a signalKey that no active goal actually declared — never invents the link", async () => {
  const server = buildServer();
  const userId = `goal-create-signal-not-declared-${randomUUID()}`;

  try {
    await seedUser(userId);

    mockPlan({ topic: "goals", intent: "propose_goal_creation", operations: teaGoalPlan(), needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "I want to drink more tea");
    await sendAgentMessage(server, userId, "yes");

    mockPlan({ topic: "goal_evidence", intent: "log_evidence", operations: [op("goal.log_evidence", { signalKey: "called_grandmother", count: 1 })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "called my grandmother");

    assert.match(reply.reply, /don't have a "called_grandmother" signal/i);
    assert.equal(reply.debug.mutationExecuted, false);
    const events = await prisma.event.count({ where: { userId } });
    assert.equal(events, 0, "an unrecognized signal key must never be logged as if it were real evidence");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("5. goal.tracking_show reports the real configured signal keys, not progress", async () => {
  const server = buildServer();
  const userId = `goal-create-tracking-show-${randomUUID()}`;

  try {
    await seedUser(userId);

    mockPlan({ topic: "goals", intent: "propose_goal_creation", operations: teaGoalPlan(), needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "I want to drink more tea");
    await sendAgentMessage(server, userId, "yes");

    mockPlan({ topic: "goals", intent: "show_tracking", operations: [op("goal.tracking_show", { goalRef: "tea" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "what am I tracking for the tea goal?");

    assert.match(reply.reply, /cups of tea drunk/i);
    assert.match(reply.reply, /tea_cups_drunk/i);
    assert.match(reply.reply, /how many cups today/i);
    assert.doesNotMatch(reply.reply, /this week|today:/i, "tracking config must not report progress counts");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("6. goal.status counts real progress against the custom tea signal after logging", async () => {
  const server = buildServer();
  const userId = `goal-create-status-${randomUUID()}`;

  try {
    await seedUser(userId);

    mockPlan({ topic: "goals", intent: "propose_goal_creation", operations: teaGoalPlan(), needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "I want to drink more tea");
    await sendAgentMessage(server, userId, "yes");

    mockPlan({ topic: "goal_evidence", intent: "log_evidence", operations: [op("goal.log_evidence", { signalKey: "tea_cups_drunk", count: 2 })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "had 2 teas today");

    mockPlan({ topic: "goal_evidence", intent: "goal_status", operations: [op("goal.status", { goalRef: "tea" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "how's the tea goal going?");

    assert.match(reply.reply, /2 cups of tea drunk/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("7. an existing goal with the same title is never duplicated — the confirmation is honest about it", async () => {
  const server = buildServer();
  const userId = `goal-create-duplicate-${randomUUID()}`;

  try {
    await seedUser(userId);

    mockPlan({ topic: "goals", intent: "propose_goal_creation", operations: teaGoalPlan(), needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "I want to drink more tea");
    await sendAgentMessage(server, userId, "yes");

    mockPlan({ topic: "goals", intent: "propose_goal_creation", operations: teaGoalPlan(), needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "I want to drink more tea");
    const secondApply = await sendAgentMessage(server, userId, "yes");

    assert.match(secondApply.reply, /already have an active goal called "drink more tea"/i);

    const goalCount = await prisma.goal.count({ where: { userId, title: "Drink more tea" } });
    assert.equal(goalCount, 1, "confirming the same proposal twice must never create a second goal");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("8. goal.create_apply can never be planned by the LLM directly, only reached via the confirm whitelist", async () => {
  const server = buildServer();
  const userId = `goal-create-no-direct-apply-${randomUUID()}`;

  try {
    await seedUser(userId);

    mockPlan({ topic: "goals", intent: "propose_goal_creation", operations: teaGoalPlan(), needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "I want to drink more tea");

    mockPlan({
      topic: "goals",
      intent: "apply_goal_creation",
      operations: [op("goal.create_apply", { title: "Drink more tea", category: "health", signals: [{ key: "tea_cups_drunk", label: "cups of tea drunk" }] })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "please just create it now");

    assert.equal(reply.debug.toolValidationPassed, false, "a direct goal.create_apply plan must be rejected");
    assert.equal(reply.debug.mutationExecuted, false);

    const goals = await prisma.goal.count({ where: { userId } });
    assert.equal(goals, 0);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("9. a genuinely vague goal statement is never proposed as a concrete plan", async () => {
  const server = buildServer();
  const userId = `goal-create-too-vague-${randomUUID()}`;

  try {
    await seedUser(userId);

    mockPlan({
      topic: "general",
      intent: "clarify",
      operations: [op("clarification.ask", { question: "What specifically would you like to get better at?" })],
      needsClarification: true,
      clarificationQuestion: "What specifically would you like to get better at?",
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "I want to be better");

    assert.match(reply.reply, /what specifically would you like to get better at/i);
    assert.equal(reply.debug.mutationExecuted, false);

    const goals = await prisma.goal.count({ where: { userId } });
    assert.equal(goals, 0, "a vague statement must never produce a fabricated goal plan");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
