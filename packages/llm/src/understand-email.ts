import { createOpenAIClient } from "./openai-client.js";
import { buildEmailUnderstandingJsonSchema, buildEmailUnderstandingPrompt, EmailUnderstandingLLMSchema, type EmailUnderstanding } from "./prompts/email-understanding.prompt.js";

export {
  EMAIL_KINDS,
  EmailKeyDetailsSchema,
  EmailUnderstandingLLMSchema,
  GOAL_RELEVANCE_LEVELS,
  PROMPT_VERSION as EMAIL_UNDERSTANDING_PROMPT_VERSION,
  RELEVANCE_LEVELS,
  SIGNAL_BUCKETS,
  SUGGESTED_USER_ACTIONS,
  buildEmailUnderstandingJsonSchema,
  buildEmailUnderstandingPrompt,
  type EmailKind,
  type EmailUnderstanding,
  type SignalBucket
} from "./prompts/email-understanding.prompt.js";

/**
 * fix/private-alpha-email-review-detail-and-general-mail-understanding: a general, domain-agnostic
 * email-understanding layer — NOT job-search-specific. Alecto is a general operator; Gmail is a
 * readonly signal source; an email review can be about a job application just as easily as a
 * flight change, an invoice, an insurance renewal, or an admin notice. This function only ever
 * PROPOSES a structured understanding of one already-cleaned/redacted email — it never mutates any
 * database row itself (see validateEmailUnderstanding below, and the caller's own tool boundary:
 * gmail.review.detail is `mutates: false`; only a distinct, explicit user instruction afterward can
 * approve/reject/log anything).
 *
 * refactor/private-alpha-general-email-intelligence-workflow: the actual prompt content (schema,
 * instructions, examples) now lives in ./prompts/email-understanding.prompt.ts as its own versioned,
 * independently testable module — this file only owns the OpenAI call plumbing, input sanitizing,
 * and the deterministic validation boundary below.
 */

const defaultModel = "gpt-4o-mini";

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
    senderDomain: truncate(input.senderDomain ?? "", 160),
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
  // Defaults every field this task's own extension added — keeps every EMAIL_UNDERSTANDING_MOCK_
  // RESPONSE test fixture written before signalBucket/ambiguity/realWorldEvent existed valid
  // without a mass rewrite, the same reasoning keyDetails/keyFacts' own defaults already established.
  // signalBucket defaults to "needs_decision" (fails closed) rather than guessing a bucket for a
  // legacy fixture that never declared one.
  const withDefaults =
    raw && typeof raw === "object"
      ? { keyDetails: null, keyFacts: [], realWorldEvent: "an email", signalBucket: "needs_decision", ambiguity: null, ...(raw as Record<string, unknown>) }
      : raw;
  return EmailUnderstandingLLMSchema.parse(withDefaults);
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
  // Same defaulting as normalizeRawUnderstanding above — this is also a boundary real callers (and
  // every existing test fixture) can hand a "raw" object straight to, not only the live LLM
  // response path.
  const withDefaults =
    raw && typeof raw === "object"
      ? { keyDetails: null, keyFacts: [], realWorldEvent: "an email", signalBucket: "needs_decision", ambiguity: null, ...(raw as Record<string, unknown>) }
      : raw;
  const parsed = EmailUnderstandingLLMSchema.safeParse(withDefaults);
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
    return {
      status: "needs_clarification",
      understanding,
      reason: understanding.ambiguity ?? "low confidence"
    };
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
