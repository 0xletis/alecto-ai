import { randomBytes, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createGoal } from "../packages/db/src/index.ts";
import { encryptSecretJson } from "../packages/core/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, mockPlan, op, prisma, seedUser, sendAgentMessage } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * fix/private-alpha-production-email-progress-truth: the CONFIRMED root cause of the live "Logged 1
 * CV sent" / goal.status-stays-unchanged contradiction — a goal created via the adaptive natural-
 * language flow (goal.create_apply) declares a signalKey-based metric for "applications sent," not
 * the eventType-based one the fixed template uses, so a tool that only ever wrote the canonical
 * career.application_sent-typed event had nothing that goal's own countEvidenceForMetric call would
 * ever recognize — a real "verifying a different metric than what's displayed" bug, reproduced here
 * directly against a goal shaped exactly like the live one. Gmail fetch and the LLM understanding
 * call are both mocked for determinism; the fetch mock rejects any non-GET request, so a passing
 * test is also proof no Gmail mutation occurred.
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
          accessToken: `truth-access-${randomUUID()}`,
          refreshToken: `truth-refresh-${randomUUID()}`,
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

/** Shapes a goal's targetMetrics EXACTLY like goal.create_apply (the adaptive, natural-language goal
 * creation flow) does — signalKey-based, never eventType-based, even for "applications sent." This
 * is the live-reproducing shape; a goal created via the fixed career.job_search TEMPLATE (as most of
 * the earlier sessions' tests used) never exhibited this bug, because it always declared the
 * eventType-based metric directly. */
