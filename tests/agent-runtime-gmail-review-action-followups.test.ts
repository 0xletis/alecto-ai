import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { formatLocalDateTime } from "../apps/api/src/utils/datetime.ts";
import { buildServer, clearAgentRuntimeMocks, prisma, sendAgentMessage } from "./helpers/agent-runtime-test-helpers.ts";
import { createActionItemReminderLog, getActionItemsEligibleForReminder } from "../packages/db/src/index.ts";

/**
 * Regression suite for a real Telegram smoke test that failed in four distinct ways even after
 * the deterministic Gmail review triage/reconciliation work in agent-runtime-gmail-review-triage
 * .test.ts: (1) "u can delete 3 its nothing important" was silently dropped from the explicit
 * intent map entirely — "delete" wasn't recognized as an ignore-shaped verb at all; (2) "remind
 * me of it at that time" created a SEPARATE companion reminder ActionItem due at the exact same
 * instant as the task itself, so the worker would send two due notifications for one moment; (3)
 * after that due notification fired, a bare "complete it" resolved to an already-REJECTED Gmail
 * review instead of the just-reminded task, because the chat session's own visibleEntities were
 * still pinned to that decided review (rejecting it with nothing left pending never clears it);
 * (4) the generated task title for a Google-style "security alert" email glued a raw classifier
 * description into the title instead of naming the account.
 *
 * Fixed clock matches the exact reported transcript: 2026-08-20T23:32:00+02:00 (Europe/Madrid,
 * CEST) = 2026-08-20T21:32:00.000Z.
 */

const NOW_UTC = "2026-08-20T21:32:00.000Z";
const TIMEZONE = "Europe/Madrid";

async function seedGmailUser(userId: string): Promise<string> {
  await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
  const connection = await prisma.integrationConnection.create({ data: { userId, integrationId: "gmail", status: "active", config: {} } });
  return connection.id;
}

async function seedReview(
  userId: string,
  connectionId: string,
  ruleId: string,
  overrides: { subject?: string; from?: string; snippet?: string; providerMessageId: string; updatedAt: Date }
) {
  return prisma.emailReviewItem.create({
    data: {
      userId,
      connectionId,
      ruleId,
      adapterId: "custom_email_review",
      provider: "gmail",
      providerMessageId: overrides.providerMessageId,
      externalId: `gmail-review:${ruleId}:${overrides.providerMessageId}`,
      subject: overrides.subject,
      from: overrides.from,
      snippet: overrides.snippet,
      evidence: overrides.snippet,
      confidence: 0.8,
      reason: "custom_rule_match",
      extracted: {},
      status: "pending",
      updatedAt: overrides.updatedAt
    }
  });
}

/** Sets up the exact 3-review transcript precondition, seeded so "show me the reviews" lists
 * them in the exact numbered order the reported transcript used. */
async function seedTranscriptReviews(userId: string, connectionId: string, ruleId: string) {
  const base = new Date(NOW_UTC).getTime();
  await seedReview(userId, connectionId, ruleId, {
    subject: "RE: duda",
    from: "Friend <friend@example.com>",
    snippet: "Te respondo sobre la duda de antes.",
    providerMessageId: "duda-followups",
    updatedAt: new Date(base - 1_000)
  });
  await seedReview(userId, connectionId, ruleId, {
    subject: "Alerta de seguridad para letisyt@gmail.com",
    from: "Google <no-reply@accounts.google.com>",
    snippet: "Nuevo inicio de sesion detectado.",
    providerMessageId: "gmail-security-alert-followups",
    updatedAt: new Date(base - 2_000)
  });
  await seedReview(userId, connectionId, ruleId, {
    subject: "Jobs Newsletter #461",
    from: "Jobs <jobs@example.com>",
    snippet: "Top jobs this week include Frontend Developer at Example Labs.",
    providerMessageId: "jobs-newsletter-followups",
    updatedAt: new Date(base - 3_000)
  });
}

