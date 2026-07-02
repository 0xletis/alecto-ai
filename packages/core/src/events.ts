import { z } from "zod";
import { EventTypeSchema } from "./event-registry.js";

export const EventSourceSchema = z.enum(["chat", "connector", "llm_inferred", "system"]);

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

export type EventSource = z.infer<typeof EventSourceSchema>;
export type Event = z.infer<typeof EventSchema>;

