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
        "we received your application",
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
    const classification = classifyJobSearchText(text);
    const eventType = eventTypeForJobClassification(classification);
    const confidence = confidenceForJobClassification(classification);

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

function classifyJobSearchText(text: string): string {
  if (
    hasAny(text, [
      "unfortunately",
      "not selected",
      "move forward with other candidates",
      "not be proceeding",
      "no longer under consideration",
      "hemos decidido continuar con otros candidatos"
    ])
  ) {
    return "rejection";
  }

  if (hasAny(text, ["we would like to offer", "offer", "compensation", "contract", "employment agreement", "oferta"])) {
    return "offer";
  }

  if (
    hasAny(text, [
      "interview",
      "schedule an interview",
      "schedule a call",
      "calendly",
      "meet",
      "available next",
      "available times",
      "entrevista",
      "agendar",
      "programar una llamada"
    ])
  ) {
    return "interview_scheduled";
  }

  if (
    hasAny(text, [
      "application received",
      "thanks for applying",
      "we received your application",
      "gracias por aplicar",
      "hemos recibido tu solicitud"
    ])
  ) {
    return "application_confirmation";
  }

  if (
    hasAny(text, [
      "thanks for reaching out",
      "your profile",
      "we'd like to discuss",
      "we would like to discuss",
      "are you available",
      "available next",
      "recruiter",
      "talent acquisition"
    ])
  ) {
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

function confidenceForJobClassification(classification: string): number {
  return classification === "unknown" ? 0.25 : 0.85;
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
