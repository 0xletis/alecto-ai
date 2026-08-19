import type { ActionItem } from "@operator-agent/db";
import type { NotificationSettings } from "@operator-agent/core";
import { GOAL_ANCHOR_NUDGE_REPLY } from "../agent-runtime/runtime.js";
import type { ContextBundle } from "../agent-runtime/types.js";
import { gmailReviewChatDescription, gmailReviewChatLabel } from "../email-reviews/email-review-service.js";
import { formatDateInTimezone } from "../utils/datetime.js";

/**
 * V3 Proactive Operator MVP — a pure, callable decision layer, deliberately NOT wired to
 * automatic sending yet (see docs/10-v3-readiness-audit.md §13). "Pure" means: this module never
 * reads the DB and never sends anything itself — its only inputs are an already-loaded
 * ContextBundle (the exact same shape agent-runtime/context-loader.ts builds for a normal chat
 * turn), the user's NotificationSettings, the current time, and which dedupe keys/how many
 * proactive sends have already happened today (both computed by the CALLER via the existing,
 * unmodified NotificationLog primitives — see apps/api/src/server.ts's preview route). This
 * keeps the decision logic trivially unit-testable with no DB mocking, and keeps this module
 * from duplicating apps/worker's own scheduling loop or NotificationLog dedup mechanism.
 *
 * Three initial proactive moments, in priority order when more than one is simultaneously
 * eligible: morning_brief (1), evening_checkin (2), gmail_nudge (3). At most one is returned per
 * call — the caller decides how often to call this (once per scheduler tick, or on demand for
 * preview).
 */

export type ProactiveMessageType = "morning_brief" | "evening_checkin" | "gmail_nudge";

export interface ProactiveMessageProposal {
  decision: "proposed_message";
  type: ProactiveMessageType;
  title: string;
  message: string;
  /** Grounded, internal facts this message is based on — for logging/debugging, not shown to the user. */
  reasons: string[];
  suggestedReplies: string[];
  /** Passed to NotificationLog as `type` — stable per moment (or per specific item, for gmail_nudge) so a repeat check is a single hasNotificationLog lookup. */
  dedupeKey: string;
  /** Lower is more important; used to pick one when multiple moments are eligible at once. */
  priority: number;
  safeToSend: boolean;
}

export interface NoProactiveMessage {
  decision: "no_message";
  reason: string;
}

export type ProactiveDecision = ProactiveMessageProposal | NoProactiveMessage;

export interface ProactiveDecisionInput {
  context: ContextBundle;
  notificationSettings: NotificationSettings;
  now: Date;
  /** Dedupe keys (MORNING_BRIEF_DEDUPE_KEY, EVENING_CHECKIN_DEDUPE_KEY, gmailNudgeDedupeKey(reviewId)) already sent today, per NotificationLog. */
  alreadySentDedupeKeys: Set<string>;
  /** How many proactive messages of any kind have already gone out today — enforces the 1-3/day cap. */
  sentCountToday: number;
}

export const MORNING_BRIEF_DEDUPE_KEY = "v3_morning_brief";
export const EVENING_CHECKIN_DEDUPE_KEY = "v3_evening_checkin";

export function gmailNudgeDedupeKey(reviewId: string): string {
  return `v3_gmail_nudge:${reviewId}`;
}

const MAX_PROACTIVE_MESSAGES_PER_DAY = 3;
const TIME_TRIGGER_WINDOW_MINUTES = 30;

