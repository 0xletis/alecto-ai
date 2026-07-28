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
    (text.includes("interview") && hasAny(text, ["schedule", "availability", "available", "call", "recruiter", "hiring", "team"])) ||
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

function isInterviewScheduled(text: string): boolean {
  return (
    hasAny(text, [
      "schedule an interview",
      "schedule a call",
      "calendly",
      "available next",
      "available times",
      "next step is a call",
      "next step is an interview",
      "phone screen",
      "technical screen",
      "entrevista",
      "agendar",
      "programar una llamada"
    ]) ||
    (text.includes("interview") && hasAny(text, ["schedule", "availability", "available", "call", "recruiter", "hiring", "team"]))
  );
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
    (hasAny(text, ["recruiter", "hiring team", "talent acquisition"]) &&
      hasAny(text, ["speak", "call", "availability", "available", "more information", "next step", "screen", "interview"]))
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
