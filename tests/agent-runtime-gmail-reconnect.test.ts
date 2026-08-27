import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createPendingAction } from "../packages/db/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, getAgentSession, prisma, sendAgentMessage, seedUser } from "./helpers/agent-runtime-test-helpers.ts";

type OAuthEnvSnapshot = {
  GOOGLE_CLIENT_ID: string | undefined;
  GOOGLE_CLIENT_SECRET: string | undefined;
  GMAIL_REDIRECT_URI: string | undefined;
};

function installGmailOAuthEnv(): () => void {
  const previous: OAuthEnvSnapshot = {
    GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET: process.env.GOOGLE_CLIENT_SECRET,
    GMAIL_REDIRECT_URI: process.env.GMAIL_REDIRECT_URI
  };

  process.env.GOOGLE_CLIENT_ID = "test-gmail-client-id.apps.googleusercontent.com";
  process.env.GOOGLE_CLIENT_SECRET = "test-gmail-client-secret";
  process.env.GMAIL_REDIRECT_URI = "http://localhost:3000/oauth/gmail/callback";

  return () => {
    restoreEnv("GOOGLE_CLIENT_ID", previous.GOOGLE_CLIENT_ID);
    restoreEnv("GOOGLE_CLIENT_SECRET", previous.GOOGLE_CLIENT_SECRET);
    restoreEnv("GMAIL_REDIRECT_URI", previous.GMAIL_REDIRECT_URI);
  };
}

