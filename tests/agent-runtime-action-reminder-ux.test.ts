import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createActionItem, prisma } from "../packages/db/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, mockPlan, op, sendAgentMessage, seedUser } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * Real Telegram smoke test after the goal-lifecycle pass: "do i have any overdue actions"
 * returned all 10 action items (open tasks AND their "remind me N minutes before" companion
 * rows, actionType "reminder") as one flat "Found 10 action item(s): ..." list, and completing
 * "brainstorm meeting" left "Reminder for Brainstorm meeting" listed separately as if it were
 * still an open, standalone task. Root cause: action.list (and action.hygiene_start's own
 * analyzeActionHygiene) never filtered out actionType "reminder" rows — only action.meeting_list
 * already did. Fix: reminder companions are excluded from every normal action list/cleanup
 * report and shown instead as a short "Reminder: N minutes before" metadata line on their real
 * parent action (resolved via the existing parentActionIdFromReminderSourceId helper); the
 * overdue query gained a new `overdueOnly` arg; action.reminder_list groups by parent title and
 * drops a reminder once its parent is completed/archived (nothing in the schema cascades that
 * automatically); action.complete is reminder-aware, so naming a reminder whose parent is
 * already done explains that honestly instead of creating a second, confusing "completion".
 * No ActionItem schema change, no migration, no new Reminder table — everything here is either a
 * client-side filter or a `Reminder: ${title}`/`pre_due_reminder:<id>:<leadMinutes>` sourceId
 * convention the codebase already had.
 */

async function seedActionWithReminder(
  userId: string,
  title: string,
  dueAt: Date,
  leadMinutes = 30
): Promise<{ parentId: string; reminderId: string }> {
  const parent = await createActionItem(userId, { source: "manual", title, dueAt });
  const reminder = await createActionItem(userId, {
    source: "system",
    sourceId: `pre_due_reminder:${parent.id}:${leadMinutes}`,
    title: `Reminder: ${title}`,
    description: `Reminder ${leadMinutes} minutes before ${title}.`,
    dueAt: new Date(dueAt.getTime() - leadMinutes * 60_000),
    actionType: "reminder"
  });
  return { parentId: parent.id, reminderId: reminder.id };
}

