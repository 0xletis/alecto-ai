import { isRiskControlGoal, type Goal, type MemoryEntry, type StoredEvent } from "@operator-agent/core";
import {
  createMemory,
  getActionItems,
  getActiveGoals,
  getActiveMemories,
  getEmailReviewItems,
  getEventsBetween,
  getMemories,
  prisma,
  updateMemory,
  type ActionItem,
  type EmailReviewItem
} from "@operator-agent/db";
import type {
  WeeklyEmailAttentionSummary,
  WeeklyReviewContext,
  WeeklyReviewDraft,
  WeeklyReviewMemory
} from "../server-types.js";
import { analyzeActionHygiene } from "./action-hygiene-conversation.js";
import { isSnoozedDue } from "../utils/action-item.js";
import {
  addDaysToLocalDateString,
  formatDateInTimezone,
  isDateInRange,
  localDateStartUtc,
  startOfLocalWeek
} from "../utils/datetime.js";
import { emailReviewKind } from "../utils/email-review.js";
import { isGuardrailEvent } from "../utils/events.js";
import { isOperatorReflectionMemory } from "../utils/memory.js";
import { arrayOfStrings, uniqueStrings } from "../utils/arrays.js";
import { isRecord, stringFromRecord } from "../utils/records.js";
import { containsUnsafeReflectionLanguage, normalizeForComparison, sharesMeaningfulToken } from "../utils/text.js";

/**
 * Legacy weekly-review context/analysis/formatting cluster, extracted from
 * apps/api/src/server.ts. Handles weekly-review context building (goal
 * progress, action/event ranges, Gmail email-attention summary, action
 * hygiene), deterministic + optional-LLM review generation, and formatting,
 * for the three weekly-review HTTP routes (POST/GET .../weekly-review,
 * GET .../weekly-review/last, GET .../weekly-review/context — the backing
 * implementation for several Telegram weekly-review slash commands,
 * confirmed via apps/telegram-bot/src/index.ts) and the legacy
 * /messages/process conversation surfaces.
 *
 * This was the hard blocker identified in the Planning Legacy Conversation
 * Cluster Extraction and `/messages/process` Extraction Readiness Audit
 * passes: buildNextWeekPlanContext (server.ts, stays) and
 * resolvePendingDecisionReply (server.ts, stays, via resolveNextWeekPlanReply)
 * both call buildWeeklyReviewContext directly, and could not move until this
 * module existed for them to import from one-directionally. See
 * docs/09-architecture-inventory.md's "Weekly-Review Legacy Cluster
 * Extraction" for the full boundary rationale and what this unblocks.
 */

