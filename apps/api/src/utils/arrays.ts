/**
 * Generic, dependency-free array-of-strings coercion extracted from
 * apps/api/src/server.ts, where it was defined once privately and called
 * 20 times for unrelated payload parsing (not specific to pending actions).
 */
export function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * Generic, dependency-free string-dedup helper extracted from
 * apps/api/src/server.ts alongside arrayOfStrings, where it was called 14
 * times for unrelated lists (risks, factors, goal ids, Gmail rule keywords,
 * etc.) — moved here so the legacy Gmail conversation cluster
 * (apps/api/src/legacy/gmail-conversation.ts) can use it without importing
 * back from server.ts.
 */
export function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value && value.trim())))];
}
