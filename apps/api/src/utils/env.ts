/**
 * Generic, dependency-free feature-flag check extracted from
 * apps/api/src/server.ts, where it was defined once privately and called
 * from three places (two legacy semantic-analysis call sites that stayed
 * in server.ts, plus the insights route group). Moved here as part of
 * server cleanup phase 3 so apps/api/src/routes/insights.ts can use it
 * without importing anything back from server.ts — that would create a
 * circular import.
 */
export function shouldUseOpenAIAnalysis(): boolean {
  return process.env.USE_OPENAI_ANALYSIS === "true" && Boolean(process.env.OPENAI_API_KEY);
}
