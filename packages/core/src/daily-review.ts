import { z } from "zod";
import { findDuplicateActiveGoal, findGoalDuplicateWarnings, type Goal } from "./goals.js";
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
  warnings: z.array(z.string()).default([])
});

export interface BuildDailyReviewInput {
  userId: string;
  activeGoals: Goal[];
  todayEvents: StoredEvent[];
}

export type DailyReview = z.infer<typeof DailyReviewSchema>;

export function buildDailyReview(input: BuildDailyReviewInput): DailyReview {
  const eventSummaries = summarizeEvents(input.todayEvents);
  const checkInSummaries = summarizeCheckIn(input.todayEvents);
  const combinedSummaries = [...eventSummaries, ...checkInSummaries];
  const wins = eventSummaries.length > 0 ? eventSummaries : ["No logged wins yet today"];
  const uniqueActiveGoals = dedupeActiveGoalsForReview(input.activeGoals);
  const gaps = buildGaps(uniqueActiveGoals, input.todayEvents);
  const suggestedFocus = buildSuggestedFocus(uniqueActiveGoals, gaps);
  const activeGoals = buildActiveGoalStatuses(uniqueActiveGoals, input.todayEvents);
  const warnings = buildDuplicateWarnings(input.activeGoals);
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
    warnings
  });
}

export function summarizeEvents(events: StoredEvent[]): string[] {
  const applications = sumNumber(events, "career.application_sent", "count");
  const trainingMinutes = sumNumber(events, "health.workout_completed", "duration_minutes");
  const sleepHours = sumNumber(events, "health.sleep_logged", "duration_hours");
  const readingMinutes = sumNumber(events, "learning.reading_session_completed", "duration_minutes");
  const summaries: string[] = [];

  if (applications > 0) {
    summaries.push(`${applications} job application${applications === 1 ? "" : "s"} sent`);
  }

  if (trainingMinutes > 0) {
    summaries.push(`${trainingMinutes} minutes of training`);
  }

  if (sleepHours > 0) {
    summaries.push(`${sleepHours} hours of sleep`);
  }

  if (readingMinutes > 0) {
    summaries.push(`${readingMinutes} minutes of reading`);
  }

  return summaries;
}

function buildGaps(activeGoals: Goal[], todayEvents: StoredEvent[]): string[] {
  if (activeGoals.length === 0) {
    return ["No active goals set"];
  }

  const todayEventTypes = new Set<string>(todayEvents.map((event) => event.type));
  const gaps = activeGoals
    .filter((goal) => {
      if (goal.templateId) {
        const template = getGoalTemplate(goal.templateId);
        return template ? !template.relevantEventTypes.some((eventType) => todayEventTypes.has(eventType)) : true;
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
      const template = getGoalTemplate(goal.templateId);
      const hasProgress = template?.relevantEventTypes.some((eventType) => todayEventTypes.has(eventType)) ?? false;

      return {
        title: goal.title,
        status: hasProgress ? "progress logged" : "no relevant event today",
        templateId: goal.templateId
      };
    }

    return {
      title: goal.title,
      status: "custom goal, no template metrics configured",
      templateId: goal.templateId
    };
  });
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
  const energy = latestNumber(events, "reflection.energy_logged", "value");
  const anxiety = latestNumber(events, "reflection.anxiety_logged", "value");
  const focus = latestNumber(events, "reflection.focus_logged", "value");
  const impulse = latestNumber(events, "reflection.impulse_logged", "value");

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
    summaries.push(`impulse: ${impulse}/10`);
  }

  return summaries;
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

function joinReadableList(items: string[]): string {
  if (items.length <= 1) {
    return items[0] ?? "";
  }

  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
