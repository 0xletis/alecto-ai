import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import test from "node:test";
import { createGoal, prisma } from "../packages/db/src/index.ts";
import { extractGenericEvidenceFields } from "../apps/api/src/email-reviews/email-review-service.ts";
import { buildServer, clearAgentRuntimeMocks, mockPlan, op, sendAgentMessage, seedUser } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * feat/gmail-rule-signal-mapping: closes the two gaps
 * audit/gmail-worker-observation-source found — gmail.rule.create never wired a goal/signal
 * mapping onto a new rule, and approving a custom_email_review never produced real goal evidence
 * even when a rule DID carry a goalId. Covers both ends generically (any goal category, never
 * job-search-specific): gmail.rule.create's own goalRef/signalKey/eventType resolution, and
 * approveEmailReviewForUser's new mapped-evidence branch, always falling back to the exact
 * pre-existing no-op behavior when no valid mapping exists.
 */

async function seedGmailConnection(userId: string) {
  await seedUser(userId);
  return prisma.integrationConnection.create({ data: { userId, integrationId: "gmail", status: "active", config: {} } });
}

async function seedPendingReview(input: {
  userId: string;
  connectionId: string;
  ruleId: string;
  subject: string;
  from: string;
  snippet: string;
}) {
  return prisma.emailReviewItem.create({
    data: {
      userId: input.userId,
      connectionId: input.connectionId,
      ruleId: input.ruleId,
      adapterId: "custom_email_review",
      provider: "gmail",
      providerMessageId: `msg-${randomUUID()}`,
      externalId: `gmail-review:${input.ruleId}:${randomUUID()}`,
      subject: input.subject,
      from: input.from,
      snippet: input.snippet,
      confidence: 0.8,
      reason: "custom_rule_match",
      extracted: {},
      status: "pending"
    }
  });
}