function restoreEnv(key: keyof OAuthEnvSnapshot, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

async function seedNotificationSettings(userId: string, gmailNudgeEnabled = false): Promise<void> {
  await prisma.notificationSettings.create({
    data: {
      userId,
      morningBriefEnabled: false,
      eveningCheckinEnabled: false,
      gmailNudgeEnabled
    }
  });
}

async function seedExpiredGmailConnection(userId: string): Promise<string> {
  const connection = await prisma.integrationConnection.create({
    data: {
      userId,
      integrationId: "gmail",
      status: "error",
      lastSyncedAt: new Date("2026-08-13T11:15:37.863Z"),
      lastError: "Gmail authorization expired. Reconnect Gmail.",
      config: {
        provider: "gmail",
        email: "user@example.com",
        accessToken: "must-not-leak-access-token",
        refreshToken: "must-not-leak-refresh-token",
        encryptedToken: {
          ciphertext: "must-not-leak-ciphertext",
          iv: "must-not-leak-iv",
          tag: "must-not-leak-tag"
        }
      }
    }
  });

  return connection.id;
}

async function seedActiveGmailRule(userId: string, connectionId: string, name = "Endesa bills"): Promise<void> {
  await prisma.emailSignalRule.create({
    data: {
      userId,
      connectionId,
      adapterId: "custom_email_review",
      name,
      status: "active",
      query: "Endesa",
      reviewBeforeLogging: true,
      createdBy: "user"
    }
  });
}

function assertContainsOAuthLink(reply: string): void {
  assert.match(reply, /https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
  assert.match(reply, /scope=https%3A%2F%2Fwww\.googleapis\.com%2Fauth%2Fgmail\.readonly/);
  assert.match(reply, /access_type=offline/);
  assert.match(reply, /prompt=consent/);
}

function assertNoGmailSecrets(payload: unknown): void {
  const text = JSON.stringify(payload);
  assert.doesNotMatch(text, /must-not-leak-access-token|must-not-leak-refresh-token|must-not-leak-ciphertext|must-not-leak-iv|must-not-leak-tag/i);
  assert.doesNotMatch(text, /\baccessToken\b|\brefreshToken\b|\bciphertext\b|"iv"|"tag"/i);
}

function plannedTools(reply: Awaited<ReturnType<typeof sendAgentMessage>>): string[] {
  return reply.operationsPlanned.map((operation) => operation.tool);
}

function assertNoGenericAgentError(reply: Awaited<ReturnType<typeof sendAgentMessage>>): void {
  assert.notEqual(reply.reply, "I hit an unexpected problem there — please try again.");
  assert.doesNotMatch(reply.reply, /unexpected problem/i);
}

function assertNoUserFacingNudge(reply: Awaited<ReturnType<typeof sendAgentMessage>>): void {
  assert.doesNotMatch(reply.reply, /\bnudges?\b/i);
}

test("V3 'turn on Gmail nudges' proposes Gmail alerts and does not crash or sync Gmail", async () => {
  const restore = installGmailOAuthEnv();
  const server = buildServer();
  const userId = `gmail-nudge-reconnect-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedNotificationSettings(userId, false);
    await seedExpiredGmailConnection(userId);

    const proposal = await sendAgentMessage(server, userId, "turn on Gmail nudges");

    assertNoGenericAgentError(proposal);
    assert.deepEqual(plannedTools(proposal), ["proactive.settings_propose_update"]);
    assert.equal(proposal.operationsPlanned[0]?.args.gmailNudgeEnabled, true);
    assert.equal(proposal.debug.mutationExecuted, false);
    assert.equal(proposal.needsConfirmation, true);
    assert.match(proposal.reply, /about to turn on Gmail alerts/i);
    assert.match(proposal.reply, /Gmail authorization is expired/i);
    assert.match(proposal.reply, /Gmail alerts won't work/i);
    assert.match(proposal.reply, /connect or reconnect Gmail/i);
    assertContainsOAuthLink(proposal.reply);
    assertNoGmailSecrets(proposal);
    assertNoUserFacingNudge(proposal);
    assert.ok(!plannedTools(proposal).some((tool) => tool.toLowerCase().includes("sync")), "nudge setting must not run Gmail sync");

    const unchanged = await prisma.notificationSettings.findUnique({ where: { userId } });
    assert.equal(unchanged?.gmailNudgeEnabled, false);
    const pendingSession = await getAgentSession(userId);
    assert.equal(pendingSession?.pendingOperation !== null, true);
    assert.doesNotMatch(JSON.stringify(pendingSession?.pendingOperation), /\bundefined\b/);

    const confirm = await sendAgentMessage(server, userId, "yes");
    assertNoGenericAgentError(confirm);
    assert.deepEqual(plannedTools(confirm), ["proactive.settings_apply_update"]);
    assert.equal(confirm.operationsExecuted[0]?.tool, "proactive.settings_apply_update");
    assert.equal(confirm.debug.mutationExecuted, true);
    assert.match(confirm.reply, /Done — Gmail alerts are now on/i);
    assert.match(confirm.reply, /Gmail needs connecting or reconnecting before alerts can work/i);
    assertContainsOAuthLink(confirm.reply);
    assertNoGmailSecrets(confirm);
    assertNoUserFacingNudge(confirm);

    const updated = await prisma.notificationSettings.findUnique({ where: { userId } });
    assert.equal(updated?.gmailNudgeEnabled, true);
  } finally {
    clearAgentRuntimeMocks();
    restore();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("V3 normal-user Gmail alert phrases route to proactive settings without generic fallback", async () => {
  const restore = installGmailOAuthEnv();
  const server = buildServer();
  const phrases = [
    "tell me when important emails arrive",
    "notify me about important Gmail",
    "avísame de correos importantes",
    "turn on Gmail alerts",
    "turn on email alerts",
    "send me alerts for Gmail"
  ];
  const userIds: string[] = [];

  try {
    for (const phrase of phrases) {
      const userId = `gmail-alert-phrase-${randomUUID()}`;
      userIds.push(userId);
      await seedUser(userId);
      await seedNotificationSettings(userId, false);
      await seedExpiredGmailConnection(userId);

      const reply = await sendAgentMessage(server, userId, phrase);
      assertNoGenericAgentError(reply);
      assert.deepEqual(plannedTools(reply), ["proactive.settings_propose_update"], phrase);
      assert.equal(reply.operationsPlanned[0]?.args.gmailNudgeEnabled, true);
      assert.equal(reply.debug.mutationExecuted, false);
      assert.equal(reply.needsConfirmation, true);
      assert.match(reply.reply, /Gmail alerts/i, phrase);
      assertContainsOAuthLink(reply.reply);
      assertNoUserFacingNudge(reply);
      assertNoGmailSecrets(reply);
      assert.ok(!plannedTools(reply).some((tool) => tool.toLowerCase().includes("sync")), `${phrase} must not run Gmail sync`);
    }
  } finally {
    clearAgentRuntimeMocks();
    restore();
    await server.close();
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
});

test("V3 normal-user Gmail alert disable phrases route to proactive settings", async () => {
  const server = buildServer();
  const phrases = ["stop email alerts", "no me avises de correos", "turn off Gmail notifications"];
  const userIds: string[] = [];

  try {
    for (const phrase of phrases) {
      const userId = `gmail-alert-disable-${randomUUID()}`;
      userIds.push(userId);
      await seedUser(userId);
      await seedNotificationSettings(userId, true);

      const reply = await sendAgentMessage(server, userId, phrase);
      assertNoGenericAgentError(reply);
      assert.deepEqual(plannedTools(reply), ["proactive.settings_propose_update"], phrase);
      assert.equal(reply.operationsPlanned[0]?.args.gmailNudgeEnabled, false);
      assert.equal(reply.debug.mutationExecuted, false);
      assert.equal(reply.needsConfirmation, true);
      assert.match(reply.reply, /turn off Gmail alerts/i, phrase);
      assertNoUserFacingNudge(reply);
    }
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
});

test("explicit Gmail alert setup bypasses stale legacy pending action state safely", async () => {
  const restore = installGmailOAuthEnv();
  const server = buildServer();
  const userId = `gmail-alert-legacy-pending-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedNotificationSettings(userId, false);
    await seedExpiredGmailConnection(userId);
    await createPendingAction(userId, {
      type: "action_archive",
      summary: "archive stale task",
      payload: { actionId: "stale-action-id" },
      expiresAt: new Date(Date.now() + 60_000)
    });

    const reply = await sendAgentMessage(server, userId, "turn on Gmail alerts");
    assertNoGenericAgentError(reply);
    assert.deepEqual(plannedTools(reply), ["proactive.settings_propose_update"]);
    assert.equal(reply.operationsPlanned[0]?.args.gmailNudgeEnabled, true);
    assert.match(reply.reply, /Gmail alerts/i);
    assert.doesNotMatch(reply.reply, /pending action from the previous flow/i);

    const legacyPending = await prisma.pendingAction.findFirst({ where: { userId, status: "pending" } });
    assert.equal(legacyPending?.type, "action_archive", "Gmail alert setup must not execute or clear the legacy pending action");
  } finally {
    clearAgentRuntimeMocks();
    restore();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("V3 reconnect and setup phrases return the real Gmail OAuth URL", async () => {
  const restore = installGmailOAuthEnv();
  const server = buildServer();
  const expiredUserId = `gmail-reconnect-link-${randomUUID()}`;
  const newUserId = `gmail-connect-link-${randomUUID()}`;

  try {
    await seedUser(expiredUserId);
    await seedNotificationSettings(expiredUserId);
    const connectionId = await seedExpiredGmailConnection(expiredUserId);
    await seedActiveGmailRule(expiredUserId, connectionId, "Naturgy invoices");

    await seedUser(newUserId);

    const reconnect = await sendAgentMessage(server, expiredUserId, "send me link to reconnect Gmail");
    assertNoGenericAgentError(reconnect);
    assert.deepEqual(plannedTools(reconnect), ["gmail.status"]);
    assert.equal(reconnect.operationsPlanned[0]?.args.includeLink, true);
    assert.equal(reconnect.debug.mutationExecuted, false);
    assert.match(reconnect.reply, /Gmail authorization is expired/i);
    assert.match(reconnect.reply, /Reconnect Gmail here/i);
    // refactor/private-alpha-goal-driven-gmail-operator (Task 7): status is goal-first — this
    // unlinked rule falls into the shared "General Gmail watch" bucket, and since it has no real
    // description, its watch-summary falls back to its own name.
    assert.match(reconnect.reply, /Gmail support:/i);
    assert.match(reconnect.reply, /General Gmail watch: on/i);
    assert.match(reconnect.reply, /Naturgy invoices/i);
    assertContainsOAuthLink(reconnect.reply);
    assertNoGmailSecrets(reconnect);

    const connect = await sendAgentMessage(server, newUserId, "send me link to connect my Gmail");
    assertNoGenericAgentError(connect);
    assert.deepEqual(plannedTools(connect), ["gmail.status"]);
    assert.match(connect.reply, /Gmail is not connected yet/i);
    assert.match(connect.reply, /Connect Gmail here/i);
    assertContainsOAuthLink(connect.reply);
    assertNoGmailSecrets(connect);

    const integrate = await sendAgentMessage(server, expiredUserId, "integrate email");
    assertNoGenericAgentError(integrate);
    assert.deepEqual(plannedTools(integrate), ["gmail.status"]);
    assert.match(integrate.reply, /Gmail authorization is expired/i);
    assert.match(integrate.reply, /Reconnect Gmail here/i);
    assert.doesNotMatch(integrate.reply, /^Gmail is error/i);
    assertContainsOAuthLink(integrate.reply);
    assertNoGmailSecrets(integrate);
  } finally {
    clearAgentRuntimeMocks();
    restore();
    await server.close();
    await prisma.user.deleteMany({ where: { id: { in: [expiredUserId, newUserId] } } });
  }
});

test("pending proactive settings do not hijack Gmail reconnect-link requests, but exact yes/cancel still resolve", async () => {
  const restore = installGmailOAuthEnv();
  const server = buildServer();
  const userId = `gmail-pending-reconnect-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedNotificationSettings(userId, false);
    await seedExpiredGmailConnection(userId);

    const proposal = await sendAgentMessage(server, userId, "turn on Gmail nudges");
    assertNoGenericAgentError(proposal);
    assert.equal(proposal.needsConfirmation, true);

    const reconnect = await sendAgentMessage(server, userId, "send me link to reconnect it");
    assertNoGenericAgentError(reconnect);
    assert.deepEqual(plannedTools(reconnect), ["gmail.status"]);
    assert.match(reconnect.reply, /Reconnect Gmail here/i);
    assertContainsOAuthLink(reconnect.reply);
    assert.doesNotMatch(reconnect.reply, /What would you like to change/i);
    assert.equal(reconnect.debug.pendingOperation, true, "asking for the link must not clear the pending nudge confirmation");

    const confirm = await sendAgentMessage(server, userId, "yes");
    assertNoGenericAgentError(confirm);
    assert.equal(confirm.operationsExecuted[0]?.tool, "proactive.settings_apply_update");
    assert.equal(confirm.debug.mutationExecuted, true);
    const updated = await prisma.notificationSettings.findUnique({ where: { userId } });
    assert.equal(updated?.gmailNudgeEnabled, true);

    const secondProposal = await sendAgentMessage(server, userId, "turn off Gmail nudges");
    assertNoGenericAgentError(secondProposal);
    assert.equal(secondProposal.needsConfirmation, true);
    const cancel = await sendAgentMessage(server, userId, "cancel");
    assertNoGenericAgentError(cancel);
    assert.match(cancel.reply, /Cancelled/i);
    assert.equal(cancel.debug.mutationExecuted, false);
    const stillOn = await prisma.notificationSettings.findUnique({ where: { userId } });
    assert.equal(stillOn?.gmailNudgeEnabled, true);

    assertNoGmailSecrets(reconnect);
    assertNoGmailSecrets(confirm);
  } finally {
    clearAgentRuntimeMocks();
    restore();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
