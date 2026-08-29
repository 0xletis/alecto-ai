import { resolveProductionDefaultedFlag } from "@operator-agent/core";

/**
 * Generic, dependency-free feature-flag check extracted from
 * apps/api/src/server.ts, where it was defined once privately and called
 * from three places (two legacy semantic-analysis call sites that stayed
 * in server.ts, plus the insights route group). Moved here as part of
 * server cleanup phase 3 so apps/api/src/routes/insights.ts can use it
 * without importing anything back from server.ts — that would create a
 * circular import.
 *
 * fix/private-alpha-launch-config-sanity: an unset USE_OPENAI_ANALYSIS now defaults ON in
 * production as long as OPENAI_API_KEY is actually present (a key with no flag would otherwise
 * silently leave real analysis off in production) — an explicit "true"/"false" still always wins,
 * and local dev/test keep defaulting OFF exactly as before.
 */
export function shouldUseOpenAIAnalysis(): boolean {
  if (!process.env.OPENAI_API_KEY) {
    return false;
  }
  return resolveProductionDefaultedFlag(process.env.USE_OPENAI_ANALYSIS, true);
}
