import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { countEvidenceForMetric } from "../../packages/core/src/goal-evidence.ts";
import type { Goal } from "../../packages/core/src/goals.ts";
import { getEventsSince, prisma } from "../../packages/db/src/index.ts";
import type { AgentMessageResponseJson } from "./agent-runtime-test-helpers.ts";

/**
 * Support for the optional real-LLM transcript eval harness (tests/agent-runtime-llm-eval.test.ts,
 * docs/10-v3-readiness-audit.md §23). Deliberately separate from agent-runtime-test-helpers.ts:
 * that module supports the FAST, deterministic, mocked-planner suite that runs on every `pnpm
 * test`; nothing here is imported by it, and nothing in it needs OPENAI_API_KEY or network access.
 *
 * Why scoring helpers instead of exact-text snapshots: a real LLM's wording varies turn to turn
 * even for the same scenario, so a snapshot would be flaky by construction. These assert on the
 * PROPERTIES that actually matter — a banned word never appears, the right goal is named, real DB
 * evidence exists and is linked to the right signal — never on an exact sentence.
 */

/**
 * `pnpm test`/`pnpm test:llm` run plain `tsx --test`, which — unlike `apps/api/src/index.ts`'s
 * own `dotenv.config()` call at process startup — never reads the repo's root `.env` file. A key
 * placed only in `.env` (not actually exported in the shell) was therefore invisible to this file
 * even with `RUN_LLM_EVALS=true` set, producing a confusing "OPENAI_API_KEY is missing" skip
 * despite the key genuinely being configured. No `dotenv` dependency needed for this: a minimal,
 * repo-root-relative parser, run once at import time before OPENAI_KEY_PRESENT below is computed.
 * Never overrides a variable already present in the environment (an explicit shell export or CI
 * secret always wins over the `.env` file).
 */
