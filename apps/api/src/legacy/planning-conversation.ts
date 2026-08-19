import { isRiskControlGoal, normalizeManualActionTitleKey, parseActionDueDate, type Goal } from "@operator-agent/core";
import {
  createActionItemIfNotExists,
  getActionItems,
  getActiveMemories,
  getOrCreateNotificationSettings,
  replacePendingAction,
  rejectPendingAction,
  confirmPendingAction,
  type ActionItem,
  type CreateActionItemInput,
  type PendingAction
} from "@operator-agent/db";
import { createOpenAIClient } from "@operator-agent/llm";
import type { NextWeekPlanContext, NextWeekPlanSuggestion, PlanWindowKind } from "../server-types.js";
import { isRecord } from "../utils/records.js";
import { normalizeForComparison, sentenceLikeTitle, sharesMeaningfulToken } from "../utils/text.js";
import { goalPriorityRank } from "../utils/goal-priority.js";
import {
  addDaysToLocalDateString,
  formatDateInTimezone,
  localDateStartUtc,
  pendingDecisionExpiry,
  startOfLocalWeek,
  isDateInRange
} from "../utils/datetime.js";
import { isSnoozedDue } from "../utils/action-item.js";
import { getUserTimezone } from "../utils/user-timezone.js";
import { buildWeeklyReviewContext, getLatestWeeklyReview } from "./weekly-review-conversation.js";

/**
 * Legacy next-week/current-week planning conversation cluster, extracted
 * from apps/api/src/server.ts. Handles plan-suggestion generation
 * (deterministic + optional LLM), pending-plan formatting, and the
 * free-text plan-reply parser, for both the POST /users/:userId/next-week-plan
 * and GET /users/:userId/next-week-plan/context HTTP routes (the backing
 * implementation for Telegram's /plan_next_week slash command) and the
 * legacy /messages/process conversation surfaces.
 *
 * buildNextWeekPlanContext and resolveNextWeekPlanReply originally stayed in
 * server.ts because buildNextWeekPlanContext calls buildWeeklyReviewContext,
 * server.ts's separate ~500-line weekly-review context builder — moving
 * either function was out of scope for this module's original (planning-only)
 * extraction pass. The Weekly-Review Legacy Cluster Extraction pass later
 * moved buildWeeklyReviewContext itself into
 * apps/api/src/legacy/weekly-review-conversation.ts, resolving that blocker;
 * the `/messages/process` Third Extraction Readiness Audit then moved both
 * functions here as the prerequisite for extracting the legacy
 * /messages/process handler cluster into
 * apps/api/src/legacy/messages-process.ts, which needs both (the latter
 * transitively, via createPlanForConversation, which lives in that module
 * and imports buildNextWeekPlanContext from here). See
 * docs/09-architecture-inventory.md's "Planning Legacy Conversation Cluster
 * Extraction" and "`/messages/process` Third Extraction Readiness Audit" for
 * the full boundary rationale.
 */

export async function generateNextWeekPlanSuggestions(context: NextWeekPlanContext): Promise<NextWeekPlanSuggestion[]> {
  const deterministic = generateDeterministicNextWeekPlanSuggestions(context);
  const llm = await maybeGenerateLlmNextWeekPlanSuggestions(context, deterministic);
  return normalizeNextWeekPlanSuggestions(context, [...deterministic, ...llm]).slice(0, 7);
}

export function generateDeterministicNextWeekPlanSuggestions(context: NextWeekPlanContext): NextWeekPlanSuggestion[] {
  const suggestions: NextWeekPlanSuggestion[] = [];
  const normalGoals = [...context.activeGoals]
    .filter((goal) => !isRiskControlGoal(goal))
    .sort(compareGoalsForPlan(context));
  const staleAction = context.staleActions[0];

  if (staleAction) {
    suggestions.push({
      index: 0,
      title: `Resolve stale action: ${staleAction.title}`,
      reason: `${staleAction.title} needs a cleanup decision before next week gets noisy.`,
      goalId: undefined,
      goalTitle: staleAction.linkedGoalTitle,
      priority: staleAction.priority === "high" ? "high" : "medium",
      actionPriority: staleAction.priority === "high" ? "high" : "medium",
      suggestedDueAt: localPlanDate(context, 0, 9 * 60),
      actionType: "generic",
      source: "weekly_plan",
      duplicateRisk: true,
      existingActionId: staleAction.actionId,
      existingActionTitle: staleAction.title,
      planKind: "cleanup",
      creatable: false,
      dedupeKey: `weekly_plan.cleanup.${staleAction.actionId}`,
      notCreatableReason: "Use /action_hygiene or say a natural cleanup command like snooze, complete, or archive."
    });
  }

  if (context.emailAttention.pendingReviews > 0) {
    suggestions.push({
      index: 0,
      title: "Clear pending Gmail reviews",
      reason: `${context.emailAttention.pendingReviews} Gmail review${context.emailAttention.pendingReviews === 1 ? " is" : "s are"} already waiting for a decision.`,
      goalId: undefined,
      goalTitle: undefined,
      priority: context.emailAttention.byKind.workAction > 0 ? "high" : "medium",
      actionPriority: "medium",
      suggestedDueAt: localPlanDate(context, 0, 10 * 60),
      actionType: "generic",
      source: "weekly_plan",
      duplicateRisk: true,
      planKind: "cleanup",
      creatable: false,
      dedupeKey: "weekly_plan.email_reviews_cleanup",
      notCreatableReason: "Say \"email reviews\" or \"show me the important emails\"; those reviews already exist."
    });
  }

  for (const goal of normalGoals) {
    const suggestion = suggestionForGoal(context, goal);

    if (suggestion) {
      suggestions.push(suggestion);
    }

    if (suggestions.length >= 6) {
      break;
    }
  }

  const riskGoal = context.guardrailGoals[0];
  if (riskGoal && suggestions.length < 7) {
    suggestions.push({
      index: 0,
      title: "Review betting/trading guardrail rules",
      reason: context.guardrailEvents.length > 0
        ? `${riskGoal.title} had guardrail activity this week; keep next week clean.`
        : `${riskGoal.title} is active; keep risky actions out of planning.`,
      goalId: riskGoal.id,
      goalTitle: riskGoal.title,
      priority: normalizePlanPriority(riskGoal.priority),
      actionPriority: normalizePlanActionPriority(riskGoal.priority),
      suggestedDueAt: localPlanDate(context, 6, 18 * 60),
      actionType: "generic",
      source: "weekly_plan",
      duplicateRisk: false,
      dedupeKey: "weekly_plan.guardrail_review"
    });
  }

  if (suggestions.length < 3) {
    suggestions.push(
      {
        index: 0,
        title: "Review open actions and pick one to finish",
        reason: "The plan needs one concrete execution decision.",
        priority: "medium",
        actionPriority: "medium",
        suggestedDueAt: localPlanDate(context, 0, 9 * 60),
        actionType: "generic",
        source: "weekly_plan",
        duplicateRisk: false,
        dedupeKey: "weekly_plan.review_open_actions"
      },
      {
        index: 0,
        title: "Log one meaningful progress action",
        reason: "A weekly plan should produce at least one verified progress signal.",
        priority: "medium",
        actionPriority: "medium",
        suggestedDueAt: localPlanDate(context, 2, 16 * 60 + 30),
        actionType: "generic",
        source: "weekly_plan",
        duplicateRisk: false,
        dedupeKey: "weekly_plan.progress_action"
      },
      {
        index: 0,
        title: "Run weekly review before Sunday night",
        reason: "Close the loop with evidence before planning the following week.",
        priority: "low",
        actionPriority: "low",
        suggestedDueAt: localPlanDate(context, 6, 18 * 60),
        actionType: "generic",
        source: "weekly_plan",
        duplicateRisk: false,
        dedupeKey: "weekly_plan.run_weekly_review"
      }
    );
  }

  return suggestions;
}

