import { z } from "zod";

const scale = z.number().int().min(1).max(5);

export const UserOperatingProfileSchema = z.object({
  id: z.string().optional(),
  userId: z.string(),
  directness: scale.default(3),
  warmth: scale.default(3),
  humor: scale.default(2),
  confrontation: scale.default(3),
  verbosity: scale.default(3),
  profanityAllowed: z.boolean().default(false),
  motivationalStyle: z.string().default("strategic"),
  accountabilityStrictness: scale.default(3),
  reminderFrequency: z.string().default("medium"),
  escalationStyle: z.string().default("firm"),
  requiresEvidence: z.boolean().default(true),
  gamblingGuardrails: z.string().default("strict"),
  selfDeceptionSensitivity: scale.default(4),
  cooldownPreference: z.string().default("require_confirmation"),
  vulnerableMode: z.string().default("soften"),
  avoidingMode: z.string().default("challenge"),
  impulsiveMode: z.string().default("guardian_mode"),
  effectivePhrases: z.array(z.string()).optional(),
  ineffectivePhrases: z.array(z.string()).optional(),
  knownTriggers: z.array(z.string()).optional(),
  knownFailureModes: z.array(z.string()).optional(),
  knownStrengths: z.array(z.string()).optional(),
  createdAt: z.coerce.date().optional(),
  updatedAt: z.coerce.date().optional()
});

export const UpdateUserOperatingProfileInputSchema = UserOperatingProfileSchema.omit({
  id: true,
  userId: true,
  createdAt: true,
  updatedAt: true
}).partial();

export type UserOperatingProfile = z.infer<typeof UserOperatingProfileSchema>;
export type UpdateUserOperatingProfileInput = z.infer<typeof UpdateUserOperatingProfileInputSchema>;
