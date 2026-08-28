import { createNotificationLog, hasNotificationLog } from "@operator-agent/db";
import { proactiveOperatorAllowlistFromEnv, proactiveOperatorDeliveryEnabledFromEnv } from "@operator-agent/core";
import { formatLocalDate, formatLocalTime, formatMinutesOfDay } from "./datetime.js";
import { telegramChatIdFromUserId } from "./telegram-chat-id.js";
import type { V3ProactiveNotificationSettingsLike } from "./v3-proactive-delivery.js";

/**
 * The legacy daily-loop evening review (`GET /users/:userId/daily-loop/end-day`), NOT V3's
 * proactive evening check-in. Extracted out of apps/worker/src/index.ts (fix/private-alpha-known-
 * gaps) for the exact same two reasons legacy-daily-loop-morning.ts was already extracted:
 *
 * 1. Testability — index.ts runs its tick loop as an import side effect, unsafe to import in
 *    tests.
 * 2. Duplicate-send prevention — this module and v3-proactive-delivery.ts's
 *    runV3ProactiveEveningCheckins are both driven by the exact same NotificationSettings row and
 *    the exact same worker tick, gated on the exact same telegramUserId/dailyLoopEnabled/
 *    eveningTimeMinutes conditions. Before this pass, nothing here existed at all for evening
 *    (only V3 evening check-in itself was missing a send path); once it was added, this module's
 *    OWN pre-existing send would double up with it for any user who has both dailyLoopEnabled and
 *    eveningCheckinEnabled on. The fix mirrors runLegacyDailyLoopMorningBriefs' morning-brief
 *    ownership check exactly: skip whenever V3 is actually configured to own evening delivery for
 *    that user (eveningCheckinEnabled on AND V3 delivery truly live — the same two developer
 *    rollout controls v3-proactive-delivery.ts itself reads).
 *
 * Also fixes a real, pre-existing reliability gap while extracting this: the original inline
 * version had no per-user try/catch around either the API fetch or the Telegram send, so one
 * user's failure would throw out of the whole loop — silently skipping every remaining user's
 * evening review AND (since this runs early in the worker's tick) every other proactive send
 * scheduled later in that same tick (morning briefs, Gmail nudges, integration sync, action
 * reminders). Mirrors legacy-daily-loop-morning.ts's own per-user isolation.
 */

export interface LegacyDailyLoopEveningOptions {
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

export async function runLegacyDailyLoopEveningReviews(
  settings: V3ProactiveNotificationSettingsLike[],
  options: LegacyDailyLoopEveningOptions
): Promise<void> {
  const now = options.now ?? new Date();
  const v3DeliveryEnabled = options.v3DeliveryEnabled ?? proactiveOperatorDeliveryEnabledFromEnv();
  const v3IsAllowed = options.v3IsAllowed ?? proactiveOperatorAllowlistFromEnv();
  const logger = options.logger ?? console;

  for (const rawItem of settings) {
    if (!rawItem.dailyLoopEnabled) {
      continue;
    }

    if (formatMinutesOfDay(rawItem.eveningTimeMinutes) !== formatLocalTime(now, rawItem.timezone)) {
      continue;
    }

    // fix/private-alpha-proactive-worker-delivery-and-gmail-log-noise: telegramUserId is only
    // ever written by the legacy slash commands — falls back to deriving it from the userId
    // itself (see telegram-chat-id.ts), the same fix v3-proactive-delivery.ts's own senders got.
    const chatId = rawItem.telegramUserId ?? telegramChatIdFromUserId(rawItem.userId);
    if (!chatId) {
      logger.log(`Legacy daily-loop evening review: time matched for ${rawItem.userId} but there's no resolvable Telegram chat id — skipping.`);
      continue;
    }
    const item = { ...rawItem, telegramUserId: chatId };

    if (item.eveningCheckinEnabled && v3DeliveryEnabled && v3IsAllowed(item.userId)) {
      logger.log(`Skipping legacy daily-loop evening review for ${item.userId}: V3 proactive evening check-in owns delivery for this user.`);
      continue;
    }

    await maybeSendLegacyDailyLoopEnd(item, now, options.apiGet, options.sendTelegramMessage, logger);
  }
}

async function maybeSendLegacyDailyLoopEnd(
  item: V3ProactiveNotificationSettingsLike,
  now: Date,
  apiGet: LegacyDailyLoopEveningOptions["apiGet"],
  sendTelegramMessage: LegacyDailyLoopEveningOptions["sendTelegramMessage"],
  logger: Pick<Console, "log" | "error">
): Promise<void> {
  if (!item.telegramUserId) {
    return;
  }

  const sentForDate = formatLocalDate(now, item.timezone);
  const logInput = {
    userId: item.userId,
    type: "daily_loop_evening",
    sentForDate
  };

  if (await hasNotificationLog(logInput)) {
    return;
  }

  let response: DailyLoopMessageResponse;
  try {
    response = await apiGet<DailyLoopMessageResponse>(`/users/${item.userId}/daily-loop/end-day?markSent=true&now=${encodeURIComponent(now.toISOString())}`);
  } catch (error) {
    logger.error(`Legacy daily-loop end fetch failed for ${item.userId}`, error);
    return;
  }

  try {
    await sendTelegramMessage(item.telegramUserId, response.message);
  } catch (error) {
    logger.error(`Legacy daily-loop end send failed for ${item.userId}`, error);
    return;
  }

  const logged = await createNotificationLog(logInput);

  if (logged) {
    logger.log(`Sent legacy daily-loop evening review to ${item.userId} for ${sentForDate}.`);
  }
}
