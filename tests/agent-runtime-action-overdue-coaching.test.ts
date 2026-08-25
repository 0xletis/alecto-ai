import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createActionItem, createGoal, prisma } from "../packages/db/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, mockPlan, op, sendAgentMessage, seedUser } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * Deterministic coverage for the "temporal health" follow-up to feat/private-alpha-action-
 * temporal-coaching — an open action's STATUS alone never said whether it was fine, overdue, or
 * had just been sitting untouched for days, so a task created "for today" silently kept saying
 * "today" 4 days later with nothing ever flagging it. assessTemporalHealth/formatTemporalHealthLabel
 * (apps/api/src/operator/proactive.ts, shared with executor.ts) are the single grounded source of
 * truth every surface below reads from — action.list, goal.recommend_next_action, the morning
 * brief, and the evening check-in can never disagree about what counts as overdue vs. stale.
 *
 * No DB migration was needed for this pass — everything is computed live from fields that
 * already existed (dueAt, createdAt, status) plus postponeCount, added by the prior temporal-
 * coaching pass on this same branch.
 */

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

function actionListPlan() {
  return { topic: "actions", intent: "list_actions", operations: [op("action.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" };
}

// --- A: overdue action + "what next" recommends addressing it first ----------------------------

test("A: an overdue goal-linked action is recommended over creating a new one", async () => {
  const server = buildServer();
  const userId = `overdue-a-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goalResult = await createGoal(userId, { title: "Find a fully remote Web3 developer job", category: "career", priority: "medium" });
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
    await createActionItem(userId, {
      source: "manual",
      title: "Apply to 3 more remote Web3 roles",
      goalId: goalResult.goal.id,
      dueAt: new Date(Date.now() - ONE_DAY_MS)
    });

    const beforeCount = await prisma.actionItem.count({ where: { userId } });
    mockPlan({
      topic: "goals",
      intent: "next_action",
      operations: [op("goal.recommend_next_action", { recommendation: "Let's look at what's already there.", proposedAction: "Apply to 3 more remote Web3 roles today" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "what should I do next?");

    assert.match(reply.reply, /overdue/i);
    assert.match(reply.reply, /apply to 3 more remote web3 roles/i);
    assert.equal(reply.debug.pendingOperation, false, "must not open a create-confirmation while an overdue action exists");
    const afterCount = await prisma.actionItem.count({ where: { userId } });
    assert.equal(afterCount, beforeCount, "no duplicate action may be created");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- B: overdue action + "show actions" labels it overdue --------------------------------------

test("B: 'show me my actions' labels an action due yesterday as overdue, not just a normal date", async () => {
  const server = buildServer();
  const userId = `overdue-b-${randomUUID()}`;
  try {
    await seedUser(userId);
    await createActionItem(userId, { source: "manual", title: "Renew passport", dueAt: new Date(Date.now() - ONE_DAY_MS) });

    mockPlan(actionListPlan());
    const reply = await sendAgentMessage(server, userId, "show me my actions");

    assert.match(reply.reply, /overdue since yesterday/i);
    assert.doesNotMatch(reply.reply, /\bstale\b|sitting for/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- C: stale action with no dueAt labels as sitting, never overdue -----------------------------

test("C: an action with no dueAt but created 4 days ago is labeled 'sitting for 4 days', never 'overdue'", async () => {
  const server = buildServer();
  const userId = `overdue-c-${randomUUID()}`;
  try {
    await seedUser(userId);
    const action = await createActionItem(userId, { source: "manual", title: "Organize old photos" });
    await prisma.actionItem.update({ where: { id: action.id }, data: { createdAt: new Date(Date.now() - 4 * ONE_DAY_MS) } });

    mockPlan(actionListPlan());
    const reply = await sendAgentMessage(server, userId, "show me my actions");

    assert.match(reply.reply, /sitting for 4 days/i);
    assert.doesNotMatch(reply.reply, /overdue/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- D: morning brief includes an overdue action ------------------------------------------------

const MORNING_UTC = "2026-08-20T07:00:00.000Z"; // 09:00 Europe/Madrid
const EVENING_UTC = "2026-08-20T17:00:00.000Z"; // 19:00 Europe/Madrid

async function seedNotificationSettings(userId: string): Promise<void> {
  await prisma.notificationSettings.create({
    data: { userId, dailyLoopEnabled: true, morningTimeMinutes: 540, eveningTimeMinutes: 1140, timezone: "Europe/Madrid" }
  });
}

async function preview(server: ReturnType<typeof buildServer>, userId: string, nowIso: string) {
  const response = await server.inject({ method: "GET", url: `/users/${userId}/operator/proactive/preview?now=${encodeURIComponent(nowIso)}` });
  assert.equal(response.statusCode, 200, `preview for ${userId} returned ${response.statusCode}: ${response.body}`);
  return response.json().decision as { decision: "proposed_message"; type: string; message: string } | { decision: "no_message"; reason: string };
}

test("D: morning brief mentions an overdue action explicitly", async () => {
  const server = buildServer();
  const userId = `overdue-d-${randomUUID()}`;
  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    await seedNotificationSettings(userId);
    await createGoal(userId, { title: "Find a fully remote Web3 developer job", category: "career", priority: "high" });
    await createActionItem(userId, {
      source: "manual",
      title: "Apply to 3 more remote Web3 roles",
      priority: "high",
      dueAt: new Date("2026-08-19T10:00:00.000Z")
    });

    const decision = await preview(server, userId, MORNING_UTC);

    assert.equal(decision.decision, "proposed_message");
    assert.match((decision as { message: string }).message, /overdue/i);
    assert.match((decision as { message: string }).message, /apply to 3 more remote web3 roles/i);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- E: evening check-in mentions a missed due-today action -------------------------------------

test("E: evening check-in mentions an action that was due today and is still open", async () => {
  const server = buildServer();
  const userId = `overdue-e-${randomUUID()}`;
  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    await seedNotificationSettings(userId);
    await createActionItem(userId, {
      source: "manual",
      title: "Apply to 3 more remote Web3 roles",
      priority: "high",
      dueAt: new Date("2026-08-20T10:00:00.000Z")
    });

    const decision = await preview(server, userId, EVENING_UTC);

    assert.equal(decision.decision, "proposed_message");
    assert.match((decision as { message: string }).message, /apply to 3 more remote web3 roles/i);
    assert.match((decision as { message: string }).message, /due today|still open/i);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- F: repeated missed/postponed action triggers mild/strong coaching --------------------------

test("F: an action overdue by 3 days gets a mild challenge; by 5 days gets stronger coaching", async () => {
  const server = buildServer();
  const userIdMild = `overdue-f-mild-${randomUUID()}`;
  const userIdStrong = `overdue-f-strong-${randomUUID()}`;
  try {
    await seedUser(userIdMild);
    const goalMild = await createGoal(userIdMild, { title: "Find a fully remote Web3 developer job", category: "career", priority: "medium" });
    if (goalMild.duplicate) throw new Error("unexpected duplicate goal in test setup");
    await createActionItem(userIdMild, { source: "manual", title: "Apply to remote roles", goalId: goalMild.goal.id, dueAt: new Date(Date.now() - 3 * ONE_DAY_MS) });

    mockPlan({ topic: "goals", intent: "next_action", operations: [op("goal.recommend_next_action", { recommendation: "Let's look." })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const mildReply = await sendAgentMessage(server, userIdMild, "what should I do next?");
    assert.match(mildReply.reply, /is it still the right action, or are you avoiding it/i);

    await seedUser(userIdStrong);
    const goalStrong = await createGoal(userIdStrong, { title: "Find a fully remote Web3 developer job", category: "career", priority: "medium" });
    if (goalStrong.duplicate) throw new Error("unexpected duplicate goal in test setup");
    await createActionItem(userIdStrong, { source: "manual", title: "Apply to remote roles", goalId: goalStrong.goal.id, dueAt: new Date(Date.now() - 5 * ONE_DAY_MS) });

    mockPlan({ topic: "goals", intent: "next_action", operations: [op("goal.recommend_next_action", { recommendation: "Let's look." })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const strongReply = await sendAgentMessage(server, userIdStrong, "what should I do next?");
    assert.match(strongReply.reply, /shrink it, move it, or archive it/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: { in: [userIdMild, userIdStrong] } } });
  }
});

// --- G: a legitimate reason is accepted gracefully, rescheduling still works ---------------------

test("G: after an overdue challenge, moving the action to tomorrow still works normally, no shaming in the reply", async () => {
  const server = buildServer();
  const userId = `overdue-g-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goalResult = await createGoal(userId, { title: "Find a fully remote Web3 developer job", category: "career", priority: "medium" });
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
    const action = await createActionItem(userId, {
      source: "manual",
      title: "Apply to remote roles",
      goalId: goalResult.goal.id,
      dueAt: new Date(Date.now() - 2 * ONE_DAY_MS)
    });

    mockPlan({ topic: "goals", intent: "next_action", operations: [op("goal.recommend_next_action", { recommendation: "Let's look." })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "what should I do next?");

    mockPlan({ topic: "actions", intent: "snooze", operations: [op("action.snooze", { actionId: action.id, untilText: "tomorrow" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "move it to tomorrow, I had a call today");

    assert.equal(reply.debug.mutationExecuted, true);
    assert.doesNotMatch(reply.reply, /avoiding|shrink it, move it, or archive it/i);
    const item = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(item?.status, "snoozed");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- H/I: stricter-coaching offer is confirmation-backed, never silent ---------------------------

test("H: 'be stricter about this goal' proposes a preference update and opens a real confirmation, never applies immediately", async () => {
  const server = buildServer();
  const userId = `overdue-h-${randomUUID()}`;
  try {
    await seedUser(userId);

    mockPlan({
      topic: "operator_profile",
      intent: "propose_update",
      operations: [op("operator_profile.propose_update", { accountabilityStrictness: "strict" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "yeah, be stricter with me about this goal");

    assert.equal(reply.debug.pendingOperation, true);
    assert.match(reply.reply, /reply yes to confirm or cancel/i);

    // The profile row is created lazily on first real access (getOrCreateUserOperatingProfile),
    // which the propose_update turn itself just triggered — its default accountabilityStrictness
    // is 3, "strict" maps to 5 (executor.ts's OPERATOR_PROFILE_STYLE_SCALE), so the real assertion
    // is simply that proposing alone never moves it off the default.
    const afterPropose = await prisma.userOperatingProfile.findUnique({ where: { userId } });
    assert.equal(afterPropose?.accountabilityStrictness, 3, "must not change anything before the user confirms");

    const confirmReply = await sendAgentMessage(server, userId, "yes");
    assert.equal(confirmReply.debug.mutationExecuted, true);
    const afterConfirm = await prisma.userOperatingProfile.findUnique({ where: { userId } });
    assert.equal(afterConfirm?.accountabilityStrictness, 5, "the preference must actually change to 'strict' once confirmed");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("I: operator_profile.apply_update can never be planned by the LLM directly, only reached via the confirm whitelist", async () => {
  const server = buildServer();
  const userId = `overdue-i-${randomUUID()}`;
  try {
    await seedUser(userId);

    mockPlan({
      topic: "operator_profile",
      intent: "apply_update",
      operations: [op("operator_profile.apply_update", { accountabilityStrictness: 5 })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: "Done — I'll be stricter with you now."
    });
    const reply = await sendAgentMessage(server, userId, "some unrelated message that shouldn't apply anything");

    assert.equal(reply.debug.mutationExecuted, false);
    const after = await prisma.userOperatingProfile.findUnique({ where: { userId } });
    // Never touched by this turn at all, so either the row doesn't exist yet (null) or, if some
    // earlier step in this test already created it, it's still at the untouched default (3) —
    // either way, never 5 ("strict"), which only a real confirmed apply could ever produce.
    assert.notEqual(after?.accountabilityStrictness, 5, "a direct apply_update plan must never actually change the profile");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- J: no hallucinated due date when dueAt is missing -------------------------------------------

test("J: creating an action with a title that has no temporal words gets no fabricated dueAt", async () => {
  const server = buildServer();
  const userId = `overdue-j-${randomUUID()}`;
  try {
    await seedUser(userId);
    mockPlan({ topic: "actions", intent: "create", operations: [op("action.create", { title: "Organize old photos", priority: "medium" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "add a task to organize old photos");

    const created = await prisma.actionItem.findFirstOrThrow({ where: { userId, title: "Organize old photos" } });
    assert.equal(created.dueAt, null);

    mockPlan(actionListPlan());
    const reply = await sendAgentMessage(server, userId, "show me my actions");
    assert.doesNotMatch(reply.reply, /overdue/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("J2: a title that DOES say 'today' but has no explicit dueText still gets a real dueAt (safe fallback, not a hallucination)", async () => {
  const server = buildServer();
  const userId = `overdue-j2-${randomUUID()}`;
  try {
    await seedUser(userId);
    mockPlan({
      topic: "actions",
      intent: "create",
      operations: [op("action.create", { title: "Apply to 3 more remote Web3 roles today", priority: "medium" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    await sendAgentMessage(server, userId, "add a task to apply to 3 more remote web3 roles today");

    const created = await prisma.actionItem.findFirstOrThrow({ where: { userId, title: "Apply to 3 more remote Web3 roles today" } });
    assert.ok(created.dueAt, "a title literally saying 'today' should get a real dueAt from parsing the title itself, not silently stay null");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
