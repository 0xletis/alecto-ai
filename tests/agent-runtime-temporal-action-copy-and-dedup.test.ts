import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createActionItem, createGoal, prisma, snoozeActionItem } from "../packages/db/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, mockPlan, op, sendAgentMessage, seedUser } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * Deterministic coverage for fix/private-alpha-temporal-action-copy-and-dedup — a real Telegram
 * transcript found "2 action for tomorrows" (pluralizing the whole phrase instead of the noun),
 * the word "snoozed" leaking into a normal reply, a moved action's own stale "today" wording
 * contradicting its new "due tomorrow" label, and two near-identical deferred actions shown with
 * no hint they might be the same thing twice. Tasks 4 (A-C) and 5 (A-C) are about the QUALITY of
 * LLM-authored recommendation text (today- vs. tomorrow-framing, honoring an already-stated
 * setup fact) — inherently planner-judgment questions, covered by the gated real-LLM eval suite
 * instead of here; this file covers task 4's one deterministic mechanism (D) and everything else.
 */

function actionListPlan(args: Record<string, unknown> = {}) {
  return { topic: "actions", intent: "list_actions", operations: [op("action.list", args)], needsClarification: false, clarificationQuestion: null, replyDraft: "" };
}

// --- Task 1: date-scoped action-list grammar/copy ------------------------------------------------

