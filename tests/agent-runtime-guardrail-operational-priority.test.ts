import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createGoal } from "../packages/db/src/index.ts";
import { configureAgentRuntimeServices, resetAgentRuntimeServicesForTests } from "../apps/api/src/agent-runtime/services.ts";
import {
  buildServer,
  clearAgentRuntimeMocks,
  mockGuardrail,
  mockPlan,
  op,
  prisma,
  sendAgentMessage,
  seedUser,
  type MockGuardrailClassification
} from "./helpers/agent-runtime-test-helpers.ts";

/**
 * Agent Runtime v3 routing/guardrail ordering — a real Telegram smoke test found the
 * goal-avoidance guardrail (apps/api/src/agent-runtime/goal-guardrails.ts's checkGoalGuardrail)
 * intercepting "check gmail every hour" as "avoidance" of an unrelated active goal ("Finish
 * reading Meditations by Marcus Aurelius"), because checkGoalGuardrail ran as the very first
 * thing in processAgentMessageInner (apps/api/src/agent-runtime/runtime.ts) — before ANY of the
 * deterministic domain shortcuts (Gmail sync/autonomy/status/reviews, action completion,
 * reminders, proactive settings) got a chance to recognize the message as a plain operational
 * command. Every message with at least one active goal was offered to the guardrail's LLM
 * classification tier, including ones that are unambiguously about something else entirely.
 *
 * The fix moves checkGoalGuardrail to run AFTER the full deterministic shortcut cascade,
 * immediately before the real LLM planner — so it now only ever sees messages that no domain
 * shortcut already recognized and handled. This narrows what reaches the guardrail; it does not
 * touch the guardrail's own classification logic, so genuine avoidance (test 7 below) still
 * fires exactly as before. Every operational test below deliberately mocks the guardrail's LLM
 * tier to return a worst-case "soft_warn"/avoidance verdict against the seeded goal — proving
 * the assertions hold BECAUSE the deterministic shortcut wins the race and the mock is never
 * even consulted, not because the mock happens to return "allow".
 */

async function seedGmailUser(userId: string): Promise<string> {
  await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
  const connection = await prisma.integrationConnection.create({ data: { userId, integrationId: "gmail", status: "active", config: {} } });
  return connection.id;
}

async function seedReadingGoal(userId: string) {
  // directness: 4 reproduces the exact reported reply wording ("That's avoidance of your
  // goal...") — composeGoalConflictReply (goal-guardrails.ts) uses a softer "this looks like it
  // might be pulling you away..." phrasing below that threshold (default directness is 3).
  await prisma.userOperatingProfile.create({ data: { userId, directness: 4 } });
  const result = await createGoal(userId, { title: "Finish reading Meditations by Marcus Aurelius", category: "personal", priority: "high" });
  if (result.duplicate) throw new Error("unexpected duplicate goal in test setup");
  return result.goal;
}

function worstCaseAvoidance(goalId: string): MockGuardrailClassification {
  return { conflict: "soft_warn", goalId, pattern: "avoidance", clarifyingQuestion: null, reason: "test: simulates a misfiring classifier" };
}

