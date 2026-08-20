import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createGoal } from "../packages/db/src/index.ts";
import { buildServer, prisma, seedUser, sendAgentMessage } from "./helpers/agent-runtime-test-helpers.ts";
import {
  assertActionCreated,
  assertDoesNotMentionGoal,
  assertEvidenceCountedForGoal,
  assertMentionsGoal,
  assertNoBannedPhrases,
  EvalTrace,
  llmEvalOptions
} from "./helpers/llm-eval-helpers.ts";

/**
 * Optional real-LLM product-conversation QA harness (docs/10-v3-readiness-audit.md §24) — a
 * MANUAL tool run before major commits, never part of default `pnpm test`/CI. Every other test
 * file in this repo mocks AGENT_RUNTIME_PLANNER_MOCK_RESPONSE / AGENT_RUNTIME_GUARDRAIL_MOCK_
 * RESPONSE, which proves the EXECUTOR/VALIDATOR handle a given tool call correctly but can never
 * catch the real LLM choosing the wrong tool, the wrong goalRef/signal, or misreading a progress
 * report — confirmed twice now: real `pnpm test:llm` runs against these scenarios caught bugs
 * (a guardrail false positive on new-goal intent, an eventType/signalKey hedge bug, a missing-
 * signal fallback gap, a wrong-tool-choice gap) that the entire deterministic suite could not see,
 * each closed with BOTH a capability fix AND a deterministic regression test elsewhere in this
 * repo (see docs §22/§23's "Tests" sections) — this harness's job is to keep finding the next one.
 *
 * These 10 scenarios cover Alecto's highest-value user journeys end to end: onboarding, adaptive
 * goal creation (a generic custom goal and a book-shaped one), multi-goal reference resolution,
 * the job-search evidence loop, both Gmail flows (a template-linked domain and a fully generic
 * one), the guardrail-vs-progress-report boundary, proactive settings, and morning brief quality.
 * Each runs the REAL planner (and, where relevant, the REAL guardrail classifier — no mocks at
 * all) through the exact same POST /agent/message path every other test uses, against a freshly
 * seeded, isolated user, and asserts on REPLY PROPERTIES (no banned wording, mentions the right
 * goal) and real DB TRUTH (an actual, correctly-linked StoredEvent/ActionItem/NotificationSettings
 * row) — never an exact-text snapshot, since real LLM wording varies turn to turn.
 *
 * OFF BY DEFAULT: every scenario is registered via llmEvalOptions(tags), which returns node:test's
 * `skip` option unless RUN_LLM_EVALS=true AND OPENAI_API_KEY are both set — `pnpm test`'s
 * `tests/*.test.ts` glob picks up this FILE, but each test inside it no-ops (reports "skipped,"
 * never "passed" or "failed") rather than running, so the normal suite stays fast, free, and
 * deterministic (confirmed by this file's own presence in the "464 passed, N skipped" count
 * `pnpm test` reports). Run for real with `pnpm test:llm` (needs a real OPENAI_API_KEY — there is
 * no mocked path for these, by design, and each run costs real API tokens: expect ~10 real
 * OpenAI calls per scenario, roughly 5-15s and a small fraction of a cent each at gpt-4o-mini
 * pricing — run this before a major commit, not on every save). Narrow to a subset with
 * `LLM_EVAL_TAGS=onboarding,gmail pnpm test:llm` — see each scenario's tags below, or
 * docs/10-v3-readiness-audit.md §24 for the full tag reference.
 *
 * A failing scenario writes a full trace (every turn's message/reply/planned+executed operations,
 * every checkpoint attempted — not just the one that finally failed — and a final DB state
 * snapshot of goals/actions/events/Gmail reviews/notification settings) to
 * tests/.llm-eval-traces/ (gitignored) — see EvalTrace in llm-eval-helpers.ts.
 */

const EVAL_TIMEOUT_MS = 120_000;

