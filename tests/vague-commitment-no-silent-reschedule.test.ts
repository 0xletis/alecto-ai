import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createActionItem, prisma } from "../packages/db/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, mockPlan, op, sendAgentMessage, seedUser } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * fix/private-alpha-coach-first-response-routing (originally fix/private-alpha-live-action-and-
 * coaching-regressions, Task 7 — superseded here since the escape valve that guard had is exactly
 * what let a follow-up real bug through): a rambling, mixed-timing weekend update ("...will lock
 * in will try to send some when I get there this night and also lot this week") silently
 * rescheduled an action to "tomorrow 09:00" — the user never actually committed to a time. Every
 * test here deliberately mocks the planner supplying a mutation op with a guessed dueText/
 * untilText (exactly what a real planner mistake looks like for this kind of message) and asserts
 * the deterministic backstop in runtime.ts (applyCoachFirstResponseRouting, via
 * response-mode.ts's SOFT_INTENTION_RE) strips it before it can ever execute, leaving the
 * planner's own real coaching/planning replyDraft as the reply and the action's real schedule
 * completely untouched. Deliberately no "concrete day/time mentioned -> let it through" escape
 * valve — mentioning a time is not the same as commanding a change (see test C).
 */

// Puts the action into context.session.visibleEntities first (a real "show me my actions" turn)
// so a later directly-supplied actionId for a bare "move it"-shaped message is trusted with no
// title-grounding check — validator.ts's own rule for "exactly one action visible, id matches".
// Only needed for tests where VAGUE_COMMITMENT_RE does NOT fire (so the op reaches that trust
// check at all) — mirrors how a real conversation actually reaches this shape.
async function makeActionVisible(server: ReturnType<typeof buildServer>, userId: string): Promise<void> {
  mockPlan({ topic: "actions", intent: "list_actions", operations: [op("action.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
  const reply = await sendAgentMessage(server, userId, "show me my actions");
  assert.ok(reply.reply, "test setup: listing actions must succeed");
}

test("A. the exact live transcript's rambling weekend update never silently reschedules", async () => {
  const server = buildServer();
  const userId = `vague-a-${randomUUID()}`;
  try {
    await seedUser(userId);
    const action = await createActionItem(userId, { source: "manual", title: "Send 3 CVs", priority: "high", dueAt: new Date("2026-08-30T23:59:00.000Z") });

    mockPlan({
      topic: "actions",
      intent: "reschedule",
      operations: [op("action.reschedule", { actionId: action.id, dueText: "tomorrow" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: "Moved it to tomorrow 09:00."
    });
    const reply = await sendAgentMessage(
      server,
      userId,
      "Hey Ive been this weekend doing some mindfulnes w friends, today I will go back to Barcelona and will lock in will try to send some when I get there this night and also lot this week"
    );

    assert.equal(reply.debug.mutationExecuted, false, "a vague, mixed-timing update must never silently mutate the schedule");
    assert.match(reply.reply, /tonight|tomorrow/i, "expected concrete options to be offered instead of a silent guess");
    const updated = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(updated?.dueAt?.toISOString(), "2026-08-30T23:59:00.000Z", "the due date must stay exactly what it was");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("B. \"I'll try to send them this week\" does not silently snooze the action", async () => {
  const server = buildServer();
  const userId = `vague-b-${randomUUID()}`;
  try {
    await seedUser(userId);
    const action = await createActionItem(userId, { source: "manual", title: "Send 3 CVs", priority: "high" });

    mockPlan({
      topic: "actions",
      intent: "snooze",
      operations: [op("action.snooze", { actionId: action.id, untilText: "this week" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: "Snoozed until this week."
    });
    const reply = await sendAgentMessage(server, userId, "I'll try to send them this week");

    assert.equal(reply.debug.mutationExecuted, false);
    const updated = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(updated?.status, "open", "must stay open, never silently snoozed");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("C. mentioning a day alongside vague language still does NOT mutate ('I'll try, maybe Friday works') — mentioning a time is not enough", async () => {
  const server = buildServer();
  const userId = `vague-c-${randomUUID()}`;
  try {
    await seedUser(userId);
    const action = await createActionItem(userId, { source: "manual", title: "Send 3 CVs", priority: "high" });
    await makeActionVisible(server, userId);

    // fix/private-alpha-coach-first-response-routing: the OLD guard (CONCRETE_DAY_OR_TIME_RE) let
    // a message through the moment it mentioned ANY day/time word, even inside an explicitly
    // hedged sentence — that escape valve is exactly what let the real reported bug through
    // ("tonight" alone made a soft-intention message look concrete enough to mutate). Removed:
    // "maybe Friday works" is still just a hedge, not a command, regardless of naming a real day.
    mockPlan({
      topic: "actions",
      intent: "reschedule",
      operations: [op("action.reschedule", { actionId: action.id, dueText: "friday" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: "No rush — Friday could work, or want to lock in something sooner?"
    });
    const reply = await sendAgentMessage(server, userId, "I'll try, maybe Friday works for sending them");

    assert.equal(reply.debug.mutationExecuted, false, "mentioning a day inside a hedge is still not a command");
    const updated = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(updated?.dueAt, null, "must never silently pick Friday just because it was mentioned");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("D. an explicit 'reschedule it to tomorrow' with no vague language is completely unaffected", async () => {
  const server = buildServer();
  const userId = `vague-d-${randomUUID()}`;
  try {
    await seedUser(userId);
    const action = await createActionItem(userId, { source: "manual", title: "Send 3 CVs", priority: "high" });
    await makeActionVisible(server, userId);

    mockPlan({
      topic: "actions",
      intent: "reschedule",
      operations: [op("action.reschedule", { actionId: action.id, dueText: "tomorrow" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: "Moved it to tomorrow."
    });
    const reply = await sendAgentMessage(server, userId, "reschedule it to tomorrow");

    assert.equal(reply.debug.mutationExecuted, true);
    const updated = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.ok(updated?.dueAt);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("E. Spanish/Catalan vague-commitment phrasing also blocks a silent snooze", async () => {
  const server = buildServer();
  const userId = `vague-e-${randomUUID()}`;
  try {
    await seedUser(userId);
    const action = await createActionItem(userId, { source: "manual", title: "Enviar 3 CVs", priority: "high" });

    mockPlan({
      topic: "actions",
      intent: "snooze",
      operations: [op("action.snooze", { actionId: action.id, untilText: "this week" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: "Snoozed until this week."
    });
    const reply = await sendAgentMessage(server, userId, "cuando llegue voy a intentarlo, ya vere esta semana");

    assert.equal(reply.debug.mutationExecuted, false);
    const updated = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(updated?.status, "open");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
