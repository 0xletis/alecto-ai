import { randomUUID } from "node:crypto";
import { PrismaClient, type Prisma } from "@prisma/client";
import { findDuplicateActiveGoal, getGoalTemplate, GoalCheckInQuestionSchema, GoalMetricSchema } from "@operator-agent/core";
import type {
  CreateMemoryInput,
  CreateEmailSignalRuleInput,
  CreateGoalInput,
  ExtractedEvent,
  GithubPublicConnectionInput,
  Goal,
  MemoryEntry,
  NotificationSettings,
  PendingMemoryCreatePayload,
  StoredEvent,
  UpdateIntegrationConnectionInput,
  UpdateEmailSignalRuleInput,
  UpdateNotificationSettingsInput,
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
  eventGroupId?: string;
  externalId?: string;
  provider?: string;
}

export interface ExternalEventDedupeOptions {
  ignoreArchivedCleanup?: boolean;
}

export interface GmailSemanticEventDedupeInput {
  userId: string;
  ruleId: string;
  eventType: StoredEvent["type"];
  subject?: string;
  from?: string;
  company?: string;
  role?: string;
  since?: Date;
}

export interface GmailSemanticReviewDedupeInput {
  userId: string;
  ruleId: string;
  adapterId: string;
  provider: "gmail";
  proposedEventType?: string;
  subject?: string;
  from?: string;
  company?: string;
  role?: string;
  since?: Date;
}

export interface EventQueryOptions {
  includeArchived?: boolean;
}

export interface CorrectEventInput {
  type?: StoredEvent["type"];
  timestamp?: Date;
  data: Record<string, unknown>;
  evidence?: string[];
  reason?: string;
}

export type PendingActionType =
  | "profile_update"
  | "goal_create"
  | "goal_archive"
  | "goal_progress_log"
  | "memory_create"
  | "event_undo_last";
export type PendingActionStatus = "pending" | "confirmed" | "rejected" | "expired";

export interface PendingAction {
  id: string;
  userId: string;
  type: PendingActionType;
  status: PendingActionStatus;
  summary: string;
  payload: Record<string, unknown>;
  expiresAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreatePendingActionInput {
  type: PendingActionType;
  summary: string;
  payload: Record<string, unknown>;
  expiresAt?: Date;
}

export interface GetRelevantMemoriesOptions {
  limit?: number;
  types?: MemoryEntry["type"][];
}

export interface NotificationLogInput {
  userId: string;
  type: string;
  sentForDate: string;
}

export interface IntegrationConnection {
  id: string;
  userId: string;
  integrationId: string;
  status: "active" | "paused" | "error" | "archived";
  config: Record<string, unknown>;
  lastSyncedAt?: Date;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IntegrationSyncLog {
  id: string;
  userId: string;
  connectionId: string;
  integrationId: string;
  status: "success" | "error";
  startedAt: Date;
  finishedAt?: Date;
  eventsCreated: number;
  error?: string;
}

export interface EmailSignalRule {
  id: string;
  userId: string;
  connectionId: string;
  goalId?: string;
  adapterId: string;
  name: string;
  query?: string;
  status: "active" | "paused" | "archived" | "error";
  fetchStrategy: "query" | "all_recent" | "sender_allowlist" | "label";
  lookbackDays: number;
  maxMessagesPerSync: number;
  maxEventsPerSync: number;
  classifierMode: "rules" | "llm" | "hybrid";
  minAutoLogConfidence: number;
  minReviewConfidence: number;
  reviewBeforeLogging: boolean;
  createdBy: "system" | "user";
  lastSyncedAt?: Date;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface EmailReviewItem {
  id: string;
  userId: string;
  connectionId: string;
  ruleId: string;
  adapterId: string;
  provider: "gmail";
  providerMessageId: string;
  externalId: string;
  subject?: string;
  from?: string;
  snippet?: string;
  evidence?: string;
  proposedEventType?: string;
  confidence: number;
  reason: string;
  extracted: Record<string, unknown>;
  status: "pending" | "approved" | "rejected" | "archived";
  eventId?: string;
  archiveReason?: string;
  reviewedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface EmailReviewItemInput {
  userId: string;
  connectionId: string;
  ruleId: string;
  adapterId: string;
  provider: "gmail";
  providerMessageId: string;
  externalId: string;
  subject?: string;
  from?: string;
  snippet?: string;
  evidence?: string;
  proposedEventType?: string;
  confidence: number;
  reason: string;
  extracted: Record<string, unknown>;
}

export type EmailReviewUpsertResult =
  | { status: "created"; item: EmailReviewItem }
  | { status: "already_pending"; item: EmailReviewItem }
  | { status: "rejected_deduped"; item: EmailReviewItem }
  | { status: "approved_deduped"; item: EmailReviewItem }
  | { status: "archived_deduped"; item: EmailReviewItem }
  | { status: "semantic_pending"; item: EmailReviewItem }
  | { status: "semantic_rejected"; item: EmailReviewItem }
  | { status: "semantic_approved"; item: EmailReviewItem }
  | { status: "semantic_archived"; item: EmailReviewItem }
  | { status: "active_event_deduped"; event: StoredEvent };

export type CreateGoalResult =
  | {
      duplicate: false;
      goal: Goal;
    }
  | {
      duplicate: true;
      existingGoal: Goal;
    };

export async function ensureUser(userId: string) {
  try {
    return await prisma.user.upsert({
      where: { id: userId },
      update: {},
      create: { id: userId }
    });
  } catch (error) {
    if (!isPrismaUniqueConstraintError(error)) {
      throw error;
    }

    const user = await prisma.user.findUnique({
      where: { id: userId }
    });

    if (!user) {
      throw error;
    }

    return user;
  }
}

export async function createGoal(userId: string, input: CreateGoalInput): Promise<CreateGoalResult> {
  await ensureUser(userId);
  const template = input.templateId ? getGoalTemplate(input.templateId) : undefined;
  const activeGoals = await getActiveGoals(userId);
  const duplicateGoal = input.allowDuplicate ? undefined : findDuplicateActiveGoal(input, activeGoals);

  if (duplicateGoal) {
    return {
      duplicate: true,
      existingGoal: duplicateGoal
    };
  }

  const goal = await prisma.goal.create({
    data: {
      userId,
      title: input.title,
      category: input.category,
      why: input.why,
      templateId: input.templateId,
      targetMetrics: input.targetMetrics
        ? toJsonArray(input.targetMetrics)
        : template
          ? toJsonArray(template.suggestedMetrics)
          : undefined,
      checkInConfig: input.checkInConfig
        ? toJsonArray(input.checkInConfig)
        : template
          ? toJsonArray(template.checkInQuestions)
          : undefined
    }
  });

  return {
    duplicate: false,
    goal: toGoal(goal)
  };
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
      evidence: eventInput.evidence ? toJsonArray(eventInput.evidence) : undefined,
      eventGroupId: eventInput.eventGroupId,
      externalId: eventInput.externalId,
      provider: eventInput.provider
    }
  });

