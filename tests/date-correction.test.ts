import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createGoal } from "../packages/db/src/index.ts";
import { prisma } from "../packages/db/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, seedUser, sendAgentMessage } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * refactor/private-alpha-general-email-intelligence-workflow (gate 3): the live-reported bug — at
 * 03:04 on Sep 3, "I've sent 10 today" logged 10 career.application_sent events on Sep 3; "Today I
 * meant Wednesday 2 u counted that day" was then treated as a brand-new statement instead of a
 * correction. dateCorrectionShortcutOperation (runtime.ts) fixes this: it recognizes the
 * correction phrase, resolves "Wednesday" to the most recent past Wednesday, asks to confirm the
 * move, and — on "yes" — moves each event via the existing correctEvent DB primitive (archives the
 * original with an audit link, writes one replacement on the new date) rather than logging a
 * second batch.
 *
 * AGENT_RUNTIME_TEST_NOW pins "now" so weekday resolution and today/yesterday are deterministic
 * (mirrors the pattern executor.ts's own resolveAgentRuntimeNow already establishes for tests).
 */

function seedApplicationSentEvents(userId: string, count: number, timestamp: Date) {
  return Promise.all(
    Array.from({ length: count }, () => prisma.event.create({ data: { userId, type: "career.application_sent", source: "manual", timestamp, confidence: 1, data: {} } }))
  );
}

test("1. 'today I meant Wednesday' moves events, never duplicates, and the week total stays coherent", async () => {
  const server = buildServer();
  const userId = `date-correction-1-${randomUUID()}`;
  // 2026-09-03 is a Thursday; 2026-09-02 is the Wednesday before it.
  process.env.AGENT_RUNTIME_TEST_NOW = "2026-09-03T03:04:00.000Z";

  try {
    await seedUser(userId);
    await seedApplicationSentEvents(userId, 10, new Date("2026-09-03T03:04:00.000Z"));

    const weekBefore = await prisma.event.count({ where: { userId, type: "career.application_sent", status: "active" } });
    assert.equal(weekBefore, 10);

    const attempt = await sendAgentMessage(server, userId, "today I meant Wednesday");
    assert.equal(attempt.needsConfirmation, true);
    assert.match(attempt.reply, /move.*10 CVs.*from.*to/is);
    assert.match(attempt.reply, /Wed|2 Sep/i);

    const duringConfirm = await prisma.event.count({ where: { userId, type: "career.application_sent", status: "active" } });
    assert.equal(duringConfirm, 10, "nothing moves before the user actually confirms");

    const confirmed = await sendAgentMessage(server, userId, "yes");
    assert.match(confirmed.reply, /Moved 10/i);

    const sep3Active = await prisma.event.count({
      where: { userId, type: "career.application_sent", status: "active", timestamp: { gte: new Date("2026-09-03T00:00:00.000Z"), lt: new Date("2026-09-04T00:00:00.000Z") } }
    });
    const sep2Active = await prisma.event.count({
      where: { userId, type: "career.application_sent", status: "active", timestamp: { gte: new Date("2026-09-02T00:00:00.000Z"), lt: new Date("2026-09-03T00:00:00.000Z") } }
    });
    assert.equal(sep3Active, 0, "Sep 3 must decrease to zero");
    assert.equal(sep2Active, 10, "Sep 2 must increase to 10");

    const weekAfter = await prisma.event.count({ where: { userId, type: "career.application_sent", status: "active" } });
    assert.equal(weekAfter, 10, "the week total must stay coherent — never 20, never 0");

    const corrected = await prisma.event.count({ where: { userId, type: "career.application_sent", status: "corrected" } });
    assert.equal(corrected, 10, "every original event is auditable — archived as 'corrected,' never hard-deleted");

    const anyCorrectedHasLink = await prisma.event.findFirst({ where: { userId, status: "corrected" } });
    assert.ok(anyCorrectedHasLink?.correctedByEventId, "the correction must be traceable to its replacement event");
  } finally {
    delete process.env.AGENT_RUNTIME_TEST_NOW;
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2. cancelling ('no') leaves the original date untouched", async () => {
  const server = buildServer();
  const userId = `date-correction-2-${randomUUID()}`;
  process.env.AGENT_RUNTIME_TEST_NOW = "2026-09-03T03:04:00.000Z";

  try {
    await seedUser(userId);
    await seedApplicationSentEvents(userId, 3, new Date("2026-09-03T03:04:00.000Z"));

    await sendAgentMessage(server, userId, "today I meant Wednesday");
    const cancelled = await sendAgentMessage(server, userId, "no");
    assert.doesNotMatch(cancelled.reply, /Moved/i);

    const sep3Active = await prisma.event.count({
      where: { userId, type: "career.application_sent", status: "active", timestamp: { gte: new Date("2026-09-03T00:00:00.000Z"), lt: new Date("2026-09-04T00:00:00.000Z") } }
    });
    assert.equal(sep3Active, 3, "cancelling must leave the original date completely untouched");
  } finally {
    delete process.env.AGENT_RUNTIME_TEST_NOW;
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3. 'today I meant yesterday' resolves correctly", async () => {
  const server = buildServer();
  const userId = `date-correction-3-${randomUUID()}`;
  process.env.AGENT_RUNTIME_TEST_NOW = "2026-09-03T10:00:00.000Z";

  try {
    await seedUser(userId);
    await seedApplicationSentEvents(userId, 2, new Date("2026-09-03T10:00:00.000Z"));

    const attempt = await sendAgentMessage(server, userId, "today I meant yesterday");
    assert.equal(attempt.needsConfirmation, true);
    await sendAgentMessage(server, userId, "yes");

    const sep2Active = await prisma.event.count({
      where: { userId, type: "career.application_sent", status: "active", timestamp: { gte: new Date("2026-09-02T00:00:00.000Z"), lt: new Date("2026-09-03T00:00:00.000Z") } }
    });
    assert.equal(sep2Active, 2);
  } finally {
    delete process.env.AGENT_RUNTIME_TEST_NOW;
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4. works across a midnight boundary: the correction message arrives the next local day", async () => {
  const server = buildServer();
  const userId = `date-correction-4-${randomUUID()}`;

  try {
    await seedUser(userId);
    // The user's default timezone in this test harness is Europe/Madrid (UTC+2 in September) — the
    // original statement happened late on Sep 3 LOCAL time (21:50 UTC = 23:50 Madrid).
    process.env.AGENT_RUNTIME_TEST_NOW = "2026-09-03T21:50:00.000Z";
    await seedApplicationSentEvents(userId, 4, new Date("2026-09-03T21:50:00.000Z"));

    // The correction arrives after LOCAL midnight (22:10 UTC = 00:10 Madrid, now Sep 4 locally),
    // but the most recent day with real logged CVs is still Sep 3 local — the shortcut must still
    // find it, not just literal-clock "today."
    process.env.AGENT_RUNTIME_TEST_NOW = "2026-09-03T22:10:00.000Z";
    const attempt = await sendAgentMessage(server, userId, "today I meant Wednesday");
    assert.equal(attempt.needsConfirmation, true);
    assert.match(attempt.reply, /4 CVs/i);
    await sendAgentMessage(server, userId, "yes");

    const sep2ActiveMadrid = await prisma.event.count({
      where: {
        userId,
        type: "career.application_sent",
        status: "active",
        // Madrid local Sep 2 00:00–24:00 expressed in UTC (UTC+2 in September).
        timestamp: { gte: new Date("2026-09-01T22:00:00.000Z"), lt: new Date("2026-09-02T22:00:00.000Z") }
      }
    });
    assert.equal(sep2ActiveMadrid, 4, "must still find and move Sep 3 local-date's events even though real time has crossed local midnight into Sep 4");
  } finally {
    delete process.env.AGENT_RUNTIME_TEST_NOW;
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("5. Spanish 'quise decir miércoles' and Catalan 'volia dir dimecres' both resolve", async () => {
  const server = buildServer();
  const userId = `date-correction-5-${randomUUID()}`;
  process.env.AGENT_RUNTIME_TEST_NOW = "2026-09-03T09:00:00.000Z";

  try {
    await seedUser(userId);
    await seedApplicationSentEvents(userId, 1, new Date("2026-09-03T09:00:00.000Z"));

    const es = await sendAgentMessage(server, userId, "quise decir miércoles");
    assert.equal(es.needsConfirmation, true, "Spanish correction phrasing must be recognized");
  } finally {
    delete process.env.AGENT_RUNTIME_TEST_NOW;
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("6. Catalan 'volia dir dimecres' also resolves", async () => {
  const server = buildServer();
  const userId = `date-correction-6-${randomUUID()}`;
  process.env.AGENT_RUNTIME_TEST_NOW = "2026-09-03T09:00:00.000Z";

  try {
    await seedUser(userId);
    await seedApplicationSentEvents(userId, 1, new Date("2026-09-03T09:00:00.000Z"));

    const ca = await sendAgentMessage(server, userId, "volia dir dimecres");
    assert.equal(ca.needsConfirmation, true, "Catalan correction phrasing must be recognized");
  } finally {
    delete process.env.AGENT_RUNTIME_TEST_NOW;
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// --- Gate 3 hardening: the bridged custom.goal_progress_logged event for an ADAPTIVE goal must ---
// --- move alongside the canonical career.application_sent event, never left stuck on the old day ---

async function seedApplicationSentEventsWithBridge(userId: string, count: number, timestamp: Date, signalKey: string) {
  for (let i = 0; i < count; i += 1) {
    await prisma.event.create({ data: { userId, type: "career.application_sent", source: "manual", timestamp, confidence: 1, data: {} } });
    await prisma.event.create({ data: { userId, type: "custom.goal_progress_logged", source: "manual", timestamp, confidence: 1, data: { signalKey } } });
  }
}

test("7. adaptive goal: moving 10 CVs from today to yesterday moves BOTH the canonical and bridged signalKey events, and goal.status reflects it", async () => {
  const server = buildServer();
  const userId = `date-correction-7-${randomUUID()}`;
  // goal.status's own "Today" scope reads real wall-clock new Date() (a pre-existing,
  // unrelated-to-this-task characteristic — it does not honor AGENT_RUNTIME_TEST_NOW), so this
  // test seeds against the REAL current moment rather than a fixed date, and uses "yesterday"
  // (always resolvable, never dependent on which real weekday the suite happens to run on).
  const realNow = new Date();
  const yesterday = new Date(realNow.getTime() - 24 * 60 * 60 * 1000);

  try {
    await seedUser(userId);
    await createGoal(userId, {
      title: "Find a fully remote developer job",
      category: "career",
      targetMetrics: [{ key: "applications_sent", label: "Applications sent", labelSingular: "Application sent", signalKey: "applications_sent", aggregation: "count", window: "weekly" }]
    });
    await seedApplicationSentEventsWithBridge(userId, 10, realNow, "applications_sent");

    const before = await sendAgentMessage(server, userId, "show today goal progress");
    assert.match(before.reply, /Today: 10 Application/i);

    const attempt = await sendAgentMessage(server, userId, "today I meant yesterday");
    assert.equal(attempt.needsConfirmation, true);
    assert.match(attempt.reply, /10 CVs/i, "the displayed count must be the canonical CV count, not doubled by the bridge events");
    await sendAgentMessage(server, userId, "yes");

    const after = await sendAgentMessage(server, userId, "show today goal progress");
    assert.doesNotMatch(after.reply, /Today: 10 Application/i, "today must no longer show the moved 10");

    // Matches production's own formatDateInTimezone exactly (Europe/Madrid, this test harness's
    // default) rather than a UTC day boundary, so this assertion is correct regardless of what
    // real time of day the suite happens to run at.
    const madridLocalDate = (d: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
    const todayMadrid = madridLocalDate(realNow);
    const yesterdayMadrid = madridLocalDate(yesterday);

    const activeBridgeEvents = await prisma.event.findMany({ where: { userId, type: "custom.goal_progress_logged", status: "active" } });
    const bridgeActiveYesterday = activeBridgeEvents.filter((event) => madridLocalDate(event.timestamp) === yesterdayMadrid).length;
    const bridgeStillOnToday = activeBridgeEvents.filter((event) => madridLocalDate(event.timestamp) === todayMadrid).length;
    assert.equal(bridgeActiveYesterday, 10, "all 10 bridged signalKey events must have moved to yesterday alongside the canonical ones");
    assert.equal(bridgeStillOnToday, 0, "no bridged event may be left stranded on the old day");

    const bridgeCorrected = await prisma.event.count({ where: { userId, type: "custom.goal_progress_logged", status: "corrected" } });
    assert.equal(bridgeCorrected, 10, "every original bridged event is auditable, archived as 'corrected', never hard-deleted");

    const canonicalActive = await prisma.event.count({ where: { userId, type: "career.application_sent", status: "active" } });
    assert.equal(canonicalActive, 10, "the canonical side is unaffected in count — still exactly 10, just on the new day");
  } finally {
    delete process.env.AGENT_RUNTIME_TEST_NOW;
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("8. template eventType goal (no bridge): date correction still works, no bridge events invented", async () => {
  const server = buildServer();
  const userId = `date-correction-8-${randomUUID()}`;
  process.env.AGENT_RUNTIME_TEST_NOW = "2026-09-03T09:00:00.000Z";

  try {
    await seedUser(userId);
    await createGoal(userId, {
      title: "Find a remote developer job",
      category: "career",
      targetMetrics: [{ key: "cv_sent", label: "CVs sent", labelSingular: "CV sent", eventType: "career.application_sent", aggregation: "count", window: "weekly" }]
    });
    await seedApplicationSentEvents(userId, 3, new Date("2026-09-03T09:00:00.000Z"));

    const attempt = await sendAgentMessage(server, userId, "today I meant Wednesday");
    assert.equal(attempt.needsConfirmation, true);
    await sendAgentMessage(server, userId, "yes");

    const sep2Canonical = await prisma.event.count({
      where: { userId, type: "career.application_sent", status: "active", timestamp: { gte: new Date("2026-09-01T22:00:00.000Z"), lt: new Date("2026-09-02T22:00:00.000Z") } }
    });
    assert.equal(sep2Canonical, 3);

    const bridgeEvents = await prisma.event.count({ where: { userId, type: "custom.goal_progress_logged" } });
    assert.equal(bridgeEvents, 0, "a template (canonical eventType) goal has no bridge signal — none must be invented by the correction");
  } finally {
    delete process.env.AGENT_RUNTIME_TEST_NOW;
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("9. cancelling an adaptive-goal correction leaves both canonical and bridged events untouched", async () => {
  const server = buildServer();
  const userId = `date-correction-9-${randomUUID()}`;
  process.env.AGENT_RUNTIME_TEST_NOW = "2026-09-03T09:00:00.000Z";

  try {
    await seedUser(userId);
    await createGoal(userId, {
      title: "Find a fully remote developer job",
      category: "career",
      targetMetrics: [{ key: "applications_sent", label: "Applications sent", labelSingular: "Application sent", signalKey: "applications_sent", aggregation: "count", window: "weekly" }]
    });
    await seedApplicationSentEventsWithBridge(userId, 4, new Date("2026-09-03T09:00:00.000Z"), "applications_sent");

    await sendAgentMessage(server, userId, "today I meant Wednesday");
    await sendAgentMessage(server, userId, "no");

    const canonicalSep3 = await prisma.event.count({
      where: { userId, type: "career.application_sent", status: "active", timestamp: { gte: new Date("2026-09-03T00:00:00.000Z"), lt: new Date("2026-09-04T00:00:00.000Z") } }
    });
    const bridgeSep3 = await prisma.event.count({
      where: { userId, type: "custom.goal_progress_logged", status: "active", timestamp: { gte: new Date("2026-09-03T00:00:00.000Z"), lt: new Date("2026-09-04T00:00:00.000Z") } }
    });
    assert.equal(canonicalSep3, 4);
    assert.equal(bridgeSep3, 4);
  } finally {
    delete process.env.AGENT_RUNTIME_TEST_NOW;
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