type GmailOAuthEnvSnapshot = {
  GOOGLE_CLIENT_ID: string | undefined;
  GOOGLE_CLIENT_SECRET: string | undefined;
  GMAIL_REDIRECT_URI: string | undefined;
};

function installGmailOAuthEnv(): () => void {
  const previous: GmailOAuthEnvSnapshot = {
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    GMAIL_REDIRECT_URI: process.env.GMAIL_REDIRECT_URI
  };

  process.env.GOOGLE_CLIENT_ID = "test-gmail-client-id.apps.googleusercontent.com";
  process.env.GOOGLE_CLIENT_SECRET = "test-gmail-client-secret";
  process.env.GMAIL_REDIRECT_URI = "http://localhost:3000/oauth/gmail/callback";

  return () => {
    restoreEnv("GOOGLE_CLIENT_ID", previous.GOOGLE_CLIENT_ID);
    restoreEnv("GOOGLE_CLIENT_SECRET", previous.GOOGLE_CLIENT_SECRET);
    restoreEnv("GMAIL_REDIRECT_URI", previous.GMAIL_REDIRECT_URI);
  };
}

function restoreEnv(key: keyof GmailOAuthEnvSnapshot, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

test(
  "1. new user onboarding: an empty user asking what to do gets the goal-anchor nudge, never a fake goal",
  { ...llmEvalOptions(["onboarding"]), timeout: EVAL_TIMEOUT_MS },
  async () => {
    const server = buildServer();
    const userId = `llm-eval-onboarding-${randomUUID()}`;
    const trace = new EvalTrace("1-onboarding", ["onboarding"], userId);

    try {
      await seedUser(userId);

      await trace.guard(async () => {
        const t1 = trace.record("what should I do?", await sendAgentMessage(server, userId, "what should I do?"));

        const nudgeFired = /one real goal or guardrail/i.test(t1.reply);
        trace.checkpoint("goal-anchor nudge fired", nudgeFired, t1.reply);
        assert.ok(nudgeFired, `expected the goal-anchor nudge — got: ${t1.reply}`);
        assert.equal(t1.debug.llmPlannerAttempted, false, "the deterministic nudge must short-circuit before the planner ever runs");

        const goalCount = await prisma.goal.count({ where: { userId } });
        trace.checkpoint("no goal created", goalCount === 0, `goal count: ${goalCount}`);
        assert.equal(goalCount, 0, "a broad help question must never fabricate a goal");
      });
    } finally {
      await server.close();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  }
);

test(
  "2. adaptive rare goal (tea): create -> confirm -> log -> status for a genuinely custom, LLM-invented signal",
  { ...llmEvalOptions(["adaptive-goal", "evidence"]), timeout: EVAL_TIMEOUT_MS },
  async () => {
    const server = buildServer();
    const userId = `llm-eval-tea-${randomUUID()}`;
    const trace = new EvalTrace("2-tea-goal", ["adaptive-goal", "evidence"], userId);

    try {
      await seedUser(userId);

      await trace.guard(async () => {
        const t1 = trace.record("I want to drink more tea", await sendAgentMessage(server, userId, "I want to drink more tea"));
        trace.checkpoint("proposal needs confirmation", t1.needsConfirmation, String(t1.needsConfirmation));
        assert.equal(t1.needsConfirmation, true, "a new-goal proposal must ask for confirmation, never create immediately");

        trace.record("yes", await sendAgentMessage(server, userId, "yes"));

        const tea = await prisma.goal.findFirst({ where: { userId, title: { contains: "tea", mode: "insensitive" } } });
        trace.checkpoint("tea goal created", Boolean(tea), tea?.title ?? "none");
        assert.ok(tea, "the tea goal must have been created");
        const metrics = (tea!.targetMetrics as Array<{ signalKey?: string; eventType?: string }> | null) ?? [];
        const hasSignal = metrics.some((metric) => Boolean(metric.signalKey) || Boolean(metric.eventType));
        trace.checkpoint("tea goal declares a real signal", hasSignal, JSON.stringify(metrics));
        assert.ok(hasSignal, "the tea goal must declare at least one real trackable signal");

        trace.record("had 2 teas today", await sendAgentMessage(server, userId, "had 2 teas today"));

        const t4 = trace.record("how is my tea goal going", await sendAgentMessage(server, userId, "how is my tea goal going"));
        assertMentionsGoal(t4.reply, tea!.title, "turn 4 (status)", trace);

        await assertEvidenceCountedForGoal(userId, tea!, 2, trace);
      });
    } finally {
      await server.close();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  }
);

test(
  "3. book goal (Meditations): partial reading progress is counted and never called avoidance",
  { ...llmEvalOptions(["adaptive-goal", "book", "evidence"]), timeout: EVAL_TIMEOUT_MS },
  async () => {
    const server = buildServer();
    const userId = `llm-eval-meditations-${randomUUID()}`;
    const trace = new EvalTrace("3-book-goal-meditations", ["adaptive-goal", "book", "evidence"], userId);

    try {
      await seedUser(userId);

      await trace.guard(async () => {
        const t1 = trace.record(
          "I want to finish Meditations by Marcus Aurelius",
          await sendAgentMessage(server, userId, "I want to finish Meditations by Marcus Aurelius")
        );
        trace.checkpoint("proposal needs confirmation", t1.needsConfirmation, String(t1.needsConfirmation));
        assert.equal(t1.needsConfirmation, true);

        trace.record("yes", await sendAgentMessage(server, userId, "yes"));

        const meditations = await prisma.goal.findFirst({ where: { userId, title: { contains: "Meditations", mode: "insensitive" } } });
        trace.checkpoint("Meditations goal created", Boolean(meditations), meditations?.title ?? "none");
        assert.ok(meditations, "the Meditations goal must have been created");

        const t3 = trace.record("read 30min today", await sendAgentMessage(server, userId, "read 30min today"));
        assertNoBannedPhrases(t3.reply, [], "turn 3 (partial reading progress)", trace);

        const t4 = trace.record("how is the Meditations goal going", await sendAgentMessage(server, userId, "how is the Meditations goal going"));
        assertNoBannedPhrases(t4.reply, [], "turn 4 (status)", trace);

        await assertEvidenceCountedForGoal(userId, meditations!, 1, trace);
      });
    } finally {
      await server.close();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  }
);

test(
  "4. multiple reading goals: an ambiguous reference asks or explicitly resolves, never a silent wrong generic pick",
  { ...llmEvalOptions(["goal-reference", "ambiguity"]), timeout: EVAL_TIMEOUT_MS },
  async () => {
    const server = buildServer();
    const userId = `llm-eval-ambiguous-reading-${randomUUID()}`;
    const trace = new EvalTrace("4-ambiguous-reading", ["goal-reference", "ambiguity"], userId);

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

        trace.checkpoint("names a real goal or asks", asksClarification || mentionsReadMore || mentionsNietzsche, reply.reply);
        assert.ok(
          asksClarification || mentionsReadMore || mentionsNietzsche,
          `must either ask which goal or explicitly name one of the two real goals — got: ${reply.reply}`
        );

        const silentlyMergedBoth = mentionsReadMore && mentionsNietzsche && !asksClarification;
        trace.checkpoint("does not silently merge both goals", !silentlyMergedBoth, reply.reply);
        assert.ok(!silentlyMergedBoth, "naming both without a clarifying question reads as silently merging them rather than choosing");
      });
    } finally {
      await server.close();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  }
);

test(
  "5. job-search loop: applications sent AND recruiter replies both counted, independently",
  { ...llmEvalOptions(["job-search", "evidence"]), timeout: EVAL_TIMEOUT_MS },
  async () => {
    const server = buildServer();
    const userId = `llm-eval-job-search-${randomUUID()}`;
    const trace = new EvalTrace("5-job-search-loop", ["job-search", "evidence"], userId);

    try {
      await seedUser(userId);
      const jobSearchResult = await createGoal(userId, { title: "Find a new developer job", category: "career", templateId: "career.job_search" });
      if (jobSearchResult.duplicate) throw new Error("unexpected duplicate goal in eval setup");
      const jobSearch = jobSearchResult.goal;

      await trace.guard(async () => {
        trace.record("sent 5 CVs today", await sendAgentMessage(server, userId, "sent 5 CVs today"));
        trace.record("got 2 recruiter replies", await sendAgentMessage(server, userId, "got 2 recruiter replies"));

        const reply = trace.record("how is my job search going", await sendAgentMessage(server, userId, "how is my job search going"));
        assertMentionsGoal(reply.reply, jobSearch.title, "turn 3 (status)", trace);
        assertDoesNotMentionGoal(reply.reply, "no active goals", "turn 3 (status)", trace);

        const applicationsSent = await prisma.event.count({ where: { userId, type: "career.application_sent" } });
        trace.checkpoint("applications_sent counted >= 5", applicationsSent >= 5, `got ${applicationsSent}`);
        assert.ok(applicationsSent >= 5, `expected at least 5 career.application_sent events, got ${applicationsSent}`);

        const recruiterReplies = await prisma.event.count({ where: { userId, type: "career.recruiter_reply_received" } });
        trace.checkpoint("recruiter_reply_received counted >= 2", recruiterReplies >= 2, `got ${recruiterReplies}`);
        assert.ok(recruiterReplies >= 2, `expected at least 2 career.recruiter_reply_received events, got ${recruiterReplies}`);
      });
    } finally {
      await server.close();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  }
);

test(
  "6. Gmail recruiter flow: a pending recruiter review becomes a real, goal-linked action",
  { ...llmEvalOptions(["gmail", "job-search"]), timeout: EVAL_TIMEOUT_MS },
  async () => {
    const server = buildServer();
    const userId = `llm-eval-gmail-recruiter-${randomUUID()}`;
    const trace = new EvalTrace("6-gmail-recruiter", ["gmail", "job-search"], userId);

    try {
      await seedUser(userId);
      const jobSearchResult = await createGoal(userId, { title: "Find a new developer job", category: "career", templateId: "career.job_search" });
      if (jobSearchResult.duplicate) throw new Error("unexpected duplicate goal in eval setup");
      const jobSearch = jobSearchResult.goal;

      const connection = await prisma.integrationConnection.create({ data: { userId, integrationId: "gmail", status: "active", config: {} } });
      const rule = await prisma.emailSignalRule.create({
        data: { userId, connectionId: connection.id, adapterId: "job_search_email", name: "Job search emails", status: "active", createdBy: "user", goalId: jobSearch.id }
      });
      await prisma.emailReviewItem.create({
        data: {
          userId,
          connectionId: connection.id,
          ruleId: rule.id,
          adapterId: "job_search_email",
          provider: "gmail",
          providerMessageId: "recruiter-eval-1",
          externalId: `gmail-review:${rule.id}:recruiter-eval-1`,
          subject: "Re: your application",
          from: "Recruiter <recruiter@example.com>",
          snippet: "Thanks for applying, let's talk this week.",
          confidence: 0.85,
          reason: "rule_classification",
          extracted: {},
          proposedEventType: "career.recruiter_reply_received",
          status: "pending"
        }
      });

      await trace.guard(async () => {
        const t1 = trace.record("what emails need attention?", await sendAgentMessage(server, userId, "what emails need attention?"));
        const listsRecruiterEmail = t1.reply.toLowerCase().includes("application");
        trace.checkpoint("review list mentions the pending recruiter email", listsRecruiterEmail, t1.reply);
        assert.ok(listsRecruiterEmail, `expected the pending recruiter review to be listed — got: ${t1.reply}`);

        trace.record("turn recruiter one into a task", await sendAgentMessage(server, userId, "turn recruiter one into a task"));

        await assertActionCreated(userId, "application", { goalId: jobSearch.id }, trace);
      });
    } finally {
      await server.close();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  }
);

test(
  "7. Gmail admin/bill flow: a generic, non-job goal links its own Gmail review with zero job-search assumptions",
  { ...llmEvalOptions(["gmail", "admin"]), timeout: EVAL_TIMEOUT_MS },
  async () => {
    const server = buildServer();
    const userId = `llm-eval-gmail-admin-${randomUUID()}`;
    const trace = new EvalTrace("7-gmail-admin-bills", ["gmail", "admin"], userId);

    try {
      await seedUser(userId);
      const billsResult = await createGoal(userId, { title: "Handle Endesa bills", category: "admin" });
      if (billsResult.duplicate) throw new Error("unexpected duplicate goal in eval setup");
      const bills = billsResult.goal;

      const connection = await prisma.integrationConnection.create({ data: { userId, integrationId: "gmail", status: "active", config: {} } });
      const rule = await prisma.emailSignalRule.create({
        data: { userId, connectionId: connection.id, adapterId: "custom_email_review", name: "Endesa bills", status: "active", createdBy: "user", goalId: bills.id }
      });
      await prisma.emailReviewItem.create({
        data: {
          userId,
          connectionId: connection.id,
          ruleId: rule.id,
          adapterId: "custom_email_review",
          provider: "gmail",
          providerMessageId: "endesa-eval-1",
          externalId: `gmail-review:${rule.id}:endesa-eval-1`,
          subject: "Endesa factura disponible",
          from: "Endesa <noreply@endesa.com>",
          snippet: "Your electricity bill is ready to view.",
          confidence: 0.7,
          reason: "custom_rule_match",
          extracted: {},
          status: "pending"
        }
      });

      await trace.guard(async () => {
        trace.record("what emails need attention?", await sendAgentMessage(server, userId, "what emails need attention?"));

        const t2 = trace.record("turn the Endesa one into a task", await sendAgentMessage(server, userId, "turn the Endesa one into a task"));
        assertNoBannedPhrases(t2.reply, ["job", "recruiter", "cv", "application"], "turn 2 (no job-search assumptions)", trace);

        await assertActionCreated(userId, "endesa", { goalId: bills.id }, trace);
      });
    } finally {
      await server.close();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  }
);

test(
  "8. guardrail vs progress: a partial-effort report against a strict goal is never called avoidance/sabotage",
  { ...llmEvalOptions(["guardrail", "evidence"]), timeout: EVAL_TIMEOUT_MS },
  async () => {
    const server = buildServer();
    const userId = `llm-eval-guardrail-progress-${randomUUID()}`;
    const trace = new EvalTrace("8-guardrail-vs-progress", ["guardrail", "evidence"], userId);

    try {
      await seedUser(userId);
      const meditateResult = await createGoal(userId, {
        title: "Meditate every day",
        category: "wellbeing",
        why: "Build a consistent daily meditation habit",
        targetMetrics: [{ key: "meditation_minutes", label: "minutes meditated", signalKey: "meditation_minutes", aggregation: "sum", window: "daily" }]
      });
      if (meditateResult.duplicate) throw new Error("unexpected duplicate goal in eval setup");
      const meditate = meditateResult.goal;

      await trace.guard(async () => {
        const reply = trace.record("I only did 5 minutes today", await sendAgentMessage(server, userId, "I only did 5 minutes today"));
        assertNoBannedPhrases(reply.reply, [], "turn 1 (partial-effort report)", trace);

        // Soft, informational only — whether the LLM found the exact right signal key for a
        // custom goal it didn't create itself is a separate, narrower capability question (see
        // scenario 3's known unit/key-matching edge case); the one thing this scenario MUST prove
        // is the guardrail boundary above, which is a hard assertion.
        const events = await prisma.event.count({ where: { userId } });
        trace.checkpoint("some evidence logged (informational)", events > 0, `event count: ${events}`);
      });
    } finally {
      await server.close();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  }
);

test(
  "9. proactive settings: turning on morning briefs via chat actually flips the real setting",
  { ...llmEvalOptions(["proactive-settings"]), timeout: EVAL_TIMEOUT_MS },
  async () => {
    const server = buildServer();
    const userId = `llm-eval-proactive-settings-${randomUUID()}`;
    const trace = new EvalTrace("9-proactive-settings", ["proactive-settings"], userId);

    try {
      await seedUser(userId);

      await trace.guard(async () => {
        const t1 = trace.record("turn on morning briefs", await sendAgentMessage(server, userId, "turn on morning briefs"));
        trace.checkpoint("proposal needs confirmation", t1.needsConfirmation, String(t1.needsConfirmation));
        assert.equal(t1.needsConfirmation, true, "a settings change must ask for confirmation before applying");

        const beforeConfirm = await prisma.notificationSettings.findUnique({ where: { userId } });
        trace.checkpoint("not yet enabled before confirmation", beforeConfirm?.morningBriefEnabled !== true, String(beforeConfirm?.morningBriefEnabled));
        assert.notEqual(beforeConfirm?.morningBriefEnabled, true, "must not mutate before confirmation");

        trace.record("yes", await sendAgentMessage(server, userId, "yes"));

        const afterConfirm = await prisma.notificationSettings.findUnique({ where: { userId } });
        trace.checkpoint("morning brief enabled in DB after confirm", afterConfirm?.morningBriefEnabled === true, String(afterConfirm?.morningBriefEnabled));
        assert.equal(afterConfirm?.morningBriefEnabled, true, "confirming must actually flip the real NotificationSettings row");

        const t3 = trace.record("what proactive messages are on?", await sendAgentMessage(server, userId, "what proactive messages are on?"));
        const mentionsOn = /morning brief.*on/i.test(t3.reply);
        trace.checkpoint("status reply reflects morning brief on", mentionsOn, t3.reply);
        assert.ok(mentionsOn, `expected the status reply to say the morning brief is on — got: ${t3.reply}`);
      });
    } finally {
      await server.close();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  }
);

test(
  "9b. Gmail alerts with expired auth: propose, confirm, and reconnect link stay user-facing",
  { ...llmEvalOptions(["gmail", "proactive-settings"]), timeout: EVAL_TIMEOUT_MS },
  async () => {
    const restore = installGmailOAuthEnv();
    const server = buildServer();
    const userId = `llm-eval-gmail-alerts-${randomUUID()}`;
    const trace = new EvalTrace("9b-gmail-alerts-expired-auth", ["gmail", "proactive-settings"], userId);

    try {
      await seedUser(userId);
      await prisma.notificationSettings.create({ data: { userId, gmailNudgeEnabled: false, timezone: "Europe/Madrid" } });
      await prisma.integrationConnection.create({
        data: {
          userId,
          integrationId: "gmail",
          status: "error",
          lastSyncedAt: new Date("2026-08-13T11:15:37.863Z"),
          lastError: "Gmail authorization expired. Reconnect Gmail.",
          config: { email: "user@example.com" }
        }
      });

      await trace.guard(async () => {
        const proposal = trace.record("tell me when important emails arrive", await sendAgentMessage(server, userId, "tell me when important emails arrive"));
        trace.checkpoint("proposal needs confirmation", proposal.needsConfirmation, String(proposal.needsConfirmation));
        assert.equal(proposal.needsConfirmation, true);
        assert.match(proposal.reply, /Gmail alerts/i);
        assert.match(proposal.reply, /Reconnect Gmail|connect or reconnect Gmail/i);
        assert.match(proposal.reply, /https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
        assert.doesNotMatch(proposal.reply, /\bnudges?\b/i);
        assert.ok(!proposal.operationsPlanned.some((operation) => operation.tool.toLowerCase().includes("sync")), "Gmail alert setup must not plan sync");

        trace.record("yes", await sendAgentMessage(server, userId, "yes"));

        const afterConfirm = await prisma.notificationSettings.findUnique({ where: { userId } });
        trace.checkpoint("Gmail alerts enabled in DB after confirm", afterConfirm?.gmailNudgeEnabled === true, String(afterConfirm?.gmailNudgeEnabled));
        assert.equal(afterConfirm?.gmailNudgeEnabled, true);

        const reconnect = trace.record("send me the reconnect link", await sendAgentMessage(server, userId, "send me the reconnect link"));
        assert.match(reconnect.reply, /Reconnect Gmail here/i);
        assert.match(reconnect.reply, /https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
        assert.doesNotMatch(reconnect.reply, /\bnudges?\b/i);
      });
    } finally {
      restore();
      await server.close();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  }
);

test(
  "10. morning brief preview quality: leads with the real top priority, never a stale/unrelated goal",
  { ...llmEvalOptions(["morning-brief", "proactive"]), timeout: EVAL_TIMEOUT_MS },
  async () => {
    // Deliberately deterministic under the hood (decideProactiveOperatorMessage/buildMorningBrief
    // make no LLM call at all — see apps/api/src/operator/proactive.ts) — included in this suite
    // anyway per the requested user-journey coverage, and gated the same way as every other
    // scenario for a consistent `pnpm test:llm` run; it costs no extra OpenAI tokens itself.
    const server = buildServer();
    const userId = `llm-eval-morning-brief-${randomUUID()}`;
    const trace = new EvalTrace("10-morning-brief-preview", ["morning-brief", "proactive"], userId);

    try {
      await seedUser(userId);
      await prisma.notificationSettings.create({
        data: { userId, dailyLoopEnabled: true, morningTimeMinutes: 540, eveningTimeMinutes: 1140, timezone: "Europe/Madrid" }
      });

      const jobGoalResult = await createGoal(userId, { title: "Find a new developer job", category: "career", templateId: "career.job_search" });
      const gymGoalResult = await createGoal(userId, { title: "Train 3 times a week", category: "health" });
      const bookGoalResult = await createGoal(userId, { title: "Finish reading Meditations", category: "reading" });
      // A goal with zero linked actions and zero recent activity — nothing here should ever make
      // the brief mention it; if it does, something is pulling in unrelated/stale goals.
      await createGoal(userId, { title: "Learn to play guitar", category: "hobby" });
      if (jobGoalResult.duplicate || gymGoalResult.duplicate || bookGoalResult.duplicate) {
        throw new Error("unexpected duplicate goal in eval setup");
      }

      await prisma.actionItem.create({
        data: { userId, source: "manual", title: "Apply to 3 developer jobs", priority: "high", status: "open", goalId: jobGoalResult.goal.id }
      });
      await prisma.actionItem.create({ data: { userId, source: "manual", title: "Go to the gym", priority: "medium", status: "open", goalId: gymGoalResult.goal.id } });
      await prisma.actionItem.create({ data: { userId, source: "manual", title: "Read 10 pages", priority: "low", status: "open", goalId: bookGoalResult.goal.id } });

      await trace.guard(async () => {
        const response = await server.inject({ method: "GET", url: `/users/${userId}/operator/proactive/preview?now=${encodeURIComponent("2026-08-20T07:00:00.000Z")}` });
        assert.equal(response.statusCode, 200);
        const body = response.json() as { decision: { decision: string; message?: string } };
        const message = body.decision.message ?? "";

        trace.checkpoint("decision is proposed_message", body.decision.decision === "proposed_message", body.decision.decision);
        assert.equal(body.decision.decision, "proposed_message");

        const mentionsTopPriority = /apply to 3 developer jobs/i.test(message);
        trace.checkpoint("mentions the real top (high) priority action", mentionsTopPriority, message);
        assert.match(message, /apply to 3 developer jobs/i, `expected the brief to lead with the high-priority action — got: ${message}`);

        const mentionsStaleGoal = /guitar/i.test(message);
        trace.checkpoint("does not mention the unrelated, actionless goal", !mentionsStaleGoal, message);
        assert.doesNotMatch(message, /guitar/i, `the brief must never surface a goal with no real actions/activity — got: ${message}`);
      });
    } finally {
      await server.close();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  }
);
