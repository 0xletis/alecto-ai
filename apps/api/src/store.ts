import { randomUUID } from "node:crypto";
import type { CreateGoalInput, ExtractedEvent, Goal, StoredEvent } from "@operator-agent/core";

const eventsByUserId = new Map<string, StoredEvent[]>();
const goalsByUserId = new Map<string, Goal[]>();

export function saveExtractedEvents(userId: string, extractedEvents: ExtractedEvent[]): StoredEvent[] {
  const now = new Date();
  const storedEvents = extractedEvents.map((event) => ({
    id: randomUUID(),
    userId,
    type: event.type,
    timestamp: now,
    source: "manual" as const,
    data: event.data,
    confidence: event.confidence,
    evidence: event.evidence,
    createdAt: now
  }));

  const currentEvents = eventsByUserId.get(userId) ?? [];
  eventsByUserId.set(userId, [...currentEvents, ...storedEvents]);

  return storedEvents;
}

export function getUserEvents(userId: string): StoredEvent[] {
  return eventsByUserId.get(userId) ?? [];
}

export function getRecentUserEvents(userId: string, limit = 10): StoredEvent[] {
  return [...getUserEvents(userId)]
    .sort((left, right) => right.timestamp.getTime() - left.timestamp.getTime())
    .slice(0, limit);
}

export function getUserGoals(userId: string): Goal[] {
  return goalsByUserId.get(userId) ?? [];
}

export function createUserGoal(userId: string, input: CreateGoalInput): Goal {
  const now = new Date();
  const goal: Goal = {
    id: randomUUID(),
    userId,
    title: input.title,
    category: input.category,
    status: "active",
    why: input.why,
    createdAt: now,
    updatedAt: now
  };

  const currentGoals = goalsByUserId.get(userId) ?? [];
  goalsByUserId.set(userId, [...currentGoals, goal]);

  return goal;
}

export function archiveUserGoal(userId: string, goalId: string): Goal | undefined {
  const currentGoals = goalsByUserId.get(userId) ?? [];
  const goalIndex = currentGoals.findIndex((goal) => goal.id === goalId);

  if (goalIndex === -1) {
    return undefined;
  }

  const archivedGoal: Goal = {
    ...currentGoals[goalIndex],
    status: "archived",
    updatedAt: new Date()
  };

  const nextGoals = [...currentGoals];
  nextGoals.splice(goalIndex, 1, archivedGoal);
  goalsByUserId.set(userId, nextGoals);

  return archivedGoal;
}
