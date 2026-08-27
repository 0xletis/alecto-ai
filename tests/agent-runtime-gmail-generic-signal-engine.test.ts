import { randomBytes, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { encryptSecretJson } from "../packages/core/src/index.ts";
import { prisma } from "../packages/db/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, mockPlan, op, sendAgentMessage, seedUser } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * fix/private-alpha-gmail-generic-signal-engine: Gmail is a generic readonly signal source, not a
 * job-search-only engine — job search stays as one built-in template on top of the SAME generic
 * rule + classification path every other domain (flights, insurance, car maintenance, bills,
 * broad admin deadlines) now goes through. See tests/gmail-adaptive-rule-matching.test.ts for the
 * underlying AI rule-match sync mechanics this file builds on (same mock convention), and
 * tests/agent-runtime-gmail-job-search-evidence.test.ts / tests/agent-runtime-gmail-live-
 * transcript-precision.test.ts for the job-search regression suite this branch must not disturb.
 */

interface MockGmailMessage {
  id: string;
  subject: string;
  from: string;
  snippet: string;
}

function installGmailFetchMock(messages: MockGmailMessage[]): () => void {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const urlText = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(urlText);

    if (url.hostname !== "gmail.googleapis.com") {
      return new Response("unexpected fetch", { status: 500 });
    }

    if (url.pathname === "/gmail/v1/users/me/messages") {
      const query = url.searchParams.get("q") ?? "";
      const isBroadRecentSweep = /^newer_than:\d+d$/.test(query);
      return new Response(
        JSON.stringify({ messages: isBroadRecentSweep ? messages.map((message) => ({ id: message.id })) : [] }),
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
        payload: {
          headers: [
            { name: "Subject", value: message.subject },
            { name: "From", value: message.from },
            { name: "Date", value: "Thu, 20 Aug 2026 09:00:00 +0200" }
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
  return prisma.integrationConnection.create({ data: { userId, integrationId: "gmail", status: "active", config: {} } });
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
          accessToken: `generic-engine-access-${randomUUID()}`,
          refreshToken: `generic-engine-refresh-${randomUUID()}`,
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

function installEncryptionKey(): () => void {
  const previous = process.env.ALECTO_SECRET_ENCRYPTION_KEY;
  process.env.ALECTO_SECRET_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  return () => {
    if (previous === undefined) delete process.env.ALECTO_SECRET_ENCRYPTION_KEY;
    else process.env.ALECTO_SECRET_ENCRYPTION_KEY = previous;
  };
}

function setRuleMatchMock(bySubject: Record<string, unknown>): () => void {
  const previous = process.env.GMAIL_RULE_MATCH_LLM_MOCK_RESPONSE;
  process.env.GMAIL_RULE_MATCH_LLM_MOCK_RESPONSE = JSON.stringify({ bySubject });
  return () => {
    if (previous === undefined) delete process.env.GMAIL_RULE_MATCH_LLM_MOCK_RESPONSE;
    else process.env.GMAIL_RULE_MATCH_LLM_MOCK_RESPONSE = previous;
  };
}

function matched(rule: { id: string; name: string }, title: string, reason: string, extra: Record<string, unknown> = {}) {
  return {
    shouldCreateReview: true,
    matchedRuleId: rule.id,
    matchedRuleName: rule.name,
    confidence: 0.9,
    reason,
    suggestedReviewTitle: title,
    detectedDateOrDeadline: null,
    skipReason: null,
    priority: null,
    signalKind: null,
    ...extra
  };
}

function skipped(reason: string) {
  return {
    shouldCreateReview: false,
    matchedRuleId: null,
    matchedRuleName: null,
    confidence: 0.9,
    reason,
    suggestedReviewTitle: null,
    detectedDateOrDeadline: null,
    skipReason: reason,
    priority: null,
    signalKind: null
  };
}

test("Task 3/9: gmail.rule.create with a description and domain persists BOTH generic fields onto the rule", async () => {
  const server = buildServer();
  const userId = `gmail-generic-create-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedGmailConnection(userId);

    mockPlan({
      topic: "gmail_tracking",
      intent: "create_review_first_gmail_rule",
      operations: [
        op("gmail.rule.create", {
          label: "Flight changes",
          description: "Flight delays, cancellations, gate or time changes, and boarding pass updates for any upcoming trip.",
          domain: "travel"
        })
      ],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: "I can watch Gmail readonly for flight changes and travel updates. I won't send emails or change labels. Enable this rule?"
    });
    await sendAgentMessage(server, userId, "watch my Gmail for flight changes");
    const reply = await sendAgentMessage(server, userId, "yes");

    assert.equal(reply.debug.mutationExecuted, true);
    const rule = await prisma.emailSignalRule.findFirst({ where: { userId, adapterId: "custom_email_review" } });
    assert.ok(rule);
    assert.equal(rule?.name, "Flight changes");
    assert.equal(rule?.domain, "travel");
    assert.match(rule?.description ?? "", /flight delays, cancellations/i);
    assert.equal(rule?.notifyPolicy, "review_only", "a brand-new custom rule defaults to review_only, never a surprise nudge");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("Task 4A: a real flight-cancellation email under a flight rule is classified high priority and reaches review", async () => {
  const restoreKey = installEncryptionKey();
  const server = buildServer();
  const userId = `gmail-generic-flight-${randomUUID()}`;
  const restoreFetch = installGmailFetchMock([
    {
      id: "m-flight",
      subject: "Your flight BA123 has been cancelled",
      from: "British Airways <noreply@ba.example>",
      snippet: "We're sorry to inform you that your flight BA123 on Friday has been cancelled."
    }
  ]);
  let restoreMock = () => {};

  try {
    await seedUser(userId);
    const connection = await seedGmailConnectionWithToken(userId);
    const rule = await prisma.emailSignalRule.create({
      data: {
        userId,
        connectionId: connection.id,
        adapterId: "custom_email_review",
        query: "no-layer1-match-zzz",
        name: "Flight changes",
        description: "Flight delays, cancellations, gate or time changes for any upcoming trip.",
        domain: "travel",
        status: "active",
        createdBy: "user"
      }
    });
    restoreMock = setRuleMatchMock({
      "Your flight BA123 has been cancelled": matched(rule, "Flight BA123 cancelled", "Matches flight-changes rule", {
        priority: "high",
        signalKind: "flight_cancellation"
      })
    });

    const sync = await sendAgentMessage(server, userId, "sync Gmail");
    assert.deepEqual(sync.operationsPlanned.map((operation) => operation.tool), ["gmail.sync"]);

    const review = await prisma.emailReviewItem.findFirst({ where: { userId, ruleId: rule.id } });
    assert.ok(review, "the flight-cancellation email must reach review");
    assert.equal(review?.status, "pending");
    assert.equal(review?.priority, "high", "a genuinely time-sensitive generic signal must be high priority, not just career.offer/interview");
    assert.equal(review?.domain, "travel", "the review's domain is denormalized from the matching rule");
    assert.equal(await prisma.event.count({ where: { userId, source: "gmail" } }), 0, "must never be silently auto-logged as an event");
  } finally {
    restoreMock();
    restoreFetch();
    restoreKey();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("Task 4B/4C: insurance-renewal and car-repair rules each classify their own domain's email as a normal-priority review", async () => {
  const restoreKey = installEncryptionKey();
  const server = buildServer();
  const userId = `gmail-generic-insurance-car-${randomUUID()}`;
  const restoreFetch = installGmailFetchMock([
    {
      id: "m-insurance",
      subject: "Your insurance policy renewal",
      from: "Acme Insurance <renewals@acmeinsurance.example>",
      snippet: "Your car insurance policy is up for renewal next month."
    },
    {
      id: "m-car",
      subject: "Your car service appointment is confirmed",
      from: "QuickFix Garage <appointments@quickfixgarage.example>",
      snippet: "Your vehicle service appointment is confirmed for Tuesday at 10am."
    }
  ]);
  let restoreMock = () => {};

  try {
    await seedUser(userId);
    const connection = await seedGmailConnectionWithToken(userId);
    const insuranceRule = await prisma.emailSignalRule.create({
      data: {
        userId,
        connectionId: connection.id,
        adapterId: "custom_email_review",
        query: "no-layer1-match-zzz",
        name: "Insurance renewal",
        description: "Insurance policy renewal notices, coverage changes, and premium updates.",
        domain: "insurance",
        status: "active",
        createdBy: "user"
      }
    });
    const carRule = await prisma.emailSignalRule.create({
      data: {
        userId,
        connectionId: connection.id,
        adapterId: "custom_email_review",
        query: "no-layer1-match-zzz",
        name: "Car repair updates",
        description: "Car/vehicle service appointments, repair estimates, and garage updates.",
        domain: "car",
        status: "active",
        createdBy: "user"
      }
    });
    restoreMock = setRuleMatchMock({
      "Your insurance policy renewal": matched(insuranceRule, "Review insurance renewal", "Matches insurance-renewal rule", { priority: "normal", signalKind: "insurance_renewal" }),
      "Your car service appointment is confirmed": matched(carRule, "Car service appointment confirmed", "Matches car-repair rule", { priority: "normal", signalKind: "appointment_scheduled" })
    });

    await sendAgentMessage(server, userId, "sync Gmail");

    const insuranceReview = await prisma.emailReviewItem.findFirst({ where: { userId, ruleId: insuranceRule.id } });
    assert.ok(insuranceReview);
    assert.equal(insuranceReview?.priority, "normal");
    assert.equal(insuranceReview?.domain, "insurance");

    const carReview = await prisma.emailReviewItem.findFirst({ where: { userId, ruleId: carRule.id } });
    assert.ok(carReview);
    assert.equal(carReview?.priority, "normal");
    assert.equal(carReview?.domain, "car");
  } finally {
    restoreMock();
    restoreFetch();
    restoreKey();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("Task 5A/5B: a newsletter is filtered before the LLM rule-matcher runs at all, unless a rule explicitly asks for newsletters", async () => {
  const restoreKey = installEncryptionKey();
  const server = buildServer();
  const userId = `gmail-generic-newsletter-prefilter-${randomUUID()}`;
  const restoreFetch = installGmailFetchMock([
    {
      id: "m-newsletter",
      subject: "Travel Deals Weekly Newsletter",
      from: "Travel Deals <deals@traveldealsweekly.example>",
      snippet: "This week's top travel deals. Unsubscribe from this newsletter anytime."
    }
  ]);
  let restoreMock = () => {};

  try {
    await seedUser(userId);
    const connection = await seedGmailConnectionWithToken(userId);
    const flightRule = await prisma.emailSignalRule.create({
      data: {
        userId,
        connectionId: connection.id,
        adapterId: "custom_email_review",
        query: "no-layer1-match-zzz",
        name: "Flight changes",
        description: "Flight delays, cancellations, and gate/time changes for any upcoming trip.",
        domain: "travel",
        status: "active",
        createdBy: "user"
      }
    });
    // If the deterministic prefilter did NOT run, this mock would still make it "match" - proving
    // the assertion below is actually exercising the prefilter, not just an unlucky LLM response.
    restoreMock = setRuleMatchMock({
      "Travel Deals Weekly Newsletter": matched(flightRule, "Travel deals", "matched anyway (should never be reached)")
    });

    const sync = await sendAgentMessage(server, userId, "sync Gmail");
    assert.deepEqual(sync.operationsPlanned.map((operation) => operation.tool), ["gmail.sync"]);

    assert.equal(await prisma.emailReviewItem.count({ where: { userId } }), 0, "a bulk newsletter must never reach review when no active rule explicitly wants newsletters");
  } finally {
    restoreMock();
    restoreFetch();
    restoreKey();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("Task 5B: a rule that explicitly asks for newsletters is exempt from the generic newsletter prefilter", async () => {
  const restoreKey = installEncryptionKey();
  const server = buildServer();
  const userId = `gmail-generic-newsletter-optin-${randomUUID()}`;
  const restoreFetch = installGmailFetchMock([
    {
      id: "m-newsletter",
      subject: "Travel Deals Weekly Newsletter",
      from: "Travel Deals <deals@traveldealsweekly.example>",
      snippet: "This week's top travel deals. Unsubscribe from this newsletter anytime."
    }
  ]);
  let restoreMock = () => {};

  try {
    await seedUser(userId);
    const connection = await seedGmailConnectionWithToken(userId);
    const newsletterRule = await prisma.emailSignalRule.create({
      data: {
        userId,
        connectionId: connection.id,
        adapterId: "custom_email_review",
        query: "no-layer1-match-zzz",
        name: "Track travel newsletters",
        description: "Track travel deal newsletters I've explicitly asked to keep an eye on.",
        domain: "travel",
        status: "active",
        createdBy: "user"
      }
    });
    restoreMock = setRuleMatchMock({
      "Travel Deals Weekly Newsletter": matched(newsletterRule, "Travel deals newsletter", "Matches explicit newsletter-tracking rule")
    });

    await sendAgentMessage(server, userId, "sync Gmail");

    assert.equal(
      await prisma.emailReviewItem.count({ where: { userId, ruleId: newsletterRule.id } }),
      1,
      "a rule that explicitly names newsletters must still be able to match one"
    );
  } finally {
    restoreMock();
    restoreFetch();
    restoreKey();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("Task 5C/5D: a bare security code under a general rule is not progress, but an explicit verification-code rule can still review one", async () => {
  const restoreKey = installEncryptionKey();
  const server = buildServer();
  const userId = `gmail-generic-security-code-${randomUUID()}`;
  const restoreFetch = installGmailFetchMock([
    {
      id: "m-code",
      subject: "Your verification code",
      from: "Acme <security@acme.example>",
      snippet: "Your verification code is 559012. Enter this code to continue."
    }
  ]);
  let restoreMock = () => {};

  try {
    await seedUser(userId);
    const connection = await seedGmailConnectionWithToken(userId);
    const generalRule = await prisma.emailSignalRule.create({
      data: { userId, connectionId: connection.id, adapterId: "custom_email_review", name: "General admin", domain: "admin", query: "no-layer1-match-zzz", status: "active", createdBy: "user" }
    });
    restoreMock = setRuleMatchMock({
      "Your verification code": matched(generalRule, "Verification code", "matched anyway (should never be reached)")
    });

    await sendAgentMessage(server, userId, "sync Gmail");
    assert.equal(await prisma.emailReviewItem.count({ where: { userId } }), 0, "a bare security/verification code must never reach review under a general rule");
    assert.equal(await prisma.event.count({ where: { userId, source: "gmail" } }), 0);
  } finally {
    restoreMock();
    restoreFetch();
    restoreKey();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("Task 10: gmail status shows domain, tracking policy, and per-rule pending review counts across mixed built-in and custom rules", async () => {
  const server = buildServer();
  const userId = `gmail-generic-status-${randomUUID()}`;

  try {
    await seedUser(userId);
    const connection = await seedGmailConnection(userId);
    const jobRule = await prisma.emailSignalRule.create({
      data: {
        userId,
        connectionId: connection.id,
        adapterId: "job_search_email",
        name: "Job search emails",
        domain: "career",
        notifyPolicy: "notify",
        reviewBeforeLogging: false,
        status: "active",
        createdBy: "user"
      }
    });
    const flightRule = await prisma.emailSignalRule.create({
      data: {
        userId,
        connectionId: connection.id,
        adapterId: "custom_email_review",
        name: "Flight changes",
        domain: "travel",
        reviewBeforeLogging: true,
        status: "active",
        createdBy: "user"
      }
    });
    await prisma.emailReviewItem.create({
      data: {
        userId,
        connectionId: connection.id,
        ruleId: flightRule.id,
        adapterId: "custom_email_review",
        provider: "gmail",
        providerMessageId: "m1",
        externalId: `gmail-review:${flightRule.id}:m1`,
        subject: "Your flight has changed",
        snippet: "Gate change.",
        confidence: 0.9,
        reason: "ai_rule_match",
        extracted: {},
        priority: "high",
        domain: "travel",
        status: "pending"
      }
    });

    // refactor/private-alpha-goal-driven-gmail-operator (Task 7): default "gmail status" is now
    // goal-first, not a raw per-rule list — neither rule is linked to a goal here, so both fall
    // into the shared "General Gmail watch" bucket rather than showing individual rule names.
    mockPlan({ topic: "gmail", intent: "status", operations: [op("gmail.status", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const status = await sendAgentMessage(server, userId, "gmail status");

    assert.match(status.reply, /Gmail support:/);
    assert.match(status.reply, /General Gmail watch: on/);
    assert.doesNotMatch(status.reply, /Active rules:/, "the default status must never show the old raw rule list");
    assert.match(status.reply, /Pending reviews: 1 \(1 high priority\)/);

    // The rich per-rule detail (domain, exact tracking policy, notifyPolicy) still exists, just
    // moved to the explicit advanced view.
    mockPlan({ topic: "gmail", intent: "show_rules", operations: [op("gmail.rule.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const rulesView = await sendAgentMessage(server, userId, "show Gmail rules");

    assert.match(rulesView.reply, /Job search emails \(career\)/);
    assert.match(rulesView.reply, /auto-logs clear signals, reviews the rest/, "job_search_email is not purely review-first - the advanced view must say so accurately");
    assert.match(rulesView.reply, /Flight changes \(travel\)/);
    assert.match(rulesView.reply, /review-first tracking/);
    assert.ok(jobRule.id && flightRule.id);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("Task 6/8: no active rule means no scan at all, even with a connected Gmail account - the default is do nothing", async () => {
  const server = buildServer();
  const userId = `gmail-generic-no-rule-${randomUUID()}`;
  const restoreFetch = installGmailFetchMock([{ id: "m1", subject: "Anything", from: "someone@example.com", snippet: "Anything at all." }]);

  try {
    await seedUser(userId);
    await seedGmailConnection(userId);

    const sync = await sendAgentMessage(server, userId, "sync Gmail");
    assert.doesNotMatch(sync.reply, /I scanned Gmail/i, "must never claim a scan ran with no active rule");
    assert.equal(await prisma.emailReviewItem.count({ where: { userId } }), 0);
    assert.equal(await prisma.event.count({ where: { userId } }), 0);
  } finally {
    restoreFetch();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("Task 12 seeded simulation: an invoice/payment-reminder rule classifies a real invoice email as a normal-priority review, distinct from job-search/travel/insurance", async () => {
  const server = buildServer();
  const userId = `gmail-generic-invoice-${randomUUID()}`;
  const restoreKey = installEncryptionKey();
  const restoreFetch = installGmailFetchMock([
    {
      id: "m-invoice",
      subject: "Invoice #4471 - payment due",
      from: "ClientCo Billing <billing@clientco.example>",
      snippet: "Invoice #4471 for $1,200 is due on the 30th. Please arrange payment before the due date."
    }
  ]);
  let restoreMock = () => {};

  try {
    await seedUser(userId);
    const connection = await seedGmailConnectionWithToken(userId);
    const invoiceRule = await prisma.emailSignalRule.create({
      data: {
        userId,
        connectionId: connection.id,
        adapterId: "custom_email_review",
        name: "Invoices and payment reminders",
        description: "Invoices, payment reminders, and overdue-payment notices from clients or vendors.",
        domain: "finance",
        query: "no-layer1-match-zzz",
        status: "active",
        createdBy: "user"
      }
    });
    restoreMock = setRuleMatchMock({
      "Invoice #4471 - payment due": matched(invoiceRule, "Invoice #4471 due", "Matches invoice/payment-reminder rule", {
        priority: "normal",
        signalKind: "invoice_due"
      })
    });

    await sendAgentMessage(server, userId, "sync Gmail");

    const review = await prisma.emailReviewItem.findFirst({ where: { userId, ruleId: invoiceRule.id } });
    assert.ok(review, "the invoice email must reach review");
    assert.equal(review?.status, "pending");
    assert.equal(review?.domain, "finance");
    assert.equal(await prisma.event.count({ where: { userId, source: "gmail" } }), 0, "an invoice must never be silently auto-logged as paid/an event");
  } finally {
    restoreMock();
    restoreFetch();
    restoreKey();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
