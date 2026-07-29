import { z } from "zod";
import { routeIngestion } from "./ingestion.js";

export const EmailClassificationSchema = z.object({
  decision: z.enum(["log_event", "needs_review", "ignore"]),
  eventType: z.string().optional(),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
  evidence: z.string(),
  extracted: z
    .object({
      company: z.string().optional(),
      role: z.string().optional(),
      deadline: z.string().optional(),
      actionRequired: z.boolean().optional()
    })
    .passthrough()
    .default({}),
  metadata: z.object({
    classifierMode: z.enum(["rules", "llm", "hybrid"]),
    adapterId: z.string(),
    source: z.literal("gmail"),
    classifier: z.enum(["rules", "llm"]).optional()
  })
});

export type EmailClassification = z.infer<typeof EmailClassificationSchema>;

export interface ClassifyJobSearchEmailInput {
  text: string;
  classifierMode?: "rules" | "llm" | "hybrid";
  llmAvailable?: boolean;
}

export function classifyJobSearchEmail(input: ClassifyJobSearchEmailInput): EmailClassification {
  const classifierMode = input.classifierMode ?? "rules";

  if (classifierMode === "llm" && !input.llmAvailable) {
    return EmailClassificationSchema.parse({
      decision: "needs_review",
      confidence: 0.65,
      reason: "LLM classifier unavailable",
      evidence: input.text.slice(0, 300),
      extracted: {},
      metadata: {
        classifierMode,
        adapterId: "job_search_email",
        source: "gmail",
        classifier: "llm"
      }
    });
  }

  const result = routeIngestion({
    userId: "email-classifier",
    text: input.text,
    source: "gmail",
    metadata: {
      domainHint: "career",
      emailAdapterId: "job_search_email"
    }
  });
  const candidate = result.eventCandidates[0];
  const actionRequired = result.classification === "application_action_required";
  const decision =
    result.classification === "filtered_marketing" || result.classification === "unknown"
      ? "ignore"
      : actionRequired
        ? "needs_review"
        : candidate
          ? "log_event"
          : "ignore";

  return EmailClassificationSchema.parse({
    decision,
    eventType: candidate?.type,
    confidence: result.confidence,
    reason: result.classification,
    evidence: input.text.slice(0, 300),
    extracted: {
      ...result.extracted,
      ...(actionRequired ? { actionRequired: true } : {})
    },
    metadata: {
      classifierMode: classifierMode === "hybrid" ? "rules" : classifierMode,
      adapterId: "job_search_email",
      source: "gmail",
      classifier: "rules"
    }
  });
}
