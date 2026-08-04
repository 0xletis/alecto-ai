import { z } from "zod";
import type { StoredEvent } from "./events.js";
import type { Goal } from "./goals.js";
import type { MemoryEntry } from "./memory.js";
import type { UserOperatingProfile } from "./user-operating-profile.js";

export const InsightGoalProgressSchema = z.object({
  goalId: z.string(),
  title: z.string(),
  status: z.enum(["progress", "no_progress", "risk", "stable", "custom"]),
  note: z.string()
});

export const InsightReportSchema = z.object({
  userId: z.string(),
  periodType: z.enum(["daily", "weekly"]),
  periodStart: z.coerce.date(),
  periodEnd: z.coerce.date(),
  headline: z.string(),
  summary: z.string(),
  wins: z.array(z.string()),
  gaps: z.array(z.string()),
  risks: z.array(z.string()),
  patterns: z.array(z.string()),
  goalProgress: z.array(InsightGoalProgressSchema),
  memorySignals: z.array(z.string()),
  recommendedActions: z.array(z.string()),
  hardTruth: z.string().optional(),
  generatedAt: z.coerce.date()
});

export interface BuildInsightInput {
  userId: string;
  periodStart: Date;
  periodEnd: Date;
  events: StoredEvent[];
  activeGoals: Goal[];
  activeMemories: MemoryEntry[];
  userOperatingProfile: UserOperatingProfile;
}

export type InsightGoalProgress = z.infer<typeof InsightGoalProgressSchema>;
export type InsightReport = z.infer<typeof InsightReportSchema>;

export function buildDailyInsight(input: BuildInsightInput): InsightReport {
  const activeGoals = dedupeGoalsForInsight(input.activeGoals);
  const hasDuplicateGoals = activeGoals.length < input.activeGoals.length;
  const metrics = summarizeMetrics(input.events);
  const wins = dailyWins(metrics, activeGoals, input.events);
  const risks = riskSignals(metrics);
  const goalProgress = buildGoalProgress(activeGoals, input.events, metrics, "daily");
  const gaps = buildGoalGaps(goalProgress);
  const patterns = withDuplicateGoalPattern(dailyPatterns(metrics), hasDuplicateGoals);
  const memorySignals = relevantMemorySignals(input.activeMemories, risks);
  const recommendedActions = recommendDailyActions(activeGoals, metrics, input.events);
  const directProfile = isDirectProfile(input.userOperatingProfile);
  const headline = dailyHeadline(wins, risks, directProfile, metrics.customProgressLogs > 0);
  const summary = buildDailySummary(wins, risks, directProfile, metrics);
  const hardTruth =
    directProfile && risks.length > 0
      ? "You do not need more analysis tonight. You need to protect the system from your impulsive state."
      : undefined;

  return InsightReportSchema.parse({
    userId: input.userId,
    periodType: "daily",
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    headline,
    summary,
    wins,
    gaps,
    risks,
    patterns,
    goalProgress,
    memorySignals,
    recommendedActions,
    hardTruth,
    generatedAt: new Date()
  });
}

export function buildWeeklyInsight(input: BuildInsightInput): InsightReport {
  const activeGoals = dedupeGoalsForInsight(input.activeGoals);
  const hasDuplicateGoals = activeGoals.length < input.activeGoals.length;
  const metrics = summarizeMetrics(input.events);
  const wins = weeklyWins(metrics, activeGoals, input.events);
  const risks = weeklyRisks(metrics);
  const goalProgress = buildGoalProgress(activeGoals, input.events, metrics, "weekly");
  const gaps = buildGoalGaps(goalProgress);
  const patterns = withDuplicateGoalPattern(weeklyPatterns(input.events, metrics), hasDuplicateGoals);
  const memorySignals = relevantMemorySignals(input.activeMemories, risks);
  const recommendedActions = recommendWeeklyActions(activeGoals, metrics, risks);
  const directProfile = isDirectProfile(input.userOperatingProfile);
  const headline = weeklyHeadline(wins, risks, directProfile);
  const summary = buildWeeklySummary(metrics);
  const hardTruth =
    directProfile && (risks.length > 0 || gaps.length > 1)
      ? "Next week should be boring and measurable: sleep, work blocks, applications, and no risk-seeking loopholes."
      : undefined;

  return InsightReportSchema.parse({
    userId: input.userId,
    periodType: "weekly",
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    headline,
    summary,
    wins,
    gaps,
    risks,
    patterns,
    goalProgress,
    memorySignals,
    recommendedActions,
    hardTruth,
    generatedAt: new Date()
  });
}

