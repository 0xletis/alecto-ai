import { telegramChatIdFromUserId, type NotificationSettings } from "@operator-agent/core";
import type { ContextBundle } from "../agent-runtime/types.js";
import { formatMinutesOfDay } from "./daily-loop-settings.js";
import {
  decideProactiveOperatorMessage,
  EVENING_CHECKIN_DEDUPE_KEY,
  isWithinWindow,
  minutesOfDayInTimezone,
  MORNING_BRIEF_DEDUPE_KEY,
  TIME_TRIGGER_WINDOW_MINUTES,
  type ProactiveDecision,
  type ProactiveMessageType
} from "./proactive.js";

/**
 * Layers real send-eligibility on top of decideProactiveOperatorMessage's own content decision
 * — deliberately kept OUT of proactive.ts, which stays a pure content-decision module unaware of
 * env flags or per-user product consent. Two independent gates, per the product correction that
 * introduced user-level settings: PROACTIVE_OPERATOR_DELIVERY_ENABLED/PROACTIVE_OPERATOR_ALLOWLIST
 * are developer rollout controls (never the product UX); morningBriefEnabled/
 * eveningCheckinEnabled/gmailNudgeEnabled (packages/core/src/notifications.ts) are the actual
 * per-user, per-moment consent a real send additionally requires. Used by the preview route to
 * report wouldSend/blockedBy, and independently re-checked by apps/worker's own delivery code —
 * this module's output is informational for preview, never the sole gate a real send relies on.
 */

export type ProactiveBlockedReason =
  | "delivery_disabled"
  | "not_allowlisted"
  | "user_not_opted_in"
  | "quiet_hours"
  | "dedupe"
  | "no_candidate";

export interface ProactiveEligibilityInput {
  decision: ProactiveDecision;
  deliveryEnabled: boolean;
  isAllowlisted: boolean;
  notificationSettings: NotificationSettings;
}

export interface ProactiveEligibilityResult {
  wouldSend: boolean;
  blockedBy: ProactiveBlockedReason[];
}

const NO_MESSAGE_REASON_TO_BLOCKED_BY: Record<string, ProactiveBlockedReason> = {
  daily_loop_disabled: "quiet_hours",
  daily_max_reached: "dedupe",
  no_eligible_candidate: "no_candidate"
};

export function evaluateProactiveEligibility(input: ProactiveEligibilityInput): ProactiveEligibilityResult {
  const blockedBy: ProactiveBlockedReason[] = [];

  if (!input.deliveryEnabled) {
    blockedBy.push("delivery_disabled");
  }
  if (!input.isAllowlisted) {
    blockedBy.push("not_allowlisted");
  }

  if (input.decision.decision === "no_message") {
    blockedBy.push(NO_MESSAGE_REASON_TO_BLOCKED_BY[input.decision.reason] ?? "no_candidate");
    return { wouldSend: false, blockedBy };
  }

  if (!isUserOptedIn(input.decision.type, input.notificationSettings)) {
    blockedBy.push("user_not_opted_in");
  }

  return { wouldSend: blockedBy.length === 0, blockedBy };
}

function isUserOptedIn(type: ProactiveMessageType, settings: NotificationSettings): boolean {
  if (type === "morning_brief") return settings.morningBriefEnabled;
  if (type === "evening_checkin") return settings.eveningCheckinEnabled;
  return settings.gmailNudgeEnabled;
}

