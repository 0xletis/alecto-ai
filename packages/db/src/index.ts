import { PrismaClient, type Prisma } from "@prisma/client";
import type {
  CreateGoalInput,
  ExtractedEvent,
  Goal,
  StoredEvent,
  UpdateUserOperatingProfileInput,
  UserOperatingProfile
} from "@operator-agent/core";

export const prisma = new PrismaClient();

export interface CreateEventInput {
  type: StoredEvent["type"];
  timestamp?: Date;
  source: StoredEvent["source"];
  data?: Record<string, unknown>;
  confidence: number;
  evidence?: string[];
}

export async function ensureUser(userId: string) {
  return prisma.user.upsert({
    where: { id: userId },
    update: {},
    create: { id: userId }
  });
}

export async function createGoal(userId: string, input: CreateGoalInput): Promise<Goal> {
  await ensureUser(userId);

  const goal = await prisma.goal.create({
    data: {
      userId,
      title: input.title,
      category: input.category,
      why: input.why
    }
  });

  return toGoal(goal);
}

export async function getGoals(userId: string): Promise<Goal[]> {
  await ensureUser(userId);

  const goals = await prisma.goal.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" }
  });

  return goals.map(toGoal);
}

export async function archiveGoal(userId: string, goalId: string): Promise<Goal | undefined> {
  await ensureUser(userId);

  const existingGoal = await prisma.goal.findFirst({
    where: {
      id: goalId,
      userId
    }
  });

  if (!existingGoal) {
    return undefined;
  }

  const goal = await prisma.goal.update({
    where: { id: goalId },
    data: { status: "archived" }
  });

  return toGoal(goal);
}

export async function createEvent(userId: string, eventInput: CreateEventInput): Promise<StoredEvent> {
  await ensureUser(userId);

  const event = await prisma.event.create({
    data: {
      userId,
      type: eventInput.type,
      timestamp: eventInput.timestamp ?? new Date(),
      source: eventInput.source,
      data: toJsonObject(eventInput.data ?? {}),
      confidence: eventInput.confidence,
      evidence: eventInput.evidence ? toJsonArray(eventInput.evidence) : undefined
    }
  });

  return toStoredEvent(event);
}

export async function createEvents(userId: string, eventInputs: CreateEventInput[]): Promise<StoredEvent[]> {
  const events: StoredEvent[] = [];

  for (const eventInput of eventInputs) {
    events.push(await createEvent(userId, eventInput));
  }

  return events;
}

export async function createEventsFromExtracted(
  userId: string,
  extractedEvents: ExtractedEvent[]
): Promise<StoredEvent[]> {
  return createEvents(
    userId,
    extractedEvents.map((event) => ({
      type: event.type,
      timestamp: new Date(),
      source: "manual",
      data: event.data,
      confidence: event.confidence,
      evidence: event.evidence
    }))
  );
}

export async function getEvents(userId: string): Promise<StoredEvent[]> {
  await ensureUser(userId);

  const events = await prisma.event.findMany({
    where: { userId },
    orderBy: { timestamp: "asc" }
  });

  return events.map(toStoredEvent);
}

export async function getRecentEvents(userId: string, limit = 10): Promise<StoredEvent[]> {
  await ensureUser(userId);

  const events = await prisma.event.findMany({
    where: { userId },
    orderBy: { timestamp: "desc" },
    take: limit
  });

  return events.map(toStoredEvent);
}

export async function getEventsSince(userId: string, sinceDate: Date): Promise<StoredEvent[]> {
  await ensureUser(userId);

  const events = await prisma.event.findMany({
    where: {
      userId,
      timestamp: {
        gte: sinceDate
      }
    },
    orderBy: { timestamp: "asc" }
  });

  return events.map(toStoredEvent);
}

export async function getActiveGoals(userId: string): Promise<Goal[]> {
  await ensureUser(userId);

  const goals = await prisma.goal.findMany({
    where: {
      userId,
      status: "active"
    },
    orderBy: { createdAt: "desc" }
  });

  return goals.map(toGoal);
}

