/**
 * Pure daily-loop-settings time helpers, split out of
 * apps/api/src/legacy/daily-conversation.ts (which now imports both from
 * here instead of defining them locally) as part of the Daily-Loop Settings
 * V3 Migration, so Agent Runtime v3 can parse/format the same
 * NotificationSettings time-of-day fields (morningTimeMinutes/
 * eveningTimeMinutes) without importing from legacy/*. Deliberately just
 * these two generic primitives, not legacy's whole-message regex parser
 * (parseNaturalDailyLoopSettings) — that parser exists only because legacy
 * has no LLM doing the "which field does this message mean" understanding
 * itself; V3's planner does that job, so it only ever needs the
 * text-to-minutes/minutes-to-text primitives, not a full free-text parser.
 */

export function parseNaturalTimeToMinutes(hourText: string, minuteText?: string, meridiem?: string): number | undefined {
  let hour = Number(hourText);
  const minute = minuteText ? Number(minuteText) : 0;

  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    return undefined;
  }

  if (meridiem?.toLowerCase() === "pm" && hour < 12) {
    hour += 12;
  }

  if (meridiem?.toLowerCase() === "am" && hour === 12) {
    hour = 0;
  }

  if (hour < 0 || hour > 23) {
    return undefined;
  }

  return hour * 60 + minute;
}

export function formatMinutesOfDay(minutes: number): string {
  const safe = Number.isInteger(minutes) && minutes >= 0 && minutes <= 1439 ? minutes : 0;
  const hours = Math.floor(safe / 60);
  const mins = safe % 60;
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

/**
 * Best-effort natural-language time-of-day text ("9am", "21:30", "9:15 pm") to
 * minutes-since-midnight — the shape Agent Runtime v3's planner emits for a
 * daily-loop settings change, since the planner already extracts a clean
 * time phrase itself rather than needing legacy's whole-message field
 * detection. Distinct from parseNaturalTimeToMinutes (which takes already
 * regex-split hour/minute/meridiem parts) — this owns that regex itself.
 */
export function parseTimeOfDayText(text: string): number | undefined {
  const match = text.trim().match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);

  if (!match) {
    return undefined;
  }

  return parseNaturalTimeToMinutes(match[1], match[2], match[3]);
}
