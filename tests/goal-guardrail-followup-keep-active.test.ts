import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createGoal, prisma } from "../packages/db/src/index.ts";
import {
  buildServer,
  clearAgentRuntimeMocks,
  mockGuardrail,
  sendAgentMessage,
  seedUser,
  type MockGuardrailClassification
} from "./helpers/agent-runtime-test-helpers.ts";

/**
 * fix/private-alpha-goal-guardrail-followup-keep-active: a real Telegram transcript found "im
 * kiding keep it" — a false-alarm follow-up right after the goal-avoidance guardrail correctly
 * intervened on "quiero dejar este objetivo" — planned as a fresh goal.archive_propose(operation:
 * "pause") by the real LLM planner. Root cause: the guardrail's own early-return never opens a
 * pending operation (confirmed by reading runtime.ts directly), so there was nothing for the
 * existing pending-operation firewall to protect against; the ambiguous "keep it" reply reached
 * the real planner with nothing but recent conversation history to go on, which happened to
 * contain the word "paused" (the guardrail's own coaching reply, "I'd rather you paused here,"
 * meaning "let's pause and reflect," never "pause the goal") — and the model misread it.
 *
 * Fixed with two new deterministic checks in processAgentMessageInner (runtime.ts), both BEFORE
 * the real planner is ever consulted: (1) session.topic === "guardrail" on the immediately
 * preceding turn (no pending operation involved) + keep-language -> a fixed "no changes made"
 * reply; (2) a real, already-open goal_lifecycle pending confirmation (from an explicit "pause
 * this goal"/"archive this goal") + keep-language -> cancels it. Neither ever calls the planner
 * for a message that matches, and an affirmative-opener-plus-keep-language contradiction ("yes
 * keep it") is asked about instead of guessed at either way.
 */

function hostileAvoidanceMock(goalId: string): MockGuardrailClassification {
  return { conflict: "soft_warn", goalId, pattern: "avoidance", clarifyingQuestion: null, reason: "test: real goal-abandonment signal" };
}

async function seedUserWithGoal(userId: string, title = "Find a fully remote developer job", priority: "medium" | "critical" = "medium") {
  await seedUser(userId);
  const goalResult = await createGoal(userId, { title, category: "career", priority });
  if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
  return goalResult.goal;
}

// --- Task 2: guardrail fires, then a false-alarm follow-up must keep the goal active -------------

