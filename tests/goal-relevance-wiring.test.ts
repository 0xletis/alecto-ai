import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createGoal } from "../packages/db/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, prisma, seedUser, sendAgentMessage } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * refactor/private-alpha-general-email-intelligence-workflow (gate 1 hardening): Stage C
 * (packages/llm/src/prompts/goal-relevance.prompt.ts) wired into the default single-review detail
 * path (fetchAndUnderstandGmailReview, executor.ts) — but only as a FALLBACK when the existing,
 * heavily-tested rule-based resolution (resolveActiveGoalIdsForGmailRule) finds nothing. Every
 * fixture here uses a generic "custom_email_review" rule with no goalId, which the rule-based path
 * never resolves on its own (see gmailRuleKind/resolveGoalForBuiltInGmailRuleLinking in
 * gmail-autonomy.ts) — guaranteeing these tests actually exercise the NEW relevance wiring, not the
 * pre-existing path.
 */

async function seedGmailUser(userId: string): Promise<string> {
  await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
  const connection = await prisma.integrationConnection.create({ data: { userId, integrationId: "gmail", status: "active", config: {} } });
  return connection.id;
}

async function seedReview(userId: string, connectionId: string, ruleId: string, input: { providerMessageId: string; subject: string }) {
  return prisma.emailReviewItem.create({
    data: {
      userId,
      connectionId,
      ruleId,
      adapterId: "custom_email_review",
      provider: "gmail",
      providerMessageId: input.providerMessageId,
      externalId: `gmail-review:${ruleId}:${input.providerMessageId}`,
      subject: input.subject,
      from: "no-reply@example.com",
      snippet: input.subject,
      evidence: input.subject,
      confidence: 0.6,
      reason: "unknown",
      extracted: {},
      status: "pending",
      priority: "normal"
    }
  });
}

function mockUnderstanding(response: Record<string, unknown>): void {
  process.env.EMAIL_UNDERSTANDING_MOCK_RESPONSE = JSON.stringify(response);
}

function mockRelevance(response: Record<string, unknown>): void {
  process.env.GOAL_RELEVANCE_MOCK_RESPONSE = JSON.stringify(response);
}

function clearMocks(): void {
  delete process.env.EMAIL_UNDERSTANDING_MOCK_RESPONSE;
  delete process.env.GOAL_RELEVANCE_MOCK_RESPONSE;
  delete process.env.GOAL_RELEVANCE_MOCK_THROW;
}

const applicationConfirmationUnderstanding = {
  emailKind: "application_confirmation",
  relevance: "high",
  goalRelevance: "unclear",
  summary: "Confirms an application was submitted to Cohere for Software Engineer.",
  why: ["Thank you for applying to Cohere"],
  suggestedUserAction: "approve",
  confidence: 0.9,
  keyDetails: { company: "Cohere", role: "Software Engineer", location: null, appliedDate: null, status: null, nextStep: null },
  keyFacts: [],
  realWorldEvent: "Application to Cohere for Software Engineer",
  signalBucket: "new",
  ambiguity: null
};