export function suggestionForGoal(context: NextWeekPlanContext, goal: Goal): NextWeekPlanSuggestion | undefined {
  const key = normalizeForComparison(`${goal.templateId ?? ""} ${goal.category} ${goal.title}`);
  const hasNoProgress = context.goalsWithNoProgress.some((item) => item.goalId === goal.id);
  const priority = normalizePlanPriority(goal.priority);
  const reason = hasNoProgress
    ? `${goal.title} had no progress this reviewed week.`
    : `${goal.title} is active; keep momentum concrete.`;
  const base = {
    index: 0,
    goalId: goal.id,
    goalTitle: goal.title,
    priority,
    actionPriority: normalizePlanActionPriority(priority),
    actionType: "generic" as const,
    source: "weekly_plan" as const,
    duplicateRisk: false
  };

  if (/job|career|developer|cv|application/.test(key)) {
    return {
      ...base,
      title: "Apply to 3 developer jobs",
      reason,
      suggestedDueAt: localPlanDate(context, 0, 9 * 60),
      dedupeKey: "weekly_plan.job_search_apply_3"
    };
  }

  if (/youtube|channel|creative|script|video|creator|build_project/.test(key)) {
    return {
      ...base,
      title: "Write 5 bullets for the YouTube script",
      reason,
      suggestedDueAt: localPlanDate(context, 1, 16 * 60 + 30),
      dedupeKey: "weekly_plan.youtube_script_bullets"
    };
  }

  if (/strength|health|training|workout|gym|energy/.test(key)) {
    return {
      ...base,
      title: "Do 2 strength sessions",
      reason,
      suggestedDueAt: localPlanDate(context, 2, 18 * 60),
      dedupeKey: "weekly_plan.strength_sessions"
    };
  }

  if (/sleep/.test(key)) {
    return {
      ...base,
      title: "Set sleep cutoff for 3 nights",
      reason,
      suggestedDueAt: localPlanDate(context, 0, 20 * 60),
      dedupeKey: "weekly_plan.sleep_cutoff"
    };
  }

  if (/read|reading|learning|book/.test(key)) {
    return {
      ...base,
      title: "Read 20 minutes on 3 days",
      reason,
      suggestedDueAt: localPlanDate(context, 1, 20 * 60),
      dedupeKey: "weekly_plan.reading_20_min_3_days"
    };
  }

  if (/car|vehicle|cheap car|buy car/.test(key)) {
    return {
      ...base,
      title: "Check cheap car listings twice",
      reason,
      suggestedDueAt: localPlanDate(context, 3, 16 * 60 + 30),
      dedupeKey: "weekly_plan.car_listings_twice"
    };
  }

  return {
    ...base,
    title: `Do one concrete action for ${goal.title}`,
    reason,
    suggestedDueAt: localPlanDate(context, 2, 16 * 60 + 30),
    dedupeKey: `weekly_plan.goal_action.${goal.id}`
  };
}

export async function maybeGenerateLlmNextWeekPlanSuggestions(
  context: NextWeekPlanContext,
  deterministic: NextWeekPlanSuggestion[]
): Promise<NextWeekPlanSuggestion[]> {
  if (process.env.NEXT_WEEK_PLAN_LLM_ENABLED !== "true") {
    return [];
  }

  const mock = process.env.NEXT_WEEK_PLAN_LLM_MOCK_RESPONSE;

  if (mock) {
    try {
      const parsed = JSON.parse(mock) as unknown;
      return parseLlmNextWeekPlanSuggestions(parsed, context, deterministic);
    } catch {
      return [];
    }
  }

  if (!process.env.OPENAI_API_KEY) {
    return [];
  }

  try {
    const client = createOpenAIClient();
    const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
    const response = await client.responses.create({
      model,
      store: false,
      input: [
        {
          role: "developer",
          content: [
            {
              type: "input_text",
              text: [
                "You are Alecto's weekly planning assistant.",
                "Code has already gathered verified context. You only propose small ActionItem suggestions.",
                "Do not create, update, delete, or imply any database mutation.",
                "Do not invent facts, goals, events, memories, due dates, or risk states.",
                "Every suggestion must reference an existing goal, a stale/open action, a verified weekly gap, or a deterministic suggestion.",
                "Do not suggest betting/trading actions or advice. Risk-control goals may only produce safe guardrail-review actions.",
                "No shame language, no fake motivation, no huge plans.",
                "Return strict JSON only."
              ].join("\n")
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify(compactNextWeekPlanLlmContext(context, deterministic))
            }
          ]
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "next_week_plan_suggestions",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["suggestions"],
            properties: {
              suggestions: {
                type: "array",
                maxItems: 7,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["title", "reason", "goalId", "priority", "suggestedDueAt"],
                  properties: {
                    title: { type: "string" },
                    reason: { type: "string" },
                    goalId: { type: ["string", "null"] },
                    priority: { type: "string", enum: ["low", "medium", "high", "critical"] },
                    suggestedDueAt: { type: "string" }
                  }
                }
              }
            }
          }
        }
      }
    });

    return parseLlmNextWeekPlanSuggestions(JSON.parse(response.output_text) as unknown, context, deterministic);
  } catch {
    return [];
  }
}

