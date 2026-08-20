import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createActionItem, hasNotificationLog, prisma } from "../packages/db/src/index.ts";
import { buildServer } from "../apps/api/src/server.ts";
import { runV3ProactiveMorningBriefs, type V3ProactiveNotificationSettingsLike } from "../apps/worker/src/v3-proactive-delivery.ts";
import { runLegacyDailyLoopMorningBriefs } from "../apps/worker/src/legacy-daily-loop-morning.ts";

/**
 * Prevents the exact duplicate-send bug a real Telegram smoke test surfaced: the legacy
 * daily-loop morning message (apps/api/src/operator/attention.ts's buildStartDayMessage — "First
 * move: ... / Guardrail: ...") and V3's proactive morning brief are both driven by the same
 * NotificationSettings row (dailyLoopEnabled + morningTimeMinutes) and the same worker tick, so
 * once V3 real delivery is ever turned on for a user, nothing stopped both from sending. Fix:
 * apps/worker/src/legacy-daily-loop-morning.ts skips the legacy message whenever V3 is actually
 * configured to own delivery for that user (morningBriefEnabled AND PROACTIVE_OPERATOR_DELIVERY_ENABLED
 * AND allowlisted) — see docs/10-v3-readiness-audit.md §18. Both `apiGet`s below hit the real,
 * unmodified API routes in-process via `server.inject`; only `sendTelegramMessage` is stubbed.
 */

const MORNING_UTC = new Date("2026-08-20T07:00:00.000Z"); // 09:00 Europe/Madrid
const MORNING_SENT_FOR_DATE = "2026-08-20";

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

async function seedUser(userId: string, telegramUserId: string, overrides: { morningBriefEnabled?: boolean } = {}) {
  await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
  await prisma.notificationSettings.create({
    data: {
      userId,
      telegramUserId,
      dailyLoopEnabled: true,
      morningBriefEnabled: overrides.morningBriefEnabled ?? true,
      morningTimeMinutes: 540,
      eveningTimeMinutes: 1140,
      timezone: "Europe/Madrid"
    }
  });
}

function settingsFor(userId: string, telegramUserId: string, overrides: Partial<V3ProactiveNotificationSettingsLike> = {}): V3ProactiveNotificationSettingsLike[] {
  return [{ userId, telegramUserId, dailyLoopEnabled: true, morningBriefEnabled: true, gmailNudgeEnabled: false, timezone: "Europe/Madrid", morningTimeMinutes: 540, ...overrides }];
}

test("2. V3 opted in + V3 delivery actually live + legacy dailyLoopEnabled true never produces two sends", async () => {
  const server = buildServer();
  const userId = `legacy-vs-v3-no-dup-${randomUUID()}`;

  try {
    await seedUser(userId, "222001");
    await createActionItem(userId, { source: "manual", title: "Apply to 3 developer jobs", priority: "high" });
    const legacyTelegram = stubTelegram();
    const v3Telegram = stubTelegram();

    await runLegacyDailyLoopMorningBriefs(settingsFor(userId, "222001"), {
      now: MORNING_UTC,
      v3DeliveryEnabled: true,
      v3IsAllowed: () => true,
      apiGet: injectApiGet(server),
      sendTelegramMessage: legacyTelegram.send
    });
    await runV3ProactiveMorningBriefs(settingsFor(userId, "222001"), {
      now: MORNING_UTC,
      deliveryEnabled: true,
      isAllowed: () => true,
      apiGet: injectApiGet(server),
      sendTelegramMessage: v3Telegram.send
    });

    const totalSent = legacyTelegram.sent.length + v3Telegram.sent.length;
    assert.equal(totalSent, 1, "exactly one morning message must be sent, never both and never zero");
    assert.equal(legacyTelegram.sent.length, 0, "legacy must not send once V3 owns delivery for this user");
    assert.equal(v3Telegram.sent.length, 1, "V3 must be the one that actually sends");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3. legacy daily-loop send is skipped when V3 owns delivery for the user (morningBriefEnabled + V3 delivery live)", async () => {
  const server = buildServer();
  const userId = `legacy-skipped-${randomUUID()}`;

  try {
    await seedUser(userId, "222002");
    const legacyTelegram = stubTelegram();

    await runLegacyDailyLoopMorningBriefs(settingsFor(userId, "222002"), {
      now: MORNING_UTC,
      v3DeliveryEnabled: true,
      v3IsAllowed: () => true,
      apiGet: injectApiGet(server),
      sendTelegramMessage: legacyTelegram.send
    });

    assert.equal(legacyTelegram.sent.length, 0);
    assert.equal(await hasNotificationLog({ userId, type: "daily_loop_morning", sentForDate: MORNING_SENT_FOR_DATE }), false);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("legacy daily-loop still sends when V3 delivery is not actually live for the user (the default state), even if morningBriefEnabled is true", async () => {
  const server = buildServer();
  const userId = `legacy-still-sends-default-${randomUUID()}`;

  try {
    await seedUser(userId, "222003");
    const legacyTelegram = stubTelegram();

    // v3DeliveryEnabled defaults to PROACTIVE_OPERATOR_DELIVERY_ENABLED (false unless set) — this
    // proves opting into V3's morningBriefEnabled toggle can never silently leave a user with NO
    // morning message while V3 real delivery isn't actually enabled/allowlisted for them yet.
    await runLegacyDailyLoopMorningBriefs(settingsFor(userId, "222003"), {
      now: MORNING_UTC,
      v3DeliveryEnabled: false,
      apiGet: injectApiGet(server),
      sendTelegramMessage: legacyTelegram.send
    });

    assert.equal(legacyTelegram.sent.length, 1, "legacy must still deliver a real morning message when V3 isn't actually live for this user");
    assert.equal(await hasNotificationLog({ userId, type: "daily_loop_morning", sentForDate: MORNING_SENT_FOR_DATE }), true);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("legacy daily-loop still sends when the user is not allowlisted for V3, even with V3 delivery enabled and morningBriefEnabled true", async () => {
  const server = buildServer();
  const userId = `legacy-not-allowlisted-${randomUUID()}`;

  try {
    await seedUser(userId, "222004");
    const legacyTelegram = stubTelegram();

    await runLegacyDailyLoopMorningBriefs(settingsFor(userId, "222004"), {
      now: MORNING_UTC,
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