  return toStoredEvent(event);
}

export async function createEvents(userId: string, eventInputs: CreateEventInput[]): Promise<StoredEvent[]> {
  const events: StoredEvent[] = [];
  const eventGroupId = randomUUID();

  for (const eventInput of eventInputs) {
    events.push(
      await createEvent(userId, {
        ...eventInput,
        eventGroupId: eventInput.eventGroupId ?? eventGroupId
      })
    );
  }

  return events;
}

export async function createExternalEventIfNotExists(
  userId: string,
  eventInput: CreateEventInput & { externalId: string },
  options: ExternalEventDedupeOptions = {}
): Promise<{ created: boolean; event: StoredEvent; ignoredArchivedCleanup?: boolean }> {
  await ensureUser(userId);

  const existingEvent = await prisma.event.findUnique({
    where: {
      userId_source_externalId: {
        userId,
        source: eventInput.source,
        externalId: eventInput.externalId
      }
    }
  });

  if (existingEvent) {
    if (shouldIgnoreArchivedCleanupEvent(existingEvent, eventInput, options)) {
      await prisma.event.update({
        where: { id: existingEvent.id },
        data: {
          externalId: `${existingEvent.externalId}:cleanup:${existingEvent.id}`
        }
      });

      return {
        created: true,
        event: await createEvent(userId, eventInput),
        ignoredArchivedCleanup: true
      };
    }

    return {
      created: false,
      event: toStoredEvent(existingEvent)
    };
  }

  return {
    created: true,
    event: await createEvent(userId, eventInput)
  };
}

export async function findGmailSemanticDuplicateEvent(
  input: GmailSemanticEventDedupeInput
): Promise<StoredEvent | undefined> {
  await ensureUser(input.userId);

  const subject = normalizeSemanticText(input.subject);
  const from = normalizeEmailAddress(input.from);
  const company = normalizeSemanticText(input.company);
  const role = normalizeSemanticText(input.role);

  if (!subject || !from) {
    return undefined;
  }

  const events = await prisma.event.findMany({
    where: {
      userId: input.userId,
      type: input.eventType,
      source: "gmail",
      provider: "gmail",
      status: "active",
      timestamp: {
        gte: input.since ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      }
    },
    orderBy: { timestamp: "desc" }
  });

  const duplicate = events.find((event) => {
    const data = toRecord(event.data);

    return (
      data.ruleId === input.ruleId &&
      normalizeSemanticText(readString(data.subject)) === subject &&
      normalizeEmailAddress(readString(data.from)) === from &&
      normalizeSemanticText(readString(data.company)) === company &&
      normalizeSemanticText(readString(data.role)) === role
    );
  });

  return duplicate ? toStoredEvent(duplicate) : undefined;
}

export async function findGmailSemanticDuplicateReviewItem(
  input: GmailSemanticReviewDedupeInput
): Promise<EmailReviewItem | undefined> {
  await ensureUser(input.userId);

  const subject = normalizeSemanticText(input.subject);
  const from = normalizeEmailAddress(input.from);
  const company = normalizeSemanticText(input.company);
  const role = normalizeSemanticText(input.role);

  if (!subject || !from || !input.proposedEventType) {
    return undefined;
  }

  const items = await prisma.emailReviewItem.findMany({
    where: {
      userId: input.userId,
      ruleId: input.ruleId,
      adapterId: input.adapterId,
      provider: input.provider,
      proposedEventType: input.proposedEventType,
      createdAt: {
        gte: input.since ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      }
    },
    orderBy: { updatedAt: "desc" }
  });

  const matches = items.filter((item) => {
    const extracted = toRecord(item.extracted);

    return (
      normalizeSemanticText(item.subject ?? undefined) === subject &&
      normalizeEmailAddress(item.from ?? undefined) === from &&
      normalizeSemanticText(readString(extracted.company)) === company &&
      normalizeSemanticText(readString(extracted.role)) === role
    );
  });

  const duplicate =
    matches.find((item) => normalizeEmailReviewStatus(item.status) === "pending") ??
    matches.find((item) => normalizeEmailReviewStatus(item.status) === "rejected") ??
    matches.find((item) => normalizeEmailReviewStatus(item.status) === "approved") ??
    matches.find((item) => normalizeEmailReviewStatus(item.status) === "archived");

  return duplicate ? toEmailReviewItem(duplicate) : undefined;
}

export async function approvePendingGmailReviewItemsForSemanticEvent(input: {
  userId: string;
  ruleId: string;
  adapterId: string;
  proposedEventType: StoredEvent["type"];
  subject?: string;
  from?: string;
  company?: string;
  role?: string;
  eventId: string;
  since?: Date;
}): Promise<EmailReviewItem[]> {
  await ensureUser(input.userId);

  const subject = normalizeSemanticText(input.subject);
  const from = normalizeEmailAddress(input.from);
  const company = normalizeSemanticText(input.company);
  const role = normalizeSemanticText(input.role);

  if (!subject || !from) {
    return [];
  }

  const items = await prisma.emailReviewItem.findMany({
    where: {
      userId: input.userId,
      ruleId: input.ruleId,
      adapterId: input.adapterId,
      provider: "gmail",
      proposedEventType: input.proposedEventType,
      status: "pending",
      createdAt: {
        gte: input.since ?? new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
      }
    }
  });

  const matchingIds = items
    .filter((item) => {
      const extracted = toRecord(item.extracted);

      return (
        normalizeSemanticText(item.subject ?? undefined) === subject &&
        normalizeEmailAddress(item.from ?? undefined) === from &&
        normalizeSemanticText(readString(extracted.company)) === company &&
        normalizeSemanticText(readString(extracted.role)) === role
      );
    })
    .map((item) => item.id);

  if (matchingIds.length === 0) {
    return [];
  }

  await prisma.emailReviewItem.updateMany({
    where: {
      id: {
        in: matchingIds
      }
    },
    data: {
      status: "approved",
      eventId: input.eventId,
      reviewedAt: new Date()
    }
  });

  const updated = await prisma.emailReviewItem.findMany({
    where: {
      id: {
        in: matchingIds
      }
    },
    orderBy: { updatedAt: "desc" }
  });

  return updated.map(toEmailReviewItem);
}

export async function archivePendingEmailReviewItemsForRule(userId: string, ruleId: string): Promise<EmailReviewItem[]> {
  await ensureUser(userId);

  const items = await prisma.emailReviewItem.findMany({
    where: {
      userId,
      ruleId,
      status: "pending"
    }
  });

  if (items.length === 0) {
    return [];
  }

  await prisma.emailReviewItem.updateMany({
    where: {
      id: {
        in: items.map((item) => item.id)
      }
    },
    data: {
      status: "archived",
      archiveReason: "cleanup email reviews",
      reviewedAt: new Date()
    }
  });

  const archived = await prisma.emailReviewItem.findMany({
    where: {
      id: {
        in: items.map((item) => item.id)
      }
    },
    orderBy: { updatedAt: "desc" }
  });

  return archived.map(toEmailReviewItem);
}

export async function findExternalEvent(
  userId: string,
  source: CreateEventInput["source"],
  externalId: string
): Promise<StoredEvent | undefined> {
  await ensureUser(userId);

  const event = await prisma.event.findUnique({
    where: {
      userId_source_externalId: {
        userId,
        source,
        externalId
      }
    }
  });

  return event ? toStoredEvent(event) : undefined;
}

function normalizeSemanticText(value?: string): string {
  return (value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s@.+-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeEmailAddress(value?: string): string {
  const normalized = normalizeSemanticText(value);
  const match = normalized.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/);
  return match?.[0] ?? normalized;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function shouldIgnoreArchivedCleanupEvent(
  existingEvent: Prisma.EventGetPayload<object>,
  eventInput: CreateEventInput & { externalId: string },
  options: ExternalEventDedupeOptions
): boolean {
  if (!options.ignoreArchivedCleanup || eventInput.source !== "gmail") {
    return false;
  }

  const existingData = toRecord(existingEvent.data);
  const nextData = eventInput.data ?? {};

  return (
    existingEvent.source === "gmail" &&
    existingEvent.status === "archived" &&
    existingEvent.archiveReason === "cleanup gmail rule test events" &&
    typeof existingData.ruleId === "string" &&
    typeof nextData.ruleId === "string" &&
    existingData.ruleId === nextData.ruleId
  );
}

export async function createGithubPublicConnection(
  userId: string,
  input: GithubPublicConnectionInput
): Promise<IntegrationConnection> {
  await ensureUser(userId);

  const connection = await prisma.integrationConnection.create({
    data: {
      userId,
      integrationId: "github_public",
      status: "active",
      config: toJsonObject({
        ...input,
        includeRepoActivity: input.includeRepoActivity ?? !input.authorLogin
      })
    }
  });

  return toIntegrationConnection(connection);
}

export async function createGmailConnection(
  userId: string,
  config: Record<string, unknown>
): Promise<IntegrationConnection> {
  await ensureUser(userId);

  const connection = await prisma.integrationConnection.create({
    data: {
      userId,
      integrationId: "gmail",
      status: "active",
      config: toJsonObject(config)
    }
  });

  return toIntegrationConnection(connection);
}

export async function archiveIntegrationConnection(
  userId: string,
  connectionId: string
): Promise<IntegrationConnection | undefined> {
  await ensureUser(userId);

  const existingConnection = await prisma.integrationConnection.findFirst({
    where: {
      id: connectionId,
      userId
    }
  });

  if (!existingConnection) {
    return undefined;
  }

  const connection = await prisma.integrationConnection.update({
    where: { id: connectionId },
    data: {
      status: "archived"
    }
  });

  return toIntegrationConnection(connection);
}

export async function getIntegrationConnections(userId: string): Promise<IntegrationConnection[]> {
  await ensureUser(userId);

  const connections = await prisma.integrationConnection.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" }
  });

  return connections.map(toIntegrationConnection);
}

export async function getActiveIntegrationConnectionsForSync(): Promise<IntegrationConnection[]> {
  const connections = await prisma.integrationConnection.findMany({
    where: {
      status: "active"
    },
    orderBy: { updatedAt: "asc" }
  });

  return connections.map(toIntegrationConnection);
}

export async function updateIntegrationConnectionConfig(
  userId: string,
  connectionId: string,
  config: Record<string, unknown>
): Promise<IntegrationConnection | undefined> {
  await ensureUser(userId);

  const existingConnection = await prisma.integrationConnection.findFirst({
    where: {
      id: connectionId,
      userId
    }
  });

  if (!existingConnection) {
    return undefined;
  }

  const connection = await prisma.integrationConnection.update({
    where: { id: connectionId },
    data: {
      config: toJsonObject(config)
    }
  });

  return toIntegrationConnection(connection);
}

export async function getIntegrationConnection(
  userId: string,
  connectionId: string
): Promise<IntegrationConnection | undefined> {
  await ensureUser(userId);

  const connection = await prisma.integrationConnection.findFirst({
    where: {
      id: connectionId,
      userId
    }
  });

  return connection ? toIntegrationConnection(connection) : undefined;
}

export async function updateIntegrationConnection(
  userId: string,
  connectionId: string,
  input: UpdateIntegrationConnectionInput
): Promise<IntegrationConnection | undefined> {
  await ensureUser(userId);

  const existingConnection = await prisma.integrationConnection.findFirst({
    where: {
      id: connectionId,
      userId
    }
  });

  if (!existingConnection) {
    return undefined;
  }

  const connection = await prisma.integrationConnection.update({
    where: { id: connectionId },
    data: {
      status: input.status,
      lastError: input.status === "active" ? null : existingConnection.lastError
    }
  });

  return toIntegrationConnection(connection);
}

export async function updateIntegrationConnectionSyncState(
  userId: string,
  connectionId: string,
  input: { status?: "active" | "error"; lastSyncedAt?: Date; lastError?: string | null }
): Promise<IntegrationConnection | undefined> {
  await ensureUser(userId);

  const existingConnection = await prisma.integrationConnection.findFirst({
    where: {
      id: connectionId,
      userId
    }
  });

  if (!existingConnection) {
    return undefined;
  }

  const connection = await prisma.integrationConnection.update({
    where: { id: connectionId },
    data: {
      status: input.status,
      lastSyncedAt: input.lastSyncedAt,
      lastError: input.lastError
    }
  });

  return toIntegrationConnection(connection);
}

export async function createIntegrationSyncLog(input: {
  userId: string;
  connectionId: string;
  integrationId: string;
  status: "success" | "error";
  startedAt?: Date;
  finishedAt?: Date;
  eventsCreated?: number;
  error?: string;
}): Promise<IntegrationSyncLog> {
  await ensureUser(input.userId);

  const log = await prisma.integrationSyncLog.create({
    data: {
      userId: input.userId,
      connectionId: input.connectionId,
      integrationId: input.integrationId,
      status: input.status,
      startedAt: input.startedAt ?? new Date(),
      finishedAt: input.finishedAt,
      eventsCreated: input.eventsCreated ?? 0,
      error: input.error
    }
  });

  return toIntegrationSyncLog(log);
}

export async function createEmailSignalRule(
  userId: string,
  input: CreateEmailSignalRuleInput & { createdBy?: "system" | "user" }
): Promise<EmailSignalRule> {
  await ensureUser(userId);

  const rule = await prisma.emailSignalRule.create({
    data: {
      userId,
      connectionId: input.connectionId,
      goalId: input.goalId,
      adapterId: input.adapterId,
      name: input.name,
      query: input.query,
      fetchStrategy: input.fetchStrategy,
      lookbackDays: input.lookbackDays,
      maxMessagesPerSync: input.maxMessagesPerSync,
      maxEventsPerSync: input.maxEventsPerSync,
      classifierMode: input.classifierMode,
      minAutoLogConfidence: input.minAutoLogConfidence,
      minReviewConfidence: input.minReviewConfidence,
      reviewBeforeLogging: input.reviewBeforeLogging,
      createdBy: input.createdBy ?? "user"
    }
  });

  return toEmailSignalRule(rule);
}

export async function getEmailSignalRules(userId: string): Promise<EmailSignalRule[]> {
  await ensureUser(userId);

  const rules = await prisma.emailSignalRule.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" }
  });

  return rules.map(toEmailSignalRule);
}

