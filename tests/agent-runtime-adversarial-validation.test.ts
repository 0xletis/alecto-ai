import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { buildServer, clearAgentRuntimeMocks, getAgentSession, mockPlan, op, prisma, sendAgentMessage, type MockPlan } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * V3 intent-planner hardening — adversarial validator/reconciler tests. These force a WRONG
 * planner output (mockPlan) for a message whose real, explicit intent is deterministically
 * extractable from the raw text itself (apps/api/src/agent-runtime/runtime.ts's
 * buildExplicitGmailReviewIntentPlan / reconcileExplicitGmailReviewIntentOperations), and assert
 * that the deterministic layer wins regardless — the target architecture's core promise:
 * "Deterministic validators/reconcilers enforce explicit user constraints before mutation," so a
 * planner mistake (or, in production, an adversarial/malformed LLM response) can never silently
 * mutate a review the user did not actually ask to change. reconcileExplicitGmailReviewIntentOperations
 * replaces every gmail.review.* operation the planner proposed with the deterministic plan built
 * from the message itself; when the deterministic plan has nothing for a given index, that index's
 * planner-suggested operation is simply dropped, never trusted as-is.
 */

async function seedGmailUser(userId: string): Promise<string> {
  await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
  const connection = await prisma.integrationConnection.create({ data: { userId, integrationId: "gmail", status: "active", config: {} } });
  return connection.id;
}

async function seedReviews(userId: string, subjects: string[]): Promise<string> {
  const connectionId = await seedGmailUser(userId);
  const rule = await prisma.emailSignalRule.create({ data: { userId, connectionId, adapterId: "custom_email_review", name: "Newsletters", status: "active", createdBy: "user" } });
  for (const [i, subject] of subjects.entries()) {
    await prisma.emailReviewItem.create({
      data: {
        userId,
        connectionId,
        ruleId: rule.id,
        adapterId: "custom_email_review",
        provider: "gmail",
        providerMessageId: `m${i + 1}`,
        externalId: `gmail-review:${rule.id}:m${i + 1}`,
        subject,
        snippet: subject,
        evidence: subject,
        confidence: 0.8,
        reason: "custom_rule_match",
        extracted: {},
        status: "pending"
      }
    });
  }
  return connectionId;
}

function gmailReviewListPlan(): MockPlan {
  return { topic: "gmail_reviews", intent: "list_pending_reviews", operations: [op("gmail.review.list", { status: "pending" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" };
}

async function visibleReviewIdsByIndex(userId: string): Promise<Map<number, string>> {
  const row = await getAgentSession(userId);
  const entities = (row?.visibleEntities as Array<{ type: string; id: string; index?: number }> | null) ?? [];
  const map = new Map<number, string>();
  for (const entity of entities) {
    if (entity.type === "gmail_review" && typeof entity.index === "number") {
      map.set(entity.index, entity.id);
    }
  }
  return map;
}

test("A. 'ignore 1, turn 2 into task' — a bad planner that emits gmail.review.to_action for BOTH 1 and 2 is overridden: only 2 becomes a task, 1 is rejected", async () => {
  const server = buildServer();
  const userId = `adversarial-a-${randomUUID()}`;

  try {
    await seedReviews(userId, ["Weekly digest", "Project update"]);
    mockPlan(gmailReviewListPlan());
    await sendAgentMessage(server, userId, "show pending email reviews");
    const byIndex = await visibleReviewIdsByIndex(userId);

    // The bad plan a real LLM mistake (or an adversarial response) could produce: both indexes
    // sent to gmail.review.to_action, ignoring that the user explicitly said "ignore 1".
    mockPlan({
      topic: "gmail_reviews",
      intent: "bad_plan_both_to_action",
      operations: [op("gmail.review.to_action", { index: 1 }), op("gmail.review.to_action", { index: 2 })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: "I'll turn both into tasks."
    });
    const reply = await sendAgentMessage(server, userId, "ignore 1, turn 2 into task");

    assert.equal(reply.debug.mutationExecuted, true);
    const review1 = await prisma.emailReviewItem.findUnique({ where: { id: byIndex.get(1)! } });
    const review2 = await prisma.emailReviewItem.findUnique({ where: { id: byIndex.get(2)! } });
    assert.equal(review1?.status, "rejected", "review 1 must be rejected, never turned into a task");
    assert.equal(review1?.actionItemId, null);
    assert.equal(review2?.status, "approved");
    assert.ok(review2?.actionItemId);

    const tasks = await prisma.actionItem.count({ where: { userId, status: "open" } });
    assert.equal(tasks, 1, "only review 2 may become a task, despite the bad plan asking for both");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("B. 'keep 3 in review' — a bad planner that emits gmail.review.reject for 3 is overridden: review 3 stays pending, never rejected", async () => {
  const server = buildServer();
  const userId = `adversarial-b-${randomUUID()}`;

  try {
    await seedReviews(userId, ["Weekly digest", "Project update", "Promo newsletter"]);
    mockPlan(gmailReviewListPlan());
    await sendAgentMessage(server, userId, "show pending email reviews");
    const byIndex = await visibleReviewIdsByIndex(userId);

    // The bad plan: the user said "keep," but the planner mistakenly plans a reject.
    mockPlan({
      topic: "gmail_reviews",
      intent: "bad_plan_wrong_decision",
      operations: [op("gmail.review.reject", { index: 3 })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: "I'll reject review 3."
    });
    const reply = await sendAgentMessage(server, userId, "keep 3 in review");

    const review3 = await prisma.emailReviewItem.findUnique({ where: { id: byIndex.get(3)! } });
    assert.equal(review3?.status, "pending", "review 3 must remain pending — the bad reject must never apply");
    assert.doesNotMatch(reply.reply, /reject/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("C. 'delete 1 and keep 2' — a bad planner that rejects BOTH is overridden: 1 is rejected, 2's unconfirmed reject is dropped and stays pending", async () => {
  const server = buildServer();
  const userId = `adversarial-c-${randomUUID()}`;

  try {
    await seedReviews(userId, ["Weekly digest", "Project update"]);
    mockPlan(gmailReviewListPlan());
    await sendAgentMessage(server, userId, "show pending email reviews");
    const byIndex = await visibleReviewIdsByIndex(userId);

    // The bad plan: the user said "keep 2," but the planner mistakenly rejects both.
    mockPlan({
      topic: "gmail_reviews",
      intent: "bad_plan_reject_both",
      operations: [op("gmail.review.reject", { index: 1 }), op("gmail.review.reject", { index: 2 })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: "I'll reject both."
    });
    const reply = await sendAgentMessage(server, userId, "delete 1 and keep 2");

    assert.equal(reply.debug.mutationExecuted, true);
    const review1 = await prisma.emailReviewItem.findUnique({ where: { id: byIndex.get(1)! } });
    const review2 = await prisma.emailReviewItem.findUnique({ where: { id: byIndex.get(2)! } });
    assert.equal(review1?.status, "rejected", "review 1's explicit delete must still go through");
    assert.equal(review2?.status, "pending", "review 2's unconfirmed reject must be dropped, not applied");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
