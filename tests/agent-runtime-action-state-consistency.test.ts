import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { archiveActionItem, completeActionItem, createActionItem, createGoal, prisma, snoozeActionItem } from "../packages/db/src/index.ts";
import { loadContext } from "../apps/api/src/agent-runtime/context-loader.ts";
import { buildUserPayload } from "../apps/api/src/agent-runtime/planner.ts";
import { buildServer, clearAgentRuntimeMocks, getAgentSession, mockPlan, op, sendAgentMessage, seedUser } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * Deterministic coverage for fix/private-alpha-action-state-consistency — a real Telegram
 * transcript found two related bugs: (1) "remove my actions" answered "you don't have any open or
 * scheduled actions to archive" while a real snoozed/deferred action for tomorrow still existed,
 * because action.archive_all_propose's scope "all" candidate pool was status "open" only; (2)
 * "what should I do today?" referenced an action ("...moved to tomorrow 11:00") that had ALREADY
 * been archived a turn earlier, because the model's own free-text recommendation drew on stale
 * assistant prose in conversation.recentMessages rather than the (correctly empty)
 * backgroundDeferredActions. This file covers everything deterministic: the widened bulk-scope
 * regex/query, the archiveActionItem idempotency guard, the new removedEntityIds visible-entity
 * pruning, and the new recentStateChanges/backgroundDeferredActions payload ground truth. The
 * model actually preferring fresh state over stale transcript text is LLM judgment, covered by the
 * gated real-LLM eval suite instead.
 */

function actionListPlan(args: Record<string, unknown> = {}) {
  return { topic: "actions", intent: "list_actions", operations: [op("action.list", args)], needsClarification: false, clarificationQuestion: null, replyDraft: "" };
}

// --- Task 2: "remove my actions" includes open AND deferred/scheduled -----------------------------

