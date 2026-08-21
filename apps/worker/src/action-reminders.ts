import {
  createActionItemReminderLog,
  getActionItemsEligibleForReminder,
  getAgentConversationSession,
  getOrCreateNotificationSettings,
  reopenSnoozedActionItem,
  upsertAgentConversationSession,
  type ActionItemReminderCandidate
} from "@operator-agent/db";

/**
 * Real Telegram smoke test flagged the old per-action reminder as "too robotic for V3/private
 * alpha" — one Telegram message PER action, each exposing raw slash commands with UUIDs directly
 * to the user (`/complete_action <uuid>`, `/snooze_action <uuid> tomorrow`, `/archive_action
 * <uuid>`). This module sends ONE bundled, numbered, natural-language message per user per tick
 * instead, and persists the numbered list as that user's real V3 AgentConversationSession
 * .visibleEntities (type "action", matching index) — the same DB write shape
 * v3-proactive-delivery.ts's Gmail-nudge delivery already established for "a background job shows
 * the user a numbered list, a later chat reply must resolve against it." No agent-runtime code
 * changes were needed for the natural-reply side: action.hygiene_apply's existing selection
 * resolver (apps/api/src/agent-runtime/validator.ts's resolveHygieneApplySelections) already
 * matches a reply's numbered decisions against session.visibleEntities by type/index alone,
 * regardless of which tool originally populated that list, and planner.ts's existing
 * action-hygiene guidance already describes this same "numbered decisions -> one
 * action.hygiene_apply call" shape generically.
 *
 * Kept in its own module, separate from index.ts, deliberately: index.ts has top-level side
 * effects (it starts the real tick loop and throws if TELEGRAM_BOT_TOKEN is unset on import), so
 * it can never be imported directly by a test — the same reason v3-proactive-delivery.ts is its
 * own module. sendTelegramMessage is injected rather than imported, matching that file's own
 * V3ProactiveDeliveryOptions dependency-injection pattern, so a test can stub it without touching
 * the real Telegram API.
 */
export interface ActionReminderDeliveryOptions {
  sendTelegramMessage: (chatId: string, text: string) => Promise<void>;
}

export async function sendDueActionReminders(now: Date, options: ActionReminderDeliveryOptions): Promise<void> {
  const candidates = await getActionItemsEligibleForReminder({ now, limit: 20 });

  const byUser = new Map<string, ActionItemReminderCandidate[]>();
  for (const candidate of candidates) {
    const list = byUser.get(candidate.actionItem.userId) ?? [];
    list.push(candidate);
    byUser.set(candidate.actionItem.userId, list);
  }

  for (const [userId, userCandidates] of byUser) {
    const chatId = telegramChatIdFromUserId(userId);

    if (!chatId) {
      console.log(`Skipping action reminder for unroutable user ${userId}.`);
      continue;
    }

    try {
      const settings = await getOrCreateNotificationSettings(userId);
      const message = formatBundledActionReminderMessage(userCandidates, settings.timezone);
      await options.sendTelegramMessage(chatId, message);
      await persistVisibleEntitiesForActionReminders(userId, userCandidates, message, now);

      for (const candidate of userCandidates) {
        await createActionItemReminderLog({
          userId,
          actionItemId: candidate.actionItem.id,
          reminderType: candidate.reminderType,
          sentAt: now
        });

        if (candidate.reminderType === "snoozed") {
          await createActionItemReminderLog({
            userId,
            actionItemId: candidate.actionItem.id,
            reminderType: "due",
            sentAt: now
          });
          await reopenSnoozedActionItem(userId, candidate.actionItem.id);
        }
      }

      console.log(`Sent ${userCandidates.length} bundled action reminder(s) to ${userId}.`);
    } catch (error) {
      console.error(`Action reminder failed for ${userId}`, error);
    }
  }
}

function formatBundledActionReminderMessage(candidates: ActionItemReminderCandidate[], timezone: string): string {
  const allOverdueDue = candidates.every(
    (candidate) => candidate.reminderType === "due" && Boolean(candidate.actionItem.dueAt && candidate.actionItem.dueAt < new Date())
  );
  const noun = allOverdueDue ? "overdue action" : "action reminder";
  const header = `You have ${candidates.length} ${noun}${candidates.length === 1 ? "" : "s"}:`;

  const lines = [
    header,
    ...candidates.map((candidate, index) => {
      const dueLine = candidate.actionItem.dueAt ? ` (due: ${formatLocalDateTime(candidate.actionItem.dueAt, timezone)})` : "";
      return `${index + 1}. ${candidate.actionItem.title}${dueLine}`;
    }),
    "",
    "Reply: complete 1, snooze 2 tomorrow, or archive 3."
  ];

  return lines.join("\n");
}

async function persistVisibleEntitiesForActionReminders(userId: string, candidates: ActionItemReminderCandidate[], message: string, now: Date): Promise<void> {
  const entities = candidates.map((candidate, index) => ({ type: "action", id: candidate.actionItem.id, label: candidate.actionItem.title, index: index + 1 }));

  const existing = await getAgentConversationSession(userId, "telegram");
  const messages = Array.isArray(existing?.messages) ? existing.messages : [];
  const nextMessages = [...messages, { role: "assistant", text: message, at: now.toISOString() }].slice(-20);

  await upsertAgentConversationSession(userId, "telegram", {
    topic: "actions",
    focusedEntities: existing?.focusedEntities ?? {},
    pendingOperation: existing?.pendingOperation ?? null,
    visibleEntities: entities,
    recentMutations: existing?.recentMutations ?? [],
    messages: nextMessages,
    // Deliberately real wall-clock time — see the identical comment in
    // v3-proactive-delivery.ts's persistVisibleEntitiesForDeliveredNudge for why.
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
  });
}

function telegramChatIdFromUserId(userId: string): string | undefined {
  const match = userId.match(/^telegram:(\d+)$/);
  return match?.[1];
}

function formatLocalDateTime(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}
