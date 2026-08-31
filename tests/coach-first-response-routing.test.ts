import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createActionItem, prisma } from "../packages/db/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, mockNow, mockPlan, op, sendAgentMessage, seedUser } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * fix/private-alpha-coach-first-response-routing: the exact live transcript this fix closes —
 * "I rested this weekend with friends, is that okay?" got a real coaching answer, but the very
 * next turn, "I'll try to send CVs tonight and more this week" (a soft, hedged intention
 * continuing the SAME conversation, never a command), got "Action rescheduled: Send 3 CVs due:
 * 31/08/2026, 20:00" instead of a coaching reply that anchors the already-due action without
 * touching it. Every test here deliberately mocks the planner supplying a mutation op alongside a
 * genuine coaching-shaped replyDraft (exactly what a real planner mistake looks like) and asserts
 * the deterministic backstop in runtime.ts (applyCoachFirstResponseRouting, response-mode.ts)
 * drops the mutation before validation, leaving the planner's own real reply as the shown text and
 * the DB completely untouched — while an explicit, unambiguous instruction still mutates normally.
 */

function reschedulePlan(actionId: string, dueText: string, replyDraft: string) {
  return {
    topic: "actions",
    intent: "reschedule",
    operations: [op("action.reschedule", { actionId, dueText })],
    needsClarification: false,
    clarificationQuestion: null,
    replyDraft
  };
}

