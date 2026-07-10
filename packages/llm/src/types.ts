import { z } from "zod";
import {
  AgentModeSchema,
  ExtractedEventSchema,
  MessageIntentSchema,
  type EventTypeDefinition,
  type Goal,
  type MemoryEntry,
  type StoredEvent,
  type UserOperatingProfile
} from "@operator-agent/core";

export const ProposedCustomEventTypeSchema = z.object({
  name: z.string().min(1),
  reason: z.string().min(1),
  exampleData: z.record(z.unknown()).default({})
});

export const ProposedActionSchema = z.object({
  type: z.enum(["profile_update", "goal_create", "goal_archive", "none"]),
  summary: z.string(),
  payload: z.record(z.unknown()).default({}),
  confidence: z.number().min(0).max(1)
});

export const OpenAIMessageAnalysisSchema = z.object({
  intent: MessageIntentSchema,
  mode: AgentModeSchema,
  extractedEvents: z.array(ExtractedEventSchema).default([]),
  reasoningSummary: z.string(),
  suggestedReplyTone: z.string(),
  proposedCustomEventType: ProposedCustomEventTypeSchema.nullable(),
  proposedAction: ProposedActionSchema.nullable()
});

export const AnalyzeMessageInputSchema = z.object({
  userId: z.string().min(1),
  message: z.string().min(1),
  activeGoals: z.array(z.custom<Goal>()).default([]),
  recentEvents: z.array(z.custom<StoredEvent>()).default([]),
  activeMemories: z.array(z.custom<MemoryEntry>()).default([]),
  eventRegistry: z.array(z.custom<EventTypeDefinition>()),
  userOperatingProfile: z.custom<UserOperatingProfile>().optional()
});

export type ProposedCustomEventType = z.infer<typeof ProposedCustomEventTypeSchema>;
export type ProposedAction = z.infer<typeof ProposedActionSchema>;
export type OpenAIMessageAnalysis = z.infer<typeof OpenAIMessageAnalysisSchema>;
export type AnalyzeMessageInput = z.infer<typeof AnalyzeMessageInputSchema>;
