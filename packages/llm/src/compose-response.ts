import { z } from "zod";
import {
  AgentResponseSchema,
  type AgentResponse,
  type AgentResponseComposerInput
} from "@operator-agent/core";
import { createOpenAIClient } from "./openai-client.js";

const defaultModel = "gpt-4o-mini";

const LlmResponseSchema = z.object({
  reply: z.string().min(1),
  tone: z.string().min(1),
  evidenceUsed: z.array(z.string()).default([])
});

export interface ComposeResponseWithOpenAIOptions {
  apiKey?: string;
  model?: string;
}

export async function composeResponseWithOpenAI(
  input: AgentResponseComposerInput,
  fallback: AgentResponse,
  options: ComposeResponseWithOpenAIOptions = {}
): Promise<AgentResponse> {
  if (input.riskState === "RED") {
    return fallback;
  }

  const client = createOpenAIClient({ apiKey: options.apiKey });
  const model = options.model ?? process.env.OPENAI_MODEL ?? defaultModel;

  const response = await client.responses.create({
    model,
    store: false,
    input: [
      {
        role: "developer",
        content: [
          {
            type: "input_text",
            text: [
              "You are Alecto's Response Composer.",
              "Rewrite the fallback reply to feel more human and context-aware.",
              "Keep it concise. Usually 1-3 sentences.",
              "Do not create database changes, memories, goals, or events.",
              "Do not invent event types, facts, or evidence.",
              "Do not override riskState, mode, or deterministic policy.",
              "No generic motivational fluff. No fake certainty.",
              "If evidence is weak, use 'I think' or 'looks like'.",
              "For betting/trading or impulses, do not validate risky behavior.",
              "For RED risk, the caller will use deterministic fallback and skip you."
            ].join("\n")
          }
        ]
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: JSON.stringify({
              input: compactComposerInput(input),
              fallback
            })
          }
        ]
      }
    ],
    text: {
      format: {
        type: "json_schema",
        name: "operator_response_composer",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["reply", "tone", "evidenceUsed"],
          properties: {
            reply: { type: "string" },
            tone: { type: "string" },
            evidenceUsed: { type: "array", items: { type: "string" } }
          }
        }
      }
    }
  });

  const parsed = LlmResponseSchema.parse(JSON.parse(response.output_text));
  assertPlainResponseWording(parsed.reply);

  return AgentResponseSchema.parse({
    ...fallback,
    reply: parsed.reply,
    tone: parsed.tone,
    evidenceUsed: parsed.evidenceUsed.length > 0 ? parsed.evidenceUsed : fallback.evidenceUsed
  });
}

function assertPlainResponseWording(reply: string) {
  const bannedPattern = /\b(great progress|productive day already|why not|maybe|it'?s about making progress|you'?ve got this)\b/i;

  if (bannedPattern.test(reply)) {
    throw new Error("OpenAI response composer used banned generic wording.");
  }
}

function compactComposerInput(input: AgentResponseComposerInput) {
  return {
    userId: input.userId,
    message: input.message,
    intent: input.intent,
    mode: input.mode,
    riskState: input.riskState,
    extractedEvents: input.extractedEvents?.map((event) => ({
      type: event.type,
      data: event.data
    })),
    activeGoals: input.activeGoals?.slice(0, 5).map((goal) => ({
      id: goal.id,
      title: goal.title,
      category: goal.category,
      templateId: goal.templateId
    })),
    recentEvents: input.recentEvents?.slice(0, 10).map((event) => ({
      type: event.type,
      data: event.data,
      timestamp: event.timestamp
    })),
    memories: input.memories?.slice(0, 5).map((memory) => ({
      type: memory.type,
      summary: memory.summary
    })),
    profile: input.profile
      ? {
          directness: input.profile.directness,
          warmth: input.profile.warmth,
          confrontation: input.profile.confrontation,
          vulnerableMode: input.profile.vulnerableMode,
          impulsiveMode: input.profile.impulsiveMode,
          requiresEvidence: input.profile.requiresEvidence,
          gamblingGuardrails: input.profile.gamblingGuardrails
        }
      : undefined,
    todaySummary: input.todaySummary
  };
}
