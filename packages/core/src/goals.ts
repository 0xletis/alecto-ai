import { z } from "zod";

export const GoalStatusSchema = z.enum(["active", "paused", "archived"]);

export const GoalSchema = z.object({
  id: z.string(),
  userId: z.string(),
  title: z.string().min(1),
  category: z.string().min(1),
  status: GoalStatusSchema.default("active"),
  why: z.string().optional(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date()
});

export const CreateGoalInputSchema = z.object({
  title: z.string().min(1),
  category: z.string().min(1),
  why: z.string().optional()
});

export type GoalStatus = z.infer<typeof GoalStatusSchema>;
export type Goal = z.infer<typeof GoalSchema>;
export type CreateGoalInput = z.infer<typeof CreateGoalInputSchema>;
