import {
  classifyDueWindow,
  getLocalTodayRange,
  isRiskControlGoal,
  isWithinLocalDay,
  normalizeManualActionTitleKey,
  sortDailyActionsByPriority,
  buildDeterministicDailyCoachResponse,
  DailyCoachValidationError,
  selectedDailyCoachActionTitle,
  type DailyBriefContext,
  type DailyPriorityScore,
  type Goal,
  type MemoryEntry,
  type StoredEvent
} from "@operator-agent/core";
import {
  getActionItems,
  getActiveGoals,
  getEmailReviewItems,
  getEmailSignalRules,
  getEventsBetween,
  getEventsSince,
  getOrCreateUserOperatingProfile,
  type ActionItem,
  type EmailReviewItem,
  type EmailSignalRule
} from "@operator-agent/db";
import { generateDailyCoachResponse } from "@operator-agent/llm";
import type {
  ActionHygieneReport,
  DailyCoachGenerationResult,
  DailyCoachSource,
  DailyOperatorBrief,
  DailyOperatorBriefAction,
  DailyOperatorBriefGoalStatus,
  OperatorAttentionItem,
  OperatorAttentionPriority,
  OperatorAttentionState,
  OperatorActionAttentionSummary,
  OperatorEmailAttentionSummary,
  OperatorGoalAttentionSummary,
  OperatorPlanningAttentionSummary,
  OperatorRiskAttentionSummary
} from "../server-types.js";
import { buildGmailAutonomyState, gmailSyncModeShortLabel } from "../conversation/gmail-autonomy.js";
import { getLatestWeeklyReview, shouldPromptWeeklyReview } from "../legacy/weekly-review-conversation.js";
import { analyzeActionHygiene, cleanupDecisionGrammar } from "../actions/hygiene-session.js";
import { addDaysToLocalDateString, formatDateInTimezone, formatLocalDateTime } from "../utils/datetime.js";
import { emailReviewKind, type EmailReviewKind } from "../utils/email-review.js";
import { isSnoozedDue } from "../utils/action-item.js";
import { getActiveOperatorReflections } from "../utils/memory.js";
import { normalizeForComparison, sharesMeaningfulToken } from "../utils/text.js";
import { uniqueStrings } from "../utils/arrays.js";
import { getUserTimezone } from "../utils/user-timezone.js";

/**
 * Legacy operator-attention/daily-brief cluster, extracted from
 * apps/api/src/server.ts. Builds the operator-attention state and daily
 * operator brief (start-day/end-day/tomorrow-prep messages, the daily coach,
 * and the underlying attention/priority/risk/goal summaries), for the daily
 * loop HTTP routes (backing several Telegram slash commands) and for the
 * legacy `handleConversationSurfaceIntent` natural-language surfaces
 * (today/attention/next-move/email-attention).
 *
 * `generateDailyOperatorBrief` reads active operator-reflection memories to
 * select one relevant reflection to surface in the brief. That read
 * (`getActiveOperatorReflections`) is shared with the operator-reflection
 * domain, which stays in server.ts, so it lives in
 * apps/api/src/utils/memory.ts instead of either side owning it — the same
 * de-duplication pattern already used there for `isOperatorReflectionMemory`.
 * `selectRelevantOperatorReflection` and `formatOperatorReflectionForBrief`
 * are exclusively used by `generateDailyOperatorBrief`, so they moved here
 * directly rather than staying in the operator-reflection block.
 */

export async function buildOperatorAttentionState(
  userId: string,
  now = new Date(),
  timezoneOverride?: string,
  prefetched: {
    actions?: ActionItem[];
    activeGoals?: Goal[];
    todayEvents?: StoredEvent[];
    recentEvents?: StoredEvent[];
    hygiene?: ActionHygieneReport;
  } = {}
): Promise<OperatorAttentionState> {
  const timezone = timezoneOverride ?? await getUserTimezone(userId);
  const todayRange = getLocalTodayRange(now, timezone);
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const [
    actions,
    activeGoals,
    todayEvents,
    recentEvents,
    pendingReviews,
    recentReviews,
    emailRules,
    gmailState,
    latestWeeklyReview
  ] = await Promise.all([
    prefetched.actions ? Promise.resolve(prefetched.actions) : getActionItems(userId, { status: "all", limit: 100 }),
    prefetched.activeGoals ? Promise.resolve(prefetched.activeGoals) : getActiveGoals(userId),
    prefetched.todayEvents ? Promise.resolve(prefetched.todayEvents) : getEventsBetween(userId, todayRange.start, todayRange.end),
    prefetched.recentEvents ? Promise.resolve(prefetched.recentEvents) : getEventsSince(userId, last24h),
    getEmailReviewItems(userId, { status: "pending", limit: 50 }),
    getEmailReviewItems(userId, { status: "all", limit: 50 }),
    getEmailSignalRules(userId),
    buildGmailAutonomyState(userId),
    getLatestWeeklyReview(userId)
  ]);
  const visibleActions = actions.filter((action) => action.status !== "archived");
  const openActions = visibleActions.filter((action) => action.status === "open" || isSnoozedDue(action, now));
  const overdueActions = openActions.filter((action) => action.dueAt && action.dueAt < now);
  const dueSoonActions = openActions.filter((action) => isActionDueSoon(action, now));
  const completedToday = visibleActions.filter((action) => action.status === "completed" && isWithinLocalDay(action.completedAt, todayRange));
  const goalStatusesToday = activeGoals.map((goal) => buildGoalStatusToday(goal, todayEvents, openActions, completedToday));
  const rankedOpenActions = sortDailyActionsByPriority(openActions, {
    goals: activeGoals,
    goalStatuses: goalStatusesToday,
    recentEvents,
    guardrailContext: {
      hardGuardrailTriggeredToday: todayEvents.some((event) => event.type === "finance.betting.cooldown_triggered")
    },
    now,
    timezone
  });
  const hygiene = prefetched.hygiene ?? await analyzeActionHygiene(userId, now, timezone);
  const ruleById = new Map(emailRules.map((rule) => [rule.id, rule]));
  const emailAttention = buildOperatorEmailAttentionSummary({
    pendingReviews,
    todayReviews: recentReviews.filter((review) => isWithinLocalDay(review.reviewedAt, todayRange)),
    todayEvents,
    actions: visibleActions,
    activeGoals,
    ruleById,
    todayRange,
    gmailSyncMode: gmailSyncModeShortLabel(gmailState),
    reviewNotificationEnabled: gmailState.reviewNotificationEnabled
  });
  const risks = uniqueStrings([...buildOperatorRisks(recentEvents), ...buildOperatorGuardrailWatchouts(activeGoals)]);
  const goalStatus = activeGoals.map((goal) => buildOperatorGoalStatus(goal, todayEvents, openActions, completedToday));
  const actionAttention = buildOperatorActionAttentionSummary({
    openActions,
    overdueActions,
    dueSoonActions,
    rankedOpenActions,
    hygiene
  });
  const goalAttention = buildOperatorGoalAttentionSummary(goalStatus, activeGoals);
  const riskAttention = buildOperatorRiskAttentionSummary(risks, todayEvents);
  const planningAttention = {
    weeklyReviewDue: await shouldPromptWeeklyReview(userId, now, timezone),
    latestWeeklyReviewDate: latestWeeklyReview?.reviewedEndLocalDate,
    summary: latestWeeklyReview
      ? `Latest weekly review covers ${latestWeeklyReview.weekStartLocalDate} to ${latestWeeklyReview.reviewedEndLocalDate}.`
      : "No saved weekly review yet."
  };
  const topAttentionItems = buildTopOperatorAttentionItems({
    rankedOpenActions,
    overdueActions,
    emailAttention,
    risks,
    hygiene,
    planningAttention
  });
  const recommendedNextMove = pickAttentionNextMove(topAttentionItems, {
    rankedOpenActions,
    overdueActions,
    emailAttention,
    goalStatus,
    now
  });

  return {
    userId,
    date: todayRange.date,
    timezone,
    topAttentionItems,
    recommendedNextMove,
    emailAttentionSummary: emailAttention,
    actionAttentionSummary: actionAttention,
    goalAttentionSummary: goalAttention,
    riskAttentionSummary: riskAttention,
    planningAttentionSummary: planningAttention,
    suggestedUserReplies: buildOperatorSuggestedReplies(emailAttention),
    confidence: topAttentionItems.length > 0 ? 0.88 : 0.72,
    reasoning: [
      `${openActions.length} open action${openActions.length === 1 ? "" : "s"}`,
      `${overdueActions.length} overdue action${overdueActions.length === 1 ? "" : "s"}`,
      `${emailAttention.pendingCount} pending Gmail review${emailAttention.pendingCount === 1 ? "" : "s"}`,
      `${risks.length} risk watchout${risks.length === 1 ? "" : "s"}`
    ]
  };
}

