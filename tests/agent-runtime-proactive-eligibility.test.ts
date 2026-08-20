import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createActionItem, prisma } from "../packages/db/src/index.ts";
import { buildServer } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * GET /users/:userId/operator/proactive/preview's eligibility field
 * (apps/api/src/operator/proactive-eligibility.ts's evaluateProactiveEligibility) — reports
 * wouldSend/blockedBy without ever writing the DB. PROACTIVE_OPERATOR_DELIVERY_ENABLED/
 * PROACTIVE_OPERATOR_ALLOWLIST are developer rollout controls; morningBriefEnabled (etc.) is the
 * real per-user product consent. Both are independently reported here so a real client (or a
 * future onboarding UI) can distinguish "off because dev flag" from "off because user hasn't
 * opted in" — see docs/10-v3-readiness-audit.md §15.
 */

const MORNING_UTC = "2026-08-20T07:00:00.000Z"; // 09:00 Europe/Madrid

async function seedEligibleUser(userId: string, overrides: { morningBriefEnabled?: boolean } = {}) {
  await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
  await prisma.notificationSettings.create({
    data: {
      userId,
      dailyLoopEnabled: true,
      morningBriefEnabled: overrides.morningBriefEnabled ?? true,
      morningTimeMinutes: 540,
      eveningTimeMinutes: 1140,
      timezone: "Europe/Madrid"
    }
  });
  await createActionItem(userId, { source: "manual", title: "Apply to jobs", priority: "high" });
}

async function preview(server: ReturnType<typeof buildServer>, userId: string) {
  const response = await server.inject({ method: "GET", url: `/users/${userId}/operator/proactive/preview?now=${encodeURIComponent(MORNING_UTC)}` });
  assert.equal(response.statusCode, 200, `preview for ${userId} returned ${response.statusCode}: ${response.body}`);
  return response.json() as {
    decision: { decision: string; type?: string };
    eligibility: {
      wouldSend: boolean;
      blockedBy: string[];
      deliveryEnabled?: boolean;
      allowlistActive?: boolean;
      allowlistMatched?: boolean;
      scheduledTime?: string;
      optIn?: { morningBriefEnabled: boolean; eveningCheckinEnabled: boolean; gmailNudgeEnabled: boolean };
    };
  };
}

function randomTelegramUserId(): string {
  return `telegram:${Math.floor(100000000 + Math.random() * 800000000)}`;
}

function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    previous[key] = process.env[key];
    if (vars[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = vars[key];
    }
  }
  return fn().finally(() => {
    for (const key of Object.keys(previous)) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  });
}

