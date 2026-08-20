import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../packages/db/src/index.ts";
import { buildServer } from "../apps/api/src/server.ts";

/**
 * Focused coverage for apps/api/src/routes/checkins-ingest.ts — extracted
 * verbatim out of server.ts's buildServer() (including its two
 * exclusively-used private helpers, ingestText and composeIngestionReply).
 */

test("routes/checkins-ingest: GET checkins/daily/prompt returns a prompt string", async () => {
  const server = buildServer();
  const userId = `routes-checkin-prompt-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });

    const response = await server.inject({ method: "GET", url: `/users/${userId}/checkins/daily/prompt` });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(typeof body.prompt, "string");
    assert.ok(body.prompt.length > 0);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("routes/ingest text: success path classifies and persists an event, validation path rejects an empty body", async () => {
  const server = buildServer();
  const userId = `routes-ingest-text-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });

    // basic validation/error path: `text` is required
    const invalidResponse = await server.inject({
      method: "POST",
      url: `/users/${userId}/ingest/text`,
      payload: {}
    });
    assert.equal(invalidResponse.statusCode, 400);
    const invalidBody = invalidResponse.json();
    assert.equal(invalidBody.error, "Invalid request body");
    assert.ok(Array.isArray(invalidBody.issues));

    // success path: text that the job-search-text adapter classifies confidently
    const response = await server.inject({
      method: "POST",
      url: `/users/${userId}/ingest/text`,
      payload: { text: "Thank you for your application to the Software Engineer role. We are currently reviewing your application." }
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.result.classification, "application_confirmation");
    assert.ok(Array.isArray(body.events));
    assert.equal(body.events.length, 1);
    assert.equal(body.events[0].type, "career.application_confirmation_received");
    assert.equal(typeof body.reply, "string");
    assert.match(body.reply, /Logged career event/i);

    // persistence/side effect: the event must actually be in the DB, not just in the response
    const persisted = await prisma.event.findMany({ where: { userId, type: "career.application_confirmation_received" } });
    assert.equal(persisted.length, 1);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("routes/ingest job-search-text: forces domainHint=career regardless of body, still validates `text`", async () => {
  const server = buildServer();
  const userId = `routes-ingest-jobsearch-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });

    // basic validation/error path: still requires `text` even though domainHint is injected server-side
    const invalidResponse = await server.inject({
      method: "POST",
      url: `/users/${userId}/ingest/job-search-text`,
      payload: {}
    });
    assert.equal(invalidResponse.statusCode, 400);
    assert.equal(invalidResponse.json().error, "Invalid request body");

    // success path: unrelated text still gets routed to the job-search adapter (domainHint forces
    // adapter.supports() to match) but classifies as unknown, producing zero event candidates —
    // this must be a clean 200, not an error, since "no confident classification" isn't invalid input.
    const response = await server.inject({
      method: "POST",
      url: `/users/${userId}/ingest/job-search-text`,
      payload: { text: "Just a normal note about my day, nothing career-related." }
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.result.domain, "career");
    assert.equal(body.events.length, 0);
    assert.match(body.reply, /could not classify/i);

    const persisted = await prisma.event.count({ where: { userId } });
    assert.equal(persisted, 0, "an unclassifiable ingest must not create any event");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
