import {
  DailyBriefContextSchema,
  DailyCoachValidationError,
  deterministicDailyCoachWarning,
  validateDailyCoachResponseAgainstContext,
  type DailyBriefContext,
  type DailyCoachResponse
} from "@operator-agent/core";
import { createOpenAIClient } from "./openai-client.js";

const defaultModel = "gpt-4o-mini";

export interface GenerateDailyCoachResponseOptions {
  apiKey?: string;
  model?: string;
}

export async function generateDailyCoachResponse(
  context: DailyBriefContext,
  options: GenerateDailyCoachResponseOptions = {}
): Promise<DailyCoachResponse> {
  const parsedContext = DailyBriefContextSchema.parse(context);

  if (process.env.DAILY_COACH_LLM_MOCK_DELAY_MS) {
    await delay(Number(process.env.DAILY_COACH_LLM_MOCK_DELAY_MS));
  }

  if (process.env.DAILY_COACH_LLM_MOCK_THROW === "true") {
    throw new Error("Mock daily coach LLM failure.");
  }

  if (process.env.DAILY_COACH_LLM_MOCK_RESPONSE) {
    return validateDailyCoachResponseAgainstContext(
      withDeterministicWarning(parseDailyCoachJson(process.env.DAILY_COACH_LLM_MOCK_RESPONSE), parsedContext),
      parsedContext
    );
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
              "You are Alecto's Daily Coach writer.",
              "You are not deciding facts. Code has already decided the facts.",
              "Only write a short interpretation of the provided verified DailyBriefContext.",
              "Do not invent actions, events, goals, memories, progress, due dates, or risks.",
              "Do not create, update, or delete anything.",
              "Do not reorder priorities. Do not imply a different first action.",
              "The nextMove field must point to the first scored priority action.",
              "You may rephrase the provided nextMove, but it must mention the selected action title.",
              "Do not mention a lower-ranked action as the next move.",
              "Do not suggest betting/trading actions or advice.",
              "The warning field may be null.",
              "If guardrail/risk exists, warning may only say that the guardrail remains locked.",
              "Do not mention betting/trading tactics, sizing, entries, thesis, stop loss, odds, or conditions.",
              "Tone: direct, compact, non-corporate, no fake positivity."
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
        name: "daily_coach_response",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: ["diagnosis", "nextMove", "warning", "encouragement"],
          properties: {
            diagnosis: { type: "string" },
            nextMove: { type: "string" },
            warning: { type: ["string", "null"] },
            encouragement: { type: ["string", "null"] }
          }
        }
      }
    }
  });

  return validateDailyCoachResponseAgainstContext(
    withDeterministicWarning(parseDailyCoachJson(response.output_text), parsedContext),
    parsedContext
  );
}

function withDeterministicWarning(value: unknown, context: DailyBriefContext): unknown {
  const warning = deterministicDailyCoachWarning(context);

  if (!warning || !value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  return {
    ...(value as Record<string, unknown>),
    warning
  };
}

function parseDailyCoachJson(text: string): unknown {
  const trimmed = text.trim();

  if (!trimmed) {
    throw new DailyCoachValidationError(["invalid_json"], {
      rawResponseType: "empty",
      parsedFieldsPresent: [],
      responseLength: 0
    });
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

    throw new DailyCoachValidationError(["invalid_json"], {
      rawResponseType: "text",
      parsedFieldsPresent: [],
      responseLength: trimmed.length
    });
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
