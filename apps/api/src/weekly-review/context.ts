import { isRiskControlGoal, type Goal, type StoredEvent } from "@operator-agent/core";
import {
  getActionItems,
  getActiveGoals,
  getActiveMemories,
  getEmailReviewItems,
  getEventsBetween,
  prisma,
  type ActionItem,
  type EmailReviewItem
} from "@operator-agent/db";
import type { WeeklyEmailAttentionSummary, WeeklyReviewContext } from "../server-types.js";
import { analyzeActionHygiene } from "../actions/hygiene-session.js";
import { isSnoozedDue } from "../utils/action-item.js";
import { addDaysToLocalDateString, formatDateInTimezone, isDateInRange, localDateStartUtc, startOfLocalWeek } from "../utils/datetime.js";
import { emailReviewKind } from "../utils/email-review.js";
import { isGuardrailEvent } from "../utils/events.js";
import { isOperatorReflectionMemory } from "../utils/memory.js";
import { stringFromRecord } from "../utils/records.js";

/**
 * Reusable, non-legacy weekly-review CONTEXT builder: gathers goals, actions, events,
 * memories, email reviews, and action-hygiene state for a reviewed week and assembles them
 * into a WeeklyReviewContext — pure, deterministic, no persistence. Split out of
 * apps/api/src/legacy/weekly-review-conversation.ts (which re-exports everything here for its
 * existing callers) as part of the Weekly-Review V3 Migration, so Agent Runtime v3 can build a
 * grounded review without importing the legacy module. Review GENERATION/FORMATTING/SAVING on
 * top of an already-built context lives in the sibling apps/api/src/weekly-review/review.ts.
 */

export async function buildWeeklyReviewContext(
  userId: string,
  weekStartLocalDate: string | undefined,
  timezone: string,
  now: Date
): Promise<WeeklyReviewContext> {
  const currentLocalDate = formatDateInTimezone(now, timezone);
  const weekStart = weekStartLocalDate ?? startOfLocalWeek(currentLocalDate);
  const weekEnd = addDaysToLocalDateString(weekStart, 6);
  const reviewedEnd = currentLocalDate < weekEnd ? currentLocalDate : weekEnd;
  const rangeStart = localDateStartUtc(weekStart, timezone);
  const nextEnd = addDaysToLocalDateString(reviewedEnd, 1);
  const plannedRangeEnd = localDateStartUtc(nextEnd, timezone);
  const rangeEnd = now < plannedRangeEnd ? now : plannedRangeEnd;
  const [activeGoals, actions, events, memories, emailReviews] = await Promise.all([
    getActiveGoals(userId),
    getActionItems(userId, { status: "all", limit: 300 }),
    getEventsBetween(userId, rangeStart, rangeEnd),
    getActiveMemories(userId),
    getEmailReviewItems(userId, { status: "all", limit: 300 })
  ]);
  const actionInWeek = (action: ActionItem) =>
    isDateInRange(action.completedAt, rangeStart, rangeEnd) ||
    isDateInRange(action.updatedAt, rangeStart, rangeEnd) ||
    isDateInRange(action.createdAt, rangeStart, rangeEnd) ||
    isDateInRange(action.dueAt, rangeStart, rangeEnd);
  const completedActions = actions.filter((action) => action.status === "completed" && isDateInRange(action.completedAt, rangeStart, rangeEnd));
  const openActions = actions.filter((action) => (action.status === "open" || isSnoozedDue(action, now)) && isActionRelevantToReviewedRange(action, rangeStart, rangeEnd));
  const overdueActions = openActions.filter((action) => action.dueAt && action.dueAt < now);
  const snoozedOrRescheduledActions = actions.filter((action) => actionInWeek(action) && (action.status === "snoozed" || Boolean(action.snoozedUntil)));
  const archivedActions = actions.filter((action) => action.status === "archived" && actionInWeek(action));
  const guardrailEvents = events.filter(isGuardrailEvent);
  const activeReflections = memories.filter(isOperatorReflectionMemory);
  const hygiene = await analyzeActionHygiene(userId, now, timezone);
  const eventsByType = countEventsByType(events);
  const goalProgress = activeGoals.map((goal) => buildWeeklyGoalProgress(goal, events, completedActions));
  const goalsWithProgress = goalProgress.filter((goal) => goal.progressCount > 0);
  const goalsWithoutProgress = goalProgress.filter((goal) => goal.progressCount === 0 && !goal.isRiskControl);
  const dailyLoopCounts = await getWeeklyDailyLoopCounts(userId, weekStart, reviewedEnd);
  const emailAttention = buildWeeklyEmailAttentionSummary({
    emailReviews,
    actions,
    events,
    rangeStart,
    rangeEnd
  });

  return {
    userId,
    timezone,
    weekStartLocalDate: weekStart,
    weekEndLocalDate: weekEnd,
    reviewedEndLocalDate: reviewedEnd,
    rangeStart,
    rangeEnd,
    activeGoals,
    events,
    eventsByType,
    completedActions,
    openActions,
    overdueActions,
    snoozedOrRescheduledActions,
    archivedActions,
    guardrailEvents,
    emailAttention,
    goalProgress,
    goalsWithProgress,
    goalsWithoutProgress,
    actionHygiene: hygiene,
    activeReflections,
    dailyLoopCounts
  };
}

