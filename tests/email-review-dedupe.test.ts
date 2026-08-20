import { randomBytes, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test, { mock } from "node:test";
import {
  findGmailSemanticDuplicateEvent,
  findGmailSemanticDuplicateReviewItem,
  prisma
} from "../packages/db/src/index.ts";
import {
  buildNormalizedInboundMessage,
  buildDeterministicDailyCoachResponse,
  deterministicDailyCoachWarning,
  classifyJobSearchEmail,
  classifyWorkActionEmail,
  explainNormalizedInboundRoute,
  classifyDueWindow,
  decryptSecretJson,
  encryptSecretJson,
  getLocalTodayRange,
  isEncryptedSecretJsonEnvelope,
  normalizeManualActionTitleKey,
  parseActionDueDate,
  routeNormalizedInboundMessage,
  segmentInboundMessage,
  splitPendingDecisionReplyWithCommands,
  sortDailyActionsByPriority,
  validateDailyCoachResponseAgainstContext
} from "../packages/core/src/index.ts";
import { buildServer } from "../apps/api/src/server.ts";

const userId = `test-user-${randomUUID()}`;
const connectionId = randomUUID();
const ruleId = randomUUID();

test("normalized inbound messages parse channel-neutral slash commands", () => {
  const telegramMessage = buildNormalizedInboundMessage({
    channel: "telegram",
    userId: "telegram:123",
    externalUserId: "123",
    text: "/today",
    timestamp: new Date("2026-07-30T10:00:00.000Z")
  });
  const whatsappMessage = buildNormalizedInboundMessage({
    channel: "whatsapp",
    userId: "whatsapp:123",
    externalUserId: "123",
    text: "/today",
    timestamp: new Date("2026-07-30T10:00:00.000Z")
  });

  assert.equal(telegramMessage.command?.name, "today");
  assert.equal(whatsappMessage.command?.name, "today");
  assert.deepEqual(routeNormalizedInboundMessage(telegramMessage), {
    kind: "command",
    command: { name: "today", args: "", raw: "/today" }
  });
  assert.deepEqual(routeNormalizedInboundMessage(whatsappMessage), {
    kind: "command",
    command: { name: "today", args: "", raw: "/today" }
  });
});

test("inbound message segmentation detects command batches and references", () => {
  const single = segmentInboundMessage("/today");
  assert.equal(single.kind, "single_command");

  const batch = segmentInboundMessage(
    [
      "/archive_action c8d460ea-875b-40d7-b094-95565dfc43f9",
      "/archive_action cac5a63f-3211-4dfe-90f0-79cfa88b977e",
      "/archive_action 4bf37417-2a26-44af-8095-32dd8188a33c"
    ].join("\n")
  );
  assert.equal(batch.kind, "command_batch");
  assert.deepEqual(batch.kind === "command_batch" ? batch.commands : [], [
    "/archive_action c8d460ea-875b-40d7-b094-95565dfc43f9",
    "/archive_action cac5a63f-3211-4dfe-90f0-79cfa88b977e",
    "/archive_action 4bf37417-2a26-44af-8095-32dd8188a33c"
  ]);

  const readOnlyBatch = segmentInboundMessage("/actions\n/today");
  assert.equal(readOnlyBatch.kind, "command_batch");
  assert.deepEqual(readOnlyBatch.kind === "command_batch" ? readOnlyBatch.commands : [], ["/actions", "/today"]);

  const mixedCommand = segmentInboundMessage("/archive_action abc\nextra text");
  assert.equal(mixedCommand.kind, "reference_text");
  assert.equal(mixedCommand.reason, "command_plus_extra_text");

  const mixedNaturalAndCommand = segmentInboundMessage("move YouTube script to tomorrow afternoon\n/actions");
  assert.equal(mixedNaturalAndCommand.kind, "reference_text");
  assert.equal(mixedNaturalAndCommand.reason, "mixed_text_and_command");

  const telegramExport = segmentInboundMessage("[30/07/2026 04:56] letis: /archive_action abc");
  assert.equal(telegramExport.kind, "reference_text");

  const codeFence = segmentInboundMessage("```text\n/archive_action abc\n/archive_action def\n```");
  assert.equal(codeFence.kind, "reference_text");

  const codexPrompt = segmentInboundMessage(
    [
      "You are working in the alecto-ai repository.",
      "Requirements:",
      "- /archive_action abc should not run in this pasted prompt.",
      "Expected:",
      "No side effects."
    ].join("\n")
  );
  assert.equal(codexPrompt.kind, "reference_text");

  const debugDump = segmentInboundMessage(
    [
      "intentType: command",
      "handlerName: archive_action",
      "allowedSideEffects:",
      "- createAction: false"
    ].join("\n")
  );
  assert.equal(debugDump.kind, "reference_text");

  const unknownBatch = segmentInboundMessage("/unknown_one abc\n/unknown_two def");
  assert.equal(unknownBatch.kind, "command_batch");
  assert.deepEqual(unknownBatch.kind === "command_batch" ? unknownBatch.commands : [], ["/unknown_one abc", "/unknown_two def"]);

  const normalText = segmentInboundMessage("I sent 2 CVs and trained 30 min");
  assert.equal(normalText.kind, "normal_text");

  assert.deepEqual(splitPendingDecisionReplyWithCommands("no\n/actions"), {
    replyText: "no",
    commands: ["/actions"]
  });
  assert.deepEqual(splitPendingDecisionReplyWithCommands("yes\n/actions"), {
    replyText: "yes",
    commands: ["/actions"]
  });
  assert.deepEqual(splitPendingDecisionReplyWithCommands("1\n/actions"), {
    replyText: "1",
    commands: ["/actions"]
  });
  assert.equal(splitPendingDecisionReplyWithCommands("move YouTube to tomorrow\n/actions"), undefined);
});

test("normalized inbound router prioritizes memory and risk before check-in routing", () => {
  const memoryMessage = buildNormalizedInboundMessage({
    channel: "telegram",
    userId: "telegram:123",
    externalUserId: "123",
    text: "remember that when I talk about gambling I want you stricter"
  });
  const bettingMessage = buildNormalizedInboundMessage({
    channel: "whatsapp",
    userId: "whatsapp:123",
    externalUserId: "123",
    text: "quiero apostar 1000 porque esto es seguro"
  });
  const checkInMessage = buildNormalizedInboundMessage({
    channel: "web",
    userId: "web:123",
    externalUserId: "123",
    text: "slept 6h, energy 5, anxiety 7, sent 2 cvs, trained 40 min, no gambling impulse"
  });

  assert.equal(routeNormalizedInboundMessage(memoryMessage).kind, "process_message");
  assert.equal(routeNormalizedInboundMessage(bettingMessage).kind, "process_message");
  assert.equal(routeNormalizedInboundMessage(checkInMessage).kind, "daily_checkin");
});

test("normalized inbound route debug preserves normal free-text behavior", () => {
  const action = explainNormalizedInboundRoute(
    buildNormalizedInboundMessage({
      channel: "telegram",
      userId: "telegram:123",
      externalUserId: "123",
      text: "I need to call Alex tomorrow"
    })
  );
  const event = explainNormalizedInboundRoute(
    buildNormalizedInboundMessage({
      channel: "telegram",
      userId: "telegram:123",
      externalUserId: "123",
      text: "sent 2 CVs and trained 30 min"
    })
  );
  const risk = explainNormalizedInboundRoute(
    buildNormalizedInboundMessage({
      channel: "telegram",
      userId: "telegram:123",
      externalUserId: "123",
      text: "remind me to bet 500 tomorrow"
    })
  );

  assert.equal(action.intentType, "action_create");
  assert.equal(event.intentType, "event_log");
  assert.equal(risk.intentType, "goal_guardrail");
  assert.equal(risk.allowedSideEffects.createAction, false);
});

test("normalized inbound router sends pasted job-search emails to ingestion", () => {
  const message = buildNormalizedInboundMessage({
    channel: "telegram",
    userId: "telegram:123",
    externalUserId: "123",
    text: "Hi Miquel, we'd like to schedule an interview for the Backend Engineer role at Test Company. Are you available next Tuesday?"
  });

  assert.deepEqual(routeNormalizedInboundMessage(message), {
    kind: "ingest_text",
    source: "telegram",
    domainHint: "career"
  });
});

test("route debug explains commands and does not imply command execution", () => {
  const today = explainNormalizedInboundRoute(
    buildNormalizedInboundMessage({
      channel: "telegram",
      userId: "telegram:123",
      externalUserId: "123",
      text: "/today"
    })
  );
  const gmailDebug = explainNormalizedInboundRoute(
    buildNormalizedInboundMessage({
      channel: "telegram",
      userId: "telegram:123",
      externalUserId: "123",
      text: "/sync_gmail_debug"
    })
  );

  assert.equal(today.intentType, "command");
  assert.equal(today.handlerName, "today");
  assert.equal(today.allowedSideEffects.createEvent, false);
  assert.equal(today.allowedSideEffects.createAction, false);
  assert.equal(today.allowedSideEffects.createMemory, false);
  assert.equal(gmailDebug.intentType, "command");
  assert.equal(gmailDebug.handlerName, "sync_gmail_debug");
  assert.equal(gmailDebug.allowedSideEffects.sendNotification, false);
});

test("route debug explains action, event, goal guardrail, and standalone now routes", () => {
  const now = explainNormalizedInboundRoute(
    buildNormalizedInboundMessage({
      channel: "telegram",
      userId: "telegram:123",
      externalUserId: "123",
      text: "now"
    })
  );
  const action = explainNormalizedInboundRoute(
    buildNormalizedInboundMessage({
      channel: "web",
      userId: "web:123",
      externalUserId: "123",
      text: "I need to call Alex tomorrow"
    })
  );
  const event = explainNormalizedInboundRoute(
    buildNormalizedInboundMessage({
      channel: "api",
      userId: "api:123",
      externalUserId: "123",
      text: "sent 2 CVs and trained 30 min"
    })
  );
  const risk = explainNormalizedInboundRoute(
    buildNormalizedInboundMessage({
      channel: "whatsapp",
      userId: "whatsapp:123",
      externalUserId: "123",
      text: "remind me to bet 500 tomorrow"
    })
  );
  const actionRisk = explainNormalizedInboundRoute(
    buildNormalizedInboundMessage({
      channel: "telegram",
      userId: "telegram:123",
      externalUserId: "123",
      text: "/action bet 500 tomorrow"
    })
  );
  const reference = explainNormalizedInboundRoute(
    buildNormalizedInboundMessage({
      channel: "api",
      userId: "api:123",
      externalUserId: "123",
      text: "You are working in the repo. Tests: /action bet 500 tomorrow"
    })
  );
  const debugOutput = explainNormalizedInboundRoute(
    buildNormalizedInboundMessage({
      channel: "api",
      userId: "api:123",
      externalUserId: "123",
      text: "Observed debug output: intentType risk_guardrail for /action bet 500 tomorrow"
    })
  );

  assert.equal(now.intentType, "unknown");
  assert.equal(now.allowedSideEffects.createAction, false);
  assert.equal(now.allowedSideEffects.createEvent, false);
  assert.equal(action.intentType, "action_create");
  assert.equal(action.allowedSideEffects.createAction, true);
  assert.equal(event.intentType, "event_log");
  assert.equal(event.allowedSideEffects.createEvent, true);
  assert.equal(risk.intentType, "goal_guardrail");
  assert.equal(risk.handlerName, "goal_guardrail_engine");
  assert.equal(risk.goal, "Control impulsive betting");
  assert.equal(risk.severity, "hard");
  assert.equal(risk.allowedSideEffects.createAction, false);
  assert.equal(actionRisk.intentType, "command_with_guardrail");
  assert.equal(actionRisk.handlerName, "action");
  assert.equal(actionRisk.allowedSideEffects.createAction, false);
  assert.equal(reference.intentType, "generic_chat");
  assert.equal(reference.isReferenceOnly, true);
  assert.equal(reference.allowedSideEffects.createAction, false);
  assert.equal(reference.allowedSideEffects.createEvent, false);
  assert.equal(debugOutput.intentType, "generic_chat");
  assert.equal(debugOutput.isReferenceOnly, true);
});

test("secret JSON encryption roundtrips, uses random IVs, and rejects tampering", () => {
  const key = randomBytes(32);
  const value = {
    accessToken: "secret-access-token",
    refreshToken: "secret-refresh-token",
    expiresAt: 1786372120000
  };

  const first = encryptSecretJson(value, key);
  const second = encryptSecretJson(value, key);

  assert.equal(isEncryptedSecretJsonEnvelope(first), true);
  assert.equal(isEncryptedSecretJsonEnvelope(second), true);
  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.deepEqual(decryptSecretJson(first, key), value);
  assert.throws(() => decryptSecretJson(first, randomBytes(32)), /could not be decrypted/);
  assert.throws(() => decryptSecretJson({ ...first, ciphertext: `${first.ciphertext.slice(0, -2)}aa` }, key), /could not be decrypted/);
});

test("Gmail OAuth callback stores encrypted tokens and integration output redacts secrets", async () => {
  const server = buildServer();
  const tokenUserId = `gmail-token-oauth-${randomUUID()}`;
  const previousKey = process.env.ALECTO_SECRET_ENCRYPTION_KEY;
  const previousClientId = process.env.GOOGLE_CLIENT_ID;
  const previousClientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const previousRedirect = process.env.GMAIL_REDIRECT_URI;
  const originalFetch = globalThis.fetch;

  try {
    process.env.ALECTO_SECRET_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    process.env.GOOGLE_CLIENT_ID = "google-client";
    process.env.GOOGLE_CLIENT_SECRET = "google-secret";
    process.env.GMAIL_REDIRECT_URI = "http://localhost:3000/oauth/gmail/callback";

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({
          access_token: "secret-access-token",
          refresh_token: "secret-refresh-token",
          expires_in: 3600,
          token_type: "Bearer",
          scope: "https://www.googleapis.com/auth/gmail.readonly"
        }), { status: 200, headers: { "content-type": "application/json" } });
      }

      if (url.includes("gmail.googleapis.com/gmail/v1/users/me/profile")) {
        return new Response(JSON.stringify({ emailAddress: "user@example.com" }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }

      return new Response("not found", { status: 404 });
    }) as typeof fetch;

    const state = Buffer.from(JSON.stringify({ userId: tokenUserId }), "utf8").toString("base64url");
    const callback = await server.inject({
      method: "GET",
      url: `/oauth/gmail/callback?code=fake-code&state=${state}`
    });

    assert.equal(callback.statusCode, 200);
    assert.equal(callback.body, "Gmail connected for user@example.com. No active Gmail rules needed moving. You can return to Telegram.");
    assert.doesNotMatch(callback.body, /secret-access-token|secret-refresh-token|ciphertext|accessToken|refreshToken/);

    const connection = await prisma.integrationConnection.findFirstOrThrow({
      where: { userId: tokenUserId, integrationId: "gmail" }
    });
    const rawConfig = JSON.stringify(connection.config);
    assert.match(rawConfig, /"alg":"aes-256-gcm"/);
    assert.doesNotMatch(rawConfig, /secret-access-token|secret-refresh-token/);

    const response = await server.inject({
      method: "GET",
      url: `/users/${tokenUserId}/integrations`
    });
    assert.equal(response.statusCode, 200);
    const visible = JSON.stringify(response.json());
    assert.match(visible, /"tokenStorage":"encrypted"/);
    assert.match(visible, /"hasRefreshToken":true/);
    assert.doesNotMatch(visible, /secret-access-token|secret-refresh-token|"ciphertext"|"iv"|"tag"/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.ALECTO_SECRET_ENCRYPTION_KEY;
    else process.env.ALECTO_SECRET_ENCRYPTION_KEY = previousKey;
    if (previousClientId === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = previousClientId;
    if (previousClientSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
    else process.env.GOOGLE_CLIENT_SECRET = previousClientSecret;
    if (previousRedirect === undefined) delete process.env.GMAIL_REDIRECT_URI;
    else process.env.GMAIL_REDIRECT_URI = previousRedirect;
    await server.close();
    await prisma.user.deleteMany({ where: { id: tokenUserId } });
  }
});

test("Gmail legacy plaintext tokens migrate to encrypted config on sync", async () => {
  const server = buildServer();
  const tokenUserId = `gmail-token-legacy-${randomUUID()}`;
  const previousKey = process.env.ALECTO_SECRET_ENCRYPTION_KEY;
  const originalFetch = globalThis.fetch;

  try {
    process.env.ALECTO_SECRET_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    await prisma.user.create({ data: { id: tokenUserId } });
    const connection = await prisma.integrationConnection.create({
      data: {
        userId: tokenUserId,
        integrationId: "gmail",
        status: "active",
        config: {
          provider: "gmail",
          scope: "gmail.readonly",
          email: "legacy@example.com",
          token: {
            accessToken: "legacy-access-token",
            refreshToken: "legacy-refresh-token",
            expiresAt: Date.now() + 3_600_000,
            tokenType: "Bearer",
            scope: "gmail.readonly"
          }
        }
      }
    });
    await prisma.emailSignalRule.create({
      data: {
        userId: tokenUserId,
        connectionId: connection.id,
        adapterId: "job_search_email",
        name: "Job search emails",
        query: "newer_than:1d interview",
        status: "active",
        fetchStrategy: "query",
        maxMessagesPerSync: 5,
        maxEventsPerSync: 2,
        classifierMode: "rules",
        minAutoLogConfidence: 0.9,
        minReviewConfidence: 0.65,
        reviewBeforeLogging: false,
        createdBy: "user"
      }
    });

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal((init?.headers as Record<string, string> | undefined)?.authorization, "Bearer legacy-access-token");
      return new Response(JSON.stringify({ messages: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch;

    const response = await server.inject({
      method: "POST",
      url: `/users/${tokenUserId}/integrations/${connection.id}/sync`
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, "success");

    const migrated = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: connection.id } });
    const rawConfig = JSON.stringify(migrated.config);
    assert.match(rawConfig, /"alg":"aes-256-gcm"/);
    assert.doesNotMatch(rawConfig, /legacy-access-token|legacy-refresh-token/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.ALECTO_SECRET_ENCRYPTION_KEY;
    else process.env.ALECTO_SECRET_ENCRYPTION_KEY = previousKey;
    await server.close();
    await prisma.user.deleteMany({ where: { id: tokenUserId } });
  }
});

test("Gmail sync decrypts encrypted token internally without exposing it", async () => {
  const server = buildServer();
  const tokenUserId = `gmail-token-encrypted-sync-${randomUUID()}`;
  const previousKey = process.env.ALECTO_SECRET_ENCRYPTION_KEY;
  const originalFetch = globalThis.fetch;

  try {
    process.env.ALECTO_SECRET_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    await prisma.user.create({ data: { id: tokenUserId } });
    const token = {
      accessToken: "encrypted-sync-access-token",
      refreshToken: "encrypted-sync-refresh-token",
      expiresAt: Date.now() + 3_600_000,
      tokenType: "Bearer",
      scope: "gmail.readonly"
    };
    const connection = await prisma.integrationConnection.create({
      data: {
        userId: tokenUserId,
        integrationId: "gmail",
        status: "active",
        config: {
          provider: "gmail",
          scope: "gmail.readonly",
          email: "encrypted-sync@example.com",
          token: encryptSecretJson(token),
          tokenStorage: "encrypted",
          hasRefreshToken: true,
          tokenExpiresAt: token.expiresAt
        }
      }
    });
    await prisma.emailSignalRule.create({
      data: {
        userId: tokenUserId,
        connectionId: connection.id,
        adapterId: "job_search_email",
        name: "Job search emails",
        query: "newer_than:1d interview",
        status: "active",
        fetchStrategy: "query",
        maxMessagesPerSync: 5,
        maxEventsPerSync: 2,
        classifierMode: "rules",
        minAutoLogConfidence: 0.9,
        minReviewConfidence: 0.65,
        reviewBeforeLogging: false,
        createdBy: "user"
      }
    });

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal((init?.headers as Record<string, string> | undefined)?.authorization, "Bearer encrypted-sync-access-token");
      return new Response(JSON.stringify({ messages: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch;

    const response = await server.inject({
      method: "POST",
      url: `/users/${tokenUserId}/integrations/${connection.id}/sync`
    });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().status, "success");
    assert.doesNotMatch(JSON.stringify(response.json()), /encrypted-sync-access-token|encrypted-sync-refresh-token|ciphertext/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.ALECTO_SECRET_ENCRYPTION_KEY;
    else process.env.ALECTO_SECRET_ENCRYPTION_KEY = previousKey;
    await server.close();
    await prisma.user.deleteMany({ where: { id: tokenUserId } });
  }
});

test("natural Gmail sync requests route through safe sync behavior", async () => {
  const server = buildServer();
  const previousKey = process.env.ALECTO_SECRET_ENCRYPTION_KEY;
  const previousGoogleClientId = process.env.GOOGLE_CLIENT_ID;
  const previousGoogleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const originalFetch = globalThis.fetch;
  const notConnectedUserId = `natural-gmail-sync-none-${randomUUID()}`;
  const noRuleUserId = `natural-gmail-sync-no-rule-${randomUUID()}`;
  const syncUserId = `natural-gmail-sync-ok-${randomUUID()}`;
  const expiredAuthUserId = `natural-gmail-sync-expired-${randomUUID()}`;
  const missingKeyUserId = `natural-gmail-sync-missing-key-${randomUUID()}`;

  try {
    process.env.ALECTO_SECRET_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    process.env.GOOGLE_CLIENT_ID = "test-google-client-id";
    process.env.GOOGLE_CLIENT_SECRET = "test-google-client-secret";
    await prisma.user.createMany({
      data: [
        { id: notConnectedUserId },
        { id: noRuleUserId },
        { id: syncUserId },
        { id: expiredAuthUserId },
        { id: missingKeyUserId }
      ]
    });
    await prisma.integrationConnection.create({
      data: {
        userId: noRuleUserId,
        integrationId: "gmail",
        status: "active",
        config: {
          provider: "gmail",
          scope: "gmail.readonly",
          email: "no-rule@example.com",
          token: encryptSecretJson({
            accessToken: "no-rule-access-token",
            refreshToken: "no-rule-refresh-token",
            expiresAt: Date.now() + 3_600_000,
            tokenType: "Bearer",
            scope: "gmail.readonly"
          }),
          tokenStorage: "encrypted",
          hasRefreshToken: true
        }
      }
    });
    await prisma.goal.create({
      data: {
        userId: noRuleUserId,
        title: "Find a new developer job",
        category: "career",
        templateId: "career.job_search",
        status: "active",
        priority: "critical",
        importanceScore: 70
      }
    });
    const syncConnection = await prisma.integrationConnection.create({
      data: {
        userId: syncUserId,
        integrationId: "gmail",
        status: "active",
        config: {
          provider: "gmail",
          scope: "gmail.readonly",
          email: "sync@example.com",
          token: encryptSecretJson({
            accessToken: "natural-sync-access-token",
            refreshToken: "natural-sync-refresh-token",
            expiresAt: Date.now() + 3_600_000,
            tokenType: "Bearer",
            scope: "gmail.readonly"
          }),
          tokenStorage: "encrypted",
          hasRefreshToken: true
        }
      }
    });
    await prisma.integrationConnection.create({
      data: {
        userId: syncUserId,
        integrationId: "gmail",
        status: "active",
        config: {
          provider: "gmail",
          scope: "gmail.readonly",
          email: "old-no-rule@example.com",
          token: encryptSecretJson({
            accessToken: "old-no-rule-access-token",
            refreshToken: "old-no-rule-refresh-token",
            expiresAt: Date.now() + 3_600_000,
            tokenType: "Bearer",
            scope: "gmail.readonly"
          }),
          tokenStorage: "encrypted",
          hasRefreshToken: true
        }
      }
    });
    await prisma.emailSignalRule.create({
      data: {
        userId: syncUserId,
        connectionId: syncConnection.id,
        adapterId: "job_search_email",
        name: "Job search emails",
        query: "newer_than:1d interview",
        status: "active",
        fetchStrategy: "query",
        maxMessagesPerSync: 5,
        maxEventsPerSync: 2,
        classifierMode: "rules",
        minAutoLogConfidence: 0.9,
        minReviewConfidence: 0.65,
        reviewBeforeLogging: false,
        createdBy: "user"
      }
    });
    const expiredAuthConnection = await prisma.integrationConnection.create({
      data: {
        userId: expiredAuthUserId,
        integrationId: "gmail",
        status: "active",
        config: {
          provider: "gmail",
          scope: "gmail.readonly",
          email: "expired-auth@example.com",
          token: encryptSecretJson({
            accessToken: "expired-auth-access-token",
            refreshToken: "expired-auth-refresh-token",
            expiresAt: Date.now() - 3_600_000,
            tokenType: "Bearer",
            scope: "gmail.readonly"
          }),
          tokenStorage: "encrypted",
          hasRefreshToken: true
        }
      }
    });
    await prisma.emailSignalRule.create({
      data: {
        userId: expiredAuthUserId,
        connectionId: expiredAuthConnection.id,
        adapterId: "job_search_email",
        name: "Job search emails",
        query: "newer_than:1d interview",
        status: "active",
        fetchStrategy: "query",
        maxMessagesPerSync: 5,
        maxEventsPerSync: 2,
        classifierMode: "rules",
        minAutoLogConfidence: 0.9,
        minReviewConfidence: 0.65,
        reviewBeforeLogging: false,
        createdBy: "user"
      }
    });
    const missingKeyConnection = await prisma.integrationConnection.create({
      data: {
        userId: missingKeyUserId,
        integrationId: "gmail",
        status: "active",
        config: {
          provider: "gmail",
          scope: "gmail.readonly",
          email: "missing-key@example.com",
          token: encryptSecretJson({
            accessToken: "missing-key-access-token",
            refreshToken: "missing-key-refresh-token",
            expiresAt: Date.now() + 3_600_000,
            tokenType: "Bearer",
            scope: "gmail.readonly"
          }),
          tokenStorage: "encrypted",
          hasRefreshToken: true
        }
      }
    });
    await prisma.emailSignalRule.create({
      data: {
        userId: missingKeyUserId,
        connectionId: missingKeyConnection.id,
        adapterId: "job_search_email",
        name: "Job search emails",
        query: "newer_than:1d interview",
        status: "active",
        fetchStrategy: "query",
        maxMessagesPerSync: 5,
        maxEventsPerSync: 2,
        classifierMode: "rules",
        minAutoLogConfidence: 0.9,
        minReviewConfidence: 0.65,
        reviewBeforeLogging: false,
        createdBy: "user"
      }
    });

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);

      if (url.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "content-type": "application/json" }
        });
      }

      assert.match(
        (init?.headers as Record<string, string> | undefined)?.authorization ?? "",
        /^Bearer (natural-sync-access-token|no-rule-access-token)$/
      );
      return new Response(JSON.stringify({ messages: [] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch;

    let response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: notConnectedUserId, message: "sync Gmail" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Gmail is not connected yet/);
    assert.doesNotMatch(response.json().reply, /generic|maybe|secret|ciphertext|refresh/i);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: notConnectedUserId, message: "connect Gmail" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Status: not connected/);
    assert.match(response.json().reply, /readonly/);
    assert.match(response.json().reply, /\/connect_gmail/);
    assert.match(response.json().reply, /Scanning: off until Gmail is connected and at least one rule is enabled/);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: noRuleUserId, message: "sync my email" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Gmail is connected, but no email tracking rules are active/);
    assert.doesNotMatch(response.json().reply, /no-rule-access-token|no-rule-refresh-token|ciphertext|"iv"|"tag"/);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: noRuleUserId, message: "show Gmail setup" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Gmail setup/);
    assert.match(response.json().reply, /Status: connected/);
    assert.match(response.json().reply, /No active email tracking rules/);
    assert.match(response.json().reply, /Job-search email tracking/);
    assert.match(response.json().reply, /Mode: manual only/);
    assert.match(response.json().reply, /Checks: Alecto checks Gmail when you say ['"]sync Gmail['"]/);
    assert.doesNotMatch(response.json().reply, /adapter:|job_search_email|access token|refresh token|ciphertext/i);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: noRuleUserId, message: "enable job search rule for gmail" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Job-search email tracking is on/);
    assert.match(response.json().reply, /recruiter replies/);
    assert.match(response.json().reply, /Sync now: sync Gmail/);
    assert.doesNotMatch(response.json().reply, /adapter:|job_search_email|I've logged|great step|no-rule-access-token|no-rule-refresh-token|ciphertext|"iv"|"tag"/i);

    const enabledRules = await prisma.emailSignalRule.findMany({
      where: {
        userId: noRuleUserId,
        adapterId: "job_search_email",
        status: "active"
      }
    });
    assert.equal(enabledRules.length, 1);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: noRuleUserId, message: "enable job search rule for gmail" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Job-search email tracking is already on/);
    assert.doesNotMatch(response.json().reply, /adapter:|job_search_email/i);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: noRuleUserId, message: "sync my email" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Gmail sync: 0 messages checked, 0 new review items/);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: noRuleUserId, message: "Gmail status" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Active tracking:\n- Job-search email tracking/);
    assert.match(response.json().reply, /Next step: Say 'sync Gmail'/);
    assert.doesNotMatch(response.json().reply, /adapter:|job_search_email|no-rule-access-token|no-rule-refresh-token|ciphertext/i);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: expiredAuthUserId, message: "sync Gmail" }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().reply, "Gmail authorization expired. Reconnect Gmail.");
    assert.doesNotMatch(response.json().reply, /Gmail sync failed: Gmail sync failed/);
    assert.doesNotMatch(response.json().reply, /expired-auth-access-token|expired-auth-refresh-token|ciphertext|"iv"|"tag"/);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: syncUserId, message: "check my Gmail now" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Gmail sync: 0 messages checked, 0 new review items/);
    assert.doesNotMatch(response.json().reply, /older Gmail connection|active deduped|semantic deduped/);
    assert.doesNotMatch(response.json().reply, /natural-sync-access-token|natural-sync-refresh-token|ciphertext|"iv"|"tag"/);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: syncUserId, message: "sync integrations" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Gmail sync: 0 messages checked, 0 new review items/);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: syncUserId, message: "check inbox" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /For Gmail, say 'sync Gmail'/);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: syncUserId, message: "what can Gmail track" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Gmail works through explicit tracking rules/);
    assert.match(response.json().reply, /Job search/);
    assert.match(response.json().reply, /Work actions/);
    assert.doesNotMatch(response.json().reply, /adapter:|job_search_email|work_action_email|access token|refresh token|ciphertext/i);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: syncUserId, message: "can you track Endesa bills from Gmail" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /I can set up a review-first Gmail rule/);
    assert.match(response.json().reply, /Endesa/);
    assert.match(response.json().reply, /auto-log: off/);
    assert.doesNotMatch(response.json().reply, /I've logged|created|adapter:|access token|refresh token|ciphertext/i);

    delete process.env.ALECTO_SECRET_ENCRYPTION_KEY;
    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: missingKeyUserId, message: "update Gmail signals" }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().reply, "Gmail token encryption key is missing. Set ALECTO_SECRET_ENCRYPTION_KEY and restart.");
    assert.doesNotMatch(JSON.stringify(response.json()), /missing-key-access-token|missing-key-refresh-token|ciphertext|"iv"|"tag"/);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: syncUserId, message: "sync Gmail so I can bet safely" }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().riskState, "RED");
    assert.doesNotMatch(response.json().reply, /Gmail sync:/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.ALECTO_SECRET_ENCRYPTION_KEY;
    else process.env.ALECTO_SECRET_ENCRYPTION_KEY = previousKey;
    if (previousGoogleClientId === undefined) delete process.env.GOOGLE_CLIENT_ID;
    else process.env.GOOGLE_CLIENT_ID = previousGoogleClientId;
    if (previousGoogleClientSecret === undefined) delete process.env.GOOGLE_CLIENT_SECRET;
    else process.env.GOOGLE_CLIENT_SECRET = previousGoogleClientSecret;
    await server.close();
    await prisma.user.deleteMany({
      where: { id: { in: [notConnectedUserId, noRuleUserId, syncUserId, expiredAuthUserId, missingKeyUserId] } }
    });
  }
});

test("Gmail encrypted token without encryption key returns safe sync error", async () => {
  const server = buildServer();
  const tokenUserId = `gmail-token-missing-key-${randomUUID()}`;
  const previousKey = process.env.ALECTO_SECRET_ENCRYPTION_KEY;
  const key = randomBytes(32);

  try {
    await prisma.user.create({ data: { id: tokenUserId } });
    const token = {
      accessToken: "encrypted-access-token",
      refreshToken: "encrypted-refresh-token",
      expiresAt: Date.now() + 3_600_000,
      tokenType: "Bearer",
      scope: "gmail.readonly"
    };
    const connection = await prisma.integrationConnection.create({
      data: {
        userId: tokenUserId,
        integrationId: "gmail",
        status: "active",
        config: {
          provider: "gmail",
          scope: "gmail.readonly",
          email: "encrypted@example.com",
          token: encryptSecretJson(token, key),
          tokenStorage: "encrypted",
          hasRefreshToken: true,
          tokenExpiresAt: token.expiresAt
        }
      }
    });
    await prisma.emailSignalRule.create({
      data: {
        userId: tokenUserId,
        connectionId: connection.id,
        adapterId: "job_search_email",
        name: "Job search emails",
        query: "newer_than:1d interview",
        status: "active",
        fetchStrategy: "query",
        maxMessagesPerSync: 5,
        maxEventsPerSync: 2,
        classifierMode: "rules",
        minAutoLogConfidence: 0.9,
        minReviewConfidence: 0.65,
        reviewBeforeLogging: false,
        createdBy: "user"
      }
    });

    delete process.env.ALECTO_SECRET_ENCRYPTION_KEY;

    const response = await server.inject({
      method: "POST",
      url: `/users/${tokenUserId}/integrations/${connection.id}/sync`
    });

    assert.equal(response.statusCode, 502);
    assert.equal(response.json().error, "Gmail token encryption key is missing. Set ALECTO_SECRET_ENCRYPTION_KEY and restart.");
    assert.equal(response.json().errorStage, "token_refresh");
    assert.doesNotMatch(JSON.stringify(response.json()), /encrypted-access-token|encrypted-refresh-token|ciphertext/);
  } finally {
    if (previousKey === undefined) delete process.env.ALECTO_SECRET_ENCRYPTION_KEY;
    else process.env.ALECTO_SECRET_ENCRYPTION_KEY = previousKey;
    await server.close();
    await prisma.user.deleteMany({ where: { id: tokenUserId } });
  }
});

test("Gmail timing questions route to sync guidance before custom rule creation or LLM routing", async () => {
  const previousRouterEnabled = process.env.LLM_ROUTER_ENABLED;
  const previousRouterMock = process.env.LLM_ROUTER_MOCK_RESPONSE;
  const previousOpenAIKey = process.env.OPENAI_API_KEY;
  const userId = `gmail-timing-routing-${randomUUID()}`;
  const riskUserId = `gmail-timing-risk-${randomUUID()}`;
  const server = buildServer();

  try {
    await server.ready();
    process.env.LLM_ROUTER_ENABLED = "true";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.LLM_ROUTER_MOCK_RESPONSE = JSON.stringify({
      intent: "gmail_custom_rule_request",
      operation: "create",
      confidence: 0.97,
      reason: "Bad mock tries to turn a timing question into a custom rule.",
      language: "en",
      sideEffectRisk: "write",
      requiresConfirmation: true,
      target: "Gmail",
      keywordFilters: ["Gmail"],
      senderFilters: [],
      removeKeywordFilters: [],
      goalHint: null,
      shouldUnlinkGoal: false,
      userFacingIssue: null
    });
    await prisma.user.createMany({ data: [{ id: userId }, { id: riskUserId }] });
    const connection = await prisma.integrationConnection.create({
      data: {
        userId,
        integrationId: "gmail",
        status: "active",
        config: {
          provider: "gmail",
          scope: "gmail.readonly",
          email: "timing@example.com",
          hasRefreshToken: true
        }
      }
    });
    await prisma.emailSignalRule.create({
      data: {
        userId,
        connectionId: connection.id,
        adapterId: "work_action_email",
        name: "Work action emails",
        query: "newer_than:7d \"can you review\"",
        status: "active",
        fetchStrategy: "query",
        maxMessagesPerSync: 25,
        maxEventsPerSync: 5,
        classifierMode: "hybrid",
        minAutoLogConfidence: 0.9,
        minReviewConfidence: 0.65,
        reviewBeforeLogging: true,
        createdBy: "user"
      }
    });
    await prisma.goal.create({
      data: {
        userId: riskUserId,
        title: "Control impulsive betting",
        category: "finance",
        templateId: "finance.control_betting_trading",
        status: "active"
      }
    });

    for (const message of [
      "when do u check my gmail?",
      "when do u check my mail",
      "do you check Gmail automatically",
      "will you notify me about emails"
    ]) {
      const response = await server.inject({
        method: "POST",
        url: "/messages/process",
        payload: { userId, message }
      });
      assert.equal(response.statusCode, 200);
      assert.match(response.json().reply, /Alecto checks Gmail when you say 'sync Gmail'/);
      assert.match(response.json().reply, /Automatic sync is off/);
      assert.match(response.json().reply, /not instant arrival tracking yet/i);
      assert.match(response.json().reply, /^For active Gmail rules:/);
      assert.doesNotMatch(response.json().reply, /^For Work action emails:/);
      assert.equal(response.json().routeDebug.intent, "gmail_sync_guidance");
      assert.equal(response.json().routeDebug.routerSource, "deterministic_surface");
      assert.doesNotMatch(response.json().reply, /review-first Gmail rule|too broad|sender, company|project, or 2-3 keywords/i);
    }

    const riskResponse = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: riskUserId, message: "when do you check Gmail so I can bet safely" }
    });
    assert.equal(riskResponse.statusCode, 200);
    assert.equal(riskResponse.json().riskState, "RED");
    assert.doesNotMatch(riskResponse.json().reply, /sync Gmail|email rules/i);
  } finally {
    if (previousRouterEnabled === undefined) delete process.env.LLM_ROUTER_ENABLED;
    else process.env.LLM_ROUTER_ENABLED = previousRouterEnabled;
    if (previousRouterMock === undefined) delete process.env.LLM_ROUTER_MOCK_RESPONSE;
    else process.env.LLM_ROUTER_MOCK_RESPONSE = previousRouterMock;
    if (previousOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAIKey;
    await server.close();
    await prisma.user.deleteMany({ where: { id: { in: [userId, riskUserId] } } });
  }
});

test("Gmail setup autonomy preferences are state-aware and confirmation-first", async () => {
  const server = buildServer();
  const previousIntegrationSyncEnabled = process.env.INTEGRATION_SYNC_ENABLED;
  const previousIntegrationSyncInterval = process.env.INTEGRATION_SYNC_INTERVAL_MINUTES;
  const disconnectedUserId = `gmail-autonomy-disconnected-${randomUUID()}`;
  const noRuleUserId = `gmail-autonomy-no-rule-${randomUUID()}`;
  const configuredUserId = `gmail-autonomy-configured-${randomUUID()}`;
  const riskUserId = `gmail-autonomy-risk-${randomUUID()}`;

  try {
    process.env.INTEGRATION_SYNC_ENABLED = "false";
    process.env.INTEGRATION_SYNC_INTERVAL_MINUTES = "15";
    await server.ready();
    await prisma.user.createMany({
      data: [
        { id: disconnectedUserId },
        { id: noRuleUserId },
        { id: configuredUserId },
        { id: riskUserId }
      ]
    });
    const noRuleConnection = await prisma.integrationConnection.create({
      data: {
        userId: noRuleUserId,
        integrationId: "gmail",
        status: "active",
        config: {
          provider: "gmail",
          scope: "gmail.readonly",
          email: "norule@example.com",
          hasRefreshToken: true,
          accessToken: "must-not-leak",
          refreshToken: "must-not-leak-refresh"
        }
      }
    });
    await prisma.goal.createMany({
      data: [
        {
          userId: noRuleUserId,
          title: "Find a new developer job",
          category: "career",
          templateId: "career.job_search",
          status: "active"
        },
        {
          userId: noRuleUserId,
          title: "Improve strength and energy",
          category: "health",
          templateId: "health.strength_energy",
          status: "active"
        },
        {
          userId: noRuleUserId,
          title: "Track Endesa bills",
          category: "finance",
          status: "active"
        }
      ]
    });
    await prisma.notificationSettings.create({
      data: {
        userId: configuredUserId,
        telegramUserId: "12345",
        timezone: "Europe/Madrid"
      }
    });
    const configuredConnection = await prisma.integrationConnection.create({
      data: {
        userId: configuredUserId,
        integrationId: "gmail",
        status: "active",
        lastSyncedAt: new Date("2026-08-12T08:00:00.000Z"),
        config: {
          provider: "gmail",
          scope: "gmail.readonly",
          email: "configured@example.com",
          hasRefreshToken: true,
          gmailAutonomy: {
            syncMode: "scheduled",
            syncIntervalMinutes: 60,
            reviewNotificationEnabled: false
          },
          token: {
            ciphertext: "must-not-leak-ciphertext",
            iv: "must-not-leak-iv",
            tag: "must-not-leak-tag"
          }
        }
      }
    });
    const utilityGoal = await prisma.goal.create({
      data: {
        userId: configuredUserId,
        title: "Track energy expenses",
        category: "finance",
        status: "active"
      }
    });
    await prisma.emailSignalRule.create({
      data: {
        userId: configuredUserId,
        connectionId: configuredConnection.id,
        adapterId: "work_action_email",
        name: "Work action emails",
        query: "newer_than:7d \"can you review\"",
        status: "active",
        fetchStrategy: "query",
        maxMessagesPerSync: 25,
        maxEventsPerSync: 5,
        classifierMode: "hybrid",
        minAutoLogConfidence: 0.9,
        minReviewConfidence: 0.65,
        reviewBeforeLogging: true,
        createdBy: "user"
      }
    });
    const customRule = await prisma.emailSignalRule.create({
      data: {
        userId: configuredUserId,
        connectionId: configuredConnection.id,
        goalId: utilityGoal.id,
        adapterId: "custom_email_review",
        name: "Endesa emails",
        query: "newer_than:30d Endesa",
        status: "active",
        fetchStrategy: "query",
        maxMessagesPerSync: 25,
        maxEventsPerSync: 5,
        classifierMode: "rules",
        minAutoLogConfidence: 1,
        minReviewConfidence: 0.65,
        reviewBeforeLogging: true,
        createdBy: "user"
      }
    });
    await prisma.emailReviewItem.create({
      data: {
        userId: configuredUserId,
        connectionId: configuredConnection.id,
        ruleId: customRule.id,
        adapterId: "custom_email_review",
        provider: "gmail",
        providerMessageId: "gmail-review-autonomy",
        externalId: `gmail-review:autonomy:${randomUUID()}`,
        subject: "Endesa factura",
        from: "Endesa <noreply@endesa.com>",
        snippet: "Factura ready",
        proposedEventType: "custom_email_review",
        confidence: 0.7,
        reason: "Custom tracking match.",
        evidence: "Endesa factura",
        extracted: {},
        status: "pending"
      }
    });
    await prisma.goal.create({
      data: {
        userId: riskUserId,
        title: "Control impulsive betting",
        category: "finance",
        templateId: "finance.control_betting_trading",
        status: "active"
      }
    });

    let response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: disconnectedUserId, message: "show Gmail setup" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Status: not connected/);
    assert.match(response.json().reply, /readonly/);
    assert.doesNotMatch(response.json().reply, /accessToken|refreshToken|ciphertext|"iv"|"tag"/i);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: noRuleUserId, message: "show Gmail setup" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /No active email tracking rules/);
    assert.match(response.json().reply, /Job-search email tracking/);
    assert.match(response.json().reply, /Custom sender\/keyword tracking/);
    assert.doesNotMatch(response.json().reply, /Improve strength and energy/);
    assert.doesNotMatch(response.json().reply, /accessToken|refreshToken|must-not-leak/i);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: configuredUserId, message: "Gmail status" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /connected as configured@example.com/);
    assert.match(response.json().reply, /Mode: scheduled preference saved, background sync off/);
    assert.match(response.json().reply, /review-waiting notifications off/);
    assert.match(response.json().reply, /1 email review is waiting/);
    assert.match(response.json().reply, /Work-action email tracking/);
    assert.match(response.json().reply, /Endesa emails/);
    assert.doesNotMatch(response.json().reply, /adapter:|work_action_email|custom_email_review|accessToken|refreshToken|ciphertext|"iv"|"tag"|must-not-leak/i);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: configuredUserId, message: "when do u check my gmail?" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Automatic sync preference is saved, but background sync is disabled/);
    assert.match(response.json().reply, /Only active Gmail rules are checked/);
    assert.match(response.json().reply, /Alecto cannot send emails or change labels/);
    assert.equal(response.json().routeDebug.intent, "gmail_sync_guidance");

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: configuredUserId, message: "check Gmail every hour" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /set Gmail to scheduled checks every hour/);
    assert.match(response.json().reply, /Confirm with "yes" or cancel/);
    assert.equal(response.json().routeDebug.intent, "gmail_autonomy_preference");

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: configuredUserId, message: "yes" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Gmail preference saved: checks every hour/);
    assert.match(response.json().reply, /Background sync is currently disabled/);
    let updatedConnection = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: configuredConnection.id } });
    assert.equal((updatedConnection.config as { gmailAutonomy: { syncMode: string } }).gmailAutonomy.syncMode, "scheduled");
    assert.equal((updatedConnection.config as { gmailAutonomy: { syncIntervalMinutes: number } }).gmailAutonomy.syncIntervalMinutes, 60);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: configuredUserId, message: "make Gmail manual only" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /make Gmail manual only/);
    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: configuredUserId, message: "yes" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Gmail is set to manual only/);
    updatedConnection = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: configuredConnection.id } });
    assert.equal((updatedConnection.config as { gmailAutonomy: { syncMode: string } }).gmailAutonomy.syncMode, "manual_only");

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: configuredUserId, message: "notify me when Gmail reviews are waiting" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /turn Gmail review notifications on/);
    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: configuredUserId, message: "yes" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Gmail review notifications are on/);
    updatedConnection = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: configuredConnection.id } });
    assert.equal((updatedConnection.config as { gmailAutonomy: { reviewNotificationEnabled: boolean } }).gmailAutonomy.reviewNotificationEnabled, true);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: configuredUserId, message: "will you notify me about emails?" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Review notifications are on/);
    assert.equal(
      await prisma.pendingAction.count({
        where: {
          userId: configuredUserId,
          status: "pending",
          type: "custom_email_rule",
          payload: {
            path: ["operation"],
            equals: "gmail_autonomy_preference"
          }
        }
      }),
      0
    );

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: configuredUserId, message: "daily Gmail digest" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Daily Gmail digest is not implemented yet/);
    assert.equal(
      await prisma.pendingAction.count({
        where: {
          userId: configuredUserId,
          status: "pending",
          type: "custom_email_rule",
          payload: {
            path: ["operation"],
            equals: "gmail_autonomy_preference"
          }
        }
      }),
      0
    );

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: configuredUserId, message: "only check work emails during work hours" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Work-hours Gmail checking is not implemented yet/);
    assert.equal(
      await prisma.pendingAction.count({
        where: {
          userId: configuredUserId,
          status: "pending",
          type: "custom_email_rule",
          payload: {
            path: ["operation"],
            equals: "gmail_autonomy_preference"
          }
        }
      }),
      0
    );

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: configuredUserId, message: "will work emails become tasks automatically?" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Work-action emails do not become tasks automatically/);
    assert.match(response.json().reply, /approval can create an ActionItem/);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: riskUserId, message: "check Gmail every hour for betting signals" }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().riskState, "RED");
    assert.doesNotMatch(response.json().reply, /Gmail|scheduled checks|review notifications/i);
    assert.equal(await prisma.pendingAction.count({ where: { userId: riskUserId, type: "custom_email_rule", status: "pending" } }), 0);

    assert.equal(noRuleConnection.integrationId, "gmail");
  } finally {
    if (previousIntegrationSyncEnabled === undefined) delete process.env.INTEGRATION_SYNC_ENABLED;
    else process.env.INTEGRATION_SYNC_ENABLED = previousIntegrationSyncEnabled;
    if (previousIntegrationSyncInterval === undefined) delete process.env.INTEGRATION_SYNC_INTERVAL_MINUTES;
    else process.env.INTEGRATION_SYNC_INTERVAL_MINUTES = previousIntegrationSyncInterval;
    await server.close();
    await prisma.user.deleteMany({
      where: { id: { in: [disconnectedUserId, noRuleUserId, configuredUserId, riskUserId] } }
    });
  }
});

test("Gmail status and debug output show scheduled background eligibility safely", async () => {
  const server = buildServer();
  const previousIntegrationSyncEnabled = process.env.INTEGRATION_SYNC_ENABLED;
  const previousIntegrationSyncInterval = process.env.INTEGRATION_SYNC_INTERVAL_MINUTES;
  const userId = `gmail-background-status-${randomUUID()}`;

  try {
    process.env.INTEGRATION_SYNC_ENABLED = "true";
    process.env.INTEGRATION_SYNC_INTERVAL_MINUTES = "15";
    await server.ready();
    await prisma.user.create({ data: { id: userId } });
    await prisma.notificationSettings.create({
      data: {
        userId,
        telegramUserId: "12345",
        timezone: "Europe/Madrid"
      }
    });
    const connection = await prisma.integrationConnection.create({
      data: {
        userId,
        integrationId: "gmail",
        status: "active",
        lastSyncedAt: new Date("2026-08-12T09:59:00.000Z"),
        config: {
          provider: "gmail",
          scope: "gmail.readonly",
          email: "scheduled@example.com",
          hasRefreshToken: true,
          gmailAutonomy: {
            syncMode: "scheduled",
            syncIntervalMinutes: 60,
            reviewNotificationEnabled: true,
            lastBackgroundSyncAttemptedAt: "2026-08-12T09:30:00.000Z",
            lastBackgroundSyncedAt: "2026-08-12T09:30:00.000Z",
            lastBackgroundSyncStatus: "success"
          },
          token: {
            ciphertext: "must-not-leak-ciphertext",
            iv: "must-not-leak-iv",
            tag: "must-not-leak-tag"
          }
        }
      }
    });
    await prisma.emailSignalRule.create({
      data: {
        userId,
        connectionId: connection.id,
        adapterId: "work_action_email",
        name: "Work action emails",
        query: "newer_than:7d \"can you review\"",
        status: "active",
        fetchStrategy: "query",
        maxMessagesPerSync: 25,
        maxEventsPerSync: 5,
        classifierMode: "hybrid",
        minAutoLogConfidence: 0.9,
        minReviewConfidence: 0.65,
        reviewBeforeLogging: true,
        createdBy: "user"
      }
    });

    let response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "Gmail status" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Mode: scheduled, about every hour/);
    assert.match(response.json().reply, /Alecto checks active Gmail rules on the worker schedule/);
    assert.match(response.json().reply, /Last background check:/);
    assert.match(response.json().reply, /Next background check:/);
    assert.doesNotMatch(response.json().reply, /INTEGRATION_SYNC_ENABLED|accessToken|refreshToken|ciphertext|"iv"|"tag"|must-not-leak/i);

    response = await server.inject({
      method: "GET",
      url: `/users/${userId}/integrations/gmail/background-sync/debug?now=${encodeURIComponent("2026-08-12T10:00:00.000Z")}`
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.json(), {
      globalBackgroundIntegrationSyncEnabled: true,
      gmailConnected: true,
      connectionId: connection.id,
      connectionStatus: "active",
      mode: "scheduled",
      intervalMinutes: 60,
      lastBackgroundSyncAttemptedAt: "2026-08-12T09:30:00.000Z",
      lastBackgroundSyncedAt: "2026-08-12T09:30:00.000Z",
      nextDueAt: "2026-08-12T10:30:00.000Z",
      activeRuleCount: 1,
      notificationPreference: "on",
      deliveryAvailable: true,
      eligible: false,
      reason: "not_due"
    });
    assert.doesNotMatch(JSON.stringify(response.json()), /accessToken|refreshToken|ciphertext|"iv"|"tag"|must-not-leak/i);
  } finally {
    if (previousIntegrationSyncEnabled === undefined) delete process.env.INTEGRATION_SYNC_ENABLED;
    else process.env.INTEGRATION_SYNC_ENABLED = previousIntegrationSyncEnabled;
    if (previousIntegrationSyncInterval === undefined) delete process.env.INTEGRATION_SYNC_INTERVAL_MINUTES;
    else process.env.INTEGRATION_SYNC_INTERVAL_MINUTES = previousIntegrationSyncInterval;
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("Gmail autonomy notification direction, missing rule answers, and pending focus are safe", async () => {
  const previousIntegrationSyncEnabled = process.env.INTEGRATION_SYNC_ENABLED;
  const previousIntegrationSyncInterval = process.env.INTEGRATION_SYNC_INTERVAL_MINUTES;
  const previousRouterEnabled = process.env.LLM_ROUTER_ENABLED;
  const previousRouterMock = process.env.LLM_ROUTER_MOCK_RESPONSE;
  const previousOpenAIKey = process.env.OPENAI_API_KEY;
  const userId = `gmail-autonomy-focus-${randomUUID()}`;
  const riskUserId = `gmail-autonomy-focus-risk-${randomUUID()}`;
  const server = buildServer();

  try {
    process.env.INTEGRATION_SYNC_ENABLED = "true";
    process.env.INTEGRATION_SYNC_INTERVAL_MINUTES = "15";
    process.env.LLM_ROUTER_ENABLED = "true";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.LLM_ROUTER_MOCK_RESPONSE = JSON.stringify({
      intent: "gmail_autonomy_preference",
      operation: "edit",
      confidence: 0.99,
      reason: "Bad mock tries to override deterministic notification direction.",
      language: "en",
      sideEffectRisk: "write",
      requiresConfirmation: true,
      target: "Gmail reviews",
      keywordFilters: [],
      senderFilters: [],
      removeKeywordFilters: [],
      goalHint: null,
      shouldUnlinkGoal: false,
      userFacingIssue: null
    });
    await server.ready();
    await prisma.user.createMany({ data: [{ id: userId }, { id: riskUserId }] });
    await prisma.notificationSettings.create({
      data: {
        userId,
        telegramUserId: "12345",
        timezone: "Europe/Madrid"
      }
    });
    const connection = await prisma.integrationConnection.create({
      data: {
        userId,
        integrationId: "gmail",
        status: "active",
        config: {
          provider: "gmail",
          scope: "gmail.readonly",
          email: "focus@example.com",
          hasRefreshToken: true,
          gmailAutonomy: {
            reviewNotificationEnabled: true
          }
        }
      }
    });
    await prisma.goal.create({
      data: {
        userId: riskUserId,
        title: "Control impulsive betting",
        category: "finance",
        templateId: "finance.control_betting_trading",
        status: "active"
      }
    });

    let response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "don't notify me about Gmail reviews" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /turn Gmail review notifications off/);
    assert.equal(response.json().routeDebug.routerSource, "deterministic_surface");
    assert.equal(response.json().routeDebug.intent, "gmail_autonomy_preference");
    let pending = await prisma.pendingAction.findFirstOrThrow({
      where: { userId, status: "pending", type: "custom_email_rule" }
    });
    assert.equal((pending.payload as { reviewNotificationEnabled?: boolean }).reviewNotificationEnabled, false);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "yes" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Gmail review notifications are off/);
    let updatedConnection = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: connection.id } });
    assert.equal((updatedConnection.config as { gmailAutonomy: { reviewNotificationEnabled: boolean } }).gmailAutonomy.reviewNotificationEnabled, false);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "notify me when Gmail reviews are waiting" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /turn Gmail review notifications on/);
    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "yes" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Gmail review notifications are on/);
    updatedConnection = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: connection.id } });
    assert.equal((updatedConnection.config as { gmailAutonomy: { reviewNotificationEnabled: boolean } }).gmailAutonomy.reviewNotificationEnabled, true);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "check Gmail manually only" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /make Gmail manual only/);
    assert.equal(await prisma.pendingAction.count({ where: { userId, status: "pending", type: "custom_email_rule" } }), 1);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "Gmail status" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Gmail setup/);
    assert.equal(
      await prisma.pendingAction.count({
        where: {
          userId,
          status: "pending",
          type: "custom_email_rule",
          payload: { path: ["operation"], equals: "gmail_autonomy_preference" }
        }
      }),
      0
    );

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "yes" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /pending decision expired|Please ask again/i);
    updatedConnection = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: connection.id } });
    assert.notEqual((updatedConnection.config as { gmailAutonomy?: { syncMode?: string } }).gmailAutonomy?.syncMode, "manual_only");

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "check Gmail manually only" }
    });
    assert.equal(response.statusCode, 200);
    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "check Gmail every hour" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /scheduled checks every hour/);
    pending = await prisma.pendingAction.findFirstOrThrow({
      where: { userId, status: "pending", type: "custom_email_rule" }
    });
    assert.equal((pending.payload as { syncMode?: string }).syncMode, "scheduled");
    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "yes" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Gmail scheduled checks are set to every hour/);
    updatedConnection = await prisma.integrationConnection.findUniqueOrThrow({ where: { id: connection.id } });
    assert.equal((updatedConnection.config as { gmailAutonomy: { syncMode: string } }).gmailAutonomy.syncMode, "scheduled");
    assert.equal((updatedConnection.config as { gmailAutonomy: { syncIntervalMinutes: number } }).gmailAutonomy.syncIntervalMinutes, 60);

    await prisma.emailSignalRule.create({
      data: {
        userId,
        connectionId: connection.id,
        adapterId: "work_action_email",
        name: "Work action emails",
        query: "newer_than:7d \"can you review\"",
        status: "active",
        fetchStrategy: "query",
        maxMessagesPerSync: 25,
        maxEventsPerSync: 5,
        classifierMode: "hybrid",
        minAutoLogConfidence: 0.9,
        minReviewConfidence: 0.65,
        reviewBeforeLogging: true,
        createdBy: "user"
      }
    });

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "where do Endesa emails go?" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /I don't see an active Endesa Gmail rule right now/);
    assert.match(response.json().reply, /goes to email reviews first/);
    assert.match(response.json().reply, /does not auto-log/);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "does Endesa auto-log?" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /I don't see an active Endesa Gmail rule right now/);
    assert.match(response.json().reply, /does not auto-log/);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "where do endesa mails go?" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /I don't see an active endesa Gmail rule right now/i);
    assert.doesNotMatch(response.json().reply, /Gmail rule: Work action emails/);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "does endesa auto-log?" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /I don't see an active endesa Gmail rule right now/i);
    assert.doesNotMatch(response.json().reply, /Gmail rule: Work action emails/);

    const endesaRule = await prisma.emailSignalRule.create({
      data: {
        userId,
        connectionId: connection.id,
        adapterId: "custom_email_review",
        name: "Endesa emails",
        query: "newer_than:30d Endesa",
        status: "active",
        fetchStrategy: "query",
        maxMessagesPerSync: 25,
        maxEventsPerSync: 5,
        classifierMode: "rules",
        minAutoLogConfidence: 1,
        minReviewConfidence: 0.65,
        reviewBeforeLogging: true,
        createdBy: "user"
      }
    });

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "does Endesa auto-log?" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Gmail rule: Endesa emails/);
    assert.match(response.json().reply, /Custom rules never auto-log/);

    await prisma.emailSignalRule.update({ where: { id: endesaRule.id }, data: { status: "paused" } });
    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "where do Endesa emails go?" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Endesa tracking is paused/);
    assert.match(response.json().reply, /When active, custom Gmail matches go to email reviews first and do not auto-log/);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: riskUserId, message: "notify me when betting tips arrive" }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().riskState, "RED");
    assert.equal(await prisma.pendingAction.count({ where: { userId: riskUserId, status: "pending" } }), 0);
  } finally {
    if (previousIntegrationSyncEnabled === undefined) delete process.env.INTEGRATION_SYNC_ENABLED;
    else process.env.INTEGRATION_SYNC_ENABLED = previousIntegrationSyncEnabled;
    if (previousIntegrationSyncInterval === undefined) delete process.env.INTEGRATION_SYNC_INTERVAL_MINUTES;
    else process.env.INTEGRATION_SYNC_INTERVAL_MINUTES = previousIntegrationSyncInterval;
    if (previousRouterEnabled === undefined) delete process.env.LLM_ROUTER_ENABLED;
    else process.env.LLM_ROUTER_ENABLED = previousRouterEnabled;
    if (previousRouterMock === undefined) delete process.env.LLM_ROUTER_MOCK_RESPONSE;
    else process.env.LLM_ROUTER_MOCK_RESPONSE = previousRouterMock;
    if (previousOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAIKey;
    await server.close();
    await prisma.user.deleteMany({ where: { id: { in: [userId, riskUserId] } } });
  }
});

test("custom Gmail tracking rules are confirmation-first and review-only", async () => {
  const previousKey = process.env.ALECTO_SECRET_ENCRYPTION_KEY;
  const originalFetch = globalThis.fetch;
  const userId = `custom-gmail-rule-${randomUUID()}`;
  const broadUserId = `custom-gmail-broad-${randomUUID()}`;
  const server = buildServer();

  try {
    process.env.ALECTO_SECRET_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    await server.ready();
    await prisma.user.createMany({
      data: [{ id: userId }, { id: broadUserId }]
    });
    await prisma.goal.create({
      data: {
        userId,
        title: "Track household bills",
        category: "finance",
        status: "active",
        priority: "medium",
        importanceScore: 25
      }
    });
    const connection = await prisma.integrationConnection.create({
      data: {
        userId,
        integrationId: "gmail",
        status: "active",
        config: {
          provider: "gmail",
          scope: "gmail.readonly",
          email: "custom@example.com",
          token: encryptSecretJson({
            accessToken: "custom-gmail-access-token",
            refreshToken: "custom-gmail-refresh-token",
            expiresAt: Date.now() + 3_600_000,
            tokenType: "Bearer",
            scope: "gmail.readonly"
          }),
          tokenStorage: "encrypted",
          hasRefreshToken: true
        }
      }
    });
    await prisma.integrationConnection.create({
      data: {
        userId: broadUserId,
        integrationId: "gmail",
        status: "active",
        config: {
          provider: "gmail",
          scope: "gmail.readonly",
          email: "broad@example.com",
          token: encryptSecretJson({
            accessToken: "broad-gmail-access-token",
            refreshToken: "broad-gmail-refresh-token",
            expiresAt: Date.now() + 3_600_000,
            tokenType: "Bearer",
            scope: "gmail.readonly"
          }),
          tokenStorage: "encrypted",
          hasRefreshToken: true
        }
      }
    });

    await prisma.pendingAction.create({
      data: {
        userId,
        type: "custom_email_rule",
        summary: "Expired Gmail tracking proposal",
        payload: {
          operation: "create_rule",
          displayName: "Old Endesa tracking"
        },
        expiresAt: new Date(Date.now() - 60_000)
      }
    });

    let response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "create a rule for Endesa bills as I wanna track the cost is always around the 60 euros" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /review-first Gmail rule/);
    assert.match(response.json().reply, /name: Endesa bills/);
    assert.match(response.json().reply, /looks for: .*Endesa/i);
    assert.match(response.json().reply, /auto-log: off/);
    assert.doesNotMatch(response.json().reply, /pending decision expired/i);
    assert.doesNotMatch(response.json().reply, /access token|refresh token|ciphertext|"iv"|"tag"/i);

    let activeRules = await prisma.emailSignalRule.findMany({
      where: { userId, adapterId: "custom_email_review", status: "active" }
    });
    assert.equal(activeRules.length, 0);

    let pending = await prisma.pendingAction.findFirstOrThrow({
      where: { userId, type: "custom_email_rule", status: "pending" },
      orderBy: { createdAt: "desc" }
    });
    assert.equal(pending.payload.adapterId, "custom_email_review");
    assert.equal(pending.payload.reviewBeforeLogging, true);
    assert.match(String(pending.payload.queryPreview), /Endesa/);
    assert.match(String(pending.payload.queryPreview), /bill|invoice|factura/);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "yes" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Endesa bills tracking is on/);
    assert.match(response.json().reply, /email review/);

    const rule = await prisma.emailSignalRule.findFirstOrThrow({
      where: { userId, adapterId: "custom_email_review", status: "active" }
    });
    assert.equal(rule.reviewBeforeLogging, true);
    assert.equal(rule.classifierMode, "rules");
    assert.equal(rule.maxEventsPerSync, 5);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "track emails from client@example.com for dashboard project" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /client@example.com/);
    assert.match(response.json().reply, /dashboard/i);
    pending = await prisma.pendingAction.findFirstOrThrow({
      where: { userId, type: "custom_email_rule", status: "pending" },
      orderBy: { createdAt: "desc" }
    });
    assert.deepEqual(pending.payload.senderFilters, ["client@example.com"]);
    assert.match(String(pending.payload.queryPreview), /from:client@example.com/);
    assert.match(String(pending.payload.queryPreview), /dashboard/);
    await prisma.pendingAction.update({ where: { id: pending.id }, data: { status: "rejected" } });

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: broadUserId, message: "watch every email" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /too broad/i);
    assert.equal(
      await prisma.pendingAction.count({ where: { userId: broadUserId, type: "custom_email_rule", status: "pending" } }),
      0
    );

    const bodyText = "Your Endesa factura for electricity is ready. Payment due this month.";
    globalThis.fetch = (async (input) => {
      const url = String(input);
      if (url.includes("/messages?")) {
        return new Response(JSON.stringify({ messages: [{ id: "custom-message-1" }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }

      if (url.includes("/messages/custom-message-1")) {
        return new Response(
          JSON.stringify({
            id: "custom-message-1",
            threadId: "thread-custom-1",
            snippet: "Endesa factura ready",
            payload: {
              mimeType: "text/plain",
              headers: [
                { name: "Subject", value: "Endesa factura" },
                { name: "From", value: "Endesa <noreply@endesa.com>" }
              ],
              body: {
                data: Buffer.from(bodyText, "utf8").toString("base64url")
              }
            }
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }

      return new Response(JSON.stringify({}), { status: 404 });
    }) as typeof fetch;

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "sync Gmail" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Gmail sync: 1 messages checked, 1 new review item/);
    assert.match(response.json().reply, /1 email review is waiting/);

    const review = await prisma.emailReviewItem.findFirstOrThrow({
      where: { userId, ruleId: rule.id, adapterId: "custom_email_review", status: "pending" }
    });
    assert.equal(review.proposedEventType, null);
    assert.equal(review.reason, "custom_email_match");
    assert.equal(await prisma.event.count({ where: { userId, source: "gmail" } }), 0);

    response = await server.inject({
      method: "POST",
      url: `/users/${userId}/email-reviews/${review.id}/approve`
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().message, "Custom email review approved. No event or action was created.");
    assert.equal(await prisma.event.count({ where: { userId, source: "gmail" } }), 0);
    assert.equal(await prisma.actionItem.count({ where: { userId, source: "email_review" } }), 0);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "pause Endesa emails" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Gmail rule paused: Endesa bills/);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "remove Endesa rule" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Confirm remove Gmail rule: Endesa bills/);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "yes" }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().reply, "Gmail rule removed: Endesa bills");
    assert.equal((await prisma.emailSignalRule.findUniqueOrThrow({ where: { id: rule.id } })).status, "archived");

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "I want to track betting tips from Gmail so I can bet safely" }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().riskState, "RED");
    assert.doesNotMatch(response.json().reply, /Gmail rule|tracking is on|review-first/);
  } finally {
    globalThis.fetch = originalFetch;
    if (previousKey === undefined) delete process.env.ALECTO_SECRET_ENCRYPTION_KEY;
    else process.env.ALECTO_SECRET_ENCRYPTION_KEY = previousKey;
    await server.close();
    await prisma.user.deleteMany({ where: { id: { in: [userId, broadUserId] } } });
  }
});

test("email review inbox supports numbered natural review handling", async () => {
  const reviewUserId = `email-review-inbox-${randomUUID()}`;
  const server = buildServer();

  try {
    await server.ready();
    await prisma.user.create({ data: { id: reviewUserId } });
    await prisma.notificationSettings.create({
      data: {
        userId: reviewUserId,
        timezone: "Europe/Madrid",
        telegramUserId: "123456"
      }
    });
    const connection = await prisma.integrationConnection.create({
      data: {
        userId: reviewUserId,
        integrationId: "gmail",
        status: "active",
        config: { provider: "gmail", scope: "gmail.readonly", email: "reviews@example.com", hasRefreshToken: true }
      }
    });
    const jobRule = await prisma.emailSignalRule.create({
      data: {
        userId: reviewUserId,
        connectionId: connection.id,
        adapterId: "job_search_email",
        name: "Job search emails",
        query: "newer_than:30d interview",
        status: "active",
        createdBy: "user"
      }
    });
    const workRule = await prisma.emailSignalRule.create({
      data: {
        userId: reviewUserId,
        connectionId: connection.id,
        adapterId: "work_action_email",
        name: "Work action emails",
        query: "newer_than:7d \"please review\"",
        status: "active",
        createdBy: "user",
        reviewBeforeLogging: true
      }
    });
    const customRule = await prisma.emailSignalRule.create({
      data: {
        userId: reviewUserId,
        connectionId: connection.id,
        adapterId: "custom_email_review",
        name: "Endesa emails",
        query: "newer_than:30d Endesa",
        status: "active",
        createdBy: "user",
        reviewBeforeLogging: true
      }
    });

    await prisma.emailReviewItem.createMany({
      data: [
        {
          userId: reviewUserId,
          connectionId: connection.id,
          ruleId: jobRule.id,
          adapterId: "job_search_email",
          provider: "gmail",
          providerMessageId: "job-message-1",
          externalId: `gmail-review:${jobRule.id}:job-message-1`,
          subject: "Recruiter reply from Example Labs",
          from: "Recruiter <recruiter@example.com>",
          snippet: "Thanks for applying. Can we talk tomorrow?",
          evidence: "Thanks for applying. Can we talk tomorrow?",
          proposedEventType: "career.recruiter_reply_received",
          confidence: 0.91,
          reason: "recruiter_reply",
          extracted: { company: "Example Labs" },
          status: "pending"
        },
        {
          userId: reviewUserId,
          connectionId: connection.id,
          ruleId: workRule.id,
          adapterId: "work_action_email",
          provider: "gmail",
          providerMessageId: "work-message-1",
          externalId: `gmail-review:${workRule.id}:work-message-1`,
          subject: "Homepage deadline",
          from: "Client <client@example.com>",
          snippet: "Please send the homepage fixes by Friday.",
          evidence: "Please send the homepage fixes by Friday.",
          proposedEventType: "work_deadline_detected",
          confidence: 0.86,
          reason: "work_deadline_detected",
          extracted: { project: "homepage", deadline: "Friday" },
          status: "pending"
        },
        {
          userId: reviewUserId,
          connectionId: connection.id,
          ruleId: customRule.id,
          adapterId: "custom_email_review",
          provider: "gmail",
          providerMessageId: "custom-message-1",
          externalId: `gmail-review:${customRule.id}:custom-message-1`,
          subject: "Endesa factura",
          from: "Endesa <noreply@endesa.com>",
          snippet: "Your Endesa factura is ready.",
          evidence: "Your Endesa factura is ready.",
          confidence: 0.8,
          reason: "custom_email_match",
          extracted: { customRuleName: "Endesa emails" },
          status: "pending"
        }
      ]
    });

    let response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: reviewUserId, message: "correos pendientes" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Email reviews waiting: 3/);
    assert.match(response.json().reply, /Job-search:/);
    assert.match(response.json().reply, /Work actions:/);
    assert.match(response.json().reply, /Custom tracking:/);
    assert.match(response.json().reply, /Proposed: log recruiter reply/);
    assert.match(response.json().reply, /Proposed: create action/);
    assert.match(response.json().reply, /Proposed: review only/);
    assert.deepEqual(
      response.json().reply.match(/^\d+\./gm)?.map((line: string) => Number(line.match(/^(\d+)\./)?.[1])) ?? [],
      [1, 2, 3]
    );
    assert.match(response.json().reply, /Job-search:\n1\. Recruiter reply/);
    assert.match(response.json().reply, /Work actions:\n2\. Homepage deadline/);
    assert.match(response.json().reply, /Custom tracking:\n3\. Endesa factura/);
    assert.doesNotMatch(response.json().reply, /job_search_email|work_action_email|custom_email_review|access token|refresh token|ciphertext|"iv"|"tag"/i);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: reviewUserId, message: "show 1" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Email review: Recruiter reply/);
    assert.match(response.json().reply, /Tracking: job-search email tracking/);
    assert.doesNotMatch(response.json().reply, /raw|ciphertext|refresh token/i);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: reviewUserId, message: "approve 1" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Approved 1:/);
    assert.equal(
      await prisma.event.count({ where: { userId: reviewUserId, source: "gmail", type: "career.recruiter_reply_received" } }),
      1
    );

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: reviewUserId, message: "reject 2" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Rejected 2: Homepage deadline/);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: reviewUserId, message: "turn 3 into an action tomorrow" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Action created from email review: Review Endesa bill/);
    assert.equal(await prisma.actionItem.count({ where: { userId: reviewUserId, source: "email_review" } }), 1);
    assert.equal(await prisma.emailReviewItem.count({ where: { userId: reviewUserId, status: "pending" } }), 0);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: reviewUserId, message: "email reviews" }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().reply, "No email reviews are waiting.");

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: reviewUserId, message: "reject all the rest reviews from Endesa" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /No pending email reviews are visible right now/);
    assert.doesNotMatch(response.json().reply, /expired/i);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: reviewUserId } });
  }
});

test("Gmail security and auth emails are hard-filtered before job search and custom review creation", async () => {
  const securityUserId = `gmail-security-filter-${randomUUID()}`;
  const server = buildServer();
  const originalFetch = globalThis.fetch;

  try {
    await server.ready();
    await prisma.user.create({ data: { id: securityUserId } });
    const connection = await prisma.integrationConnection.create({
      data: {
        userId: securityUserId,
        integrationId: "gmail",
        status: "active",
        config: {
          provider: "gmail",
          scope: "gmail.readonly",
          accessToken: "security-filter-token",
          expiresAt: Date.now() + 3_600_000,
          tokenType: "Bearer"
        }
      }
    });
    await prisma.emailSignalRule.createMany({
      data: [
        {
          userId: securityUserId,
          connectionId: connection.id,
          adapterId: "job_search_email",
          name: "Job search emails",
          query: "newer_than:30d application",
          status: "active",
          fetchStrategy: "query",
          maxMessagesPerSync: 5,
          maxEventsPerSync: 5,
          classifierMode: "hybrid",
          minAutoLogConfidence: 0.9,
          minReviewConfidence: 0.65,
          reviewBeforeLogging: false,
          createdBy: "user"
        },
        {
          userId: securityUserId,
          connectionId: connection.id,
          adapterId: "custom_email_review",
          name: "Blockchain application emails",
          query: "newer_than:30d Blockchain application",
          status: "active",
          fetchStrategy: "query",
          maxMessagesPerSync: 5,
          maxEventsPerSync: 5,
          classifierMode: "rules",
          minAutoLogConfidence: 1,
          minReviewConfidence: 0.65,
          reviewBeforeLogging: true,
          createdBy: "user"
        }
      ]
    });

    const messages: Record<string, { subject: string; from: string; snippet: string; body: string }> = {
      "security-code": {
        subject: "Security code for your application to Blockchain.com",
        from: "Blockchain.com <no-reply@blockchain.com>",
        snippet: "Copy and paste this code into the security code field on your application.",
        body: "Copy and paste this code into the security code field on your application. After you enter the code, resubmit your application."
      },
      "verification-code": {
        subject: "Verification code",
        from: "Accounts <security@example.com>",
        snippet: "Your verification code is 123456.",
        body: "Use this verification code to continue."
      },
      "password-reset": {
        subject: "Password reset request",
        from: "Accounts <security@example.com>",
        snippet: "Reset your password.",
        body: "We received a password reset request for your account."
      }
    };

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      assert.equal((init?.headers as Record<string, string> | undefined)?.authorization, "Bearer security-filter-token");

      if (url.includes("/messages?")) {
        return new Response(JSON.stringify({ messages: Object.keys(messages).map((id) => ({ id })) }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }

      const messageId = Object.keys(messages).find((id) => url.includes(`/messages/${id}`));
      if (messageId) {
        const message = messages[messageId];
        return new Response(
          JSON.stringify({
            id: messageId,
            threadId: `thread-${messageId}`,
            snippet: message.snippet,
            payload: {
              mimeType: "text/plain",
              headers: [
                { name: "Subject", value: message.subject },
                { name: "From", value: message.from }
              ],
              body: {
                data: Buffer.from(message.body, "utf8").toString("base64url")
              }
            }
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }

      return new Response(JSON.stringify({}), { status: 404 });
    }) as typeof fetch;

    const response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: securityUserId, message: "sync Gmail" }
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Gmail sync: 6 messages checked, 0 new review items/);
    assert.equal(await prisma.emailReviewItem.count({ where: { userId: securityUserId } }), 0);
    assert.equal(await prisma.event.count({ where: { userId: securityUserId, source: "gmail" } }), 0);
    assert.doesNotMatch(response.json().reply, /security-filter-token|ciphertext|refresh token|access token/i);
  } finally {
    globalThis.fetch = originalFetch;
    await server.close();
    await prisma.user.deleteMany({ where: { id: securityUserId } });
  }
});

test("email review context bulk operations and expiry are safe", async () => {
  const reviewUserId = `email-review-bulk-${randomUUID()}`;
  const expiredUserId = `email-review-expired-${randomUUID()}`;
  const server = buildServer();

  try {
    await server.ready();
    for (const id of [reviewUserId, expiredUserId]) {
      await prisma.user.create({ data: { id } });
    }

    const connection = await prisma.integrationConnection.create({
      data: {
        userId: reviewUserId,
        integrationId: "gmail",
        status: "active",
        config: { provider: "gmail", scope: "gmail.readonly" }
      }
    });
    const jobRule = await prisma.emailSignalRule.create({
      data: {
        userId: reviewUserId,
        connectionId: connection.id,
        adapterId: "job_search_email",
        name: "Job search emails",
        status: "active",
        createdBy: "user"
      }
    });
    const customRule = await prisma.emailSignalRule.create({
      data: {
        userId: reviewUserId,
        connectionId: connection.id,
        adapterId: "custom_email_review",
        name: "Endesa emails",
        query: "newer_than:30d Endesa",
        status: "active",
        createdBy: "user",
        reviewBeforeLogging: true
      }
    });

    await prisma.emailReviewItem.createMany({
      data: [
        {
          userId: reviewUserId,
          connectionId: connection.id,
          ruleId: jobRule.id,
          adapterId: "job_search_email",
          provider: "gmail",
          providerMessageId: "job-bulk-1",
          externalId: `gmail-review:${jobRule.id}:job-bulk-1`,
          subject: "Interview scheduling",
          from: "Example Labs <jobs@example.com>",
          snippet: "Interview next week",
          evidence: "Interview next week",
          proposedEventType: "career.interview_scheduled",
          confidence: 0.94,
          reason: "interview_scheduled",
          extracted: { company: "Example Labs" },
          status: "pending"
        },
        {
          userId: reviewUserId,
          connectionId: connection.id,
          ruleId: customRule.id,
          adapterId: "custom_email_review",
          provider: "gmail",
          providerMessageId: "custom-bulk-1",
          externalId: `gmail-review:${customRule.id}:custom-bulk-1`,
          subject: "Endesa factura agosto",
          from: "Endesa <noreply@endesa.com>",
          snippet: "Factura ready",
          evidence: "Factura ready",
          confidence: 0.8,
          reason: "custom_email_match",
          extracted: {},
          status: "pending"
        },
        {
          userId: reviewUserId,
          connectionId: connection.id,
          ruleId: customRule.id,
          adapterId: "custom_email_review",
          provider: "gmail",
          providerMessageId: "custom-bulk-2",
          externalId: `gmail-review:${customRule.id}:custom-bulk-2`,
          subject: "Endesa payment",
          from: "Endesa <noreply@endesa.com>",
          snippet: "Payment notice",
          evidence: "Payment notice",
          confidence: 0.8,
          reason: "custom_email_match",
          extracted: {},
          status: "pending"
        }
      ]
    });

    let response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: reviewUserId, message: "email reviews" }
    });
    assert.equal(response.statusCode, 200);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: reviewUserId, message: "approve all" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Which group do you mean/);
    assert.equal(await prisma.emailReviewItem.count({ where: { userId: reviewUserId, status: "pending" } }), 3);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: reviewUserId, message: "approve all job-search reviews" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Approved 1:/);
    assert.equal(await prisma.emailReviewItem.count({ where: { userId: reviewUserId, adapterId: "job_search_email", status: "approved" } }), 1);
    assert.equal(await prisma.emailReviewItem.count({ where: { userId: reviewUserId, adapterId: "custom_email_review", status: "pending" } }), 2);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: reviewUserId, message: "reject all Endesa reviews" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Rejected 2:/);
    assert.match(response.json().reply, /Rejected 3:/);
    assert.equal(await prisma.emailReviewItem.count({ where: { userId: reviewUserId, adapterId: "custom_email_review", status: "rejected" } }), 2);

    const expiredConnection = await prisma.integrationConnection.create({
      data: {
        userId: expiredUserId,
        integrationId: "gmail",
        status: "active",
        config: { provider: "gmail" }
      }
    });
    const expiredRule = await prisma.emailSignalRule.create({
      data: {
        userId: expiredUserId,
        connectionId: expiredConnection.id,
        adapterId: "custom_email_review",
        name: "Expired context",
        status: "active",
        createdBy: "user"
      }
    });
    await prisma.emailReviewItem.create({
      data: {
        userId: expiredUserId,
        connectionId: expiredConnection.id,
        ruleId: expiredRule.id,
        adapterId: "custom_email_review",
        provider: "gmail",
        providerMessageId: "expired-1",
        externalId: `gmail-review:${expiredRule.id}:expired-1`,
        subject: "Expired review",
        confidence: 0.8,
        reason: "custom_email_match",
        extracted: {},
        status: "pending"
      }
    });
    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: expiredUserId, message: "email reviews" }
    });
    assert.equal(response.statusCode, 200);
    await prisma.pendingAction.updateMany({
      where: { userId: expiredUserId, type: "email_review_context", status: "pending" },
      data: { expiresAt: new Date(Date.now() - 60_000) }
    });

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: expiredUserId, message: "approve 1" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /pending decision expired/i);
    assert.equal(await prisma.emailReviewItem.count({ where: { userId: expiredUserId, status: "pending" } }), 1);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: { in: [reviewUserId, expiredUserId] } } });
  }
});

test("email review bulk rest only mutates currently pending visible reviews", async () => {
  const reviewUserId = `email-review-rest-${randomUUID()}`;
  const server = buildServer();

  try {
    await server.ready();
    await prisma.user.create({ data: { id: reviewUserId } });
    await prisma.notificationSettings.create({
      data: {
        userId: reviewUserId,
        timezone: "Europe/Madrid",
        telegramUserId: "123456"
      }
    });
    const connection = await prisma.integrationConnection.create({
      data: {
        userId: reviewUserId,
        integrationId: "gmail",
        status: "active",
        config: { provider: "gmail", scope: "gmail.readonly" }
      }
    });
    const customRule = await prisma.emailSignalRule.create({
      data: {
        userId: reviewUserId,
        connectionId: connection.id,
        adapterId: "custom_email_review",
        name: "Endesa emails",
        query: "newer_than:30d Endesa",
        status: "active",
        createdBy: "user",
        reviewBeforeLogging: true
      }
    });

    await prisma.emailReviewItem.createMany({
      data: [1, 2, 3, 4].map((number) => ({
        userId: reviewUserId,
        connectionId: connection.id,
        ruleId: customRule.id,
        adapterId: "custom_email_review",
        provider: "gmail",
        providerMessageId: `endesa-rest-${number}`,
        externalId: `gmail-review:${customRule.id}:endesa-rest-${number}`,
        subject: `Endesa factura ${number}`,
        from: "Endesa <noreply@endesa.com>",
        snippet: `Endesa factura ${number} ready`,
        evidence: `Endesa factura ${number} ready`,
        confidence: 0.8,
        reason: "custom_email_match",
        extracted: { customRuleName: "Endesa emails" },
        status: "pending"
      }))
    });

    let response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: reviewUserId, message: "email reviews" }
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(
      response.json().reply.match(/^\d+\./gm)?.map((line: string) => Number(line.match(/^(\d+)\./)?.[1])) ?? [],
      [1, 2, 3, 4]
    );

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: reviewUserId, message: "reject 1" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Rejected 1: Endesa factura 1/);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: reviewUserId, message: "turn 2 into an action for rating Endesa this week" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Action created from email review: Review Endesa bill/);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: reviewUserId, message: "reject all the rest reviews from Endesa" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Rejected 3: Endesa factura 3/);
    assert.match(response.json().reply, /Rejected 4: Endesa factura 4/);
    assert.doesNotMatch(response.json().reply, /Rejected 1|Rejected 2/);
    assert.equal(await prisma.emailReviewItem.count({ where: { userId: reviewUserId, status: "pending" } }), 0);
    assert.equal(await prisma.emailReviewItem.count({ where: { userId: reviewUserId, status: "rejected" } }), 3);
    assert.equal(await prisma.emailReviewItem.count({ where: { userId: reviewUserId, status: "approved" } }), 1);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: reviewUserId } });
  }
});

test("email review bulk response separates already handled matching reviews", async () => {
  const reviewUserId = `email-review-already-handled-${randomUUID()}`;
  const server = buildServer();

  try {
    await server.ready();
    await prisma.user.create({ data: { id: reviewUserId } });
    const connection = await prisma.integrationConnection.create({
      data: {
        userId: reviewUserId,
        integrationId: "gmail",
        status: "active",
        config: { provider: "gmail", scope: "gmail.readonly" }
      }
    });
    const customRule = await prisma.emailSignalRule.create({
      data: {
        userId: reviewUserId,
        connectionId: connection.id,
        adapterId: "custom_email_review",
        name: "Endesa emails",
        query: "newer_than:30d Endesa",
        status: "active",
        createdBy: "user",
        reviewBeforeLogging: true
      }
    });

    await prisma.emailReviewItem.createMany({
      data: [1, 2].map((number) => ({
        userId: reviewUserId,
        connectionId: connection.id,
        ruleId: customRule.id,
        adapterId: "custom_email_review",
        provider: "gmail",
        providerMessageId: `endesa-already-${number}`,
        externalId: `gmail-review:${customRule.id}:endesa-already-${number}`,
        subject: `Endesa already ${number}`,
        from: "Endesa <noreply@endesa.com>",
        snippet: `Endesa already ${number}`,
        evidence: `Endesa already ${number}`,
        confidence: 0.8,
        reason: "custom_email_match",
        extracted: {},
        status: "pending"
      }))
    });

    let response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: reviewUserId, message: "email reviews" }
    });
    assert.equal(response.statusCode, 200);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: reviewUserId, message: "reject 1" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Rejected 1/);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: reviewUserId, message: "reject all Endesa reviews" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Rejected 2: Endesa already [12]/);
    assert.match(response.json().reply, /Already handled:/);
    assert.match(response.json().reply, /1: Endesa already [12] \(rejected\)/);
    assert.doesNotMatch(response.json().reply, /Rejected 1/);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: reviewUserId } });
  }
});

test("semantic router edits pending Gmail rules and repairs misunderstood replies", async () => {
  const previousKey = process.env.ALECTO_SECRET_ENCRYPTION_KEY;
  const previousRouterEnabled = process.env.LLM_ROUTER_ENABLED;
  const previousRouterMock = process.env.LLM_ROUTER_MOCK_RESPONSE;
  const previousOpenAIKey = process.env.OPENAI_API_KEY;
  const userId = `custom-gmail-semantic-${randomUUID()}`;
  const server = buildServer();

  try {
    process.env.ALECTO_SECRET_ENCRYPTION_KEY = randomBytes(32).toString("base64");
    await server.ready();
    await prisma.user.create({ data: { id: userId } });
    await prisma.goal.createMany({
      data: [
        {
          userId,
          title: "Control impulsive betting",
          category: "finance",
          templateId: "finance.control_betting_trading",
          status: "active",
          priority: "critical",
          importanceScore: 70
        },
        {
          userId,
          title: "Track energy consumption",
          category: "home",
          status: "active",
          priority: "medium",
          importanceScore: 25
        }
      ]
    });
    await prisma.integrationConnection.create({
      data: {
        userId,
        integrationId: "gmail",
        status: "active",
        config: {
          provider: "gmail",
          scope: "gmail.readonly",
          email: "semantic@example.com",
          token: encryptSecretJson({
            accessToken: "semantic-gmail-access-token",
            refreshToken: "semantic-gmail-refresh-token",
            expiresAt: Date.now() + 3_600_000,
            tokenType: "Bearer",
            scope: "gmail.readonly"
          }),
          tokenStorage: "encrypted",
          hasRefreshToken: true
        }
      }
    });

    let response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "track Endesa bills from Gmail" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /review-first Gmail rule/);
    assert.doesNotMatch(response.json().reply, /Control impulsive betting/);
    assert.equal(response.json().routeDebug.routerSource, "deterministic_surface");
    assert.equal(response.json().routeDebug.intent, "gmail_custom_rule_request");

    let pending = await prisma.pendingAction.findFirstOrThrow({
      where: { userId, type: "custom_email_rule", status: "pending" },
      orderBy: { createdAt: "desc" }
    });
    assert.notEqual(pending.payload.goalTitle, "Control impulsive betting");

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: {
        userId,
        message: "only look for Endesa, and can you link it to a goal to have always less than 60 euros of spending per bill?"
      }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Updated the pending Gmail rule/);
    assert.match(response.json().reply, /looks for: Endesa/);
    assert.doesNotMatch(response.json().reply, /Endesa word|bill, invoice, factura/);
    assert.match(response.json().reply, /linked goal: Track energy consumption/);
    assert.equal(response.json().routeDebug.routerSource, "deterministic_semantic");
    assert.equal(response.json().routeDebug.intent, "gmail_custom_rule_edit_pending");

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: {
        userId,
        message: "where this Endesa emails will be linked to? a goal? or will they be saved in actions?"
      }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /still pending/i);
    assert.match(response.json().reply, /Linked goal: Track energy consumption/);
    assert.match(response.json().reply, /email review only/i);
    assert.match(response.json().reply, /will not create actions or events automatically/i);
    assert.equal(response.json().routeDebug.intent, "gmail_rule_question");

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "make the looks for just Endesa" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Updated the pending Gmail rule/);
    assert.match(response.json().reply, /looks for: Endesa/);
    assert.doesNotMatch(response.json().reply, /bill, invoice, factura/);
    assert.doesNotMatch(response.json().reply, /I've logged|Check-in saved|specific action/i);

    pending = await prisma.pendingAction.findFirstOrThrow({
      where: { userId, type: "custom_email_rule", status: "pending" },
      orderBy: { createdAt: "desc" }
    });
    assert.deepEqual(pending.payload.keywordFilters, ["Endesa"]);
    assert.match(String(pending.payload.queryPreview), /Endesa/);
    assert.doesNotMatch(String(pending.payload.queryPreview), /bill|invoice|factura/);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: {
        userId,
        message: "the linked goal also is not control impulsive betting wtf this are Endesa bills, so its for energy consumption"
      }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Updated the pending Gmail rule/);
    assert.match(response.json().reply, /linked goal: Track energy consumption/);
    assert.doesNotMatch(response.json().reply, /Control impulsive betting/);

    pending = await prisma.pendingAction.findFirstOrThrow({
      where: { userId, type: "custom_email_rule", status: "pending" },
      orderBy: { createdAt: "desc" }
    });
    assert.equal(pending.payload.goalTitle, "Track energy consumption");

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "bro what are u doing" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /You are right to call that out/);
    assert.match(response.json().reply, /pending Gmail rule/);
    assert.doesNotMatch(response.json().reply, /I hear you|one check-in|YouTube|Check-in saved/i);

    process.env.LLM_ROUTER_ENABLED = "true";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.LLM_ROUTER_MOCK_RESPONSE = JSON.stringify({
      intent: "gmail_custom_rule_edit_pending",
      operation: "edit_pending",
      confidence: 0.94,
      reason: "User wants the pending Gmail rule narrowed to one keyword.",
      target: null,
      keywordFilters: ["Endesa"],
      senderFilters: [],
      removeKeywordFilters: [],
      goalHint: null,
      shouldUnlinkGoal: false,
      userFacingIssue: null
    });

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "narrow that proposal down to Endesa alone" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Updated the pending Gmail rule/);
    assert.match(response.json().reply, /looks for: Endesa/);
    assert.equal(response.json().routeDebug.routerSource, "llm_semantic");

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "yes" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /tracking is on/);

    const rule = await prisma.emailSignalRule.findFirstOrThrow({
      where: { userId, adapterId: "custom_email_review", status: "active" }
    });
    assert.equal(rule.goalTitleSnapshot ?? "Track energy consumption", "Track energy consumption");
    assert.equal(rule.goalId !== null, true);
    assert.match(rule.query ?? "", /Endesa/);
    assert.doesNotMatch(rule.query ?? "", /bill|invoice|factura/);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "where will Endesa emails go?" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Gmail rule: Endesa emails/);
    assert.match(response.json().reply, /Linked goal: Track energy consumption/);
    assert.match(response.json().reply, /Custom rules never auto-log or create actions/);
    assert.equal(response.json().routeDebug.intent, "gmail_rule_question");

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "what email rules do we have on now" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Email rules currently on/);
    assert.match(response.json().reply, /Endesa emails/);
    assert.match(response.json().reply, /custom tracking, review first, auto-log off/);
    assert.match(response.json().reply, /goal: Track energy consumption/);
    assert.doesNotMatch(response.json().reply, /adapter:|custom_email_review|access token|refresh token|ciphertext/i);
    assert.equal(response.json().routeDebug.intent, "email_rules_list");

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "when will u let me know about the new emails" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Alecto checks Gmail when you say 'sync Gmail'/);
    assert.match(response.json().reply, /Automatic sync is off/);
    assert.match(response.json().reply, /not instant arrival tracking yet/i);
    assert.match(response.json().reply, /email review/i);
    assert.doesNotMatch(response.json().reply, /I could not identify which Gmail rule/i);
    assert.equal(response.json().routeDebug.intent, "gmail_sync_guidance");

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "about the new endesa mails when will u let me know?when they arrive?" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /For Endesa emails:/);
    assert.match(response.json().reply, /sync Gmail/);
    assert.doesNotMatch(response.json().reply, /I could not identify which Gmail rule/i);

    process.env.LLM_ROUTER_MOCK_RESPONSE = JSON.stringify({
      intent: "email_rules_list",
      operation: "status",
      confidence: 0.94,
      reason: "Spanish request asks which email rules are currently active.",
      language: "es",
      sideEffectRisk: "read",
      requiresConfirmation: false,
      target: null,
      keywordFilters: [],
      senderFilters: [],
      removeKeywordFilters: [],
      goalHint: null,
      shouldUnlinkGoal: false,
      userFacingIssue: null
    });

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "que reglas de email tenemos activas ahora" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Email rules currently/i);
    assert.match(response.json().reply, /Endesa emails/);
    assert.equal(response.json().routeDebug.routerSource, "llm_semantic");
    assert.equal(response.json().routeDebug.intent, "email_rules_list");
    assert.equal(response.json().routeDebug.language, "es");

    process.env.LLM_ROUTER_MOCK_RESPONSE = JSON.stringify({
      intent: "gmail_rule_question",
      operation: "timing",
      confidence: 0.95,
      reason: "Catalan question asks when Alecto will notify about Endesa email matches.",
      language: "ca",
      sideEffectRisk: "read",
      requiresConfirmation: false,
      target: "Endesa",
      keywordFilters: [],
      senderFilters: [],
      removeKeywordFilters: [],
      goalHint: null,
      shouldUnlinkGoal: false,
      userFacingIssue: null
    });

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "quan m'avisareu dels nous correus d'Endesa?" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /For Endesa emails:/);
    assert.match(response.json().reply, /sync Gmail/);
    assert.equal(response.json().routeDebug.routerSource, "llm_semantic");
    assert.equal(response.json().routeDebug.intent, "gmail_rule_question");
    assert.equal(response.json().routeDebug.language, "ca");

    process.env.LLM_ROUTER_MOCK_RESPONSE = JSON.stringify({
      intent: "gmail_custom_rule_manage",
      operation: "pause",
      confidence: 0.93,
      reason: "Spanish request asks to pause the Endesa email rule.",
      language: "es",
      sideEffectRisk: "write",
      requiresConfirmation: false,
      target: "Endesa",
      keywordFilters: [],
      senderFilters: [],
      removeKeywordFilters: [],
      goalHint: null,
      shouldUnlinkGoal: false,
      userFacingIssue: null
    });

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "pausa los emails de Endesa" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Gmail rule paused: Endesa emails/);
    assert.equal(response.json().routeDebug.routerSource, "deterministic_surface");

    process.env.LLM_ROUTER_MOCK_RESPONSE = JSON.stringify({
      intent: "gmail_custom_rule_manage",
      operation: "resume",
      confidence: 0.93,
      reason: "Catalan request asks to resume the Endesa email rule.",
      language: "ca",
      sideEffectRisk: "write",
      requiresConfirmation: false,
      target: "Endesa",
      keywordFilters: [],
      senderFilters: [],
      removeKeywordFilters: [],
      goalHint: null,
      shouldUnlinkGoal: false,
      userFacingIssue: null
    });

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "reactiva els correus d'Endesa" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Gmail rule active: Endesa emails/);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "track Aigues bills from Gmail" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /I can set up a review-first Gmail rule/);

    process.env.LLM_ROUTER_MOCK_RESPONSE = JSON.stringify({
      intent: "gmail_custom_rule_edit_pending",
      operation: "edit_pending",
      confidence: 0.95,
      reason: "User wants to replace Endesa with Aigues de Barcelona.",
      language: "en",
      sideEffectRisk: "write",
      requiresConfirmation: true,
      target: null,
      keywordFilters: ["Aigues de Barcelona"],
      senderFilters: [],
      removeKeywordFilters: ["Endesa"],
      goalHint: null,
      shouldUnlinkGoal: false,
      userFacingIssue: null
    });

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "looks for only Aigues de Barceloa instead of Endesa" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Updated the pending Gmail rule/);
    assert.match(response.json().reply, /looks for: Aigues de Barcelona/);
    assert.doesNotMatch(response.json().reply, /instead of|Endesa/i);

    pending = await prisma.pendingAction.findFirstOrThrow({
      where: { userId, type: "custom_email_rule", status: "pending" },
      orderBy: { createdAt: "desc" }
    });
    assert.deepEqual(pending.payload.keywordFilters, ["Aigues de Barcelona"]);

    process.env.LLM_ROUTER_MOCK_RESPONSE = JSON.stringify({
      intent: "gmail_custom_rule_edit_pending",
      operation: "edit_pending",
      confidence: 0.94,
      reason: "User wants the pending Gmail rule to look for Aigues de Barcelona.",
      language: "en",
      sideEffectRisk: "write",
      requiresConfirmation: true,
      target: null,
      keywordFilters: ["Aigues de Barcelona"],
      senderFilters: [],
      removeKeywordFilters: [],
      goalHint: null,
      shouldUnlinkGoal: false,
      userFacingIssue: null
    });

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "look for Aigues the Barcelona" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /looks for: Aigues de Barcelona/);
    assert.doesNotMatch(response.json().reply, /Aigues, Aigues/i);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "no" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Cancelled/);

    process.env.LLM_ROUTER_MOCK_RESPONSE = JSON.stringify({
      intent: "gmail_custom_rule_request",
      operation: "create",
      confidence: 0.93,
      reason: "Spanish request asks to create a Gmail rule for utility invoices.",
      language: "es",
      sideEffectRisk: "write",
      requiresConfirmation: true,
      target: "Aigues de Barcelona",
      keywordFilters: ["Aigues de Barcelona", "factura"],
      senderFilters: [],
      removeKeywordFilters: [],
      goalHint: "consumo de energia",
      shouldUnlinkGoal: false,
      userFacingIssue: null
    });

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "crea una regla de Gmail para facturas de Aigües de Barcelona" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /review-first Gmail rule/);
    assert.match(response.json().reply, /looks for: Aigues de Barcelona, factura/);
    assert.match(response.json().reply, /linked goal: Track energy consumption/);
    assert.doesNotMatch(response.json().reply, /Control impulsive betting/);
    assert.equal(response.json().routeDebug.routerSource, "llm_semantic");
    assert.equal(response.json().routeDebug.intent, "gmail_custom_rule_request");
    assert.equal(response.json().routeDebug.language, "es");

    pending = await prisma.pendingAction.findFirstOrThrow({
      where: { userId, type: "custom_email_rule", status: "pending" },
      orderBy: { createdAt: "desc" }
    });
    assert.deepEqual(pending.payload.keywordFilters, ["Aigues de Barcelona", "factura"]);
    assert.equal(pending.payload.goalTitle, "Track energy consumption");

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "no" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Cancelled/);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "remove Endesa rule" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Confirm remove Gmail rule: Endesa emails/);
    assert.doesNotMatch(response.json().reply, /too broad|open action|specific action/i);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "no" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Cancelled/);

    process.env.LLM_ROUTER_MOCK_RESPONSE = JSON.stringify({
      intent: "gmail_sync",
      operation: "sync",
      confidence: 0.99,
      reason: "Bad mock tries to route risky text as Gmail sync.",
      language: "es",
      sideEffectRisk: "read",
      requiresConfirmation: false,
      target: null,
      keywordFilters: [],
      senderFilters: [],
      removeKeywordFilters: [],
      goalHint: null,
      shouldUnlinkGoal: false,
      userFacingIssue: null
    });

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "quiero apostar 500 y sincroniza Gmail" }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().riskState, "RED");
    assert.doesNotMatch(response.json().reply, /Gmail sync|messages checked|email rules/i);

    process.env.LLM_ROUTER_MOCK_RESPONSE = JSON.stringify({
      intent: "daily_operator",
      operation: "help",
      confidence: 0.91,
      reason: "User asks for the operating move in non-command language.",
      target: null,
      keywordFilters: [],
      senderFilters: [],
      removeKeywordFilters: [],
      goalHint: null,
      shouldUnlinkGoal: false,
      userFacingIssue: null
    });

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "give me the operating move for the next few hours" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Today|Status|Next move/);
    assert.equal(response.json().routeDebug.routerSource, "llm_semantic");
    assert.equal(response.json().routeDebug.intent, "daily_operator");
  } finally {
    if (previousKey === undefined) delete process.env.ALECTO_SECRET_ENCRYPTION_KEY;
    else process.env.ALECTO_SECRET_ENCRYPTION_KEY = previousKey;
    if (previousRouterEnabled === undefined) delete process.env.LLM_ROUTER_ENABLED;
    else process.env.LLM_ROUTER_ENABLED = previousRouterEnabled;
    if (previousRouterMock === undefined) delete process.env.LLM_ROUTER_MOCK_RESPONSE;
    else process.env.LLM_ROUTER_MOCK_RESPONSE = previousRouterMock;
    if (previousOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAIKey;
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("semantic router edits active Gmail rules using recent conversation context", async () => {
  const previousRouterEnabled = process.env.LLM_ROUTER_ENABLED;
  const previousRouterMock = process.env.LLM_ROUTER_MOCK_RESPONSE;
  const previousOpenAIKey = process.env.OPENAI_API_KEY;
  const userId = `custom-gmail-active-edit-${randomUUID()}`;
  const server = buildServer();

  try {
    await server.ready();
    process.env.LLM_ROUTER_ENABLED = "true";
    process.env.OPENAI_API_KEY = "test-key";
    await prisma.user.create({ data: { id: userId } });
    const goal = await prisma.goal.create({
      data: {
        userId,
        title: "Track energy consumption",
        category: "home",
        status: "active",
        priority: "medium",
        importanceScore: 25
      }
    });
    const connection = await prisma.integrationConnection.create({
      data: {
        userId,
        integrationId: "gmail",
        status: "active",
        config: {
          provider: "gmail",
          scope: "gmail.readonly",
          email: "active-edit@example.com",
          hasRefreshToken: true
        }
      }
    });
    const rule = await prisma.emailSignalRule.create({
      data: {
        userId,
        connectionId: connection.id,
        goalId: goal.id,
        adapterId: "custom_email_review",
        name: "Endesa emails",
        query: "newer_than:30d Endesa",
        status: "active",
        fetchStrategy: "query",
        lookbackDays: 30,
        maxMessagesPerSync: 25,
        maxEventsPerSync: 5,
        classifierMode: "rules",
        minAutoLogConfidence: 1,
        minReviewConfidence: 0.65,
        reviewBeforeLogging: true,
        createdBy: "user"
      }
    });

    process.env.LLM_ROUTER_MOCK_RESPONSE = JSON.stringify({
      intent: "email_rules_list",
      operation: "status",
      confidence: 0.94,
      reason: "User asks which email rules are active.",
      language: "en",
      sideEffectRisk: "read",
      requiresConfirmation: false,
      target: null,
      keywordFilters: [],
      senderFilters: [],
      removeKeywordFilters: [],
      goalHint: null,
      shouldUnlinkGoal: false,
      userFacingIssue: null
    });

    let response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "what email rules do we have on now" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Endesa emails/);
    assert.doesNotMatch(response.json().reply, /adapter:|custom_email_review|access token|refresh token|ciphertext/i);

    process.env.LLM_ROUTER_MOCK_RESPONSE = JSON.stringify({
      intent: "gmail_custom_rule_edit",
      operation: "edit",
      confidence: 0.96,
      reason: "User wants to replace the recently discussed Endesa rule filter.",
      language: "en",
      sideEffectRisk: "write",
      requiresConfirmation: false,
      target: null,
      keywordFilters: ["Aigues de Barcelona"],
      senderFilters: [],
      removeKeywordFilters: ["Endesa"],
      goalHint: null,
      shouldUnlinkGoal: false,
      userFacingIssue: null
    });

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "make that rule look for only Aigues de Barceloa instead of Endesa" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Updated Gmail rule: Aigues de Barcelona emails/);
    assert.match(response.json().reply, /Looks for: Aigues de Barcelona/);
    assert.match(response.json().reply, /Linked goal: Track energy consumption/);
    assert.doesNotMatch(response.json().reply, /adapter:|custom_email_review|I've logged|Check-in saved/i);
    assert.equal(response.json().routeDebug.routerSource, "llm_semantic");
    assert.equal(response.json().routeDebug.intent, "gmail_custom_rule_edit");

    let updatedRule = await prisma.emailSignalRule.findUniqueOrThrow({ where: { id: rule.id } });
    assert.equal(updatedRule.name, "Aigues de Barcelona emails");
    assert.match(updatedRule.query ?? "", /Aigues de Barcelona/);
    assert.doesNotMatch(updatedRule.query ?? "", /Endesa/);
    assert.equal(updatedRule.goalId, goal.id);
    assert.equal(await prisma.actionItem.count({ where: { userId } }), 0);
    assert.equal(await prisma.event.count({ where: { userId } }), 0);

    process.env.LLM_ROUTER_MOCK_RESPONSE = JSON.stringify({
      intent: "gmail_rule_question",
      operation: "timing",
      confidence: 0.94,
      reason: "User asks when Alecto will notify about the recently discussed rule.",
      language: "en",
      sideEffectRisk: "read",
      requiresConfirmation: false,
      target: null,
      keywordFilters: [],
      senderFilters: [],
      removeKeywordFilters: [],
      goalHint: null,
      shouldUnlinkGoal: false,
      userFacingIssue: null
    });

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "when will you tell me about it?" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /For Aigues de Barcelona emails:/);
    assert.match(response.json().reply, /sync Gmail/);
    assert.doesNotMatch(response.json().reply, /I could not identify/i);

    process.env.LLM_ROUTER_MOCK_RESPONSE = JSON.stringify({
      intent: "gmail_custom_rule_manage",
      operation: "pause",
      confidence: 0.93,
      reason: "User wants to pause the recently discussed Gmail rule.",
      language: "en",
      sideEffectRisk: "write",
      requiresConfirmation: false,
      target: null,
      keywordFilters: [],
      senderFilters: [],
      removeKeywordFilters: [],
      goalHint: null,
      shouldUnlinkGoal: false,
      userFacingIssue: null
    });

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "pause it" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Gmail rule paused: Aigues de Barcelona emails/);
    updatedRule = await prisma.emailSignalRule.findUniqueOrThrow({ where: { id: rule.id } });
    assert.equal(updatedRule.status, "paused");

    process.env.LLM_ROUTER_MOCK_RESPONSE = JSON.stringify({
      intent: "gmail_custom_rule_edit",
      operation: "edit",
      confidence: 0.95,
      reason: "Spanish request asks to relink the current rule to energy consumption.",
      language: "es",
      sideEffectRisk: "write",
      requiresConfirmation: false,
      target: "Aigues de Barcelona",
      keywordFilters: [],
      senderFilters: [],
      removeKeywordFilters: [],
      goalHint: "consumo de energia",
      shouldUnlinkGoal: false,
      userFacingIssue: null
    });

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "vincula la regla de Aigues de Barcelona al objetivo de consumo de energia" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Updated Gmail rule: Aigues de Barcelona emails/);
    assert.match(response.json().reply, /Linked goal: Track energy consumption/);
    assert.equal(response.json().routeDebug.language, "es");
  } finally {
    if (previousRouterEnabled === undefined) delete process.env.LLM_ROUTER_ENABLED;
    else process.env.LLM_ROUTER_ENABLED = previousRouterEnabled;
    if (previousRouterMock === undefined) delete process.env.LLM_ROUTER_MOCK_RESPONSE;
    else process.env.LLM_ROUTER_MOCK_RESPONSE = previousRouterMock;
    if (previousOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAIKey;
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("ambiguous Gmail rule deletion stores clarification and resolves title or number", async () => {
  const previousRouterEnabled = process.env.LLM_ROUTER_ENABLED;
  const previousRouterMock = process.env.LLM_ROUTER_MOCK_RESPONSE;
  const previousOpenAIKey = process.env.OPENAI_API_KEY;
  const userId = `custom-gmail-delete-clarify-${randomUUID()}`;
  const server = buildServer();

  try {
    await server.ready();
    process.env.LLM_ROUTER_ENABLED = "true";
    process.env.OPENAI_API_KEY = "test-key";
    await prisma.user.create({ data: { id: userId } });
    const connection = await prisma.integrationConnection.create({
      data: {
        userId,
        integrationId: "gmail",
        status: "active",
        config: {
          provider: "gmail",
          scope: "gmail.readonly",
          email: "delete-clarify@example.com",
          hasRefreshToken: true
        }
      }
    });
    const endesaEmails = await prisma.emailSignalRule.create({
      data: {
        userId,
        connectionId: connection.id,
        adapterId: "custom_email_review",
        name: "Endesa emails",
        query: "newer_than:30d Endesa",
        status: "active",
        fetchStrategy: "query",
        lookbackDays: 30,
        maxMessagesPerSync: 25,
        maxEventsPerSync: 5,
        classifierMode: "rules",
        minAutoLogConfidence: 1,
        minReviewConfidence: 0.65,
        reviewBeforeLogging: true,
        createdBy: "user"
      }
    });
    const endesaBills = await prisma.emailSignalRule.create({
      data: {
        userId,
        connectionId: connection.id,
        adapterId: "custom_email_review",
        name: "Endesa bills",
        query: "newer_than:30d bill invoice factura Endesa",
        status: "paused",
        fetchStrategy: "query",
        lookbackDays: 30,
        maxMessagesPerSync: 25,
        maxEventsPerSync: 5,
        classifierMode: "rules",
        minAutoLogConfidence: 1,
        minReviewConfidence: 0.65,
        reviewBeforeLogging: true,
        createdBy: "user"
      }
    });

    process.env.LLM_ROUTER_MOCK_RESPONSE = JSON.stringify({
      intent: "gmail_custom_rule_manage",
      operation: "remove",
      confidence: 0.95,
      reason: "Spanish request asks to remove matching Endesa Gmail rules.",
      language: "es",
      sideEffectRisk: "destructive",
      requiresConfirmation: true,
      target: "Endesa emails",
      keywordFilters: [],
      senderFilters: [],
      removeKeywordFilters: [],
      goalHint: null,
      shouldUnlinkGoal: false,
      userFacingIssue: null
    });

    let response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "Elimina Endesa emails" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Confirm remove Gmail rule: Endesa emails/);
    assert.doesNotMatch(response.json().reply, /Which custom Gmail rule/i);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "no" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Cancelled/);

    process.env.LLM_ROUTER_MOCK_RESPONSE = JSON.stringify({
      intent: "gmail_custom_rule_manage",
      operation: "remove",
      confidence: 0.95,
      reason: "Spanish request asks to remove matching Endesa Gmail rules.",
      language: "es",
      sideEffectRisk: "destructive",
      requiresConfirmation: true,
      target: "Endesa",
      keywordFilters: [],
      senderFilters: [],
      removeKeywordFilters: [],
      goalHint: null,
      shouldUnlinkGoal: false,
      userFacingIssue: null
    });

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "elimina Endesa" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Which custom Gmail rule do you mean/);
    assert.match(response.json().reply, /1\. Endesa emails/);
    assert.match(response.json().reply, /2\. Endesa bills/);

    let pending = await prisma.pendingAction.findFirstOrThrow({
      where: { userId, type: "custom_email_rule", status: "pending" },
      orderBy: { createdAt: "desc" }
    });
    assert.equal(pending.payload.operation, "clarify_rule_management");
    assert.equal(pending.payload.intendedOperation, "archive");

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "Endesa emails" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Confirm remove Gmail rule: Endesa emails/);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "no" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Cancelled/);
    assert.equal((await prisma.emailSignalRule.findUniqueOrThrow({ where: { id: endesaEmails.id } })).status, "active");
    assert.equal((await prisma.emailSignalRule.findUniqueOrThrow({ where: { id: endesaBills.id } })).status, "paused");

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "elimina Endesa" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Which custom Gmail rule do you mean/);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "1" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Confirm remove Gmail rule: Endesa emails/);
    assert.doesNotMatch(response.json().reply, /For active Gmail rules|Alecto checks Gmail/i);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "yes" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Gmail rule removed: Endesa emails/);
    assert.equal((await prisma.emailSignalRule.findUniqueOrThrow({ where: { id: endesaEmails.id } })).status, "archived");
    assert.equal((await prisma.emailSignalRule.findUniqueOrThrow({ where: { id: endesaBills.id } })).status, "paused");
  } finally {
    if (previousRouterEnabled === undefined) delete process.env.LLM_ROUTER_ENABLED;
    else process.env.LLM_ROUTER_ENABLED = previousRouterEnabled;
    if (previousRouterMock === undefined) delete process.env.LLM_ROUTER_MOCK_RESPONSE;
    else process.env.LLM_ROUTER_MOCK_RESPONSE = previousRouterMock;
    if (previousOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAIKey;
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("email rule list and reset phrases do not fall into action control", async () => {
  const previousRouterEnabled = process.env.LLM_ROUTER_ENABLED;
  const previousRouterMock = process.env.LLM_ROUTER_MOCK_RESPONSE;
  const previousOpenAIKey = process.env.OPENAI_API_KEY;
  const userId = `custom-gmail-reset-routing-${randomUUID()}`;
  const server = buildServer();

  try {
    await server.ready();
    process.env.LLM_ROUTER_ENABLED = "false";
    delete process.env.LLM_ROUTER_MOCK_RESPONSE;
    delete process.env.OPENAI_API_KEY;
    await prisma.user.create({ data: { id: userId } });
    const connection = await prisma.integrationConnection.create({
      data: {
        userId,
        integrationId: "gmail",
        status: "active",
        config: {
          provider: "gmail",
          scope: "gmail.readonly",
          email: "reset-routing@example.com",
          hasRefreshToken: true
        }
      }
    });

    const createRule = (name: string, adapterId: string, status: "active" | "paused", query: string) =>
      prisma.emailSignalRule.create({
        data: {
          userId,
          connectionId: connection.id,
          adapterId,
          name,
          query,
          status,
          fetchStrategy: "query",
          lookbackDays: 30,
          maxMessagesPerSync: 25,
          maxEventsPerSync: 5,
          classifierMode: "rules",
          minAutoLogConfidence: adapterId === "custom_email_review" ? 1 : 0.9,
          minReviewConfidence: 0.65,
          reviewBeforeLogging: adapterId !== "job_search_email",
          createdBy: "user"
        }
      });

    const endesa = await createRule("Endesa emails", "custom_email_review", "active", "newer_than:30d Endesa");
    const testando = await createRule("Testando emails", "custom_email_review", "active", "newer_than:30d testando@gmail.com");
    const pausedEndesa = await createRule("Endesa bills", "custom_email_review", "paused", "newer_than:30d bill invoice factura Endesa");
    const jobSearch = await createRule("Job search emails", "job_search_email", "active", "newer_than:30d interview");
    const workAction = await createRule("Work action emails", "work_action_email", "active", "newer_than:7d \"please review\"");

    let response = await server.inject({
      method: "POST",
      url: `/users/${userId}/conversation/control`,
      payload: { text: "delete all email rules" }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().handled, false);
    assert.doesNotMatch(response.json().reply ?? "", /I could not confidently match/i);

    response = await server.inject({
      method: "POST",
      url: `/users/${userId}/conversation/control`,
      payload: { text: "can u delete all of em? i want a reset" }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().handled, false);
    assert.doesNotMatch(response.json().reply ?? "", /I could not confidently match/i);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "what email rules do we have" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Email rules currently configured/);
    assert.match(response.json().reply, /Endesa emails/);
    assert.doesNotMatch(response.json().reply, /I could not confidently match/i);
    assert.equal(response.json().routeDebug.intent, "email_rules_list");

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "can u delete all of em? i want a reset" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Confirm remove 5 Gmail email rules/i);
    assert.match(response.json().reply, /Endesa emails/);
    assert.match(response.json().reply, /Testando emails/);
    assert.doesNotMatch(response.json().reply, /I could not confidently match/i);
    assert.equal(response.json().routeDebug.intent, "gmail_custom_rule_manage");

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "no" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Cancelled/);
    assert.equal((await prisma.emailSignalRule.findUniqueOrThrow({ where: { id: endesa.id } })).status, "active");
    assert.equal((await prisma.emailSignalRule.findUniqueOrThrow({ where: { id: testando.id } })).status, "active");

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "can u delete all email rules" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Confirm remove 5 Gmail email rules/i);
    assert.doesNotMatch(response.json().reply, /I could not confidently match/i);
    assert.equal(response.json().routeDebug.intent, "gmail_custom_rule_manage");

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "no" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Cancelled/);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "what email rules do we have" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Email rules currently configured/);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "turn all off and delete them" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Confirm remove 5 Gmail email rules/i);
    assert.doesNotMatch(response.json().reply, /Could not confidently handle|I could not confidently match/i);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "no" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Cancelled/);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "delete email rules for Work action emails, Job search emails, Work action emails and Endesa bills" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Confirm remove 3 Gmail email rules/i);
    assert.match(response.json().reply, /Work action emails/);
    assert.match(response.json().reply, /Job search emails/);
    assert.match(response.json().reply, /Endesa bills/);
    assert.doesNotMatch(response.json().reply, /Could not handle|Could not confidently handle/i);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "no" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Cancelled/);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "can u delete all email rules" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Confirm remove 5 Gmail email rules/i);
    assert.doesNotMatch(response.json().reply, /I could not confidently match/i);
    assert.equal(response.json().routeDebug.intent, "gmail_custom_rule_manage");

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "yes" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Gmail email rules removed: 5/);
    assert.equal((await prisma.emailSignalRule.findUniqueOrThrow({ where: { id: endesa.id } })).status, "archived");
    assert.equal((await prisma.emailSignalRule.findUniqueOrThrow({ where: { id: testando.id } })).status, "archived");
    assert.equal((await prisma.emailSignalRule.findUniqueOrThrow({ where: { id: pausedEndesa.id } })).status, "archived");
    assert.equal((await prisma.emailSignalRule.findUniqueOrThrow({ where: { id: jobSearch.id } })).status, "archived");
    assert.equal((await prisma.emailSignalRule.findUniqueOrThrow({ where: { id: workAction.id } })).status, "archived");
  } finally {
    if (previousRouterEnabled === undefined) delete process.env.LLM_ROUTER_ENABLED;
    else process.env.LLM_ROUTER_ENABLED = previousRouterEnabled;
    if (previousRouterMock === undefined) delete process.env.LLM_ROUTER_MOCK_RESPONSE;
    else process.env.LLM_ROUTER_MOCK_RESPONSE = previousRouterMock;
    if (previousOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAIKey;
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("built-in Gmail email rules are displayed and reused without duplicate noise", async () => {
  const previousRouterEnabled = process.env.LLM_ROUTER_ENABLED;
  const previousRouterMock = process.env.LLM_ROUTER_MOCK_RESPONSE;
  const previousOpenAIKey = process.env.OPENAI_API_KEY;
  const userId = `builtin-email-rule-dedupe-${randomUUID()}`;
  const server = buildServer();

  try {
    await server.ready();
    process.env.LLM_ROUTER_ENABLED = "false";
    delete process.env.LLM_ROUTER_MOCK_RESPONSE;
    delete process.env.OPENAI_API_KEY;
    await prisma.user.create({ data: { id: userId } });
    const connection = await prisma.integrationConnection.create({
      data: {
        userId,
        integrationId: "gmail",
        status: "active",
        config: {
          provider: "gmail",
          scope: "gmail.readonly",
          email: "builtin-dedupe@example.com",
          hasRefreshToken: true
        }
      }
    });

    const createRule = (name: string, adapterId: string, status: "active" | "paused", query: string) =>
      prisma.emailSignalRule.create({
        data: {
          userId,
          connectionId: connection.id,
          adapterId,
          name,
          query,
          status,
          fetchStrategy: "query",
          lookbackDays: 30,
          maxMessagesPerSync: 25,
          maxEventsPerSync: 5,
          classifierMode: adapterId === "work_action_email" ? "hybrid" : "rules",
          minAutoLogConfidence: adapterId === "work_action_email" ? 0.95 : 0.9,
          minReviewConfidence: 0.65,
          reviewBeforeLogging: adapterId !== "job_search_email",
          createdBy: "user"
        }
      });

    const workRuleA = await createRule("Work action emails", "work_action_email", "active", "newer_than:7d \"please review\"");
    const workRuleB = await createRule("Work action emails", "work_action_email", "active", "newer_than:7d \"please review\"");
    await createRule("Job search emails", "job_search_email", "active", "newer_than:30d interview");

    let response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "what email rules do we have" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Work action emails.*2 duplicate rules; shown once/i);
    assert.equal((response.json().reply.match(/Work action emails/g) ?? []).length, 1);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "delete all email rules" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Confirm remove 3 Gmail email rules/i);
    assert.match(response.json().reply, /Work action emails - 2 duplicate rules/i);
    assert.equal((response.json().reply.match(/Work action emails/g) ?? []).length, 1);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "no" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Cancelled/);

    response = await server.inject({
      method: "POST",
      url: `/users/${userId}/email-rules`,
      payload: {
        connectionId: connection.id,
        adapterId: "work_action_email",
        name: "Work action emails"
      }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().message, /Email rule already exists|Archived 1 duplicate email rule/);

    const workRulesAfterEnable = await prisma.emailSignalRule.findMany({
      where: { userId, adapterId: "work_action_email" }
    });
    assert.equal(workRulesAfterEnable.filter((rule) => rule.status === "active").length, 1);
    assert.equal(workRulesAfterEnable.filter((rule) => rule.status === "archived").length, 1);

    const activeRuleId = workRulesAfterEnable.find((rule) => rule.status === "active")?.id;
    assert.ok(activeRuleId === workRuleA.id || activeRuleId === workRuleB.id);
  } finally {
    if (previousRouterEnabled === undefined) delete process.env.LLM_ROUTER_ENABLED;
    else process.env.LLM_ROUTER_ENABLED = previousRouterEnabled;
    if (previousRouterMock === undefined) delete process.env.LLM_ROUTER_MOCK_RESPONSE;
    else process.env.LLM_ROUTER_MOCK_RESPONSE = previousRouterMock;
    if (previousOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAIKey;
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("custom Gmail rule conversation handles bulk removal and utility tracking without false health goal link", async () => {
  const userId = `custom-gmail-bulk-remove-${randomUUID()}`;
  const server = buildServer();

  try {
    await server.ready();
    await prisma.user.create({ data: { id: userId } });
    await prisma.goal.create({
      data: {
        userId,
        title: "Improve strength and energy",
        category: "health",
        templateId: "health.strength_energy",
        status: "active"
      }
    });
    const connection = await prisma.integrationConnection.create({
      data: {
        userId,
        integrationId: "gmail",
        status: "active",
        config: {
          provider: "gmail",
          scope: "gmail.readonly",
          email: "bulk-remove@example.com",
          hasRefreshToken: true
        }
      }
    });
    const aigues = await prisma.emailSignalRule.create({
      data: {
        userId,
        connectionId: connection.id,
        adapterId: "custom_email_review",
        name: "Aigues Barcelona emails",
        query: "newer_than:30d Aigues Barcelona",
        status: "active",
        fetchStrategy: "query",
        lookbackDays: 30,
        maxMessagesPerSync: 25,
        maxEventsPerSync: 5,
        classifierMode: "rules",
        minAutoLogConfidence: 1,
        minReviewConfidence: 0.65,
        reviewBeforeLogging: true,
        createdBy: "user"
      }
    });
    const endesa = await prisma.emailSignalRule.create({
      data: {
        userId,
        connectionId: connection.id,
        adapterId: "custom_email_review",
        name: "Endesa emails",
        query: "newer_than:30d Endesa",
        status: "active",
        fetchStrategy: "query",
        lookbackDays: 30,
        maxMessagesPerSync: 25,
        maxEventsPerSync: 5,
        classifierMode: "rules",
        minAutoLogConfidence: 1,
        minReviewConfidence: 0.65,
        reviewBeforeLogging: true,
        createdBy: "user"
      }
    });
    const pausedEndesa = await prisma.emailSignalRule.create({
      data: {
        userId,
        connectionId: connection.id,
        adapterId: "custom_email_review",
        name: "Endesa bills",
        query: "newer_than:30d bill invoice factura Endesa",
        status: "paused",
        fetchStrategy: "query",
        lookbackDays: 30,
        maxMessagesPerSync: 25,
        maxEventsPerSync: 5,
        classifierMode: "rules",
        minAutoLogConfidence: 1,
        minReviewConfidence: 0.65,
        reviewBeforeLogging: true,
        createdBy: "user"
      }
    });

    let response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "elimina aigues de barcelona y endesa" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Confirm remove 2 Gmail email rules/);
    assert.match(response.json().reply, /Aigues Barcelona emails/);
    assert.match(response.json().reply, /Endesa emails/);
    assert.doesNotMatch(response.json().reply, /Endesa bills/);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "yes" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Gmail email rules removed: 2/);
    assert.equal((await prisma.emailSignalRule.findUniqueOrThrow({ where: { id: aigues.id } })).status, "archived");
    assert.equal((await prisma.emailSignalRule.findUniqueOrThrow({ where: { id: endesa.id } })).status, "archived");
    assert.equal((await prisma.emailSignalRule.findUniqueOrThrow({ where: { id: pausedEndesa.id } })).status, "paused");

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "track Endesa bills from Gmail" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Rule:/);
    assert.match(response.json().reply, /Endesa/);
    assert.doesNotMatch(response.json().reply, /linked goal: Improve strength and energy/i);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("explicit custom Gmail target never falls back to unrelated visible rule context", async () => {
  const previousRouterEnabled = process.env.LLM_ROUTER_ENABLED;
  const previousRouterMock = process.env.LLM_ROUTER_MOCK_RESPONSE;
  const previousOpenAIKey = process.env.OPENAI_API_KEY;
  const userId = `gmail-cross-domain-${randomUUID()}`;
  const server = buildServer();

  try {
    await server.ready();
    process.env.LLM_ROUTER_ENABLED = "true";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.LLM_ROUTER_MOCK_RESPONSE = JSON.stringify({
      intent: "gmail_custom_rule_manage",
      operation: "remove",
      confidence: 0.92,
      reason: "User wants to ignore/remove Endesa email items.",
      language: "en",
      sideEffectRisk: "destructive",
      requiresConfirmation: true,
      target: "Endesa",
      keywordFilters: [],
      senderFilters: [],
      removeKeywordFilters: [],
      goalHint: null,
      shouldUnlinkGoal: false,
      userFacingIssue: null
    });

    await prisma.user.create({ data: { id: userId } });
    const connection = await prisma.integrationConnection.create({
      data: {
        userId,
        integrationId: "gmail",
        status: "active",
        config: {
          provider: "gmail",
          scope: "gmail.readonly",
          email: "cross-domain@example.com",
          hasRefreshToken: true
        }
      }
    });
    const workRule = await prisma.emailSignalRule.create({
      data: {
        userId,
        connectionId: connection.id,
        adapterId: "work_action_email",
        name: "Work action emails",
        query: "newer_than:7d \"please review\"",
        status: "active",
        fetchStrategy: "query",
        lookbackDays: 7,
        maxMessagesPerSync: 25,
        maxEventsPerSync: 5,
        classifierMode: "hybrid",
        minAutoLogConfidence: 0.95,
        minReviewConfidence: 0.65,
        reviewBeforeLogging: true,
        createdBy: "user"
      }
    });

    await prisma.pendingAction.create({
      data: {
        userId,
        type: "custom_email_rule",
        status: "pending",
        summary: "Gmail rule context",
        payload: {
          operation: "rule_context",
          focusedRuleId: workRule.id,
          rules: [{ id: workRule.id, name: workRule.name, adapterId: workRule.adapterId }]
        },
        expiresAt: new Date(Date.now() + 60 * 60 * 1000)
      }
    });

    const response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId, message: "ignore the Endesa ones" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /I don't see visible Endesa reviews or an active Endesa rule/i);
    assert.doesNotMatch(response.json().reply, /Work action emails/);
    assert.equal((await prisma.emailSignalRule.findUniqueOrThrow({ where: { id: workRule.id } })).status, "active");
  } finally {
    if (previousRouterEnabled === undefined) delete process.env.LLM_ROUTER_ENABLED;
    else process.env.LLM_ROUTER_ENABLED = previousRouterEnabled;
    if (previousRouterMock === undefined) delete process.env.LLM_ROUTER_MOCK_RESPONSE;
    else process.env.LLM_ROUTER_MOCK_RESPONSE = previousRouterMock;
    if (previousOpenAIKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAIKey;
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("risky action command text routes to guardrail response without creating ActionItem", async () => {
  const server = buildServer();
  const actionUserId = `action-risk-command-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  const riskGoal = await prisma.goal.create({
    data: {
      userId: actionUserId,
      title: "Control impulsive betting",
      category: "finance",
      templateId: "finance.control_betting_trading"
    }
  });

  const cases = [
    { command: "/action", text: "bet 500 tomorrow", intent: "betting_intent" },
    { command: "/todo", text: "open 20x long tomorrow", intent: "trading_intent" },
    { command: "/add_action", text: "place bet tonight", intent: "betting_intent" }
  ];

  try {
    for (const testCase of cases) {
      const debug = explainNormalizedInboundRoute(
        buildNormalizedInboundMessage({
          channel: "telegram",
          userId: actionUserId,
          externalUserId: "123",
          text: `${testCase.command} ${testCase.text}`
        })
      );
      assert.equal(debug.intentType, "command_with_guardrail");
      assert.equal(debug.allowedSideEffects.createAction, false);

      const response = await server.inject({
        method: "POST",
        url: "/messages/process",
        payload: { userId: actionUserId, message: testCase.text }
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().intent, testCase.intent);
      assert.notEqual(response.json().reply, "I could not turn that into a concrete action item.");
    }

    const actions = await prisma.actionItem.findMany({ where: { userId: actionUserId } });
    assert.equal(actions.length, 0);
    const cooldowns = await prisma.event.findMany({
      where: { userId: actionUserId, type: "finance.betting.cooldown_triggered" },
      orderBy: { createdAt: "asc" }
    });
    assert.equal(cooldowns.length, 3);
    const guardrail = (cooldowns[0].data as { guardrail?: { goalId?: string; category?: string; severity?: string } }).guardrail;
    assert.equal(guardrail?.goalId, riskGoal.id);
    assert.equal(guardrail?.category, "impulse_control");
    assert.equal(guardrail?.severity, "hard");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("betting phrased as a daily advice question hard-stops before today routing", async () => {
  const server = buildServer();
  const actionUserId = `bet-daily-question-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  await prisma.goal.create({
    data: {
      userId: actionUserId,
      title: "Control impulsive betting",
      category: "finance",
      templateId: "finance.control_betting_trading"
    }
  });

  try {
    const response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: actionUserId, message: "what should I do today to win a bet?" }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().riskState, "RED");
    assert.match(response.json().reply, /Hard stop/);
    assert.doesNotMatch(response.json().reply, /Today -/);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("/today and /review use the same user-local day event window", async () => {
  const server = buildServer();
  const reviewUserId = `daily-review-window-${randomUUID()}`;
  const now = "2026-08-13T10:00:00+02:00";
  await prisma.user.create({ data: { id: reviewUserId } });
  await prisma.notificationSettings.create({
    data: {
      userId: reviewUserId,
      timezone: "Europe/Madrid",
      telegramUserId: "12345"
    }
  });
  await prisma.event.create({
    data: {
      userId: reviewUserId,
      type: "health.workout_completed",
      timestamp: new Date("2026-08-12T22:30:00.000Z"),
      source: "manual",
      data: { duration_minutes: 30 },
      confidence: 1,
      evidence: ["trained 30 min"]
    }
  });

  try {
    const today = await server.inject({
      method: "GET",
      url: `/users/${reviewUserId}/today?now=${encodeURIComponent(now)}`
    });
    assert.equal(today.statusCode, 200);
    assert.match(today.json().brief.summary, /1 event logged today/);

    const review = await server.inject({
      method: "GET",
      url: `/users/${reviewUserId}/review/daily?now=${encodeURIComponent(now)}`
    });
    assert.equal(review.statusCode, 200);
    assert.match(review.json().review.summary, /30 minutes of training/);
    assert.doesNotMatch(review.json().review.summary, /No events logged yet today/);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: reviewUserId } });
  }
});

test("natural weekly review refreshes stale week-to-date memory", async () => {
  mock.timers.enable({ apis: ["Date"], now: new Date("2026-08-13T08:00:00.000Z") });
  const server = buildServer();
  const reviewUserId = `weekly-natural-refresh-${randomUUID()}`;
  await prisma.user.create({ data: { id: reviewUserId } });
  await prisma.notificationSettings.create({
    data: {
      userId: reviewUserId,
      timezone: "Europe/Madrid",
      telegramUserId: "12345"
    }
  });
  await prisma.memoryEntry.create({
    data: {
      userId: reviewUserId,
      type: "pattern",
      status: "active",
      summary: "Old Monday-only weekly review.",
      source: "system_inferred",
      confidence: 1,
      data: {
        kind: "weekly_review",
        status: "generated",
        weekStartLocalDate: "2026-08-10",
        weekEndLocalDate: "2026-08-16",
        reviewedEndLocalDate: "2026-08-10",
        timezone: "Europe/Madrid",
        wins: ["No wins yet"],
        stalls: ["No progress logged"],
        goalProgress: [],
        guardrailSummary: { note: "No guardrail triggers logged this reviewed period." },
        patterns: [],
        recommendedNextWeekActions: [],
        reflectionIds: [],
        source: "deterministic"
      }
    }
  });

  try {
    const response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: reviewUserId, message: "review my week" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Weekly review so far - 2026-08-10 to 2026-08-13/);
    assert.doesNotMatch(response.json().reply, /2026-08-10 to 2026-08-10/);
  } finally {
    mock.timers.reset();
    await server.close();
    await prisma.user.deleteMany({ where: { id: reviewUserId } });
  }
});

test("pasted prompt with risky examples does not trigger guardrail or cooldown", async () => {
  const server = buildServer();
  const actionUserId = `risk-reference-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });

  try {
    const response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: {
        userId: actionUserId,
        message: "You are working in the repo. Tests: /action bet 500 tomorrow. Expected: no ActionItem."
      }
    });
    assert.equal(response.statusCode, 200);
    assert.notEqual(response.json().intent, "betting_intent");
    assert.notEqual(response.json().riskState, "RED");

    const cooldowns = await prisma.event.findMany({
      where: { userId: actionUserId, type: "finance.betting.cooldown_triggered" }
    });
    assert.equal(cooldowns.length, 0);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("conversation-first surface routes natural operator requests without leaking secrets", async () => {
  const server = buildServer();
  const uxUserId = `conversation-parity-${randomUUID()}`;

  try {
    await prisma.user.upsert({
      where: { id: uxUserId },
      update: {},
      create: { id: uxUserId }
    });
    await prisma.goal.createMany({
      data: [
        {
          userId: uxUserId,
          title: "Find a new developer job",
          category: "career",
          templateId: "career.job_search",
          priority: "critical",
          importanceScore: 70
        },
        {
          userId: uxUserId,
          title: "Build a YouTube channel",
          category: "creative",
          priority: "medium",
          importanceScore: 25
        }
      ]
    });
    await prisma.actionItem.create({
      data: {
        userId: uxUserId,
        source: "manual",
        title: "Apply to 2 jobs",
        status: "open",
        priority: "medium",
        dueAt: new Date("2026-08-07T07:00:00.000Z"),
        actionType: "deadline",
        evidence: "apply to 2 jobs"
      }
    });
    await prisma.actionItem.create({
      data: {
        userId: uxUserId,
        source: "manual",
        title: "Write YouTube script",
        status: "open",
        priority: "medium",
        dueAt: new Date("2026-08-01T14:30:00.000Z"),
        actionType: "deadline",
        evidence: "write youtube script"
      }
    });
    await prisma.memoryEntry.create({
      data: {
        userId: uxUserId,
        type: "preference",
        status: "active",
        summary: "User prefers direct, factual replies.",
        source: "test",
        confidence: 1
      }
    });
    await prisma.event.create({
      data: {
        userId: uxUserId,
        type: "career.application_sent",
        timestamp: new Date(),
        source: "manual",
        data: { count: 2 },
        confidence: 1,
        evidence: ["sent 2 applications"]
      }
    });
    await prisma.integrationConnection.create({
      data: {
        userId: uxUserId,
        integrationId: "gmail",
        status: "active",
        config: {
          provider: "gmail",
          email: "user@example.com",
          accessToken: "secret-access-token",
          refreshToken: "secret-refresh-token"
        }
      }
    });

    let response = await server.inject({
      method: "GET",
      url: `/users/${uxUserId}/onboarding/start`
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().message, /Hey, I'm Alecto/);
    assert.match(response.json().message, /You can talk normally/);
    assert.doesNotMatch(response.json().message, /secret-access-token|secret-refresh-token|raw email/i);

    response = await server.inject({
      method: "GET",
      url: `/users/${uxUserId}/onboarding/setup`
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().message, /Alecto setup/);
    assert.match(response.json().message, /Goals: 2 active/);
    assert.match(response.json().message, /Actions: 2 open/);
    assert.doesNotMatch(response.json().message, /secret-access-token|secret-refresh-token|raw email/i);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: uxUserId, message: "what can you do" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Daily planning/);
    assert.match(response.json().reply, /Guardrails/);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: uxUserId, message: "help me set up" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Alecto setup/);
    assert.match(response.json().reply, /Goals: 2 active/);
    assert.match(response.json().reply, /Actions: 2 open/);
    assert.match(response.json().reply, /Ready:/);
    assert.match(response.json().reply, /Needs attention:/);
    assert.match(response.json().reply, /Optional:/);
    assert.match(response.json().reply, /Best next step:/);
    assert.doesNotMatch(response.json().reply, /secret-access-token|secret-refresh-token/i);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: uxUserId, message: "how do I start" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Quickstart:/);
    assert.match(response.json().reply, /what should I do today/);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: uxUserId, message: "what is missing" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Needs attention:/);

    const beforeOnboardingActions = await prisma.actionItem.count({ where: { userId: uxUserId } });
    const beforeOnboardingGoals = await prisma.goal.count({ where: { userId: uxUserId } });
    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: uxUserId, message: "set up goals" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Goal setup:/);
    assert.match(response.json().reply, /enough to operate|confirmation/i);
    assert.equal(await prisma.goal.count({ where: { userId: uxUserId } }), beforeOnboardingGoals);
    assert.equal(await prisma.actionItem.count({ where: { userId: uxUserId } }), beforeOnboardingActions);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: uxUserId, message: "how do reminders work" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Actions are concrete things/i);
    assert.match(response.json().reply, /remind me to apply to 3 jobs tomorrow/i);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: uxUserId, message: "set up daily loop" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Daily loop setup:/);
    assert.match(response.json().reply, /turn on morning brief at 9/);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: uxUserId, message: "set up integrations" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Integration setup:/);
    assert.match(response.json().reply, /Gmail is readonly/);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: uxUserId, message: "what should I do today" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Today -/);
    assert.match(response.json().reply, /Next move:/);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: uxUserId, message: "review my day" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Today:/);
    assert.match(response.json().reply, /Next step:/);
    assert.doesNotMatch(response.json().reply, /Do one concrete action for Control impulsive betting/);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: uxUserId, message: "review my week" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Weekly review/);
    const weeklyReviewCount = await prisma.memoryEntry.count({
      where: { userId: uxUserId, status: "active", data: { path: ["kind"], equals: "weekly_review" } }
    });
    assert.equal(weeklyReviewCount, 1);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: uxUserId, message: "plan next week" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Next week plan/);
    assert.equal(await prisma.actionItem.count({ where: { userId: uxUserId, sourceProvider: "weekly_plan" } }), 0);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: uxUserId, message: "clean up my tasks" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Action hygiene:/);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: uxUserId, message: "show my goals" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Active goals:/);
    assert.match(response.json().reply, /Find a new developer job/);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: uxUserId, message: "show my tasks" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Open actions:/);
    assert.match(response.json().reply, /Apply to 2 jobs/);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: uxUserId, message: "show my memories" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Active memories:/);
    assert.match(response.json().reply, /direct, factual replies/);
    assert.doesNotMatch(response.json().reply, /Verified reviewed period/);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: uxUserId, message: "connect Gmail" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /readonly access/);
    assert.match(response.json().reply, /only scans Gmail through active rules/);
    assert.match(response.json().reply, /go to review/);
    assert.doesNotMatch(response.json().reply, /secret-access-token|secret-refresh-token|raw/i);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: uxUserId, message: "connect GitHub" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /public/i);
    assert.match(response.json().reply, /author=LOGIN/);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: uxUserId, message: "turn on morning brief at 9" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Daily loop updated/);
    assert.match(response.json().reply, /Morning brief: 09:00/);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: uxUserId, message: "turn on morning brief at 9 and evening review at 21:30" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Morning brief: 09:00/);
    assert.match(response.json().reply, /Evening review: 21:30/);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: uxUserId, message: "I want to bet 500 tomorrow and show setup" }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().riskState, "RED");
    assert.doesNotMatch(response.json().reply, /Setup state:/);

    const reference = segmentInboundMessage("[30/07/2026 04:56] letis: /archive_action abc\n[30/07/2026 04:56] Alecto AI: Action archived");
    assert.equal(reference.kind, "reference_text");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: uxUserId } });
  }
});

test("manual actions infer links to active goals", async () => {
  const server = buildServer();
  const actionUserId = `action-goal-links-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  const jobGoal = await prisma.goal.create({
    data: {
      userId: actionUserId,
      title: "Find a new developer job",
      category: "career",
      templateId: "career.job_search"
    }
  });
  const healthGoal = await prisma.goal.create({
    data: {
      userId: actionUserId,
      title: "Build strength and energy",
      category: "health",
      templateId: "health.strength_energy"
    }
  });
  const youtubeGoal = await prisma.goal.create({
    data: {
      userId: actionUserId,
      title: "Build a YouTube channel",
      category: "creative"
    }
  });
  const carGoal = await prisma.goal.create({
    data: {
      userId: actionUserId,
      title: "Find a cheap car to buy",
      category: "custom"
    }
  });

  try {
    const cases = [
      { text: "send CV tonight", goalId: jobGoal.id, title: "Send CV" },
      { text: "apply to 2 jobs tomorrow", goalId: jobGoal.id },
      { text: "train legs tomorrow", goalId: healthGoal.id },
      { text: "write YouTube script tonight", goalId: youtubeGoal.id },
      { text: "check cheap car listings tomorrow", goalId: carGoal.id },
      { text: "pay electricity tomorrow", goalId: undefined }
    ];

    for (const testCase of cases) {
      const response = await server.inject({
        method: "POST",
        url: `/users/${actionUserId}/actions/manual`,
        payload: { text: testCase.text }
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().action.goalId, testCase.goalId);
      if (testCase.goalId) {
        assert.ok(response.json().action.goalTitleSnapshot);
      }
      if (testCase.title) {
        assert.equal(response.json().action.title, testCase.title);
      }
    }
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("conversational action control completes, reschedules, shows, and updates priorities", async () => {
  const server = buildServer();
  const actionUserId = `conversation-control-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  await prisma.notificationSettings.create({
    data: {
      userId: actionUserId,
      timezone: "Europe/Madrid",
      afternoonTimeMinutes: 990
    }
  });
  const jobGoal = await prisma.goal.create({
    data: {
      userId: actionUserId,
      title: "Find a new developer job",
      category: "career",
      templateId: "career.job_search",
      priority: "medium",
      importanceScore: 25
    }
  });
  const youtubeGoal = await prisma.goal.create({
    data: {
      userId: actionUserId,
      title: "Build a YouTube channel",
      category: "creative",
      priority: "medium",
      importanceScore: 25
    }
  });
  const applyAction = await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Apply to 2 jobs",
      priority: "medium",
      status: "open",
      goalId: jobGoal.id,
      goalTitleSnapshot: jobGoal.title
    }
  });
  const youtubeAction = await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Write YouTube script",
      priority: "medium",
      status: "open",
      goalId: youtubeGoal.id,
      goalTitleSnapshot: youtubeGoal.title
    }
  });

  try {
    let response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/control`,
      payload: {
        text: "move YouTube script to tomorrow afternoon",
        now: "2026-07-31T03:01:00+02:00",
        dryRun: true
      }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().debug.intent, "reschedule_action");
    assert.equal(response.json().debug.targetText, "YouTube script");
    assert.equal(response.json().debug.timeText, "tomorrow afternoon");
    assert.equal(response.json().debug.resolvedAction.title, "Write YouTube script");
    assert.equal(response.json().debug.requiresConfirmation, false);
    assert.equal(response.json().debug.blockedByGuardrail, false);
    assert.equal((await prisma.actionItem.findUniqueOrThrow({ where: { id: youtubeAction.id } })).dueAt, null);

    response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/control`,
      payload: { text: "done with apply to 2 jobs" }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().handled, true);
    assert.match(response.json().reply, /Action completed: Apply to 2 jobs/);
    assert.match(response.json().reply, /Goal progress logged: Find a new developer job/);
    assert.equal((await prisma.actionItem.findUniqueOrThrow({ where: { id: applyAction.id } })).status, "completed");
    assert.equal(
      await prisma.event.count({
        where: {
          userId: actionUserId,
          type: "custom.goal_progress_logged",
          provider: "action_completion",
          externalId: `action-completion:${applyAction.id}`
        }
      }),
      1
    );

    response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/control`,
      payload: { text: "done with apply to 2 jobs" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Action already completed: Apply to 2 jobs/);
    assert.equal(
      await prisma.event.count({
        where: {
          userId: actionUserId,
          type: "custom.goal_progress_logged",
          provider: "action_completion",
          externalId: `action-completion:${applyAction.id}`
        }
      }),
      1
    );

    response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/control`,
      payload: {
        text: "move YouTube script to tomorrow afternoon",
        now: "2026-07-31T01:40:00+02:00"
      }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Action rescheduled: Write YouTube script/);
    const updatedYoutube = await prisma.actionItem.findUniqueOrThrow({ where: { id: youtubeAction.id } });
    assert.equal(updatedYoutube.status, "open");
    assert.ok(updatedYoutube.dueAt);
    assert.equal(localDate(updatedYoutube.dueAt), "2026-08-01");
    assert.equal(localMinutes(updatedYoutube.dueAt), 990);
    assert.equal(await prisma.actionItem.count({ where: { userId: actionUserId, title: "Write YouTube script" } }), 1);

    const genericFallback = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: {
        userId: actionUserId,
        message: "move YouTube script to tomorrow afternoon"
      }
    });
    assert.equal(genericFallback.statusCode, 200);
    assert.equal(genericFallback.json().reply, "I could not complete that change. Use /actions to check the exact task.");
    assert.doesNotMatch(genericFallback.json().reply, /noted|logged|moved|rescheduled/i);

    response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/control`,
      payload: {
        text: "move impossible nonexistent task to tomorrow afternoon",
        now: "2026-07-31T01:40:00+02:00"
      }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().handled, true);
    assert.doesNotMatch(response.json().reply, /Action rescheduled|I.?ve logged|I moved/i);
    assert.equal(await prisma.actionItem.count({ where: { userId: actionUserId, title: "Write YouTube script" } }), 1);

    response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/control`,
      payload: {
        text: "what should I do now?",
        now: "2026-07-31T01:40:00+02:00"
      }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().handled, true);
    assert.match(response.json().reply, /Write YouTube script/);

    response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/control`,
      payload: {
        text: "show today",
        now: "2026-07-31T01:40:00+02:00"
      }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Today - 2026-07-31/);

    response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/control`,
      payload: { text: "make job search critical" }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().reply, "Goal priority updated: Find a new developer job -> critical");
    assert.equal((await prisma.goal.findUniqueOrThrow({ where: { id: jobGoal.id } })).priority, "critical");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("conversational action control asks before destructive or ambiguous mutations", async () => {
  const server = buildServer();
  const actionUserId = `conversation-control-safe-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  const carAction = await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Check cheap car listings",
      priority: "medium",
      status: "open"
    }
  });
  const callMorning = await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Call Alex",
      priority: "medium",
      status: "open",
      dueAt: new Date("2026-07-31T07:00:00.000Z")
    }
  });
  const callAfternoon = await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Call Alex",
      priority: "medium",
      status: "open",
      dueAt: new Date("2026-07-31T13:00:00.000Z")
    }
  });
  await prisma.actionItem.createMany({
    data: [
      {
        userId: actionUserId,
        source: "manual",
        title: "Review homepage copy",
        priority: "medium",
        status: "open",
        project: "homepage"
      },
      {
        userId: actionUserId,
        source: "manual",
        title: "Update homepage hero",
        priority: "medium",
        status: "open",
        project: "homepage"
      }
    ]
  });

  try {
    let response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/control`,
      payload: { text: "delete the car task" }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().handled, true);
    assert.match(response.json().reply, /Confirm archive action: Check cheap car listings/);
    assert.equal((await prisma.actionItem.findUniqueOrThrow({ where: { id: carAction.id } })).status, "open");
    assert.equal(await prisma.pendingAction.count({ where: { userId: actionUserId, type: "action_archive", status: "pending" } }), 1);
    const confirm = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: actionUserId, message: "yes" }
    });
    assert.equal(confirm.statusCode, 200);
    assert.match(confirm.json().reply, /Action archived: Check cheap car listings/);
    assert.equal((await prisma.actionItem.findUniqueOrThrow({ where: { id: carAction.id } })).status, "archived");

    const removableAction = await prisma.actionItem.create({
      data: {
        userId: actionUserId,
        source: "manual",
        title: "Remove dashboard draft",
        priority: "medium",
        status: "open"
      }
    });
    response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/control`,
      payload: { text: "delete dashboard draft task" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Confirm archive action: Remove dashboard draft/);
    const reject = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: actionUserId, message: "no" }
    });
    assert.equal(reject.statusCode, 200);
    assert.match(reject.json().reply, /Cancelled/);
    assert.equal((await prisma.actionItem.findUniqueOrThrow({ where: { id: removableAction.id } })).status, "open");

    response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/control`,
      payload: { text: "done with call Alex" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Which action do you mean/);
    assert.match(response.json().reply, /1\. Call Alex/);
    assert.match(response.json().reply, /2\. Call Alex/);
    assert.equal(
      await prisma.pendingAction.count({ where: { userId: actionUserId, type: "action_target_clarification", status: "pending" } }),
      1
    );
    assert.equal(await prisma.actionItem.count({ where: { userId: actionUserId, status: "completed" } }), 0);

    const firstChoice = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: actionUserId, message: "1" }
    });
    assert.equal(firstChoice.statusCode, 200);
    assert.match(firstChoice.json().reply, /Action completed: Call Alex/);
    assert.equal((await prisma.actionItem.findUniqueOrThrow({ where: { id: callMorning.id } })).status, "completed");
    assert.equal((await prisma.actionItem.findUniqueOrThrow({ where: { id: callAfternoon.id } })).status, "open");

    response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/control`,
      payload: {
        text: "move homepage to tomorrow morning",
        now: "2026-07-31T14:37:00+02:00"
      }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Which action do you mean/);
    assert.match(response.json().reply, /Review homepage copy/);
    assert.match(response.json().reply, /Update homepage hero/);

    const callSamMorning = await prisma.actionItem.create({
      data: {
        userId: actionUserId,
        source: "manual",
        title: "Call Sam",
        priority: "medium",
        status: "open",
        dueAt: new Date("2026-07-31T07:00:00.000Z")
      }
    });
    const callSamAfternoon = await prisma.actionItem.create({
      data: {
        userId: actionUserId,
        source: "manual",
        title: "Call Sam",
        priority: "medium",
        status: "open",
        dueAt: new Date("2026-07-31T13:00:00.000Z")
      }
    });

    response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/control`,
      payload: { text: "done with call Sam" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Which action do you mean/);
    const secondChoice = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: actionUserId, message: "second one" }
    });
    assert.equal(secondChoice.statusCode, 200);
    assert.match(secondChoice.json().reply, /Action completed: Call Sam/);
    assert.equal((await prisma.actionItem.findUniqueOrThrow({ where: { id: callSamMorning.id } })).status, "open");
    assert.equal((await prisma.actionItem.findUniqueOrThrow({ where: { id: callSamAfternoon.id } })).status, "completed");

    await prisma.actionItem.create({
      data: {
        userId: actionUserId,
        source: "manual",
        title: "Call Pat",
        priority: "medium",
        status: "open",
        dueAt: new Date("2026-07-31T07:00:00.000Z")
      }
    });
    await prisma.actionItem.create({
      data: {
        userId: actionUserId,
        source: "manual",
        title: "Call Pat",
        priority: "medium",
        status: "open",
        dueAt: new Date("2026-07-31T13:00:00.000Z")
      }
    });
    response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/control`,
      payload: { text: "done with call Pat" }
    });
    assert.equal(response.statusCode, 200);
    const cancel = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: actionUserId, message: "cancel" }
    });
    assert.equal(cancel.statusCode, 200);
    assert.match(cancel.json().reply, /Cancelled/);
    assert.equal(await prisma.actionItem.count({ where: { userId: actionUserId, title: "Call Pat", status: "completed" } }), 0);

    response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/control`,
      payload: { text: "done with call Pat" }
    });
    assert.equal(response.statusCode, 200);
    await prisma.pendingAction.updateMany({
      where: { userId: actionUserId, type: "action_target_clarification", status: "pending" },
      data: { expiresAt: new Date("2026-01-01T00:00:00.000Z") }
    });
    const expired = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: actionUserId, message: "1" }
    });
    assert.equal(expired.statusCode, 200);
    assert.equal(expired.json().reply, "That pending decision expired. Please ask again.");
    assert.equal(await prisma.actionItem.count({ where: { userId: actionUserId, title: "Call Pat", status: "completed" } }), 0);

    response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/control`,
      payload: { text: "done with impossible nonexistent task" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /could not confidently match/);
    assert.equal(await prisma.actionItem.count({ where: { userId: actionUserId, title: { contains: "impossible" } } }), 0);

    const pendingList = await server.inject({
      method: "GET",
      url: `/users/${actionUserId}/pending-actions`
    });
    assert.equal(pendingList.statusCode, 200);
    assert.ok(Array.isArray(pendingList.json().pendingActions));
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("conversation control guardrails and debug are side-effect free", async () => {
  const server = buildServer();
  const actionUserId = `conversation-control-debug-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  const action = await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Apply to 2 jobs",
      priority: "medium",
      status: "open"
    }
  });

  try {
    let response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/control`,
      payload: { text: "done with apply to 2 jobs", dryRun: true }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().debug.intent, "complete_action");
    assert.equal(response.json().debug.resolvedAction.title, "Apply to 2 jobs");
    assert.equal((await prisma.actionItem.findUniqueOrThrow({ where: { id: action.id } })).status, "open");

    response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/control`,
      payload: { text: "remind me to bet 500 tomorrow" }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().handled, false);
    assert.equal(response.json().debug.blockedByGuardrail, true);
    assert.equal(await prisma.actionItem.count({ where: { userId: actionUserId, title: { contains: "bet" } } }), 0);

    response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/control`,
      payload: { text: "move my bet of 5000 usd to tomorrow" }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().handled, false);
    assert.equal(response.json().debug.intent, "goal_guardrail");
    assert.equal(response.json().debug.blockedByGuardrail, true);

    for (const text of ["move my bet to tomorrow", "snooze my bet until tomorrow", "mark betting task done"]) {
      response = await server.inject({
        method: "POST",
        url: `/users/${actionUserId}/conversation/control`,
        payload: { text }
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.json().handled, false);
      assert.equal(response.json().debug.intent, "goal_guardrail");
      assert.equal(response.json().debug.blockedByGuardrail, true);
    }
    assert.equal(await prisma.pendingAction.count({ where: { userId: actionUserId, status: "pending" } }), 0);

    const process = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: {
        userId: actionUserId,
        message: "remind me to bet 500 tomorrow"
      }
    });
    assert.equal(process.statusCode, 200);
    assert.equal(process.json().mode, "guardian");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("multi-intent orchestrator logs events, mutates actions, and returns readouts safely", async () => {
  const server = buildServer();
  const actionUserId = `multi-intent-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  await prisma.notificationSettings.create({
    data: {
      id: randomUUID(),
      userId: actionUserId,
      timezone: "Europe/Madrid",
      afternoonTimeMinutes: 990
    }
  });
  const youtubeGoal = await prisma.goal.create({
    data: {
      userId: actionUserId,
      title: "Build a YouTube channel",
      category: "creative",
      status: "active",
      priority: "medium",
      importanceScore: 25
    }
  });
  const jobGoal = await prisma.goal.create({
    data: {
      userId: actionUserId,
      title: "Find a new developer job",
      category: "career",
      templateId: "career.job_search",
      status: "active",
      priority: "critical",
      importanceScore: 70
    }
  });
  const youtubeAction = await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Write YouTube script",
      priority: "medium",
      status: "open",
      goalId: youtubeGoal.id,
      goalTitleSnapshot: youtubeGoal.title
    }
  });
  const applyAction = await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Apply to 2 jobs",
      priority: "medium",
      status: "open",
      goalId: jobGoal.id,
      goalTitleSnapshot: jobGoal.title
    }
  });
  const carAction = await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Check cheap car listings",
      priority: "medium",
      status: "open"
    }
  });

  try {
    let response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/multi-intent`,
      payload: {
        text: "I applied to 2 jobs, trained 30 min, and what should I do now?",
        now: "2026-07-31T01:40:00+02:00"
      }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().handled, true);
    assert.match(response.json().reply, /Logged 2 job applications/);
    assert.match(response.json().reply, /Logged 30 min training/);
    assert.match(response.json().reply, /Next move:/);
    assert.equal(await prisma.event.count({ where: { userId: actionUserId, type: "career.application_sent" } }), 1);
    assert.equal(await prisma.event.count({ where: { userId: actionUserId, type: "health.workout_completed" } }), 1);

    response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/multi-intent`,
      payload: {
        text: "move YouTube script to tomorrow afternoon and show actions",
        now: "2026-07-31T01:40:00+02:00"
      }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Action rescheduled: Write YouTube script/);
    assert.match(response.json().reply, /Open actions:/);
    const movedYoutube = await prisma.actionItem.findUniqueOrThrow({ where: { id: youtubeAction.id } });
    assert.ok(movedYoutube.dueAt);
    assert.equal(localDate(movedYoutube.dueAt), "2026-08-01");
    assert.equal(localMinutes(movedYoutube.dueAt), 990);

    response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/multi-intent`,
      payload: {
        text: "done with apply to 2 jobs and show today",
        now: "2026-07-31T01:40:00+02:00"
      }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Action completed: Apply to 2 jobs/);
    assert.match(response.json().reply, /Today - 2026-07-31/);
    assert.equal((await prisma.actionItem.findUniqueOrThrow({ where: { id: applyAction.id } })).status, "completed");
    assert.equal(
      await prisma.event.count({
        where: {
          userId: actionUserId,
          type: "custom.goal_progress_logged",
          provider: "action_completion",
          externalId: `action-completion:${applyAction.id}`
        }
      }),
      1
    );

    response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/multi-intent`,
      payload: { text: "make YouTube high priority and show goal priorities" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Goal priority updated: Build a YouTube channel -> high/);
    assert.match(response.json().reply, /Goal priorities:/);
    assert.equal((await prisma.goal.findUniqueOrThrow({ where: { id: youtubeGoal.id } })).priority, "high");

    response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/multi-intent`,
      payload: {
        text: "delete car listings and show today",
        now: "2026-07-31T01:40:00+02:00"
      }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Needs confirmation/);
    assert.match(response.json().reply, /Confirm archive action: Check cheap car listings/);
    assert.doesNotMatch(response.json().reply, /Today - 2026-07-31/);
    assert.equal((await prisma.actionItem.findUniqueOrThrow({ where: { id: carAction.id } })).status, "open");
    assert.equal(await prisma.pendingAction.count({ where: { userId: actionUserId, type: "action_archive", status: "pending" } }), 1);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: actionUserId, message: "no" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Cancelled/);
    assert.equal((await prisma.actionItem.findUniqueOrThrow({ where: { id: carAction.id } })).status, "open");

    response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/multi-intent`,
      payload: {
        text: "delete car and show today",
        now: "2026-07-31T01:40:00+02:00"
      }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Confirm archive action: Check cheap car listings/);
    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: actionUserId, message: "yes" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Action archived: Check cheap car listings/);
    assert.equal((await prisma.actionItem.findUniqueOrThrow({ where: { id: carAction.id } })).status, "archived");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("multi-intent orchestrator stops for ambiguity, guardrails, and dry-run debug has no side effects", async () => {
  const server = buildServer();
  const actionUserId = `multi-intent-safe-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  const youtubeAction = await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Write YouTube script",
      priority: "medium",
      status: "open"
    }
  });
  await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Call Alex",
      priority: "medium",
      status: "open",
      dueAt: new Date("2026-07-31T07:00:00.000Z")
    }
  });
  await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Call Alex",
      priority: "medium",
      status: "open",
      dueAt: new Date("2026-07-31T13:00:00.000Z")
    }
  });

  try {
    let response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/multi-intent`,
      payload: {
        text: "done with call Alex and show today",
        now: "2026-07-31T01:40:00+02:00"
      }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Which action do you mean/);
    assert.doesNotMatch(response.json().reply, /Today - 2026-07-31/);
    assert.equal(await prisma.actionItem.count({ where: { userId: actionUserId, title: "Call Alex", status: "completed" } }), 0);
    assert.equal(
      await prisma.pendingAction.count({ where: { userId: actionUserId, type: "action_target_clarification", status: "pending" } }),
      1
    );

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: actionUserId, message: "cancel" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Cancelled/);

    response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/multi-intent`,
      payload: {
        text: "delete call Alex and show today",
        now: "2026-07-31T01:40:00+02:00"
      }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Which action do you mean/);
    assert.doesNotMatch(response.json().reply, /Today - 2026-07-31/);
    assert.equal(await prisma.actionItem.count({ where: { userId: actionUserId, title: "Call Alex", status: "archived" } }), 0);
    assert.equal(
      await prisma.pendingAction.count({ where: { userId: actionUserId, type: "action_target_clarification", status: "pending" } }),
      1
    );

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: actionUserId, message: "cancel" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Cancelled/);

    response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/multi-intent`,
      payload: {
        text: "I want to bet 500 tomorrow and move YouTube to Saturday",
        now: "2026-07-31T01:40:00+02:00"
      }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().handled, true);
    assert.match(response.json().reply, /No|locked|cooldown|bet/i);
    assert.equal((await prisma.actionItem.findUniqueOrThrow({ where: { id: youtubeAction.id } })).dueAt, null);
    assert.equal(await prisma.actionItem.count({ where: { userId: actionUserId, title: { contains: "bet" } } }), 0);
    assert.equal(await prisma.event.count({ where: { userId: actionUserId, type: "finance.betting.cooldown_triggered" } }), 1);
    assert.equal(
      await prisma.pendingAction.count({ where: { userId: actionUserId, type: { in: ["action_archive", "action_target_clarification"] }, status: "pending" } }),
      0
    );

    response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/multi-intent`,
      payload: {
        text: "I applied to 3 jobs and show actions",
        dryRun: true
      }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().handled, false);
    assert.equal(response.json().plan.isMultiIntent, true);
    assert.equal(response.json().debug[0].type, "event_log");
    assert.equal(response.json().debug[0].wouldExecute, true);
    assert.equal(await prisma.event.count({ where: { userId: actionUserId, type: "career.application_sent" } }), 0);

    response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/multi-intent`,
      payload: { text: "flibbertigibbet and show actions" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Skipped/);
    assert.match(response.json().reply, /Open actions:/);

    response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/conversation/multi-intent`,
      payload: { text: "delete unknown thing and show today", now: "2026-07-31T01:40:00+02:00" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Skipped/);
    assert.match(response.json().reply, /I could not confidently match/);
    assert.match(response.json().reply, /Today - 2026-07-31/);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("unrelated manual action creates unlinked ActionItem", async () => {
  const server = buildServer();
  const actionUserId = `action-unlinked-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  await prisma.goal.create({
    data: {
      userId: actionUserId,
      title: "Build a YouTube channel",
      category: "creative"
    }
  });

  try {
    const response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/actions/manual`,
      payload: { text: "buy milk tomorrow" }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().action.title, "Buy milk");
    assert.equal(response.json().action.goalId, undefined);
    assert.equal(response.json().action.goalTitleSnapshot, undefined);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("archived goals are ignored by action goal inference", async () => {
  const server = buildServer();
  const actionUserId = `action-archived-goal-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  await prisma.goal.create({
    data: {
      userId: actionUserId,
      title: "Find a new developer job",
      category: "career",
      templateId: "career.job_search",
      status: "archived"
    }
  });

  try {
    const response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/actions/manual`,
      payload: { text: "send CV tonight" }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().action.goalId, undefined);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("debug goal-link backfill leaves unrelated actions unlinked", async () => {
  const server = buildServer();
  const actionUserId = `action-backfill-goals-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  const jobGoal = await prisma.goal.create({
    data: {
      userId: actionUserId,
      title: "Find a new developer job",
      category: "career",
      templateId: "career.job_search"
    }
  });
  const milk = await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Buy milk",
      priority: "medium"
    }
  });
  const cv = await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Send CV",
      priority: "medium"
    }
  });

  try {
    const response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/actions/debug-link-goals`,
      payload: {}
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().linked, 1);

    const [updatedMilk, updatedCv] = await Promise.all([
      prisma.actionItem.findUniqueOrThrow({ where: { id: milk.id } }),
      prisma.actionItem.findUniqueOrThrow({ where: { id: cv.id } })
    ]);
    assert.equal(updatedMilk.goalId, null);
    assert.equal(updatedCv.goalId, jobGoal.id);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("/today shows linked action under goal and skips generic progress prompt", async () => {
  const server = buildServer();
  const actionUserId = `today-linked-action-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  const jobGoal = await prisma.goal.create({
    data: {
      userId: actionUserId,
      title: "Find a new developer job",
      category: "career",
      templateId: "career.job_search"
    }
  });

  try {
    const actionResponse = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/actions/manual`,
      payload: { text: "send CV tonight" }
    });
    assert.equal(actionResponse.statusCode, 200);
    assert.equal(actionResponse.json().action.goalId, jobGoal.id);

    const today = await server.inject({
      method: "GET",
      url: `/users/${actionUserId}/today`
    });
    assert.equal(today.statusCode, 200);
    const brief = today.json().brief;
    assert.equal(brief.openActions[0].goalTitle, "Find a new developer job");
    assert.match(brief.goalStatus[0].note, /open action: Send CV/);
    assert.ok(!brief.topPriorities.some((priority: string) => priority.includes("Log progress for Find a new developer job")));
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("daily brief keeps risk-control goals out of normal progress priorities", async () => {
  const server = buildServer();
  const actionUserId = `today-risk-control-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  await prisma.goal.create({
    data: {
      userId: actionUserId,
      title: "Control impulsive betting",
      category: "finance",
      templateId: "finance.control_betting_trading",
      priority: "critical",
      importanceScore: 70
    }
  });
  await prisma.goal.create({
    data: {
      userId: actionUserId,
      title: "Read more",
      category: "learning",
      templateId: "learning.reading_more",
      priority: "low",
      importanceScore: 10
    }
  });

  try {
    const today = await server.inject({
      method: "GET",
      url: `/users/${actionUserId}/today?now=${encodeURIComponent("2026-07-31T02:51:00+02:00")}`
    });
    assert.equal(today.statusCode, 200);
    const brief = today.json().brief;
    assert.ok(!brief.topPriorities.some((priority: string) => priority.includes("Log progress for Control impulsive betting")));
    assert.ok(!brief.suggestedNextStep.includes("Control impulsive betting"));
    assert.ok(brief.risks.some((risk: string) => risk.includes("Control impulsive betting")));
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("/today top priorities contain real open actions only", async () => {
  const server = buildServer();
  const actionUserId = `today-real-priorities-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  const youtubeGoal = await prisma.goal.create({
    data: {
      userId: actionUserId,
      title: "Build a YouTube channel",
      category: "creative",
      priority: "medium",
      importanceScore: 25
    }
  });
  const carGoal = await prisma.goal.create({
    data: {
      userId: actionUserId,
      title: "Find a cheap car to buy",
      category: "custom",
      priority: "low",
      importanceScore: 10
    }
  });
  await prisma.goal.create({
    data: {
      userId: actionUserId,
      title: "Read more",
      category: "learning",
      templateId: "learning.reading_more",
      priority: "low",
      importanceScore: 10
    }
  });
  await prisma.actionItem.createMany({
    data: [
      {
        userId: actionUserId,
        source: "manual",
        title: "Write YouTube script",
        priority: "medium",
        status: "open",
        dueAt: new Date("2026-07-31T14:30:00.000Z"),
        goalId: youtubeGoal.id,
        goalTitleSnapshot: youtubeGoal.title
      },
      {
        userId: actionUserId,
        source: "manual",
        title: "Check cheap car listings",
        priority: "medium",
        status: "open",
        dueAt: new Date("2026-07-31T07:00:00.000Z"),
        goalId: carGoal.id,
        goalTitleSnapshot: carGoal.title
      }
    ]
  });

  try {
    const today = await server.inject({
      method: "GET",
      url: `/users/${actionUserId}/today?now=${encodeURIComponent("2026-07-31T03:01:00+02:00")}`
    });
    assert.equal(today.statusCode, 200);
    const priorities = today.json().brief.topPriorities;
    assert.equal(priorities.length, 2);
    assert.ok(priorities.some((priority: string) => priority.includes("Write YouTube script")));
    assert.ok(priorities.some((priority: string) => priority.includes("Check cheap car listings")));
    assert.ok(!priorities.some((priority: string) => priority.includes("Log progress for Read more")));
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test.before(async () => {
  await prisma.user.create({
    data: { id: userId }
  });
  await prisma.integrationConnection.create({
    data: {
      id: connectionId,
      userId,
      integrationId: "gmail",
      status: "active",
      config: { provider: "gmail" }
    }
  });
  await prisma.emailSignalRule.create({
    data: {
      id: ruleId,
      userId,
      connectionId,
      adapterId: "job_search_email",
      name: "Job search",
      status: "active",
      createdBy: "user"
    }
  });
});

test.after(async () => {
  await prisma.user.deleteMany({ where: { id: userId } });
  await prisma.$disconnect();
});

test("archived review does not block recreation, rejected review still blocks", async () => {
  await createReview({
    subject: "Interview for Frontend Engineer role",
    from: "letis <letis.ether@gmail.com>",
    proposedEventType: "career.interview_scheduled",
    status: "archived",
    extracted: { company: "Test Labs", role: "Frontend Engineer" }
  });

  const archivedMatch = await findGmailSemanticDuplicateReviewItem({
    userId,
    ruleId,
    adapterId: "job_search_email",
    provider: "gmail",
    proposedEventType: "career.interview_scheduled",
    subject: "Interview for Frontend Engineer role",
    from: "letis <letis.ether@gmail.com>",
    company: "Test Labs",
    role: "Frontend Engineer"
  });
  assert.equal(archivedMatch, undefined);

  await createReview({
    subject: "Security code for your application to Blockchain.com",
    from: "Blockchain.com <noreply@blockchain.com>",
    proposedEventType: "application_action_required",
    status: "rejected",
    extracted: { company: "Blockchain.com", actionRequired: true }
  });

  const rejectedMatch = await findGmailSemanticDuplicateReviewItem({
    userId,
    ruleId,
    adapterId: "job_search_email",
    provider: "gmail",
    proposedEventType: "application_action_required",
    subject: "Security code for your application to Blockchain.com",
    from: "Blockchain.com <noreply@blockchain.com>",
    company: "Blockchain.com",
    actionRequired: true
  });
  assert.equal(rejectedMatch?.status, "rejected");
});

test("different interview subject and role do not collide", async () => {
  await createReview({
    subject: "interview ai programmer",
    from: "letis <letis.ether@gmail.com>",
    proposedEventType: "career.interview_scheduled",
    status: "pending",
    extracted: { role: "ai programmer" }
  });

  const testLabsMatch = await findGmailSemanticDuplicateReviewItem({
    userId,
    ruleId,
    adapterId: "job_search_email",
    provider: "gmail",
    proposedEventType: "career.interview_scheduled",
    subject: "Interview for Frontend Engineer role",
    from: "letis <letis.ether@gmail.com>",
    company: "Test Labs",
    role: "Frontend Engineer"
  });
  assert.equal(testLabsMatch, undefined);

  await createReview({
    subject: "Interview for Frontend Engineer role",
    from: "letis <letis.ether@gmail.com>",
    proposedEventType: "career.interview_scheduled",
    status: "pending",
    extracted: { company: "Test Labs", role: "Frontend Engineer" }
  });

  const duplicateTestLabsMatch = await findGmailSemanticDuplicateReviewItem({
    userId,
    ruleId,
    adapterId: "job_search_email",
    provider: "gmail",
    proposedEventType: "career.interview_scheduled",
    subject: "Interview for Frontend Engineer role",
    from: "letis <letis.ether@gmail.com>",
    company: "Test Labs",
    role: "Frontend Engineer"
  });
  assert.equal(duplicateTestLabsMatch?.status, "pending");

  const aiProgrammerMatch = await findGmailSemanticDuplicateReviewItem({
    userId,
    ruleId,
    adapterId: "job_search_email",
    provider: "gmail",
    proposedEventType: "career.interview_scheduled",
    subject: "interview ai programmer",
    from: "letis <letis.ether@gmail.com>",
    role: "ai programmer"
  });
  assert.equal(aiProgrammerMatch?.status, "pending");
});

test("archived Gmail event does not block review creation, active event does", async () => {
  await prisma.event.create({
    data: {
      id: randomUUID(),
      userId,
      type: "career.interview_scheduled",
      timestamp: new Date(),
      source: "gmail",
      provider: "gmail",
      status: "archived",
      archiveReason: "cleanup gmail rule test events",
      confidence: 0.95,
      data: {
        ruleId,
        subject: "Interview for Frontend Engineer role",
        from: "letis <letis.ether@gmail.com>",
        company: "Test Labs",
        role: "Frontend Engineer"
      }
    }
  });

  const archivedEventMatch = await findGmailSemanticDuplicateEvent({
    userId,
    ruleId,
    eventType: "career.interview_scheduled",
    subject: "Interview for Frontend Engineer role",
    from: "letis <letis.ether@gmail.com>",
    company: "Test Labs",
    role: "Frontend Engineer"
  });
  assert.equal(archivedEventMatch, undefined);

  await prisma.event.create({
    data: {
      id: randomUUID(),
      userId,
      type: "career.interview_scheduled",
      timestamp: new Date(),
      source: "gmail",
      provider: "gmail",
      status: "active",
      confidence: 0.95,
      data: {
        ruleId,
        subject: "Interview for Frontend Engineer role",
        from: "letis <letis.ether@gmail.com>",
        company: "Test Labs",
        role: "Frontend Engineer"
      }
    }
  });

  const activeEventMatch = await findGmailSemanticDuplicateEvent({
    userId,
    ruleId,
    eventType: "career.interview_scheduled",
    subject: "Interview for Frontend Engineer role",
    from: "letis <letis.ether@gmail.com>",
    company: "Test Labs",
    role: "Frontend Engineer"
  });
  assert.equal(activeEventMatch?.status, "active");
});

test("Topper account email is ignored and application security code goes to review", () => {
  const topper = classifyJobSearchEmail({
    text: [
      "Subject: Update regarding your Topper account",
      "From: Topper <noreply@mail.topperpay.com>",
      "We are writing about a service disruption affecting your Topper account."
    ].join("\n"),
    classifierMode: "rules"
  });
  assert.equal(topper.decision, "ignore");

  const securityCode = classifyJobSearchEmail({
    text: [
      "Subject: Security code for your application to Blockchain.com",
      "Copy and paste this code into the security code field on your application.",
      "After you enter the code, resubmit your application."
    ].join("\n"),
    classifierMode: "rules"
  });
  assert.equal(securityCode.decision, "needs_review");
  assert.equal(securityCode.reason, "application_action_required");
});

test("work action email is review-worthy, newsletter and security code are ignored", () => {
  const action = classifyWorkActionEmail({
    text: [
      "Subject: Follow up on dashboard review",
      "From: manager@example.com",
      "Can you review the dashboard metrics by Friday and send me any issues you find?"
    ].join("\n"),
    classifierMode: "rules"
  });
  assert.equal(action.decision, "needs_review");
  assert.equal(action.eventType, "work_deadline_detected");
  assert.equal(action.extracted.actionRequired, true);

  for (const text of [
    "Subject: Confirm this login\nFrom: Moonshot Support <noreply@moonshot.com>\nPlease confirm this login attempt.",
    "Subject: We need to confirm your occupation\nFrom: Wise <noreply@wise.com>\nAction required: we need to confirm your occupation.",
    "Subject: We’re updating our Privacy Notices\nFrom: Wise <noreply@wise.com>\nWe are updating our privacy notices.",
    "Subject: Los más vendidos en las rebajas\nFrom: Coach España <marketing@coach.com>\nSale and best sellers.",
    "Subject: Boost your RevPoints balance\nFrom: Revolut <no-reply@revolut.com>\nGet more points and cashback.",
    "Subject: Get up to 100% off Stays with RevPoints\nFrom: Revolut <no-reply@revolut.com>\nPromotion for travel stays.",
    "Subject: Crypto deposit received\nFrom: Revolut <no-reply@revolut.com>\nYour crypto deposit notice.",
    "Subject: AWS re:Invent promo\nFrom: AWS <marketing@amazon.com>\nJoin our webinar and product announcement.",
    "Subject: Product update newsletter\nRead our latest release notes and unsubscribe here.",
    "Subject: Your login code\nUse this security code to sign in."
  ]) {
    const noisy = classifyWorkActionEmail({ text, classifierMode: "rules" });
    assert.equal(noisy.decision, "ignore", text);
  }
});

test("work action semantic key distinguishes project and deadline", async () => {
  await createReview({
    subject: "Follow up on project Atlas",
    from: "manager@example.com",
    proposedEventType: "work_deadline_detected",
    status: "pending",
    extracted: { project: "Atlas", deadline: "Friday", actionRequired: true },
    adapterId: "work_action_email"
  });

  const atlasMatch = await findGmailSemanticDuplicateReviewItem({
    userId,
    ruleId,
    adapterId: "work_action_email",
    provider: "gmail",
    proposedEventType: "work_deadline_detected",
    subject: "Follow up on project Atlas",
    from: "manager@example.com",
    project: "Atlas",
    deadline: "Friday",
    actionRequired: true
  });
  assert.equal(atlasMatch?.status, "pending");

  const otherProjectMatch = await findGmailSemanticDuplicateReviewItem({
    userId,
    ruleId,
    adapterId: "work_action_email",
    provider: "gmail",
    proposedEventType: "work_deadline_detected",
    subject: "Follow up on project Atlas",
    from: "manager@example.com",
    project: "Hermes",
    deadline: "Friday",
    actionRequired: true
  });
  assert.equal(otherProjectMatch, undefined);
});

test("approving work action review creates one ActionItem and no Event", async () => {
  const server = buildServer();
  const reviewId = await createReview({
    subject: "Follow up on dashboard review",
    from: "manager@example.com",
    proposedEventType: "work_deadline_detected",
    status: "pending",
    extracted: { project: "dashboard", deadline: "Friday", actionRequired: true },
    adapterId: "work_action_email",
    evidence: "Can you review the dashboard metrics by Friday and send me any issues you find?"
  });

  try {
    const first = await server.inject({
      method: "POST",
      url: `/users/${userId}/email-reviews/${reviewId}/approve`
    });
    assert.equal(first.statusCode, 200);
    const firstPayload = first.json();
    assert.equal(firstPayload.event, null);
    assert.equal(firstPayload.actionItem.title, "Review dashboard metrics");
    assert.equal(firstPayload.actionItem.status, "open");

    const second = await server.inject({
      method: "POST",
      url: `/users/${userId}/email-reviews/${reviewId}/approve`
    });
    assert.equal(second.statusCode, 200);
    const secondPayload = second.json();
    assert.equal(secondPayload.actionItem.id, firstPayload.actionItem.id);

    const actions = await server.inject({
      method: "GET",
      url: `/users/${userId}/actions`
    });
    assert.equal(actions.statusCode, 200);
    assert.equal(actions.json().actions.some((action: { id: string }) => action.id === firstPayload.actionItem.id), true);
  } finally {
    await server.close();
  }
});

test("work action approval title strips email headers and caps length", async () => {
  const server = buildServer();
  const reviewId = await createReview({
    subject: "Please review dashboard export",
    from: "Letis <letiskate@gmail.com>",
    proposedEventType: "work_action_required",
    status: "pending",
    extracted: { project: "dashboard", actionRequired: true },
    adapterId: "work_action_email",
    evidence: [
      "Subject: Please review dashboard export",
      "From: Letis <letiskate@gmail.com>",
      "Snippet: Can you review the dashboard export by Friday and send me any issues?",
      "Body: Can you review the dashboard export by Friday and send me any issues?"
    ].join("\n")
  });

  try {
    const first = await server.inject({
      method: "POST",
      url: `/users/${userId}/email-reviews/${reviewId}/approve`
    });
    assert.equal(first.statusCode, 200);
    const firstPayload = first.json();
    assert.equal(firstPayload.actionItem.title, "Review dashboard export");
    assert.equal(firstPayload.actionItem.title.includes("From:"), false);
    assert.equal(firstPayload.actionItem.title.includes("Subject:"), false);
    assert.equal(firstPayload.actionItem.title.includes("@"), false);
    assert.ok(firstPayload.actionItem.title.length <= 80);
    assert.equal(firstPayload.actionItem.description, "Send any issues found.");

    const second = await server.inject({
      method: "POST",
      url: `/users/${userId}/email-reviews/${reviewId}/approve`
    });
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().actionItem.id, firstPayload.actionItem.id);
  } finally {
    await server.close();
  }
});

test("work action title prefers body action over follow-up subject", async () => {
  const server = buildServer();
  const reviewId = await createReview({
    subject: "Follow up on dashboard review",
    from: "manager@example.com",
    proposedEventType: "work_deadline_detected",
    status: "pending",
    extracted: { project: "dashboard", deadline: "Friday", actionRequired: true },
    adapterId: "work_action_email",
    evidence: [
      "Subject: Follow up on dashboard review",
      "From: manager@example.com",
      "Body: Can you review the dashboard metrics by Friday and send me any issues you find?"
    ].join("\n")
  });

  try {
    const response = await server.inject({
      method: "POST",
      url: `/users/${userId}/email-reviews/${reviewId}/approve`
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().actionItem.title, "Review dashboard metrics");
  } finally {
    await server.close();
  }
});

test("action item lifecycle routes update status", async () => {
  const server = buildServer();
  const action = await prisma.actionItem.create({
    data: {
      userId,
      source: "manual",
      title: "Review launch checklist",
      priority: "medium"
    }
  });

  try {
    const snooze = await server.inject({
      method: "PATCH",
      url: `/users/${userId}/actions/${action.id}/snooze`,
      payload: { snoozedUntil: "2026-08-01T09:00:00.000Z" }
    });
    assert.equal(snooze.statusCode, 200);
    assert.equal(snooze.json().action.status, "snoozed");

    const complete = await server.inject({
      method: "PATCH",
      url: `/users/${userId}/actions/${action.id}/complete`
    });
    assert.equal(complete.statusCode, 200);
    assert.equal(complete.json().action.status, "completed");

    const archive = await server.inject({
      method: "PATCH",
      url: `/users/${userId}/actions/${action.id}/archive`
    });
    assert.equal(archive.statusCode, 200);
    assert.equal(archive.json().action.status, "archived");
  } finally {
    await server.close();
  }
});

test("completing linked action creates one generic goal progress event", async () => {
  const server = buildServer();
  const actionUserId = `action-complete-linked-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  const goal = await prisma.goal.create({
    data: {
      userId: actionUserId,
      title: "Find a new developer job",
      category: "career",
      templateId: "career.job_search"
    }
  });
  const action = await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Send CV",
      priority: "medium",
      goalId: goal.id,
      goalSlug: "career.job_search",
      goalTitleSnapshot: goal.title
    }
  });

  try {
    const first = await server.inject({
      method: "PATCH",
      url: `/users/${actionUserId}/actions/${action.id}/complete`,
      payload: {}
    });
    assert.equal(first.statusCode, 200);
    assert.match(first.json().message, /Action completed: Send CV/);
    assert.match(first.json().message, /Goal progress logged: Find a new developer job/);

    const second = await server.inject({
      method: "PATCH",
      url: `/users/${actionUserId}/actions/${action.id}/complete`,
      payload: {}
    });
    assert.equal(second.statusCode, 200);
    assert.match(second.json().message, /Action already completed: Send CV/);

    const events = await prisma.event.findMany({
      where: { userId: actionUserId, type: "custom.goal_progress_logged" }
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].source, "manual");
    assert.equal(events[0].provider, "action_completion");
    assert.equal((events[0].data as { source?: string }).source, "action_completion");
    assert.equal((events[0].data as { goalId?: string }).goalId, goal.id);
    assert.equal((events[0].data as { actionItemId?: string }).actionItemId, action.id);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("completing unlinked action creates no goal progress event", async () => {
  const server = buildServer();
  const actionUserId = `action-complete-unlinked-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  const action = await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Buy milk",
      priority: "medium"
    }
  });

  try {
    const response = await server.inject({
      method: "PATCH",
      url: `/users/${actionUserId}/actions/${action.id}/complete`,
      payload: {}
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().message, "Action completed: Buy milk");

    const events = await prisma.event.findMany({
      where: { userId: actionUserId, type: "custom.goal_progress_logged" }
    });
    assert.equal(events.length, 0);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("/today shows completed linked action as goal progress", async () => {
  const server = buildServer();
  const actionUserId = `today-completed-linked-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  const goal = await prisma.goal.create({
    data: {
      userId: actionUserId,
      title: "Build a YouTube channel",
      category: "creative"
    }
  });
  const action = await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Write YouTube script",
      priority: "medium",
      goalId: goal.id,
      goalTitleSnapshot: goal.title
    }
  });

  try {
    const complete = await server.inject({
      method: "PATCH",
      url: `/users/${actionUserId}/actions/${action.id}/complete`,
      payload: {}
    });
    assert.equal(complete.statusCode, 200);

    const today = await server.inject({
      method: "GET",
      url: `/users/${actionUserId}/today`
    });
    assert.equal(today.statusCode, 200);
    const goalStatus = today.json().brief.goalStatus[0];
    assert.equal(goalStatus.status, "progress");
    assert.match(goalStatus.note, /completed action: Write YouTube script/);
    assert.ok(!goalStatus.note.includes("no progress logged today"));
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("completing linked actions does not create fake domain events", async () => {
  const server = buildServer();
  const actionUserId = `action-complete-no-domain-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  const [jobGoal, healthGoal] = await Promise.all([
    prisma.goal.create({
      data: {
        userId: actionUserId,
        title: "Find a new developer job",
        category: "career",
        templateId: "career.job_search"
      }
    }),
    prisma.goal.create({
      data: {
        userId: actionUserId,
        title: "Build strength and energy",
        category: "health",
        templateId: "health.strength_energy"
      }
    })
  ]);
  const [sendCv, trainLegs] = await Promise.all([
    prisma.actionItem.create({
      data: {
        userId: actionUserId,
        source: "manual",
        title: "Send CV",
        priority: "medium",
        goalId: jobGoal.id,
        goalTitleSnapshot: jobGoal.title
      }
    }),
    prisma.actionItem.create({
      data: {
        userId: actionUserId,
        source: "manual",
        title: "Train legs",
        priority: "medium",
        goalId: healthGoal.id,
        goalTitleSnapshot: healthGoal.title
      }
    })
  ]);

  try {
    for (const action of [sendCv, trainLegs]) {
      const response = await server.inject({
        method: "PATCH",
        url: `/users/${actionUserId}/actions/${action.id}/complete`,
        payload: {}
      });
      assert.equal(response.statusCode, 200);
    }

    const [progressEvents, applicationEvents, workoutEvents] = await Promise.all([
      prisma.event.findMany({ where: { userId: actionUserId, type: "custom.goal_progress_logged" } }),
      prisma.event.findMany({ where: { userId: actionUserId, type: "career.application_sent" } }),
      prisma.event.findMany({ where: { userId: actionUserId, type: "health.workout_completed" } })
    ]);
    assert.equal(progressEvents.length, 2);
    assert.equal(applicationEvents.length, 0);
    assert.equal(workoutEvents.length, 0);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("approving core career review still creates Event", async () => {
  const server = buildServer();
  const reviewId = await createReview({
    subject: "Interview for Backend Engineer role",
    from: "recruiter@example.com",
    proposedEventType: "career.interview_scheduled",
    status: "pending",
    extracted: { company: "Example Co", role: "Backend Engineer" },
    evidence: "We would like to schedule an interview next week."
  });

  try {
    const response = await server.inject({
      method: "POST",
      url: `/users/${userId}/email-reviews/${reviewId}/approve`
    });
    assert.equal(response.statusCode, 200);
    const payload = response.json();
    assert.equal(payload.event.type, "career.interview_scheduled");
    assert.equal(payload.actionItem, undefined);
  } finally {
    await server.close();
  }
});

test("unsupported non-core review creates no Event or ActionItem", async () => {
  const server = buildServer();
  const reviewId = await createReview({
    subject: "Application action required",
    from: "jobs@example.com",
    proposedEventType: "application_action_required",
    status: "pending",
    extracted: { company: "Example Co", actionRequired: true },
    evidence: "Complete your application."
  });

  try {
    const response = await server.inject({
      method: "POST",
      url: `/users/${userId}/email-reviews/${reviewId}/approve`
    });
    assert.equal(response.statusCode, 200);
    const payload = response.json();
    assert.equal(payload.event, null);
    assert.match(payload.message, /does not map to an approved event type/);
  } finally {
    await server.close();
  }
});

test("/today returns safe empty brief", async () => {
  const server = buildServer();
  const briefUserId = `brief-empty-${randomUUID()}`;
  await prisma.user.create({ data: { id: briefUserId } });

  try {
    const response = await server.inject({
      method: "GET",
      url: `/users/${briefUserId}/today`
    });
    assert.equal(response.statusCode, 200);
    const payload = response.json();
    assert.equal(payload.brief.openActions.length, 0);
    assert.equal(payload.brief.overdueActions.length, 0);
    assert.equal(payload.brief.suggestedNextStep, "Log one meaningful action.");
    assert.equal(JSON.stringify(payload).includes("accessToken"), false);
    assert.equal(JSON.stringify(payload).includes("refreshToken"), false);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: briefUserId } });
  }
});

test("daily operating loop builds start/end/tomorrow briefs and routes loop replies through multi-intent", async () => {
  const server = buildServer();
  const loopUserId = `daily-loop-${randomUUID()}`;
  const now = "2026-07-31T09:00:00+02:00";
  await prisma.user.create({ data: { id: loopUserId } });
  await prisma.notificationSettings.create({
    data: {
      id: randomUUID(),
      userId: loopUserId,
      dailyLoopEnabled: true,
      timezone: "Europe/Madrid",
      morningTimeMinutes: 540,
      eveningTimeMinutes: 1260
    }
  });
  const jobGoal = await prisma.goal.create({
    data: {
      userId: loopUserId,
      title: "Find a new developer job",
      category: "career",
      templateId: "career.job_search",
      priority: "critical",
      importanceScore: 70
    }
  });
  await prisma.goal.create({
    data: {
      userId: loopUserId,
      title: "Control impulsive betting",
      category: "finance",
      templateId: "finance.control_betting_trading",
      priority: "critical",
      importanceScore: 70
    }
  });
  const homepage = await prisma.actionItem.create({
    data: {
      userId: loopUserId,
      source: "manual",
      title: "Review homepage copy",
      status: "open",
      priority: "medium",
      dueAt: new Date("2026-07-30T07:00:00.000Z"),
      project: "homepage",
      evidence: "review homepage copy"
    }
  });
  await prisma.actionItem.create({
    data: {
      userId: loopUserId,
      source: "manual",
      title: "Write YouTube script",
      status: "open",
      priority: "medium",
      dueAt: new Date("2026-08-01T14:30:00.000Z")
    }
  });
  await prisma.actionItem.create({
    data: {
      userId: loopUserId,
      source: "manual",
      title: "Apply to 2 jobs",
      status: "completed",
      priority: "medium",
      goalId: jobGoal.id,
      goalTitleSnapshot: jobGoal.title,
      completedAt: new Date("2026-07-31T06:00:00.000Z")
    }
  });

  try {
    let response = await server.inject({
      method: "GET",
      url: `/users/${loopUserId}/daily-loop/start-day?now=${encodeURIComponent(now)}&markSent=true`
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().message, /Today - 2026-07-31/);
    assert.match(response.json().message, /First move: Review homepage copy/);
    assert.match(response.json().message, /Overdue: Review homepage copy/);
    assert.match(response.json().message, /Guardrail: Keep Control impulsive betting locked today/);
    const state = await prisma.dailyLoopState.findUniqueOrThrow({
      where: {
        userId_localDate: {
          userId: loopUserId,
          localDate: "2026-07-31"
        }
      }
    });
    assert.equal(state.status, "morning_sent");
    assert.ok(state.morningBriefSentAt);

    response = await server.inject({
      method: "GET",
      url: `/users/${loopUserId}/daily-loop/start-day?now=${encodeURIComponent(now)}&markSent=true`
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().message, /Morning brief already sent today/);

    response = await server.inject({
      method: "GET",
      url: `/users/${loopUserId}/daily-loop/start-day?now=${encodeURIComponent(now)}&markSent=true&force=true`
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().message, /First move: Review homepage copy/);

    response = await server.inject({
      method: "GET",
      url: `/users/${loopUserId}/daily-loop/end-day?now=${encodeURIComponent("2026-07-31T21:00:00+02:00")}&markSent=true`
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().message, /Evening review/);
    assert.match(response.json().message, /Completed action: Apply to 2 jobs/);
    assert.match(response.json().message, /Review homepage copy overdue/);
    assert.match(response.json().message, /move homepage to tomorrow morning/);

    response = await server.inject({
      method: "GET",
      url: `/users/${loopUserId}/daily-loop/end-day?now=${encodeURIComponent("2026-07-31T21:00:00+02:00")}&markSent=true`
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().message, /Evening review already sent today/);

    response = await server.inject({
      method: "GET",
      url: `/users/${loopUserId}/daily-loop/end-day?now=${encodeURIComponent("2026-07-31T21:00:00+02:00")}&markSent=true&force=true`
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().message, /Review homepage copy overdue/);

    response = await server.inject({
      method: "GET",
      url: `/users/${loopUserId}/daily-loop/tomorrow?now=${encodeURIComponent(now)}`
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().message, /Tomorrow - 2026-08-01/);
    assert.match(response.json().message, /Write YouTube script/);
    assert.doesNotMatch(response.json().message, /Control impulsive betting.*Log progress/i);

    response = await server.inject({
      method: "POST",
      url: `/users/${loopUserId}/conversation/multi-intent`,
      payload: {
        text: "trained 30 min, move homepage copy to tomorrow morning",
        now
      }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Logged 30 min training/);
    assert.match(response.json().reply, /Action rescheduled: Review homepage copy/);
    assert.equal(await prisma.event.count({ where: { userId: loopUserId, type: "health.workout_completed" } }), 1);
    const updatedHomepage = await prisma.actionItem.findUniqueOrThrow({ where: { id: homepage.id } });
    assert.ok(updatedHomepage.dueAt);
    assert.equal(localDate(updatedHomepage.dueAt), "2026-08-01");
    assert.equal(localMinutes(updatedHomepage.dueAt), 540);
    assert.equal(await prisma.actionItem.count({ where: { userId: loopUserId, title: "Review homepage copy" } }), 1);

    response = await server.inject({
      method: "PATCH",
      url: `/users/${loopUserId}/notification-settings`,
      payload: {
        dailyLoopEnabled: false,
        morningTimeMinutes: 600,
        eveningTimeMinutes: 1320
      }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().notificationSettings.dailyLoopEnabled, false);
    assert.equal(response.json().notificationSettings.morningTimeMinutes, 600);
    assert.equal(response.json().notificationSettings.eveningTimeMinutes, 1320);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: loopUserId } });
  }
});

test("daily operating loop filters start-day today actions by local due date", async () => {
  const server = buildServer();
  const loopUserId = `daily-loop-local-due-${randomUUID()}`;
  const now = "2026-08-04T14:43:00+02:00";
  await prisma.user.create({ data: { id: loopUserId } });
  await prisma.notificationSettings.create({
    data: {
      userId: loopUserId,
      timezone: "Europe/Madrid",
      telegramUserId: "12345",
      dailyLoopEnabled: true
    }
  });
  await prisma.actionItem.createMany({
    data: [
      {
        userId: loopUserId,
        source: "manual",
        title: "Overdue launch notes",
        status: "open",
        priority: "medium",
        dueAt: new Date("2026-08-01T14:30:00.000Z")
      },
      {
        userId: loopUserId,
        source: "manual",
        title: "Call supplier",
        status: "open",
        priority: "medium",
        dueAt: new Date("2026-08-04T16:00:00.000Z")
      },
      {
        userId: loopUserId,
        source: "manual",
        title: "Review homepage",
        status: "open",
        priority: "medium",
        dueAt: new Date("2026-08-05T07:00:00.000Z")
      }
    ]
  });

  try {
    let response = await server.inject({
      method: "GET",
      url: `/users/${loopUserId}/daily-loop/start-day?now=${encodeURIComponent(now)}`
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().message, /Today - 2026-08-04/);
    assert.match(response.json().message, /Overdue: Overdue launch notes/);
    assert.match(response.json().message, /Also today: Call supplier/);
    assert.doesNotMatch(response.json().message, /Also today: .*Review homepage/);
    assert.equal((response.json().message.match(/Overdue launch notes/g) ?? []).length, 2);

    response = await server.inject({
      method: "GET",
      url: `/users/${loopUserId}/daily-loop/tomorrow?now=${encodeURIComponent(now)}`
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().message, /Tomorrow - 2026-08-05/);
    assert.match(response.json().message, /Review homepage/);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: loopUserId } });
  }
});

test("/today shows open, completed, overdue action items and picks overdue first", async () => {
  const server = buildServer();
  const briefUserId = `brief-actions-${randomUUID()}`;
  await prisma.user.create({ data: { id: briefUserId } });

  const overdue = await prisma.actionItem.create({
    data: {
      userId: briefUserId,
      source: "manual",
      title: "Send dashboard issues",
      priority: "high",
      dueAt: new Date(Date.now() - 60 * 60 * 1000)
    }
  });
  await prisma.actionItem.create({
    data: {
      userId: briefUserId,
      source: "manual",
      title: "Review product notes",
      priority: "medium"
    }
  });
  await prisma.actionItem.create({
    data: {
      userId: briefUserId,
      source: "manual",
      title: "Finished earlier task",
      status: "completed",
      priority: "medium",
      completedAt: new Date()
    }
  });

  try {
    const response = await server.inject({
      method: "GET",
      url: `/users/${briefUserId}/today`
    });
    assert.equal(response.statusCode, 200);
    const brief = response.json().brief;
    assert.equal(brief.overdueActions[0].id, overdue.id);
    assert.match(brief.topPriorities[0], /Overdue: Send dashboard issues/);
    assert.equal(brief.recentWins.includes("Completed action: Finished earlier task"), true);
    assert.equal(brief.suggestedNextStep, "Handle overdue action: Send dashboard issues.");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: briefUserId } });
  }
});

test("/today shows goal progress and betting cooldown risk", async () => {
  const server = buildServer();
  const briefUserId = `brief-events-${randomUUID()}`;
  await prisma.user.create({ data: { id: briefUserId } });
  await prisma.goal.create({
    data: {
      userId: briefUserId,
      title: "Find a new job",
      category: "career",
      templateId: "career.job_search"
    }
  });
  await prisma.goal.create({
    data: {
      userId: briefUserId,
      title: "Control impulsive betting",
      category: "finance",
      templateId: "finance.control_betting_trading"
    }
  });
  await prisma.event.create({
    data: {
      userId: briefUserId,
      type: "career.application_sent",
      timestamp: new Date(),
      source: "manual",
      data: { count: 1 },
      confidence: 0.9
    }
  });
  await prisma.event.create({
    data: {
      userId: briefUserId,
      type: "finance.betting.cooldown_triggered",
      timestamp: new Date(),
      source: "manual",
      data: { reason: "red_risk_state" },
      confidence: 1
    }
  });

  try {
    const response = await server.inject({
      method: "GET",
      url: `/users/${briefUserId}/today`
    });
    assert.equal(response.statusCode, 200);
    const brief = response.json().brief;
    const jobStatus = brief.goalStatus.find((status: { title: string }) => status.title === "Find a new job");
    const riskStatus = brief.goalStatus.find((status: { title: string }) => status.title === "Control impulsive betting");
    assert.equal(jobStatus?.note, "1 application sent today");
    assert.equal(riskStatus?.note, "guardrail triggered today, no betting actions created");
    assert.equal(brief.risks.some((risk: string) => risk.includes("Betting impulse detected recently")), true);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: briefUserId } });
  }
});

test("manual action API creates titled action with due parsing", async () => {
  const server = buildServer();
  const actionUserId = `action-api-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });

  try {
    const response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/actions/manual`,
      payload: { text: "review homepage copy tomorrow" }
    });
    assert.equal(response.statusCode, 200);
    const payload = response.json();
    assert.equal(payload.action.title, "Review homepage copy");
    assert.equal(payload.extraction.dueText, "tomorrow");
    assert.ok(payload.action.dueAt);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("natural action due parser supports day parts and explicit times", () => {
  const now = new Date("2026-07-30T01:00:00");
  const preferences = {
    timezone: "Europe/Madrid",
    defaultActionTimeMinutes: 540,
    morningTimeMinutes: 510,
    afternoonTimeMinutes: 900,
    eveningTimeMinutes: 1140,
    tonightTimeMinutes: 1260
  };

  assert.equal(localMinutes(parseActionDueDate("call Alex tomorrow", { now, preferences }).dueAt), 540);
  assert.equal(localMinutes(parseActionDueDate("call Alex tomorrow afternoon", { now, preferences }).dueAt), 900);
  assert.equal(localMinutes(parseActionDueDate("call Alex tomorrow evening", { now, preferences }).dueAt), 1140);
  assert.equal(localMinutes(parseActionDueDate("send CV tonight", { now, preferences }).dueAt), 1260);
  assert.equal(localMinutes(parseActionDueDate("review homepage tomorrow at 6pm", { now, preferences }).dueAt), 1080);
  assert.equal(localMinutes(parseActionDueDate("pay rent Friday morning", { now, preferences }).dueAt), 510);
  assert.equal(localMinutes(parseActionDueDate("follow up in 2 days", { now, preferences }).dueAt), 540);
});

test("natural action due parser avoids vague past times and rejects explicit past", () => {
  const now = new Date("2026-07-30T11:00:00+02:00");
  const lateNow = new Date("2026-07-30T22:00:00+02:00");
  const preferences = {
    timezone: "Europe/Madrid",
    defaultActionTimeMinutes: 540,
    morningTimeMinutes: 540,
    afternoonTimeMinutes: 900,
    eveningTimeMinutes: 1140,
    tonightTimeMinutes: 1200
  };

  const today = parseActionDueDate("call Alex today", { now, preferences });
  assert.ok(today.dueAt && today.dueAt > now);
  assert.equal(minutesBetween(now, today.dueAt), 15);

  const todayMorning = parseActionDueDate("call Alex today morning", { now, preferences });
  assert.ok(todayMorning.dueAt && todayMorning.dueAt > now);
  assert.equal(minutesBetween(now, todayMorning.dueAt), 15);

  const thisMorning = parseActionDueDate("call Alex this morning", { now, preferences });
  assert.ok(thisMorning.dueAt && thisMorning.dueAt > now);
  assert.equal(minutesBetween(now, thisMorning.dueAt), 15);

  const todayAfternoon = parseActionDueDate("call Alex today afternoon", { now, preferences });
  assert.ok(todayAfternoon.dueAt && todayAfternoon.dueAt > now);
  assert.equal(localMinutes(todayAfternoon.dueAt), 900);

  const tonight = parseActionDueDate("call Alex tonight", { now, preferences });
  assert.ok(tonight.dueAt && tonight.dueAt > now);
  assert.equal(localMinutes(tonight.dueAt), 1200);

  const lateTonight = parseActionDueDate("call Alex tonight", { now: lateNow, preferences });
  assert.ok(lateTonight.dueAt && lateTonight.dueAt > lateNow);
  assert.equal(localMinutes(lateTonight.dueAt), 1200);
  assert.equal(localDate(lateTonight.dueAt), "2026-07-31");

  const explicitPast = parseActionDueDate("call Alex today at 9am", { now, preferences });
  assert.equal(explicitPast.dueAt, null);
  assert.equal(explicitPast.invalidReason, "past_explicit_time");

  const dmyExplicitPast = parseActionDueDate("call Alex 30/07/2026 at 09:00", { now, preferences });
  assert.equal(dmyExplicitPast.dueAt, null);
  assert.equal(dmyExplicitPast.invalidReason, "past_explicit_time");

  const ymdExplicitPast = parseActionDueDate("call Alex 2026-07-30 09:00", { now, preferences });
  assert.equal(ymdExplicitPast.dueAt, null);
  assert.equal(ymdExplicitPast.invalidReason, "past_explicit_time");

  const nowDue = parseActionDueDate("call Alex now", { now, preferences });
  assert.ok(nowDue.dueAt && nowDue.dueAt.getTime() === now.getTime());

  const atNowDue = parseActionDueDate("call Alex at now", { now, preferences });
  assert.ok(atNowDue.dueAt && atNowDue.dueAt.getTime() === now.getTime());
});

test("manual action uses reminder preferences and strips natural time from title", async () => {
  const server = buildServer();
  const actionUserId = `action-prefs-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  await prisma.notificationSettings.create({
    data: {
      userId: actionUserId,
      defaultActionTimeMinutes: 600,
      afternoonTimeMinutes: 960,
      timezone: "Europe/Madrid"
    }
  });

  try {
    const response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/actions/manual`,
      payload: { text: "review homepage tomorrow afternoon" }
    });
    assert.equal(response.statusCode, 200);
    const payload = response.json();
    assert.equal(payload.action.title, "Review homepage");
    assert.equal(payload.extraction.dueText, "tomorrow afternoon");
    assert.equal(localMinutes(new Date(payload.action.dueAt)), 960);
    assert.doesNotMatch(payload.message, /T\d{2}:\d{2}:\d{2}/);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("notification settings accept valid reminder time minutes and reject invalid values", async () => {
  const server = buildServer();
  const actionUserId = `action-settings-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });

  try {
    const valid = await server.inject({
      method: "PATCH",
      url: `/users/${actionUserId}/notification-settings`,
      payload: { morningTimeMinutes: 480 }
    });
    assert.equal(valid.statusCode, 200);
    assert.equal(valid.json().notificationSettings.morningTimeMinutes, 480);

    const invalid = await server.inject({
      method: "PATCH",
      url: `/users/${actionUserId}/notification-settings`,
      payload: { morningTimeMinutes: 1500 }
    });
    assert.equal(invalid.statusCode, 400);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("manual action route rejects explicit past time and accepts now", async () => {
  const server = buildServer();
  const actionUserId = `action-past-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });

  try {
    const past = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/actions/manual`,
      payload: { text: `review homepage ${yesterdayLocalDate()} at 09:00` }
    });
    assert.equal(past.statusCode, 400);
    assert.equal(past.json().error, "That time has already passed. Use a future time, or say 'now'.");

    const nowAction = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/actions/manual`,
      payload: { text: "test at now" }
    });
    assert.equal(nowAction.statusCode, 200);
    assert.equal(nowAction.json().action.title, "Test");
    assert.ok(new Date(nowAction.json().action.dueAt) > new Date(Date.now() - 60_000));
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("standalone now gets neutral scheduling prompt", async () => {
  const server = buildServer();
  const actionUserId = `action-now-standalone-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });

  try {
    const response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: actionUserId, message: "now" }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().reply, "What should I schedule now? Example: /action call Alex now");

    const actions = await prisma.actionItem.findMany({ where: { userId: actionUserId } });
    assert.equal(actions.length, 0);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("snooze route avoids vague past times and rejects explicit past time", async () => {
  const server = buildServer();
  const actionUserId = `action-snooze-past-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  await prisma.notificationSettings.create({
    data: {
      userId: actionUserId,
      morningTimeMinutes: 1,
      timezone: "Europe/Madrid"
    }
  });
  const action = await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Call Alex",
      priority: "medium"
    }
  });

  try {
    const vaguePast = await server.inject({
      method: "PATCH",
      url: `/users/${actionUserId}/actions/${action.id}/snooze`,
      payload: { snoozeText: "today morning" }
    });
    assert.equal(vaguePast.statusCode, 200);
    assert.ok(new Date(vaguePast.json().action.snoozedUntil) > new Date());

    const explicitPast = await server.inject({
      method: "PATCH",
      url: `/users/${actionUserId}/actions/${action.id}/snooze`,
      payload: { snoozeText: `${yesterdayLocalDate()} at 09:00` }
    });
    assert.equal(explicitPast.statusCode, 400);
    assert.equal(explicitPast.json().error, "That snooze time has already passed.");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("snooze route accepts now and makes action remindable", async () => {
  const server = buildServer();
  const actionUserId = `action-snooze-now-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  const action = await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Call Alex",
      priority: "medium"
    }
  });

  try {
    const snoozed = await server.inject({
      method: "PATCH",
      url: `/users/${actionUserId}/actions/${action.id}/snooze`,
      payload: { snoozeText: "now" }
    });
    assert.equal(snoozed.statusCode, 200);

    const reminder = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/actions/reminders/trigger`
    });
    assert.equal(reminder.statusCode, 200);
    assert.equal(reminder.json().sent, 1);
    assert.match(reminder.json().message, /Snoozed action is back:/);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("todo text creates action and strips tonight from title", async () => {
  const server = buildServer();
  const actionUserId = `action-todo-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });

  try {
    const response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/actions/manual`,
      payload: { text: "todo: apply to 2 jobs tonight" }
    });
    assert.equal(response.statusCode, 200);
    const payload = response.json();
    assert.equal(payload.action.title, "Apply to 2 jobs");
    assert.equal(payload.extraction.dueText, "tonight");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("natural concrete action message creates ActionItem", async () => {
  const server = buildServer();
  const actionUserId = `action-natural-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });

  try {
    const response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: actionUserId, message: "I need to review homepage copy tomorrow" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Action created/);

    const actions = await prisma.actionItem.findMany({ where: { userId: actionUserId } });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, "Review homepage copy");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("unrelated natural action message creates unlinked ActionItem", async () => {
  const server = buildServer();
  const actionUserId = `action-natural-unlinked-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  await prisma.goal.create({
    data: {
      userId: actionUserId,
      title: "Find a new developer job",
      category: "career",
      templateId: "career.job_search"
    }
  });

  try {
    const response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: actionUserId, message: "I need to buy milk tomorrow" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Action created/);

    const actions = await prisma.actionItem.findMany({ where: { userId: actionUserId } });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, "Buy milk");
    assert.equal(actions[0].goalId, null);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("manual action command and natural text with article dedupe to one open action", async () => {
  const server = buildServer();
  const actionUserId = `action-article-dedupe-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });

  try {
    const command = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/actions/manual`,
      payload: { text: "review homepage copy tomorrow" }
    });
    assert.equal(command.statusCode, 200);
    assert.equal(command.json().action.title, "Review homepage copy");

    const natural = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: actionUserId, message: "I need to review the homepage copy tomorrow" }
    });
    assert.equal(natural.statusCode, 200);
    assert.match(natural.json().reply, /Action already exists: Review homepage copy/);

    const actions = await prisma.actionItem.findMany({
      where: { userId: actionUserId, status: { in: ["open", "snoozed"] } }
    });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, "Review homepage copy");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("manual action title key treats optional articles as same task", () => {
  assert.equal(normalizeManualActionTitleKey("Review homepage copy"), normalizeManualActionTitleKey("Review the homepage copy"));
});

test("same manual task dedupes by local due date and time", async () => {
  const server = buildServer();
  const actionUserId = `action-day-dedupe-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Review homepage copy",
      priority: "medium",
      dueAt: new Date("2026-08-03T07:00:00.000Z")
    }
  });

  try {
    const response = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/actions/manual`,
      payload: {
        text: "I need to review the homepage copy 2026-08-03",
        now: "2026-07-30T11:00:00+02:00"
      }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().duplicate, true);

    const actions = await prisma.actionItem.findMany({ where: { userId: actionUserId } });
    assert.equal(actions.length, 1);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("same manual task does not dedupe across different due time buckets", async () => {
  const server = buildServer();
  const actionUserId = `action-time-dedupe-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });

  try {
    const morning = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/actions/manual`,
      payload: { text: "call Alex tomorrow morning" }
    });
    assert.equal(morning.statusCode, 200);

    const evening = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/actions/manual`,
      payload: { text: "call Alex tomorrow evening" }
    });
    assert.equal(evening.statusCode, 200);
    assert.equal(evening.json().duplicate, false);

    const actions = await prisma.actionItem.findMany({ where: { userId: actionUserId } });
    assert.equal(actions.length, 2);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("/today does not duplicate due-soon action in top priorities", async () => {
  const server = buildServer();
  const actionUserId = `today-priority-dedupe-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Review homepage copy",
      priority: "medium",
      dueAt: new Date(Date.now() + 60 * 60 * 1000)
    }
  });

  try {
    const response = await server.inject({
      method: "GET",
      url: `/users/${actionUserId}/today`
    });
    assert.equal(response.statusCode, 200);
    const priorities = response.json().brief.topPriorities as string[];
    assert.equal(priorities.filter((priority) => priority.includes("Review homepage copy")).length, 1);
    assert.equal(priorities[0], "Due soon: Review homepage copy");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("daily priority scorer ranks goal-linked action above unlinked chore with same due window", () => {
  const now = new Date(2026, 6, 30, 4, 30);
  const dueAt = new Date(2026, 6, 31, 9, 0);
  const goal = {
    id: "goal-job",
    userId: "score-user",
    title: "Find a new developer job",
    category: "career",
    status: "active" as const,
    templateId: "career.job_search",
    createdAt: now,
    updatedAt: now
  };
  const ranked = sortDailyActionsByPriority(
    [
      {
        id: "milk",
        userId: "score-user",
        source: "manual",
        title: "Buy milk",
        status: "open",
        priority: "medium",
        dueAt,
        createdAt: now,
        updatedAt: now
      },
      {
        id: "jobs",
        userId: "score-user",
        source: "manual",
        title: "Apply to 2 jobs",
        status: "open",
        priority: "medium",
        dueAt,
        goalId: goal.id,
        goalTitleSnapshot: goal.title,
        createdAt: now,
        updatedAt: now
      }
    ],
    {
      goals: [goal],
      goalStatuses: [{ goalId: goal.id, hasProgressToday: false, hasCompletedActionToday: false, hasOpenAction: true }],
      recentEvents: [],
      now
    }
  );

  assert.equal(ranked[0].action.id, "jobs");
  assert.ok(ranked[0].score.score > ranked[1].score.score);
  assert.match(ranked[0].score.rankReason, /goal-linked/);
});

test("daily priority scorer keeps true urgency and manual high priority", () => {
  const now = new Date(2026, 6, 30, 4, 30);
  const goal = {
    id: "goal-job",
    userId: "score-user",
    title: "Find a new developer job",
    category: "career",
    status: "active" as const,
    templateId: "career.job_search",
    createdAt: now,
    updatedAt: now
  };
  const overdueChore = {
    id: "milk",
    userId: "score-user",
    source: "manual" as const,
    title: "Buy milk",
    status: "open" as const,
    priority: "medium" as const,
    dueAt: new Date(2026, 6, 29, 9, 0),
    createdAt: now,
    updatedAt: now
  };
  const tomorrowGoalAction = {
    id: "jobs",
    userId: "score-user",
    source: "manual" as const,
    title: "Apply to 2 jobs",
    status: "open" as const,
    priority: "medium" as const,
    dueAt: new Date(2026, 6, 31, 9, 0),
    goalId: goal.id,
    goalTitleSnapshot: goal.title,
    createdAt: now,
    updatedAt: now
  };
  const highPriorityChore = {
    ...overdueChore,
    id: "urgent-admin",
    title: "Pay rent",
    priority: "high" as const,
    dueAt: new Date(2026, 6, 31, 9, 0)
  };

  const overdueRanked = sortDailyActionsByPriority([tomorrowGoalAction, overdueChore], {
    goals: [goal],
    goalStatuses: [{ goalId: goal.id, hasProgressToday: false, hasCompletedActionToday: false, hasOpenAction: true }],
    recentEvents: [],
    now
  });
  assert.equal(overdueRanked[0].action.id, "milk");

  const lowGoal = {
    ...goal,
    id: "goal-low",
    title: "Find a cheap car to buy",
    category: "custom",
    templateId: undefined,
    priority: "low" as const,
    importanceScore: 10
  };
  const lowGoalAction = {
    ...tomorrowGoalAction,
    id: "car",
    title: "Check cheap car listings",
    goalId: lowGoal.id,
    goalTitleSnapshot: lowGoal.title
  };
  const highPriorityRanked = sortDailyActionsByPriority([lowGoalAction, highPriorityChore], {
    goals: [lowGoal],
    goalStatuses: [{ goalId: lowGoal.id, hasProgressToday: false, hasCompletedActionToday: false, hasOpenAction: true }],
    recentEvents: [],
    now
  });
  assert.equal(highPriorityRanked[0].action.id, "urgent-admin");
});

test("daily priority scorer reduces job-search boost after progress and ignores completed actions", () => {
  const now = new Date(2026, 6, 30, 4, 30);
  const dueAt = new Date(2026, 6, 31, 9, 0);
  const goal = {
    id: "goal-job",
    userId: "score-user",
    title: "Find a new developer job",
    category: "career",
    status: "active" as const,
    templateId: "career.job_search",
    createdAt: now,
    updatedAt: now
  };
  const openAction = {
    id: "jobs",
    userId: "score-user",
    source: "manual" as const,
    title: "Apply to 2 jobs",
    status: "open" as const,
    priority: "medium" as const,
    dueAt,
    goalId: goal.id,
    goalTitleSnapshot: goal.title,
    createdAt: now,
    updatedAt: now
  };
  const completedAction = {
    ...openAction,
    id: "completed-jobs",
    title: "Send CV",
    status: "completed" as const,
    completedAt: now
  };

  const noProgressScore = sortDailyActionsByPriority([openAction], {
    goals: [goal],
    goalStatuses: [{ goalId: goal.id, hasProgressToday: false, hasCompletedActionToday: false, hasOpenAction: true }],
    recentEvents: [],
    now
  })[0].score.score;
  const withProgressScore = sortDailyActionsByPriority([openAction], {
    goals: [goal],
    goalStatuses: [{ goalId: goal.id, hasProgressToday: true, hasCompletedActionToday: true, hasOpenAction: true }],
    recentEvents: [],
    now
  })[0].score.score;

  assert.ok(noProgressScore > withProgressScore);
  assert.equal(
    sortDailyActionsByPriority([completedAction], {
      goals: [goal],
      goalStatuses: [{ goalId: goal.id, hasProgressToday: true, hasCompletedActionToday: true, hasOpenAction: false }],
      recentEvents: [],
      now
    })[0].score.score,
    -1000
  );
});

test("/today ranks goal-linked priorities above same-window chores and exposes debug scores", async () => {
  const server = buildServer();
  const actionUserId = `today-scored-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  const jobGoal = await prisma.goal.create({
    data: {
      userId: actionUserId,
      title: "Find a new developer job",
      category: "career",
      templateId: "career.job_search"
    }
  });
  const dueAt = new Date(Date.now() + 60 * 60 * 1000);
  await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Buy milk",
      priority: "medium",
      dueAt
    }
  });
  await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Apply to 2 jobs",
      priority: "medium",
      dueAt,
      goalId: jobGoal.id,
      goalTitleSnapshot: jobGoal.title
    }
  });
  await prisma.event.create({
    data: {
      userId: actionUserId,
      type: "finance.betting.cooldown_triggered",
      timestamp: new Date(),
      source: "manual",
      data: {},
      confidence: 1
    }
  });

  try {
    const response = await server.inject({
      method: "GET",
      url: `/users/${actionUserId}/today`
    });
    assert.equal(response.statusCode, 200);
    const brief = response.json().brief;
    assert.equal(brief.openActions[0].title, "Apply to 2 jobs");
    assert.match(brief.topPriorities[0], /Apply to 2 jobs/);
    assert.equal(brief.suggestedNextStep, "Next upcoming action: Apply to 2 jobs.");
    assert.ok(brief.risks.some((risk: string) => risk.includes("Betting impulse detected")));

    const debug = await server.inject({
      method: "GET",
      url: `/users/${actionUserId}/today/debug-priorities`
    });
    assert.equal(debug.statusCode, 200);
    const priorities = debug.json().priorities;
    assert.equal(priorities[0].title, "Apply to 2 jobs");
    assert.match(priorities[0].rankReason, /goal-linked/);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("/today uses user timezone for local day and due-window priority reasons", async () => {
  const server = buildServer();
  const actionUserId = `today-timezone-${randomUUID()}`;
  const now = new Date("2026-07-30T23:40:00.000Z");
  await prisma.user.create({ data: { id: actionUserId } });
  await prisma.notificationSettings.create({
    data: {
      userId: actionUserId,
      timezone: "Europe/Madrid"
    }
  });
  const jobGoal = await prisma.goal.create({
    data: {
      userId: actionUserId,
      title: "Find a new developer job",
      category: "career",
      templateId: "career.job_search",
      priority: "critical",
      importanceScore: 70
    }
  });
  await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Apply to 2 jobs",
      priority: "medium",
      dueAt: new Date("2026-07-31T07:00:00.000Z"),
      goalId: jobGoal.id,
      goalTitleSnapshot: jobGoal.title
    }
  });
  await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Write YouTube script",
      priority: "medium",
      dueAt: new Date("2026-07-31T14:30:00.000Z")
    }
  });
  await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Send CV",
      status: "completed",
      priority: "medium",
      completedAt: new Date("2026-07-30T23:20:00.000Z"),
      goalId: jobGoal.id,
      goalTitleSnapshot: jobGoal.title
    }
  });
  await prisma.event.createMany({
    data: [
      {
        userId: actionUserId,
        type: "career.application_sent",
        timestamp: new Date("2026-07-30T23:30:00.000Z"),
        source: "manual",
        data: { count: 1 },
        confidence: 1
      },
      {
        userId: actionUserId,
        type: "health.workout_completed",
        timestamp: new Date("2026-07-30T21:30:00.000Z"),
        source: "manual",
        data: { duration_minutes: 30 },
        confidence: 1
      }
    ]
  });

  try {
    const range = getLocalTodayRange(now, "Europe/Madrid");
    assert.equal(range.date, "2026-07-31");
    assert.equal(range.start.toISOString(), "2026-07-30T22:00:00.000Z");
    assert.equal(range.end.toISOString(), "2026-07-31T22:00:00.000Z");
    assert.equal(classifyDueWindow(new Date("2026-07-31T07:00:00.000Z"), now, "Europe/Madrid"), "due today morning");
    assert.equal(classifyDueWindow(new Date("2026-07-31T14:30:00.000Z"), now, "Europe/Madrid"), "due today afternoon");

    const response = await server.inject({
      method: "GET",
      url: `/users/${actionUserId}/today?now=${encodeURIComponent(now.toISOString())}`
    });
    assert.equal(response.statusCode, 200);
    const brief = response.json().brief;
    assert.equal(brief.date, "2026-07-31");
    assert.match(brief.summary, /1 event logged today/);
    assert.equal(brief.coach.nextMove, brief.suggestedNextStep);
    assert.match(brief.coach.diagnosis, /Apply to 2 jobs/);
    assert.ok(brief.goalStatus.some((goal: { title: string; note: string }) => goal.title === "Find a new developer job" && goal.note.includes("1 application sent today")));
    assert.ok(brief.goalStatus.some((goal: { title: string; note: string }) => goal.title === "Find a new developer job" && goal.note.includes("completed action: Send CV")));
    assert.ok(brief.recentWins.some((win: string) => win.includes("Completed action: Send CV")));
    assert.ok(!brief.recentWins.some((win: string) => win.includes("Training logged")));

    const debug = await server.inject({
      method: "GET",
      url: `/users/${actionUserId}/today/debug-priorities?now=${encodeURIComponent(now.toISOString())}`
    });
    assert.equal(debug.statusCode, 200);
    const reasons = debug.json().priorities.map((priority: { rankReason: string }) => priority.rankReason).join("\n");
    assert.match(reasons, /due today morning/);
    assert.match(reasons, /due today afternoon/);
    assert.doesNotMatch(reasons, /due tomorrow/);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("daily coach fallback and validation stay locked to verified brief context", () => {
  const context = {
    date: "2026-07-31",
    timezone: "Europe/Madrid",
    activeGoals: [
      {
        id: "goal-job",
        title: "Find a new developer job",
        priority: "critical" as const,
        importanceScore: 70,
        statusToday: "no progress logged today",
        openLinkedActions: ["Apply to 2 jobs"],
        completedLinkedActionsToday: [],
        guardrailActivityToday: []
      }
    ],
    scoredPriorities: [
      {
        actionId: "action-job",
        title: "Apply to 2 jobs",
        dueAt: "2026-07-31T07:00:00.000Z",
        dueLabel: "due today morning",
        score: 125,
        rankReason: "due today morning, goal-linked, critical goal",
        linkedGoalTitle: "Find a new developer job",
        linkedGoalPriority: "critical" as const
      }
    ],
    recentWins: [],
    risksOrWatchouts: ["Betting impulse detected recently. Do not open a bet today without cooldown."],
    nextMove: "Handle due action: Apply to 2 jobs.",
    userOperatingProfile: {
      directness: 5,
      warmth: 3,
      confrontation: 5,
      verbosity: 3,
      preferredStyle: "tough_love"
    }
  };

  const fallback = buildDeterministicDailyCoachResponse(context);
  assert.equal(fallback.nextMove, context.nextMove);
  assert.match(fallback.diagnosis, /Apply to 2 jobs/);
  assert.equal(fallback.warning, "Keep the betting/trading guardrail locked today.");

  const valid = validateDailyCoachResponseAgainstContext(
    {
      diagnosis: "Apply to 2 jobs is the first move because it supports Find a new developer job today with a clear, bounded action and no extra tracks. Keep the output factual, then stop adding complexity.",
      nextMove: "Apply to 2 jobs first.",
      warning: "Keep the betting/trading guardrail locked today.",
      encouragement: null
    },
    context
  );
  assert.equal(valid.nextMove, "Apply to 2 jobs first.");
  assert.ok(JSON.stringify(valid).length > 270);

  assert.throws(
    () =>
      validateDailyCoachResponseAgainstContext(
        {
          diagnosis: "You've completed two job applications recently.",
          nextMove: "Apply to 2 jobs first.",
          warning: null,
          encouragement: null
        },
        {
          ...context,
          recentWins: ["Completed action: Apply to 2 jobs"],
          activeGoals: context.activeGoals.map((goal) => ({
            ...goal,
            statusToday: "completed action: Apply to 2 jobs",
            completedLinkedActionsToday: ["Apply to 2 jobs"]
          }))
        }
      ),
    /Daily coach response failed validation/
  );

  assert.equal(
    validateDailyCoachResponseAgainstContext(
      {
        diagnosis: "Two applications were sent today.",
        nextMove: "Apply to 2 jobs first.",
        warning: null,
        encouragement: null
      },
      {
        ...context,
        recentWins: ["2 applications sent"],
        activeGoals: context.activeGoals.map((goal) => ({ ...goal, statusToday: "2 applications sent today" }))
      }
    ).diagnosis,
    "Two applications were sent today."
  );

  assert.equal(deterministicDailyCoachWarning(context), "Keep the betting/trading guardrail locked today.");

  assert.equal(
    validateDailyCoachResponseAgainstContext(
      {
        diagnosis: "Apply to 2 jobs is the first move.",
        nextMove: "Apply to 2 jobs first.",
        warning: "Do not bet today.",
        encouragement: null
      },
      context
    ).warning,
    "Do not bet today."
  );

  assert.throws(() =>
    validateDailyCoachResponseAgainstContext(
      {
        diagnosis: "Call investor first.",
        nextMove: "Handle due action: Apply to 2 jobs.",
        warning: null,
        encouragement: null
      },
      context
    )
  );

  assert.throws(() =>
    validateDailyCoachResponseAgainstContext(
      {
        diagnosis: "The day is clear.",
        nextMove: "Write YouTube script.",
        warning: null,
        encouragement: null
      },
      context
    )
  );

  assert.throws(() =>
    validateDailyCoachResponseAgainstContext(
      {
        diagnosis: "The day is clear.",
        nextMove: "Handle due action: Apply to 2 jobs.",
        warning: "Only bet if your thesis is strong.",
        encouragement: null
      },
      context
    )
  );

  assert.throws(() =>
    validateDailyCoachResponseAgainstContext(
      {
        diagnosis: "The day is clear.",
        nextMove: "Handle due action: Apply to 2 jobs.",
        warning: "Trade small with a stop loss.",
        encouragement: null
      },
      context
    )
  );
});

test("daily coach debug reports disabled, llm, invalid, error, and timeout sources", async () => {
  const originalEnv = {
    DAILY_COACH_LLM_ENABLED: process.env.DAILY_COACH_LLM_ENABLED,
    DAILY_COACH_LLM_MOCK_RESPONSE: process.env.DAILY_COACH_LLM_MOCK_RESPONSE,
    DAILY_COACH_LLM_MOCK_THROW: process.env.DAILY_COACH_LLM_MOCK_THROW,
    DAILY_COACH_LLM_MOCK_DELAY_MS: process.env.DAILY_COACH_LLM_MOCK_DELAY_MS,
    DAILY_COACH_LLM_TIMEOUT_MS: process.env.DAILY_COACH_LLM_TIMEOUT_MS,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY
  };
  const server = buildServer();
  const actionUserId = `daily-coach-debug-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  await prisma.notificationSettings.create({
    data: {
      userId: actionUserId,
      timezone: "Europe/Madrid"
    }
  });
  const goal = await prisma.goal.create({
    data: {
      userId: actionUserId,
      title: "Find a new developer job",
      category: "career",
      templateId: "career.job_search",
      priority: "critical",
      importanceScore: 70
    }
  });
  await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Apply to 2 jobs",
      priority: "medium",
      dueAt: new Date("2026-07-31T07:00:00.000Z"),
      goalId: goal.id,
      goalTitleSnapshot: goal.title
    }
  });
  const path = `/users/${actionUserId}/today/debug-daily-coach?now=${encodeURIComponent("2026-07-30T23:40:00.000Z")}`;

  const clearMockEnv = () => {
    delete process.env.DAILY_COACH_LLM_MOCK_RESPONSE;
    delete process.env.DAILY_COACH_LLM_MOCK_THROW;
    delete process.env.DAILY_COACH_LLM_MOCK_DELAY_MS;
    delete process.env.DAILY_COACH_LLM_TIMEOUT_MS;
  };

  try {
    clearMockEnv();
    process.env.DAILY_COACH_LLM_ENABLED = "false";
    process.env.OPENAI_API_KEY = "test-key";
    let response = await server.inject({ method: "GET", url: path });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().coachSource, "fallback_disabled");
    assert.equal(response.json().schemaValidationPassed, true);

    clearMockEnv();
    process.env.DAILY_COACH_LLM_ENABLED = "true";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.DAILY_COACH_LLM_MOCK_RESPONSE = JSON.stringify({
      diagnosis: "Apply to 2 jobs is the first move because it supports Find a new developer job.",
      nextMove: "Apply to 2 jobs first.",
      warning: null,
      encouragement: null
    });
    response = await server.inject({ method: "GET", url: path });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().coachSource, "llm");
    assert.equal(response.json().llmEnabled, true);
    assert.equal(response.json().llmAttempted, true);
    assert.equal(response.json().validationStatus, "passed");
    assert.deepEqual(response.json().validationFailureCodes, []);
    assert.equal(response.json().schemaValidationPassed, true);
    assert.equal(response.json().selectedNextMove, "Next upcoming action: Apply to 2 jobs.");
    assert.equal(response.json().selectedActionTitle, "Apply to 2 jobs");
    assert.equal(response.json().topPriorities[0].title, "Apply to 2 jobs");
    assert.equal(
      response.json().topPriorities[0].rankReason.split(", ").filter((factor: string) => factor === "no job-search progress").length,
      1
    );

    clearMockEnv();
    process.env.DAILY_COACH_LLM_ENABLED = "true";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.DAILY_COACH_LLM_MOCK_RESPONSE = "This is prose, not JSON.";
    response = await server.inject({ method: "GET", url: path });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().coachSource, "fallback_invalid");
    assert.equal(response.json().validationStatus, "failed");
    assert.deepEqual(response.json().validationFailureCodes, ["invalid_json"]);
    assert.equal(response.json().schemaValidationPassed, false);
    assert.equal(response.json().validationFailureSummary, "invalid_json");
    assert.equal(response.json().rawResponseType, "text");

    clearMockEnv();
    process.env.DAILY_COACH_LLM_ENABLED = "true";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.DAILY_COACH_LLM_MOCK_RESPONSE = JSON.stringify({
      diagnosis: "Apply to 2 jobs is the first move.",
      nextMove: "Apply to 2 jobs first.",
      warning: null
    });
    response = await server.inject({ method: "GET", url: path });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().coachSource, "fallback_invalid");
    assert.deepEqual(response.json().validationFailureCodes, ["schema_missing_field"]);
    assert.deepEqual(response.json().parsedFieldsPresent, ["diagnosis", "nextMove", "warning"]);
    assert.equal(typeof response.json().diagnosisLength, "number");
    assert.equal(typeof response.json().nextMoveLength, "number");

    clearMockEnv();
    process.env.DAILY_COACH_LLM_ENABLED = "true";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.DAILY_COACH_LLM_MOCK_RESPONSE = JSON.stringify({
      diagnosis: "The day is clear.",
      nextMove: "Start with the YouTube script.",
      warning: null,
      encouragement: null
    });
    response = await server.inject({ method: "GET", url: path });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().coachSource, "fallback_invalid");
    assert.ok(response.json().validationFailureCodes.includes("next_move_mismatch"));

    const todayAfterInvalid = await server.inject({ method: "GET", url: `/users/${actionUserId}/today?now=${encodeURIComponent("2026-07-30T23:40:00.000Z")}` });
    assert.equal(todayAfterInvalid.statusCode, 200);
    assert.equal(todayAfterInvalid.json().brief.coachDebug.source, "fallback_invalid");
    assert.equal(todayAfterInvalid.json().brief.coach.nextMove, "Next upcoming action: Apply to 2 jobs.");

    clearMockEnv();
    process.env.DAILY_COACH_LLM_ENABLED = "true";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.DAILY_COACH_LLM_MOCK_RESPONSE = JSON.stringify({
      diagnosis: "The day is clear.",
      nextMove: "Apply to 2 jobs first.",
      warning: "Open a trade with small size.",
      encouragement: null
    });
    response = await server.inject({ method: "GET", url: path });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().coachSource, "fallback_invalid");
    assert.ok(response.json().validationFailureCodes.includes("unsafe_guardrail_advice"));

    const riskGoal = await prisma.goal.create({
      data: {
        userId: actionUserId,
        title: "Control impulsive betting",
        category: "finance",
        templateId: "finance.control_betting_trading",
        priority: "critical",
        importanceScore: 70
      }
    });
    await prisma.event.create({
      data: {
        userId: actionUserId,
        type: "finance.betting.cooldown_triggered",
        timestamp: new Date("2026-07-30T23:30:00.000Z"),
        source: "manual",
        data: { goalId: riskGoal.id },
        confidence: 1
      }
    });
    clearMockEnv();
    process.env.DAILY_COACH_LLM_ENABLED = "true";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.DAILY_COACH_LLM_MOCK_RESPONSE = JSON.stringify({
      diagnosis: "Apply to 2 jobs is still the first move.",
      nextMove: "Apply to 2 jobs first.",
      warning: "Only bet if your thesis is strong.",
      encouragement: null
    });
    response = await server.inject({ method: "GET", url: path });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().coachSource, "llm");
    assert.deepEqual(response.json().validationFailureCodes, []);
    const riskToday = await server.inject({ method: "GET", url: `/users/${actionUserId}/today?now=${encodeURIComponent("2026-07-30T23:40:00.000Z")}` });
    assert.equal(riskToday.statusCode, 200);
    assert.equal(riskToday.json().brief.coach.warning, "Keep the Control impulsive betting guardrail locked today.");

    clearMockEnv();
    process.env.DAILY_COACH_LLM_ENABLED = "true";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.DAILY_COACH_LLM_MOCK_THROW = "true";
    response = await server.inject({ method: "GET", url: path });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().coachSource, "fallback_error");
    assert.equal(response.json().schemaValidationPassed, false);

    clearMockEnv();
    process.env.DAILY_COACH_LLM_ENABLED = "true";
    process.env.OPENAI_API_KEY = "test-key";
    process.env.DAILY_COACH_LLM_TIMEOUT_MS = "1";
    process.env.DAILY_COACH_LLM_MOCK_DELAY_MS = "20";
    process.env.DAILY_COACH_LLM_MOCK_RESPONSE = JSON.stringify({
      diagnosis: "Apply to 2 jobs is the first move because it supports Find a new developer job.",
      nextMove: "Handle due action: Apply to 2 jobs.",
      warning: null,
      encouragement: null
    });
    response = await server.inject({ method: "GET", url: path });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().coachSource, "fallback_timeout");
    assert.equal(response.json().schemaValidationPassed, false);
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("goal priority weights rank critical over medium and medium over low with same due window", () => {
  const now = new Date(2026, 6, 30, 4, 30);
  const dueAt = new Date(2026, 6, 31, 9, 0);
  const criticalGoal = {
    id: "goal-critical",
    userId: "score-user",
    title: "Find a new developer job",
    category: "career",
    status: "active" as const,
    templateId: "career.job_search",
    priority: "critical" as const,
    importanceScore: 70,
    createdAt: now,
    updatedAt: now
  };
  const mediumGoal = {
    id: "goal-medium",
    userId: "score-user",
    title: "Build a YouTube channel",
    category: "creative",
    status: "active" as const,
    priority: "medium" as const,
    importanceScore: 25,
    createdAt: now,
    updatedAt: now
  };
  const lowGoal = {
    id: "goal-low",
    userId: "score-user",
    title: "Find a cheap car to buy",
    category: "custom",
    status: "active" as const,
    priority: "low" as const,
    importanceScore: 10,
    createdAt: now,
    updatedAt: now
  };
  const action = (id: string, title: string, goal: typeof criticalGoal | typeof mediumGoal | typeof lowGoal) => ({
    id,
    userId: "score-user",
    source: "manual" as const,
    title,
    status: "open" as const,
    priority: "medium" as const,
    dueAt,
    goalId: goal.id,
    goalTitleSnapshot: goal.title,
    createdAt: now,
    updatedAt: now
  });
  const goals = [lowGoal, mediumGoal, criticalGoal];
  const ranked = sortDailyActionsByPriority(
    [
      action("car", "Check cheap car listings", lowGoal),
      action("youtube", "Write YouTube script", mediumGoal),
      action("jobs", "Apply to 2 jobs", criticalGoal)
    ],
    {
      goals,
      goalStatuses: goals.map((goal) => ({
        goalId: goal.id,
        hasProgressToday: false,
        hasCompletedActionToday: false,
        hasOpenAction: true
      })),
      recentEvents: [],
      now
    }
  );

  assert.deepEqual(ranked.map((item) => item.action.id), ["jobs", "youtube", "car"]);
  assert.match(ranked[0].score.rankReason, /critical goal/);
  assert.match(ranked[1].score.rankReason, /medium goal/);
  assert.match(ranked[2].score.rankReason, /low goal/);
});

test("/goal priorities routes list, update, backfill, and /today uses weighted scorer", async () => {
  const server = buildServer();
  const actionUserId = `goal-priority-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  const jobGoal = await prisma.goal.create({
    data: {
      userId: actionUserId,
      title: "Find a new developer job",
      category: "career",
      templateId: "career.job_search",
      priority: "medium",
      importanceScore: 25
    }
  });
  const youtubeGoal = await prisma.goal.create({
    data: {
      userId: actionUserId,
      title: "Build a YouTube channel",
      category: "creative",
      priority: "medium",
      importanceScore: 25
    }
  });
  const dueAt = new Date(Date.now() + 60 * 60 * 1000);
  await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Write YouTube script",
      priority: "medium",
      dueAt,
      goalId: youtubeGoal.id,
      goalTitleSnapshot: youtubeGoal.title
    }
  });
  await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Apply to 2 jobs",
      priority: "medium",
      dueAt,
      goalId: jobGoal.id,
      goalTitleSnapshot: jobGoal.title
    }
  });

  try {
    const update = await server.inject({
      method: "PATCH",
      url: `/users/${actionUserId}/goals/priority`,
      payload: { goal: jobGoal.id, priority: "critical" }
    });
    assert.equal(update.statusCode, 200);
    assert.equal(update.json().goal.priority, "critical");

    const list = await server.inject({
      method: "GET",
      url: `/users/${actionUserId}/goals/priorities`
    });
    assert.equal(list.statusCode, 200);
    assert.ok(list.json().goals.some((goal: { title: string; priority: string }) => goal.title === "Find a new developer job" && goal.priority === "critical"));

    const today = await server.inject({
      method: "GET",
      url: `/users/${actionUserId}/today`
    });
    assert.equal(today.statusCode, 200);
    assert.equal(today.json().brief.openActions[0].title, "Apply to 2 jobs");
    assert.equal(today.json().brief.suggestedNextStep, "Next upcoming action: Apply to 2 jobs.");

    const debug = await server.inject({
      method: "GET",
      url: `/users/${actionUserId}/today/debug-priorities`
    });
    assert.equal(debug.statusCode, 200);
    assert.match(debug.json().priorities[0].rankReason, /critical goal/);

    await prisma.goal.update({
      where: { id: youtubeGoal.id },
      data: { importanceScore: null }
    });
    const backfill = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/goals/priorities/backfill`
    });
    assert.equal(backfill.statusCode, 200);
    assert.ok(backfill.json().updated >= 1);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("goal priority backfill corrects broken default medium priorities and preserves manual choices", async () => {
  const server = buildServer();
  const actionUserId = `goal-priority-backfill-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  const goals = await Promise.all([
    prisma.goal.create({
      data: {
        userId: actionUserId,
        title: "Find a new developer job",
        category: "career",
        priority: "medium",
        importanceScore: 25,
        priorityReason: "default priority backfill"
      }
    }),
    prisma.goal.create({
      data: {
        userId: actionUserId,
        title: "Control impulsive betting",
        category: "finance",
        priority: "medium",
        importanceScore: 25,
        priorityReason: "default priority backfill"
      }
    }),
    prisma.goal.create({
      data: {
        userId: actionUserId,
        title: "Improve strength and energy",
        category: "health",
        priority: "medium",
        importanceScore: 25,
        priorityReason: "default priority backfill"
      }
    }),
    prisma.goal.create({
      data: {
        userId: actionUserId,
        title: "Build a YouTube channel",
        category: "creative",
        priority: "medium",
        importanceScore: 25,
        priorityReason: "default priority backfill"
      }
    }),
    prisma.goal.create({
      data: {
        userId: actionUserId,
        title: "Find a cheap car to buy",
        category: "custom",
        priority: "medium",
        importanceScore: 25,
        priorityReason: "default priority backfill"
      }
    }),
    prisma.goal.create({
      data: {
        userId: actionUserId,
        title: "Read more",
        category: "learning",
        priority: "medium",
        importanceScore: 25,
        priorityReason: "default priority backfill"
      }
    })
  ]);

  try {
    const backfill = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/goals/priorities/backfill`,
      payload: {}
    });
    assert.equal(backfill.statusCode, 200);
    assert.match(backfill.json().message, /Find a new developer job: medium -> critical/);
    assert.match(backfill.json().message, /Control impulsive betting: medium -> critical/);
    assert.match(backfill.json().message, /Improve strength and energy: medium -> high/);
    assert.match(backfill.json().message, /Find a cheap car to buy: medium -> low/);
    assert.match(backfill.json().message, /Read more: medium -> low/);

    const updatedGoals = await prisma.goal.findMany({ where: { userId: actionUserId } });
    const priorities = new Map(updatedGoals.map((goal) => [goal.title, goal.priority]));
    const scores = new Map(updatedGoals.map((goal) => [goal.title, goal.importanceScore]));
    assert.equal(priorities.get("Find a new developer job"), "critical");
    assert.equal(scores.get("Find a new developer job"), 70);
    assert.equal(priorities.get("Control impulsive betting"), "critical");
    assert.equal(scores.get("Control impulsive betting"), 70);
    assert.equal(priorities.get("Improve strength and energy"), "high");
    assert.equal(scores.get("Improve strength and energy"), 45);
    assert.equal(priorities.get("Build a YouTube channel"), "medium");
    assert.equal(scores.get("Build a YouTube channel"), 25);
    assert.equal(priorities.get("Find a cheap car to buy"), "low");
    assert.equal(scores.get("Find a cheap car to buy"), 10);
    assert.equal(priorities.get("Read more"), "low");
    assert.equal(scores.get("Read more"), 10);

    const manualCarGoal = goals.find((goal) => goal.title === "Find a cheap car to buy");
    assert.ok(manualCarGoal);
    const manualUpdate = await server.inject({
      method: "PATCH",
      url: `/users/${actionUserId}/goals/priority`,
      payload: { goal: manualCarGoal.id, priority: "critical" }
    });
    assert.equal(manualUpdate.statusCode, 200);

    const normalBackfill = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/goals/priorities/backfill`,
      payload: {}
    });
    assert.match(normalBackfill.json().message, /Skipped manual priorities:/);
    const preservedManual = await prisma.goal.findUniqueOrThrow({ where: { id: manualCarGoal.id } });
    assert.equal(preservedManual.priority, "critical");

    const forceBackfill = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/goals/priorities/backfill`,
      payload: { force: true }
    });
    assert.equal(forceBackfill.statusCode, 200);
    const forcedManual = await prisma.goal.findUniqueOrThrow({ where: { id: manualCarGoal.id } });
    assert.equal(forcedManual.priority, "low");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("explicit memory concrete task saves memory and creates ActionItem", async () => {
  const server = buildServer();
  const actionUserId = `action-memory-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });

  try {
    const response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: actionUserId, message: "remember that I need to review homepage copy tomorrow" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Saved to memory/);
    assert.match(response.json().reply, /Action created/);

    const [memories, actions] = await Promise.all([
      prisma.memoryEntry.findMany({ where: { userId: actionUserId } }),
      prisma.actionItem.findMany({ where: { userId: actionUserId } })
    ]);
    assert.equal(memories.length, 1);
    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, "Review homepage copy");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("explicit memory unrelated concrete task creates unlinked ActionItem", async () => {
  const server = buildServer();
  const actionUserId = `action-memory-unlinked-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  await prisma.goal.create({
    data: {
      userId: actionUserId,
      title: "Build a YouTube channel",
      category: "creative"
    }
  });

  try {
    const response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: actionUserId, message: "remember that I need to buy milk tomorrow" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Saved to memory/);
    assert.match(response.json().reply, /Action created/);

    const actions = await prisma.actionItem.findMany({ where: { userId: actionUserId } });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].title, "Buy milk");
    assert.equal(actions[0].goalId, null);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("remember task uses manual action dedupe behavior", async () => {
  const server = buildServer();
  const actionUserId = `action-memory-dedupe-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });

  try {
    const command = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/actions/manual`,
      payload: { text: "review homepage copy tomorrow" }
    });
    assert.equal(command.statusCode, 200);

    const memory = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: actionUserId, message: "remember that I need to review the homepage copy tomorrow" }
    });
    assert.equal(memory.statusCode, 200);
    assert.match(memory.json().reply, /Saved to memory/);
    assert.match(memory.json().reply, /Action already exists: Review homepage copy/);

    const actions = await prisma.actionItem.findMany({ where: { userId: actionUserId } });
    assert.equal(actions.length, 1);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("vague action language and betting reminders do not create ActionItems", async () => {
  const server = buildServer();
  const actionUserId = `action-safe-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });

  try {
    const vague = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: actionUserId, message: "I need to be better" }
    });
    assert.equal(vague.statusCode, 200);

    const betting = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: actionUserId, message: "remind me to bet tomorrow" }
    });
    assert.equal(betting.statusCode, 200);
    assert.equal(betting.json().intent, "betting_intent");

    const actions = await prisma.actionItem.findMany({ where: { userId: actionUserId } });
    assert.equal(actions.length, 0);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("duplicate open manual action is reused but completed old action does not block", async () => {
  const server = buildServer();
  const actionUserId = `action-dedupe-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });

  try {
    const first = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/actions/manual`,
      payload: { text: "remind me to call Alex Friday" }
    });
    assert.equal(first.statusCode, 200);
    const firstAction = first.json().action;
    assert.equal(firstAction.title, "Call Alex");

    const duplicate = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/actions/manual`,
      payload: { text: "remind me to call Alex Friday" }
    });
    assert.equal(duplicate.statusCode, 200);
    assert.equal(duplicate.json().duplicate, true);
    assert.equal(duplicate.json().action.id, firstAction.id);

    await prisma.actionItem.update({
      where: { id: firstAction.id },
      data: { status: "completed", completedAt: new Date() }
    });

    const newAction = await server.inject({
      method: "POST",
      url: `/users/${actionUserId}/actions/manual`,
      payload: { text: "remind me to call Alex Friday" }
    });
    assert.equal(newAction.statusCode, 200);
    assert.equal(newAction.json().duplicate, false);
    assert.notEqual(newAction.json().action.id, firstAction.id);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("action reminder trigger sends open due action and includes commands", async () => {
  const server = buildServer();
  const reminderUserId = `telegram:${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  await prisma.user.create({ data: { id: reminderUserId } });
  const action = await prisma.actionItem.create({
    data: {
      userId: reminderUserId,
      source: "manual",
      title: "Review homepage copy",
      priority: "medium",
      dueAt: new Date(Date.now() - 60_000)
    }
  });

  try {
    const response = await server.inject({
      method: "POST",
      url: `/users/${reminderUserId}/actions/reminders/trigger`
    });
    assert.equal(response.statusCode, 200);
    const payload = response.json();
    assert.equal(payload.sent, 1);
    assert.match(payload.message, /Action overdue:/);
    assert.match(payload.message, new RegExp(`/complete_action ${action.id}`));
    assert.match(payload.message, new RegExp(`/snooze_action ${action.id} tomorrow`));
    assert.match(payload.message, new RegExp(`/archive_action ${action.id}`));
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: reminderUserId } });
  }
});

test("now action triggers reminder immediately and does not duplicate", async () => {
  const server = buildServer();
  const reminderUserId = `telegram:${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  await prisma.user.create({ data: { id: reminderUserId } });

  try {
    const created = await server.inject({
      method: "POST",
      url: `/users/${reminderUserId}/actions/manual`,
      payload: { text: "test now" }
    });
    assert.equal(created.statusCode, 200);
    assert.equal(created.json().action.title, "Test");

    const first = await server.inject({
      method: "POST",
      url: `/users/${reminderUserId}/actions/reminders/trigger`
    });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().sent, 1);
    assert.match(first.json().message, /Action overdue:/);

    const second = await server.inject({
      method: "POST",
      url: `/users/${reminderUserId}/actions/reminders/trigger`
    });
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().sent, 0);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: reminderUserId } });
  }
});

test("action reminder trigger skips future, completed, and archived actions", async () => {
  const server = buildServer();
  const reminderUserId = `telegram:${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  await prisma.user.create({ data: { id: reminderUserId } });
  await prisma.actionItem.createMany({
    data: [
      {
        userId: reminderUserId,
        source: "manual",
        title: "Future action",
        priority: "medium",
        dueAt: new Date(Date.now() + 60 * 60_000)
      },
      {
        userId: reminderUserId,
        source: "manual",
        title: "Completed action",
        status: "completed",
        priority: "medium",
        dueAt: new Date(Date.now() - 60_000)
      },
      {
        userId: reminderUserId,
        source: "manual",
        title: "Archived action",
        status: "archived",
        priority: "medium",
        dueAt: new Date(Date.now() - 60_000)
      }
    ]
  });

  try {
    const response = await server.inject({
      method: "POST",
      url: `/users/${reminderUserId}/actions/reminders/trigger`
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().sent, 0);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: reminderUserId } });
  }
});

test("snoozed due action sends reminder and becomes open", async () => {
  const server = buildServer();
  const reminderUserId = `telegram:${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  await prisma.user.create({ data: { id: reminderUserId } });
  const action = await prisma.actionItem.create({
    data: {
      userId: reminderUserId,
      source: "manual",
      title: "Call Alex",
      status: "snoozed",
      priority: "medium",
      dueAt: new Date(Date.now() - 24 * 60 * 60_000),
      snoozedUntil: new Date(Date.now() - 60_000)
    }
  });

  try {
    const response = await server.inject({
      method: "POST",
      url: `/users/${reminderUserId}/actions/reminders/trigger`
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().sent, 1);
    assert.match(response.json().message, /Snoozed action is back:/);

    const updated = await prisma.actionItem.findUniqueOrThrow({ where: { id: action.id } });
    assert.equal(updated.status, "open");
    assert.equal(updated.snoozedUntil, null);

    const second = await server.inject({
      method: "POST",
      url: `/users/${reminderUserId}/actions/reminders/trigger`
    });
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().sent, 0);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: reminderUserId } });
  }
});

test("snoozed future action does not send reminder", async () => {
  const server = buildServer();
  const reminderUserId = `telegram:${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  await prisma.user.create({ data: { id: reminderUserId } });
  await prisma.actionItem.create({
    data: {
      userId: reminderUserId,
      source: "manual",
      title: "Call Alex",
      status: "snoozed",
      priority: "medium",
      snoozedUntil: new Date(Date.now() + 60 * 60_000)
    }
  });

  try {
    const response = await server.inject({
      method: "POST",
      url: `/users/${reminderUserId}/actions/reminders/trigger`
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().sent, 0);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: reminderUserId } });
  }
});

test("duplicate action reminder within 12 hours is skipped", async () => {
  const server = buildServer();
  const reminderUserId = `telegram:${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  await prisma.user.create({ data: { id: reminderUserId } });
  await prisma.actionItem.create({
    data: {
      userId: reminderUserId,
      source: "manual",
      title: "Send the CV",
      priority: "medium",
      dueAt: new Date(Date.now() - 60_000)
    }
  });

  try {
    const first = await server.inject({
      method: "POST",
      url: `/users/${reminderUserId}/actions/reminders/trigger`
    });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().sent, 1);

    const second = await server.inject({
      method: "POST",
      url: `/users/${reminderUserId}/actions/reminders/trigger`
    });
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().sent, 0);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: reminderUserId } });
  }
});

test("debug force due action makes future action remind once", async () => {
  const server = buildServer();
  const reminderUserId = `telegram:${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  await prisma.user.create({ data: { id: reminderUserId } });
  const action = await prisma.actionItem.create({
    data: {
      userId: reminderUserId,
      source: "manual",
      title: "Review homepage copy",
      priority: "medium",
      dueAt: new Date(Date.now() + 24 * 60 * 60_000)
    }
  });

  try {
    const forced = await server.inject({
      method: "PATCH",
      url: `/users/${reminderUserId}/actions/${action.id}/debug-force-due`
    });
    assert.equal(forced.statusCode, 200);
    assert.equal(forced.json().message, "Action forced due: Review homepage copy");

    const first = await server.inject({
      method: "POST",
      url: `/users/${reminderUserId}/actions/reminders/trigger`
    });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().sent, 1);
    assert.match(first.json().message, /Action overdue:/);

    const second = await server.inject({
      method: "POST",
      url: `/users/${reminderUserId}/actions/reminders/trigger`
    });
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().sent, 0);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: reminderUserId } });
  }
});

test("debug force snoozed due action makes snoozed action remind once", async () => {
  const server = buildServer();
  const reminderUserId = `telegram:${randomUUID().replace(/-/g, "").slice(0, 10)}`;
  await prisma.user.create({ data: { id: reminderUserId } });
  const action = await prisma.actionItem.create({
    data: {
      userId: reminderUserId,
      source: "manual",
      title: "Call Alex",
      status: "open",
      priority: "medium"
    }
  });

  try {
    const forced = await server.inject({
      method: "PATCH",
      url: `/users/${reminderUserId}/actions/${action.id}/debug-force-snoozed-due`
    });
    assert.equal(forced.statusCode, 200);
    assert.equal(forced.json().message, "Action forced snoozed due: Call Alex");

    const first = await server.inject({
      method: "POST",
      url: `/users/${reminderUserId}/actions/reminders/trigger`
    });
    assert.equal(first.statusCode, 200);
    assert.equal(first.json().sent, 1);
    assert.match(first.json().message, /Snoozed action is back:/);

    const updated = await prisma.actionItem.findUniqueOrThrow({ where: { id: action.id } });
    assert.equal(updated.status, "open");
    assert.equal(updated.snoozedUntil, null);

    const second = await server.inject({
      method: "POST",
      url: `/users/${reminderUserId}/actions/reminders/trigger`
    });
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().sent, 0);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: reminderUserId } });
  }
});

test("action hygiene detects stale actions and routes cleanup replies safely", async () => {
  const server = buildServer();
  const hygieneUserId = `action-hygiene-${randomUUID()}`;
  const now = "2026-08-04T14:43:00+02:00";
  await prisma.user.create({ data: { id: hygieneUserId } });
  await prisma.notificationSettings.create({
    data: {
      userId: hygieneUserId,
      timezone: "Europe/Madrid",
      telegramUserId: "12345"
    }
  });
  const criticalGoal = await prisma.goal.create({
    data: {
      userId: hygieneUserId,
      title: "Find a new developer job",
      category: "career",
      templateId: "career.job_search",
      priority: "critical",
      importanceScore: 70
    }
  });
  const riskGoal = await prisma.goal.create({
    data: {
      userId: hygieneUserId,
      title: "Control impulsive betting",
      category: "finance",
      templateId: "finance.control_betting_trading",
      priority: "critical",
      importanceScore: 70
    }
  });
  const staleUnlinked = await prisma.actionItem.create({
    data: {
      userId: hygieneUserId,
      source: "manual",
      title: "Review homepage",
      priority: "medium",
      status: "open",
      dueAt: new Date("2026-08-01T14:30:00.000Z")
    }
  });
  const criticalLinked = await prisma.actionItem.create({
    data: {
      userId: hygieneUserId,
      source: "manual",
      title: "Send recruiter follow-up",
      priority: "medium",
      status: "open",
      dueAt: new Date("2026-08-01T07:00:00.000Z"),
      goalId: criticalGoal.id,
      goalTitleSnapshot: criticalGoal.title
    }
  });
  await prisma.actionItem.create({
    data: {
      userId: hygieneUserId,
      source: "manual",
      title: "Review betting thesis",
      priority: "medium",
      status: "open",
      dueAt: new Date("2026-08-01T07:00:00.000Z"),
      goalId: riskGoal.id,
      goalTitleSnapshot: riskGoal.title
    }
  });
  const lowStale = await prisma.actionItem.create({
    data: {
      userId: hygieneUserId,
      source: "manual",
      title: "Clean old notes",
      priority: "low",
      status: "open",
      updatedAt: new Date("2026-07-20T10:00:00.000Z")
    }
  });
  const homepageSecond = await prisma.actionItem.create({
    data: {
      userId: hygieneUserId,
      source: "manual",
      title: "Update homepage hero",
      priority: "medium",
      status: "open",
      dueAt: new Date("2026-08-01T07:00:00.000Z")
    }
  });

  try {
    let response = await server.inject({
      method: "GET",
      url: `/users/${hygieneUserId}/actions/hygiene?now=${encodeURIComponent(now)}`
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().message, /Action hygiene/);
    assert.match(response.json().message, /Review homepage/);
    assert.match(response.json().message, /Clean old notes/);
    assert.doesNotMatch(response.json().message, /Review betting thesis/);
    const report = response.json().report;
    assert.ok(report.overdueActions.some((action: { title: string }) => action.title === "Review homepage"));
    assert.ok(report.staleActions.some((action: { title: string }) => action.title === "Review homepage"));
    assert.ok(report.lowPriorityStaleActions.some((action: { title: string }) => action.title === "Clean old notes"));
    const critical = report.suggestedCleanupCandidates.find((action: { title: string }) => action.title === "Send recruiter follow-up");
    assert.ok(critical);
    assert.equal(critical.recommendedOptions.includes("archive"), false);

    response = await server.inject({
      method: "GET",
      url: `/users/${hygieneUserId}/daily-loop/start-day?now=${encodeURIComponent(now)}`
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().message, /Hygiene: \d+ actions? needs? (?:a cleanup decision|cleanup decisions)\. Run \/action_hygiene/);

    response = await server.inject({
      method: "GET",
      url: `/users/${hygieneUserId}/daily-loop/end-day?now=${encodeURIComponent(now)}`
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().message, /Cleanup:\nReview overdue actions before tomorrow: \/action_hygiene/);

    response = await server.inject({
      method: "GET",
      url: `/users/${hygieneUserId}/today?now=${encodeURIComponent(now)}`
    });
    assert.equal(response.statusCode, 200);
    assert.ok(response.json().brief.actionHygiene);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: hygieneUserId, message: "snooze Review homepage tomorrow" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Action snoozed until/);
    assert.equal((await prisma.actionItem.findUniqueOrThrow({ where: { id: staleUnlinked.id } })).status, "snoozed");

    await server.inject({
      method: "GET",
      url: `/users/${hygieneUserId}/actions/hygiene?now=${encodeURIComponent(now)}`
    });
    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: hygieneUserId, message: "complete Send recruiter follow-up" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Action completed: Send recruiter follow-up/);
    assert.equal((await prisma.actionItem.findUniqueOrThrow({ where: { id: criticalLinked.id } })).status, "completed");

    await server.inject({
      method: "GET",
      url: `/users/${hygieneUserId}/actions/hygiene?now=${encodeURIComponent(now)}`
    });
    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: hygieneUserId, message: "archive homepage" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Confirm archive action: Update homepage hero/);
    assert.equal((await prisma.actionItem.findUniqueOrThrow({ where: { id: homepageSecond.id } })).status, "open");

    await prisma.pendingAction.updateMany({
      where: { userId: hygieneUserId, status: "pending" },
      data: { status: "cancelled" }
    });
    await server.inject({
      method: "GET",
      url: `/users/${hygieneUserId}/actions/hygiene?now=${encodeURIComponent(now)}`
    });

    response = await server.inject({
      method: "POST",
      url: `/users/${hygieneUserId}/actions/hygiene/reply`,
      payload: { message: "archive all unlinked stale tasks", now }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().message, /Confirm archive \d+ unlinked stale action/);
    assert.equal((await prisma.actionItem.findUniqueOrThrow({ where: { id: lowStale.id } })).status, "open");

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: hygieneUserId, message: "no" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Cancelled/);
    assert.equal((await prisma.actionItem.findUniqueOrThrow({ where: { id: lowStale.id } })).status, "open");

    response = await server.inject({
      method: "GET",
      url: `/users/${hygieneUserId}/actions/hygiene?now=${encodeURIComponent(now)}&debug=true`
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().message, /Action hygiene debug/);
    assert.equal(await prisma.pendingAction.count({ where: { userId: hygieneUserId, status: "pending" } }), 0);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: hygieneUserId } });
  }
});

test("action hygiene ignores future snoozed actions and updates daily loop hygiene", async () => {
  const server = buildServer();
  const hygieneUserId = `action-hygiene-snooze-${randomUUID()}`;
  const now = "2026-08-04T15:08:00+02:00";
  await prisma.user.create({ data: { id: hygieneUserId } });
  await prisma.notificationSettings.create({
    data: {
      userId: hygieneUserId,
      timezone: "Europe/Madrid",
      telegramUserId: "12345"
    }
  });
  const action = await prisma.actionItem.create({
    data: {
      userId: hygieneUserId,
      source: "manual",
      title: "Write YouTube script",
      priority: "medium",
      status: "open",
      dueAt: new Date("2026-08-01T14:30:00.000Z")
    }
  });

  try {
    let response = await server.inject({
      method: "GET",
      url: `/users/${hygieneUserId}/actions/hygiene?now=${encodeURIComponent(now)}`
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().message, /1 action needs a cleanup decision/);
    assert.match(response.json().message, /Write YouTube script/);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: hygieneUserId, message: "snooze 1 tomorrow" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Action snoozed until 05\/08\/2026, 09:00: Write YouTube script/);
    const snoozed = await prisma.actionItem.findUniqueOrThrow({ where: { id: action.id } });
    assert.equal(snoozed.status, "snoozed");

    response = await server.inject({
      method: "GET",
      url: `/users/${hygieneUserId}/actions/hygiene?now=${encodeURIComponent(now)}`
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().message, /Action list is clean enough/);
    assert.equal(response.json().report.suggestedCleanupCandidates.length, 0);

    response = await server.inject({
      method: "GET",
      url: `/users/${hygieneUserId}/daily-loop/start-day?now=${encodeURIComponent(now)}`
    });
    assert.equal(response.statusCode, 200);
    assert.doesNotMatch(response.json().message, /Hygiene:/);

    response = await server.inject({
      method: "GET",
      url: `/users/${hygieneUserId}/daily-loop/end-day?now=${encodeURIComponent(now)}`
    });
    assert.equal(response.statusCode, 200);
    assert.doesNotMatch(response.json().message, /Cleanup:/);

    response = await server.inject({
      method: "GET",
      url: `/users/${hygieneUserId}/today?now=${encodeURIComponent(now)}`
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().brief.actionHygiene, undefined);

    await prisma.actionItem.update({
      where: { id: action.id },
      data: {
        snoozedUntil: new Date("2026-08-04T12:00:00.000Z")
      }
    });
    response = await server.inject({
      method: "GET",
      url: `/users/${hygieneUserId}/actions/hygiene?now=${encodeURIComponent(now)}`
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().message, /1 action needs a cleanup decision/);

    await prisma.actionItem.update({
      where: { id: action.id },
      data: {
        status: "archived"
      }
    });
    const futureAction = await prisma.actionItem.create({
      data: {
        userId: hygieneUserId,
        source: "manual",
        title: "Review homepage",
        priority: "medium",
        status: "open",
        dueAt: new Date("2026-08-05T07:00:00.000Z")
      }
    });
    response = await server.inject({
      method: "GET",
      url: `/users/${hygieneUserId}/today?now=${encodeURIComponent(now)}`
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().brief.suggestedNextStep, "Next upcoming action: Review homepage.");
    assert.equal((await prisma.actionItem.findUniqueOrThrow({ where: { id: futureAction.id } })).status, "open");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: hygieneUserId } });
  }
});

test("action hygiene sessions stay active and never fake snooze success", async () => {
  const server = buildServer();
  const hygieneUserId = `action-hygiene-session-${randomUUID()}`;
  const now = "2026-08-10T14:45:00+02:00";
  await prisma.user.create({ data: { id: hygieneUserId } });
  await prisma.notificationSettings.create({
    data: {
      userId: hygieneUserId,
      timezone: "Europe/Madrid",
      telegramUserId: "12345"
    }
  });
  const youtubeGoal = await prisma.goal.create({
    data: {
      userId: hygieneUserId,
      title: "Build a YouTube channel",
      category: "creative",
      priority: "high",
      importanceScore: 45
    }
  });
  const firstAction = await prisma.actionItem.create({
    data: {
      userId: hygieneUserId,
      source: "manual",
      title: "Write YouTube script",
      priority: "medium",
      status: "open",
      dueAt: new Date("2026-08-01T14:30:00.000Z"),
      goalId: youtubeGoal.id,
      goalTitleSnapshot: youtubeGoal.title
    }
  });
  const secondAction = await prisma.actionItem.create({
    data: {
      userId: hygieneUserId,
      source: "manual",
      title: "Review homepage",
      priority: "medium",
      status: "open",
      dueAt: new Date("2026-08-05T07:00:00.000Z")
    }
  });

  try {
    let response = await server.inject({
      method: "GET",
      url: `/users/${hygieneUserId}/actions/hygiene?now=${encodeURIComponent(now)}`
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().message, /1\. Write YouTube script/);
    assert.match(response.json().message, /2\. Review homepage/);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: hygieneUserId, message: "complete 1 and snooze 2" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /need a snooze time/i);
    assert.equal((await prisma.actionItem.findUniqueOrThrow({ where: { id: firstAction.id } })).status, "open");
    assert.equal((await prisma.actionItem.findUniqueOrThrow({ where: { id: secondAction.id } })).status, "open");

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: hygieneUserId, message: "complete 1" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Action completed: Write YouTube script/);
    assert.equal((await prisma.actionItem.findUniqueOrThrow({ where: { id: firstAction.id } })).status, "completed");
    assert.equal(await prisma.pendingAction.count({ where: { userId: hygieneUserId, status: "pending", type: "action_hygiene" } }), 1);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: hygieneUserId, message: "snooze 2" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Add a time for the snooze/);
    assert.doesNotMatch(response.json().reply, /I've logged|future scheduling/i);
    assert.equal((await prisma.actionItem.findUniqueOrThrow({ where: { id: secondAction.id } })).status, "open");

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: hygieneUserId, message: "snooze 2 tomorrow" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Action snoozed until 11\/08\/2026, 09:00: Review homepage/);
    assert.equal((await prisma.actionItem.findUniqueOrThrow({ where: { id: secondAction.id } })).status, "snoozed");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: hygieneUserId } });
  }
});

test("action hygiene batch replies use visible numbers, confirm before mutation, and remember results", async () => {
  const server = buildServer();
  const hygieneUserId = `action-hygiene-batch-${randomUUID()}`;
  const now = "2026-08-13T10:00:00+02:00";
  await prisma.user.create({ data: { id: hygieneUserId } });
  await prisma.notificationSettings.create({
    data: {
      userId: hygieneUserId,
      timezone: "Europe/Madrid",
      telegramUserId: "12345"
    }
  });
  const titles = [
    "Review homepage",
    "Apply to 3 developer jobs",
    "Write 5 bullets for the YouTube script",
    "Read 20 minutes on 3 days",
    "Do 2 strength sessions"
  ];

  for (let index = 0; index < titles.length; index += 1) {
    await prisma.actionItem.create({
      data: {
        userId: hygieneUserId,
        source: "manual",
        title: titles[index],
        priority: "medium",
        status: "open",
        dueAt: new Date(`2026-08-0${index + 1}T07:00:00.000Z`)
      }
    });
  }

  try {
    const hygiene = await server.inject({
      method: "GET",
      url: `/users/${hygieneUserId}/actions/hygiene?now=${encodeURIComponent(now)}`
    });
    assert.equal(hygiene.statusCode, 200);
    const candidates = hygiene.json().report.suggestedCleanupCandidates as Array<{ actionId: string; title: string }>;
    assert.ok(candidates.length >= 5);

    let response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: {
        userId: hygieneUserId,
        message: "archive 1, snooze 2 tomorrow, archive 3, snooze 4 tomorrow, archive 5"
      }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /I will:/);
    assert.match(response.json().reply, new RegExp(candidates[0].title));
    assert.equal((await prisma.actionItem.findUniqueOrThrow({ where: { id: candidates[0].actionId } })).status, "open");

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: hygieneUserId, message: "yes" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Done:/);
    assert.equal((await prisma.actionItem.findUniqueOrThrow({ where: { id: candidates[0].actionId } })).status, "archived");
    assert.equal((await prisma.actionItem.findUniqueOrThrow({ where: { id: candidates[1].actionId } })).status, "snoozed");
    assert.equal((await prisma.actionItem.findUniqueOrThrow({ where: { id: candidates[2].actionId } })).status, "archived");

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: {
        userId: hygieneUserId,
        message: "did u also do all the archive 1, snooze 2, archive 3, snooze 4, archive 5"
      }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Last action changes:/);
    assert.match(response.json().reply, /Archived|Snoozed/);
    assert.doesNotMatch(response.json().reply, /email reviews/i);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: hygieneUserId } });
  }
});

test("action hygiene all-except replies handle missing snooze time and safe batch mutation", async () => {
  const server = buildServer();
  const hygieneUserId = `action-hygiene-except-${randomUUID()}`;
  const now = "2026-08-13T10:00:00+02:00";
  await prisma.user.create({ data: { id: hygieneUserId } });
  await prisma.notificationSettings.create({
    data: {
      userId: hygieneUserId,
      timezone: "Europe/Madrid",
      telegramUserId: "12345"
    }
  });
  const homepage = await prisma.actionItem.create({
    data: {
      userId: hygieneUserId,
      source: "manual",
      title: "Review homepage",
      priority: "medium",
      status: "open",
      dueAt: new Date("2026-08-01T07:00:00.000Z")
    }
  });
  const read = await prisma.actionItem.create({
    data: {
      userId: hygieneUserId,
      source: "manual",
      title: "Read 20 minutes on 3 days",
      priority: "medium",
      status: "open",
      dueAt: new Date("2026-08-02T07:00:00.000Z")
    }
  });
  const devJobs = await prisma.actionItem.create({
    data: {
      userId: hygieneUserId,
      source: "manual",
      title: "Apply to 3 developer jobs",
      priority: "medium",
      status: "open",
      dueAt: new Date("2026-08-03T07:00:00.000Z")
    }
  });

  try {
    await server.inject({
      method: "GET",
      url: `/users/${hygieneUserId}/actions/hygiene?now=${encodeURIComponent(now)}`
    });

    let response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: hygieneUserId, message: "archive all except the read 20 minutes that u can snooze" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /need a snooze time/i);
    assert.equal((await prisma.actionItem.findUniqueOrThrow({ where: { id: homepage.id } })).status, "open");
    assert.equal((await prisma.actionItem.findUniqueOrThrow({ where: { id: read.id } })).status, "open");

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: hygieneUserId, message: "archive all except the read 20 minutes, snooze that to tomorrow" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /I will:/);
    assert.match(response.json().reply, /archive Review homepage/);
    assert.match(response.json().reply, /snooze Read 20 minutes on 3 days/);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: hygieneUserId, message: "yes" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Done:/);
    assert.equal((await prisma.actionItem.findUniqueOrThrow({ where: { id: homepage.id } })).status, "archived");
    assert.equal((await prisma.actionItem.findUniqueOrThrow({ where: { id: read.id } })).status, "snoozed");
    assert.equal((await prisma.actionItem.findUniqueOrThrow({ where: { id: devJobs.id } })).status, "archived");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: hygieneUserId } });
  }
});

test("pending action target clarification accepts natural visible labels", async () => {
  const server = buildServer();
  const actionUserId = `action-choice-label-${randomUUID()}`;
  await prisma.user.create({ data: { id: actionUserId } });
  const devJobs = await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Apply to 3 developer jobs",
      priority: "medium",
      status: "open"
    }
  });
  const car = await prisma.actionItem.create({
    data: {
      userId: actionUserId,
      source: "manual",
      title: "Check cheap car listings",
      priority: "medium",
      status: "open"
    }
  });
  await prisma.pendingAction.create({
    data: {
      userId: actionUserId,
      type: "action_target_clarification",
      status: "pending",
      summary: "Clarify action target",
      payload: {
        intendedOperation: "archive_action",
        candidateActions: [
          { id: devJobs.id, title: devJobs.title, status: devJobs.status },
          { id: car.id, title: car.title, status: car.status }
        ]
      },
      expiresAt: new Date(Date.now() + 60 * 60 * 1000)
    }
  });

  try {
    const response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: actionUserId, message: "the dev jobs one" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Confirm archive action: Apply to 3 developer jobs/);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: actionUserId } });
  }
});

test("operator reflections are grounded, deduped, archived, and lightly shown in today", async () => {
  const server = buildServer();
  const reflectionUserId = `operator-reflection-${randomUUID()}`;
  const now = "2026-08-04T15:08:00+02:00";
  await prisma.user.create({ data: { id: reflectionUserId } });
  await prisma.notificationSettings.create({
    data: {
      userId: reflectionUserId,
      timezone: "Europe/Madrid",
      telegramUserId: "12345"
    }
  });
  const youtubeGoal = await prisma.goal.create({
    data: {
      userId: reflectionUserId,
      title: "Build a YouTube channel",
      category: "creative",
      priority: "medium",
      importanceScore: 25
    }
  });
  const jobGoal = await prisma.goal.create({
    data: {
      userId: reflectionUserId,
      title: "Find a new developer job",
      category: "career",
      templateId: "career.job_search",
      priority: "critical",
      importanceScore: 70
    }
  });
  await prisma.actionItem.create({
    data: {
      userId: reflectionUserId,
      source: "manual",
      title: "Write YouTube script",
      status: "open",
      priority: "medium",
      goalId: youtubeGoal.id,
      goalTitleSnapshot: youtubeGoal.title,
      dueAt: new Date("2026-08-01T14:30:00.000Z")
    }
  });
  await prisma.actionItem.create({
    data: {
      userId: reflectionUserId,
      source: "manual",
      title: "Draft YouTube outline",
      status: "snoozed",
      priority: "medium",
      goalId: youtubeGoal.id,
      goalTitleSnapshot: youtubeGoal.title,
      snoozedUntil: new Date("2026-08-05T07:00:00.000Z"),
      updatedAt: new Date("2026-08-03T12:00:00.000Z")
    }
  });
  await prisma.actionItem.create({
    data: {
      userId: reflectionUserId,
      source: "manual",
      title: "Edit YouTube intro",
      status: "snoozed",
      priority: "medium",
      goalId: youtubeGoal.id,
      goalTitleSnapshot: youtubeGoal.title,
      snoozedUntil: new Date("2026-08-05T07:00:00.000Z"),
      updatedAt: new Date("2026-08-03T13:00:00.000Z")
    }
  });
  await prisma.actionItem.create({
    data: {
      userId: reflectionUserId,
      source: "manual",
      title: "Send 2 CVs",
      status: "completed",
      priority: "medium",
      goalId: jobGoal.id,
      goalTitleSnapshot: jobGoal.title,
      completedAt: new Date("2026-08-04T09:00:00.000Z"),
      updatedAt: new Date("2026-08-04T09:00:00.000Z")
    }
  });
  await prisma.event.createMany({
    data: [
      {
        userId: reflectionUserId,
        type: "finance.betting.cooldown_triggered",
        timestamp: new Date("2026-08-03T10:00:00.000Z"),
        source: "manual",
        data: {},
        confidence: 1
      },
      {
        userId: reflectionUserId,
        type: "finance.betting.cooldown_triggered",
        timestamp: new Date("2026-08-04T10:00:00.000Z"),
        source: "manual",
        data: {},
        confidence: 1
      }
    ]
  });

  const originalEnv = {
    OPERATOR_REFLECTION_LLM_ENABLED: process.env.OPERATOR_REFLECTION_LLM_ENABLED,
    OPERATOR_REFLECTION_LLM_MOCK_RESPONSE: process.env.OPERATOR_REFLECTION_LLM_MOCK_RESPONSE
  };

  try {
    let response = await server.inject({
      method: "GET",
      url: `/users/${reflectionUserId}/reflections/context?now=${encodeURIComponent(now)}`
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().context.counts.overdueActions, 1);
    assert.equal(response.json().context.counts.snoozedOrRescheduledActions, 2);
    assert.equal(response.json().context.counts.guardrailTriggers, 2);
    assert.doesNotMatch(response.json().message, /accessToken|refreshToken|raw email/i);

    process.env.OPERATOR_REFLECTION_LLM_ENABLED = "true";
    process.env.OPERATOR_REFLECTION_LLM_MOCK_RESPONSE = "{bad json";
    response = await server.inject({
      method: "POST",
      url: `/users/${reflectionUserId}/reflections/generate?now=${encodeURIComponent(now)}`
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().message, /Operator reflections/);
    assert.ok(response.json().reflections.some((memory: { data?: { reflectionType?: string } }) => memory.data?.reflectionType === "stale_goal"));
    assert.ok(response.json().reflections.some((memory: { data?: { reflectionType?: string } }) => memory.data?.reflectionType === "friction"));
    assert.ok(response.json().reflections.some((memory: { data?: { reflectionType?: string } }) => memory.data?.reflectionType === "guardrail_pattern"));
    const initialCount = await prisma.memoryEntry.count({
      where: {
        userId: reflectionUserId,
        status: "active",
        data: { path: ["kind"], equals: "operator_reflection" }
      }
    });
    assert.ok(initialCount >= 3);

    response = await server.inject({
      method: "POST",
      url: `/users/${reflectionUserId}/reflections/generate?now=${encodeURIComponent(now)}`
    });
    assert.equal(response.statusCode, 200);
    const secondCount = await prisma.memoryEntry.count({
      where: {
        userId: reflectionUserId,
        status: "active",
        data: { path: ["kind"], equals: "operator_reflection" }
      }
    });
    assert.equal(secondCount, initialCount);

    response = await server.inject({
      method: "GET",
      url: `/users/${reflectionUserId}/reflections`
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().message, /Operator reflections/);

    response = await server.inject({
      method: "GET",
      url: `/users/${reflectionUserId}/today?now=${encodeURIComponent(now)}`
    });
    assert.equal(response.statusCode, 200);
    assert.equal(typeof response.json().brief.operatorReflection, "string");
    assert.equal((response.json().brief.operatorReflection.match(/\\n/g) ?? []).length, 0);

    response = await server.inject({
      method: "PATCH",
      url: `/users/${reflectionUserId}/reflections/1/archive`
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().reflection.status, "archived");

    const lowEvidenceUserId = `${reflectionUserId}-low`;
    await prisma.user.create({ data: { id: lowEvidenceUserId } });
    process.env.OPERATOR_REFLECTION_LLM_ENABLED = "true";
    process.env.OPERATOR_REFLECTION_LLM_MOCK_RESPONSE = JSON.stringify({
      candidates: [
        {
          type: "pattern",
          title: "Unsupported claim",
          summary: "The user is lazy.",
          evidence: {},
          confidence: 0.95
        }
      ]
    });
    response = await server.inject({
      method: "POST",
      url: `/users/${lowEvidenceUserId}/reflections/generate?now=${encodeURIComponent(now)}`
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().reflections.length, 0);
    await prisma.user.deleteMany({ where: { id: lowEvidenceUserId } });
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await server.close();
    await prisma.user.deleteMany({ where: { id: reflectionUserId } });
  }
});

test("weekly review builds grounded context, saves memory, falls back safely, and prompts only when due", async () => {
  const server = buildServer();
  const reviewUserId = `weekly-review-${randomUUID()}`;
  const promptUserId = `${reviewUserId}-prompt`;
  const now = "2026-08-09T20:00:00+02:00";
  const originalEnv = {
    WEEKLY_REVIEW_LLM_ENABLED: process.env.WEEKLY_REVIEW_LLM_ENABLED,
    WEEKLY_REVIEW_LLM_MOCK_RESPONSE: process.env.WEEKLY_REVIEW_LLM_MOCK_RESPONSE
  };

  try {
    await prisma.user.createMany({
      data: [{ id: reviewUserId }, { id: promptUserId }]
    });
    await prisma.notificationSettings.createMany({
      data: [
        { userId: reviewUserId, timezone: "Europe/Madrid", telegramUserId: "12345" },
        { userId: promptUserId, timezone: "Europe/Madrid", telegramUserId: "67890" }
      ]
    });
    const jobGoal = await prisma.goal.create({
      data: {
        userId: reviewUserId,
        title: "Find a new developer job",
        category: "career",
        templateId: "career.job_search",
        priority: "critical",
        importanceScore: 70
      }
    });
    await prisma.goal.create({
      data: {
        userId: reviewUserId,
        title: "Read more",
        category: "learning",
        templateId: "learning.reading_more",
        priority: "low",
        importanceScore: 10
      }
    });
    await prisma.actionItem.create({
      data: {
        userId: reviewUserId,
        source: "manual",
        title: "Send CV follow-up",
        status: "completed",
        priority: "medium",
        goalId: jobGoal.id,
        goalTitleSnapshot: jobGoal.title,
        completedAt: new Date("2026-08-05T09:00:00.000Z"),
        updatedAt: new Date("2026-08-05T09:00:00.000Z")
      }
    });
    await prisma.actionItem.create({
      data: {
        userId: reviewUserId,
        source: "manual",
        title: "Review stale homepage copy",
        status: "open",
        priority: "medium",
        dueAt: new Date("2026-08-04T07:00:00.000Z")
      }
    });
    await prisma.actionItem.create({
      data: {
        userId: reviewUserId,
        source: "manual",
        title: "Draft YouTube outline",
        status: "snoozed",
        priority: "medium",
        snoozedUntil: new Date("2026-08-10T07:00:00.000Z"),
        updatedAt: new Date("2026-08-06T12:00:00.000Z")
      }
    });
    await prisma.actionItem.create({
      data: {
        userId: reviewUserId,
        source: "manual",
        title: "Old test task",
        status: "archived",
        priority: "low",
        updatedAt: new Date("2026-08-07T12:00:00.000Z")
      }
    });
    await prisma.event.createMany({
      data: [
        {
          userId: reviewUserId,
          type: "career.application_sent",
          timestamp: new Date("2026-08-05T10:00:00.000Z"),
          source: "manual",
          data: { count: 2, goalId: jobGoal.id },
          confidence: 1
        },
        {
          userId: reviewUserId,
          type: "health.workout_completed",
          timestamp: new Date("2026-08-06T10:00:00.000Z"),
          source: "manual",
          data: { duration_minutes: 30 },
          confidence: 1
        },
        {
          userId: reviewUserId,
          type: "finance.betting.cooldown_triggered",
          timestamp: new Date("2026-08-07T10:00:00.000Z"),
          source: "system",
          data: { riskState: "RED" },
          confidence: 1
        },
        {
          userId: reviewUserId,
          type: "health.workout_completed",
          timestamp: new Date("2026-08-02T10:00:00.000Z"),
          source: "manual",
          data: { duration_minutes: 20 },
          confidence: 1
        }
      ]
    });
    await prisma.memoryEntry.create({
      data: {
        userId: reviewUserId,
        type: "pattern",
        summary: "You tend to recover momentum after a concrete first task.",
        data: {
          kind: "operator_reflection",
          title: "Concrete first task helps",
          type: "pattern",
          status: "active"
        },
        source: "system_inferred",
        confidence: 0.8
      }
    });
    await prisma.dailyLoopState.create({
      data: {
        userId: reviewUserId,
        localDate: "2026-08-05",
        timezone: "Europe/Madrid",
        morningBriefSentAt: new Date("2026-08-05T06:00:00.000Z"),
        eveningReviewCompletedAt: new Date("2026-08-05T20:00:00.000Z")
      }
    });

    let response = await server.inject({
      method: "GET",
      url: `/users/${reviewUserId}/weekly-review/context?now=${encodeURIComponent(now)}`
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().context.dateRange.start, "2026-08-03");
    assert.equal(response.json().context.dateRange.end, "2026-08-09");
    assert.equal(response.json().context.counts.completedActions, 1);
    assert.equal(response.json().context.counts.guardrailTriggers, 1);
    assert.equal(response.json().context.eventsByType["career.application_sent"], 1);
    assert.match(response.json().message, /active reflections: 1/);
    assert.doesNotMatch(response.json().message, /accessToken|refreshToken|raw provider/i);
    assert.equal(
      await prisma.memoryEntry.count({
        where: {
          userId: reviewUserId,
          data: {
            path: ["kind"],
            equals: "weekly_review"
          }
        }
      }),
      0
    );

    const beforeActionCount = await prisma.actionItem.count({ where: { userId: reviewUserId } });
    process.env.WEEKLY_REVIEW_LLM_ENABLED = "true";
    process.env.WEEKLY_REVIEW_LLM_MOCK_RESPONSE = "{bad json";
    response = await server.inject({
      method: "POST",
      url: `/users/${reviewUserId}/weekly-review`,
      payload: { now }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().review.source, "deterministic");
    assert.match(response.json().message, /Weekly review - 2026-08-03 to 2026-08-09/);
    assert.match(response.json().message, /Completed 1 action/);
    assert.match(response.json().message, /Concrete first task helps/);
    assert.ok(response.json().review.recommendedNextWeekActions.length <= 3);
    assert.equal(await prisma.actionItem.count({ where: { userId: reviewUserId } }), beforeActionCount);

    const weeklyMemoryCount = await prisma.memoryEntry.count({
      where: {
        userId: reviewUserId,
        status: "active",
        data: {
          path: ["kind"],
          equals: "weekly_review"
        }
      }
    });
    assert.equal(weeklyMemoryCount, 1);

    process.env.WEEKLY_REVIEW_LLM_MOCK_RESPONSE = JSON.stringify({
      summary: "The user is lazy and should be diagnosed.",
      wins: [],
      stalls: [],
      recommendedNextWeekActions: ["Diagnose the user."]
    });
    response = await server.inject({
      method: "POST",
      url: `/users/${reviewUserId}/weekly-review`,
      payload: { now }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().review.source, "deterministic");
    assert.doesNotMatch(response.json().review.summary, /lazy|diagnosed/i);

    response = await server.inject({
      method: "POST",
      url: `/users/${reviewUserId}/weekly-review`,
      payload: { now, force: true }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().review.source, "deterministic");
    assert.equal(
      await prisma.memoryEntry.count({
        where: {
          userId: reviewUserId,
          status: "active",
          data: {
            path: ["kind"],
            equals: "weekly_review"
          }
        }
      }),
      1
    );

    response = await server.inject({
      method: "GET",
      url: `/users/${reviewUserId}/weekly-review/last`
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().message, /Weekly review - 2026-08-03 to 2026-08-09/);

    response = await server.inject({
      method: "GET",
      url: `/users/${promptUserId}/today?now=${encodeURIComponent(now)}`
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().brief.weeklyReviewDue, true);

    response = await server.inject({
      method: "GET",
      url: `/users/${promptUserId}/today?now=${encodeURIComponent("2026-08-04T15:00:00+02:00")}`
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().brief.weeklyReviewDue, false);
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    await server.close();
    await prisma.user.deleteMany({ where: { id: { in: [reviewUserId, promptUserId] } } });
  }
});

test("weekly review uses week-to-date range and separates risk-control goals", async () => {
  const server = buildServer();
  const reviewUserId = `weekly-review-midweek-${randomUUID()}`;
  const now = "2026-08-06T15:20:00+02:00";

  try {
    await prisma.user.create({ data: { id: reviewUserId } });
    await prisma.notificationSettings.create({
      data: {
        userId: reviewUserId,
        timezone: "Europe/Madrid",
        telegramUserId: "12345"
      }
    });
    const healthGoal = await prisma.goal.create({
      data: {
        userId: reviewUserId,
        title: "Improve strength and energy",
        category: "health",
        templateId: "health.strength_energy",
        priority: "high",
        importanceScore: 45
      }
    });
    await prisma.goal.create({
      data: {
        userId: reviewUserId,
        title: "Control impulsive betting",
        category: "finance",
        templateId: "finance.control_betting_trading",
        priority: "critical",
        importanceScore: 70
      }
    });
    await prisma.goal.create({
      data: {
        userId: reviewUserId,
        title: "Read more",
        category: "learning",
        templateId: "learning.reading_more",
        priority: "low",
        importanceScore: 10
      }
    });
    await prisma.actionItem.create({
      data: {
        userId: reviewUserId,
        source: "manual",
        title: "Train legs",
        status: "completed",
        priority: "medium",
        goalId: healthGoal.id,
        goalTitleSnapshot: healthGoal.title,
        completedAt: new Date("2026-08-06T08:00:00.000Z"),
        updatedAt: new Date("2026-08-06T08:00:00.000Z")
      }
    });
    await prisma.actionItem.create({
      data: {
        userId: reviewUserId,
        source: "manual",
        title: "Future task",
        status: "open",
        priority: "medium",
        dueAt: new Date("2026-08-08T07:00:00.000Z")
      }
    });
    await prisma.event.createMany({
      data: [
        {
          userId: reviewUserId,
          type: "health.workout_completed",
          timestamp: new Date("2026-08-06T08:30:00.000Z"),
          source: "manual",
          data: { duration_minutes: 30, goalId: healthGoal.id },
          confidence: 1
        },
        {
          userId: reviewUserId,
          type: "career.application_sent",
          timestamp: new Date("2026-08-08T08:30:00.000Z"),
          source: "manual",
          data: { count: 1 },
          confidence: 1
        }
      ]
    });

    let response = await server.inject({
      method: "GET",
      url: `/users/${reviewUserId}/weekly-review/context?now=${encodeURIComponent(now)}`
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().context.weekWindow.start, "2026-08-03");
    assert.equal(response.json().context.weekWindow.end, "2026-08-09");
    assert.equal(response.json().context.reviewedRange.start, "2026-08-03");
    assert.equal(response.json().context.reviewedRange.end, "2026-08-06");
    assert.match(response.json().message, /weekWindow: 2026-08-03 to 2026-08-09/);
    assert.match(response.json().message, /reviewedRange: 2026-08-03 to 2026-08-06/);
    assert.equal(response.json().context.counts.completedActions, 1);
    assert.equal(response.json().context.counts.openActions, 0);
    assert.equal(response.json().context.eventsByType["health.workout_completed"], 1);
    assert.equal(response.json().context.eventsByType["career.application_sent"], undefined);

    response = await server.inject({
      method: "POST",
      url: `/users/${reviewUserId}/weekly-review`,
      payload: { now }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().message, /Weekly review so far - 2026-08-03 to 2026-08-06/);
    assert.doesNotMatch(response.json().message, /2026-08-09/);
    assert.match(response.json().message, /Progress logged for Improve strength and energy/);
    assert.doesNotMatch(response.json().message, /Moved goal/);
    assert.match(response.json().message, /Goals with no progress: Read more/);
    assert.doesNotMatch(response.json().message, /Goals with no progress:.*Control impulsive betting/);
    assert.match(response.json().message, /Control impulsive betting: no guardrail triggers logged this reviewed period/);
    assert.match(response.json().message, /Next: say 'plan next week' to turn this into actions\./);

    response = await server.inject({
      method: "POST",
      url: `/users/${reviewUserId}/weekly-review`,
      payload: { now, force: true }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().message, /Weekly review so far - 2026-08-03 to 2026-08-06/);

    response = await server.inject({
      method: "GET",
      url: `/users/${reviewUserId}/weekly-review/last`
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().message, /Weekly review so far - 2026-08-03 to 2026-08-06/);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: reviewUserId } });
  }
});

test("next-week plan proposes confirmed goal-linked actions and creates selected items only", async () => {
  const server = buildServer();
  const planUserId = `next-week-plan-${randomUUID()}`;
  const now = "2026-08-06T13:20:00.000Z";

  try {
    await prisma.user.upsert({
      where: { id: planUserId },
      update: {},
      create: { id: planUserId }
    });

    const jobGoal = await prisma.goal.create({
      data: {
        userId: planUserId,
        title: "Find a new developer job",
        category: "career",
        templateId: "career.job_search",
        priority: "critical",
        importanceScore: 70
      }
    });
    await prisma.goal.create({
      data: {
        userId: planUserId,
        title: "Build a YouTube channel",
        category: "creative",
        priority: "high",
        importanceScore: 45
      }
    });
    await prisma.goal.create({
      data: {
        userId: planUserId,
        title: "Control impulsive betting",
        category: "finance",
        templateId: "finance.control_betting_trading",
        priority: "critical",
        importanceScore: 70
      }
    });

    let response = await server.inject({
      method: "POST",
      url: `/users/${planUserId}/next-week-plan`,
      payload: { now }
    });

    assert.equal(response.statusCode, 200);
    const payload = response.json();
    assert.match(payload.message, /Next week plan/);
    assert.match(payload.message, /Planning window: 2026-08-10 to 2026-08-16/);
    assert.match(payload.message, /Needs cleanup:/);
    assert.match(payload.message, /Already scheduled:/);
    assert.match(payload.message, /Suggested new actions:/);
    assert.match(payload.message, /Apply to 3 developer jobs - action priority: high - goal priority: critical/);
    assert.ok(payload.suggestions.length >= 3);
    assert.ok(payload.suggestions.length <= 7);
    assert.ok(payload.suggestions.some((suggestion: { title: string; goalId?: string; priority?: string; actionPriority?: string }) =>
      suggestion.title === "Apply to 3 developer jobs" &&
      suggestion.goalId === jobGoal.id &&
      suggestion.priority === "critical" &&
      suggestion.actionPriority === "high"
    ));
    assert.ok(payload.suggestions.every((suggestion: { title: string }) => !/place|open|20x|leverage/i.test(suggestion.title)));
    assert.equal(await prisma.actionItem.count({ where: { userId: planUserId } }), 0);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: {
        userId: planUserId,
        message: "create 1"
      }
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Created actions:/);

    const actions = await prisma.actionItem.findMany({ where: { userId: planUserId } });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].source, "system");
    assert.equal(actions[0].sourceProvider, "weekly_plan");
    assert.equal(actions[0].goalId, jobGoal.id);
    assert.equal(actions[0].priority, "high");
    assert.ok(actions[0].dueAt);
    assert.ok(actions[0].dueAt! >= new Date("2026-08-09T22:00:00.000Z"));
    assert.ok(actions[0].dueAt! < new Date("2026-08-16T22:00:00.000Z"));
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: planUserId } });
  }
});

test("next-week plan edit and create multiple selected suggestions", async () => {
  const server = buildServer();
  const planUserId = `next-week-plan-edit-${randomUUID()}`;

  try {
    await prisma.user.upsert({
      where: { id: planUserId },
      update: {},
      create: { id: planUserId }
    });
    await prisma.goal.createMany({
      data: [
        {
          userId: planUserId,
          title: "Find a new developer job",
          category: "career",
          templateId: "career.job_search",
          priority: "critical",
          importanceScore: 70
        },
        {
          userId: planUserId,
          title: "Build a YouTube channel",
          category: "creative",
          priority: "high",
          importanceScore: 45
        }
      ]
    });

    let response = await server.inject({
      method: "POST",
      url: `/users/${planUserId}/next-week-plan`,
      payload: { now: "2026-08-06T13:20:00.000Z" }
    });
    assert.equal(response.statusCode, 200);

    response = await server.inject({
      method: "POST",
      url: `/users/${planUserId}/next-week-plan/reply`,
      payload: { message: "edit 2 to Friday morning" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().message, /Updated suggestion 2/);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: {
        userId: planUserId,
        message: "create 1 and 2"
      }
    });
    assert.equal(response.statusCode, 200);

    const actions = await prisma.actionItem.findMany({
      where: { userId: planUserId, sourceProvider: "weekly_plan" },
      orderBy: { title: "asc" }
    });
    assert.equal(actions.length, 2);
    assert.ok(actions.every((action) => action.goalId));
    assert.ok(actions.every((action) => action.dueAt && action.dueAt >= new Date("2026-08-09T22:00:00.000Z") && action.dueAt < new Date("2026-08-16T22:00:00.000Z")));
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: planUserId } });
  }
});

test("next-week plan shows stale cleanup as non-creatable and skips it on create", async () => {
  const server = buildServer();
  const planUserId = `next-week-plan-cleanup-${randomUUID()}`;

  try {
    await prisma.user.upsert({
      where: { id: planUserId },
      update: {},
      create: { id: planUserId }
    });
    await prisma.goal.createMany({
      data: [
        {
          userId: planUserId,
          title: "Find a new developer job",
          category: "career",
          templateId: "career.job_search",
          priority: "critical",
          importanceScore: 70
        },
        {
          userId: planUserId,
          title: "Build a YouTube channel",
          category: "creative",
          priority: "high",
          importanceScore: 45
        }
      ]
    });
    await prisma.actionItem.create({
      data: {
        userId: planUserId,
        source: "manual",
        title: "Write YouTube script",
        status: "open",
        priority: "medium",
        dueAt: new Date("2026-08-01T14:30:00.000Z"),
        actionType: "deadline",
        evidence: "write youtube script"
      }
    });

    let response = await server.inject({
      method: "POST",
      url: `/users/${planUserId}/next-week-plan`,
      payload: { now: "2026-08-07T10:00:00+02:00" }
    });

    assert.equal(response.statusCode, 200);
    const plan = response.json();
    assert.match(plan.message, /Resolve stale action: Write YouTube script/);
    assert.match(plan.message, /cleanup - already open - not creatable/);
    assert.match(plan.message, /Not creatable: .*\/action_hygiene/);
    assert.equal(plan.suggestions[0].title, "Resolve stale action: Write YouTube script");
    assert.equal(plan.suggestions[0].creatable, false);
    assert.equal(plan.suggestions[0].planKind, "cleanup");

    response = await server.inject({
      method: "POST",
      url: `/users/${planUserId}/next-week-plan/reply`,
      payload: { message: "edit 1 to Friday morning" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().message, /Suggestion 1 is cleanup for an existing action/);
    assert.match(response.json().message, /I did not move it/);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: {
        userId: planUserId,
        message: "create 1 and 2"
      }
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Skipped:/);
    assert.match(response.json().reply, /Resolve stale action: Write YouTube script is already an open action/);
    assert.match(response.json().reply, /Created actions:/);
    assert.match(response.json().reply, /Apply to 3 developer jobs/);

    const actions = await prisma.actionItem.findMany({
      where: { userId: planUserId },
      orderBy: { createdAt: "asc" }
    });
    assert.equal(actions.filter((action) => action.sourceProvider === "weekly_plan").length, 1);
    assert.equal(actions.filter((action) => action.title === "Write YouTube script").length, 1);
    assert.equal(actions.some((action) => /^Decide:|^Resolve stale action:/i.test(action.title)), false);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: planUserId } });
  }
});

test("next-week plan create all skips cleanup suggestions without creating meta actions", async () => {
  const server = buildServer();
  const planUserId = `next-week-plan-cleanup-all-${randomUUID()}`;

  try {
    await prisma.user.upsert({
      where: { id: planUserId },
      update: {},
      create: { id: planUserId }
    });
    await prisma.goal.createMany({
      data: [
        {
          userId: planUserId,
          title: "Find a new developer job",
          category: "career",
          templateId: "career.job_search",
          priority: "critical",
          importanceScore: 70
        },
        {
          userId: planUserId,
          title: "Build a YouTube channel",
          category: "creative",
          priority: "high",
          importanceScore: 45
        }
      ]
    });
    await prisma.actionItem.create({
      data: {
        userId: planUserId,
        source: "manual",
        title: "Review homepage",
        status: "open",
        priority: "medium",
        dueAt: new Date("2026-08-05T07:00:00.000Z"),
        actionType: "deadline",
        project: "homepage",
        evidence: "review homepage"
      }
    });

    let response = await server.inject({
      method: "POST",
      url: `/users/${planUserId}/next-week-plan`,
      payload: { now: "2026-08-07T10:00:00+02:00" }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().suggestions[0].creatable, false);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: {
        userId: planUserId,
        message: "create all"
      }
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Skipped:/);
    assert.doesNotMatch(response.json().reply, /No actions created/);

    const actions = await prisma.actionItem.findMany({ where: { userId: planUserId } });
    assert.equal(actions.some((action) => /^Decide:|^Resolve stale action:/i.test(action.title)), false);
    assert.equal(actions.filter((action) => action.sourceProvider === "weekly_plan").length > 0, true);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: planUserId } });
  }
});

test("next-week plan treats guardrail review aliases as already covered", async () => {
  const server = buildServer();
  const planUserId = `next-week-plan-guardrail-alias-${randomUUID()}`;

  try {
    await prisma.user.upsert({
      where: { id: planUserId },
      update: {},
      create: { id: planUserId }
    });
    await prisma.goal.createMany({
      data: [
        {
          userId: planUserId,
          title: "Find a new developer job",
          category: "career",
          templateId: "career.job_search",
          priority: "critical",
          importanceScore: 70
        },
        {
          userId: planUserId,
          title: "Control impulsive betting",
          category: "finance",
          templateId: "finance.control_betting_trading",
          priority: "critical",
          importanceScore: 70
        }
      ]
    });
    await prisma.actionItem.create({
      data: {
        userId: planUserId,
        source: "system",
        sourceProvider: "weekly_plan",
        title: "Review Control impulsive betting guardrail rules",
        status: "open",
        priority: "high",
        dueAt: new Date("2026-08-16T16:00:00.000Z"),
        actionType: "generic",
        evidence: "old guardrail review title"
      }
    });

    let response = await server.inject({
      method: "POST",
      url: `/users/${planUserId}/next-week-plan`,
      payload: { now: "2026-08-06T13:20:00.000Z" }
    });

    assert.equal(response.statusCode, 200);
    const plan = response.json();
    const guardrailSuggestion = plan.suggestions.find((suggestion: { title: string }) => suggestion.title === "Review betting/trading guardrail rules");
    assert.ok(guardrailSuggestion);
    assert.equal(guardrailSuggestion.duplicateRisk, true);
    assert.equal(guardrailSuggestion.existingActionTitle, "Review Control impulsive betting guardrail rules");
    assert.match(plan.message, /Already scheduled:/);
    assert.match(plan.message, /Review betting\/trading guardrail rules .*already covered/);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: {
        userId: planUserId,
        message: "create all new"
      }
    });

    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Already covered:/);
    assert.match(response.json().reply, /Review betting\/trading guardrail rules \(Review Control impulsive betting guardrail rules\)/);

    const guardrailActions = await prisma.actionItem.findMany({
      where: {
        userId: planUserId,
        title: {
          contains: "guardrail rules"
        }
      }
    });
    assert.equal(guardrailActions.length, 1);
    assert.equal(guardrailActions[0].title, "Review Control impulsive betting guardrail rules");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: planUserId } });
  }
});

test("next-week plan reply examples only include creatable suggestion indexes", async () => {
  const server = buildServer();
  const planUserId = `next-week-plan-reply-examples-${randomUUID()}`;

  try {
    await prisma.user.upsert({
      where: { id: planUserId },
      update: {},
      create: { id: planUserId }
    });
    const jobGoal = await prisma.goal.create({
      data: {
        userId: planUserId,
        title: "Find a new developer job",
        category: "career",
        templateId: "career.job_search",
        priority: "critical",
        importanceScore: 70
      }
    });
    await prisma.goal.create({
      data: {
        userId: planUserId,
        title: "Build a YouTube channel",
        category: "creative",
        priority: "high",
        importanceScore: 45
      }
    });
    await prisma.actionItem.createMany({
      data: [
        {
          userId: planUserId,
          source: "manual",
          title: "Review homepage",
          status: "open",
          priority: "medium",
          dueAt: new Date("2026-08-01T07:00:00.000Z"),
          actionType: "deadline",
          project: "homepage",
          evidence: "review homepage"
        },
        {
          userId: planUserId,
          source: "manual",
          goalId: jobGoal.id,
          goalTitleSnapshot: jobGoal.title,
          title: "Apply to 3 developer jobs",
          status: "open",
          priority: "medium",
          dueAt: new Date("2026-08-11T07:00:00.000Z"),
          actionType: "deadline",
          evidence: "existing future action"
        }
      ]
    });

    const response = await server.inject({
      method: "POST",
      url: `/users/${planUserId}/next-week-plan`,
      payload: { now: "2026-08-07T10:00:00+02:00" }
    });

    assert.equal(response.statusCode, 200);
    const message = response.json().message as string;
    assert.match(message, /1\. Resolve stale action: Review homepage/);
    assert.match(message, /2\. Apply to 3 developer jobs .*already covered/);
    assert.match(message, /3\. Write 5 bullets for the YouTube script/);
    assert.match(message, /- create 3/);
    assert.match(message, /- edit 3 to Friday morning/);
    assert.doesNotMatch(message, /- create 1\b/);
    assert.doesNotMatch(message, /- edit 1 to Friday morning/);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: planUserId } });
  }
});

test("next-week plan with no creatable suggestions says nothing new to create", async () => {
  const server = buildServer();
  const planUserId = `next-week-plan-no-new-${randomUUID()}`;

  try {
    await prisma.user.upsert({
      where: { id: planUserId },
      update: {},
      create: { id: planUserId }
    });
    await prisma.goal.create({
      data: {
        userId: planUserId,
        title: "Control impulsive betting",
        category: "finance",
        templateId: "finance.control_betting_trading",
        priority: "critical",
        importanceScore: 70
      }
    });
    await prisma.actionItem.createMany({
      data: [
        {
          userId: planUserId,
          source: "system",
          sourceProvider: "weekly_plan",
          title: "Review Control impulsive betting guardrail rules",
          status: "open",
          priority: "high",
          dueAt: new Date("2026-08-16T16:00:00.000Z"),
          actionType: "generic",
          evidence: "old guardrail review title"
        },
        {
          userId: planUserId,
          source: "system",
          sourceProvider: "weekly_plan",
          title: "Review open actions and pick one to finish",
          status: "open",
          priority: "medium",
          dueAt: new Date("2026-08-10T07:00:00.000Z"),
          actionType: "generic",
          evidence: "existing fallback"
        },
        {
          userId: planUserId,
          source: "system",
          sourceProvider: "weekly_plan",
          title: "Log one meaningful progress action",
          status: "open",
          priority: "medium",
          dueAt: new Date("2026-08-12T14:30:00.000Z"),
          actionType: "generic",
          evidence: "existing fallback"
        },
        {
          userId: planUserId,
          source: "system",
          sourceProvider: "weekly_plan",
          title: "Run weekly review before Sunday night",
          status: "open",
          priority: "low",
          dueAt: new Date("2026-08-16T16:00:00.000Z"),
          actionType: "generic",
          evidence: "existing fallback"
        }
      ]
    });

    const response = await server.inject({
      method: "POST",
      url: `/users/${planUserId}/next-week-plan`,
      payload: { now: "2026-08-06T13:20:00.000Z" }
    });

    assert.equal(response.statusCode, 200);
    const message = response.json().message as string;
    assert.match(message, /Nothing new to create\./);
    assert.match(message, /\/action_hygiene|what should I do today/);
    assert.doesNotMatch(message, /- create \d+/);
    assert.doesNotMatch(message, /- edit \d+ to Friday morning/);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: planUserId } });
  }
});

test("natural planning routes this-week, next-week, ambiguous, and create all new safely", async () => {
  const server = buildServer();
  const planUserId = `planning-ux-${randomUUID()}`;

  const send = async (message: string) => {
    const response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: planUserId, message }
    });
    assert.equal(response.statusCode, 200);
    return response.json().reply as string;
  };

  try {
    await prisma.user.upsert({
      where: { id: planUserId },
      update: {},
      create: { id: planUserId }
    });
    await prisma.goal.createMany({
      data: [
        {
          userId: planUserId,
          title: "Find a new developer job",
          category: "career",
          templateId: "career.job_search",
          priority: "critical",
          importanceScore: 70
        },
        {
          userId: planUserId,
          title: "Build a YouTube channel",
          category: "creative",
          priority: "high",
          importanceScore: 45
        }
      ]
    });

    let reply = await send("make a plan");
    assert.match(reply, /Do you mean this week or next week\?/);
    assert.equal(await prisma.pendingAction.count({ where: { userId: planUserId, type: "next_week_plan" } }), 0);

    reply = await send("plan this week");
    assert.match(reply, /This week plan/);
    assert.match(reply, /Planning window:/);
    assert.match(reply, /Suggested new actions:/);
    assert.equal(await prisma.actionItem.count({ where: { userId: planUserId } }), 0);

    reply = await send("create all new");
    assert.match(reply, /Created actions:/);
    const currentWeekActions = await prisma.actionItem.count({ where: { userId: planUserId, sourceProvider: "weekly_plan" } });
    assert.ok(currentWeekActions > 0);

    reply = await send("plan next week");
    assert.match(reply, /Next week plan/);
    assert.match(reply, /Planning window:/);

    reply = await send("I need a plan to bet safely next week");
    assert.match(reply, /RED|cooldown|No betting|blocked|guardrail/i);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: planUserId } });
  }
});

test("next-week plan skips, debugs without side effects, dedupes future actions, and falls back on invalid LLM JSON", async () => {
  const server = buildServer();
  const planUserId = `next-week-plan-dedupe-${randomUUID()}`;
  const previousEnabled = process.env.NEXT_WEEK_PLAN_LLM_ENABLED;
  const previousMock = process.env.NEXT_WEEK_PLAN_LLM_MOCK_RESPONSE;

  try {
    await prisma.user.upsert({
      where: { id: planUserId },
      update: {},
      create: { id: planUserId }
    });
    const jobGoal = await prisma.goal.create({
      data: {
        userId: planUserId,
        title: "Find a new developer job",
        category: "career",
        templateId: "career.job_search",
        priority: "critical",
        importanceScore: 70
      }
    });
    await prisma.actionItem.create({
      data: {
        userId: planUserId,
        source: "manual",
        goalId: jobGoal.id,
        goalTitleSnapshot: jobGoal.title,
        title: "Apply to 3 developer jobs",
        status: "open",
        priority: "medium",
        dueAt: new Date("2026-08-11T07:00:00.000Z"),
        actionType: "deadline",
        evidence: "existing future action"
      }
    });

    let response = await server.inject({
      method: "GET",
      url: `/users/${planUserId}/next-week-plan/context?now=${encodeURIComponent("2026-08-06T13:20:00.000Z")}`
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().message, /future actions already scheduled: 1/);
    assert.equal(await prisma.pendingAction.count({ where: { userId: planUserId, type: "next_week_plan" } }), 0);

    process.env.NEXT_WEEK_PLAN_LLM_ENABLED = "true";
    process.env.NEXT_WEEK_PLAN_LLM_MOCK_RESPONSE = "{bad json";

    response = await server.inject({
      method: "POST",
      url: `/users/${planUserId}/next-week-plan`,
      payload: { now: "2026-08-06T13:20:00.000Z" }
    });

    assert.equal(response.statusCode, 200);
    assert.ok(response.json().suggestions.length >= 3);
    const duplicateSuggestion = response.json().suggestions.find((suggestion: { title: string; duplicateRisk: boolean }) => suggestion.title === "Apply to 3 developer jobs" && suggestion.duplicateRisk);
    assert.ok(duplicateSuggestion);

    response = await server.inject({
      method: "POST",
      url: `/users/${planUserId}/next-week-plan/reply`,
      payload: { message: `edit ${duplicateSuggestion.index} to Friday morning` }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(
      response.json().message,
      "Suggestion 1 is already covered by an existing action. I did not move it. To move the existing action, say: move Apply to 3 developer jobs to Friday morning."
    );

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: {
        userId: planUserId,
        message: "create all"
      }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Already covered:/);

    const duplicateCount = await prisma.actionItem.count({
      where: {
        userId: planUserId,
        title: "Apply to 3 developer jobs"
      }
    });
    assert.equal(duplicateCount, 1);

    response = await server.inject({
      method: "POST",
      url: `/users/${planUserId}/next-week-plan`,
      payload: { now: "2026-08-06T13:20:00.000Z" }
    });
    assert.equal(response.statusCode, 200);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: {
        userId: planUserId,
        message: "skip"
      }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Skipped next-week plan/);
  } finally {
    if (previousEnabled === undefined) {
      delete process.env.NEXT_WEEK_PLAN_LLM_ENABLED;
    } else {
      process.env.NEXT_WEEK_PLAN_LLM_ENABLED = previousEnabled;
    }
    if (previousMock === undefined) {
      delete process.env.NEXT_WEEK_PLAN_LLM_MOCK_RESPONSE;
    } else {
      process.env.NEXT_WEEK_PLAN_LLM_MOCK_RESPONSE = previousMock;
    }
    await server.close();
    await prisma.user.deleteMany({ where: { id: planUserId } });
  }
});

test("operator attention surfaces pending Gmail reviews in conversation, today, weekly, and planning without creating fake tasks", async () => {
  const server = buildServer();
  const operatorUserId = `operator-attention-email-${randomUUID()}`;
  const now = "2026-08-13T10:00:00.000Z";

  try {
    await server.ready();
    await prisma.user.create({ data: { id: operatorUserId } });
    const goal = await prisma.goal.create({
      data: {
        userId: operatorUserId,
        title: "Find a new developer job",
        category: "career",
        templateId: "career.job_search",
        priority: "critical",
        importanceScore: 70
      }
    });
    const connection = await prisma.integrationConnection.create({
      data: {
        userId: operatorUserId,
        integrationId: "gmail",
        status: "active",
        config: {
          provider: "gmail",
          scope: "gmail.readonly",
          email: "operator@example.com",
          hasRefreshToken: true,
          gmailAutonomy: {
            syncMode: "manual_only",
            reviewNotificationEnabled: true
          }
        }
      }
    });
    const workRule = await prisma.emailSignalRule.create({
      data: {
        userId: operatorUserId,
        connectionId: connection.id,
        adapterId: "work_action_email",
        name: "Work action emails",
        query: "newer_than:7d \"can you review\"",
        status: "active",
        fetchStrategy: "query",
        lookbackDays: 7,
        maxMessagesPerSync: 25,
        maxEventsPerSync: 5,
        classifierMode: "hybrid",
        minAutoLogConfidence: 0.9,
        minReviewConfidence: 0.65,
        reviewBeforeLogging: true,
        createdBy: "user"
      }
    });
    const customRule = await prisma.emailSignalRule.create({
      data: {
        userId: operatorUserId,
        connectionId: connection.id,
        adapterId: "custom_email_review",
        name: "Endesa emails",
        query: "Endesa",
        status: "active",
        fetchStrategy: "query",
        lookbackDays: 30,
        maxMessagesPerSync: 25,
        maxEventsPerSync: 5,
        classifierMode: "rules",
        minAutoLogConfidence: 0.9,
        minReviewConfidence: 0.65,
        reviewBeforeLogging: true,
        createdBy: "user"
      }
    });
    await prisma.emailReviewItem.createMany({
      data: [
        {
          userId: operatorUserId,
          connectionId: connection.id,
          ruleId: workRule.id,
          adapterId: "work_action_email",
          provider: "gmail",
          providerMessageId: randomUUID(),
          externalId: `gmail-review:${workRule.id}:${randomUUID()}`,
          subject: "Dashboard review",
          from: "Client <client@example.com>",
          snippet: "Can you review the dashboard today?",
          evidence: "Can you review the dashboard today?",
          proposedEventType: "work_action_required",
          confidence: 0.86,
          reason: "Work action requires review.",
          extracted: { project: "dashboard" },
          status: "pending",
          createdAt: new Date("2026-08-13T08:00:00.000Z")
        },
        {
          userId: operatorUserId,
          connectionId: connection.id,
          ruleId: customRule.id,
          adapterId: "custom_email_review",
          provider: "gmail",
          providerMessageId: randomUUID(),
          externalId: `gmail-review:${customRule.id}:${randomUUID()}`,
          subject: "Endesa factura",
          from: "Endesa <billing@endesa.example>",
          snippet: "Factura disponible.",
          evidence: "Factura disponible.",
          proposedEventType: "custom_email_review",
          confidence: 0.78,
          reason: "Custom tracking match.",
          extracted: { customRuleName: "Endesa emails" },
          status: "pending",
          createdAt: new Date("2026-08-13T08:05:00.000Z")
        }
      ]
    });
    await prisma.emailReviewItem.create({
      data: {
        userId: operatorUserId,
        connectionId: connection.id,
        ruleId: workRule.id,
        adapterId: "work_action_email",
        provider: "gmail",
        providerMessageId: randomUUID(),
        externalId: `gmail-review:${workRule.id}:${randomUUID()}`,
        subject: "Approved work email",
        from: "Client <client@example.com>",
        snippet: "Handled.",
        evidence: "Handled.",
        proposedEventType: "work_action_required",
        confidence: 0.9,
        reason: "Approved work action.",
        extracted: { project: "dashboard" },
        status: "approved",
        reviewedAt: new Date("2026-08-13T08:15:00.000Z"),
        createdAt: new Date("2026-08-13T07:55:00.000Z")
      }
    });
    await prisma.actionItem.create({
      data: {
        userId: operatorUserId,
        source: "email_review",
        sourceId: "approved-review",
        sourceProvider: "gmail",
        sourceRuleId: workRule.id,
        title: "Review dashboard",
        status: "completed",
        priority: "medium",
        goalId: goal.id,
        goalTitleSnapshot: goal.title,
        completedAt: new Date("2026-08-13T08:20:00.000Z"),
        createdAt: new Date("2026-08-13T08:16:00.000Z"),
        actionType: "work_action_required",
        evidence: "Approved Gmail review."
      }
    });
    await prisma.event.create({
      data: {
        userId: operatorUserId,
        type: "career.recruiter_reply_received",
        timestamp: new Date("2026-08-13T08:30:00.000Z"),
        source: "gmail",
        provider: "gmail",
        data: { goalId: goal.id, provider: "gmail", ruleId: workRule.id },
        confidence: 0.9,
        evidence: { subject: "Recruiter reply" }
      }
    });

    let response = await server.inject({
      method: "GET",
      url: `/users/${operatorUserId}/operator-attention?now=${encodeURIComponent(now)}`
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().attention.emailAttentionSummary.pendingCount, 2);
    assert.equal(response.json().attention.emailAttentionSummary.workActionCount, 1);
    assert.equal(response.json().attention.emailAttentionSummary.customCount, 1);
    assert.match(response.json().attention.recommendedNextMove, /work-action Gmail review|Gmail reviews/i);
    assert.doesNotMatch(JSON.stringify(response.json()), /accessToken|refreshToken|ciphertext|"iv"|"tag"|raw provider/i);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: operatorUserId, message: "anything important?" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /What needs attention/);
    assert.match(response.json().reply, /Gmail review/);
    assert.equal(response.json().routeDebug.intent, "operator_attention_query");
    assert.equal(await prisma.actionItem.count({ where: { userId: operatorUserId, status: "open" } }), 0);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: operatorUserId, message: "what emails need action?" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /2 Gmail reviews need attention/);
    assert.match(response.json().reply, /work-action email/);
    assert.match(response.json().reply, /custom tracking item/);
    assert.match(response.json().reply, /Alecto cannot reply to emails or change Gmail labels/);
    assert.equal(response.json().routeDebug.intent, "email_attention_query");
    assert.doesNotMatch(response.json().reply, /work_action_email|custom_email_review|accessToken|refreshToken|ciphertext|"iv"|"tag"/i);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: operatorUserId, message: "hay correos importantes de Gmail?" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /2 Gmail reviews need attention/);
    assert.equal(response.json().routeDebug.intent, "email_attention_query");

    response = await server.inject({
      method: "GET",
      url: `/users/${operatorUserId}/today?now=${encodeURIComponent(now)}`
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().brief.summary, /2 Gmail reviews waiting/);
    assert.ok(response.json().brief.topPriorities.some((line: string) => /Gmail reviews/.test(line)));
    assert.match(response.json().brief.suggestedNextStep, /work-action Gmail review|Gmail reviews/i);

    response = await server.inject({
      method: "POST",
      url: `/users/${operatorUserId}/weekly-review`,
      payload: { now, force: true }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().message, /Email signals:/);
    assert.match(response.json().message, /3 Gmail reviews? created|3 Gmail review/);
    assert.match(response.json().message, /2 Gmail reviews still waiting/);
    assert.equal(response.json().review.emailAttention.pendingReviews, 2);

    response = await server.inject({
      method: "GET",
      url: `/users/${operatorUserId}/weekly-review/context?now=${encodeURIComponent(now)}`
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().context.counts.gmailReviewsPending, 2);
    assert.match(response.json().message, /Gmail reviews pending: 2/);

    response = await server.inject({
      method: "POST",
      url: `/users/${operatorUserId}/next-week-plan`,
      payload: { now }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().message, /Clear pending Gmail reviews/);
    assert.match(response.json().message, /not creatable/i);
    const gmailCleanup = response.json().suggestions.find((suggestion: { dedupeKey?: string }) => suggestion.dedupeKey === "weekly_plan.email_reviews_cleanup");
    assert.equal(gmailCleanup.creatable, false);

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: operatorUserId, message: "create all new" }
    });
    assert.equal(response.statusCode, 200);
    assert.match(response.json().reply, /Clear pending Gmail reviews is already an email review inbox item/);
    assert.equal(
      await prisma.actionItem.count({ where: { userId: operatorUserId, title: "Clear pending Gmail reviews" } }),
      0
    );

    response = await server.inject({
      method: "POST",
      url: "/messages/process",
      payload: { userId: operatorUserId, message: "I want to bet 500 because it is safe" }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().riskState, "RED");
    assert.doesNotMatch(response.json().reply, /Gmail reviews need attention|What needs attention/);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: operatorUserId } });
  }
});

async function createReview(input: {
  subject: string;
  from: string;
  proposedEventType: string;
  status: "pending" | "approved" | "rejected" | "archived";
  extracted: Record<string, unknown>;
  adapterId?: string;
  evidence?: string;
}) {
  const item = await prisma.emailReviewItem.create({
    data: {
      userId,
      connectionId,
      ruleId,
      adapterId: input.adapterId ?? "job_search_email",
      provider: "gmail",
      providerMessageId: randomUUID(),
      externalId: `gmail-review:${ruleId}:${randomUUID()}`,
      subject: input.subject,
      from: input.from,
      proposedEventType: input.proposedEventType,
      confidence: 0.95,
      reason: input.proposedEventType,
      evidence: input.evidence ?? input.subject,
      extracted: input.extracted,
      status: input.status
    }
  });

  return item.id;
}

function localMinutes(date: Date | null): number | undefined {
  if (!date) {
    return undefined;
  }

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Madrid",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");

  return hour * 60 + minute;
}

function localDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  return `${parts.find((part) => part.type === "year")?.value}-${parts.find((part) => part.type === "month")?.value}-${parts.find((part) => part.type === "day")?.value}`;
}

function minutesBetween(start: Date, end: Date): number {
  return Math.round((end.getTime() - start.getTime()) / 60_000);
}

function yesterdayLocalDate(): string {
  const date = new Date();
  date.setDate(date.getDate() - 1);
  return localDate(date);
}
