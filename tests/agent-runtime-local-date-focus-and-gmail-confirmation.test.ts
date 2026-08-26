import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { parseActionDueDate } from "../packages/core/src/action-intake.ts";
import { addDaysToLocalDate, formatLocalDate, localDateTimeToUtc } from "../packages/core/src/time.ts";
import { createActionItem, createGoal, prisma, updateNotificationSettings, upsertAgentConversationSession } from "../packages/db/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, getAgentSession, mockPlan, op, sendAgentMessage, seedUser } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * Deterministic coverage for fix/private-alpha-local-date-focus-and-gmail-confirmation-state — a
 * real Telegram transcript found three compounding bugs after deploying the pending-action-
 * refinement/Gmail-rule-UX fix:
 *
 * 1. "today" at 01:11 Europe/Madrid on Aug 26 (23:11 UTC Aug 25) created/displayed as due Tue Aug
 *    25 — action-intake.ts's date arithmetic (atLocalTime/addDaysAt/nextWeekdayAt) used
 *    Date.setHours/setDate, which operate in the JS runtime's OWN system timezone (UTC on this
 *    app's actual host), never the timezone value threaded all the way through but never applied.
 * 2. "move it to wed 26"/"wednesday 26" failed to parse at all — the weekday regex never
 *    recognized abbreviations, and neither it nor anything else respected an explicit day-of-month.
 * 3. Even after (2) parses, "wednesday 26" was misread as an explicit ACTION INDEX reference
 *    (as if the user said "reschedule action 26") by validator.ts's own index-vs-pronoun resolver,
 *    which treats ANY bare number in a reschedule message as a candidate list index — regardless
 *    of whether that number was actually part of the date phrase itself.
 *
 * A newly created action turned out to ALREADY become visible/focused correctly (action.create's
 * executor case already returns `entities: [actionToEntity(created)]`) — the reported "I only
 * showed 0 actions" failure was entirely explained by bug 3 above, not a missing focus mechanism.
 *
 * Separately, a real Gmail-rule-proposal bug: gmailGoalUsageStatusResponse (a status-question
 * shortcut) called setPendingOperation unconditionally whenever a rule proposal was available,
 * with no check for an already-active pendingOperation — silently replacing a still-open pending
 * action.create with a Gmail rule proposal, so the user's next "yes" (meant for the action)
 * confirmed enabling the rule instead.
 */

async function seedMadridUser(userId: string): Promise<void> {
  await seedUser(userId);
  await updateNotificationSettings(userId, { timezone: "Europe/Madrid" });
}

/**
 * launch-readiness follow-up: 2D and 2E below go through the real HTTP path (action.reschedule
 * resolves dueText against the real wall clock — no `now` override is available there), and used
 * to hardcode "wednesday 26" assuming it always meant Aug 26, 2026. Once real time actually
 * crossed Aug 26 2026's own 9am Europe/Madrid, that phrase started rolling forward to a LATER
 * date whose weekday doesn't match "wednesday" at all — which the newly added weekday/day-of-
 * month consistency check then (correctly) refuses instead of silently rescheduling anyway,
 * breaking these two tests' hardcoded assumption. `daysAhead` days out sidesteps the whole
 * rollover question: that date's default 9am is always still ahead of "now" within today, so the
 * resolved target is always exactly today+daysAhead with no rollover ambiguity.
 */
function realWeekdayAndDay(daysAhead: number, timezone = "Europe/Madrid"): { weekday: string; day: number } {
  const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const localDate = addDaysToLocalDate(formatLocalDate(new Date(), timezone), daysAhead);
  const weekdayIndex = new Date(`${localDate}T00:00:00Z`).getUTCDay();
  return { weekday: weekdays[weekdayIndex]!, day: Number(localDate.split("-")[2]) };
}

function actionListPlan(args: Record<string, unknown> = {}) {
  return { topic: "actions", intent: "list_actions", operations: [op("action.list", args)], needsClarification: false, clarificationQuestion: null, replyDraft: "" };
}

// --- Task 1: local date/time handling ---------------------------------------------------------------

