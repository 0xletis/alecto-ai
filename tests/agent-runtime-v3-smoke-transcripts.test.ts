import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createGoal, createActionItem, createActionItemReminderLog } from "../packages/db/src/index.ts";
import {
  assertNoAvoidanceWhenOperationalCommand,
  assertNoDuplicateToolSummary,
  assertNoGenericAgentError,
  assertNoMutationWhenClarificationExpected,
  assertNoUnexpectedGmailSyncForStatus,
  buildServer,
  clearAgentRuntimeMocks,
  getAgentSession,
  logTranscriptStep,
  mockGuardrail,
  mockPlan,
  op,
  prisma,
  sendAgentMessage,
  seedUser,
  type MockPlan
} from "./helpers/agent-runtime-test-helpers.ts";

/**
 * V3 real-user transcript smoke suite — compact, multi-turn scenarios mirroring the exact
 * Telegram transcripts that surfaced four distinct real regressions across earlier hardening
 * passes: Gmail status questions triggering a real sync (scenario A), the goal-avoidance
 * guardrail hijacking plain operational commands (scenario B), plural Gmail-review references
 * ("keep both") failing to resolve (scenario C), a compound numbered-triage message losing
 * decisions or duplicating a reminder (scenario D), a bare "complete it" resolving to a stale
 * Gmail review instead of the just-reminded task (scenario E), and Spanish/Catalan phrasing
 * falling back to the wrong tool entirely (scenario F). Each test exercises the real
 * POST /agent/message path end to end; nothing here talks to handleAgentMessage directly.
 *
 * This suite adds no new product behavior — every scenario below is already covered by more
 * granular tests elsewhere (agent-runtime-gmail-autonomy-status-routing, agent-runtime-
 * guardrail-operational-priority, agent-runtime-gmail-review-plural-refs, agent-runtime-
 * multilingual-intents, agent-runtime-gmail-review-action-followups). Its purpose is to catch a
 * FUTURE regression across any of these at once, the way a real user's actual conversation would
 * surface it, using shared assertions (tests/helpers/agent-runtime-test-helpers.ts) instead of
 * each scenario re-deriving its own checks.
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
  overrides: { subject: string; snippet?: string; providerMessageId: string }
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
      snippet: overrides.snippet ?? overrides.subject,
      evidence: overrides.snippet ?? overrides.subject,
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

test("A. Gmail autonomy/status transcript: scheduling, confirming, then a status question never re-syncs", async () => {
  const server = buildServer();
  const userId = `smoke-a-${randomUUID()}`;

  try {
    const connectionId = await seedGmailUser(userId);

    const propose = await sendAgentMessage(server, userId, "check Gmail every hour");
    logTranscriptStep("A1", "check Gmail every hour", propose);
    assertNoGenericAgentError(propose);
    assert.deepEqual(propose.operationsPlanned.map((operation) => operation.tool), ["gmail.autonomy.propose_update"]);
    assert.equal(propose.debug.mutationExecuted, false);
    assert.ok(propose.debug.pendingOperation);

    const confirm = await sendAgentMessage(server, userId, "yes");
    logTranscriptStep("A2", "yes", confirm);
    assertNoGenericAgentError(confirm);
    assert.equal(confirm.debug.mutationExecuted, true);
    const connection = await prisma.integrationConnection.findUnique({ where: { id: connectionId } });
    const gmailAutonomy = (connection?.config as Record<string, unknown> | null)?.gmailAutonomy as Record<string, unknown> | undefined;
    assert.equal(gmailAutonomy?.syncMode, "scheduled", "scheduled sync must actually be enabled");
    assert.equal(gmailAutonomy?.syncIntervalMinutes, 60);

    const status = await sendAgentMessage(server, userId, "when do u check mail?");
    logTranscriptStep("A3", "when do u check mail?", status);
    assertNoGenericAgentError(status);
    assert.deepEqual(status.operationsPlanned.map((operation) => operation.tool), ["gmail.autonomy.status"]);
    assertNoUnexpectedGmailSyncForStatus(status, "A3");
    assert.equal(status.debug.mutationExecuted, false, "a status question is read-only");
    assert.match(status.reply, /every hour/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("B. Guardrail ordering transcript: an operational command bypasses avoidance, genuine avoidance still fires", async () => {
  const server = buildServer();
  const userId = `smoke-b-${randomUUID()}`;

  try {
    await seedGmailUser(userId);
    const goal = await createGoal(userId, { title: "Finish reading Meditations by Marcus Aurelius", category: "personal", priority: "high" });
    if (goal.duplicate) throw new Error("unexpected duplicate goal in test setup");

    // Worst-case guardrail mock: even if the classifier WOULD misfire on this operational
    // message, the deterministic domain shortcut must win before the guardrail is ever asked.
    mockGuardrail({ conflict: "soft_warn", goalId: goal.goal.id, pattern: "avoidance", clarifyingQuestion: null, reason: "test: simulates a misfiring classifier" });
    const gmail = await sendAgentMessage(server, userId, "check Gmail every hour");
    logTranscriptStep("B1", "check Gmail every hour", gmail);
    assertNoGenericAgentError(gmail);
    assertNoAvoidanceWhenOperationalCommand(gmail, "B1");
    assert.deepEqual(gmail.operationsPlanned.map((operation) => operation.tool), ["gmail.autonomy.propose_update"]);

    // Same mock still in place: genuine avoidance must still be allowed to reach and use it,
    // proving the fix only narrowed WHICH messages reach the guardrail, not what it decides.
    const tiktok = await sendAgentMessage(server, userId, "i been watching tiktok for 5h nonstop");
    logTranscriptStep("B2", "i been watching tiktok for 5h nonstop", tiktok);
    assert.match(tiktok.reply, /avoidance|pulling you away/i);
    assert.deepEqual(tiktok.operationsPlanned, [], "the guardrail intercepts before any tool is planned");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("C. Gmail reviews plural refs transcript: 'keep both in review for now' needs no clarification", async () => {
  const server = buildServer();
  const userId = `smoke-c-${randomUUID()}`;

  try {
    const connectionId = await seedGmailUser(userId);
    const rule = await prisma.emailSignalRule.create({ data: { userId, connectionId, adapterId: "custom_email_review", name: "GitHub security advisories", status: "active", createdBy: "user" } });
    const ssrf = await seedReview(userId, connectionId, rule.id, {
      subject: "[0xletis] A security advisory on next affects at least one of your repositories — SSRF",
      providerMessageId: "advisory-ssrf"
    });
    const dos = await seedReview(userId, connectionId, rule.id, {
      subject: "[0xletis] A security advisory on next affects at least one of your repositories — DoS",
      providerMessageId: "advisory-dos"
    });

    const list = await sendAgentMessage(server, userId, "show me email reviews");
    logTranscriptStep("C1", "show me email reviews", list);
    assertNoGenericAgentError(list);

    const keep = await sendAgentMessage(server, userId, "keep both in review for now");
    logTranscriptStep("C2", "keep both in review for now", keep);
    assertNoGenericAgentError(keep);
    assert.doesNotMatch(keep.reply, /which one did you mean|couldn't tell which/i);
    assertNoDuplicateToolSummary(keep, "C2");

    const ssrfAfter = await prisma.emailReviewItem.findUnique({ where: { id: ssrf.id } });
    const dosAfter = await prisma.emailReviewItem.findUnique({ where: { id: dos.id } });
    assert.equal(ssrfAfter?.status, "pending");
    assert.equal(dosAfter?.status, "pending");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("D. Multi-review triage transcript: 'ignore 1, turn 2 into a task ... delete 3 nothing important' resolves all three correctly, no duplicate reminder", async () => {
  mock.timers.enable({ apis: ["Date"], now: new Date("2026-08-21T10:00:00.000Z") });
  const server = buildServer();
  const userId = `smoke-d-${randomUUID()}`;

  try {
    const connectionId = await seedGmailUser(userId);
    const rule = await prisma.emailSignalRule.create({ data: { userId, connectionId, adapterId: "custom_email_review", name: "Mixed inbox", status: "active", createdBy: "user" } });
    await seedReview(userId, connectionId, rule.id, { subject: "Weekly digest — nothing relevant", providerMessageId: "irrelevant" });
    await seedReview(userId, connectionId, rule.id, { subject: "Security alert: new sign-in detected", providerMessageId: "security-alert" });
    await seedReview(userId, connectionId, rule.id, { subject: "Promo newsletter", providerMessageId: "newsletter" });

    const list = await sendAgentMessage(server, userId, "show me email reviews");
    logTranscriptStep("D1", "show me email reviews", list);
    const byIndex = await visibleReviewIdsByIndex(userId);

    const triage = await sendAgentMessage(
      server,
      userId,
      "ignore 1, turn 2 into a task 5 minutes from now and remind me at that time, delete 3 nothing important"
    );
    logTranscriptStep("D2", "ignore 1, turn 2 into a task ... delete 3 nothing important", triage);
    assertNoGenericAgentError(triage);
    assertNoDuplicateToolSummary(triage, "D2");
    assert.equal(triage.debug.mutationExecuted, true);

    const review1 = await prisma.emailReviewItem.findUnique({ where: { id: byIndex.get(1)! } });
    const review2 = await prisma.emailReviewItem.findUnique({ where: { id: byIndex.get(2)! } });
    const review3 = await prisma.emailReviewItem.findUnique({ where: { id: byIndex.get(3)! } });
    assert.equal(review1?.status, "rejected", "1 must be rejected");
    assert.equal(review2?.status, "approved", "2 must become a task");
    assert.ok(review2?.actionItemId);
    assert.equal(review3?.status, "rejected", "3 must be rejected");

    const task = await prisma.actionItem.findUniqueOrThrow({ where: { id: review2!.actionItemId! } });
    assert.ok(task.dueAt);
    assert.equal(task.dueAt!.getTime(), Date.now() + 5 * 60_000, "task 2 must be due exactly 5 minutes from now");

    // "remind me at that time" (reminderLeadMinutes: 0) means AT the due time, already covered by
    // the task's own due notification — a separate companion reminder ActionItem due at the exact
    // same instant would make the worker send two notifications for one moment.
    const reminderActions = await prisma.actionItem.count({ where: { userId, actionType: "reminder" } });
    assert.equal(reminderActions, 0, "no duplicate/separate reminder ActionItem may exist");

    const totalTasks = await prisma.actionItem.count({ where: { userId } });
    assert.equal(totalTasks, 1, "only review 2 becomes a task — 1 and 3 never do");
  } finally {
    mock.timers.reset();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("E. Reminder follow-up transcript: 'complete it' after a due notification resolves the reminded task, not a stale visible Gmail review", async () => {
  const server = buildServer();
  const userId = `smoke-e-${randomUUID()}`;

  try {
    const connectionId = await seedGmailUser(userId);
    const rule = await prisma.emailSignalRule.create({ data: { userId, connectionId, adapterId: "custom_email_review", name: "Newsletters", status: "active", createdBy: "user" } });
    await seedReview(userId, connectionId, rule.id, { subject: "Weekly digest", providerMessageId: "digest-1" });

    // A Gmail review is still the most recently visible session entity from this earlier turn —
    // exactly the stale-context shape the real regression happened in.
    const list = await sendAgentMessage(server, userId, "show me email reviews");
    logTranscriptStep("E1", "show me email reviews", list);

    const task = await createActionItem(userId, { source: "manual", title: "Follow up with recruiter" });
    await createActionItemReminderLog({ userId, actionItemId: task.id, reminderType: "due" });

    const complete = await sendAgentMessage(server, userId, "complete it");
    logTranscriptStep("E2", "complete it", complete);
    assertNoGenericAgentError(complete);
    assert.deepEqual(complete.operationsPlanned.map((operation) => operation.tool), ["action.complete"]);
    assert.doesNotMatch(complete.reply, /email review/i);

    const updatedTask = await prisma.actionItem.findUnique({ where: { id: task.id } });
    assert.equal(updatedTask?.status, "completed");
    const review = await prisma.emailReviewItem.findFirst({ where: { userId, providerMessageId: "digest-1" } });
    assert.equal(review?.status, "pending", "the visible Gmail review must be untouched");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("F. Multilingual transcript: Spanish autonomy scheduling, status, and mixed numbered triage all route correctly", async () => {
  const server = buildServer();
  const userId = `smoke-f-${randomUUID()}`;

  try {
    await seedGmailUser(userId);

    const schedule = await sendAgentMessage(server, userId, "revisa mi correo cada hora");
    logTranscriptStep("F1", "revisa mi correo cada hora", schedule);
    assertNoGenericAgentError(schedule);
    assert.deepEqual(schedule.operationsPlanned.map((operation) => operation.tool), ["gmail.autonomy.propose_update"]);
    assertNoUnexpectedGmailSyncForStatus(schedule, "F1");

    // Confirm the pending scheduling proposal from F1 — otherwise the pending-operation firewall
    // correctly blocks every later mutation in this same conversation, which is a real, separate
    // protection (never a bug), not something this multilingual-routing scenario is testing.
    await sendAgentMessage(server, userId, "yes");

    const status = await sendAgentMessage(server, userId, "cada cuánto miras mi email?");
    logTranscriptStep("F2", "cada cuánto miras mi email?", status);
    assertNoGenericAgentError(status);
    assert.deepEqual(status.operationsPlanned.map((operation) => operation.tool), ["gmail.autonomy.status"]);
    assertNoUnexpectedGmailSyncForStatus(status, "F2");

    const connectionId = await prisma.integrationConnection.findFirstOrThrow({ where: { userId, integrationId: "gmail" } }).then((c) => c.id);
    const rule = await prisma.emailSignalRule.create({ data: { userId, connectionId, adapterId: "custom_email_review", name: "Newsletters", status: "active", createdBy: "user" } });
    await seedReview(userId, connectionId, rule.id, { subject: "Weekly digest", providerMessageId: "m1" });
    await seedReview(userId, connectionId, rule.id, { subject: "Project update", providerMessageId: "m2" });
    await seedReview(userId, connectionId, rule.id, { subject: "Promo newsletter", providerMessageId: "m3" });

    const listPlan: MockPlan = { topic: "gmail_reviews", intent: "list_pending_reviews", operations: [op("gmail.review.list", { status: "pending" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" };
    mockPlan(listPlan);
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
    const triage = await sendAgentMessage(server, userId, "borra el 3 y convierte el 2 en tarea para mañana");
    logTranscriptStep("F3", "borra el 3 y convierte el 2 en tarea para mañana", triage);
    assertNoGenericAgentError(triage);
    assertNoDuplicateToolSummary(triage, "F3");

    const review3 = await prisma.emailReviewItem.findUnique({ where: { id: byIndex.get(3)! } });
    const review2 = await prisma.emailReviewItem.findUnique({ where: { id: byIndex.get(2)! } });
    assert.equal(review3?.status, "rejected");
    assert.equal(review2?.status, "approved");
    assert.ok(review2?.actionItemId);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("ambiguity guard: an unclear compound reference asks for clarification and mutates nothing", async () => {
  const server = buildServer();
  const userId = `smoke-ambiguous-${randomUUID()}`;

  try {
    const connectionId = await seedGmailUser(userId);
    const rule = await prisma.emailSignalRule.create({ data: { userId, connectionId, adapterId: "custom_email_review", name: "Newsletters", status: "active", createdBy: "user" } });
    await seedReview(userId, connectionId, rule.id, { subject: "Weekly digest", providerMessageId: "m1" });
    await seedReview(userId, connectionId, rule.id, { subject: "Project update", providerMessageId: "m2" });
    await sendAgentMessage(server, userId, "show me email reviews");

    mockPlan({
      topic: "gmail_reviews",
      intent: "unclear",
      operations: [{ tool: "clarification.ask", args: { question: "Which decision do you want — keep, ignore, or turn into a task?" }, rationale: null }],
      needsClarification: true,
      clarificationQuestion: "Which decision do you want — keep, ignore, or turn into a task?",
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "do something with the email");
    logTranscriptStep("ambiguous", "do something with the email", reply);
    assertNoGenericAgentError(reply);
    assertNoMutationWhenClarificationExpected(reply, "ambiguous compound reference");
    assert.match(reply.reply, /which decision/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
