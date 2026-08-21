import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createActionItem, prisma } from "../packages/db/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, mockPlan, op, sendAgentMessage, seedUser } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * Two tiny, obvious copy bugs found during the V3 planner-context audit (audit/v3-planner-context):
 *
 * 1. "show me more actions" after a page that already showed EVERY open action (nothing was
 *    actually truncated) just re-printed the identical numbered list — indistinguishable from
 *    the request having been ignored. action.list now recognizes this shape and says "That's all
 *    N open actions — nothing more to show." instead of repeating the list.
 *
 * 2. The explicit-index-out-of-range clarification (validator.ts's own complete, user-ready
 *    sentence, e.g. "I only showed 8 actions. Use a number from 1-8...") was being wrapped a
 *    second time by response-composer.ts's generic "I couldn't {action} because {error}. Nothing
 *    was changed." template, producing a redundant, doubly-punctuated composite line. A new
 *    `standaloneError` flag on ValidatedOperation tells response-composer.ts to use an
 *    already-complete error message as-is.
 */

test("'show more actions' when everything is already shown says so, instead of repeating the list", async () => {
  const server = buildServer();
  const userId = `action-list-copy-more-${randomUUID()}`;

  try {
    await seedUser(userId);
    await createActionItem(userId, { source: "manual", title: "Renew passport" });
    await createActionItem(userId, { source: "manual", title: "Book dentist appointment" });

    mockPlan({ topic: "actions", intent: "list_actions", operations: [op("action.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const firstList = await sendAgentMessage(server, userId, "show me my actions");
    assert.match(firstList.reply, /you have 2 open actions:/i);

    mockPlan({ topic: "actions", intent: "list_actions_more", operations: [op("action.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    const moreReply = await sendAgentMessage(server, userId, "show me more actions");

    assert.match(moreReply.reply, /that's all 2 open actions/i);
    assert.doesNotMatch(moreReply.reply, /1\. renew passport/i, "must not silently repeat the same numbered list");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("the explicit-index out-of-range clarification is not double-wrapped by the generic correction template", async () => {
  const server = buildServer();
  const userId = `action-list-copy-dedupe-${randomUUID()}`;

  try {
    await seedUser(userId);
    for (const title of ["Task one", "Task two", "Task three"]) {
      await createActionItem(userId, { source: "manual", title });
    }

    mockPlan({ topic: "actions", intent: "list_actions", operations: [op("action.list", {})], needsClarification: false, clarificationQuestion: null, replyDraft: "" });
    await sendAgentMessage(server, userId, "show me my actions");

    const rows = await prisma.actionItem.findMany({ where: { userId } });
    mockPlan({
      topic: "actions",
      intent: "complete",
      operations: [op("action.complete", { actionId: rows[0]!.id })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "complete action 10");

    assert.equal(
      reply.reply,
      'I only showed 3 actions. Use a number from 1–3, or say "show more actions".',
      "the validator's own complete sentence must be used as-is, never re-wrapped in \"I couldn't ... because ...\""
    );
    assert.doesNotMatch(reply.reply, /i couldn't/i);
    assert.doesNotMatch(reply.reply, /\.\./, "must never produce a doubled trailing period");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