function summarizeMetrics(events: StoredEvent[]) {
  return {
    applications: sum(events, "career.application_sent", "count"),
    applicationConfirmations: count(events, "career.application_confirmation_received"),
    recruiterReplies: count(events, "career.recruiter_reply_received"),
    interviews: countAny(events, ["career.interview_scheduled", "career.interview_completed"]),
    rejections: count(events, "career.rejection_received"),
    offers: count(events, "career.offer_received"),
    cvUpdates: countAny(events, ["career.cv_updated", "career.portfolio_updated"]),
    workoutSessions: count(events, "health.workout_completed"),
    workoutMinutes: sum(events, "health.workout_completed", "duration_minutes"),
    readingSessions: count(events, "learning.reading_session_completed"),
    readingMinutes: sum(events, "learning.reading_session_completed", "duration_minutes"),
    commits: countPersonalCommitEvents(events),
    unverifiedGithubCommits: countUnverifiedGithubCommitEvents(events),
    repoActivity: count(events, "coding.repo_activity_detected"),
    activeRepos: unique(
      events
        .filter((event) => event.type === "coding.commit_created" || event.type === "coding.repo_activity_detected")
        .map((event) => (typeof event.data.repo === "string" ? event.data.repo : undefined))
        .filter((repo): repo is string => Boolean(repo))
    ),
    customProgressLogs: count(events, "custom.goal_progress_logged"),
    customProgressMinutes: sumCustomMinutes(events),
    checkIns: count(events, "reflection.daily_checkin_completed"),
    cooldowns: count(events, "finance.betting.cooldown_triggered"),
    thesisLogs: countAny(events, ["finance.betting.bet_thesis_logged", "finance.trading.thesis_logged"]),
    sleepLatest: latest(events, "health.sleep_logged", "duration_hours"),
    sleepAverage: average(events, "health.sleep_logged", "duration_hours"),
    lowSleepDays: distinctDays(events.filter((event) => event.type === "health.sleep_logged" && numberValue(event, "duration_hours") < 6)),
    energyLatest: latest(events, "reflection.energy_logged", "value"),
    energyAverage: average(events, "reflection.energy_logged", "value"),
    anxietyLatest: latest(events, "reflection.anxiety_logged", "value"),
    anxietyAverage: average(events, "reflection.anxiety_logged", "value"),
    highAnxietyDays: distinctDays(events.filter((event) => event.type === "reflection.anxiety_logged" && numberValue(event, "value") >= 7)),
    focusLatest: latest(events, "reflection.focus_logged", "value"),
    focusAverage: average(events, "reflection.focus_logged", "value"),
    impulseLatest: latestImpulse(events),
    highImpulseEvents: events.filter((event) => event.type === "reflection.impulse_logged" && numberValue(event, "value") >= 6).length,
    progressDays: distinctDays(
      events.filter((event) => isPersonalProgressEvent(event))
    ),
    totalDays: Math.max(1, distinctDays(events))
  };
}

function dailyWins(metrics: ReturnType<typeof summarizeMetrics>, activeGoals: Goal[] = [], events: StoredEvent[] = []): string[] {
  const wins: string[] = [];

  if (metrics.applications > 0) {
    wins.push(`${metrics.applications} job application${metrics.applications === 1 ? "" : "s"} sent`);
  }

  if (metrics.recruiterReplies > 0) {
    wins.push(`${metrics.recruiterReplies} recruiter repl${metrics.recruiterReplies === 1 ? "y" : "ies"}`);
  }

  if (metrics.interviews > 0) {
    wins.push(`${metrics.interviews} interview signal${metrics.interviews === 1 ? "" : "s"}`);
  }

  if (metrics.offers > 0) {
    wins.push(`${metrics.offers} offer${metrics.offers === 1 ? "" : "s"} received`);
  }

  if (metrics.workoutMinutes > 0) {
    wins.push(`${metrics.workoutMinutes} minutes of training`);
  }

  if (metrics.readingMinutes > 0) {
    wins.push(`${metrics.readingMinutes} minutes of reading`);
  }

  if (metrics.commits > 0) {
    wins.push(`${metrics.commits} personal commit${metrics.commits === 1 ? "" : "s"} detected`);
  }

  wins.push(...customProgressWins(activeGoals, events));

  return wins;
}