export async function getActiveEmailSignalRulesForConnection(
  userId: string,
  connectionId: string
): Promise<EmailSignalRule[]> {
  await ensureUser(userId);

  const connection = await prisma.integrationConnection.findFirst({
    where: {
      id: connectionId,
      userId
    }
  });

  if (
    !connection ||
    connection.integrationId !== "gmail" ||
    normalizeStatus(connection.status) !== "active"
  ) {
    return [];
  }

  const rules = await prisma.emailSignalRule.findMany({
    where: {
      userId,
      connectionId
    },
    orderBy: { updatedAt: "asc" }
  });

  return rules.map(toEmailSignalRule).filter((rule) => rule.status === "active");
}

export async function updateEmailSignalRule(
  userId: string,
  ruleId: string,
  input: UpdateEmailSignalRuleInput
): Promise<EmailSignalRule | undefined> {
  await ensureUser(userId);

  const existingRule = await prisma.emailSignalRule.findFirst({
    where: {
      id: ruleId,
      userId
    }
  });

  if (!existingRule) {
    return undefined;
  }

  const rule = await prisma.emailSignalRule.update({
    where: { id: ruleId },
    data: {
      status: input.status,
      fetchStrategy: input.fetchStrategy,
      query: input.query,
      lookbackDays: input.lookbackDays,
      maxMessagesPerSync: input.maxMessagesPerSync,
      maxEventsPerSync: input.maxEventsPerSync,
      classifierMode: input.classifierMode,
      minAutoLogConfidence: input.minAutoLogConfidence,
      minReviewConfidence: input.minReviewConfidence,
      reviewBeforeLogging: input.reviewBeforeLogging,
      lastError: input.status === "active" ? null : existingRule.lastError
    }
  });

  return toEmailSignalRule(rule);
}

