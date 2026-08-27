import type { ActionItem, EmailReviewItem } from "@operator-agent/db";
import type { NotificationSettings, StoredEvent } from "@operator-agent/core";
import { GOAL_ANCHOR_NUDGE_REPLY } from "../agent-runtime/runtime.js";
import type { AgentEntity, ContextBundle } from "../agent-runtime/types.js";
import { resolveActiveGoalIdsForGmailRule } from "../conversation/gmail-autonomy.js";
import {
  extractSafeSenderLabel,
  gmailReviewChatDescription,
  gmailReviewChatLabel,
  isHighPriorityGmailReview
} from "../email-reviews/email-review-service.js";
import { daysBetweenLocalDates, formatDateInTimezone } from "../utils/datetime.js";
import { truncatePlainText } from "../utils/text.js";

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

  // fix/private-alpha-gmail-proactive-highsignal-and-goal-association: computed early, before
  // either "nothing else to report" early-return below, so a fresh user with an active goal but
  // zero open actions still hears about a real recruiter reply/offer/pending review — a Gmail
  // signal is its own reason to send, not something only ever appended to an action-shaped brief.
  const goalLinkedRuleIds = new Set(
    context.gmailRules.filter((rule) => resolveActiveGoalIdsForGmailRule(rule, context.activeGoals).size > 0).map((rule) => rule.id)
  );
  const goalLinkedReviews = context.gmailReviews.filter((review) => goalLinkedRuleIds.has(review.ruleId));
  const gmailLines = describeGmailSignalsForBrief(goalLinkedReviews, recentGoalLinkedGmailEvents(context, goalLinkedRuleIds, now));

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

  if (topActions.length === 0 && overdueActions.length === 0 && deferredReturningToday.length === 0 && gmailLines.length === 0) {
    // fix/private-alpha-proactive-checkins-and-overdue-action-ux: reaching here means the goal-
    // anchor branch above already ruled out "zero goals AND zero actions" — so there's always at
    // least one real active goal at this point, just nothing action-shaped scheduled for today
    // yet. A real audit found this used to silently skip the morning brief entirely in that case
    // ("no_eligible_candidate"), even though the product requirement is that having an active
    // goal alone is enough to send — never auto-creates an action, just names the real goal(s)
    // and asks what to focus on, exactly like the goal-anchor nudge does for the no-goal case.
    const goalTitles = context.activeGoals.map((goal) => `"${goal.title}"`).join(", ");
    return {
      decision: "proposed_message",
      type: "morning_brief",
      title: "Morning brief",
      message: `Morning. Active goal${context.activeGoals.length === 1 ? "" : "s"}: ${goalTitles}. Nothing scheduled for today yet — what do you want to focus on?`,
      reasons: context.activeGoals.map((goal) => `active goal, no open/overdue/deferred actions yet: "${goal.title}"`),
      suggestedReplies: ["create a task for today"],
      dedupeKey: MORNING_BRIEF_DEDUPE_KEY,
      priority: 1,
      safeToSend: true
    };
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
  // category, not job-search-specific: goalLinkedReviews/gmailLines were computed above (before
  // the two early-returns) precisely so a Gmail signal can be a real reason to send even when
  // there's nothing action-shaped to report — see the comment up there for the full rationale.
  lines.push(...gmailLines);

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
      ...topActions.map((action) => `open action: "${action.title}" (${action.priority})`),
      ...(goalLinkedReviews.length > 0 ? [`${goalLinkedReviews.length} pending goal-linked gmail review(s)`] : [])
    ],
    suggestedReplies: ["mark 1 done", "move 2 to tomorrow"],
    dedupeKey: MORNING_BRIEF_DEDUPE_KEY,
    priority: 1,
    safeToSend: true
  };
}

/** fix/private-alpha-gmail-proactive-highsignal-and-goal-association: a goal-linked Gmail event is
 * only "new" for proactive purposes within a rolling day — recentEvents (context) is the 10 most
 * recent events overall with no built-in time window, so an event from a week ago would otherwise
 * be re-described every single morning forever. No persisted "already mentioned" state is needed
 * for events specifically: this window IS the dedupe, since a stale event simply ages out of it. */
