import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createGoal, prisma } from "../packages/db/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, mockPlan, op, sendAgentMessage, seedUser } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * refactor/private-alpha-goal-driven-gmail-operator: Gmail shifts from user-managed "rules" to
 * goal-driven operator behavior — the user states a goal, Alecto infers whether Gmail can help,
 * asks permission, and (once confirmed) creates/updates an internal watcher — without the user
 * ever needing to understand rule config, classifier modes, or notifyPolicy. Internal rules still
 * exist (see tests/agent-runtime-gmail-generic-signal-engine.test.ts for that layer, unchanged by
 * this branch) — this file covers the NEW goal-first surface on top of them.
 */

async function seedGmailConnection(userId: string) {
  return prisma.integrationConnection.create({ data: { userId, integrationId: "gmail", status: "active", config: { email: "letis@example.com" } } });
}

function jobSearchGoalInput() {
  return {
    title: "Find a fully remote developer job",
    category: "career",
    targetMetrics: [
      { key: "applications_sent_weekly", label: "Applications sent", labelSingular: "Application sent", eventType: "career.application_sent", aggregation: "count" as const, window: "weekly" as const },
      { key: "recruiter_replies_weekly", label: "Recruiter replies", labelSingular: "Recruiter reply", eventType: "career.recruiter_reply_received", aggregation: "count" as const, window: "weekly" as const }
    ]
  };
}

