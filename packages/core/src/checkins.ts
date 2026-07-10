import { z } from "zod";

export const DailyCheckInAnswerSchema = z.object({
  key: z.string().min(1),
  value: z.union([z.string(), z.number(), z.boolean()])
});

export const DailyCheckInInputSchema = z.object({
  answers: z.array(DailyCheckInAnswerSchema)
});

export type DailyCheckInAnswer = z.infer<typeof DailyCheckInAnswerSchema>;
export type DailyCheckInInput = z.infer<typeof DailyCheckInInputSchema>;
