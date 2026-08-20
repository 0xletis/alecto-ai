import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createGoal } from "../packages/db/src/index.ts";
import { buildServer, prisma, seedUser, sendAgentMessage } from "./helpers/agent-runtime-test-helpers.ts";
import {
  assertDoesNotMentionGoal,
  assertEvidenceCountedForGoal,
  assertMentionsGoal,
  assertNoBannedPhrases,
  assertNoEvidenceForGoal,
  EvalTrace,
  llmEvalTestOptions
} from "./helpers/llm-eval-helpers.ts";

/**
 * Optional real-LLM multi-turn transcript eval harness (docs/10-v3-readiness-audit.md §23) — the
 * direct answer to "current deterministic/mocked tests did not catch this." Every other test file
 * in this repo mocks AGENT_RUNTIME_PLANNER_MOCK_RESPONSE / AGENT_RUNTIME_GUARDRAIL_MOCK_RESPONSE,
 * which proves the EXECUTOR/VALIDATOR handle a given tool call correctly but can never catch the
 * real LLM choosing the wrong tool call, the wrong goalRef, or misreading a progress report as a
 * lapse in the first place — exactly the two failure modes the real Telegram smoke test that
 * prompted this pass actually hit. These scenarios run the REAL planner and REAL guardrail
 * classifier (no mocks at all) through the exact same POST /agent/message path every other test
 * uses, against a freshly seeded, isolated user, and assert on both the reply's PROPERTIES
 * (no banned wording, mentions the right goal) and real DB state (an actual, correctly-linked
 * StoredEvent) — never an exact-text snapshot, since real LLM wording varies turn to turn.
 *
 * OFF BY DEFAULT: every scenario below is registered with node:test's `skip` option unless
 * RUN_LLM_EVALS=true AND OPENAI_API_KEY are both set (see llmEvalTestOptions) — `pnpm test`'s
 * `tests/*.test.ts` glob picks up this FILE, but each test inside it no-ops (reports "skipped",
 * not "passed" or "failed") rather than running, so the normal suite stays fast, free, and
 * deterministic. Run for real with `pnpm test:llm`, or
 * `RUN_LLM_EVALS=true pnpm test tests/agent-runtime-llm-eval.test.ts` directly (both need a real
 * OPENAI_API_KEY in the environment — there is no mocked path for these, by design).
 *
 * A failing scenario writes a full transcript trace (every turn's message/reply/planned+executed
 * operations/debug info) to tests/.llm-eval-traces/ (gitignored) — see EvalTrace in
 * llm-eval-helpers.ts — since a bare assertion failure alone rarely explains why a real LLM did
 * what it did.
 */

const EVAL_TIMEOUT_MS = 120_000;

