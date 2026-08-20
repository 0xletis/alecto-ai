import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
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
  overrides: { subject?: string; from?: string; snippet?: string; providerMessageId: string }
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
      status: "pending"
    }
  });
}

function gmailReviewListPlan(): MockPlan {
  return { topic: "gmail_reviews", intent: "list_pending_reviews", operations: [op("gmail.review.list", { status: "pending" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" };
}

function gmailReviewToActionPlan(args: Record<string, unknown>): MockPlan {
  return { topic: "gmail_reviews", intent: "convert_review_to_action", operations: [op("gmail.review.to_action", args)], needsClarification: false, clarificationQuestion: null, replyDraft: "" };
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

    assert.match(reply.reply, /pending gmail reviews:/i);
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
    assert.match(reply.reply, /your bill is ready/i);
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

    assert.match(reply.reply, /turned the email review into task/i);
    assert.equal(reply.debug.mutationExecuted, true);

    const recruiterAfter = await prisma.emailReviewItem.findUnique({ where: { id: recruiterReview.id } });
    assert.equal(recruiterAfter?.status, "approved");
    assert.ok(recruiterAfter?.actionItemId);

    const endesaAfter = await prisma.emailReviewItem.findUnique({ where: { id: endesaReview.id } });
    assert.equal(endesaAfter?.status, "pending", "only the referenced review may change");
  } finally {
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

test("a direct reviewId is still honored as-is (already-resolved internal case)", async () => {
  const server = buildServer();
  const userId = `gmail-review-direct-id-${randomUUID()}`;

  try {
    const connectionId = await seedGmailUser(userId);
    const rule = await prisma.emailSignalRule.create({ data: { userId, connectionId, adapterId: "custom_email_review", name: "Recruiter replies", status: "active", createdBy: "user" } });
    const review = await seedReview(userId, connectionId, rule.id, { subject: "Recruiter reply from Example Labs", providerMessageId: "m1" });

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
