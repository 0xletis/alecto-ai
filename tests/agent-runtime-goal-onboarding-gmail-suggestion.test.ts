import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createGoal, prisma } from "../packages/db/src/index.ts";
import { buildSystemPrompt } from "../apps/api/src/agent-runtime/planner.ts";
import { buildServer, clearAgentRuntimeMocks, mockPlan, op, sendAgentMessage, seedUser } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * audit/v3-goal-onboarding-evals: deterministic (mocked-planner) coverage for the parts of goal
 * onboarding + Gmail-suggestion behavior that don't require real LLM judgment to verify — the
 * EXECUTOR mechanism that renders an integrationHint into the create-proposal preview, a prompt-
 * content regression guard for the tightened Gmail-relevance guidance, and the two real-DB safety
 * boundaries (archived/paused goals never receiving new evidence). Whether the real LLM actually
 * CHOOSES to suggest Gmail for the right goals and not the wrong ones is judgment, not mechanism —
 * that's covered by the real-LLM eval suite (tests/agent-runtime-llm-eval.test.ts), not here.
 */

function goalCreatePlan(input: { title: string; category: string; signals: Array<{ key: string; label: string }>; integrationHint?: string }) {
  return {
    topic: "goal_creation",
    intent: "create_goal",
    operations: [
      op("goal.create_propose", {
        title: input.title,
        category: input.category,
        signals: input.signals,
        ...(input.integrationHint ? { integrationHint: input.integrationHint } : {})
      })
    ],
    needsClarification: false,
    clarificationQuestion: null,
    replyDraft: ""
  };
}