export async function archiveEmailSignalRule(userId: string, ruleId: string): Promise<EmailSignalRule | undefined> {
  await ensureUser(userId);

  const existingRule = await prisma.emailSignalRule.findFirst({
    where: {
      id: ruleId,
      userId
    }
  });

  if (!existingRule) {
    return undefined;
  }

  const rule = await prisma.emailSignalRule.update({
    where: { id: ruleId },
    data: { status: "archived" }
  });

  return toEmailSignalRule(rule);
}

export async function updateEmailSignalRuleSyncState(
  userId: string,
  ruleId: string,
  input: { lastSyncedAt?: Date; lastError?: string | null }
): Promise<EmailSignalRule | undefined> {
  await ensureUser(userId);

  const existingRule = await prisma.emailSignalRule.findFirst({
    where: {
      id: ruleId,
      userId
    }
  });

  if (!existingRule) {
    return undefined;
  }

  const rule = await prisma.emailSignalRule.update({
    where: { id: ruleId },
    data: input
  });

  return toEmailSignalRule(rule);
}

export async function upsertEmailReviewItem(input: EmailReviewItemInput): Promise<EmailReviewUpsertResult> {
  await ensureUser(input.userId);

  const existing = await prisma.emailReviewItem.findUnique({
    where: { externalId: input.externalId }
  });

  if (existing) {
    const existingItem = toEmailReviewItem(existing);

    if (existingItem.status === "rejected") {
      return { status: "rejected_deduped", item: existingItem };
    }

    if (existingItem.status === "approved") {
      return { status: "approved_deduped", item: existingItem };
    }

    if (existingItem.status === "archived") {
      const item = await prisma.emailReviewItem.create({
        data: {
          ...emailReviewItemData(input),
          externalId: `${input.externalId}:recreated:${randomUUID()}`
        }
      });

      return { status: "created", item: toEmailReviewItem(item) };
    }

    const updated = await prisma.emailReviewItem.update({
      where: { id: existing.id },
      data: emailReviewItemData(input)
    });

    return { status: "already_pending", item: toEmailReviewItem(updated) };
  }

  const item = await prisma.emailReviewItem.create({
    data: emailReviewItemData(input)
  });

  return { status: "created", item: toEmailReviewItem(item) };
}

export async function getEmailReviewItems(
  userId: string,
  options: { status?: EmailReviewItem["status"] | "all"; limit?: number } = {}
): Promise<EmailReviewItem[]> {
  await ensureUser(userId);

  const items = await prisma.emailReviewItem.findMany({
    where: {
      userId,
      ...(options.status && options.status !== "all" ? { status: options.status } : {})
    },
    orderBy: { updatedAt: "desc" },
    take: options.limit ?? 10
  });

  return items.map(toEmailReviewItem);
}

export async function getEmailReviewItem(userId: string, reviewId: string): Promise<EmailReviewItem | undefined> {
  await ensureUser(userId);

  const item = await prisma.emailReviewItem.findFirst({
    where: {
      id: reviewId,
      userId
    }
  });

  return item ? toEmailReviewItem(item) : undefined;
}

