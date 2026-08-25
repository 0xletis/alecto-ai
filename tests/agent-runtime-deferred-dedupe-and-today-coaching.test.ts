import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createActionItem, createGoal, prisma, snoozeActionItem } from "../packages/db/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, mockPlan, op, sendAgentMessage, seedUser } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * Deterministic coverage for fix/private-alpha-deferred-action-dedupe-and-today-coaching — a real
 * Telegram transcript found "merge them yes" (replying to Alecto's OWN duplicate-cleanup CTA)
 * answered "You don't have any open actions to archive," because action.archive_all_propose's
 * "visible"/explicit-id candidate lookup filtered to status "open" only — a snoozed/deferred
 * action, exactly what a "tomorrow" list is made of, could never be archived that way even though
 * the single-item action.archive tool never had that restriction. Root cause: two different
 * archive paths disagreed about what counts as a valid target.
 *
 * The duplicate-cleanup CTA itself is now backed by a real pendingOperationUpdate (keep the
 * first, archive the second) rather than a text-only question with nothing behind it. Task 4/5
 * (today-coaching framing, resume-context respect) are mostly LLM-judgment concerns, covered by
 * the gated real-LLM eval suite; this file covers their one deterministic backstop (the resume-
 * proposedAction veto) plus everything else.
 */

function actionListPlan(args: Record<string, unknown> = {}) {
  return { topic: "actions", intent: "list_actions", operations: [op("action.list", args)], needsClarification: false, clarificationQuestion: null, replyDraft: "" };
}

async function seedDuplicateDeferredPair(userId: string, goalId?: string): Promise<{ first: string; second: string }> {
  const first = await createActionItem(userId, { source: "manual", title: "Apply to 3 more remote Web3 roles today", goalId });
  await snoozeActionItem(userId, first.id, new Date(Date.now() + 24 * 60 * 60 * 1000));
  const second = await createActionItem(userId, { source: "manual", title: "Apply to 3 more remote Web3 roles by the end of the week", goalId });
  await snoozeActionItem(userId, second.id, new Date(Date.now() + 24 * 60 * 60 * 1000));
  return { first: first.id, second: second.id };
}

// --- Task 2: a real, working duplicate-cleanup CTA -----------------------------------------------

test("2A: a tomorrow list with two similar deferred actions opens a real pending confirmation", async () => {
  const server = buildServer();
  const userId = `dedupe-2a-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedDuplicateDeferredPair(userId);

    mockPlan(actionListPlan({ when: "tomorrow" }));
    const reply = await sendAgentMessage(server, userId, "do i have something to do tomorrow?");

    assert.match(reply.reply, /keep .* and archive the duplicate/i);
    assert.match(reply.reply, /reply yes to confirm or cancel/i);
    assert.equal(reply.debug.pendingOperation, true);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2B/2C/2D: 'merge them yes' actually archives the duplicate, using visible DEFERRED actions as valid candidates", async () => {
  const server = buildServer();
  const userId = `dedupe-2bcd-${randomUUID()}`;
  try {
    await seedUser(userId);
    const { first, second } = await seedDuplicateDeferredPair(userId);

    mockPlan(actionListPlan({ when: "tomorrow" }));
    await sendAgentMessage(server, userId, "do i have something to do tomorrow?");

    const reply = await sendAgentMessage(server, userId, "merge them yes");

    assert.doesNotMatch(reply.reply, /don't have any open actions/i, "must never say 'no open actions' for a visible DEFERRED duplicate");
    assert.equal(reply.debug.mutationExecuted, true);

    const firstItem = await prisma.actionItem.findUnique({ where: { id: first } });
    const secondItem = await prisma.actionItem.findUnique({ where: { id: second } });
    assert.equal(firstItem?.status, "snoozed", "the kept action must be untouched, still deferred");
    assert.equal(secondItem?.status, "archived", "the duplicate must actually be archived");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2E: no mutation happens until the confirmation is actually given", async () => {
  const server = buildServer();
  const userId = `dedupe-2e-${randomUUID()}`;
  try {
    await seedUser(userId);
    const { first, second } = await seedDuplicateDeferredPair(userId);

    mockPlan(actionListPlan({ when: "tomorrow" }));
    const reply = await sendAgentMessage(server, userId, "do i have something to do tomorrow?");

    assert.equal(reply.debug.mutationExecuted, false, "the CTA itself must never mutate anything");
    const firstItem = await prisma.actionItem.findUnique({ where: { id: first } });
    const secondItem = await prisma.actionItem.findUnique({ where: { id: second } });
    assert.equal(firstItem?.status, "snoozed");
    assert.equal(secondItem?.status, "snoozed");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2F: two genuinely unrelated deferred actions never open a duplicate-cleanup proposal", async () => {
  const server = buildServer();
  const userId = `dedupe-2f-${randomUUID()}`;
  try {
    await seedUser(userId);
    const a = await createActionItem(userId, { source: "manual", title: "Apply to remote roles" });
    await snoozeActionItem(userId, a.id, new Date(Date.now() + 24 * 60 * 60 * 1000));
    const b = await createActionItem(userId, { source: "manual", title: "Book dentist appointment" });
    await snoozeActionItem(userId, b.id, new Date(Date.now() + 24 * 60 * 60 * 1000));

    mockPlan(actionListPlan({ when: "tomorrow" }));
    const reply = await sendAgentMessage(server, userId, "do i have something to do tomorrow?");

    assert.doesNotMatch(reply.reply, /similar actions scheduled|keep .* and archive the duplicate/i);
    assert.equal(reply.debug.pendingOperation, false);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 3: archiving/cleanup of visible deferred actions ----------------------------------------

test("3A: 'archive 1' on a visible deferred action works directly, no confirmation required", async () => {
  const server = buildServer();
  const userId = `dedupe-3a-${randomUUID()}`;
  try {
    await seedUser(userId);
    const action = await createActionItem(userId, { source: "manual", title: "Apply to remote roles" });
    await snoozeActionItem(userId, action.id, new Date(Date.now() + 24 * 60 * 60 * 1000));

    mockPlan(actionListPlan({ when: "tomorrow" }));
    await sendAgentMessage(server, userId, "do i have something to do tomorrow?");

    mockPlan({ topic: "actions", intent: "archive", operations: [op("action.archive", { actionId: action.id })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "archive 1");

    assert.equal(reply.debug.mutationExecuted, true);
    const item = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(item?.status, "archived");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3B: 'remove 2' works on the second visible deferred action", async () => {
  const server = buildServer();
  const userId = `dedupe-3b-${randomUUID()}`;
  try {
    await seedUser(userId);
    const { second } = await seedDuplicateDeferredPair(userId);

    mockPlan(actionListPlan({ when: "tomorrow" }));
    await sendAgentMessage(server, userId, "do i have something to do tomorrow?");

    mockPlan({ topic: "actions", intent: "archive", operations: [op("action.archive", { actionId: second })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "remove 2");

    assert.equal(reply.debug.mutationExecuted, true);
    const item = await prisma.actionItem.findUnique({ where: { id: second } });
    assert.equal(item?.status, "archived");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3C: 'keep first' after the duplicate CTA archives the duplicate, keeps the first untouched", async () => {
  const server = buildServer();
  const userId = `dedupe-3c-${randomUUID()}`;
  try {
    await seedUser(userId);
    const { first, second } = await seedDuplicateDeferredPair(userId);

    mockPlan(actionListPlan({ when: "tomorrow" }));
    await sendAgentMessage(server, userId, "do i have something to do tomorrow?");

    const reply = await sendAgentMessage(server, userId, "keep first");

    assert.equal(reply.debug.mutationExecuted, true);
    const firstItem = await prisma.actionItem.findUnique({ where: { id: first } });
    const secondItem = await prisma.actionItem.findUnique({ where: { id: second } });
    assert.equal(firstItem?.status, "snoozed");
    assert.equal(secondItem?.status, "archived");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3D: the tomorrow list after cleanup shows exactly one action", async () => {
  const server = buildServer();
  const userId = `dedupe-3d-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedDuplicateDeferredPair(userId);

    mockPlan(actionListPlan({ when: "tomorrow" }));
    await sendAgentMessage(server, userId, "do i have something to do tomorrow?");
    await sendAgentMessage(server, userId, "merge them yes");

    mockPlan(actionListPlan({ when: "tomorrow" }));
    const reply = await sendAgentMessage(server, userId, "do i have something to do tomorrow?");

    assert.match(reply.reply, /^You have 1 action for tomorrow:/);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3E: 'show me all my actions' after cleanup labels the archived duplicate", async () => {
  const server = buildServer();
  const userId = `dedupe-3e-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedDuplicateDeferredPair(userId);

    mockPlan(actionListPlan({ when: "tomorrow" }));
    await sendAgentMessage(server, userId, "do i have something to do tomorrow?");
    await sendAgentMessage(server, userId, "merge them yes");

    mockPlan(actionListPlan({ status: "all" }));
    const reply = await sendAgentMessage(server, userId, "show me all my actions");

    assert.match(reply.reply, /archived/i);
    const archivedCount = (reply.reply.match(/— archived/gi) ?? []).length;
    assert.equal(archivedCount, 1);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 5 (deterministic backstop): resume-already-current veto ---------------------------------

test("5-deterministic: a proposedAction about updating the resume is vetoed after the user said it's already current", async () => {
  const server = buildServer();
  const userId = `dedupe-5-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goalResult = await createGoal(userId, { title: "Find a fully remote Web3 developer job", category: "career", priority: "medium" });
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");

    mockPlan({ topic: "general", intent: "statement", operations: [], needsClarification: false, clarificationQuestion: null, replyDraft: "Got it, noted." });
    await sendAgentMessage(server, userId, "My resume and web CV are already up to date.");

    const beforeCount = await prisma.actionItem.count({ where: { userId } });
    mockPlan({
      topic: "goals",
      intent: "next_action",
      operations: [op("goal.recommend_next_action", { recommendation: "Let's keep momentum.", proposedAction: "Customize your resume for remote Web3 roles" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "what should I do next?");

    assert.doesNotMatch(reply.reply, /customize your resume|update your resume/i);
    assert.equal(reply.debug.pendingOperation, false, "must not open a create-confirmation for the vetoed resume action");
    const afterCount = await prisma.actionItem.count({ where: { userId } });
    assert.equal(afterCount, beforeCount, "no action may be created for the vetoed proposal");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("5-deterministic-B: a resume-update proposal is NOT vetoed without any prior resume-related statement", async () => {
  const server = buildServer();
  const userId = `dedupe-5b-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goalResult = await createGoal(userId, { title: "Find a fully remote Web3 developer job", category: "career", priority: "medium" });
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");

    mockPlan({
      topic: "goals",
      intent: "next_action",
      operations: [op("goal.recommend_next_action", { recommendation: "Let's keep momentum.", proposedAction: "Customize your resume for remote Web3 roles" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "what should I do next?");

    assert.match(reply.reply, /customize your resume/i);
    assert.equal(reply.debug.pendingOperation, true, "with no stated context, the proposal should open a normal confirmation");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
