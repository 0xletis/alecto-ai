/**
 * Small, dependency-free local-time helpers extracted from apps/worker/src/index.ts, where they
 * were defined privately — moved here so apps/worker/src/v3-proactive-delivery.ts (which must
 * stay import-safe for tests, unlike index.ts, which runs its tick loop as a side effect of being
 * imported) can reuse the exact same logic without importing index.ts itself.
 */

export function getPart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((part) => part.type === type)?.value ?? "";
}

export function formatLocalTime(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);

  return `${getPart(parts, "hour")}:${getPart(parts, "minute")}`;
}

export function formatMinutesOfDay(minutes: number | undefined): string {
  const safeMinutes = Number.isInteger(minutes) && minutes !== undefined && minutes >= 0 && minutes <= 1439 ? minutes : 0;
  const hour = Math.floor(safeMinutes / 60);
  const minute = safeMinutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

export function formatLocalDate(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  return `${getPart(parts, "year")}-${getPart(parts, "month")}-${getPart(parts, "day")}`;
}
