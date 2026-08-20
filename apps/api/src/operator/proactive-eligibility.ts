import type { NotificationSettings } from "@operator-agent/core";
import type { ContextBundle } from "../agent-runtime/types.js";
import { formatMinutesOfDay } from "./daily-loop-settings.js";
import {
  decideProactiveOperatorMessage,
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
 * "missing_allowlist" is kept in the type for the vocabulary this diagnostic tool is expected to
 * support, but is not currently reachable: an unset PROACTIVE_OPERATOR_ALLOWLIST means "open to
 * every user" (established, tested behavior since the delivery pass) — genuinely non-blocking,
 * not something to report as a problem. Only an allowlist that's SET but excludes this user
 * (user_not_allowlisted) is ever actually a blocker.
 */
export type ProactiveDeliveryStatus =
  | "legacy_daily_loop_sent_instead"
  | "delivery_disabled"
  | "missing_allowlist"
  | "user_not_allowlisted"
  | "user_not_opted_in"
  | "daily_loop_disabled"
  | "outside_morning_window"
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

  const nowMinutes = minutesOfDayInTimezone(input.now, settings.timezone);
  if (!isWithinWindow(nowMinutes, settings.morningTimeMinutes, TIME_TRIGGER_WINDOW_MINUTES)) {
    return "outside_morning_window";
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

const DIAGNOSIS_MESSAGE: Record<ProactiveDeliveryStatus, (time: string) => string> = {
  legacy_daily_loop_sent_instead: (time) =>
    `You did get a morning message today around ${time} — but it came from the older legacy daily-loop system, not the V3 proactive morning brief you're asking about. Real V3 delivery is still a developer rollout control most users aren't on yet; ask "what proactive messages are on?" to check your V3 opt-in and scheduled time.`,
  delivery_disabled: (time) => `Morning brief is on at ${time}, but delivery is blocked because PROACTIVE_OPERATOR_DELIVERY_ENABLED is off in this environment.`,
  missing_allowlist: (time) => `Morning brief is on at ${time}, but no PROACTIVE_OPERATOR_ALLOWLIST is configured in this environment.`,
  user_not_allowlisted: (time) => `Morning brief is on at ${time}, but this user is not in PROACTIVE_OPERATOR_ALLOWLIST.`,
  user_not_opted_in: () => "Morning brief is currently off — turn it on and I'll start sending it.",
  daily_loop_disabled: (time) => `Morning brief is on at ${time}, but the daily loop itself is off, which blocks both the V3 morning brief and the legacy daily-loop message — turn the daily loop back on too.`,
  outside_morning_window: (time) => `Morning brief is on at ${time} — it's not that time yet (or it already passed for today), so nothing should have sent.`,
  duplicate_dedupe_key: (time) => `Morning brief is on at ${time}, and it looks like it already sent today — I won't send a duplicate.`,
  no_candidate: (time) => `Morning brief is on at ${time}, but there isn't anything grounded to send right now (e.g. no active goals or open actions) — check back closer to ${time}.`,
  eligible: (time) => `Settings look eligible — morning brief is on at ${time}. Check whether the worker process was running at ${time} and whether Telegram delivery failed.`
};

export function formatProactiveDeliveryDiagnosis(status: ProactiveDeliveryStatus, settings: NotificationSettings, legacyDailyLoopSentAt?: Date): string {
  // legacy_daily_loop_sent_instead reports the message's REAL sentAt, not the user's current
  // morningTimeMinutes — the legacy send can be from earlier today, before the scheduled time was
  // last changed, and reusing the current setting here would misstate when it actually went out.
  const time =
    status === "legacy_daily_loop_sent_instead" && legacyDailyLoopSentAt
      ? formatMinutesOfDay(minutesOfDayInTimezone(legacyDailyLoopSentAt, settings.timezone))
      : formatMinutesOfDay(settings.morningTimeMinutes);

  return DIAGNOSIS_MESSAGE[status](time);
}