async function makeActionVisible(server: ReturnType<typeof buildServer>, userId: string): Promise<void> {
  mockPlan({ topic: "actions", intent: "list_actions", operations: [op("action.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
  const reply = await sendAgentMessage(server, userId, "show me my actions");
  assert.ok(reply.reply, "test setup: listing actions must succeed");
}

test("A. 'I rested this weekend with friends, is that okay?' answers as a coach, no mutation", async () => {
  const server = buildServer();
  const userId = `coach-first-a-${randomUUID()}`;
  try {
    await seedUser(userId);
    const action = await createActionItem(userId, { source: "manual", title: "Send 3 CVs", priority: "high", dueAt: new Date("2026-08-31T23:59:00.000Z") });
    await makeActionVisible(server, userId);

    const coachingReply = "Resting and spending time with friends is absolutely okay! It's important to take breaks and recharge.";
    mockPlan(reschedulePlan(action.id, "tonight", coachingReply));
    const reply = await sendAgentMessage(server, userId, "I rested this weekend with friends, is that okay?");

    assert.equal(reply.reply, coachingReply);
    assert.equal(reply.debug.mutationExecuted, false);
    const updated = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(updated?.dueAt?.toISOString(), "2026-08-31T23:59:00.000Z");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("B/C/D. immediately after, 'I'll try to send CVs tonight and more this week' gets a coaching/planning answer that anchors the existing action, no mutation, due date untouched", async () => {
  const server = buildServer();
  const userId = `coach-first-bcd-${randomUUID()}`;
  try {
    await seedUser(userId);
    const action = await createActionItem(userId, { source: "manual", title: "Send 3 CVs", priority: "high", dueAt: new Date("2026-08-31T23:59:00.000Z") });
    await makeActionVisible(server, userId);

    mockPlan(reschedulePlan(action.id, "tonight", "Resting and spending time with friends is absolutely okay! It's important to take breaks and recharge."));
    await sendAgentMessage(server, userId, "I rested this weekend with friends, is that okay?");

    const anchoredReply =
      'That sounds okay — a weekend reset is not wasted. You already have "Send 3 CVs" due today. Keep that as the anchor: just send one tonight if you can, then continue tomorrow.';
    mockPlan(reschedulePlan(action.id, "tonight", anchoredReply));
    const reply = await sendAgentMessage(server, userId, "I'll try to send CVs tonight and more this week");

    // D: the reply anchors the existing action by name...
    assert.match(reply.reply, /send 3 cvs/i, `expected the existing action to be named as the anchor — got: ${reply.reply}`);
    // B: ...but never with a mechanical mutation receipt...
    assert.doesNotMatch(reply.reply, /action rescheduled|due:\s*31\/08\/2026/i);
    assert.equal(reply.debug.mutationExecuted, false, "a soft intention must never silently mutate");
    // C: ...and the due date is byte-for-byte unchanged.
    const updated = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(updated?.dueAt?.toISOString(), "2026-08-31T23:59:00.000Z", "the action due today must remain completely unchanged");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("E. explicit 'move it to tonight at 20:00' still mutates", async () => {
  const server = buildServer();
  const userId = `coach-first-e-${randomUUID()}`;
  try {
    await seedUser(userId);
    await prisma.notificationSettings.create({ data: { userId, timezone: "Europe/Madrid" } });
    // fix/private-alpha-conversation-kernel-context-routing (flake fix): "tonight at 20:00" is only
    // in the future if the suite happens to run before 20:00 Europe/Madrid — pin `now` to a fixed
    // instant well before that (12:00 Madrid) so this test is deterministic at any real wall-clock
    // hour. See the dedicated after-20:00 test below for the case where the target time has passed.
    mockNow("2026-08-31T10:00:00.000Z"); // 12:00 Europe/Madrid (CEST, UTC+2)
    const action = await createActionItem(userId, { source: "manual", title: "Send 3 CVs", priority: "high" });
    await makeActionVisible(server, userId);

    mockPlan(reschedulePlan(action.id, "tonight at 20:00", "Moved it to tonight at 20:00."));
    const reply = await sendAgentMessage(server, userId, "move it to tonight at 20:00");

    assert.equal(reply.debug.mutationExecuted, true, "an explicit, unambiguous instruction must still mutate");
    const updated = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.ok(updated?.dueAt);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("E2. after 20:00 Europe/Madrid, 'move it to tonight at 20:00' is rejected, not silently scheduled into the past", async () => {
  const server = buildServer();
  const userId = `coach-first-e2-${randomUUID()}`;
  try {
    await seedUser(userId);
    await prisma.notificationSettings.create({ data: { userId, timezone: "Europe/Madrid" } });
    // Pin `now` PAST the target hour (21:00 Europe/Madrid) — "tonight at 20:00" is now an explicit
    // time that has already passed today. The product rule (packages/core/src/action-intake.ts,
    // pastExplicitDateResult / invalidReason "past_explicit_time") deliberately refuses to silently
    // schedule an explicit time into the past; the executor surfaces that as a failed operation with
    // a clarification instead of a phantom "rescheduled" mutation. This is the safest of the three
    // candidate behaviors (ask / roll to tomorrow / reject) since it never guesses the user's intent.
    mockNow("2026-08-31T19:00:00.000Z"); // 21:00 Europe/Madrid (CEST, UTC+2)
    const action = await createActionItem(userId, { source: "manual", title: "Send 3 CVs", priority: "high" });
    await makeActionVisible(server, userId);

    mockPlan(reschedulePlan(action.id, "tonight at 20:00", "Moved it to tonight at 20:00."));
    const reply = await sendAgentMessage(server, userId, "move it to tonight at 20:00");

    assert.equal(reply.debug.mutationExecuted, false, "an explicit time that has already passed today must never silently mutate");
    assert.match(reply.reply, /couldn't understand|understand the new due time/i);
    const updated = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(updated?.dueAt, null, "the action must stay untouched, not silently scheduled into the past");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("F. explicit 'reschedule it to tomorrow' still mutates", async () => {
  const server = buildServer();
  const userId = `coach-first-f-${randomUUID()}`;
  try {
    await seedUser(userId);
    const action = await createActionItem(userId, { source: "manual", title: "Send 3 CVs", priority: "high" });
    await makeActionVisible(server, userId);

    mockPlan(reschedulePlan(action.id, "tomorrow", "Moved it to tomorrow."));
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

test("G. 'I'll try tonight' with an action due tomorrow asks whether to move it, no mutation", async () => {
  const server = buildServer();
  const userId = `coach-first-g-${randomUUID()}`;
  try {
    await seedUser(userId);
    const action = await createActionItem(userId, { source: "manual", title: "Send 3 CVs", priority: "high", dueAt: new Date(Date.now() + 24 * 60 * 60 * 1000) });
    await makeActionVisible(server, userId);

    const offerReply = 'You already have "Send 3 CVs" due tomorrow. Want me to move it to tonight instead, or leave it for tomorrow?';
    mockPlan(reschedulePlan(action.id, "tonight", offerReply));
    const reply = await sendAgentMessage(server, userId, "I'll try tonight");

    assert.equal(reply.debug.mutationExecuted, false);
    assert.match(reply.reply, /tonight|tomorrow/i);
    const updated = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(updated?.dueAt?.getTime(), action.dueAt?.getTime(), "must not silently move it just because tonight was mentioned");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("H. planner emits action.reschedule for a soft-intention message — stripped before it can execute", async () => {
  const server = buildServer();
  const userId = `coach-first-h-${randomUUID()}`;
  try {
    await seedUser(userId);
    const action = await createActionItem(userId, { source: "manual", title: "Send 3 CVs", priority: "high" });
    await makeActionVisible(server, userId);

    mockPlan(reschedulePlan(action.id, "this week", "No pressure — this week works. What's one small step for today?"));
    const reply = await sendAgentMessage(server, userId, "hopefully I'll get to it this week");

    assert.equal(reply.debug.toolValidationPassed, true, "stripping the op cleanly must never itself look like a validation failure");
    assert.equal(reply.debug.mutationExecuted, false);
    assert.equal(reply.operationsExecuted.length, 0, "no operation should have executed at all, not even a failed one");
    const updated = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(updated?.dueAt, null);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("I. Spanish 'intentaré enviar CVs esta noche y más esta semana' does not mutate", async () => {
  const server = buildServer();
  const userId = `coach-first-i-${randomUUID()}`;
  try {
    await seedUser(userId);
    const action = await createActionItem(userId, { source: "manual", title: "Enviar CVs", priority: "high" });
    await makeActionVisible(server, userId);

    mockPlan(reschedulePlan(action.id, "esta noche", "Suena bien — ya tienes 'Enviar CVs' pendiente. ¿Empezamos con uno esta noche?"));
    const reply = await sendAgentMessage(server, userId, "intentaré enviar CVs esta noche y más esta semana");

    assert.equal(reply.debug.mutationExecuted, false);
    const updated = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(updated?.dueAt, null);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("J. Catalan 'intentaré enviar CVs aquesta nit i més aquesta setmana' does not mutate", async () => {
  const server = buildServer();
  const userId = `coach-first-j-${randomUUID()}`;
  try {
    await seedUser(userId);
    const action = await createActionItem(userId, { source: "manual", title: "Enviar CVs", priority: "high" });
    await makeActionVisible(server, userId);

    mockPlan(reschedulePlan(action.id, "aquesta nit", "Sona bé — ja tens 'Enviar CVs' pendent. Comencem per un aquesta nit?"));
    const reply = await sendAgentMessage(server, userId, "intentaré enviar CVs aquesta nit i més aquesta setmana");

    assert.equal(reply.debug.mutationExecuted, false);
    const updated = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(updated?.dueAt, null);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("supplementary: an explicit reschedule that would TIGHTEN an already-due deadline needs its own confirmation, never applies silently", async () => {
  const server = buildServer();
  const userId = `coach-first-stricter-${randomUUID()}`;
  try {
    await seedUser(userId);
    await prisma.notificationSettings.create({ data: { userId, timezone: "Europe/Madrid" } });
    // fix/private-alpha-conversation-kernel-context-routing (flake fix): "today at 18:00" is only
    // in the future — and only earlier than the action's 23:59 deadline — if the suite happens to
    // run before 18:00 Europe/Madrid. Pin `now` so this is deterministic at any real wall-clock hour.
    mockNow("2026-08-31T10:00:00.000Z"); // 12:00 Europe/Madrid (CEST, UTC+2)
    const action = await createActionItem(userId, { source: "manual", title: "Send 3 CVs", priority: "high", dueAt: new Date("2026-08-31T23:59:00.000Z") });
    await makeActionVisible(server, userId);

    mockPlan(reschedulePlan(action.id, "today at 18:00", "Moved it earlier to 18:00."));
    const reply = await sendAgentMessage(server, userId, "actually move it to 18:00 today, earlier than planned");

    assert.equal(reply.debug.mutationExecuted, false, "tightening a deadline must never apply silently, even for an explicit command");
    assert.equal(reply.debug.pendingOperation, true, "a real confirmation must open");
    assert.match(reply.reply, /earlier/i);
    const untouched = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(untouched?.dueAt?.toISOString(), "2026-08-31T23:59:00.000Z");

    const confirmed = await sendAgentMessage(server, userId, "yes");
    assert.equal(confirmed.debug.mutationExecuted, true, "confirming must actually apply the tightened deadline");
    const applied = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.ok(applied?.dueAt && applied.dueAt.getTime() < untouched!.dueAt!.getTime());
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("K. stricter-deadline guard (a): due tomorrow 23:59, 'move it to tomorrow 20:00' tightens — needs confirmation", async () => {
  const server = buildServer();
  const userId = `coach-first-stricter-a-${randomUUID()}`;
  try {
    await seedUser(userId);
    await prisma.notificationSettings.create({ data: { userId, timezone: "Europe/Madrid" } });
    mockNow("2026-08-31T10:00:00.000Z"); // 12:00 Europe/Madrid (CEST, UTC+2)
    const action = await createActionItem(userId, {
      source: "manual",
      title: "Send 3 CVs",
      priority: "high",
      dueAt: new Date("2026-09-01T21:59:00.000Z") // tomorrow 23:59 Europe/Madrid
    });
    await makeActionVisible(server, userId);

    mockPlan(reschedulePlan(action.id, "tomorrow at 20:00", "Moved it to tomorrow 20:00."));
    const reply = await sendAgentMessage(server, userId, "move it to tomorrow at 20:00");

    assert.equal(reply.debug.mutationExecuted, false, "moving a deadline earlier must require confirmation");
    assert.equal(reply.debug.pendingOperation, true);
    const untouched = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(untouched?.dueAt?.toISOString(), "2026-09-01T21:59:00.000Z");

    const confirmed = await sendAgentMessage(server, userId, "yes");
    assert.equal(confirmed.debug.mutationExecuted, true, "confirming must apply the tightened deadline");
    const applied = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.ok(applied?.dueAt && applied.dueAt.getTime() < untouched!.dueAt!.getTime());
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("L. stricter-deadline guard (b): due tomorrow 09:00, 'move it to tomorrow 23:59' loosens — applies without confirmation", async () => {
  const server = buildServer();
  const userId = `coach-first-stricter-b-${randomUUID()}`;
  try {
    await seedUser(userId);
    await prisma.notificationSettings.create({ data: { userId, timezone: "Europe/Madrid" } });
    mockNow("2026-08-31T10:00:00.000Z"); // 12:00 Europe/Madrid (CEST, UTC+2)
    const action = await createActionItem(userId, {
      source: "manual",
      title: "Send 3 CVs",
      priority: "high",
      dueAt: new Date("2026-09-01T07:00:00.000Z") // tomorrow 09:00 Europe/Madrid
    });
    await makeActionVisible(server, userId);

    mockPlan(reschedulePlan(action.id, "tomorrow at 23:59", "Moved it to tomorrow 23:59."));
    const reply = await sendAgentMessage(server, userId, "move it to tomorrow at 23:59");

    assert.equal(reply.debug.mutationExecuted, true, "moving a deadline later must apply immediately, no confirmation needed");
    assert.equal(reply.debug.pendingOperation, false);
    const applied = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(applied?.dueAt?.toISOString(), "2026-09-01T21:59:00.000Z");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
