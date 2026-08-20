import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createGoal } from "../packages/db/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, mockPlan, op, prisma, sendAgentMessage, seedUser } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * Generic Goal Evidence Loop MVP (docs/10-v3-readiness-audit.md §20) — Goal + Evidence + Source +
 * Confidence + Suggested Mutation, built entirely from EXISTING generic primitives: the
 * event-registry (already domain-agnostic: career/health/work/finance/... event types), a Goal's
 * own declared `targetMetrics[].eventType` (already the goal↔evidence link, just not previously
 * exposed to chat), ActionItem.goalId (already a real FK), and goal-linking.ts's
 * inferGoalLinkForAction (already used by email-review-to-action, now also wired into manual
 * action.create). Nothing in the code under test branches on "is this about a job" — job search
 * is exercised here only because it's the first goal category with a pre-built template
 * (career.job_search) and full event-registry coverage; test 9 below deliberately uses a
 * completely different goal (paying an admin bill) through the exact same tools to prove that.
 */

async function seedJobSearchGoal(userId: string) {
  const result = await createGoal(userId, { title: "Find a new developer job", category: "career", templateId: "career.job_search" });
  if (result.duplicate) throw new Error("unexpected duplicate goal in test setup");
  return result.goal;
}

function evidencePlan(operations: ReturnType<typeof op>[]) {
  return { topic: "goal_evidence", intent: "log_evidence", operations, needsClarification: false, clarificationQuestion: null, replyDraft: "" };
}

