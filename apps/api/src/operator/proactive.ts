import type { ActionItem } from "@operator-agent/db";
import type { NotificationSettings } from "@operator-agent/core";
import { GOAL_ANCHOR_NUDGE_REPLY } from "../agent-runtime/runtime.js";
import type { AgentEntity, ContextBundle } from "../agent-runtime/types.js";
import { gmailReviewChatDescription, gmailReviewChatLabel } from "../email-reviews/email-review-service.js";
import { daysBetweenLocalDates, formatDateInTimezone } from "../utils/datetime.js";

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
  /** Optional visible entities a real delivery should persist so the user's next reply can refer to "it" or "the first one." */
  entities?: AgentEntity[];
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
/** Exported so proactive-eligibility.ts's diagnostic status check uses the exact same window. */
export const TIME_TRIGGER_WINDOW_MINUTES = 30;

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

  // Temporal health (fix/private-alpha-action-temporal-coaching): an overdue action gets its own
  // explicit callout, separate from the plain "today I'd focus on" numbered list — burying it in
  // an ordinary-looking list item was the real reported gap (stale "today" wording with nothing
  // ever flagging that today had already passed). Excluded from topActions below so it's never
  // shown twice; still counts toward whether there's anything to lead with at all.
  const overdueActions = context.openActions
    .map((action) => ({ action, health: assessTemporalHealth(action, now, settings.timezone) }))
    .filter((entry): entry is { action: ActionItem; health: Extract<TemporalHealth, { kind: "overdue" }> } => entry.health.kind === "overdue")
    .sort((a, b) => b.health.daysOverdue - a.health.daysOverdue);
  const overdueIds = new Set(overdueActions.map((entry) => entry.action.id));

  const rankedActions = rankOpenActions(context.openActions.filter((action) => !overdueIds.has(action.id)));
  const topActions = rankedActions.slice(0, 3);

  // Deferred actions coming back TODAY (status "snoozed", snoozedUntil is today's local date) —
  // invisible to context.openActions by design (see context-loader.ts), so without this the
  // morning brief would never mention the one thing the user explicitly asked to be reminded
  // about today.
  const todayLocalDate = formatDateInTimezone(now, settings.timezone);
  const deferredReturningToday = context.deferredActions.filter(
    (action) => action.snoozedUntil && formatDateInTimezone(action.snoozedUntil, settings.timezone) === todayLocalDate
  );

  if (topActions.length === 0 && overdueActions.length === 0 && deferredReturningToday.length === 0) {
    // Has goals, but nothing concretely actionable today — nothing grounded to lead with.
    return null;
  }

  const lines = ["Morning."];

  if (overdueActions.length > 0) {
    lines.push(
      ...overdueActions.map((entry) => `Overdue — ${formatTemporalHealthLabel(entry.health)}: "${entry.action.title}".`)
    );
  }
  if (deferredReturningToday.length > 0) {
    lines.push(...deferredReturningToday.map((action) => `Back today, as planned: "${action.title}".`));
  }
  if (topActions.length > 0) {
    lines.push("Today I'd focus on:", ...topActions.map((action, index) => `${index + 1}. ${action.title}.`));
  }

  const deferCandidate = rankedActions.find((action) => action.priority === "low" && !topActions.includes(action));
  if (deferCandidate) {
    lines.push(`Skip "${deferCandidate.title}" today — low priority.`);
  }

  // Repeated postponement pattern (fix/private-alpha-action-temporal-coaching) — a light,
  // observational mention, not a lecture; the per-move coaching question already lives on
  // action.snooze's own reply (executor.ts), this is only ever a summary note for the morning.
  const repeatedlyMoved = [...context.openActions, ...context.deferredActions].filter((action) => action.postponeCount >= 2);
  if (repeatedlyMoved.length > 0) {
    const first = repeatedlyMoved[0]!;
    lines.push(`"${first.title}" has been moved ${first.postponeCount} times — worth shrinking it or deciding it's not happening.`);
  }

  // Goal Evidence Loop MVP (docs/10-v3-readiness-audit.md §20) — generic across every goal
  // category, not job-search-specific: a pending Gmail review counts here only when its OWN rule
  // is linked (EmailSignalRule.goalId) to one of the user's real active goals, exactly the same
  // linkage goal.status uses. A recruiter email waiting on a job-search goal and an Endesa
  // invoice waiting on a bills goal are surfaced by the identical code path.
  const goalLinkedRuleIds = new Set(
    context.gmailRules.filter((rule) => rule.goalId && context.activeGoals.some((goal) => goal.id === rule.goalId)).map((rule) => rule.id)
  );
  const goalLinkedReviews = context.gmailReviews.filter((review) => goalLinkedRuleIds.has(review.ruleId));
  if (goalLinkedReviews.length > 0) {
    const label = gmailReviewChatLabel(goalLinkedReviews[0], context.gmailRules);
    lines.push(
      `You also have ${goalLinkedReviews.length} email review${goalLinkedReviews.length === 1 ? "" : "s"} waiting on a goal you're tracking — "${label}" — handle that before other things.`
    );
  }

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
    reasons: [
      ...overdueActions.map((entry) => `overdue action: "${entry.action.title}" (${formatTemporalHealthLabel(entry.health)})`),
      ...deferredReturningToday.map((action) => `deferred action returning today: "${action.title}"`),
      ...topActions.map((action) => `open action: "${action.title}" (${action.priority})`)
    ],
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

  // fix/private-alpha-action-temporal-coaching: an action due TODAY that's still open by evening
  // check-in time is exactly the "plan didn't match execution" case the task asked for — the
  // evening check-in previously only ever looked at goal evidence signals, never at whether the
  // day's own actions actually got done. Deliberately dueAt-based, not overdue-by-days (that's
  // the morning brief's job) — "still open, was due today" is itself already the honest fact
  // worth surfacing at this specific moment.
  const missedDueTodayActions = context.openActions
    .filter((action) => action.dueAt && formatDateInTimezone(action.dueAt, settings.timezone) === todayLocalDate)
    .slice(0, 2);

  if (untrackedGoals.length === 0 && missedDueTodayActions.length === 0) {
    return null;
  }

  const parts: string[] = [];
  if (missedDueTodayActions.length > 0) {
    const names = missedDueTodayActions.map((action) => `"${action.title}"`).join(" and ");
    parts.push(
      `${names} ${missedDueTodayActions.length === 1 ? "was" : "were"} due today and still open — want to shrink it, move it to tomorrow, or archive it if it's not happening?`
    );
  }
  if (untrackedGoals.length > 0) {
    const goalPhrases = untrackedGoals.map((goal) => goal.title.toLowerCase());
    parts.push(`Did you make progress on ${joinNaturally(goalPhrases)} today? Reply naturally — "gym 45m and sent 2 CVs" is enough.`);
  }
  const message = `Evening check-in: ${parts.join(" ")}`;

  return {
    decision: "proposed_message",
    type: "evening_checkin",
    title: "Evening check-in",
    message,
    reasons: [
      ...missedDueTodayActions.map((action) => `still-open action due today: "${action.title}"`),
      ...untrackedGoals.map((goal) => `no tracked signal logged today for goal: "${goal.title}"`)
    ],
    suggestedReplies: missedDueTodayActions.length > 0 ? ["move it to tomorrow", "archive it", "gym 45m and sent 2 CVs"] : ["gym 45m and sent 2 CVs", "nothing today"],
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
    entities: [{ type: "gmail_review", id: review.id, label, index: 1 }],
    priority: 3,
    safeToSend: true
  };
}

