import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createGoal, prisma } from "../packages/db/src/index.ts";
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
  delete process.env.AGENT_RUNTIME_FORCE_ERROR;
  delete process.env.AGENT_RUNTIME_PLANNING_TRACE;
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

function nextWeekEditPlan(args: Record<string, unknown>, replyDraft = ""): void {
  mockPlan({
    topic: "next_week_planning",
    intent: "edit_next_week_plan",
    operations: [op("planning.next_week_edit", args)],
    needsClarification: false,
    clarificationQuestion: null,
    replyDraft
  });
}

function nextWeekShowCurrentPlan(): void {
  mockPlan({
    topic: "next_week_planning",
    intent: "show_current_next_week_plan",
    operations: [op("planning.next_week_show_current")],
    needsClarification: false,
    clarificationQuestion: null,
    replyDraft: ""
  });
}

/**
 * Seeds five goals whose titles/categories deterministically map (via
 * suggestionForGoal's keyword regexes in apps/api/src/planning/next-week.ts)
 * to five distinct, uniquely-identifiable suggestion titles: developer jobs,
 * YouTube script, strength/gym sessions, reading, and car listings. The gym
 * goal's own title literally contains "gym" so "the gym one" can resolve via
 * goalTitle text, since the generated suggestion title itself ("Do 2
 * strength sessions") does not.
 */
async function seedFiveTopicGoals(userId: string, lowPriorityTitle?: string): Promise<void> {
  const goals = [
    { title: "Apply to developer jobs", category: "career" },
    { title: "Grow my YouTube channel", category: "creative" },
    { title: "Hit the gym three times a week", category: "health" },
    { title: "Read more books this year", category: "learning" },
    // "finance" (not "lifestyle") would make isRiskControlGoal(goal) true and divert this
    // into a synthetic "Review betting/trading guardrail rules" suggestion instead.
    { title: "Buy a cheap car", category: "lifestyle" }
  ];

  for (const goal of goals) {
    await createGoal(userId, {
      title: goal.title,
      category: goal.category,
      priority: goal.title === lowPriorityTitle ? "low" : "medium"
    });
  }
}

/**
 * Three same-priority, non-fallback goals — generateDeterministicNextWeekPlanSuggestions
 * only pads with its 3 fixed (one of them genuinely low-priority) suggestions when there
 * are fewer than 3 real ones, so exactly 3 same-priority goals is what it takes to test
 * computeLighterPlanRemoval's "no confident low-priority subset" branch on real, uniform
 * data instead of on the padding.
 */
async function seedThreeSamePriorityGoals(userId: string): Promise<void> {
  const goals = [
    { title: "Apply to developer jobs", category: "career" },
    { title: "Hit the gym three times a week", category: "health" },
    { title: "Read more books this year", category: "learning" }
  ];

  for (const goal of goals) {
    await createGoal(userId, { title: goal.title, category: goal.category, priority: "medium" });
  }
}

/**
 * Job + reading + car goals — deliberately mirrors the real Telegram transcript that
 * surfaced this hardening pass's bugs (a draft narrowed down to "Apply to 3 developer jobs"
 * and "Check cheap car listings twice" before the reported "move the jobs to Friday" bug).
 * Three same-priority real suggestions avoids generateDeterministicNextWeekPlanSuggestions'
 * "fewer than 3 -> pad with 3 fixed items" fallback.
 */
async function seedJobReadingCarGoals(userId: string): Promise<void> {
  const goals = [
    { title: "Apply to developer jobs", category: "career" },
    { title: "Read more books this year", category: "learning" },
    { title: "Buy a cheap car", category: "lifestyle" }
  ];

  for (const goal of goals) {
    await createGoal(userId, { title: goal.title, category: goal.category, priority: "medium" });
  }
}

function draftSelections(row: { pendingOperation: unknown } | null): Array<{ index: number; title: string; suggestedDueAt: string }> {
  const pendingOperation = row?.pendingOperation as
    | { operations: Array<{ args: { selections?: Array<{ index: number; title: string; suggestedDueAt: string }> } }> }
    | null;
  return pendingOperation?.operations[0]?.args.selections ?? [];
}