function weeklyWins(metrics: ReturnType<typeof summarizeMetrics>, activeGoals: Goal[] = [], events: StoredEvent[] = []): string[] {
  const wins = dailyWins(metrics, activeGoals, events);

  if (metrics.checkIns > 0) {
    wins.push(`${metrics.checkIns} check-in${metrics.checkIns === 1 ? "" : "s"}`);
  }

  return wins;
}

function riskSignals(metrics: ReturnType<typeof summarizeMetrics>): string[] {
  const risks: string[] = [];

  if (metrics.cooldowns > 0) {
    risks.push("betting/trading cooldown triggered today");
  }

  if (metrics.impulseLatest && metrics.impulseLatest.value >= 6) {
    risks.push(`${metrics.impulseLatest.kind} impulse is ${metrics.impulseLatest.value}/10, which is 6 or higher`);
  }

  if (metrics.anxietyLatest !== undefined && metrics.anxietyLatest >= 7) {
    risks.push(`anxiety is ${metrics.anxietyLatest}/10, which is 7 or higher`);
  }

  if (metrics.sleepLatest !== undefined && metrics.sleepLatest < 6) {
    risks.push(`sleep is below 6h at ${metrics.sleepLatest}h`);
  }

  if (
    metrics.sleepLatest !== undefined &&
    metrics.sleepLatest < 6 &&
    metrics.impulseLatest &&
    metrics.impulseLatest.value >= 6
  ) {
    risks.push("low sleep plus high financial impulse");
  }

  return risks;
}

function weeklyRisks(metrics: ReturnType<typeof summarizeMetrics>): string[] {
  const risks: string[] = [];

  if (metrics.cooldowns > 0) {
    risks.push(`${metrics.cooldowns} betting/trading cooldown${metrics.cooldowns === 1 ? "" : "s"} this week`);
  }

  if (metrics.highImpulseEvents > 0) {
    risks.push(`${metrics.highImpulseEvents} high impulse log${metrics.highImpulseEvents === 1 ? "" : "s"} this week`);
  }

  if (metrics.highAnxietyDays > 0) {
    risks.push(`high anxiety appeared on ${metrics.highAnxietyDays} day${metrics.highAnxietyDays === 1 ? "" : "s"} this week`);
  }

  if (metrics.lowSleepDays > 0) {
    risks.push(`low sleep appeared on ${metrics.lowSleepDays} day${metrics.lowSleepDays === 1 ? "" : "s"} this week`);
  }

  if (metrics.lowSleepDays > 0 && metrics.highImpulseEvents > 0) {
    risks.push("low sleep and high financial impulse both appeared this week");
  }

  return unique(risks);
}

function dailyPatterns(metrics: ReturnType<typeof summarizeMetrics>): string[] {
  const patterns: string[] = [];

  if (metrics.cooldowns > 0) {
    patterns.push("risk control had to override impulse today");
  }

  if (metrics.sleepLatest !== undefined && metrics.sleepLatest < 6 && metrics.anxietyLatest !== undefined && metrics.anxietyLatest >= 7) {
    patterns.push("low sleep and high anxiety are stacked");
  }

  if (metrics.repoActivity > 0 && metrics.commits === 0) {
    patterns.push(`${metrics.repoActivity} repo activity signal${metrics.repoActivity === 1 ? "" : "s"} detected as external context, not personal output`);
  }

  if (metrics.unverifiedGithubCommits > 0) {
    patterns.push(`${metrics.unverifiedGithubCommits} unverified GitHub commit event${metrics.unverifiedGithubCommits === 1 ? "" : "s"} ignored for personal progress`);
  }

  return patterns;
}