test("A. a normal action list hides reminder companions, showing only the real parent action", async () => {
  const server = buildServer();
  const userId = `action-reminder-ux-a-${randomUUID()}`;

  try {
    await seedUser(userId);
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await seedActionWithReminder(userId, "Brainstorm meeting", future);

    mockPlan({ topic: "actions", intent: "list_actions", operations: [op("action.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "show me my actions");

    assert.match(reply.reply, /brainstorm meeting/i);
    assert.doesNotMatch(reply.reply, /reminder for brainstorm meeting/i);
    assert.doesNotMatch(reply.reply, /reminder: brainstorm meeting/i);
    assert.match(reply.reply, /reminder: 30 minutes before/i, "the real action should carry the reminder as metadata, not a separate entry");

    const reminderEntity = reply.operationsExecuted[0];
    assert.equal(reminderEntity?.tool, "action.list");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("B. 'do i have any overdue actions' returns overdue parent actions only", async () => {
  const server = buildServer();
  const userId = `action-reminder-ux-b-${randomUUID()}`;

  try {
    await seedUser(userId);
    const overdue = new Date(Date.now() - 60 * 60 * 1000);
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await seedActionWithReminder(userId, "Branding direction meeting", overdue);
    await createActionItem(userId, { source: "manual", title: "Upgrade to Node.js 24", dueAt: overdue });
    await createActionItem(userId, { source: "manual", title: "Apply to 3 developer jobs", dueAt: overdue });
    await createActionItem(userId, { source: "manual", title: "Plan next quarter roadmap", dueAt: future });
    await seedActionWithReminder(userId, "Team offsite", future);

    mockPlan({ topic: "actions", intent: "list_overdue", operations: [op("action.list", { overdueOnly: true })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "do i have any overdue actions");

    assert.match(reply.reply, /you have 3 overdue actions:/i);
    assert.match(reply.reply, /branding direction meeting/i);
    assert.match(reply.reply, /upgrade to node\.js 24/i);
    assert.match(reply.reply, /apply to 3 developer jobs/i);
    assert.doesNotMatch(reply.reply, /plan next quarter roadmap/i, "a future action must never show under an overdue-only query");
    assert.doesNotMatch(reply.reply, /team offsite/i, "a future action must never show under an overdue-only query");
    assert.doesNotMatch(reply.reply, /reminder for|reminder:.*brainstorm|reminder: branding|reminder: team offsite/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("C. 'show my reminders' shows reminders grouped under their parent, no generic tasks mixed in", async () => {
  const server = buildServer();
  const userId = `action-reminder-ux-c-${randomUUID()}`;

  try {
    await seedUser(userId);
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await seedActionWithReminder(userId, "Brainstorm meeting", future, 30);
    await createActionItem(userId, { source: "manual", title: "Renew passport" });

    // No mockPlan — actionReminderListShortcutOperation is a real deterministic shortcut, so
    // this exercises the actual production routing, not a stand-in.
    const reply = await sendAgentMessage(server, userId, "show my reminders");

    assert.deepEqual(reply.operationsPlanned.map((operation) => operation.tool), ["action.reminder_list"]);
    assert.match(reply.reply, /brainstorm meeting/i);
    assert.match(reply.reply, /30 minutes before/i);
    assert.doesNotMatch(reply.reply, /renew passport/i, "a generic task with no reminder must never appear in the reminder-only list");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("D. completing the parent action hides its reminder companion from later normal lists", async () => {
  const server = buildServer();
  const userId = `action-reminder-ux-d-${randomUUID()}`;

  try {
    await seedUser(userId);
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const { parentId } = await seedActionWithReminder(userId, "Brainstorm meeting", future);

    mockPlan({ topic: "actions", intent: "list_actions", operations: [op("action.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const firstList = await sendAgentMessage(server, userId, "show me my actions");
    assert.match(firstList.reply, /brainstorm meeting/i);

    mockPlan({ topic: "actions", intent: "complete", operations: [op("action.complete", { actionId: parentId })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const completeReply = await sendAgentMessage(server, userId, "complete brainstorm meeting");
    assert.match(completeReply.reply, /completed "brainstorm meeting"/i);

    mockPlan({ topic: "actions", intent: "list_actions", operations: [op("action.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const secondList = await sendAgentMessage(server, userId, "show me my actions again");
    assert.doesNotMatch(secondList.reply, /brainstorm meeting/i, "the completed parent must no longer show in the default open list");
    assert.doesNotMatch(secondList.reply, /reminder/i, "its reminder companion must never show as a standalone task either");

    const reminderReply = await sendAgentMessage(server, userId, "show my reminders");
    assert.doesNotMatch(reminderReply.reply, /brainstorm meeting/i, "a reminder for an already-completed action must drop out of the reminder list too");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("E. numbered replies after a normal action list operate on real parent actions", async () => {
  const server = buildServer();
  const userId = `action-reminder-ux-e-${randomUUID()}`;

  try {
    await seedUser(userId);
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const a = await createActionItem(userId, { source: "manual", title: "Apply to 3 developer jobs" });
    const b = await createActionItem(userId, { source: "manual", title: "Upgrade to Node.js 24" });
    const c = await createActionItem(userId, { source: "manual", title: "Branding direction meeting", dueAt: future });
    await seedActionWithReminder(userId, "Team offsite", future);

    mockPlan({ topic: "actions", intent: "list_actions", operations: [op("action.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const list = await sendAgentMessage(server, userId, "show me my actions");
    assert.match(list.reply, /you have 4 open actions:/i);

    mockPlan({ topic: "actions", intent: "complete_numbered", operations: [op("action.complete", { actionId: a.id })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const completeReply = await sendAgentMessage(server, userId, "complete 1");
    assert.equal(completeReply.debug.mutationExecuted, true);

    mockPlan({ topic: "actions", intent: "snooze_numbered", operations: [op("action.snooze", { actionId: b.id, untilText: "tomorrow" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const snoozeReply = await sendAgentMessage(server, userId, "snooze 2 tomorrow");
    assert.equal(snoozeReply.debug.mutationExecuted, true);

    mockPlan({ topic: "actions", intent: "archive_numbered", operations: [op("action.archive", { actionId: c.id })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const archiveReply = await sendAgentMessage(server, userId, "archive 3");
    assert.equal(archiveReply.debug.mutationExecuted, true);

    const rowA = await prisma.actionItem.findUnique({ where: { id: a.id } });
    const rowB = await prisma.actionItem.findUnique({ where: { id: b.id } });
    const rowC = await prisma.actionItem.findUnique({ where: { id: c.id } });
    assert.equal(rowA?.status, "completed");
    assert.equal(rowB?.status, "snoozed");
    assert.equal(rowC?.status, "archived");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("F. naming a reminder whose parent is already completed explains honestly instead of a confusing second completion", async () => {
  const server = buildServer();
  const userId = `action-reminder-ux-f-${randomUUID()}`;

  try {
    await seedUser(userId);
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const { parentId, reminderId } = await seedActionWithReminder(userId, "Brainstorm meeting", future);

    mockPlan({ topic: "actions", intent: "complete", operations: [op("action.complete", { actionId: parentId })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "complete brainstorm meeting");

    mockPlan({ topic: "actions", intent: "complete", operations: [op("action.complete", { actionId: reminderId })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "the reminder for brainstorm meeting too");

    assert.doesNotMatch(reply.reply, /^completed "reminder/i, "must never present a second, separate 'completion' of the reminder stub");
    assert.match(reply.reply, /brainstorm meeting/i);
    assert.match(reply.reply, /already completed/i);

    const reminderRow = await prisma.actionItem.findUnique({ where: { id: reminderId } });
    assert.notEqual(reminderRow?.status, "completed", "a reminder should never itself be marked completed — it isn't something you DO");

    mockPlan({ topic: "actions", intent: "list_actions", operations: [op("action.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const list = await sendAgentMessage(server, userId, "show me my actions");
    assert.doesNotMatch(list.reply, /reminder/i);

    const reminderListReply = await sendAgentMessage(server, userId, "show my reminders");
    assert.doesNotMatch(reminderListReply.reply, /brainstorm meeting/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