/**
 * A single, most-specific, ordered diagnosis for "why didn't I get my morning brief?" — morning
 * brief only, since it's the only moment actually wired to real delivery (apps/worker/src/
 * v3-proactive-delivery.ts). Reuses decideProactiveOperatorMessage and its exported time-window
 * helpers directly (isWithinWindow/minutesOfDayInTimezone/TIME_TRIGGER_WINDOW_MINUTES) rather
 * than reimplementing the window/dedupe/candidate math, so this can never drift out of sync with
 * what the decision module or apps/worker's own send-gate actually do.
 *
 * PROACTIVE_OPERATOR_ALLOWLIST is an OPTIONAL developer rollout limiter (docs/10-v3-readiness-
 * audit.md §19) — unset/empty means "no further restriction," never a problem to report. Only an
 * allowlist that's SET but excludes this specific user (user_not_allowlisted) is ever a blocker;
 * there is deliberately no separate "missing allowlist" status, since a missing allowlist isn't
 * an error condition — it's the normal, expected solo/dev-phase default. The "eligible" message
 * below still names the allowlist's active/inactive state, so a developer reading it never has to
 * wonder whether it's silently the culprit.
 */
export type ProactiveDeliveryStatus =
  | "legacy_daily_loop_sent_instead"
  | "delivery_disabled"
  | "user_not_allowlisted"
  | "user_not_opted_in"
  | "daily_loop_disabled"
  | "missing_telegram_user_id"
  | "due_later_today"
  | "missed_no_record"
  | "duplicate_dedupe_key"
  | "no_candidate"
  | "eligible";

export interface ProactiveDeliveryStatusInput {
  context: ContextBundle;
  notificationSettings: NotificationSettings;
  now: Date;
  alreadySentDedupeKeys: Set<string>;
  sentCountToday: number;
  deliveryEnabled: boolean;
  isAllowlisted: boolean;
  /** The real sentAt of today's LEGACY daily-loop morning message (NotificationLog type
   * "daily_loop_morning"), when one exists — see docs/10-v3-readiness-audit.md §18. Checked
   * first: apps/worker/src/legacy-daily-loop-morning.ts only ever sends when V3 does NOT own
   * delivery for this user, so a value here means legacy — not V3 — is the actual source of
   * today's morning message. Carrying the real timestamp (not just a boolean) matters: this can
   * be a send from EARLIER today, before the user's current morningTimeMinutes was set to
   * something later — reporting the user's now-current scheduled time here would misstate when
   * the message they actually received went out. */
  legacyDailyLoopSentAt: Date | undefined;
}

export function getProactiveDeliveryStatus(input: ProactiveDeliveryStatusInput): ProactiveDeliveryStatus {
  const settings = input.notificationSettings;

  // V3's own success is checked FIRST, ahead of everything else including legacy: if V3 already
  // sent today, that is the most current, most relevant truth, and must never be shadowed by a
  // legacy send from earlier the same day (e.g. before the user opted into/rescheduled V3) — a
  // real incident showed a stale legacy_daily_loop_sent_instead answer persisting for the rest of
  // the day even after the user rescheduled and re-asked about a completely different window.
  if (input.alreadySentDedupeKeys.has(MORNING_BRIEF_DEDUPE_KEY)) {
    return "duplicate_dedupe_key";
  }
  if (input.legacyDailyLoopSentAt) {
    return "legacy_daily_loop_sent_instead";
  }
  if (!input.deliveryEnabled) {
    return "delivery_disabled";
  }
  if (!input.isAllowlisted) {
    return "user_not_allowlisted";
  }
  if (!settings.morningBriefEnabled) {
    return "user_not_opted_in";
  }
  if (!settings.dailyLoopEnabled) {
    return "daily_loop_disabled";
  }

  // fix/private-alpha-proactive-worker-delivery-and-gmail-log-noise: a real production incident —
  // a fully opted-in tester (morningBriefEnabled/dailyLoopEnabled/timezone/morningTimeMinutes all
  // correct) never received a single message because NotificationSettings.telegramUserId is only
  // ever written by the legacy Telegram slash commands, never by this natural-chat opt-in path.
  // The worker itself now falls back to deriving the chat id from userId (telegramChatIdFromUserId
  // in @operator-agent/core), so this exact status is unreachable for any real Telegram user going
  // forward — checked here anyway so this diagnosis can never again misreport this failure mode as
  // "missed_no_record" (which actively pointed away from the real cause) if it somehow recurs.
  if (!settings.telegramUserId && !telegramChatIdFromUserId(input.context.session.userId)) {
    return "missing_telegram_user_id";
  }

  // fix/private-alpha-gmail-classifier-precision-and-proactive-diagnostics: a real Telegram
  // transcript showed this reached at 10:54 for a 09:00 brief, with NOTHING actually blocking
  // delivery (every check above already passed) — the only honest remaining question is whether
  // the scheduled moment is still ahead of "now" (due later today) or already behind it (should
  // have sent, no record found — likely a missed tick or a failed send, since a failed Telegram
  // send never writes NotificationLog). Splitting on nowMinutes vs the scheduled minute (not the
  // ±window edges) answers exactly that, using only facts already established by this point.
  const nowMinutes = minutesOfDayInTimezone(input.now, settings.timezone);
  if (!isWithinWindow(nowMinutes, settings.morningTimeMinutes, TIME_TRIGGER_WINDOW_MINUTES)) {
    return nowMinutes < settings.morningTimeMinutes ? "due_later_today" : "missed_no_record";
  }

  const decision = decideProactiveOperatorMessage({
    context: input.context,
    notificationSettings: settings,
    now: input.now,
    alreadySentDedupeKeys: input.alreadySentDedupeKeys,
    sentCountToday: input.sentCountToday
  });

  if (decision.decision === "no_message" || decision.type !== "morning_brief") {
    return "no_candidate";
  }

  return "eligible";
}

