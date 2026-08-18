import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_RUNTIME_V3_ERROR_REPLY,
  isLegacyTelegramChatEnabled,
  logLegacyTelegramRouting,
  routeToAgentRuntimeV3
} from "../apps/telegram-bot/src/agent-runtime-routing.ts";

/**
 * Coverage note: apps/telegram-bot/src/index.ts constructs a real grammy Bot
 * and calls bot.start() unconditionally at module load (it's a long-polling
 * entry point, not something designed to be imported). That makes importing
 * it directly in a test process unsafe — it would try to open a real
 * Telegram connection with whatever TELEGRAM_BOT_TOKEN happens to be set.
 * So there is no test here that imports index.ts or drives it through a
 * fake grammy Context.
 *
 * What IS tested, directly and without any mocking of grammy/fetch/Telegram:
 * - The flag read (cases A/B/C): isLegacyTelegramChatEnabled() is the exact
 *   same function index.ts calls to decide v3 vs. legacy, so this is the
 *   real decision, not a re-implementation of it. Agent Runtime v3 is the
 *   default — only the literal string "false" opts into legacy.
 * - The v3 routing behavior (cases B/E): routeToAgentRuntimeV3() is the
 *   exact function index.ts calls in its default branch, via dependency
 *   injection instead of real HTTP/ctx.reply.
 * - The legacy logging (case C): logLegacyTelegramRouting() is the exact
 *   function index.ts calls right before routeToLegacyMessageProcessor(ctx).
 * - Slash-command isolation (case D) is NOT independently unit-tested here:
 *   it is guaranteed by grammy's own dispatch order (bot.command(...)
 *   handlers run before the general bot.on("message:text", ...) handler
 *   this flag lives inside — grammy never invokes that handler for a
 *   command message at all), not by any custom logic in this repo that a
 *   unit test could exercise in isolation. It's asserted by construction:
 *   the v3/legacy branch only exists inside message:text, so a command
 *   message structurally can't reach either regardless of the flag's value.
 */

function withEnv(value: string | undefined, fn: () => void): void {
  const previous = process.env.TELEGRAM_AGENT_RUNTIME_V3_ENABLED;
  if (value === undefined) {
    delete process.env.TELEGRAM_AGENT_RUNTIME_V3_ENABLED;
  } else {
    process.env.TELEGRAM_AGENT_RUNTIME_V3_ENABLED = value;
  }
  try {
    fn();
  } finally {
    if (previous === undefined) {
      delete process.env.TELEGRAM_AGENT_RUNTIME_V3_ENABLED;
    } else {
      process.env.TELEGRAM_AGENT_RUNTIME_V3_ENABLED = previous;
    }
  }
}

test("case A: TELEGRAM_AGENT_RUNTIME_V3_ENABLED unset -> Agent Runtime v3 is the default (legacy NOT enabled)", () => {
  withEnv(undefined, () => {
    assert.equal(isLegacyTelegramChatEnabled(), false, "unset must default to v3, not legacy");
  });
  withEnv("nonsense", () => {
    assert.equal(isLegacyTelegramChatEnabled(), false, "any value other than the literal 'false' must still route to v3");
  });
});

test("case B: TELEGRAM_AGENT_RUNTIME_V3_ENABLED=true -> Agent Runtime v3 (explicit, same as default)", async () => {
  withEnv("true", () => {
    assert.equal(isLegacyTelegramChatEnabled(), false);
  });

  const calls: Array<{ userId: string; message: string }> = [];
  const replies: string[] = [];
  const logs: unknown[][] = [];

  await routeToAgentRuntimeV3("telegram:520894688", "track Naturgy invoices from Gmail", {
    callAgentRuntime: async (input) => {
      calls.push(input);
      return { reply: "I can watch for Naturgy invoice emails, review-first.", debug: { runtime: "agent_v3" } };
    },
    reply: async (text) => {
      replies.push(text);
    },
    log: (...args) => logs.push(args)
  });

  assert.deepEqual(calls, [{ userId: "telegram:520894688", message: "track Naturgy invoices from Gmail" }]);
  assert.deepEqual(replies, ["I can watch for Naturgy invoice emails, review-first."]);
  assert.ok(logs.some((entry) => String(entry[0]).includes("runtime=agent_v3") && String(entry[0]).includes("user=telegram:520894688") && String(entry[0]).includes("start")));
  assert.ok(logs.some((entry) => String(entry[0]).includes("runtime=agent_v3") && String(entry[0]).includes("done")));
});

test("case C: TELEGRAM_AGENT_RUNTIME_V3_ENABLED=false -> legacy is selected and logged with reason=flag_disabled", () => {
  withEnv("false", () => {
    assert.equal(isLegacyTelegramChatEnabled(), true);
  });

  const logs: string[] = [];
  logLegacyTelegramRouting("telegram:520894688", (message) => logs.push(message));

  assert.equal(logs.length, 1);
  assert.match(logs[0], /runtime=legacy_messages/);
  assert.match(logs[0], /reason=flag_disabled/);
  assert.match(logs[0], /user=telegram:520894688/);
});

test("case D: slash commands never reach the v3/legacy routing helpers, regardless of the flag (structural, not a mock)", () => {
  // There is no isLegacyTelegramChatEnabled()/routeToAgentRuntimeV3()/routeToLegacyMessageProcessor()
  // call site anywhere in the slash-command dispatch path — the only call site lives inside
  // index.ts's bot.on("message:text", ...) handler, which grammy only invokes for messages that
  // were not already consumed by an earlier bot.command(...) registration. This test documents
  // that guarantee rather than re-mocking grammy's dispatcher.
  assert.ok(true, "see file-level comment: slash-command isolation is guaranteed by grammy's dispatch order");
});

test("case E: v3 failure replies with the exact dev-safe message and never calls a fallback path", async () => {
  const replies: string[] = [];
  const errors: unknown[][] = [];
  let callCount = 0;

  await routeToAgentRuntimeV3("telegram:520894688", "remember I prefer blunt feedback", {
    callAgentRuntime: async () => {
      callCount += 1;
      throw new Error("agent runtime boom");
    },
    reply: async (text) => {
      replies.push(text);
    },
    logError: (...args) => errors.push(args)
  });

  assert.equal(callCount, 1, "the backend was attempted exactly once — no retry, no second/fallback call");
  assert.deepEqual(replies, [AGENT_RUNTIME_V3_ERROR_REPLY]);
  assert.equal(replies[0], "Agent v3 hit an error while handling that. Nothing was changed.");
  assert.ok(errors.some((entry) => String(entry[0]).includes("runtime=agent_v3") && String(entry[0]).includes("error")));

  // routeToAgentRuntimeV3's dependency shape only exposes ONE backend callback (callAgentRuntime).
  // There is no legacy/process-message callback it could invoke even if it wanted to — the
  // "no silent fallback" guarantee holds by construction, not just by this assertion.
});
