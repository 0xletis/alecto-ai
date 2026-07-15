import { z } from "zod";
import { findDuplicateActiveGoal, findGoalDuplicateWarnings, type Goal } from "./goals.js";
import type { MemoryEntry } from "./memory.js";
import type { StoredEvent } from "./events.js";
import { getGoalTemplate } from "./goal-templates.js";

export const DailyReviewGoalStatusSchema = z.object({
  title: z.string(),
  status: z.string(),
  templateId: z.string().optional()
});

export const DailyReviewSchema = z.object({
  userId: z.string(),
  summary: z.string(),
  wins: z.array(z.string()),
  gaps: z.array(z.string()),
  suggestedFocus: z.string(),
  activeGoals: z.array(DailyReviewGoalStatusSchema).default([]),
  checkIn: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
  memorySignals: z.array(z.string()).default([])
});

export interface BuildDailyReviewInput {
  userId: string;
  activeGoals: Goal[];
  todayEvents: StoredEvent[];
  activeMemories?: MemoryEntry[];
}

export type DailyReview = z.infer<typeof DailyReviewSchema>;

export function buildDailyReview(input: BuildDailyReviewInput): DailyReview {
  const progressSummaries = summarizeProgressEvents(input.todayEvents, input.activeGoals);
  const checkInSummaries = summarizeCheckIn(input.todayEvents);
  const combinedSummaries = [...progressSummaries, ...checkInSummaries];
  const winSummaries = summarizeWinEvents(input.todayEvents, input.activeGoals);
  const wins = winSummaries.length > 0 ? winSummaries : ["No logged wins yet today"];
  const uniqueActiveGoals = dedupeActiveGoalsForReview(input.activeGoals);
  const gaps = buildGaps(uniqueActiveGoals, input.todayEvents);
  const suggestedFocus = buildSuggestedFocus(uniqueActiveGoals, gaps);
  const activeGoals = buildActiveGoalStatuses(uniqueActiveGoals, input.todayEvents);
  const warnings = buildDuplicateWarnings(input.activeGoals);
  const memorySignals = buildMemorySignals(input.activeMemories ?? [], input.todayEvents);
  const summary =
    combinedSummaries.length > 0
      ? `Today: ${joinReadableList(combinedSummaries)}.`
      : "No events logged yet today.";

  return DailyReviewSchema.parse({
    userId: input.userId,
    summary,
    wins,
    gaps,
    suggestedFocus,
    activeGoals,
    checkIn: checkInSummaries,
    warnings,
    memorySignals
  });
}

export function summarizeEvents(events: StoredEvent[]): string[] {
  return [...summarizeProgressEvents(events), ...summarizeCheckIn(events)];
}

function summarizeProgressEvents(events: StoredEvent[], activeGoals: Goal[] = []): string[] {
  const applications = sumNumber(events, "career.application_sent", "count");
  const confirmations = countEvents(events, "career.application_confirmation_received");
  const replies = countEvents(events, "career.recruiter_reply_received");
  const interviews = countEvents(events, "career.interview_scheduled");
  const offers = countEvents(events, "career.offer_received");
  const trainingMinutes = sumNumber(events, "health.workout_completed", "duration_minutes");
  const readingMinutes = sumNumber(events, "learning.reading_session_completed", "duration_minutes");
  const summaries: string[] = [];

  if (applications > 0) {
    summaries.push(`${applications} job application${applications === 1 ? "" : "s"} sent`);
  }

  if (confirmations > 0) {
    summaries.push(`${confirmations} application confirmation${confirmations === 1 ? "" : "s"}`);
  }

  if (replies > 0) {
    summaries.push(`${replies} recruiter repl${replies === 1 ? "y" : "ies"}`);
  }

  if (interviews > 0) {
    summaries.push(`${interviews} interview${interviews === 1 ? "" : "s"} scheduled`);
  }

  if (offers > 0) {
    summaries.push(`${offers} offer${offers === 1 ? "" : "s"} received`);
  }

  const rejections = countEvents(events, "career.rejection_received");

  if (rejections > 0) {
    summaries.push(`${rejections} rejection${rejections === 1 ? "" : "s"} received`);
  }

  if (trainingMinutes > 0) {
    summaries.push(`${trainingMinutes} minutes of training`);
  }

  if (readingMinutes > 0) {
    summaries.push(`${readingMinutes} minutes of reading`);
  }

  summaries.push(...summarizeCustomProgress(events, activeGoals));

  return summaries;
}

