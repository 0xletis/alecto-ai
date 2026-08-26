export interface LocalDayRange {
  date: string;
  start: Date;
  end: Date;
  timezone: string;
}

export type DueWindow =
  | "overdue"
  | "due today morning"
  | "due today afternoon"
  | "due today evening"
  | "due today"
  | "due tomorrow morning"
  | "due tomorrow"
  | "due later this week"
  | "none";

export function getLocalTodayRange(now = new Date(), timezone = "UTC"): LocalDayRange {
  const date = formatLocalDate(now, timezone);
  const start = localDateTimeToUtc(date, "00:00", timezone);
  const nextDate = addDaysToLocalDate(date, 1);

  return {
    date,
    start,
    end: localDateTimeToUtc(nextDate, "00:00", timezone),
    timezone
  };
}

export function formatLocalDate(date: Date, timezone = "UTC"): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  return `${part(parts, "year")}-${part(parts, "month")}-${part(parts, "day")}`;
}

export function classifyDueWindow(dueAt: Date | undefined, now = new Date(), timezone = "UTC"): DueWindow {
  if (!dueAt) {
    return "none";
  }

  if (dueAt < now) {
    return "overdue";
  }

  const today = getLocalTodayRange(now, timezone);
  const dueDate = formatLocalDate(dueAt, timezone);
  const tomorrowDate = addDaysToLocalDate(today.date, 1);
  const weekEnd = localDateTimeToUtc(addDaysToLocalDate(today.date, 7), "00:00", timezone);

  if (dueDate === today.date) {
    return dueDayPart(dueAt, timezone, "due today");
  }

  if (dueDate === tomorrowDate) {
    return localHour(dueAt, timezone) < 12 ? "due tomorrow morning" : "due tomorrow";
  }

  if (dueAt < weekEnd) {
    return "due later this week";
  }

  return "none";
}

export function isWithinLocalDay(date: Date | undefined, range: LocalDayRange): boolean {
  return Boolean(date && date >= range.start && date < range.end);
}

function dueDayPart(date: Date, timezone: string, prefix: "due today"): DueWindow {
  const hour = localHour(date, timezone);

  if (hour < 12) {
    return `${prefix} morning`;
  }

  if (hour < 18) {
    return `${prefix} afternoon`;
  }

  if (hour < 22) {
    return `${prefix} evening`;
  }

  return prefix;
}

function localHour(date: Date, timezone: string): number {
  const hour = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    hour12: false
  }).formatToParts(date).find((item) => item.type === "hour")?.value;

  return Number(hour ?? 0);
}

/** Exported for fix/private-alpha-local-date-focus-and-gmail-confirmation-state — reused directly
 * by action-intake.ts's date-phrase parser (atLocalTime/addDaysAt/nextWeekdayAt), which
 * previously built "today"/"tomorrow"/weekday due dates with plain Date.setHours/setDate calls.
 * Those operate in the JS runtime's OWN system timezone (UTC on this app's actual host), not the
 * user's real one passed all the way through as `preferences.timezone` but never applied — a real
 * reported bug had "today" at 01:11 Europe/Madrid on Aug 26 (23:11 UTC Aug 25) resolve to Aug 25,
 * the wrong calendar day, because the arithmetic never left UTC. This is the one already-correct,
 * already-tested primitive in this codebase for "local wall-clock time in a given IANA timezone
 * -> the real UTC instant it refers to" — reusing it instead of writing a second implementation. */
export function localDateTimeToUtc(date: string, time: string, timezone: string): Date {
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0, 0));
  const offsetMs = timezoneOffsetMs(utcGuess, timezone);

  return new Date(utcGuess.getTime() - offsetMs);
}

function timezoneOffsetMs(date: Date, timezone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(date);
  const asUtc = Date.UTC(
    Number(part(parts, "year")),
    Number(part(parts, "month")) - 1,
    Number(part(parts, "day")),
    Number(part(parts, "hour")),
    Number(part(parts, "minute")),
    Number(part(parts, "second"))
  );

  return asUtc - date.getTime();
}

/** Exported alongside localDateTimeToUtc above, same reason — action-intake.ts's date-phrase
 * parser needs to add days to a LOCAL calendar date (never a UTC one) before converting back to a
 * real instant. */
export function addDaysToLocalDate(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const utc = new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0, 0));
  return utc.toISOString().slice(0, 10);
}

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((item) => item.type === type)?.value ?? "";
}
