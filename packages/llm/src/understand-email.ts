import { z } from "zod";
import { createOpenAIClient } from "./openai-client.js";

/**
 * fix/private-alpha-email-review-detail-and-general-mail-understanding: a general, domain-agnostic
 * email-understanding layer — NOT job-search-specific. Alecto is a general operator; Gmail is a
 * readonly signal source; an email review can be about a job application just as easily as a
 * flight change, an invoice, an insurance renewal, or an admin notice. This function only ever
 * PROPOSES a structured understanding of one already-cleaned/redacted email — it never mutates any
 * database row itself (see validateEmailUnderstanding below, and the caller's own tool boundary:
 * gmail.review.detail is `mutates: false`; only a distinct, explicit user instruction afterward can
 * approve/reject/log anything).
 */

const defaultModel = "gpt-4o-mini";

export const EMAIL_KINDS = [
  "application_confirmation",
  "recruiter_reply",
  "interview",
  "offer",
  "rejection",
  "job_alert",
  "security_auth",
  "onboarding",
  "receipt",
  "invoice",
  "travel_booking",
  "flight_update",
  "insurance",
  "admin_notice",
  "appointment",
  "subscription",
  "personal_message",
  "marketing",
  "unknown"
] as const;

export type EmailKind = (typeof EMAIL_KINDS)[number];

export const RELEVANCE_LEVELS = ["high", "medium", "low", "noise"] as const;
export const GOAL_RELEVANCE_LEVELS = ["direct", "indirect", "unrelated", "unclear"] as const;
export const SUGGESTED_USER_ACTIONS = ["approve", "ignore", "turn_into_action", "ask_clarification", "monitor"] as const;

const EmailUnderstandingLLMSchema = z.object({
  emailKind: z.enum(EMAIL_KINDS),
  relevance: z.enum(RELEVANCE_LEVELS),
  goalRelevance: z.enum(GOAL_RELEVANCE_LEVELS),
  summary: z.string().min(1).max(300),
  why: z.array(z.string().min(1).max(160)).min(1).max(5),
  suggestedUserAction: z.enum(SUGGESTED_USER_ACTIONS),
  confidence: z.number()
});

export type EmailUnderstanding = z.infer<typeof EmailUnderstandingLLMSchema>;

export interface UnderstandEmailInput {
  subject: string;
  /** Already cleaned and redacted by the caller (packages/core's cleanEmailBodyForDisplay) —
   * this function never receives raw MIME/HTML and never re-cleans anything itself. */
  bodyExcerpt: string;
  senderDomain: string;
  date?: string;
  linkedGoal?: { title: string; category?: string; description?: string };
  /** The active Gmail rule/watcher's own name/description, if this review came from one. */
  activeWatcherDescription?: string;
  /** The review's own already-stored classification (e.g. "application_confirmation",
   * "security_auth") — grounds the explanation in what already happened rather than letting the
   * LLM re-derive a possibly-contradictory answer from scratch. */
  currentCandidateClassification?: string;
}

export interface UnderstandEmailOptions {
  apiKey?: string;
  model?: string;
}

export async function understandEmail(input: UnderstandEmailInput, options: UnderstandEmailOptions = {}): Promise<EmailUnderstanding> {
  const mockThrow = process.env.EMAIL_UNDERSTANDING_MOCK_THROW === "true";
  if (mockThrow) {
    throw new Error("Mock email understanding failure.");
  }

  const mockResponse = process.env.EMAIL_UNDERSTANDING_MOCK_RESPONSE;
  if (mockResponse) {
    return normalizeRawUnderstanding(JSON.parse(mockResponse));
  }

  const client = createOpenAIClient({ apiKey: options.apiKey });
  const model = options.model ?? process.env.OPENAI_MODEL ?? defaultModel;

  const response = await client.responses.create({
    model,
    store: false,
    input: [
      { role: "developer", content: [{ type: "input_text", text: buildEmailUnderstandingPrompt() }] },
      { role: "user", content: [{ type: "input_text", text: JSON.stringify(sanitizeInput(input)) }] }
    ],
    text: {
      format: {
        type: "json_schema",
        name: "email_understanding",
        strict: true,
        schema: buildEmailUnderstandingJsonSchema()
      }
    }
  });

  return normalizeRawUnderstanding(JSON.parse(response.output_text));
}

function sanitizeInput(input: UnderstandEmailInput): Record<string, unknown> {
  return {
    subject: truncate(input.subject, 300),
    bodyExcerpt: truncate(input.bodyExcerpt, 3000),
    senderDomain: truncate(input.senderDomain, 160),
    date: input.date ? truncate(input.date, 60) : null,
    linkedGoal: input.linkedGoal
      ? {
          title: truncate(input.linkedGoal.title, 160),
          category: input.linkedGoal.category ? truncate(input.linkedGoal.category, 80) : null,
          description: input.linkedGoal.description ? truncate(input.linkedGoal.description, 300) : null
        }
      : null,
    activeWatcherDescription: input.activeWatcherDescription ? truncate(input.activeWatcherDescription, 300) : null,
    currentCandidateClassification: input.currentCandidateClassification ? truncate(input.currentCandidateClassification, 80) : null
  };
}

function normalizeRawUnderstanding(raw: unknown): EmailUnderstanding {
  return EmailUnderstandingLLMSchema.parse(raw);
}

