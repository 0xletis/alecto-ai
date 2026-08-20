import { z } from "zod";
import { evaluateGoalGuardrails } from "./goal-guardrails.js";

export const ManualActionTypeSchema = z.enum(["manual", "reminder", "follow_up", "deadline", "generic"]);

export const ActionExtractionResultSchema = z.object({
  shouldCreateAction: z.boolean(),
  confidence: z.number().min(0).max(1),
  title: z.string().optional(),
  description: z.string().optional(),
  dueAt: z.coerce.date().optional(),
  dueText: z.string().optional(),
  matchedText: z.string().optional(),
  timezone: z.string().optional(),
  explicitTime: z.boolean().optional(),
  invalidReason: z.string().optional(),
  priority: z.enum(["low", "medium", "high"]),
  project: z.string().optional(),
  actionType: ManualActionTypeSchema,
  needsConfirmation: z.boolean(),
  reason: z.string(),
  evidence: z.string()
});

export type ManualActionType = z.infer<typeof ManualActionTypeSchema>;
export type ActionExtractionResult = z.infer<typeof ActionExtractionResultSchema>;

export interface ActionIntakeContext {
  now?: Date;
  timezone?: string;
  forceActionIntent?: boolean;
  reminderPreferences?: Partial<ActionReminderPreferences>;
}

export interface ActionReminderPreferences {
  timezone: string;
  defaultActionTimeMinutes: number;
  morningTimeMinutes: number;
  afternoonTimeMinutes: number;
  eveningTimeMinutes: number;
  tonightTimeMinutes: number;
}

export interface ParsedActionDate {
  dueAt: Date | null;
  dueText: string | null;
  matchedText: string | null;
  confidence: number;
  timezone: string;
  explicitTime: boolean;
  invalidReason?: "past_explicit_time";
}

const actionPrefixPatterns = [
  /^\s*i need to\s+/i,
  /^\s*i have to\s+/i,
  /^\s*remind me to\s+/i,
  /^\s*can you remind me to\s+/i,
  /^\s*don'?t let me forget to\s+/i,
  /^\s*add task:?\s+/i,
  /^\s*todo:?\s+/i,
  /^\s*i should\s+/i
];

const vagueActionPattern =
  /\b(be better|work harder|change my life|build a product|do more|try harder|improve myself|sort my life out)\b/i;

export function extractManualAction(input: { text: string }, context: ActionIntakeContext = {}): ActionExtractionResult {
  const text = input.text.trim();

  if (!text) {
    return noAction("empty_text", input.text);
  }

  if (evaluateGoalGuardrails({ text }).triggered) {
    return noAction("risk_action_blocked", text);
  }

  const hasActionPrefix = context.forceActionIntent || actionPrefixPatterns.some((pattern) => pattern.test(text));

  if (!hasActionPrefix || vagueActionPattern.test(text)) {
    return noAction(hasActionPrefix ? "vague_action" : "no_action_intent", text);
  }

  const parsedDate = parseActionDueDate(text, {
    now: context.now,
    timezone: context.timezone,
    preferences: context.reminderPreferences
  });
  const title = cleanManualActionTitle(text, parsedDate.matchedText ?? parsedDate.dueText ?? undefined);

  if (parsedDate.invalidReason === "past_explicit_time") {
    return noAction("past_explicit_time", text);
  }

  if (!isConcreteActionTitle(title)) {
    return noAction("not_concrete", text);
  }

  return ActionExtractionResultSchema.parse({
    shouldCreateAction: true,
    confidence: 0.9,
    title,
    description: parsedDate.dueText && !parsedDate.dueAt ? `Due: ${parsedDate.dueText}.` : undefined,
    dueAt: parsedDate.dueAt ?? undefined,
    dueText: parsedDate.dueText ?? undefined,
    matchedText: parsedDate.matchedText ?? undefined,
    timezone: parsedDate.timezone,
    explicitTime: parsedDate.explicitTime,
    invalidReason: parsedDate.invalidReason,
    priority: "medium",
    project: inferProject(title),
    actionType: inferManualActionType(text, parsedDate.dueText ?? undefined),
    needsConfirmation: false,
    reason: "concrete_manual_action",
    evidence: text
  });
}

