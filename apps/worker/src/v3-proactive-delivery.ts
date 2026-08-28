import { createNotificationLog, getAgentConversationSession, selfHealDailyLoopEnabled, upsertAgentConversationSession } from "@operator-agent/db";
import { proactiveOperatorAllowlistFromEnv, proactiveOperatorDeliveryEnabledFromEnv } from "@operator-agent/core";
import { formatLocalDate, formatLocalTime, formatMinutesOfDay } from "./datetime.js";
import { telegramChatIdFromUserId } from "./telegram-chat-id.js";

/**
 * Real-delivery path for Agent Runtime v3's Proactive Operator MVP
 * (apps/api/src/operator/proactive.ts / docs/10-v3-readiness-audit.md §13): morning_brief,
 * evening_checkin, and gmail_nudge — all off by default behind PROACTIVE_OPERATOR_DELIVERY_ENABLED
 * and their own per-user NotificationSettings opt-ins. Nothing here
 * decides message content — that stays
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
 * evening_checkin (fix/private-alpha-known-gaps): the decision layer (decideProactiveOperatorMessage's
 * buildEveningCheckin) and the preview HTTP route were already fully built and evening_checkin-aware
 * — EVENING_CHECKIN_DEDUPE_KEY was already included in the preview route's own candidateDedupeKeys,
 * and buildEveningCheckin already produces real, grounded message content (untracked goals today).
 * The only missing piece was a worker-side send loop — runV3ProactiveEveningCheckins below mirrors
 * runV3ProactiveMorningBriefs exactly (same gating order: telegramUserId, the moment's own opt-in,
 * exact-minute time match, dailyLoopEnabled, allowlist), reusing the same maybeSendV3ProactiveDecision
 * send/log/isolate helper morning_brief and gmail_nudge already share.
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
  /** The actual per-user product consent for evening-check-in delivery. Distinct from dailyLoopEnabled. */
  eveningCheckinEnabled: boolean;
  /** The actual per-user product consent for proactive Gmail review nudges. */
  gmailNudgeEnabled: boolean;
  timezone: string;
  morningTimeMinutes: number;
  eveningTimeMinutes: number;
}

export interface V3ProactiveDeliveryOptions {
  now?: Date;
  /** Defaults to PROACTIVE_OPERATOR_DELIVERY_ENABLED === "true" — off unless explicitly opted in. */
  deliveryEnabled?: boolean;
  /** Defaults to parsing PROACTIVE_OPERATOR_ALLOWLIST (comma-separated userIds); unset/empty means every user is allowed once the master flag is on. */
  isAllowed?: (userId: string) => boolean;
  apiGet: <T>(path: string) => Promise<T>;
  sendTelegramMessage: (chatId: string, text: string) => Promise<void>;
  logger?: Pick<Console, "log" | "error">;
}

export type V3ProactiveMorningBriefOptions = V3ProactiveDeliveryOptions;

/**
 * fix/private-alpha-proactive-worker-delivery-and-gmail-log-noise (task 6 — worker observability):
 * a compact, per-tick summary for runV3ProactiveMorningBriefs/runV3ProactiveEveningCheckins —
 * "due" counts only users whose exact-minute schedule matched THIS tick (the small subset that
 * reaches the "only log from here on" point below), not the whole opted-in population, so the
 * numbers stay meaningful at a glance rather than restating settings.length every minute.
 */
export interface V3ProactiveTickSummary {
  due: number;
  sent: number;
  skipped: number;
  skippedReasons: Record<string, number>;
  errors: number;
}

function emptyTickSummary(): V3ProactiveTickSummary {
  return { due: 0, sent: 0, skipped: 0, skippedReasons: {}, errors: 0 };
}

function recordSkip(summary: V3ProactiveTickSummary, reason: string): void {
  summary.skipped += 1;
  summary.skippedReasons[reason] = (summary.skippedReasons[reason] ?? 0) + 1;
}