function weeklyPatterns(events: StoredEvent[], metrics: ReturnType<typeof summarizeMetrics>): string[] {
  const patterns: string[] = [];

  if (metrics.cooldowns >= 2) {
    patterns.push("repeated cooldowns suggest a recurring betting/trading risk loop");
  }

  if (metrics.lowSleepDays >= 2) {
    patterns.push("low sleep repeated across the week");
  }

  if (metrics.highAnxietyDays >= 2) {
    patterns.push("high anxiety repeated across the week");
  }

  if (metrics.progressDays <= 1 && metrics.applications + metrics.workoutMinutes + metrics.readingMinutes > 0) {
    patterns.push("progress was clustered instead of consistent");
  }

  if (metrics.checkIns > 0 && metrics.checkIns < Math.min(4, distinctDays(events))) {
    patterns.push("check-ins were inconsistent");
  }

  if (metrics.repoActivity > 0 && metrics.commits === 0) {
    patterns.push(`${metrics.repoActivity} repo activity signal${metrics.repoActivity === 1 ? "" : "s"} detected without personal commits`);
  }

  if (metrics.unverifiedGithubCommits > 0) {
    patterns.push(`${metrics.unverifiedGithubCommits} unverified GitHub commit event${metrics.unverifiedGithubCommits === 1 ? "" : "s"} ignored for personal progress`);
  }

  return patterns;
}

function buildGoalProgress(
  activeGoals: Goal[],
  events: StoredEvent[],
  metrics: ReturnType<typeof summarizeMetrics>,
  period: "daily" | "weekly"
): InsightGoalProgress[] {
  const eventTypes = new Set(events.map((event) => event.type));

  return activeGoals.map((goal) => {
    if (!goal.templateId && (hasCustomGoalConfig(goal) || customProgressForGoal(goal, events).logs > 0)) {
      const progress = customProgressForGoal(goal, events);

      return {
        goalId: goal.id,
        title: goal.title,
        status: progress.logs > 0 ? "progress" : "no_progress",
        note: progress.logs > 0
          ? formatCustomProgressNote(progress)
          : "No custom progress logged"
      };
    }

    if (matchesGoal(goal, "career.job_search", "career")) {
      const signals =
        metrics.applications +
        metrics.applicationConfirmations +
        metrics.recruiterReplies +
        metrics.interviews +
        metrics.rejections +
        metrics.offers +
        metrics.cvUpdates +
        metrics.commits;
      return {
        goalId: goal.id,
        title: goal.title,
        status: signals > 0 ? "progress" : "no_progress",
        note: signals > 0
          ? `${metrics.applications} applications, ${metrics.applicationConfirmations} confirmations, ${metrics.recruiterReplies} replies, ${metrics.interviews} interviews, ${metrics.rejections} rejections, ${metrics.offers} offers, ${metrics.commits} personal commits`
          : `No job-search evidence logged ${period === "daily" ? "today" : "this week"}`
      };
    }

    if (matchesGoal(goal, "health.strength_energy", "health")) {
      return {
        goalId: goal.id,
        title: goal.title,
        status: metrics.workoutMinutes > 0 ? "progress" : "no_progress",
        note: metrics.workoutMinutes > 0
          ? `${metrics.workoutSessions} workout${metrics.workoutSessions === 1 ? "" : "s"}, ${metrics.workoutMinutes} minutes`
          : `No training evidence logged ${period === "daily" ? "today" : "this week"}`
      };
    }

    if (matchesGoal(goal, "learning.reading_more", "learning")) {
      return {
        goalId: goal.id,
        title: goal.title,
        status: metrics.readingMinutes > 0 ? "progress" : "no_progress",
        note: metrics.readingMinutes > 0
          ? `${metrics.readingSessions} reading session${metrics.readingSessions === 1 ? "" : "s"}, ${metrics.readingMinutes} minutes`
          : `No reading evidence logged ${period === "daily" ? "today" : "this week"}`
      };
    }

    if (matchesGoal(goal, "creative.build_project", "creative") || goal.category === "coding" || goal.category === "project") {
      return {
        goalId: goal.id,
        title: goal.title,
        status: metrics.commits > 0 ? "progress" : "no_progress",
        note: metrics.commits > 0
          ? `${metrics.commits} personal commit${metrics.commits === 1 ? "" : "s"} detected`
          : `No personal coding evidence logged ${period === "daily" ? "today" : "this week"}`
      };
    }

    if (matchesGoal(goal, "finance.control_betting_trading", "finance")) {
      if (metrics.cooldowns > 0) {
        return {
          goalId: goal.id,
          title: goal.title,
          status: "risk",
          note: `${metrics.cooldowns} cooldown event${metrics.cooldowns === 1 ? "" : "s"} logged`
        };
      }

      if (metrics.thesisLogs > 0) {
        return {
          goalId: goal.id,
          title: goal.title,
          status: "progress",
          note: `${metrics.thesisLogs} thesis log${metrics.thesisLogs === 1 ? "" : "s"} before risk`
        };
      }

      if (metrics.impulseLatest && metrics.impulseLatest.value <= 3) {
        return {
          goalId: goal.id,
          title: goal.title,
          status: "stable",
          note: `${metrics.impulseLatest.kind} impulse logged low at ${metrics.impulseLatest.value}/10`
        };
      }

      return {
        goalId: goal.id,
        title: goal.title,
        status: metrics.impulseLatest ? "risk" : "no_progress",
        note: metrics.impulseLatest
          ? `${metrics.impulseLatest.kind} impulse logged at ${metrics.impulseLatest.value}/10`
          : `No risk-control evidence logged ${period === "daily" ? "today" : "this week"}`
      };
    }

    const hasProgress = goal.templateId
      ? events.some((event) => eventTypes.has(event.type))
      : false;

    return {
      goalId: goal.id,
      title: goal.title,
      status: hasProgress ? "progress" : "custom",
      note: hasProgress ? "Relevant event logged" : "No custom progress logged"
    };
  });
}

