import { z } from "zod";
import { EmailClassificationSchema, EventTypeSchema, type EmailClassification } from "@operator-agent/core";
import { createOpenAIClient } from "./openai-client.js";

const defaultModel = "gpt-4o-mini";

export const JobSearchEmailAllowedEventTypes = [
  "career.application_confirmation_received",
  "career.recruiter_reply_received",
  "career.interview_scheduled",
  "career.rejection_received",
  "career.offer_received"
] as const;

export const WorkActionEmailAllowedEventTypes = [
  "work.feedback_received",
  "work.blocker_reported",
  "work.task_completed",
  "work.project_milestone_completed"
] as const;

const jobSearchNonCoreReviewTypes = ["application_action_required", "security_code", "verify_email"] as const;
const workActionNonCoreReviewTypes = [
  "work_action_required",
  "work_deadline_detected",
  "work_follow_up_requested",
  "work_project_update_detected"
] as const;

const LLMEmailClassificationSchema = z.object({
  decision: z.enum(["log_event", "needs_review", "ignore"]),
  eventType: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).max(180),
  evidence: z.string().min(1).max(500),
  extracted: z.object({
    company: z.string().nullable(),
    role: z.string().nullable(),
    deadline: z.string().nullable(),
    actionRequired: z.boolean().nullable(),
    project: z.string().nullable(),
    senderIntent: z.string().nullable()
  })
});

export interface ClassifyEmailWithLLMInput {
  adapterId: "job_search_email" | "work_action_email";
  source: "gmail";
  subject?: string;
  from?: string;
  snippet?: string;
  bodyText?: string;
  allowedEventTypes?: readonly string[];
  classifierMode: "llm" | "hybrid";
  minAutoLogConfidence: number;
  minReviewConfidence: number;
}

export interface ClassifyEmailWithLLMOptions {
  apiKey?: string;
  model?: string;
}

export async function classifyEmailWithLLM(
  input: ClassifyEmailWithLLMInput,
  options: ClassifyEmailWithLLMOptions = {}
): Promise<EmailClassification> {
  const allowedEventTypes = input.allowedEventTypes ?? JobSearchEmailAllowedEventTypes;
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
            text: buildEmailClassifierPrompt(allowedEventTypes)
          }
        ]
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: JSON.stringify({
              adapterId: input.adapterId,
              source: input.source,
              subject: input.subject ?? "",
              from: input.from ?? "",
              snippet: input.snippet ?? "",
              bodyText: truncateEmailText(input.bodyText ?? "", 6000),
              allowedEventTypes,
              ruleConfig: {
                classifierMode: input.classifierMode,
                minAutoLogConfidence: input.minAutoLogConfidence,
                minReviewConfidence: input.minReviewConfidence
              }
            })
          }
        ]
      }
    ],
    text: {
      format: {
        type: "json_schema",
        name: "email_classification",
        strict: true,
        schema: buildEmailClassificationJsonSchema(allowedEventTypes)
      }
    }
  });

  const parsed = LLMEmailClassificationSchema.parse(JSON.parse(response.output_text));
  return normalizeLLMEmailClassification(parsed, input, allowedEventTypes);
}

