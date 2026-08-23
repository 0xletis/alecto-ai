import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createGoal, prisma } from "../packages/db/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, mockPlan, op, sendAgentMessage, seedUser } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * fix/private-alpha-known-gaps, task 2: a bare, contextless question about whether something
 * counts toward a goal ("does this count?", "esto cuenta?", "això compta?") must never itself log
 * evidence, even if a bad planner call proposes goal.log_evidence for it — validator.ts's
 * looksLikeBareEvidenceCountQuestion guard blocks this deterministically, regardless of what
 * signalKey/eventType/count the planner supplied. Each test here mocks the planner to return
 * exactly the kind of call a real (bad) planner produced in a live eval run — the point is to
 * prove the VALIDATOR catches it, not to depend on the real model's own judgment.
 */

async function seedReadingGoal(userId: string) {
  const result = await createGoal(userId, {
    title: "Read more books",
    category: "learning",
    targetMetrics: [{ key: "reading_minutes", label: "reading minutes", signalKey: "reading_minutes", aggregation: "sum", window: "daily" }]
  });
  if (result.duplicate) throw new Error("unexpected duplicate goal in test setup");
  return result.goal;
}

function logEvidencePlan(args: Record<string, unknown>) {
  return {
    topic: "goal_evidence",
    intent: "log_evidence",
    operations: [op("goal.log_evidence", args)],
    needsClarification: false,
    clarificationQuestion: null,
    replyDraft: "Logged."
  };
}

async function runGuardCase(message: string, args: Record<string, unknown>) {
  const server = buildServer();
  const userId = `evidence-question-guard-${randomUUID()}`;

  try {
    await seedUser(userId);
    const goal = await seedReadingGoal(userId);

    mockPlan(logEvidencePlan(args));
    const response = await sendAgentMessage(server, userId, message);

    const events = await prisma.event.count({ where: { userId } });
    return { reply: response.reply, events, goal };
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
}

test("A. Catalan 'això compta pel meu objectiu?' creates no evidence, even when the planner proposes goal.log_evidence", async () => {
  const { reply, events } = await runGuardCase("això compta pel meu objectiu?", { signalKey: "reading_minutes", count: 1 });

  assert.equal(events, 0, "a bare 'does this count' question must never log evidence");
  assert.match(reply, /tell me plainly what you did/i);
});

test("B. Spanish 'esto cuenta para mi objetivo?' creates no evidence", async () => {
  const { reply, events } = await runGuardCase("esto cuenta para mi objetivo?", { signalKey: "reading_minutes", count: 1 });

  assert.equal(events, 0);
  assert.match(reply, /tell me plainly what you did/i);
});

test("C. English 'does this count toward my goal?' creates no evidence", async () => {
  const { reply, events } = await runGuardCase("does this count toward my goal?", { signalKey: "reading_minutes", count: 1 });

  assert.equal(events, 0);
  assert.match(reply, /tell me plainly what you did/i);
});

test("D. 'is this enough for today?' creates no evidence", async () => {
  const { reply, events } = await runGuardCase("is this enough for today?", { signalKey: "reading_minutes", count: 1 });

  assert.equal(events, 0);
  assert.match(reply, /tell me plainly what you did/i);
});

test("E. 'I read 20 minutes today' still logs evidence — a real, unambiguous progress statement with no question is unaffected by the guard", async () => {
  const server = buildServer();
  const userId = `evidence-question-guard-e-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedReadingGoal(userId);

    mockPlan(logEvidencePlan({ signalKey: "reading_minutes", count: 1, notes: "20 minutes of reading today." }));
    const response = await sendAgentMessage(server, userId, "I read 20 minutes today");

    const events = await prisma.event.count({ where: { userId } });
    assert.equal(events, 1, "a real progress statement with no question must still log normally");
    assert.doesNotMatch(response.reply, /tell me plainly what you did/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("F. 'I read 20 minutes, does that count?' asks rather than silently logging — pinned behavior for the evidence-plus-question case", async () => {
  const { reply, events } = await runGuardCase("I read 20 minutes, does that count?", {
    signalKey: "reading_minutes",
    count: 20,
    notes: "20 minutes of reading."
  });

  assert.equal(events, 0, "combining real evidence with an explicit question is still treated as uncertain — the guard asks rather than guesses");
  assert.match(reply, /tell me plainly what you did/i);
});

test("G1. same guard behavior with exactly one active goal", async () => {
  const server = buildServer();
  const userId = `evidence-question-guard-g1-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedReadingGoal(userId);

    mockPlan(logEvidencePlan({ signalKey: "reading_minutes", count: 1 }));
    await sendAgentMessage(server, userId, "does this count toward my goal?");

    const events = await prisma.event.count({ where: { userId } });
    assert.equal(events, 0);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("G2. same guard behavior with multiple active goals — never guesses which goal the question was even about", async () => {
  const server = buildServer();
  const userId = `evidence-question-guard-g2-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedReadingGoal(userId);
    const jobResult = await createGoal(userId, { title: "Find a new developer job", category: "career", templateId: "career.job_search" });
    if (jobResult.duplicate) throw new Error("unexpected duplicate goal in test setup");

    mockPlan(logEvidencePlan({ signalKey: "reading_minutes", count: 1, goalRef: "reading" }));
    await sendAgentMessage(server, userId, "does this count toward my goal?");

    const events = await prisma.event.count({ where: { userId } });
    assert.equal(events, 0, "the guard blocks before any goal-attribution logic even runs, so multiple active goals change nothing");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("H. no pending confirmation is incorrectly cleared or created by a blocked evidence question", async () => {
  const server = buildServer();
  const userId = `evidence-question-guard-h-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedReadingGoal(userId);

    mockPlan(logEvidencePlan({ signalKey: "reading_minutes", count: 1 }));
    const reply = await sendAgentMessage(server, userId, "does this count toward my goal?");

    assert.equal(reply.needsConfirmation, false, "a blocked evidence question must never open a pending confirmation");
    assert.equal(reply.debug.pendingOperation, false);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