function hasCustomGoalConfig(goal: Goal): boolean {
  return Boolean(goal.targetMetrics?.length || goal.checkInConfig?.length);
}

function customProgressForGoal(goal: Goal, events: StoredEvent[]): { logs: number; minutes: number; notes: number } {
  const progressEvents = events.filter(
    (event) => event.type === "custom.goal_progress_logged" && event.data.goalId === goal.id
  );

  return {
    logs: progressEvents.length,
    minutes: progressEvents.reduce((total, event) => {
      const value = event.data.value;
      return event.data.unit === "minutes" && typeof value === "number" ? total + value : total;
    }, 0),
    notes: progressEvents.filter((event) => typeof event.data.note === "string" && event.data.note.trim()).length
  };
}

function formatCustomProgressNote(progress: { logs: number; minutes: number; notes: number }): string {
  const parts = [`${progress.logs} progress log${progress.logs === 1 ? "" : "s"}`];

  if (progress.minutes > 0) {
    parts.push(`${progress.minutes} focused minutes`);
  }

  if (progress.notes > 0) {
    parts.push(`${progress.notes} note${progress.notes === 1 ? "" : "s"}`);
  }

  return parts.join(", ");
}

function customProgressWins(activeGoals: Goal[], events: StoredEvent[]): string[] {
  return activeGoals
    .filter((goal) => !goal.templateId)
    .map((goal) => {
      const progress = customProgressForGoal(goal, events);
      return progress.logs > 0 ? `${goal.title}: ${formatCustomProgressNote(progress)}` : undefined;
    })
    .filter((item): item is string => Boolean(item));
}

function buildGoalGaps(goalProgress: InsightGoalProgress[]): string[] {
  return goalProgress
    .filter((goal) => goal.status === "no_progress")
    .map((goal) => `No logged progress for ${goal.title}`);
}

function dedupeGoalsForInsight(activeGoals: Goal[]): Goal[] {
  const uniqueGoals: Goal[] = [];

  for (const goal of activeGoals) {
    const existingIndex = uniqueGoals.findIndex((existingGoal) => areDuplicateGoalsForInsight(existingGoal, goal));

    if (existingIndex === -1) {
      uniqueGoals.push(goal);
      continue;
    }

    if (shouldPreferGoal(goal, uniqueGoals[existingIndex])) {
      uniqueGoals[existingIndex] = goal;
    }
  }

  return uniqueGoals;
}

function areDuplicateGoalsForInsight(left: Goal, right: Goal): boolean {
  const leftTitle = normalizeGoalTitleForInsight(left.title);
  const rightTitle = normalizeGoalTitleForInsight(right.title);

  return (
    leftTitle === rightTitle ||
    Boolean(left.templateId && right.templateId && left.templateId === right.templateId) ||
    (leftTitle === rightTitle && left.category === right.category)
  );
}

function shouldPreferGoal(candidate: Goal, existing: Goal): boolean {
  if (candidate.templateId && !existing.templateId) {
    return true;
  }

  if (!candidate.templateId && existing.templateId) {
    return false;
  }

  return candidate.createdAt.getTime() > existing.createdAt.getTime();
}

function normalizeGoalTitleForInsight(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ");
}