export async function generateDailyOperatorBrief(userId: string, options: { now?: Date } = {}): Promise<DailyOperatorBrief> {
  const now = options.now ?? new Date();
  const timezone = await getUserTimezone(userId);
  const todayRange = getLocalTodayRange(now, timezone);
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const [actions, activeGoals, todayEvents, recentEvents, recentReviews, userOperatingProfile] = await Promise.all([
    getActionItems(userId, { status: "all", limit: 100 }),
    getActiveGoals(userId),
    getEventsBetween(userId, todayRange.start, todayRange.end),
    getEventsSince(userId, last24h),
    getEmailReviewItems(userId, { status: "all", limit: 10 }),
    getOrCreateUserOperatingProfile(userId)
  ]);
  const visibleActions = actions.filter((action) => action.status !== "archived");
  const openActions = visibleActions.filter((action) => action.status === "open" || isSnoozedDue(action, now));
  const overdueActions = openActions.filter((action) => action.dueAt && action.dueAt < now);
  const dueSoonActions = openActions.filter((action) => isActionDueSoon(action, now));
  const completedToday = visibleActions.filter(
    (action) => action.status === "completed" && isWithinLocalDay(action.completedAt, todayRange)
  );
  const goalStatusesToday = activeGoals.map((goal) => buildGoalStatusToday(goal, todayEvents, openActions, completedToday));
  const guardrailContext = {
    hardGuardrailTriggeredToday: todayEvents.some((event) => event.type === "finance.betting.cooldown_triggered")
  };
  const rankedOpenActions = sortDailyActionsByPriority(openActions, {
    goals: activeGoals,
    goalStatuses: goalStatusesToday,
    recentEvents,
    guardrailContext,
    now,
    timezone
  });
  const rankedActions = rankedOpenActions.map((item) => item.action);
  const priorityDebug = rankedOpenActions.map((item, index) => ({
    rank: index + 1,
    actionId: item.action.id,
    title: item.action.title,
    score: item.score.score,
    rankReason: uniqueStrings(item.score.factors).join(", "),
    factors: uniqueStrings(item.score.factors)
  }));
  const goalStatus = activeGoals.map((goal) => buildOperatorGoalStatus(goal, todayEvents, rankedActions, completedToday));
  const recentWins = buildOperatorRecentWins(todayEvents, completedToday, recentReviews, todayRange);
  const risks = uniqueStrings([...buildOperatorRisks(recentEvents), ...buildOperatorGuardrailWatchouts(activeGoals)]);
  const hygiene = await analyzeActionHygiene(userId, now, timezone);
  const attention = await buildOperatorAttentionState(userId, now, timezone, {
    actions,
    activeGoals,
    todayEvents,
    recentEvents,
    hygiene
  });
  const topPriorities = buildOperatorTopPriorities({
    overdueActions,
    dueSoonActions,
    openActions: rankedActions,
    goalStatus,
    risks,
    emailAttention: attention.emailAttentionSummary,
    priorityScores: rankedOpenActions.map((item) => item.score)
  });
  const suggestedNextStep = attention.topAttentionItems[0]?.kind === "risk" && rankedActions.length > 0
    ? pickOperatorNextStep({
        overdueActions,
        dueSoonActions,
        openActions: rankedActions,
        goalStatus,
        emailAttention: attention.emailAttentionSummary,
        now
      })
    : attention.recommendedNextMove;
  const briefContext = buildDailyBriefContext({
    date: todayRange.date,
    timezone,
    activeGoals,
    goalStatus,
    rankedOpenActions,
    recentWins,
    risks,
    suggestedNextStep,
    userOperatingProfile,
    todayEvents,
    completedToday
  });
  const coachResult = await maybeGenerateDailyCoach(briefContext);
  const briefOpenActions = rankedActions.slice(0, 10).map(toBriefAction);
  const activeReflections = await getActiveOperatorReflections(userId);
  const operatorReflection = selectRelevantOperatorReflection(activeReflections, {
    openActions: briefOpenActions,
    topPriorities
  });
  const weeklyReviewDue = await shouldPromptWeeklyReview(userId, now, timezone);

  return {
    date: todayRange.date,
    summary: buildOperatorSummary({ openActions, overdueActions, activeGoals, todayEvents, risks, emailAttention: attention.emailAttentionSummary }),
    coach: coachResult.coach,
    coachDebug: coachResult.debug,
    topPriorities,
    openActions: briefOpenActions,
    overdueActions: overdueActions.slice(0, 10).map(toBriefAction),
    goalStatus,
    recentWins,
    risks,
    emailAttention: attention.emailAttentionSummary.pendingCount > 0 || attention.emailAttentionSummary.handledTodayCount > 0
      ? attention.emailAttentionSummary
      : undefined,
    actionHygiene: hygiene.suggestedCleanupCandidates.length > 0 ? {
      summary: hygiene.summary,
      needsDecision: hygiene.suggestedCleanupCandidates.length
    } : undefined,
    operatorReflection: operatorReflection ? formatOperatorReflectionForBrief(operatorReflection) : undefined,
    weeklyReviewDue,
    suggestedNextStep,
    priorityDebug
  };
}