const DIAGNOSIS_MESSAGE: Record<ProactiveDeliveryStatus, (time: string, allowlistActive: boolean) => string> = {
  legacy_daily_loop_sent_instead: (time) =>
    `You did get a morning message today around ${time} — but it came from the older legacy daily-loop system, not the V3 proactive morning brief you're asking about. Real V3 delivery is still a developer rollout control most users aren't on yet; ask "what proactive messages are on?" to check your V3 opt-in and scheduled time.`,
  delivery_disabled: () => "Morning brief is configured on, but delivery is disabled on this server.",
  user_not_allowlisted: (time) => `Morning brief was skipped today. Reason: not eligible — not in the allowlist. It's on at ${time}.`,
  user_not_opted_in: () => "Morning brief is currently off — turn it on and I'll start sending it.",
  // fix/private-alpha-proactive-launch-config-cleanup: effectively unreachable in the live tool
  // (proactive.diagnose_morning_brief self-heals dailyLoopEnabled before ever computing this
  // status now) — kept as an accurate defensive fallback rather than assumed impossible.
  daily_loop_disabled: (time) =>
    `Morning brief was skipped today. Reason: blocked — internal daily loop is off. It's on at ${time}; this should self-heal automatically — if you're still seeing this, say "turn on morning brief" again to repair it.`,
  missing_telegram_user_id: (time) =>
    `Morning brief was skipped today. Reason: no reachable Telegram chat found for your account. It's on at ${time}. This should be fixed automatically the next time it's due — if it happens again, message the bot once from Telegram and try again.`,
  due_later_today: (time) => `Morning brief is on and due today around ${time}.`,
  missed_no_record: (time) =>
    `Morning brief should have sent today around ${time}, but I don't see a sent record. Current status: eligible. Next due: tomorrow ${time}.`,
  duplicate_dedupe_key: (time) => `Morning brief was sent today at ${time}.`,
  no_candidate: (time) => `Morning brief is on at ${time}, but there isn't anything grounded to send right now (e.g. no active goals or open actions) — check back closer to ${time}.`,
  eligible: (time, allowlistActive) =>
    `Settings look eligible — morning brief is on at ${time}${allowlistActive ? ", and you're in the configured allowlist" : " (no allowlist is configured, so that's not restricting anyone)"}. Check whether the worker process was running at ${time} and whether Telegram delivery failed.`
};

