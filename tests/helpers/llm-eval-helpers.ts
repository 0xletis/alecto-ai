import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { countEvidenceForMetric } from "../../packages/core/src/goal-evidence.ts";
import type { Goal } from "../../packages/core/src/goals.ts";
import { getEventsSince, prisma } from "../../packages/db/src/index.ts";
import type { AgentMessageResponseJson } from "./agent-runtime-test-helpers.ts";

/**
 * Support for the optional real-LLM product-conversation QA harness
 * (tests/agent-runtime-llm-eval.test.ts, docs/10-v3-readiness-audit.md §24). Deliberately separate
 * from agent-runtime-test-helpers.ts: that module supports the FAST, deterministic, mocked-planner
 * suite that runs on every `pnpm test`; nothing here is imported by it, and nothing in it needs
 * OPENAI_API_KEY or network access. This harness is a QA tool run manually before major commits —
 * never part of CI/default `pnpm test` — see llmEvalOptions below for exactly how it opts out.
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

/**
 * Optional scenario filter — `LLM_EVAL_TAGS=onboarding,gmail pnpm test:llm` runs only scenarios
 * carrying at least one of those tags, everything else reports "skipped" (not run, not failed).
 * Unset (the default) runs every scenario. See docs for the full tag list per scenario.
 */
const REQUESTED_TAGS = process.env.LLM_EVAL_TAGS
  ? process.env.LLM_EVAL_TAGS.split(",")
      .map((tag) => tag.trim())
      .filter(Boolean)
  : null;

/** Pass as the second arg to node:test's test() to make a scenario a no-op skip (not a failure)
 * whenever the eval harness isn't opted into for this run, or this scenario's tags don't match
 * an active LLM_EVAL_TAGS filter — see docs for the exact commands. */
export function llmEvalOptions(tags: string[] = []): { skip?: string } {
  if (!LLM_EVALS_ENABLED) {
    return {
      skip: LLM_EVALS_REQUESTED
        ? "RUN_LLM_EVALS=true was set but OPENAI_API_KEY is missing — real-LLM evals need a real key, there is no mocked path for them"
        : "set RUN_LLM_EVALS=true (and OPENAI_API_KEY) to run this — see docs/10-v3-readiness-audit.md §24, or `pnpm test:llm`"
    };
  }
  if (REQUESTED_TAGS && !tags.some((tag) => REQUESTED_TAGS.includes(tag))) {
    return { skip: `filtered out by LLM_EVAL_TAGS=${REQUESTED_TAGS.join(",")} (this scenario is tagged: ${tags.join(", ") || "none"})` };
  }
  return {};
}

interface EvalTurnRecord {
  turn: number;
  message: string;
  reply: string;
  /** True when this turn's reply came from planner.ts's heuristicPlan (the real LLM call failed)
   * rather than genuine reasoning — labeled here so a trace makes an unexpected degraded-mode turn
   * obvious at a glance, without that alone failing the scenario (see EvalTrace.record below). */
  usedFallback: boolean;
  operationsPlanned: AgentMessageResponseJson["operationsPlanned"];
  operationsExecuted: AgentMessageResponseJson["operationsExecuted"];
  debug: AgentMessageResponseJson["debug"];
}

/**
 * Mirrors planner.ts's degradedFallbackReply's own banned list — a real Telegram smoke test found
 * fallback-mode wording ("...without my language model available") leaking straight into a user's
 * chat. This harness must catch that itself, not only trust the deterministic suite that already
 * regression-tests it (tests/agent-runtime-fallback-degraded-mode.test.ts) — a real end-to-end
 * scenario is exactly the kind of place a future rewrite could reintroduce it unnoticed.
 */
const BANNED_FALLBACK_WORDING = ["language model available", "fallback planner", "heuristic planner", "openai failed", "openai"];

function findLeakedFallbackWording(reply: string): string | undefined {
  const lower = reply.toLowerCase();
  return BANNED_FALLBACK_WORDING.find((phrase) => lower.includes(phrase));
}

interface EvalCheckpointRecord {
  description: string;
  passed: boolean;
  detail?: string;
}

/** A compact snapshot of everything this eval harness can assert against, for a failing
 * scenario's trace dump — "what did the DB actually end up looking like," independent of whatever
 * specific assertion happened to throw first. */
interface DbStateSummary {
  goals: Array<{ id: string; title: string; category: string; status: string; targetMetrics: unknown }>;
  actions: Array<{ id: string; title: string; status: string; priority: string; goalId: string | null; dueAt: string | null }>;
  recentEvents: Array<{ type: string; data: unknown; timestamp: string }>;
  gmailReviews: Array<{ id: string; subject: string | null; status: string; ruleId: string }>;
  notificationSettings: { morningBriefEnabled: boolean; eveningCheckinEnabled: boolean; gmailNudgeEnabled: boolean } | null;
}

