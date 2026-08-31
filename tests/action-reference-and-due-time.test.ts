import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { parseActionDueDate } from "../packages/core/src/action-intake.ts";
import { createActionItem, createGoal, prisma } from "../packages/db/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, mockPlan, op, seedUser, sendAgentMessage } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * fix/private-alpha-conversation-kernel-context-routing (Parts 6/7).
 *
 * Part 6 — two real reported bugs stacked: (1) validator.ts's resolveExplicitActionIndexReferences
 * treated ANY digit in the message as an attempted list-index reference, even with zero actions
 * ever shown ("complete the open action as I did send 15 already today" got blocked as "action 15
 * out of range" purely because of the "15" in "sent 15 already"); (2) even after that, the
 * ref-less action.complete/snooze/archive resolver (validator.ts, right after
 * ACTION_REFERENCE_TOOLS) only ever checked session.visibleEntities, never falling back to
 * context.openActions when there's genuinely no ambiguity (exactly one real open action). Both
 * fixed: the index-reference check now backs off entirely with zero visible actions, and the
 * ref-less resolver now falls back to the single globally-open action when nothing is visible.
 *
 * Part 7 — a bare "tomorrow" (no time, no day-part) for an action due date defaulted to
 * preferences.defaultActionTimeMinutes (9am), reading as an oddly specific morning appointment for
 * a whole-day task like "send 10 CVs tomorrow." Mirrors the SAME END_OF_DAY_TIME_MINUTES fallback
 * action-intake.ts's "today" branch already used — "tomorrow morning"/"tomorrow at 9" (an explicit
 * day-part or time) are unaffected.
 */

const MADRID = "Europe/Madrid";

async function seedJobSearchGoal(userId: string) {
  const result = await createGoal(userId, { title: "Find a fully remote developer job", category: "career" });
  if (result.duplicate) throw new Error("unexpected duplicate goal in test setup");
  return result.goal;
}

// --- Part 7: default due-time policy for a bare day word --------------------------------------

test("7A. 'send 10 CVs tomorrow' (no time, no day-part) defaults to tomorrow 23:59", () => {
  const now = new Date("2026-08-31T10:00:00+02:00");
  const parsed = parseActionDueDate("send 10 CVs tomorrow", { now, timezone: MADRID });
  assert.ok(parsed.dueAt);
  const local = new Intl.DateTimeFormat("en-GB", { timeZone: MADRID, hour: "2-digit", minute: "2-digit", hour12: false }).format(parsed.dueAt);
  assert.equal(local, "23:59");
});

test("7B. 'send 10 CVs tomorrow morning' (explicit day-part) still defaults to 09:00", () => {
  const now = new Date("2026-08-31T10:00:00+02:00");
  const parsed = parseActionDueDate("send 10 CVs tomorrow morning", { now, timezone: MADRID });
  assert.ok(parsed.dueAt);
  const local = new Intl.DateTimeFormat("en-GB", { timeZone: MADRID, hour: "2-digit", minute: "2-digit", hour12: false }).format(parsed.dueAt);
  assert.equal(local, "09:00");
});

test("7C. 'send 10 CVs tomorrow at 9' (explicit time) uses 09:00, not end of day", () => {
  const now = new Date("2026-08-31T10:00:00+02:00");
  const parsed = parseActionDueDate("send 10 CVs tomorrow at 9", { now, timezone: MADRID });
  assert.ok(parsed.dueAt);
  assert.equal(parsed.explicitTime, true);
  const local = new Intl.DateTimeFormat("en-GB", { timeZone: MADRID, hour: "2-digit", minute: "2-digit", hour12: false }).format(parsed.dueAt);
  assert.equal(local, "09:00");
});

test("7D. 'move it to tomorrow' (bare, no time) also defaults to 23:59", () => {
  const now = new Date("2026-08-31T10:00:00+02:00");
  const parsed = parseActionDueDate("move it to tomorrow", { now, timezone: MADRID });
  assert.ok(parsed.dueAt);
  const local = new Intl.DateTimeFormat("en-GB", { timeZone: MADRID, hour: "2-digit", minute: "2-digit", hour12: false }).format(parsed.dueAt);
  assert.equal(local, "23:59");
});

test("7E. timezone Europe/Madrid is honored for the 23:59 default (not UTC 23:59)", () => {
  const now = new Date("2026-08-31T10:00:00+02:00");
  const parsed = parseActionDueDate("tomorrow", { now, timezone: MADRID });
  assert.ok(parsed.dueAt);
  // Europe/Madrid is UTC+2 in August (CEST) — local 23:59 is UTC 21:59.
  assert.equal(parsed.dueAt!.toISOString(), "2026-09-01T21:59:00.000Z");
});

// --- Part 6: action pronoun/reference resolution -----------------------------------------------

