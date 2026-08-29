import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createActionItem, createGoal, prisma } from "../packages/db/src/index.ts";
import {
  buildDeterministicProactiveBriefResponse,
  ProactiveBriefValidationError,
  validateProactiveBriefResponseAgainstContext,
  type ProactiveBriefContext
} from "../packages/core/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, mockPlan, op, sendAgentMessage, seedUser } from "./helpers/agent-runtime-test-helpers.ts";
import { buildProactiveBriefContext } from "../apps/api/src/operator/proactive-brief-llm.ts";
import type { ProactiveMessageProposal } from "../apps/api/src/operator/proactive.ts";
import type { ContextBundle } from "../apps/api/src/agent-runtime/types.ts";

/**
 * fix/private-alpha-proactive-brief-llm-personalization (Tasks 4, 5, 6, 7): the LLM composition
 * layer that can rewrite a proactive morning/evening brief's `message` — using
 * PROACTIVE_BRIEF_LLM_MOCK_RESPONSE/PROACTIVE_BRIEF_LLM_MOCK_THROW (packages/llm/src/proactive-
 * brief.ts's own mock hooks, mirroring daily-coach.ts's established pattern) so this suite never
 * makes a real OpenAI call. Real-model tone/quality behavior (goal-specific adaptation, actual
 * quote generation) is covered by the LLM eval scenarios instead — this file proves the SAFETY
 * properties: the LLM is actually reachable, failures fall back safely, nothing mutates, and raw
 * email content never reaches the prompt.
 */