/** Exported so goal.recommend_next_action (agent-runtime/executor.ts) can rank a goal's own open
 * actions the exact same way the morning brief already does — one ranking rule, not a second one
 * that could drift out of sync. */
export function rankOpenActions(actions: ActionItem[]): ActionItem[] {
  const priorityRank: Record<ActionItem["priority"], number> = { high: 0, medium: 1, low: 2 };
  return [...actions].sort((a, b) => {
    const rankDiff = priorityRank[a.priority] - priorityRank[b.priority];
    if (rankDiff !== 0) return rankDiff;
    const aDue = a.dueAt?.getTime() ?? Number.POSITIVE_INFINITY;
    const bDue = b.dueAt?.getTime() ?? Number.POSITIVE_INFINITY;
    return aDue - bDue;
  });
}

/**
 * Temporal health (fix/private-alpha-action-temporal-coaching): status alone doesn't say whether
 * an open action is fine, overdue, or has just been sitting untouched — this is the single
 * source of truth for that judgment, exported so action.list's per-item line, goal.recommend_
 * next_action, the morning brief, and the evening check-in (agent-runtime/executor.ts and this
 * file) always agree on what counts as overdue/stale rather than each guessing independently —
 * same reasoning as rankOpenActions living here.
 */
export type TemporalHealth =
  | { kind: "on_track" }
  | { kind: "overdue"; daysOverdue: number }
  | { kind: "stale"; daysSitting: number };

const STALE_THRESHOLD_DAYS = 3;

export function assessTemporalHealth(action: ActionItem, now: Date, timezone: string): TemporalHealth {
  if (action.status !== "open") {
    return { kind: "on_track" };
  }
  const todayLocal = formatDateInTimezone(now, timezone);
  if (action.dueAt) {
    if (action.dueAt >= now) {
      return { kind: "on_track" };
    }
    const dueLocal = formatDateInTimezone(action.dueAt, timezone);
    // A same-day-but-earlier-time due date (due today 09:00, now 14:00) is technically already
    // past, but "overdue by 0 days" reads oddly — still today, so still on_track for THIS
    // purpose; formatDueLabelForChat's own "due today HH:mm" already says enough.
    const daysOverdue = daysBetweenLocalDates(dueLocal, todayLocal);
    return daysOverdue > 0 ? { kind: "overdue", daysOverdue } : { kind: "on_track" };
  }
  // No dueAt at all — never "overdue" (nothing to be overdue AGAINST), only ever "stale," and
  // only past a real threshold; a two-day-old undated action is completely normal.
  const createdLocal = formatDateInTimezone(action.createdAt, timezone);
  const daysSitting = daysBetweenLocalDates(createdLocal, todayLocal);
  return daysSitting >= STALE_THRESHOLD_DAYS ? { kind: "stale", daysSitting } : { kind: "on_track" };
}

/** "overdue since yesterday" / "overdue by 4 days" / "sitting for 3 days" — never "overdue" for
 * a stale (no-dueAt) action, per the explicit product rule: staleness is a real but WEAKER,
 * different signal than a missed real due date, and conflating the two words would overclaim
 * what Alecto actually knows for an action that was never given a due date in the first place. */
export function formatTemporalHealthLabel(health: TemporalHealth): string | undefined {
  if (health.kind === "overdue") {
    return health.daysOverdue === 1 ? "overdue since yesterday" : `overdue by ${health.daysOverdue} days`;
  }
  if (health.kind === "stale") {
    return `sitting for ${health.daysSitting} days`;
  }
  return undefined;
}

/** Exported so proactive-eligibility.ts's diagnostic status check uses the exact same time math the decision module itself uses — no separate reimplementation to drift out of sync. */
export function minutesOfDayInTimezone(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

/** Exported for the same reason as minutesOfDayInTimezone above. */
export function isWithinWindow(nowMinutes: number, targetMinutes: number, windowMinutes: number): boolean {
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