export async function approveEmailReviewItem(
  userId: string,
  reviewId: string,
  eventId?: string
): Promise<EmailReviewItem | undefined> {
  await ensureUser(userId);

  const existing = await prisma.emailReviewItem.findFirst({
    where: {
      id: reviewId,
      userId
    }
  });

  if (!existing || existing.status !== "pending") {
    return existing ? toEmailReviewItem(existing) : undefined;
  }

  const item = await prisma.emailReviewItem.update({
    where: { id: reviewId },
    data: {
      status: "approved",
      eventId,
      reviewedAt: new Date()
    }
  });

  return toEmailReviewItem(item);
}

export async function rejectEmailReviewItem(userId: string, reviewId: string): Promise<EmailReviewItem | undefined> {
  await ensureUser(userId);

  const existing = await prisma.emailReviewItem.findFirst({
    where: {
      id: reviewId,
      userId
    }
  });

  if (!existing || existing.status !== "pending") {
    return existing ? toEmailReviewItem(existing) : undefined;
  }

  const item = await prisma.emailReviewItem.update({
    where: { id: reviewId },
    data: {
      status: "rejected",
      reviewedAt: new Date()
    }
  });

  return toEmailReviewItem(item);
}

function emailReviewItemData(input: EmailReviewItemInput): Prisma.EmailReviewItemUncheckedCreateInput {
  return {
    userId: input.userId,
    connectionId: input.connectionId,
    ruleId: input.ruleId,
    adapterId: input.adapterId,
    provider: input.provider,
    providerMessageId: input.providerMessageId,
    externalId: input.externalId,
    subject: input.subject,
    from: input.from,
    snippet: input.snippet,
    evidence: input.evidence,
    proposedEventType: input.proposedEventType,
    confidence: input.confidence,
    reason: input.reason,
    extracted: toJsonObject(input.extracted),
    status: "pending"
  };
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

export async function getEvents(userId: string, options: EventQueryOptions = {}): Promise<StoredEvent[]> {
  await ensureUser(userId);

  const events = await prisma.event.findMany({
    where: eventWhere(userId, options),
    orderBy: { timestamp: "asc" }
  });

  return events.map(toStoredEvent);
}

export async function getRecentEvents(
  userId: string,
  limit = 10,
  options: EventQueryOptions = {}
): Promise<StoredEvent[]> {
  await ensureUser(userId);

  const events = await prisma.event.findMany({
    where: eventWhere(userId, options),
    orderBy: { timestamp: "desc" },
    take: limit
  });

  return events.map(toStoredEvent);
}

export async function getEventsSince(
  userId: string,
  sinceDate: Date,
  options: EventQueryOptions = {}
): Promise<StoredEvent[]> {
  await ensureUser(userId);

  const events = await prisma.event.findMany({
    where: {
      ...eventWhere(userId, options),
      timestamp: {
        gte: sinceDate
      }
    },
    orderBy: { timestamp: "asc" }
  });

  return events.map(toStoredEvent);
}

export async function getEventById(
  userId: string,
  eventId: string,
  options: EventQueryOptions = {}
): Promise<StoredEvent | undefined> {
  await ensureUser(userId);

  const event = await prisma.event.findFirst({
    where: {
      ...eventWhere(userId, options),
      id: eventId
    }
  });

  return event ? toStoredEvent(event) : undefined;
}

export async function archiveEvent(
  userId: string,
  eventId: string,
  reason = "archived by user"
): Promise<StoredEvent | undefined> {
  await ensureUser(userId);

  const existingEvent = await prisma.event.findFirst({
    where: {
      id: eventId,
      userId,
      status: "active"
    }
  });

  if (!existingEvent) {
    return undefined;
  }

  const event = await prisma.event.update({
    where: { id: eventId },
    data: {
      status: "archived",
      archivedAt: new Date(),
      archiveReason: reason
    }
  });

  return toStoredEvent(event);
}

export async function archiveGmailRuleEvents(
  userId: string,
  ruleId: string,
  reason = "cleanup gmail rule test events"
): Promise<StoredEvent[]> {
  await ensureUser(userId);

  const events = await prisma.event.findMany({
    where: {
      userId,
      source: "gmail",
      status: "active",
      data: {
        path: ["ruleId"],
        equals: ruleId
      }
    },
    orderBy: { createdAt: "asc" }
  });

  const archivedEvents: StoredEvent[] = [];

  for (const event of events) {
    const archivedEvent = await prisma.event.update({
      where: { id: event.id },
      data: {
        status: "archived",
        archivedAt: new Date(),
        archiveReason: reason
      }
    });

    archivedEvents.push(toStoredEvent(archivedEvent));
  }

  return archivedEvents;
}

export async function archiveEventGroup(
  userId: string,
  eventGroupId: string,
  reason = "archived by user"
): Promise<StoredEvent[]> {
  await ensureUser(userId);

  const events = await prisma.event.findMany({
    where: {
      userId,
      eventGroupId,
      status: "active"
    },
    orderBy: { timestamp: "asc" }
  });

  const archivedEvents: StoredEvent[] = [];

  for (const event of events) {
    const archivedEvent = await prisma.event.update({
      where: { id: event.id },
      data: {
        status: "archived",
        archivedAt: new Date(),
        archiveReason: reason
      }
    });

    archivedEvents.push(toStoredEvent(archivedEvent));
  }

  return archivedEvents;
}

export async function correctEvent(
  userId: string,
  eventId: string,
  input: CorrectEventInput
): Promise<{ original: StoredEvent; replacement: StoredEvent } | undefined> {
  await ensureUser(userId);

  const original = await prisma.event.findFirst({
    where: {
      id: eventId,
      userId,
      status: "active"
    }
  });

  if (!original) {
    return undefined;
  }

  const replacement = await prisma.event.create({
    data: {
      userId,
      type: input.type ?? original.type,
      timestamp: input.timestamp ?? original.timestamp,
      source: "manual",
      data: toJsonObject(input.data),
      confidence: 1,
      evidence: toJsonArray(input.evidence ?? [`Corrected from event ${eventId}`]),
      eventGroupId: original.eventGroupId ?? randomUUID()
    }
  });

  const correctedOriginal = await prisma.event.update({
    where: { id: eventId },
    data: {
      status: "corrected",
      correctedByEventId: replacement.id,
      archivedAt: new Date(),
      archiveReason: input.reason ?? "corrected by user"
    }
  });

  await updateParentDailyCheckInForCorrection(userId, original, replacement);

  return {
    original: toStoredEvent(correctedOriginal),
    replacement: toStoredEvent(replacement)
  };
}

export async function undoLastEvents(
  userId: string,
  input: { scope?: "event" | "group"; reason?: string } = {}
): Promise<StoredEvent[]> {
  await ensureUser(userId);

  const latestEvent = await prisma.event.findFirst({
    where: {
      userId,
      status: "active"
    },
    orderBy: { timestamp: "desc" }
  });

  if (!latestEvent) {
    return [];
  }

  if ((input.scope ?? "group") === "group" && latestEvent.eventGroupId) {
    return archiveEventGroup(userId, latestEvent.eventGroupId, input.reason ?? "undo last");
  }

  const archivedEvent = await archiveEvent(userId, latestEvent.id, input.reason ?? "undo last");
  return archivedEvent ? [archivedEvent] : [];
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

export async function createMemory(userId: string, input: CreateMemoryInput): Promise<MemoryEntry> {
  await ensureUser(userId);

  const memory = await prisma.memoryEntry.create({
    data: {
      userId,
      type: input.type,
      summary: input.summary,
      data: input.data ? toJsonObject(input.data) : undefined,
      evidence: input.evidence ? toJsonObject(input.evidence) : undefined,
      source: input.source ?? "manual",
      confidence: input.confidence ?? 1
    }
  });

  return toMemoryEntry(memory);
}

export async function createMemoryFromPendingPayload(
  userId: string,
  payload: PendingMemoryCreatePayload
): Promise<MemoryEntry> {
  return createMemory(userId, payload);
}

export async function getActiveMemories(userId: string): Promise<MemoryEntry[]> {
  await ensureUser(userId);

  const memories = await prisma.memoryEntry.findMany({
    where: {
      userId,
      status: "active"
    },
    orderBy: { createdAt: "desc" }
  });

  return memories.map(toMemoryEntry);
}

export async function getMemories(userId: string): Promise<MemoryEntry[]> {
  await ensureUser(userId);

  const memories = await prisma.memoryEntry.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" }
  });

  return memories.map(toMemoryEntry);
}