export function buildWeeklyGoalProgress(goal: Goal, events: StoredEvent[], completedActions: ActionItem[]) {
  const riskControl = isRiskControlGoal(goal);
  const goalEvents = events.filter((event) => stringFromRecord(event.data, "goalId") === goal.id || eventMatchesGoal(goal, event));
  const goalActions = completedActions.filter((action) => action.goalId === goal.id);
  const progressCount = goalEvents.length + goalActions.length;

  return {
    goalId: goal.id,
    title: goal.title,
    priority: goal.priority,
    isRiskControl: riskControl,
    progressCount,
    note: progressCount > 0
      ? `${progressCount} verified progress signal${progressCount === 1 ? "" : "s"}`
      : "no verified progress"
  };
}

export function eventMatchesGoal(goal: Goal, event: StoredEvent): boolean {
  const text = `${goal.templateId ?? ""} ${goal.category} ${goal.title}`.toLowerCase();

  return (
    (/job|career/.test(text) && event.type.startsWith("career.")) ||
    (/health|strength|sleep/.test(text) && event.type.startsWith("health.")) ||
    (/reading|learning/.test(text) && event.type.startsWith("learning.")) ||
    (/betting|trading|finance/.test(text) && event.type.startsWith("finance."))
  );
}

export function isActionRelevantToReviewedRange(action: ActionItem, rangeStart: Date, rangeEnd: Date): boolean {
  if (isDateInRange(action.completedAt, rangeStart, rangeEnd)) {
    return true;
  }

  if (action.dueAt && action.dueAt < rangeEnd) {
    return true;
  }

  if (action.snoozedUntil && action.snoozedUntil < rangeEnd) {
    return true;
  }

  if (action.createdAt < rangeEnd && !action.dueAt && !action.snoozedUntil) {
    return true;
  }

  return false;
}

export function weeklyContextCounts(context: WeeklyReviewContext) {
  return {
    completedActions: context.completedActions.length,
    openActions: context.openActions.length,
    overdueActions: context.overdueActions.length,
    snoozedOrRescheduledActions: context.snoozedOrRescheduledActions.length,
    archivedActions: context.archivedActions.length,
    events: context.events.length,
    guardrailTriggers: context.guardrailEvents.length,
    activeGoals: context.activeGoals.length,
    activeReflections: context.activeReflections.length,
    gmailReviewsCreated: context.emailAttention.reviewsCreated,
    gmailReviewsApproved: context.emailAttention.reviewsApproved,
    gmailReviewsRejected: context.emailAttention.reviewsRejected,
    gmailReviewsPending: context.emailAttention.pendingReviews,
    gmailDerivedActionItems: context.emailAttention.gmailDerivedActionItems,
    gmailDerivedEvents: context.emailAttention.gmailDerivedEvents,
    morningBriefs: context.dailyLoopCounts.morningBriefs,
    eveningReviews: context.dailyLoopCounts.eveningReviews
  };
}