export function finiteNumberFromRecord(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
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

export async function generateAndSaveWeeklyReview(userId: string, context: WeeklyReviewContext, options: { force?: boolean } = {}): Promise<WeeklyReviewMemory> {
  const deterministic = generateDeterministicWeeklyReview(context);
  const generated = options.force ? deterministic : await maybeGenerateLlmWeeklyReview(context) ?? deterministic;
  const existing = await getWeeklyReviewForWeek(userId, context.weekStartLocalDate);
  const data = {
    kind: "weekly_review",
    status: "generated",
    weekStartLocalDate: context.weekStartLocalDate,
    weekEndLocalDate: context.weekEndLocalDate,
    reviewedEndLocalDate: context.reviewedEndLocalDate,
    timezone: context.timezone,
    wins: generated.wins,
    stalls: generated.stalls,
    goalProgress: generated.goalProgress,
    guardrailSummary: generated.guardrailSummary,
    emailAttention: context.emailAttention,
    patterns: generated.patterns,
    recommendedNextWeekActions: generated.recommendedNextWeekActions,
    reflectionIds: generated.reflectionIds,
    source: generated.source
  };
  const evidence = {
    actionIds: uniqueStrings([
      ...context.completedActions.map((action) => action.id),
      ...context.overdueActions.map((action) => action.id),
      ...context.snoozedOrRescheduledActions.map((action) => action.id)
    ]).slice(0, 30),
    eventIds: context.events.map((event) => event.id).slice(0, 50),
    goalIds: context.activeGoals.map((goal) => goal.id),
    dateRange: {
      start: context.weekStartLocalDate,
      end: context.reviewedEndLocalDate
    },
    counts: weeklyContextCounts(context)
  };
  const summary = generated.summary;
  const memory = existing
    ? await updateMemory(userId, existing.id, { summary, data, evidence, confidence: 1 })
    : await createMemory(userId, {
      type: "pattern",
      summary,
      data,
      evidence,
      source: "system_inferred",
      confidence: 1
    });

  if (!memory) {
    throw new Error("Could not save weekly review.");
  }

  return toWeeklyReviewMemory(memory);
}

export function generateDeterministicWeeklyReview(context: WeeklyReviewContext): WeeklyReviewDraft {
  const wins = weeklyReviewWins(context);
  const stalls = weeklyReviewStalls(context);
  const goalProgress = context.goalProgress.map((goal) => ({
    goalId: goal.goalId,
    title: goal.title,
    priority: goal.priority,
    isRiskControl: goal.isRiskControl,
    note: goal.note,
    progressCount: goal.progressCount
  }));
  const guardrailSummary = {
    triggers: context.guardrailEvents.length,
    note: buildWeeklyGuardrailNote(context)
  };
  const reflections = context.activeReflections.slice(0, 2);
  const recommendedNextWeekActions = buildNextWeekRecommendations(context).slice(0, 3);

  return {
    summary: buildWeeklyReviewSummary(context, wins, stalls),
    wins,
    stalls,
    goalProgress,
    guardrailSummary,
    patterns: reflections.map((reflection) => typeof reflection.data?.title === "string" ? reflection.data.title : reflection.summary),
    recommendedNextWeekActions,
    reflectionIds: reflections.map((reflection) => reflection.id),
    source: "deterministic"
  };
}

export async function maybeGenerateLlmWeeklyReview(context: WeeklyReviewContext): Promise<WeeklyReviewDraft | undefined> {
  if (process.env.WEEKLY_REVIEW_LLM_ENABLED !== "true") {
    return undefined;
  }

  const mock = process.env.WEEKLY_REVIEW_LLM_MOCK_RESPONSE;

  if (!mock) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(mock) as unknown;
    const draft = parseWeeklyReviewDraft(parsed, context);
    return draft && isSafeWeeklyReviewDraft(draft, context) ? { ...draft, source: "llm" } : undefined;
  } catch {
    return undefined;
  }
}

export function parseWeeklyReviewDraft(value: unknown, context: WeeklyReviewContext): WeeklyReviewDraft | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const wins = arrayOfStrings(value.wins).slice(0, 5);
  const stalls = arrayOfStrings(value.stalls).slice(0, 5);
  const recommendedNextWeekActions = arrayOfStrings(value.recommendedNextWeekActions).slice(0, 3);
  const summary = typeof value.summary === "string" ? value.summary.trim() : "";

  if (!summary || recommendedNextWeekActions.length > 3) {
    return undefined;
  }

  return {
    summary: summary.slice(0, 400),
    wins,
    stalls,
    goalProgress: context.goalProgress,
    guardrailSummary: {
      triggers: context.guardrailEvents.length,
      note: buildWeeklyGuardrailNote(context)
    },
    patterns: context.activeReflections.slice(0, 2).map((reflection) => typeof reflection.data?.title === "string" ? reflection.data.title : reflection.summary),
    recommendedNextWeekActions,
    reflectionIds: context.activeReflections.slice(0, 2).map((reflection) => reflection.id),
    source: "llm"
  };
}

export function isSafeWeeklyReviewDraft(draft: WeeklyReviewDraft, context: WeeklyReviewContext): boolean {
  const text = [draft.summary, ...draft.wins, ...draft.stalls, ...draft.recommendedNextWeekActions].join(" ");

  if (containsUnsafeReflectionLanguage(text)) {
    return false;
  }

  if (draft.recommendedNextWeekActions.length > 3) {
    return false;
  }

  const allowedText = normalizeForComparison([
    ...context.activeGoals.map((goal) => goal.title),
    ...context.overdueActions.map((action) => action.title),
    ...context.snoozedOrRescheduledActions.map((action) => action.title),
    ...context.completedActions.map((action) => action.title),
    "job developer youtube script strength training reading homepage car application cv guardrail betting trading"
  ].join(" "));

  return draft.recommendedNextWeekActions.every((action) => sharesMeaningfulToken(normalizeForComparison(action), allowedText));
}

