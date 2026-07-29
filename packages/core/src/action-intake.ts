import { z } from "zod";

export const ManualActionTypeSchema = z.enum(["manual", "reminder", "follow_up", "deadline", "generic"]);

export const ActionExtractionResultSchema = z.object({
  shouldCreateAction: z.boolean(),
  confidence: z.number().min(0).max(1),
  title: z.string().optional(),
  description: z.string().optional(),
  dueAt: z.coerce.date().optional(),
  dueText: z.string().optional(),
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
const bettingActionPattern = /\b(bet|betting|gamble|apuesta|apostar|polymarket|trade|trading|long|short|leverage)\b/i;

export function extractManualAction(input: { text: string }, context: ActionIntakeContext = {}): ActionExtractionResult {
  const text = input.text.trim();

  if (!text) {
    return noAction("empty_text", input.text);
  }

  if (bettingActionPattern.test(text)) {
    return noAction("risk_action_blocked", text);
  }

  const hasActionPrefix = context.forceActionIntent || actionPrefixPatterns.some((pattern) => pattern.test(text));

  if (!hasActionPrefix || vagueActionPattern.test(text)) {
    return noAction(hasActionPrefix ? "vague_action" : "no_action_intent", text);
  }

  const { dueAt, dueText } = parseManualActionDue(text, context.now ?? new Date());
  const title = cleanManualActionTitle(text, dueText);

  if (!isConcreteActionTitle(title)) {
    return noAction("not_concrete", text);
  }

  const actionType = inferManualActionType(text, dueText);

  return ActionExtractionResultSchema.parse({
    shouldCreateAction: true,
    confidence: 0.9,
    title,
    description: dueText && !dueAt ? `Due: ${dueText}.` : undefined,
    dueAt,
    dueText,
    priority: "medium",
    project: inferProject(title),
    actionType,
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
    .replace(/\b(?:today|tonight|tomorrow|this evening)\b/gi, "")
    .replace(/\b(?:by|on|next)\s+(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi, "")
    .replace(/\bin\s+\d+\s+(?:day|days|week|weeks)\b/gi, "")
    .replace(/\b(review|send|finish|update|apply|write|prepare|book|schedule|check|reply|complete)\s+the\s+/gi, "$1 ")
    .replace(/\s+/g, " ")
    .trim();

  return sentenceCase(truncate(title, 80));
}

function isConcreteActionTitle(title?: string): title is string {
  if (!title || title.length < 3) {
    return false;
  }

  return /\b(review|call|send|finish|update|apply|write|prepare|book|schedule|check|reply|follow up|complete)\b/i.test(title);
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

function parseManualActionDue(text: string, now: Date): { dueAt?: Date; dueText?: string } {
  const lower = text.toLowerCase();
  const ymd = lower.match(/\b(\d{4}-\d{2}-\d{2})\b/);

  if (ymd) {
    const date = new Date(`${ymd[1]}T09:00:00`);
    return Number.isNaN(date.getTime()) ? { dueText: ymd[1] } : { dueAt: date, dueText: ymd[1] };
  }

  if (/\btonight|this evening\b/i.test(text)) {
    return { dueAt: atLocalTime(now, 20, 0), dueText: lower.includes("this evening") ? "this evening" : "tonight" };
  }

  if (/\btomorrow\b/i.test(text)) {
    const date = addDaysAt(now, 1, 9, 0);
    return { dueAt: date, dueText: "tomorrow" };
  }

  if (/\btoday\b/i.test(text)) {
    return { dueAt: atLocalTime(now, 18, 0), dueText: "today" };
  }

  const inDays = lower.match(/\bin\s+(\d+)\s+days?\b/);
  if (inDays) {
    return { dueAt: addDaysAt(now, Number(inDays[1]), 9, 0), dueText: inDays[0] };
  }

  const inWeeks = lower.match(/\bin\s+(\d+)\s+weeks?\b/);
  if (inWeeks) {
    return { dueAt: addDaysAt(now, Number(inWeeks[1]) * 7, 9, 0), dueText: inWeeks[0] };
  }

  const weekday = lower.match(/\b(?:by|on|next)?\s*(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/);
  if (weekday) {
    const nextDate = nextWeekdayAt(now, weekday[1], /\bnext\s+/i.test(weekday[0]));
    return { dueAt: nextDate, dueText: weekday[0].trim() };
  }

  return {};
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

function nextWeekdayAt(base: Date, weekday: string, forceNext: boolean): Date {
  const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const target = weekdays.indexOf(weekday.toLowerCase());
  const date = atLocalTime(base, 9, 0);
  let days = (target - date.getDay() + 7) % 7;

  if (days === 0 || forceNext) {
    days += 7;
  }

  date.setDate(date.getDate() + days);
  return date;
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
    .replace(/\b(review|send|finish|update|apply|write|prepare|book|schedule|check|reply|complete)\s+(?:the|a|an)\s+/gi, "$1 ")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