export async function buildStartDayMessage(userId: string, now: Date): Promise<string> {
  const brief = await generateDailyOperatorBrief(userId, { now });
  const timezone = await getUserTimezone(userId);
  const topAction = firstRealPriority(brief);
  const overdue = brief.overdueActions.slice(0, 3).map((action) => action.title);
  const overdueIds = new Set(brief.overdueActions.map((action) => action.id));
  const alsoToday = brief.openActions
    .filter((action) => action.title !== topAction)
    .filter((action) => !overdueIds.has(action.id))
    .filter((action) => classifyDueWindow(action.dueAt ? new Date(action.dueAt) : undefined, now, timezone).startsWith("due today"))
    .slice(0, 3)
    .map((action) => action.title);
  const guardrail = brief.risks.find((risk) => /risk-control|guardrail|betting|trading|impulsive/i.test(risk));
  const hygiene = brief.actionHygiene;
  const emailAttention = brief.emailAttention && brief.emailAttention.pendingCount > 0
    ? `Email: ${brief.emailAttention.summary} Say "email reviews" to handle them.`
    : undefined;

  return [
    `Today - ${brief.date}`,
    `First move: ${topAction ?? "Log one meaningful action."}`,
    overdue.length > 0 ? `Overdue: ${overdue.join(", ")}.` : undefined,
    alsoToday.length > 0 ? `Also today: ${alsoToday.join(", ")}.` : undefined,
    emailAttention,
    hygiene ? `Hygiene: ${cleanupDecisionGrammar(hygiene.needsDecision)} Run /action_hygiene.` : undefined,
    brief.weeklyReviewDue ? "Weekly review due. Run /weekly." : undefined,
    brief.operatorReflection ? `Pattern: ${brief.operatorReflection}` : undefined,
    guardrail ? `Guardrail: ${formatLoopGuardrail(guardrail)}` : undefined,
    "Reply naturally with updates."
  ]
    .filter(Boolean)
    .join("\n");
}

export async function buildEndDayMessage(userId: string, now: Date): Promise<string> {
  const brief = await generateDailyOperatorBrief(userId, { now });
  const completed = brief.recentWins.filter((win) => !/email review/i.test(win)).slice(0, 5);
  const hygiene = brief.actionHygiene;
  const emailAttention = brief.emailAttention;
  const stillOpen = [...brief.overdueActions, ...brief.openActions]
    .filter((action, index, actions) => actions.findIndex((item) => item.id === action.id) === index)
    .slice(0, 5)
    .map((action) => `${action.title}${action.dueAt && new Date(action.dueAt) < now ? " overdue" : action.dueAt ? ` due ${formatLocalDateTime(new Date(action.dueAt))}` : ""}`);

  return [
    "Evening review:",
    "Completed today:",
    completed.length > 0 ? completed.map((item) => `- ${item}`).join("\n") : "- Nothing completed is logged yet.",
    "",
    "Still open:",
    stillOpen.length > 0 ? stillOpen.map((item) => `- ${item}`).join("\n") : "- No open action items.",
    emailAttention && (emailAttention.pendingCount > 0 || emailAttention.handledTodayCount > 0)
      ? [
          "\nEmail signals:",
          emailAttention.handledTodayCount > 0 ? `- ${emailAttention.handledTodayCount} Gmail review${emailAttention.handledTodayCount === 1 ? "" : "s"} handled today.` : undefined,
          emailAttention.gmailDerivedActionItemsToday > 0 ? `- ${emailAttention.gmailDerivedActionItemsToday} Gmail-derived action item${emailAttention.gmailDerivedActionItemsToday === 1 ? "" : "s"} created today.` : undefined,
          emailAttention.gmailDerivedEventsToday > 0 ? `- ${emailAttention.gmailDerivedEventsToday} Gmail-derived event${emailAttention.gmailDerivedEventsToday === 1 ? "" : "s"} logged today.` : undefined,
          emailAttention.pendingCount > 0 ? `- ${emailAttention.pendingCount} Gmail review${emailAttention.pendingCount === 1 ? "" : "s"} still waiting.` : undefined
        ].filter(Boolean).join("\n")
      : undefined,
    hygiene ? "\nCleanup:\nReview overdue actions before tomorrow: /action_hygiene" : undefined,
    "",
    "Reply with what happened, what moved, or what to drop.",
    'Example: trained 30 min, move homepage to tomorrow morning.'
  ].join("\n");
}

export async function buildTomorrowPrepMessage(userId: string, now: Date): Promise<string> {
  const timezone = await getUserTimezone(userId);
  const tomorrow = addDaysToLocalDateString(getLocalTodayRange(now, timezone).date, 1);
  const [actions, activeGoals, brief] = await Promise.all([
    getActionItems(userId, { status: "all", limit: 100 }),
    getActiveGoals(userId),
    generateDailyOperatorBrief(userId, { now })
  ]);
  const tomorrowActions = actions
    .filter((action) => (action.status === "open" || action.status === "snoozed") && action.dueAt && formatDateInTimezone(action.dueAt, timezone) === tomorrow)
    .slice(0, 10);
  const gaps = brief.goalStatus
    .filter((goal) => !isRiskControlGoalStatus(goal) && /no progress logged/i.test(goal.note))
    .slice(0, 3)
    .map((goal) => goal.title);
  const firstMove = tomorrowActions[0]?.title ?? gaps[0] ?? activeGoals.find((goal) => !isRiskControlGoal(goal))?.title;

  return [
    `Tomorrow - ${tomorrow}`,
    "Actions due tomorrow:",
    tomorrowActions.length > 0 ? tomorrowActions.map((action) => `- ${action.title}`).join("\n") : "- No actions due tomorrow.",
    "",
    "Goal gaps:",
    gaps.length > 0 ? gaps.map((gap) => `- ${gap}`).join("\n") : "- No obvious goal gaps from today's logs.",
    "",
    `Suggested first move tomorrow: ${firstMove ? firstMove : "Log one meaningful action."}`
  ].join("\n");
}

export async function dailyLoopStateInput(userId: string, now: Date): Promise<{ localDate: string; timezone: string; sentAt: Date }> {
  const timezone = await getUserTimezone(userId);
  const today = getLocalTodayRange(now, timezone);

  return {
    localDate: today.date,
    timezone,
    sentAt: now
  };
}

function firstRealPriority(brief: DailyOperatorBrief): string | undefined {
  const openTitles = new Set(brief.openActions.map((action) => action.title));
  const priority = brief.topPriorities.find((item) => {
    const normalized = item.replace(/^Due soon:\s*/i, "").replace(/^Overdue:\s*/i, "").trim();
    return openTitles.has(normalized);
  });

  return priority?.replace(/^Due soon:\s*/i, "").replace(/^Overdue:\s*/i, "").trim() ?? brief.openActions[0]?.title;
}

function formatLoopGuardrail(risk: string): string {
  const match = risk.match(/Risk-control goal active:\s*(.+?)\./i);
  return match ? `Keep ${match[1]} locked today.` : risk;
}

function buildOperatorSummary(input: {
  openActions: ActionItem[];
  overdueActions: ActionItem[];
  activeGoals: Awaited<ReturnType<typeof getActiveGoals>>;
  todayEvents: StoredEvent[];
  risks: string[];
  emailAttention?: OperatorEmailAttentionSummary;
}): string {
  const parts = [
    `${input.openActions.length} open action${input.openActions.length === 1 ? "" : "s"}`,
    input.overdueActions.length > 0 ? `${input.overdueActions.length} overdue` : undefined,
    `${input.activeGoals.length} active goal${input.activeGoals.length === 1 ? "" : "s"}`,
    `${input.todayEvents.length} event${input.todayEvents.length === 1 ? "" : "s"} logged today`,
    input.emailAttention && input.emailAttention.pendingCount > 0
      ? `${input.emailAttention.pendingCount} Gmail review${input.emailAttention.pendingCount === 1 ? "" : "s"} waiting`
      : undefined,
    input.risks.length > 0 ? `${input.risks.length} risk watchout${input.risks.length === 1 ? "" : "s"}` : undefined
  ].filter(Boolean);

  return parts.length > 0 ? `Today has ${parts.join(", ")}.` : "Nothing material is logged for today yet.";
}

