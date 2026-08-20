import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createGoal } from "../packages/db/src/index.ts";
import {
  buildServer,
  clearAgentRuntimeMocks,
  getAgentSession,
  mockGuardrail,
  mockPlan,
  prisma,
  sendAgentMessage,
  seedUser,
  type MockGuardrailClassification
} from "./helpers/agent-runtime-test-helpers.ts";

/**
 * Agent Runtime v3's generic goal/guardrail conflict check
 * (apps/api/src/agent-runtime/goal-guardrails.ts) — the product-aligned replacement for both
 * the old validator.ts checkPolicyGuardrail (data-driven off knownTriggers/knownFailureModes
 * only) and legacy's hardcoded gambling/trading betting_intent classifier, which was
 * deliberately NOT ported. There is no gambling/finance-specific code anywhere in the module
 * under test: every scenario below uses a plain, user-authored Goal row (or a plain configured
 * trigger phrase), and the SAME classification/reply code path handles all of them —
 * "Stop gambling," "Improve financial discipline," "Find a new developer job," and
 * "Train 3 times per week" are structurally identical inputs to this system.
 *
 * The LLM semantic-classification tier (Tier 2) is mocked via AGENT_RUNTIME_GUARDRAIL_MOCK_RESPONSE
 * (mockGuardrail helper), mirroring the existing planner mock pattern, so none of this depends on
 * OPENAI_API_KEY. Tier 1 (literal knownTriggers/knownFailureModes matching) is deterministic and
 * needs no mock at all.
 */

async function seedGoal(userId: string, title: string, category: string) {
  const result = await createGoal(userId, { title, category, priority: "high" });
  if (result.duplicate) throw new Error("unexpected duplicate goal in test setup");
  return result.goal;
}

function classification(overrides: Partial<MockGuardrailClassification> & Pick<MockGuardrailClassification, "conflict">): MockGuardrailClassification {
  return { goalId: null, pattern: null, clarifyingQuestion: null, reason: "test", ...overrides };
}

