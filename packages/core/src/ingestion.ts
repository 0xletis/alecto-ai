import { z } from "zod";

export const IngestionDomainSchema = z.enum([
  "career",
  "health",
  "finance",
  "learning",
  "coding",
  "social",
  "reflection",
  "custom"
]);

export const IngestionSourceSchema = z.enum([
  "manual_paste",
  "telegram",
  "gmail",
  "future_gmail",
  "future_github",
  "future_wallet",
  "future_health"
]);

export const IngestionInputSchema = z.object({
  userId: z.string(),
  text: z.string().min(1),
  source: IngestionSourceSchema,
  metadata: z.record(z.unknown()).optional()
});

export const IngestionEventCandidateSchema = z.object({
  type: z.string(),
  data: z.record(z.unknown()).default({}),
  evidence: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1)
});

export const IngestionResultSchema = z.object({
  adapterId: z.string(),
  domain: IngestionDomainSchema,
  classification: z.string(),
  confidence: z.number().min(0).max(1),
  eventCandidates: z.array(IngestionEventCandidateSchema),
  suggestedReplyNeeded: z.boolean().optional(),
  extracted: z.record(z.unknown()).optional(),
  warnings: z.array(z.string()).optional()
});

export const IngestTextBodySchema = z.object({
  text: z.string().min(1),
  source: IngestionSourceSchema.default("manual_paste"),
  domainHint: IngestionDomainSchema.optional()
});

export type IngestionDomain = z.infer<typeof IngestionDomainSchema>;
export type IngestionSource = z.infer<typeof IngestionSourceSchema>;
export type IngestionInput = z.infer<typeof IngestionInputSchema>;
export type IngestionEventCandidate = z.infer<typeof IngestionEventCandidateSchema>;
export type IngestionResult = z.infer<typeof IngestionResultSchema>;
export type IngestTextBody = z.infer<typeof IngestTextBodySchema>;

export interface IngestionAdapter {
  id: string;
  domain: IngestionDomain;
  priority?: number;
  supports(input: IngestionInput): boolean;
  parse(input: IngestionInput): IngestionResult;
}

const adapters: IngestionAdapter[] = [];

export function registerIngestionAdapter(adapter: IngestionAdapter): void {
  if (adapters.some((item) => item.id === adapter.id)) {
    return;
  }

  adapters.push(adapter);
}

export function getIngestionAdapters(): IngestionAdapter[] {
  return [...adapters].sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0));
}

export function routeIngestion(input: IngestionInput): IngestionResult {
  const parsedInput = IngestionInputSchema.parse(input);
  const results = getIngestionAdapters()
    .filter((adapter) => adapter.supports(parsedInput))
    .map((adapter) => adapter.parse(parsedInput));

  if (results.length === 0) {
    return unknownIngestionResult();
  }

  return results.sort((left, right) => right.confidence - left.confidence)[0];
}

export const jobSearchTextAdapter: IngestionAdapter = {
  id: "job_search_text",
  domain: "career",
  priority: 100,
  supports(input) {
    const text = normalizeText(input.text);
    return (
      hasAny(text, [
        "unfortunately",
        "not selected",
        "move forward with other candidates",
        "not be proceeding",
        "no longer under consideration",
        "hemos decidido continuar con otros candidatos",
        "interview",
        "schedule an interview",
        "schedule a call",
        "calendly",
        "are you available",
        "available next",
        "available times",
        "entrevista",
        "agendar",
        "programar una llamada",
        "thanks for applying",
        "thank you for your application",
        "we received your application",
        "your application to",
        "application received",
        "gracias por aplicar",
        "hemos recibido tu solicitud",
        "we'd like to discuss",
        "we would like to discuss",
        "talent acquisition",
        "we would like to offer",
        "employment agreement"
      ]) || input.metadata?.domainHint === "career"
    );
  },
  parse(input) {
    const text = normalizeText(input.text);
    const extracted = extractJobSearchFields(input.text);
    const classification = classifyJobSearchText(text, input.source);
    const eventType = eventTypeForJobClassification(classification);
    const confidence = confidenceForJobClassification(classification, input.source);

    return IngestionResultSchema.parse({
      adapterId: "job_search_text",
      domain: "career",
      classification,
      confidence,
      eventCandidates: eventType
        ? [
            {
              type: eventType,
              data: extracted,
              evidence: [input.text.slice(0, 500)],
              confidence
            }
          ]
        : [],
      suggestedReplyNeeded: classification === "unknown",
      extracted,
      warnings: classification === "unknown" ? ["Could not classify job-search text clearly."] : undefined
    });
  }
};

