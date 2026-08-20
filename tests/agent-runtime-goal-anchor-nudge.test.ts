import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createGoal, prisma } from "../packages/db/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, mockPlan, op, sendAgentMessage, seedUser, type MockPlan } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * Agent Runtime v3's goal-anchor nudge (apps/api/src/agent-runtime/runtime.ts's
 * shouldShowGoalAnchorNudge/GOAL_ANCHOR_NUDGE_REPLY) — the small, deterministic, pre-planner
 * check that closes the last pre-proactive-operator product question: the goal-aligned guardrail
 * engine (goal-guardrails.ts) has nothing to work with for a genuinely empty user (no active
 * goals, no knownTriggers/knownFailureModes). This is NOT full onboarding and NOT proactive
 * push behavior — it only ever fires as a direct reply to a broad, capability-agnostic
 * operator/help question the user asked themselves, never unprompted, and never during a
 * specific capability flow. No new session schema was added — "was it just shown" is checked
 * against the existing session.messages history via a marker phrase.
 */

function operatorTodayPlan(): MockPlan {
  return { topic: "operator_summary", intent: "daily_summary", operations: [op("operator.today")], needsClarification: false, clarificationQuestion: null, replyDraft: "" };
}

test("1. an empty user asking 'so what today' gets the goal/guardrail anchor nudge", async () => {
  const server = buildServer();
  const userId = `nudge-empty-today-${randomUUID()}`;

  try {
    await seedUser(userId);

    // No mockPlan: the nudge must short-circuit before the planner is ever invoked.
    const reply = await sendAgentMessage(server, userId, "so what today");

    assert.match(reply.reply, /one real goal or guardrail/i);
    assert.match(reply.reply, /\/create_goal/);
    assert.equal(reply.debug.llmPlannerAttempted, false, "the planner must never run once the nudge fires");
    assert.deepEqual(reply.operationsPlanned, []);
    assert.equal(reply.debug.mutationExecuted, false);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2. an empty user asking 'what can you help me with?' gets the nudge", async () => {
  const server = buildServer();
  const userId = `nudge-empty-help-${randomUUID()}`;

  try {
    await seedUser(userId);

    const reply = await sendAgentMessage(server, userId, "what can you help me with?");

    assert.match(reply.reply, /one real goal or guardrail/i);
    assert.equal(reply.debug.llmPlannerAttempted, false);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3. a user with an active goal asking 'so what today' does not get the nudge", async () => {
  const server = buildServer();
  const userId = `nudge-has-goal-${randomUUID()}`;

  try {
    await seedUser(userId);
    await createGoal(userId, { title: "Find a new developer job", category: "career", priority: "high" });

    mockPlan(operatorTodayPlan());
    const reply = await sendAgentMessage(server, userId, "so what today");

    assert.doesNotMatch(reply.reply, /one real goal or guardrail/i);
    assert.equal(reply.debug.llmPlannerAttempted, true, "must reach the normal planner, proving the nudge did not intercept");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4. a user with a knownTrigger but no goals does not get the nudge", async () => {
  const server = buildServer();
  const userId = `nudge-has-trigger-${randomUUID()}`;

  try {
    await seedUser(userId);
    await prisma.userOperatingProfile.create({ data: { userId, knownTriggers: ["late night online shopping"] } });

    mockPlan(operatorTodayPlan());
    const reply = await sendAgentMessage(server, userId, "so what today");

    assert.doesNotMatch(reply.reply, /one real goal or guardrail/i);
    assert.equal(reply.debug.llmPlannerAttempted, true, "a configured trigger is itself an anchor for the guardrail engine, so the nudge must not fire");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("5. a specific capability request from an empty user does not get the nudge", async () => {
  const server = buildServer();
  const userId = `nudge-specific-request-${randomUUID()}`;

  try {
    await seedUser(userId);

    mockPlan({ topic: "gmail_rules", intent: "list_active_rules", operations: [op("gmail.rule.list")], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "what email rules are active?");

    assert.doesNotMatch(reply.reply, /one real goal or guardrail/i);
    assert.match(reply.reply, /no active gmail rules/i);
    assert.equal(reply.debug.llmPlannerAttempted, true);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("6. 'what are my goals?' from an empty user still uses goal.list's own honest empty state, not the nudge", async () => {
  const server = buildServer();
  const userId = `nudge-vs-goal-list-${randomUUID()}`;

  try {
    await seedUser(userId);

    mockPlan({ topic: "goals", intent: "list_active_goals", operations: [op("goal.list")], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "what are my goals?");

    assert.doesNotMatch(reply.reply, /one real goal or guardrail/i, "goal.list's own empty-state text must win, not the separate broad-question nudge");
    assert.match(reply.reply, /don't have active goals set yet/i);
    assert.equal(reply.debug.llmPlannerAttempted, true, "goal.list is a normal planned tool, not a nudge short-circuit");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("7. the nudge does not repeat immediately on the very next broad message", async () => {
  const server = buildServer();
  const userId = `nudge-no-repeat-${randomUUID()}`;

  try {
    await seedUser(userId);

    const first = await sendAgentMessage(server, userId, "so what today");
    assert.match(first.reply, /one real goal or guardrail/i);

    // Still no goal/trigger configured, and still a broad question — but the nudge was the very
    // last thing shown, so this turn must fall through to normal planning instead of repeating.
    mockPlan(operatorTodayPlan());
    const second = await sendAgentMessage(server, userId, "what can you help me with?");

    assert.doesNotMatch(second.reply, /one real goal or guardrail/i);
    assert.equal(second.debug.llmPlannerAttempted, true);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
