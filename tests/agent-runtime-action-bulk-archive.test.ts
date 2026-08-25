import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createActionItem, createGoal } from "../packages/db/src/index.ts";
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
 * Regression coverage for fix/private-alpha-action-bulk-archive — a real Railway smoke test found
 * "delete all my actions" / "archive all of them" treated as literal action TITLES to search for
 * ("I don't see an open action called 'All of them'"), "archive 1 and 2" replying as if it
 * succeeded while both actions stayed open, "yes create this" rejected as a confirmation, and
 * archiving a goal leaving its linked open actions silently open forever.
 */

async function seedTwoOpenActions(userId: string): Promise<{ networking: string; jobBoards: string }> {
  const networking = await createActionItem(userId, { source: "manual", title: "Network with industry contacts", priority: "medium" });
  const jobBoards = await createActionItem(userId, { source: "manual", title: "Search job boards", priority: "medium" });
  return { networking: networking.id, jobBoards: jobBoards.id };
}

// --- Task 2: bulk action cleanup intent ------------------------------------------------------

test("2A: 'delete all my actions' with 2 open actions opens a confirmation to archive both", async () => {
  const server = buildServer();
  const userId = `bulk-archive-2a-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedTwoOpenActions(userId);

    const reply = await sendAgentMessage(server, userId, "delete all my actions");

    assert.equal(reply.debug.llmPlannerAttempted, false, "must resolve deterministically, not via the planner");
    assert.equal(reply.debug.pendingOperation, true);
    assert.equal(reply.debug.mutationExecuted, false);
    assert.match(reply.reply, /archive/i);
    assert.match(reply.reply, /network with industry contacts/i);
    assert.match(reply.reply, /search job boards/i);
    assert.doesNotMatch(reply.reply, /i don't see an open action called/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2B: 'archive all of them' after action.list opens confirmation for the visible actions", async () => {
  const server = buildServer();
  const userId = `bulk-archive-2b-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedTwoOpenActions(userId);

    mockPlan({ topic: "actions", intent: "list_actions", operations: [op("action.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const listReply = await sendAgentMessage(server, userId, "show me my actions");
    assert.match(listReply.reply, /network with industry contacts/i);

    const reply = await sendAgentMessage(server, userId, "archive all of them");
    assert.equal(reply.debug.llmPlannerAttempted, false);
    assert.equal(reply.debug.pendingOperation, true);
    assert.match(reply.reply, /network with industry contacts/i);
    assert.match(reply.reply, /search job boards/i);
    assert.doesNotMatch(reply.reply, /i don't see an open action called/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2C: 'I mean all actions' resolves to all open actions, not a literal action title", async () => {
  const server = buildServer();
  const userId = `bulk-archive-2c-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedTwoOpenActions(userId);

    const reply = await sendAgentMessage(server, userId, "I mean all actions");
    assert.equal(reply.debug.llmPlannerAttempted, false);
    assert.equal(reply.debug.pendingOperation, true);
    assert.doesNotMatch(reply.reply, /i don't see an open action called/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2D: Spanish and Catalan bulk-cleanup phrases work", async () => {
  const server = buildServer();
  const esUserId = `bulk-archive-2d-es-${randomUUID()}`;
  const caUserId = `bulk-archive-2d-ca-${randomUUID()}`;
  try {
    await seedUser(esUserId);
    await seedTwoOpenActions(esUserId);
    const esReply = await sendAgentMessage(server, esUserId, "borra todas mis acciones");
    assert.equal(esReply.debug.llmPlannerAttempted, false, "Spanish bulk phrase must resolve deterministically");
    assert.equal(esReply.debug.pendingOperation, true);
    assert.doesNotMatch(esReply.reply, /i don't see an open action called/i);

    await seedUser(caUserId);
    await seedTwoOpenActions(caUserId);
    const caReply = await sendAgentMessage(server, caUserId, "arxiva totes les accions");
    assert.equal(caReply.debug.llmPlannerAttempted, false, "Catalan bulk phrase must resolve deterministically");
    assert.equal(caReply.debug.pendingOperation, true);
    assert.doesNotMatch(caReply.reply, /i don't see an open action called/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: { in: [esUserId, caUserId] } } });
  }
});

test("2E: zero open actions gives a clean no-op response, no confirmation opened", async () => {
  const server = buildServer();
  const userId = `bulk-archive-2e-${randomUUID()}`;
  try {
    await seedUser(userId);
    const reply = await sendAgentMessage(server, userId, "delete all my actions");

    assert.equal(reply.debug.pendingOperation, false);
    assert.equal(reply.debug.mutationExecuted, false);
    assert.match(reply.reply, /don't have any open actions/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2F: no overclaim before confirmation — nothing is archived until an explicit yes", async () => {
  const server = buildServer();
  const userId = `bulk-archive-2f-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedTwoOpenActions(userId);

    await sendAgentMessage(server, userId, "delete all my actions");

    const stillOpen = await prisma.actionItem.count({ where: { userId, status: "open" } });
    assert.equal(stillOpen, 2, "nothing may be archived before the user confirms");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 3: multi-action archive execution ---------------------------------------------------

test("3A/3B/3D: 'archive 1 and 2' — after action.list and confirmation — actually archives both, and action.list excludes them afterward", async () => {
  const server = buildServer();
  const userId = `bulk-archive-3a-${randomUUID()}`;
  try {
    await seedUser(userId);
    const { networking, jobBoards } = await seedTwoOpenActions(userId);

    mockPlan({ topic: "actions", intent: "list_actions", operations: [op("action.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "show me my actions");

    const archivePlan: MockPlan["operations"] = [op("action.archive", { actionId: networking }), op("action.archive", { actionId: jobBoards })];
    mockPlan({ topic: "actions", intent: "archive_actions", operations: archivePlan, needsClarification: false, clarificationQuestion: null, replyDraft: "Archiving the actions \"Network with industry contacts\" and \"Search job boards\"." });
    const archiveReply = await sendAgentMessage(server, userId, "archive 1 and 2");

    assert.equal(archiveReply.debug.mutationExecuted, false, "two actions in one turn must require confirmation, not execute immediately");
    assert.equal(archiveReply.debug.pendingOperation, true);
    assert.match(archiveReply.reply, /network with industry contacts/i, "the confirmation must name the real actions, matching visible refs to the right ids");
    assert.match(archiveReply.reply, /search job boards/i);

    const stillOpenBeforeConfirm = await prisma.actionItem.count({ where: { userId, status: "open" } });
    assert.equal(stillOpenBeforeConfirm, 2, "must not archive before the confirmation");

    const confirmed = await sendAgentMessage(server, userId, "yes");
    assert.equal(confirmed.debug.mutationExecuted, true);
    assert.match(confirmed.reply, /archived 2 actions/i);

    const [networkingRow, jobBoardsRow] = await Promise.all([
      prisma.actionItem.findUnique({ where: { id: networking } }),
      prisma.actionItem.findUnique({ where: { id: jobBoards } })
    ]);
    assert.equal(networkingRow?.status, "archived");
    assert.equal(jobBoardsRow?.status, "archived");

    mockPlan({ topic: "actions", intent: "list_actions", operations: [op("action.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const finalList = await sendAgentMessage(server, userId, "show me my actions");
    assert.doesNotMatch(finalList.reply, /network with industry contacts/i, "action.list must exclude archived actions");
    assert.doesNotMatch(finalList.reply, /search job boards/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3C: the pre-confirmation reply reflects a real grounded proposal, never the planner's own optimistic replyDraft", async () => {
  const server = buildServer();
  const userId = `bulk-archive-3c-${randomUUID()}`;
  try {
    await seedUser(userId);
    const { networking, jobBoards } = await seedTwoOpenActions(userId);

    mockPlan({ topic: "actions", intent: "list_actions", operations: [op("action.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "show me my actions");

    const archivePlan: MockPlan["operations"] = [op("action.archive", { actionId: networking }), op("action.archive", { actionId: jobBoards })];
    // A deliberately WRONG/optimistic replyDraft — must never leak into the reply once two
    // action.archive ops are collapsed into the grounded action.archive_all_propose confirmation.
    mockPlan({
      topic: "actions",
      intent: "archive_actions",
      operations: archivePlan,
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: "Archiving the actions \"Network with industry contacts\" and \"Search job boards\"."
    });
    const reply = await sendAgentMessage(server, userId, "archive 1 and 2");

    assert.doesNotMatch(reply.reply, /^archiving the actions/i, "must not show the planner's own present-tense optimistic claim verbatim");
    assert.match(reply.reply, /reply yes to confirm or cancel/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3E: stale/out-of-range refs are rejected safely, no partial mutation", async () => {
  const server = buildServer();
  const userId = `bulk-archive-3e-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedTwoOpenActions(userId);

    mockPlan({ topic: "actions", intent: "list_actions", operations: [op("action.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "show me my actions");

    const archivePlan: MockPlan["operations"] = [op("action.archive", {}), op("action.archive", {})];
    mockPlan({ topic: "actions", intent: "archive_actions", operations: archivePlan, needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "archive 1 and 5");

    assert.equal(reply.debug.mutationExecuted, false);
    assert.equal(reply.debug.pendingOperation, false, "an out-of-range reference must not open any confirmation");
    const stillOpen = await prisma.actionItem.count({ where: { userId, status: "open" } });
    assert.equal(stillOpen, 2, "no partial mutation on the valid ref when another ref is invalid");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 4: goal archive handles linked open actions -------------------------------------------

test("4A/4E: archiving a goal with linked open actions includes them in the SAME confirmation, and nothing is archived before yes", async () => {
  const server = buildServer();
  const userId = `bulk-archive-4a-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goalResult = await createGoal(userId, { title: "Job search", category: "career", priority: "medium" });
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
    const goal = goalResult.goal;
    const linkedAction = await createActionItem(userId, { source: "manual", title: "Apply to 5 roles today", priority: "medium", goalId: goal.id, goalTitleSnapshot: goal.title });

    const proposeReply = await sendAgentMessage(server, userId, "archive my job search goal");

    assert.equal(proposeReply.debug.pendingOperation, true);
    assert.equal(proposeReply.debug.mutationExecuted, false);
    assert.match(proposeReply.reply, /open action/i);
    assert.match(proposeReply.reply, /apply to 5 roles today/i);

    const beforeGoal = await prisma.goal.findUnique({ where: { id: goal.id } });
    const beforeAction = await prisma.actionItem.findUnique({ where: { id: linkedAction.id } });
    assert.equal(beforeGoal?.status, "active");
    assert.equal(beforeAction?.status, "open");

    const confirmed = await sendAgentMessage(server, userId, "yes");
    assert.equal(confirmed.debug.mutationExecuted, true);

    const afterGoal = await prisma.goal.findUnique({ where: { id: goal.id } });
    const afterAction = await prisma.actionItem.findUnique({ where: { id: linkedAction.id } });
    assert.equal(afterGoal?.status, "archived");
    assert.equal(afterAction?.status, "archived", "the linked open action must be archived together with its goal");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4B: 'start fresh' phrasing archives the goal and its linked open actions together", async () => {
  const server = buildServer();
  const userId = `bulk-archive-4b-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goalResult = await createGoal(userId, { title: "Job search", category: "career", priority: "medium" });
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
    const goal = goalResult.goal;
    const linkedAction = await createActionItem(userId, { source: "manual", title: "DM 3 recruiters today", priority: "medium", goalId: goal.id, goalTitleSnapshot: goal.title });

    await sendAgentMessage(server, userId, "delete my job search goal, I want to start fresh");
    const confirmed = await sendAgentMessage(server, userId, "yes");
    assert.equal(confirmed.debug.mutationExecuted, true);

    const afterGoal = await prisma.goal.findUnique({ where: { id: goal.id } });
    const afterAction = await prisma.actionItem.findUnique({ where: { id: linkedAction.id } });
    assert.equal(afterGoal?.status, "archived");
    assert.equal(afterAction?.status, "archived");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4C: unrelated actions (a different goal, or no goal at all) remain open after a goal archive", async () => {
  const server = buildServer();
  const userId = `bulk-archive-4c-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goalResult = await createGoal(userId, { title: "Job search", category: "career", priority: "medium" });
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
    const goal = goalResult.goal;
    const otherGoalResult = await createGoal(userId, { title: "Train for a marathon", category: "fitness", priority: "medium" });
    if (otherGoalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");

    const linkedAction = await createActionItem(userId, { source: "manual", title: "Apply to 5 roles today", priority: "medium", goalId: goal.id, goalTitleSnapshot: goal.title });
    const unrelatedLinkedAction = await createActionItem(userId, {
      source: "manual",
      title: "Run 5k today",
      priority: "medium",
      goalId: otherGoalResult.goal.id,
      goalTitleSnapshot: otherGoalResult.goal.title
    });
    const unlinkedAction = await createActionItem(userId, { source: "manual", title: "Buy groceries", priority: "medium" });

    await sendAgentMessage(server, userId, "archive my job search goal");
    await sendAgentMessage(server, userId, "yes");

    const [linkedRow, unrelatedRow, unlinkedRow] = await Promise.all([
      prisma.actionItem.findUnique({ where: { id: linkedAction.id } }),
      prisma.actionItem.findUnique({ where: { id: unrelatedLinkedAction.id } }),
      prisma.actionItem.findUnique({ where: { id: unlinkedAction.id } })
    ]);
    assert.equal(linkedRow?.status, "archived");
    assert.equal(unrelatedRow?.status, "open", "an action linked to a DIFFERENT goal must never be touched");
    assert.equal(unlinkedRow?.status, "open", "an action with no goal link at all must never be touched");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4D: critical goal safety confirmation still works alongside linked-action cleanup", async () => {
  const server = buildServer();
  const userId = `bulk-archive-4d-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goalResult = await createGoal(userId, { title: "Job search", category: "career", priority: "critical" });
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
    const goal = goalResult.goal;
    await createActionItem(userId, { source: "manual", title: "Apply to 5 roles today", priority: "medium", goalId: goal.id, goalTitleSnapshot: goal.title });

    const reply = await sendAgentMessage(server, userId, "archive my job search goal");

    assert.match(reply.reply, /marked critical/i, "the critical-goal friction line must still appear");
    assert.equal(reply.debug.mutationExecuted, false);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 5: extended confirmation phrases -----------------------------------------------------

test("5A/5B: 'yes create this' and 'yes create the goal' both confirm a pending goal creation", async () => {
  const server = buildServer();
  const userId = `bulk-archive-5ab-${randomUUID()}`;
  try {
    await seedUser(userId);
    const plan: MockPlan["operations"] = [op("goal.create_propose", { title: "Read more books", category: "learning", signals: [{ key: "pages_read", label: "pages read", cadence: "daily" }], firstActions: [] })];

    mockPlan({ topic: "goals", intent: "propose_goal_creation", operations: plan, needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "I want to read more books");
    const confirmedA = await sendAgentMessage(server, userId, "yes create this");
    assert.equal(confirmedA.debug.llmPlannerAttempted, false);
    assert.equal(confirmedA.debug.mutationExecuted, true);
    assert.ok(await prisma.goal.findFirst({ where: { userId, title: "Read more books" } }));

    const userId2 = `${userId}-b`;
    await seedUser(userId2);
    mockPlan({ topic: "goals", intent: "propose_goal_creation", operations: plan, needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId2, "I want to read more books");
    const confirmedB = await sendAgentMessage(server, userId2, "yes create the goal");
    assert.equal(confirmedB.debug.mutationExecuted, true);
    assert.ok(await prisma.goal.findFirst({ where: { userId: userId2, title: "Read more books" } }));

    await prisma.user.deleteMany({ where: { id: userId2 } });
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("5C: Spanish/Catalan 'yes create this' variants confirm a pending goal creation", async () => {
  const server = buildServer();
  const esUserId = `bulk-archive-5c-es-${randomUUID()}`;
  const caUserId = `bulk-archive-5c-ca-${randomUUID()}`;
  try {
    const plan: MockPlan["operations"] = [op("goal.create_propose", { title: "Read more books", category: "learning", signals: [{ key: "pages_read", label: "pages read", cadence: "daily" }], firstActions: [] })];

    await seedUser(esUserId);
    mockPlan({ topic: "goals", intent: "propose_goal_creation", operations: plan, needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, esUserId, "quiero leer más libros");
    const esConfirmed = await sendAgentMessage(server, esUserId, "vale crea esto");
    assert.equal(esConfirmed.debug.mutationExecuted, true);
    assert.ok(await prisma.goal.findFirst({ where: { userId: esUserId } }));

    await seedUser(caUserId);
    mockPlan({ topic: "goals", intent: "propose_goal_creation", operations: plan, needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, caUserId, "vull llegir més llibres");
    const caConfirmed = await sendAgentMessage(server, caUserId, "sí crea aquest");
    assert.equal(caConfirmed.debug.mutationExecuted, true);
    assert.ok(await prisma.goal.findFirst({ where: { userId: caUserId } }));
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: { in: [esUserId, caUserId] } } });
  }
});

test("5D: 'yes but change the target' revises instead of confirming", async () => {
  const server = buildServer();
  const userId = `bulk-archive-5d-${randomUUID()}`;
  try {
    await seedUser(userId);
    const plan: MockPlan["operations"] = [op("goal.create_propose", { title: "Read more books", category: "learning", signals: [{ key: "pages_read", label: "pages read", cadence: "daily" }], firstActions: [] })];
    mockPlan({ topic: "goals", intent: "propose_goal_creation", operations: plan, needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "I want to read more books");

    const revised: MockPlan["operations"] = [op("goal.create_propose", { title: "Read more books", category: "learning", successCriteria: "20 pages a day", signals: [{ key: "pages_read", label: "pages read", cadence: "daily" }], firstActions: [] })];
    mockPlan({ topic: "goals", intent: "propose_goal_creation", operations: revised, needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "yes but change the target to 20 pages a day");

    assert.equal(reply.debug.llmPlannerAttempted, true);
    assert.equal(reply.debug.mutationExecuted, false);
    assert.equal(await prisma.goal.count({ where: { userId } }), 0);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("5E: 'yes create this' with no pending operation does not mutate anything", async () => {
  const server = buildServer();
  const userId = `bulk-archive-5e-${randomUUID()}`;
  try {
    await seedUser(userId);
    const reply = await sendAgentMessage(server, userId, "yes create this");

    assert.equal(reply.debug.llmPlannerAttempted, false);
    assert.equal(reply.debug.mutationExecuted, false);
    assert.match(reply.reply, /don't have anything pending/i);
    assert.equal(await prisma.goal.count({ where: { userId } }), 0);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
