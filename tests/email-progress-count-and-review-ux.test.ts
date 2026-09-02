import { randomBytes, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createGoal } from "../packages/db/src/index.ts";
import { encryptSecretJson } from "../packages/core/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, prisma, seedUser, sendAgentMessage } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * fix/private-alpha-email-progress-count-and-review-ux: end-to-end coverage for the live-reported
 * bugs found after deploying Gmail review detail/resolution — (1) progress claimed "logged" but the
 * goal-progress aggregate didn't visibly increase and the Today line vanished (Tasks 2/4), (2) the
 * date policy for an email-derived progress event (Task 3), (3) noisy email detail output — tracking
 * URLs, recommendation blocks, separators (Task 7), (4) a fake-example, contextless review-list
 * footer (Task 5), noisy review rows (Task 6), and stale classifications surviving into the list
 * (Task 8), and (5) a suggested action that doesn't match the email's own classification (Task 9).
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
            { name: "Date", value: "Wed, 02 Sep 2026 09:00:00 +0200" }
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
          accessToken: `progress-ux-access-${randomUUID()}`,
          refreshToken: `progress-ux-refresh-${randomUUID()}`,
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

const iqanaUnderstanding = {
  emailKind: "application_confirmation",
  relevance: "medium",
  goalRelevance: "direct",
  summary: "Iqana confirmed receipt of your application for the Software Engineer role.",
  why: ["se ha enviado tu solicitud", "Software Engineer"],
  suggestedUserAction: "approve",
  confidence: 0.9,
  keyDetails: { company: "Iqana", role: "Software Engineer", location: null, appliedDate: null, status: null, nextStep: null },
  keyFacts: []
};

// --- Task 2: progress consistency ---

