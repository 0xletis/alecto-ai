import { z } from "zod";

const scale = z.number().int().min(1).max(5);

export const UserOperatingProfileSchema = z.object({
  userId: z.string(),
  directness: scale.default(3),
  warmth: scale.default(3),
  humor: scale.default(2),
  confrontation: scale.default(3),
  verbosity: scale.default(3),
  profanityAllowed: z.boolean().default(false),
  motivationalStyle: z.string().default("practical"),
  accountabilityStrictness: scale.default(3),
  reminderFrequency: z.enum(["low", "medium", "high"]).default("medium"),
  escalationStyle: z.enum(["soft", "direct", "guardian"]).default("direct"),
  requiresEvidence: z.boolean().default(true),
  gamblingGuardrails: z.enum(["off", "standard", "hard"]).default("standard"),
  selfDeceptionSensitivity: scale.default(3),
  cooldownPreference: z.string().default("24h"),
  vulnerableMode: z.enum(["soft", "steady", "direct"]).default("steady"),
  avoidingMode: z.enum(["curious", "direct", "confrontational"]).default("direct"),
  impulsiveMode: z.enum(["pause", "guardian", "block"]).default("guardian")
});

export type UserOperatingProfile = z.infer<typeof UserOperatingProfileSchema>;

