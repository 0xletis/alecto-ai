import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createGoal, prisma } from "../packages/db/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, getAgentSession, mockPlan, op, seedUser, sendAgentMessage } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * fix/private-alpha-goal-restore-ambiguity-resolution: the restore/unarchive flow (built in
 * fix/private-alpha-launch-hardening-flakes-and-pending-clarity) avoided creating a duplicate goal
 * when several archived goals matched, but the ambiguity question itself was a dead end —
 * describeAmbiguousGoalChoice just listed titles (duplicated verbatim for same-titled goals) with
 * NO pendingOperation behind it, so every follow-up (repeating the title, "the one archived today",
 * "none", "cancel") fell through to the planner or a bare "nothing pending" reply, looping the exact
 * same question forever. Fixed with a real "restore_goal_disambiguation" pending clarification whose
 * candidates carry their own createdAt/archivedAt, and a matcher that resolves index, exact title,
 * or recency phrases against them — resolving to one candidate never restores it directly, it opens
 * the SAME final "yes to confirm" step the unambiguous-match path already used.
 */

async function seedArchivedGoal(userId: string, title: string, options: { archivedAt?: Date; createdAt?: Date } = {}) {
  const result = await createGoal(userId, { title, category: "career", allowDuplicate: true });
  if (result.duplicate) throw new Error("unexpected duplicate goal in test setup");
  const data: Record<string, unknown> = { status: "archived", archivedAt: options.archivedAt ?? new Date() };
  if (options.createdAt) {
    data.createdAt = options.createdAt;
  }
  await prisma.goal.update({ where: { id: result.goal.id }, data });
  return result.goal;
}

