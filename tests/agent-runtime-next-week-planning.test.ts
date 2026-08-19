import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../packages/db/src/index.ts";
import { buildServer } from "../apps/api/src/server.ts";

/**
 * Agent Runtime v3 next-week planning flow — migrating "plan next week" from
 * the legacy /messages/process brain (apps/api/src/legacy/messages-process.ts,
 * apps/api/src/legacy/planning-conversation.ts's PendingAction-coupled
 * opt-in-create reply parser) into v3's own typed
 * planning.next_week_start/next_week_edit/next_week_apply tools
 * (apps/api/src/agent-runtime/tool-catalog.ts). Plan-context assembly and
 * plan-suggestion generation (apps/api/src/planning/next-week.ts) are shared
 * with legacy, not duplicated.
 *
 * These tests seed no goals/actions, so plan generation deterministically
 * falls back to the three fixed low-priority suggestions
 * (generateDeterministicNextWeekPlanSuggestions' "suggestions.length < 3"
 * branch) — no LLM call, no network dependency.
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

async function seedUser(userId: string): Promise<void> {
  await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
}

function nextWeekStartPlan(): void {
  mockPlan({
    topic: "next_week_planning",
    intent: "start_next_week_plan",
    operations: [op("planning.next_week_start")],
    needsClarification: false,
    clarificationQuestion: null,
    replyDraft: ""
  });
}

function nextWeekEditPlan(args: Record<string, unknown>): void {
  mockPlan({
    topic: "next_week_planning",
    intent: "edit_next_week_plan",
    operations: [op("planning.next_week_edit", args)],
    needsClarification: false,
    clarificationQuestion: null,
    replyDraft: ""
  });
}

test("agent/message: 'plan next week' returns a proposed draft plan", async () => {
  const server = buildServer();
  const userId = `plan-start-${randomUUID()}`;

  try {
    await seedUser(userId);
    nextWeekStartPlan();
    const reply = await send(server, userId, "plan next week");

    assert.match(reply.reply, /draft plan/i);
    assert.match(reply.reply, /1\./);
    assert.match(reply.reply, /reply: yes/i);
    assert.equal(reply.debug.mutationExecuted, false);
    assert.equal(reply.debug.pendingOperation, true, "a plan draft opens a pending confirmation");
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: 'help me plan next week' and 'make a plan for next week based on my goals' both propose a draft", async () => {
  const server = buildServer();
  const userId = `plan-phrasing-${randomUUID()}`;

  try {
    await seedUser(userId);

    nextWeekStartPlan();
    const replyA = await send(server, userId, "help me plan next week");
    assert.match(replyA.reply, /draft plan/i);

    nextWeekStartPlan();
    const replyB = await send(server, userId, "make a plan for next week based on my goals");
    assert.match(replyB.reply, /draft plan/i);
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: next_week_start stores numbered plan-suggestion entities and a pending operation in the v3 session", async () => {
  const server = buildServer();
  const userId = `plan-session-${randomUUID()}`;

  try {
    await seedUser(userId);
    nextWeekStartPlan();
    await send(server, userId, "plan next week");

    const row = await prisma.agentConversationSession.findUnique({ where: { userId_channel: { userId, channel: "telegram" } } });
    const visibleEntities = row?.visibleEntities as Array<{ type: string; id: string; label: string; index?: number }> | null;

    assert.ok(Array.isArray(visibleEntities) && visibleEntities.length > 0);
    assert.ok(visibleEntities?.every((entity) => entity.type === "plan_suggestion"));
    assert.equal(visibleEntities?.[0]?.index, 1);

    const pendingOperation = row?.pendingOperation as { operations: Array<{ tool: string; args: { selections?: unknown[] } }> } | null;
    assert.ok(pendingOperation, "a pending operation must be set after the draft is shown");
    assert.equal(pendingOperation?.operations[0]?.tool, "planning.next_week_apply");
    assert.ok(Array.isArray(pendingOperation?.operations[0]?.args.selections));
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: 'yes' applies the proposed plan and creates action items", async () => {
  const server = buildServer();
  const userId = `plan-yes-${randomUUID()}`;

  try {
    await seedUser(userId);
    nextWeekStartPlan();
    await send(server, userId, "plan next week");

    // No mockPlan: exact "yes" must be handled deterministically before the planner runs.
    const reply = await send(server, userId, "yes");

    assert.match(reply.reply, /done\. i created/i);
    assert.equal(reply.debug.mutationExecuted, true);
    assert.equal(reply.debug.pendingOperation, false, "the pending draft is cleared once applied");

    const created = await prisma.actionItem.findMany({ where: { userId, sourceProvider: "weekly_plan" } });
    assert.ok(created.length > 0, "applying the draft must create action items");
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: 'cancel' clears the pending plan and mutates nothing", async () => {
  const server = buildServer();
  const userId = `plan-cancel-${randomUUID()}`;

  try {
    await seedUser(userId);
    nextWeekStartPlan();
    await send(server, userId, "plan next week");

    const beforeCancel = await prisma.agentConversationSession.findUnique({ where: { userId_channel: { userId, channel: "telegram" } } });
    assert.ok(beforeCancel?.pendingOperation, "a draft must be pending before cancel");

    const cancelReply = await send(server, userId, "cancel");
    assert.equal(cancelReply.debug.plannerUsed, "none");
    assert.equal(cancelReply.debug.mutationExecuted, false);

    const afterCancel = await prisma.agentConversationSession.findUnique({ where: { userId_channel: { userId, channel: "telegram" } } });
    assert.equal(afterCancel?.pendingOperation, null, "pending plan must be cleared after cancel");
    assert.deepEqual(afterCancel?.visibleEntities, []);

    const created = await prisma.actionItem.findMany({ where: { userId, sourceProvider: "weekly_plan" } });
    assert.equal(created.length, 0, "cancel must not create anything");
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: 'remove 1' updates the proposal, and confirming only creates the remaining items", async () => {
  const server = buildServer();
  const userId = `plan-remove-${randomUUID()}`;

  try {
    await seedUser(userId);
    nextWeekStartPlan();
    const startReply = await send(server, userId, "plan next week");
    const firstTitle = startReply.reply.match(/^1\. \w+ — (.+)$/m)?.[1];
    assert.ok(firstTitle, "expected item 1's title to be parseable from the draft");

    nextWeekEditPlan({ removeIndexes: [1] });
    const editReply = await send(server, userId, "remove 1");

    assert.equal(editReply.debug.mutationExecuted, false, "editing the draft must not mutate anything");
    assert.doesNotMatch(editReply.reply, new RegExp(firstTitle!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const row = await prisma.agentConversationSession.findUnique({ where: { userId_channel: { userId, channel: "telegram" } } });
    const pendingOperation = row?.pendingOperation as { operations: Array<{ args: { selections?: Array<{ title: string }> } }> } | null;
    const remainingTitles = pendingOperation?.operations[0]?.args.selections?.map((s) => s.title) ?? [];
    assert.ok(!remainingTitles.includes(firstTitle), "removed item must not be in the updated draft");

    const applyReply = await send(server, userId, "yes");
    assert.doesNotMatch(applyReply.reply, new RegExp(firstTitle!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const created = await prisma.actionItem.findMany({ where: { userId, sourceProvider: "weekly_plan" } });
    assert.ok(created.every((item) => item.title !== firstTitle), "the removed suggestion must never be created");
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: 'change 1 to Tuesday' updates item 1's day deterministically", async () => {
  const server = buildServer();
  const userId = `plan-change-${randomUUID()}`;

  try {
    await seedUser(userId);
    nextWeekStartPlan();
    await send(server, userId, "plan next week");

    nextWeekEditPlan({ changes: [{ index: 1, dueText: "Tuesday" }] });
    const editReply = await send(server, userId, "change 1 to Tuesday");

    assert.equal(editReply.debug.mutationExecuted, false);
    assert.match(editReply.reply, /tuesday/i);

    const row = await prisma.agentConversationSession.findUnique({ where: { userId_channel: { userId, channel: "telegram" } } });
    const pendingOperation = row?.pendingOperation as { operations: Array<{ args: { selections?: Array<{ index: number; suggestedDueAt: string }> } }> } | null;
    const item1 = pendingOperation?.operations[0]?.args.selections?.find((s) => s.index === 1);
    assert.ok(item1, "item 1 must still be present after the edit");

    const dueAt = new Date(item1!.suggestedDueAt);
    const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(dueAt);
    assert.equal(weekday, "Tuesday");
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: 'yes' with no pending plan gives the fixed no-pending reply", async () => {
  const server = buildServer();
  const userId = `plan-yes-no-pending-${randomUUID()}`;

  try {
    await seedUser(userId);

    // No planning.next_week_start turn happened this conversation — nothing is pending.
    const reply = await send(server, userId, "yes");
    assert.equal(reply.reply, "I don't have anything pending to confirm.");
    assert.equal(reply.debug.mutationExecuted, false);
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: an edit with no open plan draft asks for clarification and mutates nothing", async () => {
  const server = buildServer();
  const userId = `plan-edit-no-draft-${randomUUID()}`;

  try {
    await seedUser(userId);

    // No planning.next_week_start turn happened — session.pendingOperation is empty.
    nextWeekEditPlan({ removeIndexes: [1] });
    const reply = await send(server, userId, "remove 1");

    assert.match(reply.reply, /don't have a draft plan|plan next week/i);
    assert.equal(reply.operationsExecuted.length, 0, "nothing should have executed");
    assert.equal(reply.debug.mutationExecuted, false);

    const created = await prisma.actionItem.findMany({ where: { userId, sourceProvider: "weekly_plan" } });
    assert.equal(created.length, 0);
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: an edit with neither removeIndexes nor changes asks for clarification and mutates nothing", async () => {
  const server = buildServer();
  const userId = `plan-edit-ambiguous-${randomUUID()}`;

  try {
    await seedUser(userId);
    nextWeekStartPlan();
    await send(server, userId, "plan next week");

    nextWeekEditPlan({});
    const reply = await send(server, userId, "make it different somehow");

    assert.match(reply.reply, /what would you like to change/i);
    assert.equal(reply.debug.mutationExecuted, false);

    const row = await prisma.agentConversationSession.findUnique({ where: { userId_channel: { userId, channel: "telegram" } } });
    assert.ok(row?.pendingOperation, "the original draft must remain pending, untouched");
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
