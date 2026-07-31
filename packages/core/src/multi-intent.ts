import { z } from "zod";
import { detectConversationControlIntent } from "./conversation-control.js";
import { evaluateGoalGuardrails } from "./goal-guardrails.js";
import { extractManualAction } from "./action-intake.js";
import { extractEvents } from "./message-processing.js";

export const ConversationIntentTypeSchema = z.enum([
  "event_log",
  "action_create",
  "complete_action",
  "reschedule_action",
  "archive_action",
  "set_goal_priority",
  "show_today",
  "show_actions",
  "show_goal_priorities",
  "ask_next_move",
  "memory_save",
  "goal_guardrail",
  "unknown"
]);

export type ConversationIntentType = z.infer<typeof ConversationIntentTypeSchema>;

export interface ConversationIntentPlanItem {
  type: ConversationIntentType;
  textSpan: string;
  targetText?: string;
  timeText?: string;
  goalText?: string;
  priority?: string;
  extractedData?: Record<string, unknown>;
  confidence: number;
  requiresConfirmation?: boolean;
  blockedByGuardrail?: boolean;
  reason: string;
}

export interface ConversationIntentPlan {
  isMultiIntent: boolean;
  intents: ConversationIntentPlanItem[];
  reason: string;
}

export interface MultiIntentAnalysisContext {
  now?: Date;
  timezone?: string;
}

export function looksLikeMultiIntentText(text: string): boolean {
  const trimmed = text.trim();

  if (!trimmed || trimmed.startsWith("/")) {
    return false;
  }

  const spans = splitIntentSpans(trimmed);
  return spans.length >= 2 && spans.some((span) => classifyIntentSpan(span).type !== "unknown");
}

export async function analyzeMultiIntentMessage(
  _userId: string,
  text: string,
  _context: MultiIntentAnalysisContext = {}
): Promise<ConversationIntentPlan> {
  const trimmed = text.trim();
  const spans = splitIntentSpans(trimmed);
  const wholeMessageGuardrail = evaluateGoalGuardrails({ text: trimmed });

  if (wholeMessageGuardrail.triggered && !wholeMessageGuardrail.isReferenceOnly) {
    const otherIntents = spans
      .map(classifyIntentSpan)
      .filter((intent) => intent.type !== "unknown" && intent.type !== "goal_guardrail");

    return {
      isMultiIntent: spans.length > 1 || otherIntents.length > 0,
      intents: [
        {
          type: "goal_guardrail",
          textSpan: trimmed,
          confidence: wholeMessageGuardrail.confidence,
          blockedByGuardrail: true,
          reason: wholeMessageGuardrail.reason
        },
        ...otherIntents
      ],
      reason: "Hard guardrail detected in message; mutation execution must stop."
    };
  }

  const intents = spans.map(classifyIntentSpan);
  const actionable = intents.filter((intent) => intent.type !== "unknown");

  return {
    isMultiIntent: spans.length >= 2 && actionable.length >= 1,
    intents,
    reason:
      spans.length >= 2 && actionable.length >= 1
        ? "Multiple deterministic intent spans detected."
        : "Message does not contain multiple executable intents."
  };
}

function classifyIntentSpan(span: string): ConversationIntentPlanItem {
  const trimmed = span.trim();

  if (!trimmed) {
    return unknownIntent(span, "empty span");
  }

  const guardrail = evaluateGoalGuardrails({ text: trimmed });
  if (guardrail.triggered && !guardrail.isReferenceOnly) {
    return {
      type: "goal_guardrail",
      textSpan: trimmed,
      confidence: guardrail.confidence,
      blockedByGuardrail: true,
      reason: guardrail.reason
    };
  }

  if (isGoalPrioritiesReadout(trimmed)) {
    return {
      type: "show_goal_priorities",
      textSpan: trimmed,
      confidence: 0.88,
      reason: "read-only goal priorities request"
    };
  }

  const spanishNextMove = /\b(qu[eé]\s+hago\s+ahora|que\s+hago\s+ahora|siguiente\s+paso|pr[oó]ximo\s+paso)\b/i.test(trimmed);
  if (spanishNextMove) {
    return {
      type: "ask_next_move",
      textSpan: trimmed,
      confidence: 0.86,
      reason: "Spanish/Spanglish next-move request"
    };
  }

  const control = detectConversationControlIntent(trimmed);
  if (control.intent !== "unknown" && control.intent !== "goal_guardrail") {
    return {
      type: control.intent === "snooze_action" ? "reschedule_action" : control.intent,
      textSpan: trimmed,
      targetText: control.targetText,
      timeText: control.timeText,
      goalText: control.goalText,
      priority: control.priority,
      confidence: control.confidence,
      requiresConfirmation: control.requiresConfirmation,
      reason: control.reason
    };
  }

  const extractedEvents = extractEvents(trimmed);
  if (extractedEvents.length > 0) {
    return {
      type: "event_log",
      textSpan: trimmed,
      extractedData: {
        eventTypes: extractedEvents.map((event) => event.type)
      },
      confidence: Math.max(...extractedEvents.map((event) => event.confidence)),
      reason: "structured event extraction matched"
    };
  }

  const action = extractManualAction({ text: trimmed });
  if (action.shouldCreateAction) {
    return {
      type: "action_create",
      textSpan: trimmed,
      extractedData: {
        title: action.title,
        dueAt: action.dueAt?.toISOString()
      },
      confidence: 0.82,
      reason: "manual action extraction matched"
    };
  }

  if (/\b(remember that|remember this|note that|recuerda que|acu[eé]rdate de que|guard[ae] que)\b/i.test(trimmed)) {
    return {
      type: "memory_save",
      textSpan: trimmed,
      confidence: 0.8,
      reason: "explicit memory request"
    };
  }

  return unknownIntent(trimmed, "no deterministic intent matched");
}

function splitIntentSpans(text: string): string[] {
  return text
    .replace(/\s+(?:and\s+also|and\s+then)\s+/gi, ", ")
    .split(/\r?\n|;|,(?!\d)|\s+\b(?:also|then|plus|and|tambien|también|y)\b\s+/i)
    .map((span) => cleanupSpan(span))
    .filter((span) => span.length > 0);
}

function cleanupSpan(text: string): string {
  return text
    .replace(/^\s*(?:and|also|then|plus|y|tambien|también)\s+/i, "")
    .replace(/^\s*(?:and|y)\s+/, "")
    .trim();
}

function isGoalPrioritiesReadout(text: string): boolean {
  return /\b(show|list|view)\s+(?:my\s+)?goal\s+priorit(?:y|ies)\b/i.test(text) || /\bgoal\s+priorit(?:y|ies)\b/i.test(text);
}

function unknownIntent(textSpan: string, reason: string): ConversationIntentPlanItem {
  return {
    type: "unknown",
    textSpan,
    confidence: 0,
    reason
  };
}
