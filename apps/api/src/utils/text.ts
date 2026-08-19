/**
 * Generic, dependency-free string-normalization helper extracted from
 * apps/api/src/server.ts, where it was defined once privately and called
 * ~59 times for unrelated comparisons (goals, reflections, next-week plans,
 * email rules, etc.). Moved here — rather than into the new
 * apps/api/src/gmail/gmail-rule-service.ts, which also needs it — so the
 * Gmail module's own exports stay focused on Gmail-rule concerns instead of
 * re-exporting an unrelated generic utility.
 */
export function normalizeForComparison(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ");
}
