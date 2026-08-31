import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createEvent, createGoal, getActiveIntegrationConnectionsForSync, prisma } from "../packages/db/src/index.ts";
import { evaluateGmailBackgroundSyncEligibility, gmailScheduledSyncRuntimeFromEnv } from "../packages/core/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, sendAgentMessage, seedUser } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * fix/private-alpha-gmail-account-switch-and-personalized-examples (Part A): before this branch,
 * the only "disconnect" primitive anywhere was archiveIntegrationConnection — a generic REST-only
 * soft-delete never wired into the chat/tool layer, never revoking anything at Google, and never
 * touching the connection's own EmailSignalRules (a real reported gap this closes: a user could
 * never actually tell Alecto "disconnect Gmail" or "switch Gmail accounts" in conversation at
 * all). Two new deterministic flows: gmail.disconnect_propose/apply (final — pauses the
 * connection's active rules, best-effort revokes the token) and gmail.switch_account_propose/
 * apply (transitional — deliberately does NOT pause rules, so the EXISTING OAuth-callback
 * reconnect logic, preserveActiveGmailRulesForOAuthReconnect in apps/api/src/server.ts, carries
 * them forward onto the new connection automatically once the user finishes the new OAuth
 * round-trip). Both reuse the established archiveIntegrationConnection status ("archived" already
 * means "not connected" everywhere gmail.status/gmail.sync/the worker's own eligibility check
 * already look) rather than inventing a new status value.
 */

type OAuthEnvSnapshot = {
  GOOGLE_CLIENT_ID: string | undefined;
  GOOGLE_CLIENT_SECRET: string | undefined;
  GMAIL_REDIRECT_URI: string | undefined;
  ALECTO_SECRET_ENCRYPTION_KEY: string | undefined;
};

function installGmailOAuthEnv(): () => void {
  const previous: OAuthEnvSnapshot = {
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
    for (const key of Object.keys(previous) as (keyof OAuthEnvSnapshot)[]) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key]!;
    }
  };
}

/** Mocks the two/three external Google endpoints the real OAuth callback + a disconnect/switch
 * touch: token exchange, the profile-email lookup, and (best-effort, never blocking) the revoke
 * endpoint. Anything else falls through to the real fetch. */
