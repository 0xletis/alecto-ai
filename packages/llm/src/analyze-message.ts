import {
  eventRegistry,
  EventTypeSchema,
  MessageIntentSchema,
  AgentModeSchema,
  type EventTypeDefinition
} from "@operator-agent/core";
import { createOpenAIClient } from "./openai-client.js";
import { AnalyzeMessageInputSchema, OpenAIMessageAnalysisSchema, type AnalyzeMessageInput } from "./types.js";

const defaultModel = "gpt-4o-mini";

export interface AnalyzeMessageWithOpenAIOptions {
  apiKey?: string;
  model?: string;
}

export async function analyzeMessageWithOpenAI(
  input: AnalyzeMessageInput,
  options: AnalyzeMessageWithOpenAIOptions = {}
) {
  const parsedInput = AnalyzeMessageInputSchema.parse(input);
  const client = createOpenAIClient({ apiKey: options.apiKey });
  const model = options.model ?? process.env.OPENAI_MODEL ?? defaultModel;
  const schema = buildAnalysisJsonSchema(parsedInput.eventRegistry);

  const response = await client.responses.create({
    model,
    store: false,
    input: [
      {
        role: "developer",
        content: [
          {
            type: "input_text",
            text: buildDeveloperPrompt(parsedInput.eventRegistry)
          }
        ]
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: JSON.stringify({
              userId: parsedInput.userId,
              message: parsedInput.message,
              activeGoals: parsedInput.activeGoals,
              recentEvents: parsedInput.recentEvents,
              userOperatingProfile: parsedInput.userOperatingProfile ?? null
            })
          }
        ]
      }
    ],
    text: {
      format: {
        type: "json_schema",
        name: "operator_message_analysis",
        strict: true,
        schema
      }
    }
  });

  const outputText = response.output_text;
  const parsedJson = compactAnalysisJson(JSON.parse(outputText));
  const analysis = OpenAIMessageAnalysisSchema.parse(parsedJson);
  const allowedTypes = new Set(parsedInput.eventRegistry.map((event) => event.type));

  for (const event of analysis.extractedEvents) {
    if (!allowedTypes.has(event.type)) {
      throw new Error(`OpenAI returned event type outside registry: ${event.type}`);
    }
  }

  return analysis;
}

function buildDeveloperPrompt(registry: EventTypeDefinition[]): string {
  return [
    "You analyze user messages for Operator Agent.",
    "Return only the structured JSON requested by the schema.",
    "Do not invent core event types.",
    "Only use extractedEvents.type values from the provided event registry.",
    "Extract events only from the current message. Recent events are context for patterns, not events to copy into extractedEvents.",
    "If the user asks to track something that does not fit the registry, return proposedCustomEventType instead of inventing an event type.",
    "Do not decide final riskState. A deterministic risk engine runs after your analysis.",
    "Do not validate betting, trading, or impulsive financial behavior.",
    "If a user says they sent, mandado, submitted, or applied with CVs/applications, use career.application_sent with data.count when count is clear.",
    "Use career.cv_updated only when the user edited or updated the CV itself.",
    "If a user says gym, trained, entrenado, or workout with an approximate hour, use health.workout_completed with data.duration_minutes around 60.",
    "If you extract one or more events from a message, prefer intent event_logging unless the message is primarily goal creation/update or high-risk financial intent.",
    `Allowed event types: ${registry.map((event) => event.type).join(", ")}`
  ].join("\n");
}

function buildAnalysisJsonSchema(registry: EventTypeDefinition[]) {
  const eventTypes = registry.length > 0 ? registry.map((event) => event.type) : eventRegistry.map((event) => event.type);

  return {
    type: "object",
    additionalProperties: false,
    required: [
      "intent",
      "mode",
      "extractedEvents",
      "reasoningSummary",
      "suggestedReplyTone",
      "proposedCustomEventType"
    ],
    properties: {
      intent: {
        type: "string",
        enum: MessageIntentSchema.options
      },
      mode: {
        type: "string",
        enum: AgentModeSchema.options
      },
      extractedEvents: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["type", "data", "confidence", "evidence"],
          properties: {
            type: {
              type: "string",
              enum: eventTypes
            },
            data: {
              type: "object",
              additionalProperties: false,
              required: ["count", "duration_minutes", "duration_hours", "note"],
              properties: {
                count: { type: ["number", "null"] },
                duration_minutes: { type: ["number", "null"] },
                duration_hours: { type: ["number", "null"] },
                note: { type: ["string", "null"] }
              }
            },
            confidence: {
              type: "number"
            },
            evidence: {
              type: "array",
              items: { type: "string" }
            }
          }
        }
      },
      reasoningSummary: {
        type: "string"
      },
      suggestedReplyTone: {
        type: "string"
      },
      proposedCustomEventType: {
        anyOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["name", "reason", "exampleData"],
            properties: {
              name: { type: "string" },
              reason: { type: "string" },
              exampleData: {
                type: "object",
                additionalProperties: false,
                required: ["note"],
                properties: {
                  note: { type: ["string", "null"] }
                }
              }
            }
          },
          {
            type: "null"
          }
        ]
      }
    }
  } satisfies Record<string, unknown>;
}

function compactAnalysisJson(value: unknown) {
  if (!value || typeof value !== "object") {
    return value;
  }

  const analysis = value as {
    extractedEvents?: Array<{ data?: Record<string, unknown> }>;
    proposedCustomEventType?: { exampleData?: Record<string, unknown> } | null;
  };

  analysis.extractedEvents = (analysis.extractedEvents ?? []).map((event) => ({
    ...event,
    data: compactNullValues(event.data ?? {})
  }));

  if (analysis.proposedCustomEventType) {
    analysis.proposedCustomEventType.exampleData = compactNullValues(
      analysis.proposedCustomEventType.exampleData ?? {}
    );
  }

  return analysis;
}

function compactNullValues(data: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== null));
}

export function validateOpenAIMessageAnalysis(value: unknown) {
  return OpenAIMessageAnalysisSchema.parse(value);
}

export function isEventTypeAllowed(type: string, registry: EventTypeDefinition[]) {
  return registry.some((event) => event.type === type) && EventTypeSchema.safeParse(type).success;
}