registerIngestionAdapter(jobSearchTextAdapter);

function classifyJobSearchText(text: string, source: IngestionSource): string {
  const gmail = source === "gmail";

  // fix/private-alpha-gmail-classifier-precision-and-proactive-diagnostics: checked BEFORE the
  // hasStrongJobContext escape hatch below, and unconditionally — a job/career newsletter is, BY
  // DEFINITION, dense with job-related vocabulary (recruiter, applying, hiring, role...), so the
  // old `hasMarketingContext(text) && !hasStrongJobContext(text)` filter almost always let one
  // straight through: the newsletter content itself satisfied hasStrongJobContext, exempting it
  // from its own marketing filter. A real transcript showed exactly this — "CryptoJobsList Talent
  // Newsletter" got classified as a recruiter reply. Bulk/newsletter conventions (an unsubscribe
  // link, "view in browser", a numbered digest) are strong enough signals on their own that being
  // job-related doesn't matter; a newsletter is never a personal recruiter reply or a real
  // interview email, no matter how job-focused its content is.
  if (gmail && isJobNewsletterOrPromotional(text)) {
    return "filtered_marketing";
  }

  if (gmail && hasMarketingContext(text) && !hasStrongJobContext(text)) {
    return "filtered_marketing";
  }

  if (gmail && isApplicationActionRequired(text)) {
    return "application_action_required";
  }

  if (gmail && !hasStrongJobContext(text)) {
    return "unknown";
  }

  if (isInterviewScheduled(text)) {
    return "interview_scheduled";
  }

  if (isJobOffer(text)) {
    return "offer";
  }

  if (isRejection(text)) {
    return "rejection";
  }

  if (isApplicationConfirmation(text)) {
    return "application_confirmation";
  }

  if (isRecruiterReply(text)) {
    return "recruiter_reply";
  }

  return "unknown";
}

function eventTypeForJobClassification(classification: string): string | undefined {
  const eventTypes: Record<string, string> = {
    application_confirmation: "career.application_confirmation_received",
    recruiter_reply: "career.recruiter_reply_received",
    interview_scheduled: "career.interview_scheduled",
    rejection: "career.rejection_received",
    offer: "career.offer_received"
  };

  return eventTypes[classification];
}

/** fix/private-alpha-gmail-proactive-highsignal-and-goal-association: the two career.* Gmail
 * signal types that can materially change a job search overnight — an offer needs a real decision,
 * an interview needs prep — get a launch-readiness carve-out from the ordinary confidence-based
 * auto-log path (apps/api/src/server.ts's syncEmailSignalRule) so they always land in the review
 * queue and get flagged for proactive surfacing, even at classifier confidence that would
 * otherwise clear straight through. Kept here, next to the eventType mapping it's derived from,
 * as the single shared source every consumer (sync gate, review-list display, morning/evening
 * brief, gmail_nudge selection) reads from — never redefined independently per call site. */
export const HIGH_SIGNAL_JOB_SEARCH_EVENT_TYPES: ReadonlySet<string> = new Set([
  "career.offer_received",
  "career.interview_scheduled"
]);

function confidenceForJobClassification(classification: string, source: IngestionSource): number {
  if (classification === "filtered_marketing") {
    return 0.1;
  }

  if (classification === "application_action_required") {
    return 0.8;
  }

  if (classification === "unknown") {
    return 0.25;
  }

  if (source === "gmail") {
    return classification === "recruiter_reply" ? 0.9 : 0.95;
  }

  return 0.85;
}