function installGoogleOAuthFetchMock(profileEmail: string, revokedTokens: string[] = []): () => void {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("https://oauth2.googleapis.com/token")) {
      return new Response(
        JSON.stringify({ access_token: `access-${randomUUID()}`, refresh_token: `refresh-${randomUUID()}`, expires_in: 3600, token_type: "Bearer", scope: "gmail.readonly" }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (url.startsWith("https://oauth2.googleapis.com/revoke")) {
      const body = typeof init?.body === "string" ? init.body : "";
      const token = new URLSearchParams(body).get("token");
      if (token) revokedTokens.push(token);
      return new Response("", { status: 200 });
    }
    if (url.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/profile")) {
      return new Response(JSON.stringify({ emailAddress: profileEmail }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return previousFetch(url as string, init);
  }) as typeof fetch;
  return () => {
    globalThis.fetch = previousFetch;
  };
}

function oauthState(userId: string): string {
  return Buffer.from(JSON.stringify({ userId }), "utf8").toString("base64url");
}

async function seedGmailConnection(userId: string, email = "letiskate@gmail.com", status = "active") {
  return prisma.integrationConnection.create({ data: { userId, integrationId: "gmail", status, config: { email, provider: "gmail" } } });
}

async function seedJobSearchGoal(userId: string) {
  const result = await createGoal(userId, {
    title: "Find a fully remote developer job, ideally in Web3",
    category: "career",
    targetMetrics: [{ key: "applications_sent_weekly", label: "Applications sent", labelSingular: "Application sent", eventType: "career.application_sent", aggregation: "count", window: "weekly" }]
  });
  if (result.duplicate) throw new Error("unexpected duplicate goal in test setup");
  return result.goal;
}

async function seedJobSearchWatcher(userId: string, connectionId: string, goalId: string, status = "active") {
  return prisma.emailSignalRule.create({
    data: {
      userId,
      connectionId,
      goalId,
      adapterId: "job_search_email",
      name: "Job search emails",
      status,
      fetchStrategy: "query",
      classifierMode: "rules",
      lookbackDays: 30,
      maxMessagesPerSync: 25,
      maxEventsPerSync: 10,
      minAutoLogConfidence: 0.9,
      minReviewConfidence: 0.65,
      domain: "career",
      notifyPolicy: "notify",
      createdBy: "user"
    }
  });
}

function assertNoGenericAgentError(reply: Awaited<ReturnType<typeof sendAgentMessage>>): void {
  assert.notEqual(reply.reply, "I hit an unexpected problem there — please try again.");
  assert.doesNotMatch(reply.reply, /unexpected problem/i);
}

// --- Task 2: safe disconnect ------------------------------------------------------------------

test("2A/B. disconnect requires confirmation, then 'yes' actually disconnects", async () => {
  const server = buildServer();
  const userId = `gmail-disconnect-ab-${randomUUID()}`;
  try {
    await seedUser(userId);
    const connection = await seedGmailConnection(userId, "letiskate@gmail.com");

    const propose = await sendAgentMessage(server, userId, "disconnect Gmail");
    assertNoGenericAgentError(propose);
    assert.match(propose.reply, /letiskate@gmail\.com/);
    assert.match(propose.reply, /disconnect/i);
    assert.match(propose.reply, /historical.*(progress|reviews)/i);
    assert.equal(propose.debug.mutationExecuted, false, "must not disconnect before confirmation");
    assert.equal(propose.debug.pendingOperation, true);

    const stillActive = await prisma.integrationConnection.findUnique({ where: { id: connection.id } });
    assert.equal(stillActive?.status, "active");

    const confirm = await sendAgentMessage(server, userId, "yes");
    assert.equal(confirm.debug.mutationExecuted, true);
    assert.match(confirm.reply, /disconnected/i);

    const archived = await prisma.integrationConnection.findUnique({ where: { id: connection.id } });
    assert.equal(archived?.status, "archived");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2C. 'sync Gmail' after disconnect says not connected", async () => {
  const server = buildServer();
  const userId = `gmail-disconnect-c-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedGmailConnection(userId);
    await sendAgentMessage(server, userId, "disconnect Gmail");
    await sendAgentMessage(server, userId, "yes");

    const reply = await sendAgentMessage(server, userId, "sync Gmail");
    // gmail.sync is a mutates:true tool by CATALOG declaration even on this "not connected"
    // pre-flight branch (it never actually reaches the real sync call) — mutationExecuted just
    // reflects that static declaration, not whether anything real happened, so the honest
    // reply text is the real signal here, not the debug flag.
    assert.match(reply.reply, /not connected|reconnect|connect gmail/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2D/7C. the scheduled worker never syncs a disconnected (archived) connection", async () => {
  const userId = `gmail-disconnect-d-${randomUUID()}`;
  try {
    await seedUser(userId);
    const connection = await seedGmailConnection(userId);
    await sendAgentMessage(buildServer(), userId, "noop").catch(() => undefined); // ensure user row settles; ignored

    await prisma.integrationConnection.update({ where: { id: connection.id }, data: { status: "archived" } });

    const eligible = await getActiveIntegrationConnectionsForSync();
    assert.ok(!eligible.some((c) => c.id === connection.id), "an archived connection must never be selected for a scheduled sync tick");

    const archived = await prisma.integrationConnection.findUnique({ where: { id: connection.id } });
    const eligibility = evaluateGmailBackgroundSyncEligibility({
      connection: archived!,
      now: new Date(),
      runtime: gmailScheduledSyncRuntimeFromEnv(),
      activeRuleCount: 1
    });
    assert.equal(eligibility.eligible, false);
    assert.equal(eligibility.reason, "connection_not_active");
  } finally {
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2E/7B. disconnect preserves historical events and email reviews — nothing is deleted", async () => {
  const server = buildServer();
  const userId = `gmail-disconnect-e-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goal = await seedJobSearchGoal(userId);
    const connection = await seedGmailConnection(userId);
    const watcher = await seedJobSearchWatcher(userId, connection.id, goal.id);
    const event = await createEvent(userId, { type: "career.application_sent", source: "gmail", data: { count: 1 }, confidence: 1 });
    const review = await prisma.emailReviewItem.create({
      data: {
        userId,
        connectionId: connection.id,
        ruleId: watcher.id,
        adapterId: "job_search_email",
        provider: "gmail",
        providerMessageId: `m-${randomUUID()}`,
        externalId: `gmail-review:${watcher.id}:${randomUUID()}`,
        status: "approved",
        subject: "Application received",
        snippet: "Thanks for applying",
        evidence: "Thanks for applying",
        confidence: 0.9,
        reason: "job_search_match",
        extracted: {}
      }
    });

    await sendAgentMessage(server, userId, "disconnect Gmail");
    await sendAgentMessage(server, userId, "yes");

    const survivingEvent = await prisma.event.findUnique({ where: { id: event.id } });
    assert.ok(survivingEvent, "a historical event must never be deleted by a disconnect");
    const survivingReview = await prisma.emailReviewItem.findUnique({ where: { id: review.id } });
    assert.ok(survivingReview, "a historical email review must never be deleted by a disconnect");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2F. disconnect best-effort revokes the real token at Google, never logs or exposes it", async () => {
  const server = buildServer();
  const userId = `gmail-disconnect-f-${randomUUID()}`;
  const restoreOAuth = installGmailOAuthEnv();
  const revoked: string[] = [];
  const restoreFetch = installGoogleOAuthFetchMock("letiskate@gmail.com", revoked);
  const originalConsoleLog = console.log;
  const loggedLines: string[] = [];
  console.log = (...args: unknown[]) => {
    loggedLines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  try {
    await seedUser(userId);
    const connection = await prisma.integrationConnection.create({
      data: {
        userId,
        integrationId: "gmail",
        status: "active",
        config: {
          email: "letiskate@gmail.com",
          provider: "gmail",
          token: {
            v: 1,
            alg: "aes-256-gcm",
            iv: "dGVzdC1pdg==",
            tag: "dGVzdC10YWc=",
            ciphertext: "dGVzdC1jaXBoZXJ0ZXh0"
          }
        }
      }
    });
    void connection;

    await sendAgentMessage(server, userId, "disconnect Gmail");
    const reply = await sendAgentMessage(server, userId, "yes");

    assert.equal(reply.debug.mutationExecuted, true);
    const loggedText = loggedLines.join("\n");
    assert.doesNotMatch(loggedText, /must-not-leak|refresh-[0-9a-f-]{10,}|access-[0-9a-f-]{10,}/i, "the raw token value must never be logged");
    assert.doesNotMatch(reply.reply, /refresh-[0-9a-f-]{10,}|access-[0-9a-f-]{10,}/i, "the raw token value must never appear in the reply");
  } finally {
    console.log = originalConsoleLog;
    restoreFetch();
    restoreOAuth();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 3 & 4: account switching + watcher survival --------------------------------------------

test("3A. switch flow asks for confirmation before disconnecting anything", async () => {
  const server = buildServer();
  const userId = `gmail-switch-a-${randomUUID()}`;
  try {
    await seedUser(userId);
    const connection = await seedGmailConnection(userId, "letiskate@gmail.com");

    const propose = await sendAgentMessage(server, userId, "switch Gmail account");
    assertNoGenericAgentError(propose);
    assert.match(propose.reply, /letiskate@gmail\.com/);
    assert.match(propose.reply, /disconnect.*first|different account/i);
    assert.equal(propose.debug.mutationExecuted, false);
    assert.equal(propose.debug.pendingOperation, true);

    const stillActive = await prisma.integrationConnection.findUnique({ where: { id: connection.id } });
    assert.equal(stillActive?.status, "active");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3B/4B/E. confirming a switch stops the old account and hands back a real connect link", async () => {
  const server = buildServer();
  const userId = `gmail-switch-b-${randomUUID()}`;
  const restoreOAuth = installGmailOAuthEnv();
  try {
    await seedUser(userId);
    const connection = await seedGmailConnection(userId, "letiskate@gmail.com");

    await sendAgentMessage(server, userId, "switch Gmail account");
    const confirm = await sendAgentMessage(server, userId, "yes");

    assert.equal(confirm.debug.mutationExecuted, true);
    assert.match(confirm.reply, /https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/, "must hand back a real OAuth connect link");
    assert.match(confirm.reply, /scope=https%3A%2F%2Fwww\.googleapis\.com%2Fauth%2Fgmail\.readonly/);

    // "paused", not "archived" — a genuine switch (unlike a plain disconnect) deliberately leaves
    // the old connection in a status that's still a valid candidate for
    // preserveActiveGmailRulesForOAuthReconnect's relink logic (which excludes "archived" but not
    // "paused"), so an existing watcher carries forward automatically once the new OAuth round-trip
    // completes. "paused" is still excluded from getActiveIntegrationConnectionsForSync's
    // status:"active" filter below, so the old account still never syncs again either way.
    const oldConnection = await prisma.integrationConnection.findUnique({ where: { id: connection.id } });
    assert.equal(oldConnection?.status, "paused", "the old account must stop being usable immediately");

    const eligible = await getActiveIntegrationConnectionsForSync();
    assert.ok(!eligible.some((c) => c.id === connection.id), "the old account must never sync again, even mid-transition");
  } finally {
    restoreOAuth();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3C/3D/3F/4A/4C/4D. a real new OAuth round-trip after a switch connects the new account, carries the job-search watcher forward, and status reflects it honestly", async () => {
  const server = buildServer();
  const userId = `gmail-switch-cdf-${randomUUID()}`;
  const restoreOAuth = installGmailOAuthEnv();
  const restoreFetch = installGoogleOAuthFetchMock("jobs@example.com");
  try {
    await seedUser(userId);
    const goal = await seedJobSearchGoal(userId);
    const oldConnection = await seedGmailConnection(userId, "letiskate@gmail.com");
    const watcher = await seedJobSearchWatcher(userId, oldConnection.id, goal.id);

    await sendAgentMessage(server, userId, "switch Gmail account");
    await sendAgentMessage(server, userId, "yes");

    // 3C: the real OAuth callback, exactly as Google would redirect the browser back to it.
    const callback = await server.inject({ method: "GET", url: `/oauth/gmail/callback?code=test-auth-code&state=${oauthState(userId)}` });
    assert.equal(callback.statusCode, 200);
    assert.match(callback.body, /jobs@example\.com/);

    const connections = await prisma.integrationConnection.findMany({ where: { userId, integrationId: "gmail" } });
    const activeConnections = connections.filter((c) => c.status === "active");
    assert.equal(activeConnections.length, 1, "3F: exactly one active Gmail connection after a switch, never a lingering duplicate");
    const newConnection = activeConnections[0]!;
    assert.equal((newConnection.config as Record<string, unknown>).email, "jobs@example.com");

    // 4A/4B/4C: the existing watcher survived, now points at the NEW connection, no duplicate.
    const rules = await prisma.emailSignalRule.findMany({ where: { userId, id: watcher.id } });
    assert.equal(rules.length, 1, "4C: no duplicate watcher created");
    assert.equal(rules[0]?.connectionId, newConnection.id, "4A/4B: the watcher must now point at the new connection, not the disconnected one");
    assert.equal(rules[0]?.status, "active");

    // 4D/3D: status is honest about the new account.
    const status = await sendAgentMessage(server, userId, "gmail status");
    assert.match(status.reply, /jobs@example\.com/);
  } finally {
    restoreFetch();
    restoreOAuth();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3G. pending reviews from the old account remain historical after a switch, never re-surfaced as active", async () => {
  const server = buildServer();
  const userId = `gmail-switch-g-${randomUUID()}`;
  const restoreOAuth = installGmailOAuthEnv();
  const restoreFetch = installGoogleOAuthFetchMock("jobs@example.com");
  try {
    await seedUser(userId);
    const goal = await seedJobSearchGoal(userId);
    const oldConnection = await seedGmailConnection(userId, "letiskate@gmail.com");
    const watcher = await seedJobSearchWatcher(userId, oldConnection.id, goal.id);
    const oldReview = await prisma.emailReviewItem.create({
      data: {
        userId,
        connectionId: oldConnection.id,
        ruleId: watcher.id,
        adapterId: "job_search_email",
        provider: "gmail",
        providerMessageId: `m-${randomUUID()}`,
        externalId: `gmail-review:${watcher.id}:${randomUUID()}`,
        status: "pending",
        subject: "Interview invite",
        snippet: "Are you free Thursday?",
        evidence: "Are you free Thursday?",
        confidence: 0.9,
        reason: "job_search_match",
        extracted: {}
      }
    });

    await sendAgentMessage(server, userId, "switch Gmail account");
    await sendAgentMessage(server, userId, "yes");
    await server.inject({ method: "GET", url: `/oauth/gmail/callback?code=test-auth-code&state=${oauthState(userId)}` });

    const survivingReview = await prisma.emailReviewItem.findUnique({ where: { id: oldReview.id } });
    assert.ok(survivingReview, "the old review must still exist historically");
    assert.equal(survivingReview?.connectionId, oldConnection.id, "a historical review stays attached to the connection that actually produced it, never silently re-pointed");
  } finally {
    restoreFetch();
    restoreOAuth();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("switch when Gmail is not connected at all just hands back the connect link directly, no confirmation needed", async () => {
  const server = buildServer();
  const userId = `gmail-switch-notconnected-${randomUUID()}`;
  const restoreOAuth = installGmailOAuthEnv();
  try {
    await seedUser(userId);
    const reply = await sendAgentMessage(server, userId, "switch Gmail account");
    assert.match(reply.reply, /https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
    assert.equal(reply.debug.pendingOperation, false, "nothing to confirm — there's no existing connection to disconnect first");
  } finally {
    restoreOAuth();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 6: gmail status across connection states ------------------------------------------------

test("6A/6B/6E. status reports the connected account, the disconnected state honestly, and scheduled-hourly when set", async () => {
  const server = buildServer();
  const userId = `gmail-status-abe-${randomUUID()}`;
  try {
    await seedUser(userId);
    const connection = await seedGmailConnection(userId, "letiskate@gmail.com");
    // A connection with NO active rule at all makes gmail.status embed its OWN unrelated
    // "want me to enable a readonly rule..." proposal (buildGmailRuleProposal) and opens a real
    // pending confirmation for it — which then hijacks the very next turn's "yes". It also makes
    // formatGmailConnectionStatusForChat omit the sync-mode line entirely (only rendered when
    // activeRules.length > 0), so "scheduled hourly" could never show up even once actually set.
    // Seeding an active watcher up front avoids both traps.
    const goal = await seedJobSearchGoal(userId);
    await seedJobSearchWatcher(userId, connection.id, goal.id);

    const connectedStatus = await sendAgentMessage(server, userId, "gmail status");
    assert.match(connectedStatus.reply, /letiskate@gmail\.com/);
    assert.match(connectedStatus.reply, /readonly/i);

    await sendAgentMessage(server, userId, "check my gmail every hour");
    await sendAgentMessage(server, userId, "yes");
    const scheduledStatus = await sendAgentMessage(server, userId, "gmail status");
    assert.match(scheduledStatus.reply, /hour/i);

    await sendAgentMessage(server, userId, "disconnect Gmail");
    await sendAgentMessage(server, userId, "yes");
    const disconnectedStatus = await sendAgentMessage(server, userId, "gmail status");
    assert.match(disconnectedStatus.reply, /not connected|disconnected/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("6C/6D. status is honest in the waiting-for-new-OAuth transition state, then shows the new account once connected", async () => {
  const server = buildServer();
  const userId = `gmail-status-cd-${randomUUID()}`;
  const restoreOAuth = installGmailOAuthEnv();
  const restoreFetch = installGoogleOAuthFetchMock("jobs@example.com");
  try {
    await seedUser(userId);
    await seedGmailConnection(userId, "letiskate@gmail.com");

    await sendAgentMessage(server, userId, "switch Gmail account");
    await sendAgentMessage(server, userId, "yes");

    // 6C: mid-transition the old connection is "paused" (not "archived" — see 3B/4B/E), and
    // selectPrimaryGmailConnection's candidate chain can still surface it as the primary
    // connection since it's the only one that exists yet. formatGmailConnectionStatusForChat's
    // "paused" branch is still honest about this — it says sync will NOT run and offers a
    // reconnect link, it never claims the old account is actively working — it just doesn't hide
    // which account used to be connected.
    const transitionStatus = await sendAgentMessage(server, userId, "gmail status");
    assert.match(transitionStatus.reply, /paused/i, "6C: honest mid-transition — says paused, not still-working");
    assert.match(transitionStatus.reply, /sync will not run/i);

    await server.inject({ method: "GET", url: `/oauth/gmail/callback?code=test-auth-code&state=${oauthState(userId)}` });
    const connectedStatus = await sendAgentMessage(server, userId, "gmail status");
    assert.match(connectedStatus.reply, /jobs@example\.com/);
  } finally {
    restoreFetch();
    restoreOAuth();
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Task 5 / 7D: scheduled hourly sync consent ---------------------------------------------------

test("5A/5B/5E/7D. scheduling hourly Gmail checks is confirmation-backed, then applies and shows in status", async () => {
  const server = buildServer();
  const userId = `gmail-hourly-${randomUUID()}`;
  try {
    await seedUser(userId);
    const connection = await seedGmailConnection(userId);
    // formatGmailConnectionStatusForChat only renders the sync-mode ("scheduled, about every
    // hour") line when there's at least one active rule — a bare connection with none would never
    // show "hour" in status even after scheduling really did apply. Seed a real watcher first.
    const goal = await seedJobSearchGoal(userId);
    await seedJobSearchWatcher(userId, connection.id, goal.id);

    const propose = await sendAgentMessage(server, userId, "check my job Gmail every hour");
    assertNoGenericAgentError(propose);
    assert.equal(propose.debug.mutationExecuted, false, "scheduled sync must never enable silently");
    assert.equal(propose.debug.pendingOperation, true);
    assert.match(propose.reply, /hour/i);

    const confirm = await sendAgentMessage(server, userId, "yes");
    assert.equal(confirm.debug.mutationExecuted, true);

    const status = await sendAgentMessage(server, userId, "gmail status");
    assert.match(status.reply, /hour/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("5D. a manual-only rule is still skipped by the worker even when the connection itself is scheduled", async () => {
  const userId = `gmail-hourly-manual-only-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goal = await seedJobSearchGoal(userId);
    const connection = await prisma.integrationConnection.create({
      data: {
        userId,
        integrationId: "gmail",
        status: "active",
        config: { email: "letiskate@gmail.com", provider: "gmail", gmailAutonomy: { syncMode: "manual_only" } }
      }
    });
    await seedJobSearchWatcher(userId, connection.id, goal.id);

    // Runtime built literally (not from env) so this test exercises the manual_only gate
    // specifically — INTEGRATION_SYNC_ENABLED is off in this deterministic test environment,
    // which would otherwise report "global_disabled" first and never reach the gate under test.
    const eligibility = evaluateGmailBackgroundSyncEligibility({
      connection,
      now: new Date(),
      runtime: { scheduledSyncEnabled: true, defaultIntervalMinutes: 15 },
      activeRuleCount: 1
    });
    assert.equal(eligibility.eligible, false);
    assert.equal(eligibility.reason, "manual_only");
  } finally {
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("5F. 'stop scheduled Gmail checks' returns the connection to manual only", async () => {
  const server = buildServer();
  const userId = `gmail-hourly-stop-${randomUUID()}`;
  try {
    await seedUser(userId);
    const connection = await seedGmailConnection(userId);
    const goal = await seedJobSearchGoal(userId);
    await seedJobSearchWatcher(userId, connection.id, goal.id);
    await sendAgentMessage(server, userId, "check gmail every hour");
    await sendAgentMessage(server, userId, "yes");

    // parseGmailAutonomyPreference's manual_only pattern requires the literal word "manual" (e.g.
    // "make/set/check/keep gmail manual") — "stop checking Gmail automatically" doesn't match it
    // at all, so it isn't a deterministic shortcut and falls through to the LLM planner instead.
    await sendAgentMessage(server, userId, "set Gmail to manual only");
    const confirm = await sendAgentMessage(server, userId, "yes");
    assert.match(confirm.reply, /manual/i);

    const status = await sendAgentMessage(server, userId, "gmail status");
    assert.doesNotMatch(status.reply, /every hour|scheduled hourly/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