function buildDailyBriefContext(input: {
  date: string;
  timezone: string;
  activeGoals: Awaited<ReturnType<typeof getActiveGoals>>;
  goalStatus: DailyOperatorBriefGoalStatus[];
  rankedOpenActions: Array<{ action: ActionItem; score: DailyPriorityScore }>;
  recentWins: string[];
  risks: string[];
  suggestedNextStep: string;
  userOperatingProfile: Awaited<ReturnType<typeof getOrCreateUserOperatingProfile>>;
  todayEvents: StoredEvent[];
  completedToday: ActionItem[];
}): DailyBriefContext {
  const goalStatusById = new Map(input.goalStatus.map((goal) => [goal.goalId, goal]));

  return {
    date: input.date,
    timezone: input.timezone,
    activeGoals: input.activeGoals.map((goal) => {
      const status = goalStatusById.get(goal.id);
      const openLinkedActions = input.rankedOpenActions
        .map((item) => item.action)
        .filter((action) => action.goalId === goal.id)
        .map((action) => action.title);
      const completedLinkedActionsToday = input.completedToday
        .filter((action) => action.goalId === goal.id)
        .map((action) => action.title);

      return {
        id: goal.id,
        title: goal.title,
        priority: goal.priority,
        importanceScore: goal.importanceScore,
        statusToday: status?.note ?? "no progress logged today",
        openLinkedActions,
        completedLinkedActionsToday,
        guardrailActivityToday: input.todayEvents
          .filter((event) => event.type === "finance.betting.cooldown_triggered" && goal.id === event.data.goalId)
          .map((event) => event.type)
      };
    }),
    scoredPriorities: input.rankedOpenActions.slice(0, 10).map((item) => {
      const linkedGoal = input.activeGoals.find((goal) => goal.id === item.action.goalId);

      return {
        actionId: item.action.id,
        title: item.action.title,
        dueAt: item.action.dueAt?.toISOString(),
        dueLabel: dueLabelFromPriorityScore(item.score),
        score: item.score.score,
        rankReason: item.score.rankReason,
        linkedGoalTitle: linkedGoal?.title ?? item.action.goalTitleSnapshot,
        linkedGoalPriority: linkedGoal?.priority
      };
    }),
    recentWins: input.recentWins,
    risksOrWatchouts: input.risks,
    nextMove: input.suggestedNextStep,
    userOperatingProfile: {
      directness: input.userOperatingProfile.directness,
      warmth: input.userOperatingProfile.warmth,
      confrontation: input.userOperatingProfile.confrontation,
      verbosity: input.userOperatingProfile.verbosity,
      preferredStyle: input.userOperatingProfile.motivationalStyle
    }
  };
}

async function maybeGenerateDailyCoach(context: DailyBriefContext): Promise<DailyCoachGenerationResult> {
  const fallback = buildDeterministicDailyCoachResponse(context);

  if (!shouldUseDailyCoachLLM()) {
    return {
      coach: fallback,
      debug: {
        source: "fallback_disabled",
        llmAttempted: false,
        validationStatus: "skipped",
        validationFailureCodes: [],
        schemaValidationPassed: true,
        fallbackReason: "DAILY_COACH_LLM_ENABLED is not true or OPENAI_API_KEY is missing",
        selectedActionTitle: selectedDailyCoachActionTitle(context)
      }
    };
  }

  try {
    const coach = await withDailyCoachTimeout(generateDailyCoachResponse(context));

    return {
      coach,
      debug: {
        source: "llm",
        llmAttempted: true,
        validationStatus: "passed",
        validationFailureCodes: [],
        schemaValidationPassed: true,
        selectedActionTitle: selectedDailyCoachActionTitle(context)
      }
    };
  } catch (error) {
    console.warn("OpenAI daily coach failed; using deterministic coach.");
    const source = dailyCoachFallbackSource(error);

    return {
      coach: fallback,
      debug: {
        source,
        llmAttempted: true,
        validationStatus: source === "fallback_timeout" || source === "fallback_error" ? "skipped" : "failed",
        validationFailureCodes: dailyCoachValidationFailureCodes(error),
        validationFailureSummary: dailyCoachValidationFailureSummary(error, source),
        schemaValidationPassed: false,
        fallbackReason: dailyCoachFallbackReason(source),
        selectedActionTitle: selectedDailyCoachActionTitle(context),
        rawResponseType: error instanceof DailyCoachValidationError ? error.details.rawResponseType : undefined,
        parsedFieldsPresent: error instanceof DailyCoachValidationError ? error.details.parsedFieldsPresent : undefined,
        responseLength: error instanceof DailyCoachValidationError ? error.details.responseLength : undefined,
        diagnosisLength: error instanceof DailyCoachValidationError ? error.details.diagnosisLength : undefined,
        nextMoveLength: error instanceof DailyCoachValidationError ? error.details.nextMoveLength : undefined,
        warningLength: error instanceof DailyCoachValidationError ? error.details.warningLength : undefined,
        encouragementLength: error instanceof DailyCoachValidationError ? error.details.encouragementLength : undefined
      }
    };
  }
}

export function shouldUseDailyCoachLLM(): boolean {
  return process.env.DAILY_COACH_LLM_ENABLED === "true" && Boolean(process.env.OPENAI_API_KEY);
}

async function withDailyCoachTimeout<T>(promise: Promise<T>): Promise<T> {
  const parsedTimeoutMs = Number(process.env.DAILY_COACH_LLM_TIMEOUT_MS ?? 3000);
  const timeoutMs = Number.isFinite(parsedTimeoutMs) ? parsedTimeoutMs : 3000;

  return await Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new DailyCoachTimeoutError()), Math.max(1, timeoutMs));
    })
  ]);
}

function dailyCoachFallbackSource(error: unknown): DailyCoachSource {
  if (error instanceof DailyCoachTimeoutError) {
    return "fallback_timeout";
  }

  if (error instanceof SyntaxError || (error && typeof error === "object" && "name" in error && error.name === "ZodError")) {
    return "fallback_invalid";
  }

  if (error instanceof DailyCoachValidationError) {
    return "fallback_invalid";
  }

  const message = error instanceof Error ? error.message : "";

  if (/invalid|validation|unsupported|changed deterministic next move|too long|betting\/trading advice/i.test(message)) {
    return "fallback_invalid";
  }

  return "fallback_error";
}

function dailyCoachValidationFailureCodes(error: unknown): string[] {
  if (error instanceof DailyCoachValidationError) {
    return error.failureCodes;
  }

  if (error instanceof SyntaxError) {
    return ["invalid_json"];
  }

  if (error && typeof error === "object" && "name" in error && error.name === "ZodError") {
    return ["schema_invalid"];
  }

  return [];
}

function dailyCoachValidationFailureSummary(error: unknown, source: DailyCoachSource): string | undefined {
  const codes = dailyCoachValidationFailureCodes(error);

  if (codes.length > 0) {
    return codes.join(", ");
  }

  if (source === "fallback_timeout") {
    return "timeout";
  }

  if (source === "fallback_error") {
    return "request_error";
  }

  return undefined;
}

