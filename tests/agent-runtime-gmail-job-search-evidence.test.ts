import { randomBytes, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { encryptSecretJson } from "../packages/core/src/index.ts";
import { createGoal } from "../packages/db/src/index.ts";
import { approveEmailReviewForUser, rejectEmailReviewForUser } from "../apps/api/src/email-reviews/email-review-service.ts";
import { buildServer, clearAgentRuntimeMocks, getAgentSession, mockPlan, op, prisma, seedUser, sendAgentMessage } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * fix/private-alpha-gmail-evidence-sync-and-review-flow: end-to-end hardening tests for the real
 * Gmail job-search sync/classify/review/dedupe/goal-progress loop, using the SAME built-in
 * job-search rule defaults V3's "enable job search rule for Gmail" actually creates
 * (apps/api/src/agent-runtime/executor.ts's builtInGmailRuleDefaults: reviewBeforeLogging false,
 * classifierMode "rules", minAutoLogConfidence 0.9) — not the review-first custom-rule defaults
 * other Gmail test files use, which would never exercise the auto-log branch these tests target.
 */

interface SeededGmailMessage {
  id: string;
  subject: string;
  from: string;
  body: string;
}

function installJobSearchGmailFetchMock(messages: SeededGmailMessage[]): { restore: () => void; nonGetCalls: string[] } {
  const previousFetch = globalThis.fetch;
  const nonGetCalls: string[] = [];

  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const method = (init?.method ?? "GET").toUpperCase();
    const urlText = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(urlText);

    if (method !== "GET") {
      nonGetCalls.push(`${method} ${url.pathname}`);
      return new Response("mutation not allowed in readonly Gmail sync test", { status: 500 });
    }

    if (url.hostname !== "gmail.googleapis.com") {
      return new Response("unexpected fetch", { status: 500 });
    }

    if (url.pathname === "/gmail/v1/users/me/messages") {
      return new Response(JSON.stringify({ messages: messages.map((message) => ({ id: message.id })) }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
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
        snippet: message.body.slice(0, 120),
        payload: {
          mimeType: "text/plain",
          headers: [
            { name: "Subject", value: message.subject },
            { name: "From", value: message.from },
            { name: "Date", value: "Thu, 20 Aug 2026 09:00:00 +0200" }
          ],
          body: { data: Buffer.from(message.body, "utf8").toString("base64url") }
        }
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  return {
    restore: () => {
      globalThis.fetch = previousFetch;
    },
    nonGetCalls
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
          accessToken: `job-search-access-${randomUUID()}`,
          refreshToken: `job-search-refresh-${randomUUID()}`,
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

/** Mirrors builtInGmailRuleDefaults("job_search") in apps/api/src/agent-runtime/executor.ts —
 * the actual rule V3's "enable job search rule for Gmail" creates. */
async function seedBuiltInJobSearchRule(userId: string, connectionId: string) {
  return prisma.emailSignalRule.create({
    data: {
      userId,
      connectionId,
      adapterId: "job_search_email",
      name: "Job search emails",
      query: "newer_than:30d",
      status: "active",
      fetchStrategy: "query",
      classifierMode: "rules",
      lookbackDays: 30,
      maxMessagesPerSync: 25,
      maxEventsPerSync: 10,
      minAutoLogConfidence: 0.9,
      minReviewConfidence: 0.65,
      reviewBeforeLogging: false,
      createdBy: "user"
    }
  });
}

const SIGNAL_MESSAGES: SeededGmailMessage[] = [
  {
    id: "m-application-confirmation",
    subject: "Thanks for applying to Acme",
    from: "Acme Careers <careers@acme.example>",
    body: "Thanks for applying to Acme for the Backend Engineer role. We have received your application and our team will review it soon."
  },
  {
    id: "m-recruiter-reply",
    subject: "Quick chat about the frontend role",
    from: "Jordi (Recruiter) <jordi@acme.example>",
    body: "Hi, I'm a recruiter from Acme Corp. Are you available for a quick call this week to discuss the Frontend Engineer role?"
  },
  {
    id: "m-interview-scheduled",
    subject: "Let's schedule your interview",
    from: "Acme Careers <careers@acme.example>",
    body: "Great news - let's schedule an interview for the Backend Engineer role. Are you available next week?"
  },
  {
    id: "m-rejection",
    subject: "Update on your application",
    from: "Acme Careers <careers@acme.example>",
    body: "Thank you for your interest in the role. We have decided not to proceed with your application for the Backend Engineer role at this time."
  },
  {
    id: "m-offer",
    subject: "Job offer from Acme",
    from: "Acme Careers <careers@acme.example>",
    body: "We are excited to offer you the role of Backend Engineer. Please find the compensation package details attached."
  },
  {
    id: "m-ambiguous-action-required",
    subject: "Application update needed",
    from: "Acme Careers <careers@acme.example>",
    body: "Action required: please complete your application for the Backend Engineer role at Acme within 48 hours or it will be discarded. Internal applicant reference: ALC-PRIVATE-88291."
  }
];

test("sync Gmail classifies clear job-search signals into events, sends the ambiguous one to review, and reports an honest per-type breakdown", async () => {
  const previousKey = process.env.ALECTO_SECRET_ENCRYPTION_KEY;
  process.env.ALECTO_SECRET_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  const server = buildServer();
  const userId = `gmail-job-search-evidence-${randomUUID()}`;
  const { restore, nonGetCalls } = installJobSearchGmailFetchMock(SIGNAL_MESSAGES);

  try {
    await seedUser(userId);
    const connection = await seedGmailConnection(userId);
    await seedBuiltInJobSearchRule(userId, connection.id);
    const created = await createGoal(userId, {
      title: "Find a remote developer job",
      category: "career",
      targetMetrics: [
        { key: "applications_sent_weekly", label: "Applications sent", labelSingular: "Application sent", eventType: "career.application_sent", aggregation: "count", window: "weekly" },
        { key: "recruiter_replies_weekly", label: "Recruiter replies", labelSingular: "Recruiter reply", eventType: "career.recruiter_reply_received", aggregation: "count", window: "weekly" }
      ]
    });
    if (created.duplicate) throw new Error("unexpected duplicate goal in test setup");

    // Task 4 (2 tasks later, fix/private-alpha-gmail-classifier-precision-and-proactive-
    // diagnostics): the sync reply now separates CONFIRMED/logged items from uncertain review
    // candidates entirely — a review candidate is never reported as a found/confirmed signal type.
    const sync = await sendAgentMessage(server, userId, "sync Gmail");
    assert.deepEqual(sync.operationsPlanned.map((operation) => operation.tool), ["gmail.sync"]);
    assert.match(sync.reply, /I scanned Gmail with the job-search rule\./);
    assert.match(sync.reply, /Logged clear items:/);
    assert.match(sync.reply, /- 1 recruiter reply/);
    assert.match(sync.reply, /- 1 application confirmation/);
    assert.match(sync.reply, /- 0 interview emails/);
    assert.match(sync.reply, /- 1 rejection email/);
    assert.match(sync.reply, /- 0 offer emails/);
    assert.doesNotMatch(sync.reply, /- 1 interview email\b/, "interview must never be reported as a logged/confirmed count — it was forced to review");
    assert.doesNotMatch(sync.reply, /- 1 offer email\b/, "offer must never be reported as a logged/confirmed count — it was forced to review");
    // Offer and interview are high-signal — forced to review even at auto-log confidence — so
    // only recruiter reply/application confirmation/rejection clear straight through; offer,
    // interview, and the one genuinely ambiguous email all need review, reported as a bare count
    // (never re-using the per-type breakdown for uncertain items).
    assert.match(sync.reply, /3 emails need review before I count them\./);

    // Task 2F / readonly: only GET calls should ever reach the Gmail API.
    assert.deepEqual(nonGetCalls, []);

    // Task 3 A-E: each clear (non-high-signal) signal became the correct, traceable career.* Event.
    const events = await prisma.event.findMany({ where: { userId, source: "gmail" }, orderBy: { type: "asc" } });
    assert.equal(events.length, 3);
    const eventByType = new Map(events.map((event) => [event.type, event]));
    assert.ok(eventByType.has("career.application_confirmation_received"));
    assert.ok(eventByType.has("career.recruiter_reply_received"));
    assert.ok(eventByType.has("career.rejection_received"));
    assert.ok(!eventByType.has("career.interview_scheduled"), "interview is high-signal — must go to review, not auto-log");
    assert.ok(!eventByType.has("career.offer_received"), "offer is high-signal — must go to review, not auto-log");
    for (const [messageId, eventType] of [
      ["m-application-confirmation", "career.application_confirmation_received"],
      ["m-recruiter-reply", "career.recruiter_reply_received"],
      ["m-rejection", "career.rejection_received"]
    ] as const) {
      const event = eventByType.get(eventType);
      assert.equal((event?.data as Record<string, unknown> | undefined)?.gmailMessageId, messageId, `${eventType} must be traceable to its source Gmail message id`);
    }

    // Task 3G / Task 4 (high-signal): the ambiguous "action required" email AND the two
    // high-signal emails (offer, interview) are NOT hallucinated into evidence — all three wait
    // for a human, each linked to its own source message.
    const reviews = await prisma.emailReviewItem.findMany({ where: { userId, status: "pending" } });
    assert.equal(reviews.length, 3);
    const reviewByMessageId = new Map(reviews.map((review) => [review.providerMessageId, review]));
    assert.ok(reviewByMessageId.has("m-ambiguous-action-required"));
    assert.ok(reviewByMessageId.has("m-interview-scheduled"));
    assert.ok(reviewByMessageId.has("m-offer"));
    assert.equal(reviewByMessageId.get("m-interview-scheduled")?.proposedEventType, "career.interview_scheduled");
    assert.equal(reviewByMessageId.get("m-offer")?.proposedEventType, "career.offer_received");
    assert.equal(await prisma.event.count({ where: { userId, source: "gmail", data: { path: ["gmailMessageId"], equals: "m-ambiguous-action-required" } } }), 0);

    // Task 4: "show reviews" gives a safe summary, never the raw private body text.
    const list = await sendAgentMessage(server, userId, "show Gmail reviews");
    assert.deepEqual(list.operationsPlanned.map((operation) => operation.tool), ["gmail.review.list"]);
    assert.match(list.reply, /Application update needed|Acme/);
    assert.doesNotMatch(list.reply, /ALC-PRIVATE-88291/, "must never expose the raw email body/private contents in chat");

    // Task 6A/6D: Gmail-derived recruiter-reply evidence shows in goal progress; the application
    // confirmation's DIFFERENT event type must not silently inflate "applications sent".
    mockPlan({
      topic: "goals",
      intent: "goal_status",
      operations: [op("goal.status", { goalRef: "job" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const progress = await sendAgentMessage(server, userId, "how's my job search going?");
    assert.match(progress.reply, /1 Recruiter reply/);
    assert.doesNotMatch(progress.reply, /Applications sent/i, "career.application_confirmation_received must not count as career.application_sent");

    // Task 5A/5B/5E: re-syncing the exact same mailbox state must not duplicate anything and must
    // say so honestly.
    const secondSync = await sendAgentMessage(server, userId, "sync Gmail");
    assert.match(secondSync.reply, /I scanned Gmail with the job-search rule\. No new job-search emails found\./);
    assert.equal(await prisma.event.count({ where: { userId, source: "gmail" } }), 3, "no duplicate events from the repeat sync");
    assert.equal(await prisma.emailReviewItem.count({ where: { userId } }), 3, "no duplicate review items from the repeat sync");
  } finally {
    restore();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
    if (previousKey === undefined) delete process.env.ALECTO_SECRET_ENCRYPTION_KEY;
    else process.env.ALECTO_SECRET_ENCRYPTION_KEY = previousKey;
  }
});

test("Task 4: approving a Gmail review is idempotent and rejecting creates no evidence", async () => {
  const previousKey = process.env.ALECTO_SECRET_ENCRYPTION_KEY;
  process.env.ALECTO_SECRET_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  const server = buildServer();
  const userId = `gmail-review-approve-reject-${randomUUID()}`;
  const messages: SeededGmailMessage[] = [
    SIGNAL_MESSAGES.find((message) => message.id === "m-ambiguous-action-required")!,
    { id: "m-second-ambiguous", subject: "Please confirm to continue", from: "Acme Careers <careers@acme.example>", body: "Action required: please finish your application to Acme for the Data Engineer role within 48 hours or it will be discarded." }
  ];
  const { restore } = installJobSearchGmailFetchMock(messages);

  try {
    await seedUser(userId);
    const connection = await seedGmailConnection(userId);
    await seedBuiltInJobSearchRule(userId, connection.id);

    await sendAgentMessage(server, userId, "sync Gmail");
    const pendingBefore = await prisma.emailReviewItem.findMany({ where: { userId, status: "pending" }, orderBy: { providerMessageId: "asc" } });
    assert.equal(pendingBefore.length, 2);
    assert.equal(pendingBefore[0].providerMessageId, "m-ambiguous-action-required");
    assert.equal(pendingBefore[1].providerMessageId, "m-second-ambiguous");

    // "show Gmail reviews" is what populates the session's ground-truth visible list —
    // approve/reject only trust a reviewId that appears there (validator.ts), so real reference
    // resolution by number, exactly as a user would do it, has to go through this list first.
    await sendAgentMessage(server, userId, "show Gmail reviews");
    const session = await getAgentSession(userId, "telegram");
    const visibleReviews = (session?.visibleEntities as Array<{ type: string; id: string; index: number }>).filter((entity) => entity.type === "gmail_review");
    assert.equal(visibleReviews.length, 2);
    const firstEntity = visibleReviews.find((entity) => entity.id === pendingBefore[0].id)!;
    const secondEntity = visibleReviews.find((entity) => entity.id === pendingBefore[1].id)!;

    mockPlan({
      topic: "gmail_reviews",
      intent: "approve_review",
      operations: [op("gmail.review.approve", { index: firstEntity.index })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const approve = await sendAgentMessage(server, userId, `approve review ${firstEntity.index}`);
    assert.equal(approve.debug.mutationExecuted, true);
    const approvedReview = await prisma.emailReviewItem.findUnique({ where: { id: pendingBefore[0].id } });
    assert.equal(approvedReview?.status, "approved");

    // Task 4E: approving the same (now-decided) review again must be a no-op, not a crash or a
    // second event. Calls the service directly (not through chat) since the chat layer
    // deliberately drops a reviewId once it falls out of the session's visible list — a separate,
    // already-correct anti-staleness guard this test isn't targeting.
    const secondApproveResult = await approveEmailReviewForUser(userId, pendingBefore[0].id);
    assert.equal(secondApproveResult.status, "not_pending", "re-approving an already-decided review must be a safe no-op, not a fresh mutation");
    const eventsAfterDoubleApprove = await prisma.event.count({ where: { userId, source: "gmail" } });

    // Re-list: approving the first review replaced the session's visible list with only the
    // still-pending one, renumbered — a fresh "show reviews" is what a real user would need too.
    await sendAgentMessage(server, userId, "show Gmail reviews");
    const sessionAfterApprove = await getAgentSession(userId, "telegram");
    const stillPending = (sessionAfterApprove?.visibleEntities as Array<{ type: string; id: string; index: number }>).filter((entity) => entity.type === "gmail_review");
    assert.equal(stillPending.length, 1);
    assert.equal(stillPending[0].id, secondEntity.id);

    mockPlan({
      topic: "gmail_reviews",
      intent: "reject_review",
      operations: [op("gmail.review.reject", { index: stillPending[0].index })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reject = await sendAgentMessage(server, userId, `reject review ${stillPending[0].index}`);
    assert.equal(reject.debug.mutationExecuted, true);
    const rejectedReview = await prisma.emailReviewItem.findUnique({ where: { id: pendingBefore[1].id } });
    assert.equal(rejectedReview?.status, "rejected");
    assert.equal(rejectedReview?.eventId, null, "rejecting must never create evidence");

    assert.equal(await prisma.event.count({ where: { userId, source: "gmail" } }), eventsAfterDoubleApprove, "double-approve must not create a second event");

    // Task 4F: pending count reflects that both reviews are now decided, not still pending.
    assert.equal(await prisma.emailReviewItem.count({ where: { userId, status: "pending" } }), 0);
  } finally {
    restore();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
    if (previousKey === undefined) delete process.env.ALECTO_SECRET_ENCRYPTION_KEY;
    else process.env.ALECTO_SECRET_ENCRYPTION_KEY = previousKey;
  }
});

test("Task 3F: a job-board newsletter is filtered, not counted as a recruiter reply", async () => {
  const previousKey = process.env.ALECTO_SECRET_ENCRYPTION_KEY;
  process.env.ALECTO_SECRET_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  const server = buildServer();
  const userId = `gmail-newsletter-filter-${randomUUID()}`;
  const { restore } = installJobSearchGmailFetchMock([
    {
      id: "m-newsletter",
      subject: "This week's top remote job openings",
      from: "Jobs Weekly <newsletter@jobsweekly.example>",
      body: "This week's top 10 remote job openings for developers. Unsubscribe anytime from this newsletter."
    }
  ]);

  try {
    await seedUser(userId);
    const connection = await seedGmailConnection(userId);
    await seedBuiltInJobSearchRule(userId, connection.id);

    const sync = await sendAgentMessage(server, userId, "sync Gmail");
    assert.match(sync.reply, /I scanned Gmail with the job-search rule\. No new job-search emails found\./);
    assert.equal(await prisma.event.count({ where: { userId, source: "gmail" } }), 0);
    assert.equal(await prisma.emailReviewItem.count({ where: { userId } }), 0);
  } finally {
    restore();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
    if (previousKey === undefined) delete process.env.ALECTO_SECRET_ENCRYPTION_KEY;
    else process.env.ALECTO_SECRET_ENCRYPTION_KEY = previousKey;
  }
});

test("Task 7: Gmail goal-usage status distinguishes not-connected, no-rule, and rule-active-with-sync-mode", async () => {
  const previousKey = process.env.ALECTO_SECRET_ENCRYPTION_KEY;
  process.env.ALECTO_SECRET_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  const server = buildServer();
  const userId = `gmail-status-four-states-${randomUUID()}`;

  try {
    await seedUser(userId);
    const created = await createGoal(userId, {
      title: "Find a remote developer job",
      category: "career",
      targetMetrics: [{ key: "recruiter_replies_weekly", label: "Recruiter replies", labelSingular: "Recruiter reply", eventType: "career.recruiter_reply_received", aggregation: "count", window: "weekly" }]
    });
    if (created.duplicate) throw new Error("unexpected duplicate goal in test setup");

    // State A: not connected.
    const notConnected = await sendAgentMessage(server, userId, "do u use my mail now for my goal?");
    assert.match(notConnected.reply, /not connected/i);

    // State B: connected, no active rule.
    const connection = await seedGmailConnection(userId);
    const noRule = await sendAgentMessage(server, userId, "do u use my mail now for my goal?");
    assert.match(noRule.reply, /not.*using it|no.*rule/i);
    assert.doesNotMatch(noRule.reply, /^Yes/i);

    // State C: connected, rule active, scheduled sync off (manual-only is the default).
    await seedBuiltInJobSearchRule(userId, connection.id);
    const ruleActive = await sendAgentMessage(server, userId, "do u use my mail now for my goal?");
    assert.match(ruleActive.reply, /^Yes/i);
    assert.match(ruleActive.reply, /manual|sync Gmail/i, "must distinguish manual-only from scheduled cadence");
    assert.doesNotMatch(ruleActive.reply, /scheduled Gmail checks are (also )?on|on a schedule/i, "must not claim scheduled sync is on when it is manual-only");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
    if (previousKey === undefined) delete process.env.ALECTO_SECRET_ENCRYPTION_KEY;
    else process.env.ALECTO_SECRET_ENCRYPTION_KEY = previousKey;
  }
});

test("Task 6: a sender rejected twice as newsletter/spam is suppressed on the next sync, but a genuine interview never is", async () => {
  const previousKey = process.env.ALECTO_SECRET_ENCRYPTION_KEY;
  process.env.ALECTO_SECRET_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  const server = buildServer();
  const userId = `gmail-reject-suppression-${randomUUID()}`;
  const repeatSender = "jobs@dailyquantboard.example";
  let restore: () => void = () => {};

  try {
    await seedUser(userId);
    const connection = await seedGmailConnection(userId);
    await seedBuiltInJobSearchRule(userId, connection.id);

    // First sync: two low-confidence "action required" emails from the same sender both land in
    // review (Task 6's real-transcript starting point — the user bulk-rejects ambiguous items
    // like this with "reject all, they are just spam or job newsletter no interviews").
    const firstBatch: SeededGmailMessage[] = [
      {
        id: "m-repeat-1",
        subject: "Application update needed",
        from: `Daily Quant Board <${repeatSender}>`,
        body: "Action required: please complete your application for the Quant Researcher role at Daily Quant Board within 48 hours or it will be discarded."
      },
      {
        id: "m-repeat-2",
        subject: "Application update needed again",
        from: `Daily Quant Board <${repeatSender}>`,
        body: "Action required: please complete your application for the Quant Researcher role at Daily Quant Board within 48 hours or it will be discarded, second reminder."
      }
    ];
    ({ restore } = installJobSearchGmailFetchMock(firstBatch));
    await sendAgentMessage(server, userId, "sync Gmail");
    const pendingAfterFirstSync = await prisma.emailReviewItem.findMany({ where: { userId, status: "pending" } });
    assert.equal(pendingAfterFirstSync.length, 2);
    restore();

    for (const review of pendingAfterFirstSync) {
      const result = await rejectEmailReviewForUser(userId, review.id);
      assert.equal(result.status, "ok");
    }
    assert.equal(await prisma.emailReviewItem.count({ where: { userId, status: "rejected" } }), 2, "same rejected messages must never reappear as pending again");

    // Second sync: a THIRD low-confidence email from the exact same rejected sender, plus a
    // genuine interview-scheduling email from an unrelated sender.
    const secondBatch: SeededGmailMessage[] = [
      {
        id: "m-repeat-3",
        subject: "One more thing about your application",
        from: `Daily Quant Board <${repeatSender}>`,
        body: "Action required: please re-confirm your application for the Quant Researcher role at Daily Quant Board within 48 hours or it will be discarded."
      },
      {
        id: "m-genuine-interview",
        subject: "Let's schedule your interview",
        from: "Real Recruiter <hiring@othercompany.example>",
        body: "Great news - let's schedule an interview for the Data Analyst role. Are you available next week?"
      }
    ];
    ({ restore } = installJobSearchGmailFetchMock(secondBatch));
    const secondSync = await sendAgentMessage(server, userId, "sync Gmail");
    assert.match(secondSync.reply, /I scanned Gmail with the job-search rule\./);
    restore();

    // Task 6C: a repeat low-confidence email from an already-twice-rejected sender is suppressed,
    // not raised for review again.
    const repeatReview = await prisma.emailReviewItem.findFirst({ where: { userId, providerMessageId: "m-repeat-3" } });
    assert.equal(repeatReview, null, "a third low-confidence email from an already-twice-rejected sender must be suppressed, not raised for review again");

    // Task 6D: a genuine interview email from an unrelated sender is never affected by someone
    // else's rejection history.
    const interviewReview = await prisma.emailReviewItem.findFirst({ where: { userId, providerMessageId: "m-genuine-interview" } });
    assert.ok(interviewReview, "a genuine interview email must always surface, unaffected by an unrelated sender's rejection history");
    assert.equal(interviewReview?.status, "pending");
    assert.equal(interviewReview?.proposedEventType, "career.interview_scheduled");

    // Third sync: even the repeat-rejected sender's OWN genuine interview email must still
    // surface — sender-history suppression only ever applies to low-confidence candidates, never
    // to a high-signal type (Task 6E: no overbroad suppression).
    const thirdBatch: SeededGmailMessage[] = [
      {
        id: "m-repeat-genuine-interview",
        subject: "Interview invitation",
        from: `Daily Quant Board <${repeatSender}>`,
        body: "We'd like to interview you for the Quant Researcher role - please book a time that works for you."
      }
    ];
    ({ restore } = installJobSearchGmailFetchMock(thirdBatch));
    await sendAgentMessage(server, userId, "sync Gmail");
    restore();

    const repeatSenderInterviewReview = await prisma.emailReviewItem.findFirst({ where: { userId, providerMessageId: "m-repeat-genuine-interview" } });
    assert.ok(repeatSenderInterviewReview, "a genuine interview from a previously-rejected sender must still surface - suppression never blocks a high-signal type");
    assert.equal(repeatSenderInterviewReview?.proposedEventType, "career.interview_scheduled");
  } finally {
    restore();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
    if (previousKey === undefined) delete process.env.ALECTO_SECRET_ENCRYPTION_KEY;
    else process.env.ALECTO_SECRET_ENCRYPTION_KEY = previousKey;
  }
});
