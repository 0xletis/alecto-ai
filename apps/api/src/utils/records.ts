/**
 * Generic, dependency-free type guard extracted from apps/api/src/server.ts,
 * where it was defined once privately and called 53 times. Moved here as
 * part of server cleanup phase 2 so route modules extracted out of
 * server.ts (e.g. routes/checkins-ingest.ts) can use it without importing
 * anything back from server.ts — that would create a circular import.
 *
 * Note: a few other files in this app (apps/api/src/conversation/*.ts,
 * apps/api/src/agent-runtime/session-store.ts) already have their own
 * identical private copy of this same check. Those are left alone here —
 * out of scope for this pass, since touching them isn't needed to make this
 * extraction safe and would mean editing Agent Runtime v3 source files.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
