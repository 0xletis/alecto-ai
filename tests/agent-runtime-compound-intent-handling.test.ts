import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import {
  assertCompoundReplyAccountsFor,
  assertNoDuplicateToolSummary,
  assertNoGenericAgentError,
  assertNoMutationWhenClarificationExpected,
  assertNoSilentPartialHandling,
  buildServer,
  clearAgentRuntimeMocks,
  getAgentSession,
  mockPlan,
  op,
  prisma,
  sendAgentMessage
} from "./helpers/agent-runtime-test-helpers.ts";

/**
 * V3 compound-intent hardening. Product principle under test (see the task that created this
 * file): a compound user message must never have part of it silently dropped. Alecto must either
 * (1) execute/propose every understood part, (2) execute the safe parts and explicitly say which
 * part still needs confirmation/clarification, or (3) ask clarification before mutating anything
 * if the compound request is genuinely ambiguous. It must never guess, and it must never respond
 * as though the whole request was handled when only part of it was.
 *
 * Scenario E below caught a real, previously-undetected gap: "show me email reviews and when do
 * you check Gmail?" was claimed entirely by the single-op gmail.review.list shortcut (checked
 * before gmail.autonomy.status in the cascade), silently dropping the status half. Fixed with
 * gmailReviewListAndAutonomyStatusCompoundShortcutOperations (apps/api/src/agent-runtime/
 * runtime.ts), mirroring the existing gmailAutonomyCompoundShortcutOperations pattern. Every
 * other scenario here was already correctly handled by prior hardening passes (the deterministic
 * multi-entry Gmail-review extractor and reconciler, and composeReply's merged summary lines) —
 * these tests lock that behavior in against future regressions.
 */

async function seedGmailUser(userId: string): Promise<string> {
  await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
  const connection = await prisma.integrationConnection.create({ data: { userId, integrationId: "gmail", status: "active", config: {} } });
  return connection.id;
}

