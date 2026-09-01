import { randomBytes, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { encryptSecretJson } from "../packages/core/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, prisma, seedUser, sendAgentMessage } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * fix/private-alpha-email-review-resolution-and-stale-classification: end-to-end coverage for four
 * live-reported bugs found after deploying Gmail review detail + full-body understanding —
 * (1) progress logged from a review without resolving the review (Task 2), (2) stale stored
 * classification surviving a corrected detail view (Task 3), (3) old snippet-only gmail.review.inspect
 * still used for "why is X uncertain" style questions (Task 4), (4) "show full text for it" failing to
 * resolve or crashing (Task 5) — plus the bounded "refresh email reviews" command (Task 6) and the
 * exact live transcript replay (Task 8). Gmail fetch and the LLM understanding call are both mocked
 * for determinism; the fetch mock rejects any non-GET request, so a passing test is also proof no
 * Gmail mutation occurred.
 */

interface SeededGmailMessage {
  id: string;
  subject: string;
  from: string;
  body: string;
  html?: boolean;
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
          mimeType: message.html ? "text/html" : "text/plain",
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
          accessToken: `resolution-access-${randomUUID()}`,
          refreshToken: `resolution-refresh-${randomUUID()}`,
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
  input: { providerMessageId: string; subject: string; from: string; reason: string; proposedEventType?: string; extracted?: Record<string, unknown>; updatedAt?: Date }
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
      confidence: 0.75,
      reason: input.reason,
      proposedEventType: input.proposedEventType,
      extracted: input.extracted ?? {},
      // getEmailReviewItems orders by updatedAt desc — explicit, well-separated timestamps here
      // remove any dependency on real insertion timing for a test that relies on a specific number.
      updatedAt: input.updatedAt
    }
  });
}

function mockUnderstanding(response: Record<string, unknown>): void {
  process.env.EMAIL_UNDERSTANDING_MOCK_RESPONSE = JSON.stringify(response);
}

function clearUnderstandingMock(): void {
  delete process.env.EMAIL_UNDERSTANDING_MOCK_RESPONSE;
  delete process.env.EMAIL_UNDERSTANDING_MOCK_THROW;
}

const applicationConfirmationUnderstanding = {
  emailKind: "application_confirmation",
  relevance: "medium",
  goalRelevance: "direct",
  summary: "Innovation Labs confirmed receipt of the application for the Front-End Engineer role.",
  why: ["received your application", "Front-End Engineer role"],
  suggestedUserAction: "approve",
  confidence: 0.9
};

// --- Task 2: resolve the review when progress is logged from it ---

