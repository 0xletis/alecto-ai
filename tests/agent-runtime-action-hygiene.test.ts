import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createActionItem, prisma } from "../packages/db/src/index.ts";
import { buildServer } from "../apps/api/src/server.ts";

/**
 * Agent Runtime v3 action-hygiene cleanup flow — migrating "clean up my
 * actions" from the legacy /messages/process brain
 * (apps/api/src/legacy/action-hygiene-conversation.ts,
 * apps/api/src/legacy/messages-process.ts) into v3's own typed
 * action.hygiene_start/action.hygiene_apply tools
 * (apps/api/src/agent-runtime/tool-catalog.ts). The candidate-analysis
 * logic itself (apps/api/src/actions/hygiene-session.ts) and the batch
 * mutation logic (apps/api/src/actions/hygiene.ts) are shared with the
 * legacy module, not duplicated.
 */

interface MockPlan {
  topic: string;
  intent: string;
  operations: Array<{ tool: string; args: unknown; rationale?: string }>;
  needsClarification: boolean;
  clarificationQuestion: string | null;
  replyDraft: string;
}

function op(tool: string, args: unknown = {}, rationale?: string) {
  return { tool, args, rationale };
}

function mockPlan(plan: MockPlan): void {
  process.env.AGENT_RUNTIME_PLANNER_MOCK_RESPONSE = JSON.stringify(plan);
}

function clearMocks(): void {
  delete process.env.AGENT_RUNTIME_PLANNER_MOCK_RESPONSE;
  delete process.env.AGENT_RUNTIME_PLANNER_MOCK_THROW;
}