export function weeklyReviewWins(context: WeeklyReviewContext): string[] {
  const wins: string[] = [];
  const workouts = countType(context.eventsByType, "health.workout_completed");
  const applications = countType(context.eventsByType, "career.application_sent");
  const customProgress = countType(context.eventsByType, "custom.goal_progress_logged");
  const emailReviewsHandled = context.emailAttention.reviewsApproved + context.emailAttention.reviewsRejected;

  if (context.completedActions.length > 0) {
    wins.push(`Completed ${context.completedActions.length} action${context.completedActions.length === 1 ? "" : "s"}.`);
  }

  if (emailReviewsHandled > 0) {
    wins.push(`Handled ${emailReviewsHandled} Gmail review${emailReviewsHandled === 1 ? "" : "s"}.`);
  }

  if (context.emailAttention.gmailDerivedActionItems > 0) {
    wins.push(`Created ${context.emailAttention.gmailDerivedActionItems} action item${context.emailAttention.gmailDerivedActionItems === 1 ? "" : "s"} from Gmail review.`);
  }

  if (context.emailAttention.gmailDerivedEvents > 0) {
    wins.push(`Logged ${context.emailAttention.gmailDerivedEvents} Gmail-derived event${context.emailAttention.gmailDerivedEvents === 1 ? "" : "s"}.`);
  }

  if (workouts > 0) {
    wins.push(`Logged ${workouts} workout${workouts === 1 ? "" : "s"}.`);
  }

  if (applications > 0) {
    wins.push(`Logged ${applications} job application event${applications === 1 ? "" : "s"}.`);
  }

  if (customProgress > 0) {
    wins.push(`Logged ${customProgress} custom progress event${customProgress === 1 ? "" : "s"}.`);
  }

  const movedGoals = context.goalsWithProgress.filter((goal) => !goal.isRiskControl).map((goal) => goal.title).slice(0, 2);
  if (movedGoals.length > 0) {
    wins.push(`Progress logged for ${movedGoals.join(", ")}.`);
  }

  return wins.length > 0 ? wins : ["No completed actions or progress events were logged this week."];
}

export function weeklyReviewStalls(context: WeeklyReviewContext): string[] {
  const stalls: string[] = [];

  if (context.goalsWithoutProgress.length > 0) {
    stalls.push(`Goals with no progress: ${context.goalsWithoutProgress.map((goal) => goal.title).slice(0, 5).join(", ")}.`);
  }

  if (context.snoozedOrRescheduledActions.length > 0) {
    stalls.push(`Actions snoozed/rescheduled: ${context.snoozedOrRescheduledActions.length}.`);
  }

  if (context.actionHygiene.suggestedCleanupCandidates.length > 0) {
    stalls.push(`Overdue/stale actions needing decisions: ${context.actionHygiene.suggestedCleanupCandidates.length}.`);
  }

  if (context.emailAttention.pendingReviews > 0) {
    stalls.push(`${context.emailAttention.pendingReviews} Gmail review${context.emailAttention.pendingReviews === 1 ? "" : "s"} waiting for a decision.`);
  }

  return stalls.length > 0 ? stalls : ["No major stalls detected from logged data."];
}

export function buildNextWeekRecommendations(context: WeeklyReviewContext): string[] {
  const recommendations: string[] = [];
  const jobGoal = context.activeGoals.find((goal) => /job|developer|career/i.test(`${goal.title} ${goal.templateId ?? ""}`));
  const creativeGoal = context.activeGoals.find((goal) => /youtube|creative|script|channel/i.test(`${goal.title} ${goal.category} ${goal.templateId ?? ""}`));
  const healthGoal = context.activeGoals.find((goal) => /strength|health|training|workout/i.test(`${goal.title} ${goal.category} ${goal.templateId ?? ""}`));
  const staleAction = context.actionHygiene.suggestedCleanupCandidates[0];

  if (jobGoal) {
    recommendations.push("Apply to 3 developer jobs.");
  }

  if (creativeGoal) {
    recommendations.push("Write 5 bullets for the YouTube script.");
  }

  if (healthGoal) {
    recommendations.push("Do 2 strength sessions.");
  }

  if (staleAction && recommendations.length < 3) {
    recommendations.push(`Decide ${staleAction.title}: complete, snooze, or archive.`);
  }

  if (context.guardrailEvents.length > 0 && recommendations.length < 3) {
    recommendations.push("Keep betting/trading out of task planning.");
  }

  return uniqueStrings(recommendations).slice(0, 3);
}

