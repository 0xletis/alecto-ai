import { z } from "zod";

export const DailyCheckInAnswerSchema = z.object({
  key: z.string().min(1),
  value: z.union([z.string(), z.number(), z.boolean()])
});

export const DailyCheckInInputSchema = z.object({
  answers: z.array(DailyCheckInAnswerSchema)
});

export const DailyCheckInTextInputSchema = z.object({
  text: z.string().min(1)
});

export const ParsedDailyCheckInSchema = z.object({
  energy: z.number().min(1).max(10).optional(),
  anxiety: z.number().min(1).max(10).optional(),
  focus: z.number().min(1).max(10).optional(),
  gambling_impulse: z.number().min(0).max(10).optional(),
  trading_impulse: z.number().min(0).max(10).optional(),
  applications: z.number().positive().optional(),
  workout: z.number().positive().optional(),
  reading: z.number().positive().optional(),
  sleep: z.number().positive().optional(),
  notes: z.string().optional()
});

export type DailyCheckInAnswer = z.infer<typeof DailyCheckInAnswerSchema>;
export type DailyCheckInInput = z.infer<typeof DailyCheckInInputSchema>;
export type DailyCheckInTextInput = z.infer<typeof DailyCheckInTextInputSchema>;
export type ParsedDailyCheckIn = z.infer<typeof ParsedDailyCheckInSchema>;

export function parseDailyCheckinText(message: string): ParsedDailyCheckIn {
  const text = message.trim();
  const normalized = normalizeCheckinText(text);
  const parsed: ParsedDailyCheckIn = {
    notes: text
  };

  parsed.energy = numberAfterLabel(normalized, ["energy", "energia"]);
  parsed.anxiety = numberAfterLabel(normalized, ["anxiety", "ansiedad"]);
  parsed.focus = numberAfterLabel(normalized, ["focus", "foco"]);
  parsed.gambling_impulse = parseImpulse(normalized, ["gambling impulse", "gambling", "apostar", "apuesta", "bets"], true);
  parsed.trading_impulse = parseImpulse(normalized, ["trading impulse", "trading", "trade", "tradear"], false);
  parsed.sleep = parseSleep(normalized);
  parsed.applications = parseApplications(normalized);
  parsed.workout = parseMinutes(normalized, ["trained", "entrene", "entrenado", "entrene", "gym", "workout"]);
  parsed.reading = parseReading(normalized);

  return ParsedDailyCheckInSchema.parse(removeUndefined(parsed));
}

export function countDailyCheckinSignals(message: string): number {
  const normalized = normalizeCheckinText(message);
  const signalPatterns = [
    /\benergy\b|\benergia\b/,
    /\banxiety\b|\bansiedad\b/,
    /\bfocus\b|\bfoco\b/,
    /\bsleep\b|\bslept\b|\bdormi\b/,
    /\btrained\b|\bentrene\b|\bgym\b|\bworkout\b/,
    /\bread\b|\blei\b|\breading\b/,
    /\bcvs?\b|\bapplications?\b/,
    /\bgambling\b|\bapuesta\b|\bapostar\b|\bbets?\b/,
    /\btrading\b|\btrade\b|\btradear\b/
  ];

  return signalPatterns.filter((pattern) => pattern.test(normalized)).length;
}

export function parsedDailyCheckInToAnswers(parsed: ParsedDailyCheckIn): DailyCheckInAnswer[] {
  return Object.entries(parsed)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => ({
      key,
      value
    }));
}

function normalizeCheckinText(message: string): string {
  return message
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function numberAfterLabel(text: string, labels: string[]): number | undefined {
  for (const label of labels) {
    const match = text.match(new RegExp(`\\b${escapeRegex(label)}\\b\\s*(?:is|=|:)?\\s*(\\d+(?:\\.\\d+)?)`, "i"));
    const value = match?.[1] ? Number(match[1]) : undefined;

    if (value !== undefined && value >= 1 && value <= 10) {
      return value;
    }
  }

  return undefined;
}

function parseImpulse(text: string, labels: string[], includeBettingUrgePhrase: boolean): number | undefined {
  if (labels.some((label) => new RegExp(`\\b(no ${escapeRegex(label)}|sin ganas de apostar)\\b`).test(text))) {
    return 0;
  }

  if (/\bno bets?\b/.test(text) && labels.some((label) => label.includes("gambling") || label.includes("bets"))) {
    return 0;
  }

  if (includeBettingUrgePhrase && /\bganas de apostar\s*(\d+(?:\.\d+)?)\b/.test(text)) {
    return Number(text.match(/\bganas de apostar\s*(\d+(?:\.\d+)?)/)?.[1]);
  }

  return numberAfterLabel(text, labels);
}

function parseSleep(text: string): number | undefined {
  const match =
    text.match(/\b(?:slept|sleep|dormi|dormido)\s*(\d+(?:\.\d+)?)\s*(?:h|hours?|horas?)\b/) ??
    text.match(/\b(\d+(?:\.\d+)?)\s*(?:h|hours?|horas?)\s*(?:of\s*)?(?:sleep|dormi|dormido)\b/);

  return match?.[1] ? Number(match[1]) : undefined;
}

function parseApplications(text: string): number | undefined {
  const match =
    text.match(/\b(?:sent|mande|mandado|envie|enviado)\s*(\d+)\s*(?:cvs?|applications?)\b/) ??
    text.match(/\b(\d+)\s*(?:cvs?|applications?)\b/);

  return match?.[1] ? Number(match[1]) : undefined;
}

function parseReading(text: string): number | undefined {
  if (/\b(?:read|lei|reading)\b.*\b(?:half an hour|media hora)\b/.test(text)) {
    return 30;
  }

  return parseMinutes(text, ["read", "lei", "reading"]);
}

function parseMinutes(text: string, labels: string[]): number | undefined {
  for (const label of labels) {
    const hourPattern = new RegExp(`\\b${escapeRegex(label)}\\b.*\\b(?:one hour|una hora|1h)\\b`);

    if (hourPattern.test(text)) {
      return 60;
    }

    const halfHourPattern = new RegExp(`\\b${escapeRegex(label)}\\b.*\\b(?:half an hour|media hora)\\b`);

    if (halfHourPattern.test(text)) {
      return 30;
    }

    const match = text.match(new RegExp(`\\b${escapeRegex(label)}\\b\\s*(?:for\\s*)?(\\d+)\\s*(?:minutes?|mins?|min)\\b`));

    if (match?.[1]) {
      return Number(match[1]);
    }
  }

  return undefined;
}

function removeUndefined(value: ParsedDailyCheckIn): ParsedDailyCheckIn {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as ParsedDailyCheckIn;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