test("2A: one deferred action tomorrow + 'remove my actions' proposes archiving it, annotated as moved", async () => {
  const server = buildServer();
  const userId = `state-2a-${randomUUID()}`;
  try {
    await seedUser(userId);
    const action = await createActionItem(userId, { source: "manual", title: "Apply to 3 more remote Web3 roles" });
    await snoozeActionItem(userId, action.id, new Date(Date.now() + 24 * 60 * 60 * 1000));

    const reply = await sendAgentMessage(server, userId, "remove my actions");

    assert.doesNotMatch(reply.reply, /don't have any open or scheduled actions/i, "a real deferred action must be found");
    assert.match(reply.reply, /apply to 3 more remote web3 roles/i);
    assert.match(reply.reply, /moved to/i, "a snoozed target should be annotated with when it was moved to");
    assert.equal(reply.debug.pendingOperation, true);
    assert.equal(reply.debug.mutationExecuted, false, "must not archive before the user confirms");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2B: one open + one deferred action + 'clear my actions' proposes archiving both", async () => {
  const server = buildServer();
  const userId = `state-2b-${randomUUID()}`;
  try {
    await seedUser(userId);
    await createActionItem(userId, { source: "manual", title: "Review 10 remote roles" });
    const deferred = await createActionItem(userId, { source: "manual", title: "Apply to 3 more remote Web3 roles" });
    await snoozeActionItem(userId, deferred.id, new Date(Date.now() + 24 * 60 * 60 * 1000));

    const reply = await sendAgentMessage(server, userId, "clear my actions");

    assert.match(reply.reply, /review 10 remote roles/i);
    assert.match(reply.reply, /apply to 3 more remote web3 roles/i);
    assert.match(reply.reply, /these 2 actions/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2C: already-archived and already-completed actions are excluded from 'archive my actions'", async () => {
  const server = buildServer();
  const userId = `state-2c-${randomUUID()}`;
  try {
    await seedUser(userId);
    const openAction = await createActionItem(userId, { source: "manual", title: "Review 10 remote roles" });
    const toArchive = await createActionItem(userId, { source: "manual", title: "Draft cover letter" });
    const toComplete = await createActionItem(userId, { source: "manual", title: "Update LinkedIn profile" });

    mockPlan({ topic: "actions", intent: "archive", operations: [op("action.archive", { actionId: toArchive.id })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "archive the cover letter task");

    mockPlan({ topic: "actions", intent: "complete", operations: [op("action.complete", { actionId: toComplete.id })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "done with the LinkedIn task");

    const reply = await sendAgentMessage(server, userId, "archive my actions");

    assert.match(reply.reply, /review 10 remote roles/i);
    assert.doesNotMatch(reply.reply, /draft cover letter/i, "an already-archived action must not be re-listed");
    assert.doesNotMatch(reply.reply, /update linkedin profile/i, "a completed action must not be listed for archiving");
    assert.match(reply.reply, /this action\?/i, "exactly one real candidate left, singular phrasing");
    assert.equal(openAction.status, "open");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2D: zero open/scheduled actions returns a clean no-op, never a false proposal", async () => {
  const server = buildServer();
  const userId = `state-2d-${randomUUID()}`;
  try {
    await seedUser(userId);

    const reply = await sendAgentMessage(server, userId, "delete my actions");

    assert.match(reply.reply, /don't have any open or scheduled actions to archive/i);
    assert.equal(reply.debug.pendingOperation, false);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2E: Spanish 'borra mis acciones' and Catalan 'arxiva les meves accions' both find a deferred action", async () => {
  const server = buildServer();
  const userIdEs = `state-2e-es-${randomUUID()}`;
  const userIdCa = `state-2e-ca-${randomUUID()}`;
  try {
    await seedUser(userIdEs);
    const esAction = await createActionItem(userIdEs, { source: "manual", title: "Apply to 3 more remote Web3 roles" });
    await snoozeActionItem(userIdEs, esAction.id, new Date(Date.now() + 24 * 60 * 60 * 1000));
    const esReply = await sendAgentMessage(server, userIdEs, "borra mis acciones");
    assert.match(esReply.reply, /apply to 3 more remote web3 roles/i);

    await seedUser(userIdCa);
    const caAction = await createActionItem(userIdCa, { source: "manual", title: "Apply to 3 more remote Web3 roles" });
    await snoozeActionItem(userIdCa, caAction.id, new Date(Date.now() + 24 * 60 * 60 * 1000));
    const caReply = await sendAgentMessage(server, userIdCa, "arxiva les meves accions");
    assert.match(caReply.reply, /apply to 3 more remote web3 roles/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: { in: [userIdEs, userIdCa] } } });
  }
});

// --- Task 3: fresh state after mutations, and ground truth exposed to the planner -----------------

test("3A: archive a deferred action -> next 'what actions tomorrow' does not show it", async () => {
  const server = buildServer();
  const userId = `state-3a-${randomUUID()}`;
  try {
    await seedUser(userId);
    const action = await createActionItem(userId, { source: "manual", title: "Apply to 3 more remote Web3 roles" });
    await snoozeActionItem(userId, action.id, new Date(Date.now() + 24 * 60 * 60 * 1000));

    mockPlan(actionListPlan({ when: "tomorrow" }));
    await sendAgentMessage(server, userId, "what actions do i have tomorrow?");

    mockPlan({ topic: "actions", intent: "archive", operations: [op("action.archive", { actionId: action.id })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "archive it");

    mockPlan(actionListPlan({ when: "tomorrow" }));
    const reply = await sendAgentMessage(server, userId, "what actions do i have tomorrow?");

    assert.doesNotMatch(reply.reply, /apply to 3 more remote web3 roles/i);
    assert.match(reply.reply, /don't have any actions scheduled for tomorrow/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3B: archive a deferred action -> the payload sent to the planner drops it from backgroundDeferredActions and records it in recentStateChanges", async () => {
  const userId = `state-3b-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goalResult = await createGoal(userId, { title: "Find a fully remote Web3 developer job", category: "career", priority: "medium" });
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
    const action = await createActionItem(userId, { source: "manual", title: "Apply to 3 more remote Web3 roles", goalId: goalResult.goal.id });
    await snoozeActionItem(userId, action.id, new Date(Date.now() + 24 * 60 * 60 * 1000));

    const server = buildServer();
    try {
      mockPlan(actionListPlan({ when: "tomorrow" }));
      await sendAgentMessage(server, userId, "what actions do i have tomorrow?");

      mockPlan({ topic: "actions", intent: "archive", operations: [op("action.archive", { actionId: action.id })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
      await sendAgentMessage(server, userId, "archive it");
    } finally {
      clearAgentRuntimeMocks();
      await server.close();
    }

    const context = await loadContext(userId, "telegram");
    const payload = JSON.parse(buildUserPayload("what should I do today?", context)) as {
      context: { backgroundDeferredActions: Array<{ title: string }>; backgroundOpenActions: Array<{ title: string }>; recentStateChanges: string[] };
    };
    assert.ok(
      !payload.context.backgroundDeferredActions.some((a) => /apply to 3 more remote web3 roles/i.test(a.title)),
      "the archived action must not appear in backgroundDeferredActions"
    );
    assert.ok(
      !payload.context.backgroundOpenActions.some((a) => /apply to 3 more remote web3 roles/i.test(a.title)),
      "the archived action must not appear in backgroundOpenActions"
    );
    assert.ok(
      payload.context.recentStateChanges.some((line) => /archived.*apply to 3 more remote web3 roles/i.test(line)),
      `expected the archive to show up as ground truth in recentStateChanges, got: ${JSON.stringify(payload.context.recentStateChanges)}`
    );
  } finally {
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3C: complete an action -> it's excluded from goal.recommend_next_action's linked-open-actions state", async () => {
  const server = buildServer();
  const userId = `state-3c-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goalResult = await createGoal(userId, { title: "Find a fully remote Web3 developer job", category: "career", priority: "medium" });
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
    const action = await createActionItem(userId, { source: "manual", title: "Apply to 3 more remote Web3 roles", goalId: goalResult.goal.id });

    mockPlan(actionListPlan());
    await sendAgentMessage(server, userId, "show my actions");

    mockPlan({ topic: "actions", intent: "complete", operations: [op("action.complete", { actionId: action.id })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "done");

    mockPlan({
      topic: "goals",
      intent: "next_action",
      operations: [op("goal.recommend_next_action", { recommendation: "Let's keep momentum.", proposedAction: "Apply to 5 more remote Web3 roles" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "what should I do next?");

    assert.doesNotMatch(reply.reply, /existing open actions? you can use.*apply to 3 more remote web3 roles/i);
    assert.equal(reply.debug.pendingOperation, true, "with no real open action left, the proposedAction should open a normal confirmation");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3D: snooze an action to tomorrow -> next 'show my actions' hides it from the open-now list", async () => {
  const server = buildServer();
  const userId = `state-3d-${randomUUID()}`;
  try {
    await seedUser(userId);
    const action = await createActionItem(userId, { source: "manual", title: "Apply to 3 more remote Web3 roles" });

    mockPlan(actionListPlan());
    await sendAgentMessage(server, userId, "show my actions");

    mockPlan({ topic: "actions", intent: "snooze", operations: [op("action.snooze", { actionId: action.id, untilText: "tomorrow" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "move it to tomorrow");

    mockPlan(actionListPlan());
    const reply = await sendAgentMessage(server, userId, "show my actions");

    assert.doesNotMatch(reply.reply, /apply to 3 more remote web3 roles/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3E: creating an action makes it show up immediately in the next 'show actions'", async () => {
  const server = buildServer();
  const userId = `state-3e-${randomUUID()}`;
  try {
    await seedUser(userId);

    mockPlan({ topic: "actions", intent: "create", operations: [op("action.create", { title: "Apply to 3 more remote Web3 roles" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "apply to 3 more remote web3 roles");

    mockPlan(actionListPlan());
    const reply = await sendAgentMessage(server, userId, "show my actions");

    assert.match(reply.reply, /apply to 3 more remote web3 roles/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 5: visible entities are refreshed/invalidated after a mutation --------------------------

test("5A: archiving a visible action removes it from session.visibleEntities", async () => {
  const server = buildServer();
  const userId = `state-5a-${randomUUID()}`;
  try {
    await seedUser(userId);
    const action = await createActionItem(userId, { source: "manual", title: "Apply to 3 more remote Web3 roles" });

    mockPlan(actionListPlan());
    await sendAgentMessage(server, userId, "show my actions");

    const before = await getAgentSession(userId);
    const visibleBefore = before?.visibleEntities as Array<{ id: string }>;
    assert.ok(visibleBefore.some((e) => e.id === action.id), "the action must be visible before archiving");

    mockPlan({ topic: "actions", intent: "archive", operations: [op("action.archive", { actionId: action.id })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "archive 1");

    const after = await getAgentSession(userId);
    const visibleAfter = after?.visibleEntities as Array<{ id: string }>;
    assert.ok(!visibleAfter.some((e) => e.id === action.id), "the archived action must be pruned from visibleEntities");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("5B: archiveActionItem itself is idempotent — a second call on an already-archived id is a real no-op, never a fraudulent second success", async () => {
  const userId = `state-5b-${randomUUID()}`;
  try {
    await seedUser(userId);
    const action = await createActionItem(userId, { source: "manual", title: "Apply to 3 more remote Web3 roles" });

    const first = await archiveActionItem(userId, action.id);
    assert.ok(first, "the first archive must succeed");
    assert.equal(first?.status, "archived");

    const second = await archiveActionItem(userId, action.id);
    assert.equal(second, undefined, "a second archive of the same id must be a real no-op, not a fraudulent second success");

    const item = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(item?.status, "archived");
  } finally {
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("5B-chat: after archiving a visible action, a bare 'archive it again' honestly asks rather than resolving back to the now-archived id", async () => {
  const server = buildServer();
  const userId = `state-5b-chat-${randomUUID()}`;
  try {
    await seedUser(userId);
    const action = await createActionItem(userId, { source: "manual", title: "Apply to 3 more remote Web3 roles" });

    mockPlan(actionListPlan());
    await sendAgentMessage(server, userId, "show my actions");

    mockPlan({ topic: "actions", intent: "archive", operations: [op("action.archive", { actionId: action.id })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const first = await sendAgentMessage(server, userId, "archive 1");
    assert.match(first.reply, /^archived/i);
    assert.equal(first.debug.mutationExecuted, true);

    mockPlan({ topic: "actions", intent: "archive", operations: [op("action.archive", { actionId: action.id })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const second = await sendAgentMessage(server, userId, "archive it again");

    assert.doesNotMatch(second.reply, /^archived/i, "must never claim a fresh archive succeeded twice");
    assert.equal(second.debug.mutationExecuted, false, "nothing was actually visible/groundable to re-archive");

    const item = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(item?.status, "archived");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("5C: completeActionItem is idempotent — a second call on an already-completed id is a real no-op (pre-existing guarantee, regression-guarded here)", async () => {
  const userId = `state-5c-${randomUUID()}`;
  try {
    await seedUser(userId);
    const action = await createActionItem(userId, { source: "manual", title: "Apply to 3 more remote Web3 roles" });

    const first = await completeActionItem(userId, action.id);
    assert.ok(first);
    assert.equal(first?.status, "completed");

    const second = await completeActionItem(userId, action.id);
    assert.equal(second, undefined, "a second completion of the same id must be a real no-op");

    const item = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(item?.status, "completed");
  } finally {
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("5C-chat: after completing a visible action, a bare second 'done' honestly asks rather than resolving back to the now-completed id", async () => {
  const server = buildServer();
  const userId = `state-5c-chat-${randomUUID()}`;
  try {
    await seedUser(userId);
    const action = await createActionItem(userId, { source: "manual", title: "Apply to 3 more remote Web3 roles" });

    mockPlan(actionListPlan());
    await sendAgentMessage(server, userId, "show my actions");

    mockPlan({ topic: "actions", intent: "complete", operations: [op("action.complete", { actionId: action.id })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const first = await sendAgentMessage(server, userId, "done");
    assert.equal(first.debug.mutationExecuted, true);

    mockPlan({ topic: "actions", intent: "complete", operations: [op("action.complete", { actionId: action.id })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const second = await sendAgentMessage(server, userId, "done again");

    assert.doesNotMatch(second.reply, /nice — marked/i, "must never claim a fresh completion succeeded twice");
    assert.equal(second.debug.mutationExecuted, false);

    const item = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(item?.status, "completed");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("5D: bulk-archiving prunes every archived id from visibleEntities, not just replaces it with them", async () => {
  const server = buildServer();
  const userId = `state-5d-${randomUUID()}`;
  try {
    await seedUser(userId);
    const first = await createActionItem(userId, { source: "manual", title: "Review 10 remote roles" });
    const second = await createActionItem(userId, { source: "manual", title: "DM 3 Web3 recruiters" });

    mockPlan(actionListPlan());
    await sendAgentMessage(server, userId, "show my actions");

    const reply = await sendAgentMessage(server, userId, "archive all");
    assert.equal(reply.debug.pendingOperation, true);
    await sendAgentMessage(server, userId, "yes");

    const after = await getAgentSession(userId);
    const visibleAfter = after?.visibleEntities as Array<{ id: string }>;
    assert.ok(!visibleAfter.some((e) => e.id === first.id || e.id === second.id), "both bulk-archived actions must be pruned from visibleEntities");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
