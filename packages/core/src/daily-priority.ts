import { normalizeManualActionTitleKey } from "./action-intake.js";
import { normalizeGoalPriority, scoreForGoalPriority } from "./goals.js";
import type { Goal, GoalPriority } from "./goals.js";
import type { StoredEvent } from "./events.js";

export interface DailyPriorityAction {
  id: string;
  title: string;
  status: "open" | "completed" | "snoozed" | "archived";
  priority: "low" | "medium" | "high";
  dueAt?: Date;
  snoozedUntil?: Date;
  goalId?: string;
  goalTitleSnapshot?: string;
  createdAt: Date;
  completedAt?: Date;
}

export interface GoalStatusToday {
  goalId: string;
  hasProgressToday: boolean;
  hasCompletedActionToday: boolean;
  hasOpenAction: boolean;
}

export interface DailyGuardrailContext {
  hardGuardrailTriggeredToday: boolean;
}

export interface DailyPriorityScoreInput {
  action: DailyPriorityAction;
  linkedGoal?: Goal;
  goalStatusToday?: GoalStatusToday;
  recentEvents: StoredEvent[];
  guardrailContext?: DailyGuardrailContext;
  now: Date;
}

export interface DailyPriorityScore {
  actionId: string;
  title: string;
  score: number;
  rankReason: string;
  factors: string[];
}

export function scoreDailyActionPriority(input: DailyPriorityScoreInput): DailyPriorityScore {
  const factors: string[] = [];
  let score = 0;

  if (input.action.status === "open") {
    score += 10;
    factors.push("open");
  } else if (input.action.status === "snoozed" && input.action.snoozedUntil && input.action.snoozedUntil <= input.now) {
    score += 10;
    factors.push("snoozed back");
  } else {
    factors.push("not open");
    return {
      actionId: input.action.id,
      title: input.action.title,
      score: -1000,
      rankReason: "not open",
      factors
    };
  }

  const dueFactor = scoreDueDate(input.action.dueAt, input.now);
  score += dueFactor.score;
  if (dueFactor.reason) {
    factors.push(dueFactor.reason);
  }

  if (input.action.priority === "high") {
    score += 65;
    factors.push("high priority");
  } else if (input.action.priority === "medium") {
    score += 10;
    factors.push("medium priority");
  }

  if (input.linkedGoal) {
    score += 25;
    factors.push("goal-linked");
    const priority = normalizeGoalPriority(input.linkedGoal.priority);
    const priorityScore = goalPriorityScoringBoost(input.linkedGoal.importanceScore, priority);
    score += priorityScore;
    factors.push(`${priority} goal`);

    if (!input.goalStatusToday?.hasProgressToday) {
      score += 15;
      factors.push(`no ${goalShortName(input.linkedGoal)} progress`);
    }

    if (input.goalStatusToday?.hasOpenAction && !input.goalStatusToday.hasCompletedActionToday) {
      score += 5;
      factors.push("open goal action");
    }

    if (input.goalStatusToday?.hasCompletedActionToday) {
      score += 5;
      factors.push("some goal progress today");
    }

    const categoryBoost = scoreGoalCategory(input.linkedGoal, input.goalStatusToday, input.action, input.now);
    score += categoryBoost.score;
    if (categoryBoost.reason) {
      factors.push(categoryBoost.reason);
    }
  } else if (isGenericChore(input.action.title)) {
    factors.push("unlinked chore");
  } else {
    factors.push("unlinked");
  }

  if (isRiskControlGoal(input.linkedGoal)) {
    score -= 35;
    factors.push("risk control tracked separately");
  }

  const rankReason = factors.filter((factor) => factor !== "open" && factor !== "medium priority").join(", ") || "open action";

  return {
    actionId: input.action.id,
    title: input.action.title,
    score,
    rankReason,
    factors
  };
}

export function sortDailyActionsByPriority<T extends DailyPriorityAction>(
  actions: T[],
  options: {
    goals: Goal[];
    goalStatuses: GoalStatusToday[];
    recentEvents: StoredEvent[];
    guardrailContext?: DailyGuardrailContext;
    now: Date;
  }
): Array<{ action: T; score: DailyPriorityScore }> {
  const goalsById = new Map(options.goals.map((goal) => [goal.id, goal]));
  const goalStatusById = new Map(options.goalStatuses.map((status) => [status.goalId, status]));

  return actions
    .map((action) => ({
      action,
      score: scoreDailyActionPriority({
        action,
        linkedGoal: action.goalId ? goalsById.get(action.goalId) : undefined,
        goalStatusToday: action.goalId ? goalStatusById.get(action.goalId) : undefined,
        recentEvents: options.recentEvents,
        guardrailContext: options.guardrailContext,
        now: options.now
      })
    }))
    .sort((left, right) => compareDailyPriority(left, right, options.now));
}

