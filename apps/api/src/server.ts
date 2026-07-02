import Fastify from "fastify";
import {
  buildDailyReview,
  CreateGoalInputSchema,
  eventRegistry,
  processMessage,
  ProcessMessageInputSchema,
  type MessageIntent,
  type ProcessMessageResult,
  type StoredEvent
} from "@operator-agent/core";
import {
  archiveUserGoal,
  createUserGoal,
  getActiveGoals,
  getEventsSince,
  getRecentEvents,
  getRecentUserEvents,
  getUserEvents,
  getUserGoals,
  saveExtractedEvents,
  saveStoredEvent
} from "./store.js";

export function buildServer() {
  const server = Fastify({
    logger: true
  });

  server.get("/health", async () => ({
    ok: true,
    service: "operator-agent-api"
  }));

  server.get("/events/types", async () => ({
    eventTypes: eventRegistry
  }));

  server.post("/messages/process", async (request, reply) => {
    const parsed = ProcessMessageInputSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid request body",
        issues: parsed.error.issues
      });
    }

    const recentEvents = getRecentEvents(parsed.data.userId, 50);
    const result = processMessage({
      ...parsed.data,
      recentEvents
    });
    const savedEvents = saveExtractedEvents(result.userId, result.extractedEvents);
    const isRedFinancialRisk = isFinancialRiskIntent(result.intent) && result.riskState === "RED";

    if (isRedFinancialRisk) {
      saveStoredEvent({
        userId: result.userId,
        type: "finance.betting.cooldown_triggered",
        timestamp: new Date(),
        source: "manual",
        data: {
          intent: result.intent,
          reason: "red_risk_state"
        },
        confidence: 1,
        evidence: [result.message]
      });

      return result;
    }

    if (savedEvents.length === 0) {
      return result;
    }

    return {
      ...result,
      reply: composeSavedEventsReply(savedEvents)
    } satisfies ProcessMessageResult;
  });

  server.get<{ Params: { userId: string } }>("/users/:userId/events", async (request) => ({
    events: getUserEvents(request.params.userId)
  }));

  server.get<{ Params: { userId: string } }>("/users/:userId/events/recent", async (request) => ({
    events: getRecentUserEvents(request.params.userId)
  }));

  server.get<{ Params: { userId: string } }>("/users/:userId/goals", async (request) => ({
    goals: getUserGoals(request.params.userId)
  }));

  server.get<{ Params: { userId: string } }>("/users/:userId/review/daily", async (request) => {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    return {
      review: buildDailyReview({
        userId: request.params.userId,
        activeGoals: getActiveGoals(request.params.userId),
        todayEvents: getEventsSince(request.params.userId, todayStart)
      })
    };
  });

  server.post<{ Params: { userId: string } }>("/users/:userId/goals", async (request, reply) => {
    const parsed = CreateGoalInputSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid request body",
        issues: parsed.error.issues
      });
    }

    return {
      goal: createUserGoal(request.params.userId, parsed.data)
    };
  });

  server.patch<{ Params: { userId: string; goalId: string } }>(
    "/users/:userId/goals/:goalId/archive",
    async (request, reply) => {
      const goal = archiveUserGoal(request.params.userId, request.params.goalId);

      if (!goal) {
        return reply.status(404).send({
          error: "Goal not found"
        });
      }

      return { goal };
    }
  );

  return server;
}

function isFinancialRiskIntent(intent: MessageIntent): boolean {
  return intent === "betting_intent" || intent === "trading_intent";
}

function composeSavedEventsReply(events: StoredEvent[]): string {
  const summaries = events.map((event) => {
    if (event.type === "career.application_sent" && typeof event.data.count === "number") {
      return `${event.data.count} application${event.data.count === 1 ? "" : "s"}`;
    }

    if (event.type === "health.workout_completed" && typeof event.data.duration_minutes === "number") {
      return `${event.data.duration_minutes} minutes of training`;
    }

    if (event.type === "health.sleep_logged" && typeof event.data.duration_hours === "number") {
      return `${event.data.duration_hours} hours of sleep`;
    }

    if (event.type === "learning.reading_session_completed" && typeof event.data.duration_minutes === "number") {
      return `${event.data.duration_minutes} minutes of reading`;
    }

    return "1 logged event";
  });

  return `Logged. Today counts: ${joinReadableList(summaries)}.`;
}

function joinReadableList(items: string[]): string {
  if (items.length <= 1) {
    return items[0] ?? "";
  }

  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
