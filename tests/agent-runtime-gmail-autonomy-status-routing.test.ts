import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { configureAgentRuntimeServices, resetAgentRuntimeServicesForTests } from "../apps/api/src/agent-runtime/services.ts";
import { buildServer, clearAgentRuntimeMocks, prisma, sendAgentMessage, seedUser } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * Agent Runtime v3 Gmail autonomy status vs sync routing — a real Telegram smoke test found
 * "when do u check email?" (and "when do u check gmail?") triggering an actual gmail.sync
 * instead of the read-only gmail.autonomy.status tool. Root cause:
 * looksLikeGmailAutonomyStatusQuery (apps/api/src/agent-runtime/runtime.ts) required the literal
 * word "you" (or "it"/"alecto") between "when do" and "check" — the texting shorthand "u" never
 * matched, so the message fell through to gmailSyncShortcutOperation's broad "check ... gmail"
 * pattern instead, running a real sync (creating EmailReviewItems, taking 45-50s) for what was
 * only ever a status question. The fix widens looksLikeGmailAutonomyStatusQuery to also accept
 * "u", and adds a "do you check email automatically?" shape with no "when"/"how often" at all.
 * gmailSyncShortcutOperation itself already deferred to this same predicate before running a
 * sync (added in the previous Gmail-autonomy-settings task); widening it here fixes both
 * call sites without touching sync/OAuth/adaptive-matching/review-triage code at all.
 */

async function seedScheduledGmailUser(userId: string): Promise<string> {
  await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
  const connection = await prisma.integrationConnection.create({
    data: {
      userId,
      integrationId: "gmail",
      status: "active",
      config: { gmailAutonomy: { syncMode: "scheduled", syncIntervalMinutes: 60 } }
    }
  });
  return connection.id;
}

function mockSyncTracker() {
  const calls: string[] = [];
  configureAgentRuntimeServices({
    syncGmailForUser: async (userId: string) => {
      calls.push(userId);
      return "Gmail sync: 27 messages checked, 1 new review item.";
    }
  });
  return calls;
}

const STATUS_PHRASES = [
  ["A", "when do u check email?"],
  ["B", "when do u check gmail?"],
  ["C", "when do you check my email?"],
  ["D", "how often do you check Gmail?"],
  ["E", "is Gmail sync scheduled?"]
] as const;

for (const [label, phrase] of STATUS_PHRASES) {
  test(`${label}. '${phrase}' routes to gmail.autonomy.status, never calls sync, never creates reviews`, async () => {
    const server = buildServer();
    const userId = `gmail-autonomy-status-routing-${label}-${randomUUID()}`;

    try {
      await seedScheduledGmailUser(userId);
      const syncCalls = mockSyncTracker();

      const reply = await sendAgentMessage(server, userId, phrase);

      assert.deepEqual(reply.operationsPlanned.map((operation) => operation.tool), ["gmail.autonomy.status"], phrase);
      assert.match(reply.reply, /every hour/i, phrase);
      assert.match(reply.reply, /alerts are (on|off)/i, phrase);
      assert.doesNotMatch(reply.reply, /messages checked/i, phrase);
      assert.equal(reply.debug.mutationExecuted, false, phrase);
      assert.equal(syncCalls.length, 0, `${phrase} must never call the real sync service`);

      const reviews = await prisma.emailReviewItem.count({ where: { userId } });
      assert.equal(reviews, 0, `${phrase} must never create EmailReviewItems`);
    } finally {
      clearAgentRuntimeMocks();
      resetAgentRuntimeServicesForTests();
      await server.close();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });
}

test("F. regression: 'sync Gmail' still calls gmail.sync for real", async () => {
  const server = buildServer();
  const userId = `gmail-autonomy-status-routing-f-${randomUUID()}`;

  try {
    const connectionId = await seedScheduledGmailUser(userId);
    await prisma.emailSignalRule.create({ data: { userId, connectionId, adapterId: "custom_email_review", name: "Recruiter replies", status: "active", createdBy: "user" } });
    const syncCalls = mockSyncTracker();

    const reply = await sendAgentMessage(server, userId, "sync Gmail");

    assert.deepEqual(reply.operationsPlanned.map((operation) => operation.tool), ["gmail.sync"]);
    assert.match(reply.reply, /gmail sync: 27 messages checked/i);
    assert.equal(syncCalls.length, 1);
  } finally {
    clearAgentRuntimeMocks();
    resetAgentRuntimeServicesForTests();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("G. regression: 'check Gmail now' still calls gmail.sync for real", async () => {
  const server = buildServer();
  const userId = `gmail-autonomy-status-routing-g-${randomUUID()}`;

  try {
    const connectionId = await seedScheduledGmailUser(userId);
    await prisma.emailSignalRule.create({ data: { userId, connectionId, adapterId: "custom_email_review", name: "Recruiter replies", status: "active", createdBy: "user" } });
    const syncCalls = mockSyncTracker();

    const reply = await sendAgentMessage(server, userId, "check Gmail now");

    assert.deepEqual(reply.operationsPlanned.map((operation) => operation.tool), ["gmail.sync"]);
    assert.equal(syncCalls.length, 1);
  } finally {
    clearAgentRuntimeMocks();
    resetAgentRuntimeServicesForTests();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("H. regression: 'check Gmail every hour' still routes to gmail.autonomy.propose_update, not sync", async () => {
  const server = buildServer();
  const userId = `gmail-autonomy-status-routing-h-${randomUUID()}`;

  try {
    await seedUser(userId);
    await prisma.integrationConnection.create({ data: { userId, integrationId: "gmail", status: "active", config: {} } });
    const syncCalls = mockSyncTracker();

    const reply = await sendAgentMessage(server, userId, "check Gmail every hour");

    assert.deepEqual(reply.operationsPlanned.map((operation) => operation.tool), ["gmail.autonomy.propose_update"]);
    assert.match(reply.reply, /about to check gmail every hour/i);
    assert.equal(reply.debug.mutationExecuted, false);
    assert.equal(syncCalls.length, 0);
  } finally {
    clearAgentRuntimeMocks();
    resetAgentRuntimeServicesForTests();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