function dailyCoachFallbackReason(source: DailyCoachSource): string {
  if (source === "fallback_invalid") {
    return "LLM response failed schema or policy validation";
  }

  if (source === "fallback_timeout") {
    return "LLM response timed out";
  }

  if (source === "fallback_error") {
    return "LLM request failed";
  }

  if (source === "fallback_disabled") {
    return "DAILY_COACH_LLM_ENABLED is not true or OPENAI_API_KEY is missing";
  }

  return "";
}

class DailyCoachTimeoutError extends Error {
  constructor() {
    super("Daily coach LLM timed out.");
  }
}

function selectRelevantOperatorReflection(reflections: MemoryEntry[], brief: { openActions: DailyOperatorBriefAction[]; topPriorities: string[] }): MemoryEntry | undefined {
  const topText = normalizeForComparison([brief.openActions[0]?.title, brief.topPriorities[0]].filter(Boolean).join(" "));

  return reflections.find((reflection) => {
    const title = typeof reflection.data?.title === "string" ? reflection.data.title : reflection.summary;
    return sharesMeaningfulToken(topText, normalizeForComparison(`${title} ${reflection.summary}`));
  }) ?? reflections[0];
}

function formatOperatorReflectionForBrief(reflection: MemoryEntry): string {
  const title = typeof reflection.data?.title === "string" ? reflection.data.title : reflection.summary;
  return `${title}.`;
}

export function formatConversationTodayReply(brief: DailyOperatorBrief): string {
  return [
    `Today - ${brief.date}`,
    "",
    "Status:",
    brief.summary,
    "",
    "Top priorities:",
    brief.topPriorities.length > 0 ? brief.topPriorities.map((item, index) => `${index + 1}. ${item}`).join("\n") : "No clear priorities yet.",
    brief.emailAttention && brief.emailAttention.pendingCount > 0 ? `\nGmail:\n- ${brief.emailAttention.summary} Say "show me the important emails" to inspect them.` : undefined,
    brief.actionHygiene ? `\nAction hygiene:\n- ${cleanupDecisionGrammar(brief.actionHygiene.needsDecision)} Run /action_hygiene.` : undefined,
    brief.weeklyReviewDue ? "\nWeekly review:\n- Weekly review due. Run /weekly." : undefined,
    brief.operatorReflection ? `\nPattern:\n${brief.operatorReflection}` : undefined,
    "",
    "Next move:",
    brief.suggestedNextStep
  ].join("\n");
}

export function formatOperatorAttentionForConversation(state: OperatorAttentionState): string {
  if (state.topAttentionItems.length === 0) {
    return [
      "Nothing urgent is standing out.",
      state.actionAttentionSummary.summary,
      state.emailAttentionSummary.pendingCount > 0 ? state.emailAttentionSummary.summary : "No Gmail reviews are waiting.",
      "",
      `Next move: ${state.recommendedNextMove}`
    ].join("\n");
  }

  return [
    "What needs attention:",
    ...state.topAttentionItems.slice(0, 4).map((item, index) => `${index + 1}. ${item.title} - ${item.summary}`),
    state.emailAttentionSummary.pendingCount > 0 ? `\nGmail: ${state.emailAttentionSummary.summary}` : undefined,
    "",
    `Next move: ${state.recommendedNextMove}`,
    state.suggestedUserReplies.length > 0 ? `You can say: ${state.suggestedUserReplies.slice(0, 3).join(" / ")}` : undefined
  ].filter(Boolean).join("\n");
}

export function formatOperatorNextMoveForConversation(state: OperatorAttentionState): string {
  const top = state.topAttentionItems[0];

  return [
    `First: ${state.recommendedNextMove}`,
    top ? `Why: ${top.summary}` : undefined,
    state.emailAttentionSummary.pendingCount > 0 ? `Gmail waiting: ${state.emailAttentionSummary.summary}` : undefined
  ].filter(Boolean).join("\n");
}

export function formatEmailAttentionForConversation(state: OperatorAttentionState): string {
  const email = state.emailAttentionSummary;

  if (email.pendingCount === 0) {
    return [
      "No Gmail reviews are waiting.",
      email.handledTodayCount > 0
        ? `${email.handledTodayCount} Gmail review${email.handledTodayCount === 1 ? "" : "s"} handled today.`
        : undefined,
      `Mode: ${email.syncMode}. Review notifications: ${email.notificationPreference}.`,
      "Alecto cannot reply to emails or change Gmail labels."
    ].filter(Boolean).join("\n");
  }

  const lines = [
    `${email.pendingCount} Gmail review${email.pendingCount === 1 ? "" : "s"} need attention.`,
    email.workActionCount > 0 ? `- ${email.workActionCount} work-action email${email.workActionCount === 1 ? "" : "s"} may become task${email.workActionCount === 1 ? "" : "s"}.` : undefined,
    email.jobSearchCount > 0 ? `- ${email.jobSearchCount} job-search email${email.jobSearchCount === 1 ? "" : "s"} waiting.` : undefined,
    email.customCount > 0 ? `- ${email.customCount} custom tracking item${email.customCount === 1 ? "" : "s"} waiting.` : undefined,
    email.otherCount > 0 ? `- ${email.otherCount} other email review${email.otherCount === 1 ? "" : "s"} waiting.` : undefined,
    email.topReviewSubjects.length > 0 ? `Examples: ${email.topReviewSubjects.join("; ")}` : undefined,
    "",
    'Say "email reviews" or "show me the important emails" to inspect them.',
    "Alecto cannot reply to emails or change Gmail labels."
  ];

  return lines.filter(Boolean).join("\n");
}

function dueLabelFromPriorityScore(score: DailyPriorityScore): string {
  return (
    score.factors.find((factor) => factor === "overdue" || factor.startsWith("due today") || factor.startsWith("due tomorrow") || factor === "due later this week") ??
    "not due"
  );
}