function draftVisibleEntities(row: { visibleEntities: unknown } | null): Array<{ index?: number; label: string; type: string }> {
  return (row?.visibleEntities as Array<{ index?: number; label: string; type: string }> | null) ?? [];
}

async function getSession(userId: string) {
  return prisma.agentConversationSession.findUnique({ where: { userId_channel: { userId, channel: "telegram" } } });
}

/** Invariant: pendingOperation's draft selections and visibleEntities must represent the exact same draft — same count, same index<->title pairing, in order. */
function assertDraftInSync(
  row: { pendingOperation: unknown; visibleEntities: unknown } | null,
  messageForContext: string
): void {
  const selections = draftSelections(row);
  const entities = draftVisibleEntities(row);
  assert.equal(entities.length, selections.length, `${messageForContext}: visibleEntities count must match pendingOperation selections count`);
  for (const selection of selections) {
    const entity = entities.find((e) => e.index === selection.index);
    assert.ok(entity, `${messageForContext}: visibleEntities must have an entry for index ${selection.index}`);
    assert.equal(entity?.label, selection.title, `${messageForContext}: visibleEntities label must match the draft item's title at index ${selection.index}`);
    assert.equal(entity?.type, "plan_suggestion");
  }
}

test("agent/message: 'plan next week' returns a proposed draft plan", async () => {
  const server = buildServer();
  const userId = `plan-start-${randomUUID()}`;

  try {
    await seedUser(userId);
    nextWeekStartPlan();
    const reply = await send(server, userId, "plan next week");

    assert.match(reply.reply, /draft plan for next week:/i);
    assert.doesNotMatch(reply.reply, /next week plan:/i);
    assert.match(reply.reply, /1\./);
    assert.match(reply.reply, /tell me naturally what to change/i);
    assert.match(reply.reply, /"yes" to create it/i);
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

// --- Telegram smoke-bug regression: "remove 1" produced a schema validation error,
// yet the SUBSEQUENT turn's draft showed item 1 removed anyway, contradicting the
// "Nothing was changed" reply. Root cause: (1) the planner JSON schema generator never
// marked an optional array field nullable and never propagated `.describe()` guidance to
// the LLM, so nothing told it indexes are 1-based; (2) planning.next_week_edit resolved
// indexes/dates per-item in the executor, so a partially-invalid edit could still execute
// the valid part of itself. Both are fixed: the schema generator (tool-catalog.ts) now
// marks optional arrays nullable and sends descriptions, and ALL resolution (numeric
// indexes, natural refs, day-text parsing) now happens atomically in the validator before
// anything executes — an edit either fully resolves or nothing about it touches session
// state, ever.

test("agent/message: an invalid planning.next_week_edit (bad index) does not mutate the session or DB, and the reply is truthful", async () => {
  const server = buildServer();
  const userId = `plan-invalid-edit-${randomUUID()}`;

  try {
    await seedUser(userId);
    nextWeekStartPlan();
    await send(server, userId, "plan next week");
    const before = await getSession(userId);

    // Schema-level invalid: 0 fails z.number().int().positive() — reproduces the real bug's
    // exact shape (a 0-based index where 1-based was required).
    nextWeekEditPlan({ removeIndexes: [0] });
    const reply = await send(server, userId, "remove 1");

    assert.match(reply.reply, /couldn't do that|missing required details/i);
    assert.match(reply.reply, /nothing was changed/i);
    assert.equal(reply.debug.mutationExecuted, false);

    const after = await getSession(userId);
    assert.deepEqual(after?.pendingOperation, before?.pendingOperation, "an invalid edit must leave the pending draft byte-for-byte untouched");
    assert.deepEqual(after?.visibleEntities, before?.visibleEntities, "an invalid edit must leave visible entities untouched");

    const created = await prisma.actionItem.findMany({ where: { userId, sourceProvider: "weekly_plan" } });
    assert.equal(created.length, 0);
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: a next_week_edit targeting a nonexistent item number asks for clarification and mutates nothing", async () => {
  const server = buildServer();
  const userId = `plan-unknown-index-${randomUUID()}`;

  try {
    await seedUser(userId);
    nextWeekStartPlan();
    await send(server, userId, "plan next week");
    const before = await getSession(userId);

    nextWeekEditPlan({ removeIndexes: [99] });
    const reply = await send(server, userId, "remove 99");

    assert.match(reply.reply, /no item 99/i);
    assert.equal(reply.debug.mutationExecuted, false);

    const after = await getSession(userId);
    assert.deepEqual(after?.pendingOperation, before?.pendingOperation);
    assert.deepEqual(after?.visibleEntities, before?.visibleEntities);
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: 'remove 1' succeeds outright and updates the visible draft (no validation error)", async () => {
  const server = buildServer();
  const userId = `plan-remove-1-succeeds-${randomUUID()}`;

  try {
    await seedUser(userId);
    nextWeekStartPlan();
    const startReply = await send(server, userId, "plan next week");
    const firstTitle = startReply.reply.match(/^1\. \w+ — (.+)$/m)?.[1];
    assert.ok(firstTitle);

    nextWeekEditPlan({ removeIndexes: [1] });
    const reply = await send(server, userId, "remove 1");

    assert.doesNotMatch(reply.reply, /couldn't do that|missing required details/i);
    assert.doesNotMatch(reply.reply, new RegExp(firstTitle!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const selections = draftSelections(await getSession(userId));
    assert.equal(selections.length, 2, "exactly one item should have been removed");
    assert.ok(!selections.some((s) => s.title === firstTitle));
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: after an invalid edit, 'change 1 to Tuesday' still applies to the original item 1", async () => {
  const server = buildServer();
  const userId = `plan-invalid-then-change-${randomUUID()}`;

  try {
    await seedUser(userId);
    nextWeekStartPlan();
    const startReply = await send(server, userId, "plan next week");
    const firstTitle = startReply.reply.match(/^1\. \w+ — (.+)$/m)?.[1];
    assert.ok(firstTitle);

    // A prior, invalid "remove 1" attempt (0-based index) must not have moved anything.
    nextWeekEditPlan({ removeIndexes: [0] });
    await send(server, userId, "remove 1");

    // This turn only asks to change the day — no removeIndexes carried over from the
    // earlier failed attempt (this is exactly the shape that reproduced the real bug: a
    // later turn silently re-including a stale prior request).
    nextWeekEditPlan({ changes: [{ index: 1, dueText: "Tuesday" }] });
    const changeReply = await send(server, userId, "change 1 to Tuesday");

    assert.equal(changeReply.debug.mutationExecuted, false);
    assert.match(changeReply.reply, new RegExp(firstTitle!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(changeReply.reply, /tuesday/i);

    const selections = draftSelections(await getSession(userId));
    assert.equal(selections.length, 3, "no item should have been lost by the earlier invalid attempt");
    const item1 = selections.find((s) => s.index === 1);
    assert.equal(item1?.title, firstTitle, "item 1 must still be the original item, not a shifted one");
    const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(new Date(item1!.suggestedDueAt));
    assert.equal(weekday, "Tuesday");
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: response text never contains the double-plan 'next week plan:' bug", async () => {
  const server = buildServer();
  const userId = `plan-copy-${randomUUID()}`;

  try {
    await seedUser(userId);
    nextWeekStartPlan();
    const startReply = await send(server, userId, "plan next week");
    assert.doesNotMatch(startReply.reply, /next week plan:/i);

    nextWeekEditPlan({ removeIndexes: [1] });
    const editReply = await send(server, userId, "remove 1");
    assert.doesNotMatch(editReply.reply, /next week plan:/i);
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Natural-language edit UX

test("agent/message: 'remove the YouTube one' removes the YouTube/script item", async () => {
  const server = buildServer();
  const userId = `plan-ref-youtube-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedFiveTopicGoals(userId);

    nextWeekStartPlan();
    const startReply = await send(server, userId, "plan next week");
    assert.match(startReply.reply, /youtube/i);

    nextWeekEditPlan({ removeRefs: ["the YouTube one"] });
    const editReply = await send(server, userId, "remove the YouTube one");

    assert.equal(editReply.debug.mutationExecuted, false);
    // Only the numbered draft lines matter here — the reply's own natural-language
    // instruction copy legitimately mentions "YouTube" as an example phrase.
    const draftLines = editReply.reply.split("\n").filter((line: string) => /^\d+\./.test(line));
    assert.ok(draftLines.every((line: string) => !/youtube/i.test(line)));

    const selections = draftSelections(await getSession(userId));
    assert.equal(selections.length, 4, "exactly one item should have been removed");
    assert.ok(!selections.some((s) => /youtube/i.test(s.title)));
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: 'move the gym one to Friday' changes the strength/gym item to Friday", async () => {
  const server = buildServer();
  const userId = `plan-ref-gym-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedFiveTopicGoals(userId);

    nextWeekStartPlan();
    await send(server, userId, "plan next week");

    nextWeekEditPlan({ changes: [{ ref: "the gym one", dueText: "Friday" }] });
    const editReply = await send(server, userId, "move the gym one to Friday");

    assert.equal(editReply.debug.mutationExecuted, false);
    assert.match(editReply.reply, /friday/i);
    assert.match(editReply.reply, /strength/i);

    const selections = draftSelections(await getSession(userId));
    const strengthItem = selections.find((s) => /strength/i.test(s.title));
    assert.ok(strengthItem, "the strength/gym item must still be present");
    const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(new Date(strengthItem!.suggestedDueAt));
    assert.equal(weekday, "Friday");
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: 'remove reading' removes the reading item when it is uniquely matched", async () => {
  const server = buildServer();
  const userId = `plan-ref-reading-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedFiveTopicGoals(userId);

    nextWeekStartPlan();
    await send(server, userId, "plan next week");

    nextWeekEditPlan({ removeRefs: ["reading"] });
    const editReply = await send(server, userId, "remove reading");

    assert.equal(editReply.debug.mutationExecuted, false);

    const selections = draftSelections(await getSession(userId));
    assert.equal(selections.length, 4);
    assert.ok(!selections.some((s) => /read 20 minutes/i.test(s.title)));
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: 'keep job applications and remove the rest' keeps only the matched item", async () => {
  const server = buildServer();
  const userId = `plan-keep-rest-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedFiveTopicGoals(userId);

    nextWeekStartPlan();
    await send(server, userId, "plan next week");

    nextWeekEditPlan({ keepRefs: ["job applications"] });
    const reply = await send(server, userId, "keep job applications and remove the rest");

    assert.equal(reply.debug.mutationExecuted, false);

    const selections = draftSelections(await getSession(userId));
    assert.equal(selections.length, 1);
    assert.match(selections[0].title, /developer jobs/i);
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: an ambiguous natural ref asks for clarification and mutates nothing", async () => {
  const server = buildServer();
  const userId = `plan-ref-ambiguous-${randomUUID()}`;

  try {
    await seedUser(userId);
    // No goals seeded: falls back to the fixed 3-item draft, where "review" appears in both
    // item 1 ("Review open actions...") and item 3 ("Run weekly review...") — a genuine,
    // deterministic two-way ambiguity, not a hallucinated one.
    nextWeekStartPlan();
    await send(server, userId, "plan next week");
    const before = await getSession(userId);

    nextWeekEditPlan({ removeRefs: ["review"] });
    const reply = await send(server, userId, "remove the review one");

    assert.match(reply.reply, /couldn't match/i);
    assert.equal(reply.debug.mutationExecuted, false);

    const after = await getSession(userId);
    assert.deepEqual(after?.pendingOperation, before?.pendingOperation);
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: an unknown natural ref asks for clarification and mutates nothing", async () => {
  const server = buildServer();
  const userId = `plan-ref-unknown-${randomUUID()}`;

  try {
    await seedUser(userId);
    nextWeekStartPlan();
    await send(server, userId, "plan next week");
    const before = await getSession(userId);

    nextWeekEditPlan({ removeRefs: ["xyz totally unrelated topic"] });
    const reply = await send(server, userId, "remove the xyz thing");

    assert.match(reply.reply, /couldn't match/i);
    assert.equal(reply.debug.mutationExecuted, false);

    const after = await getSession(userId);
    assert.deepEqual(after?.pendingOperation, before?.pendingOperation);
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: 'make it lighter' deterministically drops only the clearly lower-priority item", async () => {
  const server = buildServer();
  const userId = `plan-lighter-resolved-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedFiveTopicGoals(userId, "Buy a cheap car");

    nextWeekStartPlan();
    await send(server, userId, "plan next week");

    nextWeekEditPlan({ lighter: true });
    const reply = await send(server, userId, "make it lighter");

    assert.equal(reply.debug.mutationExecuted, false);

    const selections = draftSelections(await getSession(userId));
    assert.equal(selections.length, 4, "exactly the low-priority item should be dropped, nothing else");
    assert.ok(!selections.some((s) => /car listings/i.test(s.title)), "the low-priority item must be gone");
    assert.ok(selections.some((s) => /developer jobs/i.test(s.title)), "higher-priority items must survive");
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: 'make it lighter' asks for clarification instead of guessing when no item is confidently lower priority", async () => {
  const server = buildServer();
  const userId = `plan-lighter-unclear-${randomUUID()}`;

  try {
    await seedUser(userId);
    // Three real, same-priority goal-derived suggestions (not the 3-item fallback padding,
    // which includes one genuinely low-priority item) — no confident signal for what to drop.
    await seedThreeSamePriorityGoals(userId);
    nextWeekStartPlan();
    await send(server, userId, "plan next week");
    const before = await getSession(userId);

    nextWeekEditPlan({ lighter: true });
    const reply = await send(server, userId, "make it lighter");

    assert.match(reply.reply, /not confident which items/i);
    assert.equal(reply.debug.mutationExecuted, false);

    const after = await getSession(userId);
    assert.deepEqual(after?.pendingOperation, before?.pendingOperation, "an unclear 'lighter' request must not remove anything");
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Hardening pass: state-machine correctness bugs found in a real Telegram transcript
// (first "plan next week" threw a generic error; after removing an item and moving the
// remaining one, the draft went empty and the bot then claimed a false success; a "show me
// the plan" follow-up regenerated a brand-new draft instead of showing the current one).

test("regression A: the very first 'plan next week' from a brand-new user (no pre-existing User row) does not throw", async () => {
  const server = buildServer();
  const userId = `plan-first-turn-${randomUUID()}`;

  try {
    // Deliberately no seedUser() call — this is the exact shape of a real user's first-ever
    // message: ensureUser(userId) has to create the User row itself, concurrently with other
    // user-scoped queries in loadContext that may depend on it already existing.
    nextWeekStartPlan();
    const reply = await send(server, userId, "plan next week");

    assert.match(reply.reply, /draft plan for next week:/i);
    assert.notEqual(reply.reply, "I hit an unexpected problem there — please try again.");
    assert.equal(reply.debug.pendingOperation, true);
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("regression: the top-level safety net replies gracefully instead of crashing on an unexpected error, and a normal retry still works", async () => {
  const server = buildServer();
  const userId = `plan-safety-net-${randomUUID()}`;

  try {
    await seedUser(userId);

    process.env.AGENT_RUNTIME_FORCE_ERROR = "true";
    nextWeekStartPlan();
    const firstReply = await send(server, userId, "plan next week");
    assert.equal(firstReply.reply, "I hit an unexpected problem there — please try again.");
    assert.equal(firstReply.debug.mutationExecuted, false);

    delete process.env.AGENT_RUNTIME_FORCE_ERROR;
    nextWeekStartPlan();
    const secondReply = await send(server, userId, "plan next week");
    assert.match(secondReply.reply, /draft plan for next week:/i);
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("regression B: remove reading, remove the car listings one, then move the jobs to Friday — one item survives, it is Friday, the plan is not empty", async () => {
  const server = buildServer();
  const userId = `plan-move-jobs-friday-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedJobReadingCarGoals(userId);

    nextWeekStartPlan();
    await send(server, userId, "plan next week");
    assertDraftInSync(await getSession(userId), "after plan next week");

    nextWeekEditPlan({ removeRefs: ["reading"] });
    await send(server, userId, "remove reading");
    let selections = draftSelections(await getSession(userId));
    assert.equal(selections.length, 2);
    assertDraftInSync(await getSession(userId), "after remove reading");

    nextWeekEditPlan({ removeRefs: ["the car listings one"] });
    const afterCarRemoval = await send(server, userId, "remove the car listings one");
    assert.equal(afterCarRemoval.debug.mutationExecuted, false);
    selections = draftSelections(await getSession(userId));
    assert.equal(selections.length, 1, "exactly one item (the job application) must remain");
    assert.match(selections[0].title, /developer jobs/i);
    assertDraftInSync(await getSession(userId), "after remove the car listings one");

    nextWeekEditPlan({ changes: [{ ref: "the jobs", dueText: "Friday" }] });
    const afterMove = await send(server, userId, "move the jobs to friday");

    assert.equal(afterMove.debug.mutationExecuted, false);
    selections = draftSelections(await getSession(userId));
    assert.equal(selections.length, 1, "the plan must NOT become empty");
    assert.match(selections[0].title, /developer jobs/i, "the item must not have been removed");
    const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(new Date(selections[0].suggestedDueAt));
    assert.equal(weekday, "Friday");
    assertDraftInSync(await getSession(userId), "after move the jobs to friday");

    assert.doesNotMatch(afterMove.reply, /the plan is now empty/i);
    assert.match(afterMove.reply, /friday/i);
    assert.match(afterMove.reply, /developer jobs/i);
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("regression C: 'show me the week plan' shows the current pending draft, it does not regenerate the original draft", async () => {
  const server = buildServer();
  const userId = `plan-show-current-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedJobReadingCarGoals(userId);

    nextWeekStartPlan();
    await send(server, userId, "plan next week");

    nextWeekEditPlan({ removeRefs: ["reading"] });
    await send(server, userId, "remove reading");

    nextWeekEditPlan({ removeRefs: ["the car listings one"] });
    await send(server, userId, "remove the car listings one");

    nextWeekEditPlan({ changes: [{ ref: "the jobs", dueText: "Friday" }] });
    await send(server, userId, "move the jobs to friday");

    const beforeShow = await getSession(userId);

    nextWeekShowCurrentPlan();
    const showReply = await send(server, userId, "show me the week plan");

    assert.equal(showReply.debug.mutationExecuted, false);
    assert.match(showReply.reply, /friday/i);
    assert.match(showReply.reply, /developer jobs/i);
    // Must NOT have regenerated the original draft: no car listings, no Monday-dated line,
    // and only ever the one surviving item.
    assert.doesNotMatch(showReply.reply, /car listings/i);
    const draftLines = showReply.reply.split("\n").filter((line: string) => /^\d+\./.test(line));
    assert.equal(draftLines.length, 1);

    const afterShow = await getSession(userId);
    assert.deepEqual(afterShow?.pendingOperation, beforeShow?.pendingOperation, "'show current plan' must not change the pending draft");
    assert.deepEqual(afterShow?.visibleEntities, beforeShow?.visibleEntities, "'show current plan' must not change visible entities");
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("regression D: an edit that would empty the plan is rejected unless the user explicitly asked to remove everything", async () => {
  const server = buildServer();
  const userId = `plan-reject-empty-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedJobReadingCarGoals(userId);

    nextWeekStartPlan();
    await send(server, userId, "plan next week");
    nextWeekEditPlan({ removeRefs: ["reading"] });
    await send(server, userId, "remove reading");
    nextWeekEditPlan({ removeRefs: ["the car listings one"] });
    await send(server, userId, "remove the car listings one");

    const before = await getSession(userId);
    assert.equal(draftSelections(before).length, 1);

    // Without removeAll, removing the only remaining item must be rejected, not applied.
    nextWeekEditPlan({ removeRefs: ["the jobs"] });
    const reply = await send(server, userId, "remove the jobs");

    assert.match(reply.reply, /remove everything/i);
    assert.equal(reply.debug.mutationExecuted, false);

    const after = await getSession(userId);
    assert.deepEqual(after?.pendingOperation, before?.pendingOperation, "a rejected empty-the-plan edit must not mutate the draft");
    assert.equal(draftSelections(after).length, 1, "the item must still be there");

    // Explicit removeAll is the one way to actually empty it.
    nextWeekEditPlan({ removeRefs: ["the jobs"], removeAll: true });
    const removeAllReply = await send(server, userId, "remove everything, clear the plan");
    assert.match(removeAllReply.reply, /plan is now empty/i);
    assert.equal(draftSelections(await getSession(userId)).length, 0);
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("regression D2: a redundant remove alongside a change to the SAME item does not block the move — the change wins, item survives", async () => {
  const server = buildServer();
  const userId = `plan-contradictory-edit-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedJobReadingCarGoals(userId);

    nextWeekStartPlan();
    await send(server, userId, "plan next week");
    nextWeekEditPlan({ removeRefs: ["reading"] });
    await send(server, userId, "remove reading");
    nextWeekEditPlan({ removeRefs: ["the car listings one"] });
    await send(server, userId, "remove the car listings one");

    const before = await getSession(userId);
    assert.equal(draftSelections(before).length, 1);

    // Live testing showed the real planner does not reliably follow the "never also list it
    // in removeIndexes/removeRefs" prompt instruction, and repeatedly sends a redundant
    // remove alongside the change for the exact item being moved. Rejecting the whole edit
    // in that case (an earlier version of this guard) made "move the jobs to Friday"
    // permanently unusable on a single-item draft — the fix is for the explicit change to
    // win over the redundant remove, not to block the edit entirely.
    nextWeekEditPlan({ removeRefs: ["the jobs"], changes: [{ ref: "the jobs", dueText: "Friday" }] });
    const reply = await send(server, userId, "move the jobs to friday");

    assert.doesNotMatch(reply.reply, /remove everything/i);
    assert.doesNotMatch(reply.reply, /plan is now empty/i);
    assert.match(reply.reply, /friday/i);
    assert.equal(reply.debug.mutationExecuted, false);

    const after = await getSession(userId);
    const selections = draftSelections(after);
    assert.equal(selections.length, 1, "the item must survive a redundant remove+change on itself");
    assert.match(selections[0].title, /developer jobs/i);
    const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(new Date(selections[0].suggestedDueAt));
    assert.equal(weekday, "Friday", "the change must actually apply, not just survive");
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("regression D3: the same redundant-remove-vs-change conflict, expressed with numeric index instead of a ref, also resolves as a move", async () => {
  const server = buildServer();
  const userId = `plan-contradictory-edit-numeric-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedJobReadingCarGoals(userId);

    nextWeekStartPlan();
    await send(server, userId, "plan next week");
    nextWeekEditPlan({ removeRefs: ["reading"] });
    await send(server, userId, "remove reading");
    nextWeekEditPlan({ removeRefs: ["the car listings one"] });
    await send(server, userId, "remove the car listings one");

    assert.equal(draftSelections(await getSession(userId)).length, 1);

    // Same conflict as regression D2, but using removeIndexes/changes[].index (numeric) —
    // the shape a confident planner might use once only one item is visible — instead of refs.
    nextWeekEditPlan({ removeIndexes: [1], changes: [{ index: 1, dueText: "Friday" }] });
    const reply = await send(server, userId, "move it to friday");

    assert.doesNotMatch(reply.reply, /remove everything/i);
    assert.doesNotMatch(reply.reply, /plan is now empty/i);
    assert.match(reply.reply, /friday/i);

    const selections = draftSelections(await getSession(userId));
    assert.equal(selections.length, 1);
    const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(new Date(selections[0].suggestedDueAt));
    assert.equal(weekday, "Friday");
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("regression E: the response composer never claims a change happened unless the executor result confirms it", async () => {
  const server = buildServer();
  const userId = `plan-no-false-claims-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedJobReadingCarGoals(userId);

    nextWeekStartPlan();
    await send(server, userId, "plan next week");
    nextWeekEditPlan({ removeRefs: ["reading"] });
    await send(server, userId, "remove reading");
    nextWeekEditPlan({ removeRefs: ["the car listings one"] });
    await send(server, userId, "remove the car listings one");

    // The planner's own replyDraft falsely claims success for an edit that will actually be
    // rejected (remove-all guard, no removeAll set) — the real Telegram transcript showed
    // exactly this: "I've moved the job application to Friday" alongside a rejection.
    nextWeekEditPlan({ removeRefs: ["the jobs"] }, "I've moved the job application to Friday. Your plan will now reflect that change.");
    const reply = await send(server, userId, "remove the jobs");

    assert.doesNotMatch(reply.reply, /i've moved/i);
    assert.doesNotMatch(reply.reply, /reflect that change/i);
    assert.match(reply.reply, /remove everything/i);
    assert.equal(reply.debug.mutationExecuted, false);
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("regression F: pendingOperation and visibleEntities stay in sync after every successful edit", async () => {
  const server = buildServer();
  const userId = `plan-invariant-sync-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedJobReadingCarGoals(userId);

    nextWeekStartPlan();
    await send(server, userId, "plan next week");
    assertDraftInSync(await getSession(userId), "after start");

    nextWeekEditPlan({ removeRefs: ["reading"] });
    await send(server, userId, "remove reading");
    assertDraftInSync(await getSession(userId), "after remove reading");

    nextWeekEditPlan({ changes: [{ ref: "the jobs", dueText: "Wednesday" }] });
    await send(server, userId, "move the jobs to wednesday");
    assertDraftInSync(await getSession(userId), "after move to wednesday");
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("regression G: a failed edit leaves pendingOperation and visibleEntities byte-for-byte unchanged", async () => {
  const server = buildServer();
  const userId = `plan-invariant-failed-edit-${randomUUID()}`;

  try {
    await seedUser(userId);
    nextWeekStartPlan();
    await send(server, userId, "plan next week");
    const before = await getSession(userId);

    // Unresolvable ref: nothing in the fixed 3-item fallback draft matches "xyz".
    nextWeekEditPlan({ removeRefs: ["xyz nonexistent topic"] });
    const reply = await send(server, userId, "remove the xyz thing");

    assert.equal(reply.debug.mutationExecuted, false);
    const after = await getSession(userId);
    assert.deepEqual(after?.pendingOperation, before?.pendingOperation);
    assert.deepEqual(after?.visibleEntities, before?.visibleEntities);
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("regression: planning.next_week_apply only creates the current pending draft's items after a chain of edits", async () => {
  const server = buildServer();
  const userId = `plan-apply-current-draft-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedJobReadingCarGoals(userId);

    nextWeekStartPlan();
    await send(server, userId, "plan next week");
    nextWeekEditPlan({ removeRefs: ["reading"] });
    await send(server, userId, "remove reading");
    nextWeekEditPlan({ removeRefs: ["the car listings one"] });
    await send(server, userId, "remove the car listings one");
    nextWeekEditPlan({ changes: [{ ref: "the jobs", dueText: "Friday" }] });
    await send(server, userId, "move the jobs to friday");

    const applyReply = await send(server, userId, "yes");
    assert.match(applyReply.reply, /done\. i created/i);
    assert.equal(applyReply.debug.pendingOperation, false);

    const created = await prisma.actionItem.findMany({ where: { userId, sourceProvider: "weekly_plan" } });
    assert.equal(created.length, 1, "only the one surviving draft item must be created");
    assert.match(created[0].title, /developer jobs/i);
    const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(created[0].dueAt!);
    assert.equal(weekday, "Friday");
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("regression: dev/test-only planning trace is populated end-to-end when AGENT_RUNTIME_PLANNING_TRACE=true, and absent otherwise", async () => {
  const server = buildServer();
  const userId = `plan-trace-${randomUUID()}`;

  try {
    await seedUser(userId);

    // Not enabled: no trace field at all.
    nextWeekStartPlan();
    const untracedReply = await send(server, userId, "plan next week");
    assert.equal(untracedReply.debug.planningTrace, undefined);

    process.env.AGENT_RUNTIME_PLANNING_TRACE = "true";
    nextWeekEditPlan({ removeIndexes: [1] });
    const tracedReply = await send(server, userId, "remove 1");

    const trace = tracedReply.debug.planningTrace;
    assert.ok(trace, "planningTrace must be present when tracing is enabled for a planning turn");
    assert.equal(trace.message, "remove 1");
    assert.equal(trace.plannedTool, "planning.next_week_edit");
    assert.deepEqual(trace.plannedArgs, { removeIndexes: [1] });
    assert.equal(trace.validationStatus, "valid");
    assert.ok(trace.resolvedArgs?.removeIndexes);
    assert.equal(trace.executorStatus, "executed");
    assert.ok(trace.executorSummary);
    assert.ok(trace.pendingOperationBefore, "must capture the draft as it was before this edit");
    assert.ok(trace.pendingOperationAfter, "must capture the draft as it is after this edit");
    assert.notDeepEqual(trace.pendingOperationBefore, trace.pendingOperationAfter, "before/after must differ for a successful edit");
    assert.ok(Array.isArray(trace.visibleEntitiesBefore));
    assert.ok(Array.isArray(trace.visibleEntitiesAfter));
    assert.equal(typeof trace.composerSource, "string");
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
