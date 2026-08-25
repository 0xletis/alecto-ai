import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildServer,
  clearAgentRuntimeMocks,
  getAgentSession,
  mockPlan,
  op,
  prisma,
  sendAgentMessage,
  seedUser,
  type MockPlan
} from "./helpers/agent-runtime-test-helpers.ts";

/**
 * Regression coverage for fix/private-alpha-goal-action-semantics — a real Railway smoke test
 * after the previous onboarding-flow fix found three more issues: goal proposals still produced
 * vague, evergreen firstActions ("Search job boards"), a single turn could plan BOTH
 * goal.create_propose and proactive.settings_propose_update (only one can ever be the real
 * pendingOperation, so the reply asked two confirmation questions the runtime could only honor
 * one of), and "yes create it" — an unambiguous confirmation — was rejected because only the
 * bare CONFIRM_WHITELIST phrases were recognized.
 */

function jobGoalPlan(): MockPlan["operations"] {
  return [
    op("goal.create_propose", {
      title: "Find a fully remote Web3 developer job",
      category: "career",
      signals: [
        { key: "applications_sent", label: "applications sent", cadence: "daily" },
        { key: "interviews", label: "interviews", cadence: "daily" }
      ],
      firstActions: []
    })
  ];
}

test("3A: goal.create_propose + proactive.settings_propose_update in the same turn does not open two confusing confirmations", async () => {
  const server = buildServer();
  const userId = `goal-action-compound-${randomUUID()}`;
  try {
    await seedUser(userId);

    const compoundPlan: MockPlan["operations"] = [
      ...jobGoalPlan(),
      op("proactive.settings_propose_update", { morningBriefEnabled: true, eveningCheckinEnabled: true })
    ];
    mockPlan({ topic: "goals", intent: "propose_goal_creation", operations: compoundPlan, needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "I want to find a remote Web3 dev job and check on me daily");

    const goalQuestionCount = (reply.reply.match(/want me to create this goal\?/gi) ?? []).length;
    const settingsQuestionCount = (reply.reply.match(/reply yes to confirm or cancel/gi) ?? []).length;
    assert.equal(goalQuestionCount, 1, `expected exactly one goal confirmation question — got: ${reply.reply}`);
    assert.equal(settingsQuestionCount, 0, `the settings proposal must not also open its own confirmation this turn — got: ${reply.reply}`);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3B: pendingOperation topic matches the visible confirmation question after a compound turn", async () => {
  const server = buildServer();
  const userId = `goal-action-compound-topic-${randomUUID()}`;
  try {
    await seedUser(userId);

    const compoundPlan: MockPlan["operations"] = [
      ...jobGoalPlan(),
      op("proactive.settings_propose_update", { morningBriefEnabled: true, eveningCheckinEnabled: true })
    ];
    mockPlan({ topic: "goals", intent: "propose_goal_creation", operations: compoundPlan, needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "I want to find a remote Web3 dev job and check on me daily");

    assert.match(reply.reply, /want me to create this goal\?/i, "the reply must ask about the goal, matching what's actually stored as pending");
    const session = await getAgentSession(userId);
    const pending = session?.pendingOperation as { topic?: string; operations?: Array<{ tool?: string }> } | null;
    assert.equal(pending?.topic, "goal_creation", "the stored pendingOperation must be the goal, matching what the reply actually asks about");
    assert.equal(pending?.operations?.[0]?.tool, "goal.create_apply", "confirming must apply the goal, not the deferred settings proposal");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3C: a daily-coaching request bundled with a goal is not lost — Alecto acknowledges it for later", async () => {
  const server = buildServer();
  const userId = `goal-action-compound-not-lost-${randomUUID()}`;
  try {
    await seedUser(userId);

    const compoundPlan: MockPlan["operations"] = [
      ...jobGoalPlan(),
      op("proactive.settings_propose_update", { morningBriefEnabled: true, eveningCheckinEnabled: true })
    ];
    mockPlan({ topic: "goals", intent: "propose_goal_creation", operations: compoundPlan, needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "I want to find a remote Web3 dev job and check on me daily");

    assert.match(reply.reply, /ask you about that next/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3D: confirming the goal after a compound turn never mutates proactive settings without its own later confirmation", async () => {
  const server = buildServer();
  const userId = `goal-action-compound-no-settings-mutation-${randomUUID()}`;
  try {
    await seedUser(userId);

    const before = await prisma.notificationSettings.findUnique({ where: { userId } });
    assert.equal(before, null);

    const compoundPlan: MockPlan["operations"] = [
      ...jobGoalPlan(),
      op("proactive.settings_propose_update", { morningBriefEnabled: true, eveningCheckinEnabled: true })
    ];
    mockPlan({ topic: "goals", intent: "propose_goal_creation", operations: compoundPlan, needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "I want to find a remote Web3 dev job and check on me daily");

    const confirmed = await sendAgentMessage(server, userId, "yes");
    assert.equal(confirmed.debug.mutationExecuted, true);

    const goal = await prisma.goal.findFirst({ where: { userId } });
    assert.ok(goal, "the goal itself must have been created");

    const settings = await prisma.notificationSettings.findUnique({ where: { userId } });
    assert.ok(
      settings === null || (settings.morningBriefEnabled === false && settings.eveningCheckinEnabled === false),
      "proactive settings must remain untouched — confirming the goal must never also silently apply the deferred settings proposal"
    );
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4A: 'yes create it' confirms a pending goal creation", async () => {
  const server = buildServer();
  const userId = `goal-action-confirm-yes-create-it-${randomUUID()}`;
  try {
    await seedUser(userId);
    mockPlan({ topic: "goals", intent: "propose_goal_creation", operations: jobGoalPlan(), needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "I want to find a remote Web3 dev job");

    const confirmed = await sendAgentMessage(server, userId, "yes create it");
    assert.equal(confirmed.debug.llmPlannerAttempted, false, "an extended confirm phrase must resolve deterministically, not via the planner");
    assert.equal(confirmed.debug.mutationExecuted, true);

    const goal = await prisma.goal.findFirst({ where: { userId } });
    assert.ok(goal, "'yes create it' must actually create the pending goal");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4B: 'yes do it' confirms a pending proactive settings change", async () => {
  const server = buildServer();
  const userId = `goal-action-confirm-yes-do-it-${randomUUID()}`;
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

    const confirmed = await sendAgentMessage(server, userId, "yes do it");
    assert.equal(confirmed.debug.mutationExecuted, true);

    const settings = await prisma.notificationSettings.findUnique({ where: { userId } });
    assert.equal(settings?.morningBriefEnabled, true);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4C: Spanish 'sí créalo' and Catalan 'd'acord, crea-ho' both confirm a pending goal creation", async () => {
  const server = buildServer();
  const esUserId = `goal-action-confirm-es-${randomUUID()}`;
  const caUserId = `goal-action-confirm-ca-${randomUUID()}`;
  try {
    await seedUser(esUserId);
    mockPlan({ topic: "goals", intent: "propose_goal_creation", operations: jobGoalPlan(), needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, esUserId, "quiero encontrar un trabajo remoto");
    const esConfirmed = await sendAgentMessage(server, esUserId, "sí créalo");
    assert.equal(esConfirmed.debug.mutationExecuted, true, "Spanish 'sí créalo' must confirm");
    assert.ok(await prisma.goal.findFirst({ where: { userId: esUserId } }));

    await seedUser(caUserId);
    mockPlan({ topic: "goals", intent: "propose_goal_creation", operations: jobGoalPlan(), needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, caUserId, "vull trobar una feina remota");
    const caConfirmed = await sendAgentMessage(server, caUserId, "d'acord, crea-ho");
    assert.equal(caConfirmed.debug.mutationExecuted, true, "Catalan 'd'acord, crea-ho' must confirm");
    assert.ok(await prisma.goal.findFirst({ where: { userId: caUserId } }));
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: { in: [esUserId, caUserId] } } });
  }
});

test("4D: 'yes but change the target' revises the proposal instead of confirming it", async () => {
  const server = buildServer();
  const userId = `goal-action-confirm-yes-but-${randomUUID()}`;
  try {
    await seedUser(userId);
    mockPlan({ topic: "goals", intent: "propose_goal_creation", operations: jobGoalPlan(), needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "I want to find a remote Web3 dev job");

    const revisedPlan: MockPlan["operations"] = [
      op("goal.create_propose", {
        title: "Find a fully remote Web3 developer job",
        category: "career",
        successCriteria: "5 applications per week",
        signals: [{ key: "applications_sent", label: "applications sent", cadence: "daily" }],
        firstActions: []
      })
    ];
    mockPlan({ topic: "goals", intent: "propose_goal_creation", operations: revisedPlan, needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "yes but change the target to 5 a week");

    assert.equal(reply.debug.llmPlannerAttempted, true, "'yes but change...' must reach the planner, not confirm deterministically");
    assert.equal(reply.debug.mutationExecuted, false);

    const goalCount = await prisma.goal.count({ where: { userId } });
    assert.equal(goalCount, 0, "nothing should be created until the revised proposal is itself confirmed");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4E: 'yes create it' with no pending operation does not mutate anything", async () => {
  const server = buildServer();
  const userId = `goal-action-confirm-no-pending-${randomUUID()}`;
  try {
    await seedUser(userId);
    const reply = await sendAgentMessage(server, userId, "yes create it");

    assert.equal(reply.debug.llmPlannerAttempted, false);
    assert.equal(reply.debug.mutationExecuted, false);
    assert.match(reply.reply, /don't have anything pending/i);

    const goalCount = await prisma.goal.count({ where: { userId } });
    assert.equal(goalCount, 0);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