test("2A/2B. 'mark it as a CV sent' increments both weekly and today totals", async () => {
  const server = buildServer();
  const userId = `progress-2ab-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([{ id: "m1", subject: "Iqana", from: "no-reply@iqana.example", body: "Se ha enviado tu solicitud a Iqana. Software Engineer." }]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const goalResult = await createGoal(userId, { title: "Find a remote developer job", category: "career", templateId: "career.job_search" });
      const goal = goalResult.goal;
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id, goal.id);
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m1", subject: "Iqana", from: "no-reply@iqana.example", reason: "uncertain signal" });

      mockUnderstanding(iqanaUnderstanding);
      await sendAgentMessage(server, userId, "show email reviews");
      await sendAgentMessage(server, userId, "details for 1");
      const reply = await sendAgentMessage(server, userId, "mark it as a CV sent");
      assert.doesNotMatch(reply.reply, /unexpected problem|hit an error/i);

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

test("2C. progress-from-review uses the same event type as manual 'I sent 1 CV'", async () => {
  const server = buildServer();
  const userId = `progress-2c-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([{ id: "m1", subject: "Iqana", from: "no-reply@iqana.example", body: "Se ha enviado tu solicitud a Iqana." }]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m1", subject: "Iqana", from: "no-reply@iqana.example", reason: "uncertain signal" });

      mockUnderstanding(iqanaUnderstanding);
      await sendAgentMessage(server, userId, "show email reviews");
      await sendAgentMessage(server, userId, "details for 1");
      await sendAgentMessage(server, userId, "mark it as a CV sent");

      const events = await prisma.event.findMany({ where: { userId } });
      assert.equal(events.length, 1);
      assert.equal(events[0]!.type, "career.application_sent");
    });
  } finally {
    clearUnderstandingMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2E/2F. a duplicate email does not double-count and does not falsely say 'logged'", async () => {
  const server = buildServer();
  const userId = `progress-2ef-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([{ id: "m1", subject: "Iqana", from: "no-reply@iqana.example", body: "Se ha enviado tu solicitud a Iqana." }]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      const secondRule = await seedRule(userId, connection.id);
      const review1 = await seedReview(userId, connection.id, rule.id, { providerMessageId: "m1", subject: "Iqana", from: "no-reply@iqana.example", reason: "uncertain signal", updatedAt: new Date("2026-09-02T09:01:00.000Z") });

      // A second review row, from a DIFFERENT rule, pointing at the SAME underlying Gmail message
      // (same connection + providerMessageId, different externalId since that's rule-scoped) — two
      // rules both watching the same account can each independently flag the same email. Progress
      // must never be counted twice through two different review rows for the same message.
      const review2 = await prisma.emailReviewItem.create({
        data: {
          userId,
          connectionId: connection.id,
          ruleId: secondRule.id,
          adapterId: "job_search_email",
          provider: "gmail",
          providerMessageId: "m1",
          externalId: `gmail-review:${secondRule.id}:m1`,
          status: "pending",
          subject: "Iqana",
          from: "no-reply@iqana.example",
          snippet: "Iqana",
          evidence: "Iqana",
          confidence: 0.6,
          reason: "uncertain signal",
          extracted: {},
          updatedAt: new Date("2026-09-02T09:00:00.000Z")
        }
      });

      mockUnderstanding(iqanaUnderstanding);
      await sendAgentMessage(server, userId, "show email reviews");
      await sendAgentMessage(server, userId, "mark 1 as a CV sent");
      // review1 is resolved now, so the still-pending review2 is renumbered to "1" in the
      // remaining list gmail.review.log_progress just returned — same "1" reference, the OTHER
      // underlying review row, same underlying email.
      const second = await sendAgentMessage(server, userId, "mark 1 as a CV sent");

      assert.doesNotMatch(second.reply, /^Logged 1 CV/i);
      assert.match(second.reply, /already counted/i);

      const events = await prisma.event.count({ where: { userId, type: "career.application_sent" } });
      assert.equal(events, 1, "the same underlying email must never be counted twice across two review rows");

      const after2 = await prisma.emailReviewItem.findUnique({ where: { id: review2.id } });
      assert.notEqual(after2?.status, "pending", "the duplicate review must still be resolved, not left pending forever");
    });
  } finally {
    clearUnderstandingMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 3: date policy ---

test("3A/3F. an application date stated in the email body is used, and the reply explains the non-today date", async () => {
  const server = buildServer();
  const userId = `date-3af-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([{ id: "m1", subject: "Iqana", from: "no-reply@iqana.example", body: "Se ha enviado tu solicitud a Iqana. Solicitado el 1 de septiembre de 2026." }]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m1", subject: "Iqana", from: "no-reply@iqana.example", reason: "uncertain signal" });

      mockUnderstanding({
        ...iqanaUnderstanding,
        keyDetails: { ...iqanaUnderstanding.keyDetails, appliedDate: "1 de septiembre de 2026" }
      });
      await sendAgentMessage(server, userId, "show email reviews");
      await sendAgentMessage(server, userId, "details for 1");
      const reply = await sendAgentMessage(server, userId, "mark it as a CV sent");

      assert.match(reply.reply, /1 Sep/i);

      const event = await prisma.event.findFirst({ where: { userId, type: "career.application_sent" } });
      assert.ok(event);
      assert.equal(event!.timestamp.getUTCDate(), 1);
      assert.equal(event!.timestamp.getUTCMonth(), 8); // September, 0-indexed
    });
  } finally {
    clearUnderstandingMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3C. an explicit 'today' from the user overrides the email's own stated date", async () => {
  const server = buildServer();
  const userId = `date-3c-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([{ id: "m1", subject: "Iqana", from: "no-reply@iqana.example", body: "Se ha enviado tu solicitud a Iqana. Solicitado el 1 de septiembre de 2026." }]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m1", subject: "Iqana", from: "no-reply@iqana.example", reason: "uncertain signal" });

      mockUnderstanding({
        ...iqanaUnderstanding,
        keyDetails: { ...iqanaUnderstanding.keyDetails, appliedDate: "1 de septiembre de 2026" }
      });
      await sendAgentMessage(server, userId, "show email reviews");
      await sendAgentMessage(server, userId, "details for 1");
      const reply = await sendAgentMessage(server, userId, "mark it as a CV sent today");

      assert.doesNotMatch(reply.reply, /1 Sep/i);
    });
  } finally {
    clearUnderstandingMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 4: daily progress answers ---

test("4A/4D. 'show today goal progress' includes the Today line even at zero, never weekly-only", async () => {
  const server = buildServer();
  const userId = `daily-4ad-${randomUUID()}`;

  try {
    await seedUser(userId);
    const goalResult = await createGoal(userId, { title: "Find a remote developer job", category: "career", templateId: "career.job_search" });
    const goal = goalResult.goal;
    await prisma.event.create({
      data: { userId, type: "career.application_sent", source: "manual", timestamp: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), confidence: 1, data: {} }
    });

    const reply = await sendAgentMessage(server, userId, "show today goal progress");
    assert.match(reply.reply, /Today: 0/i);
    assert.match(reply.reply, /This week: 1/i);
    assert.equal(reply.operationsPlanned[0]?.tool, "goal.status");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4B. 'how many CVs did I send today?' answers with the real number, deterministically", async () => {
  const server = buildServer();
  const userId = `daily-4b-${randomUUID()}`;

  try {
    await seedUser(userId);
    await createGoal(userId, { title: "Find a remote developer job", category: "career", templateId: "career.job_search" });
    await prisma.event.create({ data: { userId, type: "career.application_sent", source: "manual", timestamp: new Date(), confidence: 1, data: {} } });

    const reply = await sendAgentMessage(server, userId, "how many CVs did I send today?");
    assert.match(reply.reply, /Today: 1/i);
    assert.deepEqual(reply.operationsPlanned.map((op) => op.tool), ["goal.status"]);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4E. Spanish/Catalan today-progress queries route deterministically", async () => {
  const server = buildServer();
  const userId = `daily-4e-${randomUUID()}`;

  try {
    await seedUser(userId);
    await createGoal(userId, { title: "Find a remote developer job", category: "career", templateId: "career.job_search" });
    await prisma.event.create({ data: { userId, type: "career.application_sent", source: "manual", timestamp: new Date(), confidence: 1, data: {} } });

    const es = await sendAgentMessage(server, userId, "cuántos CVs he enviado hoy");
    assert.deepEqual(es.operationsPlanned.map((op) => op.tool), ["goal.status"]);
    assert.match(es.reply, /Today: 1/i);

    const ca = await sendAgentMessage(server, userId, "quants CVs he enviat avui");
    assert.deepEqual(ca.operationsPlanned.map((op) => op.tool), ["goal.status"]);
    assert.match(ca.reply, /Today: 1/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4F. the typo 'show today goal progrress' still routes to goal.status", async () => {
  const server = buildServer();
  const userId = `daily-4f-${randomUUID()}`;

  try {
    await seedUser(userId);
    await createGoal(userId, { title: "Find a remote developer job", category: "career", templateId: "career.job_search" });

    const reply = await sendAgentMessage(server, userId, "show today goal progrress");
    assert.deepEqual(reply.operationsPlanned.map((op) => op.tool), ["goal.status"]);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4G. a genuine logging statement ('I sent 3 CVs today') is never intercepted as a read-only today query", async () => {
  const server = buildServer();
  const userId = `daily-4g-${randomUUID()}`;

  try {
    await seedUser(userId);
    await createGoal(userId, { title: "Find a remote developer job", category: "career", templateId: "career.job_search" });

    const reply = await sendAgentMessage(server, userId, "I sent 3 CVs today");
    assert.ok(
      reply.operationsPlanned.every((op) => op.tool !== "goal.status"),
      `a genuine logging statement must never be routed to the read-only goal.status shortcut — got: ${JSON.stringify(reply.operationsPlanned)}`
    );
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 5/6: review list UX ---

test("5A/6A. a single review's footer references 1 (never a fabricated 3), and the row is clean", async () => {
  const server = buildServer();
  const userId = `list-ux-5a6a-${randomUUID()}`;

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      await seedReview(userId, connection.id, rule.id, {
        providerMessageId: "m1",
        subject: "Se ha enviado tu solicitud a Iqana con mucho texto extra de seguimiento y enlaces de tracking",
        from: "no-reply@iqana.example",
        reason: "application_confirmation",
        proposedEventType: "career.application_confirmation_received",
        extracted: { company: "Iqana", role: "Software Engineer" }
      });

      const reply = await sendAgentMessage(server, userId, "show email reviews");
      assert.match(reply.reply, /Pending Gmail review:/i);
      assert.match(reply.reply, /details for 1/i);
      assert.doesNotMatch(reply.reply, /details for 3/i);
      assert.doesNotMatch(reply.reply, /reject the Endesa one/i);
      assert.doesNotMatch(reply.reply, /log the application confirmations/i);
      assert.match(reply.reply, /1\. Iqana — Software Engineer/i);
    });
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("5C/5D. the footer only mentions commands for groups that actually exist", async () => {
  const server = buildServer();
  const userId = `list-ux-5cd-${randomUUID()}`;

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      // Only "needs_review" reviews — no confirmation group, no noise group.
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m1", subject: "Recruiter note", from: "recruiter@example.com", reason: "recruiter_reply", proposedEventType: "career.recruiter_reply_received", updatedAt: new Date("2026-09-02T09:01:00.000Z") });
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m2", subject: "Interview invite", from: "hr@example.com", reason: "interview", proposedEventType: "career.interview_scheduled", updatedAt: new Date("2026-09-02T09:00:00.000Z") });

      const reply = await sendAgentMessage(server, userId, "show email reviews");
      assert.doesNotMatch(reply.reply, /ignore the noise/i);
      assert.doesNotMatch(reply.reply, /log the confirmations/i);
      assert.doesNotMatch(reply.reply, /reject the Endesa one/i);
    });
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 7: email detail cleanup ---

test("7A/7B/7C. tracking URLs and recommended-jobs blocks are removed from the default detail view", async () => {
  const server = buildServer();
  const userId = `detail-clean-7abc-${randomUUID()}`;
  const noisyBody = [
    "Se ha enviado tu solicitud a Iqana.",
    "Software Engineer.",
    "View this posting: https://www.linkedin.com/comm/jobs/view/12345?trk=flagship3_search_srp_jobcard&refId=abc123def456",
    "Jobs you may be interested in:",
    "Senior Engineer at OtherCo",
    "Staff Engineer at ThirdCo"
  ].join("\n");
  const restoreFetch = installGmailFullFetchMock([{ id: "m1", subject: "Iqana", from: "no-reply@iqana.example", body: noisyBody }]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m1", subject: "Iqana", from: "no-reply@iqana.example", reason: "uncertain signal" });

      mockUnderstanding(iqanaUnderstanding);
      await sendAgentMessage(server, userId, "show email reviews");
      const reply = await sendAgentMessage(server, userId, "details for 1");

      assert.doesNotMatch(reply.reply, /linkedin\.com\/comm\/jobs/i);
      assert.doesNotMatch(reply.reply, /trk=flagship3/i);
      assert.doesNotMatch(reply.reply, /Senior Engineer at OtherCo/i);
      assert.doesNotMatch(reply.reply, /Staff Engineer at ThirdCo/i);
      assert.match(reply.reply, /Key details:/i);
      assert.match(reply.reply, /Company: Iqana/i);
      assert.match(reply.reply, /Role: Software Engineer/i);
    });
  } finally {
    clearUnderstandingMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("7F. a security code stays redacted even after the tracking/recommendation cleanup", async () => {
  const server = buildServer();
  const userId = `detail-clean-7f-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([{ id: "m1", subject: "micro1 code", from: "no-reply@micro1.ai", body: "Your verification code is 482913. This code is valid for 10 minutes." }]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m1", subject: "micro1 code", from: "no-reply@micro1.ai", reason: "security_auth" });

      mockUnderstanding({
        emailKind: "security_auth",
        relevance: "noise",
        goalRelevance: "unrelated",
        summary: "A verification code.",
        why: ["verification code"],
        suggestedUserAction: "ignore",
        confidence: 0.95,
        keyDetails: null,
        keyFacts: []
      });
      await sendAgentMessage(server, userId, "show email reviews");
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

// --- Task 8: stale classification refreshed before listing ---

test("8A/8D/8E. a stale row is reclassified before the list is shown, with no status/progress change", async () => {
  const server = buildServer();
  const userId = `stale-list-8ade-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([{ id: "m1", subject: "Iqana", from: "no-reply@iqana.example", body: "Se ha enviado tu solicitud a Iqana. Software Engineer." }]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      const review = await seedReview(userId, connection.id, rule.id, { providerMessageId: "m1", subject: "Iqana", from: "no-reply@iqana.example", reason: "uncertain signal" });

      mockUnderstanding(iqanaUnderstanding);
      const reply = await sendAgentMessage(server, userId, "show email reviews");

      assert.match(reply.reply, /application confirmation/i);
      assert.doesNotMatch(reply.reply, /uncertain signal/i);

      const after = await prisma.emailReviewItem.findUnique({ where: { id: review.id } });
      assert.equal(after?.reason, "application_confirmation");
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

test("8F. the stale-row auto-refresh never mutates the real Gmail mailbox", async () => {
  const server = buildServer();
  const userId = `stale-list-8f-${randomUUID()}`;
  // The fetch mock installed by installGmailFullFetchMock rejects any non-GET call with a 500 —
  // reaching a clean reply here is itself proof no mutating Gmail call was attempted.
  const restoreFetch = installGmailFullFetchMock([{ id: "m1", subject: "Iqana", from: "no-reply@iqana.example", body: "Se ha enviado tu solicitud a Iqana." }]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m1", subject: "Iqana", from: "no-reply@iqana.example", reason: "uncertain signal" });

      mockUnderstanding(iqanaUnderstanding);
      const reply = await sendAgentMessage(server, userId, "show email reviews");
      assert.doesNotMatch(reply.reply, /unexpected problem|hit an error/i);
    });
  } finally {
    clearUnderstandingMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 9: suggested action matches classification ---

test("9A. an application confirmation suggests marking/counting it, not vague 'keep monitoring'", async () => {
  const server = buildServer();
  const userId = `suggest-9a-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([{ id: "m1", subject: "Iqana", from: "no-reply@iqana.example", body: "Se ha enviado tu solicitud a Iqana." }]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m1", subject: "Iqana", from: "no-reply@iqana.example", reason: "uncertain signal" });

      mockUnderstanding(iqanaUnderstanding);
      await sendAgentMessage(server, userId, "show email reviews");
      const reply = await sendAgentMessage(server, userId, "details for 1");

      assert.match(reply.reply, /Mark as CV sent/i);
      assert.doesNotMatch(reply.reply, /keep monitoring — nothing to decide right now/i);
    });
  } finally {
    clearUnderstandingMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("9C. noise (a job alert) suggests ignoring it", async () => {
  const server = buildServer();
  const userId = `suggest-9c-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([{ id: "m1", subject: "Kraken jobs", from: "jobs@kraken.example", body: "This week's top engineering roles across our partner network." }]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "m1", subject: "Kraken jobs", from: "jobs@kraken.example", reason: "uncertain signal" });

      mockUnderstanding({
        emailKind: "job_alert",
        relevance: "noise",
        goalRelevance: "unrelated",
        summary: "A job-alert newsletter.",
        why: ["top engineering roles", "partner network"],
        suggestedUserAction: "monitor",
        confidence: 0.9,
        keyDetails: null,
        keyFacts: []
      });
      await sendAgentMessage(server, userId, "show email reviews");
      const reply = await sendAgentMessage(server, userId, "details for 1");

      assert.match(reply.reply, /Ignore/i);
    });
  } finally {
    clearUnderstandingMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 10: exact live regression replay ---

test("10. exact live replay: Iqana stale row, clean list/detail, mark-as-CV-sent for its stated date, honest today/week totals", async () => {
  const server = buildServer();
  const userId = `live-replay-10-${randomUUID()}`;
  const noisyBody = [
    "Se ha enviado tu solicitud a Iqana.",
    "Software Engineer.",
    "Solicitado el 1 de septiembre de 2026.",
    "View job: https://www.linkedin.com/comm/jobs/view/998877?trk=flagship3_search_srp_jobcard&refId=zz9988",
    "Jobs you may be interested in:",
    "Backend Engineer at OtherCo",
    "----------------------------------------"
  ].join("\n");
  const restoreFetch = installGmailFullFetchMock([{ id: "m1", subject: "Iqana", from: "no-reply@iqana.example", body: noisyBody }]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const goalResult = await createGoal(userId, { title: "Find a remote developer job", category: "career", templateId: "career.job_search" });
      const goal = goalResult.goal;
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id, goal.id);

      // 16 prior CVs this week, none today.
      for (let i = 0; i < 16; i += 1) {
        await prisma.event.create({
          data: { userId, type: "career.application_sent", source: "manual", timestamp: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), confidence: 1, data: {} }
        });
      }
      const review = await seedReview(userId, connection.id, rule.id, { providerMessageId: "m1", subject: "Iqana", from: "no-reply@iqana.example", reason: "uncertain signal" });

      mockUnderstanding({
        ...iqanaUnderstanding,
        keyDetails: { ...iqanaUnderstanding.keyDetails, appliedDate: "1 de septiembre de 2026" }
      });

      const list1 = await sendAgentMessage(server, userId, "show email reviews");
      assert.match(list1.reply, /Pending Gmail review:/i);
      assert.doesNotMatch(list1.reply, /details for 3/i);
      assert.doesNotMatch(list1.reply, /reject the Endesa one/i);

      const detail = await sendAgentMessage(server, userId, "details for 1");
      assert.match(detail.reply, /Company: Iqana/i);
      assert.match(detail.reply, /Role: Software Engineer/i);
      assert.doesNotMatch(detail.reply, /linkedin\.com\/comm\/jobs/i);
      assert.doesNotMatch(detail.reply, /Backend Engineer at OtherCo/i);
      assert.match(detail.reply, /Mark as CV sent/i);

      const mark = await sendAgentMessage(server, userId, "mark it as a CV sent");
      assert.match(mark.reply, /1 Sep/i);
      assert.doesNotMatch(mark.reply, /unexpected problem|hit an error/i);

      const after = await prisma.emailReviewItem.findUnique({ where: { id: review.id } });
      assert.equal(after?.status, "approved");

      const listAfter = await sendAgentMessage(server, userId, "show email reviews");
      assert.match(listAfter.reply, /no email reviews are waiting/i);

      const today = await sendAgentMessage(server, userId, "show today goal progress");
      assert.match(today.reply, /Today: 0/i);
      assert.match(today.reply, /This week: 17/i);

      const askToday = await sendAgentMessage(server, userId, "how many CVs i sent today?");
      assert.match(askToday.reply, /Today: 0/i);

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