export function formatProactiveDeliveryDiagnosis(
  status: ProactiveDeliveryStatus,
  settings: NotificationSettings,
  legacyDailyLoopSentAt?: Date,
  allowlistActive = false,
  // fix/private-alpha-gmail-classifier-precision-and-proactive-diagnostics: the REAL v3 sentAt for
  // today, when one exists — "Morning brief was sent today at 09:00" must report when it actually
  // went out, not the currently-configured morningTimeMinutes (which could have been changed since).
  v3SentAt?: Date
): string {
  // legacy_daily_loop_sent_instead / duplicate_dedupe_key both report a REAL sentAt, not the
  // user's current morningTimeMinutes — either send can predate a since-changed schedule, and
  // reusing the current setting here would misstate when the message actually went out.
  const time =
    status === "legacy_daily_loop_sent_instead" && legacyDailyLoopSentAt
      ? formatMinutesOfDay(minutesOfDayInTimezone(legacyDailyLoopSentAt, settings.timezone))
      : status === "duplicate_dedupe_key" && v3SentAt
        ? formatMinutesOfDay(minutesOfDayInTimezone(v3SentAt, settings.timezone))
        : formatMinutesOfDay(settings.morningTimeMinutes);

  return DIAGNOSIS_MESSAGE[status](time, allowlistActive);
}

/**
 * Evening-check-in equivalent of getProactiveDeliveryStatus/formatProactiveDeliveryDiagnosis
 * above (fix/private-alpha-known-gaps) — a separate, mirrored pair rather than parameterizing the
 * morning-brief one, deliberately: that function's own legacy-daily-loop-sent-instead branch and
 * its DIAGNOSIS_MESSAGE strings are morning-specific by name, and generalizing it risked touching
 * already-correct, already-tested morning-brief behavior for a smoke/bugfix pass that should stay
 * small. "why didn't you check in last night?" now has a real, grounded answer instead of the
 * planner having nothing but proactive.settings_show (which answers "is it on," not "why didn't
 * it send") — same shape as the morning-brief diagnostic, since evening check-in is now equally
 * real, live delivery, not a preview-only stub.
 */
export type EveningCheckinDeliveryStatus =
  | "legacy_daily_loop_sent_instead"
  | "delivery_disabled"
  | "user_not_allowlisted"
  | "user_not_opted_in"
  | "daily_loop_disabled"
  | "missing_telegram_user_id"
  | "due_later_today"
  | "missed_no_record"
  | "duplicate_dedupe_key"
  | "no_candidate"
  | "eligible";

export interface EveningCheckinDeliveryStatusInput {
  context: ContextBundle;
  notificationSettings: NotificationSettings;
  now: Date;
  alreadySentDedupeKeys: Set<string>;
  sentCountToday: number;
  deliveryEnabled: boolean;
  isAllowlisted: boolean;
  /** The real sentAt of today's LEGACY daily-loop evening review (NotificationLog type
   * "daily_loop_evening"), when one exists — mirrors legacyDailyLoopSentAt above. */
  legacyDailyLoopSentAt: Date | undefined;
}

