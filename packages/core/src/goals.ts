import { z } from "zod";

export const GoalStatusSchema = z.enum(["active", "paused", "archived"]);
export const MetricAggregationSchema = z.enum(["count", "sum", "average", "latest"]);
export const MetricWindowSchema = z.enum(["daily", "weekly"]);
export const CheckInAnswerTypeSchema = z.enum(["text", "number", "scale_1_10", "yes_no"]);

export const GoalMetricSchema = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  eventType: z.string().optional(),
  aggregation: MetricAggregationSchema,
  window: MetricWindowSchema
});

export const GoalCheckInQuestionSchema = z.object({
  key: z.string().min(1),
  question: z.string().min(1),
  answerType: CheckInAnswerTypeSchema
});

export const GoalSchema = z.object({
  id: z.string(),
  userId: z.string(),
  title: z.string().min(1),
  category: z.string().min(1),
  status: GoalStatusSchema.default("active"),
  why: z.string().optional(),
  templateId: z.string().optional(),
  targetMetrics: z.array(GoalMetricSchema).optional(),
  checkInConfig: z.array(GoalCheckInQuestionSchema).optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date()
});

export const CreateGoalInputSchema = z.object({
  title: z.string().min(1),
  category: z.string().min(1),
  why: z.string().optional(),
  templateId: z.string().optional(),
  targetMetrics: z.array(GoalMetricSchema).optional(),
  checkInConfig: z.array(GoalCheckInQuestionSchema).optional(),
  allowDuplicate: z.boolean().optional()
});

export const CreateGoalFromTemplateInputSchema = z.object({
  templateId: z.string().min(1),
  title: z.string().min(1),
  why: z.string().optional(),
  targetMetrics: z.array(GoalMetricSchema).optional(),
  allowDuplicate: z.boolean().optional()
});

export type GoalStatus = z.infer<typeof GoalStatusSchema>;
export type GoalMetric = z.infer<typeof GoalMetricSchema>;
export type GoalCheckInQuestion = z.infer<typeof GoalCheckInQuestionSchema>;
export type Goal = z.infer<typeof GoalSchema>;
export type CreateGoalInput = z.infer<typeof CreateGoalInputSchema>;
export type CreateGoalFromTemplateInput = z.infer<typeof CreateGoalFromTemplateInputSchema>;

export interface GoalDuplicateWarning {
  goalId: string;
  similarGoalId: string;
  similarGoalTitle: string;
}

export function normalizeGoalTitle(title: string): string {
  return title
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ");
}

export function findDuplicateActiveGoal(
  input: Pick<CreateGoalInput, "title" | "category" | "templateId">,
  activeGoals: Goal[]
): Goal | undefined {
  const inputTitle = normalizeGoalTitle(input.title);

  return activeGoals.find((goal) => {
    const goalTitle = normalizeGoalTitle(goal.title);

    return (
      goalTitle === inputTitle ||
      Boolean(input.templateId && goal.templateId === input.templateId) ||
      (goal.category === input.category && areSimilarGoalTitles(goalTitle, inputTitle))
    );
  });
}

export function findGoalDuplicateWarnings(goals: Goal[]): GoalDuplicateWarning[] {
  const warnings: GoalDuplicateWarning[] = [];
  const activeGoals = goals.filter((goal) => goal.status === "active");

  for (let index = 0; index < activeGoals.length; index += 1) {
    const goal = activeGoals[index];
    const duplicate = findDuplicateActiveGoal(
      {
        title: goal.title,
        category: goal.category,
        templateId: goal.templateId
      },
      activeGoals.slice(index + 1)
    );

    if (duplicate) {
      warnings.push({
        goalId: goal.id,
        similarGoalId: duplicate.id,
        similarGoalTitle: duplicate.title
      });
    }
  }

  return warnings;
}

function areSimilarGoalTitles(left: string, right: string): boolean {
  if (!left || !right) {
    return false;
  }

  if (left.includes(right) || right.includes(left)) {
    return true;
  }

  const leftWords = meaningfulWords(left);
  const rightWords = meaningfulWords(right);
  const sharedWords = leftWords.filter((word) => rightWords.includes(word));
  const shortestLength = Math.min(leftWords.length, rightWords.length);

  return shortestLength > 0 && sharedWords.length / shortestLength >= 0.75;
}

function meaningfulWords(title: string): string[] {
  const stopWords = new Set(["a", "an", "and", "de", "el", "en", "la", "more", "my", "on", "the", "to", "un", "una", "y"]);
  return title.split(" ").filter((word) => word.length > 2 && !stopWords.has(word));
}
