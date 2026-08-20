import { getLocalTodayRange, isRiskControlGoal, type Goal } from "@operator-agent/core";
import { getActionItems, getActiveGoals, type ActionItem } from "@operator-agent/db";
import type { ActionHygieneAction, ActionHygieneReport } from "../server-types.js";
import { isSnoozedDue } from "../utils/action-item.js";
import { goalPriorityRank } from "../utils/goal-priority.js";
import { daysBetween, daysBetweenLocalDates, formatDateInTimezone } from "../utils/datetime.js";

/**
 * Pure action-hygiene candidate-analysis logic, extracted from
 * apps/api/src/legacy/action-hygiene-conversation.ts as part of migrating
 * the action-hygiene cleanup flow into Agent Runtime v3
 * (apps/api/src/agent-runtime/*). This is the read-only "what needs
 * cleanup" analysis — it never writes a legacy PendingAction row, so it is
 * safe for both the legacy conversation module and the v3 runtime to
 * import directly, with neither depending on the other.
 *
 * `createActionHygieneSession`/`storeActionHygieneSession` (which write a
 * legacy PendingAction) and the free-text batch/single-item reply parser
 * stay in apps/api/src/legacy/action-hygiene-conversation.ts, which now
 * imports the functions below from here instead of defining them.
 */

export async function analyzeActionHygiene(userId: string, now: Date, timezone: string): Promise<ActionHygieneReport> {
  const [actions, goals] = await Promise.all([
    getActionItems(userId, { status: "all", limit: 200 }),
    getActiveGoals(userId)
  ]);
  const today = getLocalTodayRange(now, timezone);
  const goalsById = new Map(goals.map((goal) => [goal.id, goal]));
  const openActions = actions.filter((action) => action.status === "open" || isSnoozedDue(action, now));
  const analyzed = openActions
    .map((action) => analyzeActionHygieneItem(action, goalsById.get(action.goalId ?? ""), today, now, timezone))
    .filter(Boolean) as ActionHygieneAction[];
  const overdueActions = analyzed.filter((action) => action.daysOverdue !== undefined && action.daysOverdue >= 1);
  const staleActions = analyzed.filter((action) => action.daysOverdue !== undefined && action.daysOverdue >= 3);
  const lowPriorityStaleActions = analyzed.filter(
    (action) => action.priority === "low" && action.lastTouchedAt && daysBetween(new Date(action.lastTouchedAt), now) >= 7
  );
  const repeatedlySnoozedActions: ActionHygieneAction[] = [];
  const suggestedCleanupCandidates = uniqueHygieneActions([
    ...staleActions,
    ...overdueActions.filter((action) => !action.linkedGoalTitle || (action.daysOverdue ?? 0) >= 2),
    ...lowPriorityStaleActions
  ]).slice(0, 10);

  return {
    staleActions,
    overdueActions,
    repeatedlySnoozedActions,
    lowPriorityStaleActions,
    suggestedCleanupCandidates,
    summary:
      suggestedCleanupCandidates.length > 0
        ? cleanupDecisionGrammar(suggestedCleanupCandidates.length)
        : overdueActions.length > 0
          ? cleanupDecisionGrammar(overdueActions.length)
        : "Action list is clean enough."
  };
}

function analyzeActionHygieneItem(
  action: ActionItem,
  goal: Goal | undefined,
  today: ReturnType<typeof getLocalTodayRange>,
  now: Date,
  timezone: string
): ActionHygieneAction | undefined {
  if (goal && isRiskControlGoal(goal)) {
    return undefined;
  }

  const dueAt = action.dueAt;
  const daysOverdue = dueAt && dueAt < now ? daysBetweenLocalDates(formatDateInTimezone(dueAt, timezone), today.date) : undefined;
  const untouchedDays = daysBetween(action.updatedAt, now);
  const reasons: string[] = [];

  if (daysOverdue !== undefined && daysOverdue >= 1) {
    reasons.push(daysOverdue >= 3 ? `overdue ${daysOverdue} days` : `overdue ${daysOverdue} day${daysOverdue === 1 ? "" : "s"}`);
  }

  if (action.priority === "low" && untouchedDays >= 7) {
    reasons.push(`low priority and untouched ${untouchedDays} days`);
  }

  if (reasons.length === 0) {
    return undefined;
  }

  const goalPriority = goalPriorityRank(goal);
  const recommendedOptions = goalPriority >= 45
    ? (["complete", "snooze", "keep"] as ActionHygieneAction["recommendedOptions"])
    : (["complete", "snooze", "archive", "keep"] as ActionHygieneAction["recommendedOptions"]);

  return {
    actionId: action.id,
    title: action.title,
    dueAt: action.dueAt?.toISOString(),
    linkedGoalTitle: action.goalTitleSnapshot,
    priority: action.priority,
    daysOverdue,
    snoozeCount: undefined,
    lastTouchedAt: action.updatedAt.toISOString(),
    reason: reasons.join("; "),
    recommendedOptions
  };
}

export function actionHygieneVisibleActions(report: ActionHygieneReport): ActionHygieneAction[] {
  return uniqueHygieneActions([
    ...report.overdueActions,
    ...report.suggestedCleanupCandidates
  ]).slice(0, 10);
}

export function cleanupDecisionGrammar(count: number): string {
  return count === 1 ? "1 action needs a cleanup decision." : `${count} actions need cleanup decisions.`;
}

function uniqueHygieneActions(actions: ActionHygieneAction[]): ActionHygieneAction[] {
  const seen = new Set<string>();
  return actions.filter((action) => {
    if (seen.has(action.actionId)) {
      return false;
    }
    seen.add(action.actionId);
    return true;
  });
}
