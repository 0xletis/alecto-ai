import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createActionItem, prisma } from "../packages/db/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, mockPlan, op, sendAgentMessage, seedUser } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * fix/private-alpha-live-action-and-coaching-regressions (Task 6): a real Telegram transcript
 * found "Is it okay? About the weekend thing" — a reflective question about whether a rest
 * weekend was fine — answered with a mechanical "Action rescheduled: Send 3 CVs due:
 * 31/08/2026, 23:59" instead of the coaching answer the question actually asked for. Every test
 * here deliberately mocks the planner supplying a mutation op alongside a genuine coaching-shaped
 * replyDraft (exactly what a real planner mistake looks like) and asserts the deterministic
 * backstop in runtime.ts (dropMutationOpsForCoachingJudgmentQuestion) drops the mutation before
 * validation, leaving the planner's own real coaching text as the reply and the DB untouched.
 */

function reschedulePlanWithCoachingDraft(actionId: string, replyDraft: string) {
  return {
    topic: "actions",
    intent: "reschedule",
    operations: [op("action.reschedule", { actionId, dueText: "tomorrow" })],
    needsClarification: false,
    clarificationQuestion: null,
    replyDraft
  };
}

// Puts the action into context.session.visibleEntities first (a real "show me my actions" turn)
// so a later directly-supplied actionId for a bare "move it"-shaped message is trusted with no
// title-grounding check — validator.ts's own rule for "exactly one action visible, id matches".
// Mirrors how a real conversation actually reaches this shape (list, then act on what's shown).
async function makeActionVisible(server: ReturnType<typeof buildServer>, userId: string): Promise<void> {
  mockPlan({ topic: "actions", intent: "list_actions", operations: [op("action.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
  const reply = await sendAgentMessage(server, userId, "show me my actions");
  assert.ok(reply.reply, "test setup: listing actions must succeed");
}

test("A. 'Is it okay? About the weekend thing' answers as a coach, never a mechanical reschedule confirmation", async () => {
  const server = buildServer();
  const userId = `coaching-a-${randomUUID()}`;
  try {
    await seedUser(userId);
    const action = await createActionItem(userId, { source: "manual", title: "Send 3 CVs", priority: "high", dueAt: new Date(Date.now() + 24 * 60 * 60 * 1000) });

    const coachingReply = "A mindful weekend with friends is worth protecting — that's real rest, not avoidance. No changes made to your tasks.";
    mockPlan(reschedulePlanWithCoachingDraft(action.id, coachingReply));
    const reply = await sendAgentMessage(server, userId, "Is it okay? About the weekend thing");

    assert.equal(reply.reply, coachingReply, `expected the real coaching answer, got: ${reply.reply}`);
    assert.doesNotMatch(reply.reply, /action rescheduled|due:/i, "must never fall back to a mechanical mutation-confirmation line");
    assert.equal(reply.debug.mutationExecuted, false, "a judgment question must never itself mutate anything");

    const updated = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(updated?.dueAt?.getTime(), action.dueAt?.getTime(), "the action's due date must be completely untouched");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("B. Spanish '¿Está bien lo del finde?' gets the same coaching-first treatment", async () => {
  const server = buildServer();
  const userId = `coaching-b-${randomUUID()}`;
  try {
    await seedUser(userId);
    const action = await createActionItem(userId, { source: "manual", title: "Enviar 3 CVs", priority: "high", dueAt: new Date(Date.now() + 24 * 60 * 60 * 1000) });

    const coachingReply = "Un fin de semana tranquilo con amigos está bien — es descanso real.";
    mockPlan(reschedulePlanWithCoachingDraft(action.id, coachingReply));
    const reply = await sendAgentMessage(server, userId, "¿Está bien lo del finde?");

    assert.equal(reply.reply, coachingReply);
    assert.equal(reply.debug.mutationExecuted, false);
    const updated = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(updated?.dueAt?.getTime(), action.dueAt?.getTime());
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("C. Catalan 'Està bé, allò del cap de setmana?' gets the same coaching-first treatment", async () => {
  const server = buildServer();
  const userId = `coaching-c-${randomUUID()}`;
  try {
    await seedUser(userId);
    const action = await createActionItem(userId, { source: "manual", title: "Enviar 3 CVs", priority: "high", dueAt: new Date(Date.now() + 24 * 60 * 60 * 1000) });

    const coachingReply = "Un cap de setmana tranquil amb amics està bé — és descans real.";
    mockPlan(reschedulePlanWithCoachingDraft(action.id, coachingReply));
    const reply = await sendAgentMessage(server, userId, "Està bé, allò del cap de setmana?");

    assert.equal(reply.reply, coachingReply);
    assert.equal(reply.debug.mutationExecuted, false);
    const updated = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(updated?.dueAt?.getTime(), action.dueAt?.getTime());
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("D. an explicit instruction alongside the judgment question still mutates ('is it okay, reschedule it to tomorrow')", async () => {
  const server = buildServer();
  const userId = `coaching-d-${randomUUID()}`;
  try {
    await seedUser(userId);
    const action = await createActionItem(userId, { source: "manual", title: "Send 3 CVs", priority: "high", dueAt: new Date(Date.now() + 24 * 60 * 60 * 1000) });
    await makeActionVisible(server, userId);

    mockPlan(reschedulePlanWithCoachingDraft(action.id, "Sure — moved to tomorrow."));
    const reply = await sendAgentMessage(server, userId, "is it okay if I reschedule it to tomorrow instead?");

    assert.equal(reply.debug.mutationExecuted, true, "an explicit mutation verb alongside the question must still be honored");
    const updated = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.notEqual(updated?.dueAt?.getTime(), action.dueAt?.getTime());
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("E. an ordinary action.reschedule with no judgment-question language is completely unaffected", async () => {
  const server = buildServer();
  const userId = `coaching-e-${randomUUID()}`;
  try {
    await seedUser(userId);
    const action = await createActionItem(userId, { source: "manual", title: "Send 3 CVs", priority: "high", dueAt: new Date(Date.now() + 24 * 60 * 60 * 1000) });
    await makeActionVisible(server, userId);

    mockPlan(reschedulePlanWithCoachingDraft(action.id, "Moved to tomorrow."));
    const reply = await sendAgentMessage(server, userId, "reschedule it to tomorrow");

    assert.equal(reply.debug.mutationExecuted, true);
    const updated = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.notEqual(updated?.dueAt?.getTime(), action.dueAt?.getTime());
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("exact live regression: 'Is it okay? About the weekend thing' never replies with a mechanical mutation line", async () => {
  const server = buildServer();
  const userId = `coaching-live-${randomUUID()}`;
  try {
    await seedUser(userId);
    const action = await createActionItem(userId, { source: "manual", title: "Send 3 CVs", priority: "high", dueAt: new Date("2026-08-31T23:59:00.000Z") });

    mockPlan(reschedulePlanWithCoachingDraft(action.id, "That's a real rest, not avoidance — good call. Want to plan tonight's CV send instead?"));
    const reply = await sendAgentMessage(server, userId, "Is it okay? About the weekend thing");

    assert.doesNotMatch(reply.reply, /action rescheduled|due:\s*31\/08\/2026/i);
    const updated = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(updated?.dueAt?.toISOString(), "2026-08-31T23:59:00.000Z", "due date must stay exactly as it was before this question");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
