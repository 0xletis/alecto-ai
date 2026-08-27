import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createActionItem, createNotificationLog, prisma } from "../packages/db/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, mockPlan, op, sendAgentMessage, seedUser } from "./helpers/agent-runtime-test-helpers.ts";
import { formatProactiveDeliveryDiagnosis } from "../apps/api/src/operator/proactive-eligibility.ts";

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
      assert.match(reply, /configured on, but delivery is disabled on this server/i);
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
      assert.match(reply, /was skipped today/i);
      assert.match(reply, /not eligible — not in the allowlist/i);
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

test("8. daily loop off self-heals: a stale morningBriefEnabled=true/dailyLoopEnabled=false user is repaired by simply asking, not stuck on daily_loop_disabled", async () => {
  const server = buildServer();
  const userId = `proactive-diagnose-daily-loop-off-${randomUUID()}`;

  try {
    await seedUser(userId);
    // fix/private-alpha-proactive-launch-config-cleanup (task 1): this exact seeded state — a
    // real, previously-reported one — used to produce a permanent "daily_loop_disabled"
    // diagnosis until the user manually re-toggled the setting. selfHealDailyLoopEnabled now
    // repairs it on this same read, so the diagnosis reflects whatever the NEXT real blocker (or
    // lack of one) actually is, never daily_loop_disabled for a user who is genuinely opted in.
    await prisma.notificationSettings.create({ data: { userId, dailyLoopEnabled: false, morningBriefEnabled: true, morningTimeMinutes: 66, timezone: "UTC" } });

    await withEnv({ PROACTIVE_OPERATOR_DELIVERY_ENABLED: "true", PROACTIVE_OPERATOR_ALLOWLIST: undefined }, async () => {
      const reply = await diagnose(server, userId);
      assert.doesNotMatch(reply, /the daily loop itself is off/i, `self-heal should have repaired dailyLoopEnabled before this diagnosis ran — got: ${reply}`);
    });

    const healed = await prisma.notificationSettings.findUnique({ where: { userId } });
    assert.equal(healed?.dailyLoopEnabled, true, "dailyLoopEnabled must be repaired in the DB, not just in the one reply");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("8b. daily_loop_disabled wording itself is still correct (defensive fallback, exercised directly since self-heal makes it unreachable via the live diagnose path)", () => {
  const settings: Parameters<typeof formatProactiveDeliveryDiagnosis>[1] = {
    id: "test",
    userId: "test",
    dailyCheckinEnabled: false,
    dailyInsightEnabled: false,
    weeklyInsightEnabled: false,
    dailyLoopEnabled: false,
    morningBriefEnabled: true,
    eveningCheckinEnabled: false,
    gmailNudgeEnabled: false,
    timezone: "UTC",
    defaultActionTimeMinutes: 540,
    morningTimeMinutes: 540,
    afternoonTimeMinutes: 900,
    eveningTimeMinutes: 1140,
    tonightTimeMinutes: 1200,
    createdAt: new Date(),
    updatedAt: new Date()
  };
  const message = formatProactiveDeliveryDiagnosis("daily_loop_disabled", settings);
  assert.match(message, /internal daily loop is off/i);
  assert.match(message, /self-heal automatically/i);
  assert.match(message, /"turn on morning brief" again to repair/i);
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
      // fix/private-alpha-gmail-classifier-precision-and-proactive-diagnostics: now reports the
      // real sent time (e.g. "sent today at 10:19"), not a vague "already sent today" hedge.
      assert.match(reply, /was sent today at \d{2}:\d{2}/i);
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
    assert.match(reply, /was sent today at \d{2}:\d{2}/i, "must report V3's own successful send");
    assert.doesNotMatch(reply, /legacy daily-loop/i, "must not resurface the earlier, now-irrelevant legacy send");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("14. with no allowlist configured, the eligible diagnosis names that fact plainly — never as a missing_allowlist error", async () => {
  const server = buildServer();
  const userId = `proactive-diagnose-no-allowlist-${randomUUID()}`;

  try {
    await seedUser(userId);
    const morningTimeMinutes = currentMinutesUtc();
    await prisma.notificationSettings.create({ data: { userId, dailyLoopEnabled: true, morningBriefEnabled: true, morningTimeMinutes, timezone: "UTC" } });
    await createActionItem(userId, { source: "manual", title: "Apply to jobs", priority: "high" });

    await withEnv({ PROACTIVE_OPERATOR_DELIVERY_ENABLED: "true", PROACTIVE_OPERATOR_ALLOWLIST: undefined }, async () => {
      const reply = await diagnose(server, userId);
      assert.match(reply, /settings look eligible/i);
      assert.match(reply, /no allowlist is configured/i);
      assert.doesNotMatch(reply, /missing|error|misconfigured|not restricting anyone is (wrong|bad)/i, "a missing allowlist is the normal solo/dev-phase default, not a problem to flag");
    });
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

function mod1440(minutes: number): number {
  return ((minutes % 1440) + 1440) % 1440;
}

test("15. asked well before the scheduled window: diagnosis says due today, never the old hand-wavy hedge", async () => {
  const server = buildServer();
  const userId = `proactive-diagnose-due-later-${randomUUID()}`;

  try {
    await seedUser(userId);
    // Two hours ahead of "now" (outside the +/-30 minute window either side) - the window check
    // has not opened yet today.
    const morningTimeMinutes = mod1440(currentMinutesUtc() + 120);
    await prisma.notificationSettings.create({ data: { userId, dailyLoopEnabled: true, morningBriefEnabled: true, morningTimeMinutes, timezone: "UTC" } });

    await withEnv({ PROACTIVE_OPERATOR_DELIVERY_ENABLED: "true", PROACTIVE_OPERATOR_ALLOWLIST: undefined }, async () => {
      const reply = await diagnose(server, userId);
      assert.match(reply, /morning brief is on and due today around \d{2}:\d{2}/i);
      assert.doesNotMatch(reply, /it's not that time yet|already passed for today|nothing should have sent/i, "must never fall back to the old hand-wavy hedge");
    });
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("16. asked well after the window with no sent record: diagnosis says missed, not a vague hedge", async () => {
  const server = buildServer();
  const userId = `proactive-diagnose-missed-${randomUUID()}`;

  try {
    await seedUser(userId);
    // Two hours behind "now" (outside the window either side) with no NotificationLog written -
    // the window has already closed today and nothing was ever sent.
    const morningTimeMinutes = mod1440(currentMinutesUtc() - 120);
    await prisma.notificationSettings.create({ data: { userId, dailyLoopEnabled: true, morningBriefEnabled: true, morningTimeMinutes, timezone: "UTC" } });

    await withEnv({ PROACTIVE_OPERATOR_DELIVERY_ENABLED: "true", PROACTIVE_OPERATOR_ALLOWLIST: undefined }, async () => {
      const reply = await diagnose(server, userId);
      assert.match(reply, /morning brief should have sent today around \d{2}:\d{2}, but i don't see a sent record/i);
      assert.match(reply, /current status: eligible/i);
      assert.match(reply, /next due: tomorrow \d{2}:\d{2}/i);
      assert.doesNotMatch(reply, /it's not that time yet|already passed for today|nothing should have sent/i, "must never fall back to the old hand-wavy hedge");
    });
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("17. timezone Europe/Madrid is respected - computed against the user's own local time, not server UTC", async () => {
  const server = buildServer();
  const userId = `proactive-diagnose-madrid-${randomUUID()}`;

  try {
    await seedUser(userId);
    const nowMadridMinutes = Number(
      new Intl.DateTimeFormat("en-US", { timeZone: "Europe/Madrid", hour: "numeric", minute: "numeric", hourCycle: "h23" })
        .formatToParts(new Date())
        .reduce((acc, part) => (part.type === "hour" ? acc + Number(part.value) * 60 : part.type === "minute" ? acc + Number(part.value) : acc), 0)
    );
    // Two hours ahead of Madrid's current local time. If the diagnosis ever computed this
    // against server/UTC time instead of the configured "Europe/Madrid" timezone, Madrid's UTC
    // offset (+1 or +2) would push this outside the "due later today" window and misreport it as
    // missed - so this only passes if the timezone is genuinely honored.
    // Clamped (never wrapped past midnight) so the comparison stays in the same local day even
    // if the test happens to run very late in Madrid's day.
    const morningTimeMinutes = Math.min(nowMadridMinutes + 120, 1439);
    await prisma.notificationSettings.create({ data: { userId, dailyLoopEnabled: true, morningBriefEnabled: true, morningTimeMinutes, timezone: "Europe/Madrid" } });

    await withEnv({ PROACTIVE_OPERATOR_DELIVERY_ENABLED: "true", PROACTIVE_OPERATOR_ALLOWLIST: undefined }, async () => {
      const reply = await diagnose(server, userId);
      assert.match(reply, /morning brief is on and due today around \d{2}:\d{2}/i);
    });
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
