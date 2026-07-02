import Fastify from "fastify";
import {
  CreateGoalInputSchema,
  eventRegistry,
  processMessage,
  ProcessMessageInputSchema,
  type ProcessMessageResult,
  type StoredEvent
} from "@operator-agent/core";
import {
  archiveUserGoal,
  createUserGoal,
  getRecentUserEvents,
  getUserEvents,
  getUserGoals,
  saveExtractedEvents
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

    const result = processMessage(parsed.data);
    const savedEvents = saveExtractedEvents(result.userId, result.extractedEvents);

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