export function compactNextWeekPlanLlmContext(context: NextWeekPlanContext, deterministic: NextWeekPlanSuggestion[]) {
  return {
    planningWindow: {
      kind: context.planWindowKind,
      startLocalDate: context.planStartLocalDate,
      endLocalDate: context.planEndLocalDate,
      timezone: context.timezone
    },
    latestWeeklyReview: context.latestWeeklyReview
      ? {
          id: context.latestWeeklyReview.id,
          summary: context.latestWeeklyReview.summary,
          stalls: context.latestWeeklyReview.stalls.slice(0, 5),
          recommendedNextWeekActions: context.latestWeeklyReview.recommendedNextWeekActions.slice(0, 5)
        }
      : null,
    activeGoals: context.activeGoals.map((goal) => ({
      id: goal.id,
      title: goal.title,
      category: goal.category,
      templateId: goal.templateId,
      priority: goal.priority,
      importanceScore: goal.importanceScore
    })),
    goalsWithNoProgress: context.goalsWithNoProgress.map((goal) => ({
      goalId: goal.goalId,
      title: goal.title
    })),
    staleActions: context.staleActions.slice(0, 5).map((action) => ({
      id: action.actionId,
      title: action.title,
      dueAt: action.dueAt
    })),
    futureActionsAlreadyScheduled: context.futureActionsNextWeek.map((action) => ({
      id: action.id,
      title: action.title,
      dueAt: action.dueAt,
      goalId: action.goalId
    })),
    emailAttention: {
      pendingReviews: context.emailAttention.pendingReviews,
      reviewsCreated: context.emailAttention.reviewsCreated,
      reviewsApproved: context.emailAttention.reviewsApproved,
      reviewsRejected: context.emailAttention.reviewsRejected,
      gmailDerivedActionItems: context.emailAttention.gmailDerivedActionItems,
      gmailDerivedEvents: context.emailAttention.gmailDerivedEvents
    },
    guardrailGoals: context.guardrailGoals.map((goal) => ({
      id: goal.id,
      title: goal.title,
      priority: goal.priority
    })),
    deterministicSuggestions: deterministic.map((suggestion) => ({
      title: suggestion.title,
      goalId: suggestion.goalId,
      priority: suggestion.priority,
      actionPriority: suggestion.actionPriority ?? normalizePlanActionPriority(suggestion.priority),
      suggestedDueAt: suggestion.suggestedDueAt.toISOString()
    }))
  };
}

export function parseLlmNextWeekPlanSuggestions(
  value: unknown,
  context: NextWeekPlanContext,
  deterministic: NextWeekPlanSuggestion[]
): NextWeekPlanSuggestion[] {
  const rawSuggestions = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.suggestions)
      ? value.suggestions
      : [];
  const allowedGoalIds = new Set(context.activeGoals.map((goal) => goal.id));
  const allowedText = normalizeForComparison([
    ...context.activeGoals.map((goal) => goal.title),
    ...context.staleActions.map((action) => action.title),
    ...deterministic.map((suggestion) => suggestion.title),
    "job developer youtube script strength training reading homepage car application cv guardrail"
  ].join(" "));

  return rawSuggestions
    .slice(0, 7)
    .filter(isRecord)
    .map((item): NextWeekPlanSuggestion | undefined => {
      const title = typeof item.title === "string" ? sentenceLikeTitle(item.title) : "";
      const reason = typeof item.reason === "string" ? item.reason.trim().slice(0, 220) : "";
      const goalId = typeof item.goalId === "string" && allowedGoalIds.has(item.goalId) ? item.goalId : undefined;
      const goal = goalId ? context.activeGoals.find((candidate) => candidate.id === goalId) : undefined;
      const priority = normalizePlanPriority(typeof item.priority === "string" ? item.priority : goal?.priority);
      const actionPriority = normalizePlanActionPriority(priority);
      const dueAt = typeof item.suggestedDueAt === "string" ? new Date(item.suggestedDueAt) : undefined;

      if (!title || !reason || containsUnsafePlanAction(title) || containsUnsafePlanAction(reason)) {
        return undefined;
      }

      if (!goalId && !sharesMeaningfulToken(normalizeForComparison(`${title} ${reason}`), allowedText)) {
        return undefined;
      }

      return {
        index: 0,
        title,
        reason,
        goalId,
        goalTitle: goal?.title,
        priority,
        actionPriority,
        suggestedDueAt: coercePlanDueAt(context, dueAt, 2, 16 * 60 + 30),
        actionType: "generic",
        source: "weekly_plan",
        duplicateRisk: false,
        dedupeKey: inferWeeklyPlanDedupeKey(title, goal?.title)
      };
    })
    .filter(Boolean) as NextWeekPlanSuggestion[];
}

