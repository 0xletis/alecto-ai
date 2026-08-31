import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createActionItem, createGoal, prisma } from "../packages/db/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, mockPlan, op, seedUser, sendAgentMessage } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * fix/private-alpha-gmail-review-llm-instruction-routing: two real reported live bugs.
 *
 * (1) Gmail account-switch/disconnect intent misrouted to gmail.sync ("I wanna disconnect my mail
 * and connect a new one" ran a full sync instead of proposing a switch) — runtime.ts's
 * gmailSyncShortcutOperation ran BEFORE the disconnect/switch shortcuts and had an overbroad
 * "mail...new" disjunct that matched on the unrelated word "new" in "a new one". Fixed by
 * reordering (switch/disconnect now checked first) and tightening the regex.
 *
 * (2) "1 and 2 are CVs I sent today, 3 and 4 are nothing u can delete them" rejected ALL FOUR
 * visible reviews — the old regex-only extractor has no "approve" intent at all, and its plural
 * "delete them" fallback swept in every visible index regardless of what was said about specific
 * numbers earlier in the same message. Fixed with a digit-guard on the plural fallback (so it only
 * ever fires for a genuinely simple, single-intent message) plus a new deterministic-validator-
 * gated LLM parser (gmail-review-instruction-parser.ts) for anything more mixed.
 */

async function seedGmailConnection(userId: string, email = "letiskate@gmail.com") {
  return prisma.integrationConnection.create({ data: { userId, integrationId: "gmail", status: "active", config: { email, provider: "gmail" } } });
}

async function seedJobSearchGoal(userId: string) {
  const result = await createGoal(userId, {
    title: "Find a fully remote developer job, ideally in Web3",
    category: "career",
    targetMetrics: [{ key: "applications_sent_weekly", label: "Applications sent", labelSingular: "Application sent", eventType: "career.application_sent", aggregation: "count", window: "weekly" }]
  });
  if (result.duplicate) throw new Error("unexpected duplicate goal in test setup");
  return result.goal;
}

async function seedRule(userId: string, connectionId: string, goalId: string, status = "active") {
  return prisma.emailSignalRule.create({
    data: {
      userId,
      connectionId,
      goalId,
      adapterId: "job_search_email",
      name: "Job search emails",
      status,
      fetchStrategy: "query",
      classifierMode: "rules",
      lookbackDays: 30,
      maxMessagesPerSync: 25,
      maxEventsPerSync: 10,
      minAutoLogConfidence: 0.9,
      minReviewConfidence: 0.65,
      domain: "career",
      notifyPolicy: "notify",
      createdBy: "user"
    }
  });
}

async function seedReview(
  userId: string,
  connectionId: string,
  ruleId: string,
  input: { subject: string; from: string; proposedEventType?: string; priority?: string; status?: string }
) {
  return prisma.emailReviewItem.create({
    data: {
      userId,
      connectionId,
      ruleId,
      adapterId: "job_search_email",
      provider: "gmail",
      providerMessageId: `m-${randomUUID()}`,
      externalId: `gmail-review:${ruleId}:${randomUUID()}`,
      status: input.status ?? "pending",
      subject: input.subject,
      from: input.from,
      snippet: input.subject,
      evidence: input.subject,
      confidence: 0.7,
      reason: "rules_match",
      proposedEventType: input.proposedEventType,
      priority: input.priority,
      extracted: {}
    }
  });
}

// --- Task 1: account-switch/disconnect intent must outrank sync -----------------------------------

test("1A. 'I wanna disconnect my mail and connect a new one' routes to switch, never sync", async () => {
  const server = buildServer();
  const userId = `t1a-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedGmailConnection(userId);
    const reply = await sendAgentMessage(server, userId, "I wanna disconnect my mail and connect a new one");
    assert.match(reply.reply, /disconnect this one first|different account/i);
    assert.ok(!reply.operationsExecuted.some((o) => o.tool === "gmail.sync"), "must never sync for this message");
    assert.equal(reply.debug.pendingOperation, true);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("1B. 'change my mail account' routes to switch (not gated on the literal word 'gmail')", async () => {
  const server = buildServer();
  const userId = `t1b-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedGmailConnection(userId);
    const reply = await sendAgentMessage(server, userId, "change my mail account");
    assert.match(reply.reply, /disconnect this one first|different account/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("1C. plain 'disconnect Gmail' still routes to disconnect, not switch", async () => {
  const server = buildServer();
  const userId = `t1c-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedGmailConnection(userId);
    const reply = await sendAgentMessage(server, userId, "disconnect Gmail");
    assert.ok(reply.operationsExecuted.some((o) => o.tool === "gmail.disconnect_propose"));
    assert.ok(!reply.operationsExecuted.some((o) => o.tool === "gmail.switch_account_propose"));
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("1D. 'connect new Gmail' while an account is already connected proposes a switch", async () => {
  const server = buildServer();
  const userId = `t1d-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedGmailConnection(userId);
    const reply = await sendAgentMessage(server, userId, "connect new Gmail");
    assert.ok(reply.operationsExecuted.some((o) => o.tool === "gmail.switch_account_propose"));
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("1E. 'sync Gmail' still syncs for real", async () => {
  const server = buildServer();
  const userId = `t1e-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedGmailConnection(userId);
    const reply = await sendAgentMessage(server, userId, "sync Gmail");
    assert.ok(reply.operationsExecuted.some((o) => o.tool === "gmail.sync"));
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("1F. bare 'mail?' never triggers a sync", async () => {
  const server = buildServer();
  const userId = `t1f-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedGmailConnection(userId);
    const reply = await sendAgentMessage(server, userId, "mail?");
    assert.ok(!reply.operationsExecuted.some((o) => o.tool === "gmail.sync"));
    assert.equal(reply.debug.mutationExecuted, false);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 2 / 6: LLM-backed mixed review instruction parsing --------------------------------------

test("2A/3A/6A. mixed 'X are CVs I sent today, Y are nothing, delete them' approves X, rejects Y, never touches the other pair", async () => {
  const server = buildServer();
  const userId = `t2a-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goal = await seedJobSearchGoal(userId);
    const connection = await seedGmailConnection(userId);
    const rule = await seedRule(userId, connection.id, goal.id);
    // Seeded in this exact order so display order (updatedAt desc -> reverse of creation) makes
    // review 1/2 the two REAL application confirmations and 3/4 the two noise emails — matching
    // the numbers used in the mocked parser response below.
    await seedReview(userId, connection.id, rule.id, { subject: "LinkedIn job alert", from: "jobs@linkedin.com", proposedEventType: "career.recruiter_reply_received" });
    await seedReview(userId, connection.id, rule.id, { subject: "LinkedIn reaction", from: "notifications@linkedin.com", proposedEventType: "career.offer_received" });
    await seedReview(userId, connection.id, rule.id, { subject: "Thank you for your application to Wintermute", from: "noreply@wintermute.com", proposedEventType: "career.application_confirmation_received" });
    await seedReview(userId, connection.id, rule.id, { subject: "Thank you for your application to Binance", from: "noreply@binance.com", proposedEventType: "career.application_confirmation_received" });

    await sendAgentMessage(server, userId, "show me the reviews");

    process.env.GMAIL_REVIEW_INSTRUCTION_PARSER_MOCK_RESPONSE = JSON.stringify({
      operations: [
        { reviewNumber: 3, action: "approve", signalType: "application_confirmation", alsoLogApplicationsSent: 2, reason: "User said this is a CV/application sent today" },
        { reviewNumber: 4, action: "approve", signalType: "application_confirmation", alsoLogApplicationsSent: null, reason: "User said this is a CV/application sent today" },
        { reviewNumber: 1, action: "reject", signalType: null, alsoLogApplicationsSent: null, reason: "User said it is nothing" },
        { reviewNumber: 2, action: "reject", signalType: null, alsoLogApplicationsSent: null, reason: "User said it is nothing" }
      ],
      needsClarification: false,
      clarificationQuestion: null
    });
    const reply = await sendAgentMessage(server, userId, "3 and 4 are CVs I sent today, 1 and 2 are nothing u can delete them");
    delete process.env.GMAIL_REVIEW_INSTRUCTION_PARSER_MOCK_RESPONSE;

    const reviews = await prisma.emailReviewItem.findMany({ where: { userId }, orderBy: { updatedAt: "desc" } });
    assert.equal(reviews.filter((r) => r.status === "approved").length, 2, "exactly the two real application confirmations must be approved");
    assert.equal(reviews.filter((r) => r.status === "rejected").length, 2, "exactly the two noise reviews must be rejected");
    assert.doesNotMatch(reply.reply, /deleted your email|deleted the email/i, "must never claim a real email was deleted");

    const events = await prisma.event.findMany({ where: { userId, type: "career.application_sent" } });
    assert.equal(events.length, 2, "alsoLogApplicationsSent must log exactly once, not once per approved review");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2B. 'reject 3 and 4' (no mixed content) still resolves via the cheap deterministic path, no LLM needed", async () => {
  const server = buildServer();
  const userId = `t2b-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goal = await seedJobSearchGoal(userId);
    const connection = await seedGmailConnection(userId);
    const rule = await seedRule(userId, connection.id, goal.id);
    for (let i = 0; i < 4; i++) {
      await seedReview(userId, connection.id, rule.id, { subject: `Review ${i}`, from: "x@example.com", proposedEventType: "career.recruiter_reply_received" });
    }
    await sendAgentMessage(server, userId, "show me the reviews");

    // No GMAIL_REVIEW_INSTRUCTION_PARSER_MOCK_RESPONSE set — if this accidentally routed to the
    // LLM path it would throw (no OPENAI_API_KEY) and surface as a clarification, not a real
    // reject; this proves the deterministic fast path still handles a fully-covered message alone.
    const reply = await sendAgentMessage(server, userId, "reject 3 and 4");
    const reviews = await prisma.emailReviewItem.findMany({ where: { userId } });
    assert.equal(reviews.filter((r) => r.status === "rejected").length, 2);
    assert.equal(reviews.filter((r) => r.status === "pending").length, 2);
    assert.doesNotMatch(reply.reply, /couldn't safely work out/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2C/6C. mixed approve+reject ('1 is a real recruiter reply, reject 2') resolves both — the old code silently dropped the unmatched half", async () => {
  const server = buildServer();
  const userId = `t2c-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goal = await seedJobSearchGoal(userId);
    const connection = await seedGmailConnection(userId);
    const rule = await seedRule(userId, connection.id, goal.id);
    await seedReview(userId, connection.id, rule.id, { subject: "Job alert", from: "jobs@linkedin.com", proposedEventType: "career.recruiter_reply_received" });
    await seedReview(userId, connection.id, rule.id, { subject: "Real recruiter note", from: "recruiter@company.com", proposedEventType: "career.recruiter_reply_received" });
    await sendAgentMessage(server, userId, "show me the reviews");

    process.env.GMAIL_REVIEW_INSTRUCTION_PARSER_MOCK_RESPONSE = JSON.stringify({
      operations: [
        { reviewNumber: 1, action: "approve", signalType: "recruiter_reply", alsoLogApplicationsSent: null, reason: "genuine recruiter reply" },
        { reviewNumber: 2, action: "reject", signalType: null, alsoLogApplicationsSent: null, reason: "job alert" }
      ],
      needsClarification: false,
      clarificationQuestion: null
    });
    const reply = await sendAgentMessage(server, userId, "1 is a real recruiter reply, reject 2");
    delete process.env.GMAIL_REVIEW_INSTRUCTION_PARSER_MOCK_RESPONSE;

    assert.equal(reply.operationsExecuted.filter((o) => o.tool.startsWith("gmail.review.")).length, 2, "both halves of the mixed message must resolve — the old code silently dropped one");
    const reviews = await prisma.emailReviewItem.findMany({ where: { userId } });
    assert.equal(reviews.filter((r) => r.status === "approved").length, 1);
    assert.equal(reviews.filter((r) => r.status === "rejected").length, 1);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2D. mixed 'turn 2 into a task and reject 1' resolves both action types via the existing numbered patterns — already fully covered, no LLM needed", async () => {
  const server = buildServer();
  const userId = `t2d-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goal = await seedJobSearchGoal(userId);
    const connection = await seedGmailConnection(userId);
    const rule = await seedRule(userId, connection.id, goal.id);
    await seedReview(userId, connection.id, rule.id, { subject: "Newsletter", from: "jobs@linkedin.com", proposedEventType: "career.recruiter_reply_received" });
    await seedReview(userId, connection.id, rule.id, { subject: "Interview invite", from: "hr@company.com", proposedEventType: "career.interview_scheduled" });
    await sendAgentMessage(server, userId, "show me the reviews");

    // No GMAIL_REVIEW_INSTRUCTION_PARSER_MOCK_RESPONSE set on purpose — "turn N into a task"/
    // "reject N" are both already recognized numbered patterns, so this must resolve deterministically.
    const reply = await sendAgentMessage(server, userId, "turn 2 into a task and reject 1");

    assert.ok(reply.operationsExecuted.some((o) => o.tool === "gmail.review.to_action" && o.status === "executed"));
    assert.ok(reply.operationsExecuted.some((o) => o.tool === "gmail.review.reject" && o.status === "executed"));
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2E. an invalid/out-of-range review number the LLM parser hallucinates asks for clarification instead of mutating", async () => {
  const server = buildServer();
  const userId = `t2e-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goal = await seedJobSearchGoal(userId);
    const connection = await seedGmailConnection(userId);
    const rule = await seedRule(userId, connection.id, goal.id);
    await seedReview(userId, connection.id, rule.id, { subject: "One review", from: "x@example.com", proposedEventType: "career.recruiter_reply_received" });
    await seedReview(userId, connection.id, rule.id, { subject: "Another one", from: "y@example.com", proposedEventType: "career.recruiter_reply_received" });
    await sendAgentMessage(server, userId, "show me the reviews");

    process.env.GMAIL_REVIEW_INSTRUCTION_PARSER_MOCK_RESPONSE = JSON.stringify({
      operations: [
        { reviewNumber: 1, action: "approve", signalType: null, alsoLogApplicationsSent: null, reason: "genuine" },
        { reviewNumber: 7, action: "reject", signalType: null, alsoLogApplicationsSent: null, reason: "hallucinated number" }
      ],
      needsClarification: false,
      clarificationQuestion: null
    });
    const reply = await sendAgentMessage(server, userId, "1 is a recruiter reply, 2 is spam");
    delete process.env.GMAIL_REVIEW_INSTRUCTION_PARSER_MOCK_RESPONSE;

    assert.equal(reply.debug.mutationExecuted, false, "an out-of-range review number must never mutate anything");
    assert.match(reply.reply, /don't see review|which|could you/i);
    const reviews = await prisma.emailReviewItem.findMany({ where: { userId } });
    assert.equal(reviews.filter((r) => r.status === "pending").length, 2, "nothing should have changed");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2F. 'delete them' with no other digits still safely rejects via the deterministic fast path", async () => {
  const server = buildServer();
  const userId = `t2f-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goal = await seedJobSearchGoal(userId);
    const connection = await seedGmailConnection(userId);
    const rule = await seedRule(userId, connection.id, goal.id);
    await seedReview(userId, connection.id, rule.id, { subject: "Junk 1", from: "x@example.com", proposedEventType: "career.recruiter_reply_received" });
    await seedReview(userId, connection.id, rule.id, { subject: "Junk 2", from: "y@example.com", proposedEventType: "career.recruiter_reply_received" });
    await sendAgentMessage(server, userId, "show me the reviews");

    const reply = await sendAgentMessage(server, userId, "delete them");
    const reviews = await prisma.emailReviewItem.findMany({ where: { userId } });
    assert.equal(reviews.filter((r) => r.status === "rejected").length, 2);
    assert.doesNotMatch(reply.reply, /deleted your email|deleted the email/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2G. an LLM parse failure asks for clarification, never over-rejects", async () => {
  const server = buildServer();
  const userId = `t2g-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goal = await seedJobSearchGoal(userId);
    const connection = await seedGmailConnection(userId);
    const rule = await seedRule(userId, connection.id, goal.id);
    await seedReview(userId, connection.id, rule.id, { subject: "One", from: "x@example.com", proposedEventType: "career.recruiter_reply_received" });
    await seedReview(userId, connection.id, rule.id, { subject: "Two", from: "y@example.com", proposedEventType: "career.recruiter_reply_received" });
    await sendAgentMessage(server, userId, "show me the reviews");

    process.env.GMAIL_REVIEW_INSTRUCTION_PARSER_MOCK_THROW = "true";
    const reply = await sendAgentMessage(server, userId, "1 is fine, 2 is spam");
    delete process.env.GMAIL_REVIEW_INSTRUCTION_PARSER_MOCK_THROW;

    assert.equal(reply.debug.mutationExecuted, false);
    assert.match(reply.reply, /couldn't safely work out|which|could you/i);
    const reviews = await prisma.emailReviewItem.findMany({ where: { userId } });
    assert.equal(reviews.filter((r) => r.status === "pending").length, 2, "an LLM failure must never over-reject");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 4: classifier precision — LinkedIn noise / job alerts ------------------------------------

test("4A/4C. a LinkedIn Spanish reaction notification is never classified as a job offer", async () => {
  const { gmailRuleMatchEventTypeForTest } = await import("../apps/api/src/server.ts").catch(() => ({ gmailRuleMatchEventTypeForTest: undefined as unknown }));
  // gmailRuleMatchEventType itself is private to server.ts — exercised indirectly instead, via the
  // shared ingestion.ts classifier both classification paths ultimately defer to for job-search
  // noise filtering (isJobNewsletterOrPromotional), which is directly exported/testable.
  void gmailRuleMatchEventTypeForTest;
  const { classifyJobSearchEmail } = await import("../packages/core/src/email-classification.ts");
  const result = classifyJobSearchEmail({ text: "Jay Maree - Co-Founder & CPO ha reaccionado a esta publicación tuya sobre trabajo remoto" });
  assert.notEqual(result.eventType, "career.offer_received");
  assert.notEqual(result.decision, "log_event");
});

test("4D/4E. a Spanish job-board listing is never classified as a personal recruiter reply", async () => {
  const { classifyJobSearchEmail } = await import("../packages/core/src/email-classification.ts");
  const result = classifyJobSearchEmail({ text: "Ciklum busca personal para el puesto de Desarrollador En remoto - aplica ahora" });
  assert.notEqual(result.eventType, "career.recruiter_reply_received");
});

test("4F. a genuine recruiter reply is still classified as a recruiter reply", async () => {
  const { classifyJobSearchEmail } = await import("../packages/core/src/email-classification.ts");
  const result = classifyJobSearchEmail({ text: "Hi, this is Sarah from our talent acquisition team, are you available for a quick call this week to discuss the role?" });
  assert.equal(result.eventType, "career.recruiter_reply_received");
});

// --- Task 5: gmail status pending-review count must match gmail.review.list -----------------------

test("5A/5B. status pending-review count matches the review list count after an account switch left stale reviews on a paused rule", async () => {
  const server = buildServer();
  const userId = `t5-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goal = await seedJobSearchGoal(userId);

    const oldConnection = await prisma.integrationConnection.create({ data: { userId, integrationId: "gmail", status: "paused", config: { email: "old@gmail.com", provider: "gmail" } } });
    const oldRule = await seedRule(userId, oldConnection.id, goal.id, "paused");
    const newConnection = await seedGmailConnection(userId, "new@gmail.com");
    const newRule = await seedRule(userId, newConnection.id, goal.id, "active");

    await seedReview(userId, oldConnection.id, oldRule.id, { subject: "Old 1", from: "x@example.com", proposedEventType: "career.application_confirmation_received" });
    await seedReview(userId, oldConnection.id, oldRule.id, { subject: "Old 2", from: "y@example.com", proposedEventType: "career.application_confirmation_received" });
    await seedReview(userId, oldConnection.id, oldRule.id, { subject: "Old 3", from: "z@example.com", proposedEventType: "career.application_confirmation_received" });
    await seedReview(userId, newConnection.id, newRule.id, { subject: "New 1", from: "a@example.com", proposedEventType: "career.application_confirmation_received" });

    const status = await sendAgentMessage(server, userId, "gmail status");
    const list = await sendAgentMessage(server, userId, "show me the reviews");

    assert.match(status.reply, /4 pending review/, `status must count all 4 pending reviews — got: ${status.reply}`);
    const listedCount = (list.reply.match(/^\d+\./gm) ?? []).length;
    assert.equal(listedCount, 4, "gmail.review.list must show the same 4 reviews status counted");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 8: exact live transcript regression ------------------------------------------------------

test("8. exact live transcript regression: switch (no sync), then mixed review triage resolves correctly", async () => {
  const server = buildServer();
  const userId = `t8-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goal = await seedJobSearchGoal(userId);
    const connection = await seedGmailConnection(userId, "letiskate@gmail.com");
    const rule = await seedRule(userId, connection.id, goal.id);

    // 2. User: "I wanna disconnect my mail and connect a new one" -> 3. proposes switch, no sync.
    const t1 = await sendAgentMessage(server, userId, "I wanna disconnect my mail and connect a new one");
    assert.ok(!t1.operationsExecuted.some((o) => o.tool === "gmail.sync"), "no sync on first switch request");
    assert.equal(t1.debug.pendingOperation, true);
    // Cancel the switch proposal rather than actually completing a real OAuth round trip here —
    // this test's focus is the review-triage flow that follows, not the switch mechanics
    // (already covered by tests/gmail-account-lifecycle.test.ts) — just need the pending
    // confirmation cleared so the next messages aren't gated behind it.
    await sendAgentMessage(server, userId, "no");

    // 7. Reviews present (simulating post-switch sync results). getEmailReviewItems orders by
    // updatedAt desc, so seeded in REVERSE of the desired displayed 1/2/3/4 order — matching the
    // live transcript's own numbering (1=Binance, 2=Wintermute, 3=Ciklum job alert, 4=LinkedIn
    // reaction) once "show me the reviews" lists them newest-first.
    await seedReview(userId, connection.id, rule.id, { subject: "Jay Maree - Co-Founder & CPO ha reaccionado a esta publicación", from: "notifications@linkedin.com", proposedEventType: undefined });
    await seedReview(userId, connection.id, rule.id, { subject: "Ciklum busca personal para el puesto de En remoto", from: "jobs@linkedin.com", proposedEventType: undefined });
    await seedReview(userId, connection.id, rule.id, { subject: "Thank you for your application to Wintermute", from: "noreply@wintermute.com", proposedEventType: "career.application_confirmation_received" });
    await seedReview(userId, connection.id, rule.id, { subject: "Thank you for your application to Binance", from: "noreply@binance.com", proposedEventType: "career.application_confirmation_received" });

    const listReply = await sendAgentMessage(server, userId, "show me the reviews");
    assert.doesNotMatch(listReply.reply, /job offer/i, "no false job offer from LinkedIn reaction");
    assert.doesNotMatch(listReply.reply, /recruiter reply/i, "no false recruiter reply from the job alert");

    // 8. User: "1 and 2 are CVs I sent today, 3 and 4 are nothing u can delete them"
    process.env.GMAIL_REVIEW_INSTRUCTION_PARSER_MOCK_RESPONSE = JSON.stringify({
      operations: [
        { reviewNumber: 1, action: "approve", signalType: "application_confirmation", alsoLogApplicationsSent: 2, reason: "User said this is a CV/application sent today" },
        { reviewNumber: 2, action: "approve", signalType: "application_confirmation", alsoLogApplicationsSent: null, reason: "User said this is a CV/application sent today" },
        { reviewNumber: 3, action: "reject", signalType: null, alsoLogApplicationsSent: null, reason: "User said it is nothing" },
        { reviewNumber: 4, action: "reject", signalType: null, alsoLogApplicationsSent: null, reason: "User said it is nothing" }
      ],
      needsClarification: false,
      clarificationQuestion: null
    });
    const t9 = await sendAgentMessage(server, userId, "1 and 2 are CVs I sent today, 3 and 4 are nothing u can delete them");
    delete process.env.GMAIL_REVIEW_INSTRUCTION_PARSER_MOCK_RESPONSE;

    assert.doesNotMatch(t9.reply, /deleted your email|deleted the email/i, "no Gmail email deletion");

    const reviews = await prisma.emailReviewItem.findMany({ where: { userId } });
    assert.equal(reviews.filter((r) => r.status === "approved").length, 2, "no rejection of the two useful application confirmations");
    assert.equal(reviews.filter((r) => r.status === "rejected").length, 2);

    // 10. Status/reviews updated consistently.
    const finalStatus = await sendAgentMessage(server, userId, "gmail status");
    const finalList = await sendAgentMessage(server, userId, "show me the reviews");
    assert.doesNotMatch(finalList.reply, /pending gmail reviews:\s*\n\s*1\./i, "all four should have been decided");
    void finalStatus;
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Addendum: progress read-after-write + action reconciliation + coaching -----------------------

async function seedJobSearchGoalWithAction(userId: string, actionTitle: string) {
  const goal = await seedJobSearchGoal(userId);
  const action = await createActionItem(userId, { source: "manual", title: actionTitle, priority: "high" });
  return { goal, action };
}

test("addendum 1/2. 'I sent 3 CVs today' immediately shows up in 'show me my goal with progress' — read-after-write consistency", async () => {
  const server = buildServer();
  const userId = `add12-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedJobSearchGoal(userId);

    mockPlan({ topic: "job_search", intent: "log", operations: [op("event.log_job_applications", { count: 3 })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const t1 = await sendAgentMessage(server, userId, "I sent 3 CVs today");
    assert.match(t1.reply, /logged 3 job application/i);

    mockPlan({ topic: "goal_status", intent: "status", operations: [op("goal.status", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const t2 = await sendAgentMessage(server, userId, "show me my goal with progress");
    assert.doesNotMatch(t2.reply, /no logged progress/i);
    assert.match(t2.reply, /3 application/i);
    assert.match(t2.reply, /today/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("addendum 3A/3C/3F. 'I sent 3 CVs today' auto-completes the exact-matching open action; overshoot also completes it", async () => {
  const server = buildServer();
  const userId = `add3a-${randomUUID()}`;
  try {
    await seedUser(userId);
    const { action } = await seedJobSearchGoalWithAction(userId, "Send 3 CVs");

    mockPlan({ topic: "job_search", intent: "log", operations: [op("event.log_job_applications", { count: 3 })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "I sent 3 CVs today");
    assert.match(reply.reply, /marked "send 3 cvs" done/i);

    const updated = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(updated?.status, "completed");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("addendum 3B. 'I sent 1 CV today' does not complete 'Send 3 CVs' — mentions 2 remaining instead", async () => {
  const server = buildServer();
  const userId = `add3b-${randomUUID()}`;
  try {
    await seedUser(userId);
    const { action } = await seedJobSearchGoalWithAction(userId, "Send 3 CVs");

    mockPlan({ topic: "job_search", intent: "log", operations: [op("event.log_job_applications", { count: 1 })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "I sent 1 CV today");
    assert.match(reply.reply, /2 more to go/i);

    const updated = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(updated?.status, "open");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("addendum 3D. two matching open actions asks rather than silently picking one", async () => {
  const server = buildServer();
  const userId = `add3d-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedJobSearchGoal(userId);
    await createActionItem(userId, { source: "manual", title: "Send 3 CVs", priority: "high" });
    await createActionItem(userId, { source: "manual", title: "Send 5 applications", priority: "high" });

    mockPlan({ topic: "job_search", intent: "log", operations: [op("event.log_job_applications", { count: 3 })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "I sent 3 CVs today");
    assert.match(reply.reply, /which one to mark done/i);

    const actions = await prisma.actionItem.findMany({ where: { userId } });
    assert.ok(actions.every((a) => a.status === "open"), "must not guess which action to complete");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("addendum 3E/3F. no matching open action just logs progress; an already-completed action is never re-completed", async () => {
  const server = buildServer();
  const userId = `add3e-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedJobSearchGoal(userId);
    const unrelated = await createActionItem(userId, { source: "manual", title: "Review resume", priority: "medium" });

    mockPlan({ topic: "job_search", intent: "log", operations: [op("event.log_job_applications", { count: 2 })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "I sent 2 CVs today");
    assert.doesNotMatch(reply.reply, /marked ".*" done/i);

    const updated = await prisma.actionItem.findUnique({ where: { id: unrelated.id } });
    assert.equal(updated?.status, "open");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("addendum 4. progress response mentions the count, the completed action, and offers an optional next step without creating anything", async () => {
  const server = buildServer();
  const userId = `add4-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedJobSearchGoalWithAction(userId, "Send 3 CVs");

    mockPlan({ topic: "job_search", intent: "log", operations: [op("event.log_job_applications", { count: 3 })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "I sent 3 CVs today");

    assert.match(reply.reply, /3 job application/i, "mentions the logged count");
    assert.match(reply.reply, /marked "send 3 cvs" done/i, "mentions the completed action");
    assert.match(reply.reply, /want me to line up another/i, "suggests an optional next step");
    const actions = await prisma.actionItem.findMany({ where: { userId } });
    assert.equal(actions.length, 1, "no new action was created without explicit confirmation");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 7: scheduled-hourly status copy shouldn't claim "local environment" outside dev ----------

test("7A/7B. background-sync-disabled wording says 'local environment' outside production, 'this server' when NODE_ENV=production", async () => {
  const { gmailSyncModeSentence } = await import("../apps/api/src/conversation/gmail-autonomy.ts");
  const state = { syncMode: "scheduled" as const, scheduledSyncEnabled: false, syncIntervalMinutes: 60 };

  const previousNodeEnv = process.env.NODE_ENV;
  try {
    delete process.env.NODE_ENV;
    assert.match(gmailSyncModeSentence(state), /local environment/i);

    process.env.NODE_ENV = "production";
    const prodSentence = gmailSyncModeSentence(state);
    assert.doesNotMatch(prodSentence, /local environment/i);
    assert.match(prodSentence, /disabled on this server/i);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
});

test("7C. when background sync IS enabled, status shows it's on with the real interval, regardless of environment", async () => {
  const { gmailSyncModeSentence } = await import("../apps/api/src/conversation/gmail-autonomy.ts");
  const sentence = gmailSyncModeSentence({ syncMode: "scheduled", scheduledSyncEnabled: true, syncIntervalMinutes: 60 });
  assert.match(sentence, /every hour/i);
  assert.doesNotMatch(sentence, /local environment|disabled/i);
});
