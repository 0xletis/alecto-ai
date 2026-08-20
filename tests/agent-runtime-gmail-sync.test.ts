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
    GMAIL_REDIRECT_URI: process.env.GMAIL_REDIRECT_URI,
    ALECTO_SECRET_ENCRYPTION_KEY: process.env.ALECTO_SECRET_ENCRYPTION_KEY
  };

  process.env.GOOGLE_CLIENT_ID = "test-gmail-client-id.apps.googleusercontent.com";
  process.env.GOOGLE_CLIENT_SECRET = "test-gmail-client-secret";
  process.env.GMAIL_REDIRECT_URI = "http://localhost:3000/oauth/gmail/callback";
  process.env.ALECTO_SECRET_ENCRYPTION_KEY = "test-secret-encryption-key";

  return () => {
    restoreEnv("GOOGLE_CLIENT_ID", previous.GOOGLE_CLIENT_ID);
    restoreEnv("GOOGLE_CLIENT_SECRET", previous.GOOGLE_CLIENT_SECRET);
    restoreEnv("GMAIL_REDIRECT_URI", previous.GMAIL_REDIRECT_URI);
    restoreEnv("ALECTO_SECRET_ENCRYPTION_KEY", previous.ALECTO_SECRET_ENCRYPTION_KEY);
  };
}

async function seedExpiredDuplicateGmailState(userId: string): Promise<void> {
  const olderConnection = await prisma.integrationConnection.create({
    data: {
      userId,
      integrationId: "gmail",
      status: "error",
      config: { email: "letiskate@gmail.com" },
      lastError: "Gmail authorization expired. Reconnect Gmail.",
      lastSyncedAt: new Date("2026-07-16T09:00:00.000Z"),
      createdAt: new Date("2026-07-16T09:00:00.000Z")
    }
  });
  const middleConnection = await prisma.integrationConnection.create({
    data: {
      userId,
      integrationId: "gmail",
      status: "error",
      config: { email: "letiskate@gmail.com" },
      lastError: "Gmail authorization expired. Reconnect Gmail.",
      lastSyncedAt: new Date("2026-07-29T09:00:00.000Z"),
      createdAt: new Date("2026-07-29T09:00:00.000Z")
    }
  });
  const newestRuleConnection = await prisma.integrationConnection.create({
    data: {
      userId,
      integrationId: "gmail",
      status: "error",
      config: { email: "letiskate@gmail.com" },
      lastError: "Gmail authorization expired. Reconnect Gmail.",
      lastSyncedAt: new Date("2026-08-13T09:00:00.000Z"),
      createdAt: new Date("2026-08-13T09:00:00.000Z")
    }
  });

  await prisma.emailSignalRule.createMany({
    data: [
      {
        userId,
        connectionId: olderConnection.id,
        adapterId: "job_search_email",
        name: "Job search emails",
        query: "interview recruiter application",
        status: "archived",
        createdBy: "user",
        createdAt: new Date("2026-07-16T09:05:00.000Z")
      },
      {
        userId,
        connectionId: middleConnection.id,
        adapterId: "custom_email_review",
        name: "Old Endesa bills",
        query: "Endesa factura",
        status: "archived",
        reviewBeforeLogging: true,
        createdBy: "user",
        createdAt: new Date("2026-07-29T09:05:00.000Z")
      },
      {
        userId,
        connectionId: middleConnection.id,
        adapterId: "work_action_email",
        name: "Old work action emails",
        query: "please review",
        status: "archived",
        reviewBeforeLogging: true,
        createdBy: "user",
        createdAt: new Date("2026-07-29T09:06:00.000Z")
      },
      {
        userId,
        connectionId: middleConnection.id,
        adapterId: "job_search_email",
        name: "Old job search emails",
        query: "interview recruiter application",
        status: "archived",
        createdBy: "user",
        createdAt: new Date("2026-07-29T09:07:00.000Z")
      },
      {
        userId,
        connectionId: newestRuleConnection.id,
        adapterId: "custom_email_review",
        name: "Naturgy invoices",
        query: "Naturgy factura",
        status: "active",
        reviewBeforeLogging: true,
        createdBy: "user",
        createdAt: new Date("2026-08-13T09:05:00.000Z")
      },
      {
        userId,
        connectionId: newestRuleConnection.id,
        adapterId: "custom_email_review",
        name: "Aigues de Barcelona invoices",
        query: "Aigues de Barcelona factura",
        status: "active",
        reviewBeforeLogging: true,
        createdBy: "user",
        createdAt: new Date("2026-08-13T09:06:00.000Z")
      },
      {
        userId,
        connectionId: newestRuleConnection.id,
        adapterId: "custom_email_review",
        name: "Endesa bills",
        query: "Endesa factura",
        status: "active",
        reviewBeforeLogging: true,
        createdBy: "user",
        createdAt: new Date("2026-08-13T09:07:00.000Z")
      },
      {
        userId,
        connectionId: newestRuleConnection.id,
        adapterId: "work_action_email",
        name: "Work action emails",
        query: "please review OR deadline",
        status: "active",
        reviewBeforeLogging: true,
        createdBy: "user",
        createdAt: new Date("2026-08-13T09:08:00.000Z")
      },
      {
        userId,
        connectionId: newestRuleConnection.id,
        adapterId: "job_search_email",
        name: "Archived job search emails",
        query: "interview recruiter application",
        status: "archived",
        createdBy: "user",
        createdAt: new Date("2026-08-13T09:09:00.000Z")
      }
    ]
  });
}