async function send(server: ReturnType<typeof buildServer>, userId: string, message: string) {
  const response = await server.inject({
    method: "POST",
    url: "/agent/message",
    payload: { userId, message, channel: "telegram" }
  });
  assert.equal(response.statusCode, 200, message);
  return response.json();
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

async function seedUser(userId: string): Promise<void> {
  await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
}

function hygieneStartPlan(): void {
  mockPlan({
    topic: "action_cleanup",
    intent: "show_hygiene_candidates",
    operations: [op("action.hygiene_start")],
    needsClarification: false,
    clarificationQuestion: null,
    replyDraft: ""
  });
}

function hygieneApplyPlan(selections: Array<Record<string, unknown>>): void {
  mockPlan({
    topic: "action_cleanup",
    intent: "apply_hygiene_decisions",
    operations: [op("action.hygiene_apply", { selections })],
    needsClarification: false,
    clarificationQuestion: null,
    replyDraft: ""
  });
}

test("agent/message: 'clean up my actions' returns action hygiene candidates", async () => {
  const server = buildServer();
  const userId = `hygiene-start-${randomUUID()}`;

  try {
    await seedUser(userId);
    const overdue = await createActionItem(userId, {
      source: "manual",
      title: "Do 2 strength sessions",
      priority: "medium",
      dueAt: daysAgo(3)
    });

    hygieneStartPlan();
    const reply = await send(server, userId, "clean up my actions");

    assert.match(reply.reply, /1\./);
    assert.match(reply.reply, new RegExp(overdue.title));
    assert.match(reply.reply, /reply like/i);
    assert.equal(reply.debug.mutationExecuted, false);
    assert.equal(reply.debug.pendingOperation, false, "hygiene_start never requires confirmation");
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: 'help me clean up my actions' with a clean list says so, no candidates invented", async () => {
  const server = buildServer();
  const userId = `hygiene-clean-${randomUUID()}`;

  try {
    await seedUser(userId);

    hygieneStartPlan();
    const reply = await send(server, userId, "help me clean up my actions");

    assert.match(reply.reply, /clean|no stale|no overdue/i);
    assert.doesNotMatch(reply.reply, /1\./);
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: hygiene_start stores visible action-hygiene items in the v3 session", async () => {
  const server = buildServer();
  const userId = `hygiene-session-${randomUUID()}`;

  try {
    await seedUser(userId);
    const overdue = await createActionItem(userId, {
      source: "manual",
      title: "Review overdue hygiene rules",
      priority: "medium",
      dueAt: daysAgo(4)
    });

    hygieneStartPlan();
    await send(server, userId, "what actions should I complete, snooze, or archive?");

    const row = await prisma.agentConversationSession.findUnique({ where: { userId_channel: { userId, channel: "telegram" } } });
    const visibleEntities = row?.visibleEntities as Array<{ type: string; id: string; label: string; index?: number }> | null;

    assert.ok(Array.isArray(visibleEntities));
    const entity = visibleEntities?.find((item) => item.id === overdue.id);
    assert.ok(entity, "the overdue action must be a visible entity after hygiene_start");
    assert.equal(entity?.type, "action");
    assert.equal(entity?.index, 1);
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: 'complete 1' completes the correct action from the visible hygiene list", async () => {
  const server = buildServer();
  const userId = `hygiene-complete-${randomUUID()}`;

  try {
    await seedUser(userId);
    const overdue = await createActionItem(userId, {
      source: "manual",
      title: "Check cheap car listings twice",
      priority: "medium",
      dueAt: daysAgo(3)
    });

    hygieneStartPlan();
    await send(server, userId, "clean up my actions");

    hygieneApplyPlan([{ index: 1, decision: "complete" }]);
    const reply = await send(server, userId, "complete 1");

    assert.match(reply.reply, /completed/i);
    assert.match(reply.reply, new RegExp(overdue.title));
    assert.equal(reply.debug.mutationExecuted, true);

    const updated = await prisma.actionItem.findUnique({ where: { id: overdue.id } });
    assert.equal(updated?.status, "completed");
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: 'snooze 1 to tomorrow' snoozes the correct action from the visible hygiene list", async () => {
  const server = buildServer();
  const userId = `hygiene-snooze-${randomUUID()}`;

  try {
    await seedUser(userId);
    const overdue = await createActionItem(userId, {
      source: "manual",
      title: "Write YouTube script",
      priority: "medium",
      dueAt: daysAgo(3)
    });

    hygieneStartPlan();
    await send(server, userId, "clean up my actions");

    hygieneApplyPlan([{ index: 1, decision: "snooze", snoozeUntilText: "tomorrow" }]);
    const reply = await send(server, userId, "snooze 1 to tomorrow");

    assert.match(reply.reply, /snoozed/i);
    assert.equal(reply.debug.mutationExecuted, true);

    const updated = await prisma.actionItem.findUnique({ where: { id: overdue.id } });
    assert.equal(updated?.status, "snoozed");
    assert.ok(updated?.snoozedUntil);
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: 'archive 1' archives the correct action from the visible hygiene list", async () => {
  const server = buildServer();
  const userId = `hygiene-archive-${randomUUID()}`;

  try {
    await seedUser(userId);
    const overdue = await createActionItem(userId, {
      source: "manual",
      title: "Review CV",
      priority: "medium",
      dueAt: daysAgo(3)
    });

    hygieneStartPlan();
    await send(server, userId, "clean up my actions");

    hygieneApplyPlan([{ index: 1, decision: "archive" }]);
    const reply = await send(server, userId, "archive 1");

    assert.match(reply.reply, /archived/i);
    assert.equal(reply.debug.mutationExecuted, true);

    const updated = await prisma.actionItem.findUnique({ where: { id: overdue.id } });
    assert.equal(updated?.status, "archived");
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: 'keep 1 and archive 2' applies distinct decisions to each visible item", async () => {
  const server = buildServer();
  const userId = `hygiene-keep-archive-${randomUUID()}`;

  try {
    await seedUser(userId);
    // getActionItems orders by dueAt ascending (most overdue first) — the earlier dueAt lands
    // at index 1 in the hygiene list, not creation order.
    const toKeep = await createActionItem(userId, { source: "manual", title: "Apply to jobs", priority: "medium", dueAt: daysAgo(4) });
    const toArchive = await createActionItem(userId, { source: "manual", title: "Old dead task", priority: "medium", dueAt: daysAgo(3) });

    hygieneStartPlan();
    await send(server, userId, "clean up my actions");

    hygieneApplyPlan([
      { index: 1, decision: "keep" },
      { index: 2, decision: "archive" }
    ]);
    const reply = await send(server, userId, "keep 1 and archive 2");

    assert.match(reply.reply, /kept/i);
    assert.match(reply.reply, /archived/i);

    const keptAction = await prisma.actionItem.findUnique({ where: { id: toKeep.id } });
    const archivedAction = await prisma.actionItem.findUnique({ where: { id: toArchive.id } });
    assert.equal(keptAction?.status, "open", "'keep' must not mutate the action");
    assert.equal(archivedAction?.status, "archived");
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: 'complete 1, snooze 2 to Friday, archive 3' applies all three decisions in one reply", async () => {
  const server = buildServer();
  const userId = `hygiene-multi-${randomUUID()}`;

  try {
    await seedUser(userId);
    // getActionItems orders by dueAt ascending (most overdue first) — earlier dueAt lands at
    // the lower index in the hygiene list, not creation order.
    const toComplete = await createActionItem(userId, { source: "manual", title: "Do 2 strength sessions", priority: "medium", dueAt: daysAgo(5) });
    const toSnooze = await createActionItem(userId, { source: "manual", title: "Review overdue hygiene rules", priority: "medium", dueAt: daysAgo(4) });
    const toArchive = await createActionItem(userId, { source: "manual", title: "Check cheap car listings twice", priority: "medium", dueAt: daysAgo(3) });

    hygieneStartPlan();
    const startReply = await send(server, userId, "clean up my actions");
    assert.match(startReply.reply, new RegExp(toComplete.title));
    assert.match(startReply.reply, new RegExp(toSnooze.title));
    assert.match(startReply.reply, new RegExp(toArchive.title));

    hygieneApplyPlan([
      { index: 1, decision: "complete" },
      { index: 2, decision: "snooze", snoozeUntilText: "friday" },
      { index: 3, decision: "archive" }
    ]);
    const applyReply = await send(server, userId, "complete 1, snooze 2 to Friday, archive 3");

    assert.match(applyReply.reply, /done/i);
    assert.match(applyReply.reply, /completed/i);
    assert.match(applyReply.reply, /snoozed/i);
    assert.match(applyReply.reply, /archived/i);
    assert.equal(applyReply.operationsExecuted.length, 1, "one hygiene_apply operation batches all three decisions");

    const completed = await prisma.actionItem.findUnique({ where: { id: toComplete.id } });
    const snoozed = await prisma.actionItem.findUnique({ where: { id: toSnooze.id } });
    const archived = await prisma.actionItem.findUnique({ where: { id: toArchive.id } });
    assert.equal(completed?.status, "completed");
    assert.equal(snoozed?.status, "snoozed");
    assert.equal(archived?.status, "archived");
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: 'complete 1' with no visible hygiene session asks for clarification and mutates nothing", async () => {
  const server = buildServer();
  const userId = `hygiene-no-session-${randomUUID()}`;

  try {
    await seedUser(userId);
    const action = await createActionItem(userId, { source: "manual", title: "Some open task", priority: "medium" });

    // No hygiene_start turn happened this conversation — session.visibleEntities is empty.
    hygieneApplyPlan([{ index: 1, decision: "complete" }]);
    const reply = await send(server, userId, "complete 1");

    assert.match(reply.reply, /clean up my actions|which action|don't have/i);
    assert.equal(reply.operationsExecuted.length, 0, "nothing should have executed");
    assert.equal(reply.debug.mutationExecuted, false);

    const unchanged = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(unchanged?.status, "open", "no visible session means nothing may be mutated");
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: 'cancel' clears the visible action-hygiene session state safely", async () => {
  const server = buildServer();
  const userId = `hygiene-cancel-${randomUUID()}`;

  try {
    await seedUser(userId);
    const overdue = await createActionItem(userId, { source: "manual", title: "Stale task", priority: "medium", dueAt: daysAgo(3) });

    hygieneStartPlan();
    await send(server, userId, "clean up my actions");

    const beforeCancel = await prisma.agentConversationSession.findUnique({ where: { userId_channel: { userId, channel: "telegram" } } });
    assert.ok(Array.isArray(beforeCancel?.visibleEntities) && (beforeCancel!.visibleEntities as unknown[]).length > 0);

    // No mockPlan: exact "cancel" must be handled deterministically before the planner runs.
    const cancelReply = await send(server, userId, "cancel");
    assert.equal(cancelReply.debug.plannerUsed, "none");
    assert.equal(cancelReply.debug.mutationExecuted, false);

    const afterCancel = await prisma.agentConversationSession.findUnique({ where: { userId_channel: { userId, channel: "telegram" } } });
    assert.deepEqual(afterCancel?.visibleEntities, [], "visible hygiene entities must be cleared after cancel");

    // A stray later "complete 1" must not silently resolve against the now-cleared session.
    hygieneApplyPlan([{ index: 1, decision: "complete" }]);
    const strayReply = await send(server, userId, "complete 1");
    assert.equal(strayReply.debug.mutationExecuted, false);

    const unchanged = await prisma.actionItem.findUnique({ where: { id: overdue.id } });
    assert.equal(unchanged?.status, "open");
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: 'yes' with no real pending hygiene operation gives the fixed no-pending reply", async () => {
  const server = buildServer();
  const userId = `hygiene-yes-no-pending-${randomUUID()}`;

  try {
    await seedUser(userId);
    await createActionItem(userId, { source: "manual", title: "Stale task", priority: "medium", dueAt: daysAgo(3) });

    hygieneStartPlan();
    await send(server, userId, "clean up my actions");

    // hygiene_apply never requires confirmation, so there is nothing pending for "yes" to confirm.
    const reply = await send(server, userId, "yes");
    assert.equal(reply.reply, "I don't have anything pending to confirm.");
    assert.equal(reply.debug.mutationExecuted, false);
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
