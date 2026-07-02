import { z } from "zod";
import { EventSchema } from "@operator-agent/core";

export const IntentSchema = z.enum([
  "general_chat",
  "emotional_reflection",
  "goal_creation",
  "goal_update",
  "event_logging",
  "research_request",
  "coding_help",
  "financial_impulse",
  "betting_intent",
  "trading_intent",
  "daily_checkin",
  "weekly_review",
  "integration_setup",
  "memory_correction"
]);

export const AgentModeSchema = z.enum([
  "mirror",
  "support",
  "guardian",
  "builder",
  "research",
  "fiscal",
  "review"
]);

export const IntentRouterResultSchema = z.object({
  intent: IntentSchema,
  mode: AgentModeSchema,
  confidence: z.number().min(0).max(1),
  riskRelevant: z.boolean().default(false),
  rationale: z.string().optional()
});

export const EventExtractionResultSchema = z.object({
  events: z.array(EventSchema).default([]),
  ignored: z.boolean().default(false),
  rationale: z.string().optional()
});

export type Intent = z.infer<typeof IntentSchema>;
export type AgentMode = z.infer<typeof AgentModeSchema>;
export type IntentRouterResult = z.infer<typeof IntentRouterResultSchema>;
export type EventExtractionResult = z.infer<typeof EventExtractionResultSchema>;

