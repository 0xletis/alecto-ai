import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { addDaysToLocalDateString, formatDateInTimezone, formatLocalDateTime } from "../apps/api/src/utils/datetime.ts";
import { buildServer, clearAgentRuntimeMocks, getAgentSession, mockPlan, op, prisma, sendAgentMessage, seedUser, type MockPlan } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * Agent Runtime v3 Gmail review triage flow — making the already-wired gmail.review.list/reject/
 * to_action tools (apps/api/src/agent-runtime/tool-catalog.ts) actually reachable through normal
 * chat. Two gaps identified by the V3 global readiness audit (docs/10-v3-readiness-audit.md) are
 * closed here: planner.ts previously had zero prompt guidance for these tools, and
 * gmail.review.list's own summary was a bare count ("N email review(s).") with no per-item
 * detail, so there was no grounded way for a follow-up like "turn the recruiter one into a task"
 * to resolve. The itemized list (apps/api/src/email-reviews/email-review-service.ts's
 * formatGmailReviewListForChat) and index/ref resolution (validator.ts's resolveGmailReviewRef)
 * close both. No Gmail OAuth/sync/provider code was touched, and no send/reply/label capability
 * was added — reject/to_action only ever mutate Alecto's own EmailReviewItem/ActionItem rows.
 */

async function seedGmailUser(userId: string): Promise<string> {
  await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
  const connection = await prisma.integrationConnection.create({ data: { userId, integrationId: "gmail", status: "active", config: {} } });
  return connection.id;
}

async function seedReview(
  userId: string,
  connectionId: string,
  ruleId: string,
  overrides: {
    subject?: string;
    from?: string;
    snippet?: string;
    evidence?: string;
    providerMessageId: string;
    extracted?: Record<string, unknown>;
    proposedEventType?: string;
    updatedAt?: Date;
  }
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
      evidence: overrides.evidence ?? overrides.snippet,
      proposedEventType: overrides.proposedEventType,
      confidence: 0.8,
      reason: "custom_rule_match",
      extracted: overrides.extracted ?? {},
      status: "pending",
      updatedAt: overrides.updatedAt
    }
  });
}

