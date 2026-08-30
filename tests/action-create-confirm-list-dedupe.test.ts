import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createGoal, prisma } from "../packages/db/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, mockPlan, op, sendAgentMessage, seedUser } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * fix/private-alpha-live-action-and-coaching-regressions (Task 4): a real Telegram transcript
 * found "schedule sending 3 CVs today" (which real-planner phrasing sometimes turns into a
 * confirm-shaped reply while STILL calling action.create right away — action.create has no
 * requiresConfirmation gate of its own) followed by "Yes do so and show me my actions so i can
 * verify" creating a SECOND, duplicate "Send 3 CVs" action, since the next turn's planner had no
 * way to know the first one had already been created for real. Fixed with two complementary
 * changes: (1) action.create's executor case now goes through createActionItemIfNotExists (an
 * exact-title, same-source, still-open-or-snoozed check) instead of a bare create, so a second
 * call for the identical title is always recognized and reported honestly rather than silently
 * duplicated; (2) a genuine pending action.create proposal (opened by goal.recommend_next_action)
 * now has its own topic-scoped, wider confirm recognizer in runtime.ts, so a compound confirm +
 * "show me my actions" message applies the pending create exactly once and lists real state,
 * without ever reaching the general LLM planner for that turn at all.
 */

async function seedPendingActionCreate(server: ReturnType<typeof buildServer>, userId: string, title: string): Promise<void> {
  const goalResult = await createGoal(userId, { title: "Find a fully remote developer job, ideally in Web3", category: "career", priority: "medium" });
  if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
  mockPlan({
    topic: "goals",
    intent: "next_action",
    operations: [op("goal.recommend_next_action", { recommendation: "Let's keep momentum.", proposedAction: title })],
    needsClarification: false,
    clarificationQuestion: null,
    replyDraft: ""
  });
  const reply = await sendAgentMessage(server, userId, "what should I do today?");
  assert.equal(reply.debug.pendingOperation, true, "test setup: a pending action.create proposal must actually open");
  clearAgentRuntimeMocks();
}

function actionCreatePlan(title: string, dueText = "today") {
  return { topic: "actions", intent: "create", operations: [op("action.create", { title, dueText })], needsClarification: false, clarificationQuestion: null, replyDraft: `Want me to add "${title}" for today? Reply yes to confirm.` };
}

test("A. planning the same action.create title twice across two turns never creates a duplicate row", async () => {
  const server = buildServer();
  const userId = `create-dedupe-a-${randomUUID()}`;
  try {
    await seedUser(userId);

    mockPlan(actionCreatePlan("Send 3 CVs"));
    const first = await sendAgentMessage(server, userId, "schedule sending 3 CVs today");
    assert.match(first.reply, /send 3 cvs/i);

    mockPlan(actionCreatePlan("Send 3 CVs"));
    const second = await sendAgentMessage(server, userId, "yes do so");

    const actions = await prisma.actionItem.findMany({ where: { userId } });
    assert.equal(actions.length, 1, "a second plan for the identical title must never create a second row");
    assert.match(second.reply, /already have/i, "the second turn must honestly say the task already exists, not claim a fresh success");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("B. a compound 'yes do so and show me my actions' applies a pending proposal exactly once and lists it", async () => {
  const server = buildServer();
  const userId = `create-dedupe-b-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedPendingActionCreate(server, userId, "Send 3 CVs");

    const reply = await sendAgentMessage(server, userId, "Yes do so and show me my actions so i can verify");

    assert.equal(reply.debug.mutationExecuted, true, "the pending create must actually apply");
    assert.equal(reply.debug.pendingOperation, false, "confirming clears the pending proposal");
    assert.match(reply.reply, /send 3 cvs/i, `expected the created action to be reported — got: ${reply.reply}`);

    const actions = await prisma.actionItem.findMany({ where: { userId, title: "Send 3 CVs" } });
    assert.equal(actions.length, 1, "a compound confirm+list message must create exactly one action");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("C. a bare 'yes' for a pending proposal still creates exactly once, unaffected by the new compound handling", async () => {
  const server = buildServer();
  const userId = `create-dedupe-c-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedPendingActionCreate(server, userId, "Send 3 CVs");

    const reply = await sendAgentMessage(server, userId, "yes");

    assert.match(reply.reply, /send 3 cvs/i);
    const actions = await prisma.actionItem.findMany({ where: { userId, title: "Send 3 CVs" } });
    assert.equal(actions.length, 1);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("D. the compound confirm never re-enters the general planner (a stale mock left over from setup is never consumed)", async () => {
  const server = buildServer();
  const userId = `create-dedupe-d-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedPendingActionCreate(server, userId, "Send 3 CVs");

    // Deliberately mocks a WRONG plan (a completely different tool) to prove the compound confirm
    // path never calls planMessage at all for this turn — if it did, this wrong mock would hijack
    // the reply instead of the real confirm+list behavior.
    mockPlan({ topic: "actions", intent: "list_actions", operations: [op("action.reminder_list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "Yes do so and show me my actions so i can verify");

    assert.match(reply.reply, /send 3 cvs/i, `expected the real confirm+list path, not the stale mocked reminder_list plan — got: ${reply.reply}`);
    const actions = await prisma.actionItem.findMany({ where: { userId, title: "Send 3 CVs" } });
    assert.equal(actions.length, 1);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("exact live regression: 'schedule sending 3 CVs today' then 'Yes do so and show me my actions so i can verify' never duplicates", async () => {
  const server = buildServer();
  const userId = `create-dedupe-live-${randomUUID()}`;
  try {
    await seedUser(userId);

    mockPlan(actionCreatePlan("Send 3 CVs"));
    await sendAgentMessage(server, userId, "schedule sending 3 CVs today");

    mockPlan({
      topic: "actions",
      intent: "create",
      operations: [op("action.create", { title: "Send 3 CVs", dueText: "today" }), op("action.list", {})],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: "Done — here are your actions:"
    });
    const reply = await sendAgentMessage(server, userId, "Yes do so and show me my actions so i can verify");

    const actions = await prisma.actionItem.findMany({ where: { userId, title: "Send 3 CVs" } });
    assert.equal(actions.length, 1, "the exact live transcript must never produce two 'Send 3 CVs' actions");
    assert.match(reply.reply, /send 3 cvs/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
