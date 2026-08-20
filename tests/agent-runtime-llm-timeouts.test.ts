import assert from "node:assert/strict";
import test from "node:test";
import { withPlannerTimeout } from "../apps/api/src/agent-runtime/planner.ts";
import { withGuardrailTimeout } from "../apps/api/src/agent-runtime/goal-guardrails.ts";

/**
 * A real incident: an invalid OPENAI_API_KEY caused the planner's (and the goal-guardrail's)
 * OpenAI call to hang indefinitely — neither ever wrapped its client.responses.create call in a
 * timeout, so a stuck/misconfigured API call left the whole /agent/message request, and the
 * Telegram reply waiting on it, hanging forever with no response at all (not even the "hit an
 * error" fallback, since nothing ever rejected). Fixed by wrapping both calls in a
 * Promise.race-based timeout, mirroring the pre-existing withDailyCoachTimeout pattern in
 * apps/api/src/operator/attention.ts. These tests exercise the timeout wrappers directly with an
 * artificial slow promise — fast, deterministic, no real network or DB involved.
 */

function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    previous[key] = process.env[key];
    if (vars[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = vars[key];
    }
  }
  return fn().finally(() => {
    for (const key of Object.keys(previous)) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  });
}

function neverResolves<T>(): Promise<T> {
  return new Promise(() => {});
}

test("withPlannerTimeout rejects a hung call instead of waiting forever", async () => {
  await withEnv({ AGENT_RUNTIME_PLANNER_TIMEOUT_MS: "50" }, async () => {
    await assert.rejects(withPlannerTimeout(neverResolves()), /timed out/i);
  });
});

test("withPlannerTimeout resolves normally when the call finishes before the timeout", async () => {
  await withEnv({ AGENT_RUNTIME_PLANNER_TIMEOUT_MS: "5000" }, async () => {
    const result = await withPlannerTimeout(Promise.resolve("fast"));
    assert.equal(result, "fast");
  });
});

test("withGuardrailTimeout rejects a hung call instead of waiting forever", async () => {
  await withEnv({ AGENT_RUNTIME_GUARDRAIL_TIMEOUT_MS: "50" }, async () => {
    await assert.rejects(withGuardrailTimeout(neverResolves()), /timed out/i);
  });
});

test("withGuardrailTimeout resolves normally when the call finishes before the timeout", async () => {
  await withEnv({ AGENT_RUNTIME_GUARDRAIL_TIMEOUT_MS: "5000" }, async () => {
    const result = await withGuardrailTimeout(Promise.resolve("fast"));
    assert.equal(result, "fast");
  });
});
