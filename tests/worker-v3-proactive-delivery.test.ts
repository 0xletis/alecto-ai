import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createActionItem, createGoal, createNotificationLog, hasNotificationLog, prisma } from "../packages/db/src/index.ts";
import { buildServer } from "../apps/api/src/server.ts";
import { runV3ProactiveMorningBriefs, type V3ProactiveNotificationSettingsLike } from "../apps/worker/src/v3-proactive-delivery.ts";

/**
 * apps/worker/src/v3-proactive-delivery.ts — the first real delivery path for Agent Runtime
 * v3's Proactive Operator MVP, morning_brief ONLY, off by default. `apiGet` is wired to a real
 * in-process `buildServer()` via `server.inject` (no real network, but the REAL, unmodified
 * preview route + decision module run for real) — sendTelegramMessage is a plain stub so no
 * test ever touches the real Telegram API. This deliberately re-uses the real preview route
 * rather than re-mocking decideProactiveOperatorMessage's own logic, which is already covered
 * by tests/agent-runtime-proactive.test.ts.
 */

const MORNING_UTC = new Date("2026-08-20T07:00:00.000Z"); // 09:00 Europe/Madrid
const MORNING_SENT_FOR_DATE = "2026-08-20";
const MORNING_DEDUPE_KEY = "v3_morning_brief";

function injectApiGet(server: ReturnType<typeof buildServer>) {
  return async <T>(path: string): Promise<T> => {
    const response = await server.inject({ method: "GET", url: path });
    if (response.statusCode !== 200) {
      throw new Error(`GET ${path} failed with ${response.statusCode}: ${response.body}`);
    }
    return response.json() as T;
  };
}

function stubTelegram(options: { fail?: boolean } = {}) {
  const sent: Array<{ chatId: string; text: string }> = [];
  const send = async (chatId: string, text: string): Promise<void> => {
    if (options.fail) {
      throw new Error("simulated Telegram failure");
    }
    sent.push({ chatId, text });
  };
  return { send, sent };
}

async function seedMorningUser(userId: string, telegramUserId: string, overrides: { eveningTimeMinutes?: number; morningBriefEnabled?: boolean } = {}) {
  await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
  await prisma.notificationSettings.create({
    data: {
      userId,
      telegramUserId,
      dailyLoopEnabled: true,
      morningBriefEnabled: overrides.morningBriefEnabled ?? true,
      morningTimeMinutes: 540,
      eveningTimeMinutes: overrides.eveningTimeMinutes ?? 1140,
      timezone: "Europe/Madrid"
    }
  });
}

function settingsFor(userId: string, telegramUserId: string, overrides: Partial<V3ProactiveNotificationSettingsLike> = {}): V3ProactiveNotificationSettingsLike[] {
  return [{ userId, telegramUserId, dailyLoopEnabled: true, morningBriefEnabled: true, timezone: "Europe/Madrid", morningTimeMinutes: 540, ...overrides }];
}