test("1. delivery enabled + opted in + no allowlist configured: eligible, allowlistActive is false", async () => {
  const server = buildServer();
  const userId = `eligibility-all-clear-${randomUUID()}`;

  try {
    await seedEligibleUser(userId);

    await withEnv({ PROACTIVE_OPERATOR_DELIVERY_ENABLED: "true", PROACTIVE_OPERATOR_ALLOWLIST: undefined }, async () => {
      const response = await preview(server, userId);
      assert.equal(response.decision.decision, "proposed_message");
      assert.equal(response.decision.type, "morning_brief");
      assert.equal(response.eligibility.wouldSend, true);
      assert.deepEqual(response.eligibility.blockedBy, []);
      assert.equal(response.eligibility.deliveryEnabled, true);
      assert.equal(response.eligibility.allowlistActive, false, "no allowlist configured means it must not restrict anyone");
      assert.equal(response.eligibility.allowlistMatched, undefined, "allowlistMatched is only meaningful when an allowlist is active");
    });
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2. delivery enabled + opted in + allowlist contains the full telegram:<id> form: eligible, allowlistMatched is true", async () => {
  const server = buildServer();
  const userId = randomTelegramUserId();

  try {
    await seedEligibleUser(userId);

    await withEnv({ PROACTIVE_OPERATOR_DELIVERY_ENABLED: "true", PROACTIVE_OPERATOR_ALLOWLIST: userId }, async () => {
      const response = await preview(server, userId);
      assert.equal(response.eligibility.wouldSend, true);
      assert.equal(response.eligibility.allowlistActive, true);
      assert.equal(response.eligibility.allowlistMatched, true);
    });
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3. delivery enabled + opted in + allowlist contains only the bare numeric Telegram id: eligible, still matches", async () => {
  const server = buildServer();
  const userId = randomTelegramUserId();
  const bareNumericId = userId.replace("telegram:", "");

  try {
    await seedEligibleUser(userId);

    await withEnv({ PROACTIVE_OPERATOR_DELIVERY_ENABLED: "true", PROACTIVE_OPERATOR_ALLOWLIST: bareNumericId }, async () => {
      const response = await preview(server, userId);
      assert.equal(response.eligibility.wouldSend, true, "a bare numeric id in the allowlist must be normalized to telegram:<id> and match");
      assert.equal(response.eligibility.allowlistActive, true);
      assert.equal(response.eligibility.allowlistMatched, true);
    });
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("6. delivery disabled: blockedBy includes delivery_disabled, wouldSend is false", async () => {
  const server = buildServer();
  const userId = `eligibility-delivery-disabled-${randomUUID()}`;

  try {
    await seedEligibleUser(userId);

    await withEnv({ PROACTIVE_OPERATOR_DELIVERY_ENABLED: "false", PROACTIVE_OPERATOR_ALLOWLIST: undefined }, async () => {
      const response = await preview(server, userId);
      assert.equal(response.eligibility.wouldSend, false);
      assert.ok(response.eligibility.blockedBy.includes("delivery_disabled"));
      assert.equal(response.eligibility.deliveryEnabled, false);
    });
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4. allowlist active but excludes this user: blockedBy includes not_allowlisted, allowlistMatched is false", async () => {
  const server = buildServer();
  const userId = randomTelegramUserId();

  try {
    await seedEligibleUser(userId);

    await withEnv({ PROACTIVE_OPERATOR_DELIVERY_ENABLED: "true", PROACTIVE_OPERATOR_ALLOWLIST: "telegram:999999999" }, async () => {
      const response = await preview(server, userId);
      assert.equal(response.eligibility.wouldSend, false);
      assert.ok(response.eligibility.blockedBy.includes("not_allowlisted"));
      assert.equal(response.eligibility.allowlistActive, true);
      assert.equal(response.eligibility.allowlistMatched, false);
    });
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("5. user has not opted in at the settings level, no allowlist configured: blockedBy includes user_not_opted_in, but the content preview still shows what it would say", async () => {
  const server = buildServer();
  const userId = `eligibility-not-opted-in-${randomUUID()}`;

  try {
    await seedEligibleUser(userId, { morningBriefEnabled: false });

    await withEnv({ PROACTIVE_OPERATOR_DELIVERY_ENABLED: "true", PROACTIVE_OPERATOR_ALLOWLIST: undefined }, async () => {
      const response = await preview(server, userId);
      // The content decision is unaffected by opt-in status — it's a pure content decision.
      assert.equal(response.decision.decision, "proposed_message");
      assert.equal(response.eligibility.wouldSend, false);
      assert.ok(response.eligibility.blockedBy.includes("user_not_opted_in"));
    });
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("no candidate exists: blockedBy reflects the decision module's own reason, wouldSend is false", async () => {
  const server = buildServer();
  const userId = `eligibility-no-candidate-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    await prisma.notificationSettings.create({
      data: { userId, dailyLoopEnabled: false, morningBriefEnabled: true, morningTimeMinutes: 540, eveningTimeMinutes: 1140, timezone: "Europe/Madrid" }
    });

    await withEnv({ PROACTIVE_OPERATOR_DELIVERY_ENABLED: "true", PROACTIVE_OPERATOR_ALLOWLIST: undefined }, async () => {
      const response = await preview(server, userId);
      assert.equal(response.decision.decision, "no_message");
      assert.equal(response.eligibility.wouldSend, false);
      assert.ok(response.eligibility.blockedBy.includes("quiet_hours"));
    });
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("11. the preview route reports scheduledTime and per-moment optIn alongside wouldSend/blockedBy", async () => {
  const server = buildServer();
  const userId = `eligibility-scheduled-time-optin-${randomUUID()}`;

  try {
    await seedEligibleUser(userId);

    await withEnv({ PROACTIVE_OPERATOR_DELIVERY_ENABLED: "true", PROACTIVE_OPERATOR_ALLOWLIST: undefined }, async () => {
      const response = await preview(server, userId);
      assert.equal(response.eligibility.scheduledTime, "09:00");
      assert.deepEqual(response.eligibility.optIn, {
        morningBriefEnabled: true,
        eveningCheckinEnabled: false,
        gmailNudgeEnabled: false
      });
    });
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("12. the preview route never writes the DB while computing eligibility", async () => {
  const server = buildServer();
  const userId = `eligibility-no-db-write-${randomUUID()}`;

  try {
    await seedEligibleUser(userId);

    await withEnv({ PROACTIVE_OPERATOR_DELIVERY_ENABLED: "true", PROACTIVE_OPERATOR_ALLOWLIST: undefined }, async () => {
      await preview(server, userId);
      await preview(server, userId);
    });

    const logs = await prisma.notificationLog.count({ where: { userId } });
    assert.equal(logs, 0);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
