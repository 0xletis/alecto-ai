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

const GmailRuleMatchClassificationSchema = z.object({
  shouldCreateReview: z.boolean(),
  matchedRuleId: z.string().nullable(),
  matchedRuleName: z.string().nullable(),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1).max(180),
  suggestedReviewTitle: z.string().nullable(),
  detectedDateOrDeadline: z.string().nullable(),
  skipReason: z.string().nullable()
});

export interface GmailRuleMatchRule {
  id: string;
  name: string;
  adapterId: string;
  description?: string;
  query?: string;
  goalTitle?: string;
  examples?: string[];
}

export interface GmailRuleMatchMessage {
  id?: string;
  from?: string;
  to?: string;
  subject?: string;
  date?: string;
  snippet?: string;
}

export interface ClassifyGmailMessageAgainstRulesInput {
  source: "gmail";
  message: GmailRuleMatchMessage;
  rules: GmailRuleMatchRule[];
  activeGoals?: Array<{ id: string; title: string; category?: string | null }>;
}

export interface GmailRuleMatchClassification {
  shouldCreateReview: boolean;
  matchedRuleId: string | null;
  matchedRuleName: string | null;
  confidence: number;
  reason: string;
  suggestedReviewTitle: string;
  detectedDateOrDeadline: string | null;
  skipReason: string | null;
}

export interface ClassifyGmailMessageAgainstRulesOptions {
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

export async function classifyGmailMessageAgainstRules(
  input: ClassifyGmailMessageAgainstRulesInput,
  options: ClassifyGmailMessageAgainstRulesOptions = {}
): Promise<GmailRuleMatchClassification> {
  const safeInput = sanitizeGmailRuleMatchInput(input);

  if (process.env.GMAIL_RULE_MATCH_LLM_CAPTURE_INPUT === "true") {
    process.env.GMAIL_RULE_MATCH_LLM_CAPTURED_INPUT = JSON.stringify(safeInput);
  }

  if (process.env.GMAIL_RULE_MATCH_LLM_MOCK_THROW === "true") {
    delete process.env.GMAIL_RULE_MATCH_LLM_MOCK_THROW;
    throw new Error("mock Gmail rule-match LLM failure");
  }

  const mocked = mockGmailRuleMatchResponse(safeInput);
  if (mocked) {
    return normalizeGmailRuleMatchClassification(mocked, safeInput);
  }

  const client = createOpenAIClient({ apiKey: options.apiKey });
  const model = options.model ?? process.env.GMAIL_RULE_MATCH_LLM_MODEL ?? process.env.OPENAI_MODEL ?? defaultModel;
  const response = await client.responses.create({
    model,
    store: false,
    input: [
      {
        role: "developer",
        content: [
          {
            type: "input_text",
            text: buildGmailRuleMatchPrompt()
          }
        ]
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: JSON.stringify(safeInput)
          }
        ]
      }
    ],
    text: {
      format: {
        type: "json_schema",
        name: "gmail_rule_match",
        strict: true,
        schema: buildGmailRuleMatchJsonSchema()
      }
    }
  });

  return normalizeGmailRuleMatchClassification(JSON.parse(response.output_text), safeInput);
}

function sanitizeGmailRuleMatchInput(input: ClassifyGmailMessageAgainstRulesInput): ClassifyGmailMessageAgainstRulesInput {
  return {
    source: "gmail",
    message: {
      id: truncateEmailText(input.message.id ?? "", 120),
      from: truncateEmailText(input.message.from ?? "", 220),
      to: truncateEmailText(input.message.to ?? "", 220),
      subject: truncateEmailText(input.message.subject ?? "", 220),
      date: truncateEmailText(input.message.date ?? "", 120),
      snippet: truncateEmailText(input.message.snippet ?? "", 700)
    },
    rules: input.rules.slice(0, 20).map((rule) => ({
      id: truncateEmailText(rule.id, 120),
      name: truncateEmailText(rule.name, 120),
      adapterId: truncateEmailText(rule.adapterId, 80),
      description: truncateEmailText(rule.description ?? "", 500),
      query: truncateEmailText(rule.query ?? "", 300),
      goalTitle: truncateEmailText(rule.goalTitle ?? "", 160),
      examples: (rule.examples ?? []).slice(0, 5).map((example) => truncateEmailText(example, 180))
    })),
    activeGoals: (input.activeGoals ?? []).slice(0, 20).map((goal) => ({
      id: truncateEmailText(goal.id, 120),
      title: truncateEmailText(goal.title, 160),
      category: goal.category ? truncateEmailText(goal.category, 80) : null
    }))
  };
}