function withDuplicateGoalPattern(patterns: string[], hasDuplicateGoals: boolean): string[] {
  return hasDuplicateGoals ? [...patterns, "Duplicate goals exist and should be cleaned up."] : patterns;
}

function relevantMemorySignals(memories: MemoryEntry[], risks: string[]): string[] {
  const operatorReflections = memories
    .filter((memory) => memory.status === "active" && memory.data?.kind === "operator_reflection")
    .slice(0, 2)
    .map((memory) => memory.summary);

  const riskSignals = risks.length === 0
    ? []
    : memories
    .filter((memory) => memory.status === "active" && memory.type === "risk_pattern")
    .slice(0, 3)
    .map((memory) => memory.summary);

  return [...operatorReflections, ...riskSignals].slice(0, 3);
}

function recommendDailyActions(activeGoals: Goal[], metrics: ReturnType<typeof summarizeMetrics>, events: StoredEvent[]): string[] {
  const actions: string[] = [];
  const hasElevatedRisk =
    metrics.cooldowns > 0 ||
    Boolean(metrics.impulseLatest && metrics.impulseLatest.value >= 6) ||
    Boolean(metrics.anxietyLatest !== undefined && metrics.anxietyLatest >= 7) ||
    Boolean(metrics.sleepLatest !== undefined && metrics.sleepLatest < 6);

  if (hasElevatedRisk) {
    actions.push("No betting/trading decisions while anxiety is 7 or higher, impulse is 6 or higher, or sleep is below 6h.");
  }

  const customGoal = preferredCustomGoalForRecommendation(activeGoals, events);

  if (customGoal) {
    const progress = customProgressForGoal(customGoal, events);
    actions.push(
      progress.logs > 0
        ? `Do one more concrete action for ${customGoal.title} or deliberately stop for today.`
        : `Log one concrete action for ${customGoal.title}.`
    );
  }

  if (hasGoal(activeGoals, "career.job_search", "career")) {
    actions.push("Send 2 applications before checking markets or feeds.");
  }

  if (hasGoal(activeGoals, "health.strength_energy", "health")) {
    actions.push("Train 30-45 minutes or take a real rest day deliberately.");
  }

  if (hasGoal(activeGoals, "learning.reading_more", "learning")) {
    actions.push("Read 20 minutes before passive scrolling.");
  }

  if (!hasElevatedRisk && hasGoal(activeGoals, "finance.control_betting_trading", "finance")) {
    actions.push("No betting/trading decisions while anxiety is 7 or higher, impulse is 6 or higher, or sleep is below 6h.");
  }

  if (actions.length === 0) {
    actions.push("Log one meaningful action before the next review.");
  }

  return unique(actions).slice(0, 4);
}

function preferredCustomGoalForRecommendation(activeGoals: Goal[], events: StoredEvent[]): Goal | undefined {
  const customGoals = activeGoals.filter((goal) => !goal.templateId);

  return (
    [...customGoals]
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .find((goal) => customProgressForGoal(goal, events).logs > 0) ??
    customGoals.sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())[0]
  );
}

function recommendWeeklyActions(activeGoals: Goal[], metrics: ReturnType<typeof summarizeMetrics>, risks: string[]): string[] {
  const actions: string[] = [];
  const hasWeeklyRisk =
    metrics.cooldowns > 0 ||
    metrics.highImpulseEvents > 0 ||
    metrics.highAnxietyDays >= 2 ||
    metrics.lowSleepDays >= 2;

  if (hasWeeklyRisk) {
    actions.push("Keep a hard no-risk rule when sleep is below 6h, anxiety is 7+, or impulse is 6+.");
  }

  if (hasGoal(activeGoals, "career.job_search", "career")) {
    actions.push("Set 3 fixed job-search blocks.");
  }

  if (hasGoal(activeGoals, "health.strength_energy", "health")) {
    actions.push("Train 3 times.");
  }

  if (hasGoal(activeGoals, "learning.reading_more", "learning")) {
    actions.push("Read 20 minutes on 4 days.");
  }

  if (!hasWeeklyRisk && (risks.length > 0 || hasGoal(activeGoals, "finance.control_betting_trading", "finance"))) {
    actions.push("Keep a hard no-risk rule when sleep is below 6h, anxiety is 7+, or impulse is 6+.");
  }

  if (actions.length === 0) {
    actions.push("Choose one measurable weekly target and log it daily.");
  }

  return unique(actions).slice(0, 4);
}

