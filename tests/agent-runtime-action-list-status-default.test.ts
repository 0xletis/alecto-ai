import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createActionItem } from "../packages/db/src/index.ts";
import {
  buildServer,
  clearAgentRuntimeMocks,
  mockPlan,
  op,
  prisma,
  sendAgentMessage,
  seedUser,
  type MockPlan
} from "./helpers/agent-runtime-test-helpers.ts";

/**
 * Regression coverage for the action.list status-default bug found right after the bulk-archive
 * fix: "show me my actions," right after archiving two actions, came back as "Showing 2 of 4
 * actions" re-listing the just-archived items with no status label — as if they were still open.
 * action.list's own executor default (status "open" when omitted) was already correct; the gap
 * was that nothing stopped the PLANNER from supplying a different status for a plain request, or
 * from carrying over "all" from a recent "archive all" turn in the same conversation.
 */

async function seedTwoOpenActions(userId: string): Promise<{ networking: string; jobBoards: string }> {
  const networking = await createActionItem(userId, { source: "manual", title: "Network with industry contacts", priority: "medium" });
  const jobBoards = await createActionItem(userId, { source: "manual", title: "Search job boards", priority: "medium" });
  return { networking: networking.id, jobBoards: jobBoards.id };
}

test("A: after action.archive_all_apply, a default action.list never shows the just-archived actions", async () => {
  const server = buildServer();
  const userId = `action-list-status-a-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedTwoOpenActions(userId);

    const bulkArchive = await sendAgentMessage(server, userId, "delete all my actions");
    assert.equal(bulkArchive.debug.pendingOperation, true);
    await sendAgentMessage(server, userId, "yes");

    mockPlan({ topic: "actions", intent: "list_actions", operations: [op("action.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const listReply = await sendAgentMessage(server, userId, "show me my actions");

    assert.match(listReply.reply, /don't have any open actions/i);
    assert.doesNotMatch(listReply.reply, /network with industry contacts/i);
    assert.doesNotMatch(listReply.reply, /search job boards/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("B: 'show me my actions' forces status=open even when the planner mistakenly supplies something else", async () => {
  const server = buildServer();
  const userId = `action-list-status-b-${randomUUID()}`;
  try {
    await seedUser(userId);
    const { networking } = await seedTwoOpenActions(userId);
    await prisma.actionItem.update({ where: { id: networking }, data: { status: "archived" } });

    // Simulates the real reported bug: the planner supplies status "all" (perhaps carried over
    // from a recent "archive all" turn) for a plain "show me my actions" request.
    mockPlan({ topic: "actions", intent: "list_actions", operations: [op("action.list", { status: "all" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "show me my actions");

    assert.doesNotMatch(reply.reply, /network with industry contacts/i, "the deterministic guard must force status=open, ignoring the planner's wrong status");
    assert.match(reply.reply, /search job boards/i);
    assert.match(reply.reply, /you have 1 open action/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("C: 'show all my actions' may include archived/completed items, each clearly labeled by status", async () => {
  const server = buildServer();
  const userId = `action-list-status-c-${randomUUID()}`;
  try {
    await seedUser(userId);
    const { networking, jobBoards } = await seedTwoOpenActions(userId);
    await prisma.actionItem.update({ where: { id: networking }, data: { status: "archived" } });

    mockPlan({ topic: "actions", intent: "list_actions", operations: [op("action.list", { status: "all" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "show all my actions, including archived ones");

    assert.match(reply.reply, /network with industry contacts.*— archived/i);
    assert.match(reply.reply, /search job boards/i);
    assert.doesNotMatch(reply.reply, /search job boards.*— archived/i, "the still-open action must not be mislabeled as archived");

    void jobBoards;
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("D: a purely archived-actions view carries no 'complete/snooze/archive' reply instructions", async () => {
  const server = buildServer();
  const userId = `action-list-status-d-${randomUUID()}`;
  try {
    await seedUser(userId);
    const { networking, jobBoards } = await seedTwoOpenActions(userId);
    await prisma.actionItem.update({ where: { id: networking }, data: { status: "archived" } });
    await prisma.actionItem.update({ where: { id: jobBoards }, data: { status: "archived" } });

    mockPlan({ topic: "actions", intent: "list_actions", operations: [op("action.list", { status: "archived" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "show me archived actions");

    assert.doesNotMatch(reply.reply, /reply:\s*complete/i, "instructions that only apply to open actions must not appear under an all-archived list");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("E: dailyCoachingInterest never creates real Alecto-duty ActionItems that could later leak into a list/archive cycle", async () => {
  const server = buildServer();
  const userId = `action-list-status-e-${randomUUID()}`;
  try {
    await seedUser(userId);
    const plan: MockPlan["operations"] = [
      op("goal.create_propose", {
        title: "Find a fully remote Web3 developer job",
        category: "career",
        signals: [{ key: "applications_sent", label: "applications sent", cadence: "daily" }],
        firstActions: [],
        dailyCoachingInterest: true
      })
    ];
    mockPlan({ topic: "goals", intent: "propose_goal_creation", operations: plan, needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "I want to find a remote Web3 dev job, and I want daily motivation");
    await sendAgentMessage(server, userId, "yes");

    const actions = await prisma.actionItem.findMany({ where: { userId } });
    assert.equal(actions.length, 0, "a dailyCoachingInterest goal must never create real ActionItem rows for Alecto's own responsibilities");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("F: exact live transcript — archive all -> yes -> show me my actions reports no open actions", async () => {
  const server = buildServer();
  const userId = `action-list-status-f-${randomUUID()}`;
  try {
    await seedUser(userId);
    await createActionItem(userId, { source: "manual", title: "Create action items for the day", priority: "medium" });
    await createActionItem(userId, { source: "manual", title: "Send a motivational message each morning", priority: "medium" });

    mockPlan({ topic: "actions", intent: "list_actions", operations: [op("action.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const t1 = await sendAgentMessage(server, userId, "show me my actions");
    assert.match(t1.reply, /create action items for the day/i);
    assert.match(t1.reply, /send a motivational message each morning/i);

    const t2 = await sendAgentMessage(server, userId, "archive all");
    assert.equal(t2.debug.pendingOperation, true);
    assert.match(t2.reply, /create action items for the day/i);
    assert.match(t2.reply, /send a motivational message each morning/i);

    const t3 = await sendAgentMessage(server, userId, "yes");
    assert.equal(t3.debug.mutationExecuted, true);
    assert.match(t3.reply, /archived 2 actions/i);

    mockPlan({ topic: "actions", intent: "list_actions", operations: [op("action.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const t4 = await sendAgentMessage(server, userId, "show me my actions");
    assert.match(t4.reply, /don't have any open actions/i);
    assert.doesNotMatch(t4.reply, /create action items for the day/i);
    assert.doesNotMatch(t4.reply, /send a motivational message each morning/i);

    const openCount = await prisma.actionItem.count({ where: { userId, status: "open" } });
    assert.equal(openCount, 0);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
