import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createActionItem, createActionItemReminderLog } from "../packages/db/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, getAgentSession, mockPlan, op, prisma, sendAgentMessage, seedUser, type MockPlan } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * V3 intent-planner hardening — multilingual (English/Spanish/Catalan) intent tests through the
 * real POST /agent/message path. Numbered Gmail-review triage (A/B) mocks the planner's response
 * — indexes are language-agnostic, so these prove the deterministic validator/reconciler
 * downstream of the planner handles a correctly-understood Spanish/Catalan plan exactly like an
 * English one, never mixing up which numbered item got which decision. Gmail autonomy scheduling/
 * status (C/D) and action completion (E) route through Alecto's own deterministic shortcuts
 * (apps/api/src/agent-runtime/runtime.ts), widened this task to recognize "correo"/"correu",
 * "cada hora"/"cada cuánto"/"cada quant", and "hecho"/"fet" alongside their English equivalents —
 * no mockPlan needed for those, proving the real shortcut cascade (not just a simulated planner)
 * understands them.
 */

async function seedGmailUser(userId: string): Promise<string> {
  await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
  const connection = await prisma.integrationConnection.create({ data: { userId, integrationId: "gmail", status: "active", config: {} } });
  return connection.id;
}

async function seedThreeReviews(userId: string): Promise<string> {
  const connectionId = await seedGmailUser(userId);
  const rule = await prisma.emailSignalRule.create({ data: { userId, connectionId, adapterId: "custom_email_review", name: "Newsletters", status: "active", createdBy: "user" } });
  for (const [subject, providerMessageId] of [
    ["Weekly digest", "m1"],
    ["Project update", "m2"],
    ["Promo newsletter", "m3"]
  ] as const) {
    await prisma.emailReviewItem.create({
      data: {
        userId,
        connectionId,
        ruleId: rule.id,
        adapterId: "custom_email_review",
        provider: "gmail",
        providerMessageId,
        externalId: `gmail-review:${rule.id}:${providerMessageId}`,
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

test("A. Spanish review triage: 'borra el 3 y convierte el 2 en tarea para mañana' rejects 3, converts 2 to a task due tomorrow, nothing for 3", async () => {
  const server = buildServer();
  const userId = `multilingual-a-${randomUUID()}`;

  try {
    await seedThreeReviews(userId);
    mockPlan(gmailReviewListPlan());
    await sendAgentMessage(server, userId, "show pending email reviews");
    const byIndex = await visibleReviewIdsByIndex(userId);

    mockPlan({
      topic: "gmail_reviews",
      intent: "spanish_mixed_triage",
      operations: [op("gmail.review.reject", { index: 3 }), op("gmail.review.to_action", { index: 2, dueText: "mañana" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "borra el 3 y convierte el 2 en tarea para mañana");

    assert.equal(reply.debug.mutationExecuted, true);
    const review3 = await prisma.emailReviewItem.findUnique({ where: { id: byIndex.get(3)! } });
    const review2 = await prisma.emailReviewItem.findUnique({ where: { id: byIndex.get(2)! } });
    assert.equal(review3?.status, "rejected");
    assert.equal(review2?.status, "approved");
    assert.ok(review2?.actionItemId);
    assert.equal(review3?.actionItemId, null, "review 3 must never also get a task");

    const tasks = await prisma.actionItem.count({ where: { userId, status: "open" } });
    assert.equal(tasks, 1, "only review 2 becomes a task");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("B. Catalan review triage: 'descarta el 3 i fes una tasca del 2 per demà al matí' rejects 3, converts 2 to a task due tomorrow morning", async () => {
  const server = buildServer();
  const userId = `multilingual-b-${randomUUID()}`;

  try {
    await seedThreeReviews(userId);
    mockPlan(gmailReviewListPlan());
    await sendAgentMessage(server, userId, "show pending email reviews");
    const byIndex = await visibleReviewIdsByIndex(userId);

    mockPlan({
      topic: "gmail_reviews",
      intent: "catalan_mixed_triage",
      operations: [op("gmail.review.reject", { index: 3 }), op("gmail.review.to_action", { index: 2, dueText: "demà al matí" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "descarta el 3 i fes una tasca del 2 per demà al matí");

    assert.equal(reply.debug.mutationExecuted, true);
    const review3 = await prisma.emailReviewItem.findUnique({ where: { id: byIndex.get(3)! } });
    const review2 = await prisma.emailReviewItem.findUnique({ where: { id: byIndex.get(2)! } });
    assert.equal(review3?.status, "rejected");
    assert.equal(review2?.status, "approved");
    assert.ok(review2?.actionItemId);

    const task = await prisma.actionItem.findFirst({ where: { userId, status: "open" } });
    assert.ok(task?.dueAt, "the timing phrase must have parsed to a real due date");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("C. Spanish Gmail autonomy: 'revisa mi correo cada hora' proposes scheduled sync at 60 minutes, not sync, not a rule pause", async () => {
  const server = buildServer();
  const userId = `multilingual-c-${randomUUID()}`;

  try {
    const connectionId = await seedGmailUser(userId);
    await prisma.emailSignalRule.create({ data: { userId, connectionId, adapterId: "custom_email_review", name: "Work action emails", status: "active", createdBy: "user" } });

    const reply = await sendAgentMessage(server, userId, "revisa mi correo cada hora");

    assert.deepEqual(reply.operationsPlanned.map((operation) => operation.tool), ["gmail.autonomy.propose_update"]);
    assert.match(reply.reply, /about to check gmail every hour/i);
    assert.doesNotMatch(reply.reply, /work action emails/i);
    assert.equal(reply.debug.mutationExecuted, false);

    const rule = await prisma.emailSignalRule.findFirst({ where: { userId, name: "Work action emails" } });
    assert.equal(rule?.status, "active");

    await sendAgentMessage(server, userId, "yes");
    const updated = await prisma.integrationConnection.findUnique({ where: { id: connectionId } });
    const gmailAutonomy = (updated?.config as Record<string, unknown> | null)?.gmailAutonomy as Record<string, unknown> | undefined;
    assert.equal(gmailAutonomy?.syncMode, "scheduled");
    assert.equal(gmailAutonomy?.syncIntervalMinutes, 60);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("D. Spanish/Catalan Gmail status: 'cada cuánto miras mi email?' and 'cada quant mires el meu email?' route to gmail.autonomy.status, not sync", async () => {
  const server = buildServer();
  const userId = `multilingual-d-${randomUUID()}`;

  try {
    await seedGmailUser(userId);

    const replyEs = await sendAgentMessage(server, userId, "cada cuánto miras mi email?");
    assert.deepEqual(replyEs.operationsPlanned.map((operation) => operation.tool), ["gmail.autonomy.status"]);
    assert.equal(replyEs.debug.mutationExecuted, false);

    const replyCa = await sendAgentMessage(server, userId, "cada quant mires el meu email?");
    assert.deepEqual(replyCa.operationsPlanned.map((operation) => operation.tool), ["gmail.autonomy.status"]);
    assert.equal(replyCa.debug.mutationExecuted, false);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("E. Spanish/Catalan action completion: 'hecho' and 'ja està fet' complete the latest visible/reminded action, not a Gmail review", async () => {
  const server = buildServer();

  for (const [label, phrase] of [
    ["es", "hecho"],
    ["ca", "ja està fet"]
  ] as const) {
    const userId = `multilingual-e-${label}-${randomUUID()}`;
    try {
      await seedUser(userId);
      const task = await createActionItem(userId, { source: "manual", title: "Follow up with recruiter" });
      await createActionItemReminderLog({ userId, actionItemId: task.id, reminderType: "due" });

      const reply = await sendAgentMessage(server, userId, phrase);

      assert.deepEqual(reply.operationsPlanned.map((operation) => operation.tool), ["action.complete"], phrase);
      assert.doesNotMatch(reply.reply, /email review/i, phrase);

      const updated = await prisma.actionItem.findUnique({ where: { id: task.id } });
      assert.equal(updated?.status, "completed", phrase);
    } finally {
      clearAgentRuntimeMocks();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  }

  await server.close();
});
