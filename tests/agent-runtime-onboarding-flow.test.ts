import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import {
  clearAgentRuntimeMocks,
  mockPlan,
  op,
  prisma,
  sendAgentMessage,
  seedUser,
  buildServer,
  type MockPlan
} from "./helpers/agent-runtime-test-helpers.ts";

/**
 * Regression coverage for fix/private-alpha-onboarding-flow — a real Railway smoke test found
 * "let me know when some of the[m] Reply as my mail get flooded with automatic responses" (a
 * passive Gmail-reply-notification request while a goal proposal was pending) hijacked by the
 * unconditional UNSUPPORTED_GMAIL_ACTION_RE shortcut before the planner ever got a turn.
 */

async function seededServer(): Promise<{ server: ReturnType<typeof buildServer>; userId: string }> {
  const server = buildServer();
  const userId = `onboarding-flow-${randomUUID()}`;
  await seedUser(userId);
  return { server, userId };
}

test("A: 'let me know when recruiters reply' while a job goal proposal is pending does not trigger gmail_unsupported_action", async () => {
  const { server, userId } = await seededServer();
  try {
    const jobPlan: MockPlan["operations"] = [
      op("goal.create_propose", {
        title: "Find a new developer job",
        category: "career",
        signals: [{ key: "applications_sent", label: "applications sent", cadence: "daily" }],
        firstActions: []
      })
    ];
    mockPlan({ topic: "goals", intent: "propose_goal_creation", operations: jobPlan, needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const proposeReply = await sendAgentMessage(server, userId, "I want to find a new developer job");
    assert.equal(proposeReply.debug.pendingOperation, true);

    const revisedPlan: MockPlan["operations"] = [
      op("goal.create_propose", {
        title: "Find a new developer job",
        category: "career",
        signals: [
          { key: "applications_sent", label: "applications sent", cadence: "daily" },
          { key: "recruiter_replies", label: "recruiter replies", cadence: "daily" }
        ],
        integrationHint: "Gmail: recruiter replies",
        firstActions: []
      })
    ];
    mockPlan({ topic: "goals", intent: "propose_goal_creation", operations: revisedPlan, needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const followUp = await sendAgentMessage(server, userId, "let me know when recruiters reply");

    assert.notEqual(followUp.debug.conversationTopic, "gmail_unsupported_action", `must not hit the unsupported-Gmail shortcut — got reply: "${followUp.reply}"`);
    assert.equal(followUp.debug.llmPlannerAttempted, true, "a passive notification request must reach the planner, not a deterministic refusal");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("B: 'reply to the recruiter for me' still triggers the unsupported-Gmail-action shortcut, even with a pending goal proposal", async () => {
  const { server, userId } = await seededServer();
  try {
    const jobPlan: MockPlan["operations"] = [
      op("goal.create_propose", {
        title: "Find a new developer job",
        category: "career",
        signals: [{ key: "applications_sent", label: "applications sent", cadence: "daily" }],
        firstActions: []
      })
    ];
    mockPlan({ topic: "goals", intent: "propose_goal_creation", operations: jobPlan, needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "I want to find a new developer job");

    const reply = await sendAgentMessage(server, userId, "reply to the recruiter for me");

    assert.equal(reply.debug.conversationTopic, "gmail_unsupported_action");
    assert.equal(reply.debug.llmPlannerAttempted, false);
    assert.match(reply.reply, /can't reply/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("C: 'watch for recruiter replies' is treated as passive Gmail observation, not email sending", async () => {
  const { server, userId } = await seededServer();
  try {
    mockPlan({ topic: "gmail", intent: "clarify", operations: [], needsClarification: true, clarificationQuestion: "Which goal should this track for?", replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "watch for recruiter replies");

    assert.notEqual(reply.debug.conversationTopic, "gmail_unsupported_action");
    assert.equal(reply.debug.llmPlannerAttempted, true);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("D: repeated unsupported Gmail action message is handled identically both times, no pending operation created", async () => {
  const { server, userId } = await seededServer();
  try {
    const first = await sendAgentMessage(server, userId, "reply to this email");
    assert.equal(first.debug.conversationTopic, "gmail_unsupported_action");
    assert.equal(first.debug.pendingOperation, false);

    const second = await sendAgentMessage(server, userId, "reply to this email");
    assert.equal(second.debug.conversationTopic, "gmail_unsupported_action");
    assert.equal(second.debug.pendingOperation, false);
    assert.equal(second.reply, first.reply);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("E: revising a pending goal proposal replaces it — confirming applies the REVISED plan, not the original", async () => {
  const { server, userId } = await seededServer();
  try {
    const originalPlan: MockPlan["operations"] = [
      op("goal.create_propose", {
        title: "Apply to 3 jobs per week",
        category: "career",
        successCriteria: "3 applications per week",
        signals: [{ key: "applications_sent", label: "applications sent", cadence: "weekly" }],
        firstActions: []
      })
    ];
    mockPlan({ topic: "goals", intent: "propose_goal_creation", operations: originalPlan, needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "I want to find a new developer job, apply to 3 jobs per week");

    const revisedPlan: MockPlan["operations"] = [
      op("goal.create_propose", {
        title: "Find a new developer job",
        category: "career",
        signals: [
          { key: "applications_sent", label: "applications sent", cadence: "daily" },
          { key: "recruiter_replies", label: "recruiter replies", cadence: "daily" }
        ],
        firstActions: []
      })
    ];
    mockPlan({ topic: "goals", intent: "propose_goal_creation", operations: revisedPlan, needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const revised = await sendAgentMessage(server, userId, "3 per week is too low, no fixed target, just track how much I send");
    assert.equal(revised.debug.pendingOperation, true);

    const confirmed = await sendAgentMessage(server, userId, "yes");
    assert.equal(confirmed.debug.mutationExecuted, true);

    const applied = await prisma.goal.findFirst({ where: { userId, title: "Find a new developer job" } });
    assert.ok(applied, "the REVISED title must have been created");
    const original = await prisma.goal.findFirst({ where: { userId, title: "Apply to 3 jobs per week" } });
    assert.equal(original, null, "the original, superseded proposal must never have been created");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("F: 'cancel' after a revision cancels the revised proposal, not the original", async () => {
  const { server, userId } = await seededServer();
  try {
    const originalPlan: MockPlan["operations"] = [
      op("goal.create_propose", {
        title: "Apply to 3 jobs per week",
        category: "career",
        signals: [{ key: "applications_sent", label: "applications sent", cadence: "weekly" }],
        firstActions: []
      })
    ];
    mockPlan({ topic: "goals", intent: "propose_goal_creation", operations: originalPlan, needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "I want to find a new developer job, apply to 3 jobs per week");

    const revisedPlan: MockPlan["operations"] = [
      op("goal.create_propose", {
        title: "Find a new developer job",
        category: "career",
        signals: [{ key: "applications_sent", label: "applications sent", cadence: "daily" }],
        firstActions: []
      })
    ];
    mockPlan({ topic: "goals", intent: "propose_goal_creation", operations: revisedPlan, needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "no fixed target, just track how much I send");

    const cancelled = await sendAgentMessage(server, userId, "cancel");
    assert.equal(cancelled.debug.pendingOperation, false);

    const anyGoal = await prisma.goal.findFirst({ where: { userId } });
    assert.equal(anyGoal, null, "no goal — original or revised — must have been created after cancel");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("G: 'help me set up' deterministically starts the operator onboarding flow, without calling the planner", async () => {
  const { server, userId } = await seededServer();
  try {
    const reply = await sendAgentMessage(server, userId, "help me set up");

    assert.equal(reply.debug.llmPlannerAttempted, false);
    assert.equal(reply.debug.conversationTopic, "operator_onboarding");
    assert.match(reply.reply, /communicate|talk to you|gentle|balanced|blunt/i);
    assert.match(reply.reply, /gmail/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("H: a new user with no goals asking a broad operator question is offered the guided setup option", async () => {
  const { server, userId } = await seededServer();
  try {
    const reply = await sendAgentMessage(server, userId, "what can you help with?");

    assert.equal(reply.debug.conversationTopic, "goal_anchor_nudge");
    assert.match(reply.reply, /set me up/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("I: operator_profile.propose_update opens a pending confirmation, and confirming actually updates the stored profile", async () => {
  const { server, userId } = await seededServer();
  try {
    mockPlan({
      topic: "setup",
      intent: "set_style",
      operations: [op("operator_profile.propose_update", { directness: "blunt" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const proposeReply = await sendAgentMessage(server, userId, "be blunt with me");
    assert.equal(proposeReply.debug.pendingOperation, true);
    assert.equal(proposeReply.debug.mutationExecuted, false);

    const confirmReply = await sendAgentMessage(server, userId, "yes");
    assert.equal(confirmReply.debug.mutationExecuted, true);

    const profile = await prisma.userOperatingProfile.findUnique({ where: { userId } });
    assert.equal(profile?.directness, 5);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("J: operator_profile.apply_update can never be planned directly by the LLM — only reachable via confirm", async () => {
  const { server, userId } = await seededServer();
  try {
    mockPlan({
      topic: "setup",
      intent: "set_style",
      operations: [op("operator_profile.apply_update", { directness: 5 })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "be blunt with me");

    assert.equal(reply.debug.mutationExecuted, false);
    const profile = await prisma.userOperatingProfile.findUnique({ where: { userId } });
    assert.equal(profile?.directness ?? 3, 3, "a direct operator_profile.apply_update plan must never mutate the profile away from its default");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