test("A. one active job-search goal links an application confirmation correctly", async () => {
  const server = buildServer();
  const userId = `goal-relevance-a-${randomUUID()}`;

  try {
    await seedUser(userId);
    const goal = await createGoal(userId, { title: "Find a remote developer job", category: "career" }).then((r) => r.goal);
    const connectionId = await seedGmailUser(userId);
    const rule = await prisma.emailSignalRule.create({ data: { userId, connectionId, adapterId: "custom_email_review", name: "Cohere watcher", status: "active", createdBy: "user" } });
    await seedReview(userId, connectionId, rule.id, { providerMessageId: "m1", subject: "Thanks for applying to Cohere" });

    mockUnderstanding(applicationConfirmationUnderstanding);
    mockRelevance({ bestGoalId: goal.id, verdict: "direct", reason: "The email confirms a job application, matching this goal's own tracked activity.", requiresConfirmation: false });

    await sendAgentMessage(server, userId, "show email reviews");
    const detail = await sendAgentMessage(server, userId, "details for 1");

    assert.match(detail.reply, /Linked goal: Find a remote developer job/i);
  } finally {
    clearMocks();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("B. multiple goals: an invoice links the finance goal, never the job-search goal", async () => {
  const server = buildServer();
  const userId = `goal-relevance-b-${randomUUID()}`;

  try {
    await seedUser(userId);
    const jobGoal = await createGoal(userId, { title: "Find a remote developer job", category: "career" }).then((r) => r.goal);
    const financeGoal = await createGoal(userId, { title: "Track Endesa bills", category: "finance" }).then((r) => r.goal);
    const connectionId = await seedGmailUser(userId);
    const rule = await prisma.emailSignalRule.create({ data: { userId, connectionId, adapterId: "custom_email_review", name: "Endesa watcher", status: "active", createdBy: "user" } });
    await seedReview(userId, connectionId, rule.id, { providerMessageId: "m1", subject: "Invoice #4471 from Endesa" });

    mockUnderstanding({
      emailKind: "invoice",
      relevance: "high",
      goalRelevance: "unclear",
      summary: "An invoice from Endesa for 84.20 EUR, due September 15.",
      why: ["Invoice #4471"],
      suggestedUserAction: "turn_into_action",
      confidence: 0.9,
      keyDetails: null,
      keyFacts: ["Amount due: 84.20 EUR"],
      realWorldEvent: "Invoice #4471 from Endesa",
      signalBucket: "action_worthy",
      ambiguity: null
    });
    mockRelevance({ bestGoalId: financeGoal.id, verdict: "direct", reason: "An Endesa invoice matches the bill-tracking goal, not the job search.", requiresConfirmation: false });

    await sendAgentMessage(server, userId, "show email reviews");
    const detail = await sendAgentMessage(server, userId, "details for 1");

    assert.match(detail.reply, /Linked goal: Track Endesa bills/i);
    assert.doesNotMatch(detail.reply, /Linked goal: Find a remote developer job/i);
    void jobGoal;
  } finally {
    clearMocks();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("C. a travel email links the travel goal when one is present", async () => {
  const server = buildServer();
  const userId = `goal-relevance-c-${randomUUID()}`;

  try {
    await seedUser(userId);
    const travelGoal = await createGoal(userId, { title: "Plan the Japan trip", category: "travel" }).then((r) => r.goal);
    const connectionId = await seedGmailUser(userId);
    const rule = await prisma.emailSignalRule.create({ data: { userId, connectionId, adapterId: "custom_email_review", name: "Travel watcher", status: "active", createdBy: "user" } });
    await seedReview(userId, connectionId, rule.id, { providerMessageId: "m1", subject: "Your flight AB123 schedule change" });

    mockUnderstanding({
      emailKind: "flight_update",
      relevance: "high",
      goalRelevance: "unclear",
      summary: "Flight AB123's departure time changed to 14:20.",
      why: ["new departure time of 14:20"],
      suggestedUserAction: "monitor",
      confidence: 0.9,
      keyDetails: null,
      keyFacts: ["New departure time: 14:20"],
      realWorldEvent: "Flight change for booking AB123",
      signalBucket: "action_worthy",
      ambiguity: null
    });
    mockRelevance({ bestGoalId: travelGoal.id, verdict: "direct", reason: "A flight change matches the Japan trip planning goal.", requiresConfirmation: false });

    await sendAgentMessage(server, userId, "show email reviews");
    const detail = await sendAgentMessage(server, userId, "details for 1");

    assert.match(detail.reply, /Linked goal: Plan the Japan trip/i);
  } finally {
    clearMocks();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("D. unrelated marketing has no linked goal and no needs-decision noise", async () => {
  const server = buildServer();
  const userId = `goal-relevance-d-${randomUUID()}`;

  try {
    await seedUser(userId);
    await createGoal(userId, { title: "Find a remote developer job", category: "career" });
    const connectionId = await seedGmailUser(userId);
    const rule = await prisma.emailSignalRule.create({ data: { userId, connectionId, adapterId: "custom_email_review", name: "Newsletter watcher", status: "active", createdBy: "user" } });
    await seedReview(userId, connectionId, rule.id, { providerMessageId: "m1", subject: "50% off everything this weekend only!" });

    mockUnderstanding({
      emailKind: "marketing",
      relevance: "noise",
      goalRelevance: "unclear",
      summary: "A promotional sale email.",
      why: ["50% off everything"],
      suggestedUserAction: "ignore",
      confidence: 0.9,
      keyDetails: null,
      keyFacts: [],
      realWorldEvent: "Weekend sale promotion",
      signalBucket: "noise",
      ambiguity: null
    });
    mockRelevance({ bestGoalId: null, verdict: "unrelated", reason: "A promotional sale has nothing to do with any active goal.", requiresConfirmation: true });

    await sendAgentMessage(server, userId, "show email reviews");
    const detail = await sendAgentMessage(server, userId, "details for 1");

    assert.doesNotMatch(detail.reply, /Linked goal:/i);
    assert.doesNotMatch(detail.reply, /Needs decision — which goal/i);
  } finally {
    clearMocks();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("E. an invalid/invented LLM goalId is rejected, never linked", async () => {
  const server = buildServer();
  const userId = `goal-relevance-e-${randomUUID()}`;

  try {
    await seedUser(userId);
    await createGoal(userId, { title: "Find a remote developer job", category: "career" });
    const connectionId = await seedGmailUser(userId);
    const rule = await prisma.emailSignalRule.create({ data: { userId, connectionId, adapterId: "custom_email_review", name: "Cohere watcher", status: "active", createdBy: "user" } });
    await seedReview(userId, connectionId, rule.id, { providerMessageId: "m1", subject: "Thanks for applying to Cohere" });

    mockUnderstanding(applicationConfirmationUnderstanding);
    mockRelevance({ bestGoalId: "not-a-real-goal-id-the-model-invented", verdict: "direct", reason: "This matches the job search.", requiresConfirmation: false });

    await sendAgentMessage(server, userId, "show email reviews");
    const detail = await sendAgentMessage(server, userId, "details for 1");

    assert.doesNotMatch(detail.reply, /Linked goal:/i, "an invented goal id must never be trusted, even at a confident 'direct' verdict");
  } finally {
    clearMocks();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("F. low-confidence/unclear relevance becomes a specific needs-decision line, never a wrong link", async () => {
  const server = buildServer();
  const userId = `goal-relevance-f-${randomUUID()}`;

  try {
    await seedUser(userId);
    const jobGoal = await createGoal(userId, { title: "Find a remote developer job", category: "career" }).then((r) => r.goal);
    const fitnessGoal = await createGoal(userId, { title: "Run a marathon", category: "fitness" }).then((r) => r.goal);
    const connectionId = await seedGmailUser(userId);
    const rule = await prisma.emailSignalRule.create({ data: { userId, connectionId, adapterId: "custom_email_review", name: "Generic watcher", status: "active", createdBy: "user" } });
    await seedReview(userId, connectionId, rule.id, { providerMessageId: "m1", subject: "Opportunity at Example Corp" });

    mockUnderstanding({
      emailKind: "job_alert",
      relevance: "low",
      goalRelevance: "unclear",
      summary: "Could be a job alert or a recruiter opportunity.",
      why: ["Opportunity at Example Corp"],
      suggestedUserAction: "ask_clarification",
      confidence: 0.3,
      keyDetails: null,
      keyFacts: [],
      realWorldEvent: "Possible job opportunity at Example Corp",
      signalBucket: "needs_decision",
      ambiguity: "This looks like either a job alert or a recruiter opportunity, but there is no personal reply in the body."
    });
    mockRelevance({ bestGoalId: jobGoal.id, verdict: "unclear", reason: "Could relate to the job search, but the email itself is too ambiguous to confirm.", requiresConfirmation: true });

    await sendAgentMessage(server, userId, "show email reviews");
    const detail = await sendAgentMessage(server, userId, "details for 1");

    assert.doesNotMatch(detail.reply, /Linked goal:/i, "a requiresConfirmation verdict must never auto-link");
    assert.match(detail.reply, /Needs decision — which goal: Could relate to the job search/i);
    void fitnessGoal;
  } finally {
    clearMocks();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("G. no DB write happens from relevance alone — a details view is purely read-only", async () => {
  const server = buildServer();
  const userId = `goal-relevance-g-${randomUUID()}`;

  try {
    await seedUser(userId);
    const goal = await createGoal(userId, { title: "Find a remote developer job", category: "career" }).then((r) => r.goal);
    const connectionId = await seedGmailUser(userId);
    const rule = await prisma.emailSignalRule.create({ data: { userId, connectionId, adapterId: "custom_email_review", name: "Cohere watcher", status: "active", createdBy: "user" } });
    const review = await seedReview(userId, connectionId, rule.id, { providerMessageId: "m1", subject: "Thanks for applying to Cohere" });

    mockUnderstanding(applicationConfirmationUnderstanding);
    mockRelevance({ bestGoalId: goal.id, verdict: "direct", reason: "Matches the job search.", requiresConfirmation: false });

    const eventsBefore = await prisma.event.count({ where: { userId } });
    await sendAgentMessage(server, userId, "show email reviews");
    const detail = await sendAgentMessage(server, userId, "details for 1");
    const eventsAfter = await prisma.event.count({ where: { userId } });

    assert.equal(eventsBefore, 0);
    assert.equal(eventsAfter, 0, "relevance assessment alone must never write a progress event");
    const stillPending = await prisma.emailReviewItem.findUnique({ where: { id: review.id } });
    assert.equal(stillPending?.status, "pending", "relevance assessment alone must never approve/resolve the review");
    assert.match(detail.reply, /Linked goal: Find a remote developer job/i);
  } finally {
    clearMocks();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