export function getEveningCheckinDeliveryStatus(input: EveningCheckinDeliveryStatusInput): EveningCheckinDeliveryStatus {
  const settings = input.notificationSettings;

  if (input.alreadySentDedupeKeys.has(EVENING_CHECKIN_DEDUPE_KEY)) {
    return "duplicate_dedupe_key";
  }
  if (input.legacyDailyLoopSentAt) {
    return "legacy_daily_loop_sent_instead";
  }
  if (!input.deliveryEnabled) {
    return "delivery_disabled";
  }
  if (!input.isAllowlisted) {
    return "user_not_allowlisted";
  }
  if (!settings.eveningCheckinEnabled) {
    return "user_not_opted_in";
  }
  if (!settings.dailyLoopEnabled) {
    return "daily_loop_disabled";
  }

  // fix/private-alpha-proactive-worker-delivery-and-gmail-log-noise: mirrors the morning-brief
  // check above — see its comment for the full root-cause writeup.
  if (!settings.telegramUserId && !telegramChatIdFromUserId(input.context.session.userId)) {
    return "missing_telegram_user_id";
  }

  // fix/private-alpha-gmail-classifier-precision-and-proactive-diagnostics: same split as the
  // morning-brief version above — see its comment for the reasoning.
  const nowMinutes = minutesOfDayInTimezone(input.now, settings.timezone);
  if (!isWithinWindow(nowMinutes, settings.eveningTimeMinutes, TIME_TRIGGER_WINDOW_MINUTES)) {
    return nowMinutes < settings.eveningTimeMinutes ? "due_later_today" : "missed_no_record";
  }

  const decision = decideProactiveOperatorMessage({
    context: input.context,
    notificationSettings: settings,
    now: input.now,
    alreadySentDedupeKeys: input.alreadySentDedupeKeys,
    sentCountToday: input.sentCountToday
  });

  if (decision.decision === "no_message" || decision.type !== "evening_checkin") {
    return "no_candidate";
  }

  return "eligible";
}

const EVENING_DIAGNOSIS_MESSAGE: Record<EveningCheckinDeliveryStatus, (time: string, allowlistActive: boolean) => string> = {
  legacy_daily_loop_sent_instead: (time) =>
    `You did get an evening message today around ${time} — but it came from the older legacy daily-loop system, not the V3 proactive evening check-in you're asking about. Ask "what proactive messages are on?" to check your V3 opt-in and scheduled time.`,
  delivery_disabled: () => "Evening check-in is configured on, but delivery is disabled on this server.",
  user_not_allowlisted: (time) => `Evening check-in was skipped today. Reason: not eligible — not in the allowlist. It's on at ${time}.`,
  user_not_opted_in: () => "Evening check-in is currently off — turn it on and I'll start sending it.",
  // fix/private-alpha-proactive-launch-config-cleanup: effectively unreachable in the live tool
  // (proactive.diagnose_evening_checkin self-heals dailyLoopEnabled before ever computing this
  // status now) — kept as an accurate defensive fallback rather than assumed impossible.
  daily_loop_disabled: (time) =>
    `Evening check-in was skipped today. Reason: blocked — internal daily loop is off. It's on at ${time}; this should self-heal automatically — if you're still seeing this, say "turn on evening check-in" again to repair it.`,
  missing_telegram_user_id: (time) =>
    `Evening check-in was skipped today. Reason: no reachable Telegram chat found for your account. It's on at ${time}. This should be fixed automatically the next time it's due — if it happens again, message the bot once from Telegram and try again.`,
  due_later_today: (time) => `Evening check-in is on and due today around ${time}.`,
  missed_no_record: (time) =>
    `Evening check-in should have sent today around ${time}, but I don't see a sent record. Current status: eligible. Next due: tomorrow ${time}.`,
  duplicate_dedupe_key: (time) => `Evening check-in was sent today at ${time}.`,
  no_candidate: (time) => `Evening check-in is on at ${time}, but there isn't anything grounded to ask about right now (every trackable goal already has today's progress logged) — check back closer to ${time}.`,
  eligible: (time, allowlistActive) =>
    `Settings look eligible — evening check-in is on at ${time}${allowlistActive ? ", and you're in the configured allowlist" : " (no allowlist is configured, so that's not restricting anyone)"}. Check whether the worker process was running at ${time} and whether Telegram delivery failed.`
};