export async function getOrCreateUserOperatingProfile(userId: string): Promise<UserOperatingProfile> {
  await ensureUser(userId);

  const profile = await prisma.userOperatingProfile.upsert({
    where: { userId },
    update: {},
    create: { userId }
  });

  return toUserOperatingProfile(profile);
}

export async function updateUserOperatingProfile(
  userId: string,
  input: UpdateUserOperatingProfileInput
): Promise<UserOperatingProfile> {
  await ensureUser(userId);

  const profile = await prisma.userOperatingProfile.upsert({
    where: { userId },
    create: {
      userId,
      ...toUserOperatingProfileUpdateData(input)
    },
    update: toUserOperatingProfileUpdateData(input)
  });

  return toUserOperatingProfile(profile);
}

function toGoal(goal: Prisma.GoalGetPayload<object>): Goal {
  return {
    id: goal.id,
    userId: goal.userId,
    title: goal.title,
    category: goal.category,
    status: goal.status,
    why: goal.why ?? undefined,
    createdAt: goal.createdAt,
    updatedAt: goal.updatedAt
  };
}

function toStoredEvent(event: Prisma.EventGetPayload<object>): StoredEvent {
  return {
    id: event.id,
    userId: event.userId,
    type: event.type as StoredEvent["type"],
    timestamp: event.timestamp,
    source: event.source as StoredEvent["source"],
    data: toRecord(event.data),
    confidence: event.confidence,
    evidence: Array.isArray(event.evidence) ? event.evidence.filter((item) => typeof item === "string") : undefined,
    createdAt: event.createdAt
  };
}

function toUserOperatingProfile(
  profile: Prisma.UserOperatingProfileGetPayload<object>
): UserOperatingProfile {
  return {
    id: profile.id,
    userId: profile.userId,
    directness: profile.directness,
    warmth: profile.warmth,
    humor: profile.humor,
    confrontation: profile.confrontation,
    verbosity: profile.verbosity,
    profanityAllowed: profile.profanityAllowed,
    motivationalStyle: profile.motivationalStyle,
    accountabilityStrictness: profile.accountabilityStrictness,
    reminderFrequency: profile.reminderFrequency,
    escalationStyle: profile.escalationStyle,
    requiresEvidence: profile.requiresEvidence,
    gamblingGuardrails: profile.gamblingGuardrails,
    selfDeceptionSensitivity: profile.selfDeceptionSensitivity,
    cooldownPreference: profile.cooldownPreference,
    vulnerableMode: profile.vulnerableMode,
    avoidingMode: profile.avoidingMode,
    impulsiveMode: profile.impulsiveMode,
    effectivePhrases: toStringArray(profile.effectivePhrases),
    ineffectivePhrases: toStringArray(profile.ineffectivePhrases),
    knownTriggers: toStringArray(profile.knownTriggers),
    knownFailureModes: toStringArray(profile.knownFailureModes),
    knownStrengths: toStringArray(profile.knownStrengths),
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt
  };
}

function toUserOperatingProfileUpdateData(input: UpdateUserOperatingProfileInput) {
  return {
    ...input,
    effectivePhrases: input.effectivePhrases ? toJsonArray(input.effectivePhrases) : undefined,
    ineffectivePhrases: input.ineffectivePhrases ? toJsonArray(input.ineffectivePhrases) : undefined,
    knownTriggers: input.knownTriggers ? toJsonArray(input.knownTriggers) : undefined,
    knownFailureModes: input.knownFailureModes ? toJsonArray(input.knownFailureModes) : undefined,
    knownStrengths: input.knownStrengths ? toJsonArray(input.knownStrengths) : undefined
  };
}

function toRecord(value: Prisma.JsonValue): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

function toJsonObject(value: Record<string, unknown>): Prisma.InputJsonObject {
  return value as Prisma.InputJsonObject;
}

function toJsonArray(value: string[]): Prisma.InputJsonArray {
  return value as Prisma.InputJsonArray;
}

function toStringArray(value: Prisma.JsonValue): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.filter((item): item is string => typeof item === "string");
}
