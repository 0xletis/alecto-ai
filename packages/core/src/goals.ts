import { z } from "zod";

export const GoalStatusSchema = z.enum(["active", "paused", "archived", "completed"]);

export const GoalSchema = z.object({
  id: z.string(),
  userId: z.string(),
  title: z.string().min(1),
  description: z.string().optional(),
  status: GoalStatusSchema.default("active"),
  targetDate: z.coerce.date().optional(),
  metrics: z.record(z.unknown()).default({}),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date()
});

export type GoalStatus = z.infer<typeof GoalStatusSchema>;
export type Goal = z.infer<typeof GoalSchema>;