function dailyHeadline(wins: string[], risks: string[], directProfile: boolean, hasCustomProgress: boolean): string {
  if (wins.length > 0 && risks.length > 0) {
    return directProfile ? "Good output. Risk state is the main issue." : "Good output, but risk state is elevated.";
  }

  if (hasCustomProgress) {
    return "Custom goal progress logged.";
  }

  if (wins.length > 0) {
    return directProfile ? "Real progress. Keep this factual." : "Real progress logged today.";
  }

  if (risks.length > 0) {
    return directProfile ? "Risk state is the main issue." : "Risk state is elevated without enough productive output.";
  }

  return "Low activity day. Get one concrete action logged.";
}

function weeklyHeadline(wins: string[], risks: string[], directProfile: boolean): string {
  if (risks.length > 0) {
    return directProfile
      ? "Progress exists. Risk and consistency need work."
      : "Progress exists, but risk and consistency need attention.";
  }

  if (wins.length > 0) {
    return directProfile
      ? "Progress exists. Consistency is the bottleneck."
      : "Progress exists, but consistency is still the bottleneck.";
  }

  return "Low signal week. The system needs more evidence.";
}

function buildDailySummary(
  wins: string[],
  risks: string[],
  directProfile: boolean,
  metrics: ReturnType<typeof summarizeMetrics>
): string {
  if (wins.length > 0 && risks.length > 0) {
    const riskText = joinReadableList(risks);
    return directProfile
      ? `You logged ${joinReadableList(wins)}. Real progress. The problem is the risk state: ${riskText}. No betting or trading decisions tonight.`
      : `You logged ${joinReadableList(wins)}. Real progress. The risk state is elevated: ${riskText}. No betting or trading decisions tonight.`;
  }

  if (wins.length > 0) {
    return directProfile
      ? `You logged ${joinReadableList(wins)}. Good output. Keep this factual and repeatable.`
      : `You logged ${joinReadableList(wins)}. Keep the next block simple and measurable.`;
  }

  if (risks.length > 0) {
    return directProfile
      ? `The main signal today is risk: ${joinReadableList(risks)}. Stabilize before decisions.`
      : `The main signal today is risk: ${joinReadableList(risks)}. Stabilize before making decisions.`;
  }

  if (metrics.repoActivity > 0) {
    return "GitHub repo activity was detected, but no personal commits were identified.";
  }

  if (metrics.unverifiedGithubCommits > 0) {
    return "GitHub commit activity exists, but it is unverified. No personal commits were identified.";
  }

  return "There is not enough logged evidence today. One honest check-in or concrete action would improve the signal.";
}

function buildWeeklySummary(metrics: ReturnType<typeof summarizeMetrics>): string {
  const parts = [
    metrics.applications > 0 ? `${metrics.applications} applications sent` : undefined,
    metrics.applicationConfirmations > 0 ? `${metrics.applicationConfirmations} confirmations` : undefined,
    metrics.recruiterReplies > 0 ? `${metrics.recruiterReplies} recruiter replies` : undefined,
    metrics.interviews > 0 ? `${metrics.interviews} interview signals` : undefined,
    metrics.rejections > 0 ? `${metrics.rejections} rejections` : undefined,
    metrics.offers > 0 ? `${metrics.offers} offers` : undefined,
    metrics.workoutMinutes > 0 ? `${metrics.workoutSessions} workouts / ${metrics.workoutMinutes} minutes` : undefined,
    metrics.readingMinutes > 0 ? `${metrics.readingMinutes} minutes of reading` : undefined,
    metrics.commits > 0 ? `${metrics.commits} personal commit${metrics.commits === 1 ? "" : "s"}` : undefined,
    metrics.repoActivity > 0 ? `${metrics.repoActivity} repo activity signal${metrics.repoActivity === 1 ? "" : "s"} detected` : undefined,
    metrics.customProgressLogs > 0
      ? `${metrics.customProgressLogs} custom progress log${metrics.customProgressLogs === 1 ? "" : "s"}${metrics.customProgressMinutes > 0 ? ` / ${metrics.customProgressMinutes} focused minutes` : ""}`
      : undefined,
    metrics.sleepAverage !== undefined ? `avg sleep ${round(metrics.sleepAverage)}h` : undefined,
    metrics.energyAverage !== undefined ? `avg energy ${round(metrics.energyAverage)}/10` : undefined,
    metrics.anxietyAverage !== undefined ? `avg anxiety ${round(metrics.anxietyAverage)}/10` : undefined,
    metrics.focusAverage !== undefined ? `avg focus ${round(metrics.focusAverage)}/10` : undefined,
    metrics.cooldowns > 0 ? `${metrics.cooldowns} cooldowns` : undefined,
    metrics.checkIns > 0 ? `${metrics.checkIns} check-ins` : undefined
  ].filter((part): part is string => Boolean(part));

  return parts.length > 0 ? `This week: ${joinReadableList(parts)}.` : "This week has very little logged evidence.";
}

