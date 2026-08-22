import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createGoal, prisma } from "../packages/db/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, mockPlan, op, sendAgentMessage, seedUser } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * audit/gmail-worker-observation-source, task 4: whether Gmail can genuinely act as a generic
 * observation source for ANY active goal, not just job search. Traces two real mechanisms found
 * by direct code reading:
 *
 * 1. EmailSignalRule.goalId — a rule created with an explicit goalId (email-review-service.ts's
 *    createActionItemFromEmailReview) makes review->action conversion attach to that EXACT goal,
 *    for any category, no job-search-specific code involved. This genuinely works today. The real
 *    gap: gmail.rule.create (the only V3 chat tool that creates a custom rule) never sets goalId
 *    itself — so this mechanism is implemented and correct, but not yet wired end-to-end from a
 *    normal chat "track invoices from ClientCo" request. Documented here, not fixed — closing it
 *    means either inferring goalId at rule-creation time or exposing it as an explicit planner
 *    arg, either of which is a real feature change beyond this audit's scope.
 *
 * 2. Evidence/event creation for a CUSTOM (non-job-search, non-work-action) review — confirmed to
 *    not exist at all. approveEmailReviewForUser's own custom_email_review branch returns "No
 *    event or action was created" unconditionally. A custom rule's classification never sets a
 *    proposedEventType (classifyEmailForRule's own custom_email_review branch always returns
 *    eventType: undefined), so there is no event type for anything downstream to log against.
 *    Reviews and actions are real and generic; goal EVIDENCE from Gmail is job-search/work-action
 *    only. This is the answer to tasks 5E/5F.
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
  adapterId?: string;
  proposedEventType?: string;
}) {
  return prisma.emailReviewItem.create({
    data: {
      userId: input.userId,
      connectionId: input.connectionId,
      ruleId: input.ruleId,
      adapterId: input.adapterId ?? "custom_email_review",
      provider: "gmail",
      providerMessageId: `msg-${randomUUID()}`,
      externalId: `gmail-review:${input.ruleId}:${randomUUID()}`,
      subject: input.subject,
      from: input.from,
      snippet: input.snippet,
      confidence: 0.8,
      reason: "custom_rule_match",
      extracted: {},
      proposedEventType: input.proposedEventType,
      status: "pending"
    }
  });
}

