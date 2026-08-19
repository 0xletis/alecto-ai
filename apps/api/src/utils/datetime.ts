/**
 * Generic, dependency-free local-datetime formatter extracted from
 * apps/api/src/server.ts, where it was defined once privately and called
 * 17 times across actions, email reviews, and other unrelated surfaces —
 * not specific to action hygiene, which is why it lives here rather than
 * in apps/api/src/actions/hygiene.ts (which also needs it).
 */
export function formatLocalDateTime(date: Date | undefined, timezone = "Europe/Madrid"): string {
  if (!date) {
    return "not set";
  }

  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
}

/**
 * Generic pending-decision expiry helper extracted from
 * apps/api/src/server.ts, where it was called ~21 times across pending
 * actions of every kind (not just Gmail rules) — moved here so the legacy
 * Gmail conversation cluster (apps/api/src/legacy/gmail-conversation.ts)
 * can use it without importing back from server.ts.
 */
export function pendingDecisionExpiry(): Date {
  return new Date(Date.now() + 60 * 60 * 1000);
}

/**
 * Generic date-arithmetic and timezone-local-date helpers extracted from
 * apps/api/src/server.ts, where they were used across daily brief, weekly
 * review, and action-hygiene analysis — not specific to any one of those,
 * which is why they live here rather than in
 * apps/api/src/legacy/action-hygiene-conversation.ts (which also needs them).
 */
export function getDateTimePart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((part) => part.type === type)?.value ?? "";
}

export function formatDateInTimezone(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  return `${getDateTimePart(parts, "year")}-${getDateTimePart(parts, "month")}-${getDateTimePart(parts, "day")}`;
}

export function daysBetweenLocalDates(fromDate: string, toDate: string): number {
  const [fromYear, fromMonth, fromDay] = fromDate.split("-").map(Number);
  const [toYear, toMonth, toDay] = toDate.split("-").map(Number);
  const from = Date.UTC(fromYear, fromMonth - 1, fromDay);
  const to = Date.UTC(toYear, toMonth - 1, toDay);
  return Math.max(0, Math.floor((to - from) / (24 * 60 * 60 * 1000)));
}

export function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000)));
}
