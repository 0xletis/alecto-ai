import { randomBytes, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { encryptSecretJson } from "../packages/core/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, prisma, seedUser, sendAgentMessage } from "./helpers/agent-runtime-test-helpers.ts";

interface MockGmailMessage {
  id: string;
  subject: string;
  from: string;
  to?: string;
  date?: string;
  snippet: string;
  labelIds?: string[];
}

function installGmailAdaptiveFetchMock(messages: MockGmailMessage[]): () => void {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const urlText = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(urlText);

    if (url.hostname !== "gmail.googleapis.com") {
      return new Response("unexpected fetch", { status: 500 });
    }

    if (url.pathname === "/gmail/v1/users/me/messages") {
      const query = url.searchParams.get("q") ?? "";
      const matchesRecentMetadataPass = /^newer_than:\d+d$/.test(query);
      return new Response(
        JSON.stringify({ messages: matchesRecentMetadataPass ? messages.map((message) => ({ id: message.id })) : [] }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
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
        snippet: message.snippet,
        labelIds: message.labelIds ?? ["INBOX", "UNREAD"],
        payload: {
          headers: [
            { name: "Subject", value: message.subject },
            { name: "From", value: message.from },
            { name: "To", value: message.to ?? "letis@example.com" },
            { name: "Date", value: message.date ?? "Thu, 13 Aug 2026 09:00:00 +0200" }
          ]
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
          accessToken: `adaptive-access-${randomUUID()}`,
          refreshToken: `adaptive-refresh-${randomUUID()}`,
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

async function seedEmailRule(input: {
  userId: string;
  connectionId: string;
  adapterId: string;
  name: string;
  query?: string;
  goalId?: string;
}) {
  return prisma.emailSignalRule.create({
    data: {
      userId: input.userId,
      connectionId: input.connectionId,
      adapterId: input.adapterId,
      name: input.name,
      query: input.query ?? input.name,
      status: "active",
      classifierMode: "hybrid",
      reviewBeforeLogging: true,
      maxEventsPerSync: 10,
      createdBy: "user",
      goalId: input.goalId
    }
  });
}

function setGmailRuleMatchMock(bySubject: Record<string, unknown>): () => void {
  const previousMock = process.env.GMAIL_RULE_MATCH_LLM_MOCK_RESPONSE;
  const previousCapture = process.env.GMAIL_RULE_MATCH_LLM_CAPTURE_INPUT;
  process.env.GMAIL_RULE_MATCH_LLM_MOCK_RESPONSE = JSON.stringify({ bySubject });

  return () => {
    if (previousMock === undefined) delete process.env.GMAIL_RULE_MATCH_LLM_MOCK_RESPONSE;
    else process.env.GMAIL_RULE_MATCH_LLM_MOCK_RESPONSE = previousMock;

    if (previousCapture === undefined) delete process.env.GMAIL_RULE_MATCH_LLM_CAPTURE_INPUT;
    else process.env.GMAIL_RULE_MATCH_LLM_CAPTURE_INPUT = previousCapture;
    delete process.env.GMAIL_RULE_MATCH_LLM_CAPTURED_INPUT;
  };
}

function matched(rule: { id: string; name: string }, title: string, reason: string, confidence = 0.92) {
  return {
    shouldCreateReview: true,
    matchedRuleId: rule.id,
    matchedRuleName: rule.name,
    confidence,
    reason,
    suggestedReviewTitle: title,
    detectedDateOrDeadline: null,
    skipReason: null
  };
}

function skipped(reason: string) {
  return {
    shouldCreateReview: false,
    matchedRuleId: null,
    matchedRuleName: null,
    confidence: 0.93,
    reason,
    suggestedReviewTitle: null,
    detectedDateOrDeadline: null,
    skipReason: reason
  };
}

test("adaptive Gmail AI matching creates review items across active rule types", async () => {
  const previousKey = process.env.ALECTO_SECRET_ENCRYPTION_KEY;
  process.env.ALECTO_SECRET_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  const server = buildServer();
  const userId = `gmail-adaptive-rules-${randomUUID()}`;
  const messages: MockGmailMessage[] = [
    {
      id: "m-work",
      subject: "Brainstorm meeting",
      from: "Client <client@example.com>",
      snippet: "Scheduled a brainstorm meeting tomorrow to decide the launch plan."
    },
    {
      id: "m-endesa",
      subject: "Your Endesa bill is ready",
      from: "Endesa <no-reply@endesa.es>",
      snippet: "Your electricity bill for August is ready to review."
    },
    {
      id: "m-recruiter",
      subject: "Quick call about frontend role",
      from: "Recruiter <talent@example.com>",
      snippet: "Could we schedule a quick call about the frontend role this week?"
    },
    {
      id: "m-security",
      subject: "New login from unknown device",
      from: "Security <security@example.com>",
      snippet: "We noticed a new login from an unknown device."
    },
    {
      id: "m-apartment",
      subject: "Viewing appointment for apartment",
      from: "Rentals <agent@example.com>",
      snippet: "Your viewing appointment for the apartment is confirmed for tomorrow."
    }
  ];
  const restoreFetch = installGmailAdaptiveFetchMock(messages);
  let restoreMock = () => {};

  try {
    await seedUser(userId);
    const connection = await seedGmailConnection(userId);
    const work = await seedEmailRule({ userId, connectionId: connection.id, adapterId: "work_action_email", name: "Work action emails", query: "please review" });
    const endesa = await seedEmailRule({ userId, connectionId: connection.id, adapterId: "custom_email_review", name: "Endesa bills", query: "Endesa factura" });
    const recruiter = await seedEmailRule({ userId, connectionId: connection.id, adapterId: "job_search_email", name: "Job search emails", query: "recruiter application" });
    const security = await seedEmailRule({ userId, connectionId: connection.id, adapterId: "custom_email_review", name: "Security account alerts", query: "security login account" });
    const apartment = await seedEmailRule({ userId, connectionId: connection.id, adapterId: "custom_email_review", name: "Track apartment rental emails", query: "apartment rental viewing" });
    restoreMock = setGmailRuleMatchMock({
      "Brainstorm meeting": { ...matched(work, "Brainstorm meeting tomorrow", "Work meeting needs review"), detectedDateOrDeadline: "tomorrow" },
      "Your Endesa bill is ready": matched(endesa, "Review Endesa bill", "Matches Endesa bill tracking"),
      "Quick call about frontend role": matched(recruiter, "Reply to recruiter about frontend role", "Recruiter/job-search email"),
      "New login from unknown device": matched(security, "Review unknown-device login alert", "Matches explicit security/account alert rule"),
      "Viewing appointment for apartment": { ...matched(apartment, "Check apartment viewing appointment", "Matches custom apartment rental tracking"), detectedDateOrDeadline: "tomorrow" }
    });

    const sync = await sendAgentMessage(server, userId, "sync Gmail");
    assert.deepEqual(sync.operationsPlanned.map((operation) => operation.tool), ["gmail.sync"]);
    assert.match(sync.reply, /Gmail sync: 5 messages checked, 5 new review items\./);

    const reviews = await prisma.emailReviewItem.findMany({ where: { userId, status: "pending" }, orderBy: { subject: "asc" } });
    assert.equal(reviews.length, 5);
    assert.deepEqual(new Set(reviews.map((review) => review.ruleId)), new Set([work.id, endesa.id, recruiter.id, security.id, apartment.id]));
    assert.equal(reviews.every((review) => review.provider === "gmail"), true);
    assert.equal(reviews.every((review) => review.reason === "ai_rule_match"), true);
    assert.equal(await prisma.event.count({ where: { userId, source: "gmail" } }), 0);
  } finally {
    restoreMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
    if (previousKey === undefined) delete process.env.ALECTO_SECRET_ENCRYPTION_KEY;
    else process.env.ALECTO_SECRET_ENCRYPTION_KEY = previousKey;
  }
});

test("adaptive Gmail AI matching skips when no active rule matches and exposes safe debug", async () => {
  const previousKey = process.env.ALECTO_SECRET_ENCRYPTION_KEY;
  process.env.ALECTO_SECRET_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  const server = buildServer();
  const userId = `gmail-adaptive-skip-${randomUUID()}`;
  const restoreFetch = installGmailAdaptiveFetchMock([
    {
      id: "m-brainstorm",
      subject: "Brainstorm meeting",
      from: "Client <client@example.com>",
      snippet: "Scheduled a brainstorm meeting tomorrow."
    }
  ]);
  const restoreMock = setGmailRuleMatchMock({
    "Brainstorm meeting": skipped("no active rule matched")
  });

  try {
    await seedUser(userId);
    const connection = await seedGmailConnection(userId);
    await seedEmailRule({ userId, connectionId: connection.id, adapterId: "custom_email_review", name: "Endesa bills", query: "Endesa factura" });

    const sync = await sendAgentMessage(server, userId, "sync Gmail");
    assert.match(sync.reply, /Gmail sync: 1 messages checked, 0 new review items/);
    assert.match(sync.reply, /why did Gmail sync find nothing/i);
    assert.equal(await prisma.emailReviewItem.count({ where: { userId } }), 0);

    const debug = await sendAgentMessage(server, userId, "why did Gmail sync find nothing?");
    assert.deepEqual(debug.operationsPlanned.map((operation) => operation.tool), ["gmail.sync.debug"]);
    assert.match(debug.reply, /Gmail sync debug/);
    assert.match(debug.reply, /Brainstorm meeting/);
    assert.match(debug.reply, /skipped: no active rule matched/);
    assert.doesNotMatch(debug.reply, /accessToken|refreshToken|ciphertext|"iv"|"tag"|raw provider|Body:/i);
  } finally {
    restoreMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
    if (previousKey === undefined) delete process.env.ALECTO_SECRET_ENCRYPTION_KEY;
    else process.env.ALECTO_SECRET_ENCRYPTION_KEY = previousKey;
  }
});

test("adaptive Gmail AI matching sends only minimal safe email fields", async () => {
  const previousKey = process.env.ALECTO_SECRET_ENCRYPTION_KEY;
  const previousCapture = process.env.GMAIL_RULE_MATCH_LLM_CAPTURE_INPUT;
  process.env.ALECTO_SECRET_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  process.env.GMAIL_RULE_MATCH_LLM_CAPTURE_INPUT = "true";
  const server = buildServer();
  const userId = `gmail-adaptive-minimal-${randomUUID()}`;
  const restoreFetch = installGmailAdaptiveFetchMock([
    {
      id: "m-endesa",
      subject: "Your Endesa bill is ready",
      from: "Endesa <no-reply@endesa.es>",
      snippet: "Safe snippet only. Hidden full body must not be sent."
    }
  ]);
  let restoreMock = () => {};

  try {
    await seedUser(userId);
    const connection = await seedGmailConnection(userId);
    const rule = await seedEmailRule({ userId, connectionId: connection.id, adapterId: "custom_email_review", name: "Endesa bills", query: "Endesa factura" });
    restoreMock = setGmailRuleMatchMock({
      "Your Endesa bill is ready": matched(rule, "Review Endesa bill", "Matches Endesa bill tracking")
    });

    await sendAgentMessage(server, userId, "sync Gmail");
    const captured = process.env.GMAIL_RULE_MATCH_LLM_CAPTURED_INPUT ?? "";
    assert.match(captured, /Your Endesa bill is ready/);
    assert.match(captured, /Safe snippet only/);
    assert.doesNotMatch(captured, /bodyText|Body:|full email body|accessToken|refreshToken|ciphertext/i);
  } finally {
    restoreMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
    if (previousCapture === undefined) delete process.env.GMAIL_RULE_MATCH_LLM_CAPTURE_INPUT;
    else process.env.GMAIL_RULE_MATCH_LLM_CAPTURE_INPUT = previousCapture;
    delete process.env.GMAIL_RULE_MATCH_LLM_CAPTURED_INPUT;
    if (previousKey === undefined) delete process.env.ALECTO_SECRET_ENCRYPTION_KEY;
    else process.env.ALECTO_SECRET_ENCRYPTION_KEY = previousKey;
  }
});

test("adaptive Gmail AI matching does not duplicate existing pending reviews", async () => {
  const previousKey = process.env.ALECTO_SECRET_ENCRYPTION_KEY;
  process.env.ALECTO_SECRET_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  const server = buildServer();
  const userId = `gmail-adaptive-dedupe-${randomUUID()}`;
  const restoreFetch = installGmailAdaptiveFetchMock([
    {
      id: "m-endesa",
      subject: "Your Endesa bill is ready",
      from: "Endesa <no-reply@endesa.es>",
      snippet: "Your electricity bill is ready."
    }
  ]);
  let restoreMock = () => {};

  try {
    await seedUser(userId);
    const connection = await seedGmailConnection(userId);
    const rule = await seedEmailRule({ userId, connectionId: connection.id, adapterId: "custom_email_review", name: "Endesa bills", query: "Endesa factura" });
    restoreMock = setGmailRuleMatchMock({
      "Your Endesa bill is ready": matched(rule, "Review Endesa bill", "Matches Endesa bill tracking")
    });

    await sendAgentMessage(server, userId, "sync Gmail");
    const second = await sendAgentMessage(server, userId, "sync Gmail");

    assert.equal(await prisma.emailReviewItem.count({ where: { userId, ruleId: rule.id, status: "pending" } }), 1);
    assert.match(second.reply, /Gmail sync: 1 messages checked, 0 new review items/);
  } finally {
    restoreMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
    if (previousKey === undefined) delete process.env.ALECTO_SECRET_ENCRYPTION_KEY;
    else process.env.ALECTO_SECRET_ENCRYPTION_KEY = previousKey;
  }
});
