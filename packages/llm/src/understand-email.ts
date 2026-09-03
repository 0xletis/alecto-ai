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
  // fix/private-alpha-email-review-router-cleanup: a real reported bug — "Okify ha visto tu
  // solicitud" / "Iqana ha visto tu solicitud" (an automated "your application was viewed" status
  // notification, no human wrote it) was classifying as recruiter_reply, which is wrong on its own
  // terms (no reply was actually sent) and made it eligible for a "turn into action" follow-up
  // suggestion that doesn't apply to a passive status ping. A distinct kind for this — no real
  // human contact, no career eventType, informational only.
  "application_viewed",
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

// fix/private-alpha-email-progress-count-and-review-ux (Task 7): structured facts, extracted once
// here rather than left for the user to dig out of a noisy full body. `keyDetails` is the
// job-application-shaped case (company/role/location/status/next step, plus the date the email
// ITSELF states the application/submission happened on, in the sender's own wording — used by the
// date policy in email-review-service.ts, never re-derived from "now"). `keyFacts` is the general
// fallback for every other domain (an invoice's amount/due date, a flight's new time, ...) so this
// stays useful outside job search too, never job-search-only.
const EmailKeyDetailsSchema = z.object({
  company: z.string().max(120).nullable(),
  role: z.string().max(160).nullable(),
  location: z.string().max(120).nullable(),
  appliedDate: z.string().max(60).nullable(),
  status: z.string().max(120).nullable(),
  nextStep: z.string().max(200).nullable()
});