function normalizeLLMEmailClassification(
  parsed: z.infer<typeof LLMEmailClassificationSchema>,
  input: ClassifyEmailWithLLMInput,
  allowedEventTypes: readonly string[]
): EmailClassification {
  const eventType = parsed.eventType ?? undefined;
  const allowedEventType = eventType && allowedEventTypes.includes(eventType);
  const nonCoreReviewTypes: readonly string[] = input.adapterId === "work_action_email" ? workActionNonCoreReviewTypes : jobSearchNonCoreReviewTypes;
  const allowedNonCoreReviewType = eventType && nonCoreReviewTypes.includes(eventType);
  const combinedText = normalizeText([
    input.subject,
    input.from,
    input.snippet,
    input.bodyText,
    parsed.reason,
    parsed.evidence
  ].filter(Boolean).join("\n"));

  if (isIrrelevantEmail(combinedText, parsed, input.adapterId)) {
    return EmailClassificationSchema.parse({
      decision: "ignore",
      confidence: parsed.confidence,
      reason: input.adapterId === "work_action_email" ? "irrelevant_to_work_action" : "irrelevant_to_job_search",
      evidence: parsed.evidence,
      extracted: cleanExtracted(parsed.extracted),
      metadata: {
        classifierMode: input.classifierMode,
        adapterId: input.adapterId,
        source: input.source,
        classifier: "llm"
      }
    });
  }

  if (allowedNonCoreReviewType) {
    return EmailClassificationSchema.parse({
      decision: "needs_review",
      eventType,
      confidence: Math.max(parsed.confidence, input.minReviewConfidence),
      reason: eventType,
      evidence: parsed.evidence,
      extracted: {
        ...cleanExtracted(parsed.extracted),
        actionRequired: true
      },
      metadata: {
        classifierMode: input.classifierMode,
        adapterId: input.adapterId,
        source: input.source,
        classifier: "llm"
      }
    });
  }

  if (eventType && (!allowedEventType || !EventTypeSchema.safeParse(eventType).success)) {
    if (isApplicationActionRequiredEmail(combinedText, parsed)) {
      return EmailClassificationSchema.parse({
        decision: "needs_review",
        eventType: "application_action_required",
        confidence: Math.max(parsed.confidence, input.minReviewConfidence),
        reason: "application_action_required",
        evidence: parsed.evidence,
        extracted: {
          ...cleanExtracted(parsed.extracted),
          actionRequired: true
        },
        metadata: {
          classifierMode: input.classifierMode,
          adapterId: input.adapterId,
          source: input.source,
          classifier: "llm"
        }
      });
    }

    return EmailClassificationSchema.parse({
      decision: "ignore",
      confidence: parsed.confidence,
      reason: `unsupported_event_type:${eventType}`,
      evidence: parsed.evidence,
      extracted: cleanExtracted(parsed.extracted),
      metadata: {
        classifierMode: input.classifierMode,
        adapterId: input.adapterId,
        source: input.source,
        classifier: "llm"
      }
    });
  }

  if (!eventType && isApplicationActionRequiredEmail(combinedText, parsed)) {
    return EmailClassificationSchema.parse({
      decision: "needs_review",
      eventType: "application_action_required",
      confidence: Math.max(parsed.confidence, input.minReviewConfidence),
      reason: "application_action_required",
      evidence: parsed.evidence,
      extracted: {
        ...cleanExtracted(parsed.extracted),
        actionRequired: true
      },
      metadata: {
        classifierMode: input.classifierMode,
        adapterId: input.adapterId,
        source: input.source,
        classifier: "llm"
      }
    });
  }

  const decision =
    parsed.confidence < input.minReviewConfidence
      ? "ignore"
      : parsed.confidence < input.minAutoLogConfidence
        ? "needs_review"
        : parsed.decision;

  return EmailClassificationSchema.parse({
    decision,
    eventType: decision === "ignore" ? undefined : eventType,
    confidence: parsed.confidence,
    reason: parsed.reason,
    evidence: parsed.evidence,
    extracted: cleanExtracted(parsed.extracted),
    metadata: {
      classifierMode: input.classifierMode,
      adapterId: input.adapterId,
      source: input.source,
      classifier: "llm"
    }
  });
}

function cleanExtracted(extracted: z.infer<typeof LLMEmailClassificationSchema>["extracted"]) {
  return {
    ...(extracted.company ? { company: extracted.company } : {}),
    ...(extracted.role ? { role: extracted.role } : {}),
    ...(extracted.deadline ? { deadline: extracted.deadline } : {}),
    ...(extracted.project ? { project: extracted.project } : {}),
    ...(extracted.senderIntent ? { senderIntent: extracted.senderIntent } : {}),
    ...(typeof extracted.actionRequired === "boolean" ? { actionRequired: extracted.actionRequired } : {})
  };
}

function buildEmailClassifierPrompt(allowedEventTypes: readonly string[]): string {
  const workAction = allowedEventTypes.some((eventType) => eventType.startsWith("work."));

  if (workAction) {
    return [
      "Classify one Gmail message for Alecto's work_action_email adapter.",
      "Return JSON only matching the schema.",
      "Classify only the email content. Do not use outside assumptions.",
      "Use approved event types only for direct core events.",
      `Approved event types: ${allowedEventTypes.join(", ")}`,
      "Allowed non-core review eventType values: work_action_required, work_deadline_detected, work_follow_up_requested, work_project_update_detected.",
      "Be conservative. If meaningful but ambiguous, prefer needs_review.",
      "Only classify as a work action if it is related to actual work, a project, a client, or collaboration.",
      "Ignore retail, finance, travel, account, login, privacy, marketing, newsletters, product promotions, receipts, KYC, and bank/card/crypto admin emails.",
      "Ignore login/security codes, password resets, social notifications, generic product updates, webinars, event invitations, and promo announcements.",
      "No-reply messages are ignored unless from an explicit work/project tool and requiring user action.",
      "A deadline only matters if it is for a work/project action, not promo/account compliance.",
      "Do not invent project or deadline. Leave absent fields null.",
      "Use concise reason and short evidence from the email."
    ].join("\n");
  }

  return [
    "Classify one Gmail message for Alecto's job_search_email adapter.",
    "Return JSON only matching the schema.",
    "Classify only the email content. Do not use outside assumptions.",
    "Use approved event types only.",
    `Approved event types: ${allowedEventTypes.join(", ")}`,
    "Do not infer rejection unless explicit rejection language exists.",
    "Do not classify marketing offers, discounts, promotions, or newsletters as job offers.",
    "Do not classify security codes, verification emails, email confirmations, or resubmission prompts as application confirmations.",
    "If an email asks the user to verify, enter a code, complete, finish, or resubmit an application, use needs_review with eventType application_action_required, security_code, or verify_email.",
    "If the email is not about recruiting, job applications, interviews, job rejections, or employment offers, use decision ignore and eventType null even when confidence is high.",
    "Do not invent company or role. Leave absent fields null.",
    "Use concise reason and evidence. Evidence must be a short excerpt from the email."
  ].join("\n");
}

