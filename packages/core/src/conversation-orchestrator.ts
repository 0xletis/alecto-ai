import { z } from "zod";

export const ConversationOutputTypeSchema = z.enum([
  "action_hygiene_list",
  "actions_list",
  "email_review_list",
  "gmail_rule_list",
  "plan_suggestions",
  "operator_attention",
  "daily_review",
  "weekly_review",
  "unknown"
]);

export const ConversationVisibleEntityTypeSchema = z.enum([
  "action",
  "email_review",
  "gmail_rule",
  "plan_suggestion"
]);

export const ConversationOperationNameSchema = z.enum([
  "show_today",
  "show_operator_attention",
  "show_action_hygiene",
  "show_email_reviews",
  "show_gmail_status",
  "show_weekly_review",
  "answer_recent_mutation_status",
  "archive_action",
  "complete_action",
  "snooze_action",
  "keep_action",
  "bulk_action_hygiene_update",
  "approve_email_review",
  "reject_email_review",
  "email_review_to_action",
  "pause_gmail_rule",
  "resume_gmail_rule",
  "remove_gmail_rule",
  "update_gmail_rule_filters",
  "create_plan_action",
  "edit_plan_suggestion",
  "skip_plan",
  "create_goal",
  "create_memory",
  "log_progress",
  "risk_guardrail_response",
  "request_clarification",
  "confirm_pending",
  "cancel_pending"
]);

export const ConversationOperationTargetSchema = z.object({
  referenceType: z.enum(["visible_number", "entity_id", "text", "all_visible", "all_except_visible"]),
  value: z.string().min(1).max(240),
  entityType: ConversationVisibleEntityTypeSchema.optional()
});

export const ConversationPlannedOperationSchema = z.object({
  name: ConversationOperationNameSchema,
  target: ConversationOperationTargetSchema.optional(),
  fields: z.record(z.unknown()).default({}),
  mutates: z.boolean().default(false),
  requiresConfirmation: z.boolean().default(false),
  reason: z.string().max(240).optional()
});

export const ConversationOperationPlanSchema = z.object({
  intent: z.string().min(1).max(120),
  operations: z.array(ConversationPlannedOperationSchema).max(20).default([]),
  needsConfirmation: z.boolean().default(false),
  clarificationQuestion: z.string().max(500).optional(),
  confidence: z.number().min(0).max(1).default(0),
  language: z.enum(["en", "es", "ca", "unknown"]).default("unknown"),
  safetyNotes: z.array(z.string().max(240)).max(10).default([]),
  responseHints: z.array(z.string().max(240)).max(10).default([]),
  source: z.enum(["deterministic", "llm", "legacy"]).default("deterministic")
});

export type ConversationOutputType = z.infer<typeof ConversationOutputTypeSchema>;
export type ConversationVisibleEntityType = z.infer<typeof ConversationVisibleEntityTypeSchema>;
export type ConversationOperationName = z.infer<typeof ConversationOperationNameSchema>;
export type ConversationOperationTarget = z.infer<typeof ConversationOperationTargetSchema>;
export type ConversationPlannedOperation = z.infer<typeof ConversationPlannedOperationSchema>;
export type ConversationOperationPlan = z.infer<typeof ConversationOperationPlanSchema>;

export interface ConversationVisibleEntity {
  displayNumber?: number;
  entityType: ConversationVisibleEntityType;
  entityId: string;
  title: string;
  status?: string;
  allowedOperations: ConversationOperationName[];
  metadata?: Record<string, unknown>;
}

export interface ConversationFocusedEntity {
  entityType: ConversationVisibleEntityType;
  entityId: string;
  title: string;
}

export interface ConversationPendingConfirmation {
  pendingActionId: string;
  scope: string;
  operationSummary: string;
  expiresAt?: Date;
}

export interface ConversationRecentMutation {
  summary: string;
  reply: string;
  createdAt?: Date;
}

export interface ConversationContext {
  userId: string;
  lastAssistantOutputType: z.infer<typeof ConversationOutputTypeSchema>;
  visibleEntities: ConversationVisibleEntity[];
  focusedEntity?: ConversationFocusedEntity;
  pendingConfirmation?: ConversationPendingConfirmation;
  recentMutations: ConversationRecentMutation[];
  contextCreatedBy?: string;
  language?: "en" | "es" | "ca" | "unknown";
  createdAt: Date;
  expiresAt?: Date;
}

export interface ConversationExecutionResult {
  succeeded: string[];
  skipped: string[];
  needsClarification: string[];
  needsConfirmation: string[];
  errorsSafe: string[];
  mutationSummary?: string;
  reply?: string;
  mutated: boolean;
}

export function normalizeConversationOperationPlan(value: unknown): ConversationOperationPlan {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const operations = Array.isArray(record.operations)
    ? record.operations.map((operation) => {
        if (!operation || typeof operation !== "object" || Array.isArray(operation)) {
          return operation;
        }

        const operationRecord = operation as Record<string, unknown>;
        return {
          ...operationRecord,
          target: operationRecord.target === null ? undefined : operationRecord.target,
          reason: operationRecord.reason === null ? undefined : operationRecord.reason
        };
      })
    : [];

  return ConversationOperationPlanSchema.parse({
    intent: record.intent,
    operations,
    needsConfirmation: record.needsConfirmation === true,
    clarificationQuestion: typeof record.clarificationQuestion === "string" ? record.clarificationQuestion : undefined,
    confidence: typeof record.confidence === "number" ? record.confidence : 0,
    language: record.language ?? "unknown",
    safetyNotes: Array.isArray(record.safetyNotes) ? record.safetyNotes : [],
    responseHints: Array.isArray(record.responseHints) ? record.responseHints : [],
    source: record.source ?? "deterministic"
  });
}