test("1. delivery disabled: no send, no NotificationLog", async () => {
  const server = buildServer();
  const userId = `delivery-disabled-${randomUUID()}`;

  try {
    await seedMorningUser(userId, "111111");
    await createActionItem(userId, { source: "manual", title: "Apply to jobs", priority: "high" });
    const telegram = stubTelegram();

    await runV3ProactiveMorningBriefs(settingsFor(userId, "111111"), {
      now: MORNING_UTC,
      deliveryEnabled: false,
      apiGet: injectApiGet(server),
      sendTelegramMessage: telegram.send
    });

    assert.equal(telegram.sent.length, 0);
    assert.equal(await hasNotificationLog({ userId, type: MORNING_DEDUPE_KEY, sentForDate: MORNING_SENT_FOR_DATE }), false);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("1b. env enabled + allowlisted, but the user has not opted in at the settings level: no send, no NotificationLog", async () => {
  const server = buildServer();
  const userId = `delivery-not-opted-in-${randomUUID()}`;

  try {
    await seedMorningUser(userId, "101010", { morningBriefEnabled: false });
    await createActionItem(userId, { source: "manual", title: "Apply to jobs", priority: "high" });
    const telegram = stubTelegram();

    // The worker's own settings query result reflects the real DB row — morningBriefEnabled:
    // false must be enough to suppress a send even with the master flag and allowlist wide open.
    await runV3ProactiveMorningBriefs(settingsFor(userId, "101010", { morningBriefEnabled: false }), {
      now: MORNING_UTC,
      deliveryEnabled: true,
      apiGet: injectApiGet(server),
      sendTelegramMessage: telegram.send
    });

    assert.equal(telegram.sent.length, 0);
    assert.equal(await hasNotificationLog({ userId, type: MORNING_DEDUPE_KEY, sentForDate: MORNING_SENT_FOR_DATE }), false);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2. delivery enabled with a morning_brief candidate: sends exactly one Telegram message", async () => {
  const server = buildServer();
  const userId = `delivery-enabled-${randomUUID()}`;

  try {
    await seedMorningUser(userId, "222222");
    await createActionItem(userId, { source: "manual", title: "Apply to jobs", priority: "high" });
    const telegram = stubTelegram();

    await runV3ProactiveMorningBriefs(settingsFor(userId, "222222"), {
      now: MORNING_UTC,
      deliveryEnabled: true,
      apiGet: injectApiGet(server),
      sendTelegramMessage: telegram.send
    });

    assert.equal(telegram.sent.length, 1);
    assert.equal(telegram.sent[0].chatId, "222222");
    assert.match(telegram.sent[0].text, /apply to jobs/i);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3. NotificationLog is written only after a successful send, with the decision's own dedupeKey", async () => {
  const server = buildServer();
  const userId = `delivery-log-after-send-${randomUUID()}`;

  try {
    await seedMorningUser(userId, "333333");
    await createActionItem(userId, { source: "manual", title: "Apply to jobs", priority: "high" });
    const telegram = stubTelegram();

    assert.equal(await hasNotificationLog({ userId, type: MORNING_DEDUPE_KEY, sentForDate: MORNING_SENT_FOR_DATE }), false);

    await runV3ProactiveMorningBriefs(settingsFor(userId, "333333"), {
      now: MORNING_UTC,
      deliveryEnabled: true,
      apiGet: injectApiGet(server),
      sendTelegramMessage: telegram.send
    });

    assert.equal(telegram.sent.length, 1);
    assert.equal(await hasNotificationLog({ userId, type: MORNING_DEDUPE_KEY, sentForDate: MORNING_SENT_FOR_DATE }), true);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4. a failed send never writes NotificationLog", async () => {
  const server = buildServer();
  const userId = `delivery-failed-send-${randomUUID()}`;

  try {
    await seedMorningUser(userId, "444444");
    await createActionItem(userId, { source: "manual", title: "Apply to jobs", priority: "high" });
    const telegram = stubTelegram({ fail: true });

    await runV3ProactiveMorningBriefs(settingsFor(userId, "444444"), {
      now: MORNING_UTC,
      deliveryEnabled: true,
      apiGet: injectApiGet(server),
      sendTelegramMessage: telegram.send
    });

    assert.equal(telegram.sent.length, 0);
    assert.equal(await hasNotificationLog({ userId, type: MORNING_DEDUPE_KEY, sentForDate: MORNING_SENT_FOR_DATE }), false, "an undelivered message must stay eligible to retry, never marked sent");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("5. a duplicate dedupe key (already sent today) suppresses the send", async () => {
  const server = buildServer();
  const userId = `delivery-dedupe-${randomUUID()}`;

  try {
    await seedMorningUser(userId, "555555");
    await createActionItem(userId, { source: "manual", title: "Apply to jobs", priority: "high" });
    // The real preview route itself excludes an already-logged candidate — simulating that a
    // prior tick (or the manual smoke test) already delivered today's morning brief.
    await createNotificationLog({ userId, type: MORNING_DEDUPE_KEY, sentForDate: MORNING_SENT_FOR_DATE });
    const telegram = stubTelegram();

    await runV3ProactiveMorningBriefs(settingsFor(userId, "555555"), {
      now: MORNING_UTC,
      deliveryEnabled: true,
      apiGet: injectApiGet(server),
      sendTelegramMessage: telegram.send
    });

    assert.equal(telegram.sent.length, 0, "must not send a second morning brief for the same local day");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("6. an evening_checkin candidate is never sent this pass", async () => {
  const server = buildServer();
  const userId = `delivery-evening-not-sent-${randomUUID()}`;

  try {
    // Morning and evening windows deliberately overlap (both 09:00) so the trigger check in
    // runV3ProactiveMorningBriefs (which only ever fires at the user's morning time) can still
    // observe an evening_checkin decision — achieved by having the morning_brief candidate
    // itself already "sent" (excluded), leaving evening_checkin as the top eligible candidate.
    await seedMorningUser(userId, "666666", { eveningTimeMinutes: 540 });
    await createNotificationLog({ userId, type: MORNING_DEDUPE_KEY, sentForDate: MORNING_SENT_FOR_DATE });
    await createGoal(userId, {
      title: "Apply to developer jobs",
      category: "career",
      priority: "high",
      targetMetrics: [{ key: "applications", label: "Applications sent", eventType: "career.application_sent", aggregation: "count", window: "daily" }]
    });
    const telegram = stubTelegram();

    const preview = await injectApiGet(server)<{ decision: { decision: string; type?: string } }>(
      `/users/${userId}/operator/proactive/preview?now=${encodeURIComponent(MORNING_UTC.toISOString())}`
    );
    assert.equal(preview.decision.decision, "proposed_message");
    assert.equal(preview.decision.type, "evening_checkin", "test setup sanity check: the preview route must actually offer an evening_checkin here");

    await runV3ProactiveMorningBriefs(settingsFor(userId, "666666"), {
      now: MORNING_UTC,
      deliveryEnabled: true,
      apiGet: injectApiGet(server),
      sendTelegramMessage: telegram.send
    });

    assert.equal(telegram.sent.length, 0, "evening_checkin must stay preview-only this pass");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("7. a gmail_nudge candidate is never sent this pass", async () => {
  const server = buildServer();
  const userId = `delivery-gmail-not-sent-${randomUUID()}`;

  try {
    await seedMorningUser(userId, "777777");
    await createNotificationLog({ userId, type: MORNING_DEDUPE_KEY, sentForDate: MORNING_SENT_FOR_DATE });
    const connection = await prisma.integrationConnection.create({ data: { userId, integrationId: "gmail", status: "active", config: {} } });
    const rule = await prisma.emailSignalRule.create({ data: { userId, connectionId: connection.id, adapterId: "custom_email_review", name: "Recruiter replies", status: "active", createdBy: "user" } });
    await prisma.emailReviewItem.create({
      data: {
        userId,
        connectionId: connection.id,
        ruleId: rule.id,
        adapterId: "custom_email_review",
        provider: "gmail",
        providerMessageId: "m1",
        externalId: `gmail-review:${rule.id}:m1`,
        subject: "Recruiter reply from Example Labs",
        confidence: 0.9,
        reason: "custom_rule_match",
        extracted: {},
        status: "pending"
      }
    });
    const telegram = stubTelegram();

    const preview = await injectApiGet(server)<{ decision: { decision: string; type?: string } }>(
      `/users/${userId}/operator/proactive/preview?now=${encodeURIComponent(MORNING_UTC.toISOString())}`
    );
    assert.equal(preview.decision.decision, "proposed_message");
    assert.equal(preview.decision.type, "gmail_nudge", "test setup sanity check: the preview route must actually offer a gmail_nudge here");

    await runV3ProactiveMorningBriefs(settingsFor(userId, "777777"), {
      now: MORNING_UTC,
      deliveryEnabled: true,
      apiGet: injectApiGet(server),
      sendTelegramMessage: telegram.send
    });

    assert.equal(telegram.sent.length, 0, "gmail_nudge must stay preview-only this pass");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("8. the preview route itself still writes nothing, delivery enabled or not", async () => {
  const server = buildServer();
  const userId = `delivery-preview-untouched-${randomUUID()}`;

  try {
    await seedMorningUser(userId, "888888");
    await createActionItem(userId, { source: "manual", title: "Apply to jobs", priority: "high" });

    await injectApiGet(server)(`/users/${userId}/operator/proactive/preview?now=${encodeURIComponent(MORNING_UTC.toISOString())}`);
    await injectApiGet(server)(`/users/${userId}/operator/proactive/preview?now=${encodeURIComponent(MORNING_UTC.toISOString())}`);

    assert.equal(await hasNotificationLog({ userId, type: MORNING_DEDUPE_KEY, sentForDate: MORNING_SENT_FOR_DATE }), false, "the preview route must never write NotificationLog itself, no matter how many times it's called");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("an allowlisted user is delivered to, a non-allowlisted user is skipped", async () => {
  const server = buildServer();
  const allowedUserId = `delivery-allowlisted-${randomUUID()}`;
  const blockedUserId = `delivery-blocked-${randomUUID()}`;

  try {
    await seedMorningUser(allowedUserId, "999991");
    await createActionItem(allowedUserId, { source: "manual", title: "Apply to jobs", priority: "high" });
    await seedMorningUser(blockedUserId, "999992");
    await createActionItem(blockedUserId, { source: "manual", title: "Apply to jobs", priority: "high" });
    const telegram = stubTelegram();

    await runV3ProactiveMorningBriefs([...settingsFor(allowedUserId, "999991"), ...settingsFor(blockedUserId, "999992")], {
      now: MORNING_UTC,
      deliveryEnabled: true,
      isAllowed: (userId) => userId === allowedUserId,
      apiGet: injectApiGet(server),
      sendTelegramMessage: telegram.send
    });

    assert.equal(telegram.sent.length, 1);
    assert.equal(telegram.sent[0].chatId, "999991");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: { in: [allowedUserId, blockedUserId] } } });
  }
});
