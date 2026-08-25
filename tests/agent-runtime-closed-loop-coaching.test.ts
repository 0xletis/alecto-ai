import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createActionItem, createEvent, createGoal } from "../packages/db/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, mockPlan, op, prisma, sendAgentMessage, seedUser, type MockPlan } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * Deterministic (mocked-planner) coverage for feat/private-alpha-closed-loop-coaching — the
 * MECHANISM behind "what should I do next?": goal resolution, real evidence/open-action data
 * grounding, existing-action-wins-over-duplicate logic, confirmation-backed new-action proposal,
 * and count pluralization. The actual coaching JUDGMENT (whether the LLM's advice is any good) is
 * inherently a planner-quality question, covered separately by the gated real-LLM eval suite.
 */

async function seedJobGoal(userId: string): Promise<Awaited<ReturnType<typeof createGoal>>> {
  return createGoal(userId, {
    title: "Find a fully remote Web3 developer job",
    category: "career",
    priority: "medium",
    targetMetrics: [
      { key: "applications_sent", label: "CVs sent", labelSingular: "CV sent", eventType: "career.application_sent", aggregation: "count", window: "daily" }
    ]
  });
}

test("3B/3C: 'what should I do next?' returns a coaching recommendation, not just a stats recap", async () => {
  const server = buildServer();
  const userId = `closed-loop-3bc-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goalResult = await seedJobGoal(userId);
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
    await createEvent(userId, { type: "career.application_sent", source: "manual", confidence: 1, data: {} });

    mockPlan({
      topic: "goals",
      intent: "next_action",
      operations: [
        op("goal.recommend_next_action", {
          recommendation: "Good start, but not enough volume yet for momentum. Next I'd do one concrete block: apply to 4 more fully remote Web3 roles today.",
          proposedAction: "Apply to 4 more fully remote Web3 roles today"
        })
      ],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "what should I do next?");

    assert.match(reply.reply, /not enough volume yet for momentum/i, "the coaching recommendation must actually appear");
    assert.match(reply.reply, /1 cv sent/i, "the real grounded evidence count must still be shown");
    assert.doesNotMatch(reply.reply, /^"find a fully remote web3 developer job":\s*\n\s*this week: 1 cv sent\.\s*\n\s*today: 1 cv sent\.\s*$/i, "must not be identical to a bare stats recap");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3A: 'show my progress' still returns plain stats via goal.status, unaffected by the new tool", async () => {
  const server = buildServer();
  const userId = `closed-loop-3a-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goalResult = await seedJobGoal(userId);
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
    await createEvent(userId, { type: "career.application_sent", source: "manual", confidence: 1, data: {} });

    mockPlan({ topic: "goals", intent: "status", operations: [op("goal.status", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "show my progress on my job search");

    assert.match(reply.reply, /1 cv sent/i);
    assert.doesNotMatch(reply.reply, /want me to create this action/i, "goal.status must never open an action confirmation");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3D/4A/4B: no open actions -> proposes ONE concrete action, opens a real pending confirmation, 'yes' creates it", async () => {
  const server = buildServer();
  const userId = `closed-loop-3d-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goalResult = await seedJobGoal(userId);
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");

    mockPlan({
      topic: "goals",
      intent: "next_action",
      operations: [
        op("goal.recommend_next_action", {
          recommendation: "No CVs sent yet today — let's get one solid block done.",
          proposedAction: "Apply to 5 fully remote Web3 roles today"
        })
      ],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "what should I do next?");

    assert.equal(reply.debug.pendingOperation, true, "a concrete new action must open a real pending confirmation, never mutate silently");
    assert.equal(reply.debug.mutationExecuted, false);
    assert.match(reply.reply, /apply to 5 fully remote web3 roles today/i);
    assert.match(reply.reply, /reply yes to confirm or cancel/i);

    const beforeCount = await prisma.actionItem.count({ where: { userId } });
    assert.equal(beforeCount, 0, "nothing may be created before confirmation");

    const confirmed = await sendAgentMessage(server, userId, "yes");
    assert.equal(confirmed.debug.mutationExecuted, true);

    const actions = await prisma.actionItem.findMany({ where: { userId } });
    assert.equal(actions.length, 1);
    assert.match(actions[0].title, /apply to 5 fully remote web3 roles today/i);
    assert.equal(actions[0].goalId, goalResult.goal.id, "the created action must be linked to the real goal, not left unlinked or mislinked");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4C: 'cancel' after a next-step action proposal does not create the action", async () => {
  const server = buildServer();
  const userId = `closed-loop-4c-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goalResult = await seedJobGoal(userId);
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");

    mockPlan({
      topic: "goals",
      intent: "next_action",
      operations: [op("goal.recommend_next_action", { recommendation: "Let's get one block done today.", proposedAction: "Apply to 5 roles today" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    await sendAgentMessage(server, userId, "what should I do next?");

    const cancelled = await sendAgentMessage(server, userId, "cancel");
    assert.equal(cancelled.debug.pendingOperation, false);

    const actions = await prisma.actionItem.count({ where: { userId } });
    assert.equal(actions, 0, "cancel must never create the proposed action");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3E/4E: an existing open action linked to the goal is recommended instead of proposing a duplicate", async () => {
  const server = buildServer();
  const userId = `closed-loop-3e-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goalResult = await seedJobGoal(userId);
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
    await createActionItem(userId, {
      source: "manual",
      title: "Apply to 5 fully remote Web3 roles today",
      priority: "medium",
      goalId: goalResult.goal.id,
      goalTitleSnapshot: goalResult.goal.title
    });

    mockPlan({
      topic: "goals",
      intent: "next_action",
      // The planner (or a stale one) might still try to propose ANOTHER new action — the
      // deterministic executor must veto that and point at the existing open one instead,
      // regardless of what proposedAction says.
      operations: [
        op("goal.recommend_next_action", {
          recommendation: "You've already got a solid action queued for today — that's the move.",
          proposedAction: "Apply to 5 more fully remote Web3 roles today"
        })
      ],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "what should I do next?");

    assert.equal(reply.debug.pendingOperation, false, "must never open a confirmation to create a duplicate of an already-open action");
    assert.match(reply.reply, /existing open action/i);
    assert.match(reply.reply, /apply to 5 fully remote web3 roles today/i);

    const actions = await prisma.actionItem.findMany({ where: { userId } });
    assert.equal(actions.length, 1, "no duplicate action must have been created");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Goal resolution rules -----------------------------------------------------------------

test("goal resolution: no active goals -> asks to set up a goal, never fabricates coaching", async () => {
  const server = buildServer();
  const userId = `closed-loop-no-goals-${randomUUID()}`;
  try {
    await seedUser(userId);
    mockPlan({
      topic: "goals",
      intent: "next_action",
      operations: [op("goal.recommend_next_action", { recommendation: "n/a" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "what should I do next?");

    assert.match(reply.reply, /don't have any active goals/i);
    assert.equal(reply.debug.pendingOperation, false);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("goal resolution: a single active goal resolves on its own, no clarification needed", async () => {
  const server = buildServer();
  const userId = `closed-loop-single-goal-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goalResult = await seedJobGoal(userId);
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");

    mockPlan({
      topic: "goals",
      intent: "next_action",
      operations: [op("goal.recommend_next_action", { recommendation: "Let's get moving on the job search." })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "what now?");

    assert.match(reply.reply, /find a fully remote web3 developer job/i);
    assert.doesNotMatch(reply.reply, /which goal/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("goal resolution: multiple active goals with none focused -> asks which goal, never guesses", async () => {
  const server = buildServer();
  const userId = `closed-loop-multi-goal-${randomUUID()}`;
  try {
    await seedUser(userId);
    const jobGoal = await seedJobGoal(userId);
    if (jobGoal.duplicate) throw new Error("unexpected duplicate goal in test setup");
    const fitnessGoal = await createGoal(userId, { title: "Train for a marathon", category: "fitness", priority: "medium" });
    if (fitnessGoal.duplicate) throw new Error("unexpected duplicate goal in test setup");

    mockPlan({
      topic: "goals",
      intent: "next_action",
      operations: [op("goal.recommend_next_action", { recommendation: "n/a" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "what should I do next?");

    assert.match(reply.reply, /find a fully remote web3 developer job/i);
    assert.match(reply.reply, /train for a marathon/i);
    assert.equal(reply.debug.pendingOperation, false);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 7: pluralization ------------------------------------------------------------------

test("7A/7B: evidence counts are pluralized correctly — '1 CV sent' singular, '2 CVs sent' plural", async () => {
  const server = buildServer();
  const singularUserId = `closed-loop-plural-1-${randomUUID()}`;
  const pluralUserId = `closed-loop-plural-2-${randomUUID()}`;
  try {
    await seedUser(singularUserId);
    const goal1 = await seedJobGoal(singularUserId);
    if (goal1.duplicate) throw new Error("unexpected duplicate goal in test setup");
    await createEvent(singularUserId, { type: "career.application_sent", source: "manual", confidence: 1, data: {} });

    mockPlan({ topic: "goals", intent: "status", operations: [op("goal.status", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const singularReply = await sendAgentMessage(server, singularUserId, "show my progress");
    assert.match(singularReply.reply, /1 cv sent/i);
    assert.doesNotMatch(singularReply.reply, /1 cvs sent/i, "must not say '1 CVs sent' — grammatically wrong");

    await seedUser(pluralUserId);
    const goal2 = await seedJobGoal(pluralUserId);
    if (goal2.duplicate) throw new Error("unexpected duplicate goal in test setup");
    await createEvent(pluralUserId, { type: "career.application_sent", source: "manual", confidence: 1, data: {} });
    await createEvent(pluralUserId, { type: "career.application_sent", source: "manual", confidence: 1, data: {} });

    mockPlan({ topic: "goals", intent: "status", operations: [op("goal.status", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const pluralReply = await sendAgentMessage(server, pluralUserId, "show my progress");
    assert.match(pluralReply.reply, /2 cvs sent/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: { in: [singularUserId, pluralUserId] } } });
  }
});

test("7: pluralization also applies inside goal.recommend_next_action's own grounded evidence block", async () => {
  const server = buildServer();
  const userId = `closed-loop-plural-recommend-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goalResult = await seedJobGoal(userId);
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
    await createEvent(userId, { type: "career.application_sent", source: "manual", confidence: 1, data: {} });

    mockPlan({
      topic: "goals",
      intent: "next_action",
      operations: [op("goal.recommend_next_action", { recommendation: "Good start — one more block would help." })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "what should I do next?");

    assert.match(reply.reply, /1 cv sent/i);
    assert.doesNotMatch(reply.reply, /1 cvs sent/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
