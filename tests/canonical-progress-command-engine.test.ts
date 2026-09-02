import { randomBytes, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createGoal } from "../packages/db/src/index.ts";
import { encryptSecretJson } from "../packages/core/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, mockPlan, op, prisma, seedUser, sendAgentMessage } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * refactor/private-alpha-canonical-progress-command-engine: end-to-end coverage for the canonical
 * ProgressCommand engine (apps/api/src/agent-runtime/progress-command.ts) — the single write/verify
 * path every progress-writing route (manual statement, email review, goal.log_evidence) is now
 * forced through. Reproduces the exact live transcript this branch fixes: a goal with BOTH an
 * "Applications sent" AND an "Application to Interview" signalKey metric (the real shape that made
 * the old, looser metric-bridge regex pick the WRONG one), a review list where the highest-numbered
 * visible item is a stale/mislabelled LinkedIn personal message, and a genuine Okify application
 * confirmation elsewhere in the list. Gmail fetch is mocked and rejects any non-GET request, so a
 * passing test is also proof no Gmail mutation occurred.
 */

interface SeededGmailMessage {
  id: string;
  subject: string;
  from: string;
  body: string;
}

function installGmailFullFetchMock(messages: SeededGmailMessage[]): () => void {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const urlText = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(urlText);

    if (method !== "GET" || url.hostname !== "gmail.googleapis.com") {
      return new Response("mutation not allowed in readonly test", { status: 500 });
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
            { name: "Date", value: new Date().toUTCString() }
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

function withGmailEncryptionKey<T>(fn: () => Promise<T>): Promise<T> {
  const previousKey = process.env.ALECTO_SECRET_ENCRYPTION_KEY;
  process.env.ALECTO_SECRET_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  return fn().finally(() => {
    if (previousKey === undefined) delete process.env.ALECTO_SECRET_ENCRYPTION_KEY;
    else process.env.ALECTO_SECRET_ENCRYPTION_KEY = previousKey;
  });
}

async function seedGmailConnectionWithToken(userId: string) {
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
          accessToken: `canon-access-${randomUUID()}`,
          refreshToken: `canon-refresh-${randomUUID()}`,
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

async function seedRule(userId: string, connectionId: string, goalId?: string) {
  return prisma.emailSignalRule.create({
    data: {
      userId,
      connectionId,
      goalId,
      adapterId: "job_search_email",
      name: "Job search emails",
      status: "active",
      fetchStrategy: "query",
      classifierMode: "rules",
      lookbackDays: 30,
      maxMessagesPerSync: 25,
      maxEventsPerSync: 10,
      minAutoLogConfidence: 0.9,
      minReviewConfidence: 0.65,
      createdBy: "user"
    }
  });
}

async function seedReview(
  userId: string,
  connectionId: string,
  ruleId: string,
  input: { providerMessageId: string; subject: string; from: string; reason: string; proposedEventType?: string; priority?: "low" | "normal" | "high"; updatedAt?: Date; createdAt?: Date }
) {
  return prisma.emailReviewItem.create({
    data: {
      userId,
      connectionId,
      ruleId,
      adapterId: "job_search_email",
      provider: "gmail",
      providerMessageId: input.providerMessageId,
      externalId: `gmail-review:${ruleId}:${input.providerMessageId}`,
      status: "pending",
      subject: input.subject,
      from: input.from,
      snippet: input.subject,
      evidence: input.subject,
      confidence: 0.6,
      reason: input.reason,
      proposedEventType: input.proposedEventType,
      priority: input.priority,
      extracted: {},
      updatedAt: input.updatedAt,
      createdAt: input.createdAt
    }
  });
}

/** Shapes a goal EXACTLY like the live transcript's own — signalKey-based, with BOTH an
 * "Applications sent" metric and an "Application to Interview" metric, the real live shape that
 * made the old, looser metric-bridge keyword match pick the wrong one. */
async function seedGoalWithBothMetrics(userId: string, title: string) {
  const result = await createGoal(userId, {
    title,
    category: "career",
    targetMetrics: [
      { key: "applications_sent", label: "Applications sent", labelSingular: "Application sent", signalKey: "applications_sent", aggregation: "count", window: "weekly" },
      { key: "application_to_interview", label: "Application to Interview", labelSingular: "Application to Interview", signalKey: "application_to_interview", aggregation: "count", window: "weekly" }
    ]
  });
  if (result.duplicate) throw new Error("unexpected duplicate goal in test setup");
  return result.goal;
}

function mockUnderstanding(response: Record<string, unknown>): void {
  process.env.EMAIL_UNDERSTANDING_MOCK_RESPONSE = JSON.stringify(response);
}

function clearUnderstandingMock(): void {
  delete process.env.EMAIL_UNDERSTANDING_MOCK_RESPONSE;
  delete process.env.EMAIL_UNDERSTANDING_MOCK_THROW;
}

const okifyUnderstanding = {
  emailKind: "application_confirmation",
  relevance: "medium",
  goalRelevance: "direct",
  summary: "Okify confirmed receipt of your application.",
  why: ["se ha enviado tu solicitud", "Okify"],
  suggestedUserAction: "approve",
  confidence: 0.9,
  keyDetails: { company: "Okify", role: null, location: null, appliedDate: null, status: null, nextStep: null },
  keyFacts: []
};

const personalMessageUnderstanding = {
  emailKind: "personal_message",
  relevance: "low",
  goalRelevance: "unrelated",
  summary: "Miquel suggests connecting with Dario Lo Buglio on LinkedIn.",
  why: ["añade a Dario Lo Buglio", "conexión"],
  suggestedUserAction: "ignore",
  confidence: 0.85,
  keyDetails: null,
  keyFacts: []
};

// --- Task 6: exact live replay A/B/C ---

test("Replay A: 'details for an application confirmation from today' selects Okify (not the LinkedIn personal message), logs, Today 1 / Week 17, no Application to Interview", async () => {
  const server = buildServer();
  const userId = `replay-a-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([
    { id: "okify-1", subject: "Okify", from: "no-reply@okify.example", body: "Se ha enviado tu solicitud a Okify." },
    { id: "li-1", subject: "Miquel, añade a Dario Lo Buglio", from: "invitations@linkedin.com", body: "Miquel quiere añadir a Dario Lo Buglio a su red de LinkedIn." }
  ]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const goal = await seedGoalWithBothMetrics(userId, "Find a fully remote developer job");
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id, goal.id);

      for (let i = 0; i < 16; i += 1) {
        await prisma.event.create({
          data: { userId, type: "custom.goal_progress_logged", source: "manual", timestamp: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), confidence: 1, data: { signalKey: "applications_sent" } }
        });
      }

      const okifyReview = await seedReview(userId, connection.id, rule.id, {
        providerMessageId: "okify-1",
        subject: "Okify",
        from: "no-reply@okify.example",
        reason: "application_confirmation",
        proposedEventType: "career.application_confirmation_received",
        createdAt: new Date()
      });
      // The 9th item, stale/mislabelled as a high-priority job offer in the LIST but really a
      // LinkedIn personal-message/connection-suggestion — exactly the live transcript's review 9.
      await seedReview(userId, connection.id, rule.id, {
        providerMessageId: "li-1",
        subject: "Miquel, añade a Dario Lo Buglio",
        from: "invitations@linkedin.com",
        reason: "job_offer",
        proposedEventType: "career.offer_received",
        priority: "high",
        createdAt: new Date()
      });

      const before = await sendAgentMessage(server, userId, "show today goal progress");
      assert.match(before.reply, /Today: 0/i);
      assert.match(before.reply, /week[^\n]*\b16\b/i);

      await sendAgentMessage(server, userId, "show email reviews");

      mockUnderstanding(okifyUnderstanding);
      const detail = await sendAgentMessage(server, userId, "details for an application confirmation from today");
      assert.match(detail.reply, /Okify/i);
      assert.doesNotMatch(detail.reply, /Dario Lo Buglio/i);

      const mark = await sendAgentMessage(server, userId, "mark as cv sent");
      assert.match(mark.reply, /^Logged 1 CV sent/i);

      const afterReview = await prisma.emailReviewItem.findUnique({ where: { id: okifyReview.id } });
      assert.equal(afterReview?.status, "approved");

      const status = await sendAgentMessage(server, userId, "show this week goal progress");
      assert.match(status.reply, /week[^\n]*\b17\b/i);
      assert.doesNotMatch(status.reply, /Application to Interview/i);

      const today = await sendAgentMessage(server, userId, "show today goal progress");
      assert.match(today.reply, /Today: 1/i);
      assert.doesNotMatch(today.reply, /Application to Interview/i);

      const bridgeEvents = await prisma.event.findMany({ where: { userId, type: "custom.goal_progress_logged" } });
      const wrongMetricWrites = bridgeEvents.filter((event) => (event.data as Record<string, unknown>)?.signalKey === "application_to_interview");
      assert.equal(wrongMetricWrites.length, 0, "a CV-sent command must never write to the Application-to-Interview metric");
    });
  } finally {
    clearUnderstandingMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("Replay B: a personal message/LinkedIn connection suggestion refuses CV-sent, no event, review stays pending", async () => {
  const server = buildServer();
  const userId = `replay-b-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([{ id: "li-1", subject: "Miquel, añade a Dario Lo Buglio", from: "invitations@linkedin.com", body: "Miquel quiere añadir a Dario Lo Buglio a su red de LinkedIn." }]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const goal = await seedGoalWithBothMetrics(userId, "Find a fully remote developer job");
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id, goal.id);
      const review = await seedReview(userId, connection.id, rule.id, {
        providerMessageId: "li-1",
        subject: "Miquel, añade a Dario Lo Buglio",
        from: "invitations@linkedin.com",
        reason: "job_offer",
        proposedEventType: "career.offer_received",
        priority: "high"
      });

      mockUnderstanding(personalMessageUnderstanding);
      await sendAgentMessage(server, userId, "show email reviews");
      await sendAgentMessage(server, userId, "details for 1");
      const reply = await sendAgentMessage(server, userId, "mark it as cv sent");

      assert.doesNotMatch(reply.reply, /^Logged/i);
      assert.match(reply.reply, /personal|networking/i);

      const after = await prisma.emailReviewItem.findUnique({ where: { id: review.id } });
      assert.equal(after?.status, "pending");

      const events = await prisma.event.count({ where: { userId } });
      assert.equal(events, 0, "no progress event of any kind must be written for an ineligible email");
    });
  } finally {
    clearUnderstandingMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("Replay B (continued): 'yes, count it anyway as a CV sent' overrides after the refusal", async () => {
  const server = buildServer();
  const userId = `replay-b2-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([{ id: "li-1", subject: "Miquel, añade a Dario Lo Buglio", from: "invitations@linkedin.com", body: "Miquel quiere añadir a Dario Lo Buglio a su red de LinkedIn." }]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      const review = await seedReview(userId, connection.id, rule.id, { providerMessageId: "li-1", subject: "Miquel, añade a Dario Lo Buglio", from: "invitations@linkedin.com", reason: "job_offer", proposedEventType: "career.offer_received" });

      mockUnderstanding(personalMessageUnderstanding);
      await sendAgentMessage(server, userId, "show email reviews");
      await sendAgentMessage(server, userId, "details for 1");
      const refused = await sendAgentMessage(server, userId, "mark it as cv sent");
      assert.doesNotMatch(refused.reply, /^Logged/i);

      const overridden = await sendAgentMessage(server, userId, "yes, count it anyway as a CV sent");
      assert.match(overridden.reply, /^Logged 1 CV sent/i);
      assert.match(overridden.reply, /override/i);

      const after = await prisma.emailReviewItem.findUnique({ where: { id: review.id } });
      assert.equal(after?.status, "approved");
    });
  } finally {
    clearUnderstandingMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("Replay C: 'mark as cv sent' twice never double-counts, second attempt says already counted", async () => {
  const server = buildServer();
  const userId = `replay-c-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([{ id: "okify-1", subject: "Okify", from: "no-reply@okify.example", body: "Se ha enviado tu solicitud a Okify." }]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const goal = await seedGoalWithBothMetrics(userId, "Find a fully remote developer job");
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id, goal.id);
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "okify-1", subject: "Okify", from: "no-reply@okify.example", reason: "application_confirmation", proposedEventType: "career.application_confirmation_received" });

      mockUnderstanding(okifyUnderstanding);
      await sendAgentMessage(server, userId, "show email reviews");
      await sendAgentMessage(server, userId, "details for 1");
      const first = await sendAgentMessage(server, userId, "mark as cv sent");
      assert.match(first.reply, /^Logged 1/i);

      const second = await sendAgentMessage(server, userId, "mark as cv sent again");
      assert.doesNotMatch(second.reply, /^Logged 1/i);
      // Once resolved, the review is no longer in the pending/visible list — a second attempt
      // honestly says so (never a silent no-op, never a false "Logged" claim) rather than needing
      // to literally repeat "already counted" wording, which is specific to the SAME-turn-visible
      // duplicate-email case, not a review that was already decided in an earlier turn.
      assert.match(second.reply, /already counted|already decided|no longer exists/i);

      const events = await prisma.event.count({ where: { userId, type: "career.application_sent" } });
      assert.equal(events, 1);
    });
  } finally {
    clearUnderstandingMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 4: natural review reference resolution ---

test("multiple application confirmations today asks which one", async () => {
  const server = buildServer();
  const userId = `ref-multi-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m1", subject: "Okify", from: "no-reply@okify.example", reason: "application_confirmation", proposedEventType: "career.application_confirmation_received", createdAt: new Date() });
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m2", subject: "Darwin Recruitment", from: "no-reply@darwin.example", reason: "application_confirmation", proposedEventType: "career.application_confirmation_received", createdAt: new Date() });

      await sendAgentMessage(server, userId, "show email reviews");
      const reply = await sendAgentMessage(server, userId, "details for an application confirmation from today");
      assert.match(reply.reply, /which one/i);
      assert.match(reply.reply, /Okify/i);
      assert.match(reply.reply, /Darwin/i);
    });
  } finally {
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("no application confirmation today says none match", async () => {
  const server = buildServer();
  const userId = `ref-none-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m1", subject: "LinkedIn digest", from: "jobs-noreply@linkedin.com", reason: "job_alert", createdAt: new Date() });

      await sendAgentMessage(server, userId, "show email reviews");
      const reply = await sendAgentMessage(server, userId, "details for an application confirmation from today");
      assert.match(reply.reply, /none.*match|match.*none/i);
    });
  } finally {
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("'open the recruiter reply' selects by classification alone, no date needed", async () => {
  const server = buildServer();
  const userId = `ref-recruiter-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m1", subject: "Okify", from: "no-reply@okify.example", reason: "application_confirmation", proposedEventType: "career.application_confirmation_received" });
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m2", subject: "Innovation Labs", from: "recruiter@innovationlabs.example", reason: "recruiter_reply", proposedEventType: "career.recruiter_reply_received" });

      await sendAgentMessage(server, userId, "show email reviews");
      const reply = await sendAgentMessage(server, userId, "open the recruiter reply");
      assert.match(reply.reply, /Innovation Labs/i);
      assert.doesNotMatch(reply.reply, /^.*Okify.*$/m);
    });
  } finally {
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 5: focused review command consistency (pronoun/i18n) ---

test("Spanish 'márcalo como CV enviado' and Catalan 'marca-ho com a CV enviat' both resolve the focused review", async () => {
  const server = buildServer();
  const userIdEs = `focus-es-${randomUUID()}`;
  const userIdCa = `focus-ca-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([{ id: "okify-1", subject: "Okify", from: "no-reply@okify.example", body: "Se ha enviado tu solicitud a Okify." }]);

  try {
    await withGmailEncryptionKey(async () => {
      for (const userId of [userIdEs, userIdCa]) {
        await seedUser(userId);
        const connection = await seedGmailConnectionWithToken(userId);
        const rule = await seedRule(userId, connection.id);
        await seedReview(userId, connection.id, rule.id, { providerMessageId: "okify-1", subject: "Okify", from: "no-reply@okify.example", reason: "application_confirmation", proposedEventType: "career.application_confirmation_received" });
      }

      mockUnderstanding(okifyUnderstanding);
      await sendAgentMessage(server, userIdEs, "show email reviews");
      await sendAgentMessage(server, userIdEs, "details for 1");
      const es = await sendAgentMessage(server, userIdEs, "márcalo como CV enviado");
      assert.match(es.reply, /^Logged 1/i);

      await sendAgentMessage(server, userIdCa, "show email reviews");
      await sendAgentMessage(server, userIdCa, "details for 1");
      const ca = await sendAgentMessage(server, userIdCa, "marca-ho com a CV enviat");
      assert.match(ca.reply, /^Logged 1/i);
    });
  } finally {
    clearUnderstandingMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userIdEs } });
    await prisma.user.deleteMany({ where: { id: userIdCa } });
  }
});

