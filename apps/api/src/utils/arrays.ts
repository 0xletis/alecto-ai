/**
 * Generic, dependency-free array-of-strings coercion extracted from
 * apps/api/src/server.ts, where it was defined once privately and called
 * 20 times for unrelated payload parsing (not specific to pending actions).
 */
export function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
