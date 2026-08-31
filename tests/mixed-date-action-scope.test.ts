import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createActionItem, prisma, snoozeActionItem } from "../packages/db/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, mockPlan, op, sendAgentMessage, seedUser } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * fix/private-alpha-coach-first-response-routing (known gap carried over from the previous
 * branch): "yesterday or this week?" was only ever answerable as a plain this_week list, which
 * silently drops anything overdue from before today — this_week's own window never looks earlier
 * than today. Fixed with a new `when: "this_week_and_overdue"` value (tool-catalog.ts,
 * executor.ts's actionMatchesWhenWindow) and a deterministic validator force
 * (MIXED_OVERDUE_AND_WEEK_RE) so a genuinely mixed request always gets both halves shown
 * together, regardless of what the planner supplied.
 */

async function seedMixedSpread(userId: string) {
  const overdue = await createActionItem(userId, { source: "manual", title: "Follow up with recruiter", priority: "medium", dueAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) });
  const today = await createActionItem(userId, { source: "manual", title: "Call the bank", priority: "medium", dueAt: new Date(Date.now() + 60 * 60 * 1000) });
  const laterThisWeek = await createActionItem(userId, { source: "manual", title: "Book flights", priority: "low" });
  await snoozeActionItem(userId, laterThisWeek.id, new Date(Date.now() + 2 * 24 * 60 * 60 * 1000));
  const nextMonth = await createActionItem(userId, { source: "manual", title: "Renew passport", priority: "low", dueAt: new Date(Date.now() + 45 * 24 * 60 * 60 * 1000) });
  return { overdue, today, laterThisWeek, nextMonth };
}

function actionListPlan(args: Record<string, unknown> = {}) {
  return { topic: "actions", intent: "list_actions", operations: [op("action.list", args)], needsClarification: false, clarificationQuestion: null, replyDraft: "" };
}

test("A. 'yesterday or this week?' shows overdue AND this-week actions together, even when the planner mistakenly narrows to this_week alone", async () => {
  const server = buildServer();
  const userId = `mixed-date-a-${randomUUID()}`;
  try {
    await seedUser(userId);
    const { overdue, today, laterThisWeek, nextMonth } = await seedMixedSpread(userId);

    mockPlan(actionListPlan({ when: "this_week" }));
    const reply = await sendAgentMessage(server, userId, "what's overdue from yesterday or coming up this week?");

    assert.match(reply.reply, /follow up with recruiter/i, `expected the overdue action — got: ${reply.reply}`);
    assert.match(reply.reply, /call the bank/i, `expected today's action — got: ${reply.reply}`);
    assert.match(reply.reply, /book flights/i, `expected the later-this-week action — got: ${reply.reply}`);
    assert.doesNotMatch(reply.reply, /renew passport/i, "an action over a month out must not be swept in");
    void overdue;
    void today;
    void laterThisWeek;
    void nextMonth;
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("B. a bare 'this week' query (no mention of yesterday/overdue) stays scoped to this_week only, unaffected", async () => {
  const server = buildServer();
  const userId = `mixed-date-b-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedMixedSpread(userId);

    mockPlan(actionListPlan({ when: "this_week" }));
    const reply = await sendAgentMessage(server, userId, "what do I have this week?");

    assert.doesNotMatch(reply.reply, /follow up with recruiter/i, "a plain this-week query must not silently pull in overdue items too");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("C. a bare 'do I have any overdue actions?' (overdueOnly) is unaffected by the new mixed scope", async () => {
  const server = buildServer();
  const userId = `mixed-date-c-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedMixedSpread(userId);

    mockPlan({ topic: "actions", intent: "list_actions", operations: [op("action.list", { overdueOnly: true })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "do I have any overdue actions?");

    assert.match(reply.reply, /follow up with recruiter/i);
    assert.doesNotMatch(reply.reply, /book flights/i, "a plain overdue-only query must not pull in the rest of the week too");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("D. Spanish '¿algo de ayer o de esta semana?' triggers the same mixed scope", async () => {
  const server = buildServer();
  const userId = `mixed-date-d-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedMixedSpread(userId);

    mockPlan(actionListPlan({ when: "this_week" }));
    const reply = await sendAgentMessage(server, userId, "¿algo de ayer o de esta semana?");

    assert.match(reply.reply, /follow up with recruiter/i, `expected the overdue action in the Spanish mixed query — got: ${reply.reply}`);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("exact live regression: 'And for yesterday or this week?' never silently narrows to a single day", async () => {
  const server = buildServer();
  const userId = `mixed-date-live-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedMixedSpread(userId);

    mockPlan(actionListPlan({ when: "today" }));
    const reply = await sendAgentMessage(server, userId, "And for yesterday or this week?");

    assert.doesNotMatch(reply.reply, /don't have any actions scheduled for (today|later this week)/i);
    assert.match(reply.reply, /follow up with recruiter/i);
    assert.match(reply.reply, /book flights/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