export async function archiveMemory(userId: string, memoryId: string): Promise<MemoryEntry | undefined> {
  await ensureUser(userId);

  const existingMemory = await prisma.memoryEntry.findFirst({
    where: {
      id: memoryId,
      userId
    }
  });

  if (!existingMemory) {
    return undefined;
  }

  const memory = await prisma.memoryEntry.update({
    where: { id: memoryId },
    data: { status: "archived" }
  });

  return toMemoryEntry(memory);
}

export async function getRelevantMemories(
  userId: string,
  options: GetRelevantMemoriesOptions = {}
): Promise<MemoryEntry[]> {
  await ensureUser(userId);

  const memories = await prisma.memoryEntry.findMany({
    where: {
      userId,
      status: "active",
      ...(options.types ? { type: { in: options.types } } : {})
    },
    orderBy: { createdAt: "desc" },
    take: options.limit ?? 10
  });

  return memories.map(toMemoryEntry);
}

export async function getOrCreateUserOperatingProfile(userId: string): Promise<UserOperatingProfile> {
  await ensureUser(userId);

  try {
    const profile = await prisma.userOperatingProfile.upsert({
      where: { userId },
      update: {},
      create: { userId }
    });

    return toUserOperatingProfile(profile);
  } catch (error) {
    if (!isPrismaUniqueConstraintError(error)) {
      throw error;
    }

    const profile = await prisma.userOperatingProfile.findUnique({
      where: { userId }
    });

    if (!profile) {
      throw error;
    }

    return toUserOperatingProfile(profile);
  }
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

export async function getOrCreateNotificationSettings(userId: string): Promise<NotificationSettings> {
  await ensureUser(userId);

  const settings = await prisma.notificationSettings.upsert({
    where: { userId },
    update: {},
    create: { userId }
  });

  return toNotificationSettings(settings);
}

export async function updateNotificationSettings(
  userId: string,
  input: UpdateNotificationSettingsInput
): Promise<NotificationSettings> {
  await ensureUser(userId);

  const settings = await prisma.notificationSettings.upsert({
    where: { userId },
    create: {
      userId,
      ...input
    },
    update: input
  });

  return toNotificationSettings(settings);
}

export async function getUsersWithDailyCheckinEnabled(): Promise<NotificationSettings[]> {
  const settings = await prisma.notificationSettings.findMany({
    where: {
      dailyCheckinEnabled: true
    },
    orderBy: {
      updatedAt: "desc"
    }
  });

  return settings.map(toNotificationSettings);
}

export async function getUsersWithEnabledNotifications(): Promise<NotificationSettings[]> {
  const settings = await prisma.notificationSettings.findMany({
    where: {
      OR: [
        { dailyCheckinEnabled: true },
        { dailyInsightEnabled: true },
        { weeklyInsightEnabled: true }
      ]
    },
    orderBy: {
      updatedAt: "desc"
    }
  });

  return settings.map(toNotificationSettings);
}

export async function createNotificationLog(input: NotificationLogInput): Promise<boolean> {
  try {
    await prisma.notificationLog.create({
      data: {
        userId: input.userId,
        type: input.type,
        sentForDate: input.sentForDate
      }
    });
    return true;
  } catch (error) {
    if (isPrismaUniqueConstraintError(error)) {
      return false;
    }

    throw error;
  }
}

export async function hasNotificationLog(input: NotificationLogInput): Promise<boolean> {
  const log = await prisma.notificationLog.findUnique({
    where: {
      userId_type_sentForDate: {
        userId: input.userId,
        type: input.type,
        sentForDate: input.sentForDate
      }
    }
  });

  return Boolean(log);
}

export async function hasRecentNotificationLog(input: Pick<NotificationLogInput, "userId" | "type"> & { since: Date }): Promise<boolean> {
  const log = await prisma.notificationLog.findFirst({
    where: {
      userId: input.userId,
      type: input.type,
      sentAt: {
        gte: input.since
      }
    }
  });

  return Boolean(log);
}

export async function createPendingAction(
  userId: string,
  input: CreatePendingActionInput
): Promise<PendingAction> {
  await ensureUser(userId);

  const pendingAction = await prisma.pendingAction.create({
    data: {
      userId,
      type: input.type,
      summary: input.summary,
      payload: toJsonObject(input.payload),
      expiresAt: input.expiresAt
    }
  });

  return toPendingAction(pendingAction);
}

export async function getPendingActions(userId: string): Promise<PendingAction[]> {
  await expireOldPendingActions(userId);

  const pendingActions = await prisma.pendingAction.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" }
  });

  return pendingActions.map(toPendingAction);
}

export async function getLatestPendingAction(userId: string): Promise<PendingAction | undefined> {
  await expireOldPendingActions(userId);

  const pendingAction = await prisma.pendingAction.findFirst({
    where: {
      userId,
      status: "pending"
    },
    orderBy: { createdAt: "desc" }
  });

  return pendingAction ? toPendingAction(pendingAction) : undefined;
}