async function seedReview(userId: string, connectionId: string, ruleId: string, subject: string, providerMessageId: string) {
  return prisma.emailReviewItem.create({
    data: {
      userId,
      connectionId,
      ruleId,
      adapterId: "custom_email_review",
      provider: "gmail",
      providerMessageId,
      externalId: `gmail-review:${ruleId}:${providerMessageId}`,
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

test("A. review + Gmail schedule compound: 'delete it nothing important, and can u check email sync every 1h?' handles both, no silent drop", async () => {
  const server = buildServer();
  const userId = `compound-a-${randomUUID()}`;

  try {
    const connectionId = await seedGmailUser(userId);
    const rule = await prisma.emailSignalRule.create({ data: { userId, connectionId, adapterId: "custom_email_review", name: "Meetings", status: "active", createdBy: "user" } });
    const review = await seedReview(userId, connectionId, rule.id, "Standup tomorrow", "standup-1");

    await sendAgentMessage(server, userId, "show me the reviews");

    const reply = await sendAgentMessage(server, userId, "delete it nothing important, and can u check email sync every 1h?");
    assertNoGenericAgentError(reply);
    assertNoDuplicateToolSummary(reply, "A");
    assertCompoundReplyAccountsFor(reply, [/ignored review|rejected/i, /every hour/i, /yes to confirm or cancel/i], "A");
    assertNoSilentPartialHandling(reply, 2, "A");

    const rejected = await prisma.emailReviewItem.findUnique({ where: { id: review.id } });
    assert.equal(rejected?.status, "rejected");
    assert.ok(reply.debug.pendingOperation, "the schedule proposal must still be open, pending 'yes'");

    const confirm = await sendAgentMessage(server, userId, "yes");
    assertNoGenericAgentError(confirm);
    assert.equal(confirm.debug.mutationExecuted, true);
    const connection = await prisma.integrationConnection.findUnique({ where: { id: connectionId } });
    const gmailAutonomy = (connection?.config as Record<string, unknown> | null)?.gmailAutonomy as Record<string, unknown> | undefined;
    assert.equal(gmailAutonomy?.syncMode, "scheduled");
    assert.equal(gmailAutonomy?.syncIntervalMinutes, 60);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("B. multi-review complete accounting: every explicit ref is decided correctly, response names all three categories", async () => {
  const server = buildServer();
  const userId = `compound-b-${randomUUID()}`;

  mock.timers.enable({ apis: ["Date"], now: new Date("2026-08-21T12:00:00.000Z") });
  try {
    const connectionId = await seedGmailUser(userId);
    const rule = await prisma.emailSignalRule.create({ data: { userId, connectionId, adapterId: "custom_email_review", name: "Mixed inbox", status: "active", createdBy: "user" } });
    for (let i = 1; i <= 6; i++) {
      await seedReview(userId, connectionId, rule.id, `Review ${i}`, `m${i}`);
    }

    await sendAgentMessage(server, userId, "show me the reviews");
    const byIndex = await visibleReviewIdsByIndex(userId);

    const reply = await sendAgentMessage(server, userId, "ignore 1, turn 2 and 3 into tasks 5 minutes from now, ignore 5 too, and keep 4 and 6 in review for later");
    assertNoGenericAgentError(reply);
    assertNoDuplicateToolSummary(reply, "B");
    assertNoSilentPartialHandling(reply, 6, "B");
    assertCompoundReplyAccountsFor(reply, [/1/, /created task/i, /kept review/i], "B");

    for (const index of [1, 5]) {
      const review = await prisma.emailReviewItem.findUnique({ where: { id: byIndex.get(index)! } });
      assert.equal(review?.status, "rejected", `review ${index} must be rejected`);
      assert.equal(review?.actionItemId, null, `review ${index} must never get a task`);
    }
    for (const index of [2, 3]) {
      const review = await prisma.emailReviewItem.findUnique({ where: { id: byIndex.get(index)! } });
      assert.equal(review?.status, "approved", `review ${index} must become a task`);
      assert.ok(review?.actionItemId);
      const task = await prisma.actionItem.findUniqueOrThrow({ where: { id: review!.actionItemId! } });
      assert.equal(task.dueAt!.getTime(), Date.now() + 5 * 60_000, `review ${index}'s task must be due in exactly 5 minutes`);
    }
    for (const index of [4, 6]) {
      const review = await prisma.emailReviewItem.findUnique({ where: { id: byIndex.get(index)! } });
      assert.equal(review?.status, "pending", `review ${index} must remain pending, never rejected`);
    }

    const totalTasks = await prisma.actionItem.count({ where: { userId } });
    assert.equal(totalTasks, 2, "only reviews 2 and 3 may become tasks");
  } finally {
    mock.timers.reset();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("C. ambiguous compound asks clarification before mutating anything", async () => {
  const server = buildServer();
  const userId = `compound-c-${randomUUID()}`;

  try {
    const connectionId = await seedGmailUser(userId);
    const rule = await prisma.emailSignalRule.create({ data: { userId, connectionId, adapterId: "custom_email_review", name: "Mixed inbox", status: "active", createdBy: "user" } });
    const r1 = await seedReview(userId, connectionId, rule.id, "Weekly digest", "m1");
    const r2 = await seedReview(userId, connectionId, rule.id, "Project update", "m2");
    await sendAgentMessage(server, userId, "show me the reviews");

    mockPlan({
      topic: "gmail_reviews",
      intent: "unclear_compound",
      operations: [
        { tool: "clarification.ask", args: { question: "I can do that, but I need you to clarify which reviews to turn into tasks." }, rationale: null }
      ],
      needsClarification: true,
      clarificationQuestion: "I can do that, but I need you to clarify which reviews to turn into tasks.",
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "handle these and remind me later");
    assertNoGenericAgentError(reply);
    assertNoMutationWhenClarificationExpected(reply, "C");
    assert.match(reply.reply, /clarify|which/i);

    const review1 = await prisma.emailReviewItem.findUnique({ where: { id: r1.id } });
    const review2 = await prisma.emailReviewItem.findUnique({ where: { id: r2.id } });
    assert.equal(review1?.status, "pending");
    assert.equal(review2?.status, "pending");
    const actions = await prisma.actionItem.count({ where: { userId } });
    assert.equal(actions, 0, "no task/reminder may be created for an ambiguous compound request");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("D. partial planner output for a compound request is corrected, not silently accepted", async () => {
  const server = buildServer();
  const userId = `compound-d-${randomUUID()}`;

  try {
    const connectionId = await seedGmailUser(userId);
    const rule = await prisma.emailSignalRule.create({ data: { userId, connectionId, adapterId: "custom_email_review", name: "Mixed inbox", status: "active", createdBy: "user" } });
    await seedReview(userId, connectionId, rule.id, "Weekly digest", "m1");
    await seedReview(userId, connectionId, rule.id, "Project update", "m2");
    await sendAgentMessage(server, userId, "show me the reviews");
    const byIndex = await visibleReviewIdsByIndex(userId);

    // Bad plan: only reject(1), silently missing the explicit "turn 2 into a task" half.
    mockPlan({
      topic: "gmail_reviews",
      intent: "bad_plan_partial",
      operations: [op("gmail.review.reject", { index: 1 })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: "I'll ignore review 1."
    });
    const reply = await sendAgentMessage(server, userId, "ignore 1 and turn 2 into a task");
    assertNoGenericAgentError(reply);
    assertNoSilentPartialHandling(reply, 2, "D");

    const review1 = await prisma.emailReviewItem.findUnique({ where: { id: byIndex.get(1)! } });
    const review2 = await prisma.emailReviewItem.findUnique({ where: { id: byIndex.get(2)! } });
    assert.equal(review1?.status, "rejected");
    assert.equal(review2?.status, "approved", "the missing task must be added by the reconciler, not silently dropped");
    assert.ok(review2?.actionItemId);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("E. compound with read-only status: 'show me email reviews and when do you check Gmail?' answers both, never syncs", async () => {
  const server = buildServer();
  const userId = `compound-e-${randomUUID()}`;

  try {
    const connectionId = await seedGmailUser(userId);
    const rule = await prisma.emailSignalRule.create({ data: { userId, connectionId, adapterId: "custom_email_review", name: "Newsletters", status: "active", createdBy: "user" } });
    await seedReview(userId, connectionId, rule.id, "Weekly digest", "m1");

    const reply = await sendAgentMessage(server, userId, "show me email reviews and when do you check Gmail?");
    assertNoGenericAgentError(reply);
    assertNoDuplicateToolSummary(reply, "E");
    assertNoSilentPartialHandling(reply, 2, "E");
    assertCompoundReplyAccountsFor(reply, [/pending gmail reviews?/i, /weekly digest/i, /alerts are/i], "E");

    const tools = reply.operationsPlanned.map((operation) => operation.tool);
    assert.deepEqual(tools.sort(), ["gmail.autonomy.status", "gmail.review.list"]);
    assert.ok(!tools.includes("gmail.sync"), "must never trigger a real sync for a status question");
    assert.equal(reply.debug.mutationExecuted, false);
    assert.doesNotMatch(reply.reply, /I didn't find anything to act on|I'm having trouble reasoning/i, "must not be a generic fallback");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