test("6A. show actions -> complete action 1 resolves against the just-shown numbered list", async () => {
  const server = buildServer();
  const userId = `ref-6a-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedJobSearchGoal(userId);
    await createActionItem(userId, { source: "manual", title: "Send 3 CVs", priority: "high" });

    mockPlan({ topic: "actions", intent: "list", operations: [op("action.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "show me my actions");

    mockPlan({ topic: "actions", intent: "complete", operations: [op("action.complete", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "complete action 1");
    assert.equal(reply.debug.mutationExecuted, true);
    const action = await prisma.actionItem.findFirst({ where: { userId } });
    assert.equal(action?.status, "completed");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("6B. show actions -> show goal progress -> complete action 1 still resolves (goal.status must not erase the action list)", async () => {
  const server = buildServer();
  const userId = `ref-6b-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedJobSearchGoal(userId);
    await createActionItem(userId, { source: "manual", title: "Send 3 CVs", priority: "high" });

    mockPlan({ topic: "actions", intent: "list", operations: [op("action.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "show me my actions");

    mockPlan({ topic: "goal_status", intent: "status", operations: [op("goal.status", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "show my goal progress");

    mockPlan({ topic: "actions", intent: "complete", operations: [op("action.complete", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "complete action 1");
    assert.doesNotMatch(reply.reply, /only showed 0 actions/i);
    assert.equal(reply.debug.mutationExecuted, true);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("6C/6D. no numbered list ever shown, exactly one global open action — 'complete the open action as I did send 15 already today' resolves to it", async () => {
  const server = buildServer();
  const userId = `ref-6cd-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedJobSearchGoal(userId);
    const action = await createActionItem(userId, { source: "manual", title: "Send 3 CVs", priority: "high" });

    mockPlan({ topic: "actions", intent: "complete", operations: [op("action.complete", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "complete the open action as I did send 15 already today");

    assert.doesNotMatch(reply.reply, /only showed 0 actions/i, "the stray '15' must never be treated as a list-index reference");
    assert.equal(reply.debug.mutationExecuted, true);
    const updated = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(updated?.status, "completed");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("6E. two or more open actions with no visible list — 'complete the open action' asks for clarification rather than guessing", async () => {
  const server = buildServer();
  const userId = `ref-6e-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedJobSearchGoal(userId);
    await createActionItem(userId, { source: "manual", title: "Send 3 CVs", priority: "high" });
    await createActionItem(userId, { source: "manual", title: "Review resume", priority: "medium" });

    mockPlan({ topic: "actions", intent: "complete", operations: [op("action.complete", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "complete the open action");

    assert.equal(reply.debug.mutationExecuted, false, "must never guess which of two open actions was meant");
    const actions = await prisma.actionItem.findMany({ where: { userId } });
    assert.ok(actions.every((a) => a.status === "open"));
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("6F/6G. show one action -> 'move it to tomorrow 23:59' resolves 'it' and applies the exact due time", async () => {
  const server = buildServer();
  const userId = `ref-6fg-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedJobSearchGoal(userId);
    await createActionItem(userId, { source: "manual", title: "Send 10 CVs", priority: "high", dueAt: new Date("2026-09-01T07:00:00.000Z") });

    mockPlan({ topic: "actions", intent: "list", operations: [op("action.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "show me my actions");

    mockPlan({
      topic: "actions",
      intent: "reschedule",
      operations: [op("action.reschedule", { dueText: "tomorrow 23:59" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "move it to tomorrow 23:59 as 9 am makes no sense");
    assert.equal(reply.debug.mutationExecuted, true);
    assert.doesNotMatch(reply.reply, /only showed 1 action/i);

    const action = await prisma.actionItem.findFirst({ where: { userId } });
    const local = new Intl.DateTimeFormat("en-GB", { timeZone: MADRID, hour: "2-digit", minute: "2-digit", hour12: false }).format(action!.dueAt!);
    assert.equal(local, "23:59");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("6H. no visible and no global open action at all — asks to show actions rather than guessing", async () => {
  const server = buildServer();
  const userId = `ref-6h-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedJobSearchGoal(userId);

    mockPlan({ topic: "actions", intent: "complete", operations: [op("action.complete", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "complete it");
    assert.equal(reply.debug.mutationExecuted, false);
    assert.match(reply.reply, /don't have one in view|which task/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Part 9 / 8: exact live transcript B regression ----------------------------------------------

test("8-B. exact live transcript B regression: full action-reference + due-time sequence", async () => {
  const server = buildServer();
  const userId = `live-b-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedJobSearchGoal(userId);
    await createActionItem(userId, { source: "manual", title: "Send 3 CVs", priority: "high" });

    mockPlan({ topic: "actions", intent: "list", operations: [op("action.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "show me my actions");

    mockPlan({ topic: "goal_status", intent: "status", operations: [op("goal.status", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "show my goal progress");

    mockPlan({ topic: "actions", intent: "complete", operations: [op("action.complete", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const t3 = await sendAgentMessage(server, userId, "complete the open action as I did send 15 already today");
    assert.doesNotMatch(t3.reply, /only showed 0 actions/i);
    assert.equal(t3.debug.mutationExecuted, true);

    mockPlan({ topic: "actions", intent: "create", operations: [op("action.create", { title: "Send 10 CVs", dueText: "tomorrow" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "make tomorrow sending 10 more");

    mockPlan({ topic: "actions", intent: "list", operations: [op("action.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "show me ma actions");

    const newAction = await prisma.actionItem.findFirst({ where: { userId, title: "Send 10 CVs" } });
    const dueLocal = new Intl.DateTimeFormat("en-GB", { timeZone: MADRID, hour: "2-digit", minute: "2-digit", hour12: false }).format(newAction!.dueAt!);
    assert.equal(dueLocal, "23:59", "new action due tomorrow defaults to 23:59 unless the user says morning");

    mockPlan({
      topic: "actions",
      intent: "reschedule",
      operations: [op("action.reschedule", { dueText: "tomorrow 23:59" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const t9 = await sendAgentMessage(server, userId, "move it to tomorrow 23:59 as 9am makes no sense");
    assert.equal(t9.debug.mutationExecuted, true, "'it' must resolve to the one visible action");
    assert.doesNotMatch(t9.reply, /only showed 1 action/i);

    const finalActions = await prisma.actionItem.findMany({ where: { userId } });
    assert.equal(finalActions.filter((a) => a.title === "Send 10 CVs").length, 1, "no duplicate action");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
