import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import {
  defaultGoalPriority,
  findDuplicateActiveGoal,
  getGoalTemplate,
  GoalCheckInQuestionSchema,
  GoalMetricSchema,
  normalizeGoalPriority,
  scoreForGoalPriority
} from "@operator-agent/core";
import type {
  CreateMemoryInput,
  CreateEmailSignalRuleInput,
  CreateGoalInput,
  ExtractedEvent,
  GithubPublicConnectionInput,
  Goal,
  GoalStatus,
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
  project?: string;
  deadline?: string;
  actionRequired?: boolean;
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
  project?: string;
  deadline?: string;
  actionRequired?: boolean;
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
  | "action_archive"
  | "action_hygiene"
  | "action_target_clarification"
  | "next_week_plan"
  | "goal_progress_log"
  | "custom_email_rule"
  | "email_review_context"
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

export type DailyLoopStatus = "not_started" | "morning_sent" | "active_day" | "evening_sent" | "completed";

export interface DailyLoopState {
  id: string;
  userId: string;
  localDate: string;
  timezone: string;
  morningBriefSentAt?: Date;
  middayNudgeSentAt?: Date;
  eveningReviewSentAt?: Date;
  eveningReviewCompletedAt?: Date;
  status: DailyLoopStatus;
  createdAt: Date;
  updatedAt: Date;
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
  /** A custom, per-goal signal key the linked goal (goalId) already declares in its own
   * targetMetrics — set XOR with eventType, never both. */
  signalKey?: string;
  /** A real, registered EventTypeSchema member — set XOR with signalKey, never both. */
  eventType?: string;
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
  actionItemId?: string;
  archiveReason?: string;
  reviewedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface ActionItem {
  id: string;
  userId: string;
  source: "email_review" | "manual" | "system";
  sourceId?: string;
  sourceProvider?: string;
  sourceRuleId?: string;
  goalId?: string;
  goalSlug?: string;
  goalTitleSnapshot?: string;
  title: string;
  description?: string;
  status: "open" | "completed" | "snoozed" | "archived";
  priority: "low" | "medium" | "high";
  dueAt?: Date;
  project?: string;
  actionType?:
    | "work_action_required"
    | "work_deadline_detected"
    | "work_follow_up_requested"
    | "work_project_update_detected"
    | "manual"
    | "reminder"
    | "follow_up"
    | "deadline"
    | "generic";
  evidence?: string;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
  snoozedUntil?: Date;
  /** How many times this action has been snoozed (via snoozeActionItem), ever — never reset by
   * completing/archiving/rescheduling, only by a fresh action.create. Powers the repeated-
   * postponement coaching in the agent runtime (accept the first move silently, a mild challenge
   * on the second, stronger coaching on the third+) without needing a separate history table. */
  postponeCount: number;
}

export interface CreateActionItemInput {
  source: ActionItem["source"];
  sourceId?: string;
  sourceProvider?: string;
  sourceRuleId?: string;
  goalId?: string;
  goalSlug?: string;
  goalTitleSnapshot?: string;
  title: string;
  description?: string;
  priority?: ActionItem["priority"];
  dueAt?: Date;
  project?: string;
  actionType?: ActionItem["actionType"];
  evidence?: string;
}

export interface UpdateGoalPriorityInput {
  priority: Goal["priority"];
  importanceScore?: number | null;
  priorityReason?: string;
}

export interface GoalPriorityBackfillResult {
  updated: number;
  updatedGoals: Array<{
    goal: Goal;
    previousPriority: Goal["priority"];
    nextPriority: Goal["priority"];
  }>;
  skippedManual: Goal[];
}

export type ActionItemReminderType = "due" | "snoozed";

export interface ActionItemReminderCandidate {
  actionItem: ActionItem;
  reminderType: ActionItemReminderType;
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

  const priority = input.priority ?? defaultGoalPriority({
    title: input.title,
    category: input.category,
    templateId: input.templateId
  });
  const goal = await prisma.goal.create({
    data: {
      userId,
      title: input.title,
      category: input.category,
      priority,
      importanceScore: input.importanceScore ?? scoreForGoalPriority(priority),
      priorityReason: input.priorityReason ?? "default priority on create",
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

/**
 * Generic goal-lifecycle status transition (active/paused/archived) — the schema's own
 * GoalStatus enum already has all three states, so pausing/resuming/archiving a goal is a plain
 * status write, never a new field or a schema change. Added for Agent Runtime v3's
 * goal.archive_propose/goal.archive_apply (pause and archive both use this; archiveGoal above is
 * kept as-is for its existing legacy/REST callers rather than rewritten to call this).
 */
export async function setGoalStatus(userId: string, goalId: string, status: GoalStatus): Promise<Goal | undefined> {
  await ensureUser(userId);

  const existingGoal = await prisma.goal.findFirst({
    where: { id: goalId, userId }
  });

  if (!existingGoal) {
    return undefined;
  }

  const goal = await prisma.goal.update({
    where: { id: goalId },
    data: { status }
  });

  return toGoal(goal);
}

export async function updateGoalPriority(
  userId: string,
  goalId: string,
  input: UpdateGoalPriorityInput
): Promise<Goal | undefined> {
  await ensureUser(userId);

  const existingGoal = await prisma.goal.findFirst({
    where: {
      id: goalId,
      userId,
      status: "active"
    }
  });

  if (!existingGoal) {
    return undefined;
  }

  const goal = await prisma.goal.update({
    where: { id: goalId },
    data: {
      priority: input.priority,
      importanceScore: input.importanceScore ?? scoreForGoalPriority(input.priority),
      priorityReason: input.priorityReason
    }
  });

  return toGoal(goal);
}

export async function backfillGoalPriorities(userId: string, options: { force?: boolean } = {}): Promise<GoalPriorityBackfillResult> {
  await ensureUser(userId);

  const goals = await prisma.goal.findMany({
    where: {
      userId,
      status: "active"
    },
    orderBy: { createdAt: "asc" }
  });
  const updatedGoals: GoalPriorityBackfillResult["updatedGoals"] = [];
  const skippedManual: Goal[] = [];

  for (const goal of goals) {
    const currentPriority = normalizeGoalPriority(goal.priority);
    const inferredPriority = defaultGoalPriority({
      title: goal.title,
      category: goal.category,
      templateId: goal.templateId ?? undefined
    });
    const canUpdate = options.force || isSystemAssignedGoalPriority(goal.priorityReason) || goal.importanceScore === null;
    const alreadyCorrect = currentPriority === inferredPriority && goal.importanceScore === scoreForGoalPriority(inferredPriority);

    if (!canUpdate) {
      skippedManual.push(toGoal(goal));
      continue;
    }

    if (alreadyCorrect) {
      continue;
    }

    const updated = await prisma.goal.update({
      where: { id: goal.id },
      data: {
        priority: inferredPriority,
        importanceScore: scoreForGoalPriority(inferredPriority),
        priorityReason: options.force ? "force default priority backfill" : "default priority backfill"
      }
    });

    updatedGoals.push({
      goal: toGoal(updated),
      previousPriority: currentPriority,
      nextPriority: inferredPriority
    });
  }

  return {
    updated: updatedGoals.length,
    updatedGoals,
    skippedManual
  };
}

function isSystemAssignedGoalPriority(reason: string | null | undefined): boolean {
  if (!reason) {
    return true;
  }

  return /\b(default|backfill|migration)\b/i.test(reason);
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
  const project = normalizeSemanticText(input.project);
  const deadline = normalizeSemanticText(input.deadline);

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
      normalizeSemanticText(readString(data.role)) === role &&
      normalizeSemanticText(readString(data.project)) === project &&
      normalizeSemanticText(readString(data.deadline)) === deadline &&
      normalizeBoolean(data.actionRequired) === normalizeBoolean(input.actionRequired)
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
  const project = normalizeSemanticText(input.project);
  const deadline = normalizeSemanticText(input.deadline);

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
      normalizeSemanticText(readString(extracted.role)) === role &&
      normalizeSemanticText(readString(extracted.project)) === project &&
      normalizeSemanticText(readString(extracted.deadline)) === deadline &&
      normalizeBoolean(extracted.actionRequired) === normalizeBoolean(input.actionRequired)
    );
  });

  const duplicate =
    matches.find((item) => normalizeEmailReviewStatus(item.status) === "pending") ??
    matches.find((item) => normalizeEmailReviewStatus(item.status) === "rejected") ??
    matches.find((item) => normalizeEmailReviewStatus(item.status) === "approved");

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
  project?: string;
  deadline?: string;
  actionRequired?: boolean;
  eventId: string;
  since?: Date;
}): Promise<EmailReviewItem[]> {
  await ensureUser(input.userId);

  const subject = normalizeSemanticText(input.subject);
  const from = normalizeEmailAddress(input.from);
  const company = normalizeSemanticText(input.company);
  const role = normalizeSemanticText(input.role);
  const project = normalizeSemanticText(input.project);
  const deadline = normalizeSemanticText(input.deadline);

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
        normalizeSemanticText(readString(extracted.role)) === role &&
        normalizeSemanticText(readString(extracted.project)) === project &&
        normalizeSemanticText(readString(extracted.deadline)) === deadline &&
        normalizeBoolean(extracted.actionRequired) === normalizeBoolean(input.actionRequired)
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

function normalizeBoolean(value: unknown): string {
  return typeof value === "boolean" ? String(value) : "";
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
      signalKey: input.signalKey,
      eventType: input.eventType,
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

export async function reassignActiveEmailSignalRulesToConnection(
  userId: string,
  input: { fromConnectionIds: string[]; toConnectionId: string }
): Promise<number> {
  await ensureUser(userId);

  const fromConnectionIds = [...new Set(input.fromConnectionIds.filter((id) => id && id !== input.toConnectionId))];
  if (fromConnectionIds.length === 0) {
    return 0;
  }

  const targetConnection = await prisma.integrationConnection.findFirst({
    where: {
      id: input.toConnectionId,
      userId,
      integrationId: "gmail"
    }
  });

  if (!targetConnection) {
    return 0;
  }

  const result = await prisma.emailSignalRule.updateMany({
    where: {
      userId,
      status: "active",
      connectionId: { in: fromConnectionIds }
    },
    data: {
      connectionId: input.toConnectionId
    }
  });

  return result.count;
}

export async function updateEmailSignalRuleDefinition(
  userId: string,
  ruleId: string,
  input: { name?: string; query?: string; goalId?: string | null }
): Promise<EmailSignalRule | undefined> {
  await ensureUser(userId);

  const existingRule = await prisma.emailSignalRule.findFirst({
    where: {
      id: ruleId,
      userId
    }
  });

  if (!existingRule || normalizeEmailRuleStatus(existingRule.status) === "archived") {
    return undefined;
  }

  const rule = await prisma.emailSignalRule.update({
    where: { id: ruleId },
    data: {
      name: input.name,
      query: input.query,
      goalId: input.goalId
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

export async function getPendingEmailReviewCount(userId: string): Promise<number> {
  await ensureUser(userId);

  return prisma.emailReviewItem.count({
    where: {
      userId,
      status: "pending"
    }
  });
}

export async function createActionItemIfNotExists(
  userId: string,
  input: CreateActionItemInput
): Promise<{ created: boolean; actionItem: ActionItem }> {
  await ensureUser(userId);

  if (input.sourceId) {
    const existing = await prisma.actionItem.findFirst({
      where: {
        userId,
        source: input.source,
        sourceId: input.sourceId,
        status: {
          not: "archived"
        }
      }
    });

    if (existing) {
      return { created: false, actionItem: toActionItem(existing) };
    }
  }

  const semanticDuplicate = await prisma.actionItem.findFirst({
    where: {
      userId,
      source: input.source,
      sourceProvider: input.sourceProvider,
      sourceRuleId: input.sourceRuleId,
      title: input.title,
      actionType: input.actionType,
      project: input.project,
      status: {
        in: ["open", "snoozed"]
      }
    },
    orderBy: { updatedAt: "desc" }
  });

  if (semanticDuplicate) {
    return { created: false, actionItem: toActionItem(semanticDuplicate) };
  }

  const actionItem = await prisma.actionItem.create({
    data: {
      userId,
      source: input.source,
      sourceId: input.sourceId,
      sourceProvider: input.sourceProvider,
      sourceRuleId: input.sourceRuleId,
      goalId: input.goalId,
      goalSlug: input.goalSlug,
      goalTitleSnapshot: input.goalTitleSnapshot,
      title: input.title,
      description: input.description,
      priority: input.priority ?? "medium",
      dueAt: input.dueAt,
      project: input.project,
      actionType: input.actionType ?? "generic",
      evidence: input.evidence
    }
  });

  return { created: true, actionItem: toActionItem(actionItem) };
}

export async function createActionItem(userId: string, input: CreateActionItemInput): Promise<ActionItem> {
  await ensureUser(userId);

  const actionItem = await prisma.actionItem.create({
    data: {
      userId,
      source: input.source,
      sourceId: input.sourceId,
      sourceProvider: input.sourceProvider,
      sourceRuleId: input.sourceRuleId,
      goalId: input.goalId,
      goalSlug: input.goalSlug,
      goalTitleSnapshot: input.goalTitleSnapshot,
      title: input.title,
      description: input.description,
      priority: input.priority ?? "medium",
      dueAt: input.dueAt,
      project: input.project,
      actionType: input.actionType ?? "generic",
      evidence: input.evidence
    }
  });

  return toActionItem(actionItem);
}

export async function getActionItem(userId: string, actionItemId: string): Promise<ActionItem | undefined> {
  await ensureUser(userId);

  const actionItem = await prisma.actionItem.findFirst({
    where: {
      id: actionItemId,
      userId
    }
  });

  return actionItem ? toActionItem(actionItem) : undefined;
}

export async function getActionItems(
  userId: string,
  options: { status?: ActionItem["status"] | "all"; limit?: number } = {}
): Promise<ActionItem[]> {
  await ensureUser(userId);

  const actionItems = await prisma.actionItem.findMany({
    where: {
      userId,
      ...(options.status && options.status !== "all" ? { status: options.status } : {})
    },
    orderBy: [{ status: "asc" }, { dueAt: "asc" }, { updatedAt: "desc" }],
    take: options.limit ?? 10
  });

  return actionItems.map(toActionItem);
}

export async function getRecentActionItems(userId: string, limit = 50): Promise<ActionItem[]> {
  await ensureUser(userId);

  const actionItems = await prisma.actionItem.findMany({
    where: {
      userId
    },
    orderBy: { updatedAt: "desc" },
    take: limit
  });

  return actionItems.map(toActionItem);
}

export async function linkActionItemToGoal(
  userId: string,
  actionItemId: string,
  input: { goalId: string; goalSlug?: string; goalTitleSnapshot?: string }
): Promise<ActionItem | undefined> {
  await ensureUser(userId);
  const existing = await getActionItem(userId, actionItemId);

  if (!existing) {
    return undefined;
  }

  const actionItem = await prisma.actionItem.update({
    where: { id: actionItemId },
    data: {
      goalId: input.goalId,
      goalSlug: input.goalSlug,
      goalTitleSnapshot: input.goalTitleSnapshot
    }
  });

  return toActionItem(actionItem);
}

export async function completeActionItem(userId: string, actionItemId: string): Promise<ActionItem | undefined> {
  await ensureUser(userId);

  const existing = await getActionItem(userId, actionItemId);

  // fix/private-alpha-action-state-consistency: previously only guarded against "archived" —
  // completing an ALREADY-completed action silently "succeeded" again (a fresh completedAt
  // timestamp, same fraudulent-second-success shape archiveActionItem's own matching fix just
  // closed), producing a real "Nice — marked ... complete" reply for a mutation that already
  // happened. "completed" is just as terminal as "archived" here.
  if (!existing || existing.status === "archived" || existing.status === "completed") {
    return undefined;
  }

  const actionItem = await prisma.actionItem.update({
    where: { id: actionItemId },
    data: {
      status: "completed",
      completedAt: new Date(),
      snoozedUntil: null
    }
  });

  return toActionItem(actionItem);
}

export async function archiveActionItem(userId: string, actionItemId: string): Promise<ActionItem | undefined> {
  await ensureUser(userId);

  const existing = await getActionItem(userId, actionItemId);

  // fix/private-alpha-action-state-consistency: unlike completeActionItem/snoozeActionItem right
  // above and below, this used to have no "already archived" guard at all — a second archive of
  // the same action (e.g. a stale visible-entity reference resolving to an already-archived id)
  // silently "succeeded" again, producing a fraudulent second "Archived ..." reply for a mutation
  // that never actually happened. Matches the other two functions' own existing idempotency check.
  if (!existing || existing.status === "archived") {
    return undefined;
  }

  const actionItem = await prisma.actionItem.update({
    where: { id: actionItemId },
    data: {
      status: "archived",
      snoozedUntil: null
    }
  });

  return toActionItem(actionItem);
}

export async function snoozeActionItem(userId: string, actionItemId: string, snoozedUntil: Date): Promise<ActionItem | undefined> {
  await ensureUser(userId);

  const existing = await getActionItem(userId, actionItemId);

  if (!existing || existing.status === "archived") {
    return undefined;
  }

  const actionItem = await prisma.actionItem.update({
    where: { id: actionItemId },
    data: {
      status: "snoozed",
      snoozedUntil,
      completedAt: null,
      // Every real snooze counts, including a second/third move of the SAME already-snoozed
      // action — that repetition is exactly the pattern the deferral-coaching feature exists to
      // notice. Never reset here; only a brand-new action.create starts a fresh count.
      postponeCount: { increment: 1 }
    }
  });

  return toActionItem(actionItem);
}

export async function rescheduleActionItem(userId: string, actionItemId: string, dueAt: Date): Promise<ActionItem | undefined> {
  await ensureUser(userId);

  const existing = await getActionItem(userId, actionItemId);

  if (!existing || existing.status === "archived") {
    return undefined;
  }

  const actionItem = await prisma.actionItem.update({
    where: { id: actionItemId },
    data: {
      status: "open",
      dueAt,
      snoozedUntil: null,
      completedAt: null
    }
  });

  return toActionItem(actionItem);
}

export async function forceActionItemDue(userId: string, actionItemId: string, dueAt: Date): Promise<ActionItem | undefined> {
  await ensureUser(userId);

  const existing = await getActionItem(userId, actionItemId);

  if (!existing || existing.status === "archived") {
    return undefined;
  }

  const actionItem = await prisma.actionItem.update({
    where: { id: actionItemId },
    data: {
      status: "open",
      dueAt,
      snoozedUntil: null,
      completedAt: null
    }
  });

  return toActionItem(actionItem);
}

export async function forceActionItemSnoozedDue(userId: string, actionItemId: string, snoozedUntil: Date): Promise<ActionItem | undefined> {
  await ensureUser(userId);

  const existing = await getActionItem(userId, actionItemId);

  if (!existing || existing.status === "archived") {
    return undefined;
  }

  const actionItem = await prisma.actionItem.update({
    where: { id: actionItemId },
    data: {
      status: "snoozed",
      snoozedUntil,
      completedAt: null
    }
  });

  return toActionItem(actionItem);
}

export async function getActionItemsEligibleForReminder(options: {
  userId?: string;
  now?: Date;
  limit?: number;
  reminderWindowHours?: number;
} = {}): Promise<ActionItemReminderCandidate[]> {
  const now = options.now ?? new Date();
  const reminderWindowMs = (options.reminderWindowHours ?? 12) * 60 * 60 * 1000;
  const since = new Date(now.getTime() - reminderWindowMs);
  const actionItems = await prisma.actionItem.findMany({
    where: {
      ...(options.userId ? { userId: options.userId } : {}),
      OR: [
        {
          status: "open",
          dueAt: {
            lte: now
          }
        },
        {
          status: "snoozed",
          snoozedUntil: {
            lte: now
          }
        }
      ]
    },
    orderBy: [{ dueAt: "asc" }, { snoozedUntil: "asc" }, { updatedAt: "asc" }],
    take: options.limit ?? 20
  });
  const candidates: ActionItemReminderCandidate[] = [];

  for (const actionItem of actionItems) {
    const reminderType: ActionItemReminderType = actionItem.status === "snoozed" ? "snoozed" : "due";
    const recentLog = await prisma.actionItemReminderLog.findFirst({
      where: {
        actionItemId: actionItem.id,
        reminderType,
        sentAt: {
          gte: since
        }
      },
      orderBy: {
        sentAt: "desc"
      }
    });

    if (recentLog && !(reminderType === "snoozed" && actionItem.updatedAt > recentLog.sentAt)) {
      continue;
    }

    candidates.push({
      actionItem: toActionItem(actionItem),
      reminderType
    });
  }

  return candidates;
}

export async function createActionItemReminderLog(input: {
  userId: string;
  actionItemId: string;
  reminderType: ActionItemReminderType;
  sentAt?: Date;
}): Promise<void> {
  await prisma.actionItemReminderLog.create({
    data: {
      userId: input.userId,
      actionItemId: input.actionItemId,
      reminderType: input.reminderType,
      sentAt: input.sentAt
    }
  });
}

/**
 * The ActionItem behind the most recent real due/overdue/snoozed-reopen notification actually
 * sent to this user (sendDueActionReminders' own ActionItemReminderLog rows — the ground truth of
 * what the worker told them about, independent of whatever the chat session's own visibleEntities
 * happen to still be pointing at). Used as a deterministic fallback for a bare "complete it"/
 * "done" right after a notification, since the worker has no way to update the agent-runtime
 * session's visibleEntities itself. Never returns an item that's since been completed/archived —
 * a stale notification about a task the user already finished some other way must not resurface.
 */
export async function getMostRecentlyRemindedActionItem(userId: string, options: { since?: Date } = {}): Promise<ActionItem | undefined> {
  const log = await prisma.actionItemReminderLog.findFirst({
    where: {
      userId,
      ...(options.since ? { sentAt: { gte: options.since } } : {})
    },
    orderBy: { sentAt: "desc" }
  });

  if (!log) {
    return undefined;
  }

  const actionItem = await prisma.actionItem.findUnique({ where: { id: log.actionItemId } });

  if (!actionItem || actionItem.userId !== userId || actionItem.status === "archived" || actionItem.status === "completed") {
    return undefined;
  }

  return toActionItem(actionItem);
}

export async function reopenSnoozedActionItem(userId: string, actionItemId: string): Promise<ActionItem | undefined> {
  const existing = await getActionItem(userId, actionItemId);

  if (!existing || existing.status !== "snoozed") {
    return existing;
  }

  const actionItem = await prisma.actionItem.update({
    where: { id: actionItemId },
    data: {
      status: "open",
      snoozedUntil: null
    }
  });

  return toActionItem(actionItem);
}

export async function approveEmailReviewItem(
  userId: string,
  reviewId: string,
  eventId?: string,
  actionItemId?: string
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
      actionItemId,
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

/**
 * fix/private-alpha-gmail-classifier-precision-and-proactive-diagnostics: lightweight rejection-
 * feedback support for Task 6 — after a user bulk-rejects newsletter/spam review items ("reject
 * all, they are just spam or job newsletter no interviews"), a future sync should be able to
 * lower priority on further low-confidence items from the SAME sender for the SAME rule, without
 * ever globally blocking a sender/domain (a genuine recruiter reply from that domain must still
 * surface). Returns only the `from`/`proposedEventType` pairs needed for that same-sender check —
 * deliberately no new schema/migration, since the existing `from` column already carries what's
 * needed.
 */
export async function getRejectedEmailReviewSendersForRule(
  userId: string,
  ruleId: string,
  limit = 200
): Promise<Array<{ from: string | null; proposedEventType: string | null }>> {
  await ensureUser(userId);

  const items = await prisma.emailReviewItem.findMany({
    where: { userId, ruleId, status: "rejected" },
    orderBy: { updatedAt: "desc" },
    take: limit,
    select: { from: true, proposedEventType: true }
  });

  return items;
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

export async function getEventsBetween(
  userId: string,
  startDate: Date,
  endDate: Date,
  options: EventQueryOptions = {}
): Promise<StoredEvent[]> {
  await ensureUser(userId);

  const events = await prisma.event.findMany({
    where: {
      ...eventWhere(userId, options),
      timestamp: {
        gte: startDate,
        lt: endDate
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

export async function updateMemory(
  userId: string,
  memoryId: string,
  input: Partial<Pick<CreateMemoryInput, "summary" | "data" | "evidence" | "confidence">>
): Promise<MemoryEntry | undefined> {
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
    data: {
      ...(input.summary ? { summary: input.summary } : {}),
      ...(input.data ? { data: toJsonObject(input.data) } : {}),
      ...(input.evidence ? { evidence: toJsonObject(input.evidence) } : {}),
      ...(typeof input.confidence === "number" ? { confidence: input.confidence } : {})
    }
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

/**
 * fix/private-alpha-proactive-launch-config-cleanup: dailyLoopEnabled is a separate, older
 * umbrella flag the V3 proactive worker also requires alongside morningBriefEnabled/
 * eveningCheckinEnabled (see apps/worker/src/v3-proactive-delivery.ts) — a user who opted into
 * morning/evening BEFORE the tool that turns them on started also enabling dailyLoopEnabled (the
 * prior fix on fix/private-alpha-proactive-checkins-and-overdue-action-ux) is left stuck with
 * dailyLoopEnabled false forever, until they manually re-touch the setting. This self-heals that
 * drift wherever settings are read for status/eligibility purposes: ONLY ever turns
 * dailyLoopEnabled ON, and ONLY when morning or evening is ALREADY true — never touches
 * morning/evening themselves, and never turns dailyLoopEnabled off (the separate legacy daily-
 * loop feature may still depend on it independently of V3). A no-op (no DB write) when nothing
 * needs healing, so this is safe to call on every read without extra write traffic.
 */
export async function selfHealDailyLoopEnabled<
  T extends { userId: string; dailyLoopEnabled: boolean; morningBriefEnabled: boolean; eveningCheckinEnabled: boolean }
>(settings: T): Promise<T> {
  if (settings.dailyLoopEnabled || (!settings.morningBriefEnabled && !settings.eveningCheckinEnabled)) {
    return settings;
  }

  // Applies the real write (so it survives past this one read) but merges the known-true value
  // locally rather than round-tripping a second read — generic so both apps/api's full
  // NotificationSettings and apps/worker's narrower V3ProactiveNotificationSettingsLike get back
  // the exact same shape they passed in, just with dailyLoopEnabled corrected.
  await updateNotificationSettings(settings.userId, { dailyLoopEnabled: true });
  return { ...settings, dailyLoopEnabled: true };
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
        { weeklyInsightEnabled: true },
        { dailyLoopEnabled: true },
        // Without these two, a user who opted into ONLY a V3 moment (never touching the legacy
        // daily-loop/checkin/insight flags) would never even appear in this coarse prefetch —
        // apps/worker/src/index.ts's runTick() would have no row to run its own morningBriefEnabled/
        // eveningCheckinEnabled check against at all. Every individual feature branch downstream
        // still does its own fine-grained gate before acting; this only widens the prefetch.
        // fix/private-alpha-proactive-launch-config-cleanup: morningBriefEnabled was missing here
        // entirely — a user who opted into ONLY the morning brief (dailyLoopEnabled still false,
        // pre-dating the fix that now sets it automatically) was silently invisible to the
        // worker's own tick loop, on top of the separate dailyLoopEnabled self-heal gap.
        { morningBriefEnabled: true },
        { eveningCheckinEnabled: true }
      ]
    },
    orderBy: {
      updatedAt: "desc"
    }
  });

  return settings.map(toNotificationSettings);
}

export async function getOrCreateDailyLoopState(
  userId: string,
  input: { localDate: string; timezone: string }
): Promise<DailyLoopState> {
  await ensureUser(userId);

  const state = await prisma.dailyLoopState.upsert({
    where: {
      userId_localDate: {
        userId,
        localDate: input.localDate
      }
    },
    create: {
      userId,
      localDate: input.localDate,
      timezone: input.timezone
    },
    update: {
      timezone: input.timezone
    }
  });

  return toDailyLoopState(state);
}

export async function markDailyLoopMorningSent(
  userId: string,
  input: { localDate: string; timezone: string; sentAt?: Date }
): Promise<DailyLoopState> {
  await ensureUser(userId);
  const sentAt = input.sentAt ?? new Date();

  const state = await prisma.dailyLoopState.upsert({
    where: {
      userId_localDate: {
        userId,
        localDate: input.localDate
      }
    },
    create: {
      userId,
      localDate: input.localDate,
      timezone: input.timezone,
      morningBriefSentAt: sentAt,
      status: "morning_sent"
    },
    update: {
      timezone: input.timezone,
      morningBriefSentAt: sentAt,
      status: "morning_sent"
    }
  });

  return toDailyLoopState(state);
}

export async function markDailyLoopEveningSent(
  userId: string,
  input: { localDate: string; timezone: string; sentAt?: Date }
): Promise<DailyLoopState> {
  await ensureUser(userId);
  const sentAt = input.sentAt ?? new Date();

  const state = await prisma.dailyLoopState.upsert({
    where: {
      userId_localDate: {
        userId,
        localDate: input.localDate
      }
    },
    create: {
      userId,
      localDate: input.localDate,
      timezone: input.timezone,
      eveningReviewSentAt: sentAt,
      status: "evening_sent"
    },
    update: {
      timezone: input.timezone,
      eveningReviewSentAt: sentAt,
      status: "evening_sent"
    }
  });

  return toDailyLoopState(state);
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

/** Same lookup as hasNotificationLog, but returns the real sentAt when it exists — needed
 * whenever a caller has to report WHEN something actually sent, not just whether it did. */
export async function getNotificationLog(input: NotificationLogInput): Promise<{ sentAt: Date } | undefined> {
  const log = await prisma.notificationLog.findUnique({
    where: {
      userId_type_sentForDate: {
        userId: input.userId,
        type: input.type,
        sentForDate: input.sentForDate
      }
    },
    select: { sentAt: true }
  });

  return log ?? undefined;
}

/** The single most recent NotificationLog row for (userId, type), regardless of which day it was
 * sent for — unlike getNotificationLog (which only ever looks up ONE specific sentForDate),
 * this answers "when did this last actually go out at all," the question a truthful "last sent"
 * status line needs (fix/private-alpha-proactive-checkins-and-overdue-action-ux). Returns
 * undefined when nothing has ever sent for this user/type — a real "never," not a guess. */
export async function getMostRecentNotificationLog(userId: string, type: string): Promise<{ sentAt: Date; sentForDate: string } | undefined> {
  const log = await prisma.notificationLog.findFirst({
    where: { userId, type },
    orderBy: { sentAt: "desc" },
    select: { sentAt: true, sentForDate: true }
  });

  return log ?? undefined;
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

export async function replacePendingAction(
  userId: string,
  input: CreatePendingActionInput
): Promise<PendingAction> {
  await ensureUser(userId);
  await expireOldPendingActions(userId);

  await prisma.pendingAction.updateMany({
    where: {
      userId,
      status: "pending"
    },
    data: {
      status: "rejected"
    }
  });

  return createPendingAction(userId, input);
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

export interface AgentConversationSessionRow {
  id: string;
  userId: string;
  channel: string;
  topic: string | null;
  focusedEntities: Prisma.JsonValue;
  pendingOperation: Prisma.JsonValue;
  visibleEntities: Prisma.JsonValue;
  recentMutations: Prisma.JsonValue;
  messages: Prisma.JsonValue;
  expiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertAgentConversationSessionInput {
  topic: string | null;
  focusedEntities: unknown;
  pendingOperation: unknown;
  visibleEntities: unknown;
  recentMutations: unknown;
  messages: unknown;
  expiresAt: Date | null;
}

export async function getAgentConversationSession(
  userId: string,
  channel: string
): Promise<AgentConversationSessionRow | undefined> {
  const row = await prisma.agentConversationSession.findUnique({
    where: { userId_channel: { userId, channel } }
  });

  return row ? toAgentConversationSessionRow(row) : undefined;
}

export async function upsertAgentConversationSession(
  userId: string,
  channel: string,
  input: UpsertAgentConversationSessionInput
): Promise<AgentConversationSessionRow> {
  await ensureUser(userId);

  const data = {
    topic: input.topic,
    focusedEntities: toJsonInput(input.focusedEntities),
    pendingOperation: toJsonInput(input.pendingOperation),
    visibleEntities: toJsonInput(input.visibleEntities),
    recentMutations: toJsonInput(input.recentMutations),
    messages: toJsonInput(input.messages),
    expiresAt: input.expiresAt
  };

  const row = await prisma.agentConversationSession.upsert({
    where: { userId_channel: { userId, channel } },
    create: { userId, channel, ...data },
    update: data
  });

  return toAgentConversationSessionRow(row);
}

function toAgentConversationSessionRow(row: Prisma.AgentConversationSessionGetPayload<object>): AgentConversationSessionRow {
  return {
    id: row.id,
    userId: row.userId,
    channel: row.channel,
    topic: row.topic,
    focusedEntities: row.focusedEntities,
    pendingOperation: row.pendingOperation,
    visibleEntities: row.visibleEntities,
    recentMutations: row.recentMutations,
    messages: row.messages,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  };
}

function toJsonInput(value: unknown): Prisma.NullableJsonNullValueInput | Prisma.InputJsonValue {
  return value === null || value === undefined ? Prisma.JsonNull : (value as Prisma.InputJsonValue);
}

function toGoal(goal: Prisma.GoalGetPayload<object>): Goal {
  return {
    id: goal.id,
    userId: goal.userId,
    title: goal.title,
    category: goal.category,
    status: goal.status,
    priority: normalizeGoalPriority(goal.priority),
    importanceScore: goal.importanceScore ?? undefined,
    priorityReason: goal.priorityReason ?? undefined,
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
    signalKey: rule.signalKey ?? undefined,
    eventType: rule.eventType ?? undefined,
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
    actionItemId: item.actionItemId ?? undefined,
    archiveReason: item.archiveReason ?? undefined,
    reviewedAt: item.reviewedAt ?? undefined,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  };
}

function toActionItem(item: Prisma.ActionItemGetPayload<object>): ActionItem {
  return {
    id: item.id,
    userId: item.userId,
    source: normalizeActionItemSource(item.source),
    sourceId: item.sourceId ?? undefined,
    sourceProvider: item.sourceProvider ?? undefined,
    sourceRuleId: item.sourceRuleId ?? undefined,
    goalId: item.goalId ?? undefined,
    goalSlug: item.goalSlug ?? undefined,
    goalTitleSnapshot: item.goalTitleSnapshot ?? undefined,
    title: item.title,
    description: item.description ?? undefined,
    status: normalizeActionItemStatus(item.status),
    priority: normalizeActionItemPriority(item.priority),
    dueAt: item.dueAt ?? undefined,
    project: item.project ?? undefined,
    actionType: normalizeActionItemType(item.actionType),
    evidence: item.evidence ?? undefined,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    completedAt: item.completedAt ?? undefined,
    snoozedUntil: item.snoozedUntil ?? undefined,
    postponeCount: item.postponeCount
  };
}

function normalizeActionItemSource(source: string | null | undefined): ActionItem["source"] {
  const normalized = normalizeStatus(source);

  if (normalized === "email_review" || normalized === "manual" || normalized === "system") {
    return normalized;
  }

  return "system";
}

function normalizeActionItemStatus(status: string | null | undefined): ActionItem["status"] {
  const normalized = normalizeStatus(status);

  if (normalized === "completed" || normalized === "snoozed" || normalized === "archived") {
    return normalized;
  }

  return "open";
}

function normalizeActionItemPriority(priority: string | null | undefined): ActionItem["priority"] {
  const normalized = normalizeStatus(priority);

  if (normalized === "low" || normalized === "high") {
    return normalized;
  }

  return "medium";
}

function normalizeActionItemType(actionType: string | null | undefined): ActionItem["actionType"] | undefined {
  const normalized = normalizeStatus(actionType);

  if (
    normalized === "work_action_required" ||
    normalized === "work_deadline_detected" ||
    normalized === "work_follow_up_requested" ||
    normalized === "work_project_update_detected" ||
    normalized === "manual" ||
    normalized === "reminder" ||
    normalized === "follow_up" ||
    normalized === "deadline" ||
    normalized === "generic"
  ) {
    return normalized;
  }

  return undefined;
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
    dailyLoopEnabled: settings.dailyLoopEnabled,
    morningBriefEnabled: settings.morningBriefEnabled,
    eveningCheckinEnabled: settings.eveningCheckinEnabled,
    gmailNudgeEnabled: settings.gmailNudgeEnabled,
    timezone: settings.timezone,
    defaultActionTimeMinutes: settings.defaultActionTimeMinutes ?? 540,
    morningTimeMinutes: settings.morningTimeMinutes ?? 540,
    afternoonTimeMinutes: settings.afternoonTimeMinutes ?? 900,
    eveningTimeMinutes: settings.eveningTimeMinutes ?? 1140,
    tonightTimeMinutes: settings.tonightTimeMinutes ?? 1200,
    createdAt: settings.createdAt,
    updatedAt: settings.updatedAt
  };
}

function toDailyLoopState(state: Prisma.DailyLoopStateGetPayload<object>): DailyLoopState {
  return {
    id: state.id,
    userId: state.userId,
    localDate: state.localDate,
    timezone: state.timezone,
    morningBriefSentAt: state.morningBriefSentAt ?? undefined,
    middayNudgeSentAt: state.middayNudgeSentAt ?? undefined,
    eveningReviewSentAt: state.eveningReviewSentAt ?? undefined,
    eveningReviewCompletedAt: state.eveningReviewCompletedAt ?? undefined,
    status: normalizeDailyLoopStatus(state.status),
    createdAt: state.createdAt,
    updatedAt: state.updatedAt
  };
}

function normalizeDailyLoopStatus(status: string): DailyLoopStatus {
  return status === "morning_sent" ||
    status === "active_day" ||
    status === "evening_sent" ||
    status === "completed"
    ? status
    : "not_started";
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
