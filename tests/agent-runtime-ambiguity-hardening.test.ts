import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createActionItem, createActionItemReminderLog } from "../packages/db/src/index.ts";
import {
  assertClarificationResponse,
  assertEmailReviewsRemainPending,
  assertNoActionItemsCreated,
  assertNoGenericAgentError,
  assertNoMutationWhenClarificationExpected,
  buildServer,
  clearAgentRuntimeMocks,
  mockPlan,
  op,
  prisma,
  sendAgentMessage,
  seedUser
} from "./helpers/agent-runtime-test-helpers.ts";

/**
 * V3 ambiguity-hardening — "ambiguity + mutation = clarification first." A vague instruction
 * ("handle it," "take care of them," "sort these out," "clean this up") with Gmail reviews
 * visible has no specific-enough intent for any tool to safely resolve; left alone, it fell
 * through every deterministic shortcut straight to the real planner, which had no reliable way to
 * avoid guessing a destructive operation. Fixed with gmailReviewVagueMutationClarification
 * (apps/api/src/agent-runtime/runtime.ts), checked LAST among the Gmail-review shortcuts so every
 * more specific one (explicit ignore/keep/task, plural "keep them", numbered refs) still gets
 * first chance to resolve the message on its own.
 *
 * A second, independent bug found in the same pass: resolveMostRecentlyNotifiedOrVisibleActionId
 * used `.find()` to silently pick the FIRST visible action whenever there was no recent worker
 * reminder to disambiguate — meaning "complete it"/"done" could mutate the WRONG task whenever
 * two or more were visible at once. Fixed to only resolve silently when exactly one action is
 * visible; otherwise it now falls through to the planner + validator's own ambiguity check
 * (resolveSingleVisibleEntity in validator.ts), which already asks a real clarification question.
 */

async function seedGmailUser(userId: string): Promise<string> {
  await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
  const connection = await prisma.integrationConnection.create({ data: { userId, integrationId: "gmail", status: "active", config: {} } });
  return connection.id;
}

