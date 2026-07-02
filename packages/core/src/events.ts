import { z } from "zod";
import { EventTypeSchema } from "./event-registry.js";

export const EventSourceSchema = z.enum(["chat", "connector", "llm_inferred", "system"]);
export const StoredEventSourceSchema = z.enum(["manual", "telegram"]);

export const EventSchema = z.object({
  id: z.string(),
  userId: z.string(),
  type: EventTypeSchema,
  occurredAt: z.coerce.date(),
  source: EventSourceSchema,
  data: z.record(z.unknown()).default({}),
  evidence: z.array(z.string()).default([]),
  createdAt: z.coerce.date()
});

export const StoredEventSchema = z.object({
  id: z.string(),
  userId: z.string(),
  type: EventTypeSchema,
  timestamp: z.coerce.date(),
  source: StoredEventSourceSchema,
  data: z.record(z.unknown()).default({}),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string()).optional(),
  createdAt: z.coerce.date()
});

export type EventSource = z.infer<typeof EventSourceSchema>;
export type Event = z.infer<typeof EventSchema>;
export type StoredEventSource = z.infer<typeof StoredEventSourceSchema>;
export type StoredEvent = z.infer<typeof StoredEventSchema>;