function noAction(reason: string, evidence: string): ActionExtractionResult {
  return {
    shouldCreateAction: false,
    confidence: 0,
    priority: "medium",
    actionType: "generic",
    needsConfirmation: false,
    reason,
    evidence
  };
}

function cleanManualActionTitle(text: string, dueText?: string): string {
  let title = text
    .replace(/[.!?]+$/g, "")
    .replace(/^\s*i need to\s+/i, "")
    .replace(/^\s*i have to\s+/i, "")
    .replace(/^\s*remind me to\s+/i, "")
    .replace(/^\s*can you remind me to\s+/i, "")
    .replace(/^\s*don'?t let me forget to\s+/i, "")
    .replace(/^\s*add task:?\s+/i, "")
    .replace(/^\s*todo:?\s+/i, "")
    .replace(/^\s*i should\s+/i, "");

  if (dueText) {
    title = title.replace(new RegExp(`\\b${escapeRegExp(dueText)}\\b`, "i"), "");
  }

  title = title
    .replace(/\b(?:today|tomorrow)\s+(?:morning|afternoon|evening)\b/gi, "")
    .replace(/\bthis\s+(?:morning|afternoon|evening)\b/gi, "")
    .replace(/\bat\s+now\b/gi, "")
    .replace(/\b(?:today|tonight|tomorrow|now)\b/gi, "")
    .replace(/\bat\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/gi, "")
    .replace(/\b(?:by|on|next)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi, "")
    .replace(/\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+(?:morning|afternoon|evening)\b/gi, "")
    .replace(/\bin\s+\d+\s+(?:day|days|week|weeks)\b/gi, "")
    .replace(/\b(review|send|finish|update|apply|write|prepare|book|schedule|check|reply|complete|pay|test|train|buy|purchase)\s+the\s+/gi, "$1 ")
    .replace(/\s+/g, " ")
    .trim();

  return sentenceCase(truncate(title, 80));
}

function isConcreteActionTitle(title?: string): title is string {
  if (!title || title.length < 3) {
    return false;
  }

  return /\b(review|call|send|finish|update|apply|write|prepare|book|schedule|check|reply|follow up|complete|pay|test|train|buy|purchase)\b/i.test(title);
}

function inferManualActionType(text: string, dueText?: string): ManualActionType {
  if (/\bremind me to|don'?t let me forget to|can you remind me to\b/i.test(text)) {
    return "reminder";
  }

  if (/\bfollow up\b/i.test(text)) {
    return "follow_up";
  }

  if (dueText || /\bdeadline|due by|by monday|by tuesday|by wednesday|by thursday|by friday|by saturday|by sunday\b/i.test(text)) {
    return "deadline";
  }

  return "manual";
}

function inferProject(title: string): string | undefined {
  if (/\bdashboard\b/i.test(title)) {
    return "dashboard";
  }

  if (/\bhomepage\b/i.test(title)) {
    return "homepage";
  }

  if (/\bportfolio\b/i.test(title)) {
    return "portfolio";
  }

  return undefined;
}

export function parseActionDueDate(
  input: string,
  options: {
    now?: Date;
    timezone?: string;
    preferences?: Partial<ActionReminderPreferences>;
  } = {}
): ParsedActionDate {
  const now = options.now ?? new Date();
  const preferences = normalizeActionReminderPreferences({
    timezone: options.timezone,
    ...options.preferences
  });
  const text = input.trim();
  const lower = text.toLowerCase();
  const explicitTime = parseExplicitTime(lower);
  const dayPart = parseDayPart(lower);
  const minutes = explicitTime?.minutes ?? minutesForDayPart(dayPart, preferences);
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;

  const inMinutes = lower.match(/\bin\s+(\d+)\s+(?:minutes?|mins?)\b|\b(\d+)\s+(?:minutes?|mins?)\s+from\s+now\b/);
  if (inMinutes) {
    const amount = Number(inMinutes[1] ?? inMinutes[2]);
    return parsedDateResult(new Date(now.getTime() + amount * 60_000), inMinutes[0], inMinutes[0], preferences, false);
  }

  const nowMatch = lower.match(/\b(?:at\s+)?now\b/);
  if (nowMatch) {
    return parsedDateResult(new Date(now), nowMatch[0], nowMatch[0], preferences, false);
  }

  const dmy = lower.match(/\b(\d{2})\/(\d{2})\/(\d{4})(?:\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2}))?\b/);
  if (dmy) {
    const dateTime = dmy[4] ? parseTimeValue(dmy[4]) : undefined;
    const dateMinutes = dateTime?.minutes ?? minutes;
    const date = new Date(`${dmy[3]}-${dmy[2]}-${dmy[1]}T00:00:00`);
    date.setHours(Math.floor(dateMinutes / 60), dateMinutes % 60, 0, 0);
    const isExplicitTime = Boolean(explicitTime || dateTime);
    return isExplicitTime && date <= now
      ? pastExplicitDateResult(dmy[0], dmy[0], preferences)
      : parsedDateResult(rollVaguePastDate(date, now, preferences, dayPart), dmy[0], dmy[0], preferences, isExplicitTime);
  }

  const ymd = lower.match(/\b(\d{4}-\d{2}-\d{2})(?:\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2}))?\b/);

  if (ymd) {
    const dateTime = ymd[2] ? parseTimeValue(ymd[2]) : undefined;
    const dateMinutes = dateTime?.minutes ?? minutes;
    const date = new Date(`${ymd[1]}T00:00:00`);
    date.setHours(Math.floor(dateMinutes / 60), dateMinutes % 60, 0, 0);
    const isExplicitTime = Boolean(explicitTime || dateTime);
    return isExplicitTime && date <= now
      ? pastExplicitDateResult(ymd[0], ymd[0], preferences)
      : parsedDateResult(rollVaguePastDate(date, now, preferences, dayPart), ymd[0], ymd[0], preferences, isExplicitTime);
  }

  const inDays = lower.match(/\bin\s+(\d+)\s+days?\b/);
  if (inDays) {
    return parsedDateResult(addDaysAt(now, Number(inDays[1]), hour, minute), inDays[0], inDays[0], preferences, Boolean(explicitTime));
  }

  const inWeeks = lower.match(/\bin\s+(\d+)\s+weeks?\b/);
  if (inWeeks) {
    return parsedDateResult(
      addDaysAt(now, Number(inWeeks[1]) * 7, hour, minute),
      inWeeks[0],
      inWeeks[0],
      preferences,
      Boolean(explicitTime)
    );
  }

  const tomorrow = lower.match(/\btomorrow(?:\s+(?:morning|afternoon|evening))?(?:\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?\b/);
  if (tomorrow) {
    return parsedDateResult(addDaysAt(now, 1, hour, minute), tomorrow[0], tomorrow[0], preferences, Boolean(explicitTime));
  }

  const tonight = lower.match(/\btonight(?:\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?\b/);
  if (tonight) {
    const dueAt = atLocalTime(now, hour, minute);
    if (explicitTime && dueAt <= now) {
      return pastExplicitDateResult(tonight[0], tonight[0], preferences);
    }
    if (dueAt <= now) {
      dueAt.setDate(dueAt.getDate() + 1);
    }
    return parsedDateResult(dueAt, tonight[0], tonight[0], preferences, Boolean(explicitTime));
  }

  const thisDayPart = lower.match(/\bthis\s+(morning|afternoon|evening)(?:\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?\b/);
  if (thisDayPart) {
    const dueAt = atLocalTime(now, hour, minute);
    if (explicitTime && dueAt <= now) {
      return pastExplicitDateResult(thisDayPart[0], thisDayPart[0], preferences);
    }
    return parsedDateResult(
      rollVaguePastDate(dueAt, now, preferences, thisDayPart[1] as ReturnType<typeof parseDayPart>),
      thisDayPart[0],
      thisDayPart[0],
      preferences,
      Boolean(explicitTime)
    );
  }

  const today = lower.match(/\btoday(?:\s+(?:morning|afternoon|evening))?(?:\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?\b/);
  if (today) {
    const dueAt = atLocalTime(now, hour, minute);
    if (explicitTime && dueAt <= now) {
      return pastExplicitDateResult(today[0], today[0], preferences);
    }
    return parsedDateResult(rollVaguePastDate(dueAt, now, preferences, dayPart), today[0], today[0], preferences, Boolean(explicitTime));
  }

  const weekday = lower.match(
    /\b(?:(by|on|next)\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+(morning|afternoon|evening))?(?:\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?\b/
  );
  if (weekday) {
    const nextDate = nextWeekdayAt(now, weekday[2], weekday[1] === "next", hour, minute);
    return parsedDateResult(nextDate, weekday[0].trim(), weekday[0].trim(), preferences, Boolean(explicitTime));
  }

  if (explicitTime) {
    const dueAt = atLocalTime(now, Math.floor(explicitTime.minutes / 60), explicitTime.minutes % 60);
    if (dueAt <= now) {
      return pastExplicitDateResult(explicitTime.matchedText, explicitTime.matchedText, preferences);
    }
    return parsedDateResult(dueAt, explicitTime.matchedText, explicitTime.matchedText, preferences, true);
  }

  return {
    dueAt: null,
    dueText: null,
    matchedText: null,
    confidence: 0,
    timezone: preferences.timezone,
    explicitTime: false
  };
}

function atLocalTime(base: Date, hour: number, minute: number): Date {
  const date = new Date(base);
  date.setHours(hour, minute, 0, 0);
  return date;
}

function addDaysAt(base: Date, days: number, hour: number, minute: number): Date {
  const date = atLocalTime(base, hour, minute);
  date.setDate(date.getDate() + days);
  return date;
}

function addMinutes(base: Date, minutes: number): Date {
  return new Date(base.getTime() + minutes * 60_000);
}

function rollVaguePastDate(
  dueAt: Date,
  now: Date,
  preferences: ActionReminderPreferences,
  dayPart?: ReturnType<typeof parseDayPart>
): Date {
  if (dueAt > now) {
    return dueAt;
  }

  if (dayPart === "tonight") {
    const nextTonight = atLocalTime(now, Math.floor(preferences.tonightTimeMinutes / 60), preferences.tonightTimeMinutes % 60);
    nextTonight.setDate(nextTonight.getDate() + 1);
    return nextTonight;
  }

  return addMinutes(now, 15);
}

function nextWeekdayAt(base: Date, weekday: string, forceNext: boolean, hour: number, minute: number): Date {
  const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const target = weekdays.indexOf(weekday.toLowerCase());
  const date = atLocalTime(base, hour, minute);
  let days = (target - date.getDay() + 7) % 7;

  if (days === 0 || forceNext) {
    days += 7;
  }

  date.setDate(date.getDate() + days);
  return date;
}

function normalizeActionReminderPreferences(input: Partial<ActionReminderPreferences> = {}): ActionReminderPreferences {
  return {
    timezone: input.timezone ?? "Europe/Madrid",
    defaultActionTimeMinutes: validMinuteOfDay(input.defaultActionTimeMinutes) ? input.defaultActionTimeMinutes : 540,
    morningTimeMinutes: validMinuteOfDay(input.morningTimeMinutes) ? input.morningTimeMinutes : 540,
    afternoonTimeMinutes: validMinuteOfDay(input.afternoonTimeMinutes) ? input.afternoonTimeMinutes : 900,
    eveningTimeMinutes: validMinuteOfDay(input.eveningTimeMinutes) ? input.eveningTimeMinutes : 1140,
    tonightTimeMinutes: validMinuteOfDay(input.tonightTimeMinutes) ? input.tonightTimeMinutes : 1200
  };
}

function validMinuteOfDay(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1439;
}

function parseDayPart(text: string): "morning" | "afternoon" | "evening" | "tonight" | undefined {
  if (/\btonight\b/.test(text)) return "tonight";
  if (/\bmorning\b/.test(text)) return "morning";
  if (/\bafternoon\b/.test(text)) return "afternoon";
  if (/\bevening\b/.test(text)) return "evening";
  return undefined;
}

function minutesForDayPart(dayPart: ReturnType<typeof parseDayPart>, preferences: ActionReminderPreferences): number {
  if (dayPart === "morning") return preferences.morningTimeMinutes;
  if (dayPart === "afternoon") return preferences.afternoonTimeMinutes;
  if (dayPart === "evening") return preferences.eveningTimeMinutes;
  if (dayPart === "tonight") return preferences.tonightTimeMinutes;
  return preferences.defaultActionTimeMinutes;
}

function parseExplicitTime(text: string): { minutes: number; matchedText: string } | undefined {
  const match = text.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);

  if (!match) {
    return undefined;
  }

  const parsed = parseTimeParts(match[1], match[2], match[3]);

  return parsed === undefined
    ? undefined
    : {
        minutes: parsed,
        matchedText: match[0]
      };
}

function parseTimeValue(value: string): { minutes: number } | undefined {
  const match = value.trim().toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);

  if (!match) {
    return undefined;
  }

  const minutes = parseTimeParts(match[1], match[2], match[3]);
  return minutes === undefined ? undefined : { minutes };
}

function parseTimeParts(hourText: string, minuteText?: string, meridiem?: string): number | undefined {
  let hour = Number(hourText);
  const minute = minuteText ? Number(minuteText) : 0;

  if (minute < 0 || minute > 59) {
    return undefined;
  }

  if (meridiem) {
    if (hour < 1 || hour > 12) return undefined;
    if (meridiem === "pm" && hour !== 12) hour += 12;
    if (meridiem === "am" && hour === 12) hour = 0;
  } else if (hour < 0 || hour > 23) {
    return undefined;
  }

  return hour * 60 + minute;
}

function parsedDateResult(
  dueAt: Date,
  dueText: string,
  matchedText: string,
  preferences: ActionReminderPreferences,
  explicitTime: boolean
): ParsedActionDate {
  return {
    dueAt: Number.isNaN(dueAt.getTime()) ? null : dueAt,
    dueText,
    matchedText,
    confidence: Number.isNaN(dueAt.getTime()) ? 0.2 : 0.95,
    timezone: preferences.timezone,
    explicitTime
  };
}

function pastExplicitDateResult(
  dueText: string,
  matchedText: string,
  preferences: ActionReminderPreferences
): ParsedActionDate {
  return {
    dueAt: null,
    dueText,
    matchedText,
    confidence: 0,
    timezone: preferences.timezone,
    explicitTime: true,
    invalidReason: "past_explicit_time"
  };
}

function sentenceCase(text: string): string {
  const clean = text.trim();
  return clean ? `${clean.charAt(0).toUpperCase()}${clean.slice(1)}` : clean;
}

function truncate(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 3).trim()}...` : text;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function normalizeManualActionTitleKey(text: string): string {
  return cleanManualActionTitle(text)
    .toLowerCase()
    .replace(/\b(review|send|finish|update|apply|write|prepare|book|schedule|check|reply|complete|pay|test|train|buy|purchase)\s+(?:the|a|an)\s+/gi, "$1 ")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
