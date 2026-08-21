import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createActionItem, createActionItemReminderLog, createGoal } from "../packages/db/src/index.ts";
import {
  assertClarificationResponse,
  assertEmailReviewsRemainPending,
  assertNoActionItemsCreated,
  assertNoGenericAgentError,
  buildServer,
  clearAgentRuntimeMocks,
  getAgentSession,
  mockGuardrail,
  mockPlan,
  op,
  prisma,
  sendAgentMessage,
  seedUser,
  type MockGuardrailClassification
} from "./helpers/agent-runtime-test-helpers.ts";

/**
 * V3 clarification-follow-up hardening — a real Telegram smoke test found two remaining
 * ambiguity bugs even after the previous ambiguity-hardening pass:
 *
 * (1) "keep em all for later" — a direct, unambiguous answer to Alecto's OWN clarification
 * question ("I can ignore them, turn them into tasks, keep them for later...") — was classified
 * as goal avoidance instead of being recognized as a Gmail-review decision. Root cause: the
 * plural-quantifier patterns in extractExplicitGmailReviewIntentEntries (runtime.ts) only
 * recognized "them"/"these"/"those"/"both"/"all (of them)" — never the informal "em"/"'em" slang
 * for "them". Since no domain shortcut matched, the message fell all the way through the
 * shortcut cascade to the goal-avoidance guardrail — the SAME architecture that already protects
 * "check gmail every hour" from the guardrail (deterministic shortcuts run before it) protects
 * this too, once the literal text is recognized; no new "pending clarification" state-tracking
 * was needed, only the missing slang alias.
 *
 * (2) "complete it" after "show all tasks" (multiple visible actions, no recent reminder) —
 * already fixed by resolveMostRecentlyNotifiedOrVisibleActionId's earlier ambiguity-hardening
 * fix (only resolves silently when exactly one action is visible). Tests B/C/D here exercise
 * that exact fix with the reported phrasing/seed shape, locking it in against regressions.
 */

async function seedGmailUser(userId: string): Promise<string> {
  await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
  const connection = await prisma.integrationConnection.create({ data: { userId, integrationId: "gmail", status: "active", config: {} } });
  return connection.id;
}

async function seedTwoAdvisoryReviews(userId: string): Promise<{ connectionId: string; ssrfId: string; dosId: string }> {
  const connectionId = await seedGmailUser(userId);
  const rule = await prisma.emailSignalRule.create({
    data: { userId, connectionId, adapterId: "custom_email_review", name: "GitHub security advisories", status: "active", createdBy: "user" }
  });
  const ssrf = await prisma.emailReviewItem.create({
    data: {
      userId,
      connectionId,
      ruleId: rule.id,
      adapterId: "custom_email_review",
      provider: "gmail",
      providerMessageId: "advisory-ssrf",
      externalId: `gmail-review:${rule.id}:advisory-ssrf`,
      subject: "GitHub security advisory SSRF",
      snippet: "SSRF vulnerability details.",
      evidence: "SSRF vulnerability details.",
      confidence: 0.8,
      reason: "custom_rule_match",
      extracted: {},
      status: "pending"
    }
  });
  const dos = await prisma.emailReviewItem.create({
    data: {
      userId,
      connectionId,
      ruleId: rule.id,
      adapterId: "custom_email_review",
      provider: "gmail",
      providerMessageId: "advisory-dos",
      externalId: `gmail-review:${rule.id}:advisory-dos`,
      subject: "GitHub security advisory DoS",
      snippet: "DoS vulnerability details.",
      evidence: "DoS vulnerability details.",
      confidence: 0.8,
      reason: "custom_rule_match",
      extracted: {},
      status: "pending"
    }
  });
  return { connectionId, ssrfId: ssrf.id, dosId: dos.id };
}

async function seedReadingGoalWithDirectProfile(userId: string) {
  // directness: 4 reproduces the exact reported reply wording ("That's avoidance of your
  // goal...") — composeGoalConflictReply (goal-guardrails.ts) uses a softer phrasing below
  // that threshold (default directness is 3).
  await prisma.userOperatingProfile.create({ data: { userId, directness: 4 } });
  const result = await createGoal(userId, { title: "Finish reading Meditations by Marcus Aurelius", category: "personal", priority: "high" });
  if (result.duplicate) throw new Error("unexpected duplicate goal in test setup");
  return result.goal;
}