export function buildWeeklyReviewSummary(context: WeeklyReviewContext, wins: string[], stalls: string[]): string {
  return `Verified reviewed period: ${context.completedActions.length} completed actions, ${context.events.length} events, ${context.guardrailEvents.length} guardrail trigger${context.guardrailEvents.length === 1 ? "" : "s"}. ${wins[0] ?? ""} ${stalls[0] ?? ""}`.trim();
}

export function buildWeeklyGuardrailNote(context: WeeklyReviewContext): string {
  const riskGoals = context.activeGoals.filter(isRiskControlGoal);
  const goalPrefix = riskGoals.length > 0 ? `${riskGoals[0].title}: ` : "";

  if (context.guardrailEvents.length > 0) {
    return `${goalPrefix}triggered ${context.guardrailEvents.length} time${context.guardrailEvents.length === 1 ? "" : "s"}. Keep risky actions out of task creation.`;
  }

  return `${goalPrefix}no guardrail triggers logged this reviewed period.`;
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

export async function getWeeklyReviewForWeek(userId: string, weekStartLocalDate: string): Promise<MemoryEntry | undefined> {
  return (await getActiveMemories(userId)).find((memory) => memory.data?.kind === "weekly_review" && memory.data.weekStartLocalDate === weekStartLocalDate);
}

export async function getLatestWeeklyReview(userId: string): Promise<WeeklyReviewMemory | undefined> {
  const review = (await getMemories(userId))
    .filter((memory) => memory.status === "active" && memory.data?.kind === "weekly_review")
    .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())[0];

  return review ? toWeeklyReviewMemory(review) : undefined;
}

export async function shouldPromptWeeklyReview(userId: string, now: Date, timezone: string): Promise<boolean> {
  const local = localWeekdayAndHour(now, timezone);

  if (!((local.weekday === "sunday" && local.hour >= 18) || (local.weekday === "monday" && local.hour < 12))) {
    return false;
  }

  const weekStart = startOfLocalWeek(formatDateInTimezone(now, timezone));
  return !(await getWeeklyReviewForWeek(userId, weekStart));
}

export function toWeeklyReviewMemory(memory: MemoryEntry): WeeklyReviewMemory {
  const data = memory.data ?? {};

  return {
    id: memory.id,
    userId: memory.userId,
    weekStartLocalDate: typeof data.weekStartLocalDate === "string" ? data.weekStartLocalDate : "",
    weekEndLocalDate: typeof data.weekEndLocalDate === "string" ? data.weekEndLocalDate : "",
    reviewedEndLocalDate: typeof data.reviewedEndLocalDate === "string"
      ? data.reviewedEndLocalDate
      : typeof data.weekEndLocalDate === "string"
        ? data.weekEndLocalDate
        : "",
    timezone: typeof data.timezone === "string" ? data.timezone : "Europe/Madrid",
    status: data.status === "archived" ? "archived" : "generated",
    summary: memory.summary,
    wins: arrayOfStrings(data.wins),
    stalls: arrayOfStrings(data.stalls),
    goalProgress: Array.isArray(data.goalProgress) ? data.goalProgress : [],
    guardrailSummary: isRecord(data.guardrailSummary) ? data.guardrailSummary : {},
    emailAttention: parseStoredWeeklyEmailAttentionSummary(data.emailAttention),
    patterns: arrayOfStrings(data.patterns).slice(0, 2),
    recommendedNextWeekActions: arrayOfStrings(data.recommendedNextWeekActions).slice(0, 3),
    reflectionIds: arrayOfStrings(data.reflectionIds),
    source: data.source === "llm" || data.source === "mixed" ? data.source : "deterministic",
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt
  };
}

