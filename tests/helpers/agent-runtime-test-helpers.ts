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

/**
 * Shared smoke-transcript assertions — pulled out of several near-duplicate copies (each test
 * file previously defined its own assertNoGenericAgentError) so new V3 transcript-shaped tests
 * have one place to import guard-rail-style assertions from, rather than re-copying them again.
 * Each one targets a specific, previously-real regression rather than being a generic sanity
 * check, so a failure here should point straight at which bug class came back.
 */

/** The top-level safety-net reply (processAgentMessage's catch-all) must never leak for an
 * ordinary, well-formed turn — its presence means something crashed instead of being handled. */
export function assertNoGenericAgentError(reply: AgentMessageResponseJson, context?: string): void {
  assert.notEqual(reply.reply, "I hit an unexpected problem there — please try again.", context);
  assert.doesNotMatch(reply.reply, /unexpected problem/i, context);
}

/** A clear operational/domain command (Gmail autonomy, sync, review triage, action completion,
 * etc.) must never be intercepted by the goal-avoidance guardrail — regression: "check gmail
 * every hour" was classified as avoidance of an unrelated active reading goal. */
export function assertNoAvoidanceWhenOperationalCommand(reply: AgentMessageResponseJson, context?: string): void {
  assert.doesNotMatch(reply.reply, /avoidance|conflicts with your goal|pulling you away from your goal/i, context);
  assert.notEqual(reply.debug.conversationTopic, "guardrail", context);
}

/** A read-only Gmail status/schedule question ("when do you check Gmail?") must never trigger a
 * real gmail.sync — regression: it ran a real 45-50s sync and created EmailReviewItems for what
 * was only ever a status question. */
export function assertNoUnexpectedGmailSyncForStatus(reply: AgentMessageResponseJson, context?: string): void {
  const tools = reply.operationsPlanned.map((operation) => operation.tool);
  assert.ok(!tools.includes("gmail.sync"), `${context ? `${context}: ` : ""}must not call gmail.sync for a status query — planned: ${tools.join(", ") || "(none)"}`);
  assert.doesNotMatch(reply.reply, /messages checked/i, context);
}

/** composeReply's groundTruthOnly/informationalSummaries branches must never show the same tool
 * summary line twice — regression: a compound turn executing a ground-truth-only tool AND a
 * separately-informational tool in the same turn could double-count or silently drop one half. */
export function assertNoDuplicateToolSummary(reply: AgentMessageResponseJson, context?: string): void {
  const lines = reply.reply
    .split(/\n\n+/)
    .map((line) => line.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  for (const line of lines) {
    assert.ok(!seen.has(line), `${context ? `${context}: ` : ""}duplicate summary line: "${line}"`);
    seen.add(line);
  }
}

/** Whenever a turn ends in a clarification question (or an intentionally ambiguous reference),
 * nothing may have actually mutated — a clarification is only honest if nothing was silently
 * decided on the user's behalf while asking. */
export function assertNoMutationWhenClarificationExpected(reply: AgentMessageResponseJson, context?: string): void {
  assert.equal(reply.debug.mutationExecuted, false, context);
  assert.ok(
    reply.operationsExecuted.every((operation) => operation.status !== "executed"),
    `${context ? `${context}: ` : ""}an operation executed despite an expected clarification`
  );
}

/** For a compound turn (one message containing several explicit intents), the reply must mention
 * EVERY expected category — never silently drop one because a shortcut/planner only handled part
 * of the request. Each fragment may be a literal substring (case-insensitive) or a RegExp for a
 * looser match; all must be present somewhere in the reply, in any order. */
export function assertCompoundReplyAccountsFor(reply: AgentMessageResponseJson, expectedFragments: Array<string | RegExp>, context?: string): void {
  for (const fragment of expectedFragments) {
    if (typeof fragment === "string") {
      assert.ok(
        reply.reply.toLowerCase().includes(fragment.toLowerCase()),
        `${context ? `${context}: ` : ""}reply must mention "${fragment}" — got: "${reply.reply}"`
      );
    } else {
      assert.match(reply.reply, fragment, context);
    }
  }
}

/** A compound request naming N explicit operations must plan at least N operations — never fewer,
 * which would mean part of the request was silently dropped rather than executed, proposed, or
 * explicitly deferred to a clarification question. */
export function assertNoSilentPartialHandling(reply: AgentMessageResponseJson, expectedOperationCount: number, context?: string): void {
  assert.ok(
    reply.operationsPlanned.length >= expectedOperationCount,
    `${context ? `${context}: ` : ""}expected at least ${expectedOperationCount} operations for this compound request, got ${reply.operationsPlanned.length} (${reply.operationsPlanned.map((operation) => operation.tool).join(", ") || "none"})`
  );
}

/** The reply must actually be clarification-shaped (a real question, not a bare statement) AND
 * nothing may have mutated — combines assertNoMutationWhenClarificationExpected's mutation check
 * with a sanity check that the reply text itself reads like a question, not a silent guess. */
export function assertClarificationResponse(reply: AgentMessageResponseJson, context?: string): void {
  assertNoMutationWhenClarificationExpected(reply, context);
  assert.match(reply.reply, /\?/, `${context ? `${context}: ` : ""}expected a clarification-shaped reply (containing a question) — got: "${reply.reply}"`);
}

/** No ActionItem of any kind (task, reminder, etc.) may exist for this user — for an ambiguous
 * request that should have asked a question instead of guessing which task/review to act on. */
export async function assertNoActionItemsCreated(userId: string, context?: string): Promise<void> {
  const count = await prisma.actionItem.count({ where: { userId } });
  assert.equal(count, 0, `${context ? `${context}: ` : ""}expected no ActionItems to exist, found ${count}`);
}

/** Every given Gmail review id must still be "pending" — for an ambiguous or explicitly
 * deferred ("keep them") request that must never silently reject/approve a review. */
export async function assertEmailReviewsRemainPending(reviewIds: string[], context?: string): Promise<void> {
  const reviews = await prisma.emailReviewItem.findMany({ where: { id: { in: reviewIds } } });
  assert.equal(reviews.length, reviewIds.length, `${context ? `${context}: ` : ""}expected to find all ${reviewIds.length} seeded reviews`);
  for (const review of reviews) {
    assert.equal(review.status, "pending", `${context ? `${context}: ` : ""}review ${review.id} must remain pending, got "${review.status}"`);
  }
}

/**
 * Env-gated, human-readable one-liner for a single transcript turn — complements (never
 * replaces) the structured `[agent-runtime-diagnostics]` JSON lines runtime.ts's own
 * logAgentRuntimeDiagnostics already emits (matched domain shortcut, whether the guardrail was
 * reached or skipped, raw planner ops, reconciled ops, mutation tools) whenever
 * AGENT_RUNTIME_DIAGNOSTICS=true. This just makes a whole multi-turn transcript easy to scan at a
 * glance in test output; it prints nothing at all when the env var isn't set, so it never adds
 * noise to a normal test run.
 */
export function logTranscriptStep(label: string, message: string, reply: AgentMessageResponseJson): void {
  if (process.env.AGENT_RUNTIME_DIAGNOSTICS !== "true") {
    return;
  }
  const tools = reply.operationsPlanned.map((operation) => operation.tool).join(", ") || "(none)";
  console.log(
    `[smoke-transcript] ${label}: "${message}" -> tools=[${tools}] mutation=${reply.debug.mutationExecuted} topic=${reply.debug.conversationTopic ?? "null"} plannerUsed=${reply.debug.plannerUsed}`
  );
}

export { buildServer, prisma };
