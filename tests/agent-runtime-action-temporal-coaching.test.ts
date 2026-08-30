import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createActionItem, createGoal, prisma, snoozeActionItem } from "../packages/db/src/index.ts";
import {
  buildServer,
  clearAgentRuntimeMocks,
  mockGuardrail,
  mockPlan,
  op,
  sendAgentMessage,
  seedUser,
  type MockGuardrailClassification
} from "./helpers/agent-runtime-test-helpers.ts";

/**
 * Deterministic coverage for feat/private-alpha-action-temporal-coaching — a real Telegram
 * transcript found "snooze it for later this week" hit the goal-avoidance guardrail, a moved
 * action vanished from "what should I do next?"'s own duplicate-check, "do i have actions for
 * tomorrow?" silently ran the default OPEN-only list (missing a snoozed action entirely), and
 * "ok do it" right after a real mutation got "I don't have anything pending to confirm." All four
 * traced back to the same root cause: a snoozed action (status "snoozed") was invisible to nearly
 * everything — context.openActions, action.list's default status, and the goal-avoidance
 * guardrail's own blind spot. This file covers the deterministic mechanism; natural-phrase
 * recognition quality and the free-form deferral-coaching follow-up (task 7 D/E) are inherently
 * planner-judgment questions, covered separately by the gated real-LLM eval suite.
 */

function guardrailClassification(overrides: Partial<MockGuardrailClassification> & Pick<MockGuardrailClassification, "conflict">): MockGuardrailClassification {
  return { goalId: null, pattern: null, clarifyingQuestion: null, reason: "test", ...overrides };
}

