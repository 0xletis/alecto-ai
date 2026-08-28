import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createActionItem, hasNotificationLog, prisma } from "../packages/db/src/index.ts";
import { buildServer } from "../apps/api/src/server.ts";
import { runV3ProactiveMorningBriefs, type V3ProactiveNotificationSettingsLike } from "../apps/worker/src/v3-proactive-delivery.ts";

/**
 * fix/private-alpha-proactive-worker-delivery-and-gmail-log-noise (tasks 2 and 7): a real production
 * tester — fully opted in via natural chat (morningBriefEnabled/dailyLoopEnabled/timezone/
 * morningTimeMinutes all correctly set) — never received their 09:00 Europe/Madrid morning brief.
 * Root cause: NotificationSettings.telegramUserId is only ever written by the legacy Telegram
 * slash commands, never by the natural-chat opt-in path (proactive.settings_apply_update), so every
 * worker sender silently `continue`d past this user forever. Fixed by falling back to deriving the
 * Telegram chat id from the user's own userId ("telegram:<digits>") — see telegram-chat-id.ts.
 *
 * Test 1 below is the exact reproduction: a real Telegram-shaped userId, telegramUserId left null in
 * the DB (the natural-chat opt-in shape), morning brief due at 09:00 Europe/Madrid, an active goal to
 * ground the brief's content. Tests A-E cover the negative cases the task asked for; a real
 * unreachable chat id (case C) is now the ONLY thing that still blocks delivery — everything else
 * behaves exactly as it did before this fix.
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

function stubTelegram() {
  const sent: Array<{ chatId: string; text: string }> = [];
  const send = async (chatId: string, text: string): Promise<void> => {
    sent.push({ chatId, text });
  };
  return { send, sent };
}

function capturingLogger(): { log: (...args: unknown[]) => void; error: (...args: unknown[]) => void; lines: string[] } {
  const lines: string[] = [];
  return {
    log: (...args: unknown[]) => lines.push(args.map(String).join(" ")),
    error: (...args: unknown[]) => lines.push(args.map(String).join(" ")),
    lines
  };
}

/** A real Telegram-shaped userId with telegramUserId left NULL — the exact shape a user who opted
 * in via natural chat (proactive.settings_apply_update) ends up with, never the legacy slash-command
 * shape most other worker tests use. */
async function seedNaturalChatOptInTester(telegramDigits: string) {
  const userId = `telegram:${telegramDigits}`;
  await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
  await prisma.notificationSettings.create({
    data: {
      userId,
      telegramUserId: null,
      dailyLoopEnabled: true,
      morningBriefEnabled: true,
      eveningCheckinEnabled: false,
      gmailNudgeEnabled: false,
      morningTimeMinutes: 540,
      eveningTimeMinutes: 1140,
      timezone: "Europe/Madrid"
    }
  });
  return userId;
}

function settingsFor(userId: string, overrides: Partial<V3ProactiveNotificationSettingsLike> = {}): V3ProactiveNotificationSettingsLike[] {
  return [
    {
      userId,
      telegramUserId: undefined,
      dailyLoopEnabled: true,
      morningBriefEnabled: true,
      eveningCheckinEnabled: false,
      gmailNudgeEnabled: false,
      timezone: "Europe/Madrid",
      morningTimeMinutes: 540,
      eveningTimeMinutes: 1140,
      ...overrides
    }
  ];
}

