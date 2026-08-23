import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createActionItem, createGoal, createNotificationLog, hasNotificationLog, prisma } from "../packages/db/src/index.ts";
import { buildServer } from "../apps/api/src/server.ts";
import {
  runV3ProactiveEveningCheckins,
  runV3ProactiveGmailNudges,
  runV3ProactiveMorningBriefs,
  type V3ProactiveNotificationSettingsLike
} from "../apps/worker/src/v3-proactive-delivery.ts";
import { clearAgentRuntimeMocks, mockPlan, op, sendAgentMessage } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * apps/worker/src/v3-proactive-delivery.ts — the real delivery path for Agent Runtime
 * v3's Proactive Operator MVP, morning_brief and gmail_nudge only, off by default. `apiGet` is wired to a real
 * in-process `buildServer()` via `server.inject` (no real network, but the REAL, unmodified
 * preview route + decision module run for real) — sendTelegramMessage is a plain stub so no
 * test ever touches the real Telegram API. This deliberately re-uses the real preview route
 * rather than re-mocking decideProactiveOperatorMessage's own logic, which is already covered
 * by tests/agent-runtime-proactive.test.ts.
 */

const MORNING_UTC = new Date("2026-08-20T07:00:00.000Z"); // 09:00 Europe/Madrid
const EVENING_UTC = new Date("2026-08-20T17:00:00.000Z"); // 19:00 Europe/Madrid
const GMAIL_NUDGE_UTC = new Date("2026-08-20T11:00:00.000Z"); // 13:00 Europe/Madrid
const MORNING_SENT_FOR_DATE = "2026-08-20";
const MORNING_DEDUPE_KEY = "v3_morning_brief";
const EVENING_DEDUPE_KEY = "v3_evening_checkin";

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

