import { randomBytes, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { encryptSecretJson } from "../packages/core/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, prisma, seedUser, sendAgentMessage } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * fix/private-alpha-email-review-detail-and-general-mail-understanding (generic sweep full-body
 * follow-up): the generic AI rule-match sweep (syncGmailRecentMessagesAgainstActiveRules,
 * classifyGmailMessageAgainstRules) previously only ever saw headers + a short Gmail-provided
 * snippet — real signal for a custom/general-domain rule (an invoice amount and due date, a
 * flight's new time, an insurance claim update, an admin deadline) routinely lives in the body,
 * never the subject or snippet alone. This file covers the plumbing: a message that survives the
 * cheap deterministic noise prefilter now gets a second, readonly, on-demand full-body fetch,
 * cleaned/redacted through the exact same packages/core/src/email-content-cleaner.ts pipeline the
 * review-detail command and the primary per-rule sync already use, and passed to the LLM rule-
 * matcher as `bodyExcerpt` - never raw MIME/HTML, never sent for a message the cheap prefilter
 * already rejected. Real semantic "does the LLM correctly USE this body content" reasoning is
 * covered by the LLM eval scenarios (generic-email-rule-full-body tag), not here - these are
 * deterministic mock-classification tests that confirm the pipeline itself is correct and safe.
 */

interface MockGmailMessage {
  id: string;
  subject: string;
  from: string;
  to?: string;
  date?: string;
  snippet: string;
  body?: string;
  isHtml?: boolean;
}

function installGmailBodySweepFetchMock(messages: MockGmailMessage[]): () => void {
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
        labelIds: ["INBOX", "UNREAD"],
        payload: {
          mimeType: message.isHtml ? "text/html" : "text/plain",
          headers: [
            { name: "Subject", value: message.subject },
            { name: "From", value: message.from },
            { name: "To", value: message.to ?? "letis@example.com" },
            { name: "Date", value: message.date ?? "Thu, 13 Aug 2026 09:00:00 +0200" }
          ],
          body: message.body ? { data: Buffer.from(message.body, "utf8").toString("base64url") } : undefined
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
          accessToken: `sweep-access-${randomUUID()}`,
          refreshToken: `sweep-refresh-${randomUUID()}`,
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

async function seedEmailRule(input: { userId: string; connectionId: string; adapterId: string; name: string; description?: string; query?: string; goalId?: string }) {
  return prisma.emailSignalRule.create({
    data: {
      userId: input.userId,
      connectionId: input.connectionId,
      adapterId: input.adapterId,
      name: input.name,
      description: input.description,
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
  process.env.GMAIL_RULE_MATCH_LLM_CAPTURE_INPUT = "true";

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
    skipReason: null,
    priority: "normal",
    signalKind: null
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
    skipReason: reason,
    priority: null,
    signalKind: null
  };
}

function withEncryptionKey<T>(fn: () => Promise<T>): Promise<T> {
  const previousKey = process.env.ALECTO_SECRET_ENCRYPTION_KEY;
  process.env.ALECTO_SECRET_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  return fn().finally(() => {
    if (previousKey === undefined) delete process.env.ALECTO_SECRET_ENCRYPTION_KEY;
    else process.env.ALECTO_SECRET_ENCRYPTION_KEY = previousKey;
  });
}

// --- Task 2: the generic sweep reuses the shared cleaner/redactor ---

test("2A. generic sweep receives a cleaned text/plain body", async () => {
  const server = buildServer();
  const userId = `sweep-2a-${randomUUID()}`;
  const restoreFetch = installGmailBodySweepFetchMock([
    {
      id: "m-invoice",
      subject: "Your invoice #4821",
      from: "billing@acme.example",
      snippet: "Your invoice is ready.",
      body: "Your invoice #4821 for September is attached. Amount due: $120. Payment due by September 30."
    }
  ]);
  let restoreMock = () => {};

  try {
    await withEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnection(userId);
      const rule = await seedEmailRule({ userId, connectionId: connection.id, adapterId: "custom_email_review", name: "Invoices", description: "Invoices and payment due notices" });
      restoreMock = setGmailRuleMatchMock({ "Your invoice #4821": matched(rule, "Review invoice #4821", "Matches invoice tracking") });

      await sendAgentMessage(server, userId, "sync Gmail");
      const captured = process.env.GMAIL_RULE_MATCH_LLM_CAPTURED_INPUT ?? "";
      assert.match(captured, /bodyExcerpt/);
      assert.match(captured, /Amount due.*120|120.*Amount due/i);
      assert.match(captured, /September 30/);
    });
  } finally {
    restoreMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2B. generic sweep receives a cleaned HTML-fallback body, never raw tags", async () => {
  const server = buildServer();
  const userId = `sweep-2b-${randomUUID()}`;
  const restoreFetch = installGmailBodySweepFetchMock([
    {
      id: "m-flight",
      subject: "Your flight BA456 has changed",
      from: "no-reply@airline.example",
      snippet: "Your flight has changed.",
      isHtml: true,
      body: "<html><body><p>Your flight <b>BA456</b> has been <i>rescheduled</i> to 14:20 on September 3rd.</p></body></html>"
    }
  ]);
  let restoreMock = () => {};

  try {
    await withEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnection(userId);
      const rule = await seedEmailRule({ userId, connectionId: connection.id, adapterId: "custom_email_review", name: "Travel emails", description: "Flight and hotel booking updates" });
      restoreMock = setGmailRuleMatchMock({ "Your flight BA456 has changed": matched(rule, "Review flight change", "Matches travel tracking") });

      await sendAgentMessage(server, userId, "sync Gmail");
      const captured = process.env.GMAIL_RULE_MATCH_LLM_CAPTURED_INPUT ?? "";
      assert.match(captured, /BA456/);
      assert.match(captured, /rescheduled/);
      assert.doesNotMatch(captured, /<b>|<i>|<p>|<html>/i);
    });
  } finally {
    restoreMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2C. a security code in the body is redacted before the LLM ever sees it", async () => {
  const server = buildServer();
  const userId = `sweep-2c-${randomUUID()}`;
  const restoreFetch = installGmailBodySweepFetchMock([
    {
      id: "m-code",
      subject: "Confirm your appointment",
      from: "no-reply@clinic.example",
      snippet: "Please confirm your appointment.",
      body: "Please confirm your appointment for September 5th at 10am. Your confirmation code is 482913. This code is valid for 10 minutes."
    }
  ]);
  let restoreMock = () => {};

  try {
    await withEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnection(userId);
      const rule = await seedEmailRule({ userId, connectionId: connection.id, adapterId: "custom_email_review", name: "Appointments", description: "Admin/appointment notices" });
      restoreMock = setGmailRuleMatchMock({ "Confirm your appointment": matched(rule, "Review appointment", "Matches appointment tracking") });

      await sendAgentMessage(server, userId, "sync Gmail");
      const captured = process.env.GMAIL_RULE_MATCH_LLM_CAPTURED_INPUT ?? "";
      assert.doesNotMatch(captured, /482913/);
      assert.match(captured, /\[redacted\]/);
      assert.match(captured, /September 5th/);
    });
  } finally {
    restoreMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2D. a very long body is capped before reaching the LLM", async () => {
  const server = buildServer();
  const userId = `sweep-2d-${randomUUID()}`;
  const longBody = `Your invoice #9911 is ready. ${"Additional line item details and terms and conditions text. ".repeat(150)}`;
  const restoreFetch = installGmailBodySweepFetchMock([{ id: "m-long", subject: "Your invoice #9911", from: "billing@acme.example", snippet: "Your invoice is ready.", body: longBody }]);
  let restoreMock = () => {};

  try {
    await withEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnection(userId);
      const rule = await seedEmailRule({ userId, connectionId: connection.id, adapterId: "custom_email_review", name: "Invoices", description: "Invoices and payment due notices" });
      restoreMock = setGmailRuleMatchMock({ "Your invoice #9911": matched(rule, "Review invoice #9911", "Matches invoice tracking") });

      await sendAgentMessage(server, userId, "sync Gmail");
      const captured = process.env.GMAIL_RULE_MATCH_LLM_CAPTURED_INPUT ?? "";
      assert.ok(captured.length > 0);
      assert.ok(longBody.length > 4000, "sanity check: the seeded body is actually long");
      assert.ok(captured.length < longBody.length, "the captured LLM input must be capped, not the full raw body");
    });
  } finally {
    restoreMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2E. invisible/zero-width characters are removed from the body before the LLM sees it", async () => {
  const server = buildServer();
  const userId = `sweep-2e-${randomUUID()}`;
  const zeroWidthSpace = "\u200B";
  const restoreFetch = installGmailBodySweepFetchMock([
    {
      id: "m-invisible",
      subject: "Your invoice #7712",
      from: "billing@acme.example",
      snippet: "Your invoice is ready.",
      body: `Your invoice${zeroWidthSpace} #7712 is ready. Amount due: $85.`
    }
  ]);
  let restoreMock = () => {};

  try {
    await withEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnection(userId);
      const rule = await seedEmailRule({ userId, connectionId: connection.id, adapterId: "custom_email_review", name: "Invoices", description: "Invoices and payment due notices" });
      restoreMock = setGmailRuleMatchMock({ "Your invoice #7712": matched(rule, "Review invoice #7712", "Matches invoice tracking") });

      await sendAgentMessage(server, userId, "sync Gmail");
      const captured = process.env.GMAIL_RULE_MATCH_LLM_CAPTURED_INPUT ?? "";
      assert.doesNotMatch(captured, new RegExp(zeroWidthSpace));
      assert.match(captured, /Amount due.*85|85/);
    });
  } finally {
    restoreMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 4: deterministic prefilters stay in place; no category explosion ---

test("4A. a clear security/auth code is excluded before the LLM even runs", async () => {
  const server = buildServer();
  const userId = `sweep-4a-${randomUUID()}`;
  const restoreFetch = installGmailBodySweepFetchMock([
    { id: "m-code", subject: "Your verification code", from: "no-reply@service.example", snippet: "Your verification code is 118204.", body: "Your verification code is 118204. This code is valid for 10 minutes." }
  ]);
  let restoreMock = () => {};

  try {
    await withEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnection(userId);
      const rule = await seedEmailRule({ userId, connectionId: connection.id, adapterId: "custom_email_review", name: "General tracking", description: "Anything important" });
      restoreMock = setGmailRuleMatchMock({ "Your verification code": matched(rule, "should never be reached", "should never be reached") });

      await sendAgentMessage(server, userId, "sync Gmail");
      const captured = process.env.GMAIL_RULE_MATCH_LLM_CAPTURED_INPUT ?? "";
      assert.equal(captured, "", "the LLM rule-matcher must never even be called for a clear security code");
      const reviews = await prisma.emailReviewItem.count({ where: { userId } });
      assert.equal(reviews, 0);
    });
  } finally {
    restoreMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4B. a newsletter/job alert is still not promoted to review", async () => {
  const server = buildServer();
  const userId = `sweep-4b-${randomUUID()}`;
  const restoreFetch = installGmailBodySweepFetchMock([
    { id: "m-news", subject: "Weekly jobs newsletter", from: "jobs@boardsite.example", snippet: "Top jobs this week.", body: "Here are the top jobs this week. Unsubscribe at any time." }
  ]);
  let restoreMock = () => {};

  try {
    await withEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnection(userId);
      const rule = await seedEmailRule({ userId, connectionId: connection.id, adapterId: "custom_email_review", name: "General tracking", description: "Anything important" });
      restoreMock = setGmailRuleMatchMock({ "Weekly jobs newsletter": matched(rule, "should never be reached", "should never be reached") });

      await sendAgentMessage(server, userId, "sync Gmail");
      const captured = process.env.GMAIL_RULE_MATCH_LLM_CAPTURED_INPUT ?? "";
      assert.equal(captured, "", "the LLM rule-matcher must never even be called for a clear newsletter");
      const reviews = await prisma.emailReviewItem.count({ where: { userId } });
      assert.equal(reviews, 0);
    });
  } finally {
    restoreMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4C. invoice/travel/admin custom rules work through the same general pipeline, no hardcoded sender", async () => {
  const server = buildServer();
  const userId = `sweep-4c-${randomUUID()}`;
  const restoreFetch = installGmailBodySweepFetchMock([
    { id: "m-invoice", subject: "Your invoice #1", from: "billing@some-random-vendor.example", snippet: "Invoice ready.", body: "Your invoice #1 is ready. Amount due: $50, due October 1." },
    { id: "m-flight", subject: "Flight change", from: "ops@another-random-airline.example", snippet: "Flight update.", body: "Your flight XY123 departure time changed to 09:15." },
    { id: "m-itv", subject: "ITV appointment reminder", from: "notices@random-gov-site.example", snippet: "ITV reminder.", body: "Your vehicle inspection (ITV) appointment is scheduled for October 12 at 09:00." }
  ]);
  let restoreMock = () => {};

  try {
    await withEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnection(userId);
      const invoiceRule = await seedEmailRule({ userId, connectionId: connection.id, adapterId: "custom_email_review", name: "Invoices", description: "Invoices and payment due notices" });
      const travelRule = await seedEmailRule({ userId, connectionId: connection.id, adapterId: "custom_email_review", name: "Travel", description: "Flight and travel updates" });
      const carRule = await seedEmailRule({ userId, connectionId: connection.id, adapterId: "custom_email_review", name: "Car admin", description: "ITV, fines, and car admin notices" });
      restoreMock = setGmailRuleMatchMock({
        "Your invoice #1": matched(invoiceRule, "Review invoice #1", "Matches invoice tracking"),
        "Flight change": matched(travelRule, "Review flight change", "Matches travel tracking"),
        "ITV appointment reminder": matched(carRule, "Review ITV appointment", "Matches car admin tracking")
      });

      await sendAgentMessage(server, userId, "sync Gmail");
      const reviews = await prisma.emailReviewItem.findMany({ where: { userId } });
      assert.equal(reviews.length, 3);
      assert.ok(reviews.some((r) => r.ruleId === invoiceRule.id));
      assert.ok(reviews.some((r) => r.ruleId === travelRule.id));
      assert.ok(reviews.some((r) => r.ruleId === carRule.id));
    });
  } finally {
    restoreMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4D. a low-confidence match asks for review, never auto-logs", async () => {
  const server = buildServer();
  const userId = `sweep-4d-${randomUUID()}`;
  const restoreFetch = installGmailBodySweepFetchMock([
    { id: "m-ambiguous", subject: "About your recent activity", from: "notices@random-service.example", snippet: "Some activity happened.", body: "There was some recent activity on your account. Details are unclear." }
  ]);
  let restoreMock = () => {};

  try {
    await withEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnection(userId);
      const rule = await seedEmailRule({ userId, connectionId: connection.id, adapterId: "custom_email_review", name: "General tracking", description: "Anything important" });
      await prisma.emailSignalRule.update({ where: { id: rule.id }, data: { minReviewConfidence: 0.6 } });
      restoreMock = setGmailRuleMatchMock({ "About your recent activity": matched(rule, "Review ambiguous activity", "Low confidence match", 0.3) });

      await sendAgentMessage(server, userId, "sync Gmail");
      const events = await prisma.event.count({ where: { userId, source: "gmail" } });
      assert.equal(events, 0, "a low-confidence match must never auto-log as a real event");
      const reviews = await prisma.emailReviewItem.count({ where: { userId } });
      assert.equal(reviews, 0, "below minReviewConfidence, it should not even become a review - it is simply skipped, not silently promoted");
    });
  } finally {
    restoreMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 5: cost/rate-limit protection ---

test("5A. a message already processed by the primary per-rule sync is never re-fetched by the generic sweep", async () => {
  const server = buildServer();
  const userId = `sweep-5a-${randomUUID()}`;
  let fullFetchCount = 0;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const urlText = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(urlText);
    if (url.hostname !== "gmail.googleapis.com") return new Response("unexpected fetch", { status: 500 });

    if (url.pathname === "/gmail/v1/users/me/messages") {
      return new Response(JSON.stringify({ messages: [{ id: "m-shared" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }

    if (url.pathname.endsWith("/m-shared")) {
      fullFetchCount += 1;
      return new Response(
        JSON.stringify({
          id: "m-shared",
          threadId: "thread-m-shared",
          snippet: "Thank you for applying to Innovation Labs.",
          payload: {
            mimeType: "text/plain",
            headers: [
              { name: "Subject", value: "Thank you for applying to Innovation Labs" },
              { name: "From", value: "no-reply@innovationlabs.example" },
              { name: "Date", value: "Thu, 13 Aug 2026 09:00:00 +0200" }
            ],
            body: { data: Buffer.from("Thank you for applying to Innovation Labs. We have received your application.", "utf8").toString("base64url") }
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  try {
    await withEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnection(userId);
      await seedEmailRule({ userId, connectionId: connection.id, adapterId: "job_search_email", name: "Job search emails", query: "newer_than:30d" });

      await sendAgentMessage(server, userId, "sync Gmail");
      // The primary per-rule sync (job_search_email) already fully fetched "m-shared" via its own
      // gmailMessageToText path; the generic sweep's own processedMessageIds check must skip it
      // entirely rather than fetching it a second time.
      assert.equal(fullFetchCount, 1, `expected exactly one full fetch for the shared message, got ${fullFetchCount}`);
    });
  } finally {
    globalThis.fetch = previousFetch;
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("5B. the per-sync full-body fetch cap is respected", async () => {
  const server = buildServer();
  const userId = `sweep-5b-${randomUUID()}`;
  const messages: MockGmailMessage[] = Array.from({ length: 5 }, (_, i) => ({
    id: `m-${i}`,
    subject: `Invoice number ${i}`,
    from: "billing@acme.example",
    snippet: "Invoice ready.",
    body: `Invoice number ${i}. Amount due: $${10 + i}.`
  }));
  const restoreFetch = installGmailBodySweepFetchMock(messages);
  let restoreMock = () => {};
  const previousCap = process.env.GMAIL_RULE_MATCH_MAX_BODY_FETCHES_PER_SYNC;
  process.env.GMAIL_RULE_MATCH_MAX_BODY_FETCHES_PER_SYNC = "2";

  try {
    await withEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnection(userId);
      const rule = await seedEmailRule({ userId, connectionId: connection.id, adapterId: "custom_email_review", name: "Invoices", description: "Invoices and payment due notices" });
      restoreMock = setGmailRuleMatchMock({
        "Invoice number 0": matched(rule, "Review invoice 0", "match"),
        "Invoice number 1": matched(rule, "Review invoice 1", "match"),
        "Invoice number 2": matched(rule, "Review invoice 2", "match"),
        "Invoice number 3": matched(rule, "Review invoice 3", "match"),
        "Invoice number 4": matched(rule, "Review invoice 4", "match")
      });

      await sendAgentMessage(server, userId, "sync Gmail");
      const reviews = await prisma.emailReviewItem.findMany({ where: { userId } });
      const withBodyEvidence = reviews.filter((r) => (r.evidence ?? "").includes("Amount due"));
      assert.ok(withBodyEvidence.length <= 2, `expected at most 2 reviews to have used a full-body fetch, got ${withBodyEvidence.length}`);
    });
  } finally {
    if (previousCap === undefined) delete process.env.GMAIL_RULE_MATCH_MAX_BODY_FETCHES_PER_SYNC;
    else process.env.GMAIL_RULE_MATCH_MAX_BODY_FETCHES_PER_SYNC = previousCap;
    restoreMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("5C. a body-fetch failure falls back honestly to snippet-only classification, does not drop the message", async () => {
  const server = buildServer();
  const userId = `sweep-5c-${randomUUID()}`;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const urlText = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(urlText);
    if (url.hostname !== "gmail.googleapis.com") return new Response("unexpected fetch", { status: 500 });

    if (url.pathname === "/gmail/v1/users/me/messages") {
      // Gated to the generic sweep's own newer_than:Nd search pattern (like
      // installGmailBodySweepFetchMock above) so the PRIMARY per-rule sync - which searches by the
      // rule's own literal query string - never independently discovers this message and makes its
      // own full-format fetch, which would otherwise fail this test for an unrelated reason.
      const query = url.searchParams.get("q") ?? "";
      const matchesSweepSearch = /^newer_than:\d+d$/.test(query);
      return new Response(JSON.stringify({ messages: matchesSweepSearch ? [{ id: "m-flaky" }] : [] }), { status: 200, headers: { "content-type": "application/json" } });
    }

    if (url.pathname.endsWith("/m-flaky")) {
      const format = url.searchParams.get("format");
      if (format === "full") {
        return new Response("simulated transient failure", { status: 500 });
      }
      return new Response(
        JSON.stringify({
          id: "m-flaky",
          threadId: "thread-m-flaky",
          snippet: "Your invoice is ready.",
          payload: {
            headers: [
              { name: "Subject", value: "Your invoice #5591" },
              { name: "From", value: "billing@acme.example" },
              { name: "Date", value: "Thu, 13 Aug 2026 09:00:00 +0200" }
            ]
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  let restoreMock = () => {};

  try {
    await withEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnection(userId);
      const rule = await seedEmailRule({ userId, connectionId: connection.id, adapterId: "custom_email_review", name: "Invoices", description: "Invoices and payment due notices" });
      restoreMock = setGmailRuleMatchMock({ "Your invoice #5591": matched(rule, "Review invoice #5591", "Matches invoice tracking, snippet only") });

      const reply = await sendAgentMessage(server, userId, "sync Gmail");
      assert.doesNotMatch(reply.reply, /unexpected problem|failed/i);
      const reviews = await prisma.emailReviewItem.count({ where: { userId } });
      assert.equal(reviews, 1, "the message must still be classified and reviewed from snippet alone when the body fetch fails");
    });
  } finally {
    globalThis.fetch = previousFetch;
    restoreMock();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("5D. a Gmail fetch error for one message does not crash the whole sync", async () => {
  const server = buildServer();
  const userId = `sweep-5d-${randomUUID()}`;
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const urlText = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(urlText);
    if (url.hostname !== "gmail.googleapis.com") return new Response("unexpected fetch", { status: 500 });

    if (url.pathname === "/gmail/v1/users/me/messages") {
      // Same gating as 5C above - only the generic sweep's own newer_than:Nd search should ever
      // discover these candidates, never the primary per-rule sync's own differently-queried search.
      const query = url.searchParams.get("q") ?? "";
      const matchesSweepSearch = /^newer_than:\d+d$/.test(query);
      return new Response(JSON.stringify({ messages: matchesSweepSearch ? [{ id: "m-good" }, { id: "m-bad" }] : [] }), { status: 200, headers: { "content-type": "application/json" } });
    }

    if (url.pathname.endsWith("/m-bad")) {
      return new Response("boom", { status: 500 });
    }

    if (url.pathname.endsWith("/m-good")) {
      return new Response(
        JSON.stringify({
          id: "m-good",
          threadId: "thread-m-good",
          snippet: "Your invoice is ready.",
          payload: {
            mimeType: "text/plain",
            headers: [
              { name: "Subject", value: "Your invoice #2201" },
              { name: "From", value: "billing@acme.example" },
              { name: "Date", value: "Thu, 13 Aug 2026 09:00:00 +0200" }
            ],
            body: { data: Buffer.from("Your invoice #2201 is ready. Amount due: $75.", "utf8").toString("base64url") }
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  let restoreMock = () => {};

  try {
    await withEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnection(userId);
      const rule = await seedEmailRule({ userId, connectionId: connection.id, adapterId: "custom_email_review", name: "Invoices", description: "Invoices and payment due notices" });
      restoreMock = setGmailRuleMatchMock({ "Your invoice #2201": matched(rule, "Review invoice #2201", "Matches invoice tracking") });

      const reply = await sendAgentMessage(server, userId, "sync Gmail");
      assert.doesNotMatch(reply.reply, /unexpected problem/i);
      const reviews = await prisma.emailReviewItem.count({ where: { userId } });
      assert.equal(reviews, 1, "the good message must still be processed even though the other message's fetch failed entirely");
    });
  } finally {
    globalThis.fetch = previousFetch;
    restoreMock();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 7: detail-command consistency after a generic full-body classified review ---

test("7A. an invoice review created by the generic sweep and its detail view agree", async () => {
  const server = buildServer();
  const userId = `sweep-7a-${randomUUID()}`;
  const restoreFetch = installGmailBodySweepFetchMock([
    { id: "m-invoice", subject: "Your invoice #3301", from: "billing@acme.example", snippet: "Invoice ready.", body: "Your invoice #3301 for September is ready. Amount due: $95. Payment due by September 28." }
  ]);
  let restoreMock = () => {};

  try {
    await withEncryptionKey(async () => {
      await seedUser(userId);
      const connection = await seedGmailConnection(userId);
      const rule = await seedEmailRule({ userId, connectionId: connection.id, adapterId: "custom_email_review", name: "Invoices", description: "Invoices and payment due notices" });
      restoreMock = setGmailRuleMatchMock({ "Your invoice #3301": matched(rule, "Review invoice #3301", "Matches invoice tracking") });

      await sendAgentMessage(server, userId, "sync Gmail");
      const listReply = await sendAgentMessage(server, userId, "show me email reviews");
      assert.match(listReply.reply, /invoice/i);

      process.env.EMAIL_UNDERSTANDING_MOCK_RESPONSE = JSON.stringify({
        emailKind: "invoice",
        relevance: "high",
        goalRelevance: "direct",
        summary: "Invoice #3301 for September is due, amount $95.",
        why: ["invoice #3301", "Amount due", "$95"],
        suggestedUserAction: "approve",
        confidence: 0.9
      });
      const detailReply = await sendAgentMessage(server, userId, "details for 1");
      assert.match(detailReply.reply, /invoice/i);
      assert.match(detailReply.reply, /\$95|95/);
    });
  } finally {
    delete process.env.EMAIL_UNDERSTANDING_MOCK_RESPONSE;
    restoreMock();
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
