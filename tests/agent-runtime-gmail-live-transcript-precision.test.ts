import { randomBytes, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { encryptSecretJson } from "../packages/core/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, prisma, seedUser, sendAgentMessage } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * fix/private-alpha-gmail-classifier-precision-and-proactive-diagnostics: deterministic
 * regression coverage using the EXACT email kinds from the live Telegram transcript that
 * motivated this branch — a CryptoJobsList-style talent newsletter, three quant/interview-prep/
 * LeetCode content newsletters (each real transcript subject lines, verbatim), a Blockchain.com-
 * style application security code, a genuine recruiter reply, and a genuine interview-scheduling
 * email. Before this branch, the four newsletters were misclassified as a recruiter reply and
 * high-priority interview events, the security code email got a generic "event" label, and the
 * sync summary reported uncertain review items as confirmed found signals — this file locks in
 * the fix so none of that can silently regress.
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
          accessToken: `live-transcript-access-${randomUUID()}`,
          refreshToken: `live-transcript-refresh-${randomUUID()}`,
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

const LIVE_TRANSCRIPT_MAILBOX: SeededGmailMessage[] = [
  {
    id: "m-cryptojobslist",
    subject: "CryptoJobsList Talent Newsletter - This Week's Top Roles",
    from: "CryptoJobsList Talent Newsletter <talent@cryptojobslist.example>",
    body: "View this email in your browser. Here are the top jobs this week for blockchain engineers, recruiters, and hiring teams. Unsubscribe from this newsletter at any time."
  },
  {
    id: "m-getcracked",
    subject: "we need to seriously talk about getcracked",
    from: "getcracked Newsletter <hello@getcracked.example>",
    body: "This newsletter breaks down what it really takes to pass quant interviews and land offers. Unsubscribe anytime. View in browser."
  },
  {
    id: "m-leetcode-mind",
    subject: "I am one LeetCode question away from losing my mind",
    from: "Interview Prep Weekly <digest@interviewprepweekly.example>",
    body: "This week's job digest covers LeetCode interview questions, mock interview drills, and how to pass interviews at top firms. Unsubscribe from this weekly jobs newsletter anytime."
  },
  {
    id: "m-quant-iq",
    subject: "do you need a 160 IQ to get into quant?",
    from: "Quant Careers Digest <news@quantcareersdigest.example>",
    body: "Our talent newsletter explains what quant interviews are really like and whether you need a 160 IQ to break in. View in browser. Unsubscribe here."
  },
  {
    id: "m-security-code",
    subject: "Security code for your application to Blockchain.com",
    from: "Blockchain.com Careers <careers@blockchain.example>",
    body: "Your security code is 482913. Enter the code to continue your application for the Senior Engineer role at Blockchain.com."
  },
  {
    id: "m-genuine-recruiter",
    subject: "Quick chat about the frontend role",
    from: "Jordi (Recruiter) <jordi@realcompany.example>",
    body: "Hi, I'm a recruiter from Real Company. Are you available for a quick call this week to discuss the Frontend Engineer role?"
  },
  {
    id: "m-genuine-interview",
    subject: "Let's schedule your interview",
    from: "Real Company Careers <careers@realcompany.example>",
    body: "Great news - let's schedule an interview for the Frontend Engineer role. Are you available next week?"
  }
];

test("live-transcript mailbox: newsletters/content emails never become a recruiter reply or interview event", async () => {
  const previousKey = process.env.ALECTO_SECRET_ENCRYPTION_KEY;
  process.env.ALECTO_SECRET_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  const server = buildServer();
  const userId = `gmail-live-transcript-${randomUUID()}`;
  const { restore, nonGetCalls } = installJobSearchGmailFetchMock(LIVE_TRANSCRIPT_MAILBOX);

  try {
    await seedUser(userId);
    const connection = await seedGmailConnection(userId);
    await seedBuiltInJobSearchRule(userId, connection.id);

    const sync = await sendAgentMessage(server, userId, "sync Gmail");
    assert.deepEqual(nonGetCalls, [], "sync must be strictly readonly");

    // The four newsletter/content emails must never become events OR review items at all - they
    // are filtered_marketing, exactly like the real CryptoJobsList/quant-prep/LeetCode senders
    // from the transcript.
    for (const id of ["m-cryptojobslist", "m-getcracked", "m-leetcode-mind", "m-quant-iq"]) {
      assert.equal(await prisma.event.count({ where: { userId, source: "gmail", data: { path: ["gmailMessageId"], equals: id } } }), 0, `${id} must never become a logged event`);
      assert.equal(await prisma.emailReviewItem.count({ where: { userId, providerMessageId: id } }), 0, `${id} must never even reach review - it's a newsletter, filtered before that`);
    }

    // The genuine recruiter reply auto-logs as a real recruiter-reply event (high confidence,
    // not high-signal, so it clears straight through).
    const recruiterEvent = await prisma.event.findFirst({ where: { userId, source: "gmail", data: { path: ["gmailMessageId"], equals: "m-genuine-recruiter" } } });
    assert.ok(recruiterEvent, "a genuine 1:1 recruiter reply must still be classified and logged correctly");
    assert.equal(recruiterEvent?.type, "career.recruiter_reply_received");

    // The genuine interview-scheduling email is high-signal - forced to review, not silently
    // auto-logged, but it MUST still be correctly classified as career.interview_scheduled (not
    // filtered, not "unknown").
    const interviewReview = await prisma.emailReviewItem.findFirst({ where: { userId, providerMessageId: "m-genuine-interview" } });
    assert.ok(interviewReview, "a genuine interview-scheduling email must reach review");
    assert.equal(interviewReview?.proposedEventType, "career.interview_scheduled");
    assert.equal(interviewReview?.status, "pending");

    // Task 7: a bare security/verification code is deliberately hard-filtered before it can ever
    // become a review item or an event, regardless of job-application context (see
    // tests/email-review-dedupe.test.ts's "Gmail security and auth emails are hard-filtered..." -
    // a pre-existing, separately tested policy this branch does not change) - so it must never
    // count as an application confirmation, a recruiter reply, or any other progress update.
    assert.equal(await prisma.emailReviewItem.count({ where: { userId, providerMessageId: "m-security-code" } }), 0, "a bare security code must be hard-filtered, not raised for review");
    assert.equal(await prisma.event.count({ where: { userId, source: "gmail", data: { path: ["gmailMessageId"], equals: "m-security-code" } } }), 0, "a bare security code must never itself count as an application confirmation / progress update");

    // Sync summary honesty: only the one genuine recruiter reply is a logged/confirmed item; the
    // interview needs review, never reported as a found signal.
    assert.match(sync.reply, /I scanned Gmail with the job-search rule\./);
    assert.match(sync.reply, /Logged clear items:/);
    assert.match(sync.reply, /- 1 recruiter reply/);
    assert.doesNotMatch(sync.reply, /- 1 interview email\b/, "the forced-review interview must never be reported as a logged/confirmed count");
    assert.match(sync.reply, /1 email needs review before I count it\./);

    // Review-list hygiene: the interview is flagged high priority; the newsletters and the
    // security code never even appear, since neither ever reached review.
    const reviewList = await sendAgentMessage(server, userId, "email reviews");
    assert.doesNotMatch(reviewList.reply, /Security code/, "a hard-filtered security-code email must never appear in the review list");
    assert.match(reviewList.reply, /\[High priority\][^\n]*Let's schedule your interview/);
  } finally {
    restore();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
    if (previousKey === undefined) delete process.env.ALECTO_SECRET_ENCRYPTION_KEY;
    else process.env.ALECTO_SECRET_ENCRYPTION_KEY = previousKey;
  }
});

test("Task 5: review summaries strip invisible characters, decode HTML entities, and never dump the raw body - while still preserving the real sender address", async () => {
  const previousKey = process.env.ALECTO_SECRET_ENCRYPTION_KEY;
  process.env.ALECTO_SECRET_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  const server = buildServer();
  const userId = `gmail-review-hygiene-${randomUUID()}`;
  const zeroWidthSpace = "\u200B";
  const softHyphen = "\u00AD";
  const messyBody =
    `Action${zeroWidthSpace} required:${softHyphen} please&nbsp;complete&#39;your application for the&amp;Data Engineer role. ` +
    `<div>This is embedded HTML that must never leak into chat.</div>` +
    "Internal applicant reference: ALC-PRIVATE-77123. ".repeat(30);

  const { restore } = installJobSearchGmailFetchMock([
    {
      id: "m-messy",
      subject: `Application${zeroWidthSpace} update needed`,
      from: "Acme Careers <careers@acme.example>",
      body: messyBody
    }
  ]);

  try {
    await seedUser(userId);
    const connection = await seedGmailConnection(userId);
    await seedBuiltInJobSearchRule(userId, connection.id);

    await sendAgentMessage(server, userId, "sync Gmail");
    const review = await prisma.emailReviewItem.findFirst({ where: { userId, providerMessageId: "m-messy" } });
    assert.ok(review);

    // The sender's real address survives sanitization - it must not be silently dropped just
    // because "<careers@acme.example>" looks like an HTML tag to a naive stripper.
    assert.match(review!.from ?? "", /careers@acme\.example/);

    // Stored snippet/evidence must be clean: no invisible characters, no raw HTML tags, no HTML
    // entities left undecoded, and never the full repeated raw body.
    for (const field of [review!.snippet ?? "", review!.evidence ?? "", review!.subject ?? ""]) {
      assert.doesNotMatch(field, /[\u200B\u00AD]/, "invisible/zero-width characters must be stripped");
      assert.doesNotMatch(field, /<div>|<\/div>/, "raw HTML tags must be stripped");
      assert.doesNotMatch(field, /&nbsp;|&#39;|&amp;/, "HTML entities must be decoded, not left raw");
    }
    assert.ok((review!.evidence ?? "").length < messyBody.length, "evidence must be capped, never the full raw body");

    const reviewList = await sendAgentMessage(server, userId, "email reviews");
    assert.doesNotMatch(reviewList.reply, /[\u200B\u00AD]/, "chat output must never contain invisible characters");
    assert.doesNotMatch(reviewList.reply, /<div>/, "chat output must never contain raw HTML");
    assert.doesNotMatch(reviewList.reply, /(ALC-PRIVATE-77123.*){3,}/, "chat output must never dump the long repeated raw body");
  } finally {
    restore();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
    if (previousKey === undefined) delete process.env.ALECTO_SECRET_ENCRYPTION_KEY;
    else process.env.ALECTO_SECRET_ENCRYPTION_KEY = previousKey;
  }
});
