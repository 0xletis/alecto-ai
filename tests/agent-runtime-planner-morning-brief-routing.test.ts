import assert from "node:assert/strict";
import test from "node:test";
import { buildSystemPrompt } from "../apps/api/src/agent-runtime/planner.ts";

/**
 * Guards the exact routing bug a real Telegram smoke test surfaced: "setup morning brief at
 * 01:35"-style requests must plan proactive.settings_propose_update (V3's proactive morning
 * brief), never daily_loop.settings_propose_update (the legacy daily-loop start-day message) —
 * see docs/10-v3-readiness-audit.md §18. Real LLM tool selection isn't deterministically testable
 * in this suite (every other planner test mocks the LLM response entirely), so this is the
 * closest available guard: assert the planner's own system prompt states the ownership rule
 * unambiguously, and no longer offers a "morning brief" phrase as a daily_loop.* example.
 */

test("planner prompt states plain 'morning brief' language always routes to proactive.*, never daily_loop.*", () => {
  const prompt = buildSystemPrompt();

  assert.match(
    prompt,
    /plain 'morning brief' language ALWAYS means the V3 proactive morning brief.*never the legacy daily loop/i,
    "the planner prompt must state the ownership rule explicitly, not just imply it via separate examples"
  );
  assert.match(prompt, /setup morning brief at 01:35/i, "the exact real-world phrasing that broke routing must be a named proactive.* example");
});

test("planner prompt no longer offers a 'morning brief' phrase as a daily_loop.* routing example", () => {
  const prompt = buildSystemPrompt();
  const dailyLoopLine = prompt.split("\n").find((line) => line.includes("daily_loop.settings_propose_update with only the field"));

  assert.ok(dailyLoopLine, "expected to find the daily_loop.settings_propose_update guidance line");
  assert.doesNotMatch(dailyLoopLine!, /morning brief/i, "the daily_loop.* routing examples must use explicit daily-loop language, never 'morning brief', which now always means V3's proactive moment");
});

test("proactive.settings_propose_update guidance still covers the combined enable+time phrasing", () => {
  const prompt = buildSystemPrompt();

  assert.match(prompt, /set up a morning brief at 9am/i);
  assert.match(prompt, /BOTH the enabled flag \(true\) AND the matching time field/i);
});
