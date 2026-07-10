import { z } from "zod";

export const MemoryEntryTypeSchema = z.enum([
  "preference",
  "goal_context",
  "pattern",
  "risk_pattern",
  "communication_style",
  "important_fact",
  "note"
]);

export const MemoryEntryStatusSchema = z.enum(["active", "archived", "rejected"]);
export const MemoryEntrySourceSchema = z.enum([
  "manual",
  "explicit_user_request",
  "system_inferred",
  "llm_inferred"
]);

export const MemoryEntrySchema = z.object({
  id: z.string(),
  userId: z.string(),
  type: MemoryEntryTypeSchema,
  status: MemoryEntryStatusSchema,
  summary: z.string().min(1),
  data: z.record(z.unknown()).optional(),
  evidence: z.record(z.unknown()).optional(),
  source: MemoryEntrySourceSchema,
  confidence: z.number().min(0).max(1).default(1),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date()
});

export const CreateMemoryInputSchema = z.object({
  type: MemoryEntryTypeSchema.default("note"),
  summary: z.string().min(1),
  data: z.record(z.unknown()).optional(),
  evidence: z.record(z.unknown()).optional(),
  source: MemoryEntrySourceSchema.optional(),
  confidence: z.number().min(0).max(1).optional()
});

export const PendingMemoryCreatePayloadSchema = z.object({
  type: MemoryEntryTypeSchema,
  summary: z.string().min(1),
  data: z.record(z.unknown()).optional(),
  evidence: z.record(z.unknown()).optional(),
  source: z.enum(["system_inferred", "llm_inferred"]),
  confidence: z.number().min(0).max(1)
});

export type MemoryEntryType = z.infer<typeof MemoryEntryTypeSchema>;
export type MemoryEntryStatus = z.infer<typeof MemoryEntryStatusSchema>;
export type MemoryEntrySource = z.infer<typeof MemoryEntrySourceSchema>;
export type MemoryEntry = z.infer<typeof MemoryEntrySchema>;
export type CreateMemoryInput = z.infer<typeof CreateMemoryInputSchema>;
export type PendingMemoryCreatePayload = z.infer<typeof PendingMemoryCreatePayloadSchema>;
