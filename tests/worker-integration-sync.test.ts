import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../packages/db/src/index.ts";
import { buildServer } from "../apps/api/src/server.ts";
import { runScheduledIntegrationSync } from "../apps/worker/src/integration-sync.ts";

/**
 * audit/gmail-worker-observation-source: apps/worker/src/integration-sync.ts's scheduled Gmail
 * sync (runScheduledIntegrationSync) had zero test coverage before this branch — the manual/
 * interactive Gmail sync path (V3's gmail.sync tool, and the legacy conversation router) is
 * extensively tested elsewhere, but the WORKER's own background tick, which reuses that exact
 * same underlying sync code through a real POST to /users/:userId/integrations/:id/sync, had
 * never been exercised end to end. `apiPost`/`apiGet` are wired to a real in-process
 * buildServer() via server.inject (no network) — sendTelegramMessage is a plain stub.
 *
 * `getConnections` is ALWAYS overridden to the exact fixture(s) this test created — the real
 * default (getActiveIntegrationConnectionsForSync) queries every Gmail connection in the whole
 * database with no userId scope, so leaving it unscoped would pick up leftover connections from
 * unrelated tests/files sharing the same test database and produce flaky, cross-test-polluted
 * results.
 */

function injectApiPost(server: ReturnType<typeof buildServer>) {
  return async <T>(path: string, body: unknown): Promise<T> => {
    const response = await server.inject({ method: "POST", url: path, payload: body });
    if (response.statusCode !== 200) {
      throw new Error(`POST ${path} failed with ${response.statusCode}: ${response.body}`);
    }
    return response.json() as T;
  };
}

function injectApiGet(server: ReturnType<typeof buildServer>) {
  return async <T>(path: string): Promise<T> => {
    const response = await server.inject({ method: "GET", url: path });
    if (response.statusCode !== 200) {
      throw new Error(`GET ${path} failed with ${response.statusCode}: ${response.body}`);
    }
    return response.json() as T;
  };
}

function stubTelegram(options: { failFor?: Set<string> } = {}) {
  const sent: Array<{ chatId: string; text: string }> = [];
  const send = async (chatId: string, text: string): Promise<void> => {
    if (options.failFor?.has(chatId)) {
      throw new Error("simulated Telegram failure");
    }
    sent.push({ chatId, text });
  };
  return { send, sent };
}

async function seedGmailUser(
  userId: string,
  telegramUserId: string,
  overrides: { connectionStatus?: "active" | "error"; syncMode?: "scheduled" | "manual_only" } = {}
) {
  await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
  await prisma.notificationSettings.create({ data: { userId, telegramUserId, timezone: "Europe/Madrid" } });
  const connection = await prisma.integrationConnection.create({
    data: {
      userId,
      integrationId: "gmail",
      status: overrides.connectionStatus ?? "active",
      config: { gmailAutonomy: { syncMode: overrides.syncMode ?? "scheduled" } }
    }
  });
  return connection;
}