async function captureDbStateSummary(userId: string): Promise<DbStateSummary> {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const [goals, actions, recentEvents, gmailReviews, notificationSettings] = await Promise.all([
    prisma.goal.findMany({ where: { userId } }),
    prisma.actionItem.findMany({ where: { userId } }),
    getEventsSince(userId, since),
    prisma.emailReviewItem.findMany({ where: { userId } }),
    prisma.notificationSettings.findUnique({ where: { userId } })
  ]);

  return {
    goals: goals.map((goal) => ({ id: goal.id, title: goal.title, category: goal.category, status: goal.status, targetMetrics: goal.targetMetrics })),
    actions: actions.map((action) => ({
      id: action.id,
      title: action.title,
      status: action.status,
      priority: action.priority,
      goalId: action.goalId,
      dueAt: action.dueAt ? action.dueAt.toISOString() : null
    })),
    recentEvents: recentEvents.map((event) => ({ type: event.type, data: event.data, timestamp: event.timestamp.toISOString() })),
    gmailReviews: gmailReviews.map((review) => ({ id: review.id, subject: review.subject, status: review.status, ruleId: review.ruleId })),
    notificationSettings: notificationSettings
      ? {
          morningBriefEnabled: notificationSettings.morningBriefEnabled,
          eveningCheckinEnabled: notificationSettings.eveningCheckinEnabled,
          gmailNudgeEnabled: notificationSettings.gmailNudgeEnabled
        }
      : null
  };
}

/**
 * Accumulates a scenario's turns, checkpoint assertions, and tags as they happen and, only if the
 * scenario's own assertions later throw, dumps ALL of it — the full message/reply/planned+executed
 * transcript, every checkpoint attempted (not just the one that finally failed), and a final DB
 * state snapshot — to tests/.llm-eval-traces/ (gitignored), for local debugging. A passing
 * scenario writes nothing. `userId` is optional only for scenarios that never touch the DB.
 */
export class EvalTrace {
  private readonly turns: EvalTurnRecord[] = [];
  private readonly checkpoints: EvalCheckpointRecord[] = [];

  constructor(
    private readonly scenarioName: string,
    private readonly tags: string[] = [],
    private readonly userId?: string
  ) {}

  record(message: string, response: AgentMessageResponseJson): AgentMessageResponseJson {
    const usedFallback = response.debug.plannerUsed === "fallback";
    const turnNumber = this.turns.length + 1;

    this.turns.push({
      turn: turnNumber,
      message,
      reply: response.reply,
      usedFallback,
      operationsPlanned: response.operationsPlanned,
      operationsExecuted: response.operationsExecuted,
      debug: response.debug
    });

    if (usedFallback) {
      // Informational only — degraded mode on one turn doesn't fail a scenario by itself unless
      // that scenario specifically needs real reasoning to pass (its own assertions will fail
      // naturally in that case); this just makes it visible in the trace at a glance.
      this.checkpoint(`turn ${turnNumber}: degraded/fallback mode used`, true, response.reply);
    }

    // UNCONDITIONAL, on every turn regardless of usedFallback: internal fallback wording must
    // never reach the user. This is the one thing about fallback mode that always fails the
    // scenario, on every turn, automatically — no scenario has to opt in.
    const leaked = findLeakedFallbackWording(response.reply);
    this.checkpoint(`turn ${turnNumber}: no internal fallback wording leaked`, !leaked, leaked ? `found "${leaked}" in: ${response.reply}` : undefined);
    assert.ok(!leaked, `turn ${turnNumber} ("${message}") leaked internal fallback wording ("${leaked}") into the reply — got: ${response.reply}`);

    return response;
  }

  /** Logs one assertion attempt (pass or fail) into the trace without itself throwing — the
   * scoring helpers below call this, then still call node:assert so the test fails normally. */
  checkpoint(description: string, passed: boolean, detail?: string): void {
    this.checkpoints.push({ description, passed, detail });
  }

  /** Wrap a scenario's assertion phase in this — on failure, writes the trace file and rethrows
   * the original error (with the trace file path appended) so the test still fails normally. */
  async guard<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      const file = await this.dump(error);
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}\n\nFull transcript trace written to: ${file}`);
    }
  }

  private async dump(error: unknown): Promise<string> {
    const dir = path.join(process.cwd(), "tests", ".llm-eval-traces");
    mkdirSync(dir, { recursive: true });
    const safeName = this.scenarioName.replace(/[^a-z0-9-]+/gi, "_").slice(0, 60);
    const file = path.join(dir, `${safeName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
    const finalDbState = this.userId ? await captureDbStateSummary(this.userId).catch((dbError) => ({ error: String(dbError) })) : null;

    writeFileSync(
      file,
      JSON.stringify(
        {
          scenario: this.scenarioName,
          tags: this.tags,
          failedWith: error instanceof Error ? error.message : String(error),
          // Same resolution order planner.ts's own planWithLLM uses — not read from a live
          // response (the harness never sees the raw OpenAI response object), but this is the
          // exact model every turn in this scenario actually ran against, so it's accurate
          // whenever AGENT_RUNTIME_PLANNER_MODEL/OPENAI_MODEL are held constant for the run.
          config: {
            model: process.env.AGENT_RUNTIME_PLANNER_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini",
            guardrailModel: process.env.AGENT_RUNTIME_GUARDRAIL_MODEL ?? process.env.OPENAI_MODEL ?? "gpt-4o-mini",
            llmEvalTagsFilter: process.env.LLM_EVAL_TAGS ?? null
          },
          turns: this.turns,
          checkpoints: this.checkpoints,
          finalDbState
        },
        null,
        2
      )
    );
    return file;
  }
}