function summarizeWinEvents(events: StoredEvent[], activeGoals: Goal[] = []): string[] {
  const applications = sumNumber(events, "career.application_sent", "count");
  const replies = countEvents(events, "career.recruiter_reply_received");
  const interviews = countEvents(events, "career.interview_scheduled");
  const offers = countEvents(events, "career.offer_received");
  const trainingMinutes = sumNumber(events, "health.workout_completed", "duration_minutes");
  const readingMinutes = sumNumber(events, "learning.reading_session_completed", "duration_minutes");
  const summaries: string[] = [];

  if (applications > 0) {
    summaries.push(`${applications} job application${applications === 1 ? "" : "s"} sent`);
  }

  if (replies > 0) {
    summaries.push(`${replies} recruiter repl${replies === 1 ? "y" : "ies"}`);
  }

  if (interviews > 0) {
    summaries.push(`${interviews} interview${interviews === 1 ? "" : "s"} scheduled`);
  }

  if (offers > 0) {
    summaries.push(`${offers} offer${offers === 1 ? "" : "s"} received`);
  }

  if (trainingMinutes > 0) {
    summaries.push(`${trainingMinutes} minutes of training`);
  }

  if (readingMinutes > 0) {
    summaries.push(`${readingMinutes} minutes of reading`);
  }

  summaries.push(...summarizeCustomProgress(events, activeGoals));

  return summaries;
}

function summarizeCustomProgress(events: StoredEvent[], activeGoals: Goal[]): string[] {
  const summaries: string[] = [];

  for (const goal of activeGoals.filter((item) => !item.templateId)) {
    const progress = customProgressForGoal(goal, events);

    if (progress.logs === 0) {
      continue;
    }

    summaries.push(
      progress.minutes > 0
        ? `${goal.title}: ${progress.minutes} focused minutes`
        : `${goal.title}: ${progress.logs} progress log${progress.logs === 1 ? "" : "s"}`
    );
  }

  return summaries;
}

function customProgressForGoal(goal: Goal, events: StoredEvent[]): { logs: number; minutes: number } {
  const progressEvents = events.filter(
    (event) => event.type === "custom.goal_progress_logged" && event.data.goalId === goal.id
  );

  return {
    logs: progressEvents.length,
    minutes: progressEvents.reduce((total, event) => {
      const value = event.data.value;
      return event.data.unit === "minutes" && typeof value === "number" ? total + value : total;
    }, 0)
  };
}

function buildGaps(activeGoals: Goal[], todayEvents: StoredEvent[]): string[] {
  if (activeGoals.length === 0) {
    return ["No active goals set"];
  }

  const todayEventTypes = new Set<string>(todayEvents.map((event) => event.type));
  const gaps = activeGoals
    .filter((goal) => {
      if (goal.templateId) {
        return goalStatusForTemplate(goal.templateId, todayEvents, todayEventTypes) === "no relevant event today";
      }

      return false;
    })
    .map((goal) => `No logged progress for ${goal.title}`);

  return gaps.length > 0 ? gaps : ["No obvious gaps from logged events"];
}

function buildSuggestedFocus(activeGoals: Goal[], gaps: string[]): string {
  const firstGap = gaps.find((gap) => gap.startsWith("No logged progress for "));

  if (firstGap) {
    const title = firstGap.replace("No logged progress for ", "");
    return `Do one concrete action for ${title}, or archive it if it is not a real priority.`;
  }

  const firstGoal = activeGoals[0];

  if (firstGoal) {
    return `Move one concrete step on ${firstGoal.title}.`;
  }

  if (gaps.includes("No active goals set")) {
    return "Create one active goal so the agent can track progress against it.";
  }

  return "Log one meaningful action before the day ends.";
}

function buildActiveGoalStatuses(activeGoals: Goal[], todayEvents: StoredEvent[]) {
  const todayEventTypes = new Set<string>(todayEvents.map((event) => event.type));

  return activeGoals.map((goal) => {
    if (goal.templateId) {
      return {
        title: goal.title,
        status: goalStatusForTemplate(goal.templateId, todayEvents, todayEventTypes),
        templateId: goal.templateId
      };
    }

    return {
      title: goal.title,
      status: customProgressStatus(goal, todayEvents),
      templateId: goal.templateId
    };
  });
}

function customProgressStatus(goal: Goal, events: StoredEvent[]): string {
  const progress = customProgressForGoal(goal, events);

  if (progress.logs === 0) {
    return "No custom progress logged";
  }

  return progress.minutes > 0
    ? `${progress.logs} progress log${progress.logs === 1 ? "" : "s"}, ${progress.minutes} focused minutes`
    : `${progress.logs} progress log${progress.logs === 1 ? "" : "s"}`;
}