test("A: an integrationHint the planner supplies renders as a conditional Integration line in the proposal", async () => {
  const server = buildServer();
  const userId = `goal-onboarding-gmail-a-${randomUUID()}`;

  try {
    await seedUser(userId);
    mockPlan(
      goalCreatePlan({
        title: "Find a new developer job",
        category: "career",
        signals: [{ key: "applications_sent", label: "applications sent" }],
        integrationHint: "If you connect Gmail, I can watch for recruiter replies and job-related emails."
      })
    );
    const reply = await sendAgentMessage(server, userId, "I want to find a new developer job");

    assert.equal(reply.needsConfirmation, true, "a new-goal proposal must require confirmation before applying");
    assert.match(reply.reply, /Integration:/);
    assert.match(reply.reply, /if you connect gmail/i);
    const goalCount = await prisma.goal.count({ where: { userId } });
    assert.equal(goalCount, 0, "nothing may be created before confirmation");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("B: no integrationHint means no Integration line at all — never a default/fallback Gmail mention", async () => {
  const server = buildServer();
  const userId = `goal-onboarding-gmail-b-${randomUUID()}`;

  try {
    await seedUser(userId);
    mockPlan(
      goalCreatePlan({
        title: "Get stronger",
        category: "health",
        signals: [{ key: "workouts_completed", label: "workouts completed" }]
      })
    );
    const reply = await sendAgentMessage(server, userId, "I want to get stronger");

    assert.equal(reply.needsConfirmation, true);
    assert.doesNotMatch(reply.reply, /Integration:/);
    assert.doesNotMatch(reply.reply, /gmail/i, "a fitness goal must never mention Gmail when the planner didn't propose it");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("C: prompt-content regression — Gmail-relevance guidance stays specific, conditional, and honest", () => {
  // Regression guard for the exact gap this audit found and fixed: the prior guidance required
  // Gmail to be "already-connected" before it could even be mentioned (blocking the desired
  // "if you connect Gmail..." invitation to a not-yet-connected user), gave only one example, and
  // had no explicit negative-domain guardrails. Asserts on the DURABLE properties this guidance
  // must keep, not the exact sentence — a future edit is free to reword it, but not to silently
  // drop the conditional-invitation requirement, the negative examples, or the "never say I'm
  // watching" honesty rule.
  const prompt = buildSystemPrompt();

  assert.doesNotMatch(prompt, /already-connected integration is genuinely relevant/i, "must not require Gmail to already be connected before it can even be suggested");
  assert.match(prompt, /integrationHint rule/i, "must exist as its own standalone, unmissable rule, not buried inside the giant Adaptive Goal Creation paragraph");
  assert.match(prompt, /default is OMIT/i);
  assert.match(prompt, /reading|fitness|screen-time|meditation/i, "must name concrete no-Gmail domains, not just leave relevance to unguided judgment");
  assert.match(prompt, /if you connect gmail/i, "must model the conditional-invitation phrasing for a not-yet-connected user");
  assert.match(prompt, /never say ['‘]i['’]ll monitor['’]/i, "must forbid an active-monitoring promise before any rule/worker path exists");
});

test("D: an archived goal never receives new evidence, even with its own exact signalKey", async () => {
  const server = buildServer();
  const userId = `goal-onboarding-gmail-d-${randomUUID()}`;

  try {
    await seedUser(userId);
    const created = await createGoal(userId, {
      title: "Drink more tea",
      category: "health",
      targetMetrics: [{ key: "tea_cups_drunk", label: "cups of tea drunk", signalKey: "tea_cups_drunk", aggregation: "count", window: "daily" }]
    });
    if (created.duplicate) throw new Error("unexpected duplicate goal in test setup");
    await prisma.goal.update({ where: { id: created.goal.id }, data: { status: "archived" } });

    mockPlan({
      topic: "goals",
      intent: "log_evidence",
      operations: [op("goal.log_evidence", { signalKey: "tea_cups_drunk", count: 2 })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "had 2 teas today");

    assert.equal(reply.debug.mutationExecuted, false, "an archived goal's own signalKey must not be treated as a currently loggable one");
    assert.match(reply.reply, /don't have|no.*signal|not.*set up/i);

    const events = await prisma.event.count({ where: { userId } });
    assert.equal(events, 0, "no event may be logged against an archived goal's signal");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("E: a paused goal never receives new evidence, even with its own exact signalKey", async () => {
  const server = buildServer();
  const userId = `goal-onboarding-gmail-e-${randomUUID()}`;

  try {
    await seedUser(userId);
    const created = await createGoal(userId, {
      title: "Meditate daily",
      category: "wellbeing",
      targetMetrics: [{ key: "meditation_minutes", label: "minutes meditated", signalKey: "meditation_minutes", aggregation: "sum", window: "daily" }]
    });
    if (created.duplicate) throw new Error("unexpected duplicate goal in test setup");
    await prisma.goal.update({ where: { id: created.goal.id }, data: { status: "paused" } });

    mockPlan({
      topic: "goals",
      intent: "log_evidence",
      operations: [op("goal.log_evidence", { signalKey: "meditation_minutes", count: 10 })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "meditated 10 minutes");

    assert.equal(reply.debug.mutationExecuted, false, "a paused goal's own signalKey must not be treated as a currently loggable one");

    const events = await prisma.event.count({ where: { userId } });
    assert.equal(events, 0, "no event may be logged against a paused goal's signal");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("F: a custom goal category and a fully invented signal key work with zero schema change", async () => {
  const server = buildServer();
  const userId = `goal-onboarding-gmail-f-${randomUUID()}`;

  try {
    await seedUser(userId);
    mockPlan(
      goalCreatePlan({
        title: "Call my grandmother every Sunday",
        category: "family",
        signals: [{ key: "grandmother_calls", label: "calls to grandmother" }]
      })
    );
    const proposeReply = await sendAgentMessage(server, userId, "I want to call my grandmother every Sunday");
    assert.equal(proposeReply.needsConfirmation, true);
    assert.doesNotMatch(proposeReply.reply, /Integration:/, "a purely personal/family goal must never get a Gmail suggestion by default");

    mockPlan({
      topic: "goal_creation",
      intent: "confirm",
      operations: [op("confirmation.confirm", {})],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    await sendAgentMessage(server, userId, "yes");

    const goal = await prisma.goal.findFirst({ where: { userId, title: { contains: "grandmother", mode: "insensitive" } } });
    assert.ok(goal, "a custom, non-templated category/signal must create a real goal with no schema migration needed");
    const metrics = (goal!.targetMetrics as Array<{ signalKey?: string }> | null) ?? [];
    assert.ok(metrics.some((metric) => metric.signalKey === "grandmother_calls"));
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