export function parseStoredWeeklyEmailAttentionSummary(value: unknown): WeeklyEmailAttentionSummary | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const byKind = isRecord(value.byKind) ? value.byKind : {};

  return {
    reviewsCreated: finiteNumberFromRecord(value, "reviewsCreated"),
    reviewsApproved: finiteNumberFromRecord(value, "reviewsApproved"),
    reviewsRejected: finiteNumberFromRecord(value, "reviewsRejected"),
    pendingReviews: finiteNumberFromRecord(value, "pendingReviews"),
    gmailDerivedActionItems: finiteNumberFromRecord(value, "gmailDerivedActionItems"),
    gmailDerivedEvents: finiteNumberFromRecord(value, "gmailDerivedEvents"),
    byKind: {
      jobSearch: finiteNumberFromRecord(byKind, "jobSearch"),
      workAction: finiteNumberFromRecord(byKind, "workAction"),
      custom: finiteNumberFromRecord(byKind, "custom"),
      other: finiteNumberFromRecord(byKind, "other")
    }
  };
}

export function formatWeeklyEmailSignalsForReview(emailAttention: WeeklyEmailAttentionSummary | undefined): string {
  if (!emailAttention) {
    return "- No Gmail review summary stored for this weekly review.";
  }

  const lines = [
    emailAttention.reviewsCreated > 0 ? `- ${emailAttention.reviewsCreated} Gmail review${emailAttention.reviewsCreated === 1 ? "" : "s"} created this reviewed period.` : undefined,
    emailAttention.reviewsApproved + emailAttention.reviewsRejected > 0
      ? `- ${emailAttention.reviewsApproved} approved, ${emailAttention.reviewsRejected} rejected.`
      : undefined,
    emailAttention.gmailDerivedActionItems > 0 ? `- ${emailAttention.gmailDerivedActionItems} action item${emailAttention.gmailDerivedActionItems === 1 ? "" : "s"} created from Gmail review.` : undefined,
    emailAttention.gmailDerivedEvents > 0 ? `- ${emailAttention.gmailDerivedEvents} Gmail-derived event${emailAttention.gmailDerivedEvents === 1 ? "" : "s"} logged.` : undefined,
    emailAttention.pendingReviews > 0 ? `- ${emailAttention.pendingReviews} Gmail review${emailAttention.pendingReviews === 1 ? "" : "s"} still waiting. Say "email reviews" to handle ${emailAttention.pendingReviews === 1 ? "it" : "them"}.` : undefined
  ].filter(Boolean);

  return lines.length > 0 ? lines.join("\n") : "- No Gmail review activity in this reviewed period.";
}

export function formatWeeklyReview(review: WeeklyReviewMemory): string {
  const isSoFar = review.reviewedEndLocalDate && review.reviewedEndLocalDate < review.weekEndLocalDate;
  const title = isSoFar
    ? `Weekly review so far - ${review.weekStartLocalDate} to ${review.reviewedEndLocalDate}`
    : `Weekly review - ${review.weekStartLocalDate} to ${review.weekEndLocalDate}`;

  return [
    title,
    "",
    review.summary,
    "",
    "Wins:",
    review.wins.map((win) => `- ${win}`).join("\n"),
    "",
    "Stalled:",
    review.stalls.map((stall) => `- ${stall}`).join("\n"),
    "",
    "Guardrails:",
    `- ${typeof review.guardrailSummary.note === "string" ? review.guardrailSummary.note : "No guardrail summary."}`,
    "",
    "Email signals:",
    formatWeeklyEmailSignalsForReview(review.emailAttention),
    "",
    "Patterns:",
    review.patterns.length > 0 ? review.patterns.map((pattern) => `- ${pattern}`).join("\n") : "- No active operator reflections included.",
    "",
    "Next week:",
    review.recommendedNextWeekActions.length > 0
      ? review.recommendedNextWeekActions.map((action, index) => `${index + 1}. ${action}`).join("\n")
      : "No next-week actions suggested."
  ].join("\n");
}

export function appendWeeklyPlanningNextStep(message: string): string {
  return `${message}\n\nNext: say 'plan next week' to turn this into actions.`;
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
export function localWeekdayAndHour(date: Date, timezone: string): { weekday: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "long",
    hour: "2-digit",
    hour12: false
  }).formatToParts(date);

  return {
    weekday: (parts.find((part) => part.type === "weekday")?.value ?? "").toLowerCase(),
    hour: Number(parts.find((part) => part.type === "hour")?.value ?? 0)
  };
}
