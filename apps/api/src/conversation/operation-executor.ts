import type {
  ConversationContext,
  ConversationExecutionResult,
  ConversationOperationPlan,
  ConversationPlannedOperation
} from "@operator-agent/core";
import type { PendingAction } from "@operator-agent/db";

export interface ConversationExecutorCallbacks {
  showActionHygiene(userId: string, message: string, now: Date): Promise<string>;
  showToday?(userId: string): Promise<string>;
  showOperatorAttention?(userId: string): Promise<string>;
  showEmailReviews?(userId: string): Promise<string>;
  showGmailStatus?(userId: string): Promise<string>;
  logProgressFromMessage?(userId: string, message: string): Promise<string>;
  createMemoryFromMessage?(userId: string, summary: string, originalMessage: string): Promise<string>;
  resolvePendingDecisionReply(
    userId: string,
    pendingAction: PendingAction,
    message: string
  ): Promise<string | undefined>;
}

export async function executeConversationOperations(input: {
  userId: string;
  message: string;
  context: ConversationContext;
  plan: ConversationOperationPlan;
  operations: ConversationPlannedOperation[];
  pendingAction?: PendingAction;
  callbacks: ConversationExecutorCallbacks;
}): Promise<ConversationExecutionResult> {
  const result: ConversationExecutionResult = {
    succeeded: [],
    skipped: [],
    needsClarification: [],
    needsConfirmation: [],
    errorsSafe: [],
    mutated: false
  };

  const replies: string[] = [];

  for (const operation of input.operations) {
    const reply = await executeOneOperation(input, operation);

    if (reply) {
      replies.push(reply);
      if (operation.mutates) {
        result.mutated = true;
      }
      result.succeeded.push(operation.reason ?? operation.name);
      continue;
    }

    result.skipped.push(operation.reason ?? `Could not handle ${operation.name}.`);
  }

  result.reply = replies.join("\n\n").trim() || undefined;
  result.mutationSummary = result.succeeded.join("; ");
  return result;
}

async function executeOneOperation(
  input: {
    userId: string;
    message: string;
    context: ConversationContext;
    plan: ConversationOperationPlan;
    pendingAction?: PendingAction;
    callbacks: ConversationExecutorCallbacks;
  },
  operation: ConversationPlannedOperation
): Promise<string | undefined> {
  if (operation.name === "request_clarification") {
    return typeof operation.fields.reply === "string"
      ? operation.fields.reply
      : input.plan.clarificationQuestion ?? "I need one more detail before changing anything.";
  }

  if (operation.name === "show_action_hygiene") {
    return input.callbacks.showActionHygiene(input.userId, input.message, input.context.createdAt);
  }

  if (operation.name === "show_today") {
    return input.callbacks.showToday?.(input.userId);
  }

  if (operation.name === "show_operator_attention") {
    return input.callbacks.showOperatorAttention?.(input.userId);
  }

  if (operation.name === "show_email_reviews") {
    return input.callbacks.showEmailReviews?.(input.userId);
  }

  if (operation.name === "show_gmail_status") {
    return input.callbacks.showGmailStatus?.(input.userId);
  }

  if (operation.name === "log_progress") {
    const evidence = typeof operation.fields.evidence === "string" && operation.fields.evidence.trim()
      ? operation.fields.evidence
      : input.message;
    return input.callbacks.logProgressFromMessage?.(input.userId, evidence);
  }

  if (operation.name === "create_memory") {
    const summary = typeof operation.fields.summary === "string" && operation.fields.summary.trim()
      ? operation.fields.summary
      : input.message;
    return input.callbacks.createMemoryFromMessage?.(input.userId, summary, input.message);
  }

  if (
    operation.name === "archive_action" ||
    operation.name === "complete_action" ||
    operation.name === "snooze_action" ||
    operation.name === "keep_action"
  ) {
    if (!input.pendingAction) {
      return "I don't have a visible cleanup item right now. Say 'clean up my tasks' first.";
    }

    return input.callbacks.resolvePendingDecisionReply(input.userId, input.pendingAction, legacyActionInstruction(operation));
  }

  if (operation.name === "answer_recent_mutation_status") {
    const recent = input.context.recentMutations[0];

    if (input.pendingAction) {
      const legacyReply = await input.callbacks.resolvePendingDecisionReply(input.userId, input.pendingAction, input.message);
      if (legacyReply) {
        return legacyReply;
      }
    }

    return recent?.reply ? recent.reply : "I do not have a recent change recorded.";
  }

  if (operation.name === "confirm_pending" || operation.name === "cancel_pending") {
    const legacyMessage = operation.name === "confirm_pending"
      ? String(operation.fields.legacyMessage ?? "yes")
      : String(operation.fields.legacyMessage ?? "no");

    if (!input.pendingAction) {
      return operation.name === "confirm_pending"
        ? "No pending change is waiting right now."
        : "Cancelled. I did not change anything.";
    }

    return input.callbacks.resolvePendingDecisionReply(input.userId, input.pendingAction, legacyMessage);
  }

  if (operation.name === "bulk_action_hygiene_update") {
    const legacyMessage = typeof operation.fields.legacyMessage === "string"
      ? operation.fields.legacyMessage
      : input.message;

    if (!input.pendingAction) {
      return "I don't have a visible cleanup item right now. Say 'clean up my tasks' first.";
    }

    return input.callbacks.resolvePendingDecisionReply(input.userId, input.pendingAction, legacyMessage);
  }

  return undefined;
}

function legacyActionInstruction(operation: ConversationPlannedOperation): string {
  const target = operationTargetToLegacyReference(operation);

  if (operation.name === "archive_action") {
    return `archive ${target}`;
  }

  if (operation.name === "complete_action") {
    return `complete ${target}`;
  }

  if (operation.name === "keep_action") {
    return `keep ${target}`;
  }

  const timeText = typeof operation.fields.timeText === "string" ? operation.fields.timeText : "";
  return `snooze ${target}${timeText ? ` ${timeText}` : ""}`;
}

function operationTargetToLegacyReference(operation: ConversationPlannedOperation): string {
  const target = operation.target;
  if (!target) {
    return "it";
  }

  if (target.referenceType === "visible_number") {
    return target.value;
  }

  if (target.referenceType === "all_visible") {
    return "all";
  }

  if (target.referenceType === "all_except_visible") {
    return `all except ${target.value}`;
  }

  return target.value;
}
