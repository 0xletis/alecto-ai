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
  checkInConfig: z.array(GoalCheckInQuestionSchema).optional()
});

export const CreateGoalFromTemplateInputSchema = z.object({
  templateId: z.string().min(1),
  title: z.string().min(1),
  why: z.string().optional(),
  targetMetrics: z.array(GoalMetricSchema).optional()
});

export type GoalStatus = z.infer<typeof GoalStatusSchema>;
export type GoalMetric = z.infer<typeof GoalMetricSchema>;
export type GoalCheckInQuestion = z.infer<typeof GoalCheckInQuestionSchema>;
export type Goal = z.infer<typeof GoalSchema>;
export type CreateGoalInput = z.infer<typeof CreateGoalInputSchema>;
export type CreateGoalFromTemplateInput = z.infer<typeof CreateGoalFromTemplateInputSchema>;
