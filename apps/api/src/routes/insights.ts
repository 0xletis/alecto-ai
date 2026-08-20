import type { FastifyInstance } from "fastify";
import { buildDailyInsight, buildWeeklyInsight, type InsightReport } from "@operator-agent/core";
import { polishInsightWithOpenAI } from "@operator-agent/llm";
import { getActiveGoals, getActiveMemories, getEventsSince, getOrCreateUserOperatingProfile } from "@operator-agent/db";
import { shouldUseOpenAIAnalysis } from "../utils/env.js";

/**
 * Daily and weekly insight routes, extracted from apps/api/src/server.ts's
 * buildServer() as-is (pure move, no behavior change). parseDateStart,
 * startOfToday, startOfLastSevenDays, addDays, maybePolishInsight, and
 * isDirectInsightProfile were only ever used by these two routes (or by
 * each other), so they moved here too rather than staying behind as a
 * circular import back into server.ts.
 */
export function registerInsightRoutes(server: FastifyInstance): void {
  server.get<{ Params: { userId: string }; Querystring: { date?: string } }>(
    "/users/:userId/insights/daily",
    async (request, reply) => {
      const periodStart = request.query.date ? parseDateStart(request.query.date) : startOfToday();

      if (!periodStart) {
        return reply.status(400).send({
          error: "Invalid date. Use YYYY-MM-DD."
        });
      }

      const periodEnd = addDays(periodStart, 1);
      const events = (await getEventsSince(request.params.userId, periodStart)).filter(
        (event) => event.timestamp < periodEnd
      );
      const userOperatingProfile = await getOrCreateUserOperatingProfile(request.params.userId);
      const report = buildDailyInsight({
        userId: request.params.userId,
        periodStart,
        periodEnd,
        events,
        activeGoals: await getActiveGoals(request.params.userId),
        activeMemories: await getActiveMemories(request.params.userId),
        userOperatingProfile
      });

      return {
        insight: await maybePolishInsight(report, userOperatingProfile)
      };
    }
  );

  server.get<{ Params: { userId: string }; Querystring: { weekStart?: string } }>(
    "/users/:userId/insights/weekly",
    async (request, reply) => {
      const periodStart = request.query.weekStart ? parseDateStart(request.query.weekStart) : startOfLastSevenDays();

      if (!periodStart) {
        return reply.status(400).send({
          error: "Invalid weekStart. Use YYYY-MM-DD."
        });
      }

      const periodEnd = addDays(periodStart, 7);
      const events = (await getEventsSince(request.params.userId, periodStart)).filter(
        (event) => event.timestamp < periodEnd
      );
      const userOperatingProfile = await getOrCreateUserOperatingProfile(request.params.userId);
      const report = buildWeeklyInsight({
        userId: request.params.userId,
        periodStart,
        periodEnd,
        events,
        activeGoals: await getActiveGoals(request.params.userId),
        activeMemories: await getActiveMemories(request.params.userId),
        userOperatingProfile
      });

      return {
        insight: await maybePolishInsight(report, userOperatingProfile)
      };
    }
  );
}

async function maybePolishInsight(
  report: InsightReport,
  userOperatingProfile: Awaited<ReturnType<typeof getOrCreateUserOperatingProfile>>
): Promise<InsightReport> {
  if (!shouldUseOpenAIAnalysis() || isDirectInsightProfile(userOperatingProfile)) {
    return report;
  }

  try {
    return await polishInsightWithOpenAI(report);
  } catch (error) {
    console.warn("OpenAI insight polish failed; using deterministic insight.");
    return report;
  }
}

function isDirectInsightProfile(profile: Awaited<ReturnType<typeof getOrCreateUserOperatingProfile>>): boolean {
  return profile.directness >= 5 || profile.motivationalStyle === "tough_love" || profile.gamblingGuardrails === "hard_guardian";
}

function startOfToday(): Date {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date;
}

function startOfLastSevenDays(): Date {
  const date = startOfToday();
  date.setDate(date.getDate() - 6);
  return date;
}

function parseDateStart(value: string): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return undefined;
  }

  const date = new Date(`${value}T00:00:00`);

  if (Number.isNaN(date.getTime())) {
    return undefined;
  }

  return date;
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}