function goalStatusForTemplate(templateId: string, events: StoredEvent[], todayEventTypes: Set<string>): string {
  if (templateId === "career.job_search") {
    return hasAny(todayEventTypes, [
      "career.application_sent",
      "career.application_confirmation_received",
      "career.recruiter_reply_received",
      "career.interview_scheduled",
      "career.interview_completed",
      "career.rejection_received",
      "career.offer_received",
      "career.cv_updated",
      "career.portfolio_updated"
    ])
      ? "progress logged"
      : "no relevant event today";
  }

  if (templateId === "health.strength_energy") {
    return hasAny(todayEventTypes, ["health.workout_completed", "health.steps_logged"])
      ? "progress logged"
      : "no relevant event today";
  }

  if (templateId === "learning.reading_more") {
    return hasAny(todayEventTypes, ["learning.reading_session_completed", "learning.note_created"])
      ? "progress logged"
      : "no relevant event today";
  }

  if (templateId === "finance.control_betting_trading") {
    if (todayEventTypes.has("finance.betting.cooldown_triggered")) {
      return "risk event logged";
    }

    if (todayEventTypes.has("finance.betting.bet_thesis_logged") || todayEventTypes.has("finance.trading.thesis_logged")) {
      return "process progress logged";
    }

    const impulse = latestImpulse(events);

    if (impulse !== undefined && impulse <= 3) {
      return "stable today";
    }

    if (impulse !== undefined) {
      return "risk state logged";
    }

    return "no relevant event today";
  }

  const template = getGoalTemplate(templateId);
  return template?.relevantEventTypes.some((eventType) => todayEventTypes.has(eventType))
    ? "progress logged"
    : "no relevant event today";
}

function hasAny(eventTypes: Set<string>, expectedTypes: string[]): boolean {
  return expectedTypes.some((eventType) => eventTypes.has(eventType));
}

function dedupeActiveGoalsForReview(activeGoals: Goal[]): Goal[] {
  const uniqueGoals: Goal[] = [];

  for (const goal of activeGoals) {
    if (
      findDuplicateActiveGoal(
        {
          title: goal.title,
          category: goal.category,
          templateId: goal.templateId
        },
        uniqueGoals
      )
    ) {
      continue;
    }

    uniqueGoals.push(goal);
  }

  return uniqueGoals;
}

function buildDuplicateWarnings(activeGoals: Goal[]): string[] {
  const warnings = findGoalDuplicateWarnings(activeGoals);
  const seen = new Set<string>();

  return warnings
    .map((warning) => warning.similarGoalTitle)
    .filter((title) => {
      if (seen.has(title)) {
        return false;
      }

      seen.add(title);
      return true;
    })
    .map((title) => `Possible duplicate goals: ${title} appears more than once.`);
}

function summarizeCheckIn(events: StoredEvent[]): string[] {
  const summaries: string[] = [];
  const sleep = latestNumber(events, "health.sleep_logged", "duration_hours");
  const energy = latestNumber(events, "reflection.energy_logged", "value");
  const anxiety = latestNumber(events, "reflection.anxiety_logged", "value");
  const focus = latestNumber(events, "reflection.focus_logged", "value");
  const impulse = latestImpulseWithKind(events);

  if (sleep !== undefined) {
    summaries.push(`slept ${sleep}h`);
  }

  if (energy !== undefined) {
    summaries.push(`energy: ${energy}/10`);
  }

  if (anxiety !== undefined) {
    summaries.push(`anxiety: ${anxiety}/10`);
  }

  if (focus !== undefined) {
    summaries.push(`focus: ${focus}/10`);
  }

  if (impulse !== undefined) {
    summaries.push(`${impulse.kind} impulse: ${impulse.value}/10`);
  }

  return summaries;
}

function latestImpulse(events: StoredEvent[]): number | undefined {
  return latestImpulseWithKind(events)?.value;
}

function latestImpulseWithKind(events: StoredEvent[]): { kind: string; value: number } | undefined {
  const event = [...events].reverse().find((item) => item.type === "reflection.impulse_logged");
  const value = event?.data.value;
  const kind = event?.data.kind;

  if (typeof value !== "number") {
    return undefined;
  }

  return {
    kind: typeof kind === "string" ? kind : "financial",
    value
  };
}

function latestNumber(events: StoredEvent[], type: StoredEvent["type"], key: string): number | undefined {
  const event = [...events].reverse().find((item) => item.type === type);
  const value = event?.data[key];
  return typeof value === "number" ? value : undefined;
}

function sumNumber(events: StoredEvent[], type: StoredEvent["type"], key: string): number {
  return events
    .filter((event) => event.type === type)
    .reduce((total, event) => {
      const value = event.data[key];
      return total + (typeof value === "number" ? value : 0);
    }, 0);
}

function countEvents(events: StoredEvent[], type: StoredEvent["type"]): number {
  return events.filter((event) => event.type === type).length;
}

function joinReadableList(items: string[]): string {
  if (items.length <= 1) {
    return items[0] ?? "";
  }

  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function buildMemorySignals(memories: MemoryEntry[], todayEvents: StoredEvent[]): string[] {
  const hasRiskEventToday = todayEvents.some(
    (event) => event.type === "finance.betting.cooldown_triggered" || event.type === "reflection.impulse_logged"
  );

  if (!hasRiskEventToday) {
    return [];
  }

  return memories
    .filter((memory) => memory.status === "active" && memory.type === "risk_pattern")
    .slice(0, 3)
    .map((memory) => memory.summary);
}