export function formatEveningCheckinDeliveryDiagnosis(
  status: EveningCheckinDeliveryStatus,
  settings: NotificationSettings,
  legacyDailyLoopSentAt?: Date,
  allowlistActive = false,
  v3SentAt?: Date
): string {
  const time =
    status === "legacy_daily_loop_sent_instead" && legacyDailyLoopSentAt
      ? formatMinutesOfDay(minutesOfDayInTimezone(legacyDailyLoopSentAt, settings.timezone))
      : status === "duplicate_dedupe_key" && v3SentAt
        ? formatMinutesOfDay(minutesOfDayInTimezone(v3SentAt, settings.timezone))
        : formatMinutesOfDay(settings.eveningTimeMinutes);

  return EVENING_DIAGNOSIS_MESSAGE[status](time, allowlistActive);
}

export type ProactiveStatusBlockedResult =
  /** Replaces the ENTIRE status line, including the "on, around HH:MM" prefix — used only for
   * delivery_disabled, where saying "on, around 09:00" alongside "delivery disabled" reads as
   * self-contradictory ("on" implying it will actually happen). */
  | { kind: "full_line"; text: string }
  /** Appended after "on, around HH:MM — " — every other blocked reason still legitimately has a
   * real scheduled time worth showing alongside the reason nothing sent. */
  | { kind: "clause"; text: string };

/**
 * fix/private-alpha-proactive-checkins-and-overdue-action-ux (extended by
 * fix/private-alpha-proactive-launch-config-cleanup — task 4, distinguishing "configured on" from
 * "will actually deliver," per a real report that "on — delivery disabled in this environment"
 * still read as fully-on): the compact status line the "automatic messages" summary
 * (proactive.settings_show) shows for a moment the user has ON — distinct from
 * formatProactiveDeliveryDiagnosis/formatEveningCheckinDeliveryDiagnosis above, which answer a
 * DELIBERATE "why didn't X send?" question with a full sentence. Undefined when nothing is
 * actually blocking today's send (the ordinary, common case). Reuses the exact same
 * ProactiveDeliveryStatus/EveningCheckinDeliveryStatus enum getProactiveDeliveryStatus/
 * getEveningCheckinDeliveryStatus already compute, so this can never disagree with the real
 * diagnosis about WHETHER something is blocked — only how it's phrased.
 */
export function proactiveStatusBlockedClause(
  status: ProactiveDeliveryStatus | EveningCheckinDeliveryStatus,
  momentPhrase: "morning brief" | "evening check-in"
): ProactiveStatusBlockedResult | undefined {
  switch (status) {
    case "delivery_disabled":
      return { kind: "full_line", text: "configured on, but delivery is disabled on this server" };
    case "user_not_allowlisted":
      return { kind: "clause", text: "not eligible — not in the allowlist" };
    case "daily_loop_disabled":
      // Should be effectively unreachable for a moment that's actually enabled now that
      // selfHealDailyLoopEnabled runs on every status/eligibility read — kept as a defensive
      // fallback (e.g. the self-heal write itself failing) rather than assumed impossible.
      return { kind: "clause", text: `blocked — internal daily loop is off. Say "turn on ${momentPhrase}" to repair.` };
    case "no_candidate":
      return { kind: "clause", text: "nothing grounded to send yet today" };
    case "legacy_daily_loop_sent_instead":
      return { kind: "clause", text: "today's message came from the legacy daily-loop system instead" };
    case "missing_telegram_user_id":
      return { kind: "clause", text: "no reachable Telegram chat found for your account" };
    default:
      // eligible / outside_..._window / duplicate_dedupe_key / user_not_opted_in — nothing is
      // actually blocking delivery; the caller shows next-due/last-sent instead of a clause.
      return undefined;
  }
}

/** "today 09:00" if the scheduled local time hasn't happened yet today, else "tomorrow 09:00" —
 * the "next due" half of the truthful automatic-messages status line. */
export function nextScheduledMomentLabel(scheduledMinutes: number, now: Date, timezone: string): string {
  const nowMinutes = minutesOfDayInTimezone(now, timezone);
  const time = formatMinutesOfDay(scheduledMinutes);
  return nowMinutes < scheduledMinutes ? `today ${time}` : `tomorrow ${time}`;
}