function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    previous[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  return fn().finally(() => {
    for (const key of Object.keys(previous)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
}

async function setupLifeMeaningTester(userId: string, style: "motivational" | "reflection" = "motivational") {
  const server = buildServer();
  await seedUser(userId);
  const goalResult = await createGoal(userId, { title: "Find meaning and purpose in life", category: "personal development" });
  if (goalResult.duplicate) throw new Error("unexpected duplicate goal in eval setup");

  mockPlan({
    topic: "proactive_brief_preference",
    intent: "update",
    operations: [op("proactive.brief_preference_apply_update", { style, contentRequest: style === "motivational" ? "motivational quotes" : "a reflection prompt" })],
    needsClarification: false,
    clarificationQuestion: null,
    replyDraft: ""
  });
  await sendAgentMessage(server, userId, style === "motivational" ? "send me motivational quotes every morning" : "give me a reflection prompt every morning");
  clearAgentRuntimeMocks();

  return { server, goal: goalResult.goal };
}

function injectApiGet(server: ReturnType<typeof buildServer>) {
  return async <T>(path: string): Promise<T> => {
    const response = await server.inject({ method: "GET", url: path });
    if (response.statusCode !== 200) throw new Error(`GET ${path} failed with ${response.statusCode}: ${response.body}`);
    return response.json() as T;
  };
}

const MORNING_UTC = "2026-08-20T07:00:00.000Z"; // 09:00 Europe/Madrid — matches the default morningTimeMinutes (540)

test("4A/6B. the LLM path is actually called during morning brief generation and its message is used", async () => {
  const userId = `llm-brief-called-${randomUUID()}`;

  await withEnv({ PROACTIVE_BRIEF_LLM_ENABLED: "true", OPENAI_API_KEY: "test-key", PROACTIVE_BRIEF_LLM_MOCK_RESPONSE: JSON.stringify({ message: "Morning. For your goal — Find meaning and purpose in life — today's line is: meaning gets clearer through action, not waiting for certainty.\n\nSmall prompt: write one sentence about what would make today feel slightly more worth living." }) }, async () => {
    const { server } = await setupLifeMeaningTester(userId);
    try {
      const response = await server.inject({ method: "GET", url: `/users/${userId}/operator/proactive/preview?now=${encodeURIComponent(MORNING_UTC)}` });
      assert.equal(response.statusCode, 200);
      const body = response.json();

      assert.equal(body.personalization.source, "llm");
      assert.match(body.decision.message, /today's line is: meaning gets clearer through action/i);
      assert.match(body.decision.message, /small prompt/i);
    } finally {
      await server.close();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });
});

test("4B/4E. LLM failure falls back to the safe deterministic message, never an empty or broken send", async () => {
  const userId = `llm-brief-fallback-${randomUUID()}`;

  await withEnv({ PROACTIVE_BRIEF_LLM_ENABLED: "true", OPENAI_API_KEY: "test-key", PROACTIVE_BRIEF_LLM_MOCK_THROW: "true" }, async () => {
    const { server } = await setupLifeMeaningTester(userId);
    try {
      const response = await server.inject({ method: "GET", url: `/users/${userId}/operator/proactive/preview?now=${encodeURIComponent(MORNING_UTC)}` });
      const body = response.json();

      assert.equal(body.personalization.source, "fallback_error");
      assert.equal(body.decision.decision, "proposed_message");
      assert.ok(body.decision.message.length > 0, "the deterministic fallback message must still be real, non-empty content");
    } finally {
      await server.close();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });
});

test("E (4E). deterministic fallback remains available and IS the response when the LLM is disabled", async () => {
  const userId = `llm-brief-disabled-${randomUUID()}`;
  const { server } = await setupLifeMeaningTester(userId);

  try {
    const response = await server.inject({ method: "GET", url: `/users/${userId}/operator/proactive/preview?now=${encodeURIComponent(MORNING_UTC)}` });
    const body = response.json();

    assert.equal(body.personalization.source, "fallback_disabled");
    assert.match(body.decision.message, /find meaning and purpose in life/i);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("C (4C). generating a personalized brief never mutates the DB — no action/event/goal created as a side effect", async () => {
  const userId = `llm-brief-no-mutation-${randomUUID()}`;

  await withEnv({ PROACTIVE_BRIEF_LLM_ENABLED: "true", OPENAI_API_KEY: "test-key", PROACTIVE_BRIEF_LLM_MOCK_RESPONSE: JSON.stringify({ message: "Morning. Today's line: small, steady steps count. What's one thing worth doing today?" }) }, async () => {
    const { server } = await setupLifeMeaningTester(userId);
    try {
      await server.inject({ method: "GET", url: `/users/${userId}/operator/proactive/preview?now=${encodeURIComponent(MORNING_UTC)}` });

      const actions = await prisma.actionItem.findMany({ where: { userId } });
      const events = await prisma.event.findMany({ where: { userId } });
      const goals = await prisma.goal.findMany({ where: { userId } });

      assert.equal(actions.length, 0);
      assert.equal(events.length, 0);
      assert.equal(goals.length, 1, "only the ONE goal the user actually created — nothing new fabricated by generation");
    } finally {
      await server.close();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });
});

test("D (4D). the LLM context never includes raw Gmail subject/snippet content — only the pre-summarized count", async () => {
  const goal = { id: "goal-1", title: "Apply to remote jobs", category: "career", why: undefined, priority: "medium", importanceScore: 0, priorityReason: "", targetMetrics: [], checkInConfig: [], createdAt: new Date(), updatedAt: new Date(), archivedAt: null, status: "active" as const, templateId: null };
  const decision: ProactiveMessageProposal = {
    decision: "proposed_message",
    type: "morning_brief",
    title: "Morning brief",
    message: "Morning. 1 Gmail item needs review before I log it.",
    reasons: [],
    suggestedReplies: [],
    dedupeKey: "v3_morning_brief",
    priority: 1,
    safeToSend: true
  };
  const sensitiveSubject = "CONFIDENTIAL-SSN-000-11-2222 password reset link inside";
  const fakeContext = {
    user: { id: "telegram:900001" },
    activeGoals: [goal],
    openActions: [],
    gmailReviews: [{ id: "r1", subject: sensitiveSubject, from: "someone@example.com", snippet: sensitiveSubject } as any],
    operatingProfile: { directness: 3, warmth: 3, confrontation: 3, verbosity: 3, motivationalStyle: "balanced" }
  } as unknown as ContextBundle;

  const built = buildProactiveBriefContext(decision, fakeContext, { timezone: "Europe/Madrid" } as any, new Date("2026-08-20T07:00:00.000Z"), "morning", goal as any, undefined);

  assert.deepEqual(built.gmailSignalLines, ["1 Gmail review pending."]);
  assert.ok(!JSON.stringify(built).includes(sensitiveSubject), "raw Gmail subject/snippet content must never reach the LLM context");
});

test("5A/5B. validateProactiveBriefResponseAgainstContext rejects a fake attributed quote but allows an original, unattributed line", () => {
  const baseContext: ProactiveBriefContext = {
    briefType: "morning",
    date: "2026-08-20",
    timezone: "Europe/Madrid",
    goal: { id: "g1", title: "Find meaning and purpose in life", category: "personal development" },
    otherActiveGoalTitles: [],
    openActionTitles: [],
    overdueActionLines: [],
    recentWins: [],
    gmailSignalLines: [],
    deterministicFallbackMessage: "Morning. Active goal: \"Find meaning and purpose in life\". Nothing scheduled for today yet — what do you want to focus on?"
  };

  assert.throws(
    () => validateProactiveBriefResponseAgainstContext({ message: '"He who has a why to live can bear almost any how." — Nietzsche' }, baseContext),
    (error: unknown) => error instanceof ProactiveBriefValidationError && error.failureCodes.includes("fake_quote_attribution")
  );

  assert.throws(
    () => validateProactiveBriefResponseAgainstContext({ message: '"Some inspiring line here." - J. Smith' }, baseContext),
    (error: unknown) => error instanceof ProactiveBriefValidationError && error.failureCodes.includes("fake_quote_attribution")
  );

  const original = validateProactiveBriefResponseAgainstContext(
    { message: "Morning. For your goal — Find meaning and purpose in life — today's line is: meaning gets clearer through action, not waiting for certainty." },
    baseContext
  );
  assert.equal(original.message.includes("today's line"), true);
});

test("5D. a long quoted span is rejected regardless of attribution — guards against reproducing a real copyrighted quote verbatim", () => {
  const baseContext: ProactiveBriefContext = {
    briefType: "morning",
    date: "2026-08-20",
    timezone: "Europe/Madrid",
    otherActiveGoalTitles: [],
    openActionTitles: [],
    overdueActionLines: [],
    recentWins: [],
    gmailSignalLines: [],
    deterministicFallbackMessage: "Morning."
  };
  const longQuote = `"${new Array(30).fill("word").join(" ")}"`;

  assert.throws(
    () => validateProactiveBriefResponseAgainstContext({ message: `Morning. ${longQuote}` }, baseContext),
    (error: unknown) => error instanceof ProactiveBriefValidationError && error.failureCodes.includes("long_quoted_span")
  );
});

test("goal leak: a response mentioning a DIFFERENT active goal's title is rejected", () => {
  const baseContext: ProactiveBriefContext = {
    briefType: "morning",
    date: "2026-08-20",
    timezone: "Europe/Madrid",
    goal: { id: "g1", title: "Find meaning and purpose in life", category: "personal development" },
    otherActiveGoalTitles: ["Apply to remote jobs"],
    openActionTitles: [],
    overdueActionLines: [],
    recentWins: [],
    gmailSignalLines: [],
    deterministicFallbackMessage: "Morning."
  };

  assert.throws(
    () => validateProactiveBriefResponseAgainstContext({ message: "Morning! Don't forget to Apply to remote jobs today too." }, baseContext),
    (error: unknown) => error instanceof ProactiveBriefValidationError && error.failureCodes.includes("goal_leak")
  );
});

test("silent mutation language is rejected", () => {
  const baseContext: ProactiveBriefContext = {
    briefType: "morning",
    date: "2026-08-20",
    timezone: "Europe/Madrid",
    otherActiveGoalTitles: [],
    openActionTitles: [],
    overdueActionLines: [],
    recentWins: [],
    gmailSignalLines: [],
    deterministicFallbackMessage: "Morning."
  };

  assert.throws(
    () => validateProactiveBriefResponseAgainstContext({ message: "Morning! I've created a new action for you to journal today." }, baseContext),
    (error: unknown) => error instanceof ProactiveBriefValidationError && error.failureCodes.includes("silent_mutation_language")
  );
});

test("buildDeterministicProactiveBriefResponse always returns the given fallback message unchanged", () => {
  const context: ProactiveBriefContext = {
    briefType: "morning",
    date: "2026-08-20",
    timezone: "Europe/Madrid",
    otherActiveGoalTitles: [],
    openActionTitles: [],
    overdueActionLines: [],
    recentWins: [],
    gmailSignalLines: [],
    deterministicFallbackMessage: "Morning. Active goal: \"Find meaning and purpose in life\". Nothing scheduled for today yet — what do you want to focus on?"
  };
  const response = buildDeterministicProactiveBriefResponse(context);
  assert.equal(response.message, context.deterministicFallbackMessage);
});

test("6. exact tester scenario end to end: goal, preference, and a real worker tick deliver a personalized, non-empty, action-free brief", async () => {
  await withEnv(
    {
      PROACTIVE_BRIEF_LLM_ENABLED: "true",
      OPENAI_API_KEY: "test-key",
      PROACTIVE_OPERATOR_DELIVERY_ENABLED: "true",
      PROACTIVE_BRIEF_LLM_MOCK_RESPONSE: JSON.stringify({
        message:
          "Morning. For your goal — Find meaning and purpose in life — today's line is: meaning gets clearer through action, not waiting for certainty.\n\nSmall prompt: write one sentence about what would make today feel slightly more worth living. Then do one 10-minute thing that supports that answer."
      })
    },
    async () => {
      const server = buildServer();
      const chatIdDigits = `900006${Date.now()}`;
      const fullUserId = `telegram:${chatIdDigits}`;

      try {
        await seedUser(fullUserId);
        const goalResult = await createGoal(fullUserId, { title: "Find meaning and purpose in life", category: "personal development" });
        if (goalResult.duplicate) throw new Error("unexpected duplicate goal in eval setup");

        mockPlan({
          topic: "proactive_brief_preference",
          intent: "update",
          operations: [op("proactive.brief_preference_apply_update", { style: "motivational", contentRequest: "motivational quotes" })],
          needsClarification: false,
          clarificationQuestion: null,
          replyDraft: ""
        });
        await sendAgentMessage(server, fullUserId, "can you send me motivational quotes every morning to help with this?");
        clearAgentRuntimeMocks();

        const settings = await prisma.notificationSettings.findUnique({ where: { userId: fullUserId } });
        assert.ok(settings?.morningBriefEnabled, "the preference request must also turn the morning brief on");

        const sent: Array<{ chatId: string; text: string }> = [];
        const { runV3ProactiveMorningBriefs } = await import("../apps/worker/src/v3-proactive-delivery.ts");
        const summary = await runV3ProactiveMorningBriefs([settings as any], {
          now: new Date(MORNING_UTC),
          deliveryEnabled: true,
          apiGet: injectApiGet(server),
          sendTelegramMessage: async (chatId, text) => void sent.push({ chatId, text })
        });

        assert.equal(summary.sent, 1);
        assert.equal(sent.length, 1);
        assert.equal(sent[0]!.chatId, chatIdDigits);
        assert.match(sent[0]!.text, /find meaning and purpose in life/i);
        assert.match(sent[0]!.text, /today's line is/i);
        assert.doesNotMatch(sent[0]!.text, /^nothing scheduled/i);
        assert.doesNotMatch(sent[0]!.text, /i've created|i've logged|i've added/i);

        const actions = await prisma.actionItem.findMany({ where: { userId: fullUserId } });
        assert.equal(actions.length, 0, "no action was silently created");
      } finally {
        await server.close();
        await prisma.user.deleteMany({ where: { id: fullUserId } });
      }
    }
  );
});
