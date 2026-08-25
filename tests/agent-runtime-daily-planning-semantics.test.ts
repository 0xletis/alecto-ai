import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildServer,
  clearAgentRuntimeMocks,
  mockPlan,
  op,
  prisma,
  sendAgentMessage,
  seedUser,
  type MockPlan
} from "./helpers/agent-runtime-test-helpers.ts";

/**
 * Regression coverage for fix/private-alpha-proactive-daily-planning-semantics — a real Telegram
 * smoke test found "add a morning message to motivate me and create some actions every morning"
 * turned into two fake firstActions ("Send a motivational message each morning", "Create action
 * items for the day") — Alecto's own proactive responsibilities, not user todos — and "Okay
 * proceed" repeated the pending proposal instead of confirming it.
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

test("3B/4B/4C: dailyCoachingInterest renders a Daily coaching section, distinct from (and without) a firstActions section", async () => {
  const server = buildServer();
  const userId = `daily-planning-3b-${randomUUID()}`;
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
    const reply = await sendAgentMessage(server, userId, "I want to find a remote Web3 dev job, and I want daily motivation");

    assert.match(reply.reply, /Daily coaching:/);
    assert.match(reply.reply, /morning brief/i);
    assert.match(reply.reply, /evening check-in/i);
    assert.doesNotMatch(reply.reply, /First concrete actions:/, "no firstActions section must appear when firstActions is empty, even with daily coaching requested");
    assert.doesNotMatch(reply.reply, /send a motivational message/i, "must never render Alecto's own responsibility as if it were a task");
    assert.doesNotMatch(reply.reply, /create action items/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3D: daily coaching copy says 'suggest', never claims silent automatic action creation", async () => {
  const server = buildServer();
  const userId = `daily-planning-3d-${randomUUID()}`;
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
    const reply = await sendAgentMessage(server, userId, "I want to find a remote Web3 dev job, and create actions for me every morning");

    assert.match(reply.reply, /suggest/i);
    assert.doesNotMatch(reply.reply, /i (will|'ll) create (new )?actions? (for you )?(automatically|without asking|silently)/i);
    assert.match(reply.reply, /without asking/i, "must be explicit that it won't create actions silently");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4A: 'ideally in Web3' (or equivalent) is preserved verbatim in the proposal, never silently dropped", async () => {
  const server = buildServer();
  const userId = `daily-planning-4a-${randomUUID()}`;
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
    assert.match(reply.reply, /Goal: Find a fully remote developer job, ideally in Web3/);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4D: Gmail copy is truthful — separate 'Gmail:' section, states it cannot send or reply", async () => {
  const server = buildServer();
  const userId = `daily-planning-4d-${randomUUID()}`;
  try {
    await seedUser(userId);
    mockPlan({
      topic: "goals",
      intent: "propose_goal_creation",
      operations: jobGoalPlan({ integrationHint: "If you connect Gmail, I can watch for recruiter replies and application acknowledgements." }),
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "I want to find a remote Web3 dev job, watch Gmail replies");

    assert.match(reply.reply, /Gmail:/);
    assert.match(reply.reply, /i cannot send or reply to emails/i);
    assert.doesNotMatch(reply.reply, /watch gmail replies/i, "the raw request phrase must never appear as a firstAction bullet");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3A: revising a pending goal proposal with a daily-planning request updates it in place, no fake firstActions, still one pending confirmation", async () => {
  const server = buildServer();
  const userId = `daily-planning-3a-${randomUUID()}`;
  try {
    await seedUser(userId);
    mockPlan({ topic: "goals", intent: "propose_goal_creation", operations: jobGoalPlan(), needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "I want to find a remote Web3 dev job");

    mockPlan({
      topic: "goals",
      intent: "propose_goal_creation",
      operations: jobGoalPlan({ dailyCoachingInterest: true }),
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(
      server,
      userId,
      "Can you also add some morning message to motivate me and create some actions every morning for that day?"
    );

    assert.equal(reply.debug.pendingOperation, true);
    assert.match(reply.reply, /Daily coaching:/);
    assert.doesNotMatch(reply.reply, /First concrete actions:/);
    assert.doesNotMatch(reply.reply, /send a motivational message/i);
    assert.doesNotMatch(reply.reply, /create action items/i);

    const goalCount = await prisma.goal.count({ where: { userId } });
    assert.equal(goalCount, 0, "nothing created before confirmation");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("6: after goal creation with dailyCoachingInterest, Alecto offers to enable morning/evening settings — and enables nothing on its own", async () => {
  const server = buildServer();
  const userId = `daily-planning-6-${randomUUID()}`;
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
    assert.equal(confirmed.debug.mutationExecuted, true);
    // fix/private-alpha-post-goal-coaching-confirmation: the follow-up now opens a REAL pending
    // proactive-settings confirmation (not a copy-only question with nothing behind it).
    assert.equal(confirmed.debug.pendingOperation, true, "the follow-up must open a real pending operation, not just ask a question");
    assert.match(confirmed.reply, /morning brief/i);
    assert.match(confirmed.reply, /evening check-in/i);
    assert.match(confirmed.reply, /reply yes to confirm or cancel/i);

    const settings = await prisma.notificationSettings.findUnique({ where: { userId } });
    assert.ok(
      settings === null || (settings.morningBriefEnabled === false && settings.eveningCheckinEnabled === false),
      "the follow-up question must never itself enable proactive settings"
    );
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("6 (already on): if morning+evening are already enabled, the follow-up states that honestly instead of asking again", async () => {
  const server = buildServer();
  const userId = `daily-planning-6b-${randomUUID()}`;
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

    assert.match(confirmed.reply, /already on/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("compound-proposal guard still protects if goal.create_propose and proactive.settings_propose_update are BOTH planned in one turn", async () => {
  const server = buildServer();
  const userId = `daily-planning-compound-${randomUUID()}`;
  try {
    await seedUser(userId);
    const compoundPlan: MockPlan["operations"] = [
      ...jobGoalPlan({ dailyCoachingInterest: true }),
      op("proactive.settings_propose_update", { morningBriefEnabled: true, eveningCheckinEnabled: true })
    ];
    mockPlan({ topic: "goals", intent: "propose_goal_creation", operations: compoundPlan, needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "I want to find a remote Web3 dev job, and I want daily motivation");

    const goalQuestionCount = (reply.reply.match(/want me to create this goal\?/gi) ?? []).length;
    const settingsQuestionCount = (reply.reply.match(/reply yes to confirm or cancel/gi) ?? []).length;
    assert.equal(goalQuestionCount, 1);
    assert.equal(settingsQuestionCount, 0, "only one pending confirmation may open, even if the planner mistakenly plans two");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 5: extended "proceed" confirmation phrases -------------------------------------------

test("5A: 'Okay proceed' confirms a pending goal creation", async () => {
  const server = buildServer();
  const userId = `daily-planning-5a-${randomUUID()}`;
  try {
    await seedUser(userId);
    mockPlan({ topic: "goals", intent: "propose_goal_creation", operations: jobGoalPlan(), needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "I want to find a remote Web3 dev job");

    const confirmed = await sendAgentMessage(server, userId, "Okay proceed");
    assert.equal(confirmed.debug.llmPlannerAttempted, false, "'Okay proceed' must resolve deterministically, not repeat the proposal via the planner");
    assert.equal(confirmed.debug.mutationExecuted, true);
    assert.ok(await prisma.goal.findFirst({ where: { userId } }));
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("5B: bare 'go ahead' confirms a pending proactive settings change", async () => {
  const server = buildServer();
  const userId = `daily-planning-5b-${randomUUID()}`;
  try {
    await seedUser(userId);
    mockPlan({
      topic: "settings",
      intent: "propose_settings",
      operations: [op("proactive.settings_propose_update", { morningBriefEnabled: true })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    await sendAgentMessage(server, userId, "turn on morning briefs");

    const confirmed = await sendAgentMessage(server, userId, "go ahead");
    assert.equal(confirmed.debug.mutationExecuted, true);
    const settings = await prisma.notificationSettings.findUnique({ where: { userId } });
    assert.equal(settings?.morningBriefEnabled, true);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("5C: Spanish/Catalan 'proceed' variants confirm a pending goal creation", async () => {
  const server = buildServer();
  const esUserId = `daily-planning-5c-es-${randomUUID()}`;
  const caUserId = `daily-planning-5c-ca-${randomUUID()}`;
  const caUserId2 = `daily-planning-5c-ca2-${randomUUID()}`;
  try {
    mockPlan({ topic: "goals", intent: "propose_goal_creation", operations: jobGoalPlan(), needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await seedUser(esUserId);
    await sendAgentMessage(server, esUserId, "quiero encontrar un trabajo remoto");
    const esConfirmed = await sendAgentMessage(server, esUserId, "vale procede");
    assert.equal(esConfirmed.debug.mutationExecuted, true, "'vale procede' must confirm");
    assert.ok(await prisma.goal.findFirst({ where: { userId: esUserId } }));

    mockPlan({ topic: "goals", intent: "propose_goal_creation", operations: jobGoalPlan(), needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await seedUser(caUserId);
    await sendAgentMessage(server, caUserId, "vull trobar una feina remota");
    const caConfirmed = await sendAgentMessage(server, caUserId, "d'acord, endavant");
    assert.equal(caConfirmed.debug.mutationExecuted, true, "'d'acord, endavant' must confirm");
    assert.ok(await prisma.goal.findFirst({ where: { userId: caUserId } }));

    mockPlan({ topic: "goals", intent: "propose_goal_creation", operations: jobGoalPlan(), needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await seedUser(caUserId2);
    await sendAgentMessage(server, caUserId2, "vull trobar una feina remota");
    const caConfirmed2 = await sendAgentMessage(server, caUserId2, "adelante");
    assert.equal(caConfirmed2.debug.mutationExecuted, true, "bare 'adelante' must confirm");
    assert.ok(await prisma.goal.findFirst({ where: { userId: caUserId2 } }));
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: { in: [esUserId, caUserId, caUserId2] } } });
  }
});

test("5D: 'proceed but change the target' revises instead of confirming", async () => {
  const server = buildServer();
  const userId = `daily-planning-5d-${randomUUID()}`;
  try {
    await seedUser(userId);
    mockPlan({ topic: "goals", intent: "propose_goal_creation", operations: jobGoalPlan(), needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "I want to find a remote Web3 dev job");

    const revised: MockPlan["operations"] = [op("goal.create_propose", { title: "Find a fully remote Web3 developer job", category: "career", successCriteria: "5 applications per week", signals: [{ key: "applications_sent", label: "applications sent", cadence: "daily" }], firstActions: [] })];
    mockPlan({ topic: "goals", intent: "propose_goal_creation", operations: revised, needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "proceed but change the target to 5 a week");

    assert.equal(reply.debug.llmPlannerAttempted, true, "'proceed but change...' must reach the planner, not confirm deterministically");
    assert.equal(reply.debug.mutationExecuted, false);
    assert.equal(await prisma.goal.count({ where: { userId } }), 0);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("5E: 'proceed' with no pending operation does not mutate anything", async () => {
  const server = buildServer();
  const userId = `daily-planning-5e-${randomUUID()}`;
  try {
    await seedUser(userId);
    const reply = await sendAgentMessage(server, userId, "proceed");

    assert.equal(reply.debug.llmPlannerAttempted, false);
    assert.equal(reply.debug.mutationExecuted, false);
    assert.match(reply.reply, /don't have anything pending/i);
    assert.equal(await prisma.goal.count({ where: { userId } }), 0);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("5E-b: 'proceed with another goal' does not confirm the wrong pending operation", async () => {
  const server = buildServer();
  const userId = `daily-planning-5e-b-${randomUUID()}`;
  try {
    await seedUser(userId);
    mockPlan({ topic: "goals", intent: "propose_goal_creation", operations: jobGoalPlan(), needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "I want to find a remote Web3 dev job");

    mockPlan({ topic: "goals", intent: "clarify", operations: [], needsClarification: true, clarificationQuestion: "Which goal do you mean?", replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "proceed with another goal");

    assert.equal(reply.debug.mutationExecuted, false);
    assert.equal(await prisma.goal.count({ where: { userId } }), 0);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
