import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../packages/db/src/index.ts";
import { buildServer } from "../apps/api/src/server.ts";

/**
 * Conversation Orchestrator v2 has been fully retired: the
 * CONVERSATION_ORCHESTRATOR_V2_ENABLED branch in /messages/process, the
 * apps/api/src/conversation/{orchestrator-v2,context,operation-*,response-composer}.ts
 * modules, and tests/conversation-orchestrator-v2.test.ts are all deleted.
 * This is a small regression check that /messages/process still works
 * through the remaining legacy path exactly as before, and that setting the
 * now-meaningless env var has no effect (nothing reads it anymore).
 */

test("messages/process: still responds through the remaining legacy deterministic-surface path", async () => {
  const server = buildServer();
  const userId = `messages-process-legacy-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });

    const response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "what can you do" }
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(typeof body.reply, "string");
    assert.ok(body.reply.length > 0);
    assert.equal(body.routeDebug.routerSource, "deterministic_surface");
    assert.equal(body.routeDebug.handlerName, "handleConversationSurfaceIntent");
    // No Conversation Orchestrator v2 fields should ever appear again.
    assert.equal(body.routeDebug.v2Enabled, undefined);
    assert.equal(body.routeDebug.v2SkippedReason, undefined);
    assert.equal(body.routeDebug.orchestrator, undefined);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("messages/process: CONVERSATION_ORCHESTRATOR_V2_ENABLED=true is now inert — no code reads it", async () => {
  const server = buildServer();
  const userId = `messages-process-legacy-inert-flag-${randomUUID()}`;
  const previous = process.env.CONVERSATION_ORCHESTRATOR_V2_ENABLED;
  process.env.CONVERSATION_ORCHESTRATOR_V2_ENABLED = "true";

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });

    const response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "what can you do" }
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    // Identical to the flag-unset case above: same legacy router, same reply source.
    assert.equal(body.routeDebug.routerSource, "deterministic_surface");
    assert.equal(body.routeDebug.v2Enabled, undefined);
  } finally {
    if (previous === undefined) {
      delete process.env.CONVERSATION_ORCHESTRATOR_V2_ENABLED;
    } else {
      process.env.CONVERSATION_ORCHESTRATOR_V2_ENABLED = previous;
    }
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("agent/message: Agent Runtime v3 is unaffected by the Conversation Orchestrator v2 removal", async () => {
  const server = buildServer();
  const userId = `agent-v3-unaffected-by-v2-removal-${randomUUID()}`;

  process.env.AGENT_RUNTIME_PLANNER_MOCK_RESPONSE = JSON.stringify({
    topic: "action_cleanup",
    intent: "list_open_actions",
    operations: [{ tool: "action.list", args: {} }],
    needsClarification: false,
    clarificationQuestion: null,
    replyDraft: "Here are your open actions."
  });

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });

    const response = await server.inject({
      method: "POST",
      url: "/agent/message",
      payload: { userId, message: "what's on my plate today", channel: "telegram" }
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.debug.runtime, "agent_v3");
    assert.equal(body.operationsExecuted[0]?.tool, "action.list");
  } finally {
    delete process.env.AGENT_RUNTIME_PLANNER_MOCK_RESPONSE;
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
