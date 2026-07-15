import { z } from "zod";
import { GoalCheckInQuestionSchema, GoalMetricSchema } from "./goals.js";
import type { UserOperatingProfile } from "./user-operating-profile.js";

export const CustomGoalConfigInputSchema = z.object({
  title: z.string().min(1),
  why: z.string().optional(),
  category: z.string().optional(),
  userProfile: z.unknown().optional()
});

export const CustomGoalConfigSchema = z.object({
  category: z.string().min(1),
  targetMetrics: z.array(GoalMetricSchema),
  checkInConfig: z.array(GoalCheckInQuestionSchema),
  suggestedLogExamples: z.array(z.string())
});

export const CustomGoalProgressInputSchema = z.object({
  metricKey: z.string().min(1).optional(),
  value: z.union([z.number(), z.string(), z.boolean()]).optional(),
  unit: z.string().optional(),
  note: z.string().optional()
});

export interface BuildCustomGoalConfigInput {
  title: string;
  why?: string;
  category?: string;
  userProfile?: UserOperatingProfile;
}

export type CustomGoalConfig = z.infer<typeof CustomGoalConfigSchema>;
export type CustomGoalProgressInput = z.infer<typeof CustomGoalProgressInputSchema>;

export function buildCustomGoalConfig(input: BuildCustomGoalConfigInput): CustomGoalConfig {
  const text = `${input.title} ${input.why ?? ""} ${input.category ?? ""}`.toLowerCase();

  if (/\b(youtube|content|write|writing|create|creator|publish|newsletter|video|videos?)\b/.test(text)) {
    return CustomGoalConfigSchema.parse({
      category: preferredCategory(input.category, "creative", ["custom", "work"]),
      targetMetrics: [
        customMetric("sessions", "Focused sessions", "count", "daily"),
        customMetric("focused_minutes", "Focused minutes", "sum", "weekly", "minutes"),
        customMetric("outputs_created", "Outputs created", "count", "weekly")
      ],
      checkInConfig: [
        customQuestion("focused_minutes", "How many focused minutes did you put into creating?"),
        customQuestion("outputs_created", "What did you publish, draft, or create?"),
        customQuestion("avoidance", "What did you avoid?")
      ],
      suggestedLogExamples: [
        "/log_progress <goalId> | metric=focused_minutes value=45 unit=minutes note=script draft",
        "/log_progress <goalId> | metric=outputs_created value=1 note=published one short"
      ]
    });
  }

  if (/\b(confidence|charisma|social|conversation|conversations|people|dating|speak|speaking)\b/.test(text)) {
    return CustomGoalConfigSchema.parse({
      category: preferredCategory(input.category, "social", ["custom"]),
      targetMetrics: [
        customMetric("interactions", "Real interactions", "count", "weekly"),
        customMetric("practice_sessions", "Practice sessions", "count", "weekly")
      ],
      checkInConfig: [
        customQuestion("interaction", "What real interaction did you do?"),
        customQuestion("uncomfortable", "What felt uncomfortable but useful?")
      ],
      suggestedLogExamples: [
        "/log_progress <goalId> | metric=interactions value=1 note=started one conversation",
        "/log_progress <goalId> | practiced small talk for 20 minutes"
      ]
    });
  }

  if (/\b(language|study|learn|learning|course|spanish|english|rust|practice|skill)\b/.test(text)) {
    return CustomGoalConfigSchema.parse({
      category: preferredCategory(input.category, "learning", ["custom"]),
      targetMetrics: [
        customMetric("study_minutes", "Study minutes", "sum", "weekly", "minutes"),
        customMetric("practice_sessions", "Practice sessions", "count", "weekly")
      ],
      checkInConfig: [
        customQuestion("study_minutes", "How many minutes did you study or practice?"),
        customQuestion("learned", "What did you learn or practice?")
      ],
      suggestedLogExamples: [
        "/log_progress <goalId> | metric=study_minutes value=30 unit=minutes note=grammar drills",
        "/log_progress <goalId> | metric=practice_sessions value=1 note=conversation practice"
      ]
    });
  }

  if (/\b(sleep|health|gym|train|training|workout|steps|energy)\b/.test(text)) {
    return CustomGoalConfigSchema.parse({
      category: preferredCategory(input.category, "health", ["custom"]),
      targetMetrics: [
        customMetric("focused_minutes", "Focused minutes", "sum", "weekly", "minutes"),
        customMetric("progress_actions", "Progress actions", "count", "weekly")
      ],
      checkInConfig: [
        customQuestion("concrete_action", "What concrete health action did you complete?"),
        customQuestion("state", "What did your body/energy tell you?")
      ],
      suggestedLogExamples: [
        "/log_progress <goalId> | metric=focused_minutes value=30 unit=minutes note=mobility work",
        "/log_progress <goalId> | metric=progress_actions value=1 note=planned recovery"
      ]
    });
  }

  return CustomGoalConfigSchema.parse({
    category: input.category ?? "custom",
    targetMetrics: [
      customMetric("progress_actions", "Progress actions", "count", "weekly"),
      customMetric("focused_minutes", "Focused minutes", "sum", "weekly", "minutes")
    ],
    checkInConfig: [
      customQuestion("concrete_action", "What concrete action moved this forward?"),
      customQuestion("avoided", "What did you avoid or postpone?")
    ],
    suggestedLogExamples: [
      "/log_progress <goalId> | metric=focused_minutes value=45 unit=minutes note=focused block",
      "/log_progress <goalId> | metric=progress_actions value=1 note=one concrete step"
    ]
  });
}

function preferredCategory(inputCategory: string | undefined, fallback: string, replaceable: string[]): string {
  return inputCategory && !replaceable.includes(inputCategory) ? inputCategory : fallback;
}

function customMetric(
  key: string,
  label: string,
  aggregation: "count" | "sum" | "average" | "latest",
  window: "daily" | "weekly",
  unit?: string
) {
  return {
    key,
    label,
    eventType: "custom.goal_progress_logged",
    aggregation,
    window,
    unit
  };
}

function customQuestion(key: string, question: string) {
  return {
    key,
    question,
    answerType: "text"
  };
}
