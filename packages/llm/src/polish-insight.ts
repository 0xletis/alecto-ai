import { z } from "zod";
import { InsightReportSchema, type InsightReport } from "@operator-agent/core";
import { createOpenAIClient } from "./openai-client.js";

const defaultModel = "gpt-4o-mini";

const PolishedInsightSchema = z.object({
  headline: z.string(),
  summary: z.string(),
  wins: z.array(z.string()),
  gaps: z.array(z.string()),
  risks: z.array(z.string()),
  patterns: z.array(z.string()),
  memorySignals: z.array(z.string()),
  recommendedActions: z.array(z.string()),
  hardTruth: z.string().nullable()
});

export interface PolishInsightWithOpenAIOptions {
  apiKey?: string;
  model?: string;
}

export async function polishInsightWithOpenAI(
  report: InsightReport,
  options: PolishInsightWithOpenAIOptions = {}
): Promise<InsightReport> {
  const parsedReport = InsightReportSchema.parse(report);
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
              "Polish this Operator Agent insight report.",
              "Do not invent facts, metrics, goals, risks, memories, or actions.",
              "Only improve clarity and tone.",
              "Keep the style honest, concrete, and plain.",
              "Avoid fake positivity and corporate coaching language.",
              "Do not use phrases like commendable progress, significant progress, great job, proud, or excellent.",
              "Keep direct language for hardTruth. Keep arrays concise."
            ].join("\n")
          }
        ]
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: JSON.stringify(parsedReport)
          }
        ]
      }
    ],
    text: {
      format: {
        type: "json_schema",
        name: "operator_insight_polish",
        strict: true,
        schema: {
          type: "object",
          additionalProperties: false,
          required: [
            "headline",
            "summary",
            "wins",
            "gaps",
            "risks",
            "patterns",
            "memorySignals",
            "recommendedActions",
            "hardTruth"
          ],
          properties: {
            headline: { type: "string" },
            summary: { type: "string" },
            wins: { type: "array", items: { type: "string" } },
            gaps: { type: "array", items: { type: "string" } },
            risks: { type: "array", items: { type: "string" } },
            patterns: { type: "array", items: { type: "string" } },
            memorySignals: { type: "array", items: { type: "string" } },
            recommendedActions: { type: "array", items: { type: "string" } },
            hardTruth: { type: ["string", "null"] }
          }
        }
      }
    }
  });

  const polished = PolishedInsightSchema.parse(JSON.parse(response.output_text));
  assertPolishMatchesReportShape(parsedReport, polished);
  assertPlainInsightWording(polished);

  return InsightReportSchema.parse({
    ...parsedReport,
    summary: polished.summary,
    hardTruth: parsedReport.hardTruth ? polished.hardTruth ?? parsedReport.hardTruth : undefined
  });
}

function assertPolishMatchesReportShape(
  report: InsightReport,
  polished: z.infer<typeof PolishedInsightSchema>
) {
  for (const key of [
    "wins",
    "gaps",
    "risks",
    "patterns",
    "memorySignals",
    "recommendedActions"
  ] as const) {
    if (polished[key].length !== report[key].length) {
      throw new Error(`OpenAI insight polish changed ${key} length.`);
    }
  }
}

function assertPlainInsightWording(polished: z.infer<typeof PolishedInsightSchema>) {
  const bannedPattern = /\b(?:commendable|significant progress|great job|proud|excellent|enhance|empower|optimize|journey)\b/i;
  const text = [polished.headline, polished.summary, polished.hardTruth ?? ""].join(" ");

  if (bannedPattern.test(text)) {
    throw new Error("OpenAI insight polish used banned motivational wording.");
  }
}