function buildOperatorEmailAttentionSummary(input: {
  pendingReviews: EmailReviewItem[];
  todayReviews: EmailReviewItem[];
  todayEvents: StoredEvent[];
  actions: ActionItem[];
  activeGoals: Goal[];
  ruleById: Map<string, EmailSignalRule>;
  todayRange: ReturnType<typeof getLocalTodayRange>;
  gmailSyncMode: string;
  reviewNotificationEnabled: boolean;
}): OperatorEmailAttentionSummary {
  const pendingByKind = input.pendingReviews.reduce(
    (counts, review) => {
      const kind = emailReviewKind(review);
      counts[kind] += 1;
      return counts;
    },
    { job_search: 0, work_action: 0, custom_tracking: 0, other: 0 } as Record<EmailReviewKind, number>
  );
  const approvedToday = input.todayReviews.filter((review) => review.status === "approved").length;
  const rejectedToday = input.todayReviews.filter((review) => review.status === "rejected").length;
  const pendingCount = input.pendingReviews.length;
  const hasCareerGoal = input.activeGoals.some((goal) => /career|job|developer/i.test(`${goal.title} ${goal.category} ${goal.templateId ?? ""}`));
  const priority: OperatorAttentionPriority =
    pendingByKind.work_action > 0 || (pendingByKind.job_search > 0 && hasCareerGoal)
      ? "high"
      : pendingByKind.job_search > 0 || pendingByKind.custom_tracking > 0
        ? "medium"
        : "low";
  const parts = [
    pendingByKind.work_action > 0 ? `${pendingByKind.work_action} work-action` : undefined,
    pendingByKind.job_search > 0 ? `${pendingByKind.job_search} job-search` : undefined,
    pendingByKind.custom_tracking > 0 ? `${pendingByKind.custom_tracking} custom tracking` : undefined,
    pendingByKind.other > 0 ? `${pendingByKind.other} other` : undefined
  ].filter(Boolean);
  const gmailDerivedActionItemsToday = input.actions.filter(
    (action) => action.source === "email_review" && isWithinLocalDay(action.createdAt, input.todayRange)
  ).length;
  const gmailDerivedEventsToday = input.todayEvents.filter(
    (event) => event.source === "gmail" || event.provider === "gmail" || event.data.provider === "gmail"
  ).length;
  const summary = pendingCount > 0
    ? `${pendingCount} Gmail review${pendingCount === 1 ? "" : "s"} waiting: ${parts.join(", ")}.`
    : input.todayReviews.length > 0
      ? `${input.todayReviews.length} Gmail review${input.todayReviews.length === 1 ? "" : "s"} handled today.`
      : "No Gmail reviews are waiting.";

  return {
    pendingCount,
    workActionCount: pendingByKind.work_action,
    jobSearchCount: pendingByKind.job_search,
    customCount: pendingByKind.custom_tracking,
    otherCount: pendingByKind.other,
    handledTodayCount: input.todayReviews.length,
    approvedTodayCount: approvedToday,
    rejectedTodayCount: rejectedToday,
    gmailDerivedActionItemsToday,
    gmailDerivedEventsToday,
    topReviewSubjects: input.pendingReviews.slice(0, 3).map((review) => sanitizeShortEmailSubject(review.subject)),
    priority,
    summary,
    userFacingLine: pendingCount > 0 ? emailAttentionPriorityLine({ ...pendingByKind, pendingCount }) : undefined,
    syncMode: input.gmailSyncMode,
    notificationPreference: input.reviewNotificationEnabled ? "on" : "off"
  };
}

function buildOperatorActionAttentionSummary(input: {
  openActions: ActionItem[];
  overdueActions: ActionItem[];
  dueSoonActions: ActionItem[];
  rankedOpenActions: Array<{ action: ActionItem; score: DailyPriorityScore }>;
  hygiene: ActionHygieneReport;
}): OperatorActionAttentionSummary {
  return {
    openCount: input.openActions.length,
    overdueCount: input.overdueActions.length,
    dueSoonCount: input.dueSoonActions.length,
    hygieneNeedsDecision: input.hygiene.suggestedCleanupCandidates.length,
    topActions: input.rankedOpenActions.slice(0, 3).map(({ action }) => ({
      id: action.id,
      title: action.title,
      dueAt: action.dueAt?.toISOString(),
      priority: action.priority
    })),
    summary: `${input.openActions.length} open action${input.openActions.length === 1 ? "" : "s"}; ${input.overdueActions.length} overdue.`
  };
}

function buildOperatorGoalAttentionSummary(goalStatus: DailyOperatorBriefGoalStatus[], activeGoals: Goal[]): OperatorGoalAttentionSummary {
  const noProgress = goalStatus.filter((goal) => goal.status === "no_progress" && !isRiskControlGoalStatus(goal));
  const criticalNoProgress = noProgress.filter((status) => {
    const goal = activeGoals.find((item) => item.id === status.goalId);
    return goal?.priority === "critical";
  });

  return {
    activeCount: activeGoals.length,
    noProgressCount: noProgress.length,
    criticalNoProgressCount: criticalNoProgress.length,
    summary: `${activeGoals.length} active goal${activeGoals.length === 1 ? "" : "s"}; ${noProgress.length} with no progress today.`
  };
}

function buildOperatorRiskAttentionSummary(risks: string[], todayEvents: StoredEvent[]): OperatorRiskAttentionSummary {
  const guardrailTriggeredToday = todayEvents.some((event) => event.type === "finance.betting.cooldown_triggered");

  return {
    activeWatchouts: risks,
    guardrailTriggeredToday,
    summary: risks.length > 0 ? `${risks.length} risk watchout${risks.length === 1 ? "" : "s"}.` : "No risk watchouts from recent signals."
  };
}

function buildTopOperatorAttentionItems(input: {
  rankedOpenActions: Array<{ action: ActionItem; score: DailyPriorityScore }>;
  overdueActions: ActionItem[];
  emailAttention: OperatorEmailAttentionSummary;
  risks: string[];
  hygiene: ActionHygieneReport;
  planningAttention: OperatorPlanningAttentionSummary;
}): OperatorAttentionItem[] {
  const items: OperatorAttentionItem[] = [];
  const topAction = input.rankedOpenActions[0]?.action;

  if (input.risks.length > 0) {
    items.push({
      kind: "risk",
      title: "Risk guardrail",
      summary: input.risks[0],
      priority: "critical",
      suggestedReply: "what should I do today"
    });
  }

  if (topAction) {
    items.push({
      kind: "action",
      title: topAction.title,
      summary: input.overdueActions.some((action) => action.id === topAction.id) ? "Overdue action." : "Top scored open action.",
      priority: input.overdueActions.some((action) => action.id === topAction.id) ? "high" : topAction.priority === "high" ? "high" : "medium",
      sourceId: topAction.id
    });
  }

  if (input.emailAttention.pendingCount > 0) {
    items.push({
      kind: "email_review",
      title: `Handle ${input.emailAttention.pendingCount} Gmail review${input.emailAttention.pendingCount === 1 ? "" : "s"}`,
      summary: input.emailAttention.userFacingLine ?? input.emailAttention.summary,
      priority: input.emailAttention.priority,
      suggestedReply: "show me the important emails"
    });
  }

  if (input.hygiene.suggestedCleanupCandidates.length > 0) {
    items.push({
      kind: "hygiene",
      title: "Clean up stale actions",
      summary: input.hygiene.summary,
      priority: "medium",
      suggestedReply: "clean up my tasks"
    });
  }

  if (input.planningAttention.weeklyReviewDue) {
    items.push({
      kind: "planning",
      title: "Weekly review due",
      summary: "Close the week before planning.",
      priority: "medium",
      suggestedReply: "review my week"
    });
  }

  return items
    .sort((left, right) => attentionPriorityRank(right.priority) - attentionPriorityRank(left.priority))
    .slice(0, 5);
}

function pickAttentionNextMove(
  items: OperatorAttentionItem[],
  input: {
    rankedOpenActions: Array<{ action: ActionItem; score: DailyPriorityScore }>;
    overdueActions: ActionItem[];
    emailAttention: OperatorEmailAttentionSummary;
    goalStatus: DailyOperatorBriefGoalStatus[];
    now: Date;
  }
): string {
  const top = items[0];

  if (top?.kind === "risk") {
    return "Keep the guardrail locked first. Do not create risky actions.";
  }

  if (top?.kind === "email_review" && input.emailAttention.workActionCount > 0) {
    return "Start with the work-action Gmail review.";
  }

  if (top?.kind === "email_review" && input.emailAttention.jobSearchCount > 0) {
    return "Check the job-search Gmail review.";
  }

  if (top?.kind === "email_review") {
    return "Clear the waiting Gmail reviews.";
  }

  return pickOperatorNextStep({
    overdueActions: input.overdueActions,
    dueSoonActions: [],
    openActions: input.rankedOpenActions.map((item) => item.action),
    goalStatus: input.goalStatus,
    emailAttention: input.emailAttention,
    now: input.now
  });
}