const RECENT_GMAIL_EVENT_WINDOW_MS = 24 * 60 * 60 * 1000;

function recentGoalLinkedGmailEvents(context: ContextBundle, goalLinkedRuleIds: Set<string>, now: Date): StoredEvent[] {
  const cutoff = now.getTime() - RECENT_GMAIL_EVENT_WINDOW_MS;
  return context.recentEvents.filter((event) => {
    if (event.source !== "gmail" || event.timestamp.getTime() < cutoff) {
      return false;
    }
    const ruleId = typeof event.data.ruleId === "string" ? event.data.ruleId : undefined;
    return ruleId ? goalLinkedRuleIds.has(ruleId) : false;
  });
}

function gmailEventFromLabel(event: StoredEvent): string | undefined {
  const from = typeof event.data.from === "string" ? event.data.from : undefined;
  return from ? extractSafeSenderLabel(from) : undefined;
}

function gmailEventSubjectLabel(event: StoredEvent): string | undefined {
  return typeof event.data.subject === "string" ? truncatePlainText(event.data.subject, 80) : undefined;
}

/**
 * Shared by the morning brief and evening check-in so both describe the exact same goal-linked
 * Gmail signals the exact same way — never two different phrasings of "a recruiter replied"
 * depending on which proactive moment happens to be reporting it. Offer/interview reviews (forced
 * to review regardless of confidence — see server.ts's syncEmailSignalRule) get their own
 * high-priority line; every other pending review is a single honest count; already-logged
 * recruiter-reply/confirmation/rejection events get one calm line each, never dramatized.
 */