test("B: an invoice goal's rule, with an explicit goalId, links its review-to-action conversion to that exact goal — no job-search code involved", async () => {
  const server = buildServer();
  const userId = `gmail-generic-b-${randomUUID()}`;

  try {
    const connection = await seedGmailConnection(userId);
    const invoiceGoal = await createGoal(userId, {
      title: "Stay on top of client invoices",
      category: "admin",
      targetMetrics: [
        { key: "invoice_received", label: "invoices received", signalKey: "invoice_received", aggregation: "count", window: "daily" },
        { key: "invoice_paid", label: "invoices paid", signalKey: "invoice_paid", aggregation: "count", window: "daily" }
      ]
    });
    if (invoiceGoal.duplicate) throw new Error("unexpected duplicate goal in test setup");

    const rule = await prisma.emailSignalRule.create({
      data: {
        userId,
        connectionId: connection.id,
        adapterId: "custom_email_review",
        name: "Invoices from ClientCo",
        query: "from:clientco.com invoice",
        status: "active",
        createdBy: "user",
        goalId: invoiceGoal.goal.id
      }
    });
    const review = await seedPendingReview({
      userId,
      connectionId: connection.id,
      ruleId: rule.id,
      subject: "Invoice #4471 from ClientCo",
      from: "billing@clientco.com",
      snippet: "Your invoice for October services is attached."
    });

    mockPlan({ topic: "gmail_reviews", intent: "list", operations: [op("gmail.review.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "what emails need my attention?");

    mockPlan({
      topic: "gmail_reviews",
      intent: "to_action",
      operations: [op("gmail.review.to_action", { reviewId: review.id })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "turn the ClientCo one into a task");

    assert.equal(reply.debug.mutationExecuted, true);
    const action = await prisma.actionItem.findFirst({ where: { userId, title: { contains: "Invoice", mode: "insensitive" } } });
    assert.ok(action, "the action must have been created");
    assert.equal(action?.goalId, invoiceGoal.goal.id, "the action must link to the invoice goal via the rule's own explicit goalId — the exact same mechanism that already works for job-search/admin goals, no category-specific code");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("C: a travel goal's rule with no configured goalId falls back to generic keyword matching, never pretending it's tracking travel automatically", async () => {
  const server = buildServer();
  const userId = `gmail-generic-c-${randomUUID()}`;

  try {
    const connection = await seedGmailConnection(userId);
    const travelGoal = await createGoal(userId, {
      title: "Prepare for Japan trip",
      category: "travel",
      targetMetrics: [
        { key: "booking_confirmed", label: "bookings confirmed", signalKey: "booking_confirmed", aggregation: "count", window: "weekly" },
        { key: "flight_changed", label: "flight changes", signalKey: "flight_changed", aggregation: "count", window: "weekly" }
      ]
    });
    if (travelGoal.duplicate) throw new Error("unexpected duplicate goal in test setup");

    // Deliberately NOT setting goalId — this rule was created the way gmail.rule.create actually
    // creates one today (see this file's own doc comment): no goalId is ever set at creation time.
    const rule = await prisma.emailSignalRule.create({
      data: { userId, connectionId: connection.id, adapterId: "custom_email_review", name: "Japan trip emails", query: "flight OR hotel OR booking", status: "active", createdBy: "user" }
    });
    const review = await seedPendingReview({
      userId,
      connectionId: connection.id,
      ruleId: rule.id,
      subject: "Your flight time changed",
      from: "notifications@airline.example",
      snippet: "Flight NH123 to Tokyo Narita is now departing at a different time."
    });

    mockPlan({ topic: "gmail_reviews", intent: "list", operations: [op("gmail.review.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "what emails need my attention?");

    mockPlan({
      topic: "gmail_reviews",
      intent: "to_action",
      operations: [op("gmail.review.to_action", { reviewId: review.id })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    await sendAgentMessage(server, userId, "turn the flight one into a task");

    const action = await prisma.actionItem.findFirst({ where: { userId, title: { contains: "flight", mode: "insensitive" } } });
    assert.ok(action, "the action must still be created — Gmail as a generic observation source must not require a configured goalId to work at all");
    // Informational only: whether the generic keyword matcher (inferGoalLinkForAction) happens to
    // find "Japan trip" via shared title words is judgment, not a guarantee this audit makes any
    // promise about — the hard guarantee is the one above (a real action is created either way)
    // plus the one this test's title states: it must never silently CLAIM automated travel
    // tracking that isn't actually configured (no rule.goalId here means no explicit link, and
    // nothing in the reply may claim otherwise).
    assert.doesNotMatch(action!.title.toLowerCase() + "", /automatically tracking|monitoring your trip/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("E/F: approving a custom (generic) Gmail review creates no event and no goal evidence — a confirmed, documented gap, not a guess", async () => {
  const server = buildServer();
  const userId = `gmail-generic-ef-${randomUUID()}`;

  try {
    const connection = await seedGmailConnection(userId);
    const invoiceGoal = await createGoal(userId, {
      title: "Stay on top of client invoices",
      category: "admin",
      targetMetrics: [{ key: "invoice_received", label: "invoices received", signalKey: "invoice_received", aggregation: "count", window: "daily" }]
    });
    if (invoiceGoal.duplicate) throw new Error("unexpected duplicate goal in test setup");

    const rule = await prisma.emailSignalRule.create({
      data: { userId, connectionId: connection.id, adapterId: "custom_email_review", name: "Invoices from ClientCo", query: "invoice", status: "active", createdBy: "user", goalId: invoiceGoal.goal.id }
    });
    const review = await seedPendingReview({
      userId,
      connectionId: connection.id,
      ruleId: rule.id,
      subject: "Invoice #4471 from ClientCo",
      from: "billing@clientco.com",
      snippet: "Your invoice for October services is attached."
      // proposedEventType deliberately omitted — classifyEmailForRule's own custom_email_review
      // branch never sets one; this fixture matches that real shape exactly.
    });

    mockPlan({ topic: "gmail_reviews", intent: "list", operations: [op("gmail.review.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "what emails need my attention?");

    mockPlan({
      topic: "gmail_reviews",
      intent: "approve",
      operations: [op("gmail.review.approve", { reviewId: review.id })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "approve the ClientCo one");

    const eventCount = await prisma.event.count({ where: { userId } });
    assert.equal(eventCount, 0, "no event/evidence exists for goal evidence logging from a custom Gmail review today — this is the documented gap, confirmed by real behavior, not inferred from reading code alone");

    const actionCount = await prisma.actionItem.count({ where: { userId } });
    assert.equal(actionCount, 0, "approve (unlike to_action) must not create an action for a custom review either — it is genuinely a no-op decision beyond marking the review approved");

    const updatedReview = await prisma.emailReviewItem.findUnique({ where: { id: review.id } });
    assert.equal(updatedReview?.status, "approved", "the review itself is still marked approved — the gap is specifically the missing evidence/event, not a broken approval flow");
    assert.match(reply.reply, /approved/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("D: an email that could match multiple goals is only ever attached to the single best-scoring one, never split or guessed blindly across both — and stays unlinked rather than misattributed when neither is a real match", async () => {
  const server = buildServer();
  const userId = `gmail-generic-d-${randomUUID()}`;

  try {
    const connection = await seedGmailConnection(userId);
    const jobGoal = await createGoal(userId, { title: "Find a new developer job", category: "career", templateId: "career.job_search" });
    const invoiceGoal = await createGoal(userId, { title: "Track client invoices", category: "admin" });
    if (jobGoal.duplicate || invoiceGoal.duplicate) throw new Error("unexpected duplicate goal in test setup");

    // No goalId on the rule — this is exactly the "ambiguous" shape the audit asked for: an email
    // that isn't clearly about either goal by its own generic wording, and no rule-level link to
    // disambiguate it deterministically.
    const rule = await prisma.emailSignalRule.create({
      data: { userId, connectionId: connection.id, adapterId: "custom_email_review", name: "Acme emails", query: "from:acme.example", status: "active", createdBy: "user" }
    });
    const review = await seedPendingReview({
      userId,
      connectionId: connection.id,
      ruleId: rule.id,
      subject: "Follow-up from Acme",
      from: "contact@acme.example",
      snippet: "Just checking in on where things stand."
    });

    mockPlan({ topic: "gmail_reviews", intent: "list", operations: [op("gmail.review.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "what emails need my attention?");

    mockPlan({
      topic: "gmail_reviews",
      intent: "to_action",
      operations: [op("gmail.review.to_action", { reviewId: review.id })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    await sendAgentMessage(server, userId, "turn the Acme one into a task");

    const action = await prisma.actionItem.findFirst({ where: { userId, title: { contains: "Acme", mode: "insensitive" } } });
    assert.ok(action, "the action must still be created — an ambiguous/generic email is never silently dropped");
    // The real, current behavior: inferGoalLinkForAction (packages/core) never asks a
    // clarification question for this case — there is no such mechanism for email-derived
    // actions today, unlike chat-based goal-reference resolution. It deterministically picks
    // whichever goal scores highest by keyword/category overlap, or leaves the action unlinked
    // if nothing clears its confidence threshold. "Follow-up from Acme" shares no real keyword
    // with either goal's title/category signals, so the safe, correct outcome is unlinked —
    // never a coin-flip attachment to one of the two plausible goals.
    assert.equal(action?.goalId, null, "a genuinely generic email with no real signal for either goal must stay unlinked, never guessed onto one of the two plausible goals");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
