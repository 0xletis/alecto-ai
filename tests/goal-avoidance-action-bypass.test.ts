import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createActionItem, createGoal, prisma } from "../packages/db/src/index.ts";
import {
  buildServer,
  clearAgentRuntimeMocks,
  mockGuardrail,
  mockNow,
  mockPlan,
  op,
  sendAgentMessage,
  seedUser,
  type MockGuardrailClassification
} from "./helpers/agent-runtime-test-helpers.ts";

/**
 * fix/private-alpha-goal-avoidance-action-bypass: a real-LLM eval caught "muévela a mañana a las
 * 20:00" (an ordinary explicit reschedule, carrying a digit so it skips the bare-pronoun
 * deterministic shortcut in runtime.ts by design) reaching the goal-avoidance guardrail's own
 * separate LLM classifier and getting misread as "pulling you away from your goal," blocking it
 * before action.reschedule ever ran — reproducibly, for this exact Spanish phrasing, across
 * repeated real-model runs. English and Catalan equivalents mostly passed the same real-model
 * eval, but only because the classifier's own judgment happened to land correctly more often for
 * them — nothing deterministic protected any of them.
 *
 * Fixed with a new, narrow, deterministic bypass (isExplicitActionMutationGuardrailBypass,
 * runtime.ts) checked immediately before checkGoalGuardrail is ever called: explicit
 * action-mutation vocabulary (move/reschedule/set/change due/complete/archive/remove — English,
 * Spanish, and Catalan forms), with a real resolvable action target, and NO goal-abandonment
 * wording anywhere in the same message, skips the guardrail LLM call entirely. It never resolves
 * an operation itself — the real planner, validator, and execution pipeline runs completely
 * unchanged, so this can never let an LLM mutate state directly, and it never widens what the
 * guardrail blocks for anything that doesn't meet this narrow bar.
 *
 * Every "should bypass" test here deliberately mocks the guardrail's own LLM tier to a HOSTILE
 * hard_block/avoidance classification — if the bypass ever failed to fire, the guardrail would
 * actually be called and this mock would block the message. A passing mutation is direct proof
 * the guardrail call itself was skipped, not just that a lenient classification happened to allow
 * it through.
 */

// goalId MUST be a real active goal's id — checkGoalGuardrail treats an unmatched/null goalId as
// "the classification named an unknown goal" and silently collapses back to allow, regardless of
// `conflict`. A hostile mock only actually blocks when it names a real goal.
function hostileGuardrailMock(goalId: string): MockGuardrailClassification {
  return { conflict: "hard_block", goalId, pattern: "avoidance", clarifyingQuestion: null, reason: "test: guardrail must never be reached for this message" };
}

const FIXED_NOW = new Date("2026-09-01T10:00:00.000Z"); // 12:00 Europe/Madrid (CEST, UTC+2)

async function seedMadridUserWithGoalAndAction(userId: string, actionTitle = "Send 10 CVs") {
  await seedUser(userId);
  await prisma.notificationSettings.create({ data: { userId, timezone: "Europe/Madrid" } });
  const goalResult = await createGoal(userId, { title: "Find a fully remote developer job", category: "career" });
  if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
  const action = await createActionItem(userId, { source: "manual", title: actionTitle, priority: "high" });
  return { goal: goalResult.goal, action };
}

