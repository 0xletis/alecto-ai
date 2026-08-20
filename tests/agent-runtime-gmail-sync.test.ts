import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { configureAgentRuntimeServices, resetAgentRuntimeServicesForTests } from "../apps/api/src/agent-runtime/services.ts";
import { buildServer, clearAgentRuntimeMocks, prisma, seedUser, sendAgentMessage } from "./helpers/agent-runtime-test-helpers.ts";

function plannedTools(reply: Awaited<ReturnType<typeof sendAgentMessage>>): string[] {
  return reply.operationsPlanned.map((operation) => operation.tool);
}

function assertNoGenericAgentError(reply: Awaited<ReturnType<typeof sendAgentMessage>>): void {
  assert.notEqual(reply.reply, "I hit an unexpected problem there — please try again.");
  assert.doesNotMatch(reply.reply, /unexpected problem/i);
}

function installGmailOAuthEnv(): () => void {
  const previous = {
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

function restoreEnv(key: "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET" | "GMAIL_REDIRECT_URI", value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

test("V3 explicit Gmail sync phrases run gmail.sync, not passive status", async () => {
  const server = buildServer();
  const userId = `gmail-sync-phrases-${randomUUID()}`;
  const phrases = ["sync Gmail", "sync email", "check Gmail now", "check my email now", "refresh Gmail", "look for new emails now"];
  const calls: string[] = [];

  try {
    await seedUser(userId);
    configureAgentRuntimeServices({
      syncGmailForUser: async (calledUserId) => {
        calls.push(calledUserId);
        return "Gmail sync: 2 messages checked, 1 new review item.";
      }
    });

    for (const phrase of phrases) {
      const reply = await sendAgentMessage(server, userId, phrase);

      assertNoGenericAgentError(reply);
      assert.deepEqual(plannedTools(reply), ["gmail.sync"], phrase);
      assert.equal(reply.operationsExecuted[0]?.tool, "gmail.sync", phrase);
      assert.match(reply.reply, /Gmail sync: 2 messages checked, 1 new review item\./, phrase);
      assert.doesNotMatch(reply.reply, /Last synced:/i, phrase);
      assert.equal(reply.debug.mutationExecuted, true, phrase);
    }

    assert.equal(calls.length, phrases.length);
    assert.ok(calls.every((calledUserId) => calledUserId === userId));
  } finally {
    clearAgentRuntimeMocks();
    resetAgentRuntimeServicesForTests();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("V3 Gmail sync auth and token failures return safe reconnect action", async () => {
  const restore = installGmailOAuthEnv();
  const server = buildServer();
  const userId = `gmail-sync-auth-${randomUUID()}`;

  try {
    await seedUser(userId);
    configureAgentRuntimeServices({
      syncGmailForUser: async () => "Gmail authorization expired. Reconnect Gmail."
    });

    const expired = await sendAgentMessage(server, userId, "sync Gmail");
    assertNoGenericAgentError(expired);
    assert.deepEqual(plannedTools(expired), ["gmail.sync"]);
    assert.match(expired.reply, /Gmail authorization expired\. Reconnect Gmail\./);
    assert.match(expired.reply, /Reconnect Gmail here:\nhttps:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
    assert.doesNotMatch(expired.reply, /accessToken|refreshToken|ciphertext|authTag|provider raw/i);

    configureAgentRuntimeServices({
      syncGmailForUser: async () => "Gmail token could not be read/decrypted. Reconnect Gmail."
    });

    const decrypt = await sendAgentMessage(server, userId, "sync email");
    assertNoGenericAgentError(decrypt);
    assert.deepEqual(plannedTools(decrypt), ["gmail.sync"]);
    assert.match(decrypt.reply, /Gmail token could not be read\/decrypted\. Reconnect Gmail\./);
    assert.match(decrypt.reply, /Reconnect Gmail here:\nhttps:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
    assert.doesNotMatch(decrypt.reply, /accessToken|refreshToken|ciphertext|authTag|provider raw/i);
  } finally {
    clearAgentRuntimeMocks();
    resetAgentRuntimeServicesForTests();
    restore();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("V3 Gmail sync reports no active rules honestly", async () => {
  const server = buildServer();
  const userId = `gmail-sync-no-rules-${randomUUID()}`;

  try {
    await seedUser(userId);
    configureAgentRuntimeServices({
      syncGmailForUser: async () =>
        "Gmail is connected, but no email tracking rules are active. Say \"enable job search rule for Gmail\", \"enable work action rule for Gmail\", or \"track Endesa bills from Gmail\"."
    });

    const reply = await sendAgentMessage(server, userId, "check Gmail now");
    assertNoGenericAgentError(reply);
    assert.deepEqual(plannedTools(reply), ["gmail.sync"]);
    assert.match(reply.reply, /no email tracking rules are active/i);
    assert.doesNotMatch(reply.reply, /Last synced:/i);
  } finally {
    clearAgentRuntimeMocks();
    resetAgentRuntimeServicesForTests();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("V3 Gmail status and rule list use the same active-rule source", async () => {
  const server = buildServer();
  const userId = `gmail-status-rules-${randomUUID()}`;

  try {
    await seedUser(userId);
    const staleConnection = await prisma.integrationConnection.create({
      data: {
        userId,
        integrationId: "gmail",
        status: "active",
        config: { email: "stale@example.com" }
      }
    });
    const ruleConnection = await prisma.integrationConnection.create({
      data: {
        userId,
        integrationId: "gmail",
        status: "active",
        config: { email: "rules@example.com" },
        lastSyncedAt: new Date("2026-08-20T09:00:00.000Z")
      }
    });
    await prisma.emailSignalRule.createMany({
      data: [
        {
          userId,
          connectionId: ruleConnection.id,
          adapterId: "custom_email_review",
          name: "Endesa bills",
          query: "Endesa",
          status: "active",
          createdBy: "user"
        },
        {
          userId,
          connectionId: ruleConnection.id,
          adapterId: "work_action_email",
          name: "Work action emails",
          query: "please review",
          status: "active",
          createdBy: "user"
        },
        {
          userId,
          connectionId: staleConnection.id,
          adapterId: "custom_email_review",
          name: "Paused stale invoices",
          query: "stale",
          status: "paused",
          createdBy: "user"
        }
      ]
    });

    const status = await sendAgentMessage(server, userId, "gmail status");
    assertNoGenericAgentError(status);
    assert.deepEqual(plannedTools(status), ["gmail.status"]);
    assert.match(status.reply, /Gmail is connected as rules@example\.com/i);
    assert.match(status.reply, /Endesa bills/);
    assert.match(status.reply, /Work action emails/);
    assert.doesNotMatch(status.reply, /No email tracking rules are active yet/i);
    assert.doesNotMatch(status.reply, /Paused stale invoices/);

    process.env.AGENT_RUNTIME_PLANNER_MOCK_RESPONSE = JSON.stringify({
      topic: "gmail_rules",
      intent: "gmail_rule_list",
      operations: [{ tool: "gmail.rule.list", args: {}, rationale: "user asked what email rules are on" }],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const list = await sendAgentMessage(server, userId, "what email rules are on?");
    assertNoGenericAgentError(list);
    assert.deepEqual(plannedTools(list), ["gmail.rule.list"]);
    assert.match(list.reply, /Endesa bills/);
    assert.match(list.reply, /Work action emails/);
    assert.doesNotMatch(list.reply, /Paused stale invoices/);
  } finally {
    clearAgentRuntimeMocks();
    resetAgentRuntimeServicesForTests();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("V3 Gmail alerts and status still route separately from sync", async () => {
  const server = buildServer();
  const userId = `gmail-sync-separation-${randomUUID()}`;
  let syncCalls = 0;

  try {
    await seedUser(userId);
    configureAgentRuntimeServices({
      syncGmailForUser: async () => {
        syncCalls += 1;
        return "Gmail sync: 1 message checked, 0 new items.";
      }
    });

    const alerts = await sendAgentMessage(server, userId, "turn on Gmail alerts");
    assertNoGenericAgentError(alerts);
    assert.deepEqual(plannedTools(alerts), ["proactive.settings_propose_update"]);
    assert.equal(syncCalls, 0);

    const status = await sendAgentMessage(server, userId, "gmail status");
    assertNoGenericAgentError(status);
    assert.deepEqual(plannedTools(status), ["gmail.status"]);
    assert.equal(syncCalls, 0);
  } finally {
    clearAgentRuntimeMocks();
    resetAgentRuntimeServicesForTests();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("Gmail integration sync route returns safe actionable error for an error-status Gmail connection", async () => {
  const server = buildServer();
  const userId = `gmail-sync-route-error-${randomUUID()}`;

  try {
    await seedUser(userId);
    const connection = await prisma.integrationConnection.create({
      data: {
        userId,
        integrationId: "gmail",
        status: "error",
        config: { email: "expired@example.com" },
        lastError: "Gmail sync failed: Gmail authorization expired. Reconnect Gmail."
      }
    });

    const response = await server.inject({
      method: "POST",
      url: `/users/${userId}/integrations/${connection.id}/sync`,
      payload: {}
    });
    const body = response.json();

    assert.equal(response.statusCode, 400);
    assert.equal(body.error, "Gmail authorization expired. Reconnect Gmail.");
    assert.equal(body.connectionId, connection.id);
    assert.equal(body.integrationId, "gmail");
    assert.doesNotMatch(JSON.stringify(body), /accessToken|refreshToken|ciphertext|authTag/i);
  } finally {
    clearAgentRuntimeMocks();
    resetAgentRuntimeServicesForTests();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
