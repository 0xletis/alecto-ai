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
