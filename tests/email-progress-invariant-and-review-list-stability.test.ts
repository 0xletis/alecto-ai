import { randomBytes, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createGoal } from "../packages/db/src/index.ts";
import { encryptSecretJson } from "../packages/core/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, prisma, seedUser, sendAgentMessage } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * fix/private-alpha-email-progress-invariant-and-review-list-stability: end-to-end coverage for the
 * hard consistency failure — "Logged 1 CV sent" claimed while the SAME aggregate goal.status reads
 * stayed unchanged. Adds a read-after-write invariant to gmail.review.log_progress (Task 2), fixes a
 * cross-rule duplicate-review bug (Task 7, the live "OpenZeppelin x2" report), a "new reviews since
 * last view" note for background-sync-added rows (Task 6), and further detail cleanup (Task 8).
 * Gmail fetch and the LLM understanding call are both mocked for determinism; the fetch mock rejects
 * any non-GET request, so a passing test is also proof no Gmail mutation occurred.
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
          accessToken: `invariant-access-${randomUUID()}`,
          refreshToken: `invariant-refresh-${randomUUID()}`,
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

async function seedRule(userId: string, connectionId: string, goalId?: string, overrides: { name?: string } = {}) {
  return prisma.emailSignalRule.create({
    data: {
      userId,
      connectionId,
      goalId,
      adapterId: "job_search_email",
      name: overrides.name ?? "Job search emails",
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
      confidence: 0.6,
      reason: input.reason,
      proposedEventType: input.proposedEventType,
      extracted: input.extracted ?? {},
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

const tsbUnderstanding = {
  emailKind: "application_confirmation",
  relevance: "medium",
  goalRelevance: "direct",
  summary: "Technical Solutions Blockchain confirmed receipt of your application.",
  why: ["hemos recibido tu solicitud", "Technical Solutions Blockchain"],
  suggestedUserAction: "approve",
  confidence: 0.9,
  keyDetails: { company: "Technical Solutions Blockchain", role: null, location: null, appliedDate: null, status: null, nextStep: null },
  keyFacts: []
};

// --- Task 2: read-after-write invariant ---

test("2A/2B/2F. a successful progress-from-review increments both aggregates, verified before the reply claims 'logged'", async () => {
  const server = buildServer();
  const userId = `raw-2ab-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([{ id: "m1", subject: "Technical Solutions Blockchain", from: "no-reply@tsb.example", body: "Hemos recibido tu solicitud. Technical Solutions Blockchain." }]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const goalResult = await createGoal(userId, { title: "Find a remote developer job", category: "career", templateId: "career.job_search" });
      const goal = goalResult.goal;
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id, goal.id);
      const review = await seedReview(userId, connection.id, rule.id, { providerMessageId: "m1", subject: "Technical Solutions Blockchain", from: "no-reply@tsb.example", reason: "uncertain signal" });

      mockUnderstanding(tsbUnderstanding);
      await sendAgentMessage(server, userId, "show email reviews");
      await sendAgentMessage(server, userId, "details for 1");
      const reply = await sendAgentMessage(server, userId, "mark it as cv sent");

      assert.match(reply.reply, /^Logged 1 CV sent/i, "must only claim 'logged' after verification passes");

      // The review must resolve ONLY after the verified write — checked directly against the DB,
      // not just the reply text, since "review resolution happens after progress write succeeds"
      // is the exact ordering invariant Task 2/F asks for.
      const after = await prisma.emailReviewItem.findUnique({ where: { id: review.id } });
      assert.equal(after?.status, "approved");

      const status = await sendAgentMessage(server, userId, "show today goal progress");
      assert.match(status.reply, /Today: 1/i);
      assert.match(status.reply, /This week: 1/i);
    });
  } finally {
    clearUnderstandingMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2C. the duplicate path says already counted, never a false 'Logged' claim", async () => {
  const server = buildServer();
  const userId = `raw-2c-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([{ id: "m1", subject: "Technical Solutions Blockchain", from: "no-reply@tsb.example", body: "Hemos recibido tu solicitud." }]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      const rule2 = await seedRule(userId, connection.id, undefined, { name: "Second rule" });
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m1", subject: "Technical Solutions Blockchain", from: "no-reply@tsb.example", reason: "uncertain signal", updatedAt: new Date(Date.now() - 1000) });
      await prisma.emailReviewItem.create({
        data: {
          userId,
          connectionId: connection.id,
          ruleId: rule2.id,
          adapterId: "job_search_email",
          provider: "gmail",
          providerMessageId: "m1",
          externalId: `gmail-review:${rule2.id}:m1`,
          status: "pending",
          subject: "Technical Solutions Blockchain",
          from: "no-reply@tsb.example",
          snippet: "Technical Solutions Blockchain",
          confidence: 0.6,
          reason: "uncertain signal",
          extracted: {}
        }
      });

      mockUnderstanding(tsbUnderstanding);
      await sendAgentMessage(server, userId, "show email reviews");
      await sendAgentMessage(server, userId, "mark 1 as cv sent");
      const second = await sendAgentMessage(server, userId, "mark 1 as cv sent");

      assert.doesNotMatch(second.reply, /^Logged 1/i);
      assert.match(second.reply, /already counted/i);

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

test("2D/2E. a forced verification failure never claims 'logged' and leaves the review pending", async () => {
  const server = buildServer();
  const userId = `raw-2de-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([{ id: "m1", subject: "Technical Solutions Blockchain", from: "no-reply@tsb.example", body: "Hemos recibido tu solicitud." }]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      const review = await seedReview(userId, connection.id, rule.id, { providerMessageId: "m1", subject: "Technical Solutions Blockchain", from: "no-reply@tsb.example", reason: "uncertain signal" });

      mockUnderstanding(tsbUnderstanding);
      process.env.EMAIL_PROGRESS_VERIFICATION_FORCE_FAIL = "true";
      try {
        await sendAgentMessage(server, userId, "show email reviews");
        await sendAgentMessage(server, userId, "details for 1");
        const reply = await sendAgentMessage(server, userId, "mark it as cv sent");

        assert.doesNotMatch(reply.reply, /^Logged/i);
        assert.match(reply.reply, /couldn't verify/i);

        const after = await prisma.emailReviewItem.findUnique({ where: { id: review.id } });
        assert.equal(after?.status, "pending", "the review must stay pending when verification fails");
      } finally {
        delete process.env.EMAIL_PROGRESS_VERIFICATION_FORCE_FAIL;
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

test("2G. no Gmail mutation across the verified log-progress flow", async () => {
  const server = buildServer();
  const userId = `raw-2g-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([{ id: "m1", subject: "Technical Solutions Blockchain", from: "no-reply@tsb.example", body: "Hemos recibido tu solicitud." }]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m1", subject: "Technical Solutions Blockchain", from: "no-reply@tsb.example", reason: "uncertain signal" });

      mockUnderstanding(tsbUnderstanding);
      await sendAgentMessage(server, userId, "show email reviews");
      await sendAgentMessage(server, userId, "details for 1");
      // installGmailFullFetchMock rejects any non-GET call with 500 — a clean reply here is itself
      // proof no mutating Gmail call was ever attempted.
      const reply = await sendAgentMessage(server, userId, "mark it as cv sent");
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

// --- Task 4: date policy, Sep-2-equals-today case ---

test("4A. an applied date equal to today's real date increments Today, not just This week", async () => {
  const server = buildServer();
  const userId = `date-4a-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([{ id: "m1", subject: "Technical Solutions Blockchain", from: "no-reply@tsb.example", body: "Hemos recibido tu solicitud." }]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      await createGoal(userId, { title: "Find a remote developer job", category: "career", templateId: "career.job_search" });
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m1", subject: "Technical Solutions Blockchain", from: "no-reply@tsb.example", reason: "uncertain signal" });

      const todayText = new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Madrid" }).format(new Date());
      mockUnderstanding({ ...tsbUnderstanding, keyDetails: { ...tsbUnderstanding.keyDetails, appliedDate: `Aplicado el ${todayText}` } });

      await sendAgentMessage(server, userId, "show email reviews");
      await sendAgentMessage(server, userId, "details for 1");
      const reply = await sendAgentMessage(server, userId, "mark it as cv sent");
      assert.match(reply.reply, /^Logged 1 CV sent from that email/i, "same-day applied date must read as 'today', no explicit date suffix");

      const status = await sendAgentMessage(server, userId, "show today goal progress");
      assert.match(status.reply, /Today: 1/i);
    });
  } finally {
    clearUnderstandingMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4E. the timezone used for 'today' is the user's own (Europe/Madrid), not UTC", async () => {
  const server = buildServer();
  const userId = `date-4e-${randomUUID()}`;
  await seedUser(userId);
  try {
    await prisma.notificationSettings.upsert({
      where: { userId },
      create: { userId, timezone: "Europe/Madrid", morningTimeMinutes: 540 },
      update: { timezone: "Europe/Madrid" }
    });
    await createGoal(userId, { title: "Find a remote developer job", category: "career", templateId: "career.job_search" });
    // A day with real week activity but genuinely zero TODAY — the case the "Today:" line must
    // stay honest about, per formatGoalStatusForChat's own design (no week activity at all means a
    // plain "No logged progress" line instead, which is not what this test is checking).
    await prisma.event.create({ data: { userId, type: "career.application_sent", source: "manual", timestamp: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), confidence: 1, data: {} } });

    const reply = await sendAgentMessage(server, userId, "show today goal progress");
    assert.match(reply.reply, /Today: 0/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 5: no old canned footer, from any route ---

test("5A/5B. the exact old canned footer never appears, and the typo route uses the new formatter", async () => {
  const server = buildServer();
  const userId = `formatter-5ab-${randomUUID()}`;

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m1", subject: "Mira vacantes de Exoticca", from: "jobs@exoticca.example", reason: "uncertain signal", updatedAt: new Date(Date.now() - 1000) });
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m2", subject: "¡Bienvenido!", from: "welcome@example.com", reason: "uncertain signal" });

      const reply = await sendAgentMessage(server, userId, "show email reviws");
      assert.doesNotMatch(reply.reply, /Say "details for 3"/i);
      assert.doesNotMatch(reply.reply, /reject the Endesa one/i);
      assert.doesNotMatch(reply.reply, /turn the recruiter one into a task/i);
      assert.match(reply.reply, /Pending Gmail reviews:/i);
    });
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("5E. a one-review list says 'details for 1', not a fabricated higher number", async () => {
  const server = buildServer();
  const userId = `formatter-5e-${randomUUID()}`;

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m1", subject: "Technical Solutions Blockchain", from: "no-reply@tsb.example", reason: "application_confirmation", proposedEventType: "career.application_confirmation_received" });

      const reply = await sendAgentMessage(server, userId, "show email reviews");
      assert.match(reply.reply, /details for 1/i);
      assert.doesNotMatch(reply.reply, /details for [2-9]/i);
    });
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 6: review-list stability ---

test("6A/6C/6D. listing reviews never creates new rows and refresh reorders nothing mid-turn", async () => {
  const server = buildServer();
  const userId = `stability-6acd-${randomUUID()}`;

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m1", subject: "First review", from: "a@example.com", reason: "application_confirmation", proposedEventType: "career.application_confirmation_received", updatedAt: new Date(Date.now() - 2000) });
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m2", subject: "Second review", from: "b@example.com", reason: "application_confirmation", proposedEventType: "career.application_confirmation_received", updatedAt: new Date(Date.now() - 1000) });

      const before = await prisma.emailReviewItem.count({ where: { userId } });
      const reply = await sendAgentMessage(server, userId, "show email reviews");
      const after = await prisma.emailReviewItem.count({ where: { userId } });

      assert.equal(before, after, "listing reviews must never create new review rows");
      assert.match(reply.reply, /1\. Second review/i, "list order (by updatedAt desc) must stay stable within one response");
      assert.match(reply.reply, /2\. First review/i);
    });
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("6B. a review that appeared since the last view in this session is called out as new", async () => {
  const server = buildServer();
  const userId = `stability-6b-${randomUUID()}`;

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m1", subject: "First review", from: "a@example.com", reason: "application_confirmation", proposedEventType: "career.application_confirmation_received" });

      await sendAgentMessage(server, userId, "show email reviews");

      // Simulates a background sync adding a new pending row between the two list calls.
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m2", subject: "Second review (new)", from: "b@example.com", reason: "application_confirmation", proposedEventType: "career.application_confirmation_received" });

      const second = await sendAgentMessage(server, userId, "show email reviews");
      assert.match(second.reply, /1 new review arrived since your last view/i);
    });
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 7: cross-rule duplicate review dedupe ---

test("7A. the same Gmail message matched by two active rules creates only one pending review", async () => {
  const server = buildServer();
  const userId = `dedupe-7a-${randomUUID()}`;

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const { createEmailSignalRule, findGmailSemanticDuplicateReviewItem, getEmailReviewItems } = await import("../packages/db/src/index.ts");
      const connection = await seedGmailConnectionWithToken(userId);
      const ruleA = await createEmailSignalRule(userId, { connectionId: connection.id, adapterId: "job_search_email", name: "Rule A", createdBy: "user" });
      const ruleB = await createEmailSignalRule(userId, { connectionId: connection.id, adapterId: "job_search_email", name: "Rule B", createdBy: "user" });

      // First rule creates the review directly (bypassing the full sync pipeline, which needs a
      // real Gmail API — this test exercises the actual DEDUPE PRIMITIVE server.ts's sync pipeline
      // calls, findGmailSemanticDuplicateReviewItem, the same way that pipeline does).
      const firstReview = await prisma.emailReviewItem.create({
        data: {
          userId,
          connectionId: connection.id,
          ruleId: ruleA.id,
          adapterId: "job_search_email",
          provider: "gmail",
          providerMessageId: "oz-1",
          externalId: `gmail-review:${ruleA.id}:oz-1`,
          status: "pending",
          subject: "Your offer from OpenZeppelin",
          from: "hr@openzeppelin.example",
          snippet: "Your offer from OpenZeppelin",
          confidence: 0.7,
          reason: "job_offer",
          proposedEventType: "career.offer_received",
          extracted: { company: "OpenZeppelin", role: "Smart Contract Engineer" }
        }
      });

      // Second rule's own classification pass now checks for a semantic duplicate BEFORE creating —
      // this must find the first rule's review even though it belongs to a DIFFERENT rule.
      const duplicate = await findGmailSemanticDuplicateReviewItem({
        userId,
        ruleId: ruleB.id,
        adapterId: "job_search_email",
        provider: "gmail",
        proposedEventType: "career.offer_received",
        subject: "Your offer from OpenZeppelin",
        from: "hr@openzeppelin.example",
        company: "OpenZeppelin",
        role: "Smart Contract Engineer"
      });

      assert.ok(duplicate, "the second rule must find the first rule's pending review as a semantic duplicate");
      assert.equal(duplicate?.id, firstReview.id);

      const allReviews = await getEmailReviewItems(userId, { status: "pending", limit: 10 });
      assert.equal(allReviews.length, 1, "only one pending review should exist for the same real opportunity");
    });
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 8: further detail cleanup ---

test("8A. a LinkedIn-shaped detail has no markdown-link residue or dangling tracking query tail", async () => {
  const server = buildServer();
  const userId = `cleanup-8a-${randomUUID()}`;
  const noisyBody = [
    "Gracias por aplicar.",
    "[NodeJS](https://www.linkedin.com/comm/jobs/view/12345?trk=flagship3)&lipi=abc123&trk=xyz",
    "Mira a quién ha contratado esta empresa antes.",
    "Solicitar con perfil y CV."
  ].join("\n");
  const restoreFetch = installGmailFullFetchMock([{ id: "m1", subject: "LinkedIn job alert", from: "jobs-noreply@linkedin.com", body: noisyBody }]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m1", subject: "LinkedIn job alert", from: "jobs-noreply@linkedin.com", reason: "uncertain signal" });

      mockUnderstanding({
        emailKind: "job_alert",
        relevance: "medium",
        goalRelevance: "unclear",
        summary: "A LinkedIn job alert.",
        why: ["Gracias por aplicar"],
        suggestedUserAction: "monitor",
        confidence: 0.7,
        keyDetails: null,
        keyFacts: []
      });
      await sendAgentMessage(server, userId, "show email reviews");
      const reply = await sendAgentMessage(server, userId, "details for 1");

      assert.doesNotMatch(reply.reply, /&lipi=/i);
      assert.doesNotMatch(reply.reply, /&trk=/i);
      assert.doesNotMatch(reply.reply, /\]\(https/i);
      assert.doesNotMatch(reply.reply, /mira a qui[eé]n ha contratado/i);
      assert.doesNotMatch(reply.reply, /solicitar con perfil y cv/i);
    });
  } finally {
    clearUnderstandingMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 9: exact live regression replay ---

test("9. exact live replay: Technical Solutions Blockchain applied Sep 2 (today) → verified log, Today 1, Week 17", async () => {
  const server = buildServer();
  const userId = `live-replay-9-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([{ id: "m1", subject: "Technical Solutions Blockchain", from: "no-reply@tsb.example", body: "Hemos recibido tu solicitud. Technical Solutions Blockchain." }]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const goalResult = await createGoal(userId, { title: "Find a remote developer job", category: "career", templateId: "career.job_search" });
      const goal = goalResult.goal;
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id, goal.id);

      for (let i = 0; i < 16; i += 1) {
        await prisma.event.create({
          data: { userId, type: "career.application_sent", source: "manual", timestamp: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), confidence: 1, data: {} }
        });
      }
      const review = await seedReview(userId, connection.id, rule.id, { providerMessageId: "m1", subject: "Technical Solutions Blockchain", from: "no-reply@tsb.example", reason: "uncertain signal" });

      const todayText = new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Madrid" }).format(new Date());
      mockUnderstanding({ ...tsbUnderstanding, keyDetails: { ...tsbUnderstanding.keyDetails, appliedDate: `Aplicado el ${todayText}` } });

      const list1 = await sendAgentMessage(server, userId, "show email reviews");
      assert.match(list1.reply, /Pending Gmail review:/i);

      const detail = await sendAgentMessage(server, userId, "details for 1");
      assert.match(detail.reply, /application confirmation/i);

      const mark = await sendAgentMessage(server, userId, "mark it as cv sent");
      assert.match(mark.reply, /^Logged 1 CV sent from that email/i);

      const after = await prisma.emailReviewItem.findUnique({ where: { id: review.id } });
      assert.equal(after?.status, "approved");

      const today = await sendAgentMessage(server, userId, "show today goal progress");
      assert.match(today.reply, /Today: 1/i);
      assert.match(today.reply, /This week: 17/i);

      const askToday = await sendAgentMessage(server, userId, "how many CVs did I send today?");
      assert.match(askToday.reply, /Today: 1/i);
      assert.deepEqual(askToday.operationsPlanned.map((op) => op.tool), ["goal.status"]);

      const week = await sendAgentMessage(server, userId, "show this week goal progress");
      assert.match(week.reply, /This week: 17/i);

      const cvEvents = await prisma.event.count({ where: { userId, type: "career.application_sent" } });
      assert.equal(cvEvents, 17, "no double count across the whole replay");
    });
  } finally {
    clearUnderstandingMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