export function isRiskControlGoal(goal?: Pick<Goal, "title" | "category" | "templateId">): boolean {
  if (!goal) {
    return false;
  }

  const text = `${goal.title} ${goal.category} ${goal.templateId ?? ""}`.toLowerCase();
  return /\b(finance|betting|trading|gambling|impulse|risk|risk-control|control_betting_trading)\b/.test(text);
}

function goalPriorityScoringBoost(importanceScore: number | null | undefined, priority: GoalPriority): number {
  if (typeof importanceScore === "number" && Number.isFinite(importanceScore)) {
    return Math.max(0, Math.min(80, Math.round(importanceScore * 0.7)));
  }

  const base = scoreForGoalPriority(priority);
  if (priority === "low") {
    return 5;
  }
  if (priority === "medium") {
    return 15;
  }
  if (priority === "high") {
    return 30;
  }
  return Math.min(50, Math.round(base * 0.72));
}

function compareDailyPriority(
  left: { action: DailyPriorityAction; score: DailyPriorityScore },
  right: { action: DailyPriorityAction; score: DailyPriorityScore },
  now: Date
): number {
  if (right.score.score !== left.score.score) {
    return right.score.score - left.score.score;
  }

  const leftDue = left.action.dueAt?.getTime() ?? Number.POSITIVE_INFINITY;
  const rightDue = right.action.dueAt?.getTime() ?? Number.POSITIVE_INFINITY;
  if (leftDue !== rightDue) {
    return leftDue - rightDue;
  }

  const leftLinked = left.action.goalId ? 1 : 0;
  const rightLinked = right.action.goalId ? 1 : 0;
  if (leftLinked !== rightLinked) {
    return rightLinked - leftLinked;
  }

  const priorityOrder = { high: 3, medium: 2, low: 1 };
  const priorityDelta = priorityOrder[right.action.priority] - priorityOrder[left.action.priority];
  if (priorityDelta !== 0) {
    return priorityDelta;
  }

  const leftCreatedAt = left.action.createdAt?.getTime() ?? now.getTime();
  const rightCreatedAt = right.action.createdAt?.getTime() ?? now.getTime();
  return leftCreatedAt - rightCreatedAt;
}

function scoreDueDate(dueAt: Date | undefined, now: Date): { score: number; reason?: string } {
  if (!dueAt) {
    return { score: 0 };
  }

  const dueStart = startOfLocalDay(dueAt);
  const todayStart = startOfLocalDay(now);
  const tomorrowStart = addDays(todayStart, 1);
  const afterTomorrowStart = addDays(todayStart, 2);
  const weekEnd = addDays(todayStart, 7);

  if (dueAt < now) {
    return { score: 90, reason: "overdue" };
  }

  if (dueStart.getTime() === todayStart.getTime()) {
    return { score: 40, reason: "due today" };
  }

  if (dueStart.getTime() === tomorrowStart.getTime()) {
    return dueAt.getHours() < 12
      ? { score: 25, reason: "due tomorrow morning" }
      : { score: 15, reason: "due tomorrow" };
  }

  if (dueAt < weekEnd) {
    return { score: 5, reason: "due later this week" };
  }

  return { score: 0 };
}

function scoreGoalCategory(
  goal: Goal,
  status: GoalStatusToday | undefined,
  action: DailyPriorityAction,
  now: Date
): { score: number; reason?: string } {
  if (status?.hasProgressToday || isRiskControlGoal(goal)) {
    return { score: 0 };
  }

  const text = `${goal.templateId ?? ""} ${goal.category}`.toLowerCase();
  const dueToday = Boolean(action.dueAt && startOfLocalDay(action.dueAt).getTime() === startOfLocalDay(now).getTime());

  if (text.includes("career") || text.includes("job_search")) {
    return { score: 5, reason: "no job-search progress" };
  }

  if (text.includes("health") && dueToday) {
    return { score: 5, reason: "no health progress" };
  }

  if (text.includes("creative") || text.includes("build_project")) {
    return { score: 5, reason: "stale creative goal" };
  }

  return { score: 0 };
}

function goalShortName(goal: Goal): string {
  const text = `${goal.templateId ?? ""} ${goal.category}`.toLowerCase();
  if (text.includes("career") || text.includes("job_search")) {
    return "job-search";
  }
  if (text.includes("health")) {
    return "health";
  }
  if (text.includes("learning") || text.includes("reading")) {
    return "learning";
  }
  if (text.includes("creative")) {
    return "creative";
  }
  return "goal";
}

function isGenericChore(title: string): boolean {
  return /\b(buy milk|groceries|laundry|clean|dishes|trash|shopping)\b/i.test(title);
}

function startOfLocalDay(date: Date): Date {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

export function dailyPriorityDedupeKey(action: Pick<DailyPriorityAction, "id" | "title">): string {
  return normalizeManualActionTitleKey(action.title) || action.id;
}
