import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createGoal, hasNotificationLog, prisma } from "../packages/db/src/index.ts";
import { buildServer } from "../apps/api/src/server.ts";
import { runV3ProactiveEveningCheckins, type V3ProactiveNotificationSettingsLike } from "../apps/worker/src/v3-proactive-delivery.ts";
import { runLegacyDailyLoopEveningReviews } from "../apps/worker/src/legacy-daily-loop-evening.ts";

/**
 * Evening equivalent of worker-legacy-vs-v3-morning.test.ts — same duplicate-send bug shape,
 * fixed the same way (fix/private-alpha-known-gaps): the legacy daily-loop evening review
 * (`GET /users/:userId/daily-loop/end-day`) and V3's proactive evening check-in are both driven
 * by the exact same NotificationSettings row (dailyLoopEnabled + eveningTimeMinutes) and the same
 * worker tick. Before this pass, evening check-in had no real send path at all, so this couldn't
 * happen yet — it became a real risk the moment runV3ProactiveEveningCheckins was added, fixed
 * with the same ownership check legacy-daily-loop-morning.ts already uses: the legacy message
 * skips whenever V3 is actually configured to own evening delivery for that user
 * (eveningCheckinEnabled AND PROACTIVE_OPERATOR_DELIVERY_ENABLED AND allowlisted).
 */

const EVENING_UTC = new Date("2026-08-20T17:00:00.000Z"); // 19:00 Europe/Madrid
const EVENING_SENT_FOR_DATE = "2026-08-20";

function injectApiGet(server: ReturnType<typeof buildServer>) {
  return async <T>(path: string): Promise<T> => {
    const response = await server.inject({ method: "GET", url: path });
    if (response.statusCode !== 200) {
      throw new Error(`GET ${path} failed with ${response.statusCode}: ${response.body}`);
    }
    return response.json() as T;
  };
}

function stubTelegram() {
  const sent: Array<{ chatId: string; text: string }> = [];
  const send = async (chatId: string, text: string): Promise<void> => {
    sent.push({ chatId, text });
  };
  return { send, sent };
}

async function seedUser(userId: string, telegramUserId: string, overrides: { eveningCheckinEnabled?: boolean } = {}) {
  await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
  await prisma.notificationSettings.create({
    data: {
      userId,
      telegramUserId,
      dailyLoopEnabled: true,
      eveningCheckinEnabled: overrides.eveningCheckinEnabled ?? true,
      morningTimeMinutes: 540,
      eveningTimeMinutes: 1140,
      timezone: "Europe/Madrid"
    }
  });
}

function settingsFor(userId: string, telegramUserId: string, overrides: Partial<V3ProactiveNotificationSettingsLike> = {}): V3ProactiveNotificationSettingsLike[] {
  return [
    {
      userId,
      telegramUserId,
      dailyLoopEnabled: true,
      morningBriefEnabled: false,
      eveningCheckinEnabled: true,
      gmailNudgeEnabled: false,
      timezone: "Europe/Madrid",
      morningTimeMinutes: 540,
      eveningTimeMinutes: 1140,
      ...overrides
    }
  ];
}

async function seedEveningCandidateGoal(userId: string) {
  await createGoal(userId, {
    title: "Apply to developer jobs",
    category: "career",
    priority: "high",
    targetMetrics: [{ key: "applications", label: "Applications sent", eventType: "career.application_sent", aggregation: "count", window: "daily" }]
  });
}

test("V3 opted in + V3 delivery actually live + legacy dailyLoopEnabled true never produces two evening sends", async () => {
  const server = buildServer();
  const userId = `legacy-vs-v3-evening-no-dup-${randomUUID()}`;

  try {
    await seedUser(userId, "223001");
    await seedEveningCandidateGoal(userId);
    const legacyTelegram = stubTelegram();
    const v3Telegram = stubTelegram();

    await runLegacyDailyLoopEveningReviews(settingsFor(userId, "223001"), {
      now: EVENING_UTC,
      v3DeliveryEnabled: true,
      v3IsAllowed: () => true,
      apiGet: injectApiGet(server),
      sendTelegramMessage: legacyTelegram.send
    });
    await runV3ProactiveEveningCheckins(settingsFor(userId, "223001"), {
      now: EVENING_UTC,
      deliveryEnabled: true,
      isAllowed: () => true,
      apiGet: injectApiGet(server),
      sendTelegramMessage: v3Telegram.send
    });

    const totalSent = legacyTelegram.sent.length + v3Telegram.sent.length;
    assert.equal(totalSent, 1, "exactly one evening message must be sent, never both and never zero");
    assert.equal(legacyTelegram.sent.length, 0, "legacy must not send once V3 owns evening delivery for this user");
    assert.equal(v3Telegram.sent.length, 1, "V3 must be the one that actually sends");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("legacy evening review is skipped when V3 owns delivery for the user (eveningCheckinEnabled + V3 delivery live)", async () => {
  const server = buildServer();
  const userId = `legacy-evening-skipped-${randomUUID()}`;

  try {
    await seedUser(userId, "223002");
    const legacyTelegram = stubTelegram();

    await runLegacyDailyLoopEveningReviews(settingsFor(userId, "223002"), {
      now: EVENING_UTC,
      v3DeliveryEnabled: true,
      v3IsAllowed: () => true,
      apiGet: injectApiGet(server),
      sendTelegramMessage: legacyTelegram.send
    });

    assert.equal(legacyTelegram.sent.length, 0);
    assert.equal(await hasNotificationLog({ userId, type: "daily_loop_evening", sentForDate: EVENING_SENT_FOR_DATE }), false);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("legacy evening review still sends when V3 delivery is not actually live for the user (the default state), even if eveningCheckinEnabled is true", async () => {
  const server = buildServer();
  const userId = `legacy-evening-still-sends-default-${randomUUID()}`;

  try {
    await seedUser(userId, "223003");
    const legacyTelegram = stubTelegram();

    // v3DeliveryEnabled defaults to PROACTIVE_OPERATOR_DELIVERY_ENABLED (false unless set) — this
    // proves opting into V3's eveningCheckinEnabled toggle can never silently leave a user with NO
    // evening message while V3 real delivery isn't actually enabled/allowlisted for them yet.
    await runLegacyDailyLoopEveningReviews(settingsFor(userId, "223003"), {
      now: EVENING_UTC,
      v3DeliveryEnabled: false,
      apiGet: injectApiGet(server),
      sendTelegramMessage: legacyTelegram.send
    });

    assert.equal(legacyTelegram.sent.length, 1, "legacy must still deliver a real evening message when V3 isn't actually live for this user");
    assert.equal(await hasNotificationLog({ userId, type: "daily_loop_evening", sentForDate: EVENING_SENT_FOR_DATE }), true);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("legacy evening review still sends when the user is not allowlisted for V3, even with V3 delivery enabled and eveningCheckinEnabled true", async () => {
  const server = buildServer();
  const userId = `legacy-evening-not-allowlisted-${randomUUID()}`;

  try {
    await seedUser(userId, "223004");
    const legacyTelegram = stubTelegram();

    await runLegacyDailyLoopEveningReviews(settingsFor(userId, "223004"), {
      now: EVENING_UTC,
      v3DeliveryEnabled: true,
      v3IsAllowed: () => false,
      apiGet: injectApiGet(server),
      sendTelegramMessage: legacyTelegram.send
    });

    assert.equal(legacyTelegram.sent.length, 1, "legacy must still deliver when this specific user is not in the V3 allowlist");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