test("1A/1B: 'today' created at Europe/Madrid 01:11 on Aug 26 is due Wed Aug 26, and confirmation copy reflects it", async () => {
  const server = buildServer();
  const userId = `datefocus-1ab-${randomUUID()}`;
  try {
    await seedMadridUser(userId);
    // Europe/Madrid 2026-08-26 01:11 CEST (UTC+2) = 2026-08-25T23:11:00Z.
    const now = new Date("2026-08-25T23:11:00Z");
    const parsed = parseActionDueDate("today", { now, timezone: "Europe/Madrid" });
    assert.ok(parsed.dueAt);
    assert.equal(parsed.dueAt!.toISOString().slice(0, 10), "2026-08-26", "the real UTC instant must land on the LOCAL Aug 26 date");

    mockPlan({ topic: "actions", intent: "create", operations: [op("action.create", { title: "Send 6 CVs today" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "send 6 CVs today");

    assert.match(reply.reply, /due today/i);
    assert.doesNotMatch(reply.reply, /tue aug 25|25\/08\/2026/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("1C: date-scoped 'today' includes an action created moments earlier", async () => {
  const server = buildServer();
  const userId = `datefocus-1c-${randomUUID()}`;
  try {
    await seedMadridUser(userId);
    mockPlan({ topic: "actions", intent: "create", operations: [op("action.create", { title: "Send 6 CVs today" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "send 6 CVs today");

    mockPlan(actionListPlan({ when: "today" }));
    const reply = await sendAgentMessage(server, userId, "show todays actions");

    assert.match(reply.reply, /send 6 cvs today/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("1D: 'tomorrow' at Europe/Madrid 01:11 on Aug 26 means Aug 27 local", () => {
  const now = new Date("2026-08-25T23:11:00Z");
  const parsed = parseActionDueDate("tomorrow", { now, timezone: "Europe/Madrid" });
  assert.ok(parsed.dueAt);
  assert.equal(parsed.dueAt!.toISOString().slice(0, 10), "2026-08-27");
});

test("1E: a UTC-timezone user still gets the right calendar day for 'today'", () => {
  const now = new Date("2026-08-26T10:00:00Z");
  const parsed = parseActionDueDate("today", { now, timezone: "UTC" });
  assert.ok(parsed.dueAt);
  assert.equal(parsed.dueAt!.toISOString().slice(0, 10), "2026-08-26");
});

// --- Task 2: date-only reschedule parsing ------------------------------------------------------------

test("2A/2B/2C: 'wed 26', 'wednesday 26', and '26 August' all parse to a real date", () => {
  const now = new Date("2026-08-20T10:00:00Z");
  for (const phrase of ["wed 26", "wednesday 26", "26 August"]) {
    const parsed = parseActionDueDate(phrase, { now, timezone: "Europe/Madrid" });
    assert.ok(parsed.dueAt, `"${phrase}" must parse to a real date`);
    assert.equal(parsed.dueAt!.toISOString().slice(0, 10), "2026-08-26", `"${phrase}" must resolve to the 26th`);
  }
});

test("2D: a date-only reschedule keeps the action's existing due TIME, not the generic default", async () => {
  const server = buildServer();
  const userId = `datefocus-2d-${randomUUID()}`;
  try {
    await seedMadridUser(userId);
    const action = await createActionItem(userId, { source: "manual", title: "Send 6 CVs", dueAt: new Date("2026-08-20T13:26:00Z") });

    const { weekday, day } = realWeekdayAndDay(3);
    const dueText = `${weekday.toLowerCase()} ${day}`;
    mockPlan({ topic: "actions", intent: "reschedule", operations: [op("action.reschedule", { actionId: action.id, dueText })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, `move it to ${dueText}`);

    assert.match(reply.reply, /rescheduled/i);
    const updated = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(updated?.dueAt?.getUTCHours(), 13, "the original due HOUR (UTC) must be preserved, not reset to the generic default");
    assert.equal(updated?.dueAt?.getUTCMinutes(), 26);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2E: rescheduling to the exact same due instant gives an honest no-op, not a fake 'rescheduled' reply", async () => {
  const server = buildServer();
  const userId = `datefocus-2e-${randomUUID()}`;
  try {
    await seedMadridUser(userId);
    const { weekday, day } = realWeekdayAndDay(3);
    const targetLocalDate = addDaysToLocalDate(formatLocalDate(new Date(), "Europe/Madrid"), 3);
    const dueAt = localDateTimeToUtc(targetLocalDate, "09:00", "Europe/Madrid"); // 540 minutes = the default action time
    const action = await createActionItem(userId, { source: "manual", title: "Send 6 CVs", dueAt });

    const dueText = `${weekday.toLowerCase()} ${day}`;
    mockPlan({ topic: "actions", intent: "reschedule", operations: [op("action.reschedule", { actionId: action.id, dueText })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, `move it to ${dueText}`);

    assert.match(reply.reply, /already scheduled/i);
    assert.doesNotMatch(reply.reply, /^action rescheduled/i);
    const updated = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(updated?.dueAt?.getTime(), dueAt.getTime(), "the due instant must be unchanged");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 3: newly created action becomes visible/focused ------------------------------------------

test("3A: create an action, then 'move it to tomorrow' works without listing actions first", async () => {
  const server = buildServer();
  const userId = `datefocus-3a-${randomUUID()}`;
  try {
    await seedMadridUser(userId);
    mockPlan({ topic: "actions", intent: "create", operations: [op("action.create", { title: "Send 6 CVs today" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "send 6 CVs today");

    mockPlan({ topic: "actions", intent: "snooze", operations: [op("action.snooze", { untilText: "tomorrow" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "move it to tomorrow");

    assert.doesNotMatch(reply.reply, /which task|don't have one in view/i);
    assert.match(reply.reply, /bring .* back tomorrow|moved/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3B: create an action, then 'archive it' works immediately", async () => {
  const server = buildServer();
  const userId = `datefocus-3b-${randomUUID()}`;
  try {
    await seedMadridUser(userId);
    mockPlan({ topic: "actions", intent: "create", operations: [op("action.create", { title: "Send 6 CVs today" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "send 6 CVs today");

    mockPlan({ topic: "actions", intent: "archive", operations: [op("action.archive", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "archive it");

    assert.match(reply.reply, /^archived/i);
    assert.equal(reply.debug.mutationExecuted, true);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3C: create an action, then 'done' works immediately", async () => {
  const server = buildServer();
  const userId = `datefocus-3c-${randomUUID()}`;
  try {
    await seedMadridUser(userId);
    mockPlan({ topic: "actions", intent: "create", operations: [op("action.create", { title: "Send 6 CVs today" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "send 6 CVs today");

    mockPlan({ topic: "actions", intent: "complete", operations: [op("action.complete", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "done");

    assert.match(reply.reply, /nice — marked/i);
    assert.equal(reply.debug.mutationExecuted, true);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3D: creating a second action makes IT the focused one, not the first", async () => {
  const server = buildServer();
  const userId = `datefocus-3d-${randomUUID()}`;
  try {
    await seedMadridUser(userId);
    mockPlan({ topic: "actions", intent: "create", operations: [op("action.create", { title: "Review 10 remote roles" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "review 10 remote roles");

    mockPlan({ topic: "actions", intent: "create", operations: [op("action.create", { title: "Send 6 CVs today" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "send 6 CVs today");

    mockPlan({ topic: "actions", intent: "archive", operations: [op("action.archive", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "archive it");

    assert.match(reply.reply, /send 6 cvs today/i, "'it' must resolve to the SECOND (most recently created) action");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3E: after archiving the newly created action, it's no longer a valid target for a second 'archive it'", async () => {
  const server = buildServer();
  const userId = `datefocus-3e-${randomUUID()}`;
  try {
    await seedMadridUser(userId);
    mockPlan({ topic: "actions", intent: "create", operations: [op("action.create", { title: "Send 6 CVs today" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "send 6 CVs today");

    mockPlan({ topic: "actions", intent: "archive", operations: [op("action.archive", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "archive it");

    mockPlan({ topic: "actions", intent: "archive", operations: [op("action.archive", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "archive it again");

    assert.doesNotMatch(reply.reply, /^archived/i);
    assert.equal(reply.debug.mutationExecuted, false);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 4: Gmail rule pending/confirmation state --------------------------------------------------

async function seedPendingActionCreate(userId: string, title: string): Promise<void> {
  const goalResult = await createGoal(userId, { title: "Find a fully remote developer job, ideally in Web3", category: "career", priority: "medium" });
  if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
  await upsertAgentConversationSession(userId, "telegram", {
    topic: "action_creation",
    focusedEntities: {},
    pendingOperation: {
      id: `agent-pending-test-${Date.now()}`,
      topic: "action_creation",
      summary: `create the action "${title}"`,
      operations: [{ tool: "action.create", args: { title, priority: "medium", goalId: goalResult.goal.id }, status: "valid", requiresConfirmation: false }],
      createdAt: new Date().toISOString(),
      expiresAt: new Date().toISOString()
    },
    visibleEntities: [],
    recentMutations: [],
    messages: [{ role: "assistant", text: `Want me to create this action?\n${title}\n\nReply yes to confirm or cancel.`, at: new Date().toISOString() }],
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
  });
}

async function seedConnectedGmail(userId: string): Promise<void> {
  await prisma.integrationConnection.create({ data: { userId, integrationId: "gmail", status: "active", config: {} } });
}

test("4A/4G: a status question asked while an action is still pending never clobbers it — next 'yes' still creates the action", async () => {
  const server = buildServer();
  const userId = `datefocus-4a-${randomUUID()}`;
  try {
    await seedMadridUser(userId);
    await seedConnectedGmail(userId);
    await seedPendingActionCreate(userId, "Send 6 CVs today");

    const statusReply = await sendAgentMessage(server, userId, "do u use my mail now for my goal?");
    assert.match(statusReply.reply, /^no —/i);

    const session = await getAgentSession(userId);
    const pending = session?.pendingOperation as { topic: string; operations: Array<{ tool: string }> };
    assert.equal(pending.topic, "action_creation", "the action's own pendingOperation must survive the status question untouched");
    assert.equal(pending.operations[0]!.tool, "action.create");

    const yesReply = await sendAgentMessage(server, userId, "yes");
    assert.equal(yesReply.debug.mutationExecuted, true);
    const actions = await prisma.actionItem.findMany({ where: { userId } });
    assert.equal(actions.length, 1);
    assert.match(actions[0]!.title, /send 6 cvs today/i);
    const rules = await prisma.emailSignalRule.findMany({ where: { userId } });
    assert.equal(rules.length, 0, "the status question must never have enabled anything");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4B/4D: a status question alone never enables a Gmail rule, connected or not", async () => {
  const server = buildServer();
  const userId = `datefocus-4b-${randomUUID()}`;
  try {
    await seedMadridUser(userId);
    await seedConnectedGmail(userId);
    const goalResult = await createGoal(userId, { title: "Find a fully remote developer job, ideally in Web3", category: "career", priority: "medium" });
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");

    await sendAgentMessage(server, userId, "do u use my mail now for my goal?");
    await sendAgentMessage(server, userId, "do u use my mail now for my goal?");

    const rules = await prisma.emailSignalRule.findMany({ where: { userId } });
    assert.equal(rules.length, 0, "asking the read-only status question, even repeatedly, must never enable a rule");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4C: once nothing else is pending, the proposed Gmail rule IS a real confirmable proposal — 'yes' enables it", async () => {
  const server = buildServer();
  const userId = `datefocus-4c-${randomUUID()}`;
  try {
    await seedMadridUser(userId);
    await seedConnectedGmail(userId);
    const goalResult = await createGoal(userId, { title: "Find a fully remote developer job, ideally in Web3", category: "career", priority: "medium" });
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");

    const statusReply = await sendAgentMessage(server, userId, "do u use my mail now for my goal?");
    assert.equal(statusReply.debug.pendingOperation, true);

    const yesReply = await sendAgentMessage(server, userId, "yes");
    assert.equal(yesReply.debug.mutationExecuted, true);
    const rules = await prisma.emailSignalRule.findMany({ where: { userId, status: "active" } });
    assert.ok(rules.some((rule) => rule.adapterId === "job_search_email"));
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4E: connected + no rule -> status question says no", async () => {
  const server = buildServer();
  const userId = `datefocus-4e-${randomUUID()}`;
  try {
    await seedMadridUser(userId);
    await seedConnectedGmail(userId);
    const goalResult = await createGoal(userId, { title: "Find a fully remote developer job, ideally in Web3", category: "career", priority: "medium" });
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");

    const reply = await sendAgentMessage(server, userId, "do u use my mail now for my goal?");
    assert.match(reply.reply, /^no —/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4F: connected + active rule -> status question says yes", async () => {
  const server = buildServer();
  const userId = `datefocus-4f-${randomUUID()}`;
  try {
    await seedMadridUser(userId);
    await seedConnectedGmail(userId);
    const goalResult = await createGoal(userId, { title: "Find a fully remote developer job, ideally in Web3", category: "career", priority: "medium" });
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
    const enableReply = await sendAgentMessage(server, userId, "enable job search rule for Gmail");
    assert.match(enableReply.reply, /job.search/i);

    const reply = await sendAgentMessage(server, userId, "do u use my mail now for my goal?");
    assert.match(reply.reply, /^yes —/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