export function normalizeNextWeekPlanSuggestions(
  context: NextWeekPlanContext,
  suggestions: NextWeekPlanSuggestion[]
): NextWeekPlanSuggestion[] {
  const seen = new Set<string>();
  const normalized: NextWeekPlanSuggestion[] = [];

  for (const suggestion of suggestions) {
    const title = sentenceLikeTitle(suggestion.title);
    const dedupeKey = suggestion.dedupeKey ?? inferWeeklyPlanDedupeKey(title, suggestion.goalTitle);
    const key = dedupeKey ?? normalizeManualActionTitleKey(title);

    if (!title || seen.has(key) || containsUnsafePlanAction(title)) {
      continue;
    }

    seen.add(key);
    const suggestedDueAt = coercePlanDueAt(context, suggestion.suggestedDueAt, 2, 16 * 60 + 30);
    const duplicate = findEquivalentOpenPlanAction(context, title, suggestedDueAt, dedupeKey);
    normalized.push({
      ...suggestion,
      index: normalized.length + 1,
      title,
      reason: suggestion.reason.trim().slice(0, 220),
      priority: normalizePlanPriority(suggestion.priority),
      actionPriority: normalizePlanActionPriority(suggestion.actionPriority ?? suggestion.priority),
      suggestedDueAt,
      dedupeKey,
      duplicateRisk: suggestion.duplicateRisk || Boolean(duplicate),
      existingActionId: suggestion.existingActionId ?? duplicate?.id,
      existingActionTitle: suggestion.existingActionTitle ?? duplicate?.title,
      planKind: suggestion.planKind ?? "action",
      creatable: suggestion.creatable !== false,
      notCreatableReason: suggestion.notCreatableReason
    });
  }

  return normalized.slice(0, 7);
}

export function compareGoalsForPlan(context: NextWeekPlanContext) {
  return (left: Goal, right: Goal) => {
    const leftNoProgress = context.goalsWithNoProgress.some((goal) => goal.goalId === left.id) ? 1 : 0;
    const rightNoProgress = context.goalsWithNoProgress.some((goal) => goal.goalId === right.id) ? 1 : 0;
    const leftPriority = goalPriorityRank(left);
    const rightPriority = goalPriorityRank(right);

    return rightPriority - leftPriority || rightNoProgress - leftNoProgress || left.createdAt.getTime() - right.createdAt.getTime();
  };
}

export function findEquivalentOpenPlanAction(
  context: NextWeekPlanContext,
  title: string,
  dueAt?: Date,
  dedupeKey?: string
): ActionItem | undefined {
  const key = normalizeManualActionTitleKey(title);
  const dueLocalDate = dueAt ? formatDateInTimezone(dueAt, context.timezone) : "";

  if (dedupeKey) {
    const semanticDuplicate = context.openActions.find((action) => weeklyPlanDedupeKeyForAction(action) === dedupeKey);

    if (semanticDuplicate) {
      return semanticDuplicate;
    }
  }

  return context.openActions.find((action) => {
    const actionKey = normalizeManualActionTitleKey(action.title);
    if (actionKey !== key) {
      return false;
    }

    const actionDate = action.dueAt ?? action.snoozedUntil;
    const actionDueDate = actionDate ? formatDateInTimezone(actionDate, context.timezone) : "";
    return !dueLocalDate || !actionDueDate || actionDueDate === dueLocalDate || Boolean(actionDate);
  });
}

export function inferWeeklyPlanDedupeKey(title: string, goalTitle?: string): string | undefined {
  const text = normalizeForComparison(`${title} ${goalTitle ?? ""}`);

  if (isGuardrailReviewPlanText(text)) {
    return "weekly_plan.guardrail_review";
  }

  if (/apply.*(developer|job)|developer.*job|job.*application|send.*cv|cv|resume/.test(text)) {
    return "weekly_plan.job_search_apply_3";
  }

  if (/youtube|script|channel|video/.test(text)) {
    return "weekly_plan.youtube_script_bullets";
  }

  if (/strength|training|workout|gym/.test(text)) {
    return "weekly_plan.strength_sessions";
  }

  if (/sleep.*cutoff|cutoff.*sleep/.test(text)) {
    return "weekly_plan.sleep_cutoff";
  }

  if (/read|reading|book/.test(text)) {
    return "weekly_plan.reading_20_min_3_days";
  }

  if (/car|vehicle|listings/.test(text)) {
    return "weekly_plan.car_listings_twice";
  }

  if (/review.*open.*actions|open.*actions.*finish/.test(text)) {
    return "weekly_plan.review_open_actions";
  }

  if (/gmail|email|mail|correo|correu/.test(text) && /review|pending|waiting|important|clear/.test(text)) {
    return "weekly_plan.email_reviews_cleanup";
  }

  if (/meaningful.*progress|progress.*action/.test(text)) {
    return "weekly_plan.progress_action";
  }

  if (/weekly.*review|review.*sunday/.test(text)) {
    return "weekly_plan.run_weekly_review";
  }

  return undefined;
}

export function weeklyPlanDedupeKeyForAction(action: ActionItem): string | undefined {
  const sourceId = action.sourceId ?? "";
  const sourceMatch = sourceId.match(/weekly-plan:[^:]+:(weekly_plan\.[a-z0-9_.-]+)/);

  if (sourceMatch) {
    return sourceMatch[1];
  }

  return inferWeeklyPlanDedupeKey([
    action.title,
    action.description ?? "",
    action.evidence ?? "",
    action.goalTitleSnapshot ?? ""
  ].join(" "));
}

export function isGuardrailReviewPlanText(text: string): boolean {
  return /review/.test(text) &&
    /guardrail|rules/.test(text) &&
    /betting|trading|risk|control impulsive betting|impulsive betting/.test(text);
}

export function summarizeNextWeekPlanContext(context: NextWeekPlanContext) {
  return {
    planningWindow: {
      kind: context.planWindowKind,
      start: context.planStartLocalDate,
      end: context.planEndLocalDate
    },
    latestWeeklyReview: context.latestWeeklyReview
      ? {
          id: context.latestWeeklyReview.id,
          weekStartLocalDate: context.latestWeeklyReview.weekStartLocalDate,
          reviewedEndLocalDate: context.latestWeeklyReview.reviewedEndLocalDate
        }
      : undefined,
    activeGoals: context.activeGoals.length,
    goalsWithNoProgress: context.goalsWithNoProgress.map((goal) => goal.title),
    openActions: context.openActions.length,
    staleActions: context.staleActions.length,
    activeReflections: context.activeReflections.length,
    futureActionsAlreadyScheduled: context.futureActionsNextWeek.length,
    emailAttention: context.emailAttention,
    guardrailGoals: context.guardrailGoals.map((goal) => goal.title),
    recentEventsSummary: context.recentEventsSummary
  };
}

