import { createNotificationLog } from "@operator-agent/db";
import { proactiveOperatorAllowlistFromEnv, proactiveOperatorDeliveryEnabledFromEnv } from "@operator-agent/core";
import { formatLocalDate, formatLocalTime, formatMinutesOfDay } from "./datetime.js";

/**
 * Cautious first real-delivery path for Agent Runtime v3's Proactive Operator MVP
 * (apps/api/src/operator/proactive.ts / docs/10-v3-readiness-audit.md §13) — morning_brief
 * ONLY, off by default, behind PROACTIVE_OPERATOR_DELIVERY_ENABLED. evening_checkin and
 * gmail_nudge stay preview-only this pass; nothing here decides message content — that stays
 * entirely inside apps/api's decideProactiveOperatorMessage, reached ONLY via the existing,
 * UNCHANGED GET /users/:userId/operator/proactive/preview route (never called with markSent or
 * any mutating param — this module writes NotificationLog itself, after a successful send, the
 * exact same "check → fetch content → send → log" shape apps/worker/src/index.ts's
 * maybeSendDailyInsight/maybeSendWeeklyInsight already use for their own scheduled sends).
 *
 * Kept in its own file, not apps/worker/src/index.ts, specifically so it can be imported by
 * tests without triggering index.ts's top-level `await runTick(); setInterval(...)` — the same
 * reason apps/worker/src/integration-sync.ts is its own file.
 *
 * Relationship to apps/api/src/operator/proactive-eligibility.ts's getProactiveDeliveryStatus
 * (the "why didn't I get my morning brief?" diagnostic): both gate on the same six concerns —
 * PROACTIVE_OPERATOR_DELIVERY_ENABLED, the allowlist, morningBriefEnabled, dailyLoopEnabled,
 * time proximity, and dedupe — and both ultimately go through decideProactiveOperatorMessage for
 * the actual content decision, so they can't drift on WHAT they check. They can't share the
 * check itself as one function: apps/worker and apps/api are separate deployable packages that
 * only talk over HTTP (this module calls decideProactiveOperatorMessage indirectly, through the
 * unmodified preview route), so getProactiveDeliveryStatus's in-process reimplementation is the
 * pragmatic alternative — kept drift-free by importing proactive.ts's own exported
 * isWithinWindow/minutesOfDayInTimezone/TIME_TRIGGER_WINDOW_MINUTES rather than restating the
 * window math. One intentional difference: this module's time gate below (line ~80) is an
 * exact-minute match, not the ±TIME_TRIGGER_WINDOW_MINUTES window getProactiveDeliveryStatus
 * uses — the worker ticks continuously and needs a fire-once-per-minute trigger, while the
 * diagnostic is answering "was I ever in range," a broader question. This is a deliberate
 * difference in what each layer needs, not a bug to reconcile.
 */

export interface V3ProactiveNotificationSettingsLike {
  userId: string;
  telegramUserId?: string;
  dailyLoopEnabled: boolean;
  /** The actual per-user product consent for morning-brief delivery — see packages/core/src/notifications.ts. Distinct from dailyLoopEnabled. */
  morningBriefEnabled: boolean;
  timezone: string;
  morningTimeMinutes: number;
}

export interface V3ProactiveMorningBriefOptions {
  now?: Date;
  /** Defaults to PROACTIVE_OPERATOR_DELIVERY_ENABLED === "true" — off unless explicitly opted in. */
  deliveryEnabled?: boolean;
  /** Defaults to parsing PROACTIVE_OPERATOR_ALLOWLIST (comma-separated userIds); unset/empty means every user is allowed once the master flag is on. */
  isAllowed?: (userId: string) => boolean;
  apiGet: <T>(path: string) => Promise<T>;
  sendTelegramMessage: (chatId: string, text: string) => Promise<void>;
  logger?: Pick<Console, "log" | "error">;
}

interface ProactiveDecisionResponse {
  decision:
    | { decision: "no_message"; reason: string }
    | {
        decision: "proposed_message";
        type: "morning_brief" | "evening_checkin" | "gmail_nudge";
        message: string;
        dedupeKey: string;
        [key: string]: unknown;
      };
}

/**
 * Only ever sends morning_brief — evening_checkin/gmail_nudge candidates from the preview route
 * are deliberately ignored this pass. Respects dailyLoopEnabled, the same time-of-day gate the
 * legacy daily-loop morning brief already uses, and the decision module's own quiet-hours/daily-
 * cap/dedupe logic (reached transparently through the unmodified preview route).
 */
export async function runV3ProactiveMorningBriefs(settings: V3ProactiveNotificationSettingsLike[], options: V3ProactiveMorningBriefOptions): Promise<void> {
  const now = options.now ?? new Date();
  const deliveryEnabled = options.deliveryEnabled ?? proactiveOperatorDeliveryEnabledFromEnv();
  const isAllowed = options.isAllowed ?? proactiveOperatorAllowlistFromEnv();
  const logger = options.logger ?? console;

  if (!deliveryEnabled) {
    return;
  }

  for (const item of settings) {
    // dailyLoopEnabled is a separate, older feature (legacy daily-loop start/end-day messages).
    // morningBriefEnabled is the actual per-user product consent for THIS feature — required
    // independently, so a user can never receive a v3 morning brief without having explicitly
    // opted into it themselves (via /agent/message's proactive.settings_* tools).
    if (!item.telegramUserId || !item.dailyLoopEnabled || !item.morningBriefEnabled || !isAllowed(item.userId)) {
      continue;
    }

    if (formatMinutesOfDay(item.morningTimeMinutes) !== formatLocalTime(now, item.timezone)) {
      continue;
    }

    await maybeSendV3MorningBrief(item, now, options.apiGet, options.sendTelegramMessage, logger);
  }
}

async function maybeSendV3MorningBrief(
  item: V3ProactiveNotificationSettingsLike,
  now: Date,
  apiGet: V3ProactiveMorningBriefOptions["apiGet"],
  sendTelegramMessage: V3ProactiveMorningBriefOptions["sendTelegramMessage"],
  logger: Pick<Console, "log" | "error">
): Promise<void> {
  if (!item.telegramUserId) {
    return;
  }

  let response: ProactiveDecisionResponse;
  try {
    response = await apiGet<ProactiveDecisionResponse>(`/users/${item.userId}/operator/proactive/preview?now=${encodeURIComponent(now.toISOString())}`);
  } catch (error) {
    logger.error(`V3 proactive preview failed for ${item.userId}`, error);
    return;
  }

  const decision = response.decision;
  if (decision.decision !== "proposed_message" || decision.type !== "morning_brief") {
    return;
  }

  try {
    await sendTelegramMessage(item.telegramUserId, decision.message);
  } catch (error) {
    // Deliberately does NOT write NotificationLog on failure — an undelivered message must stay
    // eligible to try again next tick.
    logger.error(`V3 morning brief send failed for ${item.userId}`, error);
    return;
  }

  const sentForDate = formatLocalDate(now, item.timezone);
  const logged = await createNotificationLog({ userId: item.userId, type: decision.dedupeKey, sentForDate });

  if (logged) {
    logger.log(`Sent v3 morning brief to ${item.userId} for ${sentForDate}.`);
  }
}
