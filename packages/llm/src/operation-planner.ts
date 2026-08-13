import {
  ConversationOperationNameSchema,
  ConversationVisibleEntityTypeSchema,
  normalizeConversationOperationPlan,
  type ConversationContext,
  type ConversationOperationName,
  type ConversationOperationPlan,
  type ConversationVisibleEntityType
} from "@operator-agent/core";
import { createOpenAIClient } from "./openai-client.js";

const defaultModel = "gpt-4o-mini";

export interface PlanConversationOperationsWithLLMInput {
  userId: string;
  message: string;
  context: ConversationContext;
  availableOperations: Array<{
    name: ConversationOperationName;
    mutates: boolean;
    requiresConfirmation: boolean;
    validEntityTypes: ConversationVisibleEntityType[];
    allowedContextScopes: string[];
    requiredFields: string[];
    description: string;
  }>;
  timezone?: string;
  profileStyle?: string;
}

export interface PlanConversationOperationsWithLLMOptions {
  apiKey?: string;
  model?: string;
}

export async function planConversationOperationsWithLLM(
  input: PlanConversationOperationsWithLLMInput,
  options: PlanConversationOperationsWithLLMOptions = {}
): Promise<ConversationOperationPlan> {
  if (process.env.CONVERSATION_ORCHESTRATOR_V2_MOCK_RESPONSE) {
    return normalizeConversationOperationPlan(JSON.parse(process.env.CONVERSATION_ORCHESTRATOR_V2_MOCK_RESPONSE));
  }

  const client = createOpenAIClient({ apiKey: options.apiKey });
  const model = options.model ?? process.env.CONVERSATION_ORCHESTRATOR_V2_MODEL ?? process.env.OPENAI_MODEL ?? defaultModel;

  const response = await client.responses.create({
    model,
    store: false,
    input: [
      {
        role: "developer",
        content: [{
          type: "input_text",
          text: buildOperationPlannerPrompt()
        }]
      },
      {
        role: "user",
        content: [{
          type: "input_text",
          text: JSON.stringify({
            userId: input.userId,
            message: input.message,
            context: sanitizeContextForPlanner(input.context),
            availableOperations: input.availableOperations,
            timezone: input.timezone,
            profileStyle: input.profileStyle
          })
        }]
      }
    ],
    text: {
      format: {
        type: "json_schema",
        name: "conversation_operation_plan",
        strict: true,
        schema: buildOperationPlannerJsonSchema()
      }
    }
  });

  return normalizeConversationOperationPlan(JSON.parse(response.output_text));
}

function buildOperationPlannerPrompt(): string {
  return [
    "You are Alecto's Conversation Orchestrator v2 operation planner.",
    "You understand the user's message and return a JSON operation plan only.",
    "You never mutate data, never claim success, and never send final user-facing prose.",
    "Deterministic code will validate ownership, visibility, safety, dates, confirmation, and execute allowed operations.",
    "Use only operation names from availableOperations.",
    "Targets should reference visible entities by number or id when possible.",
    "If the user refers to 'it', 'that', 'the rest', or 'all except', resolve against visibleEntities in context.",
    "For destructive operations, set needsConfirmation true and requiresConfirmation true on the operation.",
    "If the message is cross-domain and no matching visible entity exists, use request_clarification.",
    "Hard betting/trading guardrails run before execution. Never plan or suggest betting/trading actions.",
    "Understand English, Spanish, and Catalan by meaning, not literal keywords.",
    "Return only JSON matching the schema."
  ].join("\n");
}

function sanitizeContextForPlanner(context: ConversationContext) {
  return {
    lastAssistantOutputType: context.lastAssistantOutputType,
    visibleEntities: context.visibleEntities.map((entity) => ({
      displayNumber: entity.displayNumber,
      entityType: entity.entityType,
      entityId: entity.entityId,
      title: entity.title,
      status: entity.status,
      allowedOperations: entity.allowedOperations
    })),
    focusedEntity: context.focusedEntity,
    pendingConfirmation: context.pendingConfirmation
      ? {
          scope: context.pendingConfirmation.scope,
          operationSummary: context.pendingConfirmation.operationSummary,
          expiresAt: context.pendingConfirmation.expiresAt
        }
      : undefined,
    recentMutations: context.recentMutations.map((mutation) => ({
      summary: mutation.summary,
      reply: mutation.reply.slice(0, 800),
      createdAt: mutation.createdAt
    })),
    language: context.language
  };
}

function buildOperationPlannerJsonSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "intent",
      "operations",
      "needsConfirmation",
      "clarificationQuestion",
      "confidence",
      "language",
      "safetyNotes",
      "responseHints",
      "source"
    ],
    properties: {
      intent: { type: "string", minLength: 1, maxLength: 120 },
      operations: {
        type: "array",
        maxItems: 20,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["name", "target", "fields", "mutates", "requiresConfirmation", "reason"],
          properties: {
            name: {
              type: "string",
              enum: ConversationOperationNameSchema.options
            },
            target: {
              anyOf: [
                {
                  type: "object",
                  additionalProperties: false,
                  required: ["referenceType", "value", "entityType"],
                  properties: {
                    referenceType: {
                      type: "string",
                      enum: ["visible_number", "entity_id", "text", "all_visible", "all_except_visible"]
                    },
                    value: { type: "string", minLength: 1, maxLength: 240 },
                    entityType: {
                      type: "string",
                      enum: ConversationVisibleEntityTypeSchema.options
                    }
                  }
                },
                { type: "null" }
              ]
            },
            fields: {
              type: "object",
              additionalProperties: false,
              required: ["legacyMessage", "reply", "timeText", "title", "summary", "evidence"],
              properties: {
                legacyMessage: { type: ["string", "null"], maxLength: 500 },
                reply: { type: ["string", "null"], maxLength: 500 },
                timeText: { type: ["string", "null"], maxLength: 120 },
                title: { type: ["string", "null"], maxLength: 160 },
                summary: { type: ["string", "null"], maxLength: 240 },
                evidence: { type: ["string", "null"], maxLength: 500 }
              }
            },
            mutates: { type: "boolean" },
            requiresConfirmation: { type: "boolean" },
            reason: { type: ["string", "null"], maxLength: 240 }
          }
        }
      },
      needsConfirmation: { type: "boolean" },
      clarificationQuestion: { type: ["string", "null"], maxLength: 500 },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      language: { type: "string", enum: ["en", "es", "ca", "unknown"] },
      safetyNotes: {
        type: "array",
        maxItems: 10,
        items: { type: "string", maxLength: 240 }
      },
      responseHints: {
        type: "array",
        maxItems: 10,
        items: { type: "string", maxLength: 240 }
      },
      source: { type: "string", enum: ["llm"] }
    }
  };
}