test("Task 2A: creating a job-search goal (Gmail connected) chains a real, confirmable Gmail-support offer", async () => {
  const server = buildServer();
  const userId = `goal-gmail-jobsearch-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedGmailConnection(userId);

    mockPlan({
      topic: "goals",
      intent: "create_goal",
      operations: [
        op("goal.create_propose", {
          title: "Find a fully remote developer job",
          category: "career",
          signals: [{ key: "applications_sent_weekly", label: "applications sent", labelSingular: "application sent", cadence: "weekly" }]
        })
      ],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    await sendAgentMessage(server, userId, "I want to find a fully remote developer job");
    const confirm = await sendAgentMessage(server, userId, "yes");

    assert.equal(confirm.debug.mutationExecuted, true);
    assert.match(confirm.reply, /I can use Gmail readonly for "Find a fully remote developer job"/);
    assert.match(confirm.reply, /recruiter replies/i);
    assert.match(confirm.reply, /I won't send emails or change labels/);
    assert.equal(confirm.debug.pendingOperation, true);

    // Nothing was created yet — only offered.
    assert.equal(await prisma.emailSignalRule.count({ where: { userId } }), 0);

    const enableConfirm = await sendAgentMessage(server, userId, "yes");
    assert.equal(enableConfirm.debug.mutationExecuted, true);
    const rule = await prisma.emailSignalRule.findFirst({ where: { userId, status: "active" } });
    assert.ok(rule, "confirming the offer must create a real Gmail rule");
    assert.equal(rule?.adapterId, "job_search_email");
    const goal = await prisma.goal.findFirst({ where: { userId, status: "active" } });
    assert.equal(rule?.goalId, goal?.id, "the new rule must be linked to the goal that triggered the offer");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("Task 2B/3B: creating a travel goal chains a Gmail offer that becomes a real custom watcher with a travel domain", async () => {
  const server = buildServer();
  const userId = `goal-gmail-travel-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedGmailConnection(userId);

    mockPlan({
      topic: "goals",
      intent: "create_goal",
      operations: [
        op("goal.create_propose", {
          title: "Prepare for my trip to Japan",
          category: "travel",
          signals: [{ key: "trip_tasks_done", label: "trip tasks done", labelSingular: "trip task done", cadence: "weekly" }]
        })
      ],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    await sendAgentMessage(server, userId, "I want to prepare for my trip to Japan");
    const confirm = await sendAgentMessage(server, userId, "yes");

    assert.match(confirm.reply, /I can use Gmail readonly for "Prepare for my trip to Japan"/);
    assert.match(confirm.reply, /flight/i);

    const enableConfirm = await sendAgentMessage(server, userId, "yes");
    assert.equal(enableConfirm.debug.mutationExecuted, true);
    const rule = await prisma.emailSignalRule.findFirst({ where: { userId, status: "active" } });
    assert.ok(rule);
    assert.equal(rule?.adapterId, "custom_email_review", "travel has no built-in adapter - it becomes a real custom watcher");
    assert.equal(rule?.domain, "travel");
    assert.ok(rule?.description && /flight/i.test(rule.description));
    assert.equal(rule?.notifyPolicy, "review_only");
    const goal = await prisma.goal.findFirst({ where: { userId, status: "active" } });
    assert.equal(rule?.goalId, goal?.id);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("Task 2E: an unrelated (fitness) goal never gets a Gmail offer, even with Gmail connected", async () => {
  const server = buildServer();
  const userId = `goal-gmail-unrelated-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedGmailConnection(userId);

    mockPlan({
      topic: "goals",
      intent: "create_goal",
      operations: [
        op("goal.create_propose", {
          title: "Train 3 times per week",
          category: "health",
          signals: [{ key: "workouts_done", label: "workouts", labelSingular: "workout", cadence: "weekly" }]
        })
      ],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    await sendAgentMessage(server, userId, "I want to train 3 times per week");
    const confirm = await sendAgentMessage(server, userId, "yes");

    assert.equal(confirm.debug.mutationExecuted, true);
    assert.doesNotMatch(confirm.reply, /Gmail/i, "a fitness goal must never mention Gmail unprompted");
    assert.equal(confirm.debug.pendingOperation, false);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("Task 2F: Gmail not connected - the offer gives a connect link instead of a confirmable proposal", async () => {
  const server = buildServer();
  const userId = `goal-gmail-notconnected-${randomUUID()}`;

  try {
    await seedUser(userId);
    // No Gmail connection at all.

    mockPlan({
      topic: "goals",
      intent: "create_goal",
      operations: [
        op("goal.create_propose", {
          title: "Find a fully remote developer job",
          category: "career",
          signals: [{ key: "applications_sent_weekly", label: "applications sent", labelSingular: "application sent", cadence: "weekly" }]
        })
      ],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    await sendAgentMessage(server, userId, "I want to find a fully remote developer job");
    const confirm = await sendAgentMessage(server, userId, "yes");

    assert.equal(confirm.debug.mutationExecuted, true);
    assert.match(confirm.reply, /Gmail isn't connected yet|connect Gmail/i);
    assert.equal(confirm.debug.pendingOperation, false, "no confirmable proposal should open when Gmail isn't connected yet");
    assert.equal(await prisma.emailSignalRule.count({ where: { userId } }), 0);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("Task 2G/2H: a standalone 'use Gmail for my job search' proposes and enables on confirm; cancel changes nothing", async () => {
  const server = buildServer();
  const userId = `goal-gmail-standalone-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedGmailConnection(userId);
    const goalResult = await createGoal(userId, jobSearchGoalInput());
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");

    mockPlan({
      topic: "gmail_goal_watcher",
      intent: "enable_for_goal",
      operations: [op("gmail.goal_watcher.propose_enable", { goalRef: "remote developer job" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const propose = await sendAgentMessage(server, userId, "use Gmail for my job search");
    assert.match(propose.reply, /I can use Gmail readonly for "Find a fully remote developer job"/);
    assert.equal(await prisma.emailSignalRule.count({ where: { userId } }), 0);

    const cancel = await sendAgentMessage(server, userId, "cancel");
    assert.equal(cancel.debug.mutationExecuted, false);
    assert.equal(await prisma.emailSignalRule.count({ where: { userId } }), 0, "cancel must change nothing");

    mockPlan({
      topic: "gmail_goal_watcher",
      intent: "enable_for_goal",
      operations: [op("gmail.goal_watcher.propose_enable", { goalRef: "remote developer job" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    await sendAgentMessage(server, userId, "use Gmail for my job search");
    const confirm = await sendAgentMessage(server, userId, "yes");
    assert.equal(confirm.debug.mutationExecuted, true);
    const rule = await prisma.emailSignalRule.findFirst({ where: { userId, status: "active" } });
    assert.ok(rule);
    assert.equal(rule?.goalId, goalResult.goal.id);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("Task 9: a goal already covered by an active watcher is reported as already-on, never duplicated", async () => {
  const server = buildServer();
  const userId = `goal-gmail-already-covered-${randomUUID()}`;

  try {
    await seedUser(userId);
    const connection = await seedGmailConnection(userId);
    const goalResult = await createGoal(userId, jobSearchGoalInput());
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
    await prisma.emailSignalRule.create({
      data: {
        userId,
        connectionId: connection.id,
        adapterId: "job_search_email",
        name: "Job search emails",
        goalId: goalResult.goal.id,
        status: "active",
        createdBy: "user"
      }
    });

    mockPlan({
      topic: "gmail_goal_watcher",
      intent: "enable_for_goal",
      operations: [op("gmail.goal_watcher.propose_enable", { goalRef: "remote developer job" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const propose = await sendAgentMessage(server, userId, "use Gmail for my job search");
    assert.match(propose.reply, /already using Gmail for "Find a fully remote developer job"/i);
    assert.equal(await prisma.emailSignalRule.count({ where: { userId } }), 1, "must never create a duplicate watcher");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("Task 4A/4B: approving a Gmail review with a signal the linked goal doesn't track yet proposes adding it; confirming updates the goal", async () => {
  const server = buildServer();
  const userId = `goal-gmail-evolution-${randomUUID()}`;

  try {
    await seedUser(userId);
    const connection = await seedGmailConnection(userId);
    const goalResult = await createGoal(userId, jobSearchGoalInput());
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
    // This goal tracks applications/recruiter replies only - NOT interviews.
    assert.ok(!goalResult.goal.targetMetrics?.some((metric) => metric.eventType === "career.interview_scheduled"));

    const rule = await prisma.emailSignalRule.create({
      data: {
        userId,
        connectionId: connection.id,
        adapterId: "job_search_email",
        name: "Job search emails",
        goalId: goalResult.goal.id,
        status: "active",
        createdBy: "user"
      }
    });
    const review = await prisma.emailReviewItem.create({
      data: {
        userId,
        connectionId: connection.id,
        ruleId: rule.id,
        adapterId: "job_search_email",
        provider: "gmail",
        providerMessageId: "m1",
        externalId: `gmail-review:${rule.id}:m1`,
        subject: "Let's schedule your interview",
        snippet: "Great news - interview next week.",
        confidence: 0.9,
        reason: "interview_scheduled",
        proposedEventType: "career.interview_scheduled",
        extracted: {},
        priority: "high",
        status: "pending"
      }
    });

    mockPlan({ topic: "gmail_reviews", intent: "list", operations: [op("gmail.review.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "what emails need my attention?");

    mockPlan({ topic: "gmail_reviews", intent: "approve", operations: [op("gmail.review.approve", { reviewId: review.id })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const approve = await sendAgentMessage(server, userId, "approve it");

    assert.equal(approve.debug.mutationExecuted, true);
    assert.match(approve.reply, /interview event/i);
    assert.match(approve.reply, /doesn't currently track this/i);
    assert.match(approve.reply, /Want me to add it as a tracked signal\?/i);

    const goalBeforeConfirm = await prisma.goal.findUniqueOrThrow({ where: { id: goalResult.goal.id } });
    assert.ok(!(goalBeforeConfirm.targetMetrics as unknown[])?.some((metric: any) => metric.eventType === "career.interview_scheduled"), "must not change the goal before confirmation");

    const confirm = await sendAgentMessage(server, userId, "yes");
    assert.equal(confirm.debug.mutationExecuted, true);
    const goalAfterConfirm = await prisma.goal.findUniqueOrThrow({ where: { id: goalResult.goal.id } });
    const metrics = goalAfterConfirm.targetMetrics as Array<{ eventType?: string }>;
    assert.ok(metrics.some((metric) => metric.eventType === "career.interview_scheduled"), "confirming must add the new tracked signal");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("Task 4C: cancelling the tracked-signal offer leaves the goal's metrics unchanged", async () => {
  const server = buildServer();
  const userId = `goal-gmail-evolution-cancel-${randomUUID()}`;

  try {
    await seedUser(userId);
    const connection = await seedGmailConnection(userId);
    const goalResult = await createGoal(userId, jobSearchGoalInput());
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
    const rule = await prisma.emailSignalRule.create({
      data: { userId, connectionId: connection.id, adapterId: "job_search_email", name: "Job search emails", goalId: goalResult.goal.id, status: "active", createdBy: "user" }
    });
    const review = await prisma.emailReviewItem.create({
      data: {
        userId,
        connectionId: connection.id,
        ruleId: rule.id,
        adapterId: "job_search_email",
        provider: "gmail",
        providerMessageId: "m1",
        externalId: `gmail-review:${rule.id}:m1`,
        subject: "Let's schedule your interview",
        snippet: "Great news - interview next week.",
        confidence: 0.9,
        reason: "interview_scheduled",
        proposedEventType: "career.interview_scheduled",
        extracted: {},
        priority: "high",
        status: "pending"
      }
    });

    mockPlan({ topic: "gmail_reviews", intent: "list", operations: [op("gmail.review.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "what emails need my attention?");
    mockPlan({ topic: "gmail_reviews", intent: "approve", operations: [op("gmail.review.approve", { reviewId: review.id })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "approve it");

    const cancel = await sendAgentMessage(server, userId, "cancel");
    assert.equal(cancel.debug.mutationExecuted, false);
    const goalAfter = await prisma.goal.findUniqueOrThrow({ where: { id: goalResult.goal.id } });
    const metrics = goalAfter.targetMetrics as Array<{ eventType?: string }>;
    assert.ok(!metrics.some((metric) => metric.eventType === "career.interview_scheduled"), "cancel must never change the goal's tracked signals");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("Task 8A: 'stop using Gmail for my job search goal' pauses the linked rule by resolving the GOAL, not a rule name", async () => {
  const server = buildServer();
  const userId = `goal-gmail-stop-${randomUUID()}`;

  try {
    await seedUser(userId);
    const connection = await seedGmailConnection(userId);
    const goalResult = await createGoal(userId, jobSearchGoalInput());
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
    const rule = await prisma.emailSignalRule.create({
      data: { userId, connectionId: connection.id, adapterId: "job_search_email", name: "Job search emails", goalId: goalResult.goal.id, status: "active", createdBy: "user" }
    });

    mockPlan({
      topic: "gmail_rule_management",
      intent: "pause",
      operations: [op("gmail.rule.propose_update", { ref: "my job search goal", operation: "pause" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const propose = await sendAgentMessage(server, userId, "stop using Gmail for my job search goal");
    assert.match(propose.reply, /pause/i);

    const confirm = await sendAgentMessage(server, userId, "yes");
    assert.equal(confirm.debug.mutationExecuted, true);
    const updated = await prisma.emailSignalRule.findUniqueOrThrow({ where: { id: rule.id } });
    assert.equal(updated.status, "paused");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("Task 8D/8E: 'stop notifying me about flight emails' mutes the rule (notifications only) - matches still go to review", async () => {
  const server = buildServer();
  const userId = `goal-gmail-mute-${randomUUID()}`;

  try {
    await seedUser(userId);
    const connection = await seedGmailConnection(userId);
    const rule = await prisma.emailSignalRule.create({
      data: { userId, connectionId: connection.id, adapterId: "custom_email_review", name: "Flight changes", domain: "travel", notifyPolicy: "notify", status: "active", createdBy: "user" }
    });

    mockPlan({
      topic: "gmail_rule_management",
      intent: "mute",
      operations: [op("gmail.rule.propose_update", { ref: "flight", operation: "mute" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const propose = await sendAgentMessage(server, userId, "stop notifying me about flight emails");
    assert.match(propose.reply, /mute/i);

    const confirm = await sendAgentMessage(server, userId, "yes");
    assert.equal(confirm.debug.mutationExecuted, true);
    const updated = await prisma.emailSignalRule.findUniqueOrThrow({ where: { id: rule.id } });
    assert.equal(updated.status, "active", "muting must never pause/disable matching, only notifications");
    assert.equal(updated.notifyPolicy, "review_only");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("Task 7B: 'show Gmail rules' still exposes the advanced, raw rule-level view", async () => {
  const server = buildServer();
  const userId = `goal-gmail-advanced-view-${randomUUID()}`;

  try {
    await seedUser(userId);
    const connection = await seedGmailConnection(userId);
    await prisma.emailSignalRule.create({
      data: { userId, connectionId: connection.id, adapterId: "custom_email_review", name: "Flight changes", domain: "travel", reviewBeforeLogging: true, status: "active", createdBy: "user" }
    });

    mockPlan({ topic: "gmail_rules", intent: "show_rules", operations: [op("gmail.rule.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "show Gmail rules");
    assert.match(reply.reply, /Flight changes \(travel\)/);
    assert.match(reply.reply, /review-first tracking/);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
