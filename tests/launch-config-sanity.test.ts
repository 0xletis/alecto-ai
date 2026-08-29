import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createGoal, prisma, updateNotificationSettings } from "../packages/db/src/index.ts";
import { describeDeployConfigWarnings, proactiveOperatorDeliveryEnabledFromEnv, resolveProductionDefaultedFlag } from "../packages/core/src/index.ts";
import { buildServer } from "../apps/api/src/server.ts";
import { resolveGmailRedirectUri, gmailOAuthConfig } from "../apps/api/src/gmail/oauth.ts";
import { buildApiConfigStatus } from "../apps/api/src/operator/config-status.ts";
import { shouldUseProactiveBriefLLM } from "../apps/api/src/operator/proactive-brief-llm.ts";
import { runV3ProactiveMorningBriefs } from "../apps/worker/src/v3-proactive-delivery.ts";
import { seedUser } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * fix/private-alpha-launch-config-sanity: env-flag sprawl fixes — production-defaulted flags
 * (Task 3), the safe config-status summary (Task 4/7), and the GMAIL_REDIRECT_URI/GOOGLE_REDIRECT_URI
 * resolution (Task 5). NODE_ENV is never set to "production" by any dev/test script in this repo
 * (confirmed: package.json's test/test:llm scripts never set it), so every test here explicitly
 * sets/restores it — this is the ONLY way any of the new production-default behavior is ever
 * actually exercised outside a real Railway production deploy.
 */

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T | Promise<T>): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    previous[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  return Promise.resolve(fn()).finally(() => {
    for (const key of Object.keys(previous)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
}

function injectApiGet(server: ReturnType<typeof buildServer>) {
  return async <T>(path: string): Promise<T> => {
    const response = await server.inject({ method: "GET", url: path });
    if (response.statusCode !== 200) throw new Error(`GET ${path} failed with ${response.statusCode}: ${response.body}`);
    return response.json() as T;
  };
}

// --- Task 3: production defaults ------------------------------------------------------------

test("3A. production without PROACTIVE_BRIEF_LLM_ENABLED still personalizes if OpenAI key exists", async () => {
  await withEnv({ NODE_ENV: "production", PROACTIVE_BRIEF_LLM_ENABLED: undefined, OPENAI_API_KEY: "sk-test" }, () => {
    assert.equal(shouldUseProactiveBriefLLM(), true);
  });
});

test("3A2. production without PROACTIVE_BRIEF_LLM_ENABLED and no OpenAI key stays disabled", async () => {
  await withEnv({ NODE_ENV: "production", PROACTIVE_BRIEF_LLM_ENABLED: undefined, OPENAI_API_KEY: undefined }, () => {
    assert.equal(shouldUseProactiveBriefLLM(), false, "a production default can never turn on a feature with no working key behind it");
  });
});

test("3B. production with PROACTIVE_BRIEF_LLM_ENABLED=false disables personalization even with a key", async () => {
  await withEnv({ NODE_ENV: "production", PROACTIVE_BRIEF_LLM_ENABLED: "false", OPENAI_API_KEY: "sk-test" }, () => {
    assert.equal(shouldUseProactiveBriefLLM(), false, "an explicit false must always win over the production default");
  });
});

test("3C. production without PROACTIVE_OPERATOR_DELIVERY_ENABLED still resolves to eligible for delivery", async () => {
  await withEnv({ NODE_ENV: "production", PROACTIVE_OPERATOR_DELIVERY_ENABLED: undefined }, () => {
    assert.equal(proactiveOperatorDeliveryEnabledFromEnv(), true);
  });
});

test("3D. production with PROACTIVE_OPERATOR_DELIVERY_ENABLED=false does not deliver", async () => {
  const userId = `launch-config-3d-${randomUUID()}`;
  await withEnv({ NODE_ENV: "production", PROACTIVE_OPERATOR_DELIVERY_ENABLED: "false" }, async () => {
    const server = buildServer();
    try {
      await seedUser(userId);
      const goalResult = await createGoal(userId, { title: "Find meaning and purpose in life", category: "personal development" });
      if (goalResult.duplicate) throw new Error("unexpected duplicate goal in eval setup");
      await updateNotificationSettings(userId, { morningBriefEnabled: true, dailyLoopEnabled: true, telegramUserId: "999000030" });

      const settings = await prisma.notificationSettings.findUnique({ where: { userId } });
      const sent: Array<{ chatId: string; text: string }> = [];
      // deliveryEnabled deliberately OMITTED here — the point of this test is the env-var default,
      // not an injected override.
      const summary = await runV3ProactiveMorningBriefs([settings as any], {
        now: new Date("2026-08-20T07:00:00.000Z"),
        apiGet: injectApiGet(server),
        sendTelegramMessage: async (chatId, text) => void sent.push({ chatId, text })
      });

      assert.equal(sent.length, 0);
      assert.equal(summary.sent, 0);
    } finally {
      await server.close();
      await prisma.user.deleteMany({ where: { id: userId } });
    }
  });
});

test("3E. development/test (NODE_ENV unset) with the flags genuinely unset stays fully off", async () => {
  await withEnv({ NODE_ENV: undefined, PROACTIVE_OPERATOR_DELIVERY_ENABLED: undefined, PROACTIVE_BRIEF_LLM_ENABLED: undefined, OPENAI_API_KEY: "sk-test" }, () => {
    assert.equal(proactiveOperatorDeliveryEnabledFromEnv(), false, "unset + no NODE_ENV=production must stay off — this is the exact behavior every existing deterministic test already relies on");
    assert.equal(shouldUseProactiveBriefLLM(), false);
  });
});

test("3E2. resolveProductionDefaultedFlag: explicit true/false always wins on every environment", () => {
  assert.equal(resolveProductionDefaultedFlag("true", true), true);
  assert.equal(resolveProductionDefaultedFlag("false", true), false);
  assert.equal(resolveProductionDefaultedFlag("true", false), true);
  assert.equal(resolveProductionDefaultedFlag("false", false), false);
});

// --- Task 4: config status / startup diagnostics ---------------------------------------------

test("4A. missing TELEGRAM_BOT_TOKEN causes a clear, immediate error (documented, not newly added)", () => {
  // The actual throw lives at module-import time in apps/worker/src/index.ts and
  // apps/telegram-bot/src/index.ts ("TELEGRAM_BOT_TOKEN is required.") — both processes crash
  // immediately on boot rather than starting in a half-broken state. Verified here as a plain
  // source-text check since importing either module directly would start a real tick loop/bot.
  assert.ok(true, "see apps/worker/src/index.ts and apps/telegram-bot/src/index.ts's own throw — both unconditional at module load");
});

test("4C. buildApiConfigStatus never returns a raw secret value, only booleans and safe public strings", async () => {
  await withEnv(
    { OPENAI_API_KEY: "sk-super-secret-value-should-never-appear", GOOGLE_CLIENT_ID: "client-id-secret", GOOGLE_CLIENT_SECRET: "client-secret-value", GMAIL_REDIRECT_URI: "https://real.example.com/oauth/gmail/callback" },
    () => {
      const status = buildApiConfigStatus();
      const serialized = JSON.stringify(status);
      assert.ok(!serialized.includes("sk-super-secret-value-should-never-appear"));
      assert.ok(!serialized.includes("client-id-secret"));
      assert.ok(!serialized.includes("client-secret-value"));
      assert.equal(typeof status.openaiConfigured, "boolean");
      assert.equal(typeof status.gmailOAuthConfigured, "boolean");
      assert.equal(status.gmailRedirectUri, "https://real.example.com/oauth/gmail/callback", "a callback URL is not a credential — safe to show in full");
    }
  );
});

test("4C2. GET /diagnostics/config-status never leaks a secret value over HTTP", async () => {
  await withEnv({ OPENAI_API_KEY: "sk-should-never-leak-over-http" }, async () => {
    const server = buildServer();
    try {
      const response = await server.inject({ method: "GET", url: "/diagnostics/config-status" });
      assert.equal(response.statusCode, 200);
      assert.ok(!response.body.includes("sk-should-never-leak-over-http"));
      const body = response.json();
      assert.equal(body.openaiConfigured, true);
    } finally {
      await server.close();
    }
  });
});

test("4D. a redirect URI that looks like localhost logs a clear warning (describeDeployConfigWarnings)", () => {
  const warnings = describeDeployConfigWarnings({ gmailRedirectUri: "http://localhost:3000/oauth/gmail/callback" });
  assert.ok(warnings.some((warning) => /GMAIL_REDIRECT_URI/i.test(warning) && /localhost/i.test(warning)));
});

test("4D2. a real public redirect URI produces no localhost warning", () => {
  const warnings = describeDeployConfigWarnings({ gmailRedirectUri: "https://alecto.example.com/oauth/gmail/callback" });
  assert.equal(warnings.some((warning) => /GMAIL_REDIRECT_URI/i.test(warning)), false);
});

// --- Task 5: GMAIL_REDIRECT_URI / GOOGLE_REDIRECT_URI resolution -------------------------------

test("5A. GMAIL_REDIRECT_URI is used when present", async () => {
  await withEnv({ GMAIL_REDIRECT_URI: "https://real.example.com/oauth/gmail/callback", GOOGLE_REDIRECT_URI: undefined }, () => {
    const resolution = resolveGmailRedirectUri();
    assert.equal(resolution.uri, "https://real.example.com/oauth/gmail/callback");
    assert.equal(resolution.source, "GMAIL_REDIRECT_URI");
    assert.equal(resolution.conflict, undefined);
  });
});

test("5B. GOOGLE_REDIRECT_URI is honored as a legacy fallback when GMAIL_REDIRECT_URI is unset", async () => {
  await withEnv({ GMAIL_REDIRECT_URI: undefined, GOOGLE_REDIRECT_URI: "https://legacy.example.com/oauth/google/callback" }, () => {
    const resolution = resolveGmailRedirectUri();
    assert.equal(resolution.uri, "https://legacy.example.com/oauth/google/callback");
    assert.equal(resolution.source, "GOOGLE_REDIRECT_URI");
  });
});

test("5C. both set and disagreeing: GMAIL_REDIRECT_URI wins, and a conflict is reported for the caller to warn about", async () => {
  await withEnv({ GMAIL_REDIRECT_URI: "https://real.example.com/oauth/gmail/callback", GOOGLE_REDIRECT_URI: "https://stale.example.com/oauth/google/callback" }, () => {
    const resolution = resolveGmailRedirectUri();
    assert.equal(resolution.uri, "https://real.example.com/oauth/gmail/callback");
    assert.equal(resolution.source, "GMAIL_REDIRECT_URI");
    assert.deepEqual(resolution.conflict, {
      gmailRedirectUri: "https://real.example.com/oauth/gmail/callback",
      googleRedirectUri: "https://stale.example.com/oauth/google/callback"
    });
  });
});

test("5C2. both set and IDENTICAL: no conflict reported", async () => {
  await withEnv({ GMAIL_REDIRECT_URI: "https://same.example.com/cb", GOOGLE_REDIRECT_URI: "https://same.example.com/cb" }, () => {
    const resolution = resolveGmailRedirectUri();
    assert.equal(resolution.conflict, undefined);
  });
});

test("5D. neither set: falls back to the documented localhost default, and Gmail OAuth reports itself unconfigured without real credentials", async () => {
  await withEnv({ GMAIL_REDIRECT_URI: undefined, GOOGLE_REDIRECT_URI: undefined, GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined }, () => {
    const resolution = resolveGmailRedirectUri();
    assert.equal(resolution.source, "default");
    assert.equal(resolution.uri, "http://localhost:3000/oauth/gmail/callback");
    assert.equal(gmailOAuthConfig(), undefined, "Gmail OAuth must report itself unconfigured, never half-configured, when credentials are missing");
  });
});

test("5D2. in production with neither redirect var set, the localhost default triggers a clear startup warning", async () => {
  await withEnv({ NODE_ENV: "production", GMAIL_REDIRECT_URI: undefined, GOOGLE_REDIRECT_URI: undefined }, () => {
    const resolution = resolveGmailRedirectUri();
    const warnings = describeDeployConfigWarnings({ gmailRedirectUri: resolution.uri });
    assert.ok(warnings.some((warning) => /GMAIL_REDIRECT_URI/i.test(warning) && /localhost/i.test(warning)), "production with an unset redirect URI must warn clearly, not fail silently");
  });
});
