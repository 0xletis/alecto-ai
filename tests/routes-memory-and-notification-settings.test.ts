import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../packages/db/src/index.ts";
import { buildServer } from "../apps/api/src/server.ts";

/**
 * Focused coverage for apps/api/src/routes/memory.ts and
 * apps/api/src/routes/notification-settings.ts — extracted verbatim out of
 * server.ts's buildServer(). These tests pin down the exact request/response
 * shapes so a future refactor of these files can be checked against them.
 */

test("routes/memory: GET/POST/PATCH-archive behave exactly as the original inline routes", async () => {
  const server = buildServer();
  const userId = `routes-memory-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });

    // success path: create
    const createResponse = await server.inject({
      method: "POST",
      url: `/users/${userId}/memory`,
      payload: { summary: "Prefers blunt feedback", type: "preference" }
    });
    assert.equal(createResponse.statusCode, 200);
    const created = createResponse.json();
    assert.ok(created.memory?.id);
    assert.equal(created.memory.summary, "Prefers blunt feedback");
    assert.equal(created.memory.source, "manual", "route must force source:manual regardless of request body");
    assert.equal(created.memory.status, "active");

    // basic validation/error path: missing required `summary`
    const invalidResponse = await server.inject({
      method: "POST",
      url: `/users/${userId}/memory`,
      payload: { type: "preference" }
    });
    assert.equal(invalidResponse.statusCode, 400);
    const invalidBody = invalidResponse.json();
    assert.equal(invalidBody.error, "Invalid request body");
    assert.ok(Array.isArray(invalidBody.issues));

    // success path: list (default = active only)
    const listResponse = await server.inject({ method: "GET", url: `/users/${userId}/memory` });
    assert.equal(listResponse.statusCode, 200);
    const listed = listResponse.json();
    assert.ok(Array.isArray(listed.memories));
    assert.ok(listed.memories.some((m: { id: string }) => m.id === created.memory.id));

    // success path: archive
    const archiveResponse = await server.inject({
      method: "PATCH",
      url: `/users/${userId}/memory/${created.memory.id}/archive`
    });
    assert.equal(archiveResponse.statusCode, 200);
    assert.equal(archiveResponse.json().memory.status, "archived");

    // archived memory must disappear from the default (active-only) list...
    const listAfterArchive = await server.inject({ method: "GET", url: `/users/${userId}/memory` });
    assert.ok(!listAfterArchive.json().memories.some((m: { id: string }) => m.id === created.memory.id));

    // ...but must still appear with includeArchived=true
    const listIncludeArchived = await server.inject({
      method: "GET",
      url: `/users/${userId}/memory?includeArchived=true`
    });
    assert.ok(listIncludeArchived.json().memories.some((m: { id: string }) => m.id === created.memory.id));

    // error path: archiving a nonexistent memory returns 404 with the exact original message
    const missingArchive = await server.inject({
      method: "PATCH",
      url: `/users/${userId}/memory/${randomUUID()}/archive`
    });
    assert.equal(missingArchive.statusCode, 404);
    assert.equal(missingArchive.json().error, "Memory not found");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("routes/notification-settings: GET/PATCH behave exactly as the original inline routes", async () => {
  const server = buildServer();
  const userId = `routes-notif-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });

    // success path: get-or-create defaults
    const getResponse = await server.inject({ method: "GET", url: `/users/${userId}/notification-settings` });
    assert.equal(getResponse.statusCode, 200);
    const defaults = getResponse.json();
    assert.ok(defaults.notificationSettings);
    assert.equal(defaults.notificationSettings.userId, userId);
    assert.equal(defaults.notificationSettings.dailyCheckinEnabled, false);

    // success path: update
    const patchResponse = await server.inject({
      method: "PATCH",
      url: `/users/${userId}/notification-settings`,
      payload: { dailyCheckinEnabled: true, dailyCheckinTime: "09:30", timezone: "Europe/Madrid" }
    });
    assert.equal(patchResponse.statusCode, 200);
    const updated = patchResponse.json();
    assert.equal(updated.notificationSettings.dailyCheckinEnabled, true);
    assert.equal(updated.notificationSettings.dailyCheckinTime, "09:30");

    // the update must persist (response shape parity with a fresh GET)
    const getAfterUpdate = await server.inject({ method: "GET", url: `/users/${userId}/notification-settings` });
    assert.equal(getAfterUpdate.json().notificationSettings.dailyCheckinEnabled, true);

    // basic validation/error path: malformed time string rejected by the zod regex
    const invalidResponse = await server.inject({
      method: "PATCH",
      url: `/users/${userId}/notification-settings`,
      payload: { dailyCheckinTime: "not-a-time" }
    });
    assert.equal(invalidResponse.statusCode, 400);
    const invalidBody = invalidResponse.json();
    assert.equal(invalidBody.error, "Invalid request body");
    assert.ok(Array.isArray(invalidBody.issues));
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