export function formatNextWeekPlanContextDebug(context: NextWeekPlanContext): string {
  return [
    `${formatPlanTitle(context)} context:`,
    `planningWindow: ${context.planStartLocalDate} to ${context.planEndLocalDate}`,
    `latest weekly review: ${context.latestWeeklyReview ? `${context.latestWeeklyReview.id} (${context.latestWeeklyReview.weekStartLocalDate} to ${context.latestWeeklyReview.reviewedEndLocalDate})` : "none"}`,
    `active goals: ${context.activeGoals.length}`,
    `goals with no progress: ${context.goalsWithNoProgress.length}`,
    `open actions: ${context.openActions.length}`,
    `stale actions: ${context.staleActions.length}`,
    `Gmail reviews pending: ${context.emailAttention.pendingReviews}`,
    `Gmail reviews created this reviewed period: ${context.emailAttention.reviewsCreated}`,
    `Gmail-derived actions this reviewed period: ${context.emailAttention.gmailDerivedActionItems}`,
    `active reflections: ${context.activeReflections.length}`,
    `future actions already scheduled: ${context.futureActionsNextWeek.length}`,
    `guardrail goals: ${context.guardrailGoals.length}`,
    "events by type:",
    ...Object.entries(context.recentEventsSummary).slice(0, 10).map(([type, count]) => `- ${type}: ${count}`)
  ].join("\n");
}

export function formatNextWeekPlanMessage(context: NextWeekPlanContext, suggestions: NextWeekPlanSuggestion[]): string {
  const groups = groupPlanSuggestions(suggestions);
  return [
    formatPlanTitle(context),
    `Planning window: ${context.planStartLocalDate} to ${context.planEndLocalDate}`,
    "",
    "Needs cleanup:",
    ...formatPlanSuggestionGroup(groups.cleanup, context.timezone, "- None."),
    "",
    "Already scheduled:",
    ...formatPlanSuggestionGroup(groups.alreadyScheduled, context.timezone, "- None."),
    "",
    "Suggested new actions:",
    ...formatPlanSuggestionGroup(groups.newActions, context.timezone, "- None."),
    "",
    ...formatNextWeekPlanReplyExamples(suggestions)
  ].join("\n");
}

export function formatPlanTitle(context: NextWeekPlanContext): string {
  return context.planWindowKind === "current_week" ? "This week plan" : "Next week plan";
}

export function groupPlanSuggestions(suggestions: NextWeekPlanSuggestion[]) {
  return {
    cleanup: suggestions.filter((suggestion) => suggestion.planKind === "cleanup"),
    alreadyScheduled: suggestions.filter((suggestion) => suggestion.planKind !== "cleanup" && (suggestion.duplicateRisk || suggestion.existingActionId)),
    newActions: suggestions.filter((suggestion) => suggestion.planKind !== "cleanup" && !suggestion.duplicateRisk && !suggestion.existingActionId)
  };
}

export function formatPlanSuggestionGroup(suggestions: NextWeekPlanSuggestion[], timezone: string, emptyLine: string): string[] {
  return suggestions.length > 0
    ? suggestions.map((suggestion) => formatNextWeekPlanSuggestionLine(suggestion, timezone))
    : [emptyLine];
}

export async function replacePendingPlan(
  userId: string,
  context: NextWeekPlanContext,
  suggestions: NextWeekPlanSuggestion[],
  originalText: string
) {
  await replacePendingAction(userId, {
    type: "next_week_plan",
    summary: `${formatPlanTitle(context)} - ${context.planStartLocalDate} to ${context.planEndLocalDate}`,
    payload: {
      originalText,
      planWindowKind: context.planWindowKind,
      planStartLocalDate: context.planStartLocalDate,
      planEndLocalDate: context.planEndLocalDate,
      nextWeekStartLocalDate: context.planStartLocalDate,
      nextWeekEndLocalDate: context.planEndLocalDate,
      timezone: context.timezone,
      suggestions: suggestions.map(toPendingNextWeekPlanSuggestion)
    },
    expiresAt: pendingDecisionExpiry()
  });
}
export function parseNextWeekPlanReply(message: string):
  | { operation: "create"; all: true; indexes: number[] }
  | { operation: "create"; all: false; indexes: number[] }
  | { operation: "edit"; index: number; timeText: string }
  | { operation: "remove"; index: number }
  | { operation: "show" }
  | { operation: "skip" | "cancel" }
  | undefined {
  const originalTrimmed = message.trim();
  const trimmed = originalTrimmed.toLowerCase();

  if (/^(skip|cancel|no)$/i.test(trimmed)) {
    return { operation: trimmed === "no" ? "skip" : trimmed as "skip" | "cancel" };
  }

  if (/^show\s+plan$/i.test(trimmed)) {
    return { operation: "show" };
  }

  const edit = originalTrimmed.match(/^edit\s+(\d+)\s+to\s+(.+)$/i);
  if (edit) {
    return { operation: "edit", index: Number(edit[1]), timeText: edit[2].trim() };
  }

  const remove = trimmed.match(/^remove\s+(\d+)$/i);
  if (remove) {
    return { operation: "remove", index: Number(remove[1]) };
  }

  if (/^create\s+all(?:\s+new)?$/i.test(trimmed)) {
    return { operation: "create", all: true, indexes: [] };
  }

  const create = trimmed.match(/^create\s+(.+)$/i);
  if (create) {
    const indexes = [...create[1].matchAll(/\d+/g)].map((match) => Number(match[0])).filter((index) => index > 0);
    return indexes.length > 0 ? { operation: "create", all: false, indexes } : undefined;
  }

  return undefined;
}