export async function confirmPendingAction(
  userId: string,
  pendingActionId: string
): Promise<PendingAction | undefined> {
  await ensureUser(userId);

  const existingAction = await prisma.pendingAction.findFirst({
    where: {
      id: pendingActionId,
      userId,
      status: "pending"
    }
  });

  if (!existingAction) {
    return undefined;
  }

  const pendingAction = await prisma.pendingAction.update({
    where: { id: pendingActionId },
    data: { status: "confirmed" }
  });

  return toPendingAction(pendingAction);
}

export async function rejectPendingAction(
  userId: string,
  pendingActionId: string
): Promise<PendingAction | undefined> {
  await ensureUser(userId);

  const existingAction = await prisma.pendingAction.findFirst({
    where: {
      id: pendingActionId,
      userId,
      status: "pending"
    }
  });

  if (!existingAction) {
    return undefined;
  }

  const pendingAction = await prisma.pendingAction.update({
    where: { id: pendingActionId },
    data: { status: "rejected" }
  });

  return toPendingAction(pendingAction);
}

export async function expireOldPendingActions(userId: string): Promise<void> {
  await ensureUser(userId);

  await prisma.pendingAction.updateMany({
    where: {
      userId,
      status: "pending",
      expiresAt: {
        lt: new Date()
      }
    },
    data: {
      status: "expired"
    }
  });
}

function toGoal(goal: Prisma.GoalGetPayload<object>): Goal {
  return {
    id: goal.id,
    userId: goal.userId,
    title: goal.title,
    category: goal.category,
    status: goal.status,
    why: goal.why ?? undefined,
    templateId: goal.templateId ?? undefined,
    targetMetrics: parseGoalMetrics(goal.targetMetrics),
    checkInConfig: parseGoalCheckInQuestions(goal.checkInConfig),
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
    status: event.status as StoredEvent["status"],
    eventGroupId: event.eventGroupId ?? undefined,
    externalId: event.externalId ?? undefined,
    provider: event.provider ?? undefined,
    archivedAt: event.archivedAt ?? undefined,
    archiveReason: event.archiveReason ?? undefined,
    correctedByEventId: event.correctedByEventId ?? undefined,
    createdAt: event.createdAt
  };
}

async function updateParentDailyCheckInForCorrection(
  userId: string,
  original: Prisma.EventGetPayload<object>,
  replacement: Prisma.EventGetPayload<object>
): Promise<void> {
  if (!original.eventGroupId) {
    return;
  }

  const mappedCorrection = mapCorrectionToCheckInField(replacement.type, toRecord(replacement.data));

  if (!mappedCorrection) {
    return;
  }

  const parent = await prisma.event.findFirst({
    where: {
      userId,
      eventGroupId: original.eventGroupId,
      type: "reflection.daily_checkin_completed",
      status: "active"
    }
  });

  if (!parent) {
    return;
  }

  const parentData = toRecord(parent.data);
  const answers = toRecord(parentData.answers as Prisma.JsonValue);
  const oldValue = answers[mappedCorrection.field];
  const correctedAt = new Date().toISOString();
  const corrections = Array.isArray(parentData.corrections) ? parentData.corrections : [];

  await prisma.event.update({
    where: { id: parent.id },
    data: {
      data: toJsonObject({
        ...parentData,
        answers: {
          ...answers,
          [mappedCorrection.field]: mappedCorrection.value
        },
        corrected: true,
        corrections: [
          ...corrections,
          {
            eventId: original.id,
            replacementEventId: replacement.id,
            field: mappedCorrection.field,
            oldValue,
            newValue: mappedCorrection.value,
            correctedAt
          }
        ]
      })
    }
  });
}

function mapCorrectionToCheckInField(
  type: string,
  data: Record<string, unknown>
): { field: string; value: unknown } | undefined {
  if (type === "health.workout_completed" && typeof data.duration_minutes === "number") {
    return { field: "workout", value: data.duration_minutes };
  }

  if (type === "learning.reading_session_completed" && typeof data.duration_minutes === "number") {
    return { field: "reading", value: data.duration_minutes };
  }

  if (type === "health.sleep_logged" && typeof data.duration_hours === "number") {
    return { field: "sleep", value: data.duration_hours };
  }

  if (type === "career.application_sent" && typeof data.count === "number") {
    return { field: "applications", value: data.count };
  }

  if (type === "reflection.energy_logged" && typeof data.value === "number") {
    return { field: "energy", value: data.value };
  }

  if (type === "reflection.anxiety_logged" && typeof data.value === "number") {
    return { field: "anxiety", value: data.value };
  }

  if (type === "reflection.focus_logged" && typeof data.value === "number") {
    return { field: "focus", value: data.value };
  }

  if (type === "reflection.impulse_logged" && typeof data.value === "number") {
    if (data.kind === "gambling") {
      return { field: "gambling_impulse", value: data.value };
    }

    if (data.kind === "trading") {
      return { field: "trading_impulse", value: data.value };
    }
  }

  return undefined;
}

