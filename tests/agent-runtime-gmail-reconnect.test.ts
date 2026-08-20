import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { buildServer, clearAgentRuntimeMocks, prisma, sendAgentMessage, seedUser } from "./helpers/agent-runtime-test-helpers.ts";

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

test("V3 'turn on Gmail nudges' proposes proactive settings and does not sync Gmail", async () => {
  const restore = installGmailOAuthEnv();
  const server = buildServer();
  const userId = `gmail-nudge-reconnect-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedNotificationSettings(userId, false);
    await seedExpiredGmailConnection(userId);

    const proposal = await sendAgentMessage(server, userId, "turn on Gmail nudges");

    assert.deepEqual(plannedTools(proposal), ["proactive.settings_propose_update"]);
    assert.equal(proposal.operationsPlanned[0]?.args.gmailNudgeEnabled, true);
    assert.equal(proposal.debug.mutationExecuted, false);
    assert.equal(proposal.needsConfirmation, true);
    assert.match(proposal.reply, /about to turn on the Gmail nudge/i);
    assert.match(proposal.reply, /Gmail authorization is expired/i);
    assert.match(proposal.reply, /connect or reconnect Gmail/i);
    assertContainsOAuthLink(proposal.reply);
    assertNoGmailSecrets(proposal);
    assert.ok(!plannedTools(proposal).some((tool) => tool.toLowerCase().includes("sync")), "nudge setting must not run Gmail sync");

    const unchanged = await prisma.notificationSettings.findUnique({ where: { userId } });
    assert.equal(unchanged?.gmailNudgeEnabled, false);

    const confirm = await sendAgentMessage(server, userId, "yes");
    assert.deepEqual(plannedTools(confirm), ["proactive.settings_apply_update"]);
    assert.equal(confirm.operationsExecuted[0]?.tool, "proactive.settings_apply_update");
    assert.equal(confirm.debug.mutationExecuted, true);
    assert.match(confirm.reply, /Done — the Gmail nudge is now on/i);
    assert.match(confirm.reply, /Gmail needs connecting or reconnecting before nudges can work/i);
    assertContainsOAuthLink(confirm.reply);
    assertNoGmailSecrets(confirm);

    const updated = await prisma.notificationSettings.findUnique({ where: { userId } });
    assert.equal(updated?.gmailNudgeEnabled, true);
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
    assert.deepEqual(plannedTools(reconnect), ["gmail.status"]);
    assert.equal(reconnect.operationsPlanned[0]?.args.includeLink, true);
    assert.equal(reconnect.debug.mutationExecuted, false);
    assert.match(reconnect.reply, /Gmail authorization is expired/i);
    assert.match(reconnect.reply, /Reconnect Gmail here/i);
    assert.match(reconnect.reply, /Active rules:/i);
    assert.match(reconnect.reply, /Naturgy invoices/i);
    assertContainsOAuthLink(reconnect.reply);
    assertNoGmailSecrets(reconnect);

    const connect = await sendAgentMessage(server, newUserId, "send me link to connect my Gmail");
    assert.deepEqual(plannedTools(connect), ["gmail.status"]);
    assert.match(connect.reply, /Gmail is not connected yet/i);
    assert.match(connect.reply, /Connect Gmail here/i);
    assertContainsOAuthLink(connect.reply);
    assertNoGmailSecrets(connect);

    const integrate = await sendAgentMessage(server, expiredUserId, "integrate email");
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
    assert.equal(proposal.needsConfirmation, true);

    const reconnect = await sendAgentMessage(server, userId, "send me link to reconnect it");
    assert.deepEqual(plannedTools(reconnect), ["gmail.status"]);
    assert.match(reconnect.reply, /Reconnect Gmail here/i);
    assertContainsOAuthLink(reconnect.reply);
    assert.doesNotMatch(reconnect.reply, /What would you like to change/i);
    assert.equal(reconnect.debug.pendingOperation, true, "asking for the link must not clear the pending nudge confirmation");

    const confirm = await sendAgentMessage(server, userId, "yes");
    assert.equal(confirm.operationsExecuted[0]?.tool, "proactive.settings_apply_update");
    assert.equal(confirm.debug.mutationExecuted, true);
    const updated = await prisma.notificationSettings.findUnique({ where: { userId } });
    assert.equal(updated?.gmailNudgeEnabled, true);

    const secondProposal = await sendAgentMessage(server, userId, "turn off Gmail nudges");
    assert.equal(secondProposal.needsConfirmation, true);
    const cancel = await sendAgentMessage(server, userId, "cancel");
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