function applyDeliveryResult(summary: V3ProactiveTickSummary, result: V3ProactiveDeliveryResult): void {
  if (result.status === "sent") {
    summary.sent += 1;
  } else if (result.status === "preview_failed" || result.status === "send_failed" || result.status === "session_failed") {
    summary.errors += 1;
  } else {
    recordSkip(summary, result.reason);
  }
}

interface ProactiveDecisionResponse {
  decision:
    | { decision: "no_message"; reason: string }
    | {
        decision: "proposed_message";
        type: "morning_brief" | "evening_checkin" | "gmail_nudge";
        message: string;
        dedupeKey: string;
        entities?: ProactiveVisibleEntity[];
        [key: string]: unknown;
      };
  eligibility?: {
    wouldSend: boolean;
    blockedBy: string[];
    [key: string]: unknown;
  };
}

/**
 * fix/private-alpha-proactive-worker-delivery-and-gmail-log-noise: NotificationSettings.
 * telegramUserId is ONLY ever written by the legacy Telegram slash commands — a user who opts in
 * through natural chat (proactive.settings_apply_update) gets a fully-configured row with this
 * field null, and every sender below used to gate purely on it being set, silently `continue`ing
 * forever with no log line and no NotificationLog row. Falling back to deriving it from the
 * userId itself (the same fallback action-reminders.ts already had) closes that gap; returns the
 * item unchanged (still carrying whatever real telegramUserId it had) when a chat id resolves.
 */
function resolveTelegramChatId(item: V3ProactiveNotificationSettingsLike): V3ProactiveNotificationSettingsLike | undefined {
  const chatId = item.telegramUserId ?? telegramChatIdFromUserId(item.userId);
  return chatId ? { ...item, telegramUserId: chatId } : undefined;
}

export async function runV3ProactiveMorningBriefs(settings: V3ProactiveNotificationSettingsLike[], options: V3ProactiveDeliveryOptions): Promise<V3ProactiveTickSummary> {
  const now = options.now ?? new Date();
  const deliveryEnabled = options.deliveryEnabled ?? proactiveOperatorDeliveryEnabledFromEnv();
  const isAllowed = options.isAllowed ?? proactiveOperatorAllowlistFromEnv();
  const logger = options.logger ?? console;
  const summary = emptyTickSummary();

  if (!deliveryEnabled) {
    logger.log("V3 proactive morning brief: PROACTIVE_OPERATOR_DELIVERY_ENABLED is not \"true\" in this process — skipping for every user this tick.");
    return summary;
  }

  for (const rawItem of settings) {
    if (!rawItem.morningBriefEnabled) {
      continue;
    }

    // Only log from here on — this is the exact minute this user's morning brief was scheduled
    // for, the one moment a silent skip is actually worth surfacing. Every other tick/user
    // combination is normal and would be pure noise if logged.
    if (formatMinutesOfDay(rawItem.morningTimeMinutes) !== formatLocalTime(now, rawItem.timezone)) {
      continue;
    }

    summary.due += 1;

    const item = resolveTelegramChatId(rawItem);
    if (!item) {
      logger.log(`V3 proactive morning brief: time matched for ${rawItem.userId} but there's no resolvable Telegram chat id — skipping.`);
      recordSkip(summary, "missing_telegram_user_id");
      continue;
    }

    // dailyLoopEnabled is a separate, older feature (legacy daily-loop start/end-day messages),
    // which the worker also requires alongside morningBriefEnabled. fix/private-alpha-proactive-
    // launch-config-cleanup: an existing user who opted into morningBriefEnabled BEFORE the fix
    // that makes dailyLoopEnabled follow along automatically was otherwise stuck here forever —
    // self-heals right at the one moment it matters (this user's own scheduled minute), a no-op
    // once already healthy, rather than leaving delivery silently blocked until a manual re-toggle.
    const healedItem = await selfHealDailyLoopEnabled(item);
    if (!healedItem.dailyLoopEnabled) {
      logger.log(`V3 proactive morning brief: time matched for ${item.userId} but dailyLoopEnabled is false — skipping.`);
      recordSkip(summary, "daily_loop_disabled");
      continue;
    }

    if (!isAllowed(healedItem.userId)) {
      logger.log(`V3 proactive morning brief: time matched for ${item.userId} but they are not in PROACTIVE_OPERATOR_ALLOWLIST — skipping.`);
      recordSkip(summary, "not_allowlisted");
      continue;
    }

    const result = await maybeSendV3ProactiveDecision(healedItem, "morning_brief", now, options.apiGet, options.sendTelegramMessage, logger);
    applyDeliveryResult(summary, result);
  }

  return summary;
}

