import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createActionItem, createGoal, prisma } from "../packages/db/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, mockPlan, op, sendAgentMessage, seedUser } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * fix/private-alpha-gm-greeting-vs-gmail-routing: a real Telegram transcript found a user
 * replying to their morning coaching brief with "Gm will send anything web3 dev that fits my
 * style" — "Gm," a common good-morning greeting, especially in crypto/Web3 culture, never Gmail —
 * routed to gmail.goal_watcher.propose_enable's "already covered" reply ("I'm already using
 * Gmail for 'Find a fully remote developer job...' ...") instead of continuing the coaching
 * conversation. Root cause: no deterministic regex anywhere in the codebase matches bare "gm" as
 * Gmail (confirmed by direct audit — every Gmail-named shortcut requires the full word "gmail"/
 * "mail"/"email") — this was a genuine real-LLM tool-choice mistake, primed by planner.ts's own
 * "Gmail is goal-driven by default for a job-search goal" instruction combined with the message
 * happening to mention job-search-adjacent language ("web3 dev"). Every test here deliberately
 * mocks the planner supplying a Gmail tool for a greeting-shaped message (exactly what a real
 * planner mistake looks like) and asserts the deterministic backstop in runtime.ts
 * (applyCoachFirstResponseRouting's isGreetingWithoutGmailIntent gate, response-mode.ts) strips
 * it before it can ever execute — while a message with genuine explicit Gmail language still
 * lets the real Gmail tool run.
 */

function gmailProposePlan(goalId: string, replyDraft: string) {
  return {
    topic: "gmail",
    intent: "gmail_goal_watcher",
    operations: [op("gmail.goal_watcher.propose_enable", { goalId })],
    needsClarification: false,
    clarificationQuestion: null,
    replyDraft
  };
}

function gmailStatusPlan(replyDraft: string) {
  return {
    topic: "gmail_status",
    intent: "gmail_status",
    operations: [op("gmail.status", { includeLink: false })],
    needsClarification: false,
    clarificationQuestion: null,
    replyDraft
  };
}

async function seedJobSearchGoal(userId: string) {
  const goalResult = await createGoal(userId, { title: "Find a fully remote developer job, ideally in Web3", category: "career" });
  if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
  return goalResult.goal;
}

// --- Task 2: A-G ----------------------------------------------------------------------------------

test("A. 'gm' alone — greeting/coaching, no Gmail operation", async () => {
  const server = buildServer();
  const userId = `gm-a-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goal = await seedJobSearchGoal(userId);

    const coachingReply = "Morning! Ready to make progress on the job search today?";
    mockPlan(gmailProposePlan(goal.id, coachingReply));
    const reply = await sendAgentMessage(server, userId, "gm");

    assert.equal(reply.reply, coachingReply, `expected the coaching replyDraft, not a Gmail reply — got: ${reply.reply}`);
    assert.ok(!reply.operationsExecuted.some((o) => o.tool.startsWith("gmail.")), "no Gmail operation should have executed");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("B. exact live transcript: 'Gm will send anything web3 dev that fits my style' — coaching response, no Gmail operation", async () => {
  const server = buildServer();
  const userId = `gm-b-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goal = await seedJobSearchGoal(userId);

    const coachingReply =
      "GM. Good — but \"anything Web3 dev that fits my style\" is still broad. Aim for remote frontend/full-stack Web3 roles where your profile has an edge. Today's minimum is still 3 CVs.";
    mockPlan(gmailProposePlan(goal.id, coachingReply));
    const reply = await sendAgentMessage(server, userId, "Gm will send anything web3 dev that fits my style");

    assert.equal(reply.reply, coachingReply, `expected the real coaching answer, not the Gmail 'already covered' line — got: ${reply.reply}`);
    assert.doesNotMatch(reply.reply, /already using gmail/i);
    assert.ok(!reply.operationsExecuted.some((o) => o.tool.startsWith("gmail.")));
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("C. 'GM, I'll send CVs today' — coaching/progress response, no Gmail operation", async () => {
  const server = buildServer();
  const userId = `gm-c-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goal = await seedJobSearchGoal(userId);

    const coachingReply = "Good morning — sending CVs today keeps the momentum going. What's stopping you from starting with one right now?";
    mockPlan(gmailProposePlan(goal.id, coachingReply));
    const reply = await sendAgentMessage(server, userId, "GM, I'll send CVs today");

    assert.equal(reply.reply, coachingReply);
    assert.ok(!reply.operationsExecuted.some((o) => o.tool.startsWith("gmail.")));
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("D. 'good morning, what are you watching in Gmail?' — Gmail status allowed, explicit Gmail phrase present", async () => {
  const server = buildServer();
  const userId = `gm-d-${randomUUID()}`;
  try {
    await seedUser(userId);

    mockPlan(gmailStatusPlan("Here's what I'm watching in Gmail."));
    const reply = await sendAgentMessage(server, userId, "good morning, what are you watching in Gmail?");

    assert.ok(reply.operationsExecuted.some((o) => o.tool === "gmail.status"), `expected gmail.status to actually run — got: ${JSON.stringify(reply.operationsExecuted)}`);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("E. 'gmail status' still works", async () => {
  const server = buildServer();
  const userId = `gm-e-${randomUUID()}`;
  try {
    await seedUser(userId);

    mockPlan(gmailStatusPlan("Gmail is connected."));
    const reply = await sendAgentMessage(server, userId, "gmail status");

    assert.ok(reply.operationsExecuted.some((o) => o.tool === "gmail.status"));
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("F. 'sync Gmail' still works", async () => {
  const server = buildServer();
  const userId = `gm-f-${randomUUID()}`;
  try {
    await seedUser(userId);
    await prisma.integrationConnection.create({ data: { userId, integrationId: "gmail", status: "active", config: {} } });

    const reply = await sendAgentMessage(server, userId, "sync Gmail");

    assert.ok(reply.operationsExecuted.some((o) => o.tool === "gmail.sync"), `expected gmail.sync to run — got: ${JSON.stringify(reply.operationsExecuted)}`);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("G. 'are you using my mail for this goal?' — Gmail status/support still works", async () => {
  const server = buildServer();
  const userId = `gm-g-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedJobSearchGoal(userId);

    const reply = await sendAgentMessage(server, userId, "are you using my mail for this goal?");

    assert.ok(reply.operationsExecuted.some((o) => o.tool === "gmail.status"), `expected the deterministic gmail-goal-usage shortcut to answer — got: ${JSON.stringify(reply.operationsExecuted)}`);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 3: morning brief reply continuity A-D ----------------------------------------------------

test("3A/B/C/D. after a morning brief, 'gm will send anything web3 dev that fits my style' gets a coaching answer anchoring the existing action, no mutation, no Gmail", async () => {
  const server = buildServer();
  const userId = `gm-morning-abcd-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goal = await seedJobSearchGoal(userId);
    const action = await createActionItem(userId, { source: "manual", title: "Send 3 CVs", priority: "high", dueAt: new Date(Date.now() + 6 * 60 * 60 * 1000), goalId: goal.id });

    const coachingReply =
      'GM. Good — but "anything Web3 dev that fits my style" is still broad. You already have "Send 3 CVs" due today. Aim for remote frontend/full-stack Web3 roles where your profile has an edge — today\'s minimum is still 3 CVs.';
    mockPlan(gmailProposePlan(goal.id, coachingReply));
    const reply = await sendAgentMessage(server, userId, "Gm will send anything web3 dev that fits my style");

    // A: a real coaching answer, not a Gmail reply
    assert.equal(reply.reply, coachingReply);
    // B: the existing due action named as the anchor
    assert.match(reply.reply, /send 3 cvs/i);
    // C: no mutation
    assert.equal(reply.debug.mutationExecuted, false);
    const untouched = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(untouched?.dueAt?.getTime(), action.dueAt?.getTime());
    // D: no Gmail status reply
    assert.doesNotMatch(reply.reply, /already using gmail|gmail is connected|watching in gmail/i);
    assert.ok(!reply.operationsExecuted.some((o) => o.tool.startsWith("gmail.")));
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 4: response-mode guard A-C ---------------------------------------------------------------

test("4A. greeting + soft intention -> coach mode, no Gmail, no mutation", async () => {
  const server = buildServer();
  const userId = `gm-mode-a-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goal = await seedJobSearchGoal(userId);

    mockPlan(gmailProposePlan(goal.id, "No rush — what's one small step you can take right now?"));
    const reply = await sendAgentMessage(server, userId, "morning, I'll try to get to some applications later");

    assert.equal(reply.debug.mutationExecuted, false);
    assert.ok(!reply.operationsExecuted.some((o) => o.tool.startsWith("gmail.")));
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4B. greeting + explicit action command -> action mutation allowed", async () => {
  const server = buildServer();
  const userId = `gm-mode-b-${randomUUID()}`;
  try {
    await seedUser(userId);
    const action = await createActionItem(userId, { source: "manual", title: "Send 3 CVs", priority: "high" });

    // Makes the action visible first (a real "show me my actions" turn) so the later
    // directly-supplied actionId is trusted with no title-grounding check — validator.ts's own
    // rule for "exactly one action visible, id matches" — same as a real conversation flow.
    mockPlan({ topic: "actions", intent: "list_actions", operations: [op("action.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "show me my actions");

    mockPlan({
      topic: "actions",
      intent: "reschedule",
      operations: [op("action.reschedule", { actionId: action.id, dueText: "tomorrow" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: "Moved it to tomorrow."
    });
    const reply = await sendAgentMessage(server, userId, "gm, reschedule it to tomorrow");

    assert.equal(reply.debug.mutationExecuted, true, "an explicit action command must still mutate even with a greeting opener");
    const updated = await prisma.actionItem.findUnique({ where: { id: action.id } });
    const actuallyMoved = Boolean(updated?.dueAt) || updated?.status === "snoozed";
    assert.ok(actuallyMoved, `expected the action to actually move — got: ${JSON.stringify(updated)}`);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4C. greeting + explicit Gmail command -> Gmail allowed", async () => {
  const server = buildServer();
  const userId = `gm-mode-c-${randomUUID()}`;
  try {
    await seedUser(userId);

    mockPlan(gmailStatusPlan("Gmail is connected."));
    const reply = await sendAgentMessage(server, userId, "gm, gmail status please");

    assert.ok(reply.operationsExecuted.some((o) => o.tool === "gmail.status"), `expected gmail.status to still run — got: ${JSON.stringify(reply.operationsExecuted)}`);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
