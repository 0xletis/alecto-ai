import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createActionItem, prisma, snoozeActionItem } from "../packages/db/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, mockPlan, op, sendAgentMessage, seedUser } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * fix/private-alpha-live-action-and-coaching-regressions (Task 3): a real Telegram transcript
 * found "Do i have an action already to send CVs? Move it to today if so" answered "You don't
 * have any actions scheduled for today" for an action that genuinely existed — it had just
 * already been snoozed once. resolveActionRef (validator.ts) claimed in its own doc comment to
 * search "both visible and background actions by name," but only ever included
 * context.openActions — context.deferredActions (snoozed items) was never actually searched.
 * Fixed by adding it to the same candidate pool. Every test mocks the planner correctly calling
 * action.reschedule with a `ref` (no actionId) — the real-planner tool-choice side of this fix is
 * covered separately by the tagged LLM eval scenario.
 */

function reschedulePlan(ref: string, dueText = "today") {
  return { topic: "actions", intent: "reschedule", operations: [op("action.reschedule", { ref, dueText })], needsClarification: false, clarificationQuestion: null, replyDraft: "" };
}

test("A. a matching DEFERRED (snoozed) action is found by title and moved to today", async () => {
  const server = buildServer();
  const userId = `reschedule-search-a-${randomUUID()}`;
  try {
    await seedUser(userId);
    const action = await createActionItem(userId, { source: "manual", title: "Send CVs", priority: "high" });
    await snoozeActionItem(userId, action.id, new Date(Date.now() + 3 * 24 * 60 * 60 * 1000));

    mockPlan(reschedulePlan("send CVs"));
    const reply = await sendAgentMessage(server, userId, "Do i have an action already to send CVs? Move it to today if so");

    const updated = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(updated?.status, "open", "pulling a deferred action back to today re-opens it");
    assert.match(reply.reply, /send cvs|today/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("B. a matching OVERDUE (still-open) action is found by title and moved to today", async () => {
  const server = buildServer();
  const userId = `reschedule-search-b-${randomUUID()}`;
  try {
    await seedUser(userId);
    const action = await createActionItem(userId, { source: "manual", title: "Send CVs", priority: "high", dueAt: new Date(Date.now() - 24 * 60 * 60 * 1000) });

    mockPlan(reschedulePlan("send CVs"));
    await sendAgentMessage(server, userId, "Do i have an action already to send CVs? Move it to today if so");

    const updated = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(updated?.status, "open");
    assert.ok(updated?.dueAt && updated.dueAt > new Date(Date.now() - 60 * 60 * 1000), "the overdue action's due date must actually move to today");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("C. no matching action at all — asks honestly and offers to create, never claims falsely there's nothing to check", async () => {
  const server = buildServer();
  const userId = `reschedule-search-c-${randomUUID()}`;
  try {
    await seedUser(userId);
    await createActionItem(userId, { source: "manual", title: "Book flights", priority: "medium" });

    mockPlan(reschedulePlan("send CVs"));
    const reply = await sendAgentMessage(server, userId, "Do i have an action already to send CVs? Move it to today if so");

    assert.match(reply.reply, /create|new action/i, `expected an offer to create — got: ${reply.reply}`);
    const actions = await prisma.actionItem.findMany({ where: { userId } });
    assert.equal(actions.length, 1, "must never silently create a second action while asking");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("D. multiple similarly-titled actions — asks which one, no mutation", async () => {
  const server = buildServer();
  const userId = `reschedule-search-d-${randomUUID()}`;
  try {
    await seedUser(userId);
    const first = await createActionItem(userId, { source: "manual", title: "Send CVs to remote roles", priority: "high" });
    const second = await createActionItem(userId, { source: "manual", title: "Send CVs to Web3 startups", priority: "high" });

    mockPlan(reschedulePlan("send CVs"));
    await sendAgentMessage(server, userId, "Do i have an action already to send CVs? Move it to today if so");

    const firstAfter = await prisma.actionItem.findUnique({ where: { id: first.id } });
    const secondAfter = await prisma.actionItem.findUnique({ where: { id: second.id } });
    assert.equal(firstAfter?.status, "open");
    assert.equal(secondAfter?.status, "open");
    assert.equal(firstAfter?.dueAt, null, "must not guess which one to move when the reference is ambiguous");
    assert.equal(secondAfter?.dueAt, null);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("E. resolving via a deferred action never creates a duplicate", async () => {
  const server = buildServer();
  const userId = `reschedule-search-e-${randomUUID()}`;
  try {
    await seedUser(userId);
    const action = await createActionItem(userId, { source: "manual", title: "Send CVs", priority: "high" });
    await snoozeActionItem(userId, action.id, new Date(Date.now() + 3 * 24 * 60 * 60 * 1000));

    mockPlan(reschedulePlan("send CVs"));
    await sendAgentMessage(server, userId, "Do i have an action already to send CVs? Move it to today if so");

    const actions = await prisma.actionItem.findMany({ where: { userId } });
    assert.equal(actions.length, 1, "resolving and rescheduling an existing action must never also create a new one");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