test("1A: exactly one action for tomorrow is singular — 'You have 1 action for tomorrow:'", async () => {
  const server = buildServer();
  const userId = `copydedup-1a-${randomUUID()}`;
  try {
    await seedUser(userId);
    const action = await createActionItem(userId, { source: "manual", title: "Apply to remote roles" });
    await snoozeActionItem(userId, action.id, new Date(Date.now() + 24 * 60 * 60 * 1000));

    mockPlan(actionListPlan({ when: "tomorrow" }));
    const reply = await sendAgentMessage(server, userId, "do i have something to do tomorrow?");

    assert.match(reply.reply, /^You have 1 action for tomorrow:/);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("1B: exactly two actions for tomorrow is plural — 'You have 2 actions for tomorrow:'", async () => {
  const server = buildServer();
  const userId = `copydedup-1b-${randomUUID()}`;
  try {
    await seedUser(userId);
    const a = await createActionItem(userId, { source: "manual", title: "Apply to remote roles" });
    await snoozeActionItem(userId, a.id, new Date(Date.now() + 24 * 60 * 60 * 1000));
    const b = await createActionItem(userId, { source: "manual", title: "Update LinkedIn profile" });
    await snoozeActionItem(userId, b.id, new Date(Date.now() + 24 * 60 * 60 * 1000));

    mockPlan(actionListPlan({ when: "tomorrow" }));
    const reply = await sendAgentMessage(server, userId, "do i have something to do tomorrow?");

    assert.match(reply.reply, /^You have 2 actions for tomorrow:/);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("1C: never says 'tomorrows' (or 'todays'/'this weeks'), for either count", async () => {
  const server = buildServer();
  const userId = `copydedup-1c-${randomUUID()}`;
  try {
    await seedUser(userId);
    const a = await createActionItem(userId, { source: "manual", title: "Apply to remote roles" });
    await snoozeActionItem(userId, a.id, new Date(Date.now() + 24 * 60 * 60 * 1000));
    const b = await createActionItem(userId, { source: "manual", title: "Update LinkedIn profile" });
    await snoozeActionItem(userId, b.id, new Date(Date.now() + 24 * 60 * 60 * 1000));

    mockPlan(actionListPlan({ when: "tomorrow" }));
    const reply = await sendAgentMessage(server, userId, "do i have something to do tomorrow?");

    assert.doesNotMatch(reply.reply, /tomorrows|todays|weeks:/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("1D: no user-facing 'snoozed' anywhere in a normal date-scoped or status:'all' reply", async () => {
  const server = buildServer();
  const userId = `copydedup-1d-${randomUUID()}`;
  try {
    await seedUser(userId);
    const action = await createActionItem(userId, { source: "manual", title: "Apply to remote roles" });
    await snoozeActionItem(userId, action.id, new Date(Date.now() + 24 * 60 * 60 * 1000));

    mockPlan(actionListPlan({ when: "tomorrow" }));
    const tomorrowReply = await sendAgentMessage(server, userId, "do i have something to do tomorrow?");
    assert.doesNotMatch(tomorrowReply.reply, /snoozed/i);
    assert.match(tomorrowReply.reply, /moved to tomorrow/i);

    mockPlan(actionListPlan({ status: "all" }));
    const allReply = await sendAgentMessage(server, userId, "show me all my actions");
    assert.doesNotMatch(allReply.reply, /snoozed/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 2: stale temporal words in moved action titles ------------------------------------------

test("2A: moving a title that says 'today' to tomorrow never displays 'today — moved to tomorrow'", async () => {
  const server = buildServer();
  const userId = `copydedup-2a-${randomUUID()}`;
  try {
    await seedUser(userId);
    const action = await createActionItem(userId, { source: "manual", title: "Apply to 3 more remote Web3 roles today" });

    mockPlan(actionListPlan());
    await sendAgentMessage(server, userId, "show me my actions");

    mockPlan({ topic: "actions", intent: "snooze", operations: [op("action.snooze", { actionId: action.id, untilText: "tomorrow" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const snoozeReply = await sendAgentMessage(server, userId, "move it to tomorrow");
    assert.doesNotMatch(snoozeReply.reply, /today.*tomorrow|today.*back/i, "the snooze reply must not show the stale 'today' next to the new date");
    assert.match(snoozeReply.reply, /apply to 3 more remote web3 roles" back tomorrow/i);

    mockPlan(actionListPlan({ when: "tomorrow" }));
    const listReply = await sendAgentMessage(server, userId, "do i have something to do tomorrow?");
    assert.doesNotMatch(listReply.reply, /today/i, "the list line must not show the stale 'today' next to 'moved to tomorrow'");
    assert.match(listReply.reply, /apply to 3 more remote web3 roles — moved to tomorrow/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2B: moving a title that says 'by the end of the week' to tomorrow is displayed clearly, no contradiction", async () => {
  const server = buildServer();
  const userId = `copydedup-2b-${randomUUID()}`;
  try {
    await seedUser(userId);
    const action = await createActionItem(userId, { source: "manual", title: "Apply to 3 more remote Web3 roles by the end of the week." });

    mockPlan(actionListPlan());
    await sendAgentMessage(server, userId, "show me my actions");

    mockPlan({ topic: "actions", intent: "snooze", operations: [op("action.snooze", { actionId: action.id, untilText: "tomorrow" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "move it to tomorrow");

    assert.doesNotMatch(reply.reply, /end of the week/i);
    assert.match(reply.reply, /apply to 3 more remote web3 roles" back tomorrow/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2C: title-cleaning never rewrites unrelated words, only a recognized trailing temporal phrase", async () => {
  const server = buildServer();
  const userId = `copydedup-2c-${randomUUID()}`;
  try {
    await seedUser(userId);
    // "Today" appears mid-title here, as part of a real, unrelated phrase — must be left alone;
    // only a genuinely TRAILING temporal phrase is ever stripped.
    const action = await createActionItem(userId, { source: "manual", title: "Read the Today show recap" });

    mockPlan(actionListPlan());
    await sendAgentMessage(server, userId, "show me my actions");

    mockPlan({ topic: "actions", intent: "snooze", operations: [op("action.snooze", { actionId: action.id, untilText: "tomorrow" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "move it to tomorrow");

    assert.match(reply.reply, /read the today show recap/i, "a mid-title word must never be stripped, even if it happens to be a temporal word");

    const stored = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(stored?.title, "Read the Today show recap", "the STORED title must never be rewritten — this is a display-only cleanup");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 3: similar deferred actions in date-scoped lists ----------------------------------------

test("3A: two similar deferred actions for tomorrow trigger a cleanup suggestion", async () => {
  const server = buildServer();
  const userId = `copydedup-3a-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goalResult = await createGoal(userId, { title: "Find a fully remote Web3 developer job", category: "career", priority: "medium" });
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
    const first = await createActionItem(userId, { source: "manual", title: "Apply to 3 more remote Web3 roles today", goalId: goalResult.goal.id });
    await snoozeActionItem(userId, first.id, new Date(Date.now() + 24 * 60 * 60 * 1000));
    const second = await createActionItem(userId, { source: "manual", title: "Apply to 3 more remote Web3 roles by the end of the week", goalId: goalResult.goal.id });
    await snoozeActionItem(userId, second.id, new Date(Date.now() + 24 * 60 * 60 * 1000));

    mockPlan(actionListPlan({ when: "tomorrow" }));
    const reply = await sendAgentMessage(server, userId, "do i have something to do tomorrow?");

    // fix/private-alpha-deferred-action-dedupe-and-today-coaching: the text-only CTA became a
    // real pending confirmation ("keep the first and archive the duplicate?") — updated wording,
    // same underlying detection.
    assert.match(reply.reply, /similar actions scheduled/i);
    assert.match(reply.reply, /keep .* and archive the duplicate/i);
    assert.equal(reply.debug.pendingOperation, true);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3B: two unrelated deferred actions for tomorrow do not trigger a duplicate suggestion", async () => {
  const server = buildServer();
  const userId = `copydedup-3b-${randomUUID()}`;
  try {
    await seedUser(userId);
    const a = await createActionItem(userId, { source: "manual", title: "Apply to remote roles" });
    await snoozeActionItem(userId, a.id, new Date(Date.now() + 24 * 60 * 60 * 1000));
    const b = await createActionItem(userId, { source: "manual", title: "Book dentist appointment" });
    await snoozeActionItem(userId, b.id, new Date(Date.now() + 24 * 60 * 60 * 1000));

    mockPlan(actionListPlan({ when: "tomorrow" }));
    const reply = await sendAgentMessage(server, userId, "do i have something to do tomorrow?");

    assert.doesNotMatch(reply.reply, /similar actions scheduled/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3C: the cleanup suggestion never mutates anything — both actions remain untouched", async () => {
  const server = buildServer();
  const userId = `copydedup-3c-${randomUUID()}`;
  try {
    await seedUser(userId);
    const first = await createActionItem(userId, { source: "manual", title: "Apply to 3 more remote Web3 roles today" });
    await snoozeActionItem(userId, first.id, new Date(Date.now() + 24 * 60 * 60 * 1000));
    const second = await createActionItem(userId, { source: "manual", title: "Apply to 3 more remote Web3 roles by the end of the week" });
    await snoozeActionItem(userId, second.id, new Date(Date.now() + 24 * 60 * 60 * 1000));

    mockPlan(actionListPlan({ when: "tomorrow" }));
    const reply = await sendAgentMessage(server, userId, "do i have something to do tomorrow?");

    assert.match(reply.reply, /similar actions scheduled/i);
    assert.equal(reply.debug.mutationExecuted, false);
    const items = await prisma.actionItem.findMany({ where: { userId } });
    assert.equal(items.length, 2, "no action may be merged or archived by the suggestion alone");
    assert.ok(items.every((item) => item.status === "snoozed"));
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 4 (deterministic part): pulling a deferred action back to today ------------------------

test("4D: 'move it back to today' pulls a deferred action back to open, no confirmation required", async () => {
  const server = buildServer();
  const userId = `copydedup-4d-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goalResult = await createGoal(userId, { title: "Find a fully remote Web3 developer job", category: "career", priority: "medium" });
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
    const action = await createActionItem(userId, { source: "manual", title: "Apply to 3 more remote Web3 roles", goalId: goalResult.goal.id });
    await snoozeActionItem(userId, action.id, new Date(Date.now() + 24 * 60 * 60 * 1000));

    mockPlan({
      topic: "goals",
      intent: "next_action",
      operations: [op("goal.recommend_next_action", { recommendation: "You moved this to tomorrow.", proposedAction: "Apply to 3 more remote Web3 roles today" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    await sendAgentMessage(server, userId, "what should I do today?");

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