export function decideProactiveOperatorMessage(input: ProactiveDecisionInput): ProactiveDecision {
  const { context, notificationSettings, now, alreadySentDedupeKeys, sentCountToday } = input;

  // Respects daily-loop settings as the quiet-hours proxy: no dedicated quiet-hours field exists
  // yet (confirmed during this task's infra mapping), so a user who has turned their daily loop
  // off has explicitly said "don't nudge me" — the clearest available signal.
  if (!notificationSettings.dailyLoopEnabled) {
    return { decision: "no_message", reason: "daily_loop_disabled" };
  }

  if (sentCountToday >= MAX_PROACTIVE_MESSAGES_PER_DAY) {
    return { decision: "no_message", reason: "daily_max_reached" };
  }

  const nowMinutes = minutesOfDayInTimezone(now, notificationSettings.timezone);

  const candidates = [
    buildMorningBrief(context, notificationSettings, now, nowMinutes, alreadySentDedupeKeys),
    buildEveningCheckin(context, notificationSettings, now, nowMinutes, alreadySentDedupeKeys),
    buildGmailNudge(context, notificationSettings, nowMinutes, alreadySentDedupeKeys)
  ].filter((candidate): candidate is ProactiveMessageProposal => candidate !== null);

  if (candidates.length === 0) {
    return { decision: "no_message", reason: "no_eligible_candidate" };
  }

  candidates.sort((a, b) => a.priority - b.priority);
  return candidates[0];
}

function buildMorningBrief(
  context: ContextBundle,
  settings: NotificationSettings,
  now: Date,
  nowMinutes: number,
  alreadySent: Set<string>
): ProactiveMessageProposal | null {
  if (alreadySent.has(MORNING_BRIEF_DEDUPE_KEY)) {
    return null;
  }
  if (!isWithinWindow(nowMinutes, settings.morningTimeMinutes, TIME_TRIGGER_WINDOW_MINUTES)) {
    return null;
  }

  if (context.activeGoals.length === 0 && context.openActions.length === 0) {
    return {
      decision: "proposed_message",
      type: "morning_brief",
      title: "Morning",
      message: GOAL_ANCHOR_NUDGE_REPLY,
      reasons: ["no active goals or open actions — using the goal-anchor nudge instead of an empty brief"],
      suggestedReplies: ["tell me what you want to work on"],
      dedupeKey: MORNING_BRIEF_DEDUPE_KEY,
      priority: 1,
      safeToSend: true
    };
  }

  const rankedActions = rankOpenActions(context.openActions);
  const topActions = rankedActions.slice(0, 3);

  if (topActions.length === 0) {
    // Has goals, but nothing concretely actionable today — nothing grounded to lead with.
    return null;
  }

  const lines = ["Morning. Today I'd focus on:", ...topActions.map((action, index) => `${index + 1}. ${action.title}.`)];

  const deferCandidate = rankedActions.find((action) => action.priority === "low" && !topActions.includes(action));
  if (deferCandidate) {
    lines.push(`Skip "${deferCandidate.title}" today — low priority.`);
  }

  const todayLocalDate = formatDateInTimezone(now, settings.timezone);
  const riskToday = context.memories.find((memory) => memory.type === "risk_pattern" && formatDateInTimezone(memory.createdAt, settings.timezone) === todayLocalDate);
  if (riskToday) {
    lines.push(`Watch out: ${riskToday.summary}`);
  }

  lines.push("Reply naturally if you want to change the plan.");

  return {
    decision: "proposed_message",
    type: "morning_brief",
    title: "Morning brief",
    message: lines.join("\n"),
    reasons: topActions.map((action) => `open action: "${action.title}" (${action.priority})`),
    suggestedReplies: ["mark 1 done", "move 2 to tomorrow"],
    dedupeKey: MORNING_BRIEF_DEDUPE_KEY,
    priority: 1,
    safeToSend: true
  };
}

