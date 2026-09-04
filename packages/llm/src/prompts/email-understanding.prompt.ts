import { z } from "zod";

/**
 * refactor/private-alpha-general-email-intelligence-workflow (gate 1): the versioned Stage B
 * prompt module — email understanding. Moved out of understand-email.ts (which now only owns the
 * OpenAI call plumbing + deterministic validation) so the actual prompt content — schema,
 * instructions, positive/negative examples — is its own explicit, independently testable unit, per
 * this task's own instruction: "Add or refactor versioned prompt modules ... prompts must be
 * explicit, tested, and domain-general."
 *
 * Answers, per email, exactly what this task's brief asks the LLM to answer:
 *   - what happened                -> summary
 *   - what real-world object/event -> realWorldEvent
 *   - does it matter to goals      -> goalRelevance (+ relevance for general importance)
 *   - new/duplicate/status/action/noise/needs-decision -> signalBucket
 *   - safe next action             -> suggestedUserAction
 * "If unsure, say what is unsure" (gate 2) -> ambiguity, a specific one-sentence explanation,
 * never the bare word "uncertain."
 */

export const PROMPT_VERSION = "email-understanding@2";

export const EMAIL_KINDS = [
  "application_confirmation",
  "recruiter_reply",
  "interview",
  "offer",
  "rejection",
  // A distinct kind for an automated "your application was viewed" status ping — no real human
  // contact, no career eventType, informational only (see the negative examples below).
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

/**
 * Direct answer to "is this new, duplicate evidence, a status update, an action, or noise, or does
 * it need a decision" — domain-general (works the same for a job application, an invoice, a
 * travel booking), never a job-search-only concept. Deterministic code (Stage D) still OWNS the
 * actual grouping/dedupe decision — this is the LLM's own per-email signal feeding into it, one
 * more validated input, never a write and never the final say (a fuzzy/near-duplicate merge across
 * TWO different emails is still confirmed separately — see batch-reconciliation.prompt.ts).
 */
export const SIGNAL_BUCKETS = ["new", "duplicate_evidence", "status_update", "action_worthy", "noise", "needs_decision"] as const;
export type SignalBucket = (typeof SIGNAL_BUCKETS)[number];

// fix/private-alpha-email-progress-count-and-review-ux (Task 7): structured facts, extracted once
// here rather than left for the user to dig out of a noisy full body. `keyDetails` is the
// job-application-shaped case (company/role/location/status/next step, plus the date the email
// ITSELF states the application/submission happened on, in the sender's own wording — used by the
// date policy in email-review-service.ts, never re-derived from "now"). `keyFacts` is the general
// fallback for every other domain (an invoice's amount/due date, a flight's new time, ...) so this
// stays useful outside job search too, never job-search-only.
export const EmailKeyDetailsSchema = z.object({
  company: z.string().max(120).nullable(),
  role: z.string().max(160).nullable(),
  location: z.string().max(120).nullable(),
  appliedDate: z.string().max(60).nullable(),
  status: z.string().max(120).nullable(),
  nextStep: z.string().max(200).nullable()
});

export const EmailUnderstandingLLMSchema = z.object({
  emailKind: z.enum(EMAIL_KINDS),
  relevance: z.enum(RELEVANCE_LEVELS),
  goalRelevance: z.enum(GOAL_RELEVANCE_LEVELS),
  summary: z.string().min(1).max(300),
  why: z.array(z.string().min(1).max(160)).min(1).max(5),
  suggestedUserAction: z.enum(SUGGESTED_USER_ACTIONS),
  confidence: z.number(),
  keyDetails: EmailKeyDetailsSchema.nullable(),
  keyFacts: z.array(z.string().min(1).max(160)).max(4),
  /** Short label for the real-world object/event this email is EVIDENCE of — "Application to
   * GoMining for Backend Engineer," "Flight change for booking ABC123," "Invoice #4471 from
   * Endesa" — never the email's own subject line verbatim (that's noisier and less useful for
   * grouping); a concise, human phrase naming the underlying thing that happened. */
  realWorldEvent: z.string().min(1).max(160),
  signalBucket: z.enum(SIGNAL_BUCKETS),
  /** Null ONLY when genuinely confident. Otherwise one specific sentence naming exactly what is
   * unsure — "this looks like either a job alert or a recruiter opportunity, but there is no
   * personal reply in the body" — never a bare "uncertain"/"not sure." */
  ambiguity: z.string().max(240).nullable()
});

export type EmailUnderstanding = z.infer<typeof EmailUnderstandingLLMSchema>;

export interface EmailUnderstandingPromptInput {
  subject: string;
  bodyExcerpt: string;
  senderDomain: string;
  date?: string;
  linkedGoal?: { title: string; category?: string; description?: string };
  activeWatcherDescription?: string;
  currentCandidateClassification?: string;
}

/**
 * The Stage B system/developer prompt. Domain-general instructions first, then explicit
 * positive/negative examples (job-search-heavy, since that's this product's current main use
 * case, but with enough non-job-search coverage that the model does not default every ambiguous
 * email to a job-search read).
 */
export function buildEmailUnderstandingPrompt(): string {
  return [
    `Prompt version: ${PROMPT_VERSION}.`,
    "You explain ONE already-cleaned, already-redacted email to a user, for Alecto — a general personal operator, not a job-search-only tool.",
    "Return JSON only matching the schema.",
    "The email can be about ANYTHING relevant to the user's life: a job application, a recruiter, a flight or hotel booking, an invoice or receipt, an insurance policy or claim, a car/repair/fine/document, a government or admin appointment, a subscription renewal, or simply an important personal message.",
    "",
    "--- What to answer ---",
    "summary: one or two plain sentences describing what ACTUALLY happened, in the email's own terms — 'what happened.'",
    "realWorldEvent: a short (a few words to one phrase) label for the real-world OBJECT or EVENT this email is evidence of, e.g. 'Application to GoMining for Backend Engineer,' 'Flight change for booking ABC123,' 'Invoice #4471 from Endesa' — never the raw subject line, never invented details not in the email.",
    "goalRelevance: ONLY about the linkedGoal/activeWatcherDescription given to you, if any — 'direct' if the email is clearly what that goal/watcher is tracking, 'indirect' if related but not a direct match, 'unrelated' if the email is about something else entirely, 'unclear' if you cannot tell. If no goal/watcher was given, use 'unclear.'",
    "signalBucket — the single most important field, answered directly, never left to guesswork downstream: 'new' for a first, standalone piece of evidence of something happening (a fresh application confirmation, a fresh booking); 'duplicate_evidence' ONLY when the email itself reads as a second confirmation/receipt for something the user would already recognize as the same event (e.g. a resend, a duplicate notification) — most single emails are NOT this, pick it only when the email's own content signals repetition; 'status_update' for a passive, informational ping about something already in motion (an application was viewed, a shipment update) with nothing new to decide; 'action_worthy' when a real reply, decision, or task is warranted (a recruiter's real message, an interview request, an invoice with money due, a booking needing a response); 'noise' for marketing, listings/digests, verification codes, or anything with no real personal relevance; 'needs_decision' when you genuinely cannot confidently place it in one of the other buckets.",
    "suggestedUserAction: 'approve' only for something safe to log/confirm as-is (e.g. a clear booking/application confirmation), 'ignore' for noise/marketing/security codes, 'turn_into_action' when the email itself asks the user to do something with a deadline, 'monitor' for an informational update worth knowing about but with nothing to decide right now, 'ask_clarification' whenever you are genuinely unsure what this is or how it relates to the user's goals.",
    "confidence: 0 to 1, calibrated — do not default to a high number; genuinely ambiguous emails should score low.",
    "ambiguity: null when you are genuinely confident. Otherwise ONE specific sentence naming exactly what is unsure — never the bare word 'uncertain' and never a vague hedge. Bad: 'uncertain signal.' Good: 'This looks like either a job alert or a recruiter opportunity, but there is no personal reply in the body.' Good: 'The body does not state whether this was actually submitted, only that the platform recommends applying.'",
    "why: 1-5 SHORT phrases, each one a concrete detail or exact-ish wording that actually appears in the given subject/bodyExcerpt — never invent a phrase that isn't grounded in the given text.",
    "relevance: how much this email matters in general (high/medium/low/noise) — a verification code or a bulk newsletter is noise regardless of sender; a genuine booking confirmation, invoice, or personal reply is at least medium.",
    "",
    "--- Hard rules ---",
    `emailKind must be exactly one of: ${EMAIL_KINDS.join(", ")}. Pick the closest real fit; use "unknown" only when genuinely none fit.`,
    "Never invent a company, amount, date, or fact not present in the given subject/bodyExcerpt.",
    "Do not assume you have the full raw email — you only see a cleaned, redacted excerpt; never claim to have read a security code, password, or token (it is already redacted).",
    "keyDetails: ONLY for a job-application-shaped email (application_confirmation, recruiter_reply, interview, offer, rejection) — company/role/location/status/nextStep if actually stated (each null if not present), and appliedDate set to the DATE THE EMAIL ITSELF SAYS THE APPLICATION/SUBMISSION HAPPENED (in whatever wording it used) — null if the email states no such date (do NOT default this to today or to the email's received date; that is decided elsewhere, not by you). For every other emailKind, keyDetails must be null.",
    "keyFacts: for any NON-job-application email (invoice, travel, insurance, admin, receipt, subscription, appointment, ...), 0-4 short factual phrases actually stated in the email — the general-purpose equivalent of keyDetails for every other domain. Empty array for a job-application-shaped email (use keyDetails instead) or when nothing concrete is stated.",
    "",
    "--- Job-search examples (the current main use case) ---",
    "'Thanks for applying! We've received your application for Backend Engineer.' -> emailKind application_confirmation, signalBucket new, suggestedUserAction approve, ambiguity null.",
    "'Se ha enviado tu solicitud a Iqana para el puesto de Software Engineer.' -> emailKind application_confirmation, signalBucket new (Spanish confirmation, same read).",
    "'Okify ha visto tu solicitud.' / 'X viewed your application.' -> emailKind application_viewed, signalBucket status_update, suggestedUserAction monitor — NOT recruiter_reply (no human replied), NOT application_confirmation (nothing was just submitted).",
    "'We would like to schedule an interview with you.' -> emailKind interview, signalBucket action_worthy, suggestedUserAction turn_into_action.",
    "'Unfortunately we will not be moving forward with your application.' -> emailKind rejection, signalBucket action_worthy (a real outcome worth logging), suggestedUserAction approve or turn_into_action depending on next step.",
    "'5 new jobs matching Software Engineer' / 'Job matches for you' -> emailKind job_alert, signalBucket noise, suggestedUserAction ignore — a listing/digest is never application_confirmation or offer, no matter how job-related the content is.",
    "'You are no longer showing recruiters you're open to work' (a LinkedIn/job-platform ACCOUNT/PROFILE setting change, either direction) -> emailKind marketing or personal_message (whichever fits closer), signalBucket noise — about the user's OWN account settings, not a real job-search event.",
    "'Miquel, add Dario Lo Buglio to your network' (a connection suggestion) -> emailKind personal_message, signalBucket noise, ambiguity null — never a job offer or recruiter reply.",
    "'Explora empleos similares a los que has solicitado' (a similar-jobs digest) -> emailKind job_alert, signalBucket noise.",
    "'Technical Solutions Blockchain — solicita ya el empleo' (a platform PROMPT to apply, not a confirmation the user already applied) -> emailKind job_alert, signalBucket noise, ambiguity 'This is a prompt to apply, not a confirmation that an application was actually submitted, unless the body states otherwise' — unless the body itself proves a submission happened, in which case application_confirmation.",
    "'We'd love to have you as part of our talent community' / cold recruiter outreach with no concrete offer -> emailKind recruiter_reply (not offer) — 'offer' is reserved for an explicit job/role/interview offer, never a generic opportunity pitch.",
    "",
    "--- General (non-job-search) examples ---",
    "'Your invoice #4471 for 84.20 EUR is ready, due September 15.' -> emailKind invoice, signalBucket action_worthy, keyFacts ['Amount due: 84.20 EUR', 'Due September 15'].",
    "'Thank you for your payment. Receipt attached.' (already paid, nothing owed) -> emailKind receipt, signalBucket status_update or noise, suggestedUserAction monitor — usually no action needed.",
    "'Your flight AB123 departure time has changed to 14:20.' -> emailKind flight_update, signalBucket action_worthy (may need rebooking/check-in awareness).",
    "'Your booking at Hotel Example is confirmed for Sep 10-12.' -> emailKind travel_booking, signalBucket new.",
    "'Your subscription will renew automatically on Oct 1.' -> emailKind subscription, signalBucket action_worthy only if the user might want to cancel/change; otherwise status_update.",
    "'Your verification code is 481923.' / any 2FA/auth code -> emailKind security_auth, signalBucket noise, suggestedUserAction ignore, UNLESS the surrounding content suggests a suspicious/unexpected login, in which case still security_auth but ambiguity should flag the concern.",
    "A genuine personal email from a named individual asking a direct question -> emailKind personal_message, signalBucket action_worthy if a reply is expected, suggestedUserAction turn_into_action or monitor."
  ].join("\n");
}

export function buildEmailUnderstandingJsonSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["emailKind", "relevance", "goalRelevance", "summary", "why", "suggestedUserAction", "confidence", "keyDetails", "keyFacts", "realWorldEvent", "signalBucket", "ambiguity"],
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
      keyFacts: { type: "array", minItems: 0, maxItems: 4, items: { type: "string", maxLength: 160 } },
      realWorldEvent: { type: "string", maxLength: 160 },
      signalBucket: { type: "string", enum: [...SIGNAL_BUCKETS] },
      ambiguity: { anyOf: [{ type: "string", maxLength: 240 }, { type: "null" }] }
    }
  };
}
