import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { buildServer, clearAgentRuntimeMocks, mockPlan, op, prisma, sendAgentMessage, seedUser, type MockPlan } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * Regression coverage for fix/private-alpha-post-goal-coaching-confirmation — a real Telegram
 * smoke test found the post-goal-creation daily-coaching follow-up ("Want me to turn on the
 * morning brief and evening check-in for this?") was copy-only: it asked a confirmation-shaped
 * question with no real pendingOperation behind it, so the user's next "yes" got "I don't have
 * anything pending to confirm." Root cause: goal.create_apply's own pendingOperationUpdate WAS
 * being installed correctly by applyExecutionSideEffects, but finalizeDeterministicConfirmation
 * unconditionally cleared session.pendingOperation back to null right after — before this fix, no
 * confirmed tool could ever hand off to a new pending operation of its own.
 */

function jobGoalPlan(overrides: Record<string, unknown> = {}): MockPlan["operations"] {
  return [
    op("goal.create_propose", {
      title: "Find a fully remote Web3 developer job",
      category: "career",
      signals: [
        { key: "applications_sent", label: "applications sent", cadence: "daily" },
        { key: "interviews", label: "interviews", cadence: "daily" }
      ],
      firstActions: [],
      ...overrides
    })
  ];
}

test("A/B: goal.create_apply with dailyCoachingInterest opens a real proactive settings pending operation, and an immediate 'yes' applies it", async () => {
  const server = buildServer();
  const userId = `post-goal-coaching-ab-${randomUUID()}`;
  try {
    await seedUser(userId);
    mockPlan({
      topic: "goals",
      intent: "propose_goal_creation",
      operations: jobGoalPlan({ dailyCoachingInterest: true }),
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    await sendAgentMessage(server, userId, "I want to find a remote Web3 dev job, and I want daily motivation");

    const goalConfirm = await sendAgentMessage(server, userId, "yes");
    assert.equal(goalConfirm.debug.mutationExecuted, true);
    assert.equal(goalConfirm.debug.pendingOperation, true, "the follow-up must open a real pending operation");
    assert.ok(await prisma.goal.findFirst({ where: { userId } }), "the goal itself must already be created");

    const settingsBefore = await prisma.notificationSettings.findUnique({ where: { userId } });
    assert.ok(settingsBefore === null || (!settingsBefore.morningBriefEnabled && !settingsBefore.eveningCheckinEnabled));

    const settingsConfirm = await sendAgentMessage(server, userId, "yes");
    assert.equal(settingsConfirm.debug.mutationExecuted, true);
    assert.doesNotMatch(settingsConfirm.reply, /don't have anything pending/i);

    const settingsAfter = await prisma.notificationSettings.findUnique({ where: { userId } });
    assert.equal(settingsAfter?.morningBriefEnabled, true);
    assert.equal(settingsAfter?.eveningCheckinEnabled, true);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("C: 'cancel' after the coaching follow-up cancels the settings proposal without affecting the already-created goal", async () => {
  const server = buildServer();
  const userId = `post-goal-coaching-c-${randomUUID()}`;
  try {
    await seedUser(userId);
    mockPlan({
      topic: "goals",
      intent: "propose_goal_creation",
      operations: jobGoalPlan({ dailyCoachingInterest: true }),
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    await sendAgentMessage(server, userId, "I want to find a remote Web3 dev job, and I want daily motivation");
    await sendAgentMessage(server, userId, "yes");

    const cancelled = await sendAgentMessage(server, userId, "cancel");
    assert.equal(cancelled.debug.pendingOperation, false);

    const goal = await prisma.goal.findFirst({ where: { userId } });
    assert.ok(goal, "the goal must remain created after cancelling the settings follow-up");

    const settings = await prisma.notificationSettings.findUnique({ where: { userId } });
    assert.ok(settings === null || (!settings.morningBriefEnabled && !settings.eveningCheckinEnabled), "cancel must never enable settings");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("D: if morning/evening settings are already both on, no pending operation is opened after goal creation", async () => {
  const server = buildServer();
  const userId = `post-goal-coaching-d-${randomUUID()}`;
  try {
    await seedUser(userId);
    await prisma.notificationSettings.upsert({
      where: { userId },
      update: { morningBriefEnabled: true, eveningCheckinEnabled: true },
      create: { userId, morningBriefEnabled: true, eveningCheckinEnabled: true }
    });

    mockPlan({
      topic: "goals",
      intent: "propose_goal_creation",
      operations: jobGoalPlan({ dailyCoachingInterest: true }),
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    await sendAgentMessage(server, userId, "I want to find a remote Web3 dev job, and I want daily motivation");

    const confirmed = await sendAgentMessage(server, userId, "yes");
    assert.equal(confirmed.debug.mutationExecuted, true);
    assert.equal(confirmed.debug.pendingOperation, false, "no pending operation should open when settings are already fully on");
    assert.match(confirmed.reply, /already on/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("D-b: if only morning brief is already on, the follow-up proposes only the evening check-in", async () => {
  const server = buildServer();
  const userId = `post-goal-coaching-db-${randomUUID()}`;
  try {
    await seedUser(userId);
    await prisma.notificationSettings.upsert({
      where: { userId },
      update: { morningBriefEnabled: true, eveningCheckinEnabled: false },
      create: { userId, morningBriefEnabled: true, eveningCheckinEnabled: false }
    });

    mockPlan({
      topic: "goals",
      intent: "propose_goal_creation",
      operations: jobGoalPlan({ dailyCoachingInterest: true }),
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    await sendAgentMessage(server, userId, "I want to find a remote Web3 dev job, and I want daily motivation");

    const confirmed = await sendAgentMessage(server, userId, "yes");
    assert.equal(confirmed.debug.pendingOperation, true);
    assert.doesNotMatch(confirmed.reply, /morning brief/i, "must not re-propose a moment that's already on");
    assert.match(confirmed.reply, /evening check-in/i);

    const settingsConfirm = await sendAgentMessage(server, userId, "yes");
    const settings = await prisma.notificationSettings.findUnique({ where: { userId } });
    assert.equal(settings?.morningBriefEnabled, true, "must remain on, untouched");
    assert.equal(settings?.eveningCheckinEnabled, true);
    void settingsConfirm;
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("E: no 'I don't have anything pending to confirm' anywhere in the exact live transcript", async () => {
  const server = buildServer();
  const userId = `post-goal-coaching-e-${randomUUID()}`;
  try {
    await seedUser(userId);
    mockPlan({
      topic: "goals",
      intent: "propose_goal_creation",
      operations: jobGoalPlan({ dailyCoachingInterest: true }),
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const t1 = await sendAgentMessage(
      server,
      userId,
      "I want to find a fully remote developer job, ideally in Web3. I don't want a fixed weekly target yet, just track how many CVs I send, recruiter replies, interviews, and conversion from applications to interviews. My resume and web CV are already up to date. I want daily checking and motivation."
    );
    assert.doesNotMatch(t1.reply, /don't have anything pending/i);

    const t2 = await sendAgentMessage(server, userId, "yes");
    assert.doesNotMatch(t2.reply, /don't have anything pending/i);
    assert.equal(t2.debug.pendingOperation, true);

    const t3 = await sendAgentMessage(server, userId, "yes");
    assert.doesNotMatch(t3.reply, /don't have anything pending/i);
    assert.equal(t3.debug.mutationExecuted, true);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 3: explicit bullet-list copy ---------------------------------------------------------

test("copy: the follow-up shows an explicit bullet list, not a bare 'want me to' question", async () => {
  const server = buildServer();
  const userId = `post-goal-coaching-copy-${randomUUID()}`;
  try {
    await seedUser(userId);
    mockPlan({
      topic: "goals",
      intent: "propose_goal_creation",
      operations: jobGoalPlan({ dailyCoachingInterest: true }),
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    await sendAgentMessage(server, userId, "I want to find a remote Web3 dev job, and I want daily motivation");
    const confirmed = await sendAgentMessage(server, userId, "yes");

    assert.match(confirmed.reply, /next: you're about to turn on:/i);
    assert.match(confirmed.reply, /- morning brief/i);
    assert.match(confirmed.reply, /- evening check-in/i);
    assert.doesNotMatch(confirmed.reply, /want me to turn on/i, "the old copy-only phrasing must be gone");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 4: title qualifier preservation (mechanism-level pass-through) -----------------------

test("title preservation: a qualifier the mocked planner includes survives verbatim into the confirmation reply", async () => {
  const server = buildServer();
  const userId = `post-goal-coaching-title-${randomUUID()}`;
  try {
    await seedUser(userId);
    mockPlan({
      topic: "goals",
      intent: "propose_goal_creation",
      operations: jobGoalPlan({ title: "Find a fully remote developer job, ideally in Web3" }),
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "I want to find a fully remote developer job, ideally in Web3");
    assert.match(reply.reply, /web3/i);

    const confirmed = await sendAgentMessage(server, userId, "yes");
    assert.match(confirmed.reply, /web3/i);
    const goal = await prisma.goal.findFirst({ where: { userId } });
    assert.match(goal?.title ?? "", /web3/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 5: conversion wording never overpromises a computed percentage ------------------------

test("conversion wording: no signal or reply text is literally labeled '...Conversion' as if a rate were computed", async () => {
  const server = buildServer();
  const userId = `post-goal-coaching-conversion-${randomUUID()}`;
  try {
    await seedUser(userId);
    mockPlan({
      topic: "goals",
      intent: "propose_goal_creation",
      operations: jobGoalPlan({
        signals: [
          { key: "applications_sent", label: "CVs sent", cadence: "daily" },
          { key: "interviews", label: "interviews", cadence: "daily" }
        ]
      }),
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "I want to find a remote Web3 dev job, track CVs sent conversion to interviews");

    assert.doesNotMatch(reply.reply, /conversion/i, "no label should literally claim a computed 'Conversion' metric");
    assert.match(reply.reply, /cvs sent/i);
    assert.match(reply.reply, /interviews/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