function buildEveningCheckin(
  context: ContextBundle,
  settings: NotificationSettings,
  now: Date,
  nowMinutes: number,
  alreadySent: Set<string>
): ProactiveMessageProposal | null {
  if (alreadySent.has(EVENING_CHECKIN_DEDUPE_KEY)) {
    return null;
  }
  if (!isWithinWindow(nowMinutes, settings.eveningTimeMinutes, TIME_TRIGGER_WINDOW_MINUTES)) {
    return null;
  }

  const todayLocalDate = formatDateInTimezone(now, settings.timezone);
  const loggedEventTypesToday = new Set<string>(
    context.recentEvents.filter((event) => formatDateInTimezone(event.timestamp, settings.timezone) === todayLocalDate).map((event) => event.type)
  );

  // Only goals with at least one trackable metric (a real eventType to check against) are
  // eligible — never guessing which goals are "trackable" from title text alone.
  const untrackedGoals = context.activeGoals
    .filter((goal) => {
      const trackableMetrics = (goal.targetMetrics ?? []).filter((metric) => metric.eventType);
      return trackableMetrics.length > 0 && trackableMetrics.every((metric) => !loggedEventTypesToday.has(metric.eventType!));
    })
    .slice(0, 2);

  if (untrackedGoals.length === 0) {
    return null;
  }

  const goalPhrases = untrackedGoals.map((goal) => goal.title.toLowerCase());
  const message = `Quick check-in: did you make progress on ${joinNaturally(goalPhrases)} today? Reply naturally — "gym 45m and sent 2 CVs" is enough.`;

  return {
    decision: "proposed_message",
    type: "evening_checkin",
    title: "Evening check-in",
    message,
    reasons: untrackedGoals.map((goal) => `no tracked signal logged today for goal: "${goal.title}"`),
    suggestedReplies: ["gym 45m and sent 2 CVs", "nothing today"],
    dedupeKey: EVENING_CHECKIN_DEDUPE_KEY,
    priority: 2,
    safeToSend: true
  };
}

function buildGmailNudge(context: ContextBundle, settings: NotificationSettings, nowMinutes: number, alreadySent: Set<string>): ProactiveMessageProposal | null {
  if (context.gmailReviews.length === 0) {
    return null;
  }
  // No dedicated quiet-hours field exists — the user's own configured day-bounds (morning to
  // evening time) are the best available proxy so this never fires overnight.
  if (!isBetween(nowMinutes, settings.morningTimeMinutes, settings.eveningTimeMinutes)) {
    return null;
  }

  const review = context.gmailReviews[0];
  const dedupeKey = gmailNudgeDedupeKey(review.id);
  if (alreadySent.has(dedupeKey)) {
    return null;
  }

  const label = gmailReviewChatLabel(review, context.gmailRules);
  const description = gmailReviewChatDescription(review);
  const message = `One email looks actionable: ${label}${description ? ` — ${description}` : ""}. Want me to turn it into a task?`;

  return {
    decision: "proposed_message",
    type: "gmail_nudge",
    title: "Gmail review",
    message,
    reasons: [`pending gmail review: "${label}"`],
    suggestedReplies: ["turn it into a task", "ignore it"],
    dedupeKey,
    priority: 3,
    safeToSend: true
  };
}

function rankOpenActions(actions: ActionItem[]): ActionItem[] {
  const priorityRank: Record<ActionItem["priority"], number> = { high: 0, medium: 1, low: 2 };
  return [...actions].sort((a, b) => {
    const rankDiff = priorityRank[a.priority] - priorityRank[b.priority];
    if (rankDiff !== 0) return rankDiff;
    const aDue = a.dueAt?.getTime() ?? Number.POSITIVE_INFINITY;
    const bDue = b.dueAt?.getTime() ?? Number.POSITIVE_INFINITY;
    return aDue - bDue;
  });
}

function minutesOfDayInTimezone(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

function isWithinWindow(nowMinutes: number, targetMinutes: number, windowMinutes: number): boolean {
  return Math.abs(nowMinutes - targetMinutes) <= windowMinutes;
}

function isBetween(nowMinutes: number, startMinutes: number, endMinutes: number): boolean {
  if (startMinutes <= endMinutes) {
    return nowMinutes >= startMinutes && nowMinutes <= endMinutes;
  }
  // Handles a user whose configured evening time is technically "before" their morning time
  // (e.g. an evening time past midnight) by wrapping across the day boundary.
  return nowMinutes >= startMinutes || nowMinutes <= endMinutes;
}

function joinNaturally(items: string[]): string {
  if (items.length <= 1) {
    return items.join("");
  }
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}