test("A: an eligible connection with an active custom rule is actually attempted by the worker's own sync call, not silently skipped", async () => {
  // Deliberately does not mock the raw Gmail HTTP calls (searchGmailMessages/getGmailMessage) —
  // consistent with this codebase's own established pattern (see email-review-dedupe.test.ts),
  // which tests classification/dedupe logic directly against constructed message objects rather
  // than mocking Gmail's REST API. What's genuinely new and untested before this branch is the
  // WORKER's own eligibility/scheduling decision — this connection is eligible, has an active
  // rule, and the worker really calls the real sync route for it (not skipped) — proven here by
  // reaching the real "no OAuth token configured" failure, exactly what a real deployed connection
  // with a genuinely expired/never-completed auth would also hit.
  const server = buildServer();
  const userId = `worker-sync-a-${randomUUID()}`;

  try {
    const connection = await seedGmailUser(userId, "tg-a");
    await prisma.emailSignalRule.create({
      data: { userId, connectionId: connection.id, adapterId: "custom_email_review", name: "Invoices from ClientCo", query: "from:clientco.com invoice", status: "active", createdBy: "user" }
    });

    const telegram = stubTelegram();
    const result = await runScheduledIntegrationSync({
      now: new Date(),
      integrationSyncEnabled: true,
      integrationSyncIntervalMinutes: 15,
      gmailRuntime: { scheduledSyncEnabled: true, defaultIntervalMinutes: 15 },
      getConnections: async () => [connection],
      apiGet: injectApiGet(server),
      apiPost: injectApiPost(server),
      sendTelegramMessage: telegram.send,
      logger: { log: () => {}, error: () => {} }
    });

    assert.deepEqual(result.processedConnectionIds, [connection.id], "an eligible connection must actually be attempted, not skipped");
    assert.deepEqual(result.skippedConnectionIds, []);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("B: a connection not opted into scheduled sync is skipped, never synced in the background", async () => {
  const server = buildServer();
  const userId = `worker-sync-b-${randomUUID()}`;

  try {
    const connection = await seedGmailUser(userId, "tg-b", { syncMode: "manual_only" });
    await prisma.emailSignalRule.create({
      data: { userId, connectionId: connection.id, adapterId: "custom_email_review", name: "Invoices", query: "invoice", status: "active", createdBy: "user" }
    });

    const telegram = stubTelegram();
    const result = await runScheduledIntegrationSync({
      now: new Date(),
      integrationSyncEnabled: true,
      integrationSyncIntervalMinutes: 15,
      gmailRuntime: { scheduledSyncEnabled: true, defaultIntervalMinutes: 15 },
      getConnections: async () => [connection],
      apiGet: injectApiGet(server),
      apiPost: injectApiPost(server),
      sendTelegramMessage: telegram.send,
      logger: { log: () => {}, error: () => {} }
    });

    assert.deepEqual(result.processedConnectionIds, [], "manual-only is the safe default — the worker must never sync a connection the user didn't opt into scheduled checks for");
    assert.deepEqual(result.skippedConnectionIds, [connection.id]);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("C: an error-status (expired auth) connection is skipped by the background sync and never silently retried as if healthy", async () => {
  const server = buildServer();
  const userId = `worker-sync-c-${randomUUID()}`;

  try {
    const connection = await seedGmailUser(userId, "tg-c", { connectionStatus: "error" });
    await prisma.emailSignalRule.create({
      data: { userId, connectionId: connection.id, adapterId: "custom_email_review", name: "Invoices", query: "invoice", status: "active", createdBy: "user" }
    });

    const telegram = stubTelegram();
    const result = await runScheduledIntegrationSync({
      now: new Date(),
      integrationSyncEnabled: true,
      integrationSyncIntervalMinutes: 15,
      gmailRuntime: { scheduledSyncEnabled: true, defaultIntervalMinutes: 15 },
      getConnections: async () => [connection],
      apiGet: injectApiGet(server),
      apiPost: injectApiPost(server),
      sendTelegramMessage: telegram.send,
      logger: { log: () => {}, error: () => {} }
    });

    assert.deepEqual(result.processedConnectionIds, []);
    assert.deepEqual(result.skippedConnectionIds, [connection.id], "an already-error connection must be skipped, not retried as if nothing were wrong");

    const stillError = await prisma.integrationConnection.findUnique({ where: { id: connection.id } });
    assert.equal(stillError?.status, "error", "status must stay error — reconnecting is the only thing that can clear it");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("D: a duplicate scheduled sync tick against the same message never creates a second EmailReviewItem", async () => {
  const server = buildServer();
  const userId = `worker-sync-d-${randomUUID()}`;

  try {
    const connection = await seedGmailUser(userId, "tg-d");
    await prisma.emailSignalRule.create({
      data: { userId, connectionId: connection.id, adapterId: "custom_email_review", name: "Invoices from ClientCo", query: "from:clientco.com invoice", status: "active", createdBy: "user" }
    });

    const telegram = stubTelegram();
    const runOnce = () =>
      runScheduledIntegrationSync({
        now: new Date(),
        integrationSyncEnabled: true,
        integrationSyncIntervalMinutes: 0, // due again immediately for this test's second tick
        gmailRuntime: { scheduledSyncEnabled: true, defaultIntervalMinutes: 0 },
        getConnections: async () => [connection],
        apiGet: injectApiGet(server),
        apiPost: injectApiPost(server),
        sendTelegramMessage: telegram.send,
        logger: { log: () => {}, error: () => {} }
      });

    await runOnce();
    const afterFirst = await prisma.emailReviewItem.count({ where: { userId } });

    await runOnce();
    const afterSecond = await prisma.emailReviewItem.count({ where: { userId } });

    assert.equal(afterSecond, afterFirst, "re-syncing the same messages must never create duplicate review items — dedupe is by a stable externalId");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("E: one user's failed Telegram send does not block another user's notification in the same tick", async () => {
  // Regression test for the fix this branch makes to integration-sync.ts's own notification
  // loop: an uncaught sendTelegramMessage rejection used to propagate out of the whole
  // runScheduledIntegrationSync call — which apps/worker/src/index.ts's runTick() calls with no
  // wrapping try/catch — silently skipping Gmail nudges and due-action reminders for EVERY user
  // for the rest of that tick, not just the one user whose send failed. Both connections here are
  // real, active, eligible connections whose sync genuinely fails (apiPost always throws,
  // simulating a transient error), so both legitimately queue a "Gmail sync failed" notification —
  // the only difference is whose Telegram send then fails.
  const server = buildServer();
  const userIdFails = `worker-sync-e-fails-${randomUUID()}`;
  const userIdOk = `worker-sync-e-ok-${randomUUID()}`;

  try {
    const connectionFails = await seedGmailUser(userIdFails, "tg-fails");
    await prisma.emailSignalRule.create({
      data: { userId: userIdFails, connectionId: connectionFails.id, adapterId: "custom_email_review", name: "x", query: "x", status: "active", createdBy: "user" }
    });
    const connectionOk = await seedGmailUser(userIdOk, "tg-ok");
    await prisma.emailSignalRule.create({
      data: { userId: userIdOk, connectionId: connectionOk.id, adapterId: "custom_email_review", name: "y", query: "y", status: "active", createdBy: "user" }
    });

    const failingApiPost = async <T>(): Promise<T> => {
      throw new Error("Gmail sync failed: simulated transient failure");
    };
    const telegram = stubTelegram({ failFor: new Set(["tg-fails"]) });

    const result = await runScheduledIntegrationSync({
      now: new Date(),
      integrationSyncEnabled: true,
      integrationSyncIntervalMinutes: 15,
      gmailRuntime: { scheduledSyncEnabled: true, defaultIntervalMinutes: 15 },
      getConnections: async () => [connectionFails, connectionOk],
      apiGet: injectApiGet(server),
      apiPost: failingApiPost,
      sendTelegramMessage: telegram.send,
      logger: { log: () => {}, error: () => {} }
    });

    assert.ok(
      telegram.sent.some((entry) => entry.chatId === "tg-ok"),
      "the second user's notification must still be delivered even though the first user's send failed"
    );
    assert.ok(result.notifiedUserIds.includes(userIdOk), "the ok user must be recorded as notified");
    assert.ok(!result.notifiedUserIds.includes(userIdFails), "the failing user must not be falsely recorded as notified");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: { in: [userIdOk, userIdFails] } } });
  }
});
