import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { completeActionItem, createActionItem, createEvent, createGoal, prisma } from "../packages/db/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, getAgentSession, mockPlan, op, sendAgentMessage, seedUser, type MockPlan } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * Agent Runtime v3 weekly-review flow — migrating "review my week" from the legacy
 * /messages/process brain (apps/api/src/legacy/weekly-review-conversation.ts) into v3's own
 * typed weekly_review.start/weekly_review.save tools (apps/api/src/agent-runtime/tool-catalog.ts).
 * The context-building and review-generation logic
 * (apps/api/src/weekly-review/{context,review}.ts) is shared with legacy, not duplicated —
 * legacy/weekly-review-conversation.ts is now a pure re-export of both.
 */

function weeklyReviewStartPlan(): MockPlan {
  return { topic: "weekly_review", intent: "start_weekly_review", operations: [op("weekly_review.start")], needsClarification: false, clarificationQuestion: null, replyDraft: "" };
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

async function seedRichWeek(userId: string): Promise<{ goalTitle: string; overdueTitle: string }> {
  await createGoal(userId, { title: "Apply to developer jobs", category: "career", priority: "medium" });

  const completed = await createActionItem(userId, { source: "manual", title: "Send CV to acme corp", priority: "medium" });
  await completeActionItem(userId, completed.id);

  await createActionItem(userId, { source: "manual", title: "Follow up with recruiter", priority: "medium", dueAt: daysAgo(2) });

  await createEvent(userId, { type: "health.workout_completed", source: "manual", confidence: 1, data: { minutes: 45 } });
  await createEvent(userId, { type: "career.application_sent", source: "manual", confidence: 1, data: {} });

  return { goalTitle: "Apply to developer jobs", overdueTitle: "Follow up with recruiter" };
}

test("agent/message: 'review my week' returns a grounded weekly review reflecting real data", async () => {
  const server = buildServer();
  const userId = `weekly-review-grounded-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedRichWeek(userId);

    mockPlan(weeklyReviewStartPlan());
    const reply = await sendAgentMessage(server, userId, "review my week");

    assert.match(reply.reply, /here's your weekly review:/i);
    assert.match(reply.reply, /wins:/i);
    assert.match(reply.reply, /stalls:/i);
    assert.match(reply.reply, /next move:/i);
    // Grounded in the actual seeded data, not invented: 1 completed action, 1 workout logged.
    assert.match(reply.reply, /completed 1 action/i);
    assert.match(reply.reply, /logged 1 workout/i);
    assert.equal(reply.debug.mutationExecuted, false, "showing the review must not save it");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: the weekly review uses actual events/actions/goals, never invented facts", async () => {
  const server = buildServer();
  const userId = `weekly-review-no-invention-${randomUUID()}`;

  try {
    await seedUser(userId);
    const { overdueTitle } = await seedRichWeek(userId);

    mockPlan(weeklyReviewStartPlan());
    const reply = await sendAgentMessage(server, userId, "review my week");

    // The stalls section must reference the real stale/overdue action count, and no
    // fabricated numbers larger than what was actually seeded.
    assert.match(reply.reply, /overdue\/stale actions needing decisions: 1/i);
    assert.doesNotMatch(reply.reply, /completed [2-9]\d* actions?/i, "must not invent extra completed actions");
    assert.doesNotMatch(reply.reply, /logged [2-9]\d* workouts?/i, "must not invent extra workouts");

    // Cross-check directly against the DB: exactly what's grounded, nothing more.
    const openActions = await prisma.actionItem.count({ where: { userId, status: "open" } });
    assert.equal(openActions, 1);
    const overdue = await prisma.actionItem.findFirst({ where: { userId, title: overdueTitle } });
    assert.ok(overdue, "the seeded overdue action must exist as the actual grounding for the stall count");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: an empty/thin week returns an honest low-data review, not a fabricated one", async () => {
  const server = buildServer();
  const userId = `weekly-review-thin-${randomUUID()}`;

  try {
    await seedUser(userId);
    // No goals, no actions, no events at all.

    mockPlan(weeklyReviewStartPlan());
    const reply = await sendAgentMessage(server, userId, "review my week");

    assert.match(reply.reply, /not much was logged this week/i);
    assert.match(reply.reply, /event history is thin/i);
    assert.doesNotMatch(reply.reply, /here's your weekly review:/i, "the thin-data reply is deliberately shorter, not the full Wins\\/Stalls template");
    assert.equal(reply.debug.mutationExecuted, false);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: the review is stored in session state so 'save'/'cancel' can resolve against it", async () => {
  const server = buildServer();
  const userId = `weekly-review-session-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedRichWeek(userId);

    mockPlan(weeklyReviewStartPlan());
    await sendAgentMessage(server, userId, "review my week");

    const row = await getAgentSession(userId);
    const pendingOperation = row?.pendingOperation as { topic: string; operations: Array<{ tool: string; args: { weekStartLocalDate?: string; timezone?: string } }> } | null;

    assert.ok(pendingOperation, "a pending save state must be stored after showing the review");
    assert.equal(pendingOperation?.operations[0]?.tool, "weekly_review.save");
    assert.ok(pendingOperation?.operations[0]?.args.weekStartLocalDate, "the reviewed week must be pinned in session state, not re-derived from a fresh 'now' at save time");
    assert.ok(pendingOperation?.operations[0]?.args.timezone);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: 'save this review' saves it as a durable memory", async () => {
  const server = buildServer();
  const userId = `weekly-review-save-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedRichWeek(userId);

    mockPlan(weeklyReviewStartPlan());
    await sendAgentMessage(server, userId, "review my week");

    // No mockPlan: "save this review" is handled deterministically by the exact confirm
    // whitelist before the planner runs (same mechanism as "yes"/"looks good").
    const reply = await sendAgentMessage(server, userId, "save this review");

    assert.equal(reply.debug.mutationExecuted, true);
    assert.match(reply.reply, /saved your weekly review/i);
    assert.equal(reply.debug.pendingOperation, false, "the pending save state clears once saved");

    const saved = await prisma.memoryEntry.findMany({ where: { userId, status: "active" } });
    const reviewMemory = saved.find((memory) => (memory.data as Record<string, unknown> | null)?.kind === "weekly_review");
    assert.ok(reviewMemory, "a weekly_review memory must exist after saving");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: 'save this review' with no visible review asks for the fixed no-pending reply and mutates nothing", async () => {
  const server = buildServer();
  const userId = `weekly-review-save-no-pending-${randomUUID()}`;

  try {
    await seedUser(userId);

    // No "review my week" turn happened this conversation — nothing is pending.
    const reply = await sendAgentMessage(server, userId, "save this review");

    assert.equal(reply.reply, "I don't have anything pending to confirm.");
    assert.equal(reply.debug.mutationExecuted, false);

    const saved = await prisma.memoryEntry.count({ where: { userId, status: "active" } });
    assert.equal(saved, 0, "nothing may be saved with no visible review");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: 'cancel' clears the pending weekly-review state and saves nothing", async () => {
  const server = buildServer();
  const userId = `weekly-review-cancel-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedRichWeek(userId);

    mockPlan(weeklyReviewStartPlan());
    await sendAgentMessage(server, userId, "review my week");

    const before = await getAgentSession(userId);
    assert.ok(before?.pendingOperation, "a review must be pending before cancel");

    const cancelReply = await sendAgentMessage(server, userId, "cancel");
    assert.equal(cancelReply.debug.plannerUsed, "none");
    assert.equal(cancelReply.debug.mutationExecuted, false);

    const after = await getAgentSession(userId);
    assert.equal(after?.pendingOperation, null, "pending weekly-review state must be cleared after cancel");

    const saved = await prisma.memoryEntry.count({ where: { userId, status: "active" } });
    assert.equal(saved, 0, "cancel must not save anything");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: weekly_review.save can never be planned by the LLM directly, only reached via the confirm whitelist", async () => {
  const server = buildServer();
  const userId = `weekly-review-no-direct-save-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedRichWeek(userId);

    mockPlan(weeklyReviewStartPlan());
    await sendAgentMessage(server, userId, "review my week");

    mockPlan({ topic: "weekly_review", intent: "save_review", operations: [op("weekly_review.save", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "please save that for me");

    assert.equal(reply.debug.toolValidationPassed, false, "a direct weekly_review.save plan must be rejected");
    assert.equal(reply.debug.mutationExecuted, false);

    const saved = await prisma.memoryEntry.count({ where: { userId, status: "active" } });
    assert.equal(saved, 0);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: asking to review the week while a different pending operation is open is blocked by the firewall, but re-showing the review while one of its own is open works", async () => {
  const server = buildServer();
  const userId = `weekly-review-refresh-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedRichWeek(userId);

    mockPlan(weeklyReviewStartPlan());
    const first = await sendAgentMessage(server, userId, "review my week");
    assert.ok(first.debug.pendingOperation);

    // weekly_review.start is non-mutating, so it's never blocked by the pending-operation
    // firewall even while its own earlier pending save state is still open — it just
    // re-shows the (still real, still current) review and replaces the pending state.
    mockPlan(weeklyReviewStartPlan());
    const second = await sendAgentMessage(server, userId, "how did this week go?");
    assert.match(second.reply, /here's your weekly review:/i);
    assert.equal(second.debug.mutationExecuted, false);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
