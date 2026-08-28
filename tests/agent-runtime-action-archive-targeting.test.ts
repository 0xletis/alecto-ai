import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createActionItem, createGoal, prisma } from "../packages/db/src/index.ts";
import { sendDueActionReminders } from "../apps/worker/src/action-reminders.ts";
import { buildServer, clearAgentRuntimeMocks, getAgentSession, mockPlan, op, seedUser, sendAgentMessage } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * fix/private-alpha-action-archive-targeting: a real live-trust bug — a user was shown an overdue-
 * action reminder ("1. Send 6 CVs today"), said "archive it," and the ENTIRE linked goal ("Find a
 * fully remote developer job, ideally in Web3") got archived along with its open actions instead of
 * just the one visible action. Root cause: goalLifecycleShortcutOperation's bare-pronoun branch
 * ("archive it") resolved via session.focusedEntities.goal — sticky across turns, untouched by the
 * worker's reminder — before the CORRECT action-archive shortcut (actionCompletionShortcutOperation,
 * further down the dispatch chain) ever got a chance to run. There was no "critical guard that
 * rewrites action archive into goal archive" — "critical" only ever changes confirmation COPY, never
 * the target. Fixed by having the goal-lifecycle shortcut defer to a currently-visible/recently-
 * reminded ACTION target whenever the message is a bare pronoun with no explicit goal word.
 *
 * A second, related bug (found once the goal was already wrongly archived): "restore the goal 'X'"
 * routed to goal.create_propose instead of recognizing restore intent — goal.create_apply's own
 * duplicate check only ever looks at ACTIVE goals, so an archived one was invisible to it. Fixed
 * with a new deterministic goalRestoreShortcutOperation + goal.restore_propose/goal.restore_apply.
 */

function jobGoalInput(overrides: Record<string, unknown> = {}) {
  return {
    title: "Find a fully remote developer job, ideally in Web3",
    category: "career",
    priority: "critical" as const,
    targetMetrics: [{ key: "cvs_sent", label: "CVs sent", labelSingular: "CV sent", eventType: "career.application_sent", aggregation: "count" as const, window: "daily" as const }],
    ...overrides
  };
}

/** Establishes session.focusedEntities.goal the same natural way a real conversation would — a
 * prior turn that surfaces the goal as an entity (goal.status), NOT a direct DB write, so this
 * matches exactly how the live bug's sticky focus actually got set. */
async function establishGoalFocus(server: ReturnType<typeof buildServer>, userId: string, goalTitle: string) {
  mockPlan({
    topic: "goals",
    intent: "goal_status",
    operations: [op("goal.status", { goalRef: goalTitle })],
    needsClarification: false,
    clarificationQuestion: null,
    replyDraft: ""
  });
  await sendAgentMessage(server, userId, `how is my ${goalTitle} going?`);
}

async function seedOverdueLinkedAction(userId: string, goalId: string, title = "Send 6 CVs today") {
  return createActionItem(userId, { source: "manual", title, goalId, dueAt: new Date(Date.now() - 60 * 60 * 1000) });
}

/** sendDueActionReminders only routes to userIds shaped like a real Telegram chat — a plain
 * randomUUID-based test userId is silently skipped as "unroutable." Matches
 * worker-action-reminder-bundling.test.ts's own seeding pattern. */
async function seedTelegramUser(userId: string) {
  await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
  await prisma.notificationSettings.create({ data: { userId, telegramUserId: userId, timezone: "Europe/Madrid", morningTimeMinutes: 540, eveningTimeMinutes: 1140 } });
}

function stubTelegram() {
  const sent: Array<{ chatId: string; text: string }> = [];
  const send = async (chatId: string, text: string): Promise<void> => {
    sent.push({ chatId, text });
  };
  return { send, sent };
}

// ---------------------------------------------------------------------------
// Task 6: the exact live regression transcript
// ---------------------------------------------------------------------------