function toMemoryEntry(memory: Prisma.MemoryEntryGetPayload<object>): MemoryEntry {
  return {
    id: memory.id,
    userId: memory.userId,
    type: memory.type as MemoryEntry["type"],
    status: memory.status as MemoryEntry["status"],
    summary: memory.summary,
    data: memory.data ? toRecord(memory.data) : undefined,
    evidence: memory.evidence ? toRecord(memory.evidence) : undefined,
    source: memory.source as MemoryEntry["source"],
    confidence: memory.confidence,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt
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

function toPendingAction(pendingAction: Prisma.PendingActionGetPayload<object>): PendingAction {
  return {
    id: pendingAction.id,
    userId: pendingAction.userId,
    type: pendingAction.type as PendingActionType,
    status: pendingAction.status as PendingActionStatus,
    summary: pendingAction.summary,
    payload: toRecord(pendingAction.payload),
    expiresAt: pendingAction.expiresAt ?? undefined,
    createdAt: pendingAction.createdAt,
    updatedAt: pendingAction.updatedAt
  };
}

function toIntegrationConnection(
  connection: Prisma.IntegrationConnectionGetPayload<object>
): IntegrationConnection {
  return {
    id: connection.id,
    userId: connection.userId,
    integrationId: connection.integrationId,
    status: normalizeIntegrationStatus(connection.status),
    config: toRecord(connection.config),
    lastSyncedAt: connection.lastSyncedAt ?? undefined,
    lastError: connection.lastError ?? undefined,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt
  };
}

function toIntegrationSyncLog(log: Prisma.IntegrationSyncLogGetPayload<object>): IntegrationSyncLog {
  return {
    id: log.id,
    userId: log.userId,
    connectionId: log.connectionId,
    integrationId: log.integrationId,
    status: log.status as IntegrationSyncLog["status"],
    startedAt: log.startedAt,
    finishedAt: log.finishedAt ?? undefined,
    eventsCreated: log.eventsCreated,
    error: log.error ?? undefined
  };
}

function toEmailSignalRule(rule: Prisma.EmailSignalRuleGetPayload<object>): EmailSignalRule {
  return {
    id: rule.id,
    userId: rule.userId,
    connectionId: rule.connectionId,
    goalId: rule.goalId ?? undefined,
    adapterId: rule.adapterId,
    name: rule.name,
    query: rule.query ?? undefined,
    status: normalizeEmailRuleStatus(rule.status),
    fetchStrategy: normalizeEmailFetchStrategy(rule.fetchStrategy),
    lookbackDays: positiveIntOrDefault(rule.lookbackDays, 30),
    maxMessagesPerSync: positiveIntOrDefault(rule.maxMessagesPerSync, 25),
    maxEventsPerSync: positiveIntOrDefault(rule.maxEventsPerSync, 10),
    classifierMode: normalizeEmailClassifierMode(rule.classifierMode),
    minAutoLogConfidence: confidenceOrDefault(rule.minAutoLogConfidence, 0.9),
    minReviewConfidence: confidenceOrDefault(rule.minReviewConfidence, 0.65),
    reviewBeforeLogging: rule.reviewBeforeLogging ?? false,
    createdBy: rule.createdBy as EmailSignalRule["createdBy"],
    lastSyncedAt: rule.lastSyncedAt ?? undefined,
    lastError: rule.lastError ?? undefined,
    createdAt: rule.createdAt,
    updatedAt: rule.updatedAt
  };
}

function toEmailReviewItem(item: Prisma.EmailReviewItemGetPayload<object>): EmailReviewItem {
  return {
    id: item.id,
    userId: item.userId,
    connectionId: item.connectionId,
    ruleId: item.ruleId,
    adapterId: item.adapterId,
    provider: "gmail",
    providerMessageId: item.providerMessageId,
    externalId: item.externalId,
    subject: item.subject ?? undefined,
    from: item.from ?? undefined,
    snippet: item.snippet ?? undefined,
    evidence: item.evidence ?? undefined,
    proposedEventType: item.proposedEventType ?? undefined,
    confidence: item.confidence,
    reason: item.reason,
    extracted: toRecord(item.extracted),
    status: normalizeEmailReviewStatus(item.status),
    eventId: item.eventId ?? undefined,
    archiveReason: item.archiveReason ?? undefined,
    reviewedAt: item.reviewedAt ?? undefined,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  };
}

function normalizeEmailReviewStatus(status: string | null | undefined): EmailReviewItem["status"] {
  const normalized = normalizeStatus(status);

  if (normalized === "approved" || normalized === "rejected" || normalized === "archived") {
    return normalized;
  }

  return "pending";
}

function normalizeStatus(status: string | null | undefined): string {
  return (status ?? "").trim().toLowerCase();
}

function normalizeIntegrationStatus(status: string | null | undefined): IntegrationConnection["status"] {
  const normalized = normalizeStatus(status);
  return normalized === "paused" || normalized === "error" || normalized === "archived" ? normalized : "active";
}

function normalizeEmailRuleStatus(status: string | null | undefined): EmailSignalRule["status"] {
  const normalized = normalizeStatus(status);
  if (!normalized || normalized === "active") {
    return "active";
  }

  return normalized === "paused" || normalized === "error" ? normalized : "archived";
}

function normalizeEmailFetchStrategy(strategy: string | null | undefined): EmailSignalRule["fetchStrategy"] {
  const normalized = normalizeStatus(strategy);
  return normalized === "all_recent" || normalized === "sender_allowlist" || normalized === "label" ? normalized : "query";
}

function normalizeEmailClassifierMode(mode: string | null | undefined): EmailSignalRule["classifierMode"] {
  const normalized = normalizeStatus(mode);
  return normalized === "llm" || normalized === "hybrid" ? normalized : "rules";
}

function positiveIntOrDefault(value: number | null | undefined, defaultValue: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : defaultValue;
}

function confidenceOrDefault(value: number | null | undefined, defaultValue: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : defaultValue;
}

function toNotificationSettings(
  settings: Prisma.NotificationSettingsGetPayload<object>
): NotificationSettings {
  return {
    id: settings.id,
    userId: settings.userId,
    telegramUserId: settings.telegramUserId ?? undefined,
    dailyCheckinEnabled: settings.dailyCheckinEnabled,
    dailyCheckinTime: settings.dailyCheckinTime ?? undefined,
    dailyInsightEnabled: settings.dailyInsightEnabled,
    dailyInsightTime: settings.dailyInsightTime ?? undefined,
    weeklyInsightEnabled: settings.weeklyInsightEnabled,
    weeklyInsightDay: (settings.weeklyInsightDay as NotificationSettings["weeklyInsightDay"]) ?? undefined,
    weeklyInsightTime: settings.weeklyInsightTime ?? undefined,
    timezone: settings.timezone,
    createdAt: settings.createdAt,
    updatedAt: settings.updatedAt
  };
}

function isPrismaUniqueConstraintError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return false;
  }

  return (error as { code?: string }).code === "P2002";
}

function eventWhere(userId: string, options: EventQueryOptions = {}): Prisma.EventWhereInput {
  return {
    userId,
    ...(options.includeArchived ? {} : { status: "active" })
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

function toRecordArray(value: Prisma.JsonValue): Record<string, unknown>[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.filter(isRecordLike).map((item) => item as Record<string, unknown>);
}

function isRecordLike(value: Prisma.JsonValue): boolean {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function parseGoalMetrics(value: Prisma.JsonValue): Goal["targetMetrics"] {
  const records = toRecordArray(value);
  return records ? GoalMetricSchema.array().parse(records) : undefined;
}

function parseGoalCheckInQuestions(value: Prisma.JsonValue): Goal["checkInConfig"] {
  const records = toRecordArray(value);
  return records ? GoalCheckInQuestionSchema.array().parse(records) : undefined;
}

function toJsonObject(value: Record<string, unknown>): Prisma.InputJsonObject {
  return value as Prisma.InputJsonObject;
}

function toJsonArray(value: unknown[]): Prisma.InputJsonArray {
  return value as Prisma.InputJsonArray;
}

function toStringArray(value: Prisma.JsonValue): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.filter((item): item is string => typeof item === "string");
}
