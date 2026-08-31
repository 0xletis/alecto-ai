import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createActionItem, prisma } from "../packages/db/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, mockPlan, op, sendAgentMessage, seedUser } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * fix/private-alpha-coach-first-response-routing (known gap carried over from the previous
 * branch): the shared candidate resolver `selectEmailRuleCandidate` (apps/api/src/conversation/
 * email-rule-selection.ts, used by BOTH action.reschedule's ref lookup and Gmail rule/review
 * selection) did literal contiguous-substring matching only — a real, specific reference like
 * "send CVs" never matched a title like "Send 3 CVs" because the embedded "3 " breaks
 * contiguity, even though every real word of the reference is genuinely present. Fixed with a
 * new fallback tier, only reached when the existing exact/substring tiers find NOTHING at all:
 * every significant word of the (stopword-stripped) reference must appear as its own whole word
 * somewhere in the candidate's name, order-independent. Never overrides a real exact/substring
 * match, and a genuinely ambiguous 2+-way match still falls through unresolved exactly as before.
 */

function reschedulePlan(ref: string, dueText = "today") {
  return { topic: "actions", intent: "reschedule", operations: [op("action.reschedule", { ref, dueText })], needsClarification: false, clarificationQuestion: null, replyDraft: "" };
}

test("A. 'send CVs' matches a title with an embedded number — 'Send 3 CVs'", async () => {
  const server = buildServer();
  const userId = `ref-token-a-${randomUUID()}`;
  try {
    await seedUser(userId);
    const action = await createActionItem(userId, { source: "manual", title: "Send 3 CVs", priority: "high" });

    mockPlan(reschedulePlan("send CVs"));
    const reply = await sendAgentMessage(server, userId, "move send CVs to today");

    assert.match(reply.reply, /send 3 cvs|today/i, `expected the action to actually be found — got: ${reply.reply}`);
    const updated = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.ok(updated?.dueAt, "the reschedule must actually apply once the title is correctly matched");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("B. an unrelated action with no shared words is never matched by the new token fallback", async () => {
  const server = buildServer();
  const userId = `ref-token-b-${randomUUID()}`;
  try {
    await seedUser(userId);
    await createActionItem(userId, { source: "manual", title: "Book flights to Lisbon", priority: "medium" });

    mockPlan(reschedulePlan("send CVs"));
    const reply = await sendAgentMessage(server, userId, "move send CVs to today");

    assert.match(reply.reply, /create|new action|don't see/i, `expected an honest no-match, never a false positive — got: ${reply.reply}`);
    const actions = await prisma.actionItem.findMany({ where: { userId } });
    assert.equal(actions.filter((a) => a.dueAt !== null).length, 0, "nothing should have been silently rescheduled");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("C. two candidates that both contain every reference word stay genuinely ambiguous — asks, no mutation", async () => {
  const server = buildServer();
  const userId = `ref-token-c-${randomUUID()}`;
  try {
    await seedUser(userId);
    const first = await createActionItem(userId, { source: "manual", title: "Send 3 CVs to remote roles", priority: "high" });
    const second = await createActionItem(userId, { source: "manual", title: "Send 2 CVs to Web3 startups", priority: "high" });

    mockPlan(reschedulePlan("send CVs"));
    await sendAgentMessage(server, userId, "move send CVs to today");

    const firstAfter = await prisma.actionItem.findUnique({ where: { id: first.id } });
    const secondAfter = await prisma.actionItem.findUnique({ where: { id: second.id } });
    assert.equal(firstAfter?.dueAt, null, "must not guess which one to move when genuinely ambiguous");
    assert.equal(secondAfter?.dueAt, null);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("D. an exact/substring match still wins outright — the new fallback never overrides it", async () => {
  const server = buildServer();
  const userId = `ref-token-d-${randomUUID()}`;
  try {
    await seedUser(userId);
    const exact = await createActionItem(userId, { source: "manual", title: "Send CVs", priority: "high" });
    // A decoy that would ALSO satisfy the new token-overlap fallback (contains both "send" and
    // "cvs" as whole words) — proves the pre-existing exact-substring tier still wins outright,
    // the new fallback tier is never even reached when a real match already exists.
    await createActionItem(userId, { source: "manual", title: "Remember to send CVs eventually", priority: "low" });

    mockPlan(reschedulePlan("send CVs"));
    await sendAgentMessage(server, userId, "move send CVs to today");

    const updated = await prisma.actionItem.findUnique({ where: { id: exact.id } });
    assert.ok(updated?.dueAt, "the exact match must resolve outright, not fall into ambiguity");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
