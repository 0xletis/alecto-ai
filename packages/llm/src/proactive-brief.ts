import {
  ProactiveBriefContextSchema,
  ProactiveBriefValidationError,
  validateProactiveBriefResponseAgainstContext,
  type ProactiveBriefContext,
  type ProactiveBriefResponse
} from "@operator-agent/core";
import { createOpenAIClient } from "./openai-client.js";

const defaultModel = "gpt-4o-mini";

export interface GenerateProactiveBriefMessageOptions {
  apiKey?: string;
  model?: string;
}

export async function generateProactiveBriefMessage(
  context: ProactiveBriefContext,
  options: GenerateProactiveBriefMessageOptions = {}
): Promise<ProactiveBriefResponse> {
  const parsedContext = ProactiveBriefContextSchema.parse(context);

  if (process.env.PROACTIVE_BRIEF_LLM_MOCK_DELAY_MS) {
    await delay(Number(process.env.PROACTIVE_BRIEF_LLM_MOCK_DELAY_MS));
  }

  if (process.env.PROACTIVE_BRIEF_LLM_MOCK_THROW === "true") {
    throw new Error("Mock proactive brief LLM failure.");
  }

  if (process.env.PROACTIVE_BRIEF_LLM_MOCK_RESPONSE) {
    return validateProactiveBriefResponseAgainstContext(parseProactiveBriefJson(process.env.PROACTIVE_BRIEF_LLM_MOCK_RESPONSE), parsedContext);
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
              "You are Alecto's proactive morning/evening brief writer.",
              "You are not deciding facts. Code has already decided every fact you are given.",
              "Write ONE short, warm, Telegram-ready message using ONLY the goal, actions, wins, signals, and preference given to you.",
              "Never invent a goal, action, event, due date, email, or fact that is not in the provided context.",
              "If `goal` is provided, the message is about THAT goal only — never mention any other goal title, even one you might reasonably guess exists.",
              "If `preference` is provided, let its style genuinely shape the tone and content:",
              "- motivational: include one short, ORIGINAL, UNATTRIBUTED motivating line about the goal — never attribute it to any real or invented person, living or dead, and never reproduce a real quote you recall, verbatim or paraphrased.",
              "- reflection: include one short reflection question or prompt tied to the goal.",
              "- tough_love: be direct and challenging, no hedging, no false positivity — still respectful, never insulting.",
              "- gentle: be warm and encouraging, low pressure.",
              "- practical or no preference: focus on concrete progress — actions, due dates, next steps.",
              "Adapt tone to the goal's own category even without an explicit preference: a life-meaning/personal-growth/habit goal reads as reflective/motivating, not as a task dump; a job-search/career goal stays practical and progress-focused (applications, replies, interviews); a fitness goal stays about workouts/recovery/energy; an admin/travel/insurance goal stays focused on deadlines and concrete checks. Never import job-search or Gmail language into an unrelated goal.",
              "The brief must never be just \"nothing scheduled\" when a goal exists — always give the user something real to act on or reflect on: a concrete small action, or one genuine reflection prompt.",
              "You may end with ONE question, but it must be phrased as a question the user can answer — never a statement claiming you already created, logged, scheduled, or changed anything.",
              "Never say \"I've created\", \"I've logged\", \"I've added\", \"I've scheduled\", or similar — you do not create, update, or delete anything from this message.",
              "Never include raw email subject/body/sender text beyond what is already given to you as a pre-written signal line.",
              "Keep it under roughly 6 short lines total. Plain text only — no markdown headers, no emoji spam."
            ].join("\n")
          }
        ]
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: JSON.stringify(parsedContext)
          }
        ]
      }
    ],
    text: {
      format: {
        type: "json_schema",
        name: "proactive_brief_response",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["message"],
          properties: {
            message: { type: "string" }
          }
        }
      }
    }
  });

  return validateProactiveBriefResponseAgainstContext(parseProactiveBriefJson(response.output_text), parsedContext);
}

function parseProactiveBriefJson(text: string): unknown {
  const trimmed = text.trim();

  if (!trimmed) {
    throw new ProactiveBriefValidationError(["empty"]);
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    const extracted = extractJsonObject(trimmed);

    if (extracted) {
      try {
        return JSON.parse(extracted);
      } catch {
        // Fall through to the typed validation error below.
      }
    }

    throw new ProactiveBriefValidationError(["invalid_json"]);
  }
}

function extractJsonObject(text: string): string | undefined {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");

  if (start === -1 || end === -1 || end <= start) {
    return undefined;
  }

  return text.slice(start, end + 1);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, Math.max(0, Number.isFinite(ms) ? ms : 0));
  });
}
