import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { prisma } from "../packages/db/src/index.ts";
import { buildServer } from "../apps/api/src/server.ts";

/**
 * Focused coverage for apps/api/src/routes/insights.ts — extracted verbatim
 * out of server.ts's buildServer() (including its exclusively-used private
 * helpers: maybePolishInsight, isDirectInsightProfile, startOfToday,
 * startOfLastSevenDays, parseDateStart, addDays).
 */

test("routes/insights: GET insights/daily returns a daily InsightReport shaped response", async () => {
  const server = buildServer();
  const userId = `routes-insights-daily-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });

    const response = await server.inject({ method: "GET", url: `/users/${userId}/insights/daily` });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.insight.userId, userId);
    assert.equal(body.insight.periodType, "daily");
    assert.equal(typeof body.insight.headline, "string");
    assert.equal(typeof body.insight.summary, "string");
    assert.ok(Array.isArray(body.insight.wins));
    assert.ok(Array.isArray(body.insight.gaps));
    assert.ok(Array.isArray(body.insight.risks));
    assert.ok(Array.isArray(body.insight.recommendedActions));

    // no event rows should have been created by a read-only insight report
    const persisted = await prisma.event.count({ where: { userId } });
    assert.equal(persisted, 0);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("routes/insights: GET insights/daily rejects an invalid date query param", async () => {
  const server = buildServer();
  const userId = `routes-insights-daily-invalid-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });

    const response = await server.inject({
      method: "GET",
      url: `/users/${userId}/insights/daily?date=not-a-date`
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "Invalid date. Use YYYY-MM-DD.");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("routes/insights: GET insights/weekly returns a weekly InsightReport shaped response for the requested week", async () => {
  const server = buildServer();
  const userId = `routes-insights-weekly-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });

    const response = await server.inject({
      method: "GET",
      url: `/users/${userId}/insights/weekly?weekStart=2026-08-03`
    });
    assert.equal(response.statusCode, 200);
    const body = response.json();
    assert.equal(body.insight.userId, userId);
    assert.equal(body.insight.periodType, "weekly");
    assert.equal(new Date(body.insight.periodStart).getTime(), new Date("2026-08-03T00:00:00").getTime());
    assert.equal(typeof body.insight.headline, "string");

    const persisted = await prisma.event.count({ where: { userId } });
    assert.equal(persisted, 0);
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});

test("routes/insights: GET insights/weekly rejects an invalid weekStart query param", async () => {
  const server = buildServer();
  const userId = `routes-insights-weekly-invalid-${randomUUID()}`;

  try {
    await prisma.user.upsert({ where: { id: userId }, update: {}, create: { id: userId } });

    const response = await server.inject({
      method: "GET",
      url: `/users/${userId}/insights/weekly?weekStart=13/45/2026`
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error, "Invalid weekStart. Use YYYY-MM-DD.");
  } finally {
    await server.close();
    await prisma.user.deleteMany({ where: { id: userId } });
  }
});
