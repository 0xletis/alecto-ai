import assert from "node:assert/strict";
import test from "node:test";
import { createActionItem, prisma } from "../packages/db/src/index.ts";
import { sendDueActionReminders } from "../apps/worker/src/action-reminders.ts";
import { buildServer, clearAgentRuntimeMocks, getAgentSession, mockPlan, op, sendAgentMessage } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * Real Telegram smoke test flagged the worker's overdue-action notification as "too robotic for
 * V3/private alpha" — one Telegram message PER action, each exposing raw slash commands with
 * UUIDs directly to the user (`/complete_action <uuid>`, `/snooze_action <uuid> tomorrow`,
 * `/archive_action <uuid>`). Fix: sendDueActionReminders (apps/worker/src/action-reminders.ts) now sends ONE
 * bundled, numbered, natural-language message per user per tick, and persists the numbered list
 * as that user's real V3 AgentConversationSession.visibleEntities (type "action", matching
 * index) — the same DB write shape v3-proactive-delivery.ts's Gmail-nudge delivery already
 * established for "a background job shows a numbered list, a later chat reply must resolve
 * against it." No agent-runtime code changes were needed: action.hygiene_apply's existing
 * selection resolver already matches a reply's numbered decisions against session.visibleEntities
 * by type/index alone, regardless of which tool populated that list.
 */

function stubTelegram() {
  const sent: Array<{ chatId: string; text: string }> = [];
  const send = async (chatId: string, text: string): Promise<void> => {
    sent.push({ chatId, text });
  };
  return { send, sent };
}

async function seedTelegramUser(userId: string, telegramUserId: string) {
  await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
  await prisma.notificationSettings.create({
    data: { userId, telegramUserId, timezone: "Europe/Madrid", morningTimeMinutes: 540, eveningTimeMinutes: 1140 }
  });
}

test("1. multiple overdue actions for one user are bundled into a single natural-language message, no slash commands or UUIDs", async () => {
  // fix/private-alpha-proactive-checkins-and-overdue-action-ux: previously seeded NotificationSettings
  // under a randomUUID-based userId while every ActionItem/cleanup used a DIFFERENT, hardcoded
  // "telegram:555001" id — the NotificationSettings row (with its own real telegramUserId field)
  // was never cleaned up by the old `finally` block (which only ever deleted "telegram:555001"),
  // so every run left one more orphaned row behind. That accumulation of duplicate telegramUserId
  // rows across many runs eventually caused sendDueActionReminders to send the SAME bundled
  // reminder twice for one real Telegram chat — a real bug this file's own tests exist to catch,
  // just not one it should ALSO be causing by leaking test data. One real, fully-cleaned-up id
  // throughout (matching test 2's own already-correct pattern) fixes both.
  const telegramUserId = `555001${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const userId = `telegram:${telegramUserId}`;

  try {
    await seedTelegramUser(userId, userId);
    const overdue = new Date(Date.now() - 60 * 60 * 1000);
    const taskA = await createActionItem(userId, { source: "manual", title: "Apply to 3 developer jobs", dueAt: overdue });
    const taskB = await createActionItem(userId, { source: "manual", title: "Upgrade to Node.js 24", dueAt: overdue });
    const taskC = await createActionItem(userId, { source: "manual", title: "Branding direction meeting", dueAt: overdue });

    const { send, sent } = stubTelegram();
    await sendDueActionReminders(new Date(), { sendTelegramMessage: send });

    assert.equal(sent.length, 1, "one bundled message per user, not one per action");
    const text = sent[0].text;

    assert.match(text, /you have 3 overdue actions:/i);
    assert.match(text, /1\. apply to 3 developer jobs/i);
    assert.match(text, /2\. upgrade to node\.js 24/i);
    assert.match(text, /3\. branding direction meeting/i);
    // fix/private-alpha-proactive-checkins-and-overdue-action-ux: the footer used to be a single
    // hardcoded "Reply: complete 1, snooze 2 tomorrow, or archive 3." string, referencing index 3
    // regardless of how many actions were actually shown, and using the user-facing-forbidden
    // word "snooze" — now built from the REAL bundled indexes via the same shared
    // buildOpenActionCommandFooter apps/api's own action.list footer uses.
    assert.match(text, /you can say: "complete 1", "move 2 to tomorrow", or "archive 3"\./i);
    assert.doesNotMatch(text, /\bsnooze\b/i, "user-facing overdue reminder copy must never say \"snooze\"");
    assert.doesNotMatch(text, /\(due: \d{2}\/\d{2}\/\d{4}/i, "must use the natural due-label helper, not a robotic (due: DD/MM/YYYY, HH:mm) format");
    assert.doesNotMatch(text, /\/complete_action|\/snooze_action|\/archive_action/);
    assert.doesNotMatch(text, new RegExp(taskA.id), "the raw ActionItem UUID must never appear in a V3 notification");
    assert.doesNotMatch(text, new RegExp(taskB.id));
    assert.doesNotMatch(text, new RegExp(taskC.id));

    const session = await getAgentSession(`telegram:${telegramUserId}`, "telegram");
    const visible = session?.visibleEntities as Array<{ type: string; id: string; label: string; index: number }>;
    assert.equal(visible.length, 3);
    assert.deepEqual(
      visible.map((entity) => [entity.type, entity.index, entity.id]),
      [
        ["action", 1, taskA.id],
        ["action", 2, taskB.id],
        ["action", 3, taskC.id]
      ]
    );
  } finally {
    await prisma.user.deleteMany({ where: { id: `telegram:${telegramUserId}` } });
  }
});

test("2. a later 'complete 1, snooze 2 tomorrow, archive 3' chat reply resolves against the bundled list for real", async () => {
  const server = buildServer();
  const telegramUserId = "555002";
  const userId = `telegram:${telegramUserId}`;

  try {
    await seedTelegramUser(userId, userId);
    const overdue = new Date(Date.now() - 60 * 60 * 1000);
    const taskA = await createActionItem(userId, { source: "manual", title: "Apply to 3 developer jobs", dueAt: overdue });
    const taskB = await createActionItem(userId, { source: "manual", title: "Upgrade to Node.js 24", dueAt: overdue });
    const taskC = await createActionItem(userId, { source: "manual", title: "Branding direction meeting", dueAt: overdue });

    const { send } = stubTelegram();
    await sendDueActionReminders(new Date(), { sendTelegramMessage: send });

    mockPlan({
      topic: "actions",
      intent: "hygiene_apply",
      operations: [
        op("action.hygiene_apply", {
          selections: [
            { index: 1, decision: "complete" },
            { index: 2, decision: "snooze", snoozeUntilText: "tomorrow" },
            { index: 3, decision: "archive" }
          ]
        })
      ],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "complete 1, snooze 2 tomorrow, archive 3");

    assert.equal(reply.debug.mutationExecuted, true);
    assert.doesNotMatch(reply.reply, /couldn't find that in the current list/i);

    const rowA = await prisma.actionItem.findUnique({ where: { id: taskA.id } });
    const rowB = await prisma.actionItem.findUnique({ where: { id: taskB.id } });
    const rowC = await prisma.actionItem.findUnique({ where: { id: taskC.id } });
    assert.equal(rowA?.status, "completed", "index 1 must resolve to the first bundled action, not require a raw UUID");
    assert.equal(rowB?.status, "snoozed");
    assert.equal(rowC?.status, "archived");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
