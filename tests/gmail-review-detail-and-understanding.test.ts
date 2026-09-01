import { randomBytes, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { encryptSecretJson } from "../packages/core/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, prisma, seedUser, sendAgentMessage } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * fix/private-alpha-email-review-detail-and-general-mail-understanding: end-to-end coverage for the
 * new "details for N" review-detail command (Part 2), review-list conciseness with on-demand detail
 * (Part 6), grounded explanation quality (Part 7), user actions resolved from a detail view via "this"
 * (Part 8), general goal/watcher compatibility beyond job-search (Part 9), and the exact live-example
 * replay (Part 10). Every scenario exercises the REAL executor (refetch -> clean/redact -> LLM
 * understanding -> deterministic validation -> response), with the Gmail fetch and the LLM
 * understanding call both mocked for determinism — never a claim that a real email was mutated.
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
          accessToken: `detail-access-${randomUUID()}`,
          refreshToken: `detail-refresh-${randomUUID()}`,
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

async function seedRule(userId: string, connectionId: string, goalId?: string, overrides: { name?: string; description?: string; adapterId?: string } = {}) {
  return prisma.emailSignalRule.create({
    data: {
      userId,
      connectionId,
      goalId,
      adapterId: overrides.adapterId ?? "job_search_email",
      name: overrides.name ?? "Job search emails",
      description: overrides.description,
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
      // remove any dependency on real insertion timing (which can tie at this precision) for tests
      // that rely on a specific resulting review number.
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

const innovationLabsUnderstanding = {
  emailKind: "application_confirmation",
  relevance: "medium",
  goalRelevance: "direct",
  summary: "Innovation Labs confirmed receipt of the application for the Front-End Engineer role.",
  why: ["received your application", "Front-End Engineer role"],
  suggestedUserAction: "approve",
  confidence: 0.9
};

// --- Part 2: the "details for N" command ---

test("2A. 'details for 3' after review list shows title/classification/why/important text/suggested action", async () => {
  const server = buildServer();
  const userId = `detail-2a-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([
    { id: "m1", subject: "Thank you for applying to Innovation Labs", from: "no-reply@innovationlabs.example", body: "Thank you for applying to Innovation Labs. We have received your application for the Front-End Engineer role." }
  ]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      await seedReview(userId, connection.id, rule.id, {
        providerMessageId: "m1",
        subject: "Thank you for applying to Innovation Labs",
        from: "no-reply@innovationlabs.example",
        reason: "application_confirmation",
        proposedEventType: "career.application_confirmation_received",
        extracted: { company: "Innovation Labs", role: "Front-End Engineer" }
      });

      mockUnderstanding(innovationLabsUnderstanding);
      await sendAgentMessage(server, userId, "show me email reviews");
      const reply = await sendAgentMessage(server, userId, "details for 1");

      assert.match(reply.reply, /Review 1/i);
      assert.match(reply.reply, /Current classification:/i);
      assert.match(reply.reply, /Why it matters:/i);
      assert.match(reply.reply, /Important text:/i);
      assert.match(reply.reply, /Suggested action:/i);
      assert.match(reply.reply, /Innovation Labs/i);

      const review = await prisma.emailReviewItem.findFirst({ where: { userId } });
      assert.equal(review?.status, "pending", "a detail view must never mutate the review status");
    });
  } finally {
    clearUnderstandingMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2B. 'why did you classify 3 like that' triggers the same detail flow", async () => {
  const server = buildServer();
  const userId = `detail-2b-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([
    { id: "m1", subject: "Innovation Labs", from: "no-reply@innovationlabs.example", body: "Thank you for applying." },
    { id: "m2", subject: "Penta Consulting", from: "no-reply@penta.example", body: "Thank you for applying to Penta Consulting for the Frontend Developer role." },
    { id: "m3", subject: "micro1 code", from: "no-reply@micro1.ai", body: "Your verification code is 482913." }
  ]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m1", subject: "Innovation Labs", from: "no-reply@innovationlabs.example", reason: "application_confirmation", proposedEventType: "career.application_confirmation_received", updatedAt: new Date("2026-08-20T09:02:00.000Z") });
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m2", subject: "Penta Consulting", from: "no-reply@penta.example", reason: "application_confirmation", proposedEventType: "career.application_confirmation_received", updatedAt: new Date("2026-08-20T09:01:00.000Z") });
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m3", subject: "micro1 code", from: "no-reply@micro1.ai", reason: "security_auth", updatedAt: new Date("2026-08-20T09:00:00.000Z") });

      mockUnderstanding({
        emailKind: "security_auth",
        relevance: "noise",
        goalRelevance: "unrelated",
        summary: "This is a verification code email, not job-search progress.",
        why: ["verification code"],
        suggestedUserAction: "ignore",
        confidence: 0.95
      });
      await sendAgentMessage(server, userId, "show me email reviews");
      const reply = await sendAgentMessage(server, userId, "why did you classify 3 like that");

      assert.match(reply.reply, /Review 3/i);
      assert.match(reply.reply, /security|verification/i);
    });
  } finally {
    clearUnderstandingMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2C. an invalid review number asks for clarification, never crashes", async () => {
  const server = buildServer();
  const userId = `detail-2c-${randomUUID()}`;
  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m1", subject: "Innovation Labs", from: "no-reply@innovationlabs.example", reason: "application_confirmation" });

      await sendAgentMessage(server, userId, "show me email reviews");
      const reply = await sendAgentMessage(server, userId, "show review 99");

      assert.doesNotMatch(reply.reply, /unexpected problem/i);
      assert.match(reply.reply, /don't see|which one|number/i);
    });
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2D. no visible reviews asks to show reviews first", async () => {
  const server = buildServer();
  const userId = `detail-2d-${randomUUID()}`;
  try {
    await seedUser(userId);
    const reply = await sendAgentMessage(server, userId, "details for 1");
    assert.match(reply.reply, /show me my email reviews|show.*reviews first/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2E. a security code is redacted in the detail view", async () => {
  const server = buildServer();
  const userId = `detail-2e-${randomUUID()}`;
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
        why: ["verification code", "valid for 10 minutes"],
        suggestedUserAction: "ignore",
        confidence: 0.95
      });
      await sendAgentMessage(server, userId, "show me email reviews");
      const reply = await sendAgentMessage(server, userId, "details for 1");

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

test("2F. HTML content and invisible characters are sanitized in the detail view", async () => {
  const server = buildServer();
  const userId = `detail-2f-${randomUUID()}`;
  const zeroWidthSpace = "\u200B";
  const restoreFetch = installGmailFullFetchMock([
    {
      id: "m1",
      subject: "Innovation Labs",
      from: "no-reply@innovationlabs.example",
      html: true,
      body: `<html><body><p>Thank you for applying${zeroWidthSpace} to Innovation Labs. We received your application for the Front-End Engineer role.</p><script>var x = 1;</script></body></html>`
    }
  ]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m1", subject: "Innovation Labs", from: "no-reply@innovationlabs.example", reason: "application_confirmation" });

      mockUnderstanding(innovationLabsUnderstanding);
      await sendAgentMessage(server, userId, "show me email reviews");
      const reply = await sendAgentMessage(server, userId, "details for 1");

      assert.doesNotMatch(reply.reply, /<[a-z][\s\S]*>/i);
      assert.doesNotMatch(reply.reply, new RegExp(zeroWidthSpace));
      assert.doesNotMatch(reply.reply, /var x = 1/);
    });
  } finally {
    clearUnderstandingMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2G. the detail view does not approve/reject automatically", async () => {
  const server = buildServer();
  const userId = `detail-2g-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([{ id: "m1", subject: "Innovation Labs", from: "no-reply@innovationlabs.example", body: "Thank you for applying to Innovation Labs." }]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      const review = await seedReview(userId, connection.id, rule.id, { providerMessageId: "m1", subject: "Innovation Labs", from: "no-reply@innovationlabs.example", reason: "application_confirmation" });

      mockUnderstanding(innovationLabsUnderstanding);
      await sendAgentMessage(server, userId, "show me email reviews");
      const reply = await sendAgentMessage(server, userId, "details for 1");

      assert.equal(reply.debug.mutationExecuted, false);
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

// --- Part 6: review list stays concise, refs persist across detail views ---

test("6C/6D. visible review refs persist after a detail view, and 'ignore the noise' still works afterward", async () => {
  const server = buildServer();
  const userId = `detail-6cd-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([{ id: "m1", subject: "Innovation Labs", from: "no-reply@innovationlabs.example", body: "Thank you for applying to Innovation Labs." }]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      const confirmation = await seedReview(userId, connection.id, rule.id, { providerMessageId: "m1", subject: "Innovation Labs", from: "no-reply@innovationlabs.example", reason: "application_confirmation", proposedEventType: "career.application_confirmation_received" });
      const noise = await seedReview(userId, connection.id, rule.id, { providerMessageId: "m2", subject: "micro1 code", from: "no-reply@micro1.ai", reason: "security_auth" });

      mockUnderstanding(innovationLabsUnderstanding);
      await sendAgentMessage(server, userId, "show me email reviews");
      await sendAgentMessage(server, userId, "details for 1");
      const reply = await sendAgentMessage(server, userId, "ignore the noise");

      assert.ok(reply.operationsExecuted.every((entry) => entry.tool === "gmail.review.reject"));
      const confirmationAfter = await prisma.emailReviewItem.findUnique({ where: { id: confirmation.id } });
      const noiseAfter = await prisma.emailReviewItem.findUnique({ where: { id: noise.id } });
      assert.equal(confirmationAfter?.status, "pending", "the detail view must not have disturbed the confirmation's own visible ref");
      assert.equal(noiseAfter?.status, "rejected");
    });
  } finally {
    clearUnderstandingMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Part 8: actions resolved from a detail view via "this" ---

test("8A. 'details for 3' -> 'ignore this' rejects that review", async () => {
  const server = buildServer();
  const userId = `detail-8a-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([{ id: "m1", subject: "micro1 code", from: "no-reply@micro1.ai", body: "Your verification code is 482913." }]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      const review = await seedReview(userId, connection.id, rule.id, { providerMessageId: "m1", subject: "micro1 code", from: "no-reply@micro1.ai", reason: "security_auth" });

      mockUnderstanding({
        emailKind: "security_auth",
        relevance: "noise",
        goalRelevance: "unrelated",
        summary: "A verification code.",
        why: ["verification code"],
        suggestedUserAction: "ignore",
        confidence: 0.95
      });
      await sendAgentMessage(server, userId, "show me email reviews");
      await sendAgentMessage(server, userId, "details for 1");
      const reply = await sendAgentMessage(server, userId, "ignore this");

      assert.ok(reply.operationsExecuted.some((entry) => entry.tool === "gmail.review.reject"));
      const after = await prisma.emailReviewItem.findUnique({ where: { id: review.id } });
      assert.equal(after?.status, "rejected");
    });
  } finally {
    clearUnderstandingMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("8B. 'details for 3' -> 'count this' approves/logs that review", async () => {
  const server = buildServer();
  const userId = `detail-8b-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([{ id: "m1", subject: "Innovation Labs", from: "no-reply@innovationlabs.example", body: "Thank you for applying to Innovation Labs. We have received your application for the Front-End Engineer role." }]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      const review = await seedReview(userId, connection.id, rule.id, {
        providerMessageId: "m1",
        subject: "Innovation Labs",
        from: "no-reply@innovationlabs.example",
        reason: "application_confirmation",
        proposedEventType: "career.application_confirmation_received"
      });

      mockUnderstanding(innovationLabsUnderstanding);
      await sendAgentMessage(server, userId, "show me email reviews");
      await sendAgentMessage(server, userId, "details for 1");
      const reply = await sendAgentMessage(server, userId, "count this");

      assert.ok(reply.operationsExecuted.some((entry) => entry.tool === "gmail.review.approve"));
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

test("8C. 'details for 3' -> 'turn this into an action' creates/proposes an action", async () => {
  const server = buildServer();
  const userId = `detail-8c-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([{ id: "m1", subject: "Complete your application", from: "careers@acme.example", body: "Please complete your application for the Backend Engineer role within 48 hours." }]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m1", subject: "Complete your application", from: "careers@acme.example", reason: "application_action_required" });

      mockUnderstanding({
        emailKind: "admin_notice",
        relevance: "high",
        goalRelevance: "direct",
        summary: "Acme is asking you to complete your application within 48 hours.",
        why: ["complete your application", "within 48 hours"],
        suggestedUserAction: "turn_into_action",
        confidence: 0.85
      });
      await sendAgentMessage(server, userId, "show me email reviews");
      await sendAgentMessage(server, userId, "details for 1");
      const reply = await sendAgentMessage(server, userId, "turn this into an action");

      assert.ok(reply.operationsExecuted.some((entry) => entry.tool === "gmail.review.to_action"));
      const action = await prisma.actionItem.findFirst({ where: { userId } });
      assert.ok(action, "expected a real ActionItem to be created from the detailed review");
    });
  } finally {
    clearUnderstandingMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("8F. 'this' does not resolve to the wrong email after an unrelated surface (goals) is shown", async () => {
  const server = buildServer();
  const userId = `detail-8f-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([{ id: "m1", subject: "micro1 code", from: "no-reply@micro1.ai", body: "Your verification code is 482913." }]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      const review = await seedReview(userId, connection.id, rule.id, { providerMessageId: "m1", subject: "micro1 code", from: "no-reply@micro1.ai", reason: "security_auth" });

      mockUnderstanding({
        emailKind: "security_auth",
        relevance: "noise",
        goalRelevance: "unrelated",
        summary: "A verification code.",
        why: ["verification code"],
        suggestedUserAction: "ignore",
        confidence: 0.95
      });
      await sendAgentMessage(server, userId, "show me email reviews");
      await sendAgentMessage(server, userId, "details for 1");
      // An unrelated surface (goals) in between must never disturb which review "this" still means.
      await sendAgentMessage(server, userId, "what are my goals?");
      const reply = await sendAgentMessage(server, userId, "ignore this");

      assert.ok(reply.operationsExecuted.some((entry) => entry.tool === "gmail.review.reject"));
      const after = await prisma.emailReviewItem.findUnique({ where: { id: review.id } });
      assert.equal(after?.status, "rejected");
    });
  } finally {
    clearUnderstandingMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Part 9: general goals/watchers compatibility beyond job search ---

test("9A. a flight-update email is understood and linked to a travel goal, not forced into job-search categories", async () => {
  const server = buildServer();
  const userId = `detail-9a-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([{ id: "m1", subject: "Your flight BA456 has changed", from: "no-reply@airline.example", body: "Your flight BA456 has been rescheduled to 14:20 on September 3rd." }]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const goal = await prisma.goal.create({ data: { userId, title: "Plan the Lisbon trip", category: "travel", status: "active" } });
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id, goal.id, { adapterId: "custom_email_review", name: "Travel emails", description: "Flight and hotel booking updates for the Lisbon trip" });
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m1", subject: "Your flight BA456 has changed", from: "no-reply@airline.example", reason: "custom_rule_match" });

      mockUnderstanding({
        emailKind: "flight_update",
        relevance: "high",
        goalRelevance: "direct",
        summary: "Flight BA456 has been rescheduled to 14:20 on September 3rd.",
        why: ["flight BA456", "rescheduled to 14:20"],
        suggestedUserAction: "monitor",
        confidence: 0.9
      });
      await sendAgentMessage(server, userId, "show me email reviews");
      const reply = await sendAgentMessage(server, userId, "details for 1");

      assert.match(reply.reply, /flight/i);
      assert.match(reply.reply, /Lisbon trip/i);
      assert.doesNotMatch(reply.reply, /recruiter|application confirmation|job alert/i);
    });
  } finally {
    clearUnderstandingMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("9C. a job alert is never linked as job-search progress even when relevance is asked about", async () => {
  const server = buildServer();
  const userId = `detail-9c-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([{ id: "m1", subject: "New jobs matching your profile", from: "jobs@boardsite.example", body: "New opportunity matching your profile: Backend Engineer en Acme." }]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const goal = await prisma.goal.create({ data: { userId, title: "Find a remote developer job", category: "career", status: "active" } });
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id, goal.id);
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m1", subject: "New jobs matching your profile", from: "jobs@boardsite.example", reason: "unknown" });

      mockUnderstanding({
        emailKind: "job_alert",
        relevance: "low",
        goalRelevance: "indirect",
        summary: "A job-board alert advertising open roles, not a reply about your own application.",
        why: ["new opportunity matching your profile"],
        suggestedUserAction: "ignore",
        confidence: 0.85
      });
      await sendAgentMessage(server, userId, "show me email reviews");
      const reply = await sendAgentMessage(server, userId, "details for 1");

      assert.match(reply.reply, /job alert/i);
      assert.match(reply.reply, /ignore/i);

      const events = await prisma.event.count({ where: { userId, source: "gmail" } });
      assert.equal(events, 0, "a detail view must never itself log progress");
    });
  } finally {
    clearUnderstandingMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Part 10: exact live example replay ---

test("10. exact live examples: micro1 code redacted, Elastic confirmed, job alert not job-search progress", async () => {
  const server = buildServer();
  const userId = `detail-10-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([
    { id: "m-micro1", subject: "micro1 verification code", from: "no-reply@micro1.ai", body: "Your one-time verification code is 118204." },
    { id: "m-elastic", subject: "Thank you for your interest in Elastic", from: "careers@elastic.co", body: "Thank you for your interest in Elastic. We received your resume for the Software Engineer role." },
    { id: "m-innovation", subject: "Innovation Labs application confirmation", from: "no-reply@innovationlabs.example", body: "Thank you for applying to Innovation Labs. We have received your application for the Front-End Engineer role." },
    { id: "m-linkedin", subject: "New jobs matching your profile", from: "jobs@linkedin.example", body: "New opportunity matching your profile: Backend Engineer en Acme." },
    { id: "m-twine", subject: "Welcome to Twine!", from: "hello@twine.net", body: "Welcome to Twine! Let's get you set up in 4 steps." }
  ]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      // Reviews are listed most-recently-updated first, so seeded in reverse of the intended
      // displayed numbering: Innovation Labs (created last) -> 1, Elastic -> 2, LinkedIn -> 3.
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m-linkedin", subject: "New jobs matching your profile", from: "jobs@linkedin.example", reason: "unknown", updatedAt: new Date("2026-08-20T09:00:00.000Z") });
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m-elastic", subject: "Thank you for your interest in Elastic", from: "careers@elastic.co", reason: "application_confirmation", proposedEventType: "career.application_confirmation_received", updatedAt: new Date("2026-08-20T09:01:00.000Z") });
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m-innovation", subject: "Innovation Labs application confirmation", from: "no-reply@innovationlabs.example", reason: "application_confirmation", proposedEventType: "career.application_confirmation_received", updatedAt: new Date("2026-08-20T09:02:00.000Z") });

      // 1. details for 1 (Innovation Labs)
      mockUnderstanding(innovationLabsUnderstanding);
      await sendAgentMessage(server, userId, "show email reviews");
      const detail1 = await sendAgentMessage(server, userId, "details for 1");
      assert.match(detail1.reply, /Innovation Labs/i);

      // why is 3 noise? (job alert)
      mockUnderstanding({
        emailKind: "job_alert",
        relevance: "low",
        goalRelevance: "indirect",
        summary: "A job-board alert, not a personal reply.",
        why: ["new opportunity matching your profile"],
        suggestedUserAction: "ignore",
        confidence: 0.85
      });
      const why3 = await sendAgentMessage(server, userId, "why is 3 noise?");
      assert.match(why3.reply, /job alert/i);

      // show full text for 2 (Elastic)
      mockUnderstanding({
        emailKind: "application_confirmation",
        relevance: "medium",
        goalRelevance: "direct",
        summary: "Elastic confirmed receipt of the resume for the Software Engineer role.",
        why: ["received your resume", "Software Engineer role"],
        suggestedUserAction: "approve",
        confidence: 0.88
      });
      const full2 = await sendAgentMessage(server, userId, "show full text for 2");
      assert.match(full2.reply, /resume/i);
      assert.doesNotMatch(full2.reply, /rejection|rejected/i);

      // ignore this (should ignore review 2, the last detailed one)
      const ignoreThis = await sendAgentMessage(server, userId, "ignore this");
      assert.ok(ignoreThis.operationsExecuted.some((entry) => entry.tool === "gmail.review.reject"));

      // show review 99 -> clarification, no crash
      const invalid = await sendAgentMessage(server, userId, "show review 99");
      assert.doesNotMatch(invalid.reply, /unexpected problem/i);

      // never claims Gmail deletion anywhere across this whole transcript
      for (const reply of [detail1, why3, full2, ignoreThis, invalid]) {
        assert.doesNotMatch(reply.reply, /deleted your email|deleted the email|removed the email from gmail/i);
      }
    });
  } finally {
    clearUnderstandingMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
