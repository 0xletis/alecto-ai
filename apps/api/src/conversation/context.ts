import type {
  ConversationContext,
  ConversationFocusedEntity,
  ConversationOperationName,
  ConversationOutputType,
  ConversationRecentMutation,
  ConversationVisibleEntity
} from "@operator-agent/core";
import type { PendingAction } from "@operator-agent/db";

interface PendingActionCandidate {
  id: string;
  title: string;
  status: string;
  dueAt?: string;
  snoozedUntil?: string;
  goalId?: string;
  goalTitleSnapshot?: string;
  recommendedOptions?: string[];
}

interface EmailRuleCandidate {
  id: string;
  name: string;
  status: string;
}

export function buildConversationContext(input: {
  userId: string;
  pendingAction?: PendingAction;
  now?: Date;
}): ConversationContext {
  const now = input.now ?? new Date();
  const pendingAction = input.pendingAction;
  const visibleEntities = pendingAction ? visibleEntitiesFromPendingAction(pendingAction) : [];
  const recentMutations = pendingAction ? recentMutationsFromPendingAction(pendingAction) : [];
  const pendingConfirmation = pendingAction && isConfirmationBackedPendingAction(pendingAction)
    ? {
        pendingActionId: pendingAction.id,
        scope: pendingAction.type,
        operationSummary: pendingAction.summary,
        expiresAt: pendingAction.expiresAt
      }
    : undefined;

  return {
    userId: input.userId,
    lastAssistantOutputType: outputTypeFromPendingAction(pendingAction),
    visibleEntities,
    focusedEntity: pendingAction ? focusedEntityFromPendingAction(pendingAction, visibleEntities) : undefined,
    pendingConfirmation,
    recentMutations,
    contextCreatedBy: pendingAction ? contextCreatedByFromPendingAction(pendingAction) : undefined,
    language: "unknown",
    createdAt: now,
    expiresAt: pendingAction?.expiresAt
  };
}

function outputTypeFromPendingAction(pendingAction?: PendingAction): ConversationOutputType {
  if (!pendingAction) {
    return "unknown";
  }

  if (pendingAction.type === "action_hygiene") {
    return "action_hygiene_list";
  }

  if (pendingAction.type === "email_review_context") {
    return "email_review_list";
  }

  if (pendingAction.type === "custom_email_rule") {
    return "gmail_rule_list";
  }

  if (pendingAction.type === "next_week_plan") {
    return "plan_suggestions";
  }

  if (pendingAction.type === "action_target_clarification" || pendingAction.type === "action_archive") {
    return "actions_list";
  }

  return "unknown";
}

function visibleEntitiesFromPendingAction(pendingAction: PendingAction): ConversationVisibleEntity[] {
  if (pendingAction.type === "action_hygiene" || pendingAction.type === "action_target_clarification" || pendingAction.type === "action_archive") {
    return readPendingActionCandidates(pendingAction.payload.candidateActions).map((candidate, index) => ({
      displayNumber: index + 1,
      entityType: "action",
      entityId: candidate.id,
      title: candidate.title,
      status: candidate.status,
      allowedOperations: allowedActionOperations(candidate.status, candidate.recommendedOptions),
      metadata: {
        dueAt: candidate.dueAt,
        snoozedUntil: candidate.snoozedUntil,
        goalId: candidate.goalId,
        goalTitle: candidate.goalTitleSnapshot,
        recommendedOptions: candidate.recommendedOptions
      }
    }));
  }

  if (pendingAction.type === "custom_email_rule") {
    return readEmailRuleCandidates(pendingAction.payload.visibleRules ?? pendingAction.payload.candidateRules).map((candidate, index) => ({
      displayNumber: index + 1,
      entityType: "gmail_rule",
      entityId: candidate.id,
      title: candidate.name,
      status: candidate.status,
      allowedOperations: ["pause_gmail_rule", "resume_gmail_rule", "remove_gmail_rule", "update_gmail_rule_filters"]
    }));
  }

  if (pendingAction.type === "email_review_context") {
    return readGenericVisibleEntities(pendingAction.payload.visibleItems ?? pendingAction.payload.candidateReviews, "email_review");
  }

  if (pendingAction.type === "next_week_plan") {
    return readGenericVisibleEntities(pendingAction.payload.suggestions, "plan_suggestion");
  }

  return [];
}

