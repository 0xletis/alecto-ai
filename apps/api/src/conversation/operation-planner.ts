import {
  ConversationOperationPlanSchema,
  type ConversationContext,
  type ConversationOperationPlan,
  type ConversationPlannedOperation
} from "@operator-agent/core";
import type { AvailableOperationDefinition } from "./operation-catalog.js";

export interface PlanConversationOperationsInput {
  message: string;
  context: ConversationContext;
  availableOperations: AvailableOperationDefinition[];
}

export async function planConversationOperations(
  input: PlanConversationOperationsInput
): Promise<ConversationOperationPlan | undefined> {
  const deterministic = planDeterministicOperations(input);
  if (deterministic) {
    return deterministic;
  }

  return undefined;
}

export function planDeterministicOperations(
  input: PlanConversationOperationsInput
): ConversationOperationPlan | undefined {
  const trimmed = input.message.trim();
  const normalized = normalizeMessage(trimmed);
  const language = detectLanguage(trimmed);

  if (!trimmed) {
    return undefined;
  }

  if (looksLikeConfirmation(trimmed)) {
    return operationPlan({
      intent: "confirm_pending",
      language,
      confidence: 0.98,
      operations: [{
        name: "confirm_pending",
        fields: { legacyMessage: "yes" },
        mutates: true,
        requiresConfirmation: false,
        reason: "User confirmed the current pending decision."
      }]
    });
  }

  if (looksLikeCancellation(trimmed)) {
    return operationPlan({
      intent: "cancel_pending",
      language,
      confidence: 0.98,
      operations: [{
        name: "cancel_pending",
        fields: { legacyMessage: "no" },
        mutates: true,
        requiresConfirmation: false,
        reason: "User cancelled the current pending decision."
      }]
    });
  }

  if (looksLikeActionHygieneRequest(normalized)) {
    return operationPlan({
      intent: "action_hygiene",
      language,
      confidence: 0.94,
      operations: [{
        name: "show_action_hygiene",
        fields: {},
        mutates: false,
        requiresConfirmation: false,
        reason: "User asked to review stale or overdue actions."
      }]
    });
  }

  if (input.context.lastAssistantOutputType === "action_hygiene_list") {
    const legacyMessage = normalizeActionHygieneInstruction(trimmed);

    if (legacyMessage) {
      return operationPlan({
        intent: "action_hygiene_reply",
        language,
        confidence: 0.9,
        operations: [{
          name: "bulk_action_hygiene_update",
          fields: { legacyMessage },
          mutates: true,
          requiresConfirmation: containsDestructiveAction(legacyMessage),
          reason: "User replied to visible action hygiene items."
        }]
      });
    }
  }

  if (input.context.visibleEntities.length === 0 && normalizeActionHygieneInstruction(trimmed)) {
    return operationPlan({
      intent: "action_hygiene_reply",
      language,
      confidence: 0.86,
      operations: [{
        name: "request_clarification",
        fields: {
          reply: "I don't have a visible cleanup item right now. Say 'clean up my tasks' first."
        },
        mutates: false,
        requiresConfirmation: false,
        reason: "User tried to update a visible cleanup item, but no cleanup item is visible."
      }]
    });
  }

  if (looksLikeRecentMutationQuestion(normalized)) {
    return operationPlan({
      intent: "answer_recent_mutation_status",
      language,
      confidence: 0.92,
      operations: [{
        name: "answer_recent_mutation_status",
        fields: {},
        mutates: false,
        requiresConfirmation: false,
        reason: "User is asking what Alecto changed recently."
      }]
    });
  }

  if (looksLikeCrossDomainVisibleEntityRequest(normalized, input.context)) {
    return operationPlan({
      intent: "request_clarification",
      language,
      confidence: 0.82,
      operations: [{
        name: "request_clarification",
        fields: {
          reply: "I don't see visible Endesa reviews or an active Endesa rule in this context. Say \"email reviews\" or \"Gmail rules\" first."
        },
        mutates: false,
        requiresConfirmation: false,
        reason: "The request targets Endesa, but Endesa is not visible in the current conversation context."
      }]
    });
  }

  return undefined;
}

function operationPlan(input: {
  intent: string;
  language: "en" | "es" | "ca" | "unknown";
  confidence: number;
  operations: ConversationPlannedOperation[];
}): ConversationOperationPlan {
  return ConversationOperationPlanSchema.parse({
    intent: input.intent,
    operations: input.operations,
    confidence: input.confidence,
    language: input.language,
    needsConfirmation: input.operations.some((operation) => operation.requiresConfirmation),
    source: "deterministic"
  });
}

function normalizeActionHygieneInstruction(message: string): string | undefined {
  const normalized = normalizeMessage(message);

  if (
    /\b(archive|delete|remove|arxiva|archiva|elimina|borra)\b/.test(normalized) &&
    /\b(tots|todos|todas|all)\b/.test(normalized) &&
    /\b(menys|menos|except|excepto)\b/.test(normalized)
  ) {
    if (/\b(snooze|pospon|pospone|posponer|ajorna|ajornar)\b/.test(normalized)) {
      return normalizeNumberedBatchSegments(normalizeLocalizedHygieneWords(message));
    }

    const exception = readExceptionTarget(normalized);
    return exception ? `archive all except ${exception}` : "archive all except read";
  }

  if (
    /\b(snooze|pospon|pospone|posponer|ajorna|ajornar)\b/.test(normalized) &&
    /\b(leer|llegir|read)\b/.test(normalized) &&
    /\b(manana|demà|dema|tomorrow)\b/.test(normalized)
  ) {
    return "snooze read tomorrow";
  }

  if (
    /^(archive|delete|remove|complete|done|snooze|keep)\b/i.test(message) ||
    /^(archiva|arxiva|elimina|borra|pospon|ajorna)\b/i.test(message)
  ) {
    return normalizeNumberedBatchSegments(normalizeLocalizedHygieneWords(message));
  }

  return undefined;
}