test("6. exact live regression: overdue reminder -> 'archive it' -> confirm action only -> 'yes' -> goal stays active", async () => {
  const server = buildServer();
  const telegramUserId = `55503${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const userId = `telegram:${telegramUserId}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    await prisma.notificationSettings.create({ data: { userId, telegramUserId: userId, timezone: "Europe/Madrid", morningTimeMinutes: 540, eveningTimeMinutes: 1140 } });
    const goalResult = await createGoal(userId, jobGoalInput());
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
    const goal = goalResult.goal;
    const connection = await prisma.integrationConnection.create({ data: { userId, integrationId: "gmail", status: "active", config: {} } });
    const rule = await prisma.emailSignalRule.create({
      data: {
        userId,
        goalId: goal.id,
        connectionId: connection.id,
        adapterId: "job_search_email",
        name: "Job search emails",
        status: "active",
        fetchStrategy: "query",
        lookbackDays: 30,
        maxMessagesPerSync: 25,
        maxEventsPerSync: 5,
        classifierMode: "rules",
        minAutoLogConfidence: 1,
        minReviewConfidence: 0.65,
        reviewBeforeLogging: true,
        notifyPolicy: "review_only",
        createdBy: "user"
      }
    });

    await establishGoalFocus(server, userId, goal.title);
    const action = await seedOverdueLinkedAction(userId, goal.id);

    const { send, sent } = stubTelegram();
    await sendDueActionReminders(new Date(), { sendTelegramMessage: send });
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /you have 1 overdue action:/i);
    assert.match(sent[0].text, /1\. send 6 cvs today/i);

    // 2/3: "archive it" must confirm archiving the ACTION only, never the goal.
    const archiveIt = await sendAgentMessage(server, userId, "archive it");
    assert.doesNotMatch(archiveIt.reply, /goal.archive_apply/);
    assert.match(archiveIt.reply, /send 6 cvs/i, "confirmation must name the action");
    assert.doesNotMatch(archiveIt.reply, /and its \d+ open action/i, "must never frame this as a goal archive with linked actions");
    const pendingTools = archiveIt.operationsPlanned.map((o) => o.tool);
    assert.ok(!pendingTools.includes("goal.archive_propose"), `goal.archive_propose must never be planned — got: ${JSON.stringify(pendingTools)}`);

    const midway = await getAgentSession(userId, "telegram");
    const pending = midway?.pendingOperation as { operations: Array<{ tool: string; args: Record<string, unknown> }> } | undefined;
    assert.ok(pending, "a real confirmation must be pending");
    for (const pendingOp of pending!.operations) {
      assert.notEqual(pendingOp.tool, "goal.archive_apply", "goal.archive_apply must never be queued");
    }

    // 4/5: "yes" -> action archived.
    const confirm = await sendAgentMessage(server, userId, "yes");
    assert.equal(confirm.debug.mutationExecuted, true);
    assert.match(confirm.reply, /archived 1 action/i);
    assert.doesNotMatch(confirm.reply, /archived goal/i, `"Archived goal" must never appear — got: ${confirm.reply}`);

    const archivedAction = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(archivedAction?.status, "archived", "action.archive executed");

    // 6: goal remains active.
    const stillActiveGoal = await prisma.goal.findUnique({ where: { id: goal.id } });
    assert.equal(stillActiveGoal?.status, "active", "goal.archive never executed");

    // 7/8: "what goals do i have" still lists the job goal.
    mockPlan({
      topic: "goals",
      intent: "list_goals",
      operations: [op("goal.tracking_show", {})],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const goalsReply = await sendAgentMessage(server, userId, "what goals do i have");
    assert.match(goalsReply.reply, /find a fully remote developer job/i, "the goal must still be listed as active");

    // No linked Gmail watcher removed/paused.
    const ruleAfter = await prisma.emailSignalRule.findUnique({ where: { id: rule.id } });
    assert.equal(ruleAfter?.status, "active", "the linked Gmail watcher must be untouched");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// ---------------------------------------------------------------------------
// Task 2: target-preserving critical guard
// ---------------------------------------------------------------------------

test("2A: archiving an action linked to a critical goal asks to confirm the ACTION only, and 'yes' archives only the action", async () => {
  const server = buildServer();
  const userId = `archive-target-critical-action-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goalResult = await createGoal(userId, jobGoalInput());
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
    const goal = goalResult.goal;
    const action = await seedOverdueLinkedAction(userId, goal.id, "Send CVs today");

    mockPlan({
      topic: "actions",
      intent: "archive_action",
      operations: [op("action.archive", { actionId: action.id })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const propose = await sendAgentMessage(server, userId, `archive "${action.title}"`);
    assert.match(propose.reply, /linked to a critical goal/i);
    assert.match(propose.reply, /send cvs/i);
    assert.equal(propose.debug.pendingOperation, true);
    assert.equal(propose.debug.mutationExecuted, false, "must not archive before confirmation");

    const stillOpen = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(stillOpen?.status, "open");

    const confirm = await sendAgentMessage(server, userId, "yes");
    assert.equal(confirm.debug.mutationExecuted, true);

    const archived = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(archived?.status, "archived");
    const stillActiveGoal = await prisma.goal.findUnique({ where: { id: goal.id } });
    assert.equal(stillActiveGoal?.status, "active", "goal must remain active");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2B/2E: explicitly archiving the critical goal itself asks to confirm the GOAL, with different wording than the action guard", async () => {
  const server = buildServer();
  const userId = `archive-target-critical-goal-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goalResult = await createGoal(userId, jobGoalInput());
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
    const goal = goalResult.goal;
    await seedOverdueLinkedAction(userId, goal.id, "Send CVs today");

    const propose = await sendAgentMessage(server, userId, "archive my developer job goal");
    assert.match(propose.reply, /critical/i);
    assert.match(propose.reply, /stop tracking/i);
    assert.doesNotMatch(propose.reply, /linked to a critical goal/i, "goal-archive copy must read differently from the action-archive guard's own copy");
    assert.equal(propose.debug.pendingOperation, true);

    const confirm = await sendAgentMessage(server, userId, "yes");
    assert.equal(confirm.debug.mutationExecuted, true);
    const archivedGoal = await prisma.goal.findUnique({ where: { id: goal.id } });
    assert.equal(archivedGoal?.status, "archived");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2C/2D: 'archive it' after a visible action list targets the action; after a visible goal list, targets the goal", async () => {
  const server1 = buildServer();
  const userId1 = `archive-target-after-actionlist-${randomUUID()}`;
  try {
    await seedUser(userId1);
    const goalResult = await createGoal(userId1, jobGoalInput({ priority: "medium" }));
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
    const action = await seedOverdueLinkedAction(userId1, goalResult.goal.id);

    mockPlan({
      topic: "actions",
      intent: "list_actions",
      operations: [op("action.list", {})],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    await sendAgentMessage(server1, userId1, "show my actions");

    const reply = await sendAgentMessage(server1, userId1, "archive it");
    assert.equal(reply.debug.mutationExecuted, true, "a non-critical action archives immediately");
    const archived = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(archived?.status, "archived");
    const goalAfter = await prisma.goal.findUnique({ where: { id: goalResult.goal.id } });
    assert.equal(goalAfter?.status, "active");
  } finally {
    clearAgentRuntimeMocks();
    await server1.close();
    await prisma.user.deleteMany({ where: { id: userId1 } });
  }

  const server2 = buildServer();
  const userId2 = `archive-target-after-goallist-${randomUUID()}`;
  try {
    await seedUser(userId2);
    const goalResult = await createGoal(userId2, jobGoalInput({ priority: "medium" }));
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");

    // A goal-list query naming no specific goal returns "all" and sets no visible/focused entity
    // (deliberately, per resolveGoalReferenceTargets) — establishGoalFocus resolves a SPECIFIC
    // goal instead, which is what actually makes it "the currently visible goal" for this test.
    await establishGoalFocus(server2, userId2, goalResult.goal.title);

    const reply = await sendAgentMessage(server2, userId2, "archive it");
    assert.match(reply.reply, /you're about to archive/i);
    assert.equal(reply.debug.pendingOperation, true);
    const confirm = await sendAgentMessage(server2, userId2, "yes");
    assert.equal(confirm.debug.mutationExecuted, true);
    const archivedGoal = await prisma.goal.findUnique({ where: { id: goalResult.goal.id } });
    assert.equal(archivedGoal?.status, "archived");
  } finally {
    clearAgentRuntimeMocks();
    await server2.close();
    await prisma.user.deleteMany({ where: { id: userId2 } });
  }
});

// ---------------------------------------------------------------------------
// Task 3: visible entity precedence for other pronoun-shaped replies
// ---------------------------------------------------------------------------

test("3B/3C: 'done' and 'move it to tomorrow' after an overdue reminder resolve the visible action, even with a critical goal focused", async () => {
  const server = buildServer();
  const userId = `telegram:36601${Date.now()}${Math.floor(Math.random() * 1000)}`;
  try {
    await seedTelegramUser(userId);
    const goalResult = await createGoal(userId, jobGoalInput());
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
    const goal = goalResult.goal;
    await establishGoalFocus(server, userId, goal.title);
    const actionA = await seedOverdueLinkedAction(userId, goal.id, "Send 6 CVs today");

    const { send } = stubTelegram();
    await sendDueActionReminders(new Date(), { sendTelegramMessage: send });

    const done = await sendAgentMessage(server, userId, "done");
    assert.equal(done.debug.mutationExecuted, true);
    const completed = await prisma.actionItem.findUnique({ where: { id: actionA.id } });
    assert.equal(completed?.status, "completed");
    const goalStillActive = await prisma.goal.findUnique({ where: { id: goal.id } });
    assert.equal(goalStillActive?.status, "active");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }

  const server2 = buildServer();
  const userId2 = `telegram:36602${Date.now()}${Math.floor(Math.random() * 1000)}`;
  try {
    await seedTelegramUser(userId2);
    const goalResult = await createGoal(userId2, jobGoalInput());
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
    const goal = goalResult.goal;
    await establishGoalFocus(server2, userId2, goal.title);
    const action = await seedOverdueLinkedAction(userId2, goal.id, "Send 6 CVs today");

    const { send } = stubTelegram();
    await sendDueActionReminders(new Date(), { sendTelegramMessage: send });

    const moved = await sendAgentMessage(server2, userId2, "move it to tomorrow");
    assert.equal(moved.debug.mutationExecuted, true);
    const snoozed = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(snoozed?.status, "snoozed");
    const goalStillActive = await prisma.goal.findUnique({ where: { id: goal.id } });
    assert.equal(goalStillActive?.status, "active");
  } finally {
    clearAgentRuntimeMocks();
    await server2.close();
    await prisma.user.deleteMany({ where: { id: userId2 } });
  }
});

// ---------------------------------------------------------------------------
// Task 4: pending operation target integrity
// ---------------------------------------------------------------------------

test("4D: stale/changed visibleEntities cannot broaden a pending critical-action confirmation into a different target", async () => {
  const server = buildServer();
  const userId = `pending-target-stale-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goalResult = await createGoal(userId, jobGoalInput());
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
    const goal = goalResult.goal;
    const action = await seedOverdueLinkedAction(userId, goal.id, "Send CVs today");
    const otherAction = await createActionItem(userId, { source: "manual", title: "Unrelated task" });

    mockPlan({
      topic: "actions",
      intent: "archive_action",
      operations: [op("action.archive", { actionId: action.id })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    await sendAgentMessage(server, userId, `archive "${action.title}"`);

    // Simulate session drift: visibleEntities now points at a totally different action.
    const session = await getAgentSession(userId, "telegram");
    await prisma.agentConversationSession.update({
      where: { userId_channel: { userId, channel: "telegram" } },
      data: { visibleEntities: [{ type: "action", id: otherAction.id, label: otherAction.title, index: 1 }] }
    });
    assert.ok(session, "session must exist");

    const confirm = await sendAgentMessage(server, userId, "yes");
    assert.equal(confirm.debug.mutationExecuted, true);

    const archived = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(archived?.status, "archived", "the ORIGINALLY targeted action must be the one archived");
    const untouchedOther = await prisma.actionItem.findUnique({ where: { id: otherAction.id } });
    assert.equal(untouchedOther?.status, "open", "the stale visibleEntities target must never be substituted in");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4E: if the pending target was archived/removed before confirmation, 'yes' fails safely rather than mutating something else", async () => {
  const server = buildServer();
  const userId = `pending-target-missing-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goalResult = await createGoal(userId, jobGoalInput());
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
    const action = await seedOverdueLinkedAction(userId, goalResult.goal.id, "Send CVs today");

    mockPlan({
      topic: "actions",
      intent: "archive_action",
      operations: [op("action.archive", { actionId: action.id })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    await sendAgentMessage(server, userId, `archive "${action.title}"`);

    // The target is archived out-of-band before the user confirms (e.g. another channel/race).
    await prisma.actionItem.update({ where: { id: action.id }, data: { status: "archived" } });

    const confirm = await sendAgentMessage(server, userId, "yes");
    assert.doesNotMatch(confirm.reply, /^archived/i);
    assert.match(confirm.reply, /no longer exist|already archived/i);

    const goalAfter = await prisma.goal.findUnique({ where: { id: goalResult.goal.id } });
    assert.equal(goalAfter?.status, "active", "must never fall back to archiving the goal instead");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// ---------------------------------------------------------------------------
// Task 5: restore/recovery
// ---------------------------------------------------------------------------

test("5A/5B/5C: restoring an archived goal by title reactivates it, no duplicate created", async () => {
  const server = buildServer();
  const userId = `restore-by-title-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goalResult = await createGoal(userId, jobGoalInput());
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
    await prisma.goal.update({ where: { id: goalResult.goal.id }, data: { status: "archived" } });

    const propose = await sendAgentMessage(server, userId, "restore my developer job goal");
    assert.match(propose.reply, /archived/i);
    assert.equal(propose.debug.pendingOperation, true);
    assert.doesNotMatch(propose.reply, /want me to create this goal/i);

    const confirm = await sendAgentMessage(server, userId, "yes");
    assert.equal(confirm.debug.mutationExecuted, true);
    assert.match(confirm.reply, /restored/i);

    const restored = await prisma.goal.findUnique({ where: { id: goalResult.goal.id } });
    assert.equal(restored?.status, "active");

    const allGoalsWithSameTitle = await prisma.goal.findMany({ where: { userId, title: goalResult.goal.title } });
    assert.equal(allGoalsWithSameTitle.length, 1, "no duplicate goal must be created");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("5D: ambiguous archived goals ask for clarification instead of guessing", async () => {
  const server = buildServer();
  const userId = `restore-ambiguous-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goalA = await createGoal(userId, { title: "Job search for developer roles", category: "career" });
    const goalB = await createGoal(userId, { title: "Job search for designer roles", category: "career", allowDuplicate: true });
    if (goalA.duplicate || goalB.duplicate) throw new Error("unexpected duplicate goal in test setup");
    await prisma.goal.update({ where: { id: goalA.goal.id }, data: { status: "archived" } });
    await prisma.goal.update({ where: { id: goalB.goal.id }, data: { status: "archived" } });

    const reply = await sendAgentMessage(server, userId, "restore my job search goal");
    assert.equal(reply.debug.pendingOperation, false);
    assert.match(reply.reply, /which one|do you mean/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("5E: restoring an already-active goal says it's already active, no pending operation opened", async () => {
  const server = buildServer();
  const userId = `restore-already-active-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goalResult = await createGoal(userId, jobGoalInput());
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");

    const reply = await sendAgentMessage(server, userId, "restore my developer job goal");
    assert.match(reply.reply, /already active/i);
    assert.equal(reply.debug.pendingOperation, false);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// ---------------------------------------------------------------------------
// Additional live bug: restore intent priority over goal.create_propose
// ---------------------------------------------------------------------------

test("Additional bug regression: 'restore the goal \"X\"' never routes to goal.create_propose while an archived match exists", async () => {
  const server = buildServer();
  const userId = `restore-priority-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goalResult = await createGoal(userId, jobGoalInput());
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
    await prisma.goal.update({ where: { id: goalResult.goal.id }, data: { status: "archived" } });

    // Deliberately mocks the planner to return goal.create_propose (the REAL observed wrong
    // behavior) — the deterministic restore shortcut must intercept the message BEFORE the
    // planner (and therefore this mock) is ever consulted at all.
    mockPlan({
      topic: "goals",
      intent: "propose_goal_creation",
      operations: [op("goal.create_propose", { title: goalResult.goal.title, category: "career", signals: [] })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: `Good — I can track "${goalResult.goal.title}" like this... Want me to create this goal?`
    });

    const reply = await sendAgentMessage(server, userId, `restore the goal "${goalResult.goal.title}"`);
    assert.doesNotMatch(reply.reply, /want me to create this goal/i, "must never propose creating a new goal while an archived match exists");
    assert.match(reply.reply, /archived/i);
    assert.equal(reply.debug.llmPlannerAttempted, false, "the deterministic shortcut must intercept before the planner runs");
    assert.equal(reply.debug.pendingOperation, true);

    const goalCount = await prisma.goal.count({ where: { userId, title: goalResult.goal.title } });
    assert.equal(goalCount, 1, "no new goal must have been created");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("Restore should preserve linked data: does not restore archived actions, preserves the linked Gmail watcher, no duplicate metrics", async () => {
  const server = buildServer();
  const userId = `restore-preserves-data-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goalResult = await createGoal(userId, jobGoalInput());
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
    const goal = goalResult.goal;
    const connection = await prisma.integrationConnection.create({ data: { userId, integrationId: "gmail", status: "active", config: {} } });
    const rule = await prisma.emailSignalRule.create({
      data: {
        userId,
        goalId: goal.id,
        connectionId: connection.id,
        adapterId: "job_search_email",
        name: "Job search emails",
        status: "active",
        fetchStrategy: "query",
        lookbackDays: 30,
        maxMessagesPerSync: 25,
        maxEventsPerSync: 5,
        classifierMode: "rules",
        minAutoLogConfidence: 1,
        minReviewConfidence: 0.65,
        reviewBeforeLogging: true,
        notifyPolicy: "review_only",
        createdBy: "user"
      }
    });
    const archivedAction = await createActionItem(userId, { source: "manual", title: "Old archived task", goalId: goal.id });
    await prisma.actionItem.update({ where: { id: archivedAction.id }, data: { status: "archived" } });

    await prisma.goal.update({ where: { id: goal.id }, data: { status: "archived" } });

    const originalMetrics = (await prisma.goal.findUnique({ where: { id: goal.id } }))?.targetMetrics;

    const propose = await sendAgentMessage(server, userId, "restore my developer job goal");
    assert.equal(propose.debug.pendingOperation, true);
    const confirm = await sendAgentMessage(server, userId, "yes");
    assert.equal(confirm.debug.mutationExecuted, true);
    assert.match(confirm.reply, /archived actions stay archived/i);

    const restoredGoal = await prisma.goal.findUnique({ where: { id: goal.id } });
    assert.equal(restoredGoal?.status, "active");
    assert.deepEqual(restoredGoal?.targetMetrics, originalMetrics, "metrics must not be re-derived/changed");

    const stillArchivedAction = await prisma.actionItem.findUnique({ where: { id: archivedAction.id } });
    assert.equal(stillArchivedAction?.status, "archived", "archived actions must not be auto-restored");

    const ruleAfter = await prisma.emailSignalRule.findUnique({ where: { id: rule.id } });
    assert.equal(ruleAfter?.status, "active", "linked Gmail watcher must be preserved untouched");

    const goalCount = await prisma.goal.count({ where: { userId, title: goal.title } });
    assert.equal(goalCount, 1, "no duplicate goal");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