function actionListPlan() {
  return { topic: "actions", intent: "list_actions", operations: [op("action.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" };
}

test("A. 'muévela a mañana a las 20:00' with one visible action bypasses avoidance and reschedules the action", async () => {
  const server = buildServer();
  const userId = `guardrail-bypass-a-${randomUUID()}`;
  try {
    mockNow(FIXED_NOW.toISOString());
    const { action, goal } = await seedMadridUserWithGoalAndAction(userId);

    mockPlan(actionListPlan());
    await sendAgentMessage(server, userId, "muéstrame mis tareas");

    mockGuardrail(hostileGuardrailMock(goal.id));
    mockPlan({ topic: "actions", intent: "reschedule", operations: [op("action.reschedule", { actionId: action.id, dueText: "mañana a las 20:00" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "muévela a mañana a las 20:00");

    assert.notEqual(reply.debug.conversationTopic, "guardrail", "the hostile guardrail mock must never have been reached");
    assert.equal(reply.debug.mutationExecuted, true);
    assert.match(reply.reply, /rescheduled/i);

    const updated = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(updated?.status, "open");
    assert.equal(updated?.dueAt?.toISOString(), "2026-09-02T18:00:00.000Z"); // tomorrow 20:00 Europe/Madrid
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("B. 'mou-la a demà a les 20:00' with one visible action bypasses avoidance and reschedules the action", async () => {
  const server = buildServer();
  const userId = `guardrail-bypass-b-${randomUUID()}`;
  try {
    mockNow(FIXED_NOW.toISOString());
    const { action, goal } = await seedMadridUserWithGoalAndAction(userId);

    mockPlan(actionListPlan());
    await sendAgentMessage(server, userId, "mostra'm les meves tasques");

    mockGuardrail(hostileGuardrailMock(goal.id));
    mockPlan({ topic: "actions", intent: "reschedule", operations: [op("action.reschedule", { actionId: action.id, dueText: "demà a les 20:00" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "mou-la a demà a les 20:00");

    assert.notEqual(reply.debug.conversationTopic, "guardrail", "the hostile guardrail mock must never have been reached");
    assert.equal(reply.debug.mutationExecuted, true);
    assert.match(reply.reply, /rescheduled/i);

    const updated = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(updated?.status, "open");
    assert.equal(updated?.dueAt?.toISOString(), "2026-09-02T18:00:00.000Z"); // tomorrow 20:00 Europe/Madrid
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("C. 'move it to tomorrow 20:00' with one visible action bypasses avoidance and reschedules the action", async () => {
  const server = buildServer();
  const userId = `guardrail-bypass-c-${randomUUID()}`;
  try {
    mockNow(FIXED_NOW.toISOString());
    const { action, goal } = await seedMadridUserWithGoalAndAction(userId);

    mockPlan(actionListPlan());
    await sendAgentMessage(server, userId, "show me my actions");

    mockGuardrail(hostileGuardrailMock(goal.id));
    mockPlan({ topic: "actions", intent: "reschedule", operations: [op("action.reschedule", { actionId: action.id, dueText: "tomorrow at 20:00" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "move it to tomorrow 20:00");

    assert.notEqual(reply.debug.conversationTopic, "guardrail", "the hostile guardrail mock must never have been reached");
    assert.equal(reply.debug.mutationExecuted, true);
    assert.match(reply.reply, /rescheduled/i);

    const updated = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(updated?.status, "open");
    assert.equal(updated?.dueAt?.toISOString(), "2026-09-02T18:00:00.000Z"); // tomorrow 20:00 Europe/Madrid
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("D. 'archive the goal' still goes through the goal-lifecycle/critical-confirmation path, never the action bypass", async () => {
  const server = buildServer();
  const userId = `guardrail-bypass-d-${randomUUID()}`;
  try {
    mockNow(FIXED_NOW.toISOString());
    const { goal } = await seedMadridUserWithGoalAndAction(userId);
    await prisma.goal.update({ where: { id: goal.id }, data: { priority: "critical" } });

    mockGuardrail(hostileGuardrailMock(goal.id));
    const reply = await sendAgentMessage(server, userId, "archive the goal");

    // Never silently archived, and never routed as if it were an action mutation.
    assert.equal(reply.debug.mutationExecuted, false, "archiving a critical goal must never apply without confirmation");
    assert.doesNotMatch(reply.reply, /action rescheduled/i);
    const stillActive = await prisma.goal.findUnique({ where: { id: goal.id } });
    assert.equal(stillActive?.status, "active");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("E. \"I'm giving up on this goal\" still reaches the real avoidance guardrail", async () => {
  const server = buildServer();
  const userId = `guardrail-bypass-e-${randomUUID()}`;
  try {
    mockNow(FIXED_NOW.toISOString());
    const { goal } = await seedMadridUserWithGoalAndAction(userId);

    mockPlan(actionListPlan());
    await sendAgentMessage(server, userId, "show me my actions");

    mockGuardrail(hostileGuardrailMock(goal.id));
    const reply = await sendAgentMessage(server, userId, "I'm giving up on this goal");

    assert.equal(reply.debug.conversationTopic, "guardrail", "genuine goal-abandonment language must still reach the guardrail");
    // mutationExecuted is true here because a real hard_block/soft_warn logs a durable
    // memory.create incident (existing, correct behavior) — the point of this test is that no
    // ACTION tool ran, never that literally nothing was recorded.
    assert.deepEqual(reply.operationsExecuted.map((o: { tool: string }) => o.tool), ["memory.create"], "only the guardrail's own incident log may run, never an action tool");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("F. 'remove the action' routes to the action-archive path, not goal avoidance", async () => {
  const server = buildServer();
  const userId = `guardrail-bypass-f-${randomUUID()}`;
  try {
    mockNow(FIXED_NOW.toISOString());
    const { action, goal } = await seedMadridUserWithGoalAndAction(userId);

    mockPlan(actionListPlan());
    await sendAgentMessage(server, userId, "show me my actions");

    mockGuardrail(hostileGuardrailMock(goal.id));
    mockPlan({ topic: "actions", intent: "archive", operations: [op("action.archive", { actionId: action.id })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "remove the action");

    assert.notEqual(reply.debug.conversationTopic, "guardrail", "the hostile guardrail mock must never have been reached");
    assert.equal(reply.debug.mutationExecuted, true);
    const updated = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(updated?.status, "archived");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("G. 'remove the goal' routes to the goal-lifecycle path, never the action-mutation bypass", async () => {
  const server = buildServer();
  const userId = `guardrail-bypass-g-${randomUUID()}`;
  try {
    mockNow(FIXED_NOW.toISOString());
    const { goal } = await seedMadridUserWithGoalAndAction(userId);

    mockGuardrail(hostileGuardrailMock(goal.id));
    const reply = await sendAgentMessage(server, userId, "remove the goal");

    assert.doesNotMatch(reply.reply, /action rescheduled|action archived/i);
    // Either resolved deterministically via goal-lifecycle (a real pending confirmation) or, if
    // genuinely ambiguous, reached the real guardrail — either way, never treated as an action.
    const archived = await prisma.goal.findUnique({ where: { id: goal.id } });
    if (reply.debug.mutationExecuted) {
      assert.equal(archived?.status, "archived");
    } else {
      assert.equal(archived?.status, "active");
    }
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
