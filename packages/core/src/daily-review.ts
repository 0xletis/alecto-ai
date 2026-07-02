import { z } from "zod";
import type { Goal } from "./goals.js";
import type { StoredEvent } from "./events.js";

export const DailyReviewSchema = z.object({
  userId: z.string(),
  summary: z.string(),
  wins: z.array(z.string()),
  gaps: z.array(z.string()),
  suggestedFocus: z.string()
});

export interface BuildDailyReviewInput {
  userId: string;
  activeGoals: Goal[];
  todayEvents: StoredEvent[];
}

export type DailyReview = z.infer<typeof DailyReviewSchema>;

export function buildDailyReview(input: BuildDailyReviewInput): DailyReview {
  const eventSummaries = summarizeEvents(input.todayEvents);
  const wins = eventSummaries.length > 0 ? eventSummaries : ["No logged wins yet today"];
  const gaps = buildGaps(input.activeGoals, input.todayEvents);
  const suggestedFocus = buildSuggestedFocus(input.activeGoals, gaps);
  const summary =
    eventSummaries.length > 0
      ? `Today: ${joinReadableList(eventSummaries)}.`
      : "No events logged yet today.";

  return DailyReviewSchema.parse({
    userId: input.userId,
    summary,
    wins,
    gaps,
    suggestedFocus
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

  const eventDomains = new Set(todayEvents.map((event) => event.type.split(".")[0]));
  const gaps = activeGoals
    .filter((goal) => !eventDomains.has(goal.category))
    .map((goal) => `No logged progress for ${goal.title}`);

  return gaps.length > 0 ? gaps : ["No obvious gaps from logged events"];
}

function buildSuggestedFocus(activeGoals: Goal[], gaps: string[]): string {
  const firstGoal = activeGoals[0];

  if (firstGoal) {
    return `Move one concrete step on ${firstGoal.title}.`;
  }

  if (gaps.includes("No active goals set")) {
    return "Create one active goal so the agent can track progress against it.";
  }

  return "Log one meaningful action before the day ends.";
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
