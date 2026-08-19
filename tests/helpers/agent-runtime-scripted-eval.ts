import assert from "node:assert/strict";
import {
  buildServer,
  clearAgentRuntimeMocks,
  getAgentSession,
  mockPlan,
  sendAgentMessage,
  type AgentMessageResponseJson,
  type AgentSessionRow,
  type MockPlan
} from "./agent-runtime-test-helpers.ts";

/**
 * Lightweight scripted multi-turn conversation harness for Agent Runtime v3 — NOT a general
 * eval framework. Runs a fixed sequence of user messages through the exact same
 * POST /agent/message route Telegram uses (see sendAgentMessage), capturing enough of each
 * turn's pipeline for a scenario to assert on. Built to catch the class of bug unit tests on
 * an individual tool missed but a real multi-turn Telegram conversation found (see
 * docs/09-architecture-inventory.md's "Next-Week Planning Hotfix" and its follow-up): a
 * turn-by-turn test can pass while the STATE CARRIED BETWEEN turns is still wrong.
 *
 * A ScriptedTurn's `plan` field is a plain, JSON-serializable object (MockPlan) — a whole
 * ScriptedScenario can be defined as a plain TypeScript object literal, or read from a JSON
 * fixture file and given only its `turns` (the `assert`/`assertAll` callbacks, being
 * functions, are attached separately in the test file, not stored in the JSON itself).
 *
 * Deterministic / CI-safe by default: every turn in this module's own scenarios sets an
 * explicit `plan`, so nothing depends on network access or OPENAI_API_KEY. Passing a turn
 * with no `plan` at all lets the REAL planner run instead — the LLM if OPENAI_API_KEY is
 * set, otherwise the deterministic heuristic fallback (planner.ts's heuristicPlan) — useful
 * for an optional local run against the real model, not for CI.
 */

export interface ScriptedTurn {
  /** The user's message text for this turn. */
  message: string;
  /**
   * Mocked planner output for this turn. Omit for:
   * - an exact confirm/cancel whitelist turn ("yes", "cancel", etc.), which never calls the
   *   planner at all and so needs no mock, or
   * - a turn that should exercise the REAL planner (LLM or heuristic fallback) instead of a
   *   fixture — only meaningful outside CI, when OPENAI_API_KEY is set.
   */
  plan?: MockPlan;
  /** Optional per-turn assertions, run immediately after this turn completes. */
  assert?: (turn: CapturedTurn) => void;
}

export interface ScriptedScenario {
  name: string;
  turns: ScriptedTurn[];
  /** Optional assertions over the full captured transcript, run after every turn completes. */
  assertAll?: (turns: CapturedTurn[]) => void;
}

/**
 * Everything captured about one executed turn. Fields are "if available" per-domain: every
 * tool populates plannedOperation/executedOperation/toolValidationPassed (generic, from the
 * normal /agent/message response); pendingOperation/visibleEntities before/after are read
 * directly from the session row for every turn regardless of domain; planningTrace is
 * populated only for planning.* turns and only when AGENT_RUNTIME_PLANNING_TRACE=true.
 */
export interface CapturedTurn {
  index: number;
  message: string;
  reply: string;
  response: AgentMessageResponseJson;
  plannedOperation: { tool: string; args: Record<string, unknown> } | null;
  executedOperation: { tool: string; status: string; summary: string; error?: string } | null;
  toolValidationPassed: boolean;
  mutationExecuted: boolean;
  planningTrace: unknown;
  pendingOperationBefore: unknown;
  pendingOperationAfter: unknown;
  visibleEntitiesBefore: unknown[];
  visibleEntitiesAfter: unknown[];
}

/**
 * Runs one scripted scenario turn by turn against a real (test) server + Postgres session
 * row, mocking the planner per-turn where a fixture is given, and returns the full captured
 * transcript. Also runs each turn's own `assert` and the scenario's `assertAll` as it goes,
 * so a failure points at the exact turn/message that broke, not just "the scenario failed".
 */