function isIrrelevantEmail(
  text: string,
  parsed: z.infer<typeof LLMEmailClassificationSchema>,
  adapterId: ClassifyEmailWithLLMInput["adapterId"]
): boolean {
  if (parsed.decision === "ignore") {
    return true;
  }

  if (adapterId === "work_action_email") {
    const hardIgnored = hasAny(text, [
      "confirm this login",
      "confirm login",
      "login attempt",
      "verification code",
      "security code",
      "password reset",
      "access code",
      "login code",
      "newsletter",
      "unsubscribe",
      "sale",
      "rebajas",
      "promotion",
      "promo",
      "discount",
      "cashback",
      "points",
      "revpoints",
      "privilege",
      "birthday gift",
      "webinar",
      "event invitation",
      "re:invent",
      "product announcement",
      "receipt",
      "invoice",
      "privacy notice",
      "privacy notices",
      "terms update",
      "account update",
      "confirm your occupation",
      "occupation confirmation",
      "kyc",
      "know your customer",
      "bank compliance",
      "finance compliance",
      "payment notice",
      "card notice",
      "crypto deposit",
      "social notification",
      "product update",
      "release notes",
      "generic update"
    ]);

    if (hardIgnored) {
      return true;
    }

    const noisySender = hasAny(text, ["noreply@", "no-reply@", "donotreply@", "do-not-reply@", "marketing@"]);
    const actionContext = hasAny(text, [
      "can you review",
      "please review",
      "please send",
      "action required",
      "deadline",
      "due by",
      "blocked by",
      "waiting on",
      "feedback",
      "review"
    ]);
    const workTool = hasAny(text, ["jira", "linear", "asana", "notion", "github", "gitlab", "slack", "trello"]);

    return noisySender && !(workTool && actionContext);
  }

  const explicitlyIrrelevant = hasAny(text, [
    "not related to job",
    "not job related",
    "not job-search related",
    "not related to a job application",
    "does not pertain to a job application",
    "does not relate to recruiting",
    "not about recruiting",
    "service disruption",
    "account update",
    "topper account",
    "product update",
    "payment account",
    "payment method",
    "billing account",
    "newsletter",
    "promotion",
    "marketing"
  ]);

  return explicitlyIrrelevant && !isApplicationActionRequiredEmail(text, parsed);
}

function isApplicationActionRequiredEmail(
  text: string,
  parsed: z.infer<typeof LLMEmailClassificationSchema>
): boolean {
  return Boolean(parsed.extracted.actionRequired) || hasAny(text, [
    "security code",
    "verification code",
    "verify your email",
    "confirm your email",
    "copy and paste this code",
    "enter the code",
    "resubmit your application",
    "complete your application",
    "finish your application",
    "action required",
    "required to submit"
  ]);
}

function hasAny(text: string, phrases: string[]): boolean {
  return phrases.some((phrase) => text.includes(phrase));
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function buildEmailClassificationJsonSchema(allowedEventTypes: readonly string[]) {
  const nonCoreTypes = allowedEventTypes.some((eventType) => eventType.startsWith("work."))
    ? workActionNonCoreReviewTypes
    : jobSearchNonCoreReviewTypes;

  return {
    type: "object",
    additionalProperties: false,
    required: ["decision", "eventType", "confidence", "reason", "evidence", "extracted"],
    properties: {
      decision: {
        type: "string",
        enum: ["log_event", "needs_review", "ignore"]
      },
      eventType: {
        anyOf: [
          { type: "string", enum: [...allowedEventTypes, ...nonCoreTypes] },
          { type: "null" }
        ]
      },
      confidence: {
        type: "number",
        minimum: 0,
        maximum: 1
      },
      reason: {
        type: "string",
        maxLength: 180
      },
      evidence: {
        type: "string",
        maxLength: 500
      },
      extracted: {
        type: "object",
        additionalProperties: false,
        required: ["company", "role", "deadline", "actionRequired", "project", "senderIntent"],
        properties: {
          company: { anyOf: [{ type: "string" }, { type: "null" }] },
          role: { anyOf: [{ type: "string" }, { type: "null" }] },
          deadline: { anyOf: [{ type: "string" }, { type: "null" }] },
          actionRequired: { anyOf: [{ type: "boolean" }, { type: "null" }] },
          project: { anyOf: [{ type: "string" }, { type: "null" }] },
          senderIntent: { anyOf: [{ type: "string" }, { type: "null" }] }
        }
      }
    }
  };
}

function truncateEmailText(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}