/**
 * Sends evening_checkin candidates — mirrors runV3ProactiveMorningBriefs exactly (same gating
 * order: telegramUserId, the moment's own opt-in, exact-minute time match, dailyLoopEnabled,
 * allowlist), reusing the same maybeSendV3ProactiveDecision send/log/isolate helper. The actual
 * message content (which goals are untracked today) is entirely decided by
 * decideProactiveOperatorMessage's buildEveningCheckin — this function only decides WHETHER to
 * ask for that decision and send it, never what to say.
 */
export async function runV3ProactiveEveningCheckins(settings: V3ProactiveNotificationSettingsLike[], options: V3ProactiveDeliveryOptions): Promise<V3ProactiveTickSummary> {
  const now = options.now ?? new Date();
  const deliveryEnabled = options.deliveryEnabled ?? proactiveOperatorDeliveryEnabledFromEnv();
  const isAllowed = options.isAllowed ?? proactiveOperatorAllowlistFromEnv();
  const logger = options.logger ?? console;
  const summary = emptyTickSummary();

  if (!deliveryEnabled) {
    logger.log("V3 proactive evening check-in: PROACTIVE_OPERATOR_DELIVERY_ENABLED is not \"true\" in this process — skipping for every user this tick.");
    return summary;
  }

  for (const rawItem of settings) {
    if (!rawItem.eveningCheckinEnabled) {
      continue;
    }

    // Only log from here on — this is the exact minute this user's evening check-in was
    // scheduled for, the one moment a silent skip is actually worth surfacing.
    if (formatMinutesOfDay(rawItem.eveningTimeMinutes) !== formatLocalTime(now, rawItem.timezone)) {
      continue;
    }

    summary.due += 1;

    const item = resolveTelegramChatId(rawItem);
    if (!item) {
      logger.log(`V3 proactive evening check-in: time matched for ${rawItem.userId} but there's no resolvable Telegram chat id — skipping.`);
      recordSkip(summary, "missing_telegram_user_id");
      continue;
    }

    // dailyLoopEnabled is a separate, older feature (legacy daily-loop start/end-day messages),
    // which the worker also requires alongside eveningCheckinEnabled — exactly mirroring
    // morningBriefEnabled's own relationship above. fix/private-alpha-proactive-launch-config-
    // cleanup: self-heals right at the one moment it matters (this user's own scheduled minute),
    // a no-op once already healthy.
    const healedItem = await selfHealDailyLoopEnabled(item);
    if (!healedItem.dailyLoopEnabled) {
      logger.log(`V3 proactive evening check-in: time matched for ${item.userId} but dailyLoopEnabled is false — skipping.`);
      recordSkip(summary, "daily_loop_disabled");
      continue;
    }

    if (!isAllowed(healedItem.userId)) {
      logger.log(`V3 proactive evening check-in: time matched for ${item.userId} but they are not in PROACTIVE_OPERATOR_ALLOWLIST — skipping.`);
      recordSkip(summary, "not_allowlisted");
      continue;
    }

    const result = await maybeSendV3ProactiveDecision(healedItem, "evening_checkin", now, options.apiGet, options.sendTelegramMessage, logger);
    applyDeliveryResult(summary, result);
  }

  return summary;
}

