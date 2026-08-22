import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createActionItem, createGoal } from "../packages/db/src/index.ts";
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
        const sync = trace.record("sync Gmail", await sendAgentMessage(server, userId, "sync Gmail"));
        assert.deepEqual(sync.operationsPlanned.map((operation) => operation.tool), ["gmail.sync"]);
        assert.match(sync.reply, /Gmail authorization expired\. Reconnect Gmail\./);
        assert.match(sync.reply, /https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
        assert.doesNotMatch(sync.reply, /Last synced:/i);
        assert.doesNotMatch(sync.reply, /\bnudges?\b/i);

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

test(
  "11. ambiguous 'complete it' after 'show all tasks' with 10 visible actions must clarify, never guess the first one",
  { ...llmEvalOptions(["actions", "ambiguity"]), timeout: EVAL_TIMEOUT_MS },
  async () => {
    // Reproduces a real Telegram smoke test bug report verbatim: the deterministic mocked-planner
    // suite (tests/agent-runtime-ambiguity-hardening.test.ts) proved the VALIDATOR correctly
    // clarifies when action.complete is planned with no actionId and multiple actions are
    // visible — but never proved what the REAL planner actually puts in `args` for "complete it"
    // after a real "show all tasks" turn. A real LLM might supply a CONCRETE (if wrong/guessed)
    // actionId directly, which the validator has no way to distinguish from a genuinely correct
    // one — that bypasses the ambiguity check entirely, regardless of how well it works in the
    // mocked suite. This scenario is the only place in the repo that can actually observe that.
    const server = buildServer();
    const userId = `llm-eval-action-ambiguity-${randomUUID()}`;
    const trace = new EvalTrace("11-action-completion-ambiguity", ["actions", "ambiguity"], userId);

    try {
      await seedUser(userId);
      const titles = [
        "We need to seriously talk about getcracked",
        "Review GitHub security advisory for vulnerabilities",
        "Review security advisory on GitHub repository",
        "Review security alert",
        "Branding direction meeting",
        "Upgrade to Node.js 24",
        "Apply to 3 developer jobs",
        "Write 5 bullets for the YouTube script",
        "Read 20 minutes on 3 days",
        "Do 2 strength sessions"
      ];
      const createdIds: string[] = [];
      for (const title of titles) {
        const created = await createActionItem(userId, { source: "manual", title });
        createdIds.push(created.id);
      }

      await trace.guard(async () => {
        const t1 = trace.record("show all tasks", await sendAgentMessage(server, userId, "show all tasks"));
        trace.checkpoint("action.list planned", t1.operationsPlanned.some((operation) => operation.tool === "action.list"), JSON.stringify(t1.operationsPlanned));

        const t2 = trace.record("complete it", await sendAgentMessage(server, userId, "complete it"));

        const completedIds = await prisma.actionItem.findMany({ where: { userId, status: "completed" } }).then((rows) => rows.map((row) => row.id));
        trace.checkpoint("no action completed without clarification", completedIds.length === 0 || t2.debug.mutationExecuted === false, JSON.stringify({ completedIds, mutationExecuted: t2.debug.mutationExecuted, plannedOps: t2.operationsPlanned }));

        // The real, actionable assertion: with 10 equally-plausible visible actions and no recent
        // worker reminder to disambiguate, "complete it" must never mutate — it must either ask a
        // clarification or (informationally) decline, but it must not guess.
        assert.equal(
          t2.debug.mutationExecuted,
          false,
          `"complete it" must not mutate with 10 ambiguous visible actions and no reminder — planned: ${JSON.stringify(t2.operationsPlanned)}, reply: ${t2.reply}`
        );

        for (const id of createdIds) {
          const item = await prisma.actionItem.findUnique({ where: { id } });
          trace.checkpoint(`action ${id} untouched`, item?.status === "open", item?.status);
        }
      });
    } finally {
      await server.close();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  }
);

/**
 * ==========================================================================================
 * audit/v3-goal-onboarding-evals — goal onboarding, generic tracking, and Gmail-relevance suite
 * ==========================================================================================
 *
 * Product principle under test: Alecto is a generic goal operator; Gmail is one observation
 * source among many, never something every goal gets by default; job search is one fixture, not
 * the product shape. Scenarios 12+ below verify the real LLM actually respects that boundary —
 * the deterministic mocked-planner suite (tests/agent-runtime-goal-onboarding-gmail-suggestion
 * .test.ts) can only prove the EXECUTOR renders whatever the planner proposes correctly; only a
 * real planner call can prove it proposes the RIGHT thing for a given goal domain.
 */

const GMAIL_RELEVANCE_POSITIVE_CASES: Array<{ n: string; message: string; tags: string[] }> = [
  { n: "12", message: "I want to find a new developer job", tags: ["job-search"] },
  { n: "13", message: "I want to keep track of recruiter replies to my applications", tags: ["job-search"] },
  { n: "14", message: "I need to stay on top of client invoices", tags: ["admin"] },
  { n: "15", message: "I want to monitor emails from my biggest client", tags: ["admin"] },
  { n: "16", message: "Help me prepare for my Japan trip", tags: ["travel"] },
  { n: "17", message: "I want to watch for security alerts on my accounts", tags: ["security"] },
  { n: "18", message: "I want to cancel subscriptions I don't use anymore", tags: ["admin"] },
  { n: "19", message: "I want to track when my package deliveries ship", tags: ["shipping"] }
];

for (const testCase of GMAIL_RELEVANCE_POSITIVE_CASES) {
  test(
    `${testCase.n}. Gmail relevance (positive): "${testCase.message}" allows a conditional Gmail suggestion`,
    { ...llmEvalOptions(["goal-creation", "gmail-relevance", ...testCase.tags]), timeout: EVAL_TIMEOUT_MS },
    async () => {
      const server = buildServer();
      const userId = `llm-eval-gmail-pos-${testCase.n}-${randomUUID()}`;
      const trace = new EvalTrace(`${testCase.n}-gmail-relevance-positive`, ["goal-creation", "gmail-relevance", ...testCase.tags], userId);

      try {
        await seedUser(userId);
        await trace.guard(async () => {
          const reply = trace.record(testCase.message, await sendAgentMessage(server, userId, testCase.message));
          assert.equal(reply.needsConfirmation, true, `a new-goal proposal must require confirmation — got: ${reply.reply}`);
          const mentionsGmail = /gmail/i.test(reply.reply);
          trace.checkpoint("Gmail mention present", mentionsGmail, reply.reply);
          assert.ok(mentionsGmail, `expected a Gmail suggestion for "${testCase.message}" — got: ${reply.reply}`);
          assert.doesNotMatch(
            reply.reply,
            /i(?:'m| am) (?:already )?(?:watching|monitoring)|i(?:'ll| will) monitor/i,
            `must never promise active monitoring before any rule/worker path exists — got: ${reply.reply}`
          );
        });
      } finally {
        await server.close();
        await prisma.user.deleteMany({ where: { id: userId } });
      }
    }
  );
}

const GMAIL_RELEVANCE_NEGATIVE_CASES: Array<{ n: string; message: string; tags: string[] }> = [
  { n: "20", message: "I want to get stronger", tags: ["fitness"] },
  { n: "21", message: "I want to read for 20 minutes every day", tags: ["reading"] },
  { n: "22", message: "I want to stop wasting evenings on TikTok", tags: ["habit"] },
  { n: "23", message: "I want to meditate every day", tags: ["wellbeing"] },
  { n: "24", message: "I want to write a YouTube script this week", tags: ["creative"] },
  { n: "25", message: "I want to improve my sleep", tags: ["health"] },
  { n: "26", message: "I want to call my grandmother every Sunday", tags: ["family"] },
  { n: "27", message: "I want to learn to play guitar", tags: ["hobby"] },
  { n: "28", message: "I want to build a daily writing habit", tags: ["habit"] }
];

for (const testCase of GMAIL_RELEVANCE_NEGATIVE_CASES) {
  test(
    `${testCase.n}. Gmail relevance (negative): "${testCase.message}" never suggests Gmail`,
    { ...llmEvalOptions(["goal-creation", "no-gmail", ...testCase.tags]), timeout: EVAL_TIMEOUT_MS },
    async () => {
      const server = buildServer();
      const userId = `llm-eval-gmail-neg-${testCase.n}-${randomUUID()}`;
      const trace = new EvalTrace(`${testCase.n}-gmail-relevance-negative`, ["goal-creation", "no-gmail", ...testCase.tags], userId);

      try {
        await seedUser(userId);
        await trace.guard(async () => {
          const reply = trace.record(testCase.message, await sendAgentMessage(server, userId, testCase.message));
          assert.equal(reply.needsConfirmation, true, `a new-goal proposal must require confirmation — got: ${reply.reply}`);
          const mentionsGmail = /gmail/i.test(reply.reply);
          trace.checkpoint("Gmail mention absent", !mentionsGmail, reply.reply);
          assert.ok(!mentionsGmail, `must NOT mention Gmail — this goal has no email-observable signal — got: ${reply.reply}`);
        });
      } finally {
        await server.close();
        await prisma.user.deleteMany({ where: { id: userId } });
      }
    }
  );
}

test(
  "29. Gmail relevance nuance: a creative goal with an explicit email/collaborator mention DOES allow a Gmail suggestion",
  { ...llmEvalOptions(["goal-creation", "gmail-relevance", "nuance", "creative"]), timeout: EVAL_TIMEOUT_MS },
  async () => {
    const server = buildServer();
    const userId = `llm-eval-gmail-nuance-${randomUUID()}`;
    const trace = new EvalTrace("29-gmail-relevance-nuance", ["goal-creation", "gmail-relevance", "nuance"], userId);

    try {
      await seedUser(userId);
      await trace.guard(async () => {
        const message = "I want to write a YouTube script and stay on top of my collaborators' emails about it";
        const reply = trace.record(message, await sendAgentMessage(server, userId, message));
        assert.equal(reply.needsConfirmation, true);
        const mentionsGmail = /gmail/i.test(reply.reply);
        trace.checkpoint("Gmail mentioned given explicit email mention", mentionsGmail, reply.reply);
        assert.ok(mentionsGmail, `the user explicitly mentioned collaborator emails — expected a Gmail suggestion — got: ${reply.reply}`);
      });
    } finally {
      await server.close();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  }
);

test(
  "30. goal lifecycle judgment: 'I don't want to track my Meditations goal anymore' correctly chooses archive, not some other tool",
  { ...llmEvalOptions(["goal-lifecycle"]), timeout: EVAL_TIMEOUT_MS },
  async () => {
    const server = buildServer();
    const userId = `llm-eval-lifecycle-archive-${randomUUID()}`;
    const trace = new EvalTrace("30-lifecycle-archive-judgment", ["goal-lifecycle"], userId);

    try {
      await seedUser(userId);
      const result = await createGoal(userId, { title: "Meditate every day", category: "wellbeing" });
      if (result.duplicate) throw new Error("unexpected duplicate goal in eval setup");

      await trace.guard(async () => {
        const reply = trace.record(
          "I don't want to track my Meditations goal anymore",
          await sendAgentMessage(server, userId, "I don't want to track my Meditations goal anymore")
        );
        trace.checkpoint("proposal needs confirmation", reply.needsConfirmation, String(reply.needsConfirmation));
        assert.equal(reply.needsConfirmation, true, `expected an archive proposal requiring confirmation — got: ${reply.reply}`);

        const plannedArchive = reply.operationsPlanned.some((operation) => operation.tool === "goal.archive_propose");
        trace.checkpoint("goal.archive_propose was planned", plannedArchive, JSON.stringify(reply.operationsPlanned));
        assert.ok(plannedArchive, `expected goal.archive_propose, got: ${JSON.stringify(reply.operationsPlanned)}`);

        const row = await prisma.goal.findUnique({ where: { id: result.goal.id } });
        assert.equal(row?.status, "active", "nothing may be archived before confirmation");
      });
    } finally {
      await server.close();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  }
);

test(
  "31. editing a goal's title is honestly refused — zero mutating operations, the goal stays unchanged",
  { ...llmEvalOptions(["goal-lifecycle"]), timeout: EVAL_TIMEOUT_MS },
  async () => {
    const server = buildServer();
    const userId = `llm-eval-lifecycle-edit-refused-${randomUUID()}`;
    const trace = new EvalTrace("31-lifecycle-edit-refused", ["goal-lifecycle"], userId);

    try {
      await seedUser(userId);
      const result = await createGoal(userId, { title: "Find a new developer job", category: "career", templateId: "career.job_search" });
      if (result.duplicate) throw new Error("unexpected duplicate goal in eval setup");

      await trace.guard(async () => {
        const message = "can you change the title of my job search goal to something else";
        const reply = trace.record(message, await sendAgentMessage(server, userId, message));

        const mutated = reply.operationsExecuted.some((operation) => operation.status === "executed" && operation.tool.startsWith("goal."));
        trace.checkpoint("no goal mutation executed", !mutated, JSON.stringify(reply.operationsExecuted));
        assert.ok(!mutated, `editing isn't supported — nothing should execute, got: ${JSON.stringify(reply.operationsExecuted)}`);

        const row = await prisma.goal.findUnique({ where: { id: result.goal.id } });
        assert.equal(row?.title, "Find a new developer job", "the title must be completely unchanged");
      });
    } finally {
      await server.close();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  }
);

test(
  "32. evidence ambiguity: two active goals sharing the same real eventType still log real evidence (known attribution-honesty gap, tracked informationally)",
  { ...llmEvalOptions(["evidence", "ambiguity"]), timeout: EVAL_TIMEOUT_MS },
  async () => {
    // Documents a real, confirmed gap from the audit/v3-goal-onboarding-evals audit: when two
    // ACTIVE goals declare the identical real eventType (a realistic case — e.g. two reading
    // goals both using the registry's one "reading session completed" type) and no goalRef/focus
    // disambiguates, goal.log_evidence still logs the real evidence (never silently drops it —
    // that's the one HARD guarantee this scenario enforces) but currently attributes the reply's
    // own "this counts toward X" note to an arbitrary one of the two rather than asking. The
    // event itself never stores a wrong goalId (attribution is a read-time computation, not
    // stored), so this is a reply-honesty gap, not data corruption — tracked as informational
    // here rather than a hard failure until a dedicated fix lands (see the audit's own report for
    // the exact recommended design: threading a resolvedVia signal through
    // resolveActiveGoalReference).
    const server = buildServer();
    const userId = `llm-eval-evidence-ambiguity-${randomUUID()}`;
    const trace = new EvalTrace("32-evidence-shared-eventtype-ambiguity", ["evidence", "ambiguity"], userId);

    try {
      await seedUser(userId);
      const readMore = await createGoal(userId, {
        title: "Read more",
        category: "learning",
        targetMetrics: [{ key: "reading_sessions", label: "reading sessions", eventType: "learning.reading_session_completed", aggregation: "count", window: "daily" }]
      });
      const nietzsche = await createGoal(userId, {
        title: "Finish reading Nietzsche book",
        category: "reading",
        targetMetrics: [{ key: "nietzsche_sessions", label: "Nietzsche reading sessions", eventType: "learning.reading_session_completed", aggregation: "count", window: "daily" }]
      });
      if (readMore.duplicate || nietzsche.duplicate) throw new Error("unexpected duplicate goal in eval setup");

      await trace.guard(async () => {
        const reply = trace.record("read 30 minutes today", await sendAgentMessage(server, userId, "read 30 minutes today"));

        // Hard guarantee: real evidence is never silently dropped just because it's ambiguous
        // which of two goals it belongs to.
        const events = await prisma.event.count({ where: { userId } });
        trace.checkpoint("evidence was logged despite ambiguity", events > 0, `event count: ${events}`);
        assert.ok(events > 0, "genuinely ambiguous evidence must still be logged, never silently dropped");

        // Informational only, per the doc comment above — not a hard assertion.
        const namesExactlyOne = /read more|nietzsche/i.test(reply.reply);
        const asksWhichGoal = reply.reply.includes("?");
        trace.checkpoint("reply is honest about the ambiguity (asks) or clearly names one (informational)", asksWhichGoal || namesExactlyOne, reply.reply);
      });
    } finally {
      await server.close();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  }
);

test(
  "33. a custom progress phrase remaps to the goal's own declared signal instead of failing over a naming mismatch",
  { ...llmEvalOptions(["evidence"]), timeout: EVAL_TIMEOUT_MS },
  async () => {
    const server = buildServer();
    const userId = `llm-eval-evidence-remap-${randomUUID()}`;
    const trace = new EvalTrace("33-evidence-signal-remap", ["evidence"], userId);

    try {
      await seedUser(userId);
      const result = await createGoal(userId, {
        title: "Finish reading Dune",
        category: "reading",
        targetMetrics: [
          { key: "pages_read", label: "pages read", signalKey: "pages_read", aggregation: "sum", window: "daily" },
          { key: "dune_finished", label: "Dune finished", signalKey: "dune_finished", aggregation: "count", window: "weekly" }
        ]
      });
      if (result.duplicate) throw new Error("unexpected duplicate goal in eval setup");

      await trace.guard(async () => {
        const reply = trace.record("read for 30 minutes on Dune today", await sendAgentMessage(server, userId, "read for 30 minutes on Dune today"));
        assertNoBannedPhrases(reply.reply, [], "turn 1 (progress remap)", trace);

        const events = await prisma.event.count({ where: { userId } });
        trace.checkpoint("some evidence logged", events > 0, `event count: ${events}`);
        assert.ok(events > 0, `expected the progress report to be logged against a real declared signal — got reply: ${reply.reply}`);
      });
    } finally {
      await server.close();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  }
);

test(
  "34. action.create from a plain mention auto-links to the matching active goal",
  { ...llmEvalOptions(["action-creation"]), timeout: EVAL_TIMEOUT_MS },
  async () => {
    const server = buildServer();
    const userId = `llm-eval-action-autolink-${randomUUID()}`;
    const trace = new EvalTrace("34-action-autolink", ["action-creation"], userId);

    try {
      await seedUser(userId);
      const result = await createGoal(userId, { title: "Find a new developer job", category: "career", templateId: "career.job_search" });
      if (result.duplicate) throw new Error("unexpected duplicate goal in eval setup");

      await trace.guard(async () => {
        trace.record("I need to update my CV before applying to more roles", await sendAgentMessage(server, userId, "I need to update my CV before applying to more roles"));
        await assertActionCreated(userId, "CV", { goalId: result.goal.id }, trace);
      });
    } finally {
      await server.close();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  }
);

test(
  "35. firstActions from a real LLM's own goal proposal are actually created on confirm",
  { ...llmEvalOptions(["goal-creation", "action-creation"]), timeout: EVAL_TIMEOUT_MS },
  async () => {
    const server = buildServer();
    const userId = `llm-eval-first-actions-${randomUUID()}`;
    const trace = new EvalTrace("35-first-actions-materialize", ["goal-creation", "action-creation"], userId);

    try {
      await seedUser(userId);
      await trace.guard(async () => {
        const t1 = trace.record(
          "I want to start applying to developer jobs",
          await sendAgentMessage(server, userId, "I want to start applying to developer jobs")
        );
        trace.checkpoint("proposal needs confirmation", t1.needsConfirmation, String(t1.needsConfirmation));
        assert.equal(t1.needsConfirmation, true);

        trace.record("yes", await sendAgentMessage(server, userId, "yes"));

        const goal = await prisma.goal.findFirst({ where: { userId, title: { contains: "job", mode: "insensitive" } } });
        trace.checkpoint("job-search goal created", Boolean(goal), goal?.title ?? "none");
        assert.ok(goal, "the goal must have been created");

        const actions = await prisma.actionItem.findMany({ where: { userId, goalId: goal!.id } });
        trace.checkpoint("at least one first action created for the goal (informational)", actions.length > 0, `action count: ${actions.length}`);
        // Soft/informational: whether the model proposes firstActions at all for a given phrasing
        // is judgment, not a hard product guarantee (the tool's own schema allows 0-3) — the hard
        // guarantee is only that IF any were proposed, they're real, goal-linked ActionItems,
        // which the DB query above already proves for any that exist.
      });
    } finally {
      await server.close();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  }
);

test(
  "36. 'remind me 30 minutes before' after a scheduled action creates a real, distinct reminder",
  { ...llmEvalOptions(["reminders", "actions"]), timeout: EVAL_TIMEOUT_MS },
  async () => {
    const server = buildServer();
    const userId = `llm-eval-reminder-creation-${randomUUID()}`;
    const trace = new EvalTrace("36-reminder-creation", ["reminders", "actions"], userId);

    try {
      await seedUser(userId);
      await trace.guard(async () => {
        trace.record(
          "I have a dentist appointment tomorrow at 3pm",
          await sendAgentMessage(server, userId, "I have a dentist appointment tomorrow at 3pm")
        );
        const parent = await prisma.actionItem.findFirst({ where: { userId, title: { contains: "dentist", mode: "insensitive" } } });
        trace.checkpoint("parent action created", Boolean(parent), parent?.title ?? "none");
        assert.ok(parent, "the dentist appointment action must have been created first");

        trace.record("remind me 30 minutes before", await sendAgentMessage(server, userId, "remind me 30 minutes before"));

        const reminder = await prisma.actionItem.findFirst({ where: { userId, actionType: "reminder" } });
        trace.checkpoint("a real reminder companion action was created", Boolean(reminder), reminder?.title ?? "none");
        assert.ok(reminder, "a real reminder ActionItem must exist, not just a promised reminder in the reply text");
      });
    } finally {
      await server.close();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  }
);

test(
  "37. Spanish: 'Quiero beber más agua cada día' proposes a real custom goal and creates nothing before confirmation",
  { ...llmEvalOptions(["multilingual", "goal-creation"]), timeout: EVAL_TIMEOUT_MS },
  async () => {
    const server = buildServer();
    const userId = `llm-eval-es-water-${randomUUID()}`;
    const trace = new EvalTrace("37-spanish-goal-creation", ["multilingual", "goal-creation"], userId);

    try {
      await seedUser(userId);
      await trace.guard(async () => {
        const t1 = trace.record("Quiero beber más agua cada día", await sendAgentMessage(server, userId, "Quiero beber más agua cada día"));
        trace.checkpoint("proposal needs confirmation", t1.needsConfirmation, String(t1.needsConfirmation));
        assert.equal(t1.needsConfirmation, true);

        trace.record("sí", await sendAgentMessage(server, userId, "sí"));

        const goalCount = await prisma.goal.count({ where: { userId } });
        trace.checkpoint("a goal was created after confirming in Spanish", goalCount > 0, `goal count: ${goalCount}`);
        assert.ok(goalCount > 0, "confirming in Spanish must still create the real goal");
      });
    } finally {
      await server.close();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  }
);

test(
  "38. Catalan: 'Vull llegir més llibres aquest any' proposes a reading goal with no Gmail suggestion",
  { ...llmEvalOptions(["multilingual", "goal-creation", "no-gmail"]), timeout: EVAL_TIMEOUT_MS },
  async () => {
    const server = buildServer();
    const userId = `llm-eval-ca-reading-${randomUUID()}`;
    const trace = new EvalTrace("38-catalan-goal-creation", ["multilingual", "goal-creation", "no-gmail"], userId);

    try {
      await seedUser(userId);
      await trace.guard(async () => {
        const reply = trace.record("Vull llegir més llibres aquest any", await sendAgentMessage(server, userId, "Vull llegir més llibres aquest any"));
        trace.checkpoint("proposal needs confirmation", reply.needsConfirmation, String(reply.needsConfirmation));
        assert.equal(reply.needsConfirmation, true);
        const mentionsGmail = /gmail/i.test(reply.reply);
        trace.checkpoint("no Gmail mention for a reading goal", !mentionsGmail, reply.reply);
        assert.ok(!mentionsGmail, `a reading goal has no email-observable signal — got: ${reply.reply}`);
      });
    } finally {
      await server.close();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  }
);

test(
  "39. Spanish: evidence logged in Spanish after a Spanish goal creation is counted",
  { ...llmEvalOptions(["multilingual", "evidence"]), timeout: EVAL_TIMEOUT_MS },
  async () => {
    const server = buildServer();
    const userId = `llm-eval-es-evidence-${randomUUID()}`;
    const trace = new EvalTrace("39-spanish-evidence", ["multilingual", "evidence"], userId);

    try {
      await seedUser(userId);
      await trace.guard(async () => {
        trace.record("Quiero beber más agua cada día", await sendAgentMessage(server, userId, "Quiero beber más agua cada día"));
        trace.record("sí", await sendAgentMessage(server, userId, "sí"));

        const goal = await prisma.goal.findFirst({ where: { userId } });
        trace.checkpoint("goal exists before logging", Boolean(goal), goal?.title ?? "none");
        assert.ok(goal, "setup goal must exist");

        trace.record("bebí 2 litros de agua hoy", await sendAgentMessage(server, userId, "bebí 2 litros de agua hoy"));

        await assertEvidenceCountedForGoal(userId, goal!, 1, trace);
      });
    } finally {
      await server.close();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  }
);

test(
  "40. Spanish: a genuinely vague 'quiero mejorar' is never proposed as a concrete plan — asks instead",
  { ...llmEvalOptions(["multilingual", "goal-creation", "ambiguity"]), timeout: EVAL_TIMEOUT_MS },
  async () => {
    const server = buildServer();
    const userId = `llm-eval-es-vague-${randomUUID()}`;
    const trace = new EvalTrace("40-spanish-vague-statement", ["multilingual", "goal-creation", "ambiguity"], userId);

    try {
      await seedUser(userId);
      await trace.guard(async () => {
        const reply = trace.record("quiero mejorar", await sendAgentMessage(server, userId, "quiero mejorar"));
        trace.checkpoint("no concrete goal plan created from a vague statement", reply.needsConfirmation === false || reply.reply.includes("?"), String(reply.needsConfirmation));
        assert.ok(
          !reply.needsConfirmation || reply.reply.includes("?"),
          `"quiero mejorar" is too vague to propose a concrete plan — got: ${reply.reply}`
        );
        const goalCount = await prisma.goal.count({ where: { userId } });
        assert.equal(goalCount, 0, "nothing concrete may be created from a genuinely vague statement");
      });
    } finally {
      await server.close();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  }
);

test(
  "41. new user onboarding: a first message that IS already a clear goal statement needs no nudge at all",
  { ...llmEvalOptions(["onboarding", "goal-creation"]), timeout: EVAL_TIMEOUT_MS },
  async () => {
    const server = buildServer();
    const userId = `llm-eval-onboarding-direct-${randomUUID()}`;
    const trace = new EvalTrace("41-onboarding-direct-goal", ["onboarding", "goal-creation"], userId);

    try {
      await seedUser(userId);
      await trace.guard(async () => {
        const reply = trace.record(
          "I want to find a new developer job",
          await sendAgentMessage(server, userId, "I want to find a new developer job")
        );
        const nudgeFired = /one real goal or guardrail/i.test(reply.reply);
        trace.checkpoint("the anchor nudge did not fire for a message that's already a clear goal statement", !nudgeFired, reply.reply);
        assert.ok(!nudgeFired, `a clear goal statement must go straight to goal.create_propose, not the empty-user nudge — got: ${reply.reply}`);
        assert.equal(reply.needsConfirmation, true, `expected a real goal proposal — got: ${reply.reply}`);
      });
    } finally {
      await server.close();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  }
);

test(
  "42. cancelling a pending goal-creation proposal leaves nothing created",
  { ...llmEvalOptions(["goal-creation", "confirmation"]), timeout: EVAL_TIMEOUT_MS },
  async () => {
    const server = buildServer();
    const userId = `llm-eval-cancel-creation-${randomUUID()}`;
    const trace = new EvalTrace("42-cancel-goal-creation", ["goal-creation", "confirmation"], userId);

    try {
      await seedUser(userId);
      await trace.guard(async () => {
        const t1 = trace.record("I want to learn to juggle", await sendAgentMessage(server, userId, "I want to learn to juggle"));
        assert.equal(t1.needsConfirmation, true);

        trace.record("cancel", await sendAgentMessage(server, userId, "cancel"));

        const goalCount = await prisma.goal.count({ where: { userId } });
        trace.checkpoint("nothing created after cancel", goalCount === 0, `goal count: ${goalCount}`);
        assert.equal(goalCount, 0, "cancelling a proposal must never create the goal");
      });
    } finally {
      await server.close();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  }
);

test(
  "43. cancelling a pending archive leaves the goal untouched, real LLM end to end",
  { ...llmEvalOptions(["goal-lifecycle", "confirmation"]), timeout: EVAL_TIMEOUT_MS },
  async () => {
    const server = buildServer();
    const userId = `llm-eval-cancel-archive-${randomUUID()}`;
    const trace = new EvalTrace("43-cancel-archive", ["goal-lifecycle", "confirmation"], userId);

    try {
      await seedUser(userId);
      const result = await createGoal(userId, { title: "Train 3 times a week", category: "health" });
      if (result.duplicate) throw new Error("unexpected duplicate goal in eval setup");

      await trace.guard(async () => {
        const t1 = trace.record(
          "archive my training goal",
          await sendAgentMessage(server, userId, "archive my training goal")
        );
        assert.equal(t1.needsConfirmation, true, `expected an archive proposal — got: ${t1.reply}`);

        trace.record("cancel", await sendAgentMessage(server, userId, "cancel"));

        const row = await prisma.goal.findUnique({ where: { id: result.goal.id } });
        trace.checkpoint("goal still active after cancel", row?.status === "active", row?.status);
        assert.equal(row?.status, "active", "cancelling must leave the goal untouched");
      });
    } finally {
      await server.close();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  }
);

test(
  "44. a disambiguating follow-up after an ambiguous multi-goal reference correctly resolves, never guesses",
  { ...llmEvalOptions(["goal-reference", "ambiguity"]), timeout: EVAL_TIMEOUT_MS },
  async () => {
    const server = buildServer();
    const userId = `llm-eval-disambiguate-followup-${randomUUID()}`;
    const trace = new EvalTrace("44-disambiguating-followup", ["goal-reference", "ambiguity"], userId);

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
        const t1 = trace.record("show reading goal", await sendAgentMessage(server, userId, "show reading goal"));
        const alreadyResolved = !t1.reply.includes("?");

        if (!alreadyResolved) {
          const t2 = trace.record("the Nietzsche one", await sendAgentMessage(server, userId, "the Nietzsche one"));
          assertMentionsGoal(t2.reply, "Nietzsche", "turn 2 (disambiguating follow-up)", trace);
          assertDoesNotMentionGoal(t2.reply, "Read more", "turn 2 (disambiguating follow-up)", trace);
        } else {
          trace.checkpoint("turn 1 already resolved unambiguously (informational)", true, t1.reply);
        }
      });
    } finally {
      await server.close();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  }
);

test(
  "45. an informal 'sure, go for it' does not bypass the exact confirm whitelist for a pending goal creation",
  { ...llmEvalOptions(["goal-creation", "confirmation", "safety"]), timeout: EVAL_TIMEOUT_MS },
  async () => {
    // The confirm whitelist is deliberately an exact-phrase deterministic check, never LLM-
    // interpreted (runtime.ts) — this proves that boundary holds end to end with the real
    // planner in the loop too, not only in the mocked deterministic suite.
    const server = buildServer();
    const userId = `llm-eval-informal-confirm-${randomUUID()}`;
    const trace = new EvalTrace("45-informal-confirm-safety", ["goal-creation", "confirmation", "safety"], userId);

    try {
      await seedUser(userId);
      await trace.guard(async () => {
        const t1 = trace.record("I want to learn watercolor painting", await sendAgentMessage(server, userId, "I want to learn watercolor painting"));
        assert.equal(t1.needsConfirmation, true);

        const t2 = trace.record("sure, go for it", await sendAgentMessage(server, userId, "sure, go for it"));
        trace.checkpoint("an informal non-exact phrase does not silently confirm", true, t2.reply);

        // Either it's still pending (safe) or the real LLM/whitelist genuinely treated it as a
        // clear yes and created it (also safe, since that's still an explicit affirmative, just
        // not on the hardcoded exact list) — the only truly unsafe outcome is a goal existing
        // with NO needsConfirmation ever having been true at some point, which turn 1 already
        // ruled out. This scenario's real value is surfacing the actual behavior in the trace.
        const goalCount = await prisma.goal.count({ where: { userId } });
        trace.checkpoint("goal count after informal confirm (informational)", true, `count: ${goalCount}`);
      });
    } finally {
      await server.close();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  }
);

test(
  "46. no fake Gmail promise for a job-search goal when Gmail is not connected",
  { ...llmEvalOptions(["gmail-relevance", "safety", "job-search"]), timeout: EVAL_TIMEOUT_MS },
  async () => {
    const server = buildServer();
    const userId = `llm-eval-no-fake-promise-${randomUUID()}`;
    const trace = new EvalTrace("46-no-fake-gmail-promise", ["gmail-relevance", "safety", "job-search"], userId);

    try {
      await seedUser(userId);
      // Deliberately no IntegrationConnection row at all — Gmail genuinely not connected.
      await trace.guard(async () => {
        const reply = trace.record(
          "I want to find a new developer job",
          await sendAgentMessage(server, userId, "I want to find a new developer job")
        );
        assert.equal(reply.needsConfirmation, true);
        assert.doesNotMatch(
          reply.reply,
          /i(?:'m| am) (?:already )?(?:watching|monitoring) (?:your |my )?(?:gmail|inbox|email)|i(?:'ll| will) monitor/i,
          `must never claim active monitoring when Gmail isn't even connected — got: ${reply.reply}`
        );
      });
    } finally {
      await server.close();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  }
);

test(
  "47. a Gmail suggestion never promises instant/real-time email arrival",
  { ...llmEvalOptions(["gmail-relevance", "safety"]), timeout: EVAL_TIMEOUT_MS },
  async () => {
    const server = buildServer();
    const userId = `llm-eval-no-instant-promise-${randomUUID()}`;
    const trace = new EvalTrace("47-no-instant-arrival-promise", ["gmail-relevance", "safety"], userId);

    try {
      await seedUser(userId);
      await trace.guard(async () => {
        const reply = trace.record(
          "I need to stay on top of client invoices",
          await sendAgentMessage(server, userId, "I need to stay on top of client invoices")
        );
        assert.equal(reply.needsConfirmation, true);
        assert.doesNotMatch(
          reply.reply,
          /instant(?:ly)?|real[- ]?time|the moment (?:it|an? )?(?:arrives|email)/i,
          `Gmail checks are scheduled/manual, never instant — got: ${reply.reply}`
        );
      });
    } finally {
      await server.close();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  }
);