const EmailUnderstandingLLMSchema = z.object({
  emailKind: z.enum(EMAIL_KINDS),
  relevance: z.enum(RELEVANCE_LEVELS),
  goalRelevance: z.enum(GOAL_RELEVANCE_LEVELS),
  summary: z.string().min(1).max(300),
  why: z.array(z.string().min(1).max(160)).min(1).max(5),
  suggestedUserAction: z.enum(SUGGESTED_USER_ACTIONS),
  confidence: z.number(),
  keyDetails: EmailKeyDetailsSchema.nullable(),
  keyFacts: z.array(z.string().min(1).max(160)).max(4)
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
  // Defaults keyDetails/keyFacts when absent — keeps every existing EMAIL_UNDERSTANDING_MOCK_RESPONSE
  // test fixture (written before this task added these two fields) valid without a mass rewrite.
  const withDefaults =
    raw && typeof raw === "object"
      ? { keyDetails: null, keyFacts: [], ...(raw as Record<string, unknown>) }
      : raw;
  return EmailUnderstandingLLMSchema.parse(withDefaults);
}

function buildEmailUnderstandingPrompt(): string {
  return [
    "You explain ONE already-cleaned, already-redacted email to a user, for Alecto — a general personal operator, not a job-search-only tool.",
    "Return JSON only matching the schema.",
    "The email can be about ANYTHING relevant to the user's life: a job application, a recruiter, a flight or hotel booking, an invoice or receipt, an insurance policy or claim, a car/repair/fine/document, a government or admin appointment, a subscription renewal, or simply an important personal message.",
    `emailKind must be exactly one of: ${EMAIL_KINDS.join(", ")}. Pick the closest real fit; use "unknown" only when genuinely none fit.`,
    "'offer' means the email explicitly offers a job, a role, or an interview/next-step invitation — a generic recruiter opportunity, a job-board/newsletter listing, or cold outreach with no concrete offer is 'recruiter_reply' or 'job_alert', never 'offer'.",
    "A LinkedIn/job-platform ACCOUNT or PROFILE status notification (e.g. 'you are no longer showing recruiters you're open to work', an Open-to-Work visibility/privacy-setting change) is about the user's OWN account settings, not a real job-search event — use 'marketing' or 'personal_message' (whichever fits closer), never 'application_confirmation', 'recruiter_reply', or 'offer', even though the wording mentions job searching.",
    "An automated 'your application was viewed' status ping (e.g. 'Okify ha visto tu solicitud', 'Iqana ha visto tu solicitud', 'your application was viewed', 'a recruiter viewed your application') is 'application_viewed' — NOT 'recruiter_reply' (no human actually wrote back), NOT 'interview', NOT 'offer', NOT 'application_confirmation' (nothing was just submitted), and NOT 'marketing' unless the email is genuinely also a promotional pitch. suggestedUserAction for 'application_viewed' is 'monitor' (nothing to decide), never 'turn_into_action' or 'approve'.",
    "relevance is how much this email matters in general (high/medium/low/noise) — a verification code or a bulk newsletter is noise regardless of sender; a genuine booking confirmation, invoice, or personal reply is at least medium.",
    "goalRelevance is ONLY about the linkedGoal/activeWatcherDescription given to you, if any — 'direct' if the email is clearly what that goal/watcher is tracking, 'indirect' if related but not a direct match, 'unrelated' if the email is about something else entirely, 'unclear' if you cannot tell. If no goal/watcher was given, use 'unclear'.",
    "summary is one or two plain sentences describing what the email actually says.",
    "why is 1-5 SHORT phrases, each one a concrete detail or exact-ish wording that actually appears in the given subject/bodyExcerpt — never invent a phrase that isn't grounded in the given text.",
    "suggestedUserAction: 'approve' only for something safe to log/confirm as-is (e.g. a clear booking/application confirmation), 'ignore' for noise/marketing/security codes, 'turn_into_action' when the email itself asks the user to do something with a deadline, 'monitor' for an informational update worth knowing about but with nothing to decide right now, 'ask_clarification' whenever you are genuinely unsure what this is or how it relates to the user's goals.",
    "confidence is 0 to 1, calibrated — do not default to a high number; genuinely ambiguous emails should score low.",
    "Never invent a company, amount, date, or fact not present in the given subject/bodyExcerpt.",
    "Do not assume you have the full raw email — you only see a cleaned, redacted excerpt; never claim to have read a security code, password, or token (it is already redacted).",
    "keyDetails: ONLY for a job-application-shaped email (application_confirmation, recruiter_reply, interview, offer, rejection) — company/role/location/status/nextStep if actually stated (each null if not present), and appliedDate set to the DATE THE EMAIL ITSELF SAYS THE APPLICATION/SUBMISSION HAPPENED (in whatever wording it used, e.g. 'September 1, 2026' or '1 de septiembre de 2026') — null if the email states no such date (do NOT default this to today or to the email's received date; that is decided elsewhere, not by you). For every other emailKind, keyDetails must be null.",
    "keyFacts: for any NON-job-application email (invoice, travel, insurance, admin, receipt, subscription, appointment, ...), 0-4 short factual phrases actually stated in the email (e.g. 'Amount due: 84.20 EUR', 'Payment due September 15', 'New departure time: 14:20') — the general-purpose equivalent of keyDetails for every other domain. Empty array for a job-application-shaped email (use keyDetails instead) or when nothing concrete is stated."
  ].join("\n");
}

function buildEmailUnderstandingJsonSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["emailKind", "relevance", "goalRelevance", "summary", "why", "suggestedUserAction", "confidence", "keyDetails", "keyFacts"],
    properties: {
      emailKind: { type: "string", enum: [...EMAIL_KINDS] },
      relevance: { type: "string", enum: [...RELEVANCE_LEVELS] },
      goalRelevance: { type: "string", enum: [...GOAL_RELEVANCE_LEVELS] },
      summary: { type: "string", maxLength: 300 },
      why: { type: "array", minItems: 1, maxItems: 5, items: { type: "string", maxLength: 160 } },
      suggestedUserAction: { type: "string", enum: [...SUGGESTED_USER_ACTIONS] },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      keyDetails: {
        anyOf: [
          {
            type: "object",
            additionalProperties: false,
            required: ["company", "role", "location", "appliedDate", "status", "nextStep"],
            properties: {
              company: { anyOf: [{ type: "string", maxLength: 120 }, { type: "null" }] },
              role: { anyOf: [{ type: "string", maxLength: 160 }, { type: "null" }] },
              location: { anyOf: [{ type: "string", maxLength: 120 }, { type: "null" }] },
              appliedDate: { anyOf: [{ type: "string", maxLength: 60 }, { type: "null" }] },
              status: { anyOf: [{ type: "string", maxLength: 120 }, { type: "null" }] },
              nextStep: { anyOf: [{ type: "string", maxLength: 200 }, { type: "null" }] }
            }
          },
          { type: "null" }
        ]
      },
      keyFacts: { type: "array", minItems: 0, maxItems: 4, items: { type: "string", maxLength: 160 } }
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
  // Same keyDetails/keyFacts defaulting as normalizeRawUnderstanding above — this is also a
  // boundary real callers (and every existing test fixture written before this task added these
  // two fields) can hand a "raw" object straight to, not only the live LLM response path.
  const withDefaults =
    raw && typeof raw === "object" ? { keyDetails: null, keyFacts: [], ...(raw as Record<string, unknown>) } : raw;
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