export interface V3ProactiveDeliveryResult {
  type: "morning_brief" | "evening_checkin" | "gmail_nudge";
  userId: string;
  status: "sent" | "skipped" | "preview_failed" | "send_failed" | "session_failed";
  reason: string;
  dedupeKey?: string;
}

/**
 * Sends gmail_nudge candidates for opted-in users. This never queries Gmail and never creates
 * reviews itself; it only asks the existing preview route whether a pending EmailReviewItem
 * should be nudged now, then sends/logs that decision.
 */
export async function runV3ProactiveGmailNudges(
  settings: V3ProactiveNotificationSettingsLike[],
  options: V3ProactiveDeliveryOptions
): Promise<V3ProactiveDeliveryResult[]> {
  const now = options.now ?? new Date();
  const deliveryEnabled = options.deliveryEnabled ?? proactiveOperatorDeliveryEnabledFromEnv();
  const isAllowed = options.isAllowed ?? proactiveOperatorAllowlistFromEnv();
  const logger = options.logger ?? console;
  const results: V3ProactiveDeliveryResult[] = [];

  if (!deliveryEnabled) {
    logger.log("V3 proactive Gmail nudge: PROACTIVE_OPERATOR_DELIVERY_ENABLED is not \"true\" in this process — skipping for every user this tick.");
    return settings.map((item) => ({ type: "gmail_nudge", userId: item.userId, status: "skipped", reason: "delivery_disabled" }));
  }

  for (const rawItem of settings) {
    const item = resolveTelegramChatId(rawItem);
    if (!item) {
      results.push({ type: "gmail_nudge", userId: rawItem.userId, status: "skipped", reason: "missing_telegram_user_id" });
      continue;
    }
    if (!item.dailyLoopEnabled) {
      results.push({ type: "gmail_nudge", userId: item.userId, status: "skipped", reason: "daily_loop_disabled" });
      continue;
    }
    if (!item.gmailNudgeEnabled) {
      results.push({ type: "gmail_nudge", userId: item.userId, status: "skipped", reason: "user_not_opted_in" });
      continue;
    }
    if (!isAllowed(item.userId)) {
      logger.log(`V3 proactive Gmail nudge: ${item.userId} is not in PROACTIVE_OPERATOR_ALLOWLIST — skipping.`);
      results.push({ type: "gmail_nudge", userId: item.userId, status: "skipped", reason: "not_allowlisted" });
      continue;
    }

    results.push(await maybeSendV3ProactiveDecision(item, "gmail_nudge", now, options.apiGet, options.sendTelegramMessage, logger));
  }

  return results;
}

