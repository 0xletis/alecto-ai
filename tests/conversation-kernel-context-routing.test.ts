import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createActionItem, createGoal, prisma } from "../packages/db/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, mockPlan, op, seedUser, sendAgentMessage } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * fix/private-alpha-conversation-kernel-context-routing: a real reported conversation-state
 * problem, not another one-off regex patch.
 *
 * Root cause 1 — session.setVisibleEntities (conversation-session.ts) used to be a WHOLESALE
 * replace: any turn producing entities of even ONE type (e.g. goal.status returning a single
 * `goal` entity) silently wiped out every OTHER type's previously-shown list (a numbered action
 * list, a Gmail review list). Now merges per type — each surface (action/gmail_review/goal/...)
 * keeps its own last-shown list independently, and each entity is stamped with `surfacedAt` so
 * mostRecentVisibleSurfaceType can tell which surface the user actually looked at last.
 *
 * Root cause 2 — "remove all" right after "show me email reviews" routed to
 * action.archive_all_propose (bulkActionCleanupShortcutOperation's own `hasVisibleActions` gate
 * only ever checked "does ANY action entity exist somewhere in visibleEntities," never "is that
 * the surface actually being talked about"), and "remove all mail reviews" routed to
 * gmail.disconnect_propose (GMAIL_DISCONNECT_RE has no idea "mail reviews" means the review
 * QUEUE). A new gmailReviewBulkTriageShortcut, checked before both, now owns this class of
 * message whenever Gmail reviews are visible and either the wording is explicit ("...mail
 * reviews") or reviews are genuinely the most-recently-shown surface.
 *
 * Root cause 3 — only an EXACT "cancel"/"no" (nothing else in the message) was ever recognized as
 * a cancellation; "cancel, I mean X" fell straight through to the pending-operation firewall,
 * which can only confirm/cancel/re-explain the SAME stale pending operation. A new CANCEL_WITH_
 * CORRECTION_RE now cancels the pending operation AND routes the corrected request in the same turn.
 */

async function seedJobSearchGoal(userId: string) {
  const result = await createGoal(userId, { title: "Find a fully remote developer job", category: "career" });
  if (result.duplicate) throw new Error("unexpected duplicate goal in test setup");
  return result.goal;
}

async function seedGmailConnection(userId: string, email = "letis.ether@gmail.com") {
  return prisma.integrationConnection.create({ data: { userId, integrationId: "gmail", status: "active", config: { email, provider: "gmail" } } });
}

async function seedRule(userId: string, connectionId: string, goalId: string) {
  return prisma.emailSignalRule.create({
    data: {
      userId,
      connectionId,
      goalId,
      adapterId: "job_search_email",
      name: "Job search emails",
      status: "active",
      fetchStrategy: "query",
      classifierMode: "rules",
      lookbackDays: 30,
      maxMessagesPerSync: 25,
      maxEventsPerSync: 10,
      minAutoLogConfidence: 0.9,
      minReviewConfidence: 0.65,
      domain: "career",
      notifyPolicy: "notify",
      createdBy: "user"
    }
  });
}

async function seedReviews(userId: string, connectionId: string, ruleId: string, count: number) {
  for (let i = 0; i < count; i++) {
    await prisma.emailReviewItem.create({
      data: {
        userId,
        connectionId,
        ruleId,
        adapterId: "job_search_email",
        provider: "gmail",
        providerMessageId: `m-${randomUUID()}`,
        externalId: `gmail-review:${ruleId}:${randomUUID()}`,
        status: "pending",
        subject: `Review ${i}`,
        from: "x@example.com",
        snippet: `Review ${i}`,
        evidence: `Review ${i}`,
        confidence: 0.7,
        reason: "rules_match",
        proposedEventType: "career.recruiter_reply_received",
        extracted: {}
      }
    });
  }
}

// --- Part 2: typed visible surfaces persist independently ------------------------------------

test("2A. show actions then show goal progress does not erase the action list", async () => {
  const server = buildServer();
  const userId = `frame-2a-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedJobSearchGoal(userId);
    await createActionItem(userId, { source: "manual", title: "Send 3 CVs", priority: "high" });

    mockPlan({ topic: "actions", intent: "list", operations: [op("action.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "show me my actions");

    mockPlan({ topic: "goal_status", intent: "status", operations: [op("goal.status", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "show my goal progress");

    mockPlan({ topic: "actions", intent: "complete", operations: [op("action.complete", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "complete action 1");
    assert.match(reply.reply, /complete/i);
    assert.doesNotMatch(reply.reply, /only showed 0 actions/i);

    const action = await prisma.actionItem.findFirst({ where: { userId } });
    assert.equal(action?.status, "completed");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("5E. each surface keeps its own visible refs — showing reviews after actions doesn't erase the action list either", async () => {
  const server = buildServer();
  const userId = `frame-5e-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goal = await seedJobSearchGoal(userId);
    await createActionItem(userId, { source: "manual", title: "Send 3 CVs", priority: "high" });
    const connection = await seedGmailConnection(userId);
    const rule = await seedRule(userId, connection.id, goal.id);
    await seedReviews(userId, connection.id, rule.id, 2);

    mockPlan({ topic: "actions", intent: "list", operations: [op("action.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "show me my actions");

    await sendAgentMessage(server, userId, "show me the reviews");

    mockPlan({ topic: "actions", intent: "complete", operations: [op("action.complete", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "complete action 1");
    assert.doesNotMatch(reply.reply, /only showed 0 actions/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("D. back-to-back messages for the same user process sequentially, never interleaved", async () => {
  const server = buildServer();
  const userId = `frame-d-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedJobSearchGoal(userId);
    await createActionItem(userId, { source: "manual", title: "Send 3 CVs", priority: "high" });

    mockPlan({ topic: "actions", intent: "list", operations: [op("action.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const [first, second] = await Promise.all([
      sendAgentMessage(server, userId, "show me my actions"),
      sendAgentMessage(server, userId, "show me my actions")
    ]);
    assert.match(first.reply, /Send 3 CVs/);
    assert.match(second.reply, /Send 3 CVs/);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Part 3 / 5: Gmail review bulk triage vs. action archive vs. account disconnect -----------

test("3A/5A. after showing Gmail reviews, 'remove all' routes to review triage, never action archive", async () => {
  const server = buildServer();
  const userId = `route-3a-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goal = await seedJobSearchGoal(userId);
    await createActionItem(userId, { source: "manual", title: "Send 3 CVs", priority: "high" });
    const connection = await seedGmailConnection(userId);
    const rule = await seedRule(userId, connection.id, goal.id);
    await seedReviews(userId, connection.id, rule.id, 10);

    await sendAgentMessage(server, userId, "show me email reviews");
    const reply = await sendAgentMessage(server, userId, "remove all as I already counted them when I sent the update");

    assert.ok(!reply.operationsExecuted.some((o) => o.tool.startsWith("action.archive")), "must never route to action archive");
    assert.ok(reply.operationsExecuted.every((o) => o.tool === "gmail.review.reject"));
    assert.match(reply.reply, /did not delete any emails/i);
    assert.match(reply.reply, /already counted/i);

    const action = await prisma.actionItem.findFirst({ where: { userId } });
    assert.equal(action?.status, "open", "the unrelated action must never be touched");

    const reviews = await prisma.emailReviewItem.findMany({ where: { userId } });
    assert.equal(reviews.filter((r) => r.status === "rejected").length, 10);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3B/5C. 'remove all mail reviews' routes to review triage, never Gmail account disconnect", async () => {
  const server = buildServer();
  const userId = `route-3b-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goal = await seedJobSearchGoal(userId);
    const connection = await seedGmailConnection(userId);
    const rule = await seedRule(userId, connection.id, goal.id);
    await seedReviews(userId, connection.id, rule.id, 3);

    await sendAgentMessage(server, userId, "show me email reviews");
    const reply = await sendAgentMessage(server, userId, "remove all mail reviews");

    assert.ok(!reply.operationsExecuted.some((o) => o.tool === "gmail.disconnect_propose"));
    assert.ok(reply.operationsExecuted.every((o) => o.tool === "gmail.review.reject"));

    const connectionAfter = await prisma.integrationConnection.findUnique({ where: { id: connection.id } });
    assert.equal(connectionAfter?.status, "active", "the Gmail account itself must never be touched");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3C. 'disconnect Gmail account' (real account-lifecycle wording) still routes to disconnect", async () => {
  const server = buildServer();
  const userId = `route-3c-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedGmailConnection(userId);
    const reply = await sendAgentMessage(server, userId, "disconnect Gmail account");
    assert.ok(reply.operationsExecuted.some((o) => o.tool === "gmail.disconnect_propose"));
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("5B. plain 'reject all' with Gmail reviews visible rejects them all", async () => {
  const server = buildServer();
  const userId = `route-5b-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goal = await seedJobSearchGoal(userId);
    const connection = await seedGmailConnection(userId);
    const rule = await seedRule(userId, connection.id, goal.id);
    await seedReviews(userId, connection.id, rule.id, 4);

    await sendAgentMessage(server, userId, "show me email reviews");
    await sendAgentMessage(server, userId, "reject all");

    const reviews = await prisma.emailReviewItem.findMany({ where: { userId } });
    assert.equal(reviews.filter((r) => r.status === "rejected").length, 4);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("5D. 'delete these reviews' means reject the review queue, never a claim of deleting real email", async () => {
  const server = buildServer();
  const userId = `route-5d-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goal = await seedJobSearchGoal(userId);
    const connection = await seedGmailConnection(userId);
    const rule = await seedRule(userId, connection.id, goal.id);
    await seedReviews(userId, connection.id, rule.id, 2);

    await sendAgentMessage(server, userId, "show me email reviews");
    const reply = await sendAgentMessage(server, userId, "delete these reviews");

    assert.doesNotMatch(reply.reply, /deleted your email|deleted the email/i);
    const reviews = await prisma.emailReviewItem.findMany({ where: { userId } });
    assert.equal(reviews.filter((r) => r.status === "rejected").length, 2);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("5F. no visible reviews at all — bare 'remove all' does not falsely claim a review action", async () => {
  const server = buildServer();
  const userId = `route-5f-${randomUUID()}`;
  try {
    await seedUser(userId);
    await createActionItem(userId, { source: "manual", title: "Send 3 CVs", priority: "high" });

    mockPlan({ topic: "actions", intent: "list", operations: [op("action.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "show me my actions");

    mockPlan({ topic: "actions", intent: "archive_all", operations: [op("action.archive_all_propose", { scope: "visible" })], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const reply = await sendAgentMessage(server, userId, "remove all");
    // With no Gmail reviews visible at all, the bulk-review shortcut must not fire (returns []
    // immediately) — this falls through to whatever normally handles "remove all" for actions.
    assert.ok(!reply.operationsExecuted.some((o) => o.tool === "gmail.review.reject"));
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Part 4: pending confirmations can be superseded by a clear correction --------------------

test("4A/4B. bare 'cancel'/'no' alone still cancels a pending operation", async () => {
  const server = buildServer();
  const userId = `pending-4ab-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedGmailConnection(userId);
    await sendAgentMessage(server, userId, "disconnect Gmail");
    const reply = await sendAgentMessage(server, userId, "cancel");
    assert.equal(reply.debug.pendingOperation, false);
    assert.equal(reply.debug.mutationExecuted, false);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4C/4D/8-A. 'cancel, I mean remove all mail reviews' cancels the pending archive AND routes the corrected request, in one turn", async () => {
  const server = buildServer();
  const userId = `pending-4cd-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goal = await seedJobSearchGoal(userId);
    await createActionItem(userId, { source: "manual", title: "Send 3 CVs", priority: "high" });
    const connection = await seedGmailConnection(userId);
    const rule = await seedRule(userId, connection.id, goal.id);
    await seedReviews(userId, connection.id, rule.id, 3);

    // Simulate the exact reported bad first route: a bad plan opens an action-archive confirmation.
    await sendAgentMessage(server, userId, "show me email reviews");
    mockPlan({
      topic: "actions",
      intent: "archive_all",
      operations: [op("action.archive_all_propose", { scope: "visible" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const badRoute = await sendAgentMessage(server, userId, "remove all as I already counted them when I sent the update");
    void badRoute;
    clearAgentRuntimeMocks();

    const reply = await sendAgentMessage(server, userId, "cancel, i mean remove all mail reviews");
    assert.equal(reply.debug.pendingOperation, false, "the pending archive must be cancelled");
    assert.ok(reply.operationsExecuted.every((o) => o.tool === "gmail.review.reject"), "the corrected request must actually route to review triage in the same turn");

    const action = await prisma.actionItem.findFirst({ where: { userId } });
    assert.equal(action?.status, "open", "the action must never have been archived");
    const reviews = await prisma.emailReviewItem.findMany({ where: { userId } });
    assert.equal(reviews.filter((r) => r.status === "rejected").length, 3);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4E. a pending action archive does not block an unrelated 'show Gmail reviews' request", async () => {
  const server = buildServer();
  const userId = `pending-4e-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goal = await seedJobSearchGoal(userId);
    await createActionItem(userId, { source: "manual", title: "Send 3 CVs", priority: "high" });
    const connection = await seedGmailConnection(userId);
    const rule = await seedRule(userId, connection.id, goal.id);
    await seedReviews(userId, connection.id, rule.id, 2);

    mockPlan({ topic: "actions", intent: "list", operations: [op("action.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "show me my actions");
    mockPlan({
      topic: "actions",
      intent: "archive_all",
      operations: [op("action.archive_all_propose", { scope: "visible" })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    await sendAgentMessage(server, userId, "clean these up");
    clearAgentRuntimeMocks();

    // Gmail reviews are a fully independent topic — a real, unrelated request should not be
    // trapped behind an action-archive confirmation it has nothing to do with.
    const reply = await sendAgentMessage(server, userId, "show me email reviews");
    assert.match(reply.reply, /pending gmail reviews|review/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4F/3F. 'no' cancels a pending Gmail disconnect and does not block the next status request", async () => {
  const server = buildServer();
  const userId = `pending-4f-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedGmailConnection(userId);
    await sendAgentMessage(server, userId, "disconnect Gmail");
    const cancelReply = await sendAgentMessage(server, userId, "no");
    assert.equal(cancelReply.debug.pendingOperation, false);

    const statusReply = await sendAgentMessage(server, userId, "gmail status");
    assert.match(statusReply.reply, /connected/i);
    assert.doesNotMatch(statusReply.reply, /pending confirmation/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3G. after cancelling a pending disconnect, 'show me mail reviews' shows reviews, not just 'Cancelled'", async () => {
  const server = buildServer();
  const userId = `pending-3g-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goal = await seedJobSearchGoal(userId);
    const connection = await seedGmailConnection(userId);
    const rule = await seedRule(userId, connection.id, goal.id);
    await seedReviews(userId, connection.id, rule.id, 2);

    await sendAgentMessage(server, userId, "disconnect Gmail");
    await sendAgentMessage(server, userId, "no");

    const reply = await sendAgentMessage(server, userId, "show me mail reviews");
    assert.match(reply.reply, /pending gmail reviews/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Part 9 / 8: exact live transcript A regression ---------------------------------------------

test("8-A. exact live transcript A regression: show reviews -> remove all -> cancel+correction -> remove all mail reviews -> reject all", async () => {
  const server = buildServer();
  const userId = `live-a-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goal = await seedJobSearchGoal(userId);
    await createActionItem(userId, { source: "manual", title: "Send 3 CVs", priority: "high" });
    const connection = await seedGmailConnection(userId);
    const rule = await seedRule(userId, connection.id, goal.id);
    await seedReviews(userId, connection.id, rule.id, 10);

    await sendAgentMessage(server, userId, "show me email reviews");
    const t2 = await sendAgentMessage(server, userId, "remove all as I already counted them when I sent the update");
    assert.ok(!t2.operationsExecuted.some((o) => o.tool.startsWith("action.archive")), "never routes to action archive");
    assert.doesNotMatch(t2.reply, /deleted your email|deleted the email/i, "no emails deleted");

    const finalReviews = await prisma.emailReviewItem.findMany({ where: { userId } });
    assert.equal(finalReviews.filter((r) => r.status === "rejected").length, 10);

    const action = await prisma.actionItem.findFirst({ where: { userId } });
    assert.equal(action?.status, "open", "the unrelated action was never touched");
    assert.equal(t2.debug.pendingOperation, false, "never trapped behind an unrelated pending confirmation");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
