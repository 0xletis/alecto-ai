import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createActionItem, createEvent, createGoal, createNotificationLog, prisma } from "../packages/db/src/index.ts";
import { buildServer } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * Agent Runtime v3 Proactive Operator MVP — the pure decision module
 * (apps/api/src/operator/proactive.ts's decideProactiveOperatorMessage) exercised through its
 * one integration point, GET /users/:userId/operator/proactive/preview
 * (apps/api/src/routes/agent.ts). Preview-only: this route never sends a Telegram message and
 * never writes a NotificationLog entry itself — see docs/10-v3-readiness-audit.md §13 for why
 * actual scheduled sending is deliberately out of scope for this pass.
 *
 * Local times below are chosen to land on 09:00/19:00 Europe/Madrid, matching each test's seeded
 * morningTimeMinutes=540 (9:00) / eveningTimeMinutes=1140 (19:00) — Europe/Madrid is UTC+2 in
 * August (CEST), so 09:00 local = 07:00Z and 19:00 local = 17:00Z.
 */

const MORNING_UTC = "2026-08-20T07:00:00.000Z"; // 09:00 Europe/Madrid
const EVENING_UTC = "2026-08-20T17:00:00.000Z"; // 19:00 Europe/Madrid
const MIDDAY_UTC = "2026-08-20T11:00:00.000Z"; // 13:00 Europe/Madrid — between morning/evening, outside both trigger windows
const NIGHT_UTC = "2026-08-20T01:00:00.000Z"; // 03:00 Europe/Madrid — outside every window entirely

async function seedNotificationSettings(userId: string, overrides: { dailyLoopEnabled?: boolean } = {}) {
  await prisma.notificationSettings.create({
    data: {
      userId,
      dailyLoopEnabled: overrides.dailyLoopEnabled ?? true,
      morningTimeMinutes: 540,
      eveningTimeMinutes: 1140,
      timezone: "Europe/Madrid"
    }
  });
}

async function preview(server: ReturnType<typeof buildServer>, userId: string, nowIso: string) {
  const response = await server.inject({ method: "GET", url: `/users/${userId}/operator/proactive/preview?now=${encodeURIComponent(nowIso)}` });
  assert.equal(response.statusCode, 200, `preview for ${userId} returned ${response.statusCode}: ${response.body}`);
  return response.json().decision as
    | { decision: "proposed_message"; type: string; title: string; message: string; reasons: string[]; suggestedReplies: string[]; dedupeKey: string; priority: number; safeToSend: boolean }
    | { decision: "no_message"; reason: string };
}

test("1. morning brief with active goals and open actions returns grounded top priorities", async () => {
  const server = buildServer();
  const userId = `proactive-morning-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    await seedNotificationSettings(userId);
    await createGoal(userId, { title: "Find a new developer job", category: "career", priority: "high" });
    await createGoal(userId, { title: "Train 3 times per week", category: "health", priority: "medium" });
    await createActionItem(userId, { source: "manual", title: "Apply to 3 developer jobs", priority: "high" });
    await createActionItem(userId, { source: "manual", title: "Gym session", priority: "high" });
    await createActionItem(userId, { source: "manual", title: "Review CV", priority: "medium" });
    await createActionItem(userId, { source: "manual", title: "Check cheap car listings", priority: "low" });

    const decision = await preview(server, userId, MORNING_UTC);

    assert.equal(decision.decision, "proposed_message");
    assert.equal((decision as any).type, "morning_brief");
    assert.match((decision as any).message, /apply to 3 developer jobs/i);
    assert.match((decision as any).message, /gym session/i);
    assert.match((decision as any).message, /skip "check cheap car listings"/i);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2. morning brief with no goals or actions uses the goal-anchor nudge style", async () => {
  const server = buildServer();
  const userId = `proactive-morning-empty-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    await seedNotificationSettings(userId);

    const decision = await preview(server, userId, MORNING_UTC);

    assert.equal(decision.decision, "proposed_message");
    assert.equal((decision as any).type, "morning_brief");
    assert.match((decision as any).message, /one real goal or guardrail/i);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3. morning brief never mentions an action that was not actually seeded", async () => {
  const server = buildServer();
  const userId = `proactive-morning-grounded-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    await seedNotificationSettings(userId);
    await createActionItem(userId, { source: "manual", title: "Apply to 3 developer jobs", priority: "high" });

    const decision = await preview(server, userId, MORNING_UTC);

    assert.equal(decision.decision, "proposed_message");
    assert.match((decision as any).message, /apply to 3 developer jobs/i);
    assert.doesNotMatch((decision as any).message, /gym|workout|invoice|recruiter/i, "must never mention data that was never seeded");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4. evening check-in asks about goals with trackable signals missing today", async () => {
  const server = buildServer();
  const userId = `proactive-evening-missing-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    await seedNotificationSettings(userId);
    await createGoal(userId, {
      title: "Apply to developer jobs",
      category: "career",
      priority: "high",
      targetMetrics: [{ key: "applications", label: "Applications sent", eventType: "career.application_sent", aggregation: "count", window: "daily" }]
    });

    const decision = await preview(server, userId, EVENING_UTC);

    assert.equal(decision.decision, "proposed_message");
    assert.equal((decision as any).type, "evening_checkin");
    assert.match((decision as any).message, /apply to developer jobs/i);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("5. evening check-in does not nag when the signal was already logged today", async () => {
  const server = buildServer();
  const userId = `proactive-evening-logged-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    await seedNotificationSettings(userId);
    await createGoal(userId, {
      title: "Apply to developer jobs",
      category: "career",
      priority: "high",
      targetMetrics: [{ key: "applications", label: "Applications sent", eventType: "career.application_sent", aggregation: "count", window: "daily" }]
    });
    await createEvent(userId, { type: "career.application_sent", source: "manual", confidence: 1, data: {}, timestamp: new Date(EVENING_UTC) });

    const decision = await preview(server, userId, EVENING_UTC);

    assert.equal(decision.decision, "no_message");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("6. a pending Gmail review produces a gmail_nudge with a safe, grounded summary", async () => {
  const server = buildServer();
  const userId = `proactive-gmail-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    await seedNotificationSettings(userId);
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
        from: "recruiter@example.com",
        snippet: "Can we talk tomorrow?",
        confidence: 0.9,
        reason: "custom_rule_match",
        extracted: {},
        status: "pending"
      }
    });

    const decision = await preview(server, userId, MIDDAY_UTC);

    assert.equal(decision.decision, "proposed_message");
    assert.equal((decision as any).type, "gmail_nudge");
    assert.match((decision as any).message, /recruiter reply from example labs/i);
    assert.match((decision as any).message, /can we talk tomorrow/i);
    assert.doesNotMatch((decision as any).message, /recruiter@example\.com/, "must never leak the raw email address");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("7. no pending Gmail reviews means no gmail nudge", async () => {
  const server = buildServer();
  const userId = `proactive-gmail-none-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    await seedNotificationSettings(userId);

    const decision = await preview(server, userId, MIDDAY_UTC);

    assert.equal(decision.decision, "no_message");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("8. a duplicate dedupe key suppresses the repeat", async () => {
  const server = buildServer();
  const userId = `proactive-dedupe-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    await seedNotificationSettings(userId);
    await createActionItem(userId, { source: "manual", title: "Apply to 3 developer jobs", priority: "high" });

    const first = await preview(server, userId, MORNING_UTC);
    assert.equal(first.decision, "proposed_message");

    await createNotificationLog({ userId, type: (first as any).dedupeKey, sentForDate: "2026-08-20" });

    const second = await preview(server, userId, MORNING_UTC);
    assert.equal(second.decision, "no_message");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("9. quiet hours (respecting daily-loop settings) suppress every proactive message", async () => {
  const server = buildServer();
  const userId = `proactive-quiet-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    await seedNotificationSettings(userId);
    await createGoal(userId, { title: "Find a new developer job", category: "career", priority: "high" });
    await createActionItem(userId, { source: "manual", title: "Apply to 3 developer jobs", priority: "high" });

    const decision = await preview(server, userId, NIGHT_UTC);

    assert.equal(decision.decision, "no_message");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("9b. a user with daily loop disabled never gets a proactive message, at any time", async () => {
  const server = buildServer();
  const userId = `proactive-loop-disabled-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    await seedNotificationSettings(userId, { dailyLoopEnabled: false });
    await createGoal(userId, { title: "Find a new developer job", category: "career", priority: "high" });
    await createActionItem(userId, { source: "manual", title: "Apply to 3 developer jobs", priority: "high" });

    const decision = await preview(server, userId, MORNING_UTC);

    assert.equal(decision.decision, "no_message");
    assert.equal((decision as any).reason, "daily_loop_disabled");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("10. hitting the daily proactive-message cap suppresses further messages", async () => {
  const server = buildServer();
  const userId = `proactive-daily-max-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    await seedNotificationSettings(userId);
    await createActionItem(userId, { source: "manual", title: "Apply to 3 developer jobs", priority: "high" });

    const connection = await prisma.integrationConnection.create({ data: { userId, integrationId: "gmail", status: "active", config: {} } });
    const rule = await prisma.emailSignalRule.create({ data: { userId, connectionId: connection.id, adapterId: "custom_email_review", name: "Recruiter replies", status: "active", createdBy: "user" } });
    const reviews = await Promise.all(
      ["m1", "m2", "m3"].map((messageId) =>
        prisma.emailReviewItem.create({
          data: {
            userId,
            connectionId: connection.id,
            ruleId: rule.id,
            adapterId: "custom_email_review",
            provider: "gmail",
            providerMessageId: messageId,
            externalId: `gmail-review:${rule.id}:${messageId}`,
            subject: `Email ${messageId}`,
            confidence: 0.8,
            reason: "custom_rule_match",
            extracted: {},
            status: "pending"
          }
        })
      )
    );

    // Simulate 3 proactive messages already sent today (the cap), via the 3 pending reviews'
    // own dedupe keys — the daily cap check happens before any candidate is even built, so this
    // suppresses everything, not just further gmail nudges.
    await Promise.all(reviews.map((review) => createNotificationLog({ userId, type: `v3_gmail_nudge:${review.id}`, sentForDate: "2026-08-20" })));

    const decision = await preview(server, userId, MORNING_UTC);

    assert.equal(decision.decision, "no_message");
    assert.equal((decision as any).reason, "daily_max_reached");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