async function maybeSendV3ProactiveDecision(
  item: V3ProactiveNotificationSettingsLike,
  expectedType: "morning_brief" | "evening_checkin" | "gmail_nudge",
  now: Date,
  apiGet: V3ProactiveDeliveryOptions["apiGet"],
  sendTelegramMessage: V3ProactiveDeliveryOptions["sendTelegramMessage"],
  logger: Pick<Console, "log" | "error">
): Promise<V3ProactiveDeliveryResult> {
  if (!item.telegramUserId) {
    return { type: expectedType, userId: item.userId, status: "skipped", reason: "missing_telegram_user_id" };
  }

  let response: ProactiveDecisionResponse;
  try {
    response = await apiGet<ProactiveDecisionResponse>(`/users/${item.userId}/operator/proactive/preview?now=${encodeURIComponent(now.toISOString())}`);
  } catch (error) {
    logger.error(`V3 proactive preview failed for ${item.userId}`, error);
    return { type: expectedType, userId: item.userId, status: "preview_failed", reason: "preview_failed" };
  }

  const decision = response.decision;
  if (decision.decision !== "proposed_message" || decision.type !== expectedType) {
    const reason = decision.decision === "no_message" ? decision.reason : `decision type was "${decision.type}", not ${expectedType}`;
    if (expectedType === "morning_brief") {
      logger.log(`V3 proactive morning brief: preview for ${item.userId} did not propose a morning brief this tick (${reason}) — nothing sent.`);
    } else if (expectedType === "evening_checkin") {
      logger.log(`V3 proactive evening check-in: preview for ${item.userId} did not propose an evening check-in this tick (${reason}) — nothing sent.`);
    }
    return { type: expectedType, userId: item.userId, status: "skipped", reason };
  }

  try {
    await sendTelegramMessage(item.telegramUserId, decision.message);
  } catch (error) {
    // Deliberately does NOT write NotificationLog on failure — an undelivered message must stay
    // eligible to try again next tick.
    logger.error(`V3 ${expectedType} send failed for ${item.userId}`, error);
    return { type: expectedType, userId: item.userId, status: "send_failed", reason: "send_failed", dedupeKey: decision.dedupeKey };
  }

  if (expectedType === "gmail_nudge") {
    try {
      await persistVisibleEntitiesForDeliveredNudge(item, decision, now);
    } catch (error) {
      logger.error(`V3 Gmail nudge session context failed for ${item.userId}`, error);
      return { type: expectedType, userId: item.userId, status: "session_failed", reason: "session_failed", dedupeKey: decision.dedupeKey };
    }
  }

  const sentForDate = formatLocalDate(now, item.timezone);
  const logged = await createNotificationLog({ userId: item.userId, type: decision.dedupeKey, sentForDate });

  if (logged && expectedType === "morning_brief") {
    logger.log(`Sent v3 morning brief to ${item.userId} for ${sentForDate}.`);
  } else if (logged && expectedType === "evening_checkin") {
    logger.log(`Sent v3 evening check-in to ${item.userId} for ${sentForDate}.`);
  } else if (logged && expectedType === "gmail_nudge") {
    logger.log(`Sent v3 Gmail nudge to ${item.userId} for ${sentForDate}.`);
  }

  return { type: expectedType, userId: item.userId, status: "sent", reason: logged ? "sent" : "dedupe_log_exists", dedupeKey: decision.dedupeKey };
}

interface ProactiveVisibleEntity {
  type: string;
  id: string;
  label: string;
  index?: number;
}

async function persistVisibleEntitiesForDeliveredNudge(
  item: V3ProactiveNotificationSettingsLike,
  decision: Extract<ProactiveDecisionResponse["decision"], { decision: "proposed_message" }>,
  now: Date
): Promise<void> {
  const entities = (decision.entities ?? []).filter(isSafeVisibleEntity);

  if (entities.length === 0) {
    return;
  }

  const existing = await getAgentConversationSession(item.userId, "telegram");
  const messages = Array.isArray(existing?.messages) ? existing.messages : [];
  const nextMessages = [
    ...messages,
    {
      role: "assistant",
      text: decision.message,
      at: now.toISOString()
    }
  ].slice(-20);

  await upsertAgentConversationSession(item.userId, "telegram", {
    topic: "gmail_reviews",
    focusedEntities: existing?.focusedEntities ?? {},
    pendingOperation: existing?.pendingOperation ?? null,
    visibleEntities: entities,
    recentMutations: existing?.recentMutations ?? [],
    deferredCapabilityProposals: existing?.deferredCapabilityProposals ?? [],
    messages: nextMessages,
    // Deliberately real wall-clock time, not the `now` parameter above (which is the SIMULATED
    // decision time used only for proactive-eligibility windowing/message timestamping, and in
    // tests is a fixed historical date). Session TTL is a real runtime concept — conversation-
    // session.ts's own loadPersistedSession compares this against the real Date.now() on every
    // later load, so basing it on a simulated "now" would make the session expire at the wrong
    // real-world moment (or, for a fixed-past test date, already-expired the instant it's read).
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
  });
}

function isSafeVisibleEntity(entity: ProactiveVisibleEntity): entity is ProactiveVisibleEntity & { type: "gmail_review" } {
  return entity.type === "gmail_review" && typeof entity.id === "string" && entity.id.length > 0 && typeof entity.label === "string" && entity.label.length > 0;
}