async function seedReviews(userId: string, subjects: string[]): Promise<string[]> {
  const connectionId = await seedGmailUser(userId);
  const rule = await prisma.emailSignalRule.create({ data: { userId, connectionId, adapterId: "custom_email_review", name: "Newsletters", status: "active", createdBy: "user" } });
  const ids: string[] = [];
  for (const [i, subject] of subjects.entries()) {
    const review = await prisma.emailReviewItem.create({
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
    ids.push(review.id);
  }
  return ids;
}

// --- Task 2: vague compound-shaped Gmail review requests must clarify, never mutate. ---

const VAGUE_GMAIL_PHRASES = [
  ["1", "handle it"],
  ["2", "handle these"],
  ["3", "take care of them"],
  ["4", "do something with these emails"],
  ["5", "sort these out"],
  ["6", "clean this up"]
] as const;

for (const [label, phrase] of VAGUE_GMAIL_PHRASES) {
  test(`vague Gmail request ${label}. '${phrase}' asks clarification with real options, no mutation`, async () => {
    const server = buildServer();
    const userId = `ambiguity-gmail-vague-${label}-${randomUUID()}`;

    try {
      const reviewIds = await seedReviews(userId, ["Weekly digest", "Project update", "Promo newsletter"]);
      await sendAgentMessage(server, userId, "show me email reviews");

      const reply = await sendAgentMessage(server, userId, phrase);
      assertNoGenericAgentError(reply);
      assertClarificationResponse(reply, phrase);
      assert.match(reply.reply, /ignore them.*tasks.*keep them.*for later|ignore.*task.*keep.*detail/i, phrase);
      assert.deepEqual(reply.operationsPlanned, [], phrase);

      await assertEmailReviewsRemainPending(reviewIds, phrase);
      await assertNoActionItemsCreated(userId, phrase);
    } finally {
      clearAgentRuntimeMocks();
      await server.close();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });
}

// --- Task 3: unambiguous "keep them" phrasing is a clean no-op, never a clarification. ---

const UNAMBIGUOUS_KEEP_PHRASES = [
  ["1", "keep them for later"],
  ["2", "leave them in review"],
  ["3-es", "deja estos para luego"]
] as const;

for (const [label, phrase] of UNAMBIGUOUS_KEEP_PHRASES) {
  test(`unambiguous keep ${label}. '${phrase}' needs no clarification, reviews stay pending`, async () => {
    const server = buildServer();
    const userId = `ambiguity-gmail-keep-${label}-${randomUUID()}`;

    try {
      const reviewIds = await seedReviews(userId, ["Weekly digest", "Project update", "Promo newsletter"]);
      await sendAgentMessage(server, userId, "show me email reviews");

      const reply = await sendAgentMessage(server, userId, phrase);
      assertNoGenericAgentError(reply);
      assert.doesNotMatch(reply.reply, /which should i do|which one did you mean|couldn't tell/i, phrase);
      assert.match(reply.reply, /pending|in review|for later/i, phrase);
      assert.equal(reply.debug.mutationExecuted, false, phrase);

      await assertEmailReviewsRemainPending(reviewIds, phrase);
      await assertNoActionItemsCreated(userId, phrase);
    } finally {
      clearAgentRuntimeMocks();
      await server.close();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });
}

// --- Task 4: ambiguous action requests. ---

async function seedTwoActions(userId: string): Promise<[string, string]> {
  await seedUser(userId);
  const a = await createActionItem(userId, { source: "manual", title: "Follow up with recruiter" });
  const b = await createActionItem(userId, { source: "manual", title: "Renew passport" });
  return [a.id, b.id];
}

test("multiple visible actions, no recent reminder: 'complete it' asks clarification, no mutation", async () => {
  const server = buildServer();
  const userId = `ambiguity-action-complete-${randomUUID()}`;

  try {
    const [idA, idB] = await seedTwoActions(userId);
    mockPlan({ topic: "actions", intent: "list_actions", operations: [op("action.list", { status: "open" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "show my open tasks");

    // Simulates a planner correctly following its own prompt instruction ("if it's ambiguous,
    // omit the id and let the validator resolve it") rather than the crude no-API-key heuristic
    // fallback the test environment would otherwise hit — this is what actually exercises the
    // validator's own ACTION_REFERENCE_TOOLS ambiguity check (resolveSingleVisibleEntity).
    mockPlan({ topic: "actions", intent: "complete", operations: [op("action.complete", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "complete it");
    assertNoGenericAgentError(reply);
    assertClarificationResponse(reply, "complete it");
    assert.match(reply.reply, /which action|which one|which task/i);

    const a = await prisma.actionItem.findUnique({ where: { id: idA } });
    const b = await prisma.actionItem.findUnique({ where: { id: idB } });
    assert.equal(a?.status, "open");
    assert.equal(b?.status, "open");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("multiple visible actions, no recent reminder: 'done' asks clarification, no mutation", async () => {
  const server = buildServer();
  const userId = `ambiguity-action-done-${randomUUID()}`;

  try {
    const [idA, idB] = await seedTwoActions(userId);
    mockPlan({ topic: "actions", intent: "list_actions", operations: [op("action.list", { status: "open" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "show my open tasks");

    mockPlan({ topic: "actions", intent: "complete", operations: [op("action.complete", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "done");
    assertNoGenericAgentError(reply);
    assertNoMutationWhenClarificationExpected(reply, "done");

    const a = await prisma.actionItem.findUnique({ where: { id: idA } });
    const b = await prisma.actionItem.findUnique({ where: { id: idB } });
    assert.equal(a?.status, "open");
    assert.equal(b?.status, "open");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("multiple visible actions, no recent reminder: 'archive it' asks clarification, no mutation", async () => {
  const server = buildServer();
  const userId = `ambiguity-action-archive-${randomUUID()}`;

  try {
    const [idA, idB] = await seedTwoActions(userId);
    mockPlan({ topic: "actions", intent: "list_actions", operations: [op("action.list", { status: "open" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "show my open tasks");

    mockPlan({ topic: "actions", intent: "archive", operations: [op("action.archive", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "archive it");
    assertNoGenericAgentError(reply);
    assertClarificationResponse(reply, "archive it");

    const a = await prisma.actionItem.findUnique({ where: { id: idA } });
    const b = await prisma.actionItem.findUnique({ where: { id: idB } });
    assert.equal(a?.status, "open");
    assert.equal(b?.status, "open");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("multiple visible actions, no recent reminder: 'snooze it' (planner-routed) asks clarification, no mutation", async () => {
  const server = buildServer();
  const userId = `ambiguity-action-snooze-${randomUUID()}`;

  try {
    const [idA, idB] = await seedTwoActions(userId);
    mockPlan({ topic: "actions", intent: "list_actions", operations: [op("action.list", { status: "open" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "show my open tasks");

    // "snooze it" has no time phrase, so the deterministic shortcut itself can't resolve it
    // (untilText is required); it always reaches the planner. Mocked here to simulate a
    // reasonable planner call (untilText known, actionId genuinely unknown) so the validator's
    // own ACTION_REFERENCE_TOOLS ambiguity check is what's actually being tested.
    mockPlan({
      topic: "actions",
      intent: "snooze",
      operations: [op("action.snooze", { untilText: "tomorrow" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: "I'll snooze that to tomorrow."
    });
    const reply = await sendAgentMessage(server, userId, "snooze it until tomorrow");
    assertNoGenericAgentError(reply);
    assertClarificationResponse(reply, "snooze it");

    const a = await prisma.actionItem.findUnique({ where: { id: idA } });
    const b = await prisma.actionItem.findUnique({ where: { id: idB } });
    assert.equal(a?.status, "open");
    assert.equal(b?.status, "open");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("a recently reminded action resolves unambiguously even with another action also visible: 'complete it' mutates the right one", async () => {
  const server = buildServer();
  const userId = `ambiguity-action-reminded-${randomUUID()}`;

  try {
    const [idA, idB] = await seedTwoActions(userId);
    await createActionItemReminderLog({ userId, actionItemId: idB, reminderType: "due" });
    mockPlan({ topic: "actions", intent: "list_actions", operations: [op("action.list", { status: "open" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "show my open tasks");
    // mockPlan persists until overwritten — clear it so "complete it" reaches the real (mock-free)
    // heuristic fallback instead of reusing the stale action.list plan from the turn above.
    clearAgentRuntimeMocks();

    const reply = await sendAgentMessage(server, userId, "complete it");
    assertNoGenericAgentError(reply);
    assert.deepEqual(reply.operationsPlanned.map((operation) => operation.tool), ["action.complete"]);
    assert.equal(reply.debug.mutationExecuted, true);

    const a = await prisma.actionItem.findUnique({ where: { id: idA } });
    const b = await prisma.actionItem.findUnique({ where: { id: idB } });
    assert.equal(a?.status, "open", "the un-reminded action must be untouched");
    assert.equal(b?.status, "completed", "the recently reminded action is the unambiguous target");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 5: adversarial bad-planner output for vague/ambiguous requests must be blocked. ---

test("adversarial: 'handle these emails' — a bad planner emitting reject+to_action is never even consulted, clarification wins", async () => {
  const server = buildServer();
  const userId = `ambiguity-adversarial-gmail-${randomUUID()}`;

  try {
    const reviewIds = await seedReviews(userId, ["Weekly digest", "Project update"]);
    await sendAgentMessage(server, userId, "show me email reviews");

    mockPlan({
      topic: "gmail_reviews",
      intent: "bad_plan_guessed_destructive",
      operations: [op("gmail.review.reject", { index: 1 }), op("gmail.review.to_action", { index: 2 })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: "I'll handle both."
    });
    const reply = await sendAgentMessage(server, userId, "handle these emails");
    assertNoGenericAgentError(reply);
    assertClarificationResponse(reply, "handle these emails");
    assert.deepEqual(reply.operationsPlanned, [], "the bad plan must never even be reached");

    await assertEmailReviewsRemainPending(reviewIds, "handle these emails");
    await assertNoActionItemsCreated(userId, "handle these emails");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("adversarial: 'take care of the tasks' — a bad planner emitting action.complete with an invalid ref is blocked by the validator's ambiguity check", async () => {
  const server = buildServer();
  const userId = `ambiguity-adversarial-action-${randomUUID()}`;

  try {
    const [idA, idB] = await seedTwoActions(userId);
    mockPlan({ topic: "actions", intent: "list_actions", operations: [op("action.list", { status: "open" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "show my open tasks");

    // Bad plan: action.complete only accepts { actionId }, so a bogus "index" the planner might
    // hallucinate is silently stripped by the schema, leaving no real target — exactly the case
    // the validator's own ambiguity check must catch when more than one action is visible.
    mockPlan({
      topic: "actions",
      intent: "bad_plan_guessed_target",
      operations: [{ tool: "action.complete", args: { index: 1 }, rationale: null }],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: "I'll complete that task."
    });
    const reply = await sendAgentMessage(server, userId, "take care of the tasks");
    assertNoGenericAgentError(reply);
    assertClarificationResponse(reply, "take care of the tasks");

    const a = await prisma.actionItem.findUnique({ where: { id: idA } });
    const b = await prisma.actionItem.findUnique({ where: { id: idB } });
    assert.equal(a?.status, "open");
    assert.equal(b?.status, "open");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