export async function runScriptedScenario(
  server: ReturnType<typeof buildServer>,
  userId: string,
  scenario: ScriptedScenario,
  channel = "telegram"
): Promise<CapturedTurn[]> {
  const captured: CapturedTurn[] = [];

  for (let index = 0; index < scenario.turns.length; index++) {
    const turn = scenario.turns[index];
    const before = await getAgentSession(userId, channel);

    clearAgentRuntimeMocks();
    if (turn.plan) {
      mockPlan(turn.plan);
    }

    const response = await sendAgentMessage(server, userId, turn.message, channel);
    const after = await getAgentSession(userId, channel);

    const capturedTurn: CapturedTurn = {
      index,
      message: turn.message,
      reply: response.reply,
      response,
      plannedOperation: response.operationsPlanned?.[0] ?? null,
      executedOperation: response.operationsExecuted?.[0] ?? null,
      toolValidationPassed: response.debug?.toolValidationPassed ?? false,
      mutationExecuted: response.debug?.mutationExecuted ?? false,
      planningTrace: response.debug?.planningTrace ?? null,
      pendingOperationBefore: before?.pendingOperation ?? null,
      pendingOperationAfter: after?.pendingOperation ?? null,
      visibleEntitiesBefore: asArray(before?.visibleEntities),
      visibleEntitiesAfter: asArray(after?.visibleEntities)
    };

    captured.push(capturedTurn);

    try {
      turn.assert?.(capturedTurn);
    } catch (error) {
      throw new Error(`Scenario "${scenario.name}", turn ${index} ("${turn.message}"): ${(error as Error).message}`, { cause: error });
    }
  }

  scenario.assertAll?.(captured);

  return captured;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// --- Small, reusable assertion helpers matching the invariants a scripted scenario most
// commonly needs to check. Scenario-specific checks (exact reply wording, specific DB rows)
// are expected to stay as direct node:assert calls in the scenario's own turn.assert /
// assertAll — these only cover the generic, cross-domain invariants worth naming once.

/** The Telegram-layer generic dev-safe error text must never leak into a normal turn's reply. */
export function assertNoGenericError(turn: CapturedTurn): void {
  assert.doesNotMatch(turn.reply, /agent v3 hit an error/i, `turn "${turn.message}": must not surface the generic v3 error reply`);
}

const DEFAULT_SUCCESS_CLAIM_PHRASES = [
  /i've (moved|created|changed|updated|removed|added|archived|snoozed|completed)/i,
  /your plan will now reflect/i,
  /done\. i created/i
];

/**
 * If no mutation actually executed this turn, the reply must not contain a success-claiming
 * phrase — the exact shape of the real bug where a rejected planning edit's reply still said
 * "I've moved the job application to Friday" (the planner's own pre-execution replyDraft
 * leaking through). Pass extra phrases for a domain-specific claim not in the default list.
 */
export function assertNoFalseSuccessClaim(turn: CapturedTurn, extraPhrases: RegExp[] = []): void {
  if (turn.mutationExecuted) {
    return;
  }
  for (const phrase of [...DEFAULT_SUCCESS_CLAIM_PHRASES, ...extraPhrases]) {
    assert.doesNotMatch(turn.reply, phrase, `turn "${turn.message}": claims a change happened but no mutation executed this turn`);
  }
}

/** Nothing was written to the DB this turn — used for "no mutation before confirmation" checks. */
export function assertNoMutationYet(turn: CapturedTurn): void {
  assert.equal(turn.mutationExecuted, false, `turn "${turn.message}": expected no DB mutation yet`);
}

interface PlanSelection {
  index: number;
  title: string;
}

interface VisibleEntity {
  index?: number;
  label: string;
}

/**
 * Planning-specific invariant: the pending draft's own selections and the session's visible
 * entities must represent the exact same items, matched by index. A no-op (nothing to
 * check) for any turn whose pendingOperation isn't a next-week-plan draft — most notably
 * action-hygiene turns, whose visibleEntities are never backed by a pendingOperation at all.
 */
export function assertPlanningDraftInSync(turn: CapturedTurn, when: "before" | "after" = "after"): void {
  const pendingOperation = when === "after" ? turn.pendingOperationAfter : turn.pendingOperationBefore;
  const visibleEntities = (when === "after" ? turn.visibleEntitiesAfter : turn.visibleEntitiesBefore) as VisibleEntity[];
  const selections = extractPlanSelections(pendingOperation);

  if (!selections) {
    return;
  }

  assert.equal(
    visibleEntities.length,
    selections.length,
    `turn "${turn.message}": visibleEntities count must match the pending draft's item count (${when})`
  );
  for (const selection of selections) {
    const entity = visibleEntities.find((candidate) => candidate.index === selection.index);
    assert.ok(entity, `turn "${turn.message}": visibleEntities missing draft index ${selection.index} (${when})`);
    assert.equal(
      entity?.label,
      selection.title,
      `turn "${turn.message}": visibleEntities label for index ${selection.index} must match the draft item's title (${when})`
    );
  }
}

function extractPlanSelections(pendingOperation: unknown): PlanSelection[] | undefined {
  const operations = (pendingOperation as { operations?: Array<{ args?: { selections?: unknown } }> } | null)?.operations;
  const selections = operations?.[0]?.args?.selections;
  return Array.isArray(selections) ? (selections as PlanSelection[]) : undefined;
}

/** pendingOperation and visibleEntities are exactly as they were before this turn — used for rejected/no-op turns. */
export function assertPendingStateUnchanged(turn: CapturedTurn): void {
  assert.deepEqual(turn.pendingOperationAfter, turn.pendingOperationBefore, `turn "${turn.message}": pendingOperation must be unchanged`);
  assert.deepEqual(turn.visibleEntitiesAfter, turn.visibleEntitiesBefore, `turn "${turn.message}": visibleEntities must be unchanged`);
}

export type { AgentSessionRow, MockPlan };
export { buildServer, sendAgentMessage };