test("A. guardrail fires on 'I want to quit this goal'", async () => {
  const server = buildServer();
  const userId = `keep-active-2a-${randomUUID()}`;
  try {
    const goal = await seedUserWithGoal(userId);
    mockGuardrail(hostileAvoidanceMock(goal.id));
    const reply = await sendAgentMessage(server, userId, "I want to quit this goal");

    assert.equal(reply.debug.conversationTopic, "guardrail");
    const stillActive = await prisma.goal.findUnique({ where: { id: goal.id } });
    assert.equal(stillActive?.status, "active");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("B. next \"I'm kidding, keep it\" -> no mutation, no pause proposal, goal stays active", async () => {
  const server = buildServer();
  const userId = `keep-active-2b-${randomUUID()}`;
  try {
    const goal = await seedUserWithGoal(userId);
    mockGuardrail(hostileAvoidanceMock(goal.id));
    await sendAgentMessage(server, userId, "I want to quit this goal");

    const reply = await sendAgentMessage(server, userId, "I'm kidding, keep it");

    assert.equal(reply.debug.mutationExecuted, false);
    assert.equal(reply.debug.pendingOperation, false, "must never open a pause/archive confirmation");
    assert.doesNotMatch(reply.reply, /pause|archive/i, "must never propose pausing/archiving in the reply");
    assert.match(reply.reply, /keeping the goal active|no changes made/i);

    const stillActive = await prisma.goal.findUnique({ where: { id: goal.id } });
    assert.equal(stillActive?.status, "active");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("C. next 'no keep it' -> no mutation, goal stays active", async () => {
  const server = buildServer();
  const userId = `keep-active-2c-${randomUUID()}`;
  try {
    const goal = await seedUserWithGoal(userId);
    mockGuardrail(hostileAvoidanceMock(goal.id));
    await sendAgentMessage(server, userId, "I want to quit this goal");

    const reply = await sendAgentMessage(server, userId, "no keep it");

    assert.equal(reply.debug.mutationExecuted, false);
    assert.equal(reply.debug.pendingOperation, false);
    assert.doesNotMatch(reply.reply, /pause|archive/i);
    const stillActive = await prisma.goal.findUnique({ where: { id: goal.id } });
    assert.equal(stillActive?.status, "active");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("D. next 'cancel keep it' -> no mutation, goal stays active", async () => {
  const server = buildServer();
  const userId = `keep-active-2d-${randomUUID()}`;
  try {
    const goal = await seedUserWithGoal(userId);
    mockGuardrail(hostileAvoidanceMock(goal.id));
    await sendAgentMessage(server, userId, "I want to quit this goal");

    const reply = await sendAgentMessage(server, userId, "cancel keep it");

    assert.equal(reply.debug.mutationExecuted, false);
    assert.equal(reply.debug.pendingOperation, false);
    assert.doesNotMatch(reply.reply, /pause|archive/i);
    const stillActive = await prisma.goal.findUnique({ where: { id: goal.id } });
    assert.equal(stillActive?.status, "active");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("E. next Spanish 'era broma, mantenlo' -> no mutation, localized reply, goal stays active", async () => {
  const server = buildServer();
  const userId = `keep-active-2e-${randomUUID()}`;
  try {
    const goal = await seedUserWithGoal(userId);
    mockGuardrail(hostileAvoidanceMock(goal.id));
    await sendAgentMessage(server, userId, "quiero dejar este objetivo");

    const reply = await sendAgentMessage(server, userId, "era broma, mantenlo");

    assert.equal(reply.debug.mutationExecuted, false);
    assert.equal(reply.debug.pendingOperation, false);
    assert.match(reply.reply, /mantengo el objetivo activo/i);
    const stillActive = await prisma.goal.findUnique({ where: { id: goal.id } });
    assert.equal(stillActive?.status, "active");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("F. next Catalan 'era broma, mantén-lo' -> no mutation, localized reply, goal stays active", async () => {
  const server = buildServer();
  const userId = `keep-active-2f-${randomUUID()}`;
  try {
    const goal = await seedUserWithGoal(userId);
    mockGuardrail(hostileAvoidanceMock(goal.id));
    await sendAgentMessage(server, userId, "vull deixar aquest objectiu");

    const reply = await sendAgentMessage(server, userId, "era broma, mantén-lo");

    assert.equal(reply.debug.mutationExecuted, false);
    assert.equal(reply.debug.pendingOperation, false);
    assert.match(reply.reply, /mantinc l'objectiu actiu/i);
    const stillActive = await prisma.goal.findUnique({ where: { id: goal.id } });
    assert.equal(stillActive?.status, "active");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 3: real lifecycle commands must stay fully protected ------------------------------------

test("3A. 'pause this goal' still proposes pause, requires confirmation", async () => {
  const server = buildServer();
  const userId = `keep-active-3a-${randomUUID()}`;
  try {
    const goal = await seedUserWithGoal(userId);
    const reply = await sendAgentMessage(server, userId, `pause my ${goal.title} goal`);

    assert.equal(reply.debug.pendingOperation, true);
    assert.equal(reply.debug.mutationExecuted, false);
    assert.match(reply.reply, /about to pause/i);
    const stillActive = await prisma.goal.findUnique({ where: { id: goal.id } });
    assert.equal(stillActive?.status, "active");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3B. 'archive this goal' (critical) still requires the critical confirmation", async () => {
  const server = buildServer();
  const userId = `keep-active-3b-${randomUUID()}`;
  try {
    const goal = await seedUserWithGoal(userId, "Find a fully remote developer job", "critical");
    const reply = await sendAgentMessage(server, userId, `archive my ${goal.title} goal`);

    assert.equal(reply.debug.pendingOperation, true);
    assert.equal(reply.debug.mutationExecuted, false);
    assert.match(reply.reply, /marked critical/i);
    const stillActive = await prisma.goal.findUnique({ where: { id: goal.id } });
    assert.equal(stillActive?.status, "active");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3C. 'yes' after a real pause confirmation still applies the pause", async () => {
  const server = buildServer();
  const userId = `keep-active-3c-${randomUUID()}`;
  try {
    const goal = await seedUserWithGoal(userId);
    await sendAgentMessage(server, userId, `pause my ${goal.title} goal`);
    const reply = await sendAgentMessage(server, userId, "yes");

    assert.equal(reply.debug.mutationExecuted, true);
    assert.match(reply.reply, /paused/i);
    const paused = await prisma.goal.findUnique({ where: { id: goal.id } });
    assert.equal(paused?.status, "paused");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3D. 'keep it' after a pause confirmation cancels it, never applies the pause", async () => {
  const server = buildServer();
  const userId = `keep-active-3d-${randomUUID()}`;
  try {
    const goal = await seedUserWithGoal(userId);
    await sendAgentMessage(server, userId, `pause my ${goal.title} goal`);
    const reply = await sendAgentMessage(server, userId, "keep it");

    assert.equal(reply.debug.mutationExecuted, false);
    assert.equal(reply.debug.pendingOperation, false);
    assert.doesNotMatch(reply.reply, /paused "/i);
    const stillActive = await prisma.goal.findUnique({ where: { id: goal.id } });
    assert.equal(stillActive?.status, "active");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 4: pending confirmation interaction ------------------------------------------------------

test("4A. pending pause + 'keep it' cancels", async () => {
  const server = buildServer();
  const userId = `keep-active-4a-${randomUUID()}`;
  try {
    const goal = await seedUserWithGoal(userId);
    await sendAgentMessage(server, userId, `pause my ${goal.title} goal`);
    const reply = await sendAgentMessage(server, userId, "keep it");

    assert.equal(reply.debug.pendingOperation, false);
    assert.equal(reply.debug.mutationExecuted, false);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4B. pending archive + 'keep it' cancels", async () => {
  const server = buildServer();
  const userId = `keep-active-4b-${randomUUID()}`;
  try {
    const goal = await seedUserWithGoal(userId);
    await sendAgentMessage(server, userId, `archive my ${goal.title} goal`);
    const reply = await sendAgentMessage(server, userId, "keep it");

    assert.equal(reply.debug.pendingOperation, false);
    assert.equal(reply.debug.mutationExecuted, false);
    const stillActive = await prisma.goal.findUnique({ where: { id: goal.id } });
    assert.equal(stillActive?.status, "active");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4C. pending pause + 'no, keep it' cancels", async () => {
  const server = buildServer();
  const userId = `keep-active-4c-${randomUUID()}`;
  try {
    const goal = await seedUserWithGoal(userId);
    await sendAgentMessage(server, userId, `pause my ${goal.title} goal`);
    const reply = await sendAgentMessage(server, userId, "no, keep it");

    assert.equal(reply.debug.pendingOperation, false);
    assert.equal(reply.debug.mutationExecuted, false);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4D. pending pause + 'yes keep it' asks a clarification, never mutates either way", async () => {
  const server = buildServer();
  const userId = `keep-active-4d-${randomUUID()}`;
  try {
    const goal = await seedUserWithGoal(userId);
    await sendAgentMessage(server, userId, `pause my ${goal.title} goal`);
    const reply = await sendAgentMessage(server, userId, "yes keep it");

    assert.equal(reply.debug.mutationExecuted, false);
    // Deliberately still pending — neither confirmed nor cancelled, since the reply is
    // genuinely self-contradictory and must never be guessed at either way.
    assert.equal(reply.debug.pendingOperation, true);
    assert.match(reply.reply, /\?/, "must be phrased as a real clarifying question");
    const stillActive = await prisma.goal.findUnique({ where: { id: goal.id } });
    assert.equal(stillActive?.status, "active");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4E. after a keep-it cancel, the goal remains active and a later real pause still works", async () => {
  const server = buildServer();
  const userId = `keep-active-4e-${randomUUID()}`;
  try {
    const goal = await seedUserWithGoal(userId);
    await sendAgentMessage(server, userId, `pause my ${goal.title} goal`);
    await sendAgentMessage(server, userId, "keep it");

    const stillActive = await prisma.goal.findUnique({ where: { id: goal.id } });
    assert.equal(stillActive?.status, "active");

    // The cancel must not have left anything in a broken state — a genuine later pause request
    // still opens a normal, fresh confirmation.
    const secondAttempt = await sendAgentMessage(server, userId, `pause my ${goal.title} goal`);
    assert.equal(secondAttempt.debug.pendingOperation, true);
    const confirmed = await sendAgentMessage(server, userId, "yes");
    assert.equal(confirmed.debug.mutationExecuted, true);
    const paused = await prisma.goal.findUnique({ where: { id: goal.id } });
    assert.equal(paused?.status, "paused");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
