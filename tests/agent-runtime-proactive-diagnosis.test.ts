import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createActionItem, createNotificationLog, prisma } from "../packages/db/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, mockPlan, op, sendAgentMessage, seedUser } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * "why didn't I get my morning brief?" (proactive.diagnose_morning_brief) — a grounded diagnosis
 * of real delivery state, not a generic settings summary. Reuses
 * apps/api/src/operator/proactive-eligibility.ts's getProactiveDeliveryStatus, which itself reuses
 * decideProactiveOperatorMessage and its exported time-window primitives, so this can't drift out
 * of sync with what the decision module (and apps/worker's own send-gate) actually check. See also
 * tests/agent-runtime-proactive-settings.test.ts (the settings UX half of the same bug-fix pass)
 * and tests/agent-runtime-proactive-eligibility.test.ts (the preview route's array-shaped
 * blockedBy, a distinct but drift-free-by-shared-primitives sibling of this single-status
 * diagnosis).
 */

function diagnosePlan() {
  return { topic: "proactive_settings", intent: "diagnose_morning_brief", operations: [op("proactive.diagnose_morning_brief")], needsClarification: false, clarificationQuestion: null, replyDraft: "" };
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

/** Current minute-of-day in UTC, so a NotificationSettings row with timezone "UTC" and this as
 * morningTimeMinutes is always "within window" for proactive.diagnose_morning_brief, which reads
 * real server time (new Date()) rather than an injectable `now` — unlike the preview route. */
function currentMinutesUtc(): number {
  const now = new Date();
  return now.getUTCHours() * 60 + now.getUTCMinutes();
}

async function diagnose(server: ReturnType<typeof buildServer>, userId: string): Promise<string> {
  mockPlan(diagnosePlan());
  const reply = await sendAgentMessage(server, userId, "why didn't I get my morning brief?");
  return reply.reply;
}

test("5. delivery flag off: diagnosis explains delivery_disabled", async () => {
  const server = buildServer();
  const userId = `proactive-diagnose-delivery-disabled-${randomUUID()}`;

  try {
    await seedUser(userId);
    await prisma.notificationSettings.create({ data: { userId, dailyLoopEnabled: true, morningBriefEnabled: true, morningTimeMinutes: 66, timezone: "UTC" } });

    await withEnv({ PROACTIVE_OPERATOR_DELIVERY_ENABLED: undefined, PROACTIVE_OPERATOR_ALLOWLIST: undefined }, async () => {
      const reply = await diagnose(server, userId);
      assert.match(reply, /delivery is blocked because PROACTIVE_OPERATOR_DELIVERY_ENABLED is off/i);
      assert.match(reply, /01:06/);
    });
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("6. not allowlisted: diagnosis explains user_not_allowlisted", async () => {
  const server = buildServer();
  const userId = `proactive-diagnose-not-allowlisted-${randomUUID()}`;

  try {
    await seedUser(userId);
    await prisma.notificationSettings.create({ data: { userId, dailyLoopEnabled: true, morningBriefEnabled: true, morningTimeMinutes: 66, timezone: "UTC" } });

    await withEnv({ PROACTIVE_OPERATOR_DELIVERY_ENABLED: "true", PROACTIVE_OPERATOR_ALLOWLIST: "someone-else" }, async () => {
      const reply = await diagnose(server, userId);
      assert.match(reply, /not in PROACTIVE_OPERATOR_ALLOWLIST/i);
    });
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("7. morning brief not opted in: diagnosis explains user_not_opted_in and never mentions env flags", async () => {
  const server = buildServer();
  const userId = `proactive-diagnose-not-opted-in-${randomUUID()}`;

  try {
    await seedUser(userId);
    await prisma.notificationSettings.create({ data: { userId, dailyLoopEnabled: true, morningBriefEnabled: false, morningTimeMinutes: 66, timezone: "UTC" } });

    await withEnv({ PROACTIVE_OPERATOR_DELIVERY_ENABLED: "true", PROACTIVE_OPERATOR_ALLOWLIST: undefined }, async () => {
      const reply = await diagnose(server, userId);
      assert.match(reply, /currently off — turn it on/i);
      assert.doesNotMatch(reply, /PROACTIVE_OPERATOR/);
    });
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("8. daily loop off: diagnosis explains daily_loop_disabled", async () => {
  const server = buildServer();
  const userId = `proactive-diagnose-daily-loop-off-${randomUUID()}`;

  try {
    await seedUser(userId);
    await prisma.notificationSettings.create({ data: { userId, dailyLoopEnabled: false, morningBriefEnabled: true, morningTimeMinutes: 66, timezone: "UTC" } });

    await withEnv({ PROACTIVE_OPERATOR_DELIVERY_ENABLED: "true", PROACTIVE_OPERATOR_ALLOWLIST: undefined }, async () => {
      const reply = await diagnose(server, userId);
      assert.match(reply, /the daily loop itself is off/i);
    });
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("9. already sent today: diagnosis explains the dedupe, not a false 'nothing is wrong'", async () => {
  const server = buildServer();
  const userId = `proactive-diagnose-dedupe-${randomUUID()}`;

  try {
    await seedUser(userId);
    const morningTimeMinutes = currentMinutesUtc();
    await prisma.notificationSettings.create({ data: { userId, dailyLoopEnabled: true, morningBriefEnabled: true, morningTimeMinutes, timezone: "UTC" } });
    await createActionItem(userId, { source: "manual", title: "Apply to jobs", priority: "high" });

    const sentForDate = new Date().toISOString().slice(0, 10);
    await createNotificationLog({ userId, type: "v3_morning_brief", sentForDate });

    await withEnv({ PROACTIVE_OPERATOR_DELIVERY_ENABLED: "true", PROACTIVE_OPERATOR_ALLOWLIST: undefined }, async () => {
      const reply = await diagnose(server, userId);
      assert.match(reply, /already sent today/i);
    });
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("10. everything eligible but nothing arrived: diagnosis points at the worker process, not the settings", async () => {
  const server = buildServer();
  const userId = `proactive-diagnose-eligible-${randomUUID()}`;

  try {
    await seedUser(userId);
    const morningTimeMinutes = currentMinutesUtc();
    await prisma.notificationSettings.create({ data: { userId, dailyLoopEnabled: true, morningBriefEnabled: true, morningTimeMinutes, timezone: "UTC" } });
    await createActionItem(userId, { source: "manual", title: "Apply to jobs", priority: "high" });

    await withEnv({ PROACTIVE_OPERATOR_DELIVERY_ENABLED: "true", PROACTIVE_OPERATOR_ALLOWLIST: undefined }, async () => {
      const reply = await diagnose(server, userId);
      assert.match(reply, /settings look eligible/i);
      assert.match(reply, /worker process/i);
    });
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
