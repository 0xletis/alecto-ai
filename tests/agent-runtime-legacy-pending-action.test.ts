import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createPendingAction, getPendingActions, prisma } from "../packages/db/src/index.ts";
import { buildServer } from "../apps/api/src/server.ts";

/**
 * PendingAction / Agent Runtime v3 interop (Option A). A legacy PendingAction
 * row created by a slash-command flow (/action_hygiene, a Gmail rule
 * proposal, etc.) is now detected by v3's context loader and handled
 * deterministically before the planner ever runs — v3 never executes the
 * legacy applyPendingAction logic itself. See
 * docs/09-architecture-inventory.md for the full design rationale.
 */

interface MockPlan {
  topic: string;
  intent: string;
  operations: Array<{ tool: string; args: unknown; rationale?: string }>;
  needsClarification: boolean;
  clarificationQuestion: string | null;
  replyDraft: string;
}

function op(tool: string, args: unknown = {}, rationale?: string) {
  return { tool, args, rationale };
}

function mockPlan(plan: MockPlan): void {
  process.env.AGENT_RUNTIME_PLANNER_MOCK_RESPONSE = JSON.stringify(plan);
}

function clearMocks(): void {
  delete process.env.AGENT_RUNTIME_PLANNER_MOCK_RESPONSE;
  delete process.env.AGENT_RUNTIME_PLANNER_MOCK_THROW;
}

async function send(server: ReturnType<typeof buildServer>, userId: string, message: string) {
  const response = await server.inject({
    method: "POST",
    url: "/agent/message",
    payload: { userId, message, channel: "telegram" }
  });
  assert.equal(response.statusCode, 200, message);
  return response.json();
}