function hasStrongJobContext(text: string): boolean {
  const hasApplicationWithHiringContext =
    hasAny(text, ["applying", "apply", "application"]) &&
    hasAny(text, ["role", "position", "job", "candidate", "recruitment", "careers", "career"]);

  return (
    hasApplicationWithHiringContext ||
    // fix/private-alpha-gmail-classifier-precision-and-proactive-diagnostics: was `text.includes(
    // "interview") && hasAny([...6 generic words])` — "interview" plus any ONE of "team"/"call"/
    // "hiring" is exactly the pattern quant/interview-prep newsletter content trivially satisfies
    // ("our team explains what quant interviews are really like..."). Reuses isInterviewScheduled's
    // own curated scheduling/invitation phrase list so this gate and that classification never
    // define "real interview content" two different ways.
    isInterviewScheduled(text) ||
    hasAny(text, ["recruiter", "talent acquisition", "hiring team"]) ||
    hasAny(text, ["greenhouse", "lever", "workday", "ashby", "personio", "smartrecruiters", "comeet", "workable", "recruitee"]) ||
    hasAny(text, [
      "thank you for your application",
      "thanks for your application",
      "thank you for applying",
      "thanks for applying",
      "we received your application",
      "we've received your application",
      "we have received your application",
      "we are reviewing your application",
      "we are currently reviewing your application",
      "currently reviewing your application",
      "our team will review your application",
      "your application to",
      "your application has been received",
      "application received",
      "not moving forward",
      "move forward with other candidates"
    ]) ||
    (text.includes("unfortunately") && hasAny(text, ["application", "candidate", "position", "role", "job"])) ||
    isJobOffer(text)
  );
}

