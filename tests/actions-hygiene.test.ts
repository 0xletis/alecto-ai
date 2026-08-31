import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createActionItem, createGoal, prisma } from "../packages/db/src/index.ts";
import {
  applyActionHygieneBatchOperations,
  readActionHygieneBatchOperations
} from "../apps/api/src/actions/hygiene.ts";
import { buildServer } from "../apps/api/src/server.ts";

/**
 * Action-hygiene batch-operation execution, extracted from
 * apps/api/src/server.ts (see docs/09-architecture-inventory.md's "Action
 * Hygiene Service Extraction"). This is the piece applyPendingAction's
 * action_hygiene branch actually depends on.
 */

test("readActionHygieneBatchOperations: parses valid operations, drops invalid/incomplete entries", () => {
  const parsed = readActionHygieneBatchOperations([
    { operation: "archive", actionId: "a1", title: "Task 1" },
    { operation: "snooze", actionId: "a2", title: "Task 2", dueAt: "2026-08-20T09:00:00.000Z" },
    { operation: "not_a_real_operation", actionId: "a3", title: "Task 3" },
    { operation: "complete", actionId: "", title: "Missing id" },
    { operation: "complete", actionId: "a4", title: "" },
    "not an object",
    null
  ]);

  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0], { operation: "archive", actionId: "a1", title: "Task 1", timeText: undefined, dueAt: undefined });
  assert.equal(parsed[1].operation, "snooze");
  assert.equal(parsed[1].dueAt, "2026-08-20T09:00:00.000Z");
});

test("readActionHygieneBatchOperations: non-array input returns an empty list", () => {
  assert.deepEqual(readActionHygieneBatchOperations(undefined), []);
  assert.deepEqual(readActionHygieneBatchOperations("not an array"), []);
  assert.deepEqual(readActionHygieneBatchOperations({ operations: [] }), []);
});

test("applyActionHygieneBatchOperations: archive, complete (with goal progress), snooze, and keep", async () => {
  const userId = `hygiene-batch-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    const { goal } = await createGoal(userId, { title: "Ship the launch", category: "career" });

    const toArchive = await createActionItem(userId, { source: "manual", title: "Old task" });
    const toComplete = await createActionItem(userId, { source: "manual", title: "Finish report", goalId: goal.id, goalTitleSnapshot: goal.title });
    const toSnooze = await createActionItem(userId, { source: "manual", title: "Call Alex" });
    const toKeep = await createActionItem(userId, { source: "manual", title: "Review PR" });

    const result = await applyActionHygieneBatchOperations(
      userId,
      [
        { operation: "archive", actionId: toArchive.id, title: toArchive.title },
        { operation: "complete", actionId: toComplete.id, title: toComplete.title },
        { operation: "snooze", actionId: toSnooze.id, title: toSnooze.title, dueAt: "2026-08-20T09:00:00.000Z" },
        { operation: "keep", actionId: toKeep.id, title: toKeep.title }
      ],
      "Europe/Madrid"
    );

    assert.match(result.reply, /Archived Old task/);
    assert.match(result.reply, /Completed Finish report; goal progress logged for Ship the launch/);
    // fix/private-alpha-remove-user-facing-action-snooze: the batch "snooze" decision still
    // recognizes that word in the user's own reply, but no longer sets the hidden "snoozed"
    // status — it reschedules, keeping the action open (same as every other move/postpone
    // command now does), and the reply says so honestly instead of "Snoozed ... to ...".
    assert.match(result.reply, /Moved Call Alex to/);
    assert.match(result.reply, /Kept Review PR/);

    const archived = await prisma.actionItem.findUnique({ where: { id: toArchive.id } });
    assert.equal(archived?.status, "archived");
    const completed = await prisma.actionItem.findUnique({ where: { id: toComplete.id } });
    assert.equal(completed?.status, "completed");
    const snoozed = await prisma.actionItem.findUnique({ where: { id: toSnooze.id } });
    assert.equal(snoozed?.status, "open", "the batch 'snooze' decision must keep the action open, never hidden");
    const kept = await prisma.actionItem.findUnique({ where: { id: toKeep.id } });
    assert.equal(kept?.status, "open", "keep must not mutate the action");

    const progressEvents = await prisma.event.findMany({ where: { userId, type: "custom.goal_progress_logged" } });
    assert.equal(progressEvents.length, 1);
  } finally {
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("applyActionHygieneBatchOperations: skips actions no longer found, already archived/completed, or missing a snooze time", async () => {
  const userId = `hygiene-batch-skips-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    const alreadyArchived = await createActionItem(userId, { source: "manual", title: "Gone already" });
    await prisma.actionItem.update({ where: { id: alreadyArchived.id }, data: { status: "archived" } });
    const noSnoozeTime = await createActionItem(userId, { source: "manual", title: "Needs a time" });

    const result = await applyActionHygieneBatchOperations(
      userId,
      [
        { operation: "archive", actionId: "does-not-exist", title: "Ghost task" },
        { operation: "complete", actionId: alreadyArchived.id, title: alreadyArchived.title },
        { operation: "snooze", actionId: noSnoozeTime.id, title: noSnoozeTime.title }
      ],
      "Europe/Madrid"
    );

    assert.match(result.reply, /Ghost task: no longer found/);
    assert.match(result.reply, /Gone already: already archived/);
    assert.match(result.reply, /Needs a time: missing new due time/);
    assert.doesNotMatch(result.reply, /^Done:/);
  } finally {
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("applyActionHygieneBatchOperations: no-op input reports no changes", async () => {
  const userId = `hygiene-batch-empty-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    const result = await applyActionHygieneBatchOperations(userId, [], "Europe/Madrid");
    assert.equal(result.reply, "No action changes were made.");
  } finally {
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("pending-actions confirm: action_hygiene batch_update pending action still applies through the HTTP route", async () => {
  const server = buildServer();
  const userId = `hygiene-pending-action-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    const action = await createActionItem(userId, { source: "manual", title: "Stale onboarding task" });

    const pendingAction = await prisma.pendingAction.create({
      data: {
        userId,
        type: "action_hygiene",
        summary: "Archive 1 stale action?",
        payload: {
          operation: "batch_update",
          timezone: "Europe/Madrid",
          operations: [{ operation: "archive", actionId: action.id, title: action.title }]
        }
      }
    });

    const response = await server.inject({
      method: "POST",
      url: `/users/${userId}/pending-actions/${pendingAction.id}/confirm`
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.match(body.reply, /Archived Stale onboarding task/);
    assert.equal(body.pendingAction.status, "confirmed");

    const archived = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(archived?.status, "archived");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
