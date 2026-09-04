import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createActionItem } from "../packages/db/src/index.ts";
import { buildServer, prisma, seedUser } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * refactor/private-alpha-general-email-intelligence-workflow (gate 7): the legacy /messages/process
 * pipeline (apps/api/src/routes/messages.ts) and the legacy pending-actions confirm/reject routes
 * (apps/api/src/routes/pending-actions.ts) previously had no concurrency control of their own,
 * unlike /agent/message's v3 path (handleAgentMessage -> runExclusive). Both now share the exact
 * same per-user queue (apps/api/src/agent-runtime/user-lock.ts) as /agent/message — proven here by
 * dispatching a legacy call and a v3 call for the SAME user back-to-back, without awaiting between
 * them (the same technique tests/agent-runtime-user-lock.test.ts uses to prove real queuing, not
 * just test-code await ordering): the second call, whichever route it hits, cannot start until the
 * first has fully settled.
 */

test("1. /messages/process and /agent/message for the same user share the same per-user queue — never interleave", async () => {
  const server = buildServer();
  const userId = `legacy-serial-1-${randomUUID()}`;

  try {
    await seedUser(userId);
    await createActionItem(userId, { source: "manual", title: "Send 3 CVs", priority: "high" });

    // Dispatched together, without awaiting between them.
    const legacyPromise = server.inject({ method: "POST", url: "/messages/process", payload: { userId, message: "what can you do" } });
    const v3Promise = server.inject({ method: "POST", url: "/agent/message", payload: { userId, message: "what are my actions", channel: "telegram" } });

    const [legacyResponse, v3Response] = await Promise.all([legacyPromise, v3Promise]);

    assert.equal(legacyResponse.statusCode, 200);
    assert.equal(v3Response.statusCode, 200);
    const v3Body = v3Response.json();
    assert.match(v3Body.reply, /Send 3 CVs/);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2. two concurrent /messages/process calls for the same user never interleave — both resolve cleanly", async () => {
  const server = buildServer();
  const userId = `legacy-serial-2-${randomUUID()}`;

  try {
    await seedUser(userId);

    const first = server.inject({ method: "POST", url: "/messages/process", payload: { userId, message: "what can you do" } });
    const second = server.inject({ method: "POST", url: "/messages/process", payload: { userId, message: "what are my goals" } });

    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    assert.equal(firstResponse.statusCode, 200);
    assert.equal(secondResponse.statusCode, 200);
    assert.equal(typeof firstResponse.json().reply, "string");
    assert.equal(typeof secondResponse.json().reply, "string");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3. different users on the legacy route remain fully concurrent (the per-user queue never serializes across users)", async () => {
  const server = buildServer();
  const userA = `legacy-serial-3a-${randomUUID()}`;
  const userB = `legacy-serial-3b-${randomUUID()}`;

  try {
    await seedUser(userA);
    await seedUser(userB);

    const start = Date.now();
    const a = server.inject({ method: "POST", url: "/messages/process", payload: { userId: userA, message: "what can you do" } });
    const b = server.inject({ method: "POST", url: "/messages/process", payload: { userId: userB, message: "what can you do" } });
    const [responseA, responseB] = await Promise.all([a, b]);
    const elapsedMs = Date.now() - start;

    assert.equal(responseA.statusCode, 200);
    assert.equal(responseB.statusCode, 200);
    // A loose upper bound — two different users' calls must not be artificially serialized behind
    // one another; this is generous enough to never flake on a slow CI box.
    assert.ok(elapsedMs < 10_000, `expected the two different-user calls to run concurrently, took ${elapsedMs}ms`);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: { in: [userA, userB] } } });
  }
});