function isApplicationActionRequired(text: string): boolean {
  return hasAny(text, [
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

/**
 * fix/private-alpha-gmail-classifier-precision-and-proactive-diagnostics: bulk/newsletter
 * conventions specific enough that a real 1:1 recruiter email would essentially never contain
 * them — an unsubscribe link and "view in browser" are CAN-SPAM-style boilerplate universal to
 * bulk senders, and the rest are concrete phrasings a real reported newsletter used verbatim
 * ("CryptoJobsList Talent Newsletter", "here are the top jobs this week"). Unlike
 * hasMarketingContext (generic shopping/rewards vocabulary), every signal here is checked
 * UNCONDITIONALLY in classifyJobSearchText — being job-related content doesn't exempt a
 * newsletter from being a newsletter; that's the entire point of one.
 */
function isJobNewsletterOrPromotional(text: string): boolean {
  return hasAny(text, [
    "newsletter",
    "unsubscribe",
    "view in browser",
    "view this email in your browser",
    "top jobs this week",
    "weekly jobs",
    "job digest",
    "jobs digest",
    "job alert",
    "job alerts",
    "jobs newsletter",
    "talent newsletter",
    "sponsored",
    "here are the top jobs",
    "curated jobs for you",
    "jobs curated for you",
    "recommended jobs for you",
    "browse more jobs",
    "jobs board digest"
  ]);
}

function hasMarketingContext(text: string): boolean {
  return hasAny(text, [
    "newsletter",
    "limited offer",
    "special offer",
    "shopping offer",
    "discount",
    "sale",
    "buy",
    "points",
    "revpoints",
    "glovo",
    "cashback",
    "reward",
    "rewards",
    "sports card",
    "collectible",
    "collectibles",
    "promo",
    "promotion"
  ]);
}

function isJobOffer(text: string): boolean {
  return (
    hasAny(text, [
      "job offer",
      "offer of employment",
      "employment offer",
      "offer letter",
      "we would like to offer you the role",
      "compensation package",
      "employment agreement",
      "contract for the role"
    ]) ||
    (hasAny(text, ["offer", "compensation", "contract"]) &&
      hasAny(text, ["role", "position", "job", "employment", "hiring", "recruiter"]))
  );
}

/**
 * fix/private-alpha-gmail-classifier-precision-and-proactive-diagnostics: mere presence of the
 * word "interview" is deliberately NOT enough — a real transcript showed a quant-prep newsletter
 * subject-lined "we need to seriously talk about getcracked" get classified as a confirmed,
 * high-priority interview event purely because its body mentioned "interview" near "team"/"call".
 * Every phrase below is a genuine scheduling/invitation signal — something happening TO the
 * reader, not content ABOUT interviews in general. Deliberately excludes (must NOT match):
 * "interview prep", "interviews are hard", "how to pass interviews", "interview questions", "mock
 * interview", "people ask us about interviews" — none of those describe a real interview being
 * scheduled for this specific reader.
 */
function isInterviewScheduled(text: string): boolean {
  return hasAny(text, [
    "schedule an interview",
    "schedule your interview",
    "schedule the interview",
    "schedule a technical interview",
    "schedule a call",
    "scheduling your interview",
    "interview invitation",
    "invite you to interview",
    "invited you to interview",
    "invited to interview",
    "we'd like to interview you",
    "we would like to interview you",
    "like to invite you for an interview",
    "book a time",
    "book a call",
    "calendar invite",
    "calendly",
    "availability for the interview",
    "availability for your interview",
    "availability for interview",
    "your availability for interview",
    "next step is a call",
    "next step is an interview",
    "next step is a technical interview",
    "phone screen",
    "technical screen",
    "onsite interview",
    "interview scheduled",
    "interview has been scheduled",
    "confirm your interview",
    "confirmed for an interview",
    "entrevista",
    "agendar",
    "programar una llamada"
  ]);
}

function isRejection(text: string): boolean {
  return (
    (text.includes("unfortunately") &&
      hasAny(text, [
        "we will not be moving forward",
        "we are not moving forward",
        "not moving forward",
        "other candidates",
        "not selected",
        "not been selected",
        "will not be proceeding",
        "won't be progressing",
        "will not progress your application"
      ])) ||
    hasAny(text, [
      "we decided not to proceed",
      "we have decided not to proceed",
      "no longer under consideration",
      "you have not been selected",
      "you were not selected",
      "move forward with other candidates",
      "proceed with other candidates",
      "moving forward with other candidates",
      "unable to offer you",
      "not be proceeding",
      "will not be proceeding",
      "we won't be progressing",
      "we will not progress your application",
      "hemos decidido continuar con otros candidatos"
    ])
  );
}

function isApplicationConfirmation(text: string): boolean {
  return hasAny(text, [
    "application received",
    "we received your application",
    "we've received your application",
    "we have received your application",
    "your application was received",
    "your application has been received",
    "application submitted successfully",
    "application submitted",
    "application confirmed",
    "thanks for applying",
    "thank you for applying",
    "thank you for your application",
    "thank you for your interest",
    "our team will review your application",
    "we are reviewing your application",
    "we are currently reviewing your application",
    "currently reviewing your application",
    "we will be in touch if your qualifications match",
    "gracias por aplicar",
    "hemos recibido tu solicitud"
  ]);
}

function isRecruiterReply(text: string): boolean {
  return (
    hasAny(text, [
      "can you share availability",
      "share your availability",
      "are you available",
      "available next",
      "schedule a call",
      "schedule an interview",
      "asks for more information",
      "could you send",
      "can you send",
      "we'd like to discuss",
      "we would like to discuss",
      "would like to speak",
      "wants to speak",
      "next step is a call",
      "next step is a screen",
      "next step is an interview"
    ]) ||
    // fix/private-alpha-gmail-classifier-precision-and-proactive-diagnostics: dropped "interview"
    // and "screen" from the generic word list — a newsletter mentioning "recruiter" alongside
    // generic interview/screening content (very common in job-newsletter copy) is not a personal
    // reply, and isJobNewsletterOrPromotional/isInterviewScheduled already cover the real cases.
    (hasAny(text, ["recruiter", "hiring team", "talent acquisition"]) &&
      hasAny(text, ["speak", "call", "availability", "available", "more information", "next step"]))
  );
}

function extractJobSearchFields(text: string): Record<string, unknown> {
  const company = matchFirst(text, [/\bat\s+([A-Z][A-Za-z0-9&.\- ]{1,40}?)(?=[,.!?]|$|\s+(?:for|about|regarding|are|is|we)\b)/]);
  const role = matchFirst(text, [
    /\bfor the\s+([A-Za-z0-9&.\- /]{2,60})\s+role\b/i,
    /\bfor the role of\s+([A-Za-z0-9&.\- /]{2,60})\b/i
  ]);

  return {
    ...(company ? { company: cleanExtractedText(company) } : {}),
    ...(role ? { role: cleanExtractedText(role) } : {})
  };
}

function unknownIngestionResult(): IngestionResult {
  return IngestionResultSchema.parse({
    adapterId: "unknown",
    domain: "custom",
    classification: "unknown",
    confidence: 0,
    eventCandidates: [],
    suggestedReplyNeeded: true,
    warnings: ["No ingestion adapter supported this input."]
  });
}

function matchFirst(text: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  return undefined;
}

function hasAny(text: string, phrases: string[]): boolean {
  return phrases.some((phrase) => text.includes(phrase));
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanExtractedText(text: string): string {
  return text.replace(/[,.!?;:]+$/g, "").trim();
}