function readExceptionTarget(normalized: string): string | undefined {
  const readWords = /\b(read|leer|llegir)\b/;
  if (readWords.test(normalized)) {
    return "read";
  }

  const match = normalized.match(/\b(?:menys|menos|except|excepto)\s+(?:el|la|the|de|del|de\s+)?(.+)$/);
  const raw = match?.[1]?.trim();
  if (!raw) {
    return undefined;
  }

  return raw
    .replace(/\b(snooze|pospon|pospone|posponer|ajorna|ajornar).*/g, "")
    .trim();
}

function normalizeLocalizedHygieneWords(message: string): string {
  return message
    .replace(/\barxiva\b/gi, "archive")
    .replace(/\barchiva\b/gi, "archive")
    .replace(/\belimina\b/gi, "archive")
    .replace(/\bborra\b/gi, "archive")
    .replace(/\btots\b/gi, "all")
    .replace(/\btodos\b/gi, "all")
    .replace(/\btodas\b/gi, "all")
    .replace(/\bmenys\b/gi, "except")
    .replace(/\bmenos\b/gi, "except")
    .replace(/\bexcepto\b/gi, "except")
    .replace(/\bpospon(?:e|er)?\b/gi, "snooze")
    .replace(/\bajorna(?:r)?\b/gi, "snooze")
    .replace(/\bhasta\b/gi, "to")
    .replace(/\bfins\b/gi, "to")
    .replace(/\bmañana\b/gi, "tomorrow")
    .replace(/\bdemà\b/gi, "tomorrow")
    .replace(/\bdema\b/gi, "tomorrow")
    .replace(/\bleer\b/gi, "read")
    .replace(/\bllegir\b/gi, "read")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeNumberedBatchSegments(message: string): string {
  return message
    .split(/\s*,\s*/g)
    .flatMap((segment) => expandSharedVerbSegment(segment.trim()))
    .filter(Boolean)
    .join(", ");
}

function expandSharedVerbSegment(segment: string): string[] {
  const match = segment.match(/^(archive|delete|remove|complete|done|keep)\s+(.+)$/i);

  if (!match || !/\b(?:and|y|i)\b/.test(match[2])) {
    return [segment];
  }

  const verb = match[1];
  const targets = match[2]
    .split(/\s+(?:and|y|i)\s+|,/i)
    .map((target) => target.trim())
    .filter(Boolean);

  return targets.length > 1 ? targets.map((target) => `${verb} ${target}`) : [segment];
}

function looksLikeCrossDomainVisibleEntityRequest(normalized: string, context: ConversationContext): boolean {
  if (!/\bendesa\b/.test(normalized)) {
    return false;
  }

  if (!/\b(ignore|ignora|ignorar|reject|rechaza|descarta|delete|remove|archive|elimina|borra)\b/.test(normalized)) {
    return false;
  }

  return !context.visibleEntities.some((entity) => normalizeMessage(entity.title).includes("endesa"));
}

function containsDestructiveAction(message: string): boolean {
  return /\b(archive|delete|remove)\b/i.test(message);
}

function looksLikeConfirmation(message: string): boolean {
  return /^(yes|y|yep|yeah|ok|okay|sure|confirm|confirmo|sí|si|dale|do it|ok archive them|sure archive them)$/i.test(message.trim());
}

function looksLikeCancellation(message: string): boolean {
  return /^(no|cancel|cancelar|nope|stop|don't|dont)$/i.test(message.trim());
}

function looksLikeRecentMutationQuestion(normalized: string): boolean {
  return (
    /\b(did|done|changed|change|archive|archived|snooze|snoozed|complete|completed|happened|previous|last)\b/.test(normalized) &&
    /\b(you|u|it|all|them|those|that|command|stuff|do|did|changed)\b/.test(normalized)
  ) || /\b(que has cambiado|que hiciste|què has canviat|que has canviat|ho has fet|did you do it)\b/.test(normalized);
}

function looksLikeActionHygieneRequest(normalized: string): boolean {
  return (
    normalized === "action hygiene" ||
    normalized === "debug action hygiene" ||
    /^\/?(action_hygiene|debug_action_hygiene)$/.test(normalized) ||
    /\b(clean|cleanup|clean up|tidy|review)\b/.test(normalized) && /\b(tasks|actions|todos|task list|action list)\b/.test(normalized) ||
    /\b(stale|overdue|old|ignored)\b/.test(normalized) && /\b(tasks|actions|todos)\b/.test(normalized) ||
    /\b(limpia|limpiar|revisa|ordenar|ordena)\b/.test(normalized) && /\b(tareas|acciones|pendientes)\b/.test(normalized) ||
    /\b(neteja|revisa|ordena)\b/.test(normalized) && /\b(tasques|accions|pendents)\b/.test(normalized)
  );
}

function detectLanguage(message: string): "en" | "es" | "ca" | "unknown" {
  const normalized = normalizeMessage(message);
  if (/\b(què|arxiva|tots|menys|llegir|demà|dema)\b/.test(normalized)) {
    return "ca";
  }
  if (/\b(qué|que|elimina|todos|todas|menos|leer|mañana|manana)\b/.test(normalized)) {
    return "es";
  }
  if (/[a-z]/i.test(message)) {
    return "en";
  }
  return "unknown";
}

function normalizeMessage(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ");
}