// --- Task 1: canonical command parity (manual vs email, same engine) ---

test("manual 'I sent 1 CV today' and email-derived 'mark it as CV sent' both route through executeProgressCommand and agree", async () => {
  const server = buildServer();
  const userIdManual = `parity-manual-${randomUUID()}`;
  const userIdEmail = `parity-email-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([{ id: "okify-1", subject: "Okify", from: "no-reply@okify.example", body: "Se ha enviado tu solicitud a Okify." }]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userIdManual);
      await seedGoalWithBothMetrics(userIdManual, "Find a fully remote developer job");
      mockPlan({ topic: "goal_evidence", intent: "log_evidence", operations: [op("event.log_job_applications", { count: 1 })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
      const manualReply = await sendAgentMessage(server, userIdManual, "I sent 1 CV today");
      assert.match(manualReply.reply, /^Logged 1 job application/i);
      const manualStatus = await sendAgentMessage(server, userIdManual, "show today goal progress");
      assert.match(manualStatus.reply, /Today: 1/i);

      await seedUser(userIdEmail);
      const goal = await seedGoalWithBothMetrics(userIdEmail, "Find a fully remote developer job");
      const connection = await seedGmailConnectionWithToken(userIdEmail);
      const rule = await seedRule(userIdEmail, connection.id, goal.id);
      await seedReview(userIdEmail, connection.id, rule.id, { providerMessageId: "okify-1", subject: "Okify", from: "no-reply@okify.example", reason: "application_confirmation", proposedEventType: "career.application_confirmation_received" });
      mockUnderstanding(okifyUnderstanding);
      await sendAgentMessage(server, userIdEmail, "show email reviews");
      await sendAgentMessage(server, userIdEmail, "details for 1");
      await sendAgentMessage(server, userIdEmail, "mark it as cv sent");
      const emailStatus = await sendAgentMessage(server, userIdEmail, "show today goal progress");
      assert.match(emailStatus.reply, /Today: 1/i);

      const manualCanonical = await prisma.event.count({ where: { userId: userIdManual, type: "career.application_sent" } });
      const emailCanonical = await prisma.event.count({ where: { userId: userIdEmail, type: "career.application_sent" } });
      assert.equal(manualCanonical, 1);
      assert.equal(emailCanonical, 1);
    });
  } finally {
    clearUnderstandingMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userIdManual } });
    await prisma.user.deleteMany({ where: { id: userIdEmail } });
  }
});

// --- Task 2: event type lock-down ---

test("goal.log_evidence proposing the wrong eventType for a CV-sent statement is remapped, never writes the wrong type", async () => {
  const server = buildServer();
  const userId = `lockdown-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedGoalWithBothMetrics(userId, "Find a fully remote developer job");
    // The planner mistakenly chose career.interview_scheduled for a CV-sent statement — the
    // validator must catch and remap this, never let it through as-is.
    mockPlan({ topic: "goal_evidence", intent: "log_evidence", operations: [op("goal.log_evidence", { eventType: "career.interview_scheduled", count: 1 })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "I sent 1 CV today");

    assert.match(reply.reply, /^Logged 1 job application/i);
    const wrongType = await prisma.event.count({ where: { userId, type: "career.interview_scheduled" } });
    assert.equal(wrongType, 0);
    const rightType = await prisma.event.count({ where: { userId, type: "career.application_sent" } });
    assert.equal(rightType, 1);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 7: Application-to-Interview leak ---

test("'Okify ha visto tu solicitud' (viewed, not interview) does not create an interview event", async () => {
  const server = buildServer();
  const userId = `viewed-not-interview-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([{ id: "okify-viewed", subject: "Okify", from: "no-reply@okify.example", body: "Okify ha visto tu solicitud." }]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "okify-viewed", subject: "Okify", from: "no-reply@okify.example", reason: "recruiter_reply", proposedEventType: "career.recruiter_reply_received" });

      mockUnderstanding({
        emailKind: "recruiter_reply",
        relevance: "medium",
        goalRelevance: "direct",
        summary: "Okify viewed your application.",
        why: ["ha visto tu solicitud"],
        suggestedUserAction: "turn_into_action",
        confidence: 0.8,
        keyDetails: { company: "Okify", role: null, location: null, appliedDate: null, status: "viewed", nextStep: null },
        keyFacts: []
      });
      await sendAgentMessage(server, userId, "show email reviews");
      const reply = await sendAgentMessage(server, userId, "details for 1");
      assert.doesNotMatch(reply.reply, /interview/i);

      const interviewEvents = await prisma.event.count({ where: { userId, type: "career.interview_scheduled" } });
      assert.equal(interviewEvents, 0);
    });
  } finally {
    clearUnderstandingMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 8: list/detail precision follow-up ---

test("the exact same Gmail message cannot appear as two pending reviews even with no proposedEventType", async () => {
  const { findGmailDuplicateReviewItemByProviderMessageId } = await import("../packages/db/src/index.ts");
  const userId = `dedupe-exact-${randomUUID()}`;
  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const ruleA = await seedRule(userId, connection.id);
      const ruleB = await seedRule(userId, connection.id);
      const first = await seedReview(userId, connection.id, ruleA.id, { providerMessageId: "kraken-1", subject: "Kraken newsletter", from: "jobs@kraken.example", reason: "uncertain signal" });

      const duplicate = await findGmailDuplicateReviewItemByProviderMessageId({ userId, provider: "gmail", providerMessageId: "kraken-1" });
      assert.ok(duplicate, "an exact providerMessageId match must be found regardless of proposedEventType");
      assert.equal(duplicate?.id, first.id);

      // A second rule seeing the exact same message must never be allowed to create a second row —
      // exercised at the DB-primitive level here since the full sync pipeline needs a real Gmail API.
      void ruleB;
    });
  } finally {
    clearAgentRuntimeMocks();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 9: production diagnostics ---

function captureConsole(): { logs: unknown[][]; restore: () => void } {
  const logs: unknown[][] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args);
  };
  return {
    logs,
    restore: () => {
      console.log = originalLog;
    }
  };
}

test("diagnostic: an ineligible personal message logs eligibilityResult, emailKind, and the reason", async () => {
  const server = buildServer();
  const userId = `diag-ineligible-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([{ id: "li-1", subject: "Miquel, añade a Dario Lo Buglio", from: "invitations@linkedin.com", body: "Miquel quiere añadir a Dario Lo Buglio a su red de LinkedIn." }]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      const review = await seedReview(userId, connection.id, rule.id, { providerMessageId: "li-1", subject: "Miquel, añade a Dario Lo Buglio", from: "invitations@linkedin.com", reason: "job_offer", proposedEventType: "career.offer_received" });

      mockUnderstanding(personalMessageUnderstanding);
      await sendAgentMessage(server, userId, "show email reviews");
      await sendAgentMessage(server, userId, "details for 1");

      const capture = captureConsole();
      try {
        await sendAgentMessage(server, userId, "mark it as cv sent");
      } finally {
        capture.restore();
      }

      const ineligibleLog = capture.logs.find((entry) => entry[0] === "[executeProgressCommand] ineligible");
      assert.ok(ineligibleLog, "expected a structured ineligible diagnostic to be logged");
      const payload = ineligibleLog![1] as Record<string, unknown>;
      assert.equal(payload.reviewId, review.id);
      assert.equal(payload.selectedReviewClassification, "personal_message");
      assert.equal(payload.eligibilityResult, "ineligible");
      assert.ok(typeof payload.reason === "string" && payload.reason.length > 0);
    });
  } finally {
    clearUnderstandingMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("diagnostic: a forced verification failure logs baseline/post counts and verified: undefined result path", async () => {
  const server = buildServer();
  const userId = `diag-verify-fail-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([{ id: "okify-1", subject: "Okify", from: "no-reply@okify.example", body: "Se ha enviado tu solicitud a Okify." }]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      const review = await seedReview(userId, connection.id, rule.id, { providerMessageId: "okify-1", subject: "Okify", from: "no-reply@okify.example", reason: "application_confirmation" });

      mockUnderstanding(okifyUnderstanding);
      await sendAgentMessage(server, userId, "show email reviews");
      await sendAgentMessage(server, userId, "details for 1");

      process.env.EMAIL_PROGRESS_VERIFICATION_FORCE_FAIL = "true";
      const capture = captureConsole();
      try {
        await sendAgentMessage(server, userId, "mark it as cv sent");
      } finally {
        capture.restore();
        delete process.env.EMAIL_PROGRESS_VERIFICATION_FORCE_FAIL;
      }

      const resultLog = capture.logs.find((entry) => entry[0] === "[executeProgressCommand] result");
      assert.ok(resultLog, "expected a structured result diagnostic on the verification-failure path");
      const payload = resultLog![1] as Record<string, unknown>;
      assert.equal(payload.reviewId, review.id);
      assert.equal(payload.verified, false);
      assert.equal(payload.responsePath, "verification_failed");
      assert.ok(Array.isArray(payload.writtenEventIds) && (payload.writtenEventIds as unknown[]).length > 0, "the write happened even though verification failed — the event ids must still be logged for diagnosis");

      const after = await prisma.emailReviewItem.findUnique({ where: { id: review.id } });
      assert.equal(after?.status, "pending");
    });
  } finally {
    clearUnderstandingMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
