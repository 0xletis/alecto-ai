import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createActionItem, createActionItemReminderLog } from "../packages/db/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, mockPlan, op, prisma, sendAgentMessage, seedUser } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * V3 core-operator audit finding: a "remind me N minutes before" companion ActionItem
 * (actionType: "reminder", created by action.create_pre_due_reminders /
 * createOrUpdatePreDueReminderActions) is a stub ABOUT a real task, not the task itself. When
 * the worker's own due-reminder loop (sendDueActionReminders) fires on that companion stub, it
 * logs ActionItemReminderLog against the STUB's own id — so resolveMostRecentlyNotifiedOrVisibleActionId
 * (runtime.ts), which prefers "whichever ActionItem the worker most recently notified about,"
 * previously returned the stub. A bare "complete it" right after such a reminder therefore
 * silently completed the "Reminder: <task>" stub while the real task stayed open, untouched, and
 * still due — with nothing in the reply to suggest anything went wrong. Fixed by resolving a
 * reminder-type companion back to its real parent task (parentActionIdFromReminderSourceId in
 * executor.ts, parsing the existing "pre_due_reminder:<actionId>:<leadMinutes>" sourceId
 * convention) before trusting it as the completion target.
 */

function actionListPlan() {
  return { topic: "actions", intent: "list_actions", operations: [op("action.list", { status: "open", limit: 10 })], needsClarification: false, clarificationQuestion: null, replyDraft: "" };
}

test("a positive-lead pre-due reminder firing resolves 'complete it' to the real task, not the reminder stub", async () => {
  const server = buildServer();
  const userId = `reminder-companion-${randomUUID()}`;

  try {
    await seedUser(userId);
    const dueAt = new Date(Date.now() + 60 * 60 * 1000);
    // Named "call" so it passes createOrUpdatePreDueReminderActions' own meeting-shaped filter
    // (isMeetingLikeAction) — a separate, narrower-than-documented behavior noted in the audit
    // report (action.create_pre_due_reminders' own description says "already-scheduled action
    // items" generally, but resolveReminderTargetActions always filters to meeting-like titles
    // when no explicit ref narrows it, even with explicit actionIds supplied).
    const task = await createActionItem(userId, { source: "manual", title: "Recruiter call", dueAt });

    // Authentically create the companion reminder through the real V3 tool, mirroring how a
    // user's own "remind me 30 minutes before" request creates it.
    mockPlan({
      topic: "actions",
      intent: "create_pre_due_reminder",
      operations: [op("action.create_pre_due_reminders", { actionIds: [task.id], leadMinutes: 30 })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    await sendAgentMessage(server, userId, "remind me 30 minutes before");

    const companion = await prisma.actionItem.findFirstOrThrow({ where: { userId, actionType: "reminder" } });
    assert.notEqual(companion.id, task.id, "the companion reminder must be a separate row from the real task");

    // Simulates the worker's own sendDueActionReminders firing on the companion stub at T-30 —
    // the real production write is ActionItemReminderLog keyed to the STUB's own id, never the
    // parent task's id.
    await createActionItemReminderLog({ userId, actionItemId: companion.id, reminderType: "due" });

    mockPlan(actionListPlan());
    await sendAgentMessage(server, userId, "show all tasks");

    const reply = await sendAgentMessage(server, userId, "complete it");
    assert.deepEqual(reply.operationsPlanned.map((operation) => operation.tool), ["action.complete"]);
    assert.equal(reply.debug.mutationExecuted, true);
    assert.match(reply.reply, /recruiter call/i, `reply must name the real task, not the reminder stub — got: ${reply.reply}`);

    const realTaskAfter = await prisma.actionItem.findUnique({ where: { id: task.id } });
    const companionAfter = await prisma.actionItem.findUnique({ where: { id: companion.id } });
    assert.equal(realTaskAfter?.status, "completed", "the real task must be the one completed");
    assert.notEqual(companionAfter?.status, "completed", "the reminder stub itself must not be silently completed instead");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
