import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createActionItem, prisma } from "../packages/db/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, mockPlan, op, sendAgentMessage, seedUser } from "./helpers/agent-runtime-test-helpers.ts";

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
