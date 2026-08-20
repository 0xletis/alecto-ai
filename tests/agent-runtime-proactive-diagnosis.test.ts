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

test("11. legacy daily-loop already sent today: diagnosis says so explicitly, never implying V3 sent", async () => {
  const server = buildServer();
  const userId = `proactive-diagnose-legacy-sent-${randomUUID()}`;

  try {
    await seedUser(userId);
    const morningTimeMinutes = currentMinutesUtc();
    // V3 is fully configured to look eligible (opted in, delivery flag off — the common default
    // state) but the legacy daily-loop message already went out today via the worker's own
    // legacy sender (apps/worker/src/legacy-daily-loop-morning.ts), which only ever runs when V3
    // does NOT own delivery for this user.
    await prisma.notificationSettings.create({ data: { userId, dailyLoopEnabled: true, morningBriefEnabled: true, morningTimeMinutes, timezone: "UTC" } });
    await createActionItem(userId, { source: "manual", title: "Apply to jobs", priority: "high" });

    const sentForDate = new Date().toISOString().slice(0, 10);
    await createNotificationLog({ userId, type: "daily_loop_morning", sentForDate });

    const reply = await diagnose(server, userId);
    assert.match(reply, /did get a morning message today/i);
    assert.match(reply, /legacy daily-loop/i);
    assert.doesNotMatch(reply, /settings look eligible/i, "must not answer as if V3 itself sent or is merely eligible");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("12. legacy-sent diagnosis reports the message's real send time, not the user's current scheduled time", async () => {
  const server = buildServer();
  const userId = `proactive-diagnose-legacy-sent-time-${randomUUID()}`;

  try {
    await seedUser(userId);
    // Real incident: the user changed their scheduled time AFTER a legacy message already sent
    // earlier today at the OLD time — the diagnosis must report when the message actually went
    // out, not the now-current morningTimeMinutes, or it misstates what the user actually got.
    await prisma.notificationSettings.create({ data: { userId, dailyLoopEnabled: true, morningBriefEnabled: true, morningTimeMinutes: 1200, timezone: "UTC" } });
    await createActionItem(userId, { source: "manual", title: "Apply to jobs", priority: "high" });

    const sentAt = new Date();
    const sentForDate = sentAt.toISOString().slice(0, 10);
    const realSentTime = `${String(sentAt.getUTCHours()).padStart(2, "0")}:${String(sentAt.getUTCMinutes()).padStart(2, "0")}`;
    await prisma.notificationLog.create({ data: { userId, type: "daily_loop_morning", sentForDate, sentAt } });

    const reply = await diagnose(server, userId);
    assert.match(reply, new RegExp(`around ${realSentTime}`, "i"), `expected the real send time ${realSentTime}, got: ${reply}`);
    assert.doesNotMatch(reply, /around 20:00/i, "must not report the current morningTimeMinutes setting (20:00) instead of the actual send time");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("13. if V3 itself already sent today, that takes priority over a stale earlier legacy send from the same day", async () => {
  const server = buildServer();
  const userId = `proactive-diagnose-v3-sent-over-legacy-${randomUUID()}`;

  try {
    await seedUser(userId);
    // Real incident: legacy sent once early in the day (e.g. before the user opted into V3), the
    // user later opted in and rescheduled V3, and V3 itself went on to actually send at the NEW
    // time. Asking "why didn't I get my morning brief?" after that must report V3's own success —
    // not resurface the old, no-longer-relevant legacy send from hours earlier.
    const morningTimeMinutes = currentMinutesUtc();
    await prisma.notificationSettings.create({ data: { userId, dailyLoopEnabled: true, morningBriefEnabled: true, morningTimeMinutes, timezone: "UTC" } });
    await createActionItem(userId, { source: "manual", title: "Apply to jobs", priority: "high" });

    const sentForDate = new Date().toISOString().slice(0, 10);
    const earlierToday = new Date(Date.now() - 60 * 60 * 1000);
    await prisma.notificationLog.create({ data: { userId, type: "daily_loop_morning", sentForDate, sentAt: earlierToday } });
    await createNotificationLog({ userId, type: "v3_morning_brief", sentForDate });

    const reply = await diagnose(server, userId);
    assert.match(reply, /already sent today/i, "must report V3's own successful send");
    assert.doesNotMatch(reply, /legacy daily-loop/i, "must not resurface the earlier, now-irrelevant legacy send");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