test("A. a message that violates a plain 'Stop gambling' goal is hard-blocked before the planner runs", async () => {
  const server = buildServer();
  const userId = `guardrail-a-${randomUUID()}`;

  try {
    await seedUser(userId);
    const goal = await seedGoal(userId, "Stop gambling", "wellbeing");

    mockGuardrail(classification({ conflict: "hard_block", goalId: goal.id, pattern: "active_violation" }));
    const reply = await sendAgentMessage(server, userId, "I want to bet 1000 because it's safe");

    assert.match(reply.reply, /conflicts with your goal to stop gambling/i);
    assert.deepEqual(reply.operationsPlanned, [], "the tool planner must never be reached once the guardrail hard-blocks");
    assert.deepEqual(reply.operationsExecuted.map((op) => op.tool), ["memory.create"], "only the deterministic risk-incident log runs, nothing LLM-planned");

    const risk = await prisma.memoryEntry.findMany({ where: { userId, type: "risk_pattern" } });
    assert.equal(risk.length, 1, "the conflict is logged once via the existing risk_pattern memory mechanism, not a new DB write");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("B. financial discipline is just another user goal, not hardcoded finance logic", async () => {
  const server = buildServer();
  const userId = `guardrail-b-${randomUUID()}`;

  try {
    await seedUser(userId);
    const goal = await seedGoal(userId, "Improve financial discipline", "finance");

    mockGuardrail(classification({ conflict: "hard_block", goalId: goal.id, pattern: "active_violation" }));
    const reply = await sendAgentMessage(server, userId, "I'm about to buy something expensive impulsively");

    assert.match(reply.reply, /conflicts with your goal to improve financial discipline/i);
    assert.deepEqual(reply.operationsPlanned, []);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("C. avoiding a job-search goal for something else gets an intervention tied to that goal", async () => {
  const server = buildServer();
  const userId = `guardrail-c-${randomUUID()}`;

  try {
    await seedUser(userId);
    const goal = await seedGoal(userId, "Find a new developer job", "career");

    mockGuardrail(classification({ conflict: "soft_warn", goalId: goal.id, pattern: "avoidance" }));
    const reply = await sendAgentMessage(server, userId, "I'm going to browse car listings all afternoon instead of applying");

    assert.match(reply.reply, /find a new developer job/i);
    assert.deepEqual(reply.operationsPlanned, []);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("D. admitting a lapse against a training goal gets supportive accountability, not a hard block", async () => {
  const server = buildServer();
  const userId = `guardrail-d-${randomUUID()}`;

  try {
    await seedUser(userId);
    const goal = await seedGoal(userId, "Train 3 times per week", "health");

    mockGuardrail(classification({ conflict: "soft_warn", goalId: goal.id, pattern: "lapse_admission" }));
    const reply = await sendAgentMessage(server, userId, "I skipped gym again");

    assert.match(reply.reply, /train 3 times per week/i);
    assert.doesNotMatch(reply.reply, /^no\.\s/i, "a self-reported lapse is not the same severity as an active violation — must not use the hard-block phrasing");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("E. with no relevant goal or trigger, an ordinary question is never hard-blocked", async () => {
  const server = buildServer();
  const userId = `guardrail-e-${randomUUID()}`;

  try {
    await seedUser(userId);
    // No goals seeded at all, no knownTriggers configured — checkGoalGuardrail short-circuits
    // to allow WITHOUT attempting the LLM tier (nothing to classify against), so no
    // mockGuardrail is needed or used here.
    mockPlan({ topic: "general", intent: "answer_question", operations: [], needsClarification: false, clarificationQuestion: null, replyDraft: "A recruiter reply usually means your resume passed the first screen." });
    const reply = await sendAgentMessage(server, userId, "what does a recruiter reply usually mean?");

    assert.equal(reply.reply, "A recruiter reply usually means your resume passed the first screen.");
    assert.equal(reply.debug.llmPlannerAttempted, true, "must reach the normal tool planner, proving the guardrail did not intercept");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("F. a configured knownTrigger still intervenes even with no formal goal", async () => {
  const server = buildServer();
  const userId = `guardrail-f-${randomUUID()}`;

  try {
    await seedUser(userId);
    await prisma.userOperatingProfile.create({ data: { userId, knownTriggers: ["late night online shopping"] } });

    // No mockGuardrail: a literal trigger match is Tier 1, purely deterministic, no LLM call.
    const reply = await sendAgentMessage(server, userId, "I'm browsing late night online shopping again, it always relaxes me");

    assert.equal(reply.debug.llmPlannerAttempted, false);
    assert.deepEqual(reply.operationsPlanned, []);
    assert.match(reply.reply, /careful about|slow down/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("G. asking for help controlling an urge related to a goal is supportive, not treated as the violation", async () => {
  const server = buildServer();
  const userId = `guardrail-g-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedGoal(userId, "Stop smoking", "health");

    mockGuardrail(classification({ conflict: "none" }));
    mockPlan({ topic: "general", intent: "support", operations: [], needsClarification: false, clarificationQuestion: null, replyDraft: "Good — what's making the urge strong right now?" });
    const reply = await sendAgentMessage(server, userId, "I want to control my urge to smoke");

    assert.equal(reply.reply, "Good — what's making the urge strong right now?");
    assert.doesNotMatch(reply.reply, /conflicts with your goal/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("a hard_block never opens a pending confirmation", async () => {
  const server = buildServer();
  const userId = `guardrail-session-${randomUUID()}`;

  try {
    await seedUser(userId);
    const goal = await seedGoal(userId, "Stop smoking", "health");

    mockGuardrail(classification({ conflict: "hard_block", goalId: goal.id, pattern: "active_violation" }));
    const reply = await sendAgentMessage(server, userId, "I'm about to have a cigarette, it's fine just this once");

    assert.equal(reply.needsConfirmation, false, "a hard block is not itself a pending confirmation");
    const row = await getAgentSession(userId);
    assert.equal(row?.pendingOperation, null);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("an ask_clarification classification asks a short goal-grounded question and mutates nothing", async () => {
  const server = buildServer();
  const userId = `guardrail-clarify-${randomUUID()}`;

  try {
    await seedUser(userId);
    const goal = await seedGoal(userId, "Avoid impulsive spending", "finance");

    mockGuardrail(
      classification({
        conflict: "ask_clarification",
        goalId: goal.id,
        clarifyingQuestion: "Are you about to actually buy this, or just asking about the price?"
      })
    );
    const reply = await sendAgentMessage(server, userId, "what happens if I buy this right now?");

    assert.equal(reply.reply, "Are you about to actually buy this, or just asking about the price?");
    assert.equal(reply.debug.mutationExecuted, false, "nothing is confirmed yet, so nothing is logged");
    assert.deepEqual(reply.operationsPlanned, []);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("an invented/mismatched goalId from the classifier is never trusted — falls back to allow", async () => {
  const server = buildServer();
  const userId = `guardrail-invented-goal-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedGoal(userId, "Sleep before midnight", "health");

    mockGuardrail(classification({ conflict: "hard_block", goalId: randomUUID(), pattern: "active_violation" }));
    mockPlan({ topic: "general", intent: "answer", operations: [], needsClarification: false, clarificationQuestion: null, replyDraft: "Sure, here's some info." });
    const reply = await sendAgentMessage(server, userId, "tell me about sleep cycles");

    assert.equal(reply.reply, "Sure, here's some info.", "a goalId the model wasn't actually given must never be trusted into a block");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("H. a user with no betting/trading goal or trigger at all is never hard-blocked for mentioning betting — there is no built-in domain block", async () => {
  const server = buildServer();
  const userId = `guardrail-h-no-betting-goal-${randomUUID()}`;

  try {
    await seedUser(userId);
    // No goals, no knownTriggers/knownFailureModes — checkGoalGuardrail has nothing to classify
    // against, so it short-circuits to allow without even attempting the LLM tier. Proves the
    // product has no hardcoded "betting = block" behavior: the same literal message that is
    // hard-blocked in test A (once the user has a "Stop gambling" goal) is normal chat here.
    mockPlan({ topic: "general", intent: "log_intent", operations: [], needsClarification: false, clarificationQuestion: null, replyDraft: "Got it, let me know how it goes." });
    const reply = await sendAgentMessage(server, userId, "I want to bet 1000 because it's safe");

    assert.equal(reply.debug.llmPlannerAttempted, true, "must reach the normal tool planner — nothing hardcoded intercepts a betting-related message by itself");
    assert.doesNotMatch(reply.reply, /conflicts with your goal/i);

    const risk = await prisma.memoryEntry.count({ where: { userId, type: "risk_pattern" } });
    assert.equal(risk, 0, "nothing is logged as a risk incident when there is no goal/trigger to conflict with");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("I. avoiding an 'Apply to 3 jobs/day' goal for something else gets a goal-aligned intervention", async () => {
  const server = buildServer();
  const userId = `guardrail-i-jobs-avoidance-${randomUUID()}`;

  try {
    await seedUser(userId);
    const goal = await seedGoal(userId, "Apply to 3 jobs/day", "career");

    mockGuardrail(classification({ conflict: "soft_warn", goalId: goal.id, pattern: "avoidance" }));
    const reply = await sendAgentMessage(server, userId, "I'm going to watch videos all afternoon instead of applying to jobs");

    assert.match(reply.reply, /apply to 3 jobs\/day/i);
    assert.deepEqual(reply.operationsPlanned, [], "the tool planner must never be reached once the guardrail intervenes");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