async function createAdaptiveJobSearchGoal(userId: string, title: string) {
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

function captureConsole(): { logs: unknown[][]; errors: unknown[][]; restore: () => void } {
  const logs: unknown[][] = [];
  const errors: unknown[][] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => {
    logs.push(args);
  };
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  return {
    logs,
    errors,
    restore: () => {
      console.log = originalLog;
      console.error = originalError;
    }
  };
}

const darwinUnderstanding = {
  emailKind: "application_confirmation",
  relevance: "medium",
  goalRelevance: "direct",
  summary: "Darwin Recruitment confirmed receipt of your application.",
  why: ["se ha enviado tu solicitud", "Darwin Recruitment"],
  suggestedUserAction: "approve",
  confidence: 0.9,
  keyDetails: { company: "Darwin Recruitment", role: "Full Stack - React & NestJS", location: "Barcelona", appliedDate: null, status: null, nextStep: null },
  keyFacts: []
};

// --- Task 4/9: exact live replay against an ADAPTIVELY-created goal (the reproducing shape) ---

test("4/9. exact live replay: Darwin Recruitment, adaptive goal (signalKey metric) — mark as CV sent verifiably moves Today/Week", async () => {
  const server = buildServer();
  const userId = `live-replay-truth-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([{ id: "darwin-1", subject: "Darwin Recruitment", from: "no-reply@darwin.example", body: "Se ha enviado tu solicitud a Darwin Recruitment. Full Stack - React & NestJS. Aplicado el 2 de septiembre de 2026." }]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const goal = await createAdaptiveJobSearchGoal(userId, "Find a fully remote developer job, ideally in Web3");
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id, goal.id);

      for (let i = 0; i < 16; i += 1) {
        await prisma.event.create({
          data: { userId, type: "custom.goal_progress_logged", source: "manual", timestamp: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000), confidence: 1, data: { signalKey: "applications_sent" } }
        });
      }
      const review = await seedReview(userId, connection.id, rule.id, { providerMessageId: "darwin-1", subject: "Darwin Recruitment", from: "no-reply@darwin.example", reason: "uncertain signal" });

      const todayText = new Intl.DateTimeFormat("es-ES", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Madrid" }).format(new Date());
      mockUnderstanding({ ...darwinUnderstanding, keyDetails: { ...darwinUnderstanding.keyDetails, appliedDate: `Aplicado el ${todayText}` } });

      const before = await sendAgentMessage(server, userId, "show today goal progress");
      assert.match(before.reply, /Today: 0/i);
      assert.match(before.reply, /This week: 16/i);

      await sendAgentMessage(server, userId, "show email reviews");
      const detail = await sendAgentMessage(server, userId, "details for 1");
      assert.match(detail.reply, /application confirmation/i);

      const mark = await sendAgentMessage(server, userId, "mark it as cv sent");
      assert.match(mark.reply, /^Logged 1 CV sent/i);

      const after1 = await prisma.emailReviewItem.findUnique({ where: { id: review.id } });
      assert.equal(after1?.status, "approved");

      const today = await sendAgentMessage(server, userId, "show today goal progress");
      assert.match(today.reply, /Today: 1/i);
      assert.match(today.reply, /This week: 17/i);

      const askToday = await sendAgentMessage(server, userId, "how many CVs did I send today?");
      assert.match(askToday.reply, /Today: 1/i);
      assert.deepEqual(askToday.operationsPlanned.map((op) => op.tool), ["goal.status"]);

      const week = await sendAgentMessage(server, userId, "show this week goal progress");
      assert.match(week.reply, /This week: 17/i);

      // The canonical + bridge write must both exist, and both must dedupe correctly on a repeat.
      const canonicalEvents = await prisma.event.count({ where: { userId, type: "career.application_sent" } });
      const bridgeEvents = await prisma.event.count({ where: { userId, type: "custom.goal_progress_logged" } });
      assert.equal(canonicalEvents, 1);
      assert.equal(bridgeEvents, 17, "16 seeded + 1 real bridge write from the verified log");
    });
  } finally {
    clearUnderstandingMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 5: manual vs email-derived parity, against the SAME adaptive-goal shape ---

test("5. manual 'I sent 1 CV' and email-derived 'mark it as CV sent' aggregate identically for an adaptive goal", async () => {
  const server = buildServer();
  const userIdManual = `parity-manual-${randomUUID()}`;
  const userIdEmail = `parity-email-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([{ id: "darwin-2", subject: "Darwin Recruitment", from: "no-reply@darwin.example", body: "Se ha enviado tu solicitud a Darwin Recruitment." }]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userIdManual);
      await createAdaptiveJobSearchGoal(userIdManual, "Find a fully remote developer job");
      // "I sent 1 CV today" is a genuine, unstructured statement — unlike "show today goal
      // progress"/"mark it as cv sent" (both deterministic pre-planner shortcuts, exercised for
      // real elsewhere in this file), this one only ever reaches event.log_job_applications through
      // the real LLM planner, so it's mocked here the same way tests/agent-runtime-goal-evidence.test.ts
      // mocks the identical phrase shape.
      mockPlan({ topic: "goal_evidence", intent: "log_evidence", operations: [op("event.log_job_applications", { count: 1 })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
      const manualReply = await sendAgentMessage(server, userIdManual, "I sent 1 CV today");
      const manualStatus = await sendAgentMessage(server, userIdManual, "show today goal progress");

      await seedUser(userIdEmail);
      const goal = await createAdaptiveJobSearchGoal(userIdEmail, "Find a fully remote developer job");
      const connection = await seedGmailConnectionWithToken(userIdEmail);
      const rule = await seedRule(userIdEmail, connection.id, goal.id);
      await seedReview(userIdEmail, connection.id, rule.id, { providerMessageId: "darwin-2", subject: "Darwin Recruitment", from: "no-reply@darwin.example", reason: "uncertain signal" });
      mockUnderstanding(darwinUnderstanding);
      await sendAgentMessage(server, userIdEmail, "show email reviews");
      await sendAgentMessage(server, userIdEmail, "details for 1");
      const emailReply = await sendAgentMessage(server, userIdEmail, "mark it as cv sent");
      const emailStatus = await sendAgentMessage(server, userIdEmail, "show today goal progress");

      assert.doesNotMatch(manualReply.reply, /couldn't verify|unexpected problem/i);
      assert.doesNotMatch(emailReply.reply, /couldn't verify|unexpected problem/i);

      // Same metric key, same aggregation behavior — both show Today: 1 for their own account.
      assert.match(manualStatus.reply, /Today: 1/i);
      assert.match(emailStatus.reply, /Today: 1/i);

      const manualEvents = await prisma.event.findMany({ where: { userId: userIdManual } });
      const emailEvents = await prisma.event.findMany({ where: { userId: userIdEmail } });
      assert.ok(manualEvents.some((event) => event.type === "career.application_sent"), "manual path must write the canonical event type");
      assert.ok(emailEvents.some((event) => event.type === "career.application_sent"), "email-derived path must write the same canonical event type");
      assert.ok(manualEvents.some((event) => event.type === "custom.goal_progress_logged"), "manual path must bridge into the goal's own signalKey metric");
      assert.ok(emailEvents.some((event) => event.type === "custom.goal_progress_logged"), "email-derived path must bridge into the goal's own signalKey metric");
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

// --- Task 2: production-truth diagnostic logging ---

test("2A. a successful log writes a structured diagnostic including event id and verified true", async () => {
  const server = buildServer();
  const userId = `diag-2a-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([{ id: "darwin-3", subject: "Darwin Recruitment", from: "no-reply@darwin.example", body: "Se ha enviado tu solicitud." }]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const goal = await createAdaptiveJobSearchGoal(userId, "Find a remote job");
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id, goal.id);
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "darwin-3", subject: "Darwin Recruitment", from: "no-reply@darwin.example", reason: "uncertain signal" });
      mockUnderstanding(darwinUnderstanding);
      await sendAgentMessage(server, userId, "show email reviews");
      await sendAgentMessage(server, userId, "details for 1");

      const capture = captureConsole();
      try {
        await sendAgentMessage(server, userId, "mark it as cv sent");
      } finally {
        capture.restore();
      }

      const resultLog = capture.logs.find((entry) => entry[0] === "[executeProgressCommand] result");
      assert.ok(resultLog, "expected a structured result diagnostic to be logged");
      const payload = resultLog![1] as Record<string, unknown>;
      assert.ok(payload.eventIds, "diagnostic must include the created event id(s)");
      assert.equal(payload.verified, true);
      assert.equal(payload.responsePath, "logged");
    });
  } finally {
    clearUnderstandingMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2B. a duplicate attempt logs duplicate response path, no false 'logged' claim", async () => {
  const server = buildServer();
  const userId = `diag-2b-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([{ id: "darwin-4", subject: "Darwin Recruitment", from: "no-reply@darwin.example", body: "Se ha enviado tu solicitud." }]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const goal = await createAdaptiveJobSearchGoal(userId, "Find a remote job");
      const connection = await seedGmailConnectionWithToken(userId);
      const ruleA = await seedRule(userId, connection.id, goal.id);
      const ruleB = await seedRule(userId, connection.id, goal.id);
      await seedReview(userId, connection.id, ruleA.id, { providerMessageId: "darwin-4", subject: "Darwin Recruitment", from: "no-reply@darwin.example", reason: "uncertain signal", updatedAt: new Date(Date.now() - 1000) });
      await prisma.emailReviewItem.create({
        data: {
          userId,
          connectionId: connection.id,
          ruleId: ruleB.id,
          adapterId: "job_search_email",
          provider: "gmail",
          providerMessageId: "darwin-4",
          externalId: `gmail-review:${ruleB.id}:darwin-4`,
          status: "pending",
          subject: "Darwin Recruitment",
          from: "no-reply@darwin.example",
          confidence: 0.6,
          reason: "uncertain signal",
          extracted: {}
        }
      });
      mockUnderstanding(darwinUnderstanding);
      await sendAgentMessage(server, userId, "show email reviews");
      await sendAgentMessage(server, userId, "mark 1 as cv sent");

      const capture = captureConsole();
      let reply;
      try {
        reply = await sendAgentMessage(server, userId, "mark 1 as cv sent");
      } finally {
        capture.restore();
      }

      assert.doesNotMatch(reply.reply, /^Logged 1/i);
      const resultLog = capture.logs.find((entry) => entry[0] === "[executeProgressCommand] result");
      assert.ok(resultLog, "expected a structured result diagnostic on the duplicate path too");
      const payload = resultLog![1] as Record<string, unknown>;
      assert.equal(payload.responsePath, "duplicate");
    });
  } finally {
    clearUnderstandingMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2C. a forced verification failure logs verified false, review remains pending, no false 'logged' claim", async () => {
  const server = buildServer();
  const userId = `diag-2c-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([{ id: "darwin-5", subject: "Darwin Recruitment", from: "no-reply@darwin.example", body: "Se ha enviado tu solicitud." }]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const goal = await createAdaptiveJobSearchGoal(userId, "Find a remote job");
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id, goal.id);
      const review = await seedReview(userId, connection.id, rule.id, { providerMessageId: "darwin-5", subject: "Darwin Recruitment", from: "no-reply@darwin.example", reason: "uncertain signal" });
      mockUnderstanding(darwinUnderstanding);
      await sendAgentMessage(server, userId, "show email reviews");
      await sendAgentMessage(server, userId, "details for 1");

      process.env.EMAIL_PROGRESS_VERIFICATION_FORCE_FAIL = "true";
      const capture = captureConsole();
      let reply;
      try {
        reply = await sendAgentMessage(server, userId, "mark it as cv sent");
      } finally {
        capture.restore();
        delete process.env.EMAIL_PROGRESS_VERIFICATION_FORCE_FAIL;
      }

      assert.doesNotMatch(reply.reply, /^Logged/i);
      const resultLog = capture.logs.find((entry) => entry[0] === "[executeProgressCommand] result");
      assert.ok(resultLog, "expected a structured result diagnostic on the failure path");
      const payload = resultLog![1] as Record<string, unknown>;
      assert.equal(payload.verified, false);
      assert.equal(payload.responsePath, "verification_failed");

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

// --- Task 7: detail cleanup — no nulls, no separator garbage ---

test("7A/7B/7C. no 'Status: null' / 'Next step: null', and separator garbage after the date is collapsed", async () => {
  const server = buildServer();
  const userId = `cleanup-7-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([{ id: "darwin-6", subject: "Darwin Recruitment", from: "no-reply@darwin.example", body: "Se ha enviado tu solicitud a Darwin Recruitment. Aplicado el 2 de septiembre de 2026. ----------" }]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "darwin-6", subject: "Darwin Recruitment", from: "no-reply@darwin.example", reason: "uncertain signal" });

      // The real live failure mode: the model returns the STRING "null" instead of JSON null for
      // an unset field.
      mockUnderstanding({
        ...darwinUnderstanding,
        keyDetails: { company: "Darwin Recruitment", role: "Full Stack - React & NestJS", location: "Barcelona", appliedDate: "2 de septiembre de 2026", status: "null", nextStep: "null" }
      });
      await sendAgentMessage(server, userId, "show email reviews");
      const reply = await sendAgentMessage(server, userId, "details for 1");

      assert.doesNotMatch(reply.reply, /status: null/i);
      assert.doesNotMatch(reply.reply, /next step: null/i);
      assert.doesNotMatch(reply.reply, /-{4,}/);
      assert.match(reply.reply, /Company: Darwin Recruitment/i);
    });
  } finally {
    clearUnderstandingMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 8: LinkedIn profile/status notifications classified as noise ---

test("8A/8C. a LinkedIn 'no longer showing recruiters' profile-status email is not job-search progress", async () => {
  const server = buildServer();
  const userId = `classify-8ac-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([{ id: "li-status-1", subject: "Tu estado de búsqueda de empleo", from: "jobs-noreply@linkedin.com", body: "Ya no estás mostrando a los técnicos de selección que estás buscando empleo." }]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "li-status-1", subject: "Tu estado de búsqueda de empleo", from: "jobs-noreply@linkedin.com", reason: "uncertain signal" });

      mockUnderstanding({
        emailKind: "marketing",
        relevance: "low",
        goalRelevance: "unrelated",
        summary: "A LinkedIn profile visibility status notification, not a real job-search event.",
        why: ["ya no estas mostrando", "buscando empleo"],
        suggestedUserAction: "ignore",
        confidence: 0.85,
        keyDetails: null,
        keyFacts: []
      });
      await sendAgentMessage(server, userId, "show email reviews");
      const reply = await sendAgentMessage(server, userId, "details for 1");

      assert.doesNotMatch(reply.reply, /application confirmation/i);
      assert.doesNotMatch(reply.reply, /recruiter reply/i);
      assert.match(reply.reply, /ignore/i);
    });
  } finally {
    clearUnderstandingMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 9: job-offer classification precision ---

test("9A/9B. a generic recruiter opportunity is not mislabelled as a job offer", async () => {
  const server = buildServer();
  const userId = `classify-9ab-${randomUUID()}`;
  const restoreFetch = installGmailFullFetchMock([{ id: "oz-1", subject: "Opportunity at OpenZeppelin", from: "recruiter@openzeppelin.example", body: "Hi, I'm reaching out about a Senior Engineer opportunity at OpenZeppelin that matches your background. Let me know if you're interested in chatting." }]);

  try {
    await withGmailEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnectionWithToken(userId);
      const rule = await seedRule(userId, connection.id);
      await seedReview(userId, connection.id, rule.id, { providerMessageId: "oz-1", subject: "Opportunity at OpenZeppelin", from: "recruiter@openzeppelin.example", reason: "uncertain signal" });

      mockUnderstanding({
        emailKind: "recruiter_reply",
        relevance: "high",
        goalRelevance: "direct",
        summary: "A recruiter reached out about a Senior Engineer opportunity at OpenZeppelin.",
        why: ["reaching out about", "Senior Engineer opportunity"],
        suggestedUserAction: "turn_into_action",
        confidence: 0.85,
        keyDetails: { company: "OpenZeppelin", role: "Senior Engineer", location: null, appliedDate: null, status: null, nextStep: null },
        keyFacts: []
      });
      await sendAgentMessage(server, userId, "show email reviews");
      const reply = await sendAgentMessage(server, userId, "details for 1");

      assert.doesNotMatch(reply.reply, /job offer/i);
      assert.match(reply.reply, /recruiter reply/i);
    });
  } finally {
    clearUnderstandingMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