test("1. exact tester reproduction: natural-chat opt-in with telegramUserId null still delivers the 09:00 Europe/Madrid morning brief", async () => {
  const server = buildServer();
  const telegramDigits = "1096010998";
  const userId = await seedNaturalChatOptInTester(telegramDigits);

  try {
    await createActionItem(userId, { source: "manual", title: "Apply to jobs", priority: "high" });
    const telegram = stubTelegram();

    const summary = await runV3ProactiveMorningBriefs(settingsFor(userId), {
      now: MORNING_UTC,
      deliveryEnabled: true,
      apiGet: injectApiGet(server),
      sendTelegramMessage: telegram.send
    });

    assert.equal(summary.due, 1, "the user's scheduled minute matched this tick");
    assert.equal(telegram.sent.length, 1, "the tester must actually receive a Telegram message, not just a generated-but-undelivered brief");
    assert.equal(telegram.sent[0].chatId, telegramDigits, "the chat id must be derived from the userId itself, since NotificationSettings.telegramUserId was never set");
    assert.match(telegram.sent[0].text, /apply to jobs/i);
    assert.equal(await hasNotificationLog({ userId, type: MORNING_DEDUPE_KEY, sentForDate: MORNING_SENT_FOR_DATE }), true, "NotificationLog must only be written after the real Telegram send above succeeded");
    assert.equal(summary.sent, 1);
    assert.equal(summary.skipped, 0);
    assert.equal(summary.errors, 0);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("A. delivery disabled: skipped with an explicit, discoverable reason — never a silent no-op", async () => {
  const server = buildServer();
  const telegramDigits = "1096010001";
  const userId = await seedNaturalChatOptInTester(telegramDigits);

  try {
    await createActionItem(userId, { source: "manual", title: "Apply to jobs", priority: "high" });
    const telegram = stubTelegram();
    const logger = capturingLogger();

    const summary = await runV3ProactiveMorningBriefs(settingsFor(userId), {
      now: MORNING_UTC,
      deliveryEnabled: false,
      apiGet: injectApiGet(server),
      sendTelegramMessage: telegram.send,
      logger
    });

    assert.equal(telegram.sent.length, 0);
    assert.equal(summary.sent, 0);
    assert.ok(logger.lines.some((line) => line.includes("PROACTIVE_OPERATOR_DELIVERY_ENABLED")), "the reason must be explicit and discoverable in logs, not silent");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("B. allowlist excludes the user: skipped with an explicit reason", async () => {
  const server = buildServer();
  const telegramDigits = "1096010002";
  const userId = await seedNaturalChatOptInTester(telegramDigits);

  try {
    await createActionItem(userId, { source: "manual", title: "Apply to jobs", priority: "high" });
    const telegram = stubTelegram();
    const logger = capturingLogger();

    const summary = await runV3ProactiveMorningBriefs(settingsFor(userId), {
      now: MORNING_UTC,
      deliveryEnabled: true,
      isAllowed: () => false,
      apiGet: injectApiGet(server),
      sendTelegramMessage: telegram.send,
      logger
    });

    assert.equal(telegram.sent.length, 0);
    assert.equal(summary.skippedReasons.not_allowlisted, 1);
    assert.ok(logger.lines.some((line) => line.includes("PROACTIVE_OPERATOR_ALLOWLIST")));
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("C. no resolvable Telegram chat id at all: skipped with an explicit reason, never a crash or a silent forever-skip", async () => {
  const server = buildServer();
  // Deliberately NOT telegram-shaped and telegramUserId left unset — the one remaining real failure
  // mode after this fix (e.g. a user created through a non-Telegram channel that never got a chat id).
  const userId = `unroutable-tester-${randomUUID()}`;
  await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });

  try {
    await createActionItem(userId, { source: "manual", title: "Apply to jobs", priority: "high" });
    const telegram = stubTelegram();
    const logger = capturingLogger();

    const summary = await runV3ProactiveMorningBriefs(settingsFor(userId), {
      now: MORNING_UTC,
      deliveryEnabled: true,
      apiGet: injectApiGet(server),
      sendTelegramMessage: telegram.send,
      logger
    });

    assert.equal(telegram.sent.length, 0);
    assert.equal(summary.due, 1, "the schedule still matched — the block is specifically the missing chat id, not a scheduling miss");
    assert.equal(summary.skippedReasons.missing_telegram_user_id, 1);
    assert.ok(logger.lines.some((line) => line.includes("no resolvable Telegram chat id")));
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("D. already sent today: a second tick the same day is skipped as a dedupe, not resent", async () => {
  const server = buildServer();
  const telegramDigits = "1096010004";
  const userId = await seedNaturalChatOptInTester(telegramDigits);

  try {
    await createActionItem(userId, { source: "manual", title: "Apply to jobs", priority: "high" });
    const telegram = stubTelegram();

    await runV3ProactiveMorningBriefs(settingsFor(userId), {
      now: MORNING_UTC,
      deliveryEnabled: true,
      apiGet: injectApiGet(server),
      sendTelegramMessage: telegram.send
    });
    assert.equal(telegram.sent.length, 1, "sanity check: the first tick sent normally");

    const summary = await runV3ProactiveMorningBriefs(settingsFor(userId), {
      now: MORNING_UTC,
      deliveryEnabled: true,
      apiGet: injectApiGet(server),
      sendTelegramMessage: telegram.send
    });

    assert.equal(telegram.sent.length, 1, "a second tick the same day must never send a duplicate message");
    assert.equal(summary.sent, 0);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("E. before the scheduled window: not due yet — no send attempt at all", async () => {
  const server = buildServer();
  const telegramDigits = "1096010005";
  const userId = await seedNaturalChatOptInTester(telegramDigits);

  try {
    await createActionItem(userId, { source: "manual", title: "Apply to jobs", priority: "high" });
    const telegram = stubTelegram();

    // 07:00 Europe/Madrid — two hours before the user's 09:00 schedule.
    const summary = await runV3ProactiveMorningBriefs(settingsFor(userId), {
      now: new Date("2026-08-20T05:00:00.000Z"),
      deliveryEnabled: true,
      apiGet: injectApiGet(server),
      sendTelegramMessage: telegram.send
    });

    assert.equal(summary.due, 0, "the exact-minute schedule never matched, so this user is not even considered due this tick");
    assert.equal(telegram.sent.length, 0);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
