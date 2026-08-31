import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createActionItem, prisma, snoozeActionItem } from "../packages/db/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, mockNow, mockPlan, op, sendAgentMessage, seedUser } from "./helpers/agent-runtime-test-helpers.ts";

// fix/private-alpha-conversation-kernel-context-routing (flake fix): the "today" fixture below
// used to be seeded relative to real Date.now(), which silently rolled onto tomorrow's local date
// whenever the suite ran within an hour of local midnight (Europe/Madrid) — a real, observed
// failure. Pinned to a fixed midday instant, safely away from any local-midnight boundary, and
// shared with the executor's own `now` via mockNow so both sides always agree on what "today" is.
const FIXED_NOW = new Date("2026-08-31T10:00:00.000Z"); // 12:00 Europe/Madrid (CEST, UTC+2)

/**
 * fix/private-alpha-live-action-and-coaching-regressions (Task 2): a real Telegram transcript
 * found "And showme all actions" answered "You don't have any actions scheduled for today" — the
 * planner had (incorrectly) set `when: "today"` for a plain "all actions" request, silently
 * narrowing a whole-list query down to one day; separately, even once `when` is correctly
 * cleared, a bare "open" status still hides anything the user already snoozed/deferred, which is
 * NOT what "all actions" means. Fixed with two deterministic validator backstops in validator.ts
 * (never left to planner reliability): `when` is cleared unless the message itself names a day/
 * date scope, and a genuine "all actions"-shaped request forces status "active" (open + deferred,
 * never archived/completed) regardless of what the planner supplied.
 *
 * Every test here deliberately mocks the planner supplying the WRONG args (exactly what a real
 * planner mistake looks like) and asserts the deterministic backstop corrects it — the same
 * pattern tests/agent-runtime-action-list-status-default.test.ts already uses for the sibling
 * `status` guard. Real end-to-end planner behavior for this same phrasing is covered separately
 * by the tagged LLM eval scenarios.
 */

async function seedFullActionSpread(userId: string, now: Date = FIXED_NOW) {
  const overdue = await createActionItem(userId, { source: "manual", title: "Send 3 CVs", priority: "high", dueAt: new Date(now.getTime() - 24 * 60 * 60 * 1000) });
  const today = await createActionItem(userId, { source: "manual", title: "Call the bank", priority: "medium", dueAt: new Date(now.getTime() + 60 * 60 * 1000) });
  const deferred = await createActionItem(userId, { source: "manual", title: "Book flights", priority: "low" });
  await snoozeActionItem(userId, deferred.id, new Date(now.getTime() + 24 * 60 * 60 * 1000));
  const archived = await createActionItem(userId, { source: "manual", title: "Old idea", priority: "low" });
  await prisma.actionItem.update({ where: { id: archived.id }, data: { status: "archived" } });
  return { overdue, today, deferred, archived };
}

function actionListPlan(args: Record<string, unknown> = {}) {
  return { topic: "actions", intent: "list_actions", operations: [op("action.list", args)], needsClarification: false, clarificationQuestion: null, replyDraft: "" };
}

test("A. 'show all actions' lists overdue + today + deferred, even when the planner mistakenly narrows to today", async () => {
  const server = buildServer();
  const userId = `all-scope-a-${randomUUID()}`;
  try {
    await seedUser(userId);
    mockNow(FIXED_NOW.toISOString());
    await seedFullActionSpread(userId);

    // Simulates the exact real-transcript planner mistake: `when: "today"` supplied for a plain
    // "all actions" request.
    mockPlan(actionListPlan({ when: "today" }));
    const reply = await sendAgentMessage(server, userId, "show all my actions");

    assert.match(reply.reply, /send 3 cvs/i, `expected the overdue action to be listed — got: ${reply.reply}`);
    assert.match(reply.reply, /call the bank/i, `expected today's action to be listed — got: ${reply.reply}`);
    assert.match(reply.reply, /book flights/i, `expected the deferred action to be listed — got: ${reply.reply}`);
    assert.doesNotMatch(reply.reply, /don't have any actions scheduled for today/i, "must never narrow an 'all actions' request to a single day");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("B. 'show me today's actions' stays scoped to today even when the planner mistakenly omits `when`", async () => {
  const server = buildServer();
  const userId = `all-scope-b-${randomUUID()}`;
  try {
    await seedUser(userId);
    mockNow(FIXED_NOW.toISOString());
    await seedFullActionSpread(userId);

    mockPlan(actionListPlan({ when: "today" }));
    const reply = await sendAgentMessage(server, userId, "show me today's actions");

    assert.match(reply.reply, /call the bank/i, `expected today's action to be listed — got: ${reply.reply}`);
    assert.doesNotMatch(reply.reply, /book flights/i, "a genuinely date-scoped 'today' query must not also show a deferred-to-tomorrow action");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("C. a genuinely vague 'show me my actions' (no day named) keeps the deterministic `when` guard cleared", async () => {
  const server = buildServer();
  const userId = `all-scope-c-${randomUUID()}`;
  try {
    await seedUser(userId);
    mockNow(FIXED_NOW.toISOString());
    await seedFullActionSpread(userId);

    // Planner mistakenly carries over `when: "this_week"` from an earlier turn.
    mockPlan(actionListPlan({ when: "this_week" }));
    const reply = await sendAgentMessage(server, userId, "show me my actions");

    assert.match(reply.reply, /call the bank/i, `expected the open action to be listed — got: ${reply.reply}`);
    assert.doesNotMatch(reply.reply, /book flights/i, "a bare 'my actions' request (no 'all') stays strictly open, unchanged");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("D. archived/completed items are shown only when explicitly requested, never for a bare 'all actions'", async () => {
  const server = buildServer();
  const userId = `all-scope-d-${randomUUID()}`;
  try {
    await seedUser(userId);
    mockNow(FIXED_NOW.toISOString());
    await seedFullActionSpread(userId);

    mockPlan(actionListPlan({ status: "all" }));
    const bareAll = await sendAgentMessage(server, userId, "show all my actions");
    assert.doesNotMatch(bareAll.reply, /old idea/i, "a bare 'all actions' request must never surface archived items, even if the planner sets status:'all'");

    mockPlan(actionListPlan({ status: "all" }));
    const explicit = await sendAgentMessage(server, userId, "show all my actions, including archived ones");
    assert.match(explicit.reply, /old idea/i, "an explicit archived request must actually show archived items");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("E. no misleading 'scheduled for today' copy for an all-actions query with items spread across dates", async () => {
  const server = buildServer();
  const userId = `all-scope-e-${randomUUID()}`;
  try {
    await seedUser(userId);
    mockNow(FIXED_NOW.toISOString());
    await seedFullActionSpread(userId);

    mockPlan(actionListPlan({ when: "today" }));
    const reply = await sendAgentMessage(server, userId, "list actions");

    assert.doesNotMatch(reply.reply, /scheduled for today/i, "a whole-list query must never use today-scoped copy");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("exact live regression: 'And showme all actions' (the tester's real typo'd phrasing), planner mis-scoped to today", async () => {
  const server = buildServer();
  const userId = `all-scope-live-${randomUUID()}`;
  try {
    await seedUser(userId);
    mockNow(FIXED_NOW.toISOString());
    await seedFullActionSpread(userId);

    mockPlan(actionListPlan({ when: "today" }));
    const reply = await sendAgentMessage(server, userId, "And showme all actions");

    assert.match(reply.reply, /send 3 cvs/i);
    assert.match(reply.reply, /call the bank/i);
    assert.match(reply.reply, /book flights/i);
    assert.doesNotMatch(reply.reply, /don't have any actions scheduled for today/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
