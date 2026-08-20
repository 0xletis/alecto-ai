import { createNotificationLog, hasNotificationLog } from "@operator-agent/db";
import { proactiveOperatorAllowlistFromEnv, proactiveOperatorDeliveryEnabledFromEnv } from "@operator-agent/core";
import { formatLocalDate, formatLocalTime, formatMinutesOfDay } from "./datetime.js";
import type { V3ProactiveNotificationSettingsLike } from "./v3-proactive-delivery.js";

/**
 * The legacy daily-loop morning message (`GET /users/:userId/daily-loop/start-day`, built by
 * apps/api/src/operator/attention.ts's buildStartDayMessage — the "First move: ... / Guardrail:
 * ..." format, NOT V3's proactive morning brief). Extracted out of apps/worker/src/index.ts
 * (which runs its tick loop as an import side effect and so is unsafe to import in tests, the
 * same reason v3-proactive-delivery.ts and integration-sync.ts are their own files) specifically
 * so the legacy-vs-V3 duplicate-send prevention below is testable.
 *
 * Duplicate-send prevention (docs/10-v3-readiness-audit.md §18): both this module and
 * v3-proactive-delivery.ts are driven by the exact same NotificationSettings row and the exact
 * same worker tick, gated on the exact same telegramUserId/dailyLoopEnabled/morningTimeMinutes
 * conditions — before this pass, nothing stopped both from sending a real Telegram message to the
 * same user in the same tick once V3 delivery was ever turned on. The fix: this module additionally
 * skips whenever V3 is actually configured to own morning delivery for that user — i.e.
 * morningBriefEnabled is on AND V3 delivery is truly live for them (PROACTIVE_OPERATOR_DELIVERY_ENABLED
 * and the allowlist, the same two functions v3-proactive-delivery.ts itself reads). Checking "V3 is
 * actually live," not just "the user opted in," is deliberate: PROACTIVE_OPERATOR_DELIVERY_ENABLED
 * defaults false and the allowlist is a developer rollout control, so for the overwhelming majority
 * of users today this check is a no-op and the legacy message keeps sending exactly as before —
 * turning on morningBriefEnabled must never silently leave a user with NO morning message just
 * because V3 real delivery isn't actually enabled for them yet.
 */

export interface LegacyDailyLoopMorningOptions {
  now?: Date;
  /** Defaults to PROACTIVE_OPERATOR_DELIVERY_ENABLED === "true" — matches v3-proactive-delivery.ts exactly, so both sides agree on whether V3 is actually live. */
  v3DeliveryEnabled?: boolean;
  /** Defaults to parsing PROACTIVE_OPERATOR_ALLOWLIST — matches v3-proactive-delivery.ts exactly. */
  v3IsAllowed?: (userId: string) => boolean;
  apiGet: <T>(path: string) => Promise<T>;
  sendTelegramMessage: (chatId: string, text: string) => Promise<void>;
  logger?: Pick<Console, "log" | "error">;
}

interface DailyLoopMessageResponse {
  message: string;
}

export async function runLegacyDailyLoopMorningBriefs(
  settings: V3ProactiveNotificationSettingsLike[],
  options: LegacyDailyLoopMorningOptions
): Promise<void> {
  const now = options.now ?? new Date();
  const v3DeliveryEnabled = options.v3DeliveryEnabled ?? proactiveOperatorDeliveryEnabledFromEnv();
  const v3IsAllowed = options.v3IsAllowed ?? proactiveOperatorAllowlistFromEnv();
  const logger = options.logger ?? console;

  for (const item of settings) {
    if (!item.telegramUserId || !item.dailyLoopEnabled) {
      continue;
    }

    if (formatMinutesOfDay(item.morningTimeMinutes) !== formatLocalTime(now, item.timezone)) {
      continue;
    }

    if (item.morningBriefEnabled && v3DeliveryEnabled && v3IsAllowed(item.userId)) {
      logger.log(`Skipping legacy daily-loop morning brief for ${item.userId}: V3 proactive morning brief owns delivery for this user.`);
      continue;
    }

    await maybeSendLegacyDailyLoopStart(item, now, options.apiGet, options.sendTelegramMessage, logger);
  }
}

async function maybeSendLegacyDailyLoopStart(
  item: V3ProactiveNotificationSettingsLike,
  now: Date,
  apiGet: LegacyDailyLoopMorningOptions["apiGet"],
  sendTelegramMessage: LegacyDailyLoopMorningOptions["sendTelegramMessage"],
  logger: Pick<Console, "log" | "error">
): Promise<void> {
  if (!item.telegramUserId) {
    return;
  }

  const sentForDate = formatLocalDate(now, item.timezone);
  const logInput = {
    userId: item.userId,
    type: "daily_loop_morning",
    sentForDate
  };

  if (await hasNotificationLog(logInput)) {
    return;
  }

  let response: DailyLoopMessageResponse;
  try {
    response = await apiGet<DailyLoopMessageResponse>(`/users/${item.userId}/daily-loop/start-day?markSent=true&now=${encodeURIComponent(now.toISOString())}`);
  } catch (error) {
    logger.error(`Legacy daily-loop start fetch failed for ${item.userId}`, error);
    return;
  }

  try {
    await sendTelegramMessage(item.telegramUserId, response.message);
  } catch (error) {
    logger.error(`Legacy daily-loop start send failed for ${item.userId}`, error);
    return;
  }

  const logged = await createNotificationLog(logInput);

  if (logged) {
    logger.log(`Sent legacy daily-loop start to ${item.userId} for ${sentForDate}.`);
  }
}