function hoursAgo(hours: number): Date {
  return new Date(Date.now() - hours * 60 * 60 * 1000);
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

// ---------------------------------------------------------------------------
// Task 2: restore ambiguity as real pending state
// ---------------------------------------------------------------------------

test("2A/2I: multiple archived matches create a real pending restore disambiguation, mutating nothing", async () => {
  const server = buildServer();
  const userId = `restore-disambig-pending-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedArchivedGoal(userId, "Job search for developer roles");
    await seedArchivedGoal(userId, "Job search for designer roles");

    const reply = await sendAgentMessage(server, userId, "restore my job search goal");
    assert.equal(reply.debug.pendingOperation, true);
    assert.equal(reply.debug.mutationExecuted, false, "nothing must be restored before a final confirmation");

    const session = await getAgentSession(userId);
    const pending = session?.pendingOperation as { topic: string } | undefined;
    assert.equal(pending?.topic, "restore_goal_disambiguation");

    const activeCount = await prisma.goal.count({ where: { userId, status: "active" } });
    assert.equal(activeCount, 0, "nothing restored yet");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2B: reply '1' chooses the FIRST candidate exactly as displayed (whichever goal that is)", async () => {
  const server = buildServer();
  const userId = `restore-disambig-index1-${randomUUID()}`;
  try {
    await seedUser(userId);
    const goalA = await seedArchivedGoal(userId, "Job search for developer roles");
    const goalB = await seedArchivedGoal(userId, "Job search for designer roles");

    const propose = await sendAgentMessage(server, userId, "restore my job search goal");
    // The scoring engine's own order decides which title is "1." — read it back rather than
    // assuming creation order, since the point of this test is that index selection is honored,
    // not which specific candidate happens to sort first.
    const firstListedTitle = /1\.\s(.+?)\s—/.exec(propose.reply)?.[1];
    assert.ok(firstListedTitle, `expected a numbered list — got: ${propose.reply}`);
    const expectedGoal = firstListedTitle === goalA.title ? goalA : goalB;

    const disambiguate = await sendAgentMessage(server, userId, "1");
    assert.match(disambiguate.reply, /reply yes to confirm or cancel/i);
    assert.equal(disambiguate.debug.pendingOperation, true);
    assert.match(disambiguate.reply, new RegExp(expectedGoal.title, "i"));

    const confirm = await sendAgentMessage(server, userId, "yes");
    assert.equal(confirm.debug.mutationExecuted, true);
    const restored = await prisma.goal.findUnique({ where: { id: expectedGoal.id } });
    assert.equal(restored?.status, "active");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2C: an exact title reply that's unique after normalization resolves directly", async () => {
  const server = buildServer();
  const userId = `restore-disambig-exacttitle-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedArchivedGoal(userId, "Job search for developer roles");
    const goalB = await seedArchivedGoal(userId, "Job search for designer roles");

    await sendAgentMessage(server, userId, "restore my job search goal");
    const disambiguate = await sendAgentMessage(server, userId, "Job search for designer roles");
    assert.match(disambiguate.reply, /reply yes to confirm or cancel/i);

    const confirm = await sendAgentMessage(server, userId, "yes");
    assert.equal(confirm.debug.mutationExecuted, true);
    const restored = await prisma.goal.findUnique({ where: { id: goalB.id } });
    assert.equal(restored?.status, "active");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2D/2E: 'latest archived' and 'latest created' each pick the correct candidate by their own field", async () => {
  const server1 = buildServer();
  const userId1 = `restore-disambig-latestarchived-${randomUUID()}`;
  try {
    await seedUser(userId1);
    const older = await seedArchivedGoal(userId1, "Job search for developer roles", { archivedAt: hoursAgo(30) });
    const newer = await seedArchivedGoal(userId1, "Job search for designer roles", { archivedAt: hoursAgo(1) });

    await sendAgentMessage(server1, userId1, "restore my job search goal");
    const disambiguate = await sendAgentMessage(server1, userId1, "latest archived");
    assert.match(disambiguate.reply, new RegExp(newer.title, "i"));
    assert.doesNotMatch(disambiguate.reply, new RegExp(`^.*${older.title}`, "i"));

    const confirm = await sendAgentMessage(server1, userId1, "yes");
    assert.equal(confirm.debug.mutationExecuted, true);
    const restoredNewer = await prisma.goal.findUnique({ where: { id: newer.id } });
    const restoredOlder = await prisma.goal.findUnique({ where: { id: older.id } });
    assert.equal(restoredNewer?.status, "active");
    assert.equal(restoredOlder?.status, "archived");
  } finally {
    clearAgentRuntimeMocks();
    await server1.close();
    await prisma.user.deleteMany({ where: { id: userId1 } });
  }

  const server2 = buildServer();
  const userId2 = `restore-disambig-latestcreated-${randomUUID()}`;
  try {
    await seedUser(userId2);
    const olderCreated = await seedArchivedGoal(userId2, "Job search for developer roles", { createdAt: daysAgo(10) });
    const newerCreated = await seedArchivedGoal(userId2, "Job search for designer roles", { createdAt: daysAgo(1) });

    await sendAgentMessage(server2, userId2, "restore my job search goal");
    const disambiguate = await sendAgentMessage(server2, userId2, "the one created the latest");
    assert.match(disambiguate.reply, new RegExp(newerCreated.title, "i"));

    const confirm = await sendAgentMessage(server2, userId2, "yes");
    assert.equal(confirm.debug.mutationExecuted, true);
    const restoredNewer = await prisma.goal.findUnique({ where: { id: newerCreated.id } });
    const restoredOlder = await prisma.goal.findUnique({ where: { id: olderCreated.id } });
    assert.equal(restoredNewer?.status, "active");
    assert.equal(restoredOlder?.status, "archived");
  } finally {
    clearAgentRuntimeMocks();
    await server2.close();
    await prisma.user.deleteMany({ where: { id: userId2 } });
  }
});

test("2F: 'archived today' filters to today's archived candidates only", async () => {
  const server = buildServer();
  const userId = `restore-disambig-archivedtoday-${randomUUID()}`;
  try {
    await seedUser(userId);
    const yesterday = await seedArchivedGoal(userId, "Job search for developer roles", { archivedAt: hoursAgo(30) });
    const today = await seedArchivedGoal(userId, "Job search for designer roles", { archivedAt: hoursAgo(1) });

    await sendAgentMessage(server, userId, "restore my job search goal");
    const disambiguate = await sendAgentMessage(server, userId, "the one archived today");
    assert.match(disambiguate.reply, new RegExp(today.title, "i"));

    const confirm = await sendAgentMessage(server, userId, "yes");
    assert.equal(confirm.debug.mutationExecuted, true);
    const restoredToday = await prisma.goal.findUnique({ where: { id: today.id } });
    const restoredYesterday = await prisma.goal.findUnique({ where: { id: yesterday.id } });
    assert.equal(restoredToday?.status, "active");
    assert.equal(restoredYesterday?.status, "archived");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2G/2H: 'cancel' and 'none' both clear the pending restore disambiguation, no mutation", async () => {
  const server1 = buildServer();
  const userId1 = `restore-disambig-cancel-${randomUUID()}`;
  try {
    await seedUser(userId1);
    await seedArchivedGoal(userId1, "Job search for developer roles");
    await seedArchivedGoal(userId1, "Job search for designer roles");

    await sendAgentMessage(server1, userId1, "restore my job search goal");
    const cancelled = await sendAgentMessage(server1, userId1, "cancel");
    assert.equal(cancelled.debug.pendingOperation, false);
    assert.equal(await prisma.goal.count({ where: { userId: userId1, status: "active" } }), 0);
  } finally {
    clearAgentRuntimeMocks();
    await server1.close();
    await prisma.user.deleteMany({ where: { id: userId1 } });
  }

  const server2 = buildServer();
  const userId2 = `restore-disambig-none-${randomUUID()}`;
  try {
    await seedUser(userId2);
    await seedArchivedGoal(userId2, "Job search for developer roles");
    await seedArchivedGoal(userId2, "Job search for designer roles");

    await sendAgentMessage(server2, userId2, "restore my job search goal");
    const cleared = await sendAgentMessage(server2, userId2, "none");
    assert.equal(cleared.debug.pendingOperation, false);
    assert.equal(await prisma.goal.count({ where: { userId: userId2, status: "active" } }), 0);
  } finally {
    clearAgentRuntimeMocks();
    await server2.close();
    await prisma.user.deleteMany({ where: { id: userId2 } });
  }
});

// ---------------------------------------------------------------------------
// Task 3: ambiguity display
// ---------------------------------------------------------------------------

test("3A/3B/3E: duplicate titles are shown numbered with distinguishing archived/created metadata", async () => {
  const server = buildServer();
  const userId = `restore-display-metadata-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedArchivedGoal(userId, "Find a fully remote developer job, ideally in Web3", { archivedAt: hoursAgo(1) });
    await seedArchivedGoal(userId, "Find a fully remote developer job, ideally in Web3", { archivedAt: hoursAgo(30) });

    const reply = await sendAgentMessage(server, userId, 'restore the goal "Find a fully remote developer job, ideally in Web3"');
    assert.match(reply.reply, /1\. find a fully remote developer job, ideally in web3 — archived/i);
    assert.match(reply.reply, /2\. find a fully remote developer job, ideally in web3 — archived/i);
    assert.match(reply.reply, /archived (today|yesterday)/i);
    assert.match(reply.reply, /created \d{2}\/\d{2}\/\d{4}|created today|created yesterday/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3C: a long candidate list is capped, with a note that there are more", async () => {
  const server = buildServer();
  const userId = `restore-display-cap-${randomUUID()}`;
  try {
    await seedUser(userId);
    for (let i = 0; i < 10; i++) {
      await seedArchivedGoal(userId, `Job search attempt ${i}`, { archivedAt: hoursAgo(i + 1) });
    }

    const reply = await sendAgentMessage(server, userId, "restore my job search goal");
    const numberedLines = reply.reply.match(/^\d+\./gm) ?? [];
    assert.equal(numberedLines.length, 8, `expected exactly 8 numbered lines — got: ${reply.reply}`);
    assert.doesNotMatch(reply.reply, /^9\./m, "must never show a 9th numbered line");
    assert.match(reply.reply, /and 2 more/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3D: an active goal with a similar name is not mixed into archived restore candidates", async () => {
  const server = buildServer();
  const userId = `restore-display-noactive-${randomUUID()}`;
  try {
    await seedUser(userId);
    await seedArchivedGoal(userId, "Job search for developer roles");
    await seedArchivedGoal(userId, "Job search for designer roles");
    // Deliberately unrelated to "job search" — an active goal that DID fuzzy-match would
    // legitimately win via the pre-existing "already active" priority check (a real, separate
    // rule), which would make this test exercise that rule instead of the one it's actually
    // about: that the archived-candidate pool itself is built only from archived goals.
    const activeResult = await createGoal(userId, { title: "Learn watercolor painting", category: "hobby", allowDuplicate: true });
    if (activeResult.duplicate) throw new Error("unexpected duplicate goal in test setup");

    const reply = await sendAgentMessage(server, userId, "restore my job search goal");
    assert.doesNotMatch(reply.reply, /watercolor/i, "an active goal must never appear as an archived restore candidate");
    assert.equal(reply.debug.pendingOperation, true, "must have reached the real archived-candidate disambiguation");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// ---------------------------------------------------------------------------
// Task 4: recency disambiguation
// ---------------------------------------------------------------------------

test("4D: a combined phrase ('created the latest, that was archived today') filters by archived-today then sorts by createdAt", async () => {
  const server = buildServer();
  const userId = `restore-recency-combined-${randomUUID()}`;
  try {
    await seedUser(userId);
    // Archived yesterday, created most recently overall — must be EXCLUDED by the "archived
    // today" filter even though it would otherwise win on createdAt alone.
    await seedArchivedGoal(userId, "Job search for developer roles", { archivedAt: hoursAgo(30), createdAt: hoursAgo(2) });
    // Archived today, created earlier than the one above.
    const olderCreatedTodayArchived = await seedArchivedGoal(userId, "Job search for QA roles", { archivedAt: hoursAgo(1), createdAt: daysAgo(5) });
    // Archived today AND created most recently among today's archived set — the expected match.
    const expected = await seedArchivedGoal(userId, "Job search for designer roles", { archivedAt: hoursAgo(1), createdAt: daysAgo(1) });

    await sendAgentMessage(server, userId, "restore my job search goal");
    const disambiguate = await sendAgentMessage(server, userId, "the one that was created the latest, that was archived today");
    assert.match(disambiguate.reply, new RegExp(expected.title, "i"));

    const confirm = await sendAgentMessage(server, userId, "yes");
    assert.equal(confirm.debug.mutationExecuted, true);
    const restoredExpected = await prisma.goal.findUnique({ where: { id: expected.id } });
    const restoredOther = await prisma.goal.findUnique({ where: { id: olderCreatedTodayArchived.id } });
    assert.equal(restoredExpected?.status, "active");
    assert.equal(restoredOther?.status, "archived");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4E: if recency phrasing still leaves multiple candidates, ask for clarification rather than guessing", async () => {
  const server = buildServer();
  const userId = `restore-recency-stillambiguous-${randomUUID()}`;
  try {
    await seedUser(userId);
    // Both archived today, at the SAME real moment (a genuine tie the parser can't break).
    const sameMoment = hoursAgo(1);
    await seedArchivedGoal(userId, "Job search for developer roles", { archivedAt: sameMoment });
    await seedArchivedGoal(userId, "Job search for designer roles", { archivedAt: sameMoment });

    await sendAgentMessage(server, userId, "restore my job search goal");
    const disambiguate = await sendAgentMessage(server, userId, "the one archived today");
    assert.equal(disambiguate.debug.pendingOperation, true, "must still be pending — never guesses on a genuine tie");
    assert.equal(disambiguate.debug.mutationExecuted, false);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// ---------------------------------------------------------------------------
// Task 5: final confirmation still required
// ---------------------------------------------------------------------------

test("5A/5B/5C/5D/5E/5F: disambiguation resolves to a real confirmation, 'yes' restores the exact same row with its Gmail watcher intact", async () => {
  const server = buildServer();
  const userId = `restore-final-confirmation-${randomUUID()}`;
  try {
    await seedUser(userId);
    const connection = await prisma.integrationConnection.create({ data: { userId, integrationId: "gmail", status: "active", config: {} } });
    const goalA = await seedArchivedGoal(userId, "Job search for developer roles", { archivedAt: hoursAgo(1) });
    const rule = await prisma.emailSignalRule.create({
      data: {
        userId,
        goalId: goalA.id,
        connectionId: connection.id,
        adapterId: "job_search_email",
        name: "Job search emails",
        status: "active",
        fetchStrategy: "query",
        lookbackDays: 30,
        maxMessagesPerSync: 25,
        maxEventsPerSync: 5,
        classifierMode: "rules",
        minAutoLogConfidence: 1,
        minReviewConfidence: 0.65,
        reviewBeforeLogging: true,
        notifyPolicy: "review_only",
        createdBy: "user"
      }
    });
    await seedArchivedGoal(userId, "Job search for designer roles", { archivedAt: hoursAgo(30) });

    await sendAgentMessage(server, userId, "restore my job search goal");
    const disambiguate = await sendAgentMessage(server, userId, "latest archived");
    assert.equal(disambiguate.debug.pendingOperation, true, "disambiguation must resolve to a pending confirmation");
    assert.equal(disambiguate.debug.mutationExecuted, false, "must NOT restore immediately from disambiguation");
    assert.match(disambiguate.reply, /restore it\? reply yes to confirm or cancel/i);

    const cancelAttempt = await sendAgentMessage(server, userId, "cancel");
    assert.equal(cancelAttempt.debug.pendingOperation, false);
    const stillArchived = await prisma.goal.findUnique({ where: { id: goalA.id } });
    assert.equal(stillArchived?.status, "archived", "'cancel' at the final step must not restore anything");

    // Re-run the flow and actually confirm this time.
    await sendAgentMessage(server, userId, "restore my job search goal");
    await sendAgentMessage(server, userId, "latest archived");
    const confirm = await sendAgentMessage(server, userId, "yes");
    assert.equal(confirm.debug.mutationExecuted, true);

    const restored = await prisma.goal.findUnique({ where: { id: goalA.id } });
    assert.equal(restored?.status, "active");
    assert.equal(restored?.id, goalA.id, "the SAME goal row must be restored, never a new one");

    const ruleAfter = await prisma.emailSignalRule.findUnique({ where: { id: rule.id } });
    assert.equal(ruleAfter?.status, "active", "the linked Gmail watcher must be preserved");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

// ---------------------------------------------------------------------------
// Task 6: restore-vs-create priority
// ---------------------------------------------------------------------------

test("6A/6B: restore command with (single or multiple) archived matches never creates a goal proposal", async () => {
  const server1 = buildServer();
  const userId1 = `restore-priority-single-${randomUUID()}`;
  try {
    await seedUser(userId1);
    await seedArchivedGoal(userId1, "Find a fully remote developer job, ideally in Web3");

    const reply = await sendAgentMessage(server1, userId1, 'restore the goal "Find a fully remote developer job, ideally in Web3"');
    assert.ok(!reply.operationsPlanned.some((op) => op.tool === "goal.create_propose"));
    assert.doesNotMatch(reply.reply, /want me to create/i);
  } finally {
    clearAgentRuntimeMocks();
    await server1.close();
    await prisma.user.deleteMany({ where: { id: userId1 } });
  }

  const server2 = buildServer();
  const userId2 = `restore-priority-multi-${randomUUID()}`;
  try {
    await seedUser(userId2);
    await seedArchivedGoal(userId2, "Job search for developer roles");
    await seedArchivedGoal(userId2, "Job search for designer roles");

    const reply = await sendAgentMessage(server2, userId2, "restore my job search goal");
    assert.ok(!reply.operationsPlanned.some((op) => op.tool === "goal.create_propose"));
    assert.doesNotMatch(reply.reply, /want me to create/i);
  } finally {
    clearAgentRuntimeMocks();
    await server2.close();
    await prisma.user.deleteMany({ where: { id: userId2 } });
  }
});

test("6C/6D: no archived match may offer to create (only after saying so honestly); an active match says already active", async () => {
  const server1 = buildServer();
  const userId1 = `restore-priority-notfound-${randomUUID()}`;
  try {
    await seedUser(userId1);
    const reply = await sendAgentMessage(server1, userId1, "restore my job search goal");
    assert.match(reply.reply, /don't see an archived goal matching/i);
  } finally {
    clearAgentRuntimeMocks();
    await server1.close();
    await prisma.user.deleteMany({ where: { id: userId1 } });
  }

  const server2 = buildServer();
  const userId2 = `restore-priority-active-${randomUUID()}`;
  try {
    await seedUser(userId2);
    const activeResult = await createGoal(userId2, { title: "Job search for developer roles", category: "career" });
    if (activeResult.duplicate) throw new Error("unexpected duplicate goal in test setup");

    const reply = await sendAgentMessage(server2, userId2, "restore my job search goal");
    assert.match(reply.reply, /already active/i);
  } finally {
    clearAgentRuntimeMocks();
    await server2.close();
    await prisma.user.deleteMany({ where: { id: userId2 } });
  }
});

// ---------------------------------------------------------------------------
// Task 7: Spanish/Catalan support
// ---------------------------------------------------------------------------

test("7A/7B: Spanish 'el creado más reciente' resolves by createdAt, and 'cancela' clears the disambiguation", async () => {
  const server1 = buildServer();
  const userId1 = `restore-es-latest-${randomUUID()}`;
  try {
    await seedUser(userId1);
    const older = await seedArchivedGoal(userId1, "Búsqueda de trabajo para desarrollador", { createdAt: daysAgo(10) });
    const newer = await seedArchivedGoal(userId1, "Búsqueda de trabajo para diseñador", { createdAt: daysAgo(1) });

    await sendAgentMessage(server1, userId1, "restaura mi objetivo de búsqueda de trabajo");
    const disambiguate = await sendAgentMessage(server1, userId1, "el creado más reciente");
    assert.match(disambiguate.reply, new RegExp(newer.title, "i"));
    const confirm = await sendAgentMessage(server1, userId1, "yes");
    assert.equal(confirm.debug.mutationExecuted, true);
    const restoredNewer = await prisma.goal.findUnique({ where: { id: newer.id } });
    const restoredOlder = await prisma.goal.findUnique({ where: { id: older.id } });
    assert.equal(restoredNewer?.status, "active");
    assert.equal(restoredOlder?.status, "archived");
  } finally {
    clearAgentRuntimeMocks();
    await server1.close();
    await prisma.user.deleteMany({ where: { id: userId1 } });
  }

  const server2 = buildServer();
  const userId2 = `restore-es-cancel-${randomUUID()}`;
  try {
    await seedUser(userId2);
    await seedArchivedGoal(userId2, "Búsqueda de trabajo para desarrollador");
    await seedArchivedGoal(userId2, "Búsqueda de trabajo para diseñador");

    await sendAgentMessage(server2, userId2, "restaura mi objetivo de búsqueda de trabajo");
    const cancelled = await sendAgentMessage(server2, userId2, "cancela");
    assert.equal(cancelled.debug.pendingOperation, false);
  } finally {
    clearAgentRuntimeMocks();
    await server2.close();
    await prisma.user.deleteMany({ where: { id: userId2 } });
  }
});

test("7C/7D: Catalan 'el més recent' resolves by archivedAt (default recency), and 'cancel·la' clears the disambiguation", async () => {
  const server1 = buildServer();
  const userId1 = `restore-ca-latest-${randomUUID()}`;
  try {
    await seedUser(userId1);
    const older = await seedArchivedGoal(userId1, "Cerca de feina per a desenvolupador", { archivedAt: hoursAgo(30) });
    const newer = await seedArchivedGoal(userId1, "Cerca de feina per a dissenyador", { archivedAt: hoursAgo(1) });

    await sendAgentMessage(server1, userId1, "restaura el meu objectiu de cerca de feina");
    const disambiguate = await sendAgentMessage(server1, userId1, "el més recent");
    assert.match(disambiguate.reply, new RegExp(newer.title, "i"));
    const confirm = await sendAgentMessage(server1, userId1, "yes");
    assert.equal(confirm.debug.mutationExecuted, true);
    const restoredNewer = await prisma.goal.findUnique({ where: { id: newer.id } });
    const restoredOlder = await prisma.goal.findUnique({ where: { id: older.id } });
    assert.equal(restoredNewer?.status, "active");
    assert.equal(restoredOlder?.status, "archived");
  } finally {
    clearAgentRuntimeMocks();
    await server1.close();
    await prisma.user.deleteMany({ where: { id: userId1 } });
  }

  const server2 = buildServer();
  const userId2 = `restore-ca-cancel-${randomUUID()}`;
  try {
    await seedUser(userId2);
    await seedArchivedGoal(userId2, "Cerca de feina per a desenvolupador");
    await seedArchivedGoal(userId2, "Cerca de feina per a dissenyador");

    await sendAgentMessage(server2, userId2, "restaura el meu objectiu de cerca de feina");
    const cancelled = await sendAgentMessage(server2, userId2, "cancel·la");
    assert.equal(cancelled.debug.pendingOperation, false);
  } finally {
    clearAgentRuntimeMocks();
    await server2.close();
    await prisma.user.deleteMany({ where: { id: userId2 } });
  }
});

// ---------------------------------------------------------------------------
// Task 8: exact live regression
// ---------------------------------------------------------------------------

test("8. exact live regression: duplicate titles + similar titles + recency phrase resolves the correct goal, restores it, and it shows up in active goals", async () => {
  const server = buildServer();
  const userId = `restore-live-regression-${randomUUID()}`;
  try {
    await seedUser(userId);
    const exactTitle = "Find a fully remote developer job, ideally in Web3";

    // Two with the exact same title — a genuine live-transcript shape.
    await seedArchivedGoal(userId, exactTitle, { archivedAt: hoursAgo(30), createdAt: daysAgo(2) });
    // The one that's both archived today AND created most recently — the expected final match.
    const expected = await seedArchivedGoal(userId, exactTitle, { archivedAt: hoursAgo(1), createdAt: hoursAgo(2) });
    // Several similar job-search titles, also archived, to stress the candidate pool further —
    // deliberately archived/created several days ago, so none of them could ever win "archived
    // today" + "created the latest" over the goal this test actually expects to be restored.
    await seedArchivedGoal(userId, "Find a fully remote developer job", { archivedAt: daysAgo(5), createdAt: daysAgo(6) });
    await seedArchivedGoal(userId, "Find a fully remote developer job in Web3", { archivedAt: daysAgo(5), createdAt: daysAgo(6) });
    await seedArchivedGoal(userId, "Find a fully remote developer job in the web3 space", { archivedAt: daysAgo(5), createdAt: daysAgo(6) });

    // 1: restore the goal "Find a fully remote developer job, ideally in Web3"
    const propose = await sendAgentMessage(server, userId, `restore the goal "${exactTitle}"`);
    // 2: numbered candidates with timestamps
    assert.equal(propose.debug.pendingOperation, true);
    assert.match(propose.reply, /1\./);
    assert.match(propose.reply, /archived/i);
    assert.match(propose.reply, /created/i);

    // 3: user disambiguates by recency
    const disambiguate = await sendAgentMessage(server, userId, "the one that was created the latest, that was archived today");
    // 4: final restore confirmation for the correct candidate
    assert.match(disambiguate.reply, /reply yes to confirm or cancel/i);
    assert.equal(disambiguate.debug.mutationExecuted, false);

    // 5: user confirms
    const confirm = await sendAgentMessage(server, userId, "yes");
    // 6: correct goal restored
    assert.equal(confirm.debug.mutationExecuted, true);
    const restored = await prisma.goal.findUnique({ where: { id: expected.id } });
    assert.equal(restored?.status, "active");

    // 7: what goals do i have -> restored goal listed
    mockPlan({
      topic: "goals",
      intent: "list_goals",
      operations: [op("goal.tracking_show", {})],
      needsClarification: false,
      clarificationQuestion: null,
      replyDraft: ""
    });
    const goalsReply = await sendAgentMessage(server, userId, "what goals do i have");
    assert.match(goalsReply.reply, new RegExp(exactTitle, "i"));

    // Only ONE goal is now active (the correct one) — every other candidate stays archived.
    const activeGoals = await prisma.goal.findMany({ where: { userId, status: "active" } });
    assert.equal(activeGoals.length, 1);
    assert.equal(activeGoals[0].id, expected.id);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("8. 'none' and 'cancel' both clear the live-regression-shaped disambiguation without restoring anything", async () => {
  const server1 = buildServer();
  const userId1 = `restore-live-regression-none-${randomUUID()}`;
  try {
    await seedUser(userId1);
    const exactTitle = "Find a fully remote developer job, ideally in Web3";
    await seedArchivedGoal(userId1, exactTitle, { archivedAt: hoursAgo(30) });
    await seedArchivedGoal(userId1, exactTitle, { archivedAt: hoursAgo(1) });

    await sendAgentMessage(server1, userId1, `restore the goal "${exactTitle}"`);
    const cleared = await sendAgentMessage(server1, userId1, "none");
    assert.equal(cleared.debug.pendingOperation, false);
    assert.equal(await prisma.goal.count({ where: { userId: userId1, status: "active" } }), 0);
  } finally {
    clearAgentRuntimeMocks();
    await server1.close();
    await prisma.user.deleteMany({ where: { id: userId1 } });
  }

  const server2 = buildServer();
  const userId2 = `restore-live-regression-cancel-${randomUUID()}`;
  try {
    await seedUser(userId2);
    const exactTitle = "Find a fully remote developer job, ideally in Web3";
    await seedArchivedGoal(userId2, exactTitle, { archivedAt: hoursAgo(30) });
    await seedArchivedGoal(userId2, exactTitle, { archivedAt: hoursAgo(1) });

    await sendAgentMessage(server2, userId2, `restore the goal "${exactTitle}"`);
    const cancelled = await sendAgentMessage(server2, userId2, "cancel");
    assert.equal(cancelled.debug.pendingOperation, false);
    assert.equal(await prisma.goal.count({ where: { userId: userId2, status: "active" } }), 0);
  } finally {
    clearAgentRuntimeMocks();
    await server2.close();
    await prisma.user.deleteMany({ where: { id: userId2 } });
  }
});

test("8. repeating the exact same ambiguous title keeps the SAME pending clarification rather than looping uselessly", async () => {
  const server = buildServer();
  const userId = `restore-live-regression-repeat-${randomUUID()}`;
  try {
    await seedUser(userId);
    const exactTitle = "Find a fully remote developer job, ideally in Web3";
    await seedArchivedGoal(userId, exactTitle, { archivedAt: hoursAgo(30) });
    await seedArchivedGoal(userId, exactTitle, { archivedAt: hoursAgo(1) });

    const first = await sendAgentMessage(server, userId, `restore the goal "${exactTitle}"`);
    assert.equal(first.debug.pendingOperation, true);

    // Repeating the exact same (still-ambiguous) title must not crash, silently pick one, or lose
    // the pending state — it stays open for the next, actually-disambiguating reply.
    const repeated = await sendAgentMessage(server, userId, exactTitle);
    assert.equal(repeated.debug.pendingOperation, true);
    assert.equal(repeated.debug.mutationExecuted, false);

    const finalDisambiguate = await sendAgentMessage(server, userId, "latest archived");
    assert.match(finalDisambiguate.reply, /reply yes to confirm or cancel/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
