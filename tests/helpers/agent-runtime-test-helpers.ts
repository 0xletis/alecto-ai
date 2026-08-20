import assert from "node:assert/strict";
import { prisma } from "../../packages/db/src/index.ts";
import { buildServer } from "../../apps/api/src/server.ts";

/**
 * Minimal, generic Agent Runtime v3 test primitives — extracted out of the
 * near-identical copies that had accumulated in tests/agent-message.test.ts,
 * tests/agent-runtime-action-hygiene.test.ts, and
 * tests/agent-runtime-next-week-planning.test.ts (each defined its own
 * MockPlan/op/mockPlan/clearMocks/send/seedUser). Nothing here is
 * domain-specific (planning, hygiene, Gmail, memory all use the same shape),
 * so new scripted scenarios and existing per-domain test files can both
 * build on this instead of re-copying the boilerplate again.
 *
 * Deliberately does not change any existing test file to import from here —
 * this is additive only, for the new scripted-eval harness
 * (tests/helpers/agent-runtime-scripted-eval.ts) to build on.
 */

export interface MockPlan {
  topic: string;
  intent: string;
  operations: Array<{ tool: string; args: unknown; rationale?: string | null }>;
  needsClarification: boolean;
  clarificationQuestion: string | null;
  replyDraft: string;
}

export function op(tool: string, args: unknown = {}, rationale: string | null = null): MockPlan["operations"][number] {
  return { tool, args, rationale };
}

/** Sets the mocked planner response for the NEXT turn only (AGENT_RUNTIME_PLANNER_MOCK_RESPONSE is read once per call to planMessage). */
export function mockPlan(plan: MockPlan): void {
  process.env.AGENT_RUNTIME_PLANNER_MOCK_RESPONSE = JSON.stringify(plan);
}

export interface MockGuardrailClassification {
  conflict: "none" | "soft_warn" | "hard_block" | "ask_clarification";
  goalId: string | null;
  pattern: "active_violation" | "avoidance" | "lapse_admission" | null;
  clarifyingQuestion: string | null;
  reason: string;
}

/**
 * Sets the mocked goal-guardrail LLM classification for the NEXT call to checkGoalGuardrail's
 * Tier 2 (AGENT_RUNTIME_GUARDRAIL_MOCK_RESPONSE is read once per call to classifyGoalConflict).
 * Only reached when the turn's message doesn't match a literal knownTriggers/knownFailureModes
 * phrase AND the user has at least one active goal — see goal-guardrails.ts.
 */
export function mockGuardrail(classification: MockGuardrailClassification): void {
  process.env.AGENT_RUNTIME_GUARDRAIL_MOCK_RESPONSE = JSON.stringify(classification);
}

/**
 * Clears every Agent Runtime v3 test-only env hook. Safe to call before a turn that should
 * hit the real planner (LLM if OPENAI_API_KEY is set, deterministic heuristic fallback
 * otherwise) or the exact confirm/cancel whitelist (which never calls the planner at all).
 */
export function clearAgentRuntimeMocks(): void {
  delete process.env.AGENT_RUNTIME_PLANNER_MOCK_RESPONSE;
  delete process.env.AGENT_RUNTIME_PLANNER_MOCK_THROW;
  delete process.env.AGENT_RUNTIME_FORCE_ERROR;
  delete process.env.AGENT_RUNTIME_PLANNING_TRACE;
  delete process.env.AGENT_RUNTIME_GUARDRAIL_MOCK_RESPONSE;
}

export async function seedUser(userId: string): Promise<void> {
  await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
}

/**
 * Posts to POST /agent/message — the exact same HTTP route
 * apps/telegram-bot/src/agent-runtime-routing.ts calls for real Telegram traffic — rather
 * than calling handleAgentMessage() directly, so a scripted scenario exercises the same
 * request path Telegram actually uses (route registration, body parsing, etc.), not just
 * the runtime function underneath it.
 */
export async function sendAgentMessage(
  server: ReturnType<typeof buildServer>,
  userId: string,
  message: string,
  channel = "telegram"
): Promise<AgentMessageResponseJson> {
  const response = await server.inject({
    method: "POST",
    url: "/agent/message",
    payload: { userId, message, channel }
  });
  assert.equal(response.statusCode, 200, `POST /agent/message for "${message}" returned ${response.statusCode}: ${response.body}`);
  return response.json();
}

export interface AgentMessageResponseJson {
  reply: string;
  operationsPlanned: Array<{ tool: string; args: Record<string, unknown> }>;
  operationsExecuted: Array<{ tool: string; status: string; summary: string; error?: string }>;
  needsConfirmation: boolean;
  debug: {
    runtime: string;
    plannerUsed: string;
    llmPlannerAttempted: boolean;
    llmPlannerUsed: boolean;
    toolValidationPassed: boolean;
    mutationExecuted: boolean;
    conversationTopic: string | null;
    pendingOperation: boolean;
    legacyPendingActionDetected: boolean;
    planningTrace?: unknown;
  };
}

export interface AgentSessionRow {
  pendingOperation: unknown;
  visibleEntities: unknown;
  focusedEntities: unknown;
}

export async function getAgentSession(userId: string, channel = "telegram"): Promise<AgentSessionRow | null> {
  return prisma.agentConversationSession.findUnique({ where: { userId_channel: { userId, channel } } });
}

export { buildServer, prisma };
