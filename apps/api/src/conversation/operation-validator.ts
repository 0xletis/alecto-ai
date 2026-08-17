import type {
  ConversationContext,
  ConversationOperationPlan,
  ConversationPlannedOperation
} from "@operator-agent/core";
import type { AvailableOperationDefinition } from "./operation-catalog.js";

export interface ConversationValidationResult {
  ok: boolean;
  operations: ConversationPlannedOperation[];
  safeReply?: string;
  failureReasons: string[];
}

export function validateConversationOperationPlan(input: {
  plan: ConversationOperationPlan;
  context: ConversationContext;
  availableOperations: AvailableOperationDefinition[];
}): ConversationValidationResult {
  const definitionsByName = new Map(input.availableOperations.map((operation) => [operation.name, operation]));
  const failureReasons: string[] = [];
  const validOperations: ConversationPlannedOperation[] = [];

  for (const operation of input.plan.operations) {
    const definition = definitionsByName.get(operation.name);

    if (!definition) {
      failureReasons.push(`${operation.name}: operation is not available in this context`);
      continue;
    }

    const missingField = definition.requiredFields.find((field) => !hasRequiredField(operation, field));
    if (missingField) {
      failureReasons.push(`${operation.name}: missing ${missingField}`);
      continue;
    }

    if (operation.name === "confirm_pending" || operation.name === "cancel_pending") {
      if (!input.context.pendingConfirmation && input.context.recentMutations.length === 0) {
        failureReasons.push(`${operation.name}: no pending decision is waiting`);
        continue;
      }
    }

    if (operation.target?.entityType && definition.validEntityTypes.length > 0) {
      const visible = input.context.visibleEntities.find((entity) =>
        entity.entityType === operation.target?.entityType &&
        (entity.entityId === operation.target?.value ||
          String(entity.displayNumber) === operation.target?.value ||
          entity.title.toLowerCase() === operation.target?.value.toLowerCase())
      );

      if (!visible) {
        failureReasons.push(`${operation.name}: target is not visible`);
        continue;
      }

      if (!visible.allowedOperations.includes(operation.name)) {
        failureReasons.push(`${operation.name}: operation is not allowed for target`);
        continue;
      }
    }

    validOperations.push({
      ...operation,
      mutates: definition.mutates
    });
  }

  if (validOperations.length === 0) {
    return {
      ok: false,
      operations: [],
      failureReasons,
      safeReply: failureReasons.some((reason) => reason.includes("no pending decision"))
        ? "No pending change is waiting right now."
        : "I could not safely match that to the current conversation. Show the list again and try from there."
    };
  }

  return {
    ok: true,
    operations: validOperations,
    failureReasons
  };
}

function hasRequiredField(operation: ConversationPlannedOperation, field: string): boolean {
  if (field === "target") {
    return Boolean(operation.target);
  }

  const value = operation.fields[field];
  if (typeof value === "string") {
    return value.trim().length > 0;
  }

  return value !== undefined && value !== null;
}
