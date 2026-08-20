import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createEvent, createGoal, prisma } from "../packages/db/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, mockGuardrail, mockPlan, op, sendAgentMessage, seedUser, type MockPlan } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * Agent Runtime v3's read-only goal-listing capability (apps/api/src/agent-runtime/executor.ts's
 * goal.list) and the honesty boundary around goal creation/editing, which V3 chat does not
 * support. Closes the readiness audit's last pre-proactive-operator baseline gap
 * (docs/10-v3-readiness-audit.md): before this pass, "what are my goals?" either fell through
 * to operator.today's bare active-goal COUNT or got silently mishandled, and there was no
 * guardrail against the planner quietly using memory.create to pretend a goal now exists. Both
 * are closed here without adding any goal creation/update/delete tool — goal.list is
 * intentionally the only new tool, deliberately minimal per this task's explicit scope.
 */

async function seedGoal(userId: string, input: { title: string; category: string; priority?: "low" | "medium" | "high" | "critical"; why?: string }) {
  const result = await createGoal(userId, { title: input.title, category: input.category, priority: input.priority ?? "medium", why: input.why });
  if (result.duplicate) throw new Error("unexpected duplicate goal in test setup");
  return result.goal;
}

function goalListPlan(): MockPlan {
  return { topic: "goals", intent: "list_active_goals", operations: [op("goal.list")], needsClarification: false, clarificationQuestion: null, replyDraft: "" };
}

test("1. 'what are my goals?' returns the user's real active goal titles", async () => {
  const server = buildServer();
  const userId = `goal-list-titles-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedGoal(userId, { title: "Find a new developer job", category: "career", priority: "critical", why: "Build stable career capital." });
    await seedGoal(userId, { title: "Improve strength and energy", category: "health", priority: "high" });

    mockPlan(goalListPlan());
    const reply = await sendAgentMessage(server, userId, "what are my goals?");

    assert.match(reply.reply, /your active goals:/i);
    assert.match(reply.reply, /find a new developer job/i);
    assert.match(reply.reply, /improve strength and energy/i);
    assert.equal(reply.debug.mutationExecuted, false);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2. goal.list includes priority/category/why where available", async () => {
  const server = buildServer();
  const userId = `goal-list-detail-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedGoal(userId, { title: "Find a new developer job", category: "career", priority: "critical", why: "Build stable career capital." });
    await seedGoal(userId, { title: "Improve strength and energy", category: "health", priority: "high" });

    mockPlan(goalListPlan());
    const reply = await sendAgentMessage(server, userId, "show my active goals");

    assert.match(reply.reply, /find a new developer job.*career.*critical/i);
    assert.match(reply.reply, /why: build stable career capital\./i);
    assert.match(reply.reply, /improve strength and energy.*health.*high/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3. no active goals returns an honest empty state, not a false count", async () => {
  const server = buildServer();
  const userId = `goal-list-empty-${randomUUID()}`;

  try {
    await seedUser(userId);

    mockPlan(goalListPlan());
    const reply = await sendAgentMessage(server, userId, "what am I working on?");

    assert.match(reply.reply, /don't have active goals set yet/i);
    assert.match(reply.reply, /\/create_goal/);
    assert.equal(reply.debug.mutationExecuted, false);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4. 'create a goal to run a marathon' does not silently create a memory pretending to be a goal", async () => {
  const server = buildServer();
  const userId = `goal-create-decline-${randomUUID()}`;

  try {
    await seedUser(userId);

    mockPlan({
      topic: "goals",
      intent: "decline_goal_creation",
      operations: [],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: "Goal creation through chat isn't wired yet — use /create_goal to add \"run a marathon\" as a real goal."
    });
    const reply = await sendAgentMessage(server, userId, "create a goal to run a marathon");

    assert.match(reply.reply, /not wired yet|isn't wired yet/i);
    assert.match(reply.reply, /\/create_goal/);
    assert.equal(reply.debug.mutationExecuted, false);

    const goals = await prisma.goal.count({ where: { userId } });
    assert.equal(goals, 0, "no real goal was created");
    const memories = await prisma.memoryEntry.count({ where: { userId } });
    assert.equal(memories, 0, "no memory was silently created to stand in for the declined goal either");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("5. 'I want to find a developer job' never lets the reply claim a real goal now exists", async () => {
  const server = buildServer();
  const userId = `goal-ambiguous-intent-${randomUUID()}`;

  try {
    await seedUser(userId);

    // The ambiguous-intent path this task sanctions: memory.create(type: "goal_context") is
    // allowed, but only paired with a replyDraft that's explicit this is NOT a tracked goal.
    mockPlan({
      topic: "memory",
      intent: "remember_goal_context",
      operations: [op("memory.create", { summary: "Wants to find a developer job", type: "goal_context" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: "I can remember that, but goal creation through V3 chat is not wired yet. Use /create_goal for now."
    });
    const reply = await sendAgentMessage(server, userId, "I want to find a developer job");

    assert.match(reply.reply, /not wired yet/i);
    assert.match(reply.reply, /\/create_goal/);
    assert.doesNotMatch(reply.reply, /goal (created|added|set|is now tracked)/i, "must never claim a real goal now exists");

    const goals = await prisma.goal.count({ where: { userId } });
    assert.equal(goals, 0, "an ambiguous statement of intent must never silently create a real Goal row");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("6. progress logging still works after adding goal.list: 'I sent 3 CVs today' logs a real event", async () => {
  const server = buildServer();
  const userId = `goal-progress-still-works-${randomUUID()}`;

  try {
    await seedUser(userId);

    mockPlan({ topic: "progress_logging", intent: "log_job_applications", operations: [op("event.log_job_applications", { count: 3 })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "I sent 3 CVs today");

    assert.match(reply.reply, /3 job application/i);
    assert.equal(reply.debug.mutationExecuted, true);

    const events = await prisma.event.count({ where: { userId, type: "career.application_sent" } });
    assert.equal(events, 3);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("7. the goal-aligned guardrail still sees active goals after adding goal.list", async () => {
  const server = buildServer();
  const userId = `goal-guardrail-still-works-${randomUUID()}`;

  try {
    await seedUser(userId);
    const goal = await seedGoal(userId, { title: "Stop smoking", category: "health", priority: "critical" });

    mockGuardrail({ conflict: "hard_block", goalId: goal.id, pattern: "active_violation", clarifyingQuestion: null, reason: "test" });
    const reply = await sendAgentMessage(server, userId, "I'm about to have a cigarette, it's fine just this once");

    assert.match(reply.reply, /conflicts with your goal to stop smoking/i);
    assert.deepEqual(reply.operationsPlanned, [], "the guardrail must still short-circuit before the planner runs");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