function buildOperatorSuggestedReplies(emailAttention: OperatorEmailAttentionSummary): string[] {
  const replies = ["what should I handle first?", "show my tasks"];

  if (emailAttention.pendingCount > 0) {
    replies.unshift("show me the important emails");
    replies.push("email reviews");
  }

  return uniqueStrings(replies).slice(0, 4);
}

function attentionPriorityRank(priority: OperatorAttentionPriority): number {
  return priority === "critical" ? 4 : priority === "high" ? 3 : priority === "medium" ? 2 : 1;
}

function emailAttentionPriorityLine(input: Record<EmailReviewKind, number> & { pendingCount: number }): string {
  const parts = [
    input.work_action > 0 ? `${input.work_action} work-action email${input.work_action === 1 ? "" : "s"} may become task${input.work_action === 1 ? "" : "s"}` : undefined,
    input.job_search > 0 ? `${input.job_search} job-search email${input.job_search === 1 ? "" : "s"} waiting` : undefined,
    input.custom_tracking > 0 ? `${input.custom_tracking} custom tracking item${input.custom_tracking === 1 ? "" : "s"} waiting` : undefined,
    input.other > 0 ? `${input.other} other email review${input.other === 1 ? "" : "s"} waiting` : undefined
  ].filter(Boolean);

  return parts.join("; ") || `${input.pendingCount} Gmail review${input.pendingCount === 1 ? "" : "s"} waiting`;
}

function sanitizeShortEmailSubject(subject: string | undefined): string {
  return (subject ?? "Email review")
    .replace(/\b(accessToken|refreshToken|ciphertext|providerMessageId|raw)\b/gi, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90);
}

function buildOperatorTopPriorities(input: {
  overdueActions: ActionItem[];
  dueSoonActions: ActionItem[];
  openActions: ActionItem[];
  goalStatus: DailyOperatorBriefGoalStatus[];
  risks: string[];
  emailAttention?: OperatorEmailAttentionSummary;
  priorityScores: DailyPriorityScore[];
}): string[] {
  const priorities: string[] = [];
  const seenActionIds = new Set<string>();
  const seenActionTitles = new Set<string>();
  const scoresByActionId = new Map(input.priorityScores.map((score) => [score.actionId, score]));
  const overdueActionIds = new Set(input.overdueActions.map((action) => action.id));
  const emailPriority = input.emailAttention && input.emailAttention.pendingCount > 0
    ? `Gmail reviews: ${input.emailAttention.userFacingLine ?? input.emailAttention.summary}`
    : undefined;
  let emailPriorityAdded = false;

  const addActionPriority = (action: ActionItem) => {
    const titleKey = normalizeManualActionTitleKey(action.title);

    if (seenActionIds.has(action.id) || seenActionTitles.has(titleKey)) {
      return;
    }

    seenActionIds.add(action.id);
    seenActionTitles.add(titleKey);
    priorities.push(formatPriorityAction(action, scoresByActionId.get(action.id)));
  };

  for (const action of input.openActions) {
    addActionPriority(action);

    if (!emailPriority || emailPriorityAdded) {
      continue;
    }

    const shouldInsertEmail =
      input.emailAttention?.priority === "high"
        ? overdueActionIds.has(action.id) || input.overdueActions.length === 0
        : input.emailAttention?.priority === "medium" && priorities.length >= 1;

    if (shouldInsertEmail) {
      priorities.push(emailPriority);
      emailPriorityAdded = true;
    }
  }

  if (emailPriority && !emailPriorityAdded) {
    priorities.push(emailPriority);
  }

  return uniqueStrings(priorities).slice(0, 3);
}

function pickOperatorNextStep(input: {
  overdueActions: ActionItem[];
  dueSoonActions: ActionItem[];
  openActions: ActionItem[];
  goalStatus: DailyOperatorBriefGoalStatus[];
  emailAttention?: OperatorEmailAttentionSummary;
  now: Date;
}): string {
  const topAction = input.openActions[0];
  if (topAction) {
    if (input.overdueActions.some((action) => action.id === topAction.id)) {
      return `Handle overdue action: ${topAction.title}.`;
    }

    if (topAction.dueAt && topAction.dueAt <= input.now) {
      return `Handle due action: ${topAction.title}.`;
    }

    return `Next upcoming action: ${topAction.title}.`;
  }

  if ((input.emailAttention?.workActionCount ?? 0) > 0) {
    return "Start with the work-action Gmail review.";
  }

  if ((input.emailAttention?.jobSearchCount ?? 0) > 0) {
    return "Check the job-search Gmail review.";
  }

  if ((input.emailAttention?.pendingCount ?? 0) > 0) {
    return "Clear the waiting Gmail reviews.";
  }

  const staleGoal = input.goalStatus.find((goal) => goal.status === "no_progress" && !isRiskControlGoalStatus(goal));
  if (staleGoal) {
    return `Log one concrete action for ${staleGoal.title}.`;
  }

  return "Log one meaningful action.";
}

function formatPriorityAction(action: ActionItem, score?: DailyPriorityScore): string {
  if (score?.factors.includes("overdue")) {
    return `Overdue: ${action.title}`;
  }

  if (score?.factors.some((factor) => factor.startsWith("due today") || factor === "due tomorrow morning" || factor === "due tomorrow")) {
    return `Due soon: ${action.title}`;
  }

  return action.title;
}

function buildGoalStatusToday(
  goal: Awaited<ReturnType<typeof getActiveGoals>>[number],
  todayEvents: StoredEvent[],
  openActions: ActionItem[],
  completedActions: ActionItem[]
) {
  const progressNote = goalProgressNoteForToday(goal, todayEvents);

  return {
    goalId: goal.id,
    hasProgressToday: progressNote !== "no progress logged today" || completedActions.some((action) => action.goalId === goal.id),
    hasCompletedActionToday: completedActions.some((action) => action.goalId === goal.id),
    hasOpenAction: openActions.some((action) => action.goalId === goal.id)
  };
}

function buildOperatorGoalStatus(
  goal: Awaited<ReturnType<typeof getActiveGoals>>[number],
  todayEvents: StoredEvent[],
  openActions: ActionItem[],
  completedActions: ActionItem[]
): DailyOperatorBriefGoalStatus {
  const openAction = openActions.find((action) => action.goalId === goal.id);
  const completedAction = completedActions.find((action) => action.goalId === goal.id);
  const progressNote = goalProgressNoteForToday(goal, todayEvents);
  const shouldShowProgressNote = progressNote !== "no progress logged today" || !completedAction;
  const note = [
    shouldShowProgressNote ? progressNote : undefined,
    completedAction ? `completed action: ${completedAction.title}` : undefined,
    openAction ? `open action: ${openAction.title}` : undefined
  ]
    .filter(Boolean)
    .join(", ");

  return {
    goalId: goal.id,
    title: goal.title,
    status: progressNote === "no progress logged today" && !completedAction ? "no_progress" : "progress",
    note,
    openActionTitle: openAction?.title,
    completedActionTitle: completedAction?.title
  };
}

