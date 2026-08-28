import {
  createActionItemReminderLog,
  getActionItemsEligibleForReminder,
  getAgentConversationSession,
  getOrCreateNotificationSettings,
  reopenSnoozedActionItem,
  upsertAgentConversationSession,
  type ActionItemReminderCandidate
} from "@operator-agent/db";
import { buildOpenActionCommandFooter, formatOverdueSinceLabelForChat } from "@operator-agent/core";

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
      const message = formatBundledActionReminderMessage(userCandidates, settings.timezone, now);
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

function formatBundledActionReminderMessage(candidates: ActionItemReminderCandidate[], timezone: string, now: Date): string {
  // fix/private-alpha-proactive-checkins-and-overdue-action-ux: a real Telegram transcript found
  // this footer still hardcoded as "Reply: complete 1, snooze 2 tomorrow, or archive 3." — always
  // referencing indexes 1/2/3 regardless of how many actions were actually bundled (one action
  // shown, "archive 3" referenced), and still saying the user-facing-forbidden word "snooze".
  // apps/api's own action.list had already fixed the identical bug for its own footer (see
  // buildOpenActionCommandFooter's doc comment in @operator-agent/core) — this worker message is a
  // completely separate code path (apps/worker never imports apps/api) that nothing kept in sync.
  // Every candidate bundled here is, by construction, an open action whose due (or deferred-
  // return) moment has already passed, so its own index is always a valid, real "open index".
  const allOverdueDue = candidates.every(
    (candidate) => candidate.reminderType === "due" && Boolean(candidate.actionItem.dueAt && candidate.actionItem.dueAt < now)
  );
  const noun = allOverdueDue ? "overdue action" : "action reminder";
  const header = `You have ${candidates.length} ${noun}${candidates.length === 1 ? "" : "s"}:`;

  const lines = [
    header,
    ...candidates.map((candidate, index) => {
      const dueLine = candidate.actionItem.dueAt ? ` — ${formatOverdueSinceLabelForChat(candidate.actionItem.dueAt, timezone, now)}` : "";
      return `${index + 1}. ${candidate.actionItem.title}${dueLine}`;
    })
  ];

  const openIndexes = candidates.map((_, index) => index + 1);
  const footer = buildOpenActionCommandFooter(openIndexes);
  if (footer) {
    lines.push("", footer);
  }

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
    deferredCapabilityProposals: existing?.deferredCapabilityProposals ?? [],
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