async function approveViaChat(server: ReturnType<typeof buildServer>, userId: string, reviewId: string, phrase: string) {
  mockPlan({ topic: "gmail_reviews", intent: "list", operations: [op("gmail.review.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
  await sendAgentMessage(server, userId, "what emails need my attention?");

  mockPlan({ topic: "gmail_reviews", intent: "approve", operations: [op("gmail.review.approve", { reviewId })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
  return sendAgentMessage(server, userId, phrase);
}

test("A: job-search generic mapping — a custom rule's eventType mapping logs real evidence, no job-search-specific code involved", async () => {
  const server = buildServer();
  const userId = `gmail-signal-a-${randomUUID()}`;

  try {
    const connection = await seedGmailConnection(userId);
    const jobGoal = await createGoal(userId, {
      title: "Find a new developer job",
      category: "career",
      targetMetrics: [{ key: "recruiter_replies", label: "recruiter replies", eventType: "career.recruiter_reply_received", aggregation: "count", window: "weekly" }]
    });
    if (jobGoal.duplicate) throw new Error("unexpected duplicate goal in test setup");

    const rule = await prisma.emailSignalRule.create({
      data: {
        userId,
        connectionId: connection.id,
        adapterId: "custom_email_review",
        name: "Recruiter replies",
        query: "recruiter",
        status: "active",
        createdBy: "user",
        goalId: jobGoal.goal.id,
        eventType: "career.recruiter_reply_received"
      }
    });
    const review = await seedPendingReview({
      userId,
      connectionId: connection.id,
      ruleId: rule.id,
      subject: "Re: your application",
      from: "recruiter@acme.example",
      snippet: "Thanks for applying — would you be free for a call this week?"
    });

    await approveViaChat(server, userId, review.id, "approve the recruiter one");

    const events = await prisma.event.findMany({ where: { userId } });
    assert.equal(events.length, 1, "the rule's own mapped eventType must produce one real event");
    assert.equal(events[0]?.type, "career.recruiter_reply_received");
    assert.equal((events[0]?.data as Record<string, unknown>).ruleId, rule.id);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("B: Endesa expense mapping — signalKey evidence is logged and the bill amount is extracted from the stored snippet", async () => {
  const server = buildServer();
  const userId = `gmail-signal-b-${randomUUID()}`;

  try {
    const connection = await seedGmailConnection(userId);
    const endesaGoal = await createGoal(userId, {
      title: "Keep Endesa bills under control",
      category: "admin",
      targetMetrics: [{ key: "endesa_bill_received", label: "Endesa bills received", signalKey: "endesa_bill_received", aggregation: "count", window: "weekly" }]
    });
    if (endesaGoal.duplicate) throw new Error("unexpected duplicate goal in test setup");

    const rule = await prisma.emailSignalRule.create({
      data: {
        userId,
        connectionId: connection.id,
        adapterId: "custom_email_review",
        name: "Endesa bills",
        query: "Endesa factura",
        status: "active",
        createdBy: "user",
        goalId: endesaGoal.goal.id,
        signalKey: "endesa_bill_received"
      }
    });
    const review = await seedPendingReview({
      userId,
      connectionId: connection.id,
      ruleId: rule.id,
      subject: "Your Endesa bill is ready",
      from: "noreply@endesa.example",
      snippet: "Your latest invoice amount is €43.20, due next month."
    });

    const reply = await approveViaChat(server, userId, review.id, "approve the Endesa one");

    const events = await prisma.event.findMany({ where: { userId } });
    assert.equal(events.length, 1);
    const data = events[0]?.data as Record<string, unknown>;
    assert.equal(data.signalKey, "endesa_bill_received");
    assert.equal(data.amount_eur, 43.2, "the €43.20 amount must be extracted from the review's own stored snippet, never invented");
    assert.match(reply.reply, /43\.20/, "the honest reply must name the real extracted amount, never a generic 'logged' message when a real figure was found");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("C: client invoice mapping — a USD amount is extracted the same generic way", async () => {
  const server = buildServer();
  const userId = `gmail-signal-c-${randomUUID()}`;

  try {
    const connection = await seedGmailConnection(userId);
    const invoiceGoal = await createGoal(userId, {
      title: "Track ClientCo invoices",
      category: "admin",
      targetMetrics: [{ key: "invoice_received", label: "invoices received", signalKey: "invoice_received", aggregation: "count", window: "weekly" }]
    });
    if (invoiceGoal.duplicate) throw new Error("unexpected duplicate goal in test setup");

    const rule = await prisma.emailSignalRule.create({
      data: {
        userId,
        connectionId: connection.id,
        adapterId: "custom_email_review",
        name: "Invoices from ClientCo",
        query: "invoice",
        status: "active",
        createdBy: "user",
        goalId: invoiceGoal.goal.id,
        signalKey: "invoice_received"
      }
    });
    const review = await seedPendingReview({
      userId,
      connectionId: connection.id,
      ruleId: rule.id,
      subject: "Invoice #4471 from ClientCo",
      from: "billing@clientco.example",
      snippet: "Amount due: $120.00, payable within 30 days."
    });

    const reply = await approveViaChat(server, userId, review.id, "approve the ClientCo one");

    const events = await prisma.event.findMany({ where: { userId } });
    assert.equal(events.length, 1);
    const data = events[0]?.data as Record<string, unknown>;
    assert.equal(data.signalKey, "invoice_received");
    assert.equal(data.amount_usd, 120);
    assert.match(reply.reply, /120/);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("D: travel mapping — a flight-change signal logs evidence and extracts an obvious date, generically, not a career/finance special case", async () => {
  const server = buildServer();
  const userId = `gmail-signal-d-${randomUUID()}`;

  try {
    const connection = await seedGmailConnection(userId);
    const travelGoal = await createGoal(userId, {
      title: "Prepare for Japan trip",
      category: "travel",
      targetMetrics: [{ key: "flight_changed", label: "flight changes", signalKey: "flight_changed", aggregation: "count", window: "weekly" }]
    });
    if (travelGoal.duplicate) throw new Error("unexpected duplicate goal in test setup");

    const rule = await prisma.emailSignalRule.create({
      data: {
        userId,
        connectionId: connection.id,
        adapterId: "custom_email_review",
        name: "Japan trip emails",
        query: "flight OR hotel OR booking",
        status: "active",
        createdBy: "user",
        goalId: travelGoal.goal.id,
        signalKey: "flight_changed"
      }
    });
    const review = await seedPendingReview({
      userId,
      connectionId: connection.id,
      ruleId: rule.id,
      subject: "Your flight time changed",
      from: "notifications@airline.example",
      snippet: "Flight NH123 to Tokyo Narita now departs March 5, 2027."
    });

    await approveViaChat(server, userId, review.id, "approve the flight one");

    const events = await prisma.event.findMany({ where: { userId } });
    assert.equal(events.length, 1);
    const data = events[0]?.data as Record<string, unknown>;
    assert.equal(data.signalKey, "flight_changed");
    assert.equal(data.date, "2027-03-05", "an unambiguous month-name date in the stored snippet must be extracted");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("E: gmail.rule.create with an ambiguous goal reference asks instead of guessing, and creates no rule at all — never a wrong-goal link", async () => {
  const server = buildServer();
  const userId = `gmail-signal-e-${randomUUID()}`;

  try {
    await seedGmailConnection(userId);
    const first = await createGoal(userId, { title: "Read more", category: "learning" });
    const second = await createGoal(userId, { title: "Read the Bible", category: "faith" });
    if (first.duplicate || second.duplicate) throw new Error("unexpected duplicate goal in test setup");

    mockPlan({
      topic: "gmail_tracking",
      intent: "create_review_first_gmail_rule",
      operations: [op("gmail.rule.create", { label: "Reading emails", goalRef: "read" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: "I can watch for reading-related emails. Want me to set that up?"
    });
    await sendAgentMessage(server, userId, "track reading emails for my read goal");

    const reply = await sendAgentMessage(server, userId, "yes");

    assert.match(reply.reply, /do you mean/i);
    assert.match(reply.reply, /read more/i);
    assert.match(reply.reply, /read the bible/i);

    const rules = await prisma.emailSignalRule.count({ where: { userId } });
    assert.equal(rules, 0, "an ambiguous goal reference must create no rule at all rather than guess which goal to link");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("F: an archived goal's rule mapping produces no evidence — evidence logging requires the linked goal to still be active", async () => {
  const server = buildServer();
  const userId = `gmail-signal-f-${randomUUID()}`;

  try {
    const connection = await seedGmailConnection(userId);
    const endesaGoal = await createGoal(userId, {
      title: "Keep Endesa bills under control",
      category: "admin",
      targetMetrics: [{ key: "endesa_bill_received", label: "Endesa bills received", signalKey: "endesa_bill_received", aggregation: "count", window: "weekly" }]
    });
    if (endesaGoal.duplicate) throw new Error("unexpected duplicate goal in test setup");

    const rule = await prisma.emailSignalRule.create({
      data: {
        userId,
        connectionId: connection.id,
        adapterId: "custom_email_review",
        name: "Endesa bills",
        query: "Endesa factura",
        status: "active",
        createdBy: "user",
        goalId: endesaGoal.goal.id,
        signalKey: "endesa_bill_received"
      }
    });
    await prisma.goal.update({ where: { id: endesaGoal.goal.id }, data: { status: "archived" } });

    const review = await seedPendingReview({
      userId,
      connectionId: connection.id,
      ruleId: rule.id,
      subject: "Your Endesa bill is ready",
      from: "noreply@endesa.example",
      snippet: "Your latest invoice amount is €43.20, due next month."
    });

    const reply = await approveViaChat(server, userId, review.id, "approve the Endesa one");

    const events = await prisma.event.count({ where: { userId } });
    assert.equal(events, 0, "no evidence may be logged once the linked goal is archived, even though the rule's own mapping is still configured");
    assert.match(reply.reply, /approved/i);

    const updatedReview = await prisma.emailReviewItem.findUnique({ where: { id: review.id } });
    assert.equal(updatedReview?.status, "approved", "the review itself is still approved — only evidence logging is withheld");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("G: a custom rule with a goalId but no signalKey/eventType mapping preserves the exact old no-op approval behavior", async () => {
  const server = buildServer();
  const userId = `gmail-signal-g-${randomUUID()}`;

  try {
    const connection = await seedGmailConnection(userId);
    const goal = await createGoal(userId, { title: "Track client invoices", category: "admin" });
    if (goal.duplicate) throw new Error("unexpected duplicate goal in test setup");

    const rule = await prisma.emailSignalRule.create({
      data: { userId, connectionId: connection.id, adapterId: "custom_email_review", name: "ClientCo emails", query: "clientco", status: "active", createdBy: "user", goalId: goal.goal.id }
    });
    const review = await seedPendingReview({
      userId,
      connectionId: connection.id,
      ruleId: rule.id,
      subject: "Invoice #4471 from ClientCo",
      from: "billing@clientco.example",
      snippet: "Your invoice for October services is attached."
    });

    const reply = await approveViaChat(server, userId, review.id, "approve the ClientCo one");

    const events = await prisma.event.count({ where: { userId } });
    assert.equal(events, 0, "no goalId->signalKey/eventType mapping exists on this rule, so no evidence may be invented");
    assert.match(reply.reply, /approved/i);

    const updatedReview = await prisma.emailReviewItem.findUnique({ where: { id: review.id } });
    assert.equal(updatedReview?.status, "approved");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("H: gmail.rule.create links the resolved goal and its matching signal onto the new rule", async () => {
  const server = buildServer();
  const userId = `gmail-signal-h-${randomUUID()}`;

  try {
    await seedGmailConnection(userId);
    const goal = await createGoal(userId, {
      title: "Track ClientCo invoices",
      category: "admin",
      targetMetrics: [{ key: "invoice_received", label: "invoices received", signalKey: "invoice_received", aggregation: "count", window: "weekly" }]
    });
    if (goal.duplicate) throw new Error("unexpected duplicate goal in test setup");

    mockPlan({
      topic: "gmail_tracking",
      intent: "create_review_first_gmail_rule",
      operations: [op("gmail.rule.create", { label: "ClientCo invoices", goalRef: "ClientCo invoices", signalKey: "invoice_received" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: "I can watch for ClientCo invoice emails and count them toward your invoices goal. Want me to set that up?"
    });
    await sendAgentMessage(server, userId, "track ClientCo invoices for my invoices goal");
    const reply = await sendAgentMessage(server, userId, "yes");

    assert.equal(reply.debug.mutationExecuted, true);
    const rules = await prisma.emailSignalRule.findMany({ where: { userId } });
    assert.equal(rules.length, 1);
    assert.equal(rules[0]?.goalId, goal.goal.id, "the resolved goal must be linked onto the new rule");
    assert.equal(rules[0]?.signalKey, "invoice_received");
    assert.match(reply.reply, /ClientCo invoices/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("I: an invented or ambiguous signal is never guessed onto a new rule — the rule still gets created, just unmapped", async () => {
  const server = buildServer();
  const userId = `gmail-signal-i-${randomUUID()}`;

  try {
    await seedGmailConnection(userId);
    const goal = await createGoal(userId, {
      title: "Track ClientCo invoices",
      category: "admin",
      targetMetrics: [
        { key: "invoice_received", label: "invoices received", signalKey: "invoice_received", aggregation: "count", window: "weekly" },
        { key: "invoice_paid", label: "invoices paid", signalKey: "invoice_paid", aggregation: "count", window: "weekly" }
      ]
    });
    if (goal.duplicate) throw new Error("unexpected duplicate goal in test setup");

    // The planner guesses a signalKey that matches NEITHER of the goal's two real declared
    // signals (a hallucinated hedge) — this must never be trusted onto the rule.
    mockPlan({
      topic: "gmail_tracking",
      intent: "create_review_first_gmail_rule",
      operations: [op("gmail.rule.create", { label: "ClientCo invoices", goalRef: "ClientCo invoices", signalKey: "invoice_amount" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: "I can watch for ClientCo invoice emails. Want me to set that up?"
    });
    await sendAgentMessage(server, userId, "track ClientCo invoices for my invoices goal");
    await sendAgentMessage(server, userId, "yes");

    const rules = await prisma.emailSignalRule.findMany({ where: { userId } });
    assert.equal(rules.length, 1);
    assert.equal(rules[0]?.goalId, goal.goal.id, "the goal link itself is still real and correct");
    assert.equal(rules[0]?.signalKey, null, "an invented signalKey that matches nothing the goal actually declares must never be stored");
    assert.equal(rules[0]?.eventType, null);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("J: privacy — extraction is a pure local function over already-stored text, and the email-review service has no LLM/OpenAI dependency", async () => {
  const fields = extractGenericEvidenceFields(
    "Subject: Your Endesa bill is ready. Snippet: amount is €43.20 due March 5, 2027. " +
      "This is a long simulated full email body paragraph that must never be sent anywhere, containing unrelated account numbers and personal details that only well-known keys may ever be extracted from."
  );

  assert.deepEqual(Object.keys(fields).sort(), ["amount_eur", "date"], "extraction must only ever produce the small set of well-known keys, never a raw-text field");
  assert.equal(fields.amount_eur, 43.2);
  assert.equal(fields.date, "2027-03-05");

  const source = readFileSync(new URL("../apps/api/src/email-reviews/email-review-service.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /openai/i, "the email-review service must have zero OpenAI/LLM dependency — evidence extraction and approval are fully deterministic, local code");
});