function buildEmailUnderstandingPrompt(): string {
  return [
    "You explain ONE already-cleaned, already-redacted email to a user, for Alecto — a general personal operator, not a job-search-only tool.",
    "Return JSON only matching the schema.",
    "The email can be about ANYTHING relevant to the user's life: a job application, a recruiter, a flight or hotel booking, an invoice or receipt, an insurance policy or claim, a car/repair/fine/document, a government or admin appointment, a subscription renewal, or simply an important personal message.",
    `emailKind must be exactly one of: ${EMAIL_KINDS.join(", ")}. Pick the closest real fit; use "unknown" only when genuinely none fit.`,
    "relevance is how much this email matters in general (high/medium/low/noise) — a verification code or a bulk newsletter is noise regardless of sender; a genuine booking confirmation, invoice, or personal reply is at least medium.",
    "goalRelevance is ONLY about the linkedGoal/activeWatcherDescription given to you, if any — 'direct' if the email is clearly what that goal/watcher is tracking, 'indirect' if related but not a direct match, 'unrelated' if the email is about something else entirely, 'unclear' if you cannot tell. If no goal/watcher was given, use 'unclear'.",
    "summary is one or two plain sentences describing what the email actually says.",
    "why is 1-5 SHORT phrases, each one a concrete detail or exact-ish wording that actually appears in the given subject/bodyExcerpt — never invent a phrase that isn't grounded in the given text.",
    "suggestedUserAction: 'approve' only for something safe to log/confirm as-is (e.g. a clear booking/application confirmation), 'ignore' for noise/marketing/security codes, 'turn_into_action' when the email itself asks the user to do something with a deadline, 'monitor' for an informational update worth knowing about but with nothing to decide right now, 'ask_clarification' whenever you are genuinely unsure what this is or how it relates to the user's goals.",
    "confidence is 0 to 1, calibrated — do not default to a high number; genuinely ambiguous emails should score low.",
    "Never invent a company, amount, date, or fact not present in the given subject/bodyExcerpt.",
    "Do not assume you have the full raw email — you only see a cleaned, redacted excerpt; never claim to have read a security code, password, or token (it is already redacted)."
  ].join("\n");
}

function buildEmailUnderstandingJsonSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["emailKind", "relevance", "goalRelevance", "summary", "why", "suggestedUserAction", "confidence"],
    properties: {
      emailKind: { type: "string", enum: [...EMAIL_KINDS] },
      relevance: { type: "string", enum: [...RELEVANCE_LEVELS] },
      goalRelevance: { type: "string", enum: [...GOAL_RELEVANCE_LEVELS] },
      summary: { type: "string", maxLength: 300 },
      why: { type: "array", minItems: 1, maxItems: 5, items: { type: "string", maxLength: 160 } },
      suggestedUserAction: { type: "string", enum: [...SUGGESTED_USER_ACTIONS] },
      confidence: { type: "number", minimum: 0, maximum: 1 }
    }
  };
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

// --- Deterministic validation, applied by every caller before an understanding is ever shown to a
// user or used to drive a suggestion. Never trusts the LLM's own output directly. ---

export const LOW_CONFIDENCE_THRESHOLD = 0.4;

export type EmailUnderstandingValidationResult =
  | { status: "ok"; understanding: EmailUnderstanding }
  | { status: "needs_clarification"; understanding?: EmailUnderstanding; reason: string };

/**
 * Deterministic safety boundary for one LLM-proposed email understanding: unsupported enum values
 * are rejected outright (zod parse failure -> clarification, never a guessed fallback), confidence
 * is clamped to [0, 1], and every `why` phrase must be grounded in the actual cleaned subject/body
 * text given to the LLM - an ungrounded phrase is dropped, and if NONE survive, the whole result
 * becomes a clarification rather than a plausible-sounding but fabricated explanation. Low overall
 * confidence (or emailKind "unknown") also asks for clarification instead of presenting a shaky
 * guess as fact.
 */
export function validateEmailUnderstanding(raw: unknown, groundingText: string): EmailUnderstandingValidationResult {
  const parsed = EmailUnderstandingLLMSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "needs_clarification", reason: "The email understanding result used an unsupported category or shape." };
  }

  const clampedConfidence = Math.min(1, Math.max(0, parsed.data.confidence));
  const normalizedGrounding = normalizeForGrounding(groundingText);
  const groundedWhy = parsed.data.why.filter((phrase) => isGroundedInText(phrase, normalizedGrounding));

  const understanding: EmailUnderstanding = {
    ...parsed.data,
    confidence: clampedConfidence,
    why: groundedWhy
  };

  if (groundedWhy.length === 0) {
    return { status: "needs_clarification", understanding, reason: "I couldn't ground the explanation in the actual email content." };
  }

  if (clampedConfidence < LOW_CONFIDENCE_THRESHOLD || understanding.emailKind === "unknown") {
    return { status: "needs_clarification", understanding, reason: "low confidence" };
  }

  return { status: "ok", understanding };
}

function normalizeForGrounding(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** A why-phrase is "grounded" when it shares at least one meaningful (4+ char) word with the
 * actual cleaned email text it was supposedly derived from - cheap, deliberately forgiving (a
 * paraphrase should still pass), but enough to catch a wholly fabricated explanation. */
function isGroundedInText(phrase: string, normalizedGroundingText: string): boolean {
  const words = normalizeForGrounding(phrase)
    .split(" ")
    .filter((word) => word.length >= 4);

  if (words.length === 0) {
    return normalizedGroundingText.includes(normalizeForGrounding(phrase));
  }

  return words.some((word) => normalizedGroundingText.includes(word));
}
