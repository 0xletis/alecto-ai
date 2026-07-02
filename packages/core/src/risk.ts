import { z } from "zod";

export const RiskStateSchema = z.enum(["GREEN", "YELLOW", "ORANGE", "RED", "BLACK"]);

export const RiskAssessmentSchema = z.object({
  state: RiskStateSchema,
  signals: z.array(z.string()).default([]),
  evidence: z.array(z.string()).default([]),
  assessedAt: z.coerce.date()
});

export type RiskState = z.infer<typeof RiskStateSchema>;
export type RiskAssessment = z.infer<typeof RiskAssessmentSchema>;

