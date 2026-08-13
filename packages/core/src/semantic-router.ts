import { z } from "zod";

export const SemanticRouterIntentSchema = z.enum([
  "capability_help",
  "quickstart",
  "setup_state",
  "configure_goals",
  "configure_actions",
  "configure_daily_loop",
  "configure_integrations",
  "daily_operator",
  "start_day",
  "daily_review",
  "weekly_review",
  "ambiguous_plan",
  "current_week_plan",
  "next_week_plan",
  "action_hygiene",
  "show_goals",
  "show_actions",
  "show_memory",
  "email_review_inbox",
  "email_review_action",
  "email_rules_list",
  "integration_guidance",
  "integration_sync",
  "daily_loop_settings",
  "gmail_capability_guidance",
  "gmail_setup",
  "gmail_autonomy_preference",
  "gmail_sync",
  "gmail_sync_guidance",
  "enable_job_search_email_rule",
  "enable_work_action_email_rule",
  "gmail_custom_rule_request",
  "gmail_custom_rule_edit",
  "gmail_custom_rule_edit_pending",
  "gmail_custom_rule_manage",
  "gmail_rule_question",
  "conversation_repair",
  "unknown"
]);

export const SemanticRouterOperationSchema = z.enum([
  "create",
  "edit",
  "edit_pending",
  "pause",
  "resume",
  "remove",
  "sync",
  "status",
  "help",
  "answer",
  "timing",
  "plan",
  "review",
  "repair",
  "none"
]);

export const SemanticRouterLanguageSchema = z.enum(["en", "es", "ca", "unknown"]);

export const SemanticRouterSideEffectRiskSchema = z.enum([
  "none",
  "read",
  "write",
  "destructive",
  "unsafe"
]);

export const SemanticRouterResultSchema = z.object({
  intent: SemanticRouterIntentSchema,
  operation: SemanticRouterOperationSchema,
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).max(240),
  language: SemanticRouterLanguageSchema.default("unknown"),
  sideEffectRisk: SemanticRouterSideEffectRiskSchema.default("none"),
  requiresConfirmation: z.boolean().default(false),
  target: z.string().max(120).nullable(),
  keywordFilters: z.array(z.string().min(1).max(80)).max(8),
  senderFilters: z.array(z.string().min(3).max(120)).max(5),
  removeKeywordFilters: z.array(z.string().min(1).max(80)).max(8),
  goalHint: z.string().max(120).nullable(),
  shouldUnlinkGoal: z.boolean(),
  userFacingIssue: z.string().max(180).nullable()
});

export type SemanticRouterIntent = z.infer<typeof SemanticRouterIntentSchema>;
export type SemanticRouterOperation = z.infer<typeof SemanticRouterOperationSchema>;
export type SemanticRouterLanguage = z.infer<typeof SemanticRouterLanguageSchema>;
export type SemanticRouterSideEffectRisk = z.infer<typeof SemanticRouterSideEffectRiskSchema>;
export type SemanticRouterResult = z.infer<typeof SemanticRouterResultSchema>;

export function normalizeSemanticRouterResult(value: unknown): SemanticRouterResult {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};

  return SemanticRouterResultSchema.parse({
    intent: record.intent,
    operation: record.operation ?? "none",
    confidence: record.confidence,
    reason: record.reason,
    language: record.language ?? "unknown",
    sideEffectRisk: record.sideEffectRisk ?? "none",
    requiresConfirmation: record.requiresConfirmation === true,
    target: typeof record.target === "string" ? record.target : null,
    keywordFilters: Array.isArray(record.keywordFilters) ? record.keywordFilters : [],
    senderFilters: Array.isArray(record.senderFilters) ? record.senderFilters : [],
    removeKeywordFilters: Array.isArray(record.removeKeywordFilters) ? record.removeKeywordFilters : [],
    goalHint: typeof record.goalHint === "string" ? record.goalHint : null,
    shouldUnlinkGoal: record.shouldUnlinkGoal === true,
    userFacingIssue: typeof record.userFacingIssue === "string" ? record.userFacingIssue : null
  });
}