test("1. no PendingAction: normal Telegram message still routes to v3 normally", async () => {
  const server = buildServer();
  const userId = `legacy-pending-none-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });

    mockPlan({
      topic: "action_cleanup",
      intent: "list_open_actions",
      operations: [op("action.list", {})],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: "Here are your open actions."
    });

    const result = await send(server, userId, "what's on my plate today");
    assert.equal(result.debug.legacyPendingActionDetected, false);
    assert.equal(result.debug.plannerUsed, "llm");
    assert.equal(result.operationsExecuted[0]?.tool, "action.list");
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2 & 5. active PendingAction: ambiguous normal message does not reach the planner, explains pending state", async () => {
  const server = buildServer();
  const userId = `legacy-pending-ambiguous-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    await createPendingAction(userId, {
      type: "action_hygiene",
      summary: "Archive 2 stale actions?",
      payload: {}
    });

    // Deliberately no mockPlan: if the planner were invoked (a bug), there would be no mock
    // response configured for it to use, so asserting plannerUsed === "none" below is a real
    // guarantee the planner never ran, not just a happy-path coincidence.
    const result = await send(server, userId, "log a workout of 30 minutes running");
    assert.equal(result.debug.legacyPendingActionDetected, true);
    assert.equal(result.debug.plannerUsed, "none");
    assert.equal(result.debug.llmPlannerAttempted, false);
    assert.equal(result.operationsExecuted.length, 0);
    assert.match(result.reply, /pending action from the previous flow/i);
    assert.match(result.reply, /Archive 2 stale actions\?/);
    assert.match(result.reply, /confirm.*cancel/i);

    const stillPending = await getPendingActions(userId);
    assert.equal(stillPending.length, 1);
    assert.equal(stillPending[0].status, "pending");
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3. exact confirm with active PendingAction: v3 defers to /confirm instead of executing it", async () => {
  const server = buildServer();
  const userId = `legacy-pending-confirm-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    await createPendingAction(userId, {
      type: "goal_create",
      summary: "Create goal: Ship the launch",
      payload: { title: "Ship the launch", category: "career" }
    });

    const result = await send(server, userId, "yes");
    assert.equal(result.debug.legacyPendingActionDetected, true);
    assert.equal(result.debug.plannerUsed, "none");
    assert.equal(result.debug.mutationExecuted, false);
    assert.equal(result.operationsExecuted[0]?.status, "skipped");
    assert.match(result.reply, /\/confirm/);

    // The row must be untouched: still "pending", and no Goal was created by v3.
    const stillPending = await getPendingActions(userId);
    assert.equal(stillPending.length, 1);
    assert.equal(stillPending[0].status, "pending");
    const goals = await prisma.goal.findMany({ where: { userId } });
    assert.equal(goals.length, 0);
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4. exact cancel with active PendingAction: v3 safely rejects it directly", async () => {
  const server = buildServer();
  const userId = `legacy-pending-cancel-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    const created = await createPendingAction(userId, {
      type: "action_hygiene",
      summary: "Archive 2 stale actions?",
      payload: {}
    });

    const result = await send(server, userId, "cancel");
    assert.equal(result.debug.legacyPendingActionDetected, true);
    assert.equal(result.debug.plannerUsed, "none");
    assert.equal(result.operationsExecuted[0]?.status, "executed");
    assert.equal(result.reply, "Cancelled. I did not change anything.");

    const row = await prisma.pendingAction.findUnique({ where: { id: created.id } });
    assert.equal(row?.status, "rejected");

    // A follow-up message must now route normally — the pending action no longer blocks it.
    mockPlan({
      topic: "action_cleanup",
      intent: "list_open_actions",
      operations: [op("action.list", {})],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: "Here are your open actions."
    });
    const followUp = await send(server, userId, "what's open");
    assert.equal(followUp.debug.legacyPendingActionDetected, false);
    assert.equal(followUp.debug.plannerUsed, "llm");
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("6. v3's own pendingOperation takes precedence and is never confused with a legacy PendingAction", async () => {
  const server = buildServer();
  const userId = `legacy-pending-vs-v3-pending-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    await prisma.integrationConnection.create({
      data: { userId, integrationId: "gmail", status: "active", config: {} }
    });

    mockPlan({
      topic: "gmail_tracking_endesa",
      intent: "create_review_first_gmail_rule",
      operations: [op("gmail.rule.create", { label: "Endesa bills" }, "user wants Endesa bill tracking")],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: "I can watch for Endesa bill emails. Want me to set that up?"
    });
    const proposal = await send(server, userId, "track Endesa bills from Gmail");
    assert.equal(proposal.needsConfirmation, true);
    assert.equal(proposal.debug.conversationTopic, "gmail_rule_creation");
    assert.equal(proposal.debug.legacyPendingActionDetected, false, "no legacy row exists yet at proposal time");

    // A legacy PendingAction shows up mid-conversation (e.g. the user ran /action_hygiene as a
    // slash command in between), while v3's own pendingOperation is still open.
    const legacy = await createPendingAction(userId, {
      type: "action_hygiene",
      summary: "Archive 2 stale actions?",
      payload: {}
    });

    // "yes" here must resolve v3's OWN pendingOperation (the Gmail rule), not the legacy one.
    const confirmed = await send(server, userId, "yes");
    assert.equal(confirmed.debug.mutationExecuted, true);
    assert.equal(confirmed.operationsExecuted[0]?.tool, "gmail.rule.create");
    assert.match(confirmed.reply, /Endesa/i);

    const rules = await prisma.emailSignalRule.findMany({ where: { userId } });
    assert.equal(rules.length, 1, "v3's pendingOperation must have executed, not been blocked by the legacy row");

    // The legacy PendingAction must remain completely untouched by the "yes" above.
    const legacyRow = await prisma.pendingAction.findUnique({ where: { id: legacy.id } });
    assert.equal(legacyRow?.status, "pending");
  } finally {
    clearMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("7. slash-command HTTP routes for pending actions are unchanged by the v3 interop", async () => {
  const server = buildServer();
  const userId = `legacy-pending-routes-unchanged-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    await createPendingAction(userId, {
      type: "action_hygiene",
      summary: "Archive 2 stale actions?",
      payload: {}
    });

    const list = await server.inject({ method: "GET", url: `/users/${userId}/pending-actions` });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().pendingActions.length, 1);

    const pendingActionId = list.json().pendingActions[0].id;
    const reject = await server.inject({
      method: "POST",
      url: `/users/${userId}/pending-actions/${pendingActionId}/reject`
    });
    assert.equal(reject.statusCode, 200);
    assert.equal(reject.json().reply, "Cancelled. I did not change anything.");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
