import { buildDailyReview, composeAgentResponse, getLocalTodayRange, type AgentResponse, type AgentResponseComposerInput, type MemoryEntry, type ProcessMessageResult, type StoredEvent } from "@operator-agent/core";
import { composeResponseWithOpenAI } from "@operator-agent/llm";
import { getActiveGoals, getEventsBetween, getOrCreateUserOperatingProfile, getRecentEvents, getRelevantMemories } from "@operator-agent/db";
import { shouldUseOpenAIAnalysis } from "../utils/env.js";
import { getUserTimezone } from "../utils/user-timezone.js";

/**
 * Final-agent-response composition helpers extracted from
 * apps/api/src/server.ts, where they were shared between the legacy
 * /messages/process handler (apps/api/src/legacy/messages-process.ts) and
 * the multi-intent guardrail executor (executeGuardrailMessage, part of the
 * separate POST /users/:userId/conversation/multi-intent route), which
 * stays in server.ts and imports from here one-directionally.
 */
export async function buildAgentContext(userId: string) {
  const activeGoals = await getActiveGoals(userId);
  const recentEvents = await getRecentEvents(userId, 10);
  const memories = await getRelevantMemories(userId, { limit: 5 });
  const profile = await getOrCreateUserOperatingProfile(userId);
  const todayRange = getLocalTodayRange(new Date(), await getUserTimezone(userId));
  const todayEvents = await getEventsBetween(userId, todayRange.start, todayRange.end);
  const todaySummary = buildDailyReview({
    userId,
    activeGoals,
    todayEvents,
    activeMemories: memories
  }).summary;

  return {
    activeGoals,
    recentEvents,
    memories,
    profile,
    todaySummary
  };
}

export async function composeFinalAgentResponse(
  result: ProcessMessageResult,
  options: { extractedEvents?: StoredEvent[] } = {}
): Promise<AgentResponse> {
  const context = await buildAgentContext(result.userId);
  const input: AgentResponseComposerInput = {
    userId: result.userId,
    message: result.message,
    intent: result.intent,
    mode: result.mode,
    riskState: result.riskState,
    extractedEvents: options.extractedEvents,
    activeGoals: context.activeGoals,
    recentEvents: context.recentEvents,
    memories: context.memories,
    profile: context.profile,
    todaySummary: context.todaySummary
  };
  const fallback = composeAgentResponse(input);

  if (!shouldUseOpenAIAnalysis() || result.riskState === "RED" || fallback.mode === "support") {
    return fallback;
  }

  try {
    return await composeResponseWithOpenAI(input, fallback);
  } catch (error) {
    console.warn("OpenAI response composer failed; using deterministic reply.", error);
    return fallback;
  }
}

export function withMemoryContextReply(result: ProcessMessageResult, activeMemories: MemoryEntry[]): ProcessMessageResult {
  if (result.mode !== "guardian") {
    return result;
  }

  const riskMemory = activeMemories.find((memory) => memory.type === "risk_pattern");

  if (!riskMemory) {
    return result;
  }

  return {
    ...result,
    reply: `${result.reply} Memory signal: ${riskMemory.summary}`
  };
}