async function seedMorningUser(
  userId: string,
  telegramUserId: string,
  overrides: {
    dailyLoopEnabled?: boolean;
    eveningTimeMinutes?: number;
    morningBriefEnabled?: boolean;
    eveningCheckinEnabled?: boolean;
    gmailNudgeEnabled?: boolean;
  } = {}
) {
  await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
  await prisma.notificationSettings.create({
    data: {
      userId,
      telegramUserId,
      dailyLoopEnabled: overrides.dailyLoopEnabled ?? true,
      morningBriefEnabled: overrides.morningBriefEnabled ?? true,
      eveningCheckinEnabled: overrides.eveningCheckinEnabled ?? true,
      gmailNudgeEnabled: overrides.gmailNudgeEnabled ?? false,
      morningTimeMinutes: 540,
      eveningTimeMinutes: overrides.eveningTimeMinutes ?? 1140,
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
      morningBriefEnabled: true,
      eveningCheckinEnabled: true,
      gmailNudgeEnabled: false,
      timezone: "Europe/Madrid",
      morningTimeMinutes: 540,
      eveningTimeMinutes: 1140,
      ...overrides
    }
  ];
}

async function seedPendingGmailReview(userId: string, overrides: { subject?: string; from?: string; snippet?: string } = {}) {
  const connection = await prisma.integrationConnection.create({ data: { userId, integrationId: "gmail", status: "active", config: {} } });
  const rule = await prisma.emailSignalRule.create({
    data: { userId, connectionId: connection.id, adapterId: "custom_email_review", name: "Recruiter replies", status: "active", createdBy: "user" }
  });
  return prisma.emailReviewItem.create({
    data: {
      userId,
      connectionId: connection.id,
      ruleId: rule.id,
      adapterId: "custom_email_review",
      provider: "gmail",
      providerMessageId: "m1",
      externalId: `gmail-review:${rule.id}:m1`,
      subject: overrides.subject ?? "Recruiter reply from Example Labs",
      from: overrides.from ?? "recruiter@example.com",
      snippet: overrides.snippet ?? "Can we talk tomorrow?",
      confidence: 0.9,
      reason: "custom_rule_match",
      extracted: {},
      status: "pending"
    }
  });
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

test("6. runV3ProactiveMorningBriefs itself never sends an evening_checkin decision, even when the preview offers one — each function only ever sends its own expected type", async () => {
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

    assert.equal(telegram.sent.length, 0, "runV3ProactiveMorningBriefs must never send a decision of a different type, regardless of what the preview offers");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// fix/private-alpha-known-gaps: evening_checkin now has a real send path
// (runV3ProactiveEveningCheckins), mirroring runV3ProactiveMorningBriefs exactly. Reuses the same
// active-goal-with-a-daily-eventType-metric-and-no-event-logged-today fixture the test above
// already established produces a real evening_checkin candidate from the actual, unmocked
// decision module.
async function seedEveningCandidateGoal(userId: string) {
  await createGoal(userId, {
    title: "Apply to developer jobs",
    category: "career",
    priority: "high",
    targetMetrics: [{ key: "applications", label: "Applications sent", eventType: "career.application_sent", aggregation: "count", window: "daily" }]
  });
}

test("A. evening check-in sends when opted in, allowlisted, due, and delivery is enabled", async () => {
  const server = buildServer();
  const userId = `evening-sends-${randomUUID()}`;

  try {
    await seedMorningUser(userId, "700001");
    await seedEveningCandidateGoal(userId);
    const telegram = stubTelegram();

    await runV3ProactiveEveningCheckins(settingsFor(userId, "700001"), {
      now: EVENING_UTC,
      deliveryEnabled: true,
      apiGet: injectApiGet(server),
      sendTelegramMessage: telegram.send
    });

    assert.equal(telegram.sent.length, 1);
    assert.equal(telegram.sent[0].chatId, "700001");
    assert.match(telegram.sent[0].text, /apply to developer jobs/i);
    assert.equal(await hasNotificationLog({ userId, type: EVENING_DEDUPE_KEY, sentForDate: MORNING_SENT_FOR_DATE }), true);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("B. evening check-in does not send twice the same day — a duplicate dedupe key suppresses the second send", async () => {
  const server = buildServer();
  const userId = `evening-no-dupe-${randomUUID()}`;

  try {
    await seedMorningUser(userId, "700002");
    await seedEveningCandidateGoal(userId);
    await createNotificationLog({ userId, type: EVENING_DEDUPE_KEY, sentForDate: MORNING_SENT_FOR_DATE });
    const telegram = stubTelegram();

    await runV3ProactiveEveningCheckins(settingsFor(userId, "700002"), {
      now: EVENING_UTC,
      deliveryEnabled: true,
      apiGet: injectApiGet(server),
      sendTelegramMessage: telegram.send
    });

    assert.equal(telegram.sent.length, 0, "must not send a second evening check-in for the same local day");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("C. evening check-in does not send when PROACTIVE_OPERATOR_DELIVERY_ENABLED is off, even fully opted in and due", async () => {
  const server = buildServer();
  const userId = `evening-delivery-disabled-${randomUUID()}`;

  try {
    await seedMorningUser(userId, "700003");
    await seedEveningCandidateGoal(userId);
    const telegram = stubTelegram();

    await runV3ProactiveEveningCheckins(settingsFor(userId, "700003"), {
      now: EVENING_UTC,
      deliveryEnabled: false,
      apiGet: injectApiGet(server),
      sendTelegramMessage: telegram.send
    });

    assert.equal(telegram.sent.length, 0);
    assert.equal(await hasNotificationLog({ userId, type: EVENING_DEDUPE_KEY, sentForDate: MORNING_SENT_FOR_DATE }), false);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("D. evening check-in does not send when the user is not on the configured allowlist, even fully opted in and due", async () => {
  const server = buildServer();
  const userId = `evening-not-allowlisted-${randomUUID()}`;

  try {
    await seedMorningUser(userId, "700004");
    await seedEveningCandidateGoal(userId);
    const telegram = stubTelegram();

    await runV3ProactiveEveningCheckins(settingsFor(userId, "700004"), {
      now: EVENING_UTC,
      deliveryEnabled: true,
      isAllowed: () => false,
      apiGet: injectApiGet(server),
      sendTelegramMessage: telegram.send
    });

    assert.equal(telegram.sent.length, 0);
    assert.equal(await hasNotificationLog({ userId, type: EVENING_DEDUPE_KEY, sentForDate: MORNING_SENT_FOR_DATE }), false);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("E. one user's failed Telegram send does not block another user's evening check-in in the same run — same isolation pattern as morning brief/Gmail nudge", async () => {
  const server = buildServer();
  const failingUserId = `evening-fails-${randomUUID()}`;
  const okUserId = `evening-ok-${randomUUID()}`;

  try {
    await seedMorningUser(failingUserId, "700005");
    await seedEveningCandidateGoal(failingUserId);
    await seedMorningUser(okUserId, "700006");
    await seedEveningCandidateGoal(okUserId);

    const failingTelegram = stubTelegram({ fail: true });
    const okTelegram = stubTelegram();
    const sendTelegramMessage = async (chatId: string, text: string) => {
      if (chatId === "700005") {
        return failingTelegram.send(chatId, text);
      }
      return okTelegram.send(chatId, text);
    };

    await runV3ProactiveEveningCheckins(
      [...settingsFor(failingUserId, "700005"), ...settingsFor(okUserId, "700006")],
      {
        now: EVENING_UTC,
        deliveryEnabled: true,
        apiGet: injectApiGet(server),
        sendTelegramMessage
      }
    );

    assert.equal(failingTelegram.sent.length, 0);
    assert.equal(okTelegram.sent.length, 1, "the second user's evening check-in must still send despite the first user's send failure");
    assert.equal(await hasNotificationLog({ userId: failingUserId, type: EVENING_DEDUPE_KEY, sentForDate: MORNING_SENT_FOR_DATE }), false);
    assert.equal(await hasNotificationLog({ userId: okUserId, type: EVENING_DEDUPE_KEY, sentForDate: MORNING_SENT_FOR_DATE }), true);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: { in: [failingUserId, okUserId] } } });
  }
});

test("F. morning brief and Gmail nudge behavior is unchanged by evening check-in's new send path — all three can run in the same tick without cross-contamination", async () => {
  const server = buildServer();
  const userId = `evening-no-cross-contamination-${randomUUID()}`;

  try {
    await seedMorningUser(userId, "700007");
    await createActionItem(userId, { source: "manual", title: "Apply to jobs", priority: "high" });
    await seedEveningCandidateGoal(userId);
    const morningTelegram = stubTelegram();
    const eveningTelegram = stubTelegram();

    // Same shape as apps/worker/src/index.ts's own runTick(): morning and evening are each their
    // own call, at each moment's own due time — not a single combined call.
    await runV3ProactiveMorningBriefs(settingsFor(userId, "700007"), {
      now: MORNING_UTC,
      deliveryEnabled: true,
      apiGet: injectApiGet(server),
      sendTelegramMessage: morningTelegram.send
    });
    await runV3ProactiveEveningCheckins(settingsFor(userId, "700007"), {
      now: EVENING_UTC,
      deliveryEnabled: true,
      apiGet: injectApiGet(server),
      sendTelegramMessage: eveningTelegram.send
    });

    assert.equal(morningTelegram.sent.length, 1, "morning brief must still send exactly as before");
    assert.match(morningTelegram.sent[0].text, /apply to jobs/i);
    assert.equal(eveningTelegram.sent.length, 1, "evening check-in must send independently, at its own time");
    assert.match(eveningTelegram.sent[0].text, /apply to developer jobs/i);
    assert.equal(await hasNotificationLog({ userId, type: MORNING_DEDUPE_KEY, sentForDate: MORNING_SENT_FOR_DATE }), true);
    assert.equal(await hasNotificationLog({ userId, type: EVENING_DEDUPE_KEY, sentForDate: MORNING_SENT_FOR_DATE }), true);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("7. a gmail_nudge candidate is delivered, logged, and stored as visible review context", async () => {
  const server = buildServer();
  const userId = `delivery-gmail-sent-${randomUUID()}`;

  try {
    await seedMorningUser(userId, "777777", { gmailNudgeEnabled: true });
    const review = await seedPendingGmailReview(userId);
    const telegram = stubTelegram();

    const preview = await injectApiGet(server)<{ decision: { decision: string; type?: string } }>(
      `/users/${userId}/operator/proactive/preview?now=${encodeURIComponent(GMAIL_NUDGE_UTC.toISOString())}`
    );
    assert.equal(preview.decision.decision, "proposed_message");
    assert.equal(preview.decision.type, "gmail_nudge", "test setup sanity check: the preview route must actually offer a gmail_nudge here");

    const results = await runV3ProactiveGmailNudges(settingsFor(userId, "777777", { gmailNudgeEnabled: true }), {
      now: GMAIL_NUDGE_UTC,
      deliveryEnabled: true,
      isAllowed: () => true,
      apiGet: injectApiGet(server),
      sendTelegramMessage: telegram.send
    });

    assert.equal(results[0].status, "sent");
    assert.equal(telegram.sent.length, 1);
    assert.equal(telegram.sent[0].chatId, "777777");
    assert.match(telegram.sent[0].text, /one email looks actionable/i);
    assert.match(telegram.sent[0].text, /recruiter reply from example labs/i);
    assert.equal(await hasNotificationLog({ userId, type: `v3_gmail_nudge:${review.id}`, sentForDate: MORNING_SENT_FOR_DATE }), true);

    const session = await prisma.agentConversationSession.findUnique({ where: { userId_channel: { userId, channel: "telegram" } } });
    const visibleEntities = (Array.isArray(session?.visibleEntities) ? session?.visibleEntities : []) as Array<{ type: string; id: string; index?: number }>;
    assert.deepEqual(visibleEntities.map((entity) => ({ type: entity.type, id: entity.id, index: entity.index })), [
      { type: "gmail_review", id: review.id, index: 1 }
    ]);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("7b. a failed gmail_nudge send writes no NotificationLog and no visible review context", async () => {
  const server = buildServer();
  const userId = `delivery-gmail-send-fails-${randomUUID()}`;

  try {
    await seedMorningUser(userId, "777778", { gmailNudgeEnabled: true });
    const review = await seedPendingGmailReview(userId);
    const telegram = stubTelegram({ fail: true });

    const results = await runV3ProactiveGmailNudges(settingsFor(userId, "777778", { gmailNudgeEnabled: true }), {
      now: GMAIL_NUDGE_UTC,
      deliveryEnabled: true,
      isAllowed: () => true,
      apiGet: injectApiGet(server),
      sendTelegramMessage: telegram.send,
      logger: { log() {}, error() {} }
    });

    assert.equal(results[0].status, "send_failed");
    assert.equal(await hasNotificationLog({ userId, type: `v3_gmail_nudge:${review.id}`, sentForDate: MORNING_SENT_FOR_DATE }), false);
    const session = await prisma.agentConversationSession.findUnique({ where: { userId_channel: { userId, channel: "telegram" } } });
    assert.equal(session, null);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("7c. duplicate Gmail nudge NotificationLog suppresses a second send", async () => {
  const server = buildServer();
  const userId = `delivery-gmail-dedupe-${randomUUID()}`;

  try {
    await seedMorningUser(userId, "777779", { gmailNudgeEnabled: true });
    const review = await seedPendingGmailReview(userId);
    await createNotificationLog({ userId, type: `v3_gmail_nudge:${review.id}`, sentForDate: MORNING_SENT_FOR_DATE });
    const telegram = stubTelegram();

    const results = await runV3ProactiveGmailNudges(settingsFor(userId, "777779", { gmailNudgeEnabled: true }), {
      now: GMAIL_NUDGE_UTC,
      deliveryEnabled: true,
      isAllowed: () => true,
      apiGet: injectApiGet(server),
      sendTelegramMessage: telegram.send
    });

    assert.equal(results[0].status, "skipped");
    assert.equal(results[0].reason, "no_eligible_candidate");
    assert.equal(telegram.sent.length, 0);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("7d. Gmail nudges require per-user opt-in and allowlist access", async () => {
  const server = buildServer();
  const optedOutUserId = `delivery-gmail-opted-out-${randomUUID()}`;
  const blockedUserId = `delivery-gmail-blocked-${randomUUID()}`;

  try {
    await seedMorningUser(optedOutUserId, "777780", { gmailNudgeEnabled: false });
    await seedPendingGmailReview(optedOutUserId);
    await seedMorningUser(blockedUserId, "777781", { gmailNudgeEnabled: true });
    await seedPendingGmailReview(blockedUserId);
    const telegram = stubTelegram();

    const results = await runV3ProactiveGmailNudges(
      [
        ...settingsFor(optedOutUserId, "777780", { gmailNudgeEnabled: false }),
        ...settingsFor(blockedUserId, "777781", { gmailNudgeEnabled: true })
      ],
      {
        now: GMAIL_NUDGE_UTC,
        deliveryEnabled: true,
        isAllowed: (userId) => userId !== blockedUserId,
        apiGet: injectApiGet(server),
        sendTelegramMessage: telegram.send
      }
    );

    assert.deepEqual(results.map((result) => result.reason), ["user_not_opted_in", "not_allowlisted"]);
    assert.equal(telegram.sent.length, 0);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: { in: [optedOutUserId, blockedUserId] } } });
  }
});

test("7e. no configured allowlist plus opt-in is eligible for Gmail nudge delivery", async () => {
  const server = buildServer();
  const userId = `delivery-gmail-no-allowlist-${randomUUID()}`;
  const previousAllowlist = process.env.PROACTIVE_OPERATOR_ALLOWLIST;

  try {
    delete process.env.PROACTIVE_OPERATOR_ALLOWLIST;
    await seedMorningUser(userId, "777782", { gmailNudgeEnabled: true });
    await seedPendingGmailReview(userId);
    const telegram = stubTelegram();

    const results = await runV3ProactiveGmailNudges(settingsFor(userId, "777782", { gmailNudgeEnabled: true }), {
      now: GMAIL_NUDGE_UTC,
      deliveryEnabled: true,
      apiGet: injectApiGet(server),
      sendTelegramMessage: telegram.send
    });

    assert.equal(results[0].status, "sent");
    assert.equal(telegram.sent.length, 1);
  } finally {
    if (previousAllowlist === undefined) {
      delete process.env.PROACTIVE_OPERATOR_ALLOWLIST;
    } else {
      process.env.PROACTIVE_OPERATOR_ALLOWLIST = previousAllowlist;
    }
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("7f. after a delivered Gmail nudge, the user's reply can use existing V3 review-to-action triage", async () => {
  const server = buildServer();
  const userId = `delivery-gmail-reply-flow-${randomUUID()}`;

  try {
    await seedMorningUser(userId, "777783", { gmailNudgeEnabled: true });
    const review = await seedPendingGmailReview(userId);
    const telegram = stubTelegram();

    await runV3ProactiveGmailNudges(settingsFor(userId, "777783", { gmailNudgeEnabled: true }), {
      now: GMAIL_NUDGE_UTC,
      deliveryEnabled: true,
      isAllowed: () => true,
      apiGet: injectApiGet(server),
      sendTelegramMessage: telegram.send
    });

    mockPlan({
      topic: "gmail_reviews",
      intent: "convert_review_to_action",
      operations: [op("gmail.review.to_action", { index: 1 })],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const reply = await sendAgentMessage(server, userId, "turn it into a task");

    assert.match(reply.reply, /created task/i);
    assert.equal(reply.debug.mutationExecuted, true);
    const reviewAfter = await prisma.emailReviewItem.findUnique({ where: { id: review.id } });
    assert.equal(reviewAfter?.status, "approved");
    assert.ok(reviewAfter?.actionItemId);
  } finally {
    clearAgentRuntimeMocks();
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
