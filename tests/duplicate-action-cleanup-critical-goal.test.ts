import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createActionItem, createGoal, prisma, snoozeActionItem } from "../packages/db/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, mockPlan, op, sendAgentMessage, seedUser } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * fix/private-alpha-live-action-and-coaching-regressions (Task 5): the duplicate-cleanup proposal
 * ("keep X, archive the duplicate Y?") applies its confirmed action.archive by re-entering
 * action.archive's own executor case — which, when the archived action is linked to a CRITICAL
 * goal, used to ask a SECOND "this is linked to a critical goal, archive only this action?"
 * confirmation, making the user say "yes" twice for the same single archive. Fixed by having the
 * duplicate-cleanup proposal disclose the critical-goal link in its OWN single confirmation
 * message and plan action.archive_all_apply directly (bypassing the redundant second gate) when
 * that link exists — never weakening action.archive's own guard for a DIRECT "archive it"
 * request, which is untouched (see test D).
 */

function actionListPlan(args: Record<string, unknown> = {}) {
  return { topic: "actions", intent: "list_actions", operations: [op("action.list", args)], needsClarification: false, clarificationQuestion: null, replyDraft: "" };
}

async function seedSimilarDeferredPair(userId: string, goalId?: string) {
  const first = await createActionItem(userId, { source: "manual", title: "Apply to 3 more remote Web3 roles today", goalId });
  await snoozeActionItem(userId, first.id, new Date(Date.now() + 24 * 60 * 60 * 1000));
  const second = await createActionItem(userId, { source: "manual", title: "Apply to 3 more remote Web3 roles by the end of the week", goalId });
  await snoozeActionItem(userId, second.id, new Date(Date.now() + 24 * 60 * 60 * 1000));
  return { first, second };
}

test("A. a duplicate linked to a critical goal discloses the link in the same proposal message", async () => {
  const server = buildServer();
  const userId = `dup-critical-a-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goalResult = await createGoal(userId, { title: "Find a fully remote Web3 developer job", category: "career", priority: "critical" });
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
    await seedSimilarDeferredPair(userId, goalResult.goal.id);

    mockPlan(actionListPlan({ when: "tomorrow" }));
    const reply = await sendAgentMessage(server, userId, "do i have something to do tomorrow?");

    assert.match(reply.reply, /similar actions scheduled/i);
    assert.match(reply.reply, /critical.*"Find a fully remote Web3 developer job"/i, `expected the critical-goal link disclosed up front — got: ${reply.reply}`);
    assert.match(reply.reply, /reply yes to confirm/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("B. confirming once actually archives the duplicate — no second critical-goal confirmation prompt", async () => {
  const server = buildServer();
  const userId = `dup-critical-b-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goalResult = await createGoal(userId, { title: "Find a fully remote Web3 developer job", category: "career", priority: "critical" });
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
    const { second } = await seedSimilarDeferredPair(userId, goalResult.goal.id);

    mockPlan(actionListPlan({ when: "tomorrow" }));
    await sendAgentMessage(server, userId, "do i have something to do tomorrow?");

    const reply = await sendAgentMessage(server, userId, "yes");

    assert.equal(reply.debug.mutationExecuted, true, "one 'yes' must actually archive the duplicate, not re-ask");
    assert.doesNotMatch(reply.reply, /archive only this action\?/i, "must never re-ask the critical-goal question a second time");
    assert.equal(reply.debug.pendingOperation, false, "nothing should still be pending after the single confirmation");

    const archived = await prisma.actionItem.findUnique({ where: { id: second.id } });
    assert.equal(archived?.status, "archived");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("C. a duplicate with no critical-goal link is completely unaffected by this change", async () => {
  const server = buildServer();
  const userId = `dup-critical-c-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goalResult = await createGoal(userId, { title: "Find a fully remote Web3 developer job", category: "career", priority: "medium" });
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
    const { second } = await seedSimilarDeferredPair(userId, goalResult.goal.id);

    mockPlan(actionListPlan({ when: "tomorrow" }));
    const proposal = await sendAgentMessage(server, userId, "do i have something to do tomorrow?");
    assert.doesNotMatch(proposal.reply, /critical/i);

    const reply = await sendAgentMessage(server, userId, "yes");
    assert.equal(reply.debug.mutationExecuted, true);
    const archived = await prisma.actionItem.findUnique({ where: { id: second.id } });
    assert.equal(archived?.status, "archived");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("D. a DIRECT 'archive it' request for a critical-goal-linked action still asks its own single confirmation, unchanged", async () => {
  const server = buildServer();
  const userId = `dup-critical-d-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goalResult = await createGoal(userId, { title: "Find a fully remote Web3 developer job", category: "career", priority: "critical" });
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
    const action = await createActionItem(userId, { source: "manual", title: "Apply to 5 roles", goalId: goalResult.goal.id, priority: "high" });

    // Makes the action visible first (a real "show me my actions" turn) so the later
    // directly-supplied actionId is trusted with no title-grounding check — validator.ts's own
    // rule for "exactly one action visible, id matches" — same as a real conversation flow.
    mockPlan(actionListPlan({}));
    await sendAgentMessage(server, userId, "show me my actions");

    mockPlan({ topic: "actions", intent: "archive", operations: [op("action.archive", { actionId: action.id })], needsClarification: false, clarificationQuestion: null, replyDraft: "Archived." });
    const reply = await sendAgentMessage(server, userId, "archive it");

    assert.match(reply.reply, /linked to a critical goal.*archive only this action/i, "the direct-archive guard must still fire exactly as before");
    assert.equal(reply.debug.mutationExecuted, false, "the direct path still requires its own confirmation, not weakened by Task 5");

    const untouched = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(untouched?.status, "open");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("E. confirming the critical-linked duplicate cleanup never touches the goal itself, only the duplicate action", async () => {
  const server = buildServer();
  const userId = `dup-critical-e-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goalResult = await createGoal(userId, { title: "Find a fully remote Web3 developer job", category: "career", priority: "critical" });
    if (goalResult.duplicate) throw new Error("unexpected duplicate goal in test setup");
    const { first, second } = await seedSimilarDeferredPair(userId, goalResult.goal.id);

    mockPlan(actionListPlan({ when: "tomorrow" }));
    await sendAgentMessage(server, userId, "do i have something to do tomorrow?");
    await sendAgentMessage(server, userId, "yes");

    const goal = await prisma.goal.findUnique({ where: { id: goalResult.goal.id } });
    assert.equal(goal?.status, "active", "the critical goal itself must remain completely untouched");
    const keptAction = await prisma.actionItem.findUnique({ where: { id: first.id } });
    assert.notEqual(keptAction?.status, "archived", "only the duplicate is archived, never the one being kept");
    const archivedAction = await prisma.actionItem.findUnique({ where: { id: second.id } });
    assert.equal(archivedAction?.status, "archived");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