function focusedEntityFromPendingAction(
  pendingAction: PendingAction,
  visibleEntities: ConversationVisibleEntity[]
): ConversationFocusedEntity | undefined {
  if (pendingAction.type === "custom_email_rule") {
    const focusedRuleId = typeof pendingAction.payload.focusedRuleId === "string" ? pendingAction.payload.focusedRuleId : undefined;
    const focused = focusedRuleId ? visibleEntities.find((entity) => entity.entityId === focusedRuleId) : visibleEntities[0];
    return focused ? { entityType: focused.entityType, entityId: focused.entityId, title: focused.title } : undefined;
  }

  return undefined;
}

function recentMutationsFromPendingAction(pendingAction: PendingAction): ConversationRecentMutation[] {
  if (
    pendingAction.type === "action_hygiene" &&
    pendingAction.payload.operation === "recent_mutation_status"
  ) {
    return [{
      summary: typeof pendingAction.payload.summary === "string" ? pendingAction.payload.summary : "Recent action changes",
      reply: typeof pendingAction.payload.reply === "string" ? pendingAction.payload.reply : "",
      createdAt: pendingAction.createdAt
    }];
  }

  return [];
}

function isConfirmationBackedPendingAction(pendingAction: PendingAction): boolean {
  if (pendingAction.type === "action_archive") {
    return true;
  }

  if (pendingAction.type === "action_hygiene") {
    return pendingAction.payload.operation === "batch_update" || pendingAction.payload.operation === "bulk_archive";
  }

  if (pendingAction.type === "custom_email_rule") {
    return pendingAction.payload.operation === "archive_rule" || pendingAction.payload.operation === "archive_rules";
  }

  return false;
}

function allowedActionOperations(status: string, recommendedOptions?: string[]): ConversationOperationName[] {
  if (status === "archived" || status === "completed") {
    return [];
  }

  if (recommendedOptions && recommendedOptions.length > 0) {
    return recommendedOptions.flatMap((option): ConversationOperationName[] => {
      if (option === "archive") {
        return ["archive_action"];
      }
      if (option === "complete") {
        return ["complete_action"];
      }
      if (option === "snooze") {
        return ["snooze_action"];
      }
      if (option === "keep") {
        return ["keep_action"];
      }
      return [];
    });
  }

  return ["archive_action", "complete_action", "snooze_action", "keep_action"];
}

function contextCreatedByFromPendingAction(pendingAction: PendingAction): string {
  return typeof pendingAction.payload.createdBy === "string"
    ? pendingAction.payload.createdBy
    : "legacy";
}

function readPendingActionCandidates(value: unknown): PendingActionCandidate[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isRecord)
    .map((item) => ({
      id: typeof item.id === "string" ? item.id : "",
      title: typeof item.title === "string" ? item.title : "",
      status: typeof item.status === "string" ? item.status : "",
      dueAt: typeof item.dueAt === "string" ? item.dueAt : undefined,
      snoozedUntil: typeof item.snoozedUntil === "string" ? item.snoozedUntil : undefined,
      goalId: typeof item.goalId === "string" ? item.goalId : undefined,
      goalTitleSnapshot: typeof item.goalTitleSnapshot === "string" ? item.goalTitleSnapshot : undefined,
      recommendedOptions: Array.isArray(item.recommendedOptions)
        ? item.recommendedOptions.filter((option): option is string => typeof option === "string")
        : undefined
    }))
    .filter((item) => item.id && item.title);
}

function readEmailRuleCandidates(value: unknown): EmailRuleCandidate[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isRecord)
    .map((item) => ({
      id: typeof item.id === "string" ? item.id : "",
      name: typeof item.name === "string" ? item.name : "",
      status: typeof item.status === "string" ? item.status : ""
    }))
    .filter((item) => item.id && item.name);
}

function readGenericVisibleEntities(
  value: unknown,
  entityType: ConversationVisibleEntity["entityType"]
): ConversationVisibleEntity[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isRecord)
    .map((item, index) => {
      const id = typeof item.id === "string" ? item.id : typeof item.actionId === "string" ? item.actionId : "";
      const title = typeof item.title === "string" ? item.title : typeof item.subject === "string" ? item.subject : "";

      return {
        displayNumber: index + 1,
        entityType,
        entityId: id,
        title,
        status: typeof item.status === "string" ? item.status : undefined,
        allowedOperations: [] as ConversationOperationName[],
        metadata: item
      };
    })
    .filter((item) => item.entityId && item.title);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