function goalProgressNoteForToday(goal: Awaited<ReturnType<typeof getActiveGoals>>[number], events: StoredEvent[]): string {
  const templateId = goal.templateId ?? "";
  const category = goal.category;

  if (templateId === "career.job_search" || category === "career") {
    const applications = sumEventNumber(events, "career.application_sent", "count");
    const interviews = countEvent(events, "career.interview_scheduled");
    const replies = countEvent(events, "career.recruiter_reply_received");
    const parts = [
      applications > 0 ? `${applications} application${applications === 1 ? "" : "s"} sent today` : undefined,
      interviews > 0 ? `${interviews} interview${interviews === 1 ? "" : "s"} scheduled today` : undefined,
      replies > 0 ? `${replies} recruiter repl${replies === 1 ? "y" : "ies"} today` : undefined
    ].filter(Boolean);

    return parts.join(", ") || "no progress logged today";
  }

  if (templateId.includes("health") || category === "health") {
    const workouts = countEvent(events, "health.workout_completed");
    const steps = sumEventNumber(events, "health.steps_logged", "count");
    const parts = [
      workouts > 0 ? "training logged today" : undefined,
      steps > 0 ? `${steps} steps logged today` : undefined
    ].filter(Boolean);

    return parts.join(", ") || "no progress logged today";
  }

  if (templateId.includes("reading") || category === "learning") {
    const minutes = sumEventNumber(events, "learning.reading_session_completed", "duration_minutes");
    return minutes > 0 ? `${minutes} minutes reading today` : "no progress logged today";
  }

  if (templateId === "finance.control_betting_trading" || category === "finance") {
    const guardrails = events.filter((event) => event.type === "finance.betting.cooldown_triggered");

    if (guardrails.length > 0) {
      return "guardrail triggered today, no betting actions created";
    }

    return "no progress logged today";
  }

  const customLogs = events.filter((event) => event.type === "custom.goal_progress_logged" && event.data.goalId === goal.id);
  const focusedMinutes = customLogs.reduce((sum, event) => {
    const metricKey = typeof event.data.metricKey === "string" ? event.data.metricKey : "";
    const value = typeof event.data.value === "number" ? event.data.value : 0;
    return metricKey === "focused_minutes" || metricKey === "minutes" ? sum + value : sum;
  }, 0);

  if (customLogs.length > 0) {
    return focusedMinutes > 0
      ? `${customLogs.length} progress log${customLogs.length === 1 ? "" : "s"}, ${focusedMinutes} focused minutes`
      : `${customLogs.length} progress log${customLogs.length === 1 ? "" : "s"} today`;
  }

  return "no progress logged today";
}

function buildOperatorRecentWins(
  events: StoredEvent[],
  completedActions: ActionItem[],
  recentReviews: EmailReviewItem[],
  todayRange: ReturnType<typeof getLocalTodayRange>
): string[] {
  const wins = [
    ...completedActions.map((action) => `Completed action: ${action.title}`),
    sumEventNumber(events, "career.application_sent", "count") > 0
      ? `${sumEventNumber(events, "career.application_sent", "count")} application${sumEventNumber(events, "career.application_sent", "count") === 1 ? "" : "s"} sent`
      : undefined,
    countEvent(events, "health.workout_completed") > 0 ? "Training logged" : undefined,
    sumEventNumber(events, "learning.reading_session_completed", "duration_minutes") > 0
      ? `${sumEventNumber(events, "learning.reading_session_completed", "duration_minutes")} minutes reading`
      : undefined,
    countEvent(events, "custom.goal_progress_logged") > 0 ? `${countEvent(events, "custom.goal_progress_logged")} custom progress log${countEvent(events, "custom.goal_progress_logged") === 1 ? "" : "s"}` : undefined,
    recentReviews.some((review) => review.status === "approved" && isWithinLocalDay(review.reviewedAt, todayRange))
      ? "Email review approved today"
      : undefined
  ].filter(Boolean);

  return uniqueStrings(wins).slice(0, 5);
}

function buildOperatorRisks(events: StoredEvent[]): string[] {
  const risks = [];
  const cooldowns = countEvent(events, "finance.betting.cooldown_triggered");

  if (cooldowns > 0) {
    risks.push("Betting impulse detected recently. Do not open a bet today without cooldown.");
  }

  if (countEvent(events, "finance.betting.large_bet_detected") > 0) {
    risks.push("Large bet signal detected recently.");
  }

  if (countEvent(events, "finance.trading.large_loss_detected") > 0) {
    risks.push("Large trading loss detected recently.");
  }

  const latestAnxiety = latestEventNumber(events, "reflection.anxiety_logged", "value");
  const latestSleep = latestEventNumber(events, "health.sleep_logged", "duration_hours");
  const latestImpulse = latestImpulseValue(events);

  if (latestAnxiety !== undefined && latestAnxiety >= 7) {
    risks.push(`Anxiety is ${latestAnxiety}/10. Keep decisions smaller.`);
  }

  if (latestSleep !== undefined && latestSleep < 6) {
    risks.push(`Sleep is below 6h. No betting/trading decisions today.`);
  }

  if (latestImpulse !== undefined && latestImpulse >= 6) {
    risks.push(`Gambling/trading impulse is ${latestImpulse}/10. Do not act on it.`);
  }

  return uniqueStrings(risks).slice(0, 5);
}

function buildOperatorGuardrailWatchouts(activeGoals: Awaited<ReturnType<typeof getActiveGoals>>): string[] {
  return activeGoals
    .filter((goal) => isRiskControlGoal(goal))
    .map((goal) => `Risk-control goal active: ${goal.title}. Keep guardrail separate from normal task progress.`)
    .slice(0, 1);
}

function isRiskControlGoalStatus(goal: Pick<DailyOperatorBriefGoalStatus, "title">): boolean {
  return /\b(finance|betting|trading|gambling|impulse|risk|apuesta|apostar)\b/i.test(goal.title);
}

function toBriefAction(action: ActionItem): DailyOperatorBriefAction {
  return {
    id: action.id,
    title: action.title,
    status: action.status,
    priority: action.priority,
    dueAt: action.dueAt?.toISOString(),
    snoozedUntil: action.snoozedUntil?.toISOString(),
    goalId: action.goalId,
    goalTitle: action.goalTitleSnapshot
  };
}

function isActionDueSoon(action: ActionItem, now: Date): boolean {
  if (!action.dueAt) {
    return false;
  }

  const next24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  return action.dueAt >= now && action.dueAt <= next24h;
}

function countEvent(events: StoredEvent[], type: string): number {
  return events.filter((event) => event.type === type).length;
}

function sumEventNumber(events: StoredEvent[], type: string, key: string): number {
  return events
    .filter((event) => event.type === type)
    .reduce((sum, event) => sum + (typeof event.data[key] === "number" ? event.data[key] : 0), 0);
}

function latestEventNumber(events: StoredEvent[], type: string, key: string): number | undefined {
  const event = [...events]
    .filter((item) => item.type === type && typeof item.data[key] === "number")
    .sort((left, right) => right.timestamp.getTime() - left.timestamp.getTime())[0];

  return typeof event?.data[key] === "number" ? event.data[key] : undefined;
}

function latestImpulseValue(events: StoredEvent[]): number | undefined {
  const event = [...events]
    .filter(
      (item) =>
        item.type === "reflection.impulse_logged" &&
        typeof item.data.value === "number" &&
        (item.data.kind === "gambling" || item.data.kind === "trading")
    )
    .sort((left, right) => right.timestamp.getTime() - left.timestamp.getTime())[0];

  return typeof event?.data.value === "number" ? event.data.value : undefined;
}