export function summarizeWeeklyReviewContext(context: WeeklyReviewContext) {
  return {
    weekWindow: {
      start: context.weekStartLocalDate,
      end: context.weekEndLocalDate
    },
    reviewedRange: {
      start: context.weekStartLocalDate,
      end: context.reviewedEndLocalDate
    },
    dateRange: {
      start: context.weekStartLocalDate,
      end: context.reviewedEndLocalDate
    },
    counts: weeklyContextCounts(context),
    eventsByType: context.eventsByType,
    emailAttention: context.emailAttention,
    goalsWithProgress: context.goalsWithProgress.map((goal) => goal.title),
    goalsWithoutProgress: context.goalsWithoutProgress.map((goal) => goal.title),
    activeReflections: context.activeReflections.map((reflection) => typeof reflection.data?.title === "string" ? reflection.data.title : reflection.summary)
  };
}

export function formatWeeklyReviewContextDebug(context: WeeklyReviewContext): string {
  const counts = weeklyContextCounts(context);

  return [
    "Weekly review context:",
    `weekWindow: ${context.weekStartLocalDate} to ${context.weekEndLocalDate}`,
    `reviewedRange: ${context.weekStartLocalDate} to ${context.reviewedEndLocalDate}`,
    `completed actions: ${counts.completedActions}`,
    `open actions: ${counts.openActions}`,
    `overdue/stale actions: ${counts.overdueActions}`,
    `snoozes/reschedules: ${counts.snoozedOrRescheduledActions}`,
    `guardrail triggers: ${counts.guardrailTriggers}`,
    `Gmail reviews created: ${counts.gmailReviewsCreated}`,
    `Gmail reviews pending: ${counts.gmailReviewsPending}`,
    `Gmail-derived actions: ${counts.gmailDerivedActionItems}`,
    `Gmail-derived events: ${counts.gmailDerivedEvents}`,
    `goals with progress: ${context.goalsWithProgress.length}`,
    `goals without progress: ${context.goalsWithoutProgress.length}`,
    `active reflections: ${context.activeReflections.length}`,
    "events by type:",
    ...Object.entries(context.eventsByType).slice(0, 10).map(([type, count]) => `- ${type}: ${count}`)
  ].join("\n");
}

export function buildWeeklyEmailAttentionSummary(input: {
  emailReviews: EmailReviewItem[];
  actions: ActionItem[];
  events: StoredEvent[];
  rangeStart: Date;
  rangeEnd: Date;
}): WeeklyEmailAttentionSummary {
  const reviewsCreated = input.emailReviews.filter((review) => isDateInRange(review.createdAt, input.rangeStart, input.rangeEnd));
  const reviewsHandled = input.emailReviews.filter((review) => isDateInRange(review.reviewedAt, input.rangeStart, input.rangeEnd));
  const byKind = reviewsCreated.reduce(
    (counts, review) => {
      const kind = emailReviewKind(review);
      if (kind === "job_search") {
        counts.jobSearch += 1;
      } else if (kind === "work_action") {
        counts.workAction += 1;
      } else if (kind === "custom_tracking") {
        counts.custom += 1;
      } else {
        counts.other += 1;
      }
      return counts;
    },
    { jobSearch: 0, workAction: 0, custom: 0, other: 0 }
  );

  return {
    reviewsCreated: reviewsCreated.length,
    reviewsApproved: reviewsHandled.filter((review) => review.status === "approved").length,
    reviewsRejected: reviewsHandled.filter((review) => review.status === "rejected").length,
    pendingReviews: input.emailReviews.filter((review) => review.status === "pending").length,
    gmailDerivedActionItems: input.actions.filter(
      (action) => action.source === "email_review" && isDateInRange(action.createdAt, input.rangeStart, input.rangeEnd)
    ).length,
    gmailDerivedEvents: input.events.filter(
      (event) => event.source === "gmail" || event.provider === "gmail" || event.data.provider === "gmail"
    ).length,
    byKind
  };
}

export async function getWeeklyDailyLoopCounts(userId: string, weekStart: string, weekEnd: string) {
  const states = await prisma.dailyLoopState.findMany({
    where: {
      userId,
      localDate: {
        gte: weekStart,
        lte: weekEnd
      }
    }
  });

  return {
    morningBriefs: states.filter((state) => state.morningBriefSentAt).length,
    eveningReviews: states.filter((state) => state.eveningReviewSentAt || state.eveningReviewCompletedAt).length
  };
}

export function countEventsByType(events: StoredEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const event of events) {
    counts[event.type] = (counts[event.type] ?? 0) + 1;
  }

  return counts;
}

export function countType(counts: Record<string, number>, type: string): number {
  return counts[type] ?? 0;
}