test("1. 'check gmail every hour' routes to gmail.autonomy.propose_update, not the Meditations avoidance guardrail", async () => {
  const server = buildServer();
  const userId = `guardrail-op-priority-1-${randomUUID()}`;

  try {
    await seedGmailUser(userId);
    const goal = await seedReadingGoal(userId);
    mockGuardrail(worstCaseAvoidance(goal.id));

    const reply = await sendAgentMessage(server, userId, "check gmail every hour");

    assert.doesNotMatch(reply.reply, /avoidance|conflicts with your goal|meditations|marcus aurelius/i);
    assert.match(reply.reply, /about to check gmail every hour/i);
    assert.match(reply.reply, /reply yes to confirm or cancel/i);
    assert.equal(reply.debug.mutationExecuted, false);
    assert.ok(reply.debug.pendingOperation, "must open the scheduled-sync confirmation, not a guardrail block");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2. 'review my emails every 1h' routes to gmail.autonomy.propose_update, not avoidance and not a rule pause", async () => {
  const server = buildServer();
  const userId = `guardrail-op-priority-2-${randomUUID()}`;

  try {
    const connectionId = await seedGmailUser(userId);
    await prisma.emailSignalRule.create({ data: { userId, connectionId, adapterId: "custom_email_review", name: "Work action emails", status: "active", createdBy: "user" } });
    const goal = await seedReadingGoal(userId);
    mockGuardrail(worstCaseAvoidance(goal.id));

    const reply = await sendAgentMessage(server, userId, "review my emails every 1h");

    assert.doesNotMatch(reply.reply, /avoidance|conflicts with your goal|meditations/i);
    assert.doesNotMatch(reply.reply, /work action emails/i, "must not misroute into a rule pause either");
    assert.match(reply.reply, /about to check gmail every hour/i);
    assert.equal(reply.debug.mutationExecuted, false);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3. 'when do you check Gmail?' routes to gmail.autonomy.status, not avoidance", async () => {
  const server = buildServer();
  const userId = `guardrail-op-priority-3-${randomUUID()}`;

  try {
    await seedGmailUser(userId);
    const goal = await seedReadingGoal(userId);
    mockGuardrail(worstCaseAvoidance(goal.id));

    const reply = await sendAgentMessage(server, userId, "when do you check Gmail?");

    assert.doesNotMatch(reply.reply, /avoidance|conflicts with your goal|meditations/i);
    assert.match(reply.reply, /alerts are (on|off)/i);
    assert.equal(reply.debug.mutationExecuted, false);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4. 'sync Gmail' routes to gmail.sync, not avoidance", async () => {
  const server = buildServer();
  const userId = `guardrail-op-priority-4-${randomUUID()}`;

  try {
    const connectionId = await seedGmailUser(userId);
    // formatCanonicalGmailSyncBlock short-circuits to "enable a rule first" copy when there are
    // no active Gmail rules at all — an active rule plus a mocked syncGmailForUser reaches the
    // actual sync attempt this test cares about (routing, not the rule-less-account edge case).
    await prisma.emailSignalRule.create({ data: { userId, connectionId, adapterId: "custom_email_review", name: "Recruiter replies", status: "active", createdBy: "user" } });
    const goal = await seedReadingGoal(userId);
    mockGuardrail(worstCaseAvoidance(goal.id));
    configureAgentRuntimeServices({
      syncGmailForUser: async () => "Gmail sync: 2 messages checked, 1 new review item."
    });

    const reply = await sendAgentMessage(server, userId, "sync Gmail");

    assert.doesNotMatch(reply.reply, /avoidance|conflicts with your goal|meditations/i);
    assert.match(reply.reply, /gmail sync:/i);
  } finally {
    clearAgentRuntimeMocks();
    resetAgentRuntimeServicesForTests();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("5. 'show me the email reviews' routes to gmail.review.list, not avoidance", async () => {
  const server = buildServer();
  const userId = `guardrail-op-priority-5-${randomUUID()}`;

  try {
    const connectionId = await seedGmailUser(userId);
    const rule = await prisma.emailSignalRule.create({ data: { userId, connectionId, adapterId: "custom_email_review", name: "Recruiter replies", status: "active", createdBy: "user" } });
    await prisma.emailReviewItem.create({
      data: {
        userId,
        connectionId,
        ruleId: rule.id,
        adapterId: "custom_email_review",
        provider: "gmail",
        providerMessageId: "m1",
        externalId: `gmail-review:${rule.id}:m1`,
        subject: "Recruiter reply",
        snippet: "Can we talk tomorrow?",
        evidence: "Can we talk tomorrow?",
        confidence: 0.8,
        reason: "custom_rule_match",
        extracted: {},
        status: "pending"
      }
    });
    const goal = await seedReadingGoal(userId);
    mockGuardrail(worstCaseAvoidance(goal.id));

    const reply = await sendAgentMessage(server, userId, "show me the email reviews");

    assert.doesNotMatch(reply.reply, /avoidance|conflicts with your goal|meditations/i);
    assert.match(reply.reply, /pending gmail reviews?:/i);
    assert.match(reply.reply, /recruiter reply/i);
    assert.equal(reply.debug.mutationExecuted, false);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("6. 'turn off daily review' reaches the daily-loop settings path, not Gmail autonomy and not Meditations avoidance", async () => {
  const server = buildServer();
  const userId = `guardrail-op-priority-6-${randomUUID()}`;

  try {
    await seedUser(userId);
    const goal = await seedReadingGoal(userId);
    // No deterministic shortcut exists for daily-loop settings (LLM-planned), so this reaches
    // the guardrail as before — mocked here with the CORRECT "none" verdict, since "turn off
    // daily review" genuinely has nothing to do with the reading goal. This test's job is to
    // confirm downstream routing lands on daily_loop, not on the Gmail-autonomy parser's own
    // "review"+"daily" ambiguity (already guarded against separately) and not on a false
    // avoidance reply, given the ordering fix now lets it reach the real planner at all.
    mockGuardrail({ conflict: "none", goalId: null, pattern: null, clarifyingQuestion: null, reason: "unrelated to the reading goal" });
    mockPlan({
      topic: "daily_loop",
      intent: "propose_daily_loop_update",
      operations: [op("daily_loop.settings_propose_update", { field: "dailyReviewEnabled", value: false })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });

    const reply = await sendAgentMessage(server, userId, "turn off daily review");

    assert.doesNotMatch(reply.reply, /avoidance|conflicts with your goal|meditations/i);
    assert.doesNotMatch(reply.reply, /gmail/i);
    assert.deepEqual(reply.operationsPlanned.map((operation) => operation.tool), ["daily_loop.settings_propose_update"]);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("7. genuine avoidance of the reading goal still triggers the guardrail", async () => {
  const server = buildServer();
  const userId = `guardrail-op-priority-7-${randomUUID()}`;

  try {
    await seedUser(userId);
    const goal = await seedReadingGoal(userId);
    mockGuardrail(worstCaseAvoidance(goal.id));

    const reply = await sendAgentMessage(server, userId, "I don't want to read Meditations, I'll scroll YouTube instead");

    assert.match(reply.reply, /avoidance/i);
    assert.match(reply.reply, /meditations by marcus aurelius/i);
    assert.deepEqual(reply.operationsPlanned, [], "the tool planner must never be reached once the guardrail intervenes");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
