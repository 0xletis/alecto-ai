import { z } from "zod";
import { evaluateGoalGuardrails } from "./goal-guardrails.js";
import { addDaysToLocalDate, formatLocalDate, localDateTimeToUtc } from "./time.js";

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
  invalidReason?: "past_explicit_time" | "weekday_mismatch";
  // Only set for invalidReason "weekday_mismatch" — a ready-to-show clarification question
  // (e.g. "Thursday 26 August doesn't match the calendar — ..."), since a generic "couldn't
  // understand" message would hide the actually-useful information: which side is wrong and
  // what the two plausible fixes are.
  clarification?: string;
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
    const date = localDateTimeToUtc(`${dmy[3]}-${dmy[2]}-${dmy[1]}`, pad2Time(dateMinutes), preferences.timezone);
    const isExplicitTime = Boolean(explicitTime || dateTime);
    return isExplicitTime && date <= now
      ? pastExplicitDateResult(dmy[0], dmy[0], preferences)
      : parsedDateResult(rollVaguePastDate(date, now, preferences, dayPart), dmy[0], dmy[0], preferences, isExplicitTime);
  }

  const ymd = lower.match(/\b(\d{4}-\d{2}-\d{2})(?:\s+(?:at\s+)?(\d{1,2}(?::\d{2})?\s*(?:am|pm)?|\d{1,2}:\d{2}))?\b/);

  if (ymd) {
    const dateTime = ymd[2] ? parseTimeValue(ymd[2]) : undefined;
    const dateMinutes = dateTime?.minutes ?? minutes;
    const date = localDateTimeToUtc(ymd[1], pad2Time(dateMinutes), preferences.timezone);
    const isExplicitTime = Boolean(explicitTime || dateTime);
    return isExplicitTime && date <= now
      ? pastExplicitDateResult(ymd[0], ymd[0], preferences)
      : parsedDateResult(rollVaguePastDate(date, now, preferences, dayPart), ymd[0], ymd[0], preferences, isExplicitTime);
  }

  const inDays = lower.match(/\bin\s+(\d+)\s+days?\b/);
  if (inDays) {
    return parsedDateResult(addDaysAt(now, Number(inDays[1]), hour, minute, preferences.timezone), inDays[0], inDays[0], preferences, Boolean(explicitTime));
  }

  const inWeeks = lower.match(/\bin\s+(\d+)\s+weeks?\b/);
  if (inWeeks) {
    return parsedDateResult(
      addDaysAt(now, Number(inWeeks[1]) * 7, hour, minute, preferences.timezone),
      inWeeks[0],
      inWeeks[0],
      preferences,
      Boolean(explicitTime)
    );
  }

  // fix/private-alpha-local-date-focus-and-gmail-confirmation-state (follow-up): this branch is
  // checked BEFORE "tomorrow" below on purpose. Spanish "mañana" alone means "tomorrow", but
  // "esta mañana" means "this morning" — checking this first stops the bare-"mañana" alternative
  // in the tomorrow branch from swallowing "esta mañana" and misreading it as "tomorrow". Each
  // language's day-part word (mañana/tarde, matí/tarda) isn't recognized by the generic
  // parseDayPart() sweep above, so this branch resolves its own effective time-of-day directly
  // from resolvedDayPart, rather than relying on the outer dayPart/minutes already computed for
  // the English-only words parseDayPart knows about.
  const thisDayPart = lower.match(
    new RegExp(
      `\\b(?:this\\s+(?<en>morning|afternoon|evening)|esta\\s+(?<es>mañana|manana|tarde)|aquest\\s+(?<caM>mat[íi])|aquesta\\s+(?<caT>tarda))(?:\\s+at\\s+\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)?)?${SAFE_END}`,
      "u"
    )
  );
  if (thisDayPart) {
    const resolvedDayPart: "morning" | "afternoon" | "evening" =
      ((thisDayPart.groups?.en as "morning" | "afternoon" | "evening" | undefined) ??
        (thisDayPart.groups?.es ? (thisDayPart.groups.es === "tarde" ? "afternoon" : "morning") : undefined) ??
        (thisDayPart.groups?.caM ? "morning" : undefined) ??
        (thisDayPart.groups?.caT ? "afternoon" : undefined))!;
    const effectiveMinutes = explicitTime?.minutes ?? minutesForDayPart(resolvedDayPart, preferences);
    const dueAt = atLocalTime(now, Math.floor(effectiveMinutes / 60), effectiveMinutes % 60, preferences.timezone);
    if (explicitTime && dueAt <= now) {
      return pastExplicitDateResult(thisDayPart[0], thisDayPart[0], preferences);
    }
    return parsedDateResult(rollVaguePastDate(dueAt, now, preferences, resolvedDayPart), thisDayPart[0], thisDayPart[0], preferences, Boolean(explicitTime));
  }

  const tomorrow = lower.match(
    new RegExp(
      `\\b(?:tomorrow|dem[àa]|mañana|manana)(?:\\s+(?:morning|afternoon|evening))?(?:\\s+at\\s+\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)?)?${SAFE_END}`,
      "u"
    )
  );
  if (tomorrow) {
    return parsedDateResult(addDaysAt(now, 1, hour, minute, preferences.timezone), tomorrow[0], tomorrow[0], preferences, Boolean(explicitTime));
  }

  // Spanish "esta noche" / Catalan "aquesta nit" aren't recognized by parseDayPart's English-only
  // sweep either, so — same reasoning as thisDayPart above — the tonight-specific default time
  // (preferences.tonightTimeMinutes) is applied directly here rather than via the outer minutes.
  const tonight = lower.match(/\b(?:tonight|esta\s+noche|aquesta\s+nit)(?:\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?\b/);
  if (tonight) {
    const effectiveMinutes = explicitTime?.minutes ?? preferences.tonightTimeMinutes;
    const effectiveHour = Math.floor(effectiveMinutes / 60);
    const effectiveMinute = effectiveMinutes % 60;
    const dueAt = atLocalTime(now, effectiveHour, effectiveMinute, preferences.timezone);
    if (explicitTime && dueAt <= now) {
      return pastExplicitDateResult(tonight[0], tonight[0], preferences);
    }
    const finalDueAt = dueAt <= now ? addDaysAt(now, 1, effectiveHour, effectiveMinute, preferences.timezone) : dueAt;
    return parsedDateResult(finalDueAt, tonight[0], tonight[0], preferences, Boolean(explicitTime));
  }

  const today = lower.match(/\b(?:today|hoy|avui)(?:\s+(?:morning|afternoon|evening))?(?:\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?\b/);
  if (today) {
    // fix/private-alpha-proactive-checkins-and-overdue-action-ux: a bare "today" with no explicit
    // time or day-part qualifier used to fall back to the SAME defaultActionTimeMinutes (9am)
    // every other date-only phrase uses. Every OTHER date-only phrase (tomorrow, a specific
    // weekday/date) is immune to that default ever already being in the past, because a future
    // calendar day's own 9am is always still ahead of "now" — "today" is the one case where it
    // isn't: created at 2pm, 9am has already passed, silently landing in rollVaguePastDate's
    // "+15 minutes from now" vague-fallback and creating a task that goes overdue almost
    // immediately (a real reported transcript: created ~01:11, overdue by ~01:26). Defaulting to
    // the END of the local day instead — only when the user gave neither an explicit time nor a
    // day-part ("today morning"/"tonight" keep their own already-intentional time) — keeps a
    // same-day due date comfortably ahead of "now" for a same-day task created at any hour.
    const effectiveMinutes = explicitTime || dayPart ? minutes : END_OF_DAY_TIME_MINUTES;
    const effectiveHour = Math.floor(effectiveMinutes / 60);
    const effectiveMinute = effectiveMinutes % 60;
    const dueAt = atLocalTime(now, effectiveHour, effectiveMinute, preferences.timezone);
    if (explicitTime && dueAt <= now) {
      return pastExplicitDateResult(today[0], today[0], preferences);
    }
    return parsedDateResult(rollVaguePastDate(dueAt, now, preferences, dayPart), today[0], today[0], preferences, Boolean(explicitTime));
  }

  // fix/private-alpha-local-date-focus-and-gmail-confirmation-state: "move it to wed 26"/
  // "wednesday 26"/"26 August" all previously failed or silently ignored the day-of-month number
  // — the OLD weekday regex right below only ever recognized a full weekday name with no trailing
  // day number, and abbreviated names ("wed") weren't recognized at all. This is checked BEFORE
  // that bare-weekday branch specifically so "wednesday 26" matches HERE (day number authoritative)
  // rather than being caught by the old regex as just "wednesday" with "26" silently discarded.
  // Deliberately requires a weekday name OR a month name alongside the day number — a bare "26"
  // alone is too ambiguous with an ordinary number mentioned in text to safely auto-interpret as a
  // date, and every real reported/requested phrasing includes at least one of the two.
  // fix/private-alpha-local-date-focus-and-gmail-confirmation-state (follow-up): the month prefix
  // now also accepts Spanish "de" ("26 de agosto") and Catalan "de"/elided "d'" ("26 d'agost",
  // "26 de agost") alongside the existing English "of" — all equally optional, so "26 August",
  // "26 agosto", and "26 agost" (no preposition at all) still match too.
  const dayOfMonth = lower.match(
    new RegExp(
      `\\b(?:(?:on\\s+)?(${WEEKDAY_ALIAS_PATTERN})\\s+)?(\\d{1,2})(?:st|nd|rd|th)?(?:\\s+(?:(?:of|de)\\s+|d['’])?(${MONTH_ALIAS_PATTERN}))?${SAFE_END}`,
      "u"
    )
  );
  if (dayOfMonth && (dayOfMonth[1] || dayOfMonth[3]) && Number(dayOfMonth[2]) >= 1 && Number(dayOfMonth[2]) <= 31) {
    const day = Number(dayOfMonth[2]);
    const monthAlias = dayOfMonth[3];
    const weekdayAlias = dayOfMonth[1];
    const todayLocal = formatLocalDate(now, preferences.timezone);
    const [todayYear, todayMonthNum] = todayLocal.split("-").map(Number) as [number, number];
    const targetMonthIndex = monthAlias !== undefined ? MONTH_ALIASES[monthAlias] : todayMonthNum - 1;
    const targetYear = monthAlias !== undefined && targetMonthIndex < todayMonthNum - 1 ? todayYear + 1 : todayYear;

    let targetLocalDate = `${targetYear}-${String(targetMonthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    let dueAt = localDateTimeToUtc(targetLocalDate, pad2Time(minutes), preferences.timezone);

    if (dueAt <= now) {
      if (explicitTime) {
        return pastExplicitDateResult(dayOfMonth[0].trim(), dayOfMonth[0].trim(), preferences);
      }
      // Already passed with only a DEFAULT time applied — roll forward one unit: a full year if a
      // specific month was named (the user clearly meant that exact month), otherwise one month
      // (a bare day-of-month said after that day already happened this month).
      targetLocalDate =
        monthAlias !== undefined
          ? `${targetYear + 1}-${String(targetMonthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`
          : addMonthsToLocalDate(targetLocalDate, 1);
      dueAt = localDateTimeToUtc(targetLocalDate, pad2Time(minutes), preferences.timezone);
    }

    // Task 3 (launch-readiness): the user may state a weekday ALONGSIDE the day-of-month
    // ("Thursday 26 August") — until now that weekday was matched but never actually checked
    // against the real calendar, so a contradictory statement ("Thursday" when the 26th is really
    // a Wednesday) would silently schedule whichever date the day-number resolved to, with the
    // user given no indication their stated weekday was ignored. Checked against the FINAL
    // targetLocalDate (after any past-date rollover above), since that's the date that would
    // actually be scheduled — validating a stale pre-rollover date would produce a mismatch
    // message about a date that's not even the one in question.
    if (weekdayAlias) {
      const statedWeekdayIndex = WEEKDAY_NAMES.indexOf(WEEKDAY_ALIASES[weekdayAlias]!);
      const actualWeekdayIndex = localWeekdayIndex(targetLocalDate);
      if (statedWeekdayIndex !== actualWeekdayIndex) {
        return weekdayMismatchResult(targetLocalDate, statedWeekdayIndex, actualWeekdayIndex, dayOfMonth[0].trim(), preferences);
      }
    }

    return parsedDateResult(dueAt, dayOfMonth[0].trim(), dayOfMonth[0].trim(), preferences, Boolean(explicitTime));
  }

  const weekday = lower.match(
    new RegExp(`\\b(?:(by|on|next)\\s+)?(${WEEKDAY_ALIAS_PATTERN})(?:\\s+(morning|afternoon|evening))?(?:\\s+at\\s+\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)?)?${SAFE_END}`, "u")
  );
  if (weekday) {
    const nextDate = nextWeekdayAt(now, WEEKDAY_ALIASES[weekday[2]!]!, weekday[1] === "next", hour, minute, preferences.timezone);
    return parsedDateResult(nextDate, weekday[0].trim(), weekday[0].trim(), preferences, Boolean(explicitTime));
  }

  if (explicitTime) {
    const dueAt = atLocalTime(now, Math.floor(explicitTime.minutes / 60), explicitTime.minutes % 60, preferences.timezone);
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

// fix/private-alpha-local-date-focus-and-gmail-confirmation-state: pad a "total minutes since
// midnight" value into the "HH:MM" string localDateTimeToUtc expects — every timezone-aware date
// branch below needs this, so it's shared rather than repeated per call site.
function pad2Time(totalMinutes: number): string {
  const hour = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/** "Today" (in `timezone`, from `base`) at hour:minute LOCAL time, as a real UTC instant — the
 * fix for a real reported bug where "today" at 01:11 Europe/Madrid on Aug 26 (23:11 UTC Aug 25)
 * resolved to Aug 25, the wrong calendar day, because the previous implementation used
 * Date.setHours (the JS runtime's OWN system timezone, UTC on this app's actual host) instead of
 * the user's real one. localDateTimeToUtc (packages/core/src/time.ts) is the one already-correct
 * primitive for this in the codebase — reused here rather than reimplemented. */
function atLocalTime(base: Date, hour: number, minute: number, timezone: string): Date {
  return localDateTimeToUtc(formatLocalDate(base, timezone), pad2Time(hour * 60 + minute), timezone);
}

function addDaysAt(base: Date, days: number, hour: number, minute: number, timezone: string): Date {
  const localDate = addDaysToLocalDate(formatLocalDate(base, timezone), days);
  return localDateTimeToUtc(localDate, pad2Time(hour * 60 + minute), timezone);
}

function addMinutes(base: Date, minutes: number): Date {
  return new Date(base.getTime() + minutes * 60_000);
}

/** Adds whole calendar months to a "YYYY-MM-DD" local date string, clamping the day to the
 * target month's real length (e.g. Jan 31 + 1 month -> Feb 28/29, never Mar 3). Local to this
 * file — only the day-of-month reschedule branch needs it right now. */
function addMonthsToLocalDate(date: string, months: number): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const totalMonths = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(totalMonths / 12);
  const targetMonthIndex = ((totalMonths % 12) + 12) % 12;
  const daysInTargetMonth = new Date(Date.UTC(targetYear, targetMonthIndex + 1, 0)).getUTCDate();
  const clampedDay = Math.min(day, daysInTargetMonth);
  return `${targetYear}-${String(targetMonthIndex + 1).padStart(2, "0")}-${String(clampedDay).padStart(2, "0")}`;
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
    return addDaysAt(now, 1, Math.floor(preferences.tonightTimeMinutes / 60), preferences.tonightTimeMinutes % 60, preferences.timezone);
  }

  return addMinutes(now, 15);
}

// Accepts common abbreviations ("wed", "thu") alongside full weekday names — a real reported
// message ("move it to wed 26") used the abbreviated form, which the old weekday matching never
// recognized at all. Values are the canonical full ENGLISH name every date-arithmetic function
// below expects; WEEKDAY_ALIAS_PATTERN is the same keys joined for use inside a RegExp literal.
//
// fix/private-alpha-local-date-focus-and-gmail-confirmation-state (follow-up): Spanish and
// Catalan weekday words (and their common abbreviations) are added as MORE keys resolving to the
// same canonical English names, rather than as a parallel dictionary — every downstream
// consumer (nextWeekdayAt, the day-of-month branch, the weekday-mismatch check) already only
// ever deals in canonical English names, so no other code needs to know a phrase was Spanish or
// Catalan at all.
const WEEKDAY_ALIASES: Record<string, string> = {
  monday: "monday",
  mon: "monday",
  tuesday: "tuesday",
  tue: "tuesday",
  tues: "tuesday",
  wednesday: "wednesday",
  wed: "wednesday",
  thursday: "thursday",
  thu: "thursday",
  thur: "thursday",
  thurs: "thursday",
  friday: "friday",
  fri: "friday",
  saturday: "saturday",
  sat: "saturday",
  sunday: "sunday",
  sun: "sunday",
  // Spanish
  lunes: "monday",
  lun: "monday",
  martes: "tuesday",
  mar: "tuesday",
  "miércoles": "wednesday",
  miercoles: "wednesday",
  "mié": "wednesday",
  mie: "wednesday",
  jueves: "thursday",
  jue: "thursday",
  viernes: "friday",
  vie: "friday",
  "sábado": "saturday",
  sabado: "saturday",
  "sáb": "saturday",
  sab: "saturday",
  domingo: "sunday",
  dom: "sunday",
  // Catalan
  dilluns: "monday",
  dl: "monday",
  dimarts: "tuesday",
  dt: "tuesday",
  dimecres: "wednesday",
  dc: "wednesday",
  dijous: "thursday",
  dj: "thursday",
  divendres: "friday",
  dv: "friday",
  dissabte: "saturday",
  ds: "saturday",
  diumenge: "sunday",
  dg: "sunday"
};
const WEEKDAY_ALIAS_PATTERN = Object.keys(WEEKDAY_ALIASES).sort((a, b) => b.length - a.length).join("|");

// JS's \b classifies accented Latin letters (á, é, í, à, ç, ...) as "non-word" characters, so a
// plain \b placed right after a Spanish/Catalan word that ENDS in one (demà, matí, març, mié,
// sáb) never matches — both sides of the boundary read as "non-word", and \b only fires when
// exactly one side is a word character. SAFE_END does the same job correctly for any Unicode
// letter; needed (with the "u" regex flag) only where one of these accent-ending words can be
// the very last thing matched before the boundary.
const SAFE_END = "(?![\\p{L}\\p{N}_])";

// 23:59 local — the target time-of-day for a bare "today" with no explicit time or day-part
// qualifier (fix/private-alpha-proactive-checkins-and-overdue-action-ux). Deliberately the LAST
// minute of the day, not some other "end of day" hour like 21:00: any earlier fixed hour could
// itself already be in the past for a user creating the task in the evening, reintroducing the
// exact vague-fallback bug this constant exists to avoid.
const END_OF_DAY_TIME_MINUTES = 23 * 60 + 59;

// Canonical English weekday/month names, in calendar order — shared by nextWeekdayAt (weekday
// index lookup) and the weekday-mismatch clarification message (Task 3), so both always agree on
// the same names regardless of what language the user's own phrase was in.
const WEEKDAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December"
];

const MONTH_ALIASES: Record<string, number> = {
  january: 0,
  jan: 0,
  february: 1,
  feb: 1,
  march: 2,
  mar: 2,
  april: 3,
  apr: 3,
  may: 4,
  june: 5,
  jun: 5,
  july: 6,
  jul: 6,
  august: 7,
  aug: 7,
  september: 8,
  sept: 8,
  sep: 8,
  october: 9,
  oct: 9,
  november: 10,
  nov: 10,
  december: 11,
  dec: 11,
  // Spanish
  enero: 0,
  febrero: 1,
  marzo: 2,
  abril: 3,
  mayo: 4,
  junio: 5,
  julio: 6,
  agosto: 7,
  septiembre: 8,
  setiembre: 8,
  octubre: 9,
  noviembre: 10,
  diciembre: 11,
  // Catalan
  gener: 0,
  febrer: 1,
  "març": 2,
  marc: 2,
  maig: 4,
  juny: 5,
  juliol: 6,
  agost: 7,
  setembre: 8,
  novembre: 10,
  desembre: 11
};
const MONTH_ALIAS_PATTERN = Object.keys(MONTH_ALIASES).sort((a, b) => b.length - a.length).join("|");

function localWeekdayIndex(localDate: string): number {
  // Safe regardless of the server's own system timezone: parsing a bare "YYYY-MM-DD" as UTC
  // midnight and reading getUTCDay() always reflects that CALENDAR date's real weekday.
  return new Date(`${localDate}T00:00:00Z`).getUTCDay();
}

function nextWeekdayAt(base: Date, weekday: string, forceNext: boolean, hour: number, minute: number, timezone: string): Date {
  const target = WEEKDAY_NAMES.indexOf(weekday.toLowerCase());
  const todayLocal = formatLocalDate(base, timezone);
  let days = (target - localWeekdayIndex(todayLocal) + 7) % 7;

  if (days === 0 || forceNext) {
    days += 7;
  }

  const targetLocalDate = addDaysToLocalDate(todayLocal, days);
  return localDateTimeToUtc(targetLocalDate, pad2Time(hour * 60 + minute), timezone);
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

// Task 3 (launch-readiness): builds the clarification for a stated weekday that doesn't match
// the real calendar day of the stated day-of-month. Offers both plausible fixes rather than
// silently picking one — correcting the weekday to match the stated date ("Wednesday 26 August"),
// or keeping the stated weekday and moving to its next real occurrence on/after that day-of-month
// ("Thursday 27 August"). dueAt is deliberately null: every existing call site that only checks
// `!parsedDate.dueAt` (action.snooze, parseActionRescheduleDate, action.create) is therefore
// already safe against mutating on a mismatch, even before it's updated to surface this specific
// message.
function weekdayMismatchResult(
  targetLocalDate: string,
  statedWeekdayIndex: number,
  actualWeekdayIndex: number,
  matchedText: string,
  preferences: ActionReminderPreferences
): ParsedActionDate {
  const [, monthNumText, dayNumText] = targetLocalDate.split("-");
  const dayNum = Number(dayNumText);
  const monthName = MONTH_NAMES[Number(monthNumText) - 1];
  const statedWeekdayName = capitalize(WEEKDAY_NAMES[statedWeekdayIndex]!);
  const actualWeekdayName = capitalize(WEEKDAY_NAMES[actualWeekdayIndex]!);
  const alternativeLocalDate = addDaysToLocalDate(targetLocalDate, (statedWeekdayIndex - actualWeekdayIndex + 7) % 7);
  const [, alternativeMonthText, alternativeDayText] = alternativeLocalDate.split("-");
  const alternativeMonthName = MONTH_NAMES[Number(alternativeMonthText) - 1];

  return {
    dueAt: null,
    dueText: matchedText,
    matchedText,
    confidence: 0,
    timezone: preferences.timezone,
    explicitTime: false,
    invalidReason: "weekday_mismatch",
    clarification:
      `${statedWeekdayName} ${dayNum} ${monthName} doesn't match the calendar — ${dayNum} ${monthName} is ${actualWeekdayName}. ` +
      `Did you mean ${actualWeekdayName} ${dayNum} ${monthName}, or ${statedWeekdayName} ${Number(alternativeDayText)} ${alternativeMonthName}?`
  };
}

function capitalize(word: string): string {
  return word.length ? `${word.charAt(0).toUpperCase()}${word.slice(1)}` : word;
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