function actionListPlan() {
  return { topic: "actions", intent: "list_actions", operations: [op("action.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" };
}

// --- Task 2: temporal action semantics -----------------------------------------------------------

test("2A: 'show me my actions' defaults to active/open now, excluding a snoozed one", async () => {
  const server = buildServer();
  const userId = `temporal-2a-${randomUUID()}`;
  try {
    await seedUser(userId);
    await createActionItem(userId, { source: "manual", title: "Renew passport" });
    const deferred = await createActionItem(userId, { source: "manual", title: "Book flights" });
    await snoozeActionItem(userId, deferred.id, new Date(Date.now() + 24 * 60 * 60 * 1000));

    mockPlan(actionListPlan());
    const reply = await sendAgentMessage(server, userId, "show me my actions");

    assert.match(reply.reply, /you have 1 open action:/i);
    assert.match(reply.reply, /renew passport/i);
    assert.doesNotMatch(reply.reply, /book flights/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2B: 'actions for tomorrow' shows a deferred action, with a date/time label", async () => {
  const server = buildServer();
  const userId = `temporal-2b-${randomUUID()}`;
  try {
    await seedUser(userId);
    const action = await createActionItem(userId, { source: "manual", title: "Apply to remote roles" });
    await snoozeActionItem(userId, action.id, new Date(Date.now() + 24 * 60 * 60 * 1000));

    mockPlan({ topic: "actions", intent: "list_actions", operations: [op("action.list", { when: "tomorrow" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "do i have actions for tomorrow?");

    assert.match(reply.reply, /you have 1 action for tomorrow:/i);
    assert.match(reply.reply, /apply to remote roles/i);
    assert.match(reply.reply, /tomorrow/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2C: 'actions for tomorrow' does not show a plain today-open action", async () => {
  const server = buildServer();
  const userId = `temporal-2c-${randomUUID()}`;
  try {
    await seedUser(userId);
    await createActionItem(userId, { source: "manual", title: "Renew passport" });

    mockPlan({ topic: "actions", intent: "list_actions", operations: [op("action.list", { when: "tomorrow" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "any actions tomorrow?");

    assert.match(reply.reply, /you don't have any actions scheduled for tomorrow/i);
    assert.doesNotMatch(reply.reply, /renew passport/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2D: 'all actions' labels deferred (with date), completed, and archived items", async () => {
  const server = buildServer();
  const userId = `temporal-2d-${randomUUID()}`;
  try {
    await seedUser(userId);
    const open = await createActionItem(userId, { source: "manual", title: "Renew passport" });
    const deferred = await createActionItem(userId, { source: "manual", title: "Book flights" });
    await snoozeActionItem(userId, deferred.id, new Date(Date.now() + 24 * 60 * 60 * 1000));
    const done = await createActionItem(userId, { source: "manual", title: "Send invoice" });
    await prisma.actionItem.update({ where: { id: done.id }, data: { status: "completed", completedAt: new Date() } });
    const dropped = await createActionItem(userId, { source: "manual", title: "Old idea" });
    await prisma.actionItem.update({ where: { id: dropped.id }, data: { status: "archived" } });
    void open;

    // fix/private-alpha-live-action-and-coaching-regressions: a bare "show me all my actions" now
    // deterministically means status "active" (open + deferred, never archived/completed) — the
    // message must explicitly ask for completed/archived items too for the validator to allow
    // status "all" through.
    mockPlan({ topic: "actions", intent: "list_all", operations: [op("action.list", { status: "all" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "show me all my actions, including completed and archived ones");

    // fix/private-alpha-temporal-action-copy-and-dedup: "snoozed" must never leak into
    // user-facing copy — a deferred item's line now says "moved to <date>" instead of
    // "due <date> — snoozed".
    assert.match(reply.reply, /book flights[^\n]*moved to tomorrow/i);
    assert.doesNotMatch(reply.reply, /snoozed/i);
    assert.match(reply.reply, /send invoice[^\n]*completed/i);
    assert.match(reply.reply, /old idea[^\n]*archived/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2E: mutation-reply and footer copy say 'move'/'bring back', never 'snoozed'", async () => {
  const server = buildServer();
  const userId = `temporal-2e-${randomUUID()}`;
  try {
    const action = await createActionItem(userId, { source: "manual", title: "Renew passport" });
    await seedUser(userId);

    mockPlan(actionListPlan());
    const listReply = await sendAgentMessage(server, userId, "show me my actions");
    assert.doesNotMatch(listReply.reply, /\bsnooze\b/i);

    mockPlan({ topic: "actions", intent: "snooze", operations: [op("action.snooze", { actionId: action.id, untilText: "tomorrow" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const snoozeReply = await sendAgentMessage(server, userId, "move it to tomorrow");
    assert.doesNotMatch(snoozeReply.reply, /\bsnoozed\b/i);
    assert.match(snoozeReply.reply, /bring "renew passport" back tomorrow/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 3: ambiguous deferral phrases ------------------------------------------------------

test("3A: 'snooze it for later this week' with one visible action asks which day, no mutation", async () => {
  const server = buildServer();
  const userId = `temporal-3a-${randomUUID()}`;
  try {
    await seedUser(userId);
    const action = await createActionItem(userId, { source: "manual", title: "Apply to remote roles" });

    mockPlan(actionListPlan());
    await sendAgentMessage(server, userId, "show me my actions");

    const reply = await sendAgentMessage(server, userId, "snooze it for later this week");

    assert.match(reply.reply, /which day (later this week|would you like)/i);
    assert.equal(reply.debug.mutationExecuted, false);
    const item = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(item?.status, "open");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3B: 'move it to tomorrow' (bare, single visible action) applies directly, no clarification", async () => {
  const server = buildServer();
  const userId = `temporal-3b-${randomUUID()}`;
  try {
    await seedUser(userId);
    const action = await createActionItem(userId, { source: "manual", title: "Apply to remote roles" });

    mockPlan(actionListPlan());
    await sendAgentMessage(server, userId, "show me my actions");

    mockPlan({ topic: "actions", intent: "snooze", operations: [op("action.snooze", { untilText: "tomorrow" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "move it to tomorrow");

    assert.equal(reply.debug.mutationExecuted, true);
    const item = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(item?.status, "snoozed");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3C: 'snooze it for later this week' never hits goal-avoidance, even with an active goal", async () => {
  const server = buildServer();
  const userId = `temporal-3c-${randomUUID()}`;
  try {
    await seedUser(userId);
    await createGoal(userId, { title: "Find a fully remote Web3 developer job", category: "career", priority: "medium" });
    await createActionItem(userId, { source: "manual", title: "Apply to remote roles" });

    mockPlan(actionListPlan());
    await sendAgentMessage(server, userId, "show me my actions");

    // If this ever DID reach the guardrail, a mocked hard_block/soft_warn would make the
    // assertion below fail loudly instead of silently passing for the wrong reason.
    mockGuardrail(guardrailClassification({ conflict: "soft_warn", pattern: "avoidance" }));
    const reply = await sendAgentMessage(server, userId, "snooze it for later this week");

    assert.notEqual(reply.debug.conversationTopic, "guardrail");
    assert.match(reply.reply, /which day (later this week|would you like)/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3D: Spanish and Catalan 'later this week' deferral phrases also ask which day", async () => {
  const server = buildServer();
  const userIdEs = `temporal-3d-es-${randomUUID()}`;
  const userIdCa = `temporal-3d-ca-${randomUUID()}`;
  try {
    await seedUser(userIdEs);
    await createActionItem(userIdEs, { source: "manual", title: "Renovar el pasaporte" });
    mockPlan(actionListPlan());
    await sendAgentMessage(server, userIdEs, "muéstrame mis tareas");
    const replyEs = await sendAgentMessage(server, userIdEs, "muévelo a más adelante esta semana");
    assert.match(replyEs.reply, /which day (later this week|would you like)/i);

    await seedUser(userIdCa);
    await createActionItem(userIdCa, { source: "manual", title: "Renovar el passaport" });
    mockPlan(actionListPlan());
    await sendAgentMessage(server, userIdCa, "mostra'm les meves tasques");
    const replyCa = await sendAgentMessage(server, userIdCa, "recorda-m'ho més endavant aquesta setmana");
    assert.match(replyCa.reply, /which day (later this week|would you like)/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: { in: [userIdEs, userIdCa] } } });
  }
});

// --- Task 4: post-mutation acknowledgement ---------------------------------------------------

test("4A: 'ok do it' right after moving an action to tomorrow says already done, no re-mutation", async () => {
  const server = buildServer();
  const userId = `temporal-4a-${randomUUID()}`;
  try {
    await seedUser(userId);
    const action = await createActionItem(userId, { source: "manual", title: "Apply to remote roles" });

    mockPlan(actionListPlan());
    await sendAgentMessage(server, userId, "show me my actions");
    mockPlan({ topic: "actions", intent: "snooze", operations: [op("action.snooze", { untilText: "tomorrow" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "move it to tomorrow");

    const reply = await sendAgentMessage(server, userId, "ok do it");

    assert.match(reply.reply, /already done/i);
    assert.doesNotMatch(reply.reply, /don't have anything pending/i);
    assert.equal(reply.debug.mutationExecuted, false);
    const item = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(item?.status, "snoozed", "must not have been mutated a second time");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4B: 'ok do it' right after completing an action says already done", async () => {
  const server = buildServer();
  const userId = `temporal-4b-${randomUUID()}`;
  try {
    await seedUser(userId);
    const action = await createActionItem(userId, { source: "manual", title: "Renew passport" });

    mockPlan(actionListPlan());
    await sendAgentMessage(server, userId, "show me my actions");
    mockPlan({ topic: "actions", intent: "complete", operations: [op("action.complete", { actionId: action.id })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "complete it");

    const reply = await sendAgentMessage(server, userId, "ok do it");

    assert.match(reply.reply, /already done/i);
    assert.doesNotMatch(reply.reply, /don't have anything pending/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4C: 'ok do it' with no recent mutation gets the honest 'nothing pending' reply, no mutation", async () => {
  const server = buildServer();
  const userId = `temporal-4c-${randomUUID()}`;
  try {
    await seedUser(userId);
    const reply = await sendAgentMessage(server, userId, "ok do it");

    assert.match(reply.reply, /don't have anything pending/i);
    assert.equal(reply.debug.mutationExecuted, false);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4D: 'ok do it' after an unrelated read-only turn (not the immediately preceding mutation) does not say already done", async () => {
  const server = buildServer();
  const userId = `temporal-4d-${randomUUID()}`;
  try {
    await seedUser(userId);
    const action = await createActionItem(userId, { source: "manual", title: "Renew passport" });

    mockPlan(actionListPlan());
    await sendAgentMessage(server, userId, "show me my actions");
    mockPlan({ topic: "actions", intent: "complete", operations: [op("action.complete", { actionId: action.id })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "complete it");

    // An unrelated read-only turn happens in between — the mutation is no longer "the
    // immediately preceding turn."
    mockPlan(actionListPlan());
    await sendAgentMessage(server, userId, "show me my actions");

    const reply = await sendAgentMessage(server, userId, "ok do it");
    assert.match(reply.reply, /don't have anything pending/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 5: date-scoped action queries -------------------------------------------------------

test("5A: a moved action appears in the tomorrow query", async () => {
  const server = buildServer();
  const userId = `temporal-5a-${randomUUID()}`;
  try {
    await seedUser(userId);
    const action = await createActionItem(userId, { source: "manual", title: "Apply to remote roles" });
    await snoozeActionItem(userId, action.id, new Date(Date.now() + 24 * 60 * 60 * 1000));

    mockPlan({ topic: "actions", intent: "list_actions", operations: [op("action.list", { when: "tomorrow" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "what actions do i have tomorrow?");

    assert.match(reply.reply, /apply to remote roles/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("5B: a today-open action does not appear in the tomorrow query", async () => {
  const server = buildServer();
  const userId = `temporal-5b-${randomUUID()}`;
  try {
    await seedUser(userId);
    await createActionItem(userId, { source: "manual", title: "Renew passport" });

    mockPlan({ topic: "actions", intent: "list_actions", operations: [op("action.list", { when: "tomorrow" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "show tomorrow's actions");

    assert.doesNotMatch(reply.reply, /renew passport/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("5C: 'actions today' shows the plain open action", async () => {
  const server = buildServer();
  const userId = `temporal-5c-${randomUUID()}`;
  try {
    await seedUser(userId);
    await createActionItem(userId, { source: "manual", title: "Renew passport" });

    mockPlan({ topic: "actions", intent: "list_actions", operations: [op("action.list", { when: "today" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "actions today");

    assert.match(reply.reply, /renew passport/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("5D: no actions scheduled for tomorrow gives a clean empty message", async () => {
  const server = buildServer();
  const userId = `temporal-5d-${randomUUID()}`;
  try {
    await seedUser(userId);

    mockPlan({ topic: "actions", intent: "list_actions", operations: [op("action.list", { when: "tomorrow" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "any actions tomorrow?");

    assert.equal(reply.reply, "You don't have any actions scheduled for tomorrow.");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("5E: Spanish and Catalan date-scoped queries work", async () => {
  const server = buildServer();
  const userIdEs = `temporal-5e-es-${randomUUID()}`;
  const userIdCa = `temporal-5e-ca-${randomUUID()}`;
  try {
    await seedUser(userIdEs);
    const actionEs = await createActionItem(userIdEs, { source: "manual", title: "Renovar el pasaporte" });
    await snoozeActionItem(userIdEs, actionEs.id, new Date(Date.now() + 24 * 60 * 60 * 1000));
    mockPlan({ topic: "actions", intent: "list_actions", operations: [op("action.list", { when: "tomorrow" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const replyEs = await sendAgentMessage(server, userIdEs, "tengo acciones para mañana?");
    assert.match(replyEs.reply, /renovar el pasaporte/i);

    await seedUser(userIdCa);
    const actionCa = await createActionItem(userIdCa, { source: "manual", title: "Renovar el passaport" });
    await snoozeActionItem(userIdCa, actionCa.id, new Date(Date.now() + 24 * 60 * 60 * 1000));
    mockPlan({ topic: "actions", intent: "list_actions", operations: [op("action.list", { when: "tomorrow" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const replyCa = await sendAgentMessage(server, userIdCa, "tinc accions per demà?");
    assert.match(replyCa.reply, /renovar el passaport/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: { in: [userIdEs, userIdCa] } } });
  }
});

// --- Task 6: next-action recommendation accounts for deferred actions -------------------------

test("6A/6B: a deferred similar action -> no duplicate created, mentions the deferral and a pull-back option", async () => {
  const server = buildServer();
  const userId = `temporal-6ab-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goalResult = await createGoal(userId, { title: "Find a fully remote Web3 developer job", category: "career", priority: "medium" });
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
    const action = await createActionItem(userId, { source: "manual", title: "Apply to 3 more remote Web3 roles", goalId: goalResult.goal.id });
    await snoozeActionItem(userId, action.id, new Date(Date.now() + 24 * 60 * 60 * 1000));

    const beforeCount = await prisma.actionItem.count({ where: { userId } });
    mockPlan({
      topic: "goals",
      intent: "next_action",
      operations: [op("goal.recommend_next_action", { recommendation: "You just moved this to tomorrow.", proposedAction: "Apply to 3 more remote Web3 roles today" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "what should I do next?");

    assert.match(reply.reply, /already moved "apply to 3 more remote web3 roles"/i);
    assert.match(reply.reply, /move it back to today/i);
    assert.equal(reply.debug.pendingOperation, false, "must not open a create-confirmation for a near-duplicate");
    const afterCount = await prisma.actionItem.count({ where: { userId } });
    assert.equal(afterCount, beforeCount, "no duplicate action may be created");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("6C: explicit 'move it back to today' pulls the deferred action back to open", async () => {
  const server = buildServer();
  const userId = `temporal-6c-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goalResult = await createGoal(userId, { title: "Find a fully remote Web3 developer job", category: "career", priority: "medium" });
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
    const action = await createActionItem(userId, { source: "manual", title: "Apply to 3 more remote Web3 roles", goalId: goalResult.goal.id });
    await snoozeActionItem(userId, action.id, new Date(Date.now() + 24 * 60 * 60 * 1000));

    mockPlan({
      topic: "goals",
      intent: "next_action",
      operations: [op("goal.recommend_next_action", { recommendation: "You just moved this to tomorrow.", proposedAction: "Apply to 3 more remote Web3 roles today" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    await sendAgentMessage(server, userId, "what should I do next?");

    mockPlan({ topic: "actions", intent: "reschedule", operations: [op("action.reschedule", { dueText: "today" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "move it back to today");

    assert.equal(reply.debug.mutationExecuted, true);
    const item = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(item?.status, "open");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("6D: no deferred conflict -> normal recommendation opens a real confirmation", async () => {
  const server = buildServer();
  const userId = `temporal-6d-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goalResult = await createGoal(userId, { title: "Find a fully remote Web3 developer job", category: "career", priority: "medium" });
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");

    mockPlan({
      topic: "goals",
      intent: "next_action",
      operations: [op("goal.recommend_next_action", { recommendation: "Good start.", proposedAction: "Apply to 3 more remote Web3 roles today" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "what should I do next?");

    assert.equal(reply.debug.pendingOperation, true);
    assert.match(reply.reply, /want me to create this action/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 7: repeated postponement coaching (deterministic, postponeCount-driven) --------------

test("7A: the first deferral gets no challenge at all", async () => {
  const server = buildServer();
  const userId = `temporal-7a-${randomUUID()}`;
  try {
    await seedUser(userId);
    const action = await createActionItem(userId, { source: "manual", title: "Apply to remote roles" });

    mockPlan({ topic: "actions", intent: "snooze", operations: [op("action.snooze", { actionId: action.id, untilText: "tomorrow" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "move it to tomorrow");

    assert.doesNotMatch(reply.reply, /second time|avoiding|several times/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("7B: the second deferral gets a mild, non-accusatory challenge", async () => {
  const server = buildServer();
  const userId = `temporal-7b-${randomUUID()}`;
  try {
    await seedUser(userId);
    const action = await createActionItem(userId, { source: "manual", title: "Apply to remote roles" });
    await snoozeActionItem(userId, action.id, new Date(Date.now() + 24 * 60 * 60 * 1000));

    mockPlan({ topic: "actions", intent: "list_all", operations: [op("action.list", { status: "all" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "show me all my actions");

    mockPlan({ topic: "actions", intent: "snooze", operations: [op("action.snooze", { actionId: action.id, untilText: "tomorrow" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "move it to tomorrow again");

    assert.match(reply.reply, /second time/i);
    assert.match(reply.reply, /\?/, "must be phrased as a genuine question, not an accusation");
    assert.equal(reply.debug.mutationExecuted, true, "the move itself is never blocked");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("7C: the third deferral gets stronger, concrete coaching", async () => {
  const server = buildServer();
  const userId = `temporal-7c-${randomUUID()}`;
  try {
    await seedUser(userId);
    const action = await createActionItem(userId, { source: "manual", title: "Apply to remote roles" });
    await snoozeActionItem(userId, action.id, new Date(Date.now() + 24 * 60 * 60 * 1000));
    await snoozeActionItem(userId, action.id, new Date(Date.now() + 48 * 60 * 60 * 1000));

    mockPlan({ topic: "actions", intent: "list_all", operations: [op("action.list", { status: "all" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "show me all my actions");

    mockPlan({ topic: "actions", intent: "snooze", operations: [op("action.snooze", { actionId: action.id, untilText: "tomorrow" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "move it to tomorrow yet again");

    assert.match(reply.reply, /several times/i);
    assert.match(reply.reply, /10-minute version|shrink it|archive it/i);
    assert.equal(reply.debug.mutationExecuted, true, "the move itself is never blocked");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 8: goal-avoidance guardrail refinement -----------------------------------------------

test("8A: 'snooze it later this week' does not hit avoidance", async () => {
  const server = buildServer();
  const userId = `temporal-8a-${randomUUID()}`;
  try {
    await seedUser(userId);
    await createGoal(userId, { title: "Find a fully remote Web3 developer job", category: "career", priority: "medium" });
    await createActionItem(userId, { source: "manual", title: "Apply to remote roles" });

    mockPlan(actionListPlan());
    await sendAgentMessage(server, userId, "show me my actions");

    mockGuardrail(guardrailClassification({ conflict: "hard_block", pattern: "avoidance" }));
    const reply = await sendAgentMessage(server, userId, "snooze it later this week");

    assert.notEqual(reply.debug.conversationTopic, "guardrail");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("8B: 'not today, remind me tomorrow' does not hit avoidance and actually moves the action", async () => {
  const server = buildServer();
  const userId = `temporal-8b-${randomUUID()}`;
  try {
    await seedUser(userId);
    await createGoal(userId, { title: "Find a fully remote Web3 developer job", category: "career", priority: "medium" });
    const action = await createActionItem(userId, { source: "manual", title: "Apply to remote roles" });

    mockPlan(actionListPlan());
    await sendAgentMessage(server, userId, "show me my actions");

    mockGuardrail(guardrailClassification({ conflict: "soft_warn", pattern: "avoidance" }));
    mockPlan({ topic: "actions", intent: "snooze", operations: [op("action.snooze", { untilText: "tomorrow" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "not today, remind me tomorrow");

    assert.notEqual(reply.debug.conversationTopic, "guardrail");
    assert.equal(reply.debug.mutationExecuted, true);
    const item = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(item?.status, "snoozed");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("8C: genuinely vague avoidance ('I'll do it someday') still reaches guardrail handling, not the new action-scheduling bypass", async () => {
  const server = buildServer();
  const userId = `temporal-8c-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goal = await createGoal(userId, { title: "Find a fully remote Web3 developer job", category: "career", priority: "medium" });
    if (goal.duplicate) throw new Error("unexpected duplicate goal in test setup");

    // Deliberately NOT "I don't want to do this goal anymore" — that phrase is (correctly,
    // pre-existing, unrelated to this task) routed to goalLifecycleShortcutOperation as an
    // operational "archive this goal" command, checked even earlier than the guardrail. This
    // test is specifically about the NEW action-scheduling bypass this task added, so it needs
    // wording with no lifecycle-management verb AND no deferral verb at all.
    mockGuardrail(guardrailClassification({ conflict: "soft_warn", goalId: goal.goal.id, pattern: "avoidance" }));
    const reply = await sendAgentMessage(server, userId, "I'll do it someday");

    assert.equal(reply.debug.conversationTopic, "guardrail");
    assert.deepEqual(reply.operationsPlanned, []);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("8D: Spanish and Catalan deferral phrases also bypass the guardrail with an active goal", async () => {
  const server = buildServer();
  const userIdEs = `temporal-8d-es-${randomUUID()}`;
  const userIdCa = `temporal-8d-ca-${randomUUID()}`;
  try {
    await seedUser(userIdEs);
    await createGoal(userIdEs, { title: "Find a fully remote Web3 developer job", category: "career", priority: "medium" });
    await createActionItem(userIdEs, { source: "manual", title: "Renovar el pasaporte" });
    mockPlan(actionListPlan());
    await sendAgentMessage(server, userIdEs, "muéstrame mis tareas");
    mockGuardrail(guardrailClassification({ conflict: "soft_warn", pattern: "avoidance" }));
    mockPlan({ topic: "actions", intent: "snooze", operations: [op("action.snooze", { untilText: "tomorrow" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const replyEs = await sendAgentMessage(server, userIdEs, "muévelo a mañana");
    assert.notEqual(replyEs.debug.conversationTopic, "guardrail");

    await seedUser(userIdCa);
    await createGoal(userIdCa, { title: "Find a fully remote Web3 developer job", category: "career", priority: "medium" });
    await createActionItem(userIdCa, { source: "manual", title: "Renovar el passaport" });
    mockPlan(actionListPlan());
    await sendAgentMessage(server, userIdCa, "mostra'm les meves tasques");
    mockGuardrail(guardrailClassification({ conflict: "soft_warn", pattern: "avoidance" }));
    mockPlan({ topic: "actions", intent: "snooze", operations: [op("action.snooze", { untilText: "tomorrow" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const replyCa = await sendAgentMessage(server, userIdCa, "mou-ho a demà");
    assert.notEqual(replyCa.debug.conversationTopic, "guardrail");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: { in: [userIdEs, userIdCa] } } });
  }
});