function gmailReviewListPlan(): MockPlan {
  return { topic: "gmail_reviews", intent: "list_pending_reviews", operations: [op("gmail.review.list", { status: "pending" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" };
}

function gmailReviewToActionPlan(args: Record<string, unknown>): MockPlan {
  return { topic: "gmail_reviews", intent: "convert_review_to_action", operations: [op("gmail.review.to_action", args)], needsClarification: false, clarificationQuestion: null, replyDraft: "" };
}

function actionListPlan(operations = [op("action.list", { status: "all", limit: 10 })]): MockPlan {
  return { topic: "actions", intent: "list_actions", operations, needsClarification: false, clarificationQuestion: null, replyDraft: "" };
}

function gmailReviewRejectPlan(args: Record<string, unknown>): MockPlan {
  return { topic: "gmail_reviews", intent: "reject_review", operations: [op("gmail.review.reject", args)], needsClarification: false, clarificationQuestion: null, replyDraft: "" };
}

test("1. 'what emails need my attention?' plans and lists real pending Gmail reviews", async () => {
  const server = buildServer();
  const userId = `gmail-review-list-${randomUUID()}`;

  try {
    const connectionId = await seedGmailUser(userId);
    const rule = await prisma.emailSignalRule.create({ data: { userId, connectionId, adapterId: "custom_email_review", name: "Recruiter replies", status: "active", createdBy: "user" } });
    await seedReview(userId, connectionId, rule.id, { subject: "Recruiter reply from Example Labs", from: "recruiter@example.com", snippet: "Can we talk tomorrow?", providerMessageId: "m1" });

    mockPlan(gmailReviewListPlan());
    const reply = await sendAgentMessage(server, userId, "what emails need my attention?");

    assert.match(reply.reply, /pending gmail reviews?:/i);
    assert.match(reply.reply, /recruiter reply from example labs/i);
    assert.equal(reply.debug.mutationExecuted, false);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2. the list response is itemized (subjects/senders), not a bare count only", async () => {
  const server = buildServer();
  const userId = `gmail-review-itemized-${randomUUID()}`;

  try {
    const connectionId = await seedGmailUser(userId);
    const rule = await prisma.emailSignalRule.create({ data: { userId, connectionId, adapterId: "custom_email_review", name: "Endesa bills", status: "active", createdBy: "user" } });
    await seedReview(userId, connectionId, rule.id, { subject: "Recruiter reply from Example Labs", providerMessageId: "m1" });
    await seedReview(userId, connectionId, rule.id, { subject: "Endesa factura", snippet: "Your bill is ready", providerMessageId: "m2" });

    mockPlan(gmailReviewListPlan());
    const reply = await sendAgentMessage(server, userId, "show pending email reviews");

    assert.doesNotMatch(reply.reply, /^\d+ email review\(s\)\.?$/i, "must not regress to the old bare-count summary");
    assert.match(reply.reply, /^\d\. recruiter reply from example labs/im, "each item must be numbered");
    assert.match(reply.reply, /^\d\. endesa factura/im);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3. visible gmail_review entities are stored with indexes after listing", async () => {
  const server = buildServer();
  const userId = `gmail-review-entities-${randomUUID()}`;

  try {
    const connectionId = await seedGmailUser(userId);
    const rule = await prisma.emailSignalRule.create({ data: { userId, connectionId, adapterId: "custom_email_review", name: "Recruiter replies", status: "active", createdBy: "user" } });
    await seedReview(userId, connectionId, rule.id, { subject: "Recruiter reply from Example Labs", providerMessageId: "m1" });
    await seedReview(userId, connectionId, rule.id, { subject: "Endesa factura", providerMessageId: "m2" });

    mockPlan(gmailReviewListPlan());
    await sendAgentMessage(server, userId, "anything important in Gmail?");

    const row = await getAgentSession(userId);
    const entities = (row?.visibleEntities as Array<{ type: string; label: string; index?: number }> | null) ?? [];
    const reviewEntities = entities.filter((entity) => entity.type === "gmail_review");
    assert.equal(reviewEntities.length, 2);
    assert.ok(reviewEntities.every((entity) => typeof entity.index === "number" && entity.index > 0));
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4. 'turn the recruiter one into a task' resolves the right review and creates a grounded action", async () => {
  const server = buildServer();
  const userId = `gmail-review-to-action-${randomUUID()}`;

  try {
    const connectionId = await seedGmailUser(userId);
    const rule = await prisma.emailSignalRule.create({ data: { userId, connectionId, adapterId: "custom_email_review", name: "Recruiter replies", status: "active", createdBy: "user" } });
    const endesaRule = await prisma.emailSignalRule.create({ data: { userId, connectionId, adapterId: "custom_email_review", name: "Endesa bills", status: "active", createdBy: "user" } });
    const recruiterReview = await seedReview(userId, connectionId, rule.id, { subject: "Recruiter reply from Example Labs", snippet: "Can we talk tomorrow?", providerMessageId: "m1" });
    const endesaReview = await seedReview(userId, connectionId, endesaRule.id, { subject: "Endesa factura", providerMessageId: "m2" });

    mockPlan(gmailReviewListPlan());
    await sendAgentMessage(server, userId, "what emails need my attention?");

    mockPlan(gmailReviewToActionPlan({ ref: "recruiter" }));
    const reply = await sendAgentMessage(server, userId, "turn the recruiter one into a task");

    assert.match(reply.reply, /created task/i);
    assert.match(reply.reply, /reply to recruiter/i);
    assert.equal(reply.debug.mutationExecuted, true);

    const recruiterAfter = await prisma.emailReviewItem.findUnique({ where: { id: recruiterReview.id } });
    assert.equal(recruiterAfter?.status, "approved");
    assert.ok(recruiterAfter?.actionItemId);
    const action = await prisma.actionItem.findUniqueOrThrow({ where: { id: recruiterAfter.actionItemId } });
    assert.match(action.title, /reply to recruiter/i);
    assert.doesNotMatch(action.title, /follow up on/i);

    const endesaAfter = await prisma.emailReviewItem.findUnique({ where: { id: endesaReview.id } });
    assert.equal(endesaAfter?.status, "pending", "only the referenced review may change");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("Gmail review to task creates a specific Node.js upgrade action and respects tomorrow morning", async () => {
  const server = buildServer();
  const userId = `gmail-review-node-upgrade-${randomUUID()}`;
  const timezone = "Europe/Madrid";

  try {
    const connectionId = await seedGmailUser(userId);
    await prisma.notificationSettings.create({ data: { userId, timezone } });
    const rule = await prisma.emailSignalRule.create({
      data: {
        userId,
        connectionId,
        adapterId: "custom_email_review",
        name: "Platform notices",
        status: "active",
        reviewBeforeLogging: true,
        createdBy: "user"
      }
    });
    const review = await seedReview(userId, connectionId, rule.id, {
      subject: "[Action Required] Node.js 20 is being discontinued on October 1st, 2026",
      from: "Settings <settings@example.com>",
      snippet: "Hi there, Please upgrade to Node.js 24 as soon as possible. After October 1st, new builds using Node.js 20 will fail.",
      extracted: { project: "Settings" },
      proposedEventType: "work_action_required",
      providerMessageId: "node-upgrade"
    });

    mockPlan(gmailReviewListPlan());
    await sendAgentMessage(server, userId, "show me the item to review");

    const expectedLocalDate = addDaysToLocalDateString(formatDateInTimezone(new Date(), timezone), 1);
    mockPlan(gmailReviewToActionPlan({ index: 1, dueText: "tomorrow morning" }));
    const reply = await sendAgentMessage(server, userId, "turn it into a task for tomorrow morning");

    assert.equal(reply.debug.mutationExecuted, true);
    assert.match(reply.reply, /created task/i);
    assert.match(reply.reply, /node\.js/i);
    assert.match(reply.reply, /tomorrow morning|09:00|9:00/i);

    const updatedReview = await prisma.emailReviewItem.findUnique({ where: { id: review.id } });
    assert.equal(updatedReview?.status, "approved");
    assert.ok(updatedReview?.actionItemId);

    const action = await prisma.actionItem.findUniqueOrThrow({ where: { id: updatedReview.actionItemId } });
    assert.match(action.title, /node\.js/i);
    assert.match(action.title, /upgrade|24/i);
    assert.doesNotMatch(action.title, /follow up on settings/i);
    assert.ok(action.dueAt, "dueAt should be stored for tomorrow morning");
    assert.equal(formatDateInTimezone(action.dueAt!, timezone), expectedLocalDate);
    assert.match(formatLocalDateTime(action.dueAt!, timezone), /09:00/);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("Generic Gmail review to task still derives a specific Node.js upgrade action", async () => {
  const server = buildServer();
  const userId = `gmail-review-node-generic-${randomUUID()}`;

  try {
    const connectionId = await seedGmailUser(userId);
    const rule = await prisma.emailSignalRule.create({
      data: {
        userId,
        connectionId,
        adapterId: "custom_email_review",
        name: "Platform notices",
        status: "active",
        reviewBeforeLogging: true,
        createdBy: "user"
      }
    });
    const review = await seedReview(userId, connectionId, rule.id, {
      subject: "[Action Required] Node.js 20 is being discontinued on October 1st, 2026",
      from: "Settings <settings@example.com>",
      snippet: "Hi there, Please upgrade to Node.js 24 as soon as possible. After October 1st, new builds using Node.js 20 will fail.",
      extracted: { project: "Settings" },
      proposedEventType: "work_action_required",
      providerMessageId: "node-upgrade-generic"
    });

    mockPlan(gmailReviewListPlan());
    await sendAgentMessage(server, userId, "show me the item to review");

    mockPlan(gmailReviewToActionPlan({ index: 1 }));
    const reply = await sendAgentMessage(server, userId, "turn it into a task");

    assert.match(reply.reply, /created task/i);
    assert.match(reply.reply, /upgrade node\.js to 24/i);

    const updatedReview = await prisma.emailReviewItem.findUnique({ where: { id: review.id } });
    assert.ok(updatedReview?.actionItemId);
    const action = await prisma.actionItem.findUniqueOrThrow({ where: { id: updatedReview.actionItemId } });
    assert.equal(action.title, "Upgrade Node.js to 24");
    assert.doesNotMatch(action.title, /follow up on settings/i);
    assert.ok(action.dueAt);
    assert.equal(formatDateInTimezone(action.dueAt!, "Europe/Madrid"), "2026-10-01");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("Invoice Gmail review to task creates a concrete bill review action", async () => {
  const server = buildServer();
  const userId = `gmail-review-invoice-action-${randomUUID()}`;

  try {
    const connectionId = await seedGmailUser(userId);
    const rule = await prisma.emailSignalRule.create({
      data: {
        userId,
        connectionId,
        adapterId: "custom_email_review",
        name: "Endesa bills",
        status: "active",
        reviewBeforeLogging: true,
        createdBy: "user"
      }
    });
    const review = await seedReview(userId, connectionId, rule.id, {
      subject: "Endesa factura agosto",
      from: "Endesa <no-reply@endesa.com>",
      snippet: "Tu factura ya está disponible. Importe aproximado 60 euros.",
      providerMessageId: "endesa-invoice"
    });

    mockPlan(gmailReviewListPlan());
    await sendAgentMessage(server, userId, "show me the item to review");

    mockPlan(gmailReviewToActionPlan({ index: 1 }));
    const reply = await sendAgentMessage(server, userId, "turn it into a task");

    assert.match(reply.reply, /created task/i);
    assert.match(reply.reply, /endesa/i);

    const updatedReview = await prisma.emailReviewItem.findUnique({ where: { id: review.id } });
    assert.ok(updatedReview?.actionItemId);
    const action = await prisma.actionItem.findUniqueOrThrow({ where: { id: updatedReview.actionItemId } });
    assert.match(action.title, /review endesa bill/i);
    assert.doesNotMatch(action.title, /follow up/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("Gmail review-to-task transcript creates a clean Nest.js task, honors user timing, and lists tasks once", async () => {
  mock.timers.enable({ apis: ["Date"], now: new Date("2026-08-20T10:00:00.000Z") });
  const server = buildServer();
  const userId = `gmail-review-nest-transcript-${randomUUID()}`;
  const timezone = "Europe/Madrid";

  try {
    const connectionId = await seedGmailUser(userId);
    await prisma.notificationSettings.create({ data: { userId, timezone, morningTimeMinutes: 540 } });
    const rule = await prisma.emailSignalRule.create({
      data: {
        userId,
        connectionId,
        adapterId: "custom_email_review",
        name: "Platform notices",
        status: "active",
        reviewBeforeLogging: true,
        createdBy: "user"
      }
    });
    const review = await seedReview(userId, connectionId, rule.id, {
      subject: "[Action Required] Nest.js 20 is being discontinued on October 1st, 2026",
      from: "Settings <settings@example.com>",
      snippet: "Hi there, please upgrade to Nest.js 24 as soon as possible. After October 1st, new builds using Nest.js 20 will fail.",
      extracted: { project: "Settings" },
      proposedEventType: "work_action_required",
      providerMessageId: "nest-upgrade-transcript"
    });

    mockPlan(gmailReviewListPlan());
    const listReply = await sendAgentMessage(server, userId, "show me the item to review");
    assert.match(listReply.reply, /pending gmail reviews?/i);
    assert.match(listReply.reply, /nest\.js 20/i);

    mockPlan(gmailReviewToActionPlan({ index: 1, dueText: "tomorrow morning" }));
    const conversionReply = await sendAgentMessage(server, userId, "turn it into a task for tomorrow morning");

    assert.equal(conversionReply.debug.mutationExecuted, true);
    assert.match(conversionReply.reply, /created task/i);
    assert.match(conversionReply.reply, /upgrade nest\.js to 24/i);
    assert.doesNotMatch(conversionReply.reply, /as soon as po/i);
    assert.doesNotMatch(conversionReply.reply, /upgrade nest\.js 24/i);
    assert.doesNotMatch(conversionReply.reply, /01\/10\/2026|2026-10-01/i);

    const updatedReview = await prisma.emailReviewItem.findUnique({ where: { id: review.id } });
    assert.equal(updatedReview?.status, "approved");
    assert.ok(updatedReview?.actionItemId);

    const action = await prisma.actionItem.findUniqueOrThrow({ where: { id: updatedReview.actionItemId } });
    assert.equal(action.title, "Upgrade Nest.js to 24");
    assert.doesNotMatch(action.title, /as soon as po/i);
    assert.ok(action.dueAt, "dueAt should be stored");
    assert.equal(formatDateInTimezone(action.dueAt!, timezone), "2026-08-21");
    assert.match(formatLocalDateTime(action.dueAt!, timezone), /09:00/);

    mockPlan(actionListPlan([op("action.list", { status: "all", limit: 10 }), op("action.list", { status: "all", limit: 10 })]));
    const tasksReply = await sendAgentMessage(server, userId, "show all tasks");
    assert.equal((tasksReply.reply.match(/You have \d+ actions?:/g) ?? []).length, 1);
    assert.match(tasksReply.reply, /upgrade nest\.js to 24/i);
  } finally {
    mock.timers.reset();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("Gmail review meeting transcript supports list, QA, multi-task conversion, reminders, correction, and meeting query", async () => {
  mock.timers.enable({ apis: ["Date"], now: new Date("2026-08-20T10:00:00.000Z") });
  const server = buildServer();
  const userId = `gmail-review-meeting-transcript-${randomUUID()}`;
  const timezone = "Europe/Madrid";

  try {
    const connectionId = await seedGmailUser(userId);
    await prisma.notificationSettings.create({ data: { userId, timezone, morningTimeMinutes: 540 } });
    const rule = await prisma.emailSignalRule.create({
      data: {
        userId,
        connectionId,
        adapterId: "custom_email_review",
        name: "Work action emails",
        status: "active",
        reviewBeforeLogging: true,
        createdBy: "user"
      }
    });

    await seedReview(userId, connectionId, rule.id, {
      subject: "Branding direction meeting",
      from: "Client <client@example.com>",
      snippet: "Hey Letis, scheduled a branding direction meeting tomorrow at 9 AM. Bring 3 ideas.",
      proposedEventType: "work_deadline_detected",
      providerMessageId: "branding-meeting",
      updatedAt: new Date("2026-08-20T09:00:00.000Z")
    });
    await seedReview(userId, connectionId, rule.id, {
      subject: "Brainstorm meeting",
      from: "Client <client@example.com>",
      snippet: "Hey Letis, scheduled a braistorm meeting tomorrow at 12am see u there!",
      proposedEventType: "work_deadline_detected",
      providerMessageId: "brainstorm-meeting",
      updatedAt: new Date("2026-08-20T09:01:00.000Z")
    });
    await seedReview(userId, connectionId, rule.id, {
      subject: "Jobs Newsletter #461",
      from: "Jobs <jobs@example.com>",
      snippet: "Top jobs this week include Frontend Developer at Example Labs and Product Engineer roles.",
      providerMessageId: "jobs-newsletter",
      updatedAt: new Date("2026-08-20T09:02:00.000Z")
    });

    const list = await sendAgentMessage(server, userId, "show me the email reviews");
    assert.deepEqual(list.operationsPlanned.map((operation) => operation.tool), ["gmail.review.list"]);
    assert.match(list.reply, /Pending Gmail reviews/i);
    assert.match(list.reply, /^1\. Jobs Newsletter #461/im);
    assert.match(list.reply, /^2\. Brainstorm meeting/im);
    assert.match(list.reply, /^3\. Branding direction meeting/im);

    // fix/private-alpha-email-review-resolution-and-stale-classification (Task 4): gmail.review.
    // inspect is now a thin alias for the full-body detail/explanation flow (buildGmailReviewDetailResult)
    // — it no longer answers with a bare stored-snippet-substring "yes"/"no", and it must never say
    // it only has the stored subject/snippet/evidence when a real (or, absent a usable LLM key in
    // this test env, a gracefully-degraded) understanding attempt was made instead.
    const qa = await sendAgentMessage(server, userId, "the jobs newsletter one does it have any info on frontend developer jobs?");
    assert.deepEqual(qa.operationsPlanned.map((operation) => operation.tool), ["gmail.review.inspect"]);
    assert.match(qa.reply, /Jobs Newsletter #461/i);
    assert.match(qa.reply, /Frontend Developer/i);
    assert.doesNotMatch(qa.reply, /I only have the stored subject, snippet, and evidence/i);
    assert.doesNotMatch(qa.reply, /Pending Gmail reviews:/i);

    const created = await sendAgentMessage(server, userId, "turn 2 and 3 into tasks at the time they say in each mail and remind me 30 minutes before each");
    assert.deepEqual(created.operationsPlanned.map((operation) => operation.tool), ["gmail.review.to_action", "gmail.review.to_action"]);
    assert.equal(created.debug.mutationExecuted, true);
    assert.match(created.reply, /Created task: "Brainstorm meeting" for 21\/08\/2026, 00:00/i);
    assert.match(created.reply, /Reminder: 20\/08\/2026, 23:30/i);
    assert.match(created.reply, /Created task: "Branding direction meeting" for 21\/08\/2026, 09:00/i);
    assert.match(created.reply, /Reminder: 21\/08\/2026, 08:30/i);

    const meetingTasks = await prisma.actionItem.findMany({
      where: { userId, actionType: { not: "reminder" }, status: "open" },
      orderBy: { title: "asc" }
    });
    assert.deepEqual(meetingTasks.map((action) => action.title), ["Brainstorm meeting", "Branding direction meeting"]);
    const brainstorm = meetingTasks.find((action) => action.title === "Brainstorm meeting");
    const branding = meetingTasks.find((action) => action.title === "Branding direction meeting");
    assert.ok(brainstorm?.dueAt);
    assert.ok(branding?.dueAt);
    assert.match(formatLocalDateTime(brainstorm!.dueAt!, timezone), /21\/08\/2026, 00:00/);
    assert.match(formatLocalDateTime(branding!.dueAt!, timezone), /21\/08\/2026, 09:00/);

    let reminders = await prisma.actionItem.findMany({
      where: { userId, actionType: "reminder", status: "open" },
      orderBy: { dueAt: "asc" }
    });
    assert.equal(reminders.length, 2);
    assert.ok(reminders.every((action) => action.source === "system"));
    assert.match(reminders.map((action) => formatLocalDateTime(action.dueAt!, timezone)).join("\n"), /20\/08\/2026, 23:30/);
    assert.match(reminders.map((action) => formatLocalDateTime(action.dueAt!, timezone)).join("\n"), /21\/08\/2026, 08:30/);

    const correction = await sendAgentMessage(server, userId, "brainstorm meeting means 12pm i guess not am change it");
    assert.deepEqual(correction.operationsPlanned.map((operation) => operation.tool), ["action.reschedule"]);
    assert.match(correction.reply, /Action rescheduled: Brainstorm meeting/i);
    assert.match(correction.reply, /21\/08\/2026, 12:00/);
    assert.match(correction.reply, /Reminder updated: 21\/08\/2026, 11:30/);
    assert.doesNotMatch(correction.reply, /Completed/i);

    const afterCorrectionMeetings = await prisma.actionItem.findMany({
      where: { userId, title: "Brainstorm meeting", status: "open" }
    });
    assert.equal(afterCorrectionMeetings.length, 1);
    assert.match(formatLocalDateTime(afterCorrectionMeetings[0]!.dueAt!, timezone), /21\/08\/2026, 12:00/);

    const reminderReply = await sendAgentMessage(server, userId, "also will u remind me 30 min before of each meeting?");
    assert.deepEqual(reminderReply.operationsPlanned.map((operation) => operation.tool), ["action.create_pre_due_reminders"]);
    assert.match(reminderReply.reply, /Reminders set 30 minutes before/i);
    assert.match(reminderReply.reply, /Brainstorm meeting: 21\/08\/2026, 11:30/i);
    assert.match(reminderReply.reply, /Branding direction meeting: 21\/08\/2026, 08:30/i);

    reminders = await prisma.actionItem.findMany({
      where: { userId, actionType: "reminder", status: "open" },
      orderBy: { dueAt: "asc" }
    });
    assert.equal(reminders.length, 2, "re-asking for reminders must not duplicate reminder tasks");

    const meetings = await sendAgentMessage(server, userId, "when are my meetings");
    assert.deepEqual(meetings.operationsPlanned.map((operation) => operation.tool), ["action.meeting_list"]);
    assert.match(meetings.reply, /Your meetings:/i);
    assert.match(meetings.reply, /Branding direction meeting.*21\/08\/2026, 09:00.*Reminder: 21\/08\/2026, 08:30/i);
    assert.match(meetings.reply, /Brainstorm meeting.*21\/08\/2026, 12:00.*Reminder: 21\/08\/2026, 11:30/i);
    assert.doesNotMatch(meetings.reply, /Jobs Newsletter/i);
    assert.equal((meetings.reply.match(/You have \d+ actions?:/g) ?? []).length, 0);
  } finally {
    mock.timers.reset();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("mixed Gmail review triage honors explicit ignore/task/keep refs, relative time, and reminder query", async () => {
  mock.timers.enable({ apis: ["Date"], now: new Date("2026-08-20T21:07:00.000Z") });
  const server = buildServer();
  const userId = `gmail-review-mixed-triage-${randomUUID()}`;
  const timezone = "Europe/Madrid";

  try {
    const connectionId = await seedGmailUser(userId);
    await prisma.notificationSettings.create({ data: { userId, timezone, morningTimeMinutes: 540 } });
    const rule = await prisma.emailSignalRule.create({
      data: {
        userId,
        connectionId,
        adapterId: "custom_email_review",
        name: "Gmail reviews",
        status: "active",
        reviewBeforeLogging: true,
        createdBy: "user"
      }
    });

    await seedReview(userId, connectionId, rule.id, {
      subject: "Jobs Newsletter #461",
      from: "Jobs <jobs@example.com>",
      snippet: "Top jobs this week include Frontend Developer at Example Labs.",
      providerMessageId: "jobs-newsletter-mixed",
      updatedAt: new Date("2026-08-20T20:00:00.000Z")
    });
    await seedReview(userId, connectionId, rule.id, {
      subject: "Alerta de seguridad para letisyt@gmail.com",
      from: "Google <no-reply@accounts.google.com>",
      snippet: "Nuevo inicio de sesion detectado.",
      providerMessageId: "gmail-security-alert-mixed",
      updatedAt: new Date("2026-08-20T20:01:00.000Z")
    });
    await seedReview(userId, connectionId, rule.id, {
      subject: "RE: duda",
      from: "Friend <friend@example.com>",
      snippet: "Te respondo sobre la duda de antes.",
      providerMessageId: "duda-mixed",
      updatedAt: new Date("2026-08-20T20:02:00.000Z")
    });
    await seedReview(userId, connectionId, rule.id, {
      subject: "[0xletis] A security advisory on next affects at least one of your repositories",
      from: "GitHub <noreply@github.com>",
      snippet: "Security advisory: denial of service vulnerability affects next. Review and upgrade the affected repository.",
      providerMessageId: "github-dos-mixed",
      updatedAt: new Date("2026-08-20T20:03:00.000Z")
    });
    await seedReview(userId, connectionId, rule.id, {
      subject: "[0xletis] A security advisory on next affects at least one of your repositories",
      from: "GitHub <noreply@github.com>",
      snippet: "Security advisory: SSRF vulnerability affects next. Review and upgrade the affected repository.",
      providerMessageId: "github-ssrf-mixed",
      updatedAt: new Date("2026-08-20T20:04:00.000Z")
    });
    await seedReview(userId, connectionId, rule.id, {
      subject: "we need to seriously talk about getcracked",
      from: "Someone <person@example.com>",
      snippet: "We need to seriously talk about getcracked later.",
      providerMessageId: "getcracked-mixed",
      updatedAt: new Date("2026-08-20T20:05:00.000Z")
    });

    const list = await sendAgentMessage(server, userId, "show me the reviews");
    assert.match(list.reply, /^1\. we need to seriously talk about getcracked/im);
    assert.match(list.reply, /^2\. \[0xletis\] A security advisory/im);
    assert.match(list.reply, /^3\. \[0xletis\] A security advisory/im);
    assert.match(list.reply, /^4\. RE: duda/im);
    assert.match(list.reply, /^5\. Alerta de seguridad/im);
    assert.match(list.reply, /^6\. Jobs Newsletter #461/im);

    const triage = await sendAgentMessage(
      server,
      userId,
      "ignore 1, turn 2 and 3 into tasks 5 minutes from now and remind me of them at that time, ifnore 5 too, and 4 and 6 keep them in review for later"
    );

    assert.equal(triage.debug.mutationExecuted, true);
    assert.match(triage.reply, /ignored review 1/i);
    assert.match(triage.reply, /ignored review 5/i);
    assert.match(triage.reply, /created task/i);
    assert.match(triage.reply, /kept review 4/i);
    assert.match(triage.reply, /kept review 6/i);
    assert.match(triage.reply, /23:12/i);

    const actions = await prisma.actionItem.findMany({ where: { userId, status: "open" }, orderBy: { title: "asc" } });
    const taskActions = actions.filter((action) => action.actionType !== "reminder");
    const reminderActions = actions.filter((action) => action.actionType === "reminder");
    assert.equal(taskActions.length, 2, "only reviews 2 and 3 should become tasks");
    // "remind me of them at that time" means AT the task's own due moment — a separate companion
    // reminder ActionItem due at that exact same instant would just make the worker send a second,
    // duplicate notification for the same moment, so none should be created; the task's own due
    // notification already covers it.
    assert.equal(reminderActions.length, 0, "a reminder due at the exact same time as the task itself must not create a duplicate notification");
    assert.ok(taskActions.every((action) => /security advisory|github|next/i.test(action.title)), "created tasks must be the two GitHub security advisory reviews");
    assert.ok(taskActions.every((action) => !/getcracked|newsletter|duda|alerta/i.test(action.title)), "ignored/kept reviews must not become tasks");
    for (const action of taskActions) {
      assert.ok(action.dueAt);
      assert.equal(formatLocalDateTime(action.dueAt!, timezone), "20/08/2026, 23:12");
    }

    const reviews = await prisma.emailReviewItem.findMany({ where: { userId }, orderBy: { updatedAt: "desc" } });
    const byProviderMessageId = new Map(reviews.map((review) => [review.providerMessageId, review]));
    assert.equal(byProviderMessageId.get("getcracked-mixed")?.status, "rejected");
    assert.equal(byProviderMessageId.get("github-ssrf-mixed")?.status, "approved");
    assert.equal(byProviderMessageId.get("github-dos-mixed")?.status, "approved");
    assert.equal(byProviderMessageId.get("duda-mixed")?.status, "pending");
    assert.equal(byProviderMessageId.get("gmail-security-alert-mixed")?.status, "rejected");
    assert.equal(byProviderMessageId.get("jobs-newsletter-mixed")?.status, "pending");

    const reminders = await sendAgentMessage(server, userId, "do i have any reminders on");
    assert.deepEqual(reminders.operationsPlanned.map((operation) => operation.tool), ["action.reminder_list"]);
    // No separate reminder ActionItems exist (see above) — the two tasks' own due notifications
    // are the only thing that will fire, so the reminder list is honestly empty.
    assert.match(reminders.reply, /no reminders are currently scheduled/i);
    assert.doesNotMatch(reminders.reply, /You have \d+ actions?:/i);
    assert.doesNotMatch(reminders.reply, /getcracked|Jobs Newsletter|RE: duda/i);
  } finally {
    mock.timers.reset();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("an explicitly ignored Gmail review cannot become a task even if a bad planner plan is queued", async () => {
  mock.timers.enable({ apis: ["Date"], now: new Date("2026-08-20T21:07:00.000Z") });
  const server = buildServer();
  const userId = `gmail-review-ignore-blocks-task-${randomUUID()}`;

  try {
    const connectionId = await seedGmailUser(userId);
    await prisma.notificationSettings.create({ data: { userId, timezone: "Europe/Madrid" } });
    const rule = await prisma.emailSignalRule.create({
      data: {
        userId,
        connectionId,
        adapterId: "custom_email_review",
        name: "Gmail reviews",
        status: "active",
        reviewBeforeLogging: true,
        createdBy: "user"
      }
    });
    const review = await seedReview(userId, connectionId, rule.id, {
      subject: "we need to seriously talk about getcracked",
      from: "Someone <person@example.com>",
      snippet: "We need to seriously talk about getcracked later.",
      providerMessageId: "getcracked-ignore-blocks-task"
    });

    await sendAgentMessage(server, userId, "show me the reviews");

    mockPlan(gmailReviewToActionPlan({ index: 1, dueText: "5 minutes from now" }));
    const reply = await sendAgentMessage(server, userId, "ignore 1");

    assert.deepEqual(reply.operationsPlanned.map((operation) => operation.tool), ["gmail.review.reject"]);
    assert.doesNotMatch(reply.reply, /created task/i);
    assert.equal(reply.debug.mutationExecuted, true);

    const actions = await prisma.actionItem.findMany({ where: { userId } });
    assert.equal(actions.length, 0);
    const updatedReview = await prisma.emailReviewItem.findUnique({ where: { id: review.id } });
    assert.equal(updatedReview?.status, "rejected");
  } finally {
    mock.timers.reset();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("Gmail review-to-task extracts tomorrow morning from the user message when planner omits dueText", async () => {
  mock.timers.enable({ apis: ["Date"], now: new Date("2026-08-20T10:00:00.000Z") });
  const server = buildServer();
  const userId = `gmail-review-nest-timing-fallback-${randomUUID()}`;
  const timezone = "Europe/Madrid";

  try {
    const connectionId = await seedGmailUser(userId);
    await prisma.notificationSettings.create({ data: { userId, timezone, morningTimeMinutes: 540 } });
    const rule = await prisma.emailSignalRule.create({
      data: {
        userId,
        connectionId,
        adapterId: "custom_email_review",
        name: "Platform notices",
        status: "active",
        reviewBeforeLogging: true,
        createdBy: "user"
      }
    });
    const review = await seedReview(userId, connectionId, rule.id, {
      subject: "[Action Required] Nest.js 20 is being discontinued on October 1st, 2026",
      from: "Settings <settings@example.com>",
      snippet: "Hi there, please upgrade to Nest.js 24 as soon as possible. After October 1st, new builds using Nest.js 20 will fail.",
      extracted: { project: "Settings" },
      proposedEventType: "work_action_required",
      providerMessageId: "nest-upgrade-timing-fallback"
    });

    mockPlan(gmailReviewListPlan());
    await sendAgentMessage(server, userId, "show me the item to review");

    mockPlan(gmailReviewToActionPlan({ index: 1 }));
    const reply = await sendAgentMessage(server, userId, "turn it into a task for tomorrow morning");

    assert.match(reply.reply, /created task/i);
    assert.match(reply.reply, /upgrade nest\.js to 24/i);
    assert.doesNotMatch(reply.reply, /01\/10\/2026|2026-10-01/i);

    const updatedReview = await prisma.emailReviewItem.findUnique({ where: { id: review.id } });
    assert.ok(updatedReview?.actionItemId);
    const action = await prisma.actionItem.findUniqueOrThrow({ where: { id: updatedReview.actionItemId } });
    assert.equal(action.title, "Upgrade Nest.js to 24");
    assert.ok(action.dueAt);
    assert.equal(formatDateInTimezone(action.dueAt!, timezone), "2026-08-21");
    assert.match(formatLocalDateTime(action.dueAt!, timezone), /09:00/);
  } finally {
    mock.timers.reset();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("5. 'reject Endesa' resolves the right review and rejects only that one", async () => {
  const server = buildServer();
  const userId = `gmail-review-reject-${randomUUID()}`;

  try {
    const connectionId = await seedGmailUser(userId);
    const rule = await prisma.emailSignalRule.create({ data: { userId, connectionId, adapterId: "custom_email_review", name: "Recruiter replies", status: "active", createdBy: "user" } });
    const endesaRule = await prisma.emailSignalRule.create({ data: { userId, connectionId, adapterId: "custom_email_review", name: "Endesa bills", status: "active", createdBy: "user" } });
    const recruiterReview = await seedReview(userId, connectionId, rule.id, { subject: "Recruiter reply from Example Labs", providerMessageId: "m1" });
    const endesaReview = await seedReview(userId, connectionId, endesaRule.id, { subject: "Endesa factura", providerMessageId: "m2" });

    mockPlan(gmailReviewListPlan());
    await sendAgentMessage(server, userId, "what emails need my attention?");

    mockPlan(gmailReviewRejectPlan({ ref: "Endesa" }));
    const reply = await sendAgentMessage(server, userId, "reject Endesa");

    assert.match(reply.reply, /rejected/i);
    assert.equal(reply.debug.mutationExecuted, true);

    const endesaAfter = await prisma.emailReviewItem.findUnique({ where: { id: endesaReview.id } });
    assert.equal(endesaAfter?.status, "rejected");
    const recruiterAfter = await prisma.emailReviewItem.findUnique({ where: { id: recruiterReview.id } });
    assert.equal(recruiterAfter?.status, "pending", "only the referenced review may change");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("'ignore the first one' resolves by index against the visible list", async () => {
  const server = buildServer();
  const userId = `gmail-review-index-${randomUUID()}`;

  try {
    const connectionId = await seedGmailUser(userId);
    const rule = await prisma.emailSignalRule.create({ data: { userId, connectionId, adapterId: "custom_email_review", name: "Recruiter replies", status: "active", createdBy: "user" } });
    await seedReview(userId, connectionId, rule.id, { subject: "Recruiter reply from Example Labs", providerMessageId: "m1" });
    await seedReview(userId, connectionId, rule.id, { subject: "Endesa factura", providerMessageId: "m2" });

    mockPlan(gmailReviewListPlan());
    await sendAgentMessage(server, userId, "what emails need my attention?");

    // getEmailReviewItems orders by updatedAt desc, not creation order, so which seeded review
    // lands at index 1 isn't fixed up front — read it back from the session's own visible
    // entities, the same ground truth resolveGmailReviewRef itself resolves against.
    const row = await getAgentSession(userId);
    const entities = (row?.visibleEntities as Array<{ type: string; id: string; index?: number }> | null) ?? [];
    const firstEntity = entities.find((entity) => entity.type === "gmail_review" && entity.index === 1);
    assert.ok(firstEntity, "the list must have stored an index-1 gmail_review entity");

    mockPlan(gmailReviewRejectPlan({ index: 1 }));
    const reply = await sendAgentMessage(server, userId, "ignore the first one");

    assert.match(reply.reply, /rejected/i);
    const firstAfter = await prisma.emailReviewItem.findUnique({ where: { id: firstEntity!.id } });
    assert.equal(firstAfter?.status, "rejected");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("6. an ambiguous reference asks for clarification and mutates nothing", async () => {
  const server = buildServer();
  const userId = `gmail-review-ambiguous-${randomUUID()}`;

  try {
    const connectionId = await seedGmailUser(userId);
    const rule = await prisma.emailSignalRule.create({ data: { userId, connectionId, adapterId: "custom_email_review", name: "Endesa bills", status: "active", createdBy: "user" } });
    const first = await seedReview(userId, connectionId, rule.id, { subject: "Endesa factura enero", providerMessageId: "m1" });
    const second = await seedReview(userId, connectionId, rule.id, { subject: "Endesa factura febrero", providerMessageId: "m2" });

    mockPlan(gmailReviewListPlan());
    await sendAgentMessage(server, userId, "what emails need my attention?");

    mockPlan(gmailReviewRejectPlan({ ref: "Endesa" }));
    const reply = await sendAgentMessage(server, userId, "reject the Endesa one");

    assert.equal(reply.debug.mutationExecuted, false);
    assert.equal(reply.debug.pendingOperation, false);
    assert.notEqual(reply.reply, "");

    const firstAfter = await prisma.emailReviewItem.findUnique({ where: { id: first.id } });
    const secondAfter = await prisma.emailReviewItem.findUnique({ where: { id: second.id } });
    assert.equal(firstAfter?.status, "pending");
    assert.equal(secondAfter?.status, "pending");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("7. an unknown reference asks for clarification and mutates nothing", async () => {
  const server = buildServer();
  const userId = `gmail-review-unknown-${randomUUID()}`;

  try {
    const connectionId = await seedGmailUser(userId);
    const rule = await prisma.emailSignalRule.create({ data: { userId, connectionId, adapterId: "custom_email_review", name: "Recruiter replies", status: "active", createdBy: "user" } });
    const review = await seedReview(userId, connectionId, rule.id, { subject: "Recruiter reply from Example Labs", providerMessageId: "m1" });

    mockPlan(gmailReviewListPlan());
    await sendAgentMessage(server, userId, "what emails need my attention?");

    mockPlan(gmailReviewToActionPlan({ ref: "car insurance" }));
    const reply = await sendAgentMessage(server, userId, "turn the car insurance email into a task");

    assert.equal(reply.debug.mutationExecuted, false);
    assert.notEqual(reply.reply, "");

    const reviewAfter = await prisma.emailReviewItem.findUnique({ where: { id: review.id } });
    assert.equal(reviewAfter?.status, "pending");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("a reference given with no review list shown yet asks for clarification and mutates nothing", async () => {
  const server = buildServer();
  const userId = `gmail-review-no-list-yet-${randomUUID()}`;

  try {
    await seedUser(userId);

    mockPlan(gmailReviewRejectPlan({ ref: "Endesa" }));
    const reply = await sendAgentMessage(server, userId, "reject the Endesa one");

    assert.equal(reply.debug.mutationExecuted, false);
    assert.match(reply.reply, /don't have any gmail reviews in view/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("8. no pending reviews returns an honest empty state", async () => {
  const server = buildServer();
  const userId = `gmail-review-empty-${randomUUID()}`;

  try {
    await seedGmailUser(userId);

    mockPlan(gmailReviewListPlan());
    const reply = await sendAgentMessage(server, userId, "what emails need my attention?");

    assert.match(reply.reply, /no email reviews are waiting/i);
    assert.equal(reply.debug.mutationExecuted, false);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("a direct reviewId is no longer trusted when the review was never actually shown (audit/v3-mutating-tool-boundaries)", async () => {
  // Was previously "a direct reviewId is still honored as-is (already-resolved internal case)" —
  // that name assumed a directly-supplied reviewId only ever came from an already-verified
  // internal source, but nothing enforced that: the real LLM planner path (exercised via mockPlan
  // here, same as any other test in this file) could supply one too, with zero grounding — the
  // exact pre-hardening shape action.complete/snooze/archive used to have for actionId. Closed by
  // validator.ts's new gmail-review-id trust check: a directly-supplied reviewId is only honored
  // when it matches a review from THIS turn's own visibleEntities (the only place a real id is
  // ever actually shown to the planner — buildUserPayload never sends real review ids at all,
  // only a bare pendingGmailReviewCount) — never trusted purely because it belongs to this user
  // and exists in the database.
  const server = buildServer();
  const userId = `gmail-review-direct-id-${randomUUID()}`;

  try {
    const connectionId = await seedGmailUser(userId);
    const rule = await prisma.emailSignalRule.create({ data: { userId, connectionId, adapterId: "custom_email_review", name: "Recruiter replies", status: "active", createdBy: "user" } });
    const review = await seedReview(userId, connectionId, rule.id, { subject: "Recruiter reply from Example Labs", providerMessageId: "m1" });

    // No gmail.review.list call first — this review was never shown, so nothing about it is in
    // session.visibleEntities. A "bad planner" that nonetheless supplies its real id directly
    // must be blocked, not trusted.
    mockPlan(gmailReviewRejectPlan({ reviewId: review.id }));
    const reply = await sendAgentMessage(server, userId, "reject that review directly by id");

    assert.doesNotMatch(reply.reply, /rejected/i);
    assert.match(reply.reply, /i don't have any gmail reviews in view/i);
    const reviewAfter = await prisma.emailReviewItem.findUnique({ where: { id: review.id } });
    assert.equal(reviewAfter?.status, "pending", "an unverified direct reviewId must never mutate the review");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("a direct reviewId IS still honored when it matches a review the user was actually just shown", async () => {
  const server = buildServer();
  const userId = `gmail-review-direct-id-visible-${randomUUID()}`;

  try {
    const connectionId = await seedGmailUser(userId);
    const rule = await prisma.emailSignalRule.create({ data: { userId, connectionId, adapterId: "custom_email_review", name: "Recruiter replies", status: "active", createdBy: "user" } });
    const review = await seedReview(userId, connectionId, rule.id, { subject: "Recruiter reply from Example Labs", providerMessageId: "m1" });

    mockPlan({ topic: "gmail_reviews", intent: "list", operations: [op("gmail.review.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "what emails need my attention?");

    // Now that it's genuinely visible, the real planner supplying its real id directly (rather
    // than index/ref) must still work — this isn't a new restriction on the legitimate case, only
    // on an unverified one.
    mockPlan(gmailReviewRejectPlan({ reviewId: review.id }));
    const reply = await sendAgentMessage(server, userId, "reject that review directly by id");

    assert.match(reply.reply, /rejected/i);
    const reviewAfter = await prisma.emailReviewItem.findUnique({ where: { id: review.id } });
    assert.equal(reviewAfter?.status, "rejected");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