function describeGmailSignalsForBrief(goalLinkedReviews: EmailReviewItem[], goalLinkedEvents: StoredEvent[]): string[] {
  const lines: string[] = [];
  const highPriorityReviews = goalLinkedReviews.filter(isHighPriorityGmailReview);
  const normalReviews = goalLinkedReviews.filter((review) => !isHighPriorityGmailReview(review));

  for (const review of highPriorityReviews) {
    const signalLabel = review.proposedEventType === "career.offer_received" ? "possible offer" : "an interview email";
    const sender = review.from ? extractSafeSenderLabel(review.from) : undefined;
    lines.push(`High-priority Gmail signal: ${signalLabel}${sender ? ` from ${sender}` : ""}. Review it today.`);
  }

  if (normalReviews.length > 0) {
    lines.push(
      normalReviews.length === 1 ? "1 Gmail item needs review before I log it." : `${normalReviews.length} Gmail items need review before I log them.`
    );
  }

  const latestEventByType = new Map<string, StoredEvent>();
  for (const event of goalLinkedEvents) {
    const existing = latestEventByType.get(event.type);
    if (!existing || event.timestamp > existing.timestamp) {
      latestEventByType.set(event.type, event);
    }
  }

  const recruiterEvent = latestEventByType.get("career.recruiter_reply_received");
  if (recruiterEvent) {
    const sender = gmailEventFromLabel(recruiterEvent);
    const subject = gmailEventSubjectLabel(recruiterEvent);
    lines.push(`New Gmail signal: recruiter reply${sender ? ` from ${sender}` : ""}${subject ? ` about "${subject}"` : ""}. Review/follow up today.`);
  }

  const confirmationEvent = latestEventByType.get("career.application_confirmation_received");
  if (confirmationEvent) {
    const sender = gmailEventFromLabel(confirmationEvent);
    const subject = gmailEventSubjectLabel(confirmationEvent);
    lines.push(`Gmail: application confirmation${sender ? ` from ${sender}` : ""}${subject ? ` for "${subject}"` : ""}.`);
  }

  const rejectionEvent = latestEventByType.get("career.rejection_received");
  if (rejectionEvent) {
    // Never dramatized — a factual note, not coaching (that's what "what should I do next" is for).
    const sender = gmailEventFromLabel(rejectionEvent);
    lines.push(`Gmail: a rejection came in${sender ? ` from ${sender}` : ""}. Onward to the next one.`);
  }

  return lines;
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

  // fix/private-alpha-proactive-checkins-and-overdue-action-ux: untrackedGoals only ever includes
  // a goal that HAS a trackable metric (a real eventType) AND wasn't logged today — a goal with NO
  // trackable metrics at all (e.g. a fresh custom goal with no configured signals yet) was
  // silently excluded from BOTH untrackedGoals (no metrics to be "untracked") and this fallback,
  // sending nothing at all even though it's the user's only active goal. Deliberately distinct
  // from "this goal's metrics were already logged today" (untrackedGoals correctly excludes that
  // case too, but it must still mean "no_message" — the goal already has an honest answer for
  // today, nagging again would be exactly the "does not nag" behavior this module is tested for).
  const goalsWithNoTrackableMetric = context.activeGoals.filter((goal) => (goal.targetMetrics ?? []).filter((metric) => metric.eventType).length === 0);

  // fix/private-alpha-gmail-proactive-highsignal-and-goal-association: goal-linked Gmail signals
  // are their own real reason for an evening check-in to exist — a recruiter reply that came in
  // this afternoon, or a still-pending review, is exactly the kind of thing "what happened today"
  // should mention, even on a day with no other action/goal-tracking gap to report. Events are
  // scoped to TODAY specifically (not the rolling 24h window the morning brief uses) since this is
  // literally "what did Gmail find today"; pending reviews aren't day-scoped — they stay relevant
  // however many days they've been sitting, same as the morning brief.
  const goalLinkedRuleIds = new Set(
    context.gmailRules.filter((rule) => resolveActiveGoalIdsForGmailRule(rule, context.activeGoals).size > 0).map((rule) => rule.id)
  );
  const goalLinkedReviews = context.gmailReviews.filter((review) => goalLinkedRuleIds.has(review.ruleId));
  const goalLinkedEventsToday = context.recentEvents.filter((event) => {
    if (event.source !== "gmail" || formatDateInTimezone(event.timestamp, settings.timezone) !== todayLocalDate) {
      return false;
    }
    const ruleId = typeof event.data.ruleId === "string" ? event.data.ruleId : undefined;
    return ruleId ? goalLinkedRuleIds.has(ruleId) : false;
  });
  const gmailLines = describeGmailSignalsForBrief(goalLinkedReviews, goalLinkedEventsToday);

  if (untrackedGoals.length === 0 && missedDueTodayActions.length === 0 && gmailLines.length === 0) {
    if (goalsWithNoTrackableMetric.length === 0) {
      // Either no active goals at all, or every active goal already has a trackable metric that
      // was logged today — genuinely nothing to ask about, not a case this fallback should cover.
      return null;
    }
    const goalPhrases = goalsWithNoTrackableMetric.map((goal) => goal.title.toLowerCase());
    return {
      decision: "proposed_message",
      type: "evening_checkin",
      title: "Evening check-in",
      message: `Evening check-in: Did you make progress on ${joinNaturally(goalPhrases)} today? Reply naturally — "gym 45m and sent 2 CVs" is enough.`,
      reasons: goalsWithNoTrackableMetric.map((goal) => `active goal, no trackable metric configured: "${goal.title}"`),
      suggestedReplies: ["gym 45m and sent 2 CVs", "nothing today"],
      dedupeKey: EVENING_CHECKIN_DEDUPE_KEY,
      priority: 2,
      safeToSend: true
    };
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
  parts.push(...gmailLines);
  const message = `Evening check-in: ${parts.join(" ")}`;

  return {
    decision: "proposed_message",
    type: "evening_checkin",
    title: "Evening check-in",
    message,
    reasons: [
      ...missedDueTodayActions.map((action) => `still-open action due today: "${action.title}"`),
      ...untrackedGoals.map((goal) => `no tracked signal logged today for goal: "${goal.title}"`),
      ...goalLinkedEventsToday.map((event) => `gmail event logged today: ${event.type}`),
      ...(goalLinkedReviews.length > 0 ? [`${goalLinkedReviews.length} pending goal-linked gmail review(s)`] : [])
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

  // fix/private-alpha-gmail-generic-signal-engine: a rule explicitly marked "silent"
  // (EmailSignalRule.notifyPolicy) never nudges at all, regardless of priority — an explicit,
  // per-rule opt-out, additive on top of the pre-existing behavior below. Every other rule
  // (including the "review_only" default any brand-new custom rule gets) stays exactly as
  // eligible as it always was — notifyPolicy intentionally does NOT restrict the plain fallback
  // any further than that, since a user who explicitly created a tracking rule at all has already
  // opted into knowing about its matches; requiring a SECOND opt-in per rule would silently break
  // that expectation for every existing custom rule (Endesa bills, apartment viewings, etc.).
  const nudgeEligibleReviews = context.gmailReviews.filter((review) => {
    const rule = context.gmailRules.find((candidate) => candidate.id === review.ruleId);
    return rule?.notifyPolicy !== "silent";
  });
  if (nudgeEligibleReviews.length === 0) {
    return null;
  }

  // fix/private-alpha-gmail-proactive-highsignal-and-goal-association (generalized in fix/private-
  // alpha-gmail-generic-signal-engine): a high-priority signal — now ANY rule's, not just
  // career.offer_received/career.interview_scheduled — must not sit buried behind an older,
  // lower-stakes pending review just because it arrived first. This is also what lets a broad
  // "important admin emails" rule surface a real flight cancellation promptly: the classifier
  // marks that match high priority, so it wins the slot below over an older, ordinary review from
  // some other rule.
  const highPriorityReview = nudgeEligibleReviews.find(isHighPriorityGmailReview);
  const review = highPriorityReview ?? nudgeEligibleReviews[0];
  const dedupeKey = gmailNudgeDedupeKey(review.id);
  if (alreadySent.has(dedupeKey)) {
    return null;
  }

  const label = gmailReviewChatLabel(review, context.gmailRules);
  const description = gmailReviewChatDescription(review);
  const message = isHighPriorityGmailReview(review)
    ? `High-priority Gmail signal: ${gmailNudgeHighPriorityKind(review)} — ${label}${description ? ` — ${description}` : ""}. Review it today.`
    : `One email looks actionable: ${label}${description ? ` — ${description}` : ""}. Want me to turn it into a task?`;

  return {
    decision: "proposed_message",
    type: "gmail_nudge",
    title: "Gmail review",
    message,
    reasons: [`pending gmail review: "${label}"${isHighPriorityGmailReview(review) ? " (high priority)" : ""}`],
    suggestedReplies: isHighPriorityGmailReview(review) ? ["show me the details", "approve it"] : ["turn it into a task", "ignore it"],
    dedupeKey,
    entities: [{ type: "gmail_review", id: review.id, label, index: 1 }],
    priority: 3,
    safeToSend: true
  };
}

/**
 * fix/private-alpha-gmail-generic-signal-engine: generalizes what used to be a literal
 * career.offer_received/career.interview_scheduled ternary — any high-priority review now needs a
 * short, human phrase to lead the nudge with. Prefers the classifier's own `signalKind` (e.g.
 * "flight_cancellation" -> "flight cancellation") when the generic rule-matcher supplied one,
 * falls back to the two original career-specific phrasings for backward compatibility, and a
 * generic phrase otherwise — never a raw internal key.
 */
function gmailNudgeHighPriorityKind(review: Pick<EmailReviewItem, "proposedEventType" | "extracted">): string {
  if (review.proposedEventType === "career.offer_received") {
    return "possible offer";
  }
  if (review.proposedEventType === "career.interview_scheduled") {
    return "an interview email";
  }
  const signalKind = review.extracted?.signalKind;
  if (typeof signalKind === "string" && signalKind.trim()) {
    return signalKind.trim().replace(/_/g, " ");
  }
  return "an important email";
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
