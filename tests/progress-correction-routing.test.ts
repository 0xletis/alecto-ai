import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createActionItem, createGoal } from "../packages/db/src/index.ts";
import { buildServer, clearAgentRuntimeMocks, prisma, seedUser, sendAgentMessage } from "./helpers/agent-runtime-test-helpers.ts";

/**
 * refactor/private-alpha-general-email-intelligence-workflow (gate 4): the live-reported bug —
 * "Application to interview is fake u can delete it" routed to archiving the "Send 10 CVs" ACTION
 * instead of correcting the wrong PROGRESS metric. progressCorrectionShortcutOperation
 * (apps/api/src/agent-runtime/runtime.ts) fixes this by recognizing "fake"/"wrong"/"never
 * happened" + a correction verb as a metric-correction statement, checked ahead of every
 * action-management shortcut, and routing to the real event.list_recent_progress /
 * event.undo_progress tools (both pre-existing from an earlier task).
 */

test("1. 'Application to interview is fake u can delete it' never targets action archive, asks confirmation, and correcting it leaves CV counts unchanged", async () => {
  const server = buildServer();
  const userId = `progress-correction-1-${randomUUID()}`;

  try {
    await seedUser(userId);
    const goal = await createGoal(userId, {
      title: "Find a fully remote developer job",
      category: "career",
      targetMetrics: [
        { key: "applications_sent", label: "Applications sent", labelSingular: "Application sent", signalKey: "applications_sent", aggregation: "count", window: "weekly" },
        { key: "application_to_interview", label: "Application to Interview", labelSingular: "Application to Interview", signalKey: "application_to_interview", aggregation: "count", window: "weekly" }
      ]
    }).then((r) => r.goal);
    void goal;

    await createActionItem(userId, { source: "manual", title: "Send 10 CVs", priority: "high" });
    await prisma.event.create({ data: { userId, type: "career.application_sent", source: "manual", timestamp: new Date(), confidence: 1, data: {} } });
    const fakeEvent = await prisma.event.create({
      data: { userId, type: "custom.goal_progress_logged", source: "gmail", timestamp: new Date(), confidence: 1, data: { signalKey: "application_to_interview" } }
    });

    const statusBefore = await sendAgentMessage(server, userId, "show today goal progress");
    assert.match(statusBefore.reply, /Application to Interview/i);

    const attempt = await sendAgentMessage(server, userId, "Application to interview is fake u can delete it");

    assert.ok(!attempt.operationsExecuted.some((op) => op.tool.startsWith("action.archive")), "must never route to action archive");
    assert.equal(attempt.needsConfirmation, true, "a real historical correction must require explicit confirmation");
    assert.equal(attempt.debug.mutationExecuted, false, "nothing mutates before confirmation");
    assert.match(attempt.reply, /Application to Interview/i);

    const stillActiveDuringConfirm = await prisma.event.findUnique({ where: { id: fakeEvent.id } });
    assert.equal(stillActiveDuringConfirm?.status, "active", "the event is untouched until the user actually confirms");

    const actionsAfterAttempt = await prisma.actionItem.findMany({ where: { userId, title: "Send 10 CVs" } });
    assert.equal(actionsAfterAttempt.length, 1);
    assert.equal(actionsAfterAttempt[0]?.status, "open", "the unrelated action must never be touched by this flow");

    const confirmed = await sendAgentMessage(server, userId, "yes");
    assert.match(confirmed.reply, /Undone/i);

    const archived = await prisma.event.findUnique({ where: { id: fakeEvent.id } });
    assert.equal(archived?.status, "archived");

    const statusAfter = await sendAgentMessage(server, userId, "show today goal progress");
    assert.doesNotMatch(statusAfter.reply, /Application to Interview/i, "goal.status must no longer show the corrected metric");

    const cvEvents = await prisma.event.count({ where: { userId, type: "career.application_sent", status: "active" } });
    assert.equal(cvEvents, 1, "CV-sent counts must be completely unaffected by a progress correction targeting a different metric");

    const stillOpenAction = await prisma.actionItem.findFirst({ where: { userId, title: "Send 10 CVs" } });
    assert.equal(stillOpenAction?.status, "open", "the action must remain untouched after confirmation too");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("2. 'remove fake Application to Interview' (alternate phrasing) also routes to progress correction", async () => {
  const server = buildServer();
  const userId = `progress-correction-2-${randomUUID()}`;

  try {
    await seedUser(userId);
    await prisma.event.create({
      data: { userId, type: "custom.goal_progress_logged", source: "gmail", timestamp: new Date(), confidence: 1, data: { signalKey: "application_to_interview" } }
    });

    const attempt = await sendAgentMessage(server, userId, "remove fake Application to Interview");
    assert.equal(attempt.needsConfirmation, true);
    assert.ok(!attempt.operationsExecuted.some((op) => op.tool.startsWith("action.archive")));
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("3. saying 'no' to the progress-correction confirmation leaves the event untouched", async () => {
  const server = buildServer();
  const userId = `progress-correction-3-${randomUUID()}`;

  try {
    await seedUser(userId);
    const fakeEvent = await prisma.event.create({
      data: { userId, type: "custom.goal_progress_logged", source: "gmail", timestamp: new Date(), confidence: 1, data: { signalKey: "application_to_interview" } }
    });

    await sendAgentMessage(server, userId, "Application to interview is fake, delete it");
    const cancelled = await sendAgentMessage(server, userId, "no");
    assert.doesNotMatch(cancelled.reply, /Undone/i);

    const stillActive = await prisma.event.findUnique({ where: { id: fakeEvent.id } });
    assert.equal(stillActive?.status, "active");
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("4. ambiguous phrasing with two candidate events asks which one, mutates nothing", async () => {
  const server = buildServer();
  const userId = `progress-correction-4-${randomUUID()}`;

  try {
    await seedUser(userId);
    await prisma.event.create({
      data: { userId, type: "custom.goal_progress_logged", source: "gmail", timestamp: new Date(), confidence: 1, data: { signalKey: "application_to_interview" } }
    });
    await prisma.event.create({
      data: { userId, type: "custom.goal_progress_logged", source: "gmail", timestamp: new Date(Date.now() - 1000), confidence: 1, data: { signalKey: "recruiter_reply" } }
    });

    const attempt = await sendAgentMessage(server, userId, "that progress is wrong, delete it");
    assert.equal(attempt.needsConfirmation, false, "an unresolved ambiguous reference must never silently pick one");
    assert.equal(attempt.debug.mutationExecuted, false);
    assert.match(attempt.reply, /which one/i);
  } finally {
    clearAgentRuntimeMocks();
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
