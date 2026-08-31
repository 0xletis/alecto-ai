import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createActionItem, prisma, snoozeActionItem } from "../packages/db/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, mockNow, mockPlan, op, sendAgentMessage, seedUser } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * fix/private-alpha-remove-user-facing-action-snooze: dedicated, explicit coverage for the
 * product decision this branch implements — Alecto actions are commitments with exactly three
 * states (open, completed, archived), never a hidden "snoozed"/"deferred" state reachable from a
 * normal chat command. Root cause of the real reported transcript ("move it to tomorrow 20:00"
 * making an action vanish from every list) was two-fold: (1) the deterministic bare-pronoun
 * shortcut in runtime.ts (actionCompletionShortcutOperation) built an action.snooze operation for
 * "move it"/"bring it back"/"remind me tomorrow"/etc., and (2) the planner's own tool-catalog.ts
 * description explicitly instructed the LLM to do the same for messages carrying a digit (so the
 * shortcut doesn't intercept them). Both now build action.reschedule instead, which was already
 * implemented correctly (rescheduleActionItem always sets status "open"). action.snooze itself is
 * removed from the planner's tool catalog entirely and its executor case is kept only as a
 * defense-in-depth alias to the same open-keeping behavior, never creating "snoozed" state.
 *
 * Structured to mirror the task's own lettered lists directly: Task 2 (user-facing action model),
 * Task 3 (re-routing snooze-like language), Task 6 (copy), Task 8 (the exact live regression).
 */

const FIXED_NOW = new Date("2026-09-01T10:00:00.000Z"); // 12:00 Europe/Madrid (CEST, UTC+2)

async function seedMadridUser(userId: string): Promise<void> {
  await seedUser(userId);
  await prisma.notificationSettings.create({ data: { userId, timezone: "Europe/Madrid" } });
}

function actionListPlan(args: Record<string, unknown> = {}) {
  return { topic: "actions", intent: "list_actions", operations: [op("action.list", args)], needsClarification: false, clarificationQuestion: null, replyDraft: "" };
}

// --- Task 2: user-facing action model ------------------------------------------------------------

test("2A: a moved action remains open", async () => {
  const server = buildServer();
  const userId = `snooze-removal-2a-${randomUUID()}`;
  try {
    await seedMadridUser(userId);
    mockNow(FIXED_NOW.toISOString());
    const action = await createActionItem(userId, { source: "manual", title: "Send 10 CVs", priority: "high", dueAt: new Date("2026-09-02T07:00:00.000Z") });

    mockPlan(actionListPlan());
    await sendAgentMessage(server, userId, "show me my actions");

    // Contains a digit ("20:00"), so this reaches the real planner rather than the bare-pronoun
    // deterministic shortcut — mocked to the exact operation the new tool-catalog.ts description
    // asks the planner to emit for this phrasing.
    mockPlan({ topic: "actions", intent: "reschedule", operations: [op("action.reschedule", { actionId: action.id, dueText: "tomorrow at 20:00" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "move it to tomorrow 20:00 so i have more time to do it");
    assert.equal(reply.debug.mutationExecuted, true);

    const updated = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(updated?.status, "open");
    assert.ok(updated?.dueAt);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2B: a future action remains open", async () => {
  const server = buildServer();
  const userId = `snooze-removal-2b-${randomUUID()}`;
  try {
    await seedMadridUser(userId);
    mockNow(FIXED_NOW.toISOString());
    await createActionItem(userId, { source: "manual", title: "Send 10 CVs", priority: "high", dueAt: new Date("2026-09-05T09:00:00.000Z") });

    mockPlan(actionListPlan());
    const reply = await sendAgentMessage(server, userId, "show me my actions");

    assert.match(reply.reply, /you have 1 open action:/i);
    assert.match(reply.reply, /send 10 cvs/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2C: a tomorrow-due action appears in the tomorrow list", async () => {
  const server = buildServer();
  const userId = `snooze-removal-2c-${randomUUID()}`;
  try {
    await seedMadridUser(userId);
    mockNow(FIXED_NOW.toISOString());
    await createActionItem(userId, { source: "manual", title: "Send 10 CVs", priority: "high", dueAt: new Date("2026-09-02T18:00:00.000Z") });

    mockPlan(actionListPlan({ when: "tomorrow" }));
    const reply = await sendAgentMessage(server, userId, "show me tomorrow's actions");

    assert.match(reply.reply, /send 10 cvs/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2D: a completed action disappears from the open list", async () => {
  const server = buildServer();
  const userId = `snooze-removal-2d-${randomUUID()}`;
  try {
    await seedMadridUser(userId);
    mockNow(FIXED_NOW.toISOString());
    const action = await createActionItem(userId, { source: "manual", title: "Send 10 CVs", priority: "high" });
    await prisma.actionItem.update({ where: { id: action.id }, data: { status: "completed", completedAt: new Date() } });

    mockPlan(actionListPlan());
    const reply = await sendAgentMessage(server, userId, "show me my actions");

    assert.doesNotMatch(reply.reply, /send 10 cvs/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2E: an archived action disappears from the open list", async () => {
  const server = buildServer();
  const userId = `snooze-removal-2e-${randomUUID()}`;
  try {
    await seedMadridUser(userId);
    mockNow(FIXED_NOW.toISOString());
    const action = await createActionItem(userId, { source: "manual", title: "Send 10 CVs", priority: "high" });
    await prisma.actionItem.update({ where: { id: action.id }, data: { status: "archived" } });

    mockPlan(actionListPlan());
    const reply = await sendAgentMessage(server, userId, "show me my actions");

    assert.doesNotMatch(reply.reply, /send 10 cvs/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2F: an existing (legacy) snoozed/deferred action is still visible, not lost", async () => {
  const server = buildServer();
  const userId = `snooze-removal-2f-${randomUUID()}`;
  try {
    await seedMadridUser(userId);
    mockNow(FIXED_NOW.toISOString());
    // No new code path ever creates status "snoozed" anymore — this simulates a real row that
    // existed before this deploy, which must not be lost or hidden from a plain action list.
    const legacy = await createActionItem(userId, { source: "manual", title: "Book flights", priority: "medium" });
    await snoozeActionItem(userId, legacy.id, new Date("2026-09-02T09:00:00.000Z"));

    mockPlan(actionListPlan());
    const reply = await sendAgentMessage(server, userId, "show me my actions");

    assert.match(reply.reply, /book flights/i, "a legacy snoozed row must still surface in a plain action list");
    const stillThere = await prisma.actionItem.findUnique({ where: { id: legacy.id } });
    assert.ok(stillThere, "the row itself must never be deleted");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 3: re-route snooze-like user language to reschedule -------------------------------------

test("3A: 'move it to tomorrow 20:00' -> dueAt tomorrow 20:00, status open", async () => {
  const server = buildServer();
  const userId = `snooze-removal-3a-${randomUUID()}`;
  try {
    await seedMadridUser(userId);
    mockNow(FIXED_NOW.toISOString());
    const action = await createActionItem(userId, { source: "manual", title: "Send 10 CVs", priority: "high", dueAt: new Date("2026-09-02T07:00:00.000Z") });
    mockPlan(actionListPlan());
    await sendAgentMessage(server, userId, "show me my actions");

    // Contains a digit ("20:00"), so this reaches the real planner rather than the bare-pronoun
    // deterministic shortcut.
    mockPlan({ topic: "actions", intent: "reschedule", operations: [op("action.reschedule", { actionId: action.id, dueText: "tomorrow at 20:00" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "move it to tomorrow 20:00");
    assert.equal(reply.debug.mutationExecuted, true);

    const updated = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(updated?.status, "open");
    assert.equal(updated?.dueAt?.toISOString(), "2026-09-02T18:00:00.000Z"); // 20:00 Europe/Madrid (CEST, UTC+2)
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3B: 'bring it back tomorrow' -> dueAt tomorrow 23:59, status open", async () => {
  const server = buildServer();
  const userId = `snooze-removal-3b-${randomUUID()}`;
  try {
    await seedMadridUser(userId);
    mockNow(FIXED_NOW.toISOString());
    const action = await createActionItem(userId, { source: "manual", title: "Send 10 CVs", priority: "high" });
    mockPlan(actionListPlan());
    await sendAgentMessage(server, userId, "show me my actions");

    const reply = await sendAgentMessage(server, userId, "bring it back tomorrow");
    assert.equal(reply.debug.mutationExecuted, true);
    assert.doesNotMatch(reply.reply, /\bbring\b.*\bback\b/i, "the reply itself must never use 'bring back' language");

    const updated = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(updated?.status, "open");
    assert.equal(updated?.dueAt?.toISOString(), "2026-09-02T21:59:00.000Z"); // 23:59 Europe/Madrid (CEST, UTC+2)
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3C: 'remind me tomorrow' keeps the action open (no separate reminder metadata exists yet)", async () => {
  const server = buildServer();
  const userId = `snooze-removal-3c-${randomUUID()}`;
  try {
    await seedMadridUser(userId);
    mockNow(FIXED_NOW.toISOString());
    const action = await createActionItem(userId, { source: "manual", title: "Send 10 CVs", priority: "high" });
    mockPlan(actionListPlan());
    await sendAgentMessage(server, userId, "show me my actions");

    const reply = await sendAgentMessage(server, userId, "remind me tomorrow");
    assert.equal(reply.debug.mutationExecuted, true);

    const updated = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(updated?.status, "open");
    assert.ok(updated?.dueAt);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3D: 'do it later today at 20:00' -> dueAt today 20:00, status open", async () => {
  const server = buildServer();
  const userId = `snooze-removal-3d-${randomUUID()}`;
  try {
    await seedMadridUser(userId);
    mockNow(FIXED_NOW.toISOString()); // 12:00 Europe/Madrid, so 20:00 today is still ahead
    const action = await createActionItem(userId, { source: "manual", title: "Send 10 CVs", priority: "high" });
    mockPlan(actionListPlan());
    await sendAgentMessage(server, userId, "show me my actions");

    // Contains digits ("20:00"), so this reaches the real planner rather than the bare-pronoun
    // shortcut — mocked to the exact operation the new tool-catalog.ts description asks the
    // planner to emit for this phrasing.
    mockPlan({ topic: "actions", intent: "reschedule", operations: [op("action.reschedule", { actionId: action.id, dueText: "today at 20:00" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "do it later today at 20:00");
    assert.equal(reply.debug.mutationExecuted, true);

    const updated = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(updated?.status, "open");
    assert.equal(updated?.dueAt?.toISOString(), "2026-09-01T18:00:00.000Z"); // 20:00 Europe/Madrid today (CEST, UTC+2)
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3E: 'not now, tomorrow' -> dueAt tomorrow 23:59, status open", async () => {
  const server = buildServer();
  const userId = `snooze-removal-3e-${randomUUID()}`;
  try {
    await seedMadridUser(userId);
    mockNow(FIXED_NOW.toISOString());
    const action = await createActionItem(userId, { source: "manual", title: "Send 10 CVs", priority: "high" });
    mockPlan(actionListPlan());
    await sendAgentMessage(server, userId, "show me my actions");

    // "not now, tomorrow" (no "snooze"/"move it"/"remind me" keyword) isn't covered by the
    // bare-pronoun deterministic shortcut's own vocabulary — it reaches the real planner, mocked
    // here to the exact operation the new tool-catalog.ts description asks for.
    mockPlan({ topic: "actions", intent: "reschedule", operations: [op("action.reschedule", { actionId: action.id, dueText: "tomorrow" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "not now, tomorrow");
    assert.equal(reply.debug.mutationExecuted, true);

    const updated = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(updated?.status, "open");
    assert.equal(updated?.dueAt?.toISOString(), "2026-09-02T21:59:00.000Z"); // 23:59 Europe/Madrid (CEST, UTC+2)
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3F: none of the re-routed snooze-like phrases ever make the action disappear from the open list", async () => {
  const server = buildServer();
  const userId = `snooze-removal-3f-${randomUUID()}`;
  try {
    await seedMadridUser(userId);
    mockNow(FIXED_NOW.toISOString());
    const action = await createActionItem(userId, { source: "manual", title: "Send 10 CVs", priority: "high" });
    mockPlan(actionListPlan());
    await sendAgentMessage(server, userId, "show me my actions");

    await sendAgentMessage(server, userId, "do it tomorrow");

    mockPlan(actionListPlan());
    const reply = await sendAgentMessage(server, userId, "show me my actions");

    assert.match(reply.reply, /you have 1 open action:/i);
    assert.match(reply.reply, /send 10 cvs/i);
    const updated = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(updated?.status, "open");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 6: copy ----------------------------------------------------------------------------------

test("6A: move copy says moved/rescheduled", async () => {
  const server = buildServer();
  const userId = `snooze-removal-6a-${randomUUID()}`;
  try {
    await seedMadridUser(userId);
    mockNow(FIXED_NOW.toISOString());
    const action = await createActionItem(userId, { source: "manual", title: "Send 10 CVs", priority: "high" });
    mockPlan(actionListPlan());
    await sendAgentMessage(server, userId, "show me my actions");

    mockPlan({ topic: "actions", intent: "reschedule", operations: [op("action.reschedule", { actionId: action.id, dueText: "tomorrow at 20:00" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "move it to tomorrow 20:00");
    assert.match(reply.reply, /rescheduled/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("6B: no 'bring back' language anywhere for a normal move", async () => {
  const server = buildServer();
  const userId = `snooze-removal-6b-${randomUUID()}`;
  try {
    await seedMadridUser(userId);
    mockNow(FIXED_NOW.toISOString());
    await createActionItem(userId, { source: "manual", title: "Send 10 CVs", priority: "high" });
    mockPlan(actionListPlan());
    await sendAgentMessage(server, userId, "show me my actions");

    const reply = await sendAgentMessage(server, userId, "bring it back tomorrow");
    assert.doesNotMatch(reply.reply, /\bbring\b.*\bback\b/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("6C: list copy is consistent with DB state after a move", async () => {
  const server = buildServer();
  const userId = `snooze-removal-6c-${randomUUID()}`;
  try {
    await seedMadridUser(userId);
    mockNow(FIXED_NOW.toISOString());
    await createActionItem(userId, { source: "manual", title: "Send 10 CVs", priority: "high" });
    mockPlan(actionListPlan());
    await sendAgentMessage(server, userId, "show me my actions");

    await sendAgentMessage(server, userId, "move it to tomorrow 20:00");

    mockPlan(actionListPlan());
    const reply = await sendAgentMessage(server, userId, "show me my actions");

    assert.match(reply.reply, /you have 1 open action:/i);
    assert.doesNotMatch(reply.reply, /you don't have any open actions/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("6D: 'didn't we just move it?' says it's open and due", async () => {
  const server = buildServer();
  const userId = `snooze-removal-6d-${randomUUID()}`;
  try {
    await seedMadridUser(userId);
    mockNow(FIXED_NOW.toISOString());
    await createActionItem(userId, { source: "manual", title: "Send 10 CVs", priority: "high" });
    mockPlan(actionListPlan());
    await sendAgentMessage(server, userId, "show me my actions");

    await sendAgentMessage(server, userId, "move it to tomorrow 20:00");

    mockPlan({ topic: "actions", intent: "list_actions", operations: [op("action.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "didnt we just move my send 10cvs action?");

    assert.match(reply.reply, /open/i);
    assert.match(reply.reply, /tomorrow/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 8: exact live regression -----------------------------------------------------------------

test("8. exact live regression replay: seed due tomorrow 09:00 -> move to tomorrow 20:00 -> stays open and visible everywhere", async () => {
  const server = buildServer();
  const userId = `snooze-removal-8-${randomUUID()}`;
  try {
    await seedMadridUser(userId);
    mockNow(FIXED_NOW.toISOString()); // 12:00 Europe/Madrid on 2026-09-01
    const action = await createActionItem(userId, {
      source: "manual",
      title: "Send 10 CVs",
      priority: "high",
      dueAt: new Date("2026-09-02T07:00:00.000Z") // tomorrow 09:00 Europe/Madrid
    });

    mockPlan(actionListPlan());
    const listBefore = await sendAgentMessage(server, userId, "show me my actions");
    assert.match(listBefore.reply, /send 10 cvs/i);

    // Contains a digit ("20:00"), so this reaches the real planner rather than the bare-pronoun
    // deterministic shortcut — mocked to the exact operation the new tool-catalog.ts description
    // asks the planner to emit for this phrasing.
    mockPlan({ topic: "actions", intent: "reschedule", operations: [op("action.reschedule", { actionId: action.id, dueText: "tomorrow at 20:00" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const moveReply = await sendAgentMessage(server, userId, "move it to tomorrow 20:00 so i have more time to do it");
    assert.equal(moveReply.debug.mutationExecuted, true);
    assert.match(moveReply.reply, /rescheduled/i);
    assert.doesNotMatch(moveReply.reply, /\bbring\b.*\bback\b/i);
    assert.equal(moveReply.debug.pendingOperation, false, "loosening a deadline (09:00 -> 20:00) must never require confirmation");

    const afterMove = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(afterMove?.status, "open");
    assert.equal(afterMove?.dueAt?.toISOString(), "2026-09-02T18:00:00.000Z");

    mockPlan(actionListPlan());
    const listAfter = await sendAgentMessage(server, userId, "show me my actions");
    assert.match(listAfter.reply, /send 10 cvs/i);
    assert.doesNotMatch(listAfter.reply, /you don't have any open actions/i);

    mockPlan(actionListPlan({ when: "tomorrow" }));
    const tomorrowList = await sendAgentMessage(server, userId, "show me tomorrow's actions");
    assert.match(tomorrowList.reply, /send 10 cvs/i);
    assert.doesNotMatch(tomorrowList.reply, /you don't have any open actions/i);

    // No dedicated "didn't we just move it?" recognition exists — this falls back to a normal
    // action.list operation, whose own honest reply already answers the question: still open,
    // still due tomorrow 20:00. The point is the reply is never "You don't have any open actions."
    mockPlan({ topic: "actions", intent: "list_actions", operations: [op("action.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const confirmReply = await sendAgentMessage(server, userId, "didnt we just move my send 10cvs action?");
    assert.match(confirmReply.reply, /open/i);
    assert.match(confirmReply.reply, /tomorrow/i);
    assert.doesNotMatch(confirmReply.reply, /you don't have any open actions/i);

    mockPlan(actionListPlan({ status: "all" }));
    const allList = await sendAgentMessage(server, userId, "show me all my actions");
    assert.match(allList.reply, /send 10 cvs/i);
    const allMatches = allList.reply.match(/send 10 cvs/gi) ?? [];
    assert.equal(allMatches.length, 1, "must be the same action, not a hidden duplicate/second entry");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