test("exact reported transcript: delete-3 is honored, no duplicate same-time reminder, and 'complete it' completes the reminded task, never a rejected review", async () => {
  mock.timers.enable({ apis: ["Date"], now: new Date(NOW_UTC) });
  const server = buildServer();
  const userId = `gmail-followups-transcript-${randomUUID()}`;

  try {
    const connectionId = await seedGmailUser(userId);
    await prisma.notificationSettings.create({ data: { userId, timezone: TIMEZONE, morningTimeMinutes: 540 } });
    const rule = await prisma.emailSignalRule.create({
      data: { userId, connectionId, adapterId: "custom_email_review", name: "Gmail reviews", status: "active", reviewBeforeLogging: true, createdBy: "user" }
    });
    await seedTranscriptReviews(userId, connectionId, rule.id);

    // Turn 1: "show me the reviews"
    const list = await sendAgentMessage(server, userId, "show me the reviews");
    assert.match(list.reply, /^1\. RE: duda/im);
    assert.match(list.reply, /^2\. Alerta de seguridad/im);
    assert.match(list.reply, /^3\. Jobs Newsletter #461/im);

    // Turn 2: the compound triage message — ignore 1, task 2, and (via "delete" + "nothing
    // important") ignore 3.
    const triage = await sendAgentMessage(
      server,
      userId,
      "ignore 1, turn 2 into tasks 5 minutes from now and remind me of it at that time, u can delete 3 its nothing important"
    );
    assert.equal(triage.debug.mutationExecuted, true);
    assert.deepEqual(
      triage.operationsPlanned.map((operation) => operation.tool),
      ["gmail.review.reject", "gmail.review.to_action", "gmail.review.reject"],
      "the explicit intent map must resolve delete-3 to ignore, alongside ignore-1 and task-2"
    );
    assert.deepEqual(
      triage.operationsPlanned.map((operation) => operation.args.index),
      [1, 2, 3]
    );

    const reviews = await prisma.emailReviewItem.findMany({ where: { userId } });
    const byProviderMessageId = new Map(reviews.map((review) => [review.providerMessageId, review]));
    assert.equal(byProviderMessageId.get("duda-followups")?.status, "rejected", "review 1 must be rejected");
    assert.equal(byProviderMessageId.get("gmail-security-alert-followups")?.status, "approved", "review 2 must become a task");
    assert.equal(byProviderMessageId.get("jobs-newsletter-followups")?.status, "rejected", "review 3 (deleted) must be rejected, not left pending");

    // Task title must be clean, never the raw classifier text glued together.
    const task = await prisma.actionItem.findFirst({ where: { userId, status: "open" } });
    assert.ok(task, "the security-alert review must have become a real open task");
    assert.match(task!.title, /security alert/i);
    assert.match(task!.title, /letisyt@gmail\.com/);
    assert.doesNotMatch(task!.title, /the email is a security alert related to/i, "must never glue a raw classifier description into the title");

    // Due time is exactly now + 5 minutes.
    assert.ok(task!.dueAt);
    assert.equal(formatLocalDateTime(task!.dueAt!, TIMEZONE), "20/08/2026, 23:37");

    // "remind me of it at that time" must NOT create a separate companion reminder due at the
    // exact same instant — that would be a duplicate notification for the same moment.
    const reminderActions = await prisma.actionItem.findMany({ where: { userId, actionType: "reminder" } });
    assert.equal(reminderActions.length, 0, "no separate same-time reminder ActionItem should exist");

    // Worker due-reminder simulation: at exactly the task's due time, exactly ONE ActionItem is
    // eligible for a due notification for this user — proving only one notification would ever
    // be sent, using the real, unmocked production query the worker itself calls.
    const eligibleAtDueTime = await getActionItemsEligibleForReminder({ userId, now: task!.dueAt! });
    assert.equal(eligibleAtDueTime.length, 1, "exactly one due notification should be eligible for this task/time, never two");
    assert.equal(eligibleAtDueTime[0]!.actionItem.id, task!.id);

    // Turn 3: "any emails left to review" — everything has been decided.
    const remaining = await sendAgentMessage(server, userId, "any emails left to review");
    assert.match(remaining.reply, /no email reviews are waiting|don't have any|no pending/i);

    // Simulate the worker actually sending the due notification at 23:38 (matches the task
    // transcript's own timing) — this is the real DB write sendDueActionReminders performs.
    await createActionItemReminderLog({ userId, actionItemId: task!.id, reminderType: "due", sentAt: new Date("2026-08-20T21:38:00.000Z") });

    // Turn 5: "complete it" — must resolve to the just-reminded task, never re-decide the
    // already-rejected Jobs Newsletter review still sitting in session.visibleEntities.
    const complete = await sendAgentMessage(server, userId, "complete it");
    assert.deepEqual(complete.operationsPlanned.map((operation) => operation.tool), ["action.complete"]);
    assert.doesNotMatch(complete.reply, /already rejected|email review/i);
    assert.match(complete.reply, /complet/i);

    const completedTask = await prisma.actionItem.findUnique({ where: { id: task!.id } });
    assert.equal(completedTask?.status, "completed");
  } finally {
    mock.timers.reset();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("delete/remove/discard wording all map to ignoring a visible Gmail review", async () => {
  for (const phrase of ["delete 2", "delete number 2", "remove 2", "discard 2", "2 is nothing important"]) {
    const server = buildServer();
    const userId = `gmail-followups-delete-${randomUUID()}`;

    try {
      const connectionId = await seedGmailUser(userId);
      await prisma.notificationSettings.create({ data: { userId, timezone: TIMEZONE } });
      const rule = await prisma.emailSignalRule.create({
        data: { userId, connectionId, adapterId: "custom_email_review", name: "Gmail reviews", status: "active", reviewBeforeLogging: true, createdBy: "user" }
      });
      await seedReview(userId, connectionId, rule.id, {
        subject: "RE: duda",
        from: "Friend <friend@example.com>",
        snippet: "Te respondo sobre la duda de antes.",
        providerMessageId: `duda-delete-${phrase}`,
        updatedAt: new Date()
      });
      await seedReview(userId, connectionId, rule.id, {
        subject: "we need to seriously talk about getcracked",
        from: "Someone <person@example.com>",
        snippet: "We need to seriously talk about getcracked later.",
        providerMessageId: `getcracked-delete-${phrase}`,
        updatedAt: new Date(Date.now() - 1_000)
      });

      await sendAgentMessage(server, userId, "show me the reviews");
      const reply = await sendAgentMessage(server, userId, phrase);

      assert.deepEqual(reply.operationsPlanned.map((operation) => operation.tool), ["gmail.review.reject"], `"${phrase}" must map to gmail.review.reject`);
      const review = await prisma.emailReviewItem.findFirst({ where: { userId, providerMessageId: `getcracked-delete-${phrase}` } });
      assert.equal(review?.status, "rejected", `"${phrase}" must reject review 2`);
    } finally {
      clearAgentRuntimeMocks();
      await server.close();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  }
});

test("'remind me 30 minutes before' still creates a real, distinct pre-due reminder (not affected by the same-time fix)", async () => {
  mock.timers.enable({ apis: ["Date"], now: new Date(NOW_UTC) });
  const server = buildServer();
  const userId = `gmail-followups-predue-${randomUUID()}`;

  try {
    const connectionId = await seedGmailUser(userId);
    await prisma.notificationSettings.create({ data: { userId, timezone: TIMEZONE } });
    const rule = await prisma.emailSignalRule.create({
      data: { userId, connectionId, adapterId: "custom_email_review", name: "Gmail reviews", status: "active", reviewBeforeLogging: true, createdBy: "user" }
    });
    await seedReview(userId, connectionId, rule.id, {
      subject: "Branding direction meeting",
      from: "Client <client@example.com>",
      snippet: "Meeting tomorrow at 9am.",
      providerMessageId: "predue-branding",
      updatedAt: new Date()
    });

    await sendAgentMessage(server, userId, "show me the reviews");
    const reply = await sendAgentMessage(server, userId, "turn 1 into a task 5 minutes from now and remind me 30 minutes before");

    assert.deepEqual(reply.operationsPlanned.map((operation) => operation.tool), ["gmail.review.to_action"]);
    assert.deepEqual(reply.operationsPlanned[0]!.args.reminderLeadMinutes, 30);

    const reminderActions = await prisma.actionItem.findMany({ where: { userId, actionType: "reminder" } });
    assert.equal(reminderActions.length, 1, "a genuine before-time request must still create a real, distinct reminder");
    assert.notEqual(reminderActions[0]!.dueAt?.getTime(), undefined);

    const task = await prisma.actionItem.findFirst({ where: { userId, actionType: { not: "reminder" } } });
    assert.ok(task?.dueAt);
    assert.notEqual(reminderActions[0]!.dueAt!.getTime(), task!.dueAt!.getTime(), "the pre-due reminder must fire at a genuinely different time than the task itself");
  } finally {
    mock.timers.reset();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("'complete it' prefers the most recently reminded task over a stale visible Gmail review, and never plans a Gmail review tool", async () => {
  const server = buildServer();
  const userId = `gmail-followups-complete-priority-${randomUUID()}`;

  try {
    const connectionId = await seedGmailUser(userId);
    await prisma.notificationSettings.create({ data: { userId, timezone: TIMEZONE } });
    const rule = await prisma.emailSignalRule.create({
      data: { userId, connectionId, adapterId: "custom_email_review", name: "Gmail reviews", status: "active", reviewBeforeLogging: true, createdBy: "user" }
    });
    const review = await seedReview(userId, connectionId, rule.id, {
      subject: "Jobs Newsletter #461",
      from: "Jobs <jobs@example.com>",
      snippet: "Top jobs this week.",
      providerMessageId: "complete-priority-jobs",
      updatedAt: new Date()
    });

    // Make the review both pending AND then reject it, leaving it as the last thing shown/decided
    // in session — the exact stale-visible-entity shape from the real bug.
    await sendAgentMessage(server, userId, "show me the reviews");
    await sendAgentMessage(server, userId, "ignore 1");
    const rejected = await prisma.emailReviewItem.findUnique({ where: { id: review.id } });
    assert.equal(rejected?.status, "rejected");

    // A real, unrelated task exists and the worker already notified about it.
    const created = await prisma.actionItem.create({
      data: { userId, source: "manual", title: "Buy milk", priority: "medium", status: "open", dueAt: new Date() }
    });
    await createActionItemReminderLog({ userId, actionItemId: created.id, reminderType: "due" });

    const reply = await sendAgentMessage(server, userId, "complete it");
    assert.deepEqual(reply.operationsPlanned.map((operation) => operation.tool), ["action.complete"]);
    assert.doesNotMatch(reply.reply, /already rejected|jobs newsletter/i);

    const completed = await prisma.actionItem.findUnique({ where: { id: created.id } });
    assert.equal(completed?.status, "completed");
    const stillRejected = await prisma.emailReviewItem.findUnique({ where: { id: review.id } });
    assert.equal(stillRejected?.status, "rejected", "the already-decided review must never be re-touched");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("security alert email produces a clean task title naming the account, never raw classifier text", async () => {
  const server = buildServer();
  const userId = `gmail-followups-security-title-${randomUUID()}`;

  try {
    const connectionId = await seedGmailUser(userId);
    await prisma.notificationSettings.create({ data: { userId, timezone: TIMEZONE } });
    const rule = await prisma.emailSignalRule.create({
      data: { userId, connectionId, adapterId: "custom_email_review", name: "Gmail reviews", status: "active", reviewBeforeLogging: true, createdBy: "user" }
    });
    await seedReview(userId, connectionId, rule.id, {
      subject: "Alerta de seguridad para letisyt@gmail.com",
      from: "Google <no-reply@accounts.google.com>",
      snippet: "The email is a security alert related to an account sign-in from a new device.",
      providerMessageId: "security-title-only",
      updatedAt: new Date()
    });

    await sendAgentMessage(server, userId, "show me the reviews");
    const reply = await sendAgentMessage(server, userId, "turn 1 into a task");

    const task = await prisma.actionItem.findFirst({ where: { userId } });
    assert.ok(task);
    assert.equal(task!.title, "Review security alert for letisyt@gmail.com");
    assert.doesNotMatch(task!.title, /^review security alert for -/i);
    assert.doesNotMatch(reply.reply, /the email is a security alert related to/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

