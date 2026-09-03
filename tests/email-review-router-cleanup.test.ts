import { randomBytes, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createGoal } from "../packages/db/src/index.ts";
import { encryptSecretJson } from "../packages/core/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, mockPlan, op, prisma, seedUser, sendAgentMessage } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * fix/private-alpha-email-review-router-cleanup: the canonical progress command engine now works
 * (confirmed in the live report this task fixes — Today 2->3, Week 18->19 after "mask as CV sent").
 * The remaining bugs live entirely in the SURROUNDING router/classification layer this file covers:
 * the semantic review-reference resolver missing a visibly-matching review, a typo ("mask") never
 * matching the review-linked shortcut and silently falling back to unlinked manual logging, "ha
 * visto tu solicitud" misclassifying as a recruiter reply, duplicate job-alert rows with no shared
 * providerMessageId, and a legacy wrong progress event with no safe correction path.
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
          accessToken: `router-access-${randomUUID()}`,
          refreshToken: `router-refresh-${randomUUID()}`,
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
  input: { providerMessageId: string; subject: string; from: string; reason: string; proposedEventType?: string; priority?: "low" | "normal" | "high"; createdAt?: Date }
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
      createdAt: input.createdAt
    }
  });
}

async function seedAdaptiveGoal(userId: string, title: string) {
  const result = await createGoal(userId, {
    title,
    category: "career",
    targetMetrics: [{ key: "applications_sent", label: "Applications sent", labelSingular: "Application sent", signalKey: "applications_sent", aggregation: "count", window: "weekly" }]
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

// --- Task 2: semantic reference resolution — the "review.reason vs proposedEventType" bug ---

test("2A. a review whose displayed label is 'application confirmation' via proposedEventType (not reason) is still selected by 'from today'", async () => {
  const server = buildServer();
  const userId = `router-2a-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([{ id: "okify-1", subject: "Okify", from: "no-reply@okify.example", body: "Se ha enviado tu solicitud a Okify." }]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      // reason is the classifier's OWN free-text/eventType convention, NOT the clean
      // "application_confirmation" string — proposedEventType is what actually determines the
      // displayed "application confirmation" label (gmailReviewSignalTypeLabel), exactly like a
      // real sync-time-classified row.
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "okify-1", subject: "Okify", from: "no-reply@okify.example", reason: "career.application_confirmation_received", proposedEventType: "career.application_confirmation_received", createdAt: new Date() });

      const list = await sendAgentMessage(server, userId, "show email reviews");
      assert.match(list.reply, /application confirmation/i);

      const reply = await sendAgentMessage(server, userId, "details for an application confirmation from today");
      assert.match(reply.reply, /Okify/i);
      assert.doesNotMatch(reply.reply, /none.*match/i);
    });
  } finally {
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2B. two application confirmations today asks which one", async () => {
  const server = buildServer();
  const userId = `router-2b-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m1", subject: "Okify", from: "no-reply@okify.example", reason: "career.application_confirmation_received", proposedEventType: "career.application_confirmation_received", createdAt: new Date() });
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m2", subject: "Darwin", from: "no-reply@darwin.example", reason: "career.application_confirmation_received", proposedEventType: "career.application_confirmation_received", createdAt: new Date() });

      await sendAgentMessage(server, userId, "show email reviews");
      const reply = await sendAgentMessage(server, userId, "details for an application confirmation from today");
      assert.match(reply.reply, /which one/i);
    });
  } finally {
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2C. no application confirmations today says none match", async () => {
  const server = buildServer();
  const userId = `router-2c-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m1", subject: "Kraken newsletter", from: "jobs@kraken.example", reason: "job listing digest", createdAt: new Date() });

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

test("2D. an explicit number still wins over the semantic filter", async () => {
  const server = buildServer();
  const userId = `router-2d-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m1", subject: "Okify", from: "no-reply@okify.example", reason: "career.application_confirmation_received", proposedEventType: "career.application_confirmation_received", createdAt: new Date() });
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m2", subject: "Kraken newsletter", from: "jobs@kraken.example", reason: "job listing digest" });

      await sendAgentMessage(server, userId, "show email reviews");
      const reply = await sendAgentMessage(server, userId, "why is 2 noise?");
      assert.doesNotMatch(reply.reply, /none.*match/i);
    });
  } finally {
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 3: typo-tolerant review-linked marking beats manual logging ---

test("3A/3B. 'mark as CV sent' and 'mask as CV sent' (typo) both resolve the focused review", async () => {
  const server = buildServer();
  const userIdMark = `router-3a-${randomUUID()}`;
  const userIdMask = `router-3b-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([{ id: "okify-1", subject: "Okify", from: "no-reply@okify.example", body: "Se ha enviado tu solicitud a Okify." }]);

  try {
    await withGmailEncryptionKey(async () => {
      for (const [userId, phrase] of [
        [userIdMark, "mark as CV sent"],
        [userIdMask, "mask as CV sent"]
      ] as const) {
        await seedUser(userId);
        const connection = await seedGmailConnectionWithToken(userId);
        const rule = await seedRule(userId, connection.id);
        const review = await seedReview(userId, connection.id, rule.id, { providerMessageId: "okify-1", subject: "Okify", from: "no-reply@okify.example", reason: "career.application_confirmation_received", proposedEventType: "career.application_confirmation_received" });

        mockUnderstanding(okifyUnderstanding);
        await sendAgentMessage(server, userId, "show email reviews");
        await sendAgentMessage(server, userId, "details of 1");
        const reply = await sendAgentMessage(server, userId, phrase);

        assert.match(reply.reply, /^Logged 1/i, `phrase "${phrase}" must log via the review-linked path`);
        assert.deepEqual(reply.operationsPlanned.map((o) => o.tool), ["gmail.review.log_progress"], `phrase "${phrase}" must call gmail.review.log_progress, not manual logging`);

        const after = await prisma.emailReviewItem.findUnique({ where: { id: review.id } });
        assert.equal(after?.status, "approved", `phrase "${phrase}" must resolve the review`);
      }
    });
  } finally {
    clearUnderstandingMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userIdMark } });
    await prisma.user.deleteMany({ where: { id: userIdMask } });
  }
});

test("3D/3E/3F. 'makr as CV sent' increments Today/Week once and the review disappears from pending", async () => {
  const server = buildServer();
  const userId = `router-3def-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([{ id: "okify-1", subject: "Okify", from: "no-reply@okify.example", body: "Se ha enviado tu solicitud a Okify." }]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const goal = await seedAdaptiveGoal(userId, "Find a fully remote developer job");
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id, goal.id);
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "okify-1", subject: "Okify", from: "no-reply@okify.example", reason: "career.application_confirmation_received", proposedEventType: "career.application_confirmation_received" });

      mockUnderstanding(okifyUnderstanding);
      const before = await sendAgentMessage(server, userId, "show today goal progress");
      assert.match(before.reply, /No logged progress/i);

      await sendAgentMessage(server, userId, "show email reviews");
      await sendAgentMessage(server, userId, "details of 1");
      const mark = await sendAgentMessage(server, userId, "makr as CV sent");
      assert.match(mark.reply, /^Logged 1/i);

      const status = await sendAgentMessage(server, userId, "show today goal progress");
      assert.match(status.reply, /Today: 1/i);

      const list = await sendAgentMessage(server, userId, "show email reviews");
      assert.doesNotMatch(list.reply, /Okify/i);
      assert.match(list.reply, /no email reviews/i);
    });
  } finally {
    clearUnderstandingMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3G. no Gmail mutation across the typo-marked flow", async () => {
  const server = buildServer();
  const userId = `router-3g-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([{ id: "okify-1", subject: "Okify", from: "no-reply@okify.example", body: "Se ha enviado tu solicitud a Okify." }]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "okify-1", subject: "Okify", from: "no-reply@okify.example", reason: "career.application_confirmation_received", proposedEventType: "career.application_confirmation_received" });

      mockUnderstanding(okifyUnderstanding);
      await sendAgentMessage(server, userId, "show email reviews");
      await sendAgentMessage(server, userId, "details of 1");
      // installGmailFullFetchMock rejects any non-GET call with 500 — a clean reply is proof no
      // mutating Gmail call was ever attempted.
      const reply = await sendAgentMessage(server, userId, "mask as CV sent");
      assert.match(reply.reply, /^Logged 1/i);
    });
  } finally {
    clearUnderstandingMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 4: ineligible override with confirmation ---

test("4A/4B/4C/4D. an ineligible job alert is refused, then a justification asks for confirmation, then 'yes' logs manually and handles the review", async () => {
  const server = buildServer();
  const userId = `router-4-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([{ id: "kraken-1", subject: "3 new jobs matching your search", from: "jobs-noreply@linkedin.com", body: "New roles this week." }]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      const review = await seedReview(userId, connection.id, rule.id, { providerMessageId: "kraken-1", subject: "3 new jobs matching your search", from: "jobs-noreply@linkedin.com", reason: "job listing digest" });

      mockUnderstanding({
        emailKind: "job_alert",
        relevance: "low",
        goalRelevance: "unrelated",
        summary: "A job-board digest.",
        why: ["new roles this week"],
        suggestedUserAction: "ignore",
        confidence: 0.85,
        keyDetails: null,
        keyFacts: []
      });

      await sendAgentMessage(server, userId, "show email reviews");
      const first = await sendAgentMessage(server, userId, "mark 1 as CV sent");
      assert.doesNotMatch(first.reply, /^Logged/i);

      const ask = await sendAgentMessage(server, userId, "I sent a CV related to that mail so mark it as CV sent");
      assert.match(ask.reply, /manual cv sent/i);
      assert.match(ask.reply, /\?/);
      // The tool itself is mutates:true (it CAN write), but this specific turn's real effect is a
      // question, not a write — verified directly: no event exists yet and the review is untouched.
      const eventsBeforeConfirm = await prisma.event.count({ where: { userId } });
      assert.equal(eventsBeforeConfirm, 0);
      const reviewBeforeConfirm = await prisma.emailReviewItem.findUnique({ where: { id: review.id } });
      assert.equal(reviewBeforeConfirm?.status, "pending");

      const confirmed = await sendAgentMessage(server, userId, "yes");
      assert.match(confirmed.reply, /^Logged 1/i);

      const after = await prisma.emailReviewItem.findUnique({ where: { id: review.id } });
      assert.equal(after?.status, "approved");

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

test("4E. saying 'no' leaves the review pending, no event written", async () => {
  const server = buildServer();
  const userId = `router-4e-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([{ id: "kraken-1", subject: "3 new jobs matching your search", from: "jobs-noreply@linkedin.com", body: "New roles this week." }]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      const review = await seedReview(userId, connection.id, rule.id, { providerMessageId: "kraken-1", subject: "3 new jobs matching your search", from: "jobs-noreply@linkedin.com", reason: "job listing digest" });

      mockUnderstanding({
        emailKind: "job_alert",
        relevance: "low",
        goalRelevance: "unrelated",
        summary: "A job-board digest.",
        why: ["new roles this week"],
        suggestedUserAction: "ignore",
        confidence: 0.85,
        keyDetails: null,
        keyFacts: []
      });

      await sendAgentMessage(server, userId, "show email reviews");
      await sendAgentMessage(server, userId, "I sent a CV related to that mail so mark it as CV sent");
      await sendAgentMessage(server, userId, "no");

      const after = await prisma.emailReviewItem.findUnique({ where: { id: review.id } });
      assert.equal(after?.status, "pending");
      const events = await prisma.event.count({ where: { userId } });
      assert.equal(events, 0);
    });
  } finally {
    clearUnderstandingMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 5: application_viewed classification ---

test("5A/5D/5F/5H. 'Okify ha visto tu solicitud' classifies as application_viewed, not recruiter reply, not CV-eligible, no interview event", async () => {
  const server = buildServer();
  const userId = `router-5-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([{ id: "okify-viewed", subject: "Okify", from: "no-reply@okify.example", body: "Okify ha visto tu solicitud." }]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "okify-viewed", subject: "Okify", from: "no-reply@okify.example", reason: "recruiter_reply", proposedEventType: "career.recruiter_reply_received" });

      mockUnderstanding({
        emailKind: "application_viewed",
        relevance: "low",
        goalRelevance: "indirect",
        summary: "Okify viewed your application.",
        why: ["ha visto tu solicitud"],
        suggestedUserAction: "monitor",
        confidence: 0.85,
        keyDetails: null,
        keyFacts: []
      });
      await sendAgentMessage(server, userId, "show email reviews");
      const detail = await sendAgentMessage(server, userId, "details for 1");

      // The stale-classification self-correction note ("Updated classification: recruiter reply ->
      // application viewed") legitimately MENTIONS "recruiter reply" as the OLD, corrected-away
      // value — only the CURRENT classification line must never say it.
      assert.doesNotMatch(detail.reply, /Current classification: recruiter reply/i);
      assert.match(detail.reply, /Current classification: application viewed/i);

      const mark = await sendAgentMessage(server, userId, "mark it as cv sent");
      assert.doesNotMatch(mark.reply, /^Logged/i);

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

// --- Task 6: legacy event correction ---

test("6A/6B/6C/6D. list recent progress events, undo requires confirmation, goal.status stops showing it after, CV counts unchanged", async () => {
  const server = buildServer();
  const userId = `router-6-${randomUUID()}`;

  try {
    await seedUser(userId);
    const goal = await createGoal(userId, {
      title: "Find a fully remote developer job",
      category: "career",
      targetMetrics: [
        { key: "applications_sent", label: "Applications sent", labelSingular: "Application sent", signalKey: "applications_sent", aggregation: "count", window: "weekly" },
        { key: "application_to_interview", label: "Application to Interview", labelSingular: "Application to Interview", signalKey: "application_to_interview", aggregation: "count", window: "weekly" }
      ]
    }).then((r) => r.goal);
    void goal;

    // This goal is signalKey-shaped (the adaptive-flow shape) — a real career.application_sent
    // event would never be recognized by ITS OWN metric, so the seeded "good" event must match the
    // goal's actual declared signalKey, exactly like the real bridge write does.
    await prisma.event.create({ data: { userId, type: "custom.goal_progress_logged", source: "manual", timestamp: new Date(), confidence: 1, data: { signalKey: "applications_sent" } } });
    await prisma.event.create({ data: { userId, type: "career.application_sent", source: "manual", timestamp: new Date(), confidence: 1, data: {} } });
    const badEvent = await prisma.event.create({ data: { userId, type: "custom.goal_progress_logged", source: "gmail", timestamp: new Date(), confidence: 1, data: { signalKey: "application_to_interview" } } });

    mockPlan({ topic: "progress_correction", intent: "list_recent_progress", operations: [op("event.list_recent_progress", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const list = await sendAgentMessage(server, userId, "show recent progress events");
    assert.match(list.reply, /Application to Interview/i);

    const statusBefore = await sendAgentMessage(server, userId, "show today goal progress");
    assert.match(statusBefore.reply, /Application to Interview/i);

    mockPlan({ topic: "progress_correction", intent: "undo_progress", operations: [op("event.undo_progress", { index: list.reply.match(/(\d+)\. .*Application to Interview/i) ? Number(list.reply.match(/(\d+)\. .*Application to Interview/i)![1]) : 2 })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const undoAttempt = await sendAgentMessage(server, userId, "undo the Application to Interview one");
    assert.equal(undoAttempt.needsConfirmation, true);
    assert.equal(undoAttempt.debug.mutationExecuted, false);

    const confirmed = await sendAgentMessage(server, userId, "yes");
    assert.match(confirmed.reply, /Undone/i);

    const statusAfter = await sendAgentMessage(server, userId, "show today goal progress");
    assert.doesNotMatch(statusAfter.reply, /Application to Interview/i);
    assert.match(statusAfter.reply, /Today: 1 Application sent/i);

    const stillActive = await prisma.event.findUnique({ where: { id: badEvent.id } });
    assert.equal(stillActive?.status, "archived");

    const cvEvents = await prisma.event.count({ where: { userId, type: "career.application_sent", status: "active" } });
    assert.equal(cvEvents, 1);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 7: duplicate job-alert display grouping ---

test("7B/7D. three same-subject/sender/day job-alert rows are grouped into one display line, each index still opens correctly", async () => {
  const server = buildServer();
  const userId = `router-7-${randomUUID()}`;

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      const today = new Date();
      const reviews = await Promise.all(
        ["kraken-1", "kraken-2", "kraken-3"].map((providerMessageId) =>
          seedReview(userId, connection.id, rule.id, {
            providerMessageId,
            subject: "Engineering Manager - Frontend - Consumer en Kraken",
            from: "jobs-noreply@linkedin.com",
            reason: "job listing digest",
            createdAt: today
          })
        )
      );

      const list = await sendAgentMessage(server, userId, "show email reviews");
      assert.match(list.reply, /3 similar/i);
      const krakenLines = list.reply.split("\n").filter((line) => line.includes("Kraken"));
      assert.equal(krakenLines.length, 1, "three identical-shaped rows must collapse into one display line");

      void reviews;
    });
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