export function readPendingNextWeekPlanSuggestions(value: unknown): NextWeekPlanSuggestion[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isRecord)
    .map((item): NextWeekPlanSuggestion | undefined => {
      const title = typeof item.title === "string" ? item.title : "";
      const reason = typeof item.reason === "string" ? item.reason : "";
      const suggestedDueAt = typeof item.suggestedDueAt === "string" ? new Date(item.suggestedDueAt) : undefined;

      if (!title || !reason || !suggestedDueAt || Number.isNaN(suggestedDueAt.getTime())) {
        return undefined;
      }

      return {
        index: typeof item.index === "number" ? item.index : 0,
        title,
        reason,
        goalId: typeof item.goalId === "string" ? item.goalId : undefined,
        goalTitle: typeof item.goalTitle === "string" ? item.goalTitle : undefined,
        priority: normalizePlanPriority(typeof item.priority === "string" ? item.priority : undefined),
        actionPriority: normalizePlanActionPriority(typeof item.actionPriority === "string" ? item.actionPriority : typeof item.priority === "string" ? item.priority : undefined),
        suggestedDueAt,
        actionType: "generic",
        source: "weekly_plan",
        duplicateRisk: item.duplicateRisk === true,
        existingActionId: typeof item.existingActionId === "string" ? item.existingActionId : undefined,
        existingActionTitle: typeof item.existingActionTitle === "string" ? item.existingActionTitle : undefined,
        planKind: item.planKind === "cleanup" ? "cleanup" : "action",
        creatable: item.creatable !== false,
        notCreatableReason: typeof item.notCreatableReason === "string" ? item.notCreatableReason : undefined,
        dedupeKey: typeof item.dedupeKey === "string" ? item.dedupeKey : inferWeeklyPlanDedupeKey(title, typeof item.goalTitle === "string" ? item.goalTitle : undefined)
      };
    })
    .filter(Boolean) as NextWeekPlanSuggestion[];
}

export function getPendingPlanStart(payload: Record<string, unknown>): string {
  return typeof payload.planStartLocalDate === "string"
    ? payload.planStartLocalDate
    : typeof payload.nextWeekStartLocalDate === "string"
      ? payload.nextWeekStartLocalDate
      : "";
}

export function getPendingPlanEnd(payload: Record<string, unknown>): string {
  return typeof payload.planEndLocalDate === "string"
    ? payload.planEndLocalDate
    : typeof payload.nextWeekEndLocalDate === "string"
      ? payload.nextWeekEndLocalDate
      : "";
}

export function actionInputFromPlanSuggestion(suggestion: NextWeekPlanSuggestion, payload: Record<string, unknown>): CreateActionItemInput {
  const weekStart = getPendingPlanStart(payload) || "unknown-week";
  const sourceKey = suggestion.dedupeKey ?? normalizeManualActionTitleKey(suggestion.title);
  return {
    source: "system",
    sourceId: `weekly-plan:${weekStart}:${sourceKey}`,
    sourceProvider: "weekly_plan",
    goalId: suggestion.goalId,
    goalTitleSnapshot: suggestion.goalTitle,
    title: suggestion.title,
    description: suggestion.reason,
    priority: suggestion.actionPriority ?? normalizePlanActionPriority(suggestion.priority),
    dueAt: suggestion.suggestedDueAt,
    actionType: "generic",
    evidence: `Weekly plan suggestion (${sourceKey}): ${suggestion.reason}`
  };
}

export function toPendingNextWeekPlanSuggestion(suggestion: NextWeekPlanSuggestion) {
  return {
    ...suggestion,
    suggestedDueAt: suggestion.suggestedDueAt.toISOString()
  };
}

export function formatPendingNextWeekPlan(timezone: string, payload: Record<string, unknown>, suggestions: NextWeekPlanSuggestion[]): string {
  const start = getPendingPlanStart(payload);
  const end = getPendingPlanEnd(payload);
  const title = payload.planWindowKind === "current_week" ? "This week plan" : "Next week plan";
  const groups = groupPlanSuggestions(suggestions);

  return [
    title,
    `Planning window: ${start} to ${end}`,
    "",
    "Needs cleanup:",
    ...formatPlanSuggestionGroup(groups.cleanup, timezone, "- None."),
    "",
    "Already scheduled:",
    ...formatPlanSuggestionGroup(groups.alreadyScheduled, timezone, "- None."),
    "",
    "Suggested new actions:",
    ...formatPlanSuggestionGroup(groups.newActions, timezone, "- None."),
    "",
    ...formatNextWeekPlanReplyExamples(suggestions)
  ].join("\n");
}

export function formatNextWeekPlanReplyExamples(suggestions: NextWeekPlanSuggestion[]): string[] {
  const creatable = suggestions.filter(isCreatableNewPlanSuggestion);

  if (creatable.length === 0) {
    return [
      "Reply:",
      "Nothing new to create.",
      "- run /action_hygiene to resolve cleanup",
      "- ask what should I do today",
      "- skip"
    ];
  }

  const first = creatable[0].index;
  const lines = [
    "Reply:",
    `- create ${first}`
  ];

  if (creatable.length > 1) {
    lines.push(`- create ${first} and ${creatable[1].index}`);
  }

  lines.push(
    "- create all new",
    "- skip",
    `- edit ${first} to Friday morning`
  );

  return lines;
}

export function isCreatableNewPlanSuggestion(suggestion: NextWeekPlanSuggestion): boolean {
  return suggestion.creatable !== false &&
    suggestion.planKind !== "cleanup" &&
    !suggestion.duplicateRisk &&
    !suggestion.existingActionId;
}

export function formatNextWeekPlanSuggestionLine(suggestion: NextWeekPlanSuggestion, timezone: string): string {
  const tags = [
    suggestion.planKind === "cleanup" ? "cleanup" : undefined,
    suggestion.duplicateRisk
      ? suggestion.planKind === "cleanup" && suggestion.dedupeKey === "weekly_plan.email_reviews_cleanup"
        ? "already waiting"
        : suggestion.planKind === "cleanup"
          ? "already open"
          : "already covered"
      : undefined,
    suggestion.creatable === false ? "not creatable" : undefined
  ].filter(Boolean).join(" - ");
  const suffix = tags ? ` - ${tags}` : "";
  const details = [
    `${suggestion.index}. ${suggestion.title} - action priority: ${suggestion.actionPriority ?? normalizePlanActionPriority(suggestion.priority)} - goal priority: ${suggestion.priority} - ${formatPlanDue(suggestion.suggestedDueAt, timezone)}${suffix}`,
    `   Reason: ${suggestion.reason}`
  ];

  if (suggestion.creatable === false) {
    details.push(`   Not creatable: ${suggestion.notCreatableReason ?? "Use /action_hygiene to complete, snooze, or archive the existing action."}`);
  }

  return details.join("\n");
}