test("1. 'sent 5 CVs today' logs applications_sent and names the linked job-search goal", async () => {
  const server = buildServer();
  const userId = `evidence-cvs-${randomUUID()}`;

  try {
    await seedUser(userId);
    const goal = await seedJobSearchGoal(userId);

    mockPlan(evidencePlan([op("event.log_job_applications", { count: 5 })]));
    const reply = await sendAgentMessage(server, userId, "sent 5 CVs today");

    assert.match(reply.reply, /logged 5 job applications sent/i);
    assert.match(reply.reply, new RegExp(`counts toward your "${goal.title}" goal`, "i"));

    const events = await prisma.event.count({ where: { userId, type: "career.application_sent" } });
    assert.equal(events, 5);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2. 'got 2 recruiter replies' logs recruiter_reply_received via goal.log_evidence, linked to the goal", async () => {
  const server = buildServer();
  const userId = `evidence-recruiter-replies-${randomUUID()}`;

  try {
    await seedUser(userId);
    const goal = await seedJobSearchGoal(userId);

    mockPlan(evidencePlan([op("goal.log_evidence", { eventType: "career.recruiter_reply_received", count: 2 })]));
    const reply = await sendAgentMessage(server, userId, "got 2 recruiter replies");

    assert.match(reply.reply, /logged 2 recruiter replies/i);
    assert.match(reply.reply, new RegExp(`counts toward your "${goal.title}" goal`, "i"));

    const events = await prisma.event.count({ where: { userId, type: "career.recruiter_reply_received" } });
    assert.equal(events, 2);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3. 'I have an interview tomorrow' logs interview_scheduled AND creates a linked follow-up action", async () => {
  const server = buildServer();
  const userId = `evidence-interview-${randomUUID()}`;

  try {
    await seedUser(userId);
    const goal = await seedJobSearchGoal(userId);

    mockPlan(
      evidencePlan([
        op("goal.log_evidence", { eventType: "career.interview_scheduled" }),
        op("action.create", { title: "Interview", dueText: "tomorrow" })
      ])
    );
    const reply = await sendAgentMessage(server, userId, "I have an interview tomorrow");

    assert.match(reply.reply, /logged 1 interview scheduled/i);
    assert.match(reply.reply, /created task "interview"/i);
    assert.match(reply.reply, new RegExp(`linked to your "${goal.title}" goal`, "i"));

    const events = await prisma.event.count({ where: { userId, type: "career.interview_scheduled" } });
    assert.equal(events, 1);
    const action = await prisma.actionItem.findFirst({ where: { userId, title: "Interview" } });
    assert.ok(action?.dueAt, "the interview action must have a real due date, not be left open-ended");
    assert.equal(action?.goalId, goal.id, "the interview action must be linked to the active job-search goal");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4. 'need to follow up with recruiter tomorrow' creates an action linked to the job-search goal, no fabricated event", async () => {
  const server = buildServer();
  const userId = `evidence-follow-up-${randomUUID()}`;

  try {
    await seedUser(userId);
    const goal = await seedJobSearchGoal(userId);

    mockPlan(evidencePlan([op("action.create", { title: "Follow up with recruiter", dueText: "tomorrow" })]));
    const reply = await sendAgentMessage(server, userId, "need to follow up with recruiter tomorrow");

    assert.match(reply.reply, /created task "follow up with recruiter"/i);
    assert.match(reply.reply, new RegExp(`linked to your "${goal.title}" goal`, "i"));

    const action = await prisma.actionItem.findFirst({ where: { userId, title: "Follow up with recruiter" } });
    assert.equal(action?.goalId, goal.id);
    // Nothing "happened" yet — a future intention must never be logged as if it were a real event.
    const events = await prisma.event.count({ where: { userId } });
    assert.equal(events, 0);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("5. job-search status returns real logged counts, not invented progress", async () => {
  const server = buildServer();
  const userId = `evidence-status-${randomUUID()}`;

  try {
    await seedUser(userId);
    const goal = await seedJobSearchGoal(userId);

    mockPlan(evidencePlan([op("event.log_job_applications", { count: 3 })]));
    await sendAgentMessage(server, userId, "sent 3 CVs today");
    clearAgentRuntimeMocks();

    mockPlan({ topic: "goal_evidence", intent: "goal_status", operations: [op("goal.status", { goalRef: "job search" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "how is my job search going?");

    assert.match(reply.reply, new RegExp(goal.title, "i"));
    assert.match(reply.reply, /3 applications sent/i);
    assert.doesNotMatch(reply.reply, /interview|recruiter reply|rejection/i, "must not mention signals that were never logged");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("6. a pending recruiter Gmail review, classified as a recruiter reply, becomes a real logged event via gmail.review.approve", async () => {
  const server = buildServer();
  const userId = `evidence-gmail-recruiter-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedJobSearchGoal(userId);
    const connection = await prisma.integrationConnection.create({ data: { userId, integrationId: "gmail", status: "active", config: {} } });
    const rule = await prisma.emailSignalRule.create({
      data: { userId, connectionId: connection.id, adapterId: "job_search_email", name: "Job search emails", status: "active", createdBy: "user" }
    });
    await prisma.emailReviewItem.create({
      data: {
        userId,
        connectionId: connection.id,
        ruleId: rule.id,
        adapterId: "job_search_email",
        provider: "gmail",
        providerMessageId: "recruiter-1",
        externalId: `gmail-review:${rule.id}:recruiter-1`,
        subject: "Re: your application",
        from: "Recruiter <recruiter@example.com>",
        snippet: "Thanks for applying, let's talk this week.",
        confidence: 0.85,
        reason: "rule_classification",
        extracted: {},
        proposedEventType: "career.recruiter_reply_received",
        status: "pending"
      }
    });

    mockPlan({ topic: "gmail_reviews", intent: "list_pending_reviews", operations: [op("gmail.review.list", { status: "pending" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "what emails need my attention?");

    mockPlan({ topic: "gmail_reviews", intent: "approve_review", operations: [op("gmail.review.approve", { ref: "your application" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "approve that one");

    assert.match(reply.reply, /event created|approved/i);
    const events = await prisma.event.count({ where: { userId, type: "career.recruiter_reply_received" } });
    assert.equal(events, 1, "approving a review already classified as a recruiter reply must log the real event, not just mark it reviewed");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("7. morning brief with an active job-search goal surfaces a goal-linked pending Gmail review", async () => {
  const server = buildServer();
  const userId = `evidence-morning-brief-${randomUUID()}`;

  try {
    await seedUser(userId);
    const goal = await seedJobSearchGoal(userId);
    await prisma.notificationSettings.create({
      data: { userId, dailyLoopEnabled: true, morningTimeMinutes: 540, eveningTimeMinutes: 1140, timezone: "Europe/Madrid" }
    });
    await prisma.actionItem.create({ data: { userId, source: "manual", title: "Apply to 3 developer jobs", priority: "high", status: "open" } });
    const connection = await prisma.integrationConnection.create({ data: { userId, integrationId: "gmail", status: "active", config: {} } });
    const rule = await prisma.emailSignalRule.create({
      data: { userId, connectionId: connection.id, adapterId: "job_search_email", name: "Job search emails", status: "active", createdBy: "user", goalId: goal.id }
    });
    await prisma.emailReviewItem.create({
      data: {
        userId,
        connectionId: connection.id,
        ruleId: rule.id,
        adapterId: "job_search_email",
        provider: "gmail",
        providerMessageId: "recruiter-2",
        externalId: `gmail-review:${rule.id}:recruiter-2`,
        subject: "Interview availability?",
        from: "Recruiter <recruiter@example.com>",
        confidence: 0.85,
        reason: "rule_classification",
        extracted: {},
        status: "pending"
      }
    });

    const response = await server.inject({ method: "GET", url: `/users/${userId}/operator/proactive/preview?now=${encodeURIComponent("2026-08-20T07:00:00.000Z")}` });
    assert.equal(response.statusCode, 200);
    const body = response.json() as { decision: { decision: string; message?: string } };
    assert.equal(body.decision.decision, "proposed_message");
    assert.match(body.decision.message ?? "", /apply to 3 developer jobs/i);
    assert.match(body.decision.message ?? "", /email review.*waiting.*goal you're tracking/i);
    assert.match(body.decision.message ?? "", /interview availability/i);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("8. no active job-search (or any) goal: status is honest, never fabricated job-search coaching", async () => {
  const server = buildServer();
  const userId = `evidence-no-goal-${randomUUID()}`;

  try {
    await seedUser(userId);

    mockPlan({ topic: "goal_evidence", intent: "goal_status", operations: [op("goal.status", { goalRef: "job search" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "how is my job search going?");

    assert.match(reply.reply, /don't have any active goals/i);
    assert.doesNotMatch(reply.reply, /application|recruiter|interview/i, "must not invent job-search content when no goal exists");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("9. non-job example: an Endesa-bills goal links a matching Gmail review to itself, with zero job-search assumptions", async () => {
  const server = buildServer();
  const userId = `evidence-endesa-${randomUUID()}`;

  try {
    await seedUser(userId);
    const goalResult = await createGoal(userId, { title: "Handle Endesa bills", category: "admin" });
    if (goalResult.duplicate) throw new Error("unexpected duplicate");
    const goal = goalResult.goal;

    const connection = await prisma.integrationConnection.create({ data: { userId, integrationId: "gmail", status: "active", config: {} } });
    const rule = await prisma.emailSignalRule.create({
      data: { userId, connectionId: connection.id, adapterId: "custom_email_review", name: "Endesa bills", status: "active", createdBy: "user" }
    });
    await prisma.emailReviewItem.create({
      data: {
        userId,
        connectionId: connection.id,
        ruleId: rule.id,
        adapterId: "custom_email_review",
        provider: "gmail",
        providerMessageId: "endesa-1",
        externalId: `gmail-review:${rule.id}:endesa-1`,
        subject: "Endesa factura disponible",
        from: "Endesa <noreply@endesa.com>",
        snippet: "Your electricity bill is ready to view.",
        confidence: 0.7,
        reason: "custom_rule_match",
        extracted: {},
        status: "pending"
      }
    });

    mockPlan({ topic: "gmail_reviews", intent: "list_pending_reviews", operations: [op("gmail.review.list", { status: "pending" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "what emails need my attention?");

    mockPlan({ topic: "gmail_reviews", intent: "convert_review_to_action", operations: [op("gmail.review.to_action", { ref: "Endesa" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "turn the Endesa one into a task");

    assert.match(reply.reply, /created task/i);
    const action = await prisma.actionItem.findFirst({ where: { userId, sourceProvider: "gmail" } });
    assert.ok(action, "an action must have been created from the Endesa review");
    assert.equal(action?.goalId, goal.id, "the action must be linked to the Endesa-bills goal via the same generic matcher used for job-search actions — no job-search-specific code path involved");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
