import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { buildServer, clearAgentRuntimeMocks, mockPlan, op, prisma, sendAgentMessage, seedUser, type MockPlan } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * Degraded-mode UX when the real LLM planner is unavailable (network error, missing/invalid
 * OPENAI_API_KEY, timeout — apps/api/src/agent-runtime/planner.ts's heuristicPlan, reached only
 * from planMessage's own catch block). A real Telegram smoke test — surfaced by the optional
 * `pnpm test:llm` suite's own transient-failure runs — found this leaking internal, dev-facing
 * wording straight into the user's chat: "...without my language model available." Honest that
 * something didn't work is fine; naming the internal mechanism (planner/LLM/fallback/heuristic) is
 * not, and neither is pretending the message was understood. Fixed generically: a small message-
 * shape check (Gmail-flavored vs goal-progress-flavored vs generic — never a specific goal/tool
 * name) picks a clean, user-friendly reply with a concrete example next step, always with
 * needsClarification left true and zero operations, so nothing is silently guessed either.
 *
 * AGENT_RUNTIME_PLANNER_MOCK_THROW=true (already a test-only hook the planner itself checks — see
 * planWithLLM) deterministically reproduces "the real LLM call failed" without any network
 * dependency, exactly the condition heuristicPlan exists for.
 */

const BANNED_FALLBACK_PHRASES = ["language model available", "fallback planner", "heuristic planner", "openai failed", "openai"];

function assertNoDevWording(reply: string, context: string): void {
  const lower = reply.toLowerCase();
  for (const phrase of BANNED_FALLBACK_PHRASES) {
    assert.ok(!lower.includes(phrase), `${context}: reply must not contain internal wording "${phrase}" — got: ${reply}`);
  }
}

test("1. a Gmail-shaped message during an LLM outage gets a clean degraded reply, never dev wording", async () => {
  const server = buildServer();
  const userId = `fallback-gmail-${randomUUID()}`;

  try {
    await seedUser(userId);
    process.env.AGENT_RUNTIME_PLANNER_MOCK_THROW = "true";

    const reply = await sendAgentMessage(server, userId, "what emails need attention?");

    assertNoDevWording(reply.reply, "Gmail-shaped fallback");
    assert.match(reply.reply, /email/i, "should offer a Gmail-shaped example next step, not a bare generic message");
    assert.equal(reply.debug.plannerUsed, "fallback");
    assert.equal(reply.debug.mutationExecuted, false);
    assert.deepEqual(reply.operationsExecuted, []);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2. a goal-progress-shaped message during an LLM outage gets a clean degraded reply, never dev wording", async () => {
  const server = buildServer();
  const userId = `fallback-progress-${randomUUID()}`;

  try {
    await seedUser(userId);
    process.env.AGENT_RUNTIME_PLANNER_MOCK_THROW = "true";

    const reply = await sendAgentMessage(server, userId, "read 30 minutes for Nietzsche");

    assertNoDevWording(reply.reply, "progress-shaped fallback");
    assert.match(reply.reply, /read 30 minutes for nietzsche|sent 5 cvs/i, "should offer a progress-phrasing example next step");
    assert.equal(reply.debug.plannerUsed, "fallback");
    assert.equal(reply.debug.mutationExecuted, false);
    assert.deepEqual(reply.operationsExecuted, []);

    const events = await prisma.event.count({ where: { userId } });
    assert.equal(events, 0, "a degraded reply must never fabricate logged progress");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3. a generic, unscripted message during an LLM outage gets a clean generic degraded reply, never dev wording", async () => {
  const server = buildServer();
  const userId = `fallback-generic-${randomUUID()}`;

  try {
    await seedUser(userId);
    process.env.AGENT_RUNTIME_PLANNER_MOCK_THROW = "true";

    const reply = await sendAgentMessage(server, userId, "asdkjfh qwoeiru totally unscripted nonsense");

    assertNoDevWording(reply.reply, "generic fallback");
    assert.match(reply.reply, /having trouble reasoning|logging progress|showing goals|listing actions/i);
    assert.equal(reply.debug.plannerUsed, "fallback");
    assert.equal(reply.debug.llmPlannerAttempted, true, "the real planner must genuinely have been tried, not skipped");
    assert.equal(reply.debug.llmPlannerUsed, false);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4. an LLM outage never executes any mutation, no matter how the message is phrased", async () => {
  const server = buildServer();
  const userId = `fallback-no-mutation-${randomUUID()}`;

  try {
    await seedUser(userId);
    process.env.AGENT_RUNTIME_PLANNER_MOCK_THROW = "true";

    const messages = ["mark task 3 complete", "sent 5 CVs today", "turn the recruiter one into a task", "I want to drink more tea"];
    for (const message of messages) {
      const reply = await sendAgentMessage(server, userId, message);
      assert.equal(reply.debug.mutationExecuted, false, `"${message}" must never mutate during an LLM outage`);
      assert.deepEqual(reply.operationsExecuted, [], `"${message}" must never execute any operation during an LLM outage`);
    }

    const goals = await prisma.goal.count({ where: { userId } });
    const actions = await prisma.actionItem.count({ where: { userId } });
    const events = await prisma.event.count({ where: { userId } });
    assert.equal(goals, 0);
    assert.equal(actions, 0);
    assert.equal(events, 0);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("5. exact 'yes' still confirms a pending operation deterministically during an LLM outage — the planner is never even attempted", async () => {
  const server = buildServer();
  const userId = `fallback-confirm-${randomUUID()}`;

  try {
    await seedUser(userId);

    const teaPlan: MockPlan["operations"] = [
      op("goal.create_propose", {
        title: "Drink more tea",
        category: "health",
        signals: [{ key: "tea_cups_drunk", label: "cups of tea drunk", cadence: "daily" }],
        firstActions: []
      })
    ];
    mockPlan({ topic: "goals", intent: "propose_goal_creation", operations: teaPlan, needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const proposeReply = await sendAgentMessage(server, userId, "I want to drink more tea");
    assert.equal(proposeReply.debug.pendingOperation, true, "a pending confirmation must be open before simulating the outage");

    // Now the LLM is "down" for the confirming turn — exact "yes" must still work.
    process.env.AGENT_RUNTIME_PLANNER_MOCK_THROW = "true";
    const confirmReply = await sendAgentMessage(server, userId, "yes");

    assertNoDevWording(confirmReply.reply, "confirm during outage");
    assert.equal(confirmReply.debug.llmPlannerAttempted, false, "exact confirm/cancel bypasses the planner entirely, outage or not");
    assert.equal(confirmReply.debug.mutationExecuted, true, "the real, already-validated pending operation must still apply");
    assert.match(confirmReply.reply, /done.*drink more tea/i);

    const goal = await prisma.goal.findFirst({ where: { userId, title: "Drink more tea" } });
    assert.ok(goal, "the goal must have been created via the deterministic confirm path, independent of planner availability");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("6. exact 'cancel' still cancels a pending operation deterministically during an LLM outage", async () => {
  const server = buildServer();
  const userId = `fallback-cancel-${randomUUID()}`;

  try {
    await seedUser(userId);

    const teaPlan: MockPlan["operations"] = [
      op("goal.create_propose", {
        title: "Drink more tea",
        category: "health",
        signals: [{ key: "tea_cups_drunk", label: "cups of tea drunk", cadence: "daily" }],
        firstActions: []
      })
    ];
    mockPlan({ topic: "goals", intent: "propose_goal_creation", operations: teaPlan, needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "I want to drink more tea");

    process.env.AGENT_RUNTIME_PLANNER_MOCK_THROW = "true";
    const cancelReply = await sendAgentMessage(server, userId, "cancel");

    assertNoDevWording(cancelReply.reply, "cancel during outage");
    assert.equal(cancelReply.debug.llmPlannerAttempted, false);
    assert.equal(cancelReply.debug.pendingOperation, false);

    const goals = await prisma.goal.count({ where: { userId } });
    assert.equal(goals, 0, "cancelling must never create the goal, outage or not");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