export function formatSkippedNextWeekPlanSuggestion(suggestion: NextWeekPlanSuggestion): string {
  if (suggestion.dedupeKey === "weekly_plan.email_reviews_cleanup") {
    return `${suggestion.title} is already an email review inbox item. Say "email reviews" or "show me the important emails" to handle it.`;
  }

  if (suggestion.planKind === "cleanup" || suggestion.creatable === false) {
    return `${suggestion.title} is already an open action. Use /action_hygiene to complete, snooze, or archive it.`;
  }

  return `${suggestion.title} was skipped.`;
}

export function localPlanDate(context: Pick<NextWeekPlanContext, "planStartLocalDate" | "timezone">, dayOffset: number, minutes: number): Date {
  const date = addDaysToLocalDateString(context.planStartLocalDate, dayOffset);
  const start = localDateStartUtc(date, context.timezone);
  return new Date(start.getTime() + minutes * 60_000);
}

export function coercePlanDueAt(context: NextWeekPlanContext, dueAt: Date | undefined, fallbackDayOffset: number, fallbackMinutes: number): Date {
  if (dueAt && dueAt >= context.nextWeekRangeStart && dueAt < context.nextWeekRangeEnd) {
    return dueAt;
  }

  const fallback = localPlanDate(context, fallbackDayOffset, fallbackMinutes);
  if (fallback >= context.nextWeekRangeStart && fallback < context.nextWeekRangeEnd) {
    return fallback;
  }

  const endStart = localDateStartUtc(context.planEndLocalDate, context.timezone);
  const endFallback = new Date(endStart.getTime() + Math.min(fallbackMinutes, 18 * 60) * 60_000);
  return endFallback >= context.nextWeekRangeStart && endFallback < context.nextWeekRangeEnd
    ? endFallback
    : new Date(context.nextWeekRangeStart.getTime() + 9 * 60 * 60_000);
}

export function formatPlanDue(date: Date, timezone: string): string {
  const weekday = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, weekday: "short" }).format(date);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  return `${weekday} ${time}`;
}

export function normalizePlanPriority(value: unknown): NextWeekPlanSuggestion["priority"] {
  return value === "critical" || value === "high" || value === "medium" || value === "low" ? value : "medium";
}

export function normalizePlanActionPriority(value: unknown): NextWeekPlanSuggestion["actionPriority"] {
  return value === "high" || value === "critical"
    ? "high"
    : value === "low"
      ? "low"
      : "medium";
}

export function containsUnsafePlanAction(value: string): boolean {
  const text = value.toLowerCase();
  return /\b(place|open|make|take|size|enter|time|optimi[sz]e|justify)\s+(?:a\s+)?(?:bet|trade|long|short)\b/.test(text) ||
    /\b(?:bet|trade)\s+(?:small|later|with|if)\b/.test(text) ||
    /\b(?:20x|leverage|stop loss|entry|odds)\b/.test(text);
}

export type PlanningRequestKind = "next_week" | "current_week" | "ambiguous";

export function detectPlanningRequestKind(message: string): PlanningRequestKind | undefined {
  const text = message.trim().toLowerCase();

  if (!text) {
    return undefined;
  }

  if (
    /^(plan|make|create|build|generate)\s+(the\s+)?next\s+week(?:\s+(plan|actions))?$/.test(text) ||
    /^(make|create|build|generate)\s+next\s+week\s+actions$/.test(text) ||
    /^plan\s+the\s+next\s+week$/.test(text) ||
    /^create\s+a\s+plan\s+from\s+the\s+weekly\s+review$/.test(text)
  ) {
    return "next_week";
  }

  if (
    /^(plan|make|create|build|generate)\s+(my|this)\s+week(?:\s+plan)?$/.test(text) ||
    /^make\s+a\s+plan\s+for\s+this\s+week$/.test(text) ||
    /^what\s+should\s+i\s+focus\s+on\s+this\s+week$/.test(text)
  ) {
    return "current_week";
  }

  if (/^(make\s+a\s+plan|help\s+me\s+plan|what\s+should\s+i\s+plan)$/.test(text)) {
    return "ambiguous";
  }

  return undefined;
}

export function looksLikeNextWeekPlanRequest(message: string): boolean {
  return detectPlanningRequestKind(message) === "next_week";
}

export async function buildNextWeekPlanContext(
  userId: string,
  now: Date,
  timezone: string,
  planWindowKind: PlanWindowKind = "next_week"
): Promise<NextWeekPlanContext> {
  const currentLocalDate = formatDateInTimezone(now, timezone);
  const currentWeekStart = startOfLocalWeek(currentLocalDate);
  const currentWeekEnd = addDaysToLocalDateString(currentWeekStart, 6);
  const nextWeekStart = addDaysToLocalDateString(currentWeekStart, 7);
  const nextWeekEnd = addDaysToLocalDateString(nextWeekStart, 6);
  const planStartLocalDate = planWindowKind === "current_week" ? currentLocalDate : nextWeekStart;
  const planEndLocalDate = planWindowKind === "current_week" ? currentWeekEnd : nextWeekEnd;
  const planRangeStart = localDateStartUtc(planStartLocalDate, timezone);
  const planRangeEnd = localDateStartUtc(addDaysToLocalDateString(planEndLocalDate, 1), timezone);
  const weeklyContext = await buildWeeklyReviewContext(userId, undefined, timezone, now);
  const [latestWeeklyReview, allActions, activeMemories] = await Promise.all([
    getLatestWeeklyReview(userId),
    getActionItems(userId, { status: "all", limit: 300 }),
    getActiveMemories(userId)
  ]);
  const openActions = allActions.filter((action) => action.status === "open" || isSnoozedDue(action, now));
  const futureActionsNextWeek = openActions.filter((action) =>
    isDateInRange(action.dueAt, planRangeStart, planRangeEnd) ||
    isDateInRange(action.snoozedUntil, planRangeStart, planRangeEnd)
  );

  return {
    userId,
    timezone,
    now,
    planWindowKind,
    planStartLocalDate,
    planEndLocalDate,
    nextWeekStartLocalDate: planStartLocalDate,
    nextWeekEndLocalDate: planEndLocalDate,
    nextWeekRangeStart: planRangeStart,
    nextWeekRangeEnd: planRangeEnd,
    latestWeeklyReview,
    activeGoals: weeklyContext.activeGoals,
    goalsWithNoProgress: weeklyContext.goalsWithoutProgress,
    openActions,
    staleActions: weeklyContext.actionHygiene.suggestedCleanupCandidates,
    activeReflections: weeklyContext.activeReflections,
    recentEventsSummary: weeklyContext.eventsByType,
    guardrailGoals: weeklyContext.activeGoals.filter(isRiskControlGoal),
    guardrailEvents: weeklyContext.guardrailEvents,
    emailAttention: weeklyContext.emailAttention,
    futureActionsNextWeek,
    reviewedWeek: {
      weekStartLocalDate: weeklyContext.weekStartLocalDate,
      weekEndLocalDate: weeklyContext.weekEndLocalDate,
      reviewedEndLocalDate: weeklyContext.reviewedEndLocalDate
    }
  };
}