const DEFAULT_BANNED_PHRASES = ["avoidance", "lapse", "sabotage"];

/** Fails if the reply contains any banned phrase (case-insensitive substring) — the default list
 * covers the exact wrong-classification words reported bugs have produced; pass `extra` for
 * scenario-specific ones (e.g. a wrong goal's title). Records a checkpoint on `trace` when given. */
export function assertNoBannedPhrases(reply: string, extra: string[] = [], context = "", trace?: EvalTrace): void {
  const lower = reply.toLowerCase();
  for (const phrase of [...DEFAULT_BANNED_PHRASES, ...extra]) {
    const passed = !lower.includes(phrase.toLowerCase());
    trace?.checkpoint(`${context ? `${context}: ` : ""}reply excludes "${phrase}"`, passed, reply);
    assert.ok(passed, `${context ? `${context}: ` : ""}reply must not contain "${phrase}" — got: ${reply}`);
  }
}

export function assertMentionsGoal(reply: string, goalTitle: string, context = "", trace?: EvalTrace): void {
  const passed = reply.toLowerCase().includes(goalTitle.toLowerCase());
  trace?.checkpoint(`${context ? `${context}: ` : ""}reply mentions "${goalTitle}"`, passed, reply);
  assert.ok(passed, `${context ? `${context}: ` : ""}reply must mention "${goalTitle}" — got: ${reply}`);
}

export function assertDoesNotMentionGoal(reply: string, goalTitle: string, context = "", trace?: EvalTrace): void {
  const passed = !reply.toLowerCase().includes(goalTitle.toLowerCase());
  trace?.checkpoint(`${context ? `${context}: ` : ""}reply excludes "${goalTitle}"`, passed, reply);
  assert.ok(passed, `${context ? `${context}: ` : ""}reply must NOT mention "${goalTitle}" — got: ${reply}`);
}

/** Ground-truth DB check: real recent events exist that goal.status's own countEvidenceForMetric
 * would count toward this goal, at or above `minCount` — never trusts the reply text alone, since
 * the whole point of this suite is catching a confident-sounding reply that isn't backed by real,
 * linked evidence. */
export async function assertEvidenceCountedForGoal(userId: string, goal: Pick<Goal, "id" | "targetMetrics">, minCount = 1, trace?: EvalTrace): Promise<void> {
  const freshGoal = await prisma.goal.findUnique({ where: { id: goal.id } });
  assert.ok(freshGoal, `goal ${goal.id} must still exist`);
  const metrics = (freshGoal!.targetMetrics as Goal["targetMetrics"]) ?? [];
  assert.ok(metrics.length > 0, `goal "${freshGoal!.title}" must have at least one declared metric to count evidence against`);

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const events = await getEventsSince(userId, since);
  const total = metrics.reduce((sum, metric) => sum + countEvidenceForMetric(metric, events), 0);

  const passed = total >= minCount;
  trace?.checkpoint(`evidence counted for "${freshGoal!.title}" >= ${minCount}`, passed, `got ${total}`);
  assert.ok(passed, `expected at least ${minCount} counted evidence for "${freshGoal!.title}", got ${total}`);
}

/** Ground-truth DB check that an ActionItem was created from this user's recent activity and, if
 * `goalId` is given, that it's actually linked to that goal — never trusts "created task" wording
 * alone. Matches by title substring (case-insensitive) since the exact title is LLM-authored. */
export async function assertActionCreated(userId: string, titleContains: string, options: { goalId?: string } = {}, trace?: EvalTrace): Promise<void> {
  const actions = await prisma.actionItem.findMany({ where: { userId } });
  const match = actions.find((action) => action.title.toLowerCase().includes(titleContains.toLowerCase()));

  trace?.checkpoint(`an action containing "${titleContains}" exists`, Boolean(match), match ? match.title : "no match");
  assert.ok(match, `expected an action containing "${titleContains}" — real actions: ${actions.map((a) => a.title).join(", ") || "(none)"}`);

  if (options.goalId) {
    const linked = match!.goalId === options.goalId;
    trace?.checkpoint(`action "${match!.title}" linked to goal ${options.goalId}`, linked, `actual goalId: ${match!.goalId}`);
    assert.equal(match!.goalId, options.goalId, `expected the action to be linked to goal ${options.goalId}, got ${match!.goalId}`);
  }
}
