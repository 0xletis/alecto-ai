import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createActionItem, createPendingAction, prisma } from "../packages/db/src/index.ts";
import { buildServer } from "../apps/api/src/server.ts";

/**
 * Pending-actions confirmation flow, extracted from apps/api/src/server.ts
 * into apps/api/src/routes/pending-actions.ts (see
 * docs/09-architecture-inventory.md's "Pending-Actions Route Extraction").
 * Route paths, request/response shapes, status codes, and DB mutations are
 * unchanged from the pre-extraction inline handlers.
 */

test("GET pending-actions: lists a user's pending actions", async () => {
  const server = buildServer();
  const userId = `pending-actions-list-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    await createPendingAction(userId, { type: "action_archive", summary: "Archive 1 action?", payload: { actionId: "a1" } });
    await createPendingAction(userId, { type: "memory_create", summary: "Save memory?", payload: { summary: "test", type: "preference" } });

    const response = await server.inject({ method: "GET", url: `/users/${userId}/pending-actions` });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.pendingActions.length, 2);
    assert.ok(body.pendingActions.every((action: { status: string }) => action.status === "pending"));
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("POST confirm: custom_email_rule create_rule pending action creates a new Gmail rule", async () => {
  const server = buildServer();
  const userId = `pending-actions-confirm-gmail-rule-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    const connection = await prisma.integrationConnection.create({
      data: { userId, integrationId: "gmail", status: "active", config: {} }
    });
    const pendingAction = await createPendingAction(userId, {
      type: "custom_email_rule",
      summary: "Track Endesa bills?",
      payload: {
        operation: "create_rule",
        connectionId: connection.id,
        displayName: "Endesa bills",
        queryPreview: "from:endesa.com"
      }
    });

    const response = await server.inject({
      method: "POST",
      url: `/users/${userId}/pending-actions/${pendingAction.id}/confirm`
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.match(body.reply, /Endesa bills tracking is on/);
    assert.equal(body.pendingAction.status, "confirmed");

    const rules = await prisma.emailSignalRule.findMany({ where: { userId } });
    assert.equal(rules.length, 1);
    assert.equal(rules[0].adapterId, "custom_email_review");
    assert.equal(rules[0].reviewBeforeLogging, true);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("POST confirm: gmail_autonomy_preference pending action updates the connection config", async () => {
  const server = buildServer();
  const userId = `pending-actions-confirm-gmail-autonomy-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    const connection = await prisma.integrationConnection.create({
      data: { userId, integrationId: "gmail", status: "active", config: {} }
    });
    const pendingAction = await createPendingAction(userId, {
      type: "custom_email_rule",
      summary: "Set Gmail to manual only?",
      payload: {
        operation: "gmail_autonomy_preference",
        connectionId: connection.id,
        syncMode: "manual_only",
        preferenceKind: "manual_only"
      }
    });

    const response = await server.inject({
      method: "POST",
      url: `/users/${userId}/pending-actions/${pendingAction.id}/confirm`
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.match(body.reply, /Gmail is set to manual only/);
    assert.equal(body.pendingAction.status, "confirmed");

    const updated = await prisma.integrationConnection.findUnique({ where: { id: connection.id } });
    const config = updated?.config as Record<string, unknown>;
    const gmailAutonomy = config.gmailAutonomy as Record<string, unknown>;
    assert.equal(gmailAutonomy.syncMode, "manual_only");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("POST confirm: action_hygiene batch_update pending action applies the batch and preserves the reply text", async () => {
  const server = buildServer();
  const userId = `pending-actions-confirm-hygiene-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    const action = await createActionItem(userId, { source: "manual", title: "Stale onboarding task" });
    const pendingAction = await createPendingAction(userId, {
      type: "action_hygiene",
      summary: "Archive 1 stale action?",
      payload: {
        operation: "batch_update",
        timezone: "Europe/Madrid",
        operations: [{ operation: "archive", actionId: action.id, title: action.title }]
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

test("POST confirm: action_target_clarification pending actions are refused with 400, not executed", async () => {
  const server = buildServer();
  const userId = `pending-actions-confirm-clarification-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    const pendingAction = await createPendingAction(userId, {
      type: "action_target_clarification",
      summary: "Which action do you mean?",
      payload: {}
    });

    const response = await server.inject({
      method: "POST",
      url: `/users/${userId}/pending-actions/${pendingAction.id}/confirm`
    });

    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "Reply with the number of the action you mean, or cancel.");

    const stillPending = await prisma.pendingAction.findUnique({ where: { id: pendingAction.id } });
    assert.equal(stillPending?.status, "pending");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("POST reject: rejects a pending action and does not mutate anything", async () => {
  const server = buildServer();
  const userId = `pending-actions-reject-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    const action = await createActionItem(userId, { source: "manual", title: "Do not archive me" });
    const pendingAction = await createPendingAction(userId, {
      type: "action_hygiene",
      summary: "Archive 1 stale action?",
      payload: { operation: "batch_update", timezone: "Europe/Madrid", operations: [{ operation: "archive", actionId: action.id, title: action.title }] }
    });

    const response = await server.inject({
      method: "POST",
      url: `/users/${userId}/pending-actions/${pendingAction.id}/reject`
    });

    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.reply, "Cancelled. I did not change anything.");
    assert.equal(body.pendingAction.status, "rejected");

    const untouched = await prisma.actionItem.findUnique({ where: { id: action.id } });
    assert.equal(untouched?.status, "open", "reject must never apply the pending action's effect");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("missing pending action: confirm and reject both return 404 with the same error shape as before", async () => {
  const server = buildServer();
  const userId = `pending-actions-missing-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });

    const confirmResponse = await server.inject({
      method: "POST",
      url: `/users/${userId}/pending-actions/${randomUUID()}/confirm`
    });
    assert.equal(confirmResponse.statusCode, 404);
    assert.equal(confirmResponse.json().error, "Pending action not found");

    const rejectResponse = await server.inject({
      method: "POST",
      url: `/users/${userId}/pending-actions/${randomUUID()}/reject`
    });
    assert.equal(rejectResponse.statusCode, 404);
    assert.equal(rejectResponse.json().error, "Pending action not found");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("missing pending action: confirming an already-confirmed pending action returns 404 (findPendingAction only matches status=pending)", async () => {
  const server = buildServer();
  const userId = `pending-actions-already-confirmed-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });
    const action = await createActionItem(userId, { source: "manual", title: "Archive me once" });
    const pendingAction = await createPendingAction(userId, {
      type: "action_archive",
      summary: "Archive this action?",
      payload: { actionId: action.id }
    });

    const first = await server.inject({
      method: "POST",
      url: `/users/${userId}/pending-actions/${pendingAction.id}/confirm`
    });
    assert.equal(first.statusCode, 200);

    const second = await server.inject({
      method: "POST",
      url: `/users/${userId}/pending-actions/${pendingAction.id}/confirm`
    });
    assert.equal(second.statusCode, 404);
    assert.equal(second.json().error, "Pending action not found");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