async function seedActiveGmailConnectionWithRule(userId: string): Promise<void> {
  const connection = await prisma.integrationConnection.create({
    data: {
      userId,
      integrationId: "gmail",
      status: "active",
      config: { email: "rules@example.com" }
    }
  });

  await prisma.emailSignalRule.create({
    data: {
      userId,
      connectionId: connection.id,
      adapterId: "custom_email_review",
      name: "Endesa bills",
      query: "Endesa",
      status: "active",
      reviewBeforeLogging: true,
      createdBy: "user"
    }
  });
}

async function runAgentTranscript(
  server: ReturnType<typeof buildServer>,
  userId: string,
  messages: string[]
): Promise<Array<Awaited<ReturnType<typeof sendAgentMessage>>>> {
  const replies: Array<Awaited<ReturnType<typeof sendAgentMessage>>> = [];
  for (const message of messages) {
    replies.push(await sendAgentMessage(server, userId, message));
  }
  return replies;
}

function installGmailOAuthFetchMock(email = "letiskate@gmail.com"): () => void {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url === "https://oauth2.googleapis.com/token") {
      return new Response(
        JSON.stringify({
          access_token: "test-access-token",
          refresh_token: "test-refresh-token",
          expires_in: 3600,
          token_type: "Bearer",
          scope: "https://www.googleapis.com/auth/gmail.readonly"
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    if (url === "https://gmail.googleapis.com/gmail/v1/users/me/profile") {
      return new Response(JSON.stringify({ emailAddress: email }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }

    return new Response("unexpected fetch", { status: 500 });
  }) as typeof fetch;

  return () => {
    globalThis.fetch = previousFetch;
  };
}

function gmailOAuthCallbackUrl(userId: string): string {
  const state = Buffer.from(JSON.stringify({ userId }), "utf8").toString("base64url");
  return `/oauth/gmail/callback?code=test-oauth-code&state=${state}`;
}

function restoreEnv(
  key: "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET" | "GMAIL_REDIRECT_URI" | "ALECTO_SECRET_ENCRYPTION_KEY",
  value: string | undefined
): void {
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
    await seedActiveGmailConnectionWithRule(userId);
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
    await seedActiveGmailConnectionWithRule(userId);
    configureAgentRuntimeServices({
      syncGmailForUser: async () => "Gmail authorization expired. Reconnect Gmail."
    });

    const expired = await sendAgentMessage(server, userId, "sync Gmail");
    assertNoGenericAgentError(expired);
    assert.deepEqual(plannedTools(expired), ["gmail.sync"]);
    assert.match(expired.reply, /Gmail authorization expired\. Reconnect Gmail\./);
    assert.match(expired.reply, /Reconnect Gmail here:\nhttps:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
    assert.match(expired.reply, /Open this link on the same machine running Alecto/i);
    assert.doesNotMatch(expired.reply, /accessToken|refreshToken|ciphertext|authTag|provider raw/i);

    configureAgentRuntimeServices({
      syncGmailForUser: async () => "Gmail token could not be read/decrypted. Reconnect Gmail."
    });

    const decrypt = await sendAgentMessage(server, userId, "sync email");
    assertNoGenericAgentError(decrypt);
    assert.deepEqual(plannedTools(decrypt), ["gmail.sync"]);
    assert.match(decrypt.reply, /Gmail token could not be read\/decrypted\. Reconnect Gmail\./);
    assert.match(decrypt.reply, /Reconnect Gmail here:\nhttps:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
    assert.match(decrypt.reply, /Open this link on the same machine running Alecto/i);
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
    await prisma.integrationConnection.create({
      data: {
        userId,
        integrationId: "gmail",
        status: "active",
        config: { email: "rules@example.com" }
      }
    });
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

test("V3 Gmail status, sync, and built-in rule enablement share canonical expired duplicate state", async () => {
  const restore = installGmailOAuthEnv();
  const server = buildServer();
  const userId = `gmail-canonical-transcript-${randomUUID()}`;

  try {
    await seedUser(userId);
    await seedExpiredDuplicateGmailState(userId);

    const [status, sync, enableJobSearch, secondSync] = await runAgentTranscript(server, userId, [
      "gmail status",
      "sync Gmail",
      "enable job search one",
      "sync gmail"
    ]);

    assertNoGenericAgentError(status);
    assert.deepEqual(plannedTools(status), ["gmail.status"]);
    assert.match(status.reply, /Gmail authorization is expired/i);
    assert.match(status.reply, /Reconnect Gmail here:\nhttps:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
    assert.match(status.reply, /Open this link on the same machine running Alecto/i);
    assert.match(status.reply, /Last synced: 2026-08-13\./);
    assert.match(status.reply, /Naturgy invoices/);
    assert.match(status.reply, /Aigues de Barcelona invoices/);
    assert.match(status.reply, /Endesa bills/);
    assert.match(status.reply, /Work action emails/);

    assertNoGenericAgentError(sync);
    assert.deepEqual(plannedTools(sync), ["gmail.sync"]);
    assert.match(sync.reply, /Gmail authorization is expired/i);
    assert.match(sync.reply, /Reconnect Gmail here:\nhttps:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
    assert.match(sync.reply, /Open this link on the same machine running Alecto/i);
    assert.match(sync.reply, /You have 4 active Gmail rules, but sync cannot run until Gmail is reconnected\./);
    assert.match(sync.reply, /Naturgy invoices/);
    assert.match(sync.reply, /Aigues de Barcelona invoices/);
    assert.match(sync.reply, /Endesa bills/);
    assert.match(sync.reply, /Work action emails/);
    assert.doesNotMatch(sync.reply, /Gmail is connected/i);
    assert.doesNotMatch(sync.reply, /no email tracking rules are active/i);

    assertNoGenericAgentError(enableJobSearch);
    assert.deepEqual(plannedTools(enableJobSearch), ["gmail.rule.enable_builtin"]);
    assert.match(enableJobSearch.reply, /Job-search email tracking/i);
    assert.doesNotMatch(enableJobSearch.reply, /Work-action email tracking is already on|Work action emails is already active/i);

    assertNoGenericAgentError(secondSync);
    assert.deepEqual(plannedTools(secondSync), ["gmail.sync"]);
    assert.match(secondSync.reply, /Gmail authorization is expired/i);
    assert.match(secondSync.reply, /sync cannot run until Gmail is reconnected/i);
    assert.doesNotMatch(secondSync.reply, /Gmail is connected/i);
    assert.doesNotMatch(secondSync.reply, /no email tracking rules are active/i);
  } finally {
    clearAgentRuntimeMocks();
    resetAgentRuntimeServicesForTests();
    restore();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("Gmail OAuth reconnect preserves active rules for V3 status and sync", async () => {
  const restoreEnv = installGmailOAuthEnv();
  const restoreFetch = installGmailOAuthFetchMock("letiskate@gmail.com");
  const server = buildServer();
  const userId = `gmail-reconnect-lifecycle-${randomUUID()}`;
  let syncCalls = 0;

  try {
    await seedUser(userId);
    await seedExpiredDuplicateGmailState(userId);
    configureAgentRuntimeServices({
      syncGmailForUser: async () => {
        syncCalls += 1;
        return "Gmail sync: 4 messages checked, 1 new item.";
      }
    });

    const callback = await server.inject({
      method: "GET",
      url: gmailOAuthCallbackUrl(userId)
    });
    assert.equal(callback.statusCode, 200);
    assert.match(callback.body, /Gmail connected/i);
    assert.doesNotMatch(callback.body, /accessToken|refreshToken|ciphertext|authTag/i);

    const status = await sendAgentMessage(server, userId, "gmail status");
    assertNoGenericAgentError(status);
    assert.deepEqual(plannedTools(status), ["gmail.status"]);
    assert.match(status.reply, /Gmail is connected as letiskate@gmail\.com/i);
    assert.match(status.reply, /Naturgy invoices/);
    assert.match(status.reply, /Aigues de Barcelona invoices/);
    assert.match(status.reply, /Endesa bills/);
    assert.match(status.reply, /Work action emails/);
    assert.doesNotMatch(status.reply, /authorization is expired|Reconnect Gmail here|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);

    const sync = await sendAgentMessage(server, userId, "sync gmail");
    assertNoGenericAgentError(sync);
    assert.deepEqual(plannedTools(sync), ["gmail.sync"]);
    assert.match(sync.reply, /Gmail sync: 4 messages checked, 1 new item\./);
    assert.doesNotMatch(sync.reply, /authorization is expired|Reconnect Gmail here|no email tracking rules are active/i);
    assert.equal(syncCalls, 1);

    const activeRules = await prisma.emailSignalRule.findMany({
      where: { userId, status: "active" },
      orderBy: { name: "asc" }
    });
    assert.equal(activeRules.length, 4);
    assert.equal(new Set(activeRules.map((rule) => rule.connectionId)).size, 1);
  } finally {
    clearAgentRuntimeMocks();
    resetAgentRuntimeServicesForTests();
    restoreFetch();
    restoreEnv();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("Gmail OAuth URL response warns when callback URL is localhost", async () => {
  const restore = installGmailOAuthEnv();
  const server = buildServer();
  const userId = `gmail-oauth-url-warning-${randomUUID()}`;

  try {
    await seedUser(userId);
    const response = await server.inject({
      method: "GET",
      url: `/users/${userId}/integrations/gmail/oauth-url`
    });
    const body = response.json();

    assert.equal(response.statusCode, 200);
    assert.match(body.url, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
    assert.match(body.localCallbackWarning, /Open this link on the same machine running Alecto/i);
    assert.doesNotMatch(JSON.stringify(body), /accessToken|refreshToken|ciphertext|authTag/i);
  } finally {
    restore();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("V3 built-in Gmail rule enablement keeps job-search and work-action references separate", async () => {
  const restore = installGmailOAuthEnv();
  const server = buildServer();
  const userId = `gmail-builtin-enable-${randomUUID()}`;

  try {
    await seedUser(userId);
    await prisma.integrationConnection.create({
      data: {
        userId,
        integrationId: "gmail",
        status: "active",
        config: { email: "rules@example.com" }
      }
    });

    for (const phrase of ["enable job search one", "enable job search rule"]) {
      const reply = await sendAgentMessage(server, userId, phrase);
      assertNoGenericAgentError(reply);
      assert.deepEqual(plannedTools(reply), ["gmail.rule.enable_builtin"], phrase);
      assert.equal(reply.operationsPlanned[0]?.args.kind, "job_search", phrase);
      assert.match(reply.reply, /Job-search email tracking/i, phrase);
      assert.doesNotMatch(reply.reply, /Work-action email tracking is already on|Work action emails is already active/i, phrase);
    }

    const work = await sendAgentMessage(server, userId, "enable work action rule");
    assertNoGenericAgentError(work);
    assert.deepEqual(plannedTools(work), ["gmail.rule.enable_builtin"]);
    assert.equal(work.operationsPlanned[0]?.args.kind, "work_action");
    assert.match(work.reply, /Work-action email tracking/i);
    assert.doesNotMatch(work.reply, /Job-search email tracking is already on|Job search emails is already active/i);

    const activeRules = await prisma.emailSignalRule.findMany({
      where: { userId, status: "active" },
      orderBy: { name: "asc" }
    });
    assert.deepEqual(
      activeRules.map((rule) => rule.adapterId).sort(),
      ["job_search_email", "work_action_email"]
    );
  } finally {
    clearAgentRuntimeMocks();
    resetAgentRuntimeServicesForTests();
    restore();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("V3 custom Gmail tracking like Endesa still goes through review-first rule creation confirmation", async () => {
  const server = buildServer();
  const userId = `gmail-custom-track-${randomUUID()}`;

  try {
    await seedUser(userId);
    await prisma.integrationConnection.create({
      data: {
        userId,
        integrationId: "gmail",
        status: "active",
        config: { email: "rules@example.com" }
      }
    });
    process.env.AGENT_RUNTIME_PLANNER_MOCK_RESPONSE = JSON.stringify({
      topic: "gmail_rules",
      intent: "create_custom_gmail_rule",
      operations: [{ tool: "gmail.rule.create", args: { label: "Endesa bills" }, rationale: "user wants Endesa bill tracking" }],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });

    const reply = await sendAgentMessage(server, userId, "track Endesa bills");
    assertNoGenericAgentError(reply);
    assert.deepEqual(plannedTools(reply), ["gmail.rule.create"]);
    assert.equal(reply.needsConfirmation, true);
    assert.match(reply.reply, /Endesa bills/i);
    assert.match(reply.reply, /review-first|email reviews/i);
    assert.match(reply.reply, /not instant/i);
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