function hasGoal(goals: Goal[], templateId: string, category: string): boolean {
  return goals.some((goal) => matchesGoal(goal, templateId, category));
}

function matchesGoal(goal: Goal, templateId: string, category: string): boolean {
  return goal.templateId === templateId || goal.category === category;
}

function isDirectProfile(profile: UserOperatingProfile): boolean {
  return profile.directness >= 5 || profile.motivationalStyle === "tough_love" || profile.gamblingGuardrails === "hard_guardian";
}

function count(events: StoredEvent[], type: string): number {
  return events.filter((event) => event.type === type).length;
}

function countAny(events: StoredEvent[], types: string[]): number {
  return events.filter((event) => types.includes(event.type)).length;
}

function countPersonalCommitEvents(events: StoredEvent[]): number {
  return events.filter(isPersonalCommitEvent).length;
}

function countUnverifiedGithubCommitEvents(events: StoredEvent[]): number {
  return events.filter(
    (event) =>
      event.type === "coding.commit_created" &&
      event.source === "github" &&
      event.data.isPersonal !== true
  ).length;
}

function isPersonalCommitEvent(event: StoredEvent): boolean {
  if (event.type !== "coding.commit_created") {
    return false;
  }

  if (event.source === "github") {
    return event.data.isPersonal === true;
  }

  return true;
}

function isPersonalProgressEvent(event: StoredEvent): boolean {
  return (
    [
      "career.application_sent",
      "career.application_confirmation_received",
      "career.recruiter_reply_received",
      "career.interview_scheduled",
      "career.rejection_received",
      "career.offer_received",
      "health.workout_completed",
      "learning.reading_session_completed",
      "custom.goal_progress_logged",
      "work.deep_work_session_completed",
      "work.task_completed"
    ].includes(event.type) || isPersonalCommitEvent(event)
  );
}

function sum(events: StoredEvent[], type: string, key: string): number {
  return events
    .filter((event) => event.type === type)
    .reduce((total, event) => total + numberValue(event, key), 0);
}

function sumCustomMinutes(events: StoredEvent[]): number {
  return events
    .filter((event) => event.type === "custom.goal_progress_logged")
    .reduce((total, event) => {
      const value = event.data.value;
      return event.data.unit === "minutes" && typeof value === "number" ? total + value : total;
    }, 0);
}

function latest(events: StoredEvent[], type: string, key: string): number | undefined {
  const event = [...events].reverse().find((item) => item.type === type);
  const value = event?.data[key];
  return typeof value === "number" ? value : undefined;
}

function average(events: StoredEvent[], type: string, key: string): number | undefined {
  const values = events
    .filter((event) => event.type === type)
    .map((event) => event.data[key])
    .filter((value): value is number => typeof value === "number");
  return values.length > 0 ? values.reduce((total, value) => total + value, 0) / values.length : undefined;
}

function latestImpulse(events: StoredEvent[]): { kind: string; value: number } | undefined {
  const event = [...events].reverse().find((item) => item.type === "reflection.impulse_logged");
  const value = event?.data.value;

  if (typeof value !== "number") {
    return undefined;
  }

  const kind = event?.data.kind;
  return {
    kind: typeof kind === "string" ? kind : "financial",
    value
  };
}

function numberValue(event: StoredEvent, key: string): number {
  const value = event.data[key];
  return typeof value === "number" ? value : 0;
}

function distinctDays(events: StoredEvent[]): number {
  return new Set(events.map((event) => event.timestamp.toISOString().slice(0, 10))).size;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}

function unique(items: string[]): string[] {
  return [...new Set(items)];
}

function joinReadableList(items: string[]): string {
  if (items.length <= 1) {
    return items[0] ?? "";
  }

  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