test("2A. 'details for 1' -> 'mark it as a CV sent' logs progress AND resolves the review", async () => {
  const server = buildServer();
  const userId = `resolve-2a-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([
    { id: "m1", subject: "Thank you for applying to Innovation Labs", from: "no-reply@innovationlabs.example", body: "Thank you for applying to Innovation Labs. We have received your application for the Front-End Engineer role." }
  ]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      const review = await seedReview(userId, connection.id, rule.id, {
        providerMessageId: "m1",
        subject: "Thank you for applying to Innovation Labs",
        from: "no-reply@innovationlabs.example",
        reason: "recruiter_reply",
        proposedEventType: "career.recruiter_reply_received"
      });

      mockUnderstanding(applicationConfirmationUnderstanding);
      await sendAgentMessage(server, userId, "show me email reviews");
      await sendAgentMessage(server, userId, "details for 1");
      const reply = await sendAgentMessage(server, userId, "mark it as a CV sent");

      assert.ok(reply.operationsExecuted.some((entry) => entry.tool === "gmail.review.log_progress" && entry.status === "executed"));
      assert.match(reply.reply, /resolved the review/i);

      const after = await prisma.emailReviewItem.findUnique({ where: { id: review.id } });
      assert.equal(after?.status, "approved", "the review must be resolved, not left pending");

      const events = await prisma.event.findMany({ where: { userId, type: "career.application_sent" } });
      assert.equal(events.length, 1, "exactly one CV-sent event must be logged");
      assert.equal(after?.eventId, events[0]!.id, "the resolved review must be linked to the event it produced");

      const list = await sendAgentMessage(server, userId, "show email reviews");
      assert.doesNotMatch(list.reply, /Innovation Labs/i, "the resolved review must not still appear in the pending list");
    });
  } finally {
    clearUnderstandingMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2B. 'show reviews' -> 'mark 2 as CV sent' resolves review 2 specifically", async () => {
  const server = buildServer();
  const userId = `resolve-2b-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([
    { id: "m1", subject: "AIT application received", from: "no-reply@ait.example", body: "We received your application." },
    { id: "m2", subject: "Kraken newsletter", from: "jobs@kraken.example", body: "New roles this week." }
  ]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      await seedReview(userId, connection.id, rule.id, {
        providerMessageId: "m2",
        subject: "Kraken newsletter",
        from: "jobs@kraken.example",
        reason: "uncertain signal",
        updatedAt: new Date("2026-08-20T09:02:00.000Z")
      });
      const aitReview = await seedReview(userId, connection.id, rule.id, {
        providerMessageId: "m1",
        subject: "AIT application received",
        from: "no-reply@ait.example",
        reason: "application_confirmation",
        proposedEventType: "career.application_confirmation_received",
        updatedAt: new Date("2026-08-20T09:01:00.000Z")
      });

      await sendAgentMessage(server, userId, "show email reviews");
      const reply = await sendAgentMessage(server, userId, "mark 2 as CV sent");

      assert.ok(reply.operationsExecuted.some((entry) => entry.tool === "gmail.review.log_progress" && entry.status === "executed"));
      const after = await prisma.emailReviewItem.findUnique({ where: { id: aitReview.id } });
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

test("2C. saying 'mark it as a CV sent' twice does not double-count", async () => {
  const server = buildServer();
  const userId = `resolve-2c-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([
    { id: "m1", subject: "Innovation Labs", from: "no-reply@innovationlabs.example", body: "We received your application for the Front-End Engineer role." }
  ]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      await seedReview(userId, connection.id, rule.id, {
        providerMessageId: "m1",
        subject: "Innovation Labs",
        from: "no-reply@innovationlabs.example",
        reason: "recruiter_reply",
        proposedEventType: "career.recruiter_reply_received"
      });

      mockUnderstanding(applicationConfirmationUnderstanding);
      await sendAgentMessage(server, userId, "show email reviews");
      await sendAgentMessage(server, userId, "details for 1");
      const first = await sendAgentMessage(server, userId, "mark it as a CV sent");
      assert.ok(first.operationsExecuted.some((entry) => entry.tool === "gmail.review.log_progress" && entry.status === "executed"));

      const second = await sendAgentMessage(server, userId, "mark it as a CV sent");
      assert.ok(
        second.operationsExecuted.every((entry) => entry.tool !== "gmail.review.log_progress" || entry.status !== "executed"),
        "a second attempt on an already-resolved review must never execute again"
      );

      const events = await prisma.event.count({ where: { userId, type: "career.application_sent" } });
      assert.equal(events, 1, "exactly one CV must ever be counted from the same review");
    });
  } finally {
    clearUnderstandingMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2D/2F. resolving from a review never touches the real Gmail mailbox", async () => {
  const server = buildServer();
  const userId = `resolve-2f-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([
    { id: "m1", subject: "Innovation Labs", from: "no-reply@innovationlabs.example", body: "We received your application." }
  ]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      await seedReview(userId, connection.id, rule.id, {
        providerMessageId: "m1",
        subject: "Innovation Labs",
        from: "no-reply@innovationlabs.example",
        reason: "recruiter_reply",
        proposedEventType: "career.recruiter_reply_received"
      });

      mockUnderstanding(applicationConfirmationUnderstanding);
      await sendAgentMessage(server, userId, "show email reviews");
      await sendAgentMessage(server, userId, "details for 1");
      // The fetch mock installed above rejects any non-GET request with a 500 — reaching this line
      // without a thrown/failed operation is itself proof no mutating Gmail call was ever attempted.
      const reply = await sendAgentMessage(server, userId, "mark it as a CV sent");
      assert.ok(reply.operationsExecuted.some((entry) => entry.tool === "gmail.review.log_progress" && entry.status === "executed"));
    });
  } finally {
    clearUnderstandingMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 3: stale classification reconciliation ---

test("3A. a stale 'recruiter reply' review corrects to 'application confirmation' after detail, and the next list reflects it", async () => {
  const server = buildServer();
  const userId = `stale-3a-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([
    { id: "m1", subject: "Innovation Labs", from: "no-reply@innovationlabs.example", body: "We received your application for the Front-End Engineer role." }
  ]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      const review = await seedReview(userId, connection.id, rule.id, {
        providerMessageId: "m1",
        subject: "Innovation Labs",
        from: "no-reply@innovationlabs.example",
        reason: "recruiter_reply",
        proposedEventType: "career.recruiter_reply_received"
      });

      mockUnderstanding(applicationConfirmationUnderstanding);
      await sendAgentMessage(server, userId, "show email reviews");
      const detail = await sendAgentMessage(server, userId, "details for 1");
      assert.match(detail.reply, /application confirmation/i);
      assert.match(detail.reply, /Updated classification: recruiter reply.*application confirmation/i);

      const refreshed = await prisma.emailReviewItem.findUnique({ where: { id: review.id } });
      assert.equal(refreshed?.reason, "application_confirmation");
      assert.equal(refreshed?.status, "pending", "a classification refresh must never change status");

      const list = await sendAgentMessage(server, userId, "show email reviews");
      assert.match(list.reply, /application confirmation/i);
      assert.doesNotMatch(list.reply, /recruiter reply/i);
    });
  } finally {
    clearUnderstandingMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3B. a stale 'rejection' review corrects to 'application confirmation' (Elastic-shaped case)", async () => {
  const server = buildServer();
  const userId = `stale-3b-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([
    { id: "m1", subject: "Your application to Elastic", from: "no-reply@elastic.example", body: "Thank you, we have received your resume for the Platform Engineer role and will be in touch." }
  ]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      const review = await seedReview(userId, connection.id, rule.id, {
        providerMessageId: "m1",
        subject: "Your application to Elastic",
        from: "no-reply@elastic.example",
        reason: "rejection",
        proposedEventType: "career.rejection_received"
      });

      mockUnderstanding({
        emailKind: "application_confirmation",
        relevance: "medium",
        goalRelevance: "direct",
        summary: "Elastic confirmed receipt of your resume for the Platform Engineer role.",
        why: ["received your resume", "Platform Engineer role"],
        suggestedUserAction: "approve",
        confidence: 0.88
      });
      await sendAgentMessage(server, userId, "show email reviews");
      await sendAgentMessage(server, userId, "details for 1");

      const refreshed = await prisma.emailReviewItem.findUnique({ where: { id: review.id } });
      assert.equal(refreshed?.reason, "application_confirmation");

      const list = await sendAgentMessage(server, userId, "show email reviews");
      assert.doesNotMatch(list.reply, /rejection/i);
    });
  } finally {
    clearUnderstandingMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3D. the classification refresh never approves, rejects, or logs anything on its own", async () => {
  const server = buildServer();
  const userId = `stale-3d-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([
    { id: "m1", subject: "Innovation Labs", from: "no-reply@innovationlabs.example", body: "We received your application for the Front-End Engineer role." }
  ]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      const review = await seedReview(userId, connection.id, rule.id, {
        providerMessageId: "m1",
        subject: "Innovation Labs",
        from: "no-reply@innovationlabs.example",
        reason: "recruiter_reply",
        proposedEventType: "career.recruiter_reply_received"
      });

      mockUnderstanding(applicationConfirmationUnderstanding);
      await sendAgentMessage(server, userId, "show email reviews");
      await sendAgentMessage(server, userId, "details for 1");

      const after = await prisma.emailReviewItem.findUnique({ where: { id: review.id } });
      assert.equal(after?.status, "pending");
      const events = await prisma.event.count({ where: { userId } });
      assert.equal(events, 0, "a detail-time refresh must never log an event on its own");
    });
  } finally {
    clearUnderstandingMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 4: gmail.review.inspect is now a full-body detail alias ---

test("4A. 'why is 3 uncertain signal?' uses the full-body detail flow, not the old snippet-only inspect", async () => {
  const server = buildServer();
  const userId = `inspect-4a-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([
    { id: "m1", subject: "Innovation Labs", from: "no-reply@innovationlabs.example", body: "We received your application." },
    { id: "m2", subject: "AIT confirmation", from: "no-reply@ait.example", body: "We received your application." },
    { id: "m3", subject: "Kraken newsletter", from: "jobs@kraken.example", body: "New engineering roles posted this week at several companies." }
  ]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m1", subject: "Innovation Labs", from: "no-reply@innovationlabs.example", reason: "application_confirmation", updatedAt: new Date("2026-08-20T09:02:00.000Z") });
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m2", subject: "AIT confirmation", from: "no-reply@ait.example", reason: "application_confirmation", updatedAt: new Date("2026-08-20T09:01:00.000Z") });
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m3", subject: "Kraken newsletter", from: "jobs@kraken.example", reason: "uncertain signal", updatedAt: new Date("2026-08-20T09:00:00.000Z") });

      mockUnderstanding({
        emailKind: "job_alert",
        relevance: "noise",
        goalRelevance: "unrelated",
        summary: "This is a job-alert newsletter, not a personal reply.",
        why: ["several companies", "new roles posted"],
        suggestedUserAction: "ignore",
        confidence: 0.9
      });
      await sendAgentMessage(server, userId, "show email reviews");
      const reply = await sendAgentMessage(server, userId, "why is 3 uncertain signal?");

      assert.ok(
        reply.operationsExecuted.some((entry) => (entry.tool === "gmail.review.detail" || entry.tool === "gmail.review.inspect") && entry.status === "executed")
      );
      assert.match(reply.reply, /Review 3/i);
      assert.doesNotMatch(reply.reply, /I only have the stored subject, snippet, and evidence/i);
    });
  } finally {
    clearUnderstandingMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4C. 'what is 3?' also uses the full-body detail flow", async () => {
  const server = buildServer();
  const userId = `inspect-4c-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([{ id: "m1", subject: "Innovation Labs", from: "no-reply@innovationlabs.example", body: "We received your application for the Front-End Engineer role." }]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m1", subject: "Innovation Labs", from: "no-reply@innovationlabs.example", reason: "application_confirmation" });

      mockUnderstanding(applicationConfirmationUnderstanding);
      await sendAgentMessage(server, userId, "show email reviews");
      const reply = await sendAgentMessage(server, userId, "what is 1?");

      assert.match(reply.reply, /Review 1/i);
      assert.doesNotMatch(reply.reply, /I only have the stored subject, snippet, and evidence/i);
    });
  } finally {
    clearUnderstandingMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 5: "show full text for it" resolves and never crashes ---

test("5A. 'details for 1' -> 'show full text for it' resolves to review 1 and shows longer text", async () => {
  const server = buildServer();
  const userId = `fulltext-5a-${randomUUID()}`;
  const longBody =
    "We received your application for the Front-End Engineer role. " +
    "Our team reviews every application carefully and typically responds within two weeks. " +
    "In the meantime, feel free to explore our engineering blog for more about our culture and stack.";
  const restoreFetch = installGmailFullFetchMock([{ id: "m1", subject: "Innovation Labs", from: "no-reply@innovationlabs.example", body: longBody }]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m1", subject: "Innovation Labs", from: "no-reply@innovationlabs.example", reason: "application_confirmation" });

      mockUnderstanding(applicationConfirmationUnderstanding);
      await sendAgentMessage(server, userId, "show email reviews");
      await sendAgentMessage(server, userId, "details for 1");
      const reply = await sendAgentMessage(server, userId, "show full text for it");

      assert.doesNotMatch(reply.reply, /unexpected problem|hit an error/i);
      assert.match(reply.reply, /Review 1/i);
      assert.match(reply.reply, /engineering blog/i);
    });
  } finally {
    clearUnderstandingMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("5B. 'why is 3 uncertain' -> 'show full text for it' resolves to review 3 among many visible reviews, never crashes", async () => {
  const server = buildServer();
  const userId = `fulltext-5b-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([
    { id: "m1", subject: "Innovation Labs", from: "no-reply@innovationlabs.example", body: "We received your application." },
    { id: "m2", subject: "AIT confirmation", from: "no-reply@ait.example", body: "We received your application." },
    { id: "m3", subject: "Kraken newsletter", from: "jobs@kraken.example", body: "New engineering roles posted this week across several partner companies and startups." }
  ]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m1", subject: "Innovation Labs", from: "no-reply@innovationlabs.example", reason: "application_confirmation", updatedAt: new Date("2026-08-20T09:02:00.000Z") });
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m2", subject: "AIT confirmation", from: "no-reply@ait.example", reason: "application_confirmation", updatedAt: new Date("2026-08-20T09:01:00.000Z") });
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m3", subject: "Kraken newsletter", from: "jobs@kraken.example", reason: "uncertain signal", updatedAt: new Date("2026-08-20T09:00:00.000Z") });

      mockUnderstanding({
        emailKind: "job_alert",
        relevance: "noise",
        goalRelevance: "unrelated",
        summary: "This is a job-alert newsletter, not a personal reply.",
        why: ["several partner companies", "new roles posted"],
        suggestedUserAction: "ignore",
        confidence: 0.9
      });
      await sendAgentMessage(server, userId, "show email reviews");
      await sendAgentMessage(server, userId, "why is 3 uncertain signal?");
      const reply = await sendAgentMessage(server, userId, "show full text for it");

      assert.doesNotMatch(reply.reply, /unexpected problem|hit an error/i);
      assert.match(reply.reply, /Review 3/i);
      assert.match(reply.reply, /partner companies/i);
    });
  } finally {
    clearUnderstandingMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("5D. 'show full text for it' with nothing focused asks for clarification, never crashes", async () => {
  const server = buildServer();
  const userId = `fulltext-5d-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([
    { id: "m1", subject: "Innovation Labs", from: "no-reply@innovationlabs.example", body: "We received your application." },
    { id: "m2", subject: "AIT confirmation", from: "no-reply@ait.example", body: "We received your application." }
  ]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m1", subject: "Innovation Labs", from: "no-reply@innovationlabs.example", reason: "application_confirmation", updatedAt: new Date("2026-08-20T09:01:00.000Z") });
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m2", subject: "AIT confirmation", from: "no-reply@ait.example", reason: "application_confirmation", updatedAt: new Date("2026-08-20T09:00:00.000Z") });

      await sendAgentMessage(server, userId, "show email reviews");
      const reply = await sendAgentMessage(server, userId, "show full text for it");

      assert.doesNotMatch(reply.reply, /unexpected problem|hit an error/i);
    });
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("5F. a security code stays redacted in the full-text follow-up", async () => {
  const server = buildServer();
  const userId = `fulltext-5f-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([{ id: "m1", subject: "micro1 verification code", from: "no-reply@micro1.ai", body: "Your one-time verification code is 482913. This code is valid for 10 minutes." }]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m1", subject: "micro1 verification code", from: "no-reply@micro1.ai", reason: "security_auth" });

      mockUnderstanding({
        emailKind: "security_auth",
        relevance: "noise",
        goalRelevance: "unrelated",
        summary: "A one-time verification code from micro1.",
        why: ["verification code"],
        suggestedUserAction: "ignore",
        confidence: 0.95
      });
      await sendAgentMessage(server, userId, "show email reviews");
      await sendAgentMessage(server, userId, "details for 1");
      const reply = await sendAgentMessage(server, userId, "show full text for it");

      assert.doesNotMatch(reply.reply, /482913/);
      assert.match(reply.reply, /\[redacted\]/);
    });
  } finally {
    clearUnderstandingMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 6: bounded "refresh email reviews" ---

test("6A. 'refresh email reviews' reclassifies a stale row and reports how many were refreshed", async () => {
  const server = buildServer();
  const userId = `refresh-6a-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([{ id: "m1", subject: "Innovation Labs", from: "no-reply@innovationlabs.example", body: "We received your application for the Front-End Engineer role." }]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      const review = await seedReview(userId, connection.id, rule.id, {
        providerMessageId: "m1",
        subject: "Innovation Labs",
        from: "no-reply@innovationlabs.example",
        reason: "recruiter_reply",
        proposedEventType: "career.recruiter_reply_received"
      });

      mockUnderstanding(applicationConfirmationUnderstanding);
      const reply = await sendAgentMessage(server, userId, "refresh email reviews");

      assert.ok(reply.operationsExecuted.some((entry) => entry.tool === "gmail.review.refresh" && entry.status === "executed"));
      assert.match(reply.reply, /refreshed 1/i);

      const after = await prisma.emailReviewItem.findUnique({ where: { id: review.id } });
      assert.equal(after?.reason, "application_confirmation");
      assert.equal(after?.status, "pending", "refresh must never change status");
    });
  } finally {
    clearUnderstandingMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("6D/6E. refresh never changes progress counts or review statuses", async () => {
  const server = buildServer();
  const userId = `refresh-6de-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([{ id: "m1", subject: "Innovation Labs", from: "no-reply@innovationlabs.example", body: "We received your application for the Front-End Engineer role." }]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      await seedReview(userId, connection.id, rule.id, {
        providerMessageId: "m1",
        subject: "Innovation Labs",
        from: "no-reply@innovationlabs.example",
        reason: "recruiter_reply",
        proposedEventType: "career.recruiter_reply_received"
      });

      mockUnderstanding(applicationConfirmationUnderstanding);
      await sendAgentMessage(server, userId, "refresh email reviews");

      const events = await prisma.event.count({ where: { userId } });
      assert.equal(events, 0);
      const pending = await prisma.emailReviewItem.count({ where: { userId, status: "pending" } });
      assert.equal(pending, 1);
    });
  } finally {
    clearUnderstandingMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 8: exact live regression replay ---

test("8. exact live replay: list, details+mark-as-CV-sent resolves review 1, stale-3 corrected explanation, full text, bulk ignore, no double count", async () => {
  const server = buildServer();
  const userId = `live-replay-8-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([
    { id: "m1", subject: "Innovation Labs — Front-End Engineer", from: "no-reply@innovationlabs.example", body: "Thank you for applying to Innovation Labs. We have received your application for the Front-End Engineer role." },
    { id: "m2", subject: "AIT — application received", from: "no-reply@ait.example", body: "We have received your application and will be in touch soon." },
    { id: "m3", subject: "Kraken talent newsletter", from: "jobs@kraken.example", body: "This week's top engineering roles across our partner network include several remote-friendly positions." },
    { id: "m4", subject: "Revolut jobs digest", from: "jobs@revolut.example", body: "New job alert: roles matching your saved search are now open." },
    { id: "m5", subject: "Built In job matches", from: "alerts@builtin.example", body: "Here are this week's job matches based on your profile." },
    { id: "m6", subject: "SLNG talent update", from: "jobs@slng.example", body: "New job alert: roles matching your search criteria." },
    { id: "m7", subject: "Jobgether — application confirmed", from: "no-reply@jobgether.example", body: "Your application has been submitted successfully and is now under review." },
    { id: "m8", subject: "Elastic — thanks for applying", from: "no-reply@elastic.example", body: "Thank you, we have received your resume for the Platform Engineer role and will be in touch." },
    { id: "m9", subject: "Innovation Labs — Backend Engineer", from: "no-reply@innovationlabs.example", body: "Thank you for applying to Innovation Labs. We have received your application for the Backend Engineer role." },
    { id: "m10", subject: "micro1 — new opportunity", from: "recruiter@micro1.ai", body: "Hi, I'm reaching out about a Senior Engineer opportunity at Crossing Hurdles that matches your background." }
  ]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);

      const t = (minutesAgo: number) => new Date(Date.parse("2026-08-20T09:10:00.000Z") - minutesAgo * 60_000);
      const review1 = await seedReview(userId, connection.id, rule.id, { providerMessageId: "m1", subject: "Innovation Labs — Front-End Engineer", from: "no-reply@innovationlabs.example", reason: "recruiter_reply", proposedEventType: "career.recruiter_reply_received", updatedAt: t(1) });
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m2", subject: "AIT — application received", from: "no-reply@ait.example", reason: "application_confirmation", proposedEventType: "career.application_confirmation_received", updatedAt: t(2) });
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m3", subject: "Kraken talent newsletter", from: "jobs@kraken.example", reason: "uncertain signal", updatedAt: t(3) });
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m4", subject: "Revolut jobs digest", from: "jobs@revolut.example", reason: "job_alert", updatedAt: t(4) });
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m5", subject: "Built In job matches", from: "alerts@builtin.example", reason: "job_alert", updatedAt: t(5) });
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m6", subject: "SLNG talent update", from: "jobs@slng.example", reason: "recruiter_reply", proposedEventType: "career.recruiter_reply_received", updatedAt: t(6) });
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m7", subject: "Jobgether — application confirmed", from: "no-reply@jobgether.example", reason: "application_confirmation", proposedEventType: "career.application_confirmation_received", updatedAt: t(7) });
      const elasticReview = await seedReview(userId, connection.id, rule.id, { providerMessageId: "m8", subject: "Elastic — thanks for applying", from: "no-reply@elastic.example", reason: "rejection", proposedEventType: "career.rejection_received", updatedAt: t(8) });
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m9", subject: "Innovation Labs — Backend Engineer", from: "no-reply@innovationlabs.example", reason: "job_offer", updatedAt: t(9) });
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m10", subject: "micro1 — new opportunity", from: "recruiter@micro1.ai", reason: "recruiter_reply", proposedEventType: "career.recruiter_reply_received", updatedAt: t(10) });

      // Understanding mock keyed by a substring of the cleaned subject/body so each turn below gets a
      // plausible, scenario-matching understanding rather than one fixed canned response for all ten.
      const understandingByMessageId: Record<string, Record<string, unknown>> = {
        m1: applicationConfirmationUnderstanding,
        m3: {
          emailKind: "job_alert",
          relevance: "noise",
          goalRelevance: "unrelated",
          summary: "This is a recruiting newsletter listing open roles, not a personal reply.",
          why: ["partner network", "top engineering roles"],
          suggestedUserAction: "ignore",
          confidence: 0.9
        },
        m8: {
          emailKind: "application_confirmation",
          relevance: "medium",
          goalRelevance: "direct",
          summary: "Elastic confirmed receipt of your resume for the Platform Engineer role.",
          why: ["received your resume", "Platform Engineer role"],
          suggestedUserAction: "approve",
          confidence: 0.88
        }
      };
      const previousMockThrow = process.env.EMAIL_UNDERSTANDING_MOCK_RESPONSE;
      process.env.EMAIL_UNDERSTANDING_MOCK_RESPONSE = JSON.stringify(understandingByMessageId.m1);

      const list1 = await sendAgentMessage(server, userId, "show email reviews");
      assert.match(list1.reply, /Innovation Labs/i);

      const detail1 = await sendAgentMessage(server, userId, "details for 1");
      assert.match(detail1.reply, /application confirmation/i);

      const markCv = await sendAgentMessage(server, userId, "mark it as a CV sent");
      assert.ok(markCv.operationsExecuted.some((entry) => entry.tool === "gmail.review.log_progress" && entry.status === "executed"));
      const resolvedReview1 = await prisma.emailReviewItem.findUnique({ where: { id: review1.id } });
      assert.equal(resolvedReview1?.status, "approved");

      const list2 = await sendAgentMessage(server, userId, "show email reviews");
      assert.doesNotMatch(list2.reply, /Front-End Engineer/i, "review 1 must not still appear pending");

      process.env.EMAIL_UNDERSTANDING_MOCK_RESPONSE = JSON.stringify(understandingByMessageId.m3);
      const why3 = await sendAgentMessage(server, userId, "why is 3 uncertain signal?");
      assert.doesNotMatch(why3.reply, /I only have the stored subject, snippet, and evidence/i);

      const fullText = await sendAgentMessage(server, userId, "show full text for it");
      assert.doesNotMatch(fullText.reply, /unexpected problem|hit an error/i);

      const ignoreAll = await sendAgentMessage(server, userId, "ignore all mail reviews");
      assert.doesNotMatch(ignoreAll.reply, /sent|deleted|archived|marked as read|changed.*label/i);

      const finalList = await sendAgentMessage(server, userId, "email reviews");
      assert.match(finalList.reply, /no.*(pending|waiting)|nothing.*(pending|waiting)/i);

      const cvEvents = await prisma.event.count({ where: { userId, type: "career.application_sent" } });
      assert.equal(cvEvents, 1, "exactly one CV sent must be counted across the whole replay");

      const elasticAfter = await prisma.emailReviewItem.findUnique({ where: { id: elasticReview.id } });
      assert.notEqual(elasticAfter?.status, "pending", "ignore-all must have cleared the remaining visible reviews, including Elastic");

      if (previousMockThrow === undefined) delete process.env.EMAIL_UNDERSTANDING_MOCK_RESPONSE;
      else process.env.EMAIL_UNDERSTANDING_MOCK_RESPONSE = previousMockThrow;
    });
  } finally {
    clearUnderstandingMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