test(
  "A. reading goal focus: a partial progress report after showing tracking for a specific goal counts against THAT goal, never the newest one, and is never called avoidance",
  { ...llmEvalTestOptions, timeout: EVAL_TIMEOUT_MS },
  async () => {
    const server = buildServer();
    const userId = `llm-eval-a-${randomUUID()}`;
    const trace = new EvalTrace("A-reading-goal-focus");

    try {
      await seedUser(userId);

      await trace.guard(async () => {
        const t1 = trace.record("I want to finish reading Meditations by Marcus Aurelius", await sendAgentMessage(server, userId, "I want to finish reading Meditations by Marcus Aurelius"));
        assert.equal(t1.needsConfirmation, true, "a new-goal proposal must ask for confirmation, never create immediately");
        trace.record("yes", await sendAgentMessage(server, userId, "yes"));

        const meditations = await prisma.goal.findFirst({ where: { userId, title: { contains: "Meditations", mode: "insensitive" } } });
        assert.ok(meditations, "the Meditations goal must have been created");

        const t3 = trace.record("I want to finish reading my Nietzsche book too", await sendAgentMessage(server, userId, "I want to finish reading my Nietzsche book too"));
        assert.equal(t3.needsConfirmation, true);
        trace.record("yes", await sendAgentMessage(server, userId, "yes"));

        const nietzsche = await prisma.goal.findFirst({ where: { userId, title: { contains: "Nietzsche", mode: "insensitive" } } });
        assert.ok(nietzsche, "the Nietzsche goal must have been created");

        // Establishes conversational focus on Nietzsche specifically, with the exact typo from
        // the real reported transcript.
        const t5 = trace.record("show tracking for reading niezsche book", await sendAgentMessage(server, userId, "show tracking for reading niezsche book"));
        assertMentionsGoal(t5.reply, nietzsche!.title, "turn 5 (tracking_show)");

        const t6 = trace.record("i didnt finish it but i read 30min today", await sendAgentMessage(server, userId, "i didnt finish it but i read 30min today"));
        assertNoBannedPhrases(t6.reply, [], "turn 6 (partial progress report)");

        const t7 = trace.record("how is my nitzche book goal going", await sendAgentMessage(server, userId, "how is my nitzche book goal going"));
        assertNoBannedPhrases(t7.reply, [], "turn 7 (status)");
        assertMentionsGoal(t7.reply, nietzsche!.title, "turn 7 (status)");

        await assertEvidenceCountedForGoal(userId, nietzsche!, 1);
        await assertNoEvidenceForGoal(userId, meditations!);
      });
    } finally {
      await server.close();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  }
);

test("B. tea goal: a full create -> confirm -> log -> status flow for a genuinely custom goal", { ...llmEvalTestOptions, timeout: EVAL_TIMEOUT_MS }, async () => {
  const server = buildServer();
  const userId = `llm-eval-b-${randomUUID()}`;
  const trace = new EvalTrace("B-tea-goal");

  try {
    await seedUser(userId);

    await trace.guard(async () => {
      const t1 = trace.record("I want to drink more tea", await sendAgentMessage(server, userId, "I want to drink more tea"));
      assert.equal(t1.needsConfirmation, true);
      trace.record("yes", await sendAgentMessage(server, userId, "yes"));

      const tea = await prisma.goal.findFirst({ where: { userId, title: { contains: "tea", mode: "insensitive" } } });
      assert.ok(tea, "the tea goal must have been created");
      const metrics = (tea!.targetMetrics as Array<{ signalKey?: string; eventType?: string }> | null) ?? [];
      assert.ok(
        metrics.some((metric) => Boolean(metric.signalKey) || Boolean(metric.eventType)),
        "the tea goal must declare at least one real trackable signal"
      );

      trace.record("had 2 teas today", await sendAgentMessage(server, userId, "had 2 teas today"));

      const t4 = trace.record("how is tea goal going", await sendAgentMessage(server, userId, "how is tea goal going"));
      assertMentionsGoal(t4.reply, tea!.title, "turn 4 (status)");

      await assertEvidenceCountedForGoal(userId, tea!, 2);
    });
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test(
  "C. ambiguous reading reference: a generic 'reading goal' request with two candidates asks or explicitly chooses, never a silent wrong pick",
  { ...llmEvalTestOptions, timeout: EVAL_TIMEOUT_MS },
  async () => {
    const server = buildServer();
    const userId = `llm-eval-c-${randomUUID()}`;
    const trace = new EvalTrace("C-ambiguous-reading");

    try {
      await seedUser(userId);
      const readMore = await createGoal(userId, { title: "Read more", category: "learning", templateId: "learning.reading_more" });
      const nietzsche = await createGoal(userId, {
        title: "Finish reading Nietzsche book",
        category: "reading",
        targetMetrics: [{ key: "book_nietzsche_finished", label: "Nietzsche book finished", signalKey: "book_nietzsche_finished", aggregation: "count", window: "weekly" }]
      });
      if (readMore.duplicate || nietzsche.duplicate) throw new Error("unexpected duplicate goal in eval setup");

      await trace.guard(async () => {
        const reply = trace.record("show reading goal", await sendAgentMessage(server, userId, "show reading goal"));

        const mentionsReadMore = reply.reply.toLowerCase().includes("read more");
        const mentionsNietzsche = reply.reply.toLowerCase().includes("nietzsche");
        const asksClarification = reply.reply.includes("?");

        assert.ok(
          asksClarification || mentionsReadMore || mentionsNietzsche,
          `must either ask which goal or explicitly name one of the two real goals — got: ${reply.reply}`
        );
        assert.ok(
          !(mentionsReadMore && mentionsNietzsche && !asksClarification),
          "naming both without a clarifying question reads as silently merging them rather than choosing"
        );
      });
    } finally {
      await server.close();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  }
);

test("D. job goal: existing job-search goal correctly counts applications sent", { ...llmEvalTestOptions, timeout: EVAL_TIMEOUT_MS }, async () => {
  const server = buildServer();
  const userId = `llm-eval-d-${randomUUID()}`;
  const trace = new EvalTrace("D-job-goal");

  try {
    await seedUser(userId);
    const jobSearch = await createGoal(userId, { title: "Find a new developer job", category: "career", templateId: "career.job_search" });
    if (jobSearch.duplicate) throw new Error("unexpected duplicate goal in eval setup");

    await trace.guard(async () => {
      trace.record("sent 5 CVs today", await sendAgentMessage(server, userId, "sent 5 CVs today"));

      const reply = trace.record("how is my job search going", await sendAgentMessage(server, userId, "how is my job search going"));
      assertMentionsGoal(reply.reply, jobSearch.goal.title, "turn 2 (status)");
      assertDoesNotMentionGoal(reply.reply, "no active goals", "turn 2 (status)");

      await assertEvidenceCountedForGoal(userId, jobSearch.goal, 5);
    });
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