function worstCaseAvoidance(goalId: string): MockGuardrailClassification {
  return { conflict: "soft_warn", goalId, pattern: "avoidance", clarifyingQuestion: null, reason: "test: simulates a misfiring classifier" };
}

const CLARIFICATION_FOLLOWUP_PHRASES = [
  ["main", "keep em all for later"],
  ["variant-1", "keep them all for later"],
  ["variant-2", "keep 'em all for later"],
  ["variant-3", "keep em for later"],
  ["variant-4", "leave em there for now"]
] as const;

for (const [label, phrase] of CLARIFICATION_FOLLOWUP_PHRASES) {
  test(`A-${label}. clarification follow-up '${phrase}' keeps both reviews pending, never hits the avoidance guardrail`, async () => {
    const server = buildServer();
    const userId = `clarification-followup-${label}-${randomUUID()}`;

    try {
      const { ssrfId, dosId } = await seedTwoAdvisoryReviews(userId);
      const goal = await seedReadingGoalWithDirectProfile(userId);
      // Worst-case guardrail mock, set BEFORE the clarification-answer turn: if the guardrail
      // were consulted at all for this message, it would misfire — proving the assertions below
      // hold BECAUSE the deterministic shortcut wins the race, not because the mock says allow.
      mockGuardrail(worstCaseAvoidance(goal.id));

      const list = await sendAgentMessage(server, userId, "show me email reviews");
      assertNoGenericAgentError(list);

      const clarify = await sendAgentMessage(server, userId, "handle them");
      assertNoGenericAgentError(clarify);
      assert.match(clarify.reply, /which should i do/i);
      assert.equal(clarify.debug.mutationExecuted, false);

      const reply = await sendAgentMessage(server, userId, phrase);
      assertNoGenericAgentError(reply);
      assert.doesNotMatch(reply.reply, /avoidance|conflicts with your goal|meditations|marcus aurelius/i, phrase);
      assert.notEqual(reply.debug.conversationTopic, "guardrail", phrase);
      assert.deepEqual(reply.operationsPlanned.map((operation) => operation.tool), ["gmail.review.keep", "gmail.review.keep"], phrase);

      await assertEmailReviewsRemainPending([ssrfId, dosId], phrase);
      await assertNoActionItemsCreated(userId, phrase);
    } finally {
      clearAgentRuntimeMocks();
      await server.close();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });
}

test("A-diagnostics. 'keep em all for later' logs a domain shortcut match, never a guardrail_check", async () => {
  const server = buildServer();
  const userId = `clarification-followup-diagnostics-${randomUUID()}`;
  const previousDiagnostics = process.env.AGENT_RUNTIME_DIAGNOSTICS;
  const logs: string[] = [];
  const originalLog = console.log;

  try {
    process.env.AGENT_RUNTIME_DIAGNOSTICS = "true";
    console.log = (...args: unknown[]) => {
      logs.push(args.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join(" "));
    };

    const { ssrfId, dosId } = await seedTwoAdvisoryReviews(userId);
    const goal = await seedReadingGoalWithDirectProfile(userId);
    mockGuardrail(worstCaseAvoidance(goal.id));

    await sendAgentMessage(server, userId, "show me email reviews");
    await sendAgentMessage(server, userId, "handle them");
    logs.length = 0; // only care about the diagnostics for the clarification-answer turn itself
    await sendAgentMessage(server, userId, "keep em all for later");

    const relevant = logs.filter((line) => line.includes("[agent-runtime-diagnostics]"));
    assert.ok(
      relevant.some((line) => line.includes('"phase":"domain_shortcut_matched"') && line.includes("gmail.review.keep")),
      `expected a domain_shortcut_matched log mentioning gmail.review.keep, got:\n${relevant.join("\n")}`
    );
    assert.ok(
      !relevant.some((line) => line.includes('"phase":"guardrail_check"')),
      `must not log guardrail_check for this turn, got:\n${relevant.join("\n")}`
    );

    await assertEmailReviewsRemainPending([ssrfId, dosId]);
  } finally {
    console.log = originalLog;
    if (previousDiagnostics === undefined) delete process.env.AGENT_RUNTIME_DIAGNOSTICS;
    else process.env.AGENT_RUNTIME_DIAGNOSTICS = previousDiagnostics;
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Action-completion ambiguity: B (must clarify), C (reminded action still works), D (numbered still works). ---

async function seedActionItems(userId: string, titles: string[]): Promise<string[]> {
  await seedUser(userId);
  const ids: string[] = [];
  for (const title of titles) {
    const item = await createActionItem(userId, { source: "manual", title });
    ids.push(item.id);
  }
  return ids;
}

function actionListPlan() {
  return { topic: "actions", intent: "list_actions", operations: [op("action.list", { status: "all", limit: 10 })], needsClarification: false, clarificationQuestion: null, replyDraft: "" };
}

test("B. bare 'complete it' after 'show all tasks' with 3+ visible actions and no reminder asks clarification, no mutation", async () => {
  const server = buildServer();
  const userId = `action-ambiguity-b-${randomUUID()}`;

  try {
    const ids = await seedActionItems(userId, ["Check cheap car listings twice", "Renew passport", "Follow up with recruiter"]);
    mockPlan(actionListPlan());
    const list = await sendAgentMessage(server, userId, "show all tasks");
    assertNoGenericAgentError(list);
    assert.match(list.reply, /you have 3 actions:/i);

    // Simulates a planner correctly following its own prompt instruction (omit actionId when
    // ambiguous) rather than the crude no-API-key heuristic fallback the test environment would
    // otherwise hit — this is what actually exercises the validator's ambiguity check.
    mockPlan({ topic: "actions", intent: "complete", operations: [op("action.complete", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "complete it");
    assertNoGenericAgentError(reply);
    assertClarificationResponse(reply, "complete it");
    assert.match(reply.reply, /which action do you mean/i);

    for (const id of ids) {
      const item = await prisma.actionItem.findUnique({ where: { id } });
      assert.equal(item?.status, "open", `action ${id} must remain open`);
    }
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("C. bare 'complete it' with a latest reminded action still resolves and completes it, no clarification", async () => {
  const server = buildServer();
  const userId = `action-ambiguity-c-${randomUUID()}`;

  try {
    const ids = await seedActionItems(userId, ["Check cheap car listings twice", "Renew passport", "Follow up with recruiter"]);
    await createActionItemReminderLog({ userId, actionItemId: ids[2]!, reminderType: "due" });
    mockPlan(actionListPlan());
    await sendAgentMessage(server, userId, "show all tasks");

    const reply = await sendAgentMessage(server, userId, "complete it");
    assertNoGenericAgentError(reply);
    assert.deepEqual(reply.operationsPlanned.map((operation) => operation.tool), ["action.complete"]);
    assert.equal(reply.debug.mutationExecuted, true);

    const reminded = await prisma.actionItem.findUnique({ where: { id: ids[2]! } });
    assert.equal(reminded?.status, "completed");
    for (const id of [ids[0]!, ids[1]!]) {
      const item = await prisma.actionItem.findUnique({ where: { id } });
      assert.equal(item?.status, "open", `un-reminded action ${id} must be untouched`);
    }
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("D. numbered 'complete 2' after 'show all tasks' completes exactly action 2", async () => {
  const server = buildServer();
  const userId = `action-ambiguity-d-${randomUUID()}`;

  try {
    // action.list's own entities now DO carry index metadata (matching its numbered chat
    // output), but action.complete's own schema still has no index/ref field of its own — a real
    // LLM planner is expected to plan action.hygiene_apply with an index-based selection for a
    // numbered reply, or resolve "2" to the real id itself for a direct action.complete plan (as
    // this test does). This seeds the second item as the id a correctly-functioning planner
    // would resolve "2" to.
    const ids = await seedActionItems(userId, ["Check cheap car listings twice", "Renew passport", "Follow up with recruiter"]);
    const targetId = ids[1]!;
    mockPlan(actionListPlan());
    await sendAgentMessage(server, userId, "show all tasks");

    // "complete 2" has a digit, so the deterministic bare-pronoun shortcut always defers to the
    // planner; action.complete's own schema has no index/ref field, so a correctly-functioning
    // planner must resolve "2" against visible context itself and pass the real actionId.
    mockPlan({ topic: "actions", intent: "complete_numbered", operations: [op("action.complete", { actionId: targetId })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "complete 2");
    assertNoGenericAgentError(reply);
    assert.deepEqual(reply.operationsPlanned.map((operation) => operation.tool), ["action.complete"]);
    assert.equal(reply.debug.mutationExecuted, true);

    const target = await prisma.actionItem.findUnique({ where: { id: targetId } });
    assert.equal(target?.status, "completed");

    for (const id of [ids[0]!, ids[2]!]) {
      const item = await prisma.actionItem.findUnique({ where: { id } });
      assert.equal(item?.status, "open", `action ${id} must remain untouched`);
    }
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// A real live-LLM eval reproduction (tests/agent-runtime-llm-eval.test.ts scenario 11) found the
// REAL planner directly supplying a concrete (but wrong) actionId for a bare "complete it" —
// bypassing the validator's "missing actionId" ambiguity check entirely, since that check only
// ever ran when actionId was absent. These two tests lock in the fix (validator.ts's
// actionReferenceGroundedInMessage) with a mocked planner forcing exactly that shape.

test("E. a bad planner supplying a concrete but ungrounded actionId for 'complete it' is discarded, not trusted — clarification wins", async () => {
  const server = buildServer();
  const userId = `action-ambiguity-e-${randomUUID()}`;

  try {
    const ids = await seedActionItems(userId, [
      "We need to seriously talk about getcracked",
      "Review GitHub security advisory for vulnerabilities",
      "Branding direction meeting",
      "Upgrade to Node.js 24",
      "Do 2 strength sessions"
    ]);
    mockPlan(actionListPlan());
    await sendAgentMessage(server, userId, "show all tasks");

    // The exact bad shape a real LLM was observed producing: a concrete, real actionId with no
    // textual connection to "complete it" at all.
    const wrongTarget = ids[4]!; // "Do 2 strength sessions"
    mockPlan({ topic: "actions", intent: "complete", operations: [op("action.complete", { actionId: wrongTarget })], needsClarification: false, clarificationQuestion: null, replyDraft: "I've marked that as completed." });
    const reply = await sendAgentMessage(server, userId, "complete it");
    assertNoGenericAgentError(reply);
    assertClarificationResponse(reply, "complete it (ungrounded actionId)");
    assert.match(reply.reply, /which action do you mean/i);

    for (const id of ids) {
      const item = await prisma.actionItem.findUnique({ where: { id } });
      assert.equal(item?.status, "open", `action ${id} must remain untouched`);
    }
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("F. a planner supplying an actionId grounded in a specific named reference is still trusted and completes", async () => {
  const server = buildServer();
  const userId = `action-ambiguity-f-${randomUUID()}`;

  try {
    const ids = await seedActionItems(userId, ["Check cheap car listings twice", "Renew passport", "Follow up with recruiter"]);
    mockPlan(actionListPlan());
    await sendAgentMessage(server, userId, "show all tasks");

    const targetId = ids[1]!; // "Renew passport"
    mockPlan({ topic: "actions", intent: "complete_named", operations: [op("action.complete", { actionId: targetId })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "complete the passport renewal task");
    assertNoGenericAgentError(reply);
    assert.deepEqual(reply.operationsPlanned.map((operation) => operation.tool), ["action.complete"]);
    assert.equal(reply.debug.mutationExecuted, true, "a genuinely named reference must not be blocked by the ambiguity guard");

    const target = await prisma.actionItem.findUnique({ where: { id: targetId } });
    assert.equal(target?.status, "completed");
    for (const id of [ids[0]!, ids[2]!]) {
      const item = await prisma.actionItem.findUnique({ where: { id } });
      assert.equal(item?.status, "open", `action ${id} must remain untouched`);
    }
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// A real Telegram smoke test found that after Alecto asks "Which action do you mean?", a direct
// "cancel this" answer ("none," "no action," "nothing," "never mind," "cancel," "i mean NO
// ACTION") fell through to the real planner with no way to know a clarification was just open,
// and got misread as an unrelated action-cleanup request. Root cause: a needs_clarification
// result never persisted ANY session state, so the next turn had nothing to distinguish "this is
// answering my own question" from a fresh, unrelated message. Fixed by marking
// session.pendingOperation with a lightweight ACTION_CLARIFICATION_TOPIC marker (operations: [],
// so it can never trip the mutation firewall meant for real yes/no confirmations) whenever an
// action.complete/archive/snooze reference is genuinely ambiguous, and checking a dedicated
// cancel-phrase pattern against it before anything else runs.

const ACTION_CLARIFICATION_CANCEL_PHRASES = [
  ["1", "none"],
  ["2", "no action"],
  ["3", "nothing"],
  ["4", "never mind"],
  ["5", "cancel"],
  ["6", "i mean NO ACTION"]
] as const;

for (const [label, phrase] of ACTION_CLARIFICATION_CANCEL_PHRASES) {
  test(`G-${label}. '${phrase}' cancels an open action-completion clarification, no mutation`, async () => {
    const server = buildServer();
    const userId = `action-clarification-cancel-${label}-${randomUUID()}`;

    try {
      const ids = await seedActionItems(userId, ["Check cheap car listings twice", "Renew passport", "Follow up with recruiter"]);
      mockPlan(actionListPlan());
      await sendAgentMessage(server, userId, "show all tasks");

      // Simulates the real planner's own observed behavior for a genuinely ambiguous "complete
      // it": omitting actionId and letting the validator ask.
      mockPlan({ topic: "actions", intent: "complete", operations: [op("action.complete", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
      const clarify = await sendAgentMessage(server, userId, "complete it");
      assertNoGenericAgentError(clarify);
      assertClarificationResponse(clarify, "complete it");
      assert.match(clarify.reply, /which action do you mean/i);

      const rowAfterClarify = await getAgentSession(userId);
      assert.equal((rowAfterClarify?.pendingOperation as { topic?: string } | null)?.topic, "action_clarification", "the clarification must be tracked as pending");

      const reply = await sendAgentMessage(server, userId, phrase);
      assertNoGenericAgentError(reply);
      assert.equal(reply.reply, "Okay — I won't complete anything.", phrase);
      assert.equal(reply.debug.mutationExecuted, false, phrase);
      assert.deepEqual(reply.operationsPlanned, [], phrase);
      assert.doesNotMatch(reply.reply, /which action do you mean|actions worth cleaning up/i, phrase);

      const rowAfterCancel = await getAgentSession(userId);
      assert.equal(rowAfterCancel?.pendingOperation, null, "the pending clarification must be cleared");

      for (const id of ids) {
        const item = await prisma.actionItem.findUnique({ where: { id } });
        assert.equal(item?.status, "open", `action ${id} must remain untouched (${phrase})`);
      }
    } finally {
      clearAgentRuntimeMocks();
      await server.close();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });
}

test("H. cancelling an action-completion clarification does not block a later, unrelated mutation", async () => {
  const server = buildServer();
  const userId = `action-clarification-cancel-then-new-${randomUUID()}`;

  try {
    const ids = await seedActionItems(userId, ["Check cheap car listings twice", "Renew passport", "Follow up with recruiter"]);
    mockPlan(actionListPlan());
    await sendAgentMessage(server, userId, "show all tasks");

    mockPlan({ topic: "actions", intent: "complete", operations: [op("action.complete", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "complete it");

    await sendAgentMessage(server, userId, "none");

    // A fresh, unrelated, unambiguous named completion right after cancelling must work
    // normally — the cleared marker must not leave any stale firewall/state behind.
    const targetId = ids[1]!;
    mockPlan({ topic: "actions", intent: "complete_named", operations: [op("action.complete", { actionId: targetId })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "complete the passport renewal task");
    assertNoGenericAgentError(reply);
    assert.deepEqual(reply.operationsPlanned.map((operation) => operation.tool), ["action.complete"]);
    assert.equal(reply.debug.mutationExecuted, true);

    const target = await prisma.actionItem.findUnique({ where: { id: targetId } });
    assert.equal(target?.status, "completed");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