export async function resolveNextWeekPlanReply(userId: string, pendingAction: PendingAction, message: string): Promise<string | undefined> {
  const parsed = parseNextWeekPlanReply(message);

  if (!parsed) {
    return undefined;
  }

  if (parsed.operation === "skip" || parsed.operation === "cancel") {
    await rejectPendingAction(userId, pendingAction.id);
    return "Skipped next-week plan. No actions created.";
  }

  const timezone = typeof pendingAction.payload.timezone === "string" ? pendingAction.payload.timezone : await getUserTimezone(userId);
  const suggestions = readPendingNextWeekPlanSuggestions(pendingAction.payload.suggestions);

  if (parsed.operation === "show") {
    return formatPendingNextWeekPlan(timezone, pendingAction.payload, suggestions);
  }

  if (parsed.operation === "remove") {
    const kept = suggestions.filter((suggestion) => suggestion.index !== parsed.index)
      .map((suggestion, index) => ({ ...suggestion, index: index + 1 }));

    await replacePendingAction(userId, {
      type: "next_week_plan",
      summary: pendingAction.summary,
      payload: {
        ...pendingAction.payload,
        suggestions: kept.map(toPendingNextWeekPlanSuggestion)
      },
      expiresAt: pendingDecisionExpiry()
    });

    return formatPendingNextWeekPlan(timezone, pendingAction.payload, kept);
  }

  if (parsed.operation === "edit") {
    const suggestion = suggestions.find((item) => item.index === parsed.index);

    if (!suggestion) {
      return `No suggestion ${parsed.index}. Reply show plan to see the current list.`;
    }

    if (suggestion.creatable === false || suggestion.planKind === "cleanup") {
      return `Suggestion ${parsed.index} is cleanup for an existing action. I did not move it. Use /action_hygiene or say: move ${suggestion.existingActionTitle ?? suggestion.title} to ${parsed.timeText}.`;
    }

    if (suggestion.duplicateRisk || suggestion.existingActionId) {
      return `Suggestion ${parsed.index} is already covered by an existing action. I did not move it. To move the existing action, say: move ${suggestion.existingActionTitle ?? suggestion.title} to ${parsed.timeText}.`;
    }

    const planStart = getPendingPlanStart(pendingAction.payload);
    const planEnd = getPendingPlanEnd(pendingAction.payload);
    const parsedTime = parseActionDueDate(parsed.timeText, {
      now: localDateStartUtc(planStart, timezone),
      timezone,
      preferences: await getOrCreateNotificationSettings(userId)
    });
    const dueAt = parsedTime.dueAt;

    if (!dueAt || !planStart || !planEnd || dueAt < localDateStartUtc(planStart, timezone) || dueAt >= localDateStartUtc(addDaysToLocalDateString(planEnd, 1), timezone)) {
      return "That edit does not land inside the planning window. Try: edit 2 to Friday morning.";
    }

    const updated = suggestions.map((item) => item.index === parsed.index ? { ...item, suggestedDueAt: dueAt } : item);

    await replacePendingAction(userId, {
      type: "next_week_plan",
      summary: pendingAction.summary,
      payload: {
        ...pendingAction.payload,
        suggestions: updated.map(toPendingNextWeekPlanSuggestion)
      },
      expiresAt: pendingDecisionExpiry()
    });

    return `Updated suggestion ${parsed.index}: ${suggestion.title} -> ${formatPlanDue(dueAt, timezone)}.`;
  }

  if (parsed.operation === "create") {
    const selected = parsed.all ? suggestions : suggestions.filter((suggestion) => parsed.indexes.includes(suggestion.index));

    if (selected.length === 0) {
      return "No matching suggestions. Reply show plan to see the current list.";
    }

    const created: string[] = [];
    const covered: string[] = [];
    const skipped: string[] = [];
    const context = await buildNextWeekPlanContext(
      userId,
      new Date(),
      timezone,
      pendingAction.payload.planWindowKind === "current_week" ? "current_week" : "next_week"
    );

    for (const suggestion of selected) {
      if (suggestion.creatable === false || suggestion.planKind === "cleanup") {
        skipped.push(formatSkippedNextWeekPlanSuggestion(suggestion));
        continue;
      }

      const duplicate = findEquivalentOpenPlanAction(context, suggestion.title, suggestion.suggestedDueAt, suggestion.dedupeKey);

      if (duplicate || suggestion.duplicateRisk) {
        covered.push(`${suggestion.title}${duplicate?.title ? ` (${duplicate.title})` : ""}`);
        continue;
      }

      const actionInput = actionInputFromPlanSuggestion(suggestion, pendingAction.payload);
      const result = await createActionItemIfNotExists(userId, actionInput);

      if (result.created) {
        created.push(result.actionItem.title);
      } else {
        covered.push(result.actionItem.title);
      }
    }

    await confirmPendingAction(userId, pendingAction.id);

    return [
      skipped.length > 0 ? "Skipped:" : undefined,
      ...skipped.map((line) => `- ${line}`),
      created.length > 0 ? "Created actions:" : undefined,
      ...created.map((title) => `- ${title}`),
      covered.length > 0 ? "Already covered:" : undefined,
      ...covered.map((title) => `- ${title}`),
      created.length === 0 && covered.length === 0 ? "No actions created." : undefined
    ].filter(Boolean).join("\n");
  }

  return undefined;
}
