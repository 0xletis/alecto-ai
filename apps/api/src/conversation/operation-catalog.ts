import type {
  ConversationContext,
  ConversationOperationName,
  ConversationVisibleEntityType
} from "@operator-agent/core";

export interface AvailableOperationDefinition {
  name: ConversationOperationName;
  mutates: boolean;
  requiresConfirmation: boolean;
  validEntityTypes: ConversationVisibleEntityType[];
  allowedContextScopes: Array<ConversationContext["lastAssistantOutputType"] | "any">;
  requiredFields: string[];
  description: string;
}

export function buildAvailableOperationsCatalog(context: ConversationContext): AvailableOperationDefinition[] {
  const all = allOperationDefinitions();

  return all.filter((operation) =>
    operation.allowedContextScopes.includes("any") ||
    operation.allowedContextScopes.includes(context.lastAssistantOutputType)
  );
}

export function allOperationDefinitions(): AvailableOperationDefinition[] {
  return [
    operation("show_today", false, false, [], ["any"], [], "Show the daily operator brief."),
    operation("show_operator_attention", false, false, [], ["any"], [], "Show what needs attention."),
    operation("show_action_hygiene", false, false, [], ["any"], [], "Show action hygiene cleanup candidates."),
    operation("show_email_reviews", false, false, [], ["any"], [], "Show pending email reviews."),
    operation("show_gmail_status", false, false, [], ["any"], [], "Show Gmail status and rule behavior."),
    operation("show_weekly_review", false, false, [], ["any"], [], "Show weekly review."),
    operation("answer_recent_mutation_status", false, false, [], ["any"], [], "Answer what changed recently."),
    operation("archive_action", true, true, ["action"], ["action_hygiene_list", "actions_list"], ["target"], "Archive an action after confirmation."),
    operation("complete_action", true, false, ["action"], ["action_hygiene_list", "actions_list"], ["target"], "Complete an action."),
    operation("snooze_action", true, false, ["action"], ["action_hygiene_list", "actions_list"], ["target", "timeText"], "Snooze an action."),
    operation("keep_action", true, false, ["action"], ["action_hygiene_list"], ["target"], "Keep an action for now."),
    operation("bulk_action_hygiene_update", true, true, ["action"], ["action_hygiene_list"], ["legacyMessage"], "Apply a batch action hygiene update."),
    operation("approve_email_review", true, false, ["email_review"], ["email_review_list"], ["target"], "Approve an email review."),
    operation("reject_email_review", true, false, ["email_review"], ["email_review_list"], ["target"], "Reject an email review."),
    operation("email_review_to_action", true, false, ["email_review"], ["email_review_list"], ["target"], "Turn an email review into an action."),
    operation("pause_gmail_rule", true, false, ["gmail_rule"], ["gmail_rule_list"], ["target"], "Pause a Gmail rule."),
    operation("resume_gmail_rule", true, false, ["gmail_rule"], ["gmail_rule_list"], ["target"], "Resume a Gmail rule."),
    operation("remove_gmail_rule", true, true, ["gmail_rule"], ["gmail_rule_list"], ["target"], "Remove a Gmail rule after confirmation."),
    operation("update_gmail_rule_filters", true, true, ["gmail_rule"], ["gmail_rule_list"], ["target"], "Update Gmail rule filters after validation."),
    operation("create_plan_action", true, false, ["plan_suggestion"], ["plan_suggestions"], ["target"], "Create an action from a plan suggestion."),
    operation("edit_plan_suggestion", true, false, ["plan_suggestion"], ["plan_suggestions"], ["target"], "Edit a pending plan suggestion."),
    operation("skip_plan", true, false, [], ["plan_suggestions"], [], "Skip a pending plan."),
    operation("create_goal", true, true, [], ["any"], ["title"], "Create a goal after confirmation."),
    operation("create_memory", true, false, [], ["any"], ["summary"], "Create a memory from an explicit remember request."),
    operation("log_progress", true, false, [], ["any"], ["evidence"], "Log progress when explicitly supported."),
    operation("risk_guardrail_response", true, false, [], ["any"], [], "Return a hard risk guardrail response."),
    operation("request_clarification", false, false, [], ["any"], ["reply"], "Ask for clarification without mutation."),
    operation("confirm_pending", true, false, [], ["any"], [], "Confirm a pending decision."),
    operation("cancel_pending", true, false, [], ["any"], [], "Cancel a pending decision.")
  ];
}

function operation(
  name: ConversationOperationName,
  mutates: boolean,
  requiresConfirmation: boolean,
  validEntityTypes: ConversationVisibleEntityType[],
  allowedContextScopes: Array<ConversationContext["lastAssistantOutputType"] | "any">,
  requiredFields: string[],
  description: string
): AvailableOperationDefinition {
  return {
    name,
    mutates,
    requiresConfirmation,
    validEntityTypes,
    allowedContextScopes,
    requiredFields,
    description
  };
}