function mockGmailRuleMatchResponse(input: ClassifyGmailMessageAgainstRulesInput): unknown {
  const raw = process.env.GMAIL_RULE_MATCH_LLM_MOCK_RESPONSE;
  if (!raw) {
    return undefined;
  }

  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return parsed;
  }

  const record = parsed as Record<string, unknown>;
  const bySubject = record.bySubject;
  if (bySubject && typeof bySubject === "object" && !Array.isArray(bySubject)) {
    const subject = input.message.subject ?? "";
    const subjectMatch = (bySubject as Record<string, unknown>)[subject];
    if (subjectMatch) {
      return subjectMatch;
    }
  }

  return record.default ?? parsed;
}

function normalizeGmailRuleMatchClassification(
  raw: unknown,
  input: ClassifyGmailMessageAgainstRulesInput
): GmailRuleMatchClassification {
  const parsed = GmailRuleMatchClassificationSchema.parse(raw);
  const rule =
    (parsed.matchedRuleId ? input.rules.find((candidate) => candidate.id === parsed.matchedRuleId) : undefined) ??
    (parsed.matchedRuleName
      ? input.rules.find((candidate) => normalizeText(candidate.name) === normalizeText(parsed.matchedRuleName ?? ""))
      : undefined);

  if (!parsed.shouldCreateReview || !rule) {
    return {
      shouldCreateReview: false,
      matchedRuleId: null,
      matchedRuleName: null,
      confidence: parsed.confidence,
      reason: cleanOneLine(parsed.reason, 180),
      suggestedReviewTitle: cleanOneLine(parsed.suggestedReviewTitle || "Email review", 120),
      detectedDateOrDeadline: parsed.detectedDateOrDeadline ? cleanOneLine(parsed.detectedDateOrDeadline, 120) : null,
      skipReason: cleanOneLine(parsed.skipReason ?? (rule ? "no review needed" : "no active rule matched"), 180)
    };
  }

  return {
    shouldCreateReview: true,
    matchedRuleId: rule.id,
    matchedRuleName: rule.name,
    confidence: parsed.confidence,
    reason: cleanOneLine(parsed.reason, 180),
    suggestedReviewTitle: cleanOneLine(parsed.suggestedReviewTitle || input.message.subject || rule.name, 120),
    detectedDateOrDeadline: parsed.detectedDateOrDeadline ? cleanOneLine(parsed.detectedDateOrDeadline, 120) : null,
    skipReason: parsed.skipReason ? cleanOneLine(parsed.skipReason, 180) : null
  };
}

function cleanOneLine(value: string, maxLength: number): string {
  return truncateEmailText(value.replace(/\s+/g, " ").trim(), maxLength) || "unknown";
}

function buildGmailRuleMatchPrompt(): string {
  return [
    "You classify one recent Gmail message against Alecto's active Gmail tracking rules.",
    "Return JSON only matching the schema. Choose at most one matched rule.",
    "Use only the provided safe fields: sender, recipients, subject, date, snippet, active rules, and active goal titles.",
    "Do not assume access to the full email body. Do not request mailbox writes. This is review-first only.",
    "The active rules are generic. They may describe work actions, recruiter/job-search mail, invoices or bills, calendar/meeting mail, government/legal/tax admin, security/account alerts, shipping/refunds, personal/family admin, or any custom user-defined category.",
    "If the email clearly matches one active rule, set shouldCreateReview true, return that rule id/name, a calibrated confidence, a concise reason, and a useful review title.",
    "If no active rule matches, set shouldCreateReview false, matchedRuleId/name null, and skipReason explaining the non-match.",
    "Do not create a review just because the email is important in general; it must match one of the provided active rules.",
    "Do not invent rule ids, rule names, goals, facts, dates, or deadlines.",
    "Keep suggestedReviewTitle specific and useful, for example: 'Upgrade Node.js to 24', 'Review Endesa bill', 'Reply to recruiter about frontend role', 'Check apartment viewing appointment'."
  ].join("\n");
}

function buildGmailRuleMatchJsonSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      shouldCreateReview: { type: "boolean" },
      matchedRuleId: { type: ["string", "null"] },
      matchedRuleName: { type: ["string", "null"] },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      reason: { type: "string", maxLength: 180 },
      suggestedReviewTitle: { type: ["string", "null"], maxLength: 120 },
      detectedDateOrDeadline: { type: ["string", "null"], maxLength: 120 },
      skipReason: { type: ["string", "null"], maxLength: 180 }
    },
    required: [
      "shouldCreateReview",
      "matchedRuleId",
      "matchedRuleName",
      "confidence",
      "reason",
      "suggestedReviewTitle",
      "detectedDateOrDeadline",
      "skipReason"
    ]
  };
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