function loadDotEnvIfPresent(): void {
  const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "../..");
  const envPath = path.join(repoRoot, ".env");
  if (!existsSync(envPath)) {
    return;
  }

  for (const rawLine of readFileSync(envPath, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const eqIndex = line.indexOf("=");
    if (eqIndex === -1) {
      continue;
    }
    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (key && !(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadDotEnvIfPresent();

export const OPENAI_KEY_PRESENT = Boolean(process.env.OPENAI_API_KEY);
export const LLM_EVALS_REQUESTED = process.env.RUN_LLM_EVALS === "true";
export const LLM_EVALS_ENABLED = LLM_EVALS_REQUESTED && OPENAI_KEY_PRESENT;

/** Pass as the second arg to node:test's test() to make a scenario a no-op skip (not a failure)
 * whenever the eval harness isn't opted into for this run — see docs for the exact commands. */
export const llmEvalTestOptions: { skip?: string } = LLM_EVALS_ENABLED
  ? {}
  : {
      skip: LLM_EVALS_REQUESTED
        ? "RUN_LLM_EVALS=true was set but OPENAI_API_KEY is missing — real-LLM evals need a real key, there is no mocked path for them"
        : "set RUN_LLM_EVALS=true (and OPENAI_API_KEY) to run this — see docs/10-v3-readiness-audit.md §23, or `pnpm test:llm`"
    };

interface EvalTurnRecord {
  turn: number;
  message: string;
  reply: string;
  operationsPlanned: AgentMessageResponseJson["operationsPlanned"];
  operationsExecuted: AgentMessageResponseJson["operationsExecuted"];
  debug: AgentMessageResponseJson["debug"];
}

/**
 * Accumulates a scenario's turns as they happen and, only if the scenario's own assertions later
 * throw, dumps the full transcript to tests/.llm-eval-traces/ (gitignored) for local debugging —
 * exactly what a real LLM actually planned/replied/executed each turn, not just which assertion
 * failed. A passing scenario writes nothing.
 */
export class EvalTrace {
  private readonly turns: EvalTurnRecord[] = [];

  constructor(private readonly scenarioName: string) {}

  record(message: string, response: AgentMessageResponseJson): AgentMessageResponseJson {
    this.turns.push({
      turn: this.turns.length + 1,
      message,
      reply: response.reply,
      operationsPlanned: response.operationsPlanned,
      operationsExecuted: response.operationsExecuted,
      debug: response.debug
    });
    return response;
  }

  /** Wrap a scenario's assertion phase in this — on failure, writes the trace file and rethrows
   * the original error (with the trace file path appended) so the test still fails normally. */
  async guard<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      const file = this.dump(error);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}\n\nFull transcript trace written to: ${file}`);
    }
  }

  private dump(error: unknown): string {
    const dir = path.join(process.cwd(), "tests", ".llm-eval-traces");
    mkdirSync(dir, { recursive: true });
    const safeName = this.scenarioName.replace(/[^a-z0-9-]+/gi, "_").slice(0, 60);
    const file = path.join(dir, `${safeName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
    writeFileSync(
      file,
      JSON.stringify(
        {
          scenario: this.scenarioName,
          failedWith: error instanceof Error ? error.message : String(error),
          turns: this.turns
        },
        null,
        2
      )
    );
    return file;
  }
}

const DEFAULT_BANNED_PHRASES = ["avoidance", "lapse"];

/** Fails if the reply contains any banned phrase (case-insensitive substring) — the default list
 * covers the exact wrong-classification words the reported bug produced; pass `extra` for
 * scenario-specific ones (e.g. a wrong goal's title). */
export function assertNoBannedPhrases(reply: string, extra: string[] = [], context = ""): void {
  const lower = reply.toLowerCase();
  for (const phrase of [...DEFAULT_BANNED_PHRASES, ...extra]) {
    assert.ok(!lower.includes(phrase.toLowerCase()), `${context ? `${context}: ` : ""}reply must not contain "${phrase}" — got: ${reply}`);
  }
}

export function assertMentionsGoal(reply: string, goalTitle: string, context = ""): void {
  assert.ok(reply.toLowerCase().includes(goalTitle.toLowerCase()), `${context ? `${context}: ` : ""}reply must mention "${goalTitle}" — got: ${reply}`);
}

export function assertDoesNotMentionGoal(reply: string, goalTitle: string, context = ""): void {
  assert.ok(!reply.toLowerCase().includes(goalTitle.toLowerCase()), `${context ? `${context}: ` : ""}reply must NOT mention "${goalTitle}" — got: ${reply}`);
}

/** Ground-truth DB check: real recent events exist that goal.status's own countEvidenceForMetric
 * would count toward this goal, at or above `minCount` — never trusts the reply text alone, since
 * the whole point of this suite is catching a confident-sounding reply that isn't backed by real,
 * linked evidence. */
export async function assertEvidenceCountedForGoal(userId: string, goal: Pick<Goal, "id" | "targetMetrics">, minCount = 1): Promise<void> {
  const freshGoal = await prisma.goal.findUnique({ where: { id: goal.id } });
  assert.ok(freshGoal, `goal ${goal.id} must still exist`);
  const metrics = (freshGoal!.targetMetrics as Goal["targetMetrics"]) ?? [];
  assert.ok(metrics.length > 0, `goal "${freshGoal!.title}" must have at least one declared metric to count evidence against`);

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const events = await getEventsSince(userId, since);
  const total = metrics.reduce((sum, metric) => sum + countEvidenceForMetric(metric, events), 0);

  assert.ok(total >= minCount, `expected at least ${minCount} counted evidence for "${freshGoal!.title}", got ${total}`);
}

/** The inverse check — a goal must show ZERO evidence logged in the last day, proving a message
 * that was never about it left it untouched (used to prove a wrong-goal mixup did NOT happen). */
export async function assertNoEvidenceForGoal(userId: string, goal: Pick<Goal, "id" | "targetMetrics">): Promise<void> {
  const freshGoal = await prisma.goal.findUnique({ where: { id: goal.id } });
  assert.ok(freshGoal, `goal ${goal.id} must still exist`);
  const metrics = (freshGoal!.targetMetrics as Goal["targetMetrics"]) ?? [];
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const events = await getEventsSince(userId, since);
  const total = metrics.reduce((sum, metric) => sum + countEvidenceForMetric(metric, events), 0);

  assert.equal(total, 0, `goal "${freshGoal!.title}" must have zero evidence — this message was never about it`);
}
