import { randomBytes, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { encryptSecretJson } from "../packages/core/src/index.ts";
import { createEvent, createGoal } from "../packages/db/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, mockPlan, op, prisma, seedUser, sendAgentMessage } from "./helpers/agent-runtime-test-helpers.ts";
import { minutesOfDayInTimezone } from "../apps/api/src/operator/proactive.ts";

/**
 * fix/private-alpha-gmail-proactive-highsignal-and-goal-association: closes the remaining
 * launch-readiness gaps found after the Gmail evidence sync/review branch — built-in job-search
 * rule goal association, proactive (morning/evening) surfacing of Gmail evidence, offer/interview
 * high-signal handling, the event/action boundary, manual-vs-Gmail progress reconciliation, the
 * enriched review queue, and status/sync-mode clarity. Reuses the same real seeded-mailbox
 * simulation style as agent-runtime-gmail-job-search-evidence.test.ts (the prior branch's own
 * deterministic suite) rather than duplicating a second mocking approach.
 */

// Computed off the REAL current date, not a fixed past/future one — the evening check-in scopes
// "Gmail events logged today" to an EXACT calendar-day match (formatDateInTimezone equality, not
// a rolling window), so a real "sync Gmail" call's real new Date() timestamp must land on the
// same calendar day these preview() calls ask about.
const TODAY_UTC_DATE = new Date().toISOString().slice(0, 10);
const MORNING_UTC = `${TODAY_UTC_DATE}T07:00:00.000Z`; // 09:00 Europe/Madrid
const EVENING_UTC = `${TODAY_UTC_DATE}T17:00:00.000Z`; // 19:00 Europe/Madrid

interface SeededGmailMessage {
  id: string;
  subject: string;
  from: string;
  body: string;
}

function installJobSearchGmailFetchMock(messages: SeededGmailMessage[]): () => void {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const urlText = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(urlText);

    if (method !== "GET" || url.hostname !== "gmail.googleapis.com") {
      return new Response("mutation not allowed in readonly Gmail sync test", { status: 500 });
    }

    if (url.pathname === "/gmail/v1/users/me/messages") {
      return new Response(JSON.stringify({ messages: messages.map((message) => ({ id: message.id })) }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    const messageId = url.pathname.split("/").pop() ?? "";
    const message = messages.find((candidate) => candidate.id === messageId);
    if (!message) {
      return new Response("not found", { status: 404 });
    }

    return new Response(
      JSON.stringify({
        id: message.id,
        threadId: `thread-${message.id}`,
        snippet: message.body.slice(0, 120),
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "Subject", value: message.subject },
            { name: "From", value: message.from },
            { name: "Date", value: "Thu, 20 Aug 2026 09:00:00 +0200" }
          ],
          body: { data: Buffer.from(message.body, "utf8").toString("base64url") }
        }
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  return () => {
    globalThis.fetch = previousFetch;
  };
}

async function seedGmailConnection(userId: string) {
  return prisma.integrationConnection.create({
    data: {
      userId,
      integrationId: "gmail",
      status: "active",
      config: {
        provider: "gmail",
        scope: "gmail.readonly",
        email: "letis@example.com",
        token: encryptSecretJson({
          accessToken: `hs-access-${randomUUID()}`,
          refreshToken: `hs-refresh-${randomUUID()}`,
          expiresAt: Date.now() + 3_600_000,
          tokenType: "Bearer",
          scope: "gmail.readonly"
        }),
        tokenStorage: "encrypted",
        hasRefreshToken: true
      }
    }
  });
}

/** Mirrors builtInGmailRuleDefaults("job_search") in apps/api/src/agent-runtime/executor.ts. */
async function seedBuiltInJobSearchRule(userId: string, connectionId: string, goalId?: string) {
  return prisma.emailSignalRule.create({
    data: {
      userId,
      connectionId,
      adapterId: "job_search_email",
      name: "Job search emails",
      query: "newer_than:30d",
      status: "active",
      fetchStrategy: "query",
      classifierMode: "rules",
      lookbackDays: 30,
      maxMessagesPerSync: 25,
      maxEventsPerSync: 10,
      minAutoLogConfidence: 0.9,
      minReviewConfidence: 0.65,
      reviewBeforeLogging: false,
      createdBy: "user",
      goalId
    }
  });
}

function jobSearchGoalInput(overrides: { title?: string } = {}) {
  return {
    title: overrides.title ?? "Find a fully remote developer job, ideally in Web3",
    category: "career",
    targetMetrics: [
      { key: "applications_sent_weekly", label: "Applications sent", labelSingular: "Application sent", eventType: "career.application_sent", aggregation: "count" as const, window: "weekly" as const },
      { key: "recruiter_replies_weekly", label: "Recruiter replies", labelSingular: "Recruiter reply", eventType: "career.recruiter_reply_received", aggregation: "count" as const, window: "weekly" as const }
    ]
  };
}

async function seedNotificationSettings(userId: string) {
  await prisma.notificationSettings.create({
    data: { userId, dailyLoopEnabled: true, morningTimeMinutes: 540, eveningTimeMinutes: 1140, timezone: "Europe/Madrid" }
  });
}

async function preview(server: ReturnType<typeof buildServer>, userId: string, nowIso: string) {
  const response = await server.inject({ method: "GET", url: `/users/${userId}/operator/proactive/preview?now=${encodeURIComponent(nowIso)}` });
  assert.equal(response.statusCode, 200, `preview for ${userId} returned ${response.statusCode}: ${response.body}`);
  return response.json().decision as
    | { decision: "proposed_message"; type: string; title: string; message: string; reasons: string[]; suggestedReplies: string[]; dedupeKey: string; priority: number; safeToSend: boolean }
    | { decision: "no_message"; reason: string };
}

function withGmailEnv<T>(fn: () => Promise<T>): Promise<T> {
  const previousKey = process.env.ALECTO_SECRET_ENCRYPTION_KEY;
  process.env.ALECTO_SECRET_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  return fn().finally(() => {
    if (previousKey === undefined) delete process.env.ALECTO_SECRET_ENCRYPTION_KEY;
    else process.env.ALECTO_SECRET_ENCRYPTION_KEY = previousKey;
  });
}

// --- Task 1: built-in job-search rule goal association ---

test("1A. enabling the built-in job-search rule with exactly one active job-search goal links it automatically", async () => {
  const server = buildServer();
  const userId = `hs-goalassoc-a-${randomUUID()}`;

  try {
    await seedUser(userId);
    await prisma.integrationConnection.create({ data: { userId, integrationId: "gmail", status: "active", config: {} } });
    const goalResult = await createGoal(userId, jobSearchGoalInput());
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");

    const reply = await sendAgentMessage(server, userId, "enable job search rule for Gmail");
    assert.match(reply.reply, /job.search/i);
    assert.match(reply.reply, new RegExp(`Linked to your "${goalResult.goal.title}" goal`, "i"));

    const rule = await prisma.emailSignalRule.findFirst({ where: { userId, adapterId: "job_search_email", status: "active" } });
    assert.equal(rule?.goalId, goalResult.goal.id, "the built-in rule must be linked to the single unambiguous active job-search goal");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("1B. enabling the built-in job-search rule with no job-search goal creates it unlinked, never a fake association", async () => {
  const server = buildServer();
  const userId = `hs-goalassoc-b-${randomUUID()}`;

  try {
    await seedUser(userId);
    await prisma.integrationConnection.create({ data: { userId, integrationId: "gmail", status: "active", config: {} } });

    const reply = await sendAgentMessage(server, userId, "enable job search rule for Gmail");
    assert.match(reply.reply, /job.search/i);
    assert.doesNotMatch(reply.reply, /Linked to your/i);

    const rule = await prisma.emailSignalRule.findFirst({ where: { userId, adapterId: "job_search_email", status: "active" } });
    assert.equal(rule?.goalId, null, "no goal exists to link — must stay unlinked, not guess");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("1C. two candidate job-search goals with no clear focus: the rule is created but left unlinked, never guessed", async () => {
  const server = buildServer();
  const userId = `hs-goalassoc-c-${randomUUID()}`;

  try {
    await seedUser(userId);
    await prisma.integrationConnection.create({ data: { userId, integrationId: "gmail", status: "active", config: {} } });
    const first = await createGoal(userId, jobSearchGoalInput({ title: "Find a remote developer job" }));
    const second = await createGoal(userId, jobSearchGoalInput({ title: "Land a recruiter interview at a Web3 startup" }));
    if (first.duplicate || second.duplicate) throw new Error("unexpected duplicate goal in test setup");

    const reply = await sendAgentMessage(server, userId, "enable job search rule for Gmail");
    assert.match(reply.reply, /job.search/i);
    assert.doesNotMatch(reply.reply, /Linked to your/i, "must never silently pick one of two ambiguous candidates");

    const rule = await prisma.emailSignalRule.findFirst({ where: { userId, adapterId: "job_search_email", status: "active" } });
    assert.equal(rule?.goalId, null);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("1D. an existing built-in rule with no stored goalId still resolves to the single active job-search goal for status/proactive use", async () => {
  const server = buildServer();
  const userId = `hs-goalassoc-d-${randomUUID()}`;

  try {
    await seedUser(userId);
    const connection = await prisma.integrationConnection.create({ data: { userId, integrationId: "gmail", status: "active", config: {} } });
    // Simulates a rule created BEFORE this feature existed, or before any goal existed — no
    // stored goalId, exactly the real-world gap this task reports.
    await seedBuiltInJobSearchRule(userId, connection.id);
    const goalResult = await createGoal(userId, jobSearchGoalInput());
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");

    // refactor/private-alpha-goal-driven-gmail-operator (Task 7): status is goal-first now — a
    // resolved goal shows as the group's own label ("- <goal title>: on — watches ..."), not a
    // "linked to X" suffix on a raw rule line.
    const status = await sendAgentMessage(server, userId, "gmail status");
    assert.match(status.reply, new RegExp(`- ${goalResult.goal.title}: on`, "i"), "the live single-candidate fallback must resolve the link even without a stored goalId");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 10: end-to-end proactive + Gmail integration matrix ---

test("10A. manual sync finds a recruiter reply: shows in progress, morning brief, and is available to next-action coaching", async () => {
  await withGmailEnv(async () => {
    const server = buildServer();
    const userId = `hs-matrix-a-${randomUUID()}`;
    const restore = installJobSearchGmailFetchMock([
      {
        id: "hs-a-recruiter",
        subject: "Quick chat about the frontend role",
        from: "Jordi (Recruiter) <jordi@acme.example>",
        body: "Hi, I'm a recruiter from Acme Corp. Are you available for a quick call this week to discuss the Frontend Engineer role?"
      }
    ]);

    try {
      await seedUser(userId);
      await seedNotificationSettings(userId);
      const goalResult = await createGoal(userId, jobSearchGoalInput());
      if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
      const connection = await seedGmailConnection(userId);
      await seedBuiltInJobSearchRule(userId, connection.id, goalResult.goal.id);

      const sync = await sendAgentMessage(server, userId, "sync Gmail");
      assert.match(sync.reply, /recruiter reply/i);
      assert.equal(await prisma.event.count({ where: { userId, source: "gmail", type: "career.recruiter_reply_received" } }), 1);

      mockPlan({ topic: "goals", intent: "goal_status", operations: [op("goal.status", { goalRef: "job" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
      const progress = await sendAgentMessage(server, userId, "show progress on job search");
      assert.match(progress.reply, /1 Recruiter reply/);

      const morning = await preview(server, userId, MORNING_UTC);
      assert.equal(morning.decision, "proposed_message");
      if (morning.decision === "proposed_message") {
        assert.match(morning.message, /Gmail \(already logged, not in your review queue\): recruiter reply/i);
        assert.match(morning.message, /Worth following up today/i);
      }

      // fix/private-alpha-gmail-review-quality-and-dedupe (Task 8): a real live-testing report —
      // the proactive summary named an item ("Jordi (Recruiter)" here) that was NOT in the visible
      // "show me" review list, because it auto-logged directly rather than sitting pending. The
      // summary copy above now says so explicitly ("already logged, not in your review queue"), so
      // this is no longer a silent scope mismatch — confirmed here by checking "show me" really has
      // nothing pending for this already-logged item.
      const reviews = await sendAgentMessage(server, userId, "show me email reviews");
      assert.doesNotMatch(reviews.reply, /Jordi/i);
      assert.equal(await prisma.emailReviewItem.count({ where: { userId, status: "pending" } }), 0);
    } finally {
      restore();
      clearAgentRuntimeMocks();
      await server.close();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });
});

test("10B/10C. manual sync finds an ambiguous email and an offer: morning brief surfaces both, offer as high-priority", async () => {
  await withGmailEnv(async () => {
    const server = buildServer();
    const userId = `hs-matrix-bc-${randomUUID()}`;
    const restore = installJobSearchGmailFetchMock([
      {
        id: "hs-bc-ambiguous",
        subject: "Application update needed",
        from: "Acme Careers <careers@acme.example>",
        body: "Action required: please complete your application for the Backend Engineer role at Acme within 48 hours or it will be discarded."
      },
      {
        id: "hs-bc-offer",
        subject: "Job offer from Acme",
        from: "Acme Careers <careers@acme.example>",
        body: "We are excited to offer you the role of Backend Engineer. Please find the compensation package details attached."
      }
    ]);

    try {
      await seedUser(userId);
      await seedNotificationSettings(userId);
      const goalResult = await createGoal(userId, jobSearchGoalInput());
      if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
      const connection = await seedGmailConnection(userId);
      await seedBuiltInJobSearchRule(userId, connection.id, goalResult.goal.id);

      await sendAgentMessage(server, userId, "sync Gmail");
      assert.equal(await prisma.emailReviewItem.count({ where: { userId, status: "pending" } }), 2);

      const morning = await preview(server, userId, MORNING_UTC);
      assert.equal(morning.decision, "proposed_message");
      if (morning.decision === "proposed_message") {
        assert.match(morning.message, /High-priority Gmail signal: possible offer/i);
        assert.match(morning.message, /Review it today/i);
        assert.match(morning.message, /1 Gmail item needs review before I log it\./i);
      }
    } finally {
      restore();
      clearAgentRuntimeMocks();
      await server.close();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });
});

test("10D / 4G. repeating the exact same sync never duplicates the event, review, or the morning-brief mention", async () => {
  await withGmailEnv(async () => {
    const server = buildServer();
    const userId = `hs-matrix-d-${randomUUID()}`;
    const restore = installJobSearchGmailFetchMock([
      {
        id: "hs-d-offer",
        subject: "Job offer from Acme",
        from: "Acme Careers <careers@acme.example>",
        body: "We are excited to offer you the role of Backend Engineer. Please find the compensation package details attached."
      }
    ]);

    try {
      await seedUser(userId);
      await seedNotificationSettings(userId);
      const goalResult = await createGoal(userId, jobSearchGoalInput());
      if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
      const connection = await seedGmailConnection(userId);
      await seedBuiltInJobSearchRule(userId, connection.id, goalResult.goal.id);

      await sendAgentMessage(server, userId, "sync Gmail");
      await sendAgentMessage(server, userId, "sync Gmail");

      assert.equal(await prisma.emailReviewItem.count({ where: { userId } }), 1, "no duplicate review from the repeat sync");
      assert.equal(await prisma.event.count({ where: { userId, source: "gmail" } }), 0, "an offer must never auto-log even after a repeat sync");

      const morning = await preview(server, userId, MORNING_UTC);
      assert.equal(morning.decision, "proposed_message");
      if (morning.decision === "proposed_message") {
        const occurrences = morning.message.match(/High-priority Gmail signal/g) ?? [];
        assert.equal(occurrences.length, 1, "the same pending offer must be mentioned once, not once per sync");
      }
    } finally {
      restore();
      clearAgentRuntimeMocks();
      await server.close();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });
});

test("10E. a built-in rule with no stored goalId still surfaces in the morning brief once a single active job-search goal exists", async () => {
  await withGmailEnv(async () => {
    const server = buildServer();
    const userId = `hs-matrix-e-${randomUUID()}`;
    const restore = installJobSearchGmailFetchMock([
      {
        id: "hs-e-recruiter",
        subject: "Quick chat about the frontend role",
        from: "Jordi (Recruiter) <jordi@acme.example>",
        body: "Hi, I'm a recruiter from Acme Corp. Are you available for a quick call this week to discuss the Frontend Engineer role?"
      }
    ]);

    try {
      await seedUser(userId);
      await seedNotificationSettings(userId);
      const connection = await seedGmailConnection(userId);
      // No goalId passed — simulates a rule that predates goal association, or was created with
      // multiple/zero candidates and left unlinked at the time.
      await seedBuiltInJobSearchRule(userId, connection.id);
      const goalResult = await createGoal(userId, jobSearchGoalInput());
      if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");

      await sendAgentMessage(server, userId, "sync Gmail");

      const morning = await preview(server, userId, MORNING_UTC);
      assert.equal(morning.decision, "proposed_message");
      if (morning.decision === "proposed_message") {
        assert.match(morning.message, /Gmail \(already logged, not in your review queue\): recruiter reply/i, "the live fallback must resolve the unlinked rule to the one active job-search goal");
      }
    } finally {
      restore();
      clearAgentRuntimeMocks();
      await server.close();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });
});

test("10F. no active job-search goal: a pending Gmail review is still surfaced via gmail_nudge, never a fake goal link", async () => {
  const server = buildServer();
  const userId = `hs-matrix-f-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedNotificationSettings(userId);
    const connection = await prisma.integrationConnection.create({ data: { userId, integrationId: "gmail", status: "active", config: {} } });
    const rule = await seedBuiltInJobSearchRule(userId, connection.id);
    await prisma.emailReviewItem.create({
      data: {
        userId,
        connectionId: connection.id,
        ruleId: rule.id,
        adapterId: "job_search_email",
        provider: "gmail",
        providerMessageId: "hs-f-review",
        externalId: `gmail-review:${rule.id}:hs-f-review`,
        subject: "Recruiter reply from Example Labs",
        from: "recruiter@example.com",
        snippet: "Can we talk tomorrow?",
        confidence: 0.9,
        reason: "rule_classification",
        extracted: {},
        status: "pending"
      }
    });

    const morning = await preview(server, userId, MORNING_UTC);
    // No active goal at all -> the goal-anchor nudge, never a fabricated goal-linked Gmail line.
    assert.equal(morning.decision, "proposed_message");
    if (morning.decision === "proposed_message") {
      assert.doesNotMatch(morning.message, /Gmail item needs review|Gmail \(already logged|High-priority Gmail signal/i);
    }

    const midday = await preview(server, userId, "2026-08-20T11:00:00.000Z");
    assert.equal(midday.decision, "proposed_message");
    if (midday.decision === "proposed_message") {
      assert.equal(midday.type, "gmail_nudge", "the review is still visible via gmail_nudge — goal-agnostic by design");
    }
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("10G / Task 6: a manually logged CV send and a later Gmail confirmation never double-count", async () => {
  await withGmailEnv(async () => {
    const server = buildServer();
    const userId = `hs-matrix-g-${randomUUID()}`;
    const restore = installJobSearchGmailFetchMock([
      {
        id: "hs-g-confirmation",
        subject: "Thanks for applying to Acme",
        from: "Acme Careers <careers@acme.example>",
        body: "Thanks for applying to Acme for the Backend Engineer role. We have received your application and our team will review it soon."
      }
    ]);

    try {
      await seedUser(userId);
      await seedNotificationSettings(userId);
      const goalResult = await createGoal(userId, jobSearchGoalInput());
      if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
      const connection = await seedGmailConnection(userId);
      await seedBuiltInJobSearchRule(userId, connection.id, goalResult.goal.id);

      // "I sent 1 CV today" — a manual log, real career.application_sent event.
      await createEvent(userId, {
        type: "career.application_sent",
        timestamp: new Date(),
        source: "manual",
        data: { company: "Acme" },
        confidence: 1,
        evidence: ["manually logged"]
      });

      await sendAgentMessage(server, userId, "sync Gmail");
      assert.equal(await prisma.event.count({ where: { userId, source: "gmail", type: "career.application_confirmation_received" } }), 1);
      assert.equal(await prisma.event.count({ where: { userId, source: "manual", type: "career.application_sent" } }), 1);

      mockPlan({ topic: "goals", intent: "goal_status", operations: [op("goal.status", { goalRef: "job" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
      const progress = await sendAgentMessage(server, userId, "show progress on job search");
      assert.match(progress.reply, /1 Application sent/i);
      assert.doesNotMatch(progress.reply, /2 Application/i, "the Gmail confirmation must never inflate the manually-logged applications-sent count");
    } finally {
      restore();
      clearAgentRuntimeMocks();
      await server.close();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });
});

test("10H. the same HTTP sync route the scheduled worker uses produces identical evidence to a manual sync", async () => {
  await withGmailEnv(async () => {
    const server = buildServer();
    const userId = `hs-matrix-h-${randomUUID()}`;
    const restore = installJobSearchGmailFetchMock([
      {
        id: "hs-h-recruiter",
        subject: "Quick chat about the frontend role",
        from: "Jordi (Recruiter) <jordi@acme.example>",
        body: "Hi, I'm a recruiter from Acme Corp. Are you available for a quick call this week to discuss the Frontend Engineer role?"
      }
    ]);

    try {
      await seedUser(userId);
      const connection = await seedGmailConnection(userId);
      await seedBuiltInJobSearchRule(userId, connection.id);

      // apps/worker/src/integration-sync.ts's scheduled tick posts to this exact route — calling
      // it directly is a faithful stand-in for "scheduled sync ran," without needing to drive the
      // real worker's setInterval loop end to end.
      const response = await server.inject({ method: "POST", url: `/users/${userId}/integrations/${connection.id}/sync`, payload: {} });
      assert.equal(response.statusCode, 200, response.body);

      const events = await prisma.event.findMany({ where: { userId, source: "gmail", type: "career.recruiter_reply_received" } });
      assert.equal(events.length, 1);
      assert.equal((events[0].data as Record<string, unknown>).gmailMessageId, "hs-h-recruiter");
    } finally {
      restore();
      clearAgentRuntimeMocks();
      await server.close();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });
});

// --- Task 3: evening check-in Gmail surfacing ---

test("3A/3B. evening check-in mentions Gmail events logged today and pending review", async () => {
  await withGmailEnv(async () => {
    const server = buildServer();
    const userId = `hs-evening-ab-${randomUUID()}`;
    const restore = installJobSearchGmailFetchMock([
      {
        id: "hs-eve-recruiter",
        subject: "Quick chat about the frontend role",
        from: "Jordi (Recruiter) <jordi@acme.example>",
        body: "Hi, I'm a recruiter from Acme Corp. Are you available for a quick call this week to discuss the Frontend Engineer role?"
      },
      {
        id: "hs-eve-ambiguous",
        subject: "Application update needed",
        from: "Acme Careers <careers@acme.example>",
        body: "Action required: please complete your application for the Backend Engineer role at Acme within 48 hours or it will be discarded."
      }
    ]);

    try {
      await seedUser(userId);
      await seedNotificationSettings(userId);
      const goalResult = await createGoal(userId, jobSearchGoalInput());
      if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
      const connection = await seedGmailConnection(userId);
      await seedBuiltInJobSearchRule(userId, connection.id, goalResult.goal.id);

      await sendAgentMessage(server, userId, "sync Gmail");

      // fix/private-alpha-launch-hardening-flakes-and-pending-clarity: EVENING_UTC (a UTC instant
      // built from a UTC date string captured once at module load) used to drift from the real
      // event this "sync Gmail" call just created — the sync stamps its event with a genuinely
      // real `new Date()` (server.ts's Gmail classification pipeline has no injectable clock), and
      // the evening check-in's "logged today" filter compares calendar days in the user's
      // configured Europe/Madrid timezone, not UTC. Whenever the real run happens to fall in the
      // ~1-2 hour band where Madrid has already rolled to the next calendar day but UTC hasn't
      // (22:00-24:00 UTC in summer CEST, 23:00-24:00 UTC in winter CET), the module-load-time
      // TODAY_UTC_DATE and the sync's real event timestamp land on different Madrid calendar days,
      // so the just-created event silently fails the "today" filter. Fixed by capturing "now" ONCE
      // here — immediately after the sync that needs to count as "today" — and reusing that exact
      // instant for both the evening-window schedule (via minutesOfDayInTimezone, the same
      // Madrid-aware helper the product code itself uses) and the preview's own `now`, so the two
      // are always the same real moment rather than a stale snapshot compared against a fresh one.
      const now = new Date();
      await prisma.notificationSettings.update({ where: { userId }, data: { eveningTimeMinutes: minutesOfDayInTimezone(now, "Europe/Madrid") } });

      const evening = await preview(server, userId, now.toISOString());
      assert.equal(evening.decision, "proposed_message");
      if (evening.decision === "proposed_message") {
        assert.match(evening.message, /Gmail \(already logged, not in your review queue\): recruiter reply/i);
        assert.match(evening.message, /1 Gmail item needs review before I log it\./i);
      }
    } finally {
      restore();
      clearAgentRuntimeMocks();
      await server.close();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });
});

test("3C. no Gmail noise in the evening check-in when there is nothing new and no other reason to send", async () => {
  const server = buildServer();
  const userId = `hs-evening-c-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedNotificationSettings(userId);
    const goalResult = await createGoal(userId, jobSearchGoalInput());
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
    // A trackable metric already logged today means the base evening check-in has nothing to
    // ask about either — isolates "no gmail signals" as the only variable.
    await createEvent(userId, {
      type: "career.recruiter_reply_received",
      timestamp: new Date(`${TODAY_UTC_DATE}T16:00:00.000Z`),
      source: "manual",
      data: {},
      confidence: 1,
      evidence: ["manual"]
    });

    const evening = await preview(server, userId, EVENING_UTC);
    assert.equal(evening.decision, "no_message");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3E. a Gmail event mentioned in the evening check-in is not double-counted in goal progress", async () => {
  await withGmailEnv(async () => {
    const server = buildServer();
    const userId = `hs-evening-e-${randomUUID()}`;
    const restore = installJobSearchGmailFetchMock([
      {
        id: "hs-eve-e-recruiter",
        subject: "Quick chat about the frontend role",
        from: "Jordi (Recruiter) <jordi@acme.example>",
        body: "Hi, I'm a recruiter from Acme Corp. Are you available for a quick call this week to discuss the Frontend Engineer role?"
      }
    ]);

    try {
      await seedUser(userId);
      await seedNotificationSettings(userId);
      const goalResult = await createGoal(userId, jobSearchGoalInput());
      if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
      const connection = await seedGmailConnection(userId);
      await seedBuiltInJobSearchRule(userId, connection.id, goalResult.goal.id);

      await sendAgentMessage(server, userId, "sync Gmail");
      await preview(server, userId, EVENING_UTC);
      await preview(server, userId, EVENING_UTC);

      assert.equal(await prisma.event.count({ where: { userId, source: "gmail", type: "career.recruiter_reply_received" } }), 1, "previewing twice must never create or duplicate an event");
    } finally {
      restore();
      clearAgentRuntimeMocks();
      await server.close();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });
});

// --- Task 7: review queue improvements ---

test("7A/7E/7F. the review list shows signal type, high-priority marker, source, date, and linked goal", async () => {
  await withGmailEnv(async () => {
    const server = buildServer();
    const userId = `hs-reviewqueue-${randomUUID()}`;
    const restore = installJobSearchGmailFetchMock([
      {
        id: "hs-rq-offer",
        subject: "Job offer from Acme",
        from: "Acme Careers <careers@acme.example>",
        body: "We are excited to offer you the role of Backend Engineer. Please find the compensation package details attached."
      }
    ]);

    try {
      await seedUser(userId);
      const goalResult = await createGoal(userId, jobSearchGoalInput());
      if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
      const connection = await seedGmailConnection(userId);
      await seedBuiltInJobSearchRule(userId, connection.id, goalResult.goal.id);

      await sendAgentMessage(server, userId, "sync Gmail");
      const list = await sendAgentMessage(server, userId, "show Gmail reviews");

      assert.match(list.reply, /\[High priority\]/);
      assert.match(list.reply, /job offer/i);
      assert.match(list.reply, /Gmail,/);
      assert.match(list.reply, new RegExp(`linked to "${goalResult.goal.title}"`, "i"));
    } finally {
      restore();
      clearAgentRuntimeMocks();
      await server.close();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });
});

// --- Task 8: Gmail status and sync-mode clarity ---

test("8A/8B/8C. gmail status shows linked goal, manual-only cadence, and pending review count", async () => {
  await withGmailEnv(async () => {
    const server = buildServer();
    const userId = `hs-status-${randomUUID()}`;
    const restore = installJobSearchGmailFetchMock([
      {
        id: "hs-status-ambiguous-1",
        subject: "Application update needed",
        from: "Acme Careers <careers@acme.example>",
        body: "Action required: please complete your application for the Backend Engineer role at Acme within 48 hours or it will be discarded."
      },
      {
        id: "hs-status-ambiguous-2",
        subject: "Please confirm to continue",
        from: "Acme Careers <careers@acme.example>",
        body: "Action required: please finish your application to Acme for the Data Engineer role within 48 hours or it will be discarded."
      }
    ]);

    try {
      await seedUser(userId);
      const goalResult = await createGoal(userId, jobSearchGoalInput());
      if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
      const connection = await seedGmailConnection(userId);
      await seedBuiltInJobSearchRule(userId, connection.id, goalResult.goal.id);

      await sendAgentMessage(server, userId, "sync Gmail");
      const status = await sendAgentMessage(server, userId, "gmail status");

      // refactor/private-alpha-goal-driven-gmail-operator (Task 7): status is goal-first — the
      // resolved goal is the group's own label now, not a "linked to X" suffix.
      assert.match(status.reply, new RegExp(`- ${goalResult.goal.title}: on`, "i"));
      assert.match(status.reply, /Pending reviews: 2\./);
      assert.match(status.reply, /Alecto checks Gmail when you say 'sync Gmail'\./);
      assert.match(status.reply, /Last synced:/);
    } finally {
      restore();
      clearAgentRuntimeMocks();
      await server.close();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });
});
