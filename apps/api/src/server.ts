import Fastify from "fastify";
import { assertWorkspacePackagesAreFresh } from "./utils/build-freshness.js";

// Runs once, the moment this module is first loaded — by the real production entrypoint
// (apps/api/src/index.ts) and by every test file's buildServer() import alike. See build-
// freshness.ts's own doc comment for the real reported bug this closes: a source fix to
// packages/core/db/llm silently not taking effect at runtime, with typecheck staying green the
// whole time. Deliberately placed here (not inside buildServer() itself) so it fires exactly once
// per process, at the earliest possible point, rather than on every server instance a test spins up.
assertWorkspacePackagesAreFresh(import.meta.url);
import {
  buildDailyReview,
  buildCustomGoalConfig,
  buildConversationControlDebug,
  classifyJobSearchEmail,
  classifyWorkActionEmail,
  CreateGoalFromTemplateInputSchema,
  CreateGoalInputSchema,
  GoalPrioritySchema,
  CustomGoalConfigInputSchema,
  CustomGoalProgressInputSchema,
  DailyCheckInInputSchema,
  DailyCheckInTextInputSchema,
  EventTypeSchema,
  eventRegistry,
  HIGH_SIGNAL_JOB_SEARCH_EVENT_TYPES,
  parseActionDueDate,
  normalizeManualActionTitleKey,
  extractEvents,
  findGoalDuplicateWarnings,
  getLocalTodayRange,
  isRiskControlGoal,
  getGoalTemplate,
  detectConversationControlIntent,
  analyzeMultiIntentMessage,
  evaluateGoalGuardrails,
  goalTemplates,
  CreateEmailSignalRuleInputSchema,
  UpdateEmailSignalRuleInputSchema,
  GithubPublicConnectionInputSchema,
  emailAdapterRegistry,
  getEmailAdapterDefinition,
  integrationRegistry,
  processMessage,
  parsedDailyCheckInToAnswers,
  parseDailyCheckinText,
  parseConversationControlTime,
  resolveActionReference,
  resolveGoalReference,
  decryptSecretJson,
  encryptSecretJson,
  getSecretEncryptionKeyFromEnv,
  isEncryptedSecretJsonEnvelope,
  SecretEncryptionError,
  evaluateGmailBackgroundSyncEligibility,
  writeGmailBackgroundSyncAttempt,
  UpdateIntegrationConnectionInputSchema,
  UpdateUserOperatingProfileInputSchema,
  isSecurityOrAuthEmail,
  cleanEmailBodyForDisplay,
  CLASSIFIER_BODY_LENGTH,
  type GithubPublicConnectionInput,
  type GoalSummary,
  type Goal,
  type ConversationIntentPlan,
  type MemoryEntry,
  type StoredEvent
} from "@operator-agent/core";
import {
  classifyGmailMessageAgainstRules,
  classifyEmailWithLLM,
  JobSearchEmailAllowedEventTypes,
  WorkActionEmailAllowedEventTypes,
  type GmailRuleMatchClassification,
  type GmailRuleMatchRule
} from "@operator-agent/llm";
import {
  archiveEvent,
  archiveEventGroup,
  archiveGmailRuleEvents,
  archiveGoal,
  backfillGoalPriorities,
  archiveIntegrationConnection,
  archiveMemory,
  correctEvent,
  createEvent,
  createEvents,
  createEventsFromExtracted,
  createGoal,
  createGmailConnection,
  createEmailSignalRule,
  createNotificationLog,
  createMemory,
  createPendingAction,
  replacePendingAction,
  getActiveGoals,
  getActiveMemories,
  getEventById,
  getEvents,
  getEventsBetween,
  getEventsSince,
  getGoals,
  getLatestPendingAction,
  getOrCreateDailyLoopState,
  getOrCreateNotificationSettings,
  getOrCreateUserOperatingProfile,
  getPendingEmailReviewCount,
  getRecentEvents,
  getRecentActionItems,
  getRelevantMemories,
  findExternalEvent,
  findGmailSemanticDuplicateEvent,
  findGmailDuplicateReviewItemByProviderMessageId,
  findGmailSemanticDuplicateReviewItem,
  findCompanyRoleDayDuplicateReviewItem,
  findCompanyRoleDayDuplicateEvent,
  hasRecentNotificationLog,
  createExternalEventIfNotExists,
  createGithubPublicConnection,
  createIntegrationSyncLog,
  getActiveEmailSignalRulesForConnection,
  getEmailSignalRules,
  getEmailReviewItems,
  getActionItem,
  getActionItems,
  getActionItemsEligibleForReminder,
  linkActionItemToGoal,
  updateGoalPriority,
  getIntegrationConnection,
  getIntegrationConnections,
  approvePendingGmailReviewItemsForSemanticEvent,
  rejectEmailReviewItem,
  getRejectedEmailReviewSendersForRule,
  reassignActiveEmailSignalRulesToConnection,
  completeActionItem,
  archiveActionItem,
  rescheduleActionItem,
  createActionItemReminderLog,
  reopenSnoozedActionItem,
  forceActionItemDue,
  forceActionItemSnoozedDue,
  markDailyLoopEveningSent,
  markDailyLoopMorningSent,
  snoozeActionItem,
  undoLastEvents,
  archiveEmailSignalRule,
  archivePendingEmailReviewItemsForRule,
  upsertEmailReviewItem,
  type IntegrationConnection,
  type EmailSignalRule,
  type EmailReviewItem,
  type ActionItem,
  type ActionItemReminderType,
  updateIntegrationConnection,
  updateIntegrationConnectionConfig,
  updateIntegrationConnectionSyncState,
  updateEmailSignalRule,
  updateEmailSignalRuleSyncState,
  updateMemory,
  updateUserOperatingProfile
} from "@operator-agent/db";
import { buildGmailAutonomyState } from "./conversation/gmail-autonomy.js";
import { composeFinalAgentResponse, withMemoryContextReply } from "./conversation/final-response.js";
import {
  buildOperatorAttentionState,
  buildEndDayMessage,
  buildStartDayMessage,
  buildTomorrowPrepMessage,
  dailyLoopStateInput,
  formatConversationTodayReply,
  generateDailyOperatorBrief,
  shouldUseDailyCoachLLM
} from "./operator/attention.js";
import { buildApiConfigStatus } from "./operator/config-status.js";
import { buildOnboardingState, composeOnboardingReply } from "./legacy/daily-conversation.js";
import { registerMessageRoutes } from "./routes/messages.js";
import { createMessagesProcessHandler } from "./legacy/messages-process.js";
import { registerAgentRoutes, defaultAgentRouteHandlers } from "./routes/agent.js";
import { configureAgentRuntimeServices } from "./agent-runtime/services.js";
import { registerMemoryRoutes } from "./routes/memory.js";
import { registerNotificationSettingsRoutes } from "./routes/notification-settings.js";
import { registerCheckinsIngestRoutes } from "./routes/checkins-ingest.js";
import { registerInsightRoutes } from "./routes/insights.js";
import { registerPendingActionRoutes } from "./routes/pending-actions.js";
import { isRecord, stringFromRecord } from "./utils/records.js";
import { goalPriorityRank, sortGoalsForDisplay } from "./utils/goal-priority.js";
import { inferActionGoalLink } from "./utils/action-goal-link.js";
import {
  containsUnsafeReflectionLanguage,
  normalizeForComparison,
  pendingEmailReviewLine,
  sanitizeEmailText,
  truncatePlainText
} from "./utils/text.js";
import { isGuardrailEvent } from "./utils/events.js";
import { getActiveOperatorReflections, isOperatorReflectionMemory } from "./utils/memory.js";
import { hasPendingMemoryCreate, hasSimilarActiveMemory } from "./utils/pending-memory.js";
import {
  comparePendingActionCandidates,
  formatPendingActionCandidate,
  toPendingActionCandidate,
  type PendingActionCandidate
} from "./actions/pending-candidate.js";
import {
  formatActionHygieneDebug,
  formatActionHygieneReport,
  resolveActionHygieneReply,
  storeActionHygieneSession
} from "./legacy/action-hygiene-conversation.js";
import { analyzeActionHygiene } from "./actions/hygiene-session.js";
import {
  buildNextWeekPlanContext,
  formatNextWeekPlanContextDebug,
  formatNextWeekPlanMessage,
  generateNextWeekPlanSuggestions,
  replacePendingPlan,
  resolveNextWeekPlanReply,
  summarizeNextWeekPlanContext
} from "./legacy/planning-conversation.js";
import {
  appendWeeklyPlanningNextStep,
  buildWeeklyReviewContext,
  formatWeeklyReview,
  formatWeeklyReviewContextDebug,
  generateAndSaveWeeklyReview,
  getLatestWeeklyReview,
  summarizeWeeklyReviewContext
} from "./legacy/weekly-review-conversation.js";
import {
  approveEmailReviewForUser,
  buildEmailReviewInboxResponse,
  sanitizeEmailReviewItem
} from "./email-reviews/email-review-service.js";
import {
  extractEmailReviewReference,
  isPendingEmailReviewContext,
  looksLikeEmailReviewContextAction,
  looksLikeEmailReviewInboxRequest,
  resolveEmailReviewContextReply
} from "./legacy/email-review-conversation.js";
import { archiveStaleJobSearchEmailRules, isBuiltInEmailAdapter } from "./gmail/gmail-rule-service.js";
import {
  daysBetweenLocalDates,
  formatDateInTimezone,
  formatLocalDateTime,
  parseOptionalNow,
  pendingDecisionExpiry,
  tomorrow
} from "./utils/datetime.js";
import {
  looksLikeEmailRuleOrGmailConversationText,
  noActiveGmailRulesMessage,
  reactivateOrReuseBuiltInEmailRule
} from "./legacy/gmail-conversation.js";
import { buildGmailOAuthUrl, decodeGmailOAuthState, gmailOAuthConfig, gmailOAuthLocalhostCallbackWarning, gmailOAuthMissingConfigMessage } from "./gmail/oauth.js";
import { createGoalProgressFromCompletedAction, createCustomGoalProgressEvent } from "./actions/goal-progress.js";
import { formatActionCreatedReply, maybeCreateManualActionFromText } from "./actions/manual-action.js";
import {
  applyActionHygieneBatchOperations,
  type ActionHygieneBatchOperation,
  type HygieneOperation
} from "./actions/hygiene.js";
import { arrayOfStrings, uniqueStrings } from "./utils/arrays.js";
import { getUserTimezone } from "./utils/user-timezone.js";
import type {
  ActionHygieneAction,
  ActionHygieneOption,
  ActionHygieneReport,
  ActionReminderDispatch,
  ConversationControlResponse,
  EmailReviewCandidateDebug,
  EmailRuleDiagnostics,
  EmailRuleSyncSummary,
  RefetchGmailReviewContentResult,
  GmailLastSyncDiagnostics,
  GithubCommit,
  GmailErrorStage,
  GmailMessage,
  GmailMessagePart,
  GmailSyncDecisionDebug,
  GmailStoredToken,
  GmailTokenResponse,
  NextWeekPlanSuggestion,
  OperatorReflectionCandidate,
  OperatorReflectionContext,
  OperatorReflectionType,
  WeeklyEmailAttentionSummary,
  WeeklyReviewContext,
  WeeklyReviewDraft,
  WeeklyReviewMemory
} from "./server-types.js";

export function buildServer() {
  const server = Fastify({
    logger: true
  });

  configureAgentRuntimeServices({
    syncGmailForUser: syncGmailForConversation,
    gmailSyncDebugForUser: gmailSyncDebugForConversation,
    refetchGmailReviewContentForUser: refetchGmailReviewContentForConversation
  });

  server.get("/health", async () => ({
    ok: true,
    service: "operator-agent-api"
  }));

  // fix/private-alpha-launch-config-sanity (task 7): a minimal, safe, read-only config status —
  // never a secret value, only presence booleans and already-public config (shares
  // buildApiConfigStatus with apps/api/src/index.ts's own startup log, so they can never
  // disagree). Deliberately not an admin panel: one flat JSON object, no auth of its own beyond
  // whatever normally fronts this API, matching /health's own unauthenticated-by-default shape.
  server.get("/diagnostics/config-status", async () => buildApiConfigStatus());

  server.get("/events/types", async () => ({
    eventTypes: eventRegistry
  }));

  server.get("/integrations", async () => ({
    integrations: integrationRegistry
  }));

  server.get("/email-adapters", async () => ({
    emailAdapters: emailAdapterRegistry
  }));

  server.get("/goal-templates", async () => ({
    goalTemplates
  }));

  server.get<{ Params: { templateId: string } }>("/goal-templates/:templateId", async (request, reply) => {
    const template = getGoalTemplate(request.params.templateId);

    if (!template) {
      return reply.status(404).send({
        error: "Goal template not found"
      });
    }

    return { goalTemplate: template };
  });

  registerAgentRoutes(server, defaultAgentRouteHandlers());
  registerMemoryRoutes(server);
  registerNotificationSettingsRoutes(server);
  registerCheckinsIngestRoutes(server);
  registerInsightRoutes(server);
  registerPendingActionRoutes(server);

  registerMessageRoutes(server, {
    process: createMessagesProcessHandler({ syncGmailForConversation, syncIntegrationsForConversation })
  });

  server.get<{ Params: { userId: string }; Querystring: { includeArchived?: string } }>(
    "/users/:userId/events",
    async (request) => ({
      events: await getEvents(request.params.userId, {
        includeArchived: request.query.includeArchived === "true"
      })
    })
  );

  server.get<{ Params: { userId: string }; Querystring: { includeArchived?: string } }>(
    "/users/:userId/events/recent",
    async (request) => ({
      events: await getRecentEvents(request.params.userId, 10, {
        includeArchived: request.query.includeArchived === "true"
      })
    })
  );

  server.patch<{ Params: { userId: string; eventId: string } }>(
    "/users/:userId/events/:eventId/archive",
    async (request, reply) => {
      const event = await archiveEvent(
        request.params.userId,
        request.params.eventId,
        readReason(request.body, "archived by user")
      );

      if (!event) {
        return reply.status(404).send({
          error: "Active event not found"
        });
      }

      return { event };
    }
  );

  server.patch<{ Params: { userId: string; eventGroupId: string } }>(
    "/users/:userId/events/groups/:eventGroupId/archive",
    async (request) => {
      const events = await archiveEventGroup(
        request.params.userId,
        request.params.eventGroupId,
        readReason(request.body, "archived event group")
      );

      return {
        count: events.length,
        events
      };
    }
  );

  server.post<{ Params: { userId: string; eventId: string } }>(
    "/users/:userId/events/:eventId/correct",
    async (request, reply) => {
      const input = parseCorrectEventBody(request.body);

      if (!input) {
        return reply.status(400).send({
          error: "Invalid request body"
        });
      }

      const event = await getEventById(request.params.userId, request.params.eventId, {
        includeArchived: true
      });

      if (!event) {
        return reply.status(404).send({
          error: "Event not found"
        });
      }

      if (event.status !== "active") {
        return reply.status(404).send({
          error: "Active event not found"
        });
      }

      const validationError = validateCorrectEventInput(event.type, input.data, Boolean(input.type));

      if (validationError) {
        return reply.status(400).send({
          error: validationError
        });
      }

      const result = await correctEvent(request.params.userId, request.params.eventId, input);

      if (!result) {
        return reply.status(404).send({
          error: "Active event not found"
        });
      }

      return result;
    }
  );

  server.post<{ Params: { userId: string } }>("/users/:userId/events/undo-last", async (request) => {
    const input = parseUndoLastBody(request.body);
    const events = await undoLastEvents(request.params.userId, input);

    return {
      count: events.length,
      events
    };
  });

  server.get<{ Params: { userId: string } }>("/users/:userId/goals", async (request) => ({
    ...formatGoalsResponse(await getGoals(request.params.userId))
  }));

  server.get<{ Params: { userId: string } }>("/users/:userId/goals/priorities", async (request) => {
    const goals = (await getGoals(request.params.userId)).filter((goal) => goal.status === "active");

    return {
      goals: goals.map((goal, index) => ({
        number: index + 1,
        id: goal.id,
        title: goal.title,
        category: goal.category,
        templateId: goal.templateId,
        priority: goal.priority,
        importanceScore: goal.importanceScore,
        priorityReason: goal.priorityReason
      }))
    };
  });

  server.patch<{ Params: { userId: string }; Body: { goal?: string; priority?: string; priorityReason?: string } }>(
    "/users/:userId/goals/priority",
    async (request, reply) => {
      const body = isRecord(request.body) ? request.body : {};
      const goalSelector = typeof body.goal === "string" ? body.goal.trim() : "";
      const parsedPriority = GoalPrioritySchema.safeParse(body.priority);

      if (!goalSelector || !parsedPriority.success) {
        return reply.status(400).send({ error: "Provide goal and priority: low, medium, high, or critical." });
      }

      const goals = (await getGoals(request.params.userId)).filter((goal) => goal.status === "active");
      const goal = findGoalBySelector(goals, goalSelector);

      if (!goal) {
        return reply.status(404).send({ error: "Active goal not found." });
      }

      const updated = await updateGoalPriority(request.params.userId, goal.id, {
        priority: parsedPriority.data,
        priorityReason: typeof body.priorityReason === "string" ? body.priorityReason : "manual priority update"
      });

      if (!updated) {
        return reply.status(404).send({ error: "Active goal not found." });
      }

      return {
        goal: updated,
        message: `Goal priority updated: ${updated.title} -> ${updated.priority}`
      };
    }
  );

  server.post<{ Params: { userId: string }; Body: { force?: boolean } }>("/users/:userId/goals/priorities/backfill", async (request) => {
    const body = isRecord(request.body) ? request.body : {};
    const result = await backfillGoalPriorities(request.params.userId, { force: body.force === true });

    return {
      ...result,
      message: formatGoalPriorityBackfillMessage(result)
    };
  });

  server.get<{ Params: { userId: string } }>("/users/:userId/profile", async (request) => ({
    profile: await getOrCreateUserOperatingProfile(request.params.userId)
  }));

  server.get<{ Params: { userId: string }; Querystring: { now?: string } }>(
    "/users/:userId/onboarding/state",
    async (request) => {
      const timezone = await getUserTimezone(request.params.userId);
      const state = await buildOnboardingState(
        request.params.userId,
        parseOptionalNow(request.query.now) ?? new Date(),
        timezone
      );

      return { state };
    }
  );

  server.get<{ Params: { userId: string }; Querystring: { now?: string } }>(
    "/users/:userId/onboarding/start",
    async (request) => {
      const timezone = await getUserTimezone(request.params.userId);
      const state = await buildOnboardingState(
        request.params.userId,
        parseOptionalNow(request.query.now) ?? new Date(),
        timezone
      );

      return {
        state,
        message: composeOnboardingReply(state, "first_run_intro")
      };
    }
  );

  server.get<{ Params: { userId: string }; Querystring: { now?: string } }>(
    "/users/:userId/onboarding/setup",
    async (request) => {
      const timezone = await getUserTimezone(request.params.userId);
      const state = await buildOnboardingState(
        request.params.userId,
        parseOptionalNow(request.query.now) ?? new Date(),
        timezone
      );

      return {
        state,
        message: composeOnboardingReply(state, "setup_overview")
      };
    }
  );

  server.post<{ Params: { userId: string }; Querystring: { now?: string } }>("/users/:userId/reflections/generate", async (request) => {
    const timezone = await getUserTimezone(request.params.userId);
    const now = parseOptionalNow(request.query.now) ?? new Date();
    const context = await buildOperatorReflectionContext(request.params.userId, { now, timezone });
    const result = await generateAndSaveOperatorReflections(request.params.userId, context);

    return {
      ...result,
      message: formatOperatorReflectionGeneration(result.reflections)
    };
  });

  server.get<{ Params: { userId: string } }>("/users/:userId/reflections", async (request) => {
    const reflections = await getActiveOperatorReflections(request.params.userId);

    return {
      reflections,
      message: formatOperatorReflections(reflections)
    };
  });

  server.patch<{ Params: { userId: string; reflectionId: string } }>(
    "/users/:userId/reflections/:reflectionId/archive",
    async (request, reply) => {
      const reflection = await archiveOperatorReflection(request.params.userId, request.params.reflectionId);

      if (!reflection) {
        return reply.status(404).send({ error: "Reflection not found" });
      }

      return {
        reflection,
        message: "Archived reflection."
      };
    }
  );

  server.get<{ Params: { userId: string }; Querystring: { now?: string } }>("/users/:userId/reflections/context", async (request) => {
    const timezone = await getUserTimezone(request.params.userId);
    const now = parseOptionalNow(request.query.now) ?? new Date();
    const context = await buildOperatorReflectionContext(request.params.userId, { now, timezone });

    return {
      context: summarizeOperatorReflectionContext(context),
      message: formatOperatorReflectionContextDebug(context)
    };
  });

  server.post<{ Params: { userId: string }; Body: { force?: boolean; weekStart?: string; now?: string } }>("/users/:userId/weekly-review", async (request, reply) => {
    const body = isRecord(request.body) ? request.body : {};
    const timezone = await getUserTimezone(request.params.userId);
    const now = parseOptionalNow(typeof body.now === "string" ? body.now : undefined) ?? new Date();
    const weekStart = typeof body.weekStart === "string" ? body.weekStart : undefined;

    if (weekStart && !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
      return reply.status(400).send({ error: "Invalid weekStart. Use YYYY-MM-DD." });
    }

    const context = await buildWeeklyReviewContext(request.params.userId, weekStart, timezone, now);
    const review = await generateAndSaveWeeklyReview(request.params.userId, context, { force: body.force === true });

    return {
      review,
      message: appendWeeklyPlanningNextStep(formatWeeklyReview(review))
    };
  });

  server.get<{ Params: { userId: string } }>("/users/:userId/weekly-review/last", async (request, reply) => {
    const review = await getLatestWeeklyReview(request.params.userId);

    if (!review) {
      return reply.status(404).send({ error: "No weekly review found." });
    }

    return {
      review,
      message: formatWeeklyReview(review)
    };
  });

  server.get<{ Params: { userId: string }; Querystring: { weekStart?: string; now?: string } }>("/users/:userId/weekly-review/context", async (request, reply) => {
    const timezone = await getUserTimezone(request.params.userId);
    const now = parseOptionalNow(request.query.now) ?? new Date();

    if (request.query.weekStart && !/^\d{4}-\d{2}-\d{2}$/.test(request.query.weekStart)) {
      return reply.status(400).send({ error: "Invalid weekStart. Use YYYY-MM-DD." });
    }

    const context = await buildWeeklyReviewContext(request.params.userId, request.query.weekStart, timezone, now);

    return {
      context: summarizeWeeklyReviewContext(context),
      message: formatWeeklyReviewContextDebug(context)
    };
  });

  server.get<{ Params: { userId: string }; Querystring: { now?: string } }>(
    "/users/:userId/next-week-plan/context",
    async (request) => {
      const timezone = await getUserTimezone(request.params.userId);
      const now = parseOptionalNow(request.query.now) ?? new Date();
      const context = await buildNextWeekPlanContext(request.params.userId, now, timezone);

      return {
        context: summarizeNextWeekPlanContext(context),
        message: formatNextWeekPlanContextDebug(context)
      };
    }
  );

  server.post<{ Params: { userId: string }; Body: { now?: string } }>(
    "/users/:userId/next-week-plan",
    async (request) => {
      const body = isRecord(request.body) ? request.body : {};
      const timezone = await getUserTimezone(request.params.userId);
      const now = typeof body.now === "string" ? parseOptionalNow(body.now) ?? new Date() : new Date();
      const context = await buildNextWeekPlanContext(request.params.userId, now, timezone);
      const suggestions = await generateNextWeekPlanSuggestions(context);

      await replacePendingPlan(request.params.userId, context, suggestions, "/plan_next_week");

      return {
        context: summarizeNextWeekPlanContext(context),
        suggestions,
        message: formatNextWeekPlanMessage(context, suggestions)
      };
    }
  );

  server.post<{ Params: { userId: string }; Body: { message?: string; now?: string } }>(
    "/users/:userId/next-week-plan/reply",
    async (request, reply) => {
      const body = isRecord(request.body) ? request.body : {};
      const message = typeof body.message === "string" ? body.message : "";
      const pending = await getLatestPendingAction(request.params.userId);

      if (!pending || pending.type !== "next_week_plan") {
        return reply.status(400).send({
          error: "No pending next-week plan. Run /plan_next_week first."
        });
      }

      const result = await resolveNextWeekPlanReply(request.params.userId, pending, message);

      if (!result) {
        return reply.status(400).send({
          error: "Reply with create 1, create 1 and 2, create all, edit 2 to Friday morning, show plan, or skip."
        });
      }

      return {
        message: result
      };
    }
  );

  server.patch<{ Params: { userId: string } }>("/users/:userId/profile", async (request, reply) => {
    const parsed = UpdateUserOperatingProfileInputSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid request body",
        issues: parsed.error.issues
      });
    }

    return {
      profile: await updateUserOperatingProfile(request.params.userId, parsed.data)
    };
  });

  server.get<{ Params: { userId: string }; Querystring: { now?: string } }>("/users/:userId/review/daily", async (request) => {
    const now = parseOptionalNow(request.query.now) ?? new Date();
    const todayRange = getLocalTodayRange(now, await getUserTimezone(request.params.userId));

    return {
      review: buildDailyReview({
        userId: request.params.userId,
        activeGoals: await getActiveGoals(request.params.userId),
        todayEvents: await getEventsBetween(request.params.userId, todayRange.start, todayRange.end),
        activeMemories: await getRelevantMemories(request.params.userId, {
          types: ["risk_pattern"],
          limit: 3
        })
      })
    };
  });

  server.get<{ Params: { userId: string }; Querystring: { now?: string } }>("/users/:userId/today", async (request) => ({
    brief: await generateDailyOperatorBrief(request.params.userId, { now: parseOptionalNow(request.query.now) })
  }));

  server.get<{ Params: { userId: string }; Querystring: { now?: string } }>("/users/:userId/operator-attention", async (request) => {
    const now = parseOptionalNow(request.query.now) ?? new Date();

    return {
      attention: await buildOperatorAttentionState(request.params.userId, now)
    };
  });

  server.get<{ Params: { userId: string }; Querystring: { now?: string; markSent?: string; force?: string } }>(
    "/users/:userId/daily-loop/start-day",
    async (request) => {
      const now = parseOptionalNow(request.query.now) ?? new Date();
      const input = await dailyLoopStateInput(request.params.userId, now);
      const existingState = await getOrCreateDailyLoopState(request.params.userId, input);
      const markSent = request.query.markSent === "true";
      const force = request.query.force === "true";

      if (markSent && existingState.morningBriefSentAt && !force) {
        return {
          message: "Morning brief already sent today. Use /debug_send_start_day force to resend.",
          state: existingState,
          alreadySent: true
        };
      }

      const message = await buildStartDayMessage(request.params.userId, now);
      const state = markSent
        ? await markDailyLoopMorningSent(request.params.userId, input)
        : existingState;

      if (markSent) {
        await createNotificationLog({
          userId: request.params.userId,
          type: "daily_loop_morning",
          sentForDate: input.localDate
        });
      }

      return { message, state, alreadySent: false };
    }
  );

  server.get<{ Params: { userId: string }; Querystring: { now?: string; markSent?: string; force?: string } }>(
    "/users/:userId/daily-loop/end-day",
    async (request) => {
      const now = parseOptionalNow(request.query.now) ?? new Date();
      const input = await dailyLoopStateInput(request.params.userId, now);
      const existingState = await getOrCreateDailyLoopState(request.params.userId, input);
      const markSent = request.query.markSent === "true";
      const force = request.query.force === "true";

      if (markSent && existingState.eveningReviewSentAt && !force) {
        return {
          message: "Evening review already sent today. Use /debug_send_end_day force to resend.",
          state: existingState,
          alreadySent: true
        };
      }

      const message = await buildEndDayMessage(request.params.userId, now);
      const state = markSent
        ? await markDailyLoopEveningSent(request.params.userId, input)
        : existingState;

      if (markSent) {
        await createNotificationLog({
          userId: request.params.userId,
          type: "daily_loop_evening",
          sentForDate: input.localDate
        });
      }

      return { message, state, alreadySent: false };
    }
  );

  server.get<{ Params: { userId: string }; Querystring: { now?: string } }>(
    "/users/:userId/daily-loop/tomorrow",
    async (request) => ({
      message: await buildTomorrowPrepMessage(request.params.userId, parseOptionalNow(request.query.now) ?? new Date())
    })
  );

  server.get<{ Params: { userId: string }; Querystring: { now?: string } }>("/users/:userId/today/debug-priorities", async (request) => {
    const brief = await generateDailyOperatorBrief(request.params.userId, { now: parseOptionalNow(request.query.now) });

    return {
      priorities: brief.priorityDebug ?? [],
      message:
        brief.priorityDebug && brief.priorityDebug.length > 0
          ? "Daily priorities scored."
          : "No open actions to score."
    };
  });

  server.get<{ Params: { userId: string }; Querystring: { now?: string } }>("/users/:userId/today/debug-daily-coach", async (request) => {
    const brief = await generateDailyOperatorBrief(request.params.userId, { now: parseOptionalNow(request.query.now) });

    return {
      coachSource: brief.coachDebug.source,
      dailyCoachLlmEnabled: process.env.DAILY_COACH_LLM_ENABLED ?? "false",
      llmEnabled: shouldUseDailyCoachLLM(),
      llmAttempted: brief.coachDebug.llmAttempted,
      validationStatus: brief.coachDebug.validationStatus,
      validationFailureCodes: brief.coachDebug.validationFailureCodes,
      validationFailureSummary: brief.coachDebug.validationFailureSummary,
      selectedNextMove: brief.suggestedNextStep,
      selectedActionTitle: brief.coachDebug.selectedActionTitle,
      topPriorities: (brief.priorityDebug ?? []).slice(0, 3).map((priority) => ({
        rank: priority.rank,
        actionId: priority.actionId,
        title: priority.title,
        score: priority.score,
        rankReason: priority.rankReason
      })),
      schemaValidationPassed: brief.coachDebug.schemaValidationPassed,
      fallbackReason: brief.coachDebug.fallbackReason,
      rawResponseType: brief.coachDebug.rawResponseType,
      parsedFieldsPresent: brief.coachDebug.parsedFieldsPresent,
      responseLength: brief.coachDebug.responseLength,
      diagnosisLength: brief.coachDebug.diagnosisLength,
      nextMoveLength: brief.coachDebug.nextMoveLength,
      warningLength: brief.coachDebug.warningLength,
      encouragementLength: brief.coachDebug.encouragementLength
    };
  });

  server.post<{ Params: { userId: string }; Body: { text?: string; dryRun?: boolean; now?: string } }>(
    "/users/:userId/conversation/control",
    async (request, reply) => {
      const body = isRecord(request.body) ? request.body : {};
      const text = typeof body.text === "string" ? body.text : "";
      const now = typeof body.now === "string" ? parseOptionalNow(body.now) : undefined;

      if (!text.trim()) {
        return reply.status(400).send({ error: "Text is required." });
      }

      const debug = await buildConversationControlDebugForUser(request.params.userId, text);

      if (body.dryRun === true) {
        return {
          handled: false,
          debug
        };
      }

      const result = await handleConversationControl(request.params.userId, text, { now, debug });

      return result;
    }
  );

  server.post<{ Params: { userId: string }; Body: { text?: string; dryRun?: boolean; now?: string } }>(
    "/users/:userId/conversation/multi-intent",
    async (request, reply) => {
      const body = isRecord(request.body) ? request.body : {};
      const text = typeof body.text === "string" ? body.text : "";
      const now = typeof body.now === "string" ? parseOptionalNow(body.now) : undefined;

      if (!text.trim()) {
        return reply.status(400).send({ error: "Text is required." });
      }

      const plan = await analyzeMultiIntentMessage(request.params.userId, text, { now });
      const debug = await buildIntentPlanDebug(request.params.userId, plan);

      if (body.dryRun === true) {
        return {
          handled: false,
          plan,
          debug
        };
      }

      if (!plan.isMultiIntent) {
        return {
          handled: false,
          plan,
          debug
        };
      }

      const result = await executeMultiIntentPlan(request.params.userId, text, plan, { now });

      return {
        handled: true,
        ...result,
        plan,
        debug
      };
    }
  );

  server.get<{ Params: { userId: string } }>("/users/:userId/integrations", async (request) => ({
    connections: (await getIntegrationConnections(request.params.userId)).map(sanitizeIntegrationConnection)
  }));

  server.get<{ Params: { userId: string } }>("/users/:userId/integrations/gmail/oauth-url", async (request, reply) => {
    const config = gmailOAuthConfig();

    if (!config) {
      return reply.status(400).send({
        error: gmailOAuthMissingConfigMessage()
      });
    }

    return {
      url: buildGmailOAuthUrl(request.params.userId, config),
      localCallbackWarning: gmailOAuthLocalhostCallbackWarning(config)
    };
  });

  server.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    "/oauth/gmail/callback",
    async (request, reply) => {
      if (request.query.error) {
        return reply.status(400).send({
          error: `Gmail OAuth failed: ${request.query.error}`
        });
      }

      if (!request.query.code || !request.query.state) {
        return reply.status(400).send({
          error: "Missing Gmail OAuth code or state."
        });
      }

      const config = gmailOAuthConfig();
      const userId = decodeGmailOAuthState(request.query.state);

      if (!config || !userId) {
        return reply.status(400).send({
          error: "Invalid Gmail OAuth configuration or state."
        });
      }

      try {
        const token = await exchangeGmailOAuthCode(request.query.code, config);
        const email = await getGmailProfileEmail(token.accessToken);

        const connection = await createGmailConnection(userId, buildEncryptedGmailConnectionConfig({
          provider: "gmail",
          scope: "gmail.readonly",
          email
        }, token));
        const activeRulesPreserved = await preserveActiveGmailRulesForOAuthReconnect(userId, connection, email);
        console.info(
          `Gmail OAuth connected for user=${userId} email=${email ?? "unknown"} connection=${connection.id} activeRulesPreserved=${activeRulesPreserved}`
        );

        return reply
          .type("text/plain")
          .send([
            `Gmail connected${email ? ` for ${email}` : ""}.`,
            activeRulesPreserved > 0
              ? `Preserved ${activeRulesPreserved} active Gmail rule${activeRulesPreserved === 1 ? "" : "s"}.`
              : "No active Gmail rules needed moving.",
            "Access is readonly — Alecto cannot send emails or change labels.",
            // fix/private-alpha-pending-action-refinement-and-gmail-rule-ux: a real reported gap
            // — this page previously only said "you can return to Telegram," leaving the user to
            // guess what to say next. A direct Telegram push from here isn't available (apps/api
            // has no Telegram bot client/token — that lives entirely in apps/telegram-bot as a
            // separate process; wiring one in is a real cross-service change, out of scope for
            // this branch). The next Telegram message already sees this connection as active
            // (context-loader.ts reads it fresh every turn), so this is just about giving the
            // user something concrete to say when they get there.
            "Return to Telegram and say: enable job search rule for Gmail."
          ].join(" "));
      } catch (error) {
        return reply.status(400).type("text/plain").send(safeGmailErrorMessage(error));
      }
    }
  );

  server.post<{ Params: { userId: string } }>(
    "/users/:userId/integrations/github-public",
    async (request, reply) => {
      const parsed = GithubPublicConnectionInputSchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.status(400).send({
          error: "Invalid request body",
          issues: parsed.error.issues
        });
      }

      for (const repo of parsed.data.repos) {
        const validationError = await validateGithubPublicRepo(repo.owner, repo.repo, "connection");

        if (validationError) {
          return reply.status(validationError.httpStatus).send({
            error: validationError.message
          });
        }
      }

      const input = normalizeGithubPublicConnectionInput(parsed.data);
      const existingConnection = findDuplicateGithubConnection(
        await getIntegrationConnections(request.params.userId),
        input
      );

      if (existingConnection) {
        return {
          duplicate: true,
          message: `GitHub integration already exists: ${existingConnection.id}`,
          connection: sanitizeIntegrationConnection(existingConnection)
        };
      }

      return {
        duplicate: false,
        connection: sanitizeIntegrationConnection(await createGithubPublicConnection(request.params.userId, input))
      };
    }
  );

  server.get<{ Params: { userId: string } }>("/users/:userId/email-rules", async (request) => ({
    emailRules: (await getEmailSignalRules(request.params.userId)).map(sanitizeEmailSignalRule)
  }));

  server.post<{ Params: { userId: string } }>("/users/:userId/email-rules", async (request, reply) => {
    const parsed = CreateEmailSignalRuleInputSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid request body",
        issues: parsed.error.issues
      });
    }

    const connection = await getIntegrationConnection(request.params.userId, parsed.data.connectionId);

    if (!connection || connection.integrationId !== "gmail" || connection.status !== "active") {
      return reply.status(400).send({
        error: "Active Gmail connection not found."
      });
    }

    const adapter = getEmailAdapterDefinition(parsed.data.adapterId);

    if (!adapter || adapter.status !== "available" || !["job_search_email", "work_action_email", "custom_email_review"].includes(adapter.id)) {
      return reply.status(400).send({
        error: "Unsupported email adapter."
      });
    }

    if (adapter.id === "job_search_email") {
      await archiveStaleJobSearchEmailRules(request.params.userId, connection.id);
    }

    if (isBuiltInEmailAdapter(adapter.id)) {
      const reusedRule = await reactivateOrReuseBuiltInEmailRule(request.params.userId, connection.id, adapter.id);

      if (reusedRule) {
        return {
          emailRule: sanitizeEmailSignalRule(reusedRule.rule),
          message: [
            reusedRule.wasReactivated ? `Email rule resumed: ${reusedRule.rule.id}` : `Email rule already exists: ${reusedRule.rule.id}`,
            reusedRule.archivedDuplicateCount > 0
              ? `Archived ${reusedRule.archivedDuplicateCount} duplicate email rule${reusedRule.archivedDuplicateCount === 1 ? "" : "s"}.`
              : undefined
          ]
            .filter(Boolean)
            .join(" ")
        };
      }
    }

    const existingCurrentRule = (await getEmailSignalRules(request.params.userId)).find(
      (rule) =>
        rule.status === "active" &&
        rule.connectionId === connection.id &&
        rule.adapterId === adapter.id &&
        (adapter.id !== "custom_email_review" ||
          normalizeForComparison(rule.query ?? "") === normalizeForComparison(parsed.data.query ?? adapter.defaultQuery ?? ""))
    );

    if (existingCurrentRule) {
      return {
        emailRule: sanitizeEmailSignalRule(existingCurrentRule),
        message: `Email rule already exists: ${existingCurrentRule.id}`
      };
    }

    const rule = await createEmailSignalRule(request.params.userId, {
      ...parsed.data,
      ...defaultEmailRuleConfigForAdapter(adapter.id, request.body),
      query: parsed.data.query ?? adapter.defaultQuery ?? "",
      createdBy: "user"
    });

    return {
      emailRule: sanitizeEmailSignalRule(rule),
      message: `Email rule enabled: ${rule.id}`
    };
  });

  server.patch<{ Params: { userId: string; ruleId: string } }>(
    "/users/:userId/email-rules/:ruleId",
    async (request, reply) => {
      const parsed = UpdateEmailSignalRuleInputSchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.status(400).send({
          error: "Invalid request body",
          issues: parsed.error.issues
        });
      }

      const existingRule = (await getEmailSignalRules(request.params.userId)).find((rule) => rule.id === request.params.ruleId);

      if (!existingRule) {
        return reply.status(404).send({
          error: "Email rule not found"
        });
      }

      if (existingRule.status === "archived") {
        return reply.status(400).send({
          error: "Email rule is archived and cannot be updated. Use the active rule or create a new one."
        });
      }

      const rule = await updateEmailSignalRule(request.params.userId, request.params.ruleId, parsed.data);

      if (!rule) {
        return reply.status(404).send({
          error: "Email rule not found"
        });
      }

      return { emailRule: sanitizeEmailSignalRule(rule) };
    }
  );

  server.delete<{ Params: { userId: string; ruleId: string } }>(
    "/users/:userId/email-rules/:ruleId",
    async (request, reply) => {
      const rule = await archiveEmailSignalRule(request.params.userId, request.params.ruleId);

      if (!rule) {
        return reply.status(404).send({
          error: "Email rule not found"
        });
      }

      return {
        emailRule: sanitizeEmailSignalRule(rule),
        message: `Email rule archived: ${rule.id}`
      };
    }
  );

  server.post<{ Params: { userId: string; ruleId: string } }>(
    "/users/:userId/email-rules/:ruleId/cleanup-events",
    async (request) => {
      const events = await archiveGmailRuleEvents(request.params.userId, request.params.ruleId, "cleanup gmail rule test events");

      return {
        count: events.length,
        events,
        message: `Archived ${events.length} Gmail event${events.length === 1 ? "" : "s"} for rule ${request.params.ruleId}.`
      };
    }
  );

  server.get<{ Params: { userId: string }; Querystring: { status?: string } }>(
    "/users/:userId/email-reviews/inbox",
    async (request) => {
      return buildEmailReviewInboxResponse(request.params.userId, {
        storeContext: request.query.status !== "all"
      });
    }
  );

  server.get<{ Params: { userId: string }; Querystring: { status?: string } }>(
    "/users/:userId/email-reviews",
    async (request) => {
      const status = request.query.status === "all" ? "all" : "pending";

      return {
        emailReviews: (await getEmailReviewItems(request.params.userId, {
          status,
          limit: 10
        })).map(sanitizeEmailReviewItem)
      };
    }
  );

  server.post<{ Params: { userId: string; reviewId: string } }>(
    "/users/:userId/email-reviews/:reviewId/approve",
    async (request, reply) => {
      const result = await approveEmailReviewForUser(request.params.userId, request.params.reviewId);

      if (result.status === "not_found") {
        return reply.status(404).send({ error: "Email review item not found" });
      }

      if (result.status === "not_pending") {
        return reply.status(400).send({
          error: `Email review item is already ${result.review.status}.`,
          emailReview: sanitizeEmailReviewItem(result.review)
        });
      }

      return {
        emailReview: sanitizeEmailReviewItem(result.emailReview),
        event: result.event ?? null,
        actionItem: result.actionItem ? sanitizeActionItem(result.actionItem) : undefined,
        message: result.message
      };
    }
  );

  server.get<{ Params: { userId: string }; Querystring: { status?: string } }>(
    "/users/:userId/actions",
    async (request) => {
      const status = request.query.status === "all" ? "all" : "open";

      return {
        actions: (await getActionItems(request.params.userId, {
          status,
          limit: 10
        })).map(sanitizeActionItem)
      };
    }
  );

  server.get<{ Params: { userId: string }; Querystring: { now?: string; debug?: string } }>(
    "/users/:userId/actions/hygiene",
    async (request) => {
      const now = parseOptionalNow(request.query.now) ?? new Date();
      const timezone = await getUserTimezone(request.params.userId);
      const report = await analyzeActionHygiene(request.params.userId, now, timezone);

      if (request.query.debug !== "true") {
        await storeActionHygieneSession(request.params.userId, "/action_hygiene", now, timezone, report, "legacy");
      }

      return {
        report,
        message: request.query.debug === "true" ? formatActionHygieneDebug(report) : formatActionHygieneReport(report)
      };
    }
  );

  server.post<{ Params: { userId: string }; Body: { message?: string; now?: string } }>(
    "/users/:userId/actions/hygiene/reply",
    async (request) => {
      const body = isRecord(request.body) ? request.body : {};
      const message = typeof body.message === "string" ? body.message : "";
      const pending = await getLatestPendingAction(request.params.userId);

      if (!pending || pending.type !== "action_hygiene") {
        return {
          handled: false,
          message: "No active action hygiene session. Run /action_hygiene first."
        };
      }

      const reply = await resolveActionHygieneReply(request.params.userId, pending, message, parseOptionalNow(typeof body.now === "string" ? body.now : undefined));

      return {
        handled: true,
        message: reply
      };
    }
  );

  server.post<{ Params: { userId: string } }>(
    "/users/:userId/actions/manual",
    async (request, reply) => {
      const body = isRecord(request.body) ? request.body : {};
      const text = typeof body.text === "string" ? body.text : "";

      if (!text.trim()) {
        return reply.status(400).send({ error: "Action text is required." });
      }

      const now = typeof body.now === "string" ? parseOptionalNow(body.now) : undefined;
      const result = await maybeCreateManualActionFromText(request.params.userId, text, { forceActionIntent: true, now });

      if (!result.extraction.shouldCreateAction) {
        if (result.extraction.reason === "past_explicit_time") {
          return reply.status(400).send({
            error: "That time has already passed. Use a future time, or say 'now'.",
            extraction: result.extraction
          });
        }

        return reply.status(400).send({
          error: "I could not turn that into a concrete action item.",
          extraction: result.extraction
        });
      }

      return {
        action: result.action ? sanitizeActionItem(result.action) : undefined,
        duplicate: result.duplicate,
        extraction: result.extraction,
        message: formatActionCreatedReply(result)
      };
    }
  );

  server.post<{ Params: { userId: string } }>(
    "/users/:userId/actions/debug-link-goals",
    async (request) => {
      const actions = (await getRecentActionItems(request.params.userId, 200)).filter(
        (action) => (action.status === "open" || action.status === "snoozed") && !action.goalId
      );
      let linked = 0;

      for (const action of actions) {
        const goalLink = await inferActionGoalLink(
          request.params.userId,
          action.title,
          action.description,
          action.evidence
        );

        if (goalLink.goalId) {
          const updated = await linkActionItemToGoal(request.params.userId, action.id, {
            goalId: goalLink.goalId,
            goalSlug: goalLink.goalSlug ?? undefined,
            goalTitleSnapshot: goalLink.matchedGoalTitle
          });

          if (updated) {
            linked += 1;
          }
        }
      }

      return {
        linked,
        message: `Linked ${linked} action${linked === 1 ? "" : "s"} to goals.`
      };
    }
  );

  server.post<{ Params: { userId: string } }>(
    "/users/:userId/actions/reminders/trigger",
    async (request) => {
      const reminders = await dispatchActionRemindersForUser(request.params.userId, new Date());

      return {
        reminders,
        sent: reminders.length,
        message:
          reminders.length > 0
            ? reminders.map((reminder) => reminder.message).join("\n\n")
            : "No due action reminders."
      };
    }
  );

  server.patch<{ Params: { userId: string; actionId: string } }>(
    "/users/:userId/actions/:actionId/debug-force-due",
    async (request, reply) => {
      const dueAt = new Date(Date.now() - 60_000);
      const actionItem = await forceActionItemDue(request.params.userId, request.params.actionId, dueAt);

      if (!actionItem) {
        return reply.status(404).send({ error: "Action item not found" });
      }

      return {
        action: sanitizeActionItem(actionItem),
        message: `Action forced due: ${actionItem.title}`
      };
    }
  );

  server.patch<{ Params: { userId: string; actionId: string } }>(
    "/users/:userId/actions/:actionId/debug-force-snoozed-due",
    async (request, reply) => {
      const snoozedUntil = new Date(Date.now() - 60_000);
      const actionItem = await forceActionItemSnoozedDue(request.params.userId, request.params.actionId, snoozedUntil);

      if (!actionItem) {
        return reply.status(404).send({ error: "Action item not found" });
      }

      return {
        action: sanitizeActionItem(actionItem),
        message: `Action forced snoozed due: ${actionItem.title}`
      };
    }
  );

  server.patch<{ Params: { userId: string; actionId: string } }>(
    "/users/:userId/actions/:actionId/complete",
    async (request, reply) => {
      const existingAction = await getActionItem(request.params.userId, request.params.actionId);

      if (!existingAction) {
        return reply.status(404).send({ error: "Action item not found" });
      }

      if (existingAction.status === "completed") {
        return {
          action: sanitizeActionItem(existingAction),
          event: null,
          message: `Action already completed: ${existingAction.title}`
        };
      }

      const actionItem = await completeActionItem(request.params.userId, request.params.actionId);

      if (!actionItem) {
        return reply.status(404).send({ error: "Action item not found" });
      }

      const progressEvent = await createGoalProgressFromCompletedAction(request.params.userId, actionItem);

      return {
        action: sanitizeActionItem(actionItem),
        event: progressEvent?.event,
        message: [
          `Action completed: ${actionItem.title}`,
          progressEvent?.created ? `Goal progress logged: ${progressEvent.goalTitle}` : undefined
        ]
          .filter(Boolean)
          .join("\n")
      };
    }
  );

  server.patch<{ Params: { userId: string; actionId: string } }>(
    "/users/:userId/actions/:actionId/archive",
    async (request, reply) => {
      const actionItem = await archiveActionItem(request.params.userId, request.params.actionId);

      if (!actionItem) {
        return reply.status(404).send({ error: "Action item not found" });
      }

      return {
        action: sanitizeActionItem(actionItem),
        message: `Action archived: ${actionItem.title}`
      };
    }
  );

  server.patch<{ Params: { userId: string; actionId: string } }>(
    "/users/:userId/actions/:actionId/snooze",
    async (request, reply) => {
      const body = request.body as { snoozedUntil?: string; snoozeText?: string };
      const settings = await getOrCreateNotificationSettings(request.params.userId);
      const parsedSnooze = body.snoozeText
        ? parseActionDueDate(body.snoozeText, {
            timezone: settings.timezone,
            preferences: settings
          })
        : undefined;

      if (parsedSnooze?.invalidReason === "past_explicit_time") {
        return reply.status(400).send({ error: "That snooze time has already passed." });
      }

      const snoozedUntil = parsedSnooze?.dueAt ?? (body.snoozedUntil ? new Date(body.snoozedUntil) : undefined);

      if (!snoozedUntil || Number.isNaN(snoozedUntil.getTime())) {
        return reply.status(400).send({ error: "Invalid snoozedUntil" });
      }

      const actionItem = await snoozeActionItem(request.params.userId, request.params.actionId, snoozedUntil);

      if (!actionItem) {
        return reply.status(404).send({ error: "Action item not found" });
      }

      return {
        action: sanitizeActionItem(actionItem),
        message: `Action snoozed until ${formatLocalDateTime(actionItem.snoozedUntil, settings.timezone)}: ${actionItem.title}`
      };
    }
  );

  server.post<{ Params: { userId: string; reviewId: string } }>(
    "/users/:userId/email-reviews/:reviewId/reject",
    async (request, reply) => {
      const review = await rejectEmailReviewItem(request.params.userId, request.params.reviewId);

      if (!review) {
        return reply.status(404).send({ error: "Email review item not found" });
      }

      return {
        emailReview: sanitizeEmailReviewItem(review),
        message: review.status === "rejected" ? "Email review rejected." : `Email review item is already ${review.status}.`
      };
    }
  );

  server.post<{ Params: { userId: string; ruleId: string } }>(
    "/users/:userId/email-rules/:ruleId/cleanup-reviews",
    async (request) => {
      const archived = await archivePendingEmailReviewItemsForRule(request.params.userId, request.params.ruleId);

      return {
        count: archived.length,
        emailReviews: archived.map(sanitizeEmailReviewItem),
        message: `Archived ${archived.length} pending email review item${archived.length === 1 ? "" : "s"} for rule ${request.params.ruleId}.`
      };
    }
  );

  server.patch<{ Params: { userId: string; connectionId: string } }>(
    "/users/:userId/integrations/:connectionId",
    async (request, reply) => {
      const parsed = UpdateIntegrationConnectionInputSchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.status(400).send({
          error: "Invalid request body",
          issues: parsed.error.issues
        });
      }

      const connection = await updateIntegrationConnection(
        request.params.userId,
        request.params.connectionId,
        parsed.data
      );

      if (!connection) {
        return reply.status(404).send({
          error: "Integration connection not found"
        });
      }

      return { connection: sanitizeIntegrationConnection(connection) };
    }
  );

  server.delete<{ Params: { userId: string; connectionId: string } }>(
    "/users/:userId/integrations/:connectionId",
    async (request, reply) => {
      const connection = await archiveIntegrationConnection(request.params.userId, request.params.connectionId);

      if (!connection) {
        return reply.status(404).send({
          error: "Integration connection not found"
        });
      }

      return {
        connection: sanitizeIntegrationConnection(connection),
        message: "Integration archived. Historical events were kept."
      };
    }
  );

  server.post<{ Params: { userId: string; connectionId: string } }>(
    "/users/:userId/integrations/:connectionId/sync",
    async (request, reply) => {
      const connection = await getIntegrationConnection(request.params.userId, request.params.connectionId);

      if (!connection) {
        return reply.status(404).send({
          error: "Integration connection not found"
        });
      }

      if (connection.status === "paused" || connection.status === "archived") {
        return reply.status(400).send({
          error: `Integration connection is ${connection.status}`
        });
      }

      if (connection.status === "error") {
        if (connection.integrationId === "gmail") {
          return reply.status(400).send({
            error: safeGmailErrorMessage(connection.lastError ?? "Gmail authorization expired. Reconnect Gmail."),
            connectionId: connection.id,
            integrationId: connection.integrationId,
            eventsCreated: 0,
            emailSummaries: [],
            errorStage: "token_refresh"
          });
        }

        return reply.status(400).send({
          error: "Integration connection is in error status. Resume it before syncing again."
        });
      }

      if (connection.integrationId !== "github_public" && connection.integrationId !== "gmail") {
        return reply.status(400).send({
          error: "Unsupported integration sync"
        });
      }

      const body = isRecord(request.body) ? request.body : {};
      const isBackgroundGmailSync = connection.integrationId === "gmail" && body.backgroundSync === true;
      const backgroundAttemptedAt = isBackgroundGmailSync
        ? parseOptionalDate(body.backgroundAttemptedAt) ?? new Date()
        : undefined;
      const result =
        connection.integrationId === "github_public"
          ? await syncGithubPublicConnection(connection)
          : await syncGmailConnection(connection);

      if (isBackgroundGmailSync && backgroundAttemptedAt) {
        await recordGmailBackgroundSyncAttempt({
          userId: connection.userId,
          connectionId: connection.id,
          attemptedAt: backgroundAttemptedAt,
          status: result.status,
          error: "error" in result ? result.error : undefined
        });
      }

      if (result.status === "error") {
        return reply.status(502).send({
          error: result.error,
          connectionId: result.connectionId,
          integrationId: result.integrationId,
          eventsCreated: result.eventsCreated,
          emailSummaries: "emailSummaries" in result ? result.emailSummaries : undefined,
          emailRuleDiagnostics: "emailRuleDiagnostics" in result ? result.emailRuleDiagnostics : undefined,
          errorStage: "errorStage" in result ? result.errorStage : undefined,
          syncLog: result.syncLog
        });
      }

      return result;
    }
  );

  server.get<{ Params: { userId: string }; Querystring: { now?: string } }>(
    "/users/:userId/integrations/gmail/background-sync/debug",
    async (request) => {
      const state = await buildGmailAutonomyState(request.params.userId);
      const now = parseOptionalNow(request.query.now) ?? new Date();
      const connection = state.primaryConnection;
      const eligibility = connection
        ? evaluateGmailBackgroundSyncEligibility({
            connection,
            now,
            runtime: state.runtime,
            activeRuleCount: state.activeRules.length
          })
        : undefined;

      return {
        globalBackgroundIntegrationSyncEnabled: state.runtime.scheduledSyncEnabled,
        gmailConnected: state.gmailConnected,
        connectionId: connection?.id,
        connectionStatus: connection?.status,
        mode: state.syncMode,
        intervalMinutes: state.syncIntervalMinutes,
        lastBackgroundSyncAttemptedAt: eligibility?.lastBackgroundSyncAttemptedAt?.toISOString(),
        lastBackgroundSyncedAt: eligibility?.lastBackgroundSyncedAt?.toISOString(),
        nextDueAt: eligibility?.nextDueAt?.toISOString(),
        activeRuleCount: state.activeRules.length,
        notificationPreference: state.reviewNotificationEnabled ? "on" : "off",
        deliveryAvailable: state.notificationDeliveryAvailable,
        eligible: eligibility?.eligible ?? false,
        reason: eligibility?.reason ?? "gmail_not_connected"
      };
    }
  );

  server.post<{ Params: { userId: string } }>("/users/:userId/goals", async (request, reply) => {
    const parsed = CreateGoalInputSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid request body",
        issues: parsed.error.issues
      });
    }

    return formatCreateGoalResult(await createGoal(request.params.userId, parsed.data));
  });

  server.post<{ Params: { userId: string } }>("/users/:userId/goals/from-template", async (request, reply) => {
    const parsed = CreateGoalFromTemplateInputSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid request body",
        issues: parsed.error.issues
      });
    }

    const template = getGoalTemplate(parsed.data.templateId);

    if (!template) {
      return reply.status(404).send({
        error: "Goal template not found"
      });
    }

    return formatCreateGoalResult(
      await createGoal(request.params.userId, {
        title: parsed.data.title,
        category: template.category,
        why: parsed.data.why,
        templateId: template.id,
        targetMetrics: parsed.data.targetMetrics,
        priority: parsed.data.priority,
        importanceScore: parsed.data.importanceScore,
        priorityReason: parsed.data.priorityReason,
        allowDuplicate: parsed.data.allowDuplicate
      })
    );
  });

  server.post<{ Params: { userId: string } }>("/users/:userId/goals/custom-config", async (request, reply) => {
    const parsed = CustomGoalConfigInputSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid request body",
        issues: parsed.error.issues
      });
    }

    return {
      config: buildCustomGoalConfig({
        ...parsed.data,
        userProfile: await getOrCreateUserOperatingProfile(request.params.userId)
      })
    };
  });

  server.post<{ Params: { userId: string; goalId: string } }>(
    "/users/:userId/goals/:goalId/progress",
    async (request, reply) => {
      const parsed = CustomGoalProgressInputSchema.safeParse(request.body);

      if (!parsed.success) {
        return reply.status(400).send({
          error: "Invalid request body",
          issues: parsed.error.issues
        });
      }

      const goal = (await getGoals(request.params.userId)).find((item) => item.id === request.params.goalId);

      if (!goal) {
        return reply.status(404).send({
          error: "Goal not found"
        });
      }

      const event = await createCustomGoalProgressEvent(request.params.userId, goal, parsed.data);

      return {
        event,
        reply: composeCustomGoalProgressReply(goal.title, parsed.data)
      };
    }
  );

  server.post<{ Params: { userId: string } }>("/users/:userId/checkins/daily", async (request, reply) => {
    const parsed = DailyCheckInInputSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid request body",
        issues: parsed.error.issues
      });
    }

    const events = await createDailyCheckInEvents(request.params.userId, parsed.data.answers);
    const pendingMemoryReply = await maybeCreateLowSleepImpulsePendingMemory(request.params.userId, events);

    return {
      events,
      reply: appendPendingMemoryNotice(`Check-in saved: ${formatCheckInConfirmation(parsed.data.answers)}.`, pendingMemoryReply)
    };
  });

  server.post<{ Params: { userId: string } }>("/users/:userId/checkins/daily/text", async (request, reply) => {
    const parsed = DailyCheckInTextInputSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid request body",
        issues: parsed.error.issues
      });
    }

    const parsedCheckIn = parseDailyCheckinText(parsed.data.text);
    const answers = parsedDailyCheckInToAnswers(parsedCheckIn);
    const events = await createDailyCheckInEvents(request.params.userId, answers, parsed.data.text);
    const pendingMemoryReply = await maybeCreateLowSleepImpulsePendingMemory(request.params.userId, events);

    return {
      parsed: parsedCheckIn,
      events,
      reply: appendPendingMemoryNotice(composeNaturalCheckInReply(parsedCheckIn), pendingMemoryReply)
    };
  });

  server.get<{ Params: { userId: string } }>("/users/:userId/notification-logs/recent-daily-checkin", async (request) => {
    const now = new Date();

    return {
      recent: await hasRecentNotificationLog({
        userId: request.params.userId,
        type: "daily_checkin",
        since: new Date(now.getTime() - 2 * 60 * 60 * 1000)
      })
    };
  });

  server.patch<{ Params: { userId: string; goalId: string } }>(
    "/users/:userId/goals/:goalId/archive",
    async (request, reply) => {
      const goal = await archiveGoal(request.params.userId, request.params.goalId);

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

function defaultEmailRuleConfigForAdapter(adapterId: string, rawBody: unknown) {
  if (adapterId === "work_action_email") {
    const input = typeof rawBody === "object" && rawBody !== null ? (rawBody as Record<string, unknown>) : {};

    return {
      ...(!("fetchStrategy" in input) ? { fetchStrategy: "query" as const } : {}),
      ...(!("lookbackDays" in input) ? { lookbackDays: 7 } : {}),
      ...(!("maxMessagesPerSync" in input) ? { maxMessagesPerSync: 25 } : {}),
      ...(!("maxEventsPerSync" in input) ? { maxEventsPerSync: 5 } : {}),
      ...(!("classifierMode" in input) ? { classifierMode: "hybrid" as const } : {}),
      ...(!("minAutoLogConfidence" in input) ? { minAutoLogConfidence: 0.95 } : {}),
      ...(!("minReviewConfidence" in input) ? { minReviewConfidence: 0.7 } : {}),
      ...(!("reviewBeforeLogging" in input) ? { reviewBeforeLogging: true } : {})
    };
  }

  if (adapterId === "custom_email_review") {
    const input = typeof rawBody === "object" && rawBody !== null ? (rawBody as Record<string, unknown>) : {};

    return {
      ...(!("fetchStrategy" in input) ? { fetchStrategy: "query" as const } : {}),
      ...(!("lookbackDays" in input) ? { lookbackDays: 30 } : {}),
      ...(!("maxMessagesPerSync" in input) ? { maxMessagesPerSync: 25 } : {}),
      ...(!("maxEventsPerSync" in input) ? { maxEventsPerSync: 5 } : {}),
      ...(!("classifierMode" in input) ? { classifierMode: "rules" as const } : {}),
      ...(!("minAutoLogConfidence" in input) ? { minAutoLogConfidence: 1 } : {}),
      ...(!("minReviewConfidence" in input) ? { minReviewConfidence: 0.65 } : {}),
      ...(!("reviewBeforeLogging" in input) ? { reviewBeforeLogging: true } : {})
    };
  }

  return {};
}

async function buildOperatorReflectionContext(
  userId: string,
  input: { now: Date; timezone: string; days?: number }
): Promise<OperatorReflectionContext> {
  const days = input.days ?? 7;
  const since = new Date(input.now.getTime() - days * 24 * 60 * 60 * 1000);
  const [activeGoals, actions, events, memories] = await Promise.all([
    getActiveGoals(userId),
    getActionItems(userId, { status: "all", limit: 200 }),
    getEventsSince(userId, since),
    getActiveMemories(userId)
  ]);
  const dateRange = {
    start: formatDateInTimezone(since, input.timezone),
    end: formatDateInTimezone(input.now, input.timezone),
    since,
    until: input.now
  };
  const inRangeActions = actions.filter((action) => action.updatedAt >= since || (action.completedAt && action.completedAt >= since));
  const completedActions = inRangeActions.filter((action) => action.status === "completed" && action.completedAt && action.completedAt >= since);
  const overdueActions = actions.filter((action) => action.status === "open" && action.dueAt && action.dueAt < input.now);
  const snoozedOrRescheduledActions = inRangeActions.filter((action) => action.status === "snoozed" || Boolean(action.snoozedUntil));
  const archivedActions = inRangeActions.filter((action) => action.status === "archived");
  const guardrailEvents = events.filter((event) => isGuardrailEvent(event));
  const existingReflections = memories.filter(isOperatorReflectionMemory);
  const goalsWithProgress = new Set<string>();

  for (const action of completedActions) {
    if (action.goalId) {
      goalsWithProgress.add(action.goalId);
    }
  }

  for (const event of events) {
    const goalId = stringFromRecord(event.data, "goalId");
    if (goalId) {
      goalsWithProgress.add(goalId);
    }
  }

  return {
    userId,
    timezone: input.timezone,
    dateRange,
    activeGoals,
    completedActions,
    overdueActions,
    snoozedOrRescheduledActions,
    archivedActions,
    events,
    guardrailEvents,
    existingReflections,
    goalsWithoutProgress: activeGoals.filter((goal) => !goalsWithProgress.has(goal.id)),
    counts: {
      completedActions: completedActions.length,
      overdueActions: overdueActions.length,
      snoozedOrRescheduledActions: snoozedOrRescheduledActions.length,
      archivedActions: archivedActions.length,
      events: events.length,
      guardrailTriggers: guardrailEvents.length,
      activeGoals: activeGoals.length,
      existingReflections: existingReflections.length
    }
  };
}

async function generateAndSaveOperatorReflections(userId: string, context: OperatorReflectionContext) {
  const candidates = mergeReflectionCandidates([
    ...generateDeterministicOperatorReflectionCandidates(context),
    ...await maybeGenerateLlmOperatorReflectionCandidates(context)
  ]);
  const saved: MemoryEntry[] = [];

  for (const candidate of candidates.slice(0, 5)) {
    if (!isSafeOperatorReflectionCandidate(candidate)) {
      continue;
    }

    saved.push(await upsertOperatorReflection(userId, candidate, context));
  }

  return {
    reflections: saved,
    candidatesGenerated: candidates.length,
    saved: saved.length
  };
}

function generateDeterministicOperatorReflectionCandidates(context: OperatorReflectionContext): OperatorReflectionCandidate[] {
  const candidates: OperatorReflectionCandidate[] = [];
  const stale = context.overdueActions.find((action) => daysOverdueForAction(action, context) >= 3);

  if (stale) {
    candidates.push({
      type: "stale_goal",
      title: `${stale.title} has become stale`,
      summary: `${stale.title} has been overdue for ${daysOverdueForAction(stale, context)} days and needs a decision: complete, snooze, archive, or make smaller.`,
      evidence: {
        actionIds: [stale.id],
        goalIds: stale.goalId ? [stale.goalId] : [],
        eventIds: [],
        dateRange: reflectionDateRangeEvidence(context),
        counts: { daysOverdue: daysOverdueForAction(stale, context), overdueActions: context.overdueActions.length }
      },
      confidence: 0.82,
      source: "daily_reflection"
    });
  }

  const snoozeGroups = groupActionsByGoalOrKeyword(context.snoozedOrRescheduledActions);
  const repeated = [...snoozeGroups.entries()].find(([, actions]) => actions.length >= 2);

  if (repeated) {
    const [label, actions] = repeated;
    candidates.push({
      type: "friction",
      title: `${label} tasks may be too broad`,
      summary: `${label} actions were snoozed or rescheduled ${actions.length} times in the last 7 days. The next action should be smaller and more concrete.`,
      evidence: {
        actionIds: actions.map((action) => action.id),
        goalIds: uniqueStrings(actions.map((action) => action.goalId).filter((value): value is string => Boolean(value))),
        eventIds: [],
        dateRange: reflectionDateRangeEvidence(context),
        counts: { snoozedOrRescheduledActions: actions.length }
      },
      confidence: 0.8,
      source: "daily_reflection"
    });
  }

  const criticalProgress = context.completedActions.find((action) => {
    const goal = context.activeGoals.find((item) => item.id === action.goalId);
    return goal && goalPriorityRank(goal) >= 70;
  });
  const mediumSnoozes = context.snoozedOrRescheduledActions.filter((action) => {
    const goal = context.activeGoals.find((item) => item.id === action.goalId);
    return goal && goalPriorityRank(goal) <= 25;
  });

  if (criticalProgress && mediumSnoozes.length >= 2) {
    candidates.push({
      type: "goal_strategy",
      title: "Concrete critical-goal actions are moving better than broad lower-priority tasks",
      summary: "Completed critical-goal work is showing up, while lower-priority tasks are being moved. Keep critical actions concrete and break broad creative tasks into smaller pieces.",
      evidence: {
        actionIds: [criticalProgress.id, ...mediumSnoozes.slice(0, 3).map((action) => action.id)],
        goalIds: uniqueStrings([criticalProgress.goalId, ...mediumSnoozes.map((action) => action.goalId)].filter((value): value is string => Boolean(value))),
        eventIds: [],
        dateRange: reflectionDateRangeEvidence(context),
        counts: { completedCriticalActions: 1, movedLowerPriorityActions: mediumSnoozes.length }
      },
      confidence: 0.78,
      source: "weekly_reflection"
    });
  }

  if (context.guardrailEvents.length >= 2) {
    candidates.push({
      type: "guardrail_pattern",
      title: "Guardrail has been active recently",
      summary: "Guardrail events appeared repeatedly in the last 7 days. Keep betting/trading intent out of task creation and let the guardrail stop those loops.",
      evidence: {
        actionIds: [],
        goalIds: context.activeGoals.filter(isRiskControlGoal).map((goal) => goal.id),
        eventIds: context.guardrailEvents.map((event) => event.id),
        dateRange: reflectionDateRangeEvidence(context),
        counts: { guardrailTriggers: context.guardrailEvents.length }
      },
      confidence: 0.86,
      source: "weekly_reflection"
    });
  }

  return candidates;
}

async function maybeGenerateLlmOperatorReflectionCandidates(context: OperatorReflectionContext): Promise<OperatorReflectionCandidate[]> {
  if (process.env.OPERATOR_REFLECTION_LLM_ENABLED !== "true") {
    return [];
  }

  const mock = process.env.OPERATOR_REFLECTION_LLM_MOCK_RESPONSE;

  if (!mock) {
    return [];
  }

  try {
    const parsed = JSON.parse(mock) as unknown;
    const candidates = Array.isArray(parsed)
      ? parsed
      : isRecord(parsed) && Array.isArray(parsed.candidates)
        ? parsed.candidates
        : [];

    return candidates
      .map(parseOperatorReflectionCandidate)
      .filter((candidate): candidate is OperatorReflectionCandidate => Boolean(candidate));
  } catch {
    return [];
  }
}

function parseOperatorReflectionCandidate(value: unknown): OperatorReflectionCandidate | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const type = typeof value.type === "string" && isOperatorReflectionType(value.type) ? value.type : undefined;
  const title = typeof value.title === "string" ? value.title.trim() : "";
  const summary = typeof value.summary === "string" ? value.summary.trim() : "";
  const evidence = isRecord(value.evidence) ? value.evidence : {};
  const confidence = typeof value.confidence === "number" ? value.confidence : 0;

  if (!type || !title || !summary) {
    return undefined;
  }

  return {
    type,
    title: title.slice(0, 120),
    summary: summary.slice(0, 360),
    evidence,
    confidence,
    source: "weekly_reflection"
  };
}

function isSafeOperatorReflectionCandidate(candidate: OperatorReflectionCandidate): boolean {
  if (candidate.confidence < 0.7) {
    return false;
  }

  if (containsUnsafeReflectionLanguage(`${candidate.title} ${candidate.summary}`)) {
    return false;
  }

  const actionIds = arrayOfStrings(candidate.evidence.actionIds);
  const eventIds = arrayOfStrings(candidate.evidence.eventIds);
  const goalIds = arrayOfStrings(candidate.evidence.goalIds);
  const evidenceCount = actionIds.length + eventIds.length + goalIds.length;

  if (candidate.type === "guardrail_pattern" && eventIds.length >= 1) {
    return true;
  }

  return evidenceCount >= 2 || (actionIds.length >= 1 && typeof candidate.evidence.counts === "object");
}

async function upsertOperatorReflection(
  userId: string,
  candidate: OperatorReflectionCandidate,
  context: OperatorReflectionContext
): Promise<MemoryEntry> {
  const existing = findSimilarOperatorReflection(context.existingReflections, candidate);
  const data = operatorReflectionData(candidate, existing);
  const evidence = sanitizeOperatorReflectionEvidence(candidate.evidence);

  if (existing) {
    const updated = await updateMemory(userId, existing.id, {
      summary: candidate.summary,
      data,
      evidence,
      confidence: Math.max(existing.confidence, candidate.confidence)
    });

    return updated ?? existing;
  }

  return createMemory(userId, {
    type: candidate.type === "guardrail_pattern" ? "risk_pattern" : candidate.type === "preference" ? "preference" : "pattern",
    summary: candidate.summary,
    data,
    evidence,
    source: "system_inferred",
    confidence: candidate.confidence
  });
}

function operatorReflectionData(candidate: OperatorReflectionCandidate, existing?: MemoryEntry): Record<string, unknown> {
  const previousCount = typeof existing?.data?.observationCount === "number" ? existing.data.observationCount : 0;

  return {
    kind: "operator_reflection",
    reflectionType: candidate.type,
    title: candidate.title,
    source: candidate.source,
    lastObservedAt: new Date().toISOString(),
    observationCount: previousCount + 1
  };
}

function findSimilarOperatorReflection(reflections: MemoryEntry[], candidate: OperatorReflectionCandidate): MemoryEntry | undefined {
  const titleKey = normalizeForComparison(candidate.title);

  return reflections.find((reflection) => {
    const data = reflection.data ?? {};
    const reflectionType = typeof data.reflectionType === "string" ? data.reflectionType : "";
    const reflectionTitle = typeof data.title === "string" ? data.title : reflection.summary;

    return reflectionType === candidate.type && normalizeForComparison(reflectionTitle) === titleKey;
  });
}

async function archiveOperatorReflection(userId: string, reflectionIdOrNumber: string): Promise<MemoryEntry | undefined> {
  const reflections = await getActiveOperatorReflections(userId);
  const index = Number.parseInt(reflectionIdOrNumber, 10);
  const reflection = Number.isInteger(index) && index > 0
    ? reflections[index - 1]
    : reflections.find((item) => item.id === reflectionIdOrNumber);

  if (!reflection) {
    return undefined;
  }

  return archiveMemory(userId, reflection.id);
}

function formatOperatorReflectionGeneration(reflections: MemoryEntry[]): string {
  if (reflections.length === 0) {
    return "Operator reflections:\nNo new grounded reflections found.";
  }

  return ["Operator reflections:", ...reflections.map((reflection, index) => formatOperatorReflectionLine(reflection, index))].join("\n\n");
}

function formatOperatorReflections(reflections: MemoryEntry[]): string {
  if (reflections.length === 0) {
    return "No active operator reflections.";
  }

  return ["Operator reflections:", ...reflections.map((reflection, index) => formatOperatorReflectionLine(reflection, index))].join("\n\n");
}

function formatOperatorReflectionLine(reflection: MemoryEntry, index: number): string {
  const title = typeof reflection.data?.title === "string" ? reflection.data.title : reflection.summary;
  const evidence = reflection.evidence ?? {};
  const counts = isRecord(evidence.counts) ? evidence.counts : {};
  const countText = Object.entries(counts)
    .slice(0, 2)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(", ");

  return [
    `${index + 1}. ${title}`,
    reflection.summary,
    countText ? `Evidence: ${countText}` : undefined,
    `id: ${reflection.id}`
  ]
    .filter(Boolean)
    .join("\n");
}

function formatOperatorReflectionContextDebug(context: OperatorReflectionContext): string {
  const summary = summarizeOperatorReflectionContext(context);

  return [
    "Operator reflection context:",
    `dateRange: ${summary.dateRange.start} to ${summary.dateRange.end}`,
    `completed actions: ${summary.counts.completedActions}`,
    `overdue actions: ${summary.counts.overdueActions}`,
    `snoozed/rescheduled actions: ${summary.counts.snoozedOrRescheduledActions}`,
    `archived actions: ${summary.counts.archivedActions}`,
    `guardrail triggers: ${summary.counts.guardrailTriggers}`,
    `active goals: ${summary.counts.activeGoals}`,
    `goals without progress: ${summary.goalsWithoutProgress.length}`,
    `existing reflections: ${summary.counts.existingReflections}`
  ].join("\n");
}

function summarizeOperatorReflectionContext(context: OperatorReflectionContext) {
  return {
    dateRange: {
      start: context.dateRange.start,
      end: context.dateRange.end
    },
    counts: context.counts,
    completedActions: context.completedActions.map((action) => ({ id: action.id, title: action.title, goalId: action.goalId })),
    overdueActions: context.overdueActions.map((action) => ({ id: action.id, title: action.title, dueAt: action.dueAt?.toISOString() })),
    snoozedOrRescheduledActions: context.snoozedOrRescheduledActions.map((action) => ({ id: action.id, title: action.title, snoozedUntil: action.snoozedUntil?.toISOString() })),
    guardrailEvents: context.guardrailEvents.map((event) => ({ id: event.id, type: event.type, timestamp: event.timestamp.toISOString() })),
    goalsWithoutProgress: context.goalsWithoutProgress.map((goal) => ({ id: goal.id, title: goal.title, priority: goal.priority }))
  };
}

function groupActionsByGoalOrKeyword(actions: ActionItem[]): Map<string, ActionItem[]> {
  const groups = new Map<string, ActionItem[]>();

  for (const action of actions) {
    const key = action.goalTitleSnapshot ?? firstMeaningfulActionToken(action.title) ?? action.title;
    const existing = groups.get(key) ?? [];
    groups.set(key, [...existing, action]);
  }

  return groups;
}

function firstMeaningfulActionToken(title: string): string | undefined {
  return normalizeForComparison(title)
    .split(" ")
    .find((token) => token.length >= 4 && !["write", "review", "check", "send", "call", "make"].includes(token));
}

function daysOverdueForAction(action: ActionItem, context: OperatorReflectionContext): number {
  if (!action.dueAt) {
    return 0;
  }

  return daysBetweenLocalDates(formatDateInTimezone(action.dueAt, context.timezone), context.dateRange.end);
}

function reflectionDateRangeEvidence(context: OperatorReflectionContext) {
  return {
    start: context.dateRange.start,
    end: context.dateRange.end
  };
}

function sanitizeOperatorReflectionEvidence(evidence: Record<string, unknown>): Record<string, unknown> {
  return {
    actionIds: arrayOfStrings(evidence.actionIds).slice(0, 10),
    eventIds: arrayOfStrings(evidence.eventIds).slice(0, 20),
    goalIds: arrayOfStrings(evidence.goalIds).slice(0, 10),
    dateRange: isRecord(evidence.dateRange) ? evidence.dateRange : undefined,
    counts: isRecord(evidence.counts) ? evidence.counts : undefined
  };
}

function mergeReflectionCandidates(candidates: OperatorReflectionCandidate[]): OperatorReflectionCandidate[] {
  const seen = new Set<string>();
  const merged: OperatorReflectionCandidate[] = [];

  for (const candidate of candidates) {
    const key = `${candidate.type}:${normalizeForComparison(candidate.title)}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    merged.push(candidate);
  }

  return merged;
}

function isOperatorReflectionType(value: string): value is OperatorReflectionType {
  return ["pattern", "preference", "friction", "guardrail_pattern", "goal_strategy", "stale_goal"].includes(value);
}

async function syncGmailForConversation(userId: string): Promise<string> {
  const allGmailConnections = (await getIntegrationConnections(userId)).filter(
    (connection) => connection.integrationId === "gmail" && connection.status !== "archived"
  );
  const gmailConnections = allGmailConnections.filter((connection) => connection.status === "active");

  if (gmailConnections.length === 0) {
    const erroredConnection = allGmailConnections.find((connection) => connection.status === "error");
    if (erroredConnection) {
      return safeGmailErrorMessage(erroredConnection.lastError ?? "Gmail authorization expired. Reconnect Gmail.");
    }

    return "Gmail is not connected yet. Say 'connect Gmail' or use /connect_gmail.";
  }

  const replies: string[] = [];
  let noRuleConnections = 0;

  for (const connection of gmailConnections) {
    const rules = await getActiveEmailSignalRulesForConnection(userId, connection.id);

    if (rules.length === 0) {
      noRuleConnections += 1;
      continue;
    }

    const result = await syncGmailConnection(connection);
    replies.push(formatConversationGmailSyncResult(result));
  }

  if (replies.length === 0) {
    return appendPendingEmailReviewLine(noActiveGmailRulesMessage(), await getPendingEmailReviewCount(userId));
  }

  return dedupeLines(replies).join("\n\n");
}

async function gmailSyncDebugForConversation(userId: string): Promise<string> {
  const gmailConnections = (await getIntegrationConnections(userId))
    .filter((connection) => connection.integrationId === "gmail" && connection.status !== "archived")
    .sort((a, b) => (b.lastSyncedAt?.getTime() ?? 0) - (a.lastSyncedAt?.getTime() ?? 0));
  const connection = gmailConnections.find((candidate) => candidate.status === "active") ?? gmailConnections[0];

  if (!connection) {
    return "Gmail is not connected yet. Say 'connect Gmail' or use /connect_gmail.";
  }

  const diagnostics = readGmailLastSyncDiagnostics(connection.config);
  if (!diagnostics) {
    return "I do not have a Gmail sync debug summary yet. Say \"sync Gmail\" first.";
  }

  return formatGmailLastSyncDiagnostics(diagnostics);
}

/**
 * fix/private-alpha-email-review-detail-and-general-mail-understanding (Part 1 audit finding): the
 * ONLY place a pending EmailReviewItem's real Gmail content is ever refetched — everything stored
 * on the row itself at creation time is a short snippet plus a mostly-header evidence prefix, never
 * enough for a real "explain this email" answer. Reuses the exact same readonly token/fetch
 * machinery syncEmailSignalRule already relies on (getValidGmailAccessToken, getGmailMessage with
 * format=full) — never a new scope, never a write call. Registered as the
 * refetchGmailReviewContentForUser agent-runtime service (see services.ts) so executor.ts, which
 * cannot import server.ts's private Gmail/OAuth functions directly, can still reach this.
 */
async function refetchGmailReviewContentForConversation(userId: string, review: EmailReviewItem): Promise<RefetchGmailReviewContentResult> {
  try {
    const connection = await getIntegrationConnection(userId, review.connectionId);
    if (!connection) {
      return { status: "error", message: "I can't refetch that email — the Gmail connection it came from no longer exists." };
    }

    const accessToken = await getValidGmailAccessToken(connection);
    const message = await getGmailMessage(accessToken, review.providerMessageId);
    const decoded = decodeGmailBodyDetailed(message.payload);

    return {
      status: "ok",
      content: {
        subject: getGmailHeader(message, "subject") || review.subject || "",
        from: getGmailHeader(message, "from") || review.from || "",
        date: getGmailHeader(message, "date") || "",
        rawBodyText: decoded.text || message.snippet || review.snippet || review.evidence || "",
        isHtml: decoded.isHtml
      }
    };
  } catch (error) {
    return { status: "error", message: safeGmailErrorMessage(error) };
  }
}

async function syncIntegrationsForConversation(userId: string): Promise<string> {
  const connections = (await getIntegrationConnections(userId)).filter(
    (connection) =>
      connection.status === "active" &&
      (connection.integrationId === "gmail" || connection.integrationId === "github_public")
  );

  if (connections.length === 0) {
    return "No active integrations to sync. Connect Gmail or GitHub first.";
  }

  const replies: string[] = [];
  let noRuleGmailConnections = 0;

  for (const connection of connections) {
    if (connection.integrationId === "gmail") {
      const rules = await getActiveEmailSignalRulesForConnection(userId, connection.id);

      if (rules.length === 0) {
        noRuleGmailConnections += 1;
        continue;
      }

      replies.push(formatConversationGmailSyncResult(await syncGmailConnection(connection)));
      continue;
    }

    replies.push(formatConversationGithubSyncResult(await syncGithubPublicConnection(connection)));
  }

  if (replies.length === 0 && noRuleGmailConnections > 0) {
    return appendPendingEmailReviewLine(noActiveGmailRulesMessage(), await getPendingEmailReviewCount(userId));
  }

  return dedupeLines(replies).join("\n\n");
}

function formatConversationGmailSyncResult(result: {
  status: "success" | "error";
  emailSummaries?: EmailRuleSyncSummary[];
  emailRuleDiagnostics?: EmailRuleDiagnostics;
  pendingEmailReviewCount?: number;
  error?: string;
}): string {
  if (result.status === "error") {
    const safeError = safeGmailErrorMessage(result.error);
    if (
      safeError.includes("Gmail token encryption key is missing") ||
      safeError.includes("Gmail authorization expired") ||
      safeError.includes("Gmail token could not be read/decrypted") ||
      safeError.startsWith("Gmail sync failed:")
    ) {
      return safeError;
    }

    return `Gmail sync failed: ${safeError}`;
  }

  if ((result.emailSummaries?.length ?? 0) === 0 && result.emailRuleDiagnostics?.activeRulesForConnection === 0) {
    return appendPendingEmailReviewLine(noActiveGmailRulesMessage(), result.pendingEmailReviewCount ?? 0);
  }

  const totals = gmailSyncTotals(result.emailSummaries ?? []);
  // Only switch to the job-search-specific "Found: ..." breakdown when EVERY rule synced this
  // call is the job-search rule — a connection can mix job-search with work-action/custom rules
  // in one "sync Gmail" call, and that combined result isn't specifically about job search, so it
  // keeps the generic aggregate line instead of a breakdown implying job-search-only signals.
  const summaries = result.emailSummaries ?? [];
  const isJobSearchOnlySync = summaries.length > 0 && summaries.every((summary) => summary.adapterId === "job_search_email");
  return [
    formatGmailSyncTotalsForConversation(totals, isJobSearchOnlySync),
    pendingEmailReviewLine(result.pendingEmailReviewCount ?? 0)
  ].filter(Boolean).join("\n\n");
}

function formatGmailSyncTotalsForConversation(totals: ReturnType<typeof gmailSyncTotals>, isJobSearchOnlySync: boolean): string {
  const messagesChecked = totals.messagesFound + totals.aiMessagesChecked;

  if (isJobSearchOnlySync) {
    // fix/private-alpha-gmail-classifier-precision-and-proactive-diagnostics: a real transcript
    // showed "Found: - 5 interview emails" for five items that were ALL still-uncertain review
    // candidates, never logged or confirmed — signalCounts now ONLY ever reflects auto-logged
    // events (see syncEmailSignalRule's two increment sites), so this breakdown can never again
    // report a review-only item as a found/confirmed signal type. Uncertain items get a bare
    // count, deliberately never a per-type breakdown — "needs review" must never imply a specific
    // confirmed type (an offer/interview forced to review is exactly this case).
    const loggedBreakdown = formatJobSearchSignalBreakdown(totals.signalCounts);

    if (!loggedBreakdown && totals.reviewItemsCreated === 0) {
      return "I scanned Gmail with the job-search rule. No new job-search emails found.";
    }

    const lines = ["I scanned Gmail with the job-search rule."];

    if (loggedBreakdown) {
      lines.push("", "Logged clear items:", ...loggedBreakdown);
    } else {
      lines.push("", "No clear job-search events were logged.");
    }

    if (totals.reviewItemsCreated > 0) {
      lines.push(
        "",
        `${totals.reviewItemsCreated} email${totals.reviewItemsCreated === 1 ? "" : "s"} need${totals.reviewItemsCreated === 1 ? "s" : ""} review before I count ${totals.reviewItemsCreated === 1 ? "it" : "them"}.`
      );
    }

    return lines.join("\n");
  }

  if (totals.reviewItemsCreated > 0 && totals.eventsCreated > 0) {
    return `Gmail sync: ${messagesChecked} messages checked, ${totals.reviewItemsCreated} new review item${totals.reviewItemsCreated === 1 ? "" : "s"}, ${totals.eventsCreated} event${totals.eventsCreated === 1 ? "" : "s"} logged.`;
  }

  if (totals.reviewItemsCreated > 0) {
    return `Gmail sync: ${messagesChecked} messages checked, ${totals.reviewItemsCreated} new review item${totals.reviewItemsCreated === 1 ? "" : "s"}.`;
  }

  if (totals.eventsCreated > 0) {
    return `Gmail sync: ${messagesChecked} messages checked, ${totals.eventsCreated} event${totals.eventsCreated === 1 ? "" : "s"} logged.`;
  }

  return `Gmail sync: ${messagesChecked} messages checked, 0 new review items. Say "why did Gmail sync find nothing?" to see the skipped-message summary.`;
}

function readGmailLastSyncDiagnostics(config: unknown): GmailLastSyncDiagnostics | undefined {
  if (!isRecord(config) || !isRecord(config.gmailLastSyncDiagnostics)) {
    return undefined;
  }

  const diagnostics = config.gmailLastSyncDiagnostics;
  if (
    typeof diagnostics.checkedAt !== "string" ||
    typeof diagnostics.connectionId !== "string" ||
    (diagnostics.status !== "success" && diagnostics.status !== "error") ||
    !isRecord(diagnostics.summary)
  ) {
    return undefined;
  }

  return diagnostics as unknown as GmailLastSyncDiagnostics;
}

function formatGmailLastSyncDiagnostics(diagnostics: GmailLastSyncDiagnostics): string {
  const decisions = diagnostics.decisions.slice(0, 10).map((decision, index) => {
    const subject = decision.subject ? truncatePlainText(decision.subject, 90) : "(no subject)";
    const from = decision.from ? ` from ${truncatePlainText(decision.from, 70)}` : "";
    const labels = decision.labels?.length ? ` labels: ${decision.labels.join(",")}` : "";
    const outcome =
      decision.decision === "skipped"
        ? `skipped: ${decision.skipReason ?? "no active rule matched"}`
        : `${decision.decision.replace(/_/g, " ")}${decision.matchedRuleName ? `: ${decision.matchedRuleName}` : ""}`;

    return `${index + 1}. ${subject}${from} - ${outcome}${labels}`;
  });

  return [
    "Gmail sync debug",
    "",
    `Last sync: ${diagnostics.checkedAt}`,
    `Status: ${diagnostics.status}`,
    `Messages checked: ${diagnostics.summary.messagesChecked}`,
    `New review items: ${diagnostics.summary.reviewItemsCreated}`,
    `Events logged: ${diagnostics.summary.eventsCreated}`,
    `AI rule matcher: ${diagnostics.aiRuleMatcher}${diagnostics.aiRuleMatcherReason ? ` - ${diagnostics.aiRuleMatcherReason}` : ""}`,
    diagnostics.errorStage ? `Error stage: ${diagnostics.errorStage}` : undefined,
    diagnostics.error ? `Last error: ${safeGmailErrorMessage(diagnostics.error)}` : undefined,
    diagnostics.rules.length
      ? `Active rules: ${diagnostics.rules.map((rule) => rule.name).join(", ")}`
      : "Active rules: none",
    decisions.length ? "" : undefined,
    decisions.length ? "Recent checked messages:" : "No recent checked-message diagnostics were stored.",
    ...decisions
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function formatConversationGithubSyncResult(result: {
  status: "success" | "error";
  eventsCreated: number;
  personalCommitEvents: number;
  repoActivityEvents: number;
  repoSummaries?: Array<{ repo: string; personalCommitEvents: number; repoActivityEvents: number }>;
  error?: string;
}): string {
  if (result.status === "error") {
    return result.error ?? "Integration sync failed.";
  }

  if (result.repoSummaries && result.repoSummaries.length > 0) {
    return result.repoSummaries
      .map((summary) => {
        const kind =
          summary.personalCommitEvents > 0
            ? `${summary.personalCommitEvents} personal commit events`
            : `${summary.repoActivityEvents} repo activity events`;
        return `Synced github_public ${summary.repo}: ${kind}.`;
      })
      .join("\n");
  }

  return `Synced github_public: ${result.eventsCreated} new events.`;
}

function gmailSyncTotals(summaries: EmailRuleSyncSummary[]) {
  return summaries.reduce(
    (totals, summary) => ({
      messagesFound: totals.messagesFound + summary.messagesFound,
      aiMessagesChecked: totals.aiMessagesChecked + summary.aiMessagesChecked,
      processed: totals.processed + summary.processed,
      ignoredUnknown: totals.ignoredUnknown + summary.ignoredUnknown,
      deduped: totals.deduped + summary.deduped,
      semanticDeduped: totals.semanticDeduped + summary.semanticDeduped,
      needsReview: totals.needsReview + summary.needsReview,
      llmClassified: totals.llmClassified + summary.llmClassified,
      llmUnavailable: totals.llmUnavailable + summary.llmUnavailable,
      llmErrors: totals.llmErrors + summary.llmErrors,
      llmNeedsReview: totals.llmNeedsReview + summary.llmNeedsReview,
      llmIgnored: totals.llmIgnored + summary.llmIgnored,
      aiRuleMatches: totals.aiRuleMatches + summary.aiRuleMatches,
      aiRuleMatchSkipped: totals.aiRuleMatchSkipped + summary.aiRuleMatchSkipped,
      aiRuleMatchUnavailable: totals.aiRuleMatchUnavailable + summary.aiRuleMatchUnavailable,
      aiRuleMatchErrors: totals.aiRuleMatchErrors + summary.aiRuleMatchErrors,
      reviewItemsCreated: totals.reviewItemsCreated + summary.reviewItemsCreated,
      reviewItemsAlreadyPending: totals.reviewItemsAlreadyPending + summary.reviewItemsAlreadyPending,
      reviewItemsRejectedDeduped: totals.reviewItemsRejectedDeduped + summary.reviewItemsRejectedDeduped,
      reviewItemsSemanticDeduped: totals.reviewItemsSemanticDeduped + summary.reviewItemsSemanticDeduped,
      lowConfidenceIgnored: totals.lowConfidenceIgnored + summary.lowConfidenceIgnored,
      archivedCleanupReprocessed: totals.archivedCleanupReprocessed + summary.archivedCleanupReprocessed,
      skippedDueMaxEventsPerSync: totals.skippedDueMaxEventsPerSync + summary.skippedDueMaxEventsPerSync,
      eventsCreated: totals.eventsCreated + summary.eventsCreated,
      suppressedRepeatSender: totals.suppressedRepeatSender + summary.suppressedRepeatSender,
      signalCounts: mergeSignalCounts(totals.signalCounts, summary.signalCounts),
      reviewSignalCounts: mergeSignalCounts(totals.reviewSignalCounts, summary.reviewSignalCounts)
    }),
    {
      messagesFound: 0,
      aiMessagesChecked: 0,
      processed: 0,
      ignoredUnknown: 0,
      deduped: 0,
      semanticDeduped: 0,
      needsReview: 0,
      llmClassified: 0,
      llmUnavailable: 0,
      llmErrors: 0,
      llmNeedsReview: 0,
      llmIgnored: 0,
      aiRuleMatches: 0,
      aiRuleMatchSkipped: 0,
      aiRuleMatchUnavailable: 0,
      aiRuleMatchErrors: 0,
      reviewItemsCreated: 0,
      reviewItemsAlreadyPending: 0,
      reviewItemsRejectedDeduped: 0,
      reviewItemsSemanticDeduped: 0,
      lowConfidenceIgnored: 0,
      archivedCleanupReprocessed: 0,
      skippedDueMaxEventsPerSync: 0,
      eventsCreated: 0,
      suppressedRepeatSender: 0,
      signalCounts: {} as Record<string, number>,
      reviewSignalCounts: {} as Record<string, number>
    }
  );
}

function mergeSignalCounts(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const merged: Record<string, number> = { ...a };
  for (const [key, count] of Object.entries(b)) {
    merged[key] = (merged[key] ?? 0) + count;
  }
  return merged;
}

/** Ordered career.* eventTypes surfaced in the job-search "sync Gmail" reply breakdown, paired
 * with singular/plural labels — kept local to this reply-formatting layer rather than reusing
 * agent-runtime/executor.ts's EVENT_COUNT_LABELS, since that table's wording (e.g. "interview
 * scheduled") is tuned for goal-progress sentences, not this "Found: - N interview emails" list. */
const JOB_SEARCH_SIGNAL_ORDER: Array<[eventType: string, singular: string, plural: string]> = [
  ["career.recruiter_reply_received", "recruiter reply", "recruiter replies"],
  ["career.application_confirmation_received", "application confirmation", "application confirmations"],
  ["career.interview_scheduled", "interview email", "interview emails"],
  ["career.rejection_received", "rejection email", "rejection emails"],
  ["career.offer_received", "offer email", "offer emails"]
];

const JOB_SEARCH_SIGNAL_EVENT_TYPES = new Set(JOB_SEARCH_SIGNAL_ORDER.map(([eventType]) => eventType));

function formatJobSearchSignalBreakdown(signalCounts: Record<string, number>): string[] | undefined {
  const total = Object.values(signalCounts).reduce((sum, count) => sum + count, 0);
  if (total === 0) {
    return undefined;
  }

  return JOB_SEARCH_SIGNAL_ORDER.map(([eventType, singular, plural]) => {
    const count = signalCounts[eventType] ?? 0;
    return `- ${count} ${count === 1 ? singular : plural}`;
  });
}

function dedupeLines(lines: string[]): string[] {
  return [...new Set(lines.filter((line) => line.trim().length > 0))];
}

export async function buildConversationControlDebugForUser(userId: string, text: string) {
  const [actions, goals] = await Promise.all([getActionItems(userId, { status: "all", limit: 100 }), getActiveGoals(userId)]);

  return buildConversationControlDebug({
    text,
    actions: actions.map(toActionSummary),
    goals: goals.map(toGoalSummary)
  });
}

async function handleConversationControl(
  userId: string,
  text: string,
  options: { now?: Date; debug?: Awaited<ReturnType<typeof buildConversationControlDebugForUser>> } = {}
): Promise<ConversationControlResponse> {
  const detection = detectConversationControlIntent(text);
  const debug = options.debug ?? (await buildConversationControlDebugForUser(userId, text));

  if (shouldDeferConversationControlToMessageProcessor(text, detection)) {
    return {
      handled: false,
      debug: {
        ...debug,
        reason: "Message looks like Gmail/email-rule management or contextual reset; defer to message processor."
      }
    };
  }

  if (detection.intent === "unknown" || detection.intent === "goal_guardrail") {
    return {
      handled: false,
      debug
    };
  }

  if (detection.intent === "show_today") {
    const brief = await generateDailyOperatorBrief(userId, { now: options.now });
    return {
      handled: true,
      reply: formatConversationTodayReply(brief),
      brief,
      debug
    };
  }

  if (detection.intent === "ask_next_move") {
    const brief = await generateDailyOperatorBrief(userId, { now: options.now });
    return {
      handled: true,
      reply: brief.suggestedNextStep,
      brief,
      debug
    };
  }

  if (detection.intent === "show_actions") {
    const actions = await getActionItems(userId, { status: "open", limit: 10 });
    return {
      handled: true,
      reply: actions.length > 0 ? actions.map((action) => `- ${action.title}`).join("\n") : "No open action items.",
      actions: actions.map(sanitizeActionItem),
      debug
    };
  }

  if (detection.intent === "set_goal_priority") {
    const activeGoals = await getActiveGoals(userId);
    const goalResolution = resolveGoalReference(detection.goalText ?? "", activeGoals.map(toGoalSummary));

    if (!goalResolution.goalId || goalResolution.confidence < 0.75 || goalResolution.ambiguousMatches.length > 0 || !detection.priority) {
      return {
        handled: true,
        reply: formatGoalClarificationReply(goalResolution),
        debug
      };
    }

    const updated = await updateGoalPriority(userId, goalResolution.goalId, {
      priority: detection.priority,
      priorityReason: "natural priority update"
    });

    return {
      handled: true,
      reply: updated ? `Goal priority updated: ${updated.title} -> ${updated.priority}` : "Active goal not found.",
      goal: updated,
      debug
    };
  }

  const actions = await getActionItems(userId, { status: "all", limit: 100 });
  const actionResolution = resolveActionReference(userId, detection.targetText ?? "", actions.map(toActionSummary));

  if (!actionResolution.actionId || actionResolution.confidence < 0.8 || actionResolution.ambiguousMatches.length > 0) {
    const completedResolution =
      detection.intent === "complete_action"
        ? resolveActionReference(
            userId,
            detection.targetText ?? "",
            actions.filter((action) => action.status === "completed").map(toActionSummary),
            { includeCompleted: true }
          )
        : undefined;

    if (completedResolution?.resolvedAction && completedResolution.confidence >= 0.8) {
      return {
        handled: true,
        reply: `Action already completed: ${completedResolution.resolvedAction.title}`,
        action: completedResolution.resolvedAction,
        debug
      };
    }

    if (actionResolution.ambiguousMatches.length > 0) {
      const pending = await createActionTargetClarification(userId, detection, actionResolution, options.now);

      return {
        handled: true,
        reply: formatActionTargetClarificationReply(pending.candidates, pending.timezone),
        debug: {
          ...debug,
          requiresConfirmation: true
        }
      };
    }

    return {
      handled: true,
      reply: formatActionClarificationReply(actionResolution),
      debug
    };
  }

  if (detection.intent === "complete_action") {
    const existingAction = await getActionItem(userId, actionResolution.actionId);

    if (existingAction?.status === "completed") {
      return {
        handled: true,
        reply: `Action already completed: ${existingAction.title}`,
        action: sanitizeActionItem(existingAction),
        debug
      };
    }

    const completed = await completeActionItem(userId, actionResolution.actionId);

    if (!completed) {
      return {
        handled: true,
        reply: "I could not find that open action.",
        debug
      };
    }

    const progressEvent = await createGoalProgressFromCompletedAction(userId, completed);

    return {
      handled: true,
      reply: [
        `Action completed: ${completed.title}`,
        progressEvent?.created ? `Goal progress logged: ${progressEvent.goalTitle}` : undefined
      ]
        .filter(Boolean)
        .join("\n"),
      action: sanitizeActionItem(completed),
      debug
    };
  }

  if (detection.intent === "archive_action") {
    const action = actionResolution.resolvedAction;
    await replacePendingAction(userId, {
      type: "action_archive",
      summary: `Archive action: ${action?.title ?? actionResolution.actionId}`,
      payload: {
        originalText: text,
        intendedOperation: "archive_action",
        actionId: actionResolution.actionId,
        candidateActions: action ? [toPendingActionCandidate(action)] : []
      },
      expiresAt: pendingDecisionExpiry()
    });

    return {
      handled: true,
      reply: `Confirm archive action: ${action?.title ?? actionResolution.actionId}? Reply yes to confirm or no to cancel.`,
      action,
      debug: {
        ...debug,
        requiresConfirmation: true
      }
    };
  }

  if (detection.intent === "snooze_action" || detection.intent === "reschedule_action") {
    const settings = await getOrCreateNotificationSettings(userId);
    const parsedTime = parseConversationControlTime(detection.timeText ?? "", {
      now: options.now,
      timezone: settings.timezone,
      preferences: settings
    });

    if (parsedTime.invalidReason === "past_explicit_time") {
      return {
        handled: true,
        reply:
          detection.intent === "snooze_action"
            ? "That snooze time has already passed."
            : "That time has already passed. Use a future time, or say 'now'.",
        debug
      };
    }

    if (!parsedTime.dueAt) {
      return {
        handled: true,
        reply: "I could not parse the new time. Try: tomorrow afternoon, 6pm, or Monday morning.",
        debug
      };
    }

    const updated =
      detection.intent === "snooze_action"
        ? await snoozeActionItem(userId, actionResolution.actionId, parsedTime.dueAt)
        : await rescheduleActionItem(userId, actionResolution.actionId, parsedTime.dueAt);

    if (!updated) {
      return {
        handled: true,
        reply: "I could not update that action.",
        debug
      };
    }

    return {
      handled: true,
      reply:
        detection.intent === "snooze_action"
          ? `Action snoozed until ${formatLocalDateTime(updated.snoozedUntil, settings.timezone)}: ${updated.title}`
          : [`Action rescheduled: ${updated.title}`, `due: ${formatLocalDateTime(updated.dueAt, settings.timezone)}`].join("\n"),
      action: sanitizeActionItem(updated),
      debug
    };
  }

  return {
    handled: false,
    debug
  };
}

async function executeMultiIntentPlan(
  userId: string,
  originalText: string,
  plan: ConversationIntentPlan,
  options: { now?: Date } = {}
): Promise<{ reply: string }> {
  const done: string[] = [];
  const skipped: string[] = [];
  const readouts: string[] = [];
  const confirmations: string[] = [];

  if (plan.intents.some((intent) => intent.type === "goal_guardrail" && intent.blockedByGuardrail)) {
    return {
      reply: await executeGuardrailMessage(userId, originalText)
    };
  }

  for (const intent of plan.intents) {
    if (intent.type === "unknown") {
      skipped.push(`Could not confidently handle "${intent.textSpan}".`);
      continue;
    }

    if (intent.confidence < 0.7) {
      skipped.push(`Low confidence for "${intent.textSpan}".`);
      continue;
    }

    if (intent.type === "event_log") {
      const events = await createEventsFromExtracted(userId, extractEvents(intent.textSpan));

      if (events.length === 0) {
        skipped.push(`No concrete event found in "${intent.textSpan}".`);
        continue;
      }

      done.push(...events.map(formatMultiIntentEventDone));
      continue;
    }

    if (intent.type === "action_create") {
      const actionResult = await maybeCreateManualActionFromText(userId, intent.textSpan);

      if (!actionResult.extraction.shouldCreateAction) {
        skipped.push(`Could not create action from "${intent.textSpan}".`);
        continue;
      }

      if (actionResult.action) {
        done.push(
          actionResult.duplicate
            ? `Action already exists: ${actionResult.action.title}.`
            : `Created action: ${actionResult.action.title}.`
        );
      } else {
        skipped.push(`Could not create action from "${intent.textSpan}".`);
      }
      continue;
    }

    if (
      intent.type === "complete_action" ||
      intent.type === "reschedule_action" ||
      intent.type === "archive_action" ||
      intent.type === "set_goal_priority"
    ) {
      const debug = await buildConversationControlDebugForUser(userId, intent.textSpan);
      const control = await handleConversationControl(userId, intent.textSpan, { now: options.now, debug });

      if (!control.handled) {
        skipped.push(`Could not handle "${intent.textSpan}".`);
        continue;
      }

      if (control.reply?.startsWith("Which action do you mean?") || control.reply?.startsWith("Confirm archive action:")) {
        confirmations.push(control.reply);
        break;
      }

      if (control.reply?.startsWith("I could not") || control.reply?.startsWith("That time has already passed")) {
        skipped.push(control.reply);
        continue;
      }

      done.push(control.reply ?? "Done.");
      continue;
    }

    if (intent.type === "show_actions") {
      const actions = await getActionItems(userId, { status: "open", limit: 10 });
      readouts.push(actions.length > 0 ? ["Open actions:", ...actions.map((action) => `- ${action.title}`)].join("\n") : "No open action items.");
      continue;
    }

    if (intent.type === "show_goal_priorities") {
      readouts.push(formatGoalPrioritiesForConversation(await getActiveGoals(userId)));
      continue;
    }

    if (intent.type === "show_today") {
      readouts.push(formatConversationTodayReply(await generateDailyOperatorBrief(userId, { now: options.now })));
      continue;
    }

    if (intent.type === "ask_next_move") {
      const brief = await generateDailyOperatorBrief(userId, { now: options.now });
      readouts.push(`Next move: ${brief.suggestedNextStep}`);
      continue;
    }

    skipped.push(`Skipped "${intent.textSpan}".`);
  }

  return {
    reply: formatMultiIntentExecutionReply({ done, skipped, confirmations, readouts })
  };
}

async function executeGuardrailMessage(userId: string, message: string): Promise<string> {
  const [recentEvents, activeGoals, activeMemories, userOperatingProfile] = await Promise.all([
    getRecentEvents(userId, 50),
    getActiveGoals(userId),
    getActiveMemories(userId),
    getOrCreateUserOperatingProfile(userId)
  ]);
  const result = withMemoryContextReply(
    processMessage({
      userId,
      message,
      recentEvents,
      userOperatingProfile
    }),
    activeMemories
  );
  const guardrail = evaluateGoalGuardrails({ text: result.message, activeGoals });
  const cooldownEvent = await createEvent(result.userId, {
    type: "finance.betting.cooldown_triggered",
    timestamp: new Date(),
    source: "manual",
    data: {
      intent: result.intent,
      reason: "multi_intent_guardrail",
      guardrail: guardrail.triggered
        ? {
            goalId: guardrail.goalId,
            goalTitle: guardrail.goalTitle,
            category: guardrail.guardrailCategory,
            severity: guardrail.severity,
            responseMode: guardrail.responseMode,
            blockedActionCreation: guardrail.blockedActionCreation,
            cooldownRequired: guardrail.cooldownRequired,
            reason: guardrail.reason
          }
        : undefined
    },
    confidence: 1,
    evidence: [result.message]
  });
  const composed = await composeFinalAgentResponse(
    {
      ...result,
      riskState: "RED"
    },
    { extractedEvents: [cooldownEvent] }
  );

  return composed.reply;
}

async function buildIntentPlanDebug(userId: string, plan: ConversationIntentPlan) {
  const [actions, goals] = await Promise.all([getRecentActionItems(userId, 50), getActiveGoals(userId)]);

  return plan.intents.map((intent) => {
    const controlDebug =
      intent.type === "complete_action" ||
      intent.type === "reschedule_action" ||
      intent.type === "archive_action" ||
      intent.type === "set_goal_priority"
        ? buildConversationControlDebug({
            text: intent.textSpan,
            actions: actions.map(toActionSummary),
            goals: goals.map(toGoalSummary)
          })
        : undefined;

    return {
      ...intent,
      wouldExecute: plan.isMultiIntent && intent.type !== "unknown" && !intent.blockedByGuardrail && intent.confidence >= 0.7,
      requiresConfirmation: intent.requiresConfirmation ?? controlDebug?.requiresConfirmation ?? false,
      blockedByGuardrail: intent.blockedByGuardrail ?? false,
      resolvedAction: controlDebug?.resolvedAction,
      ambiguousActions: controlDebug?.ambiguousActions,
      resolvedGoal: controlDebug?.resolvedGoal,
      ambiguousGoals: controlDebug?.ambiguousGoals
    };
  });
}

function formatMultiIntentExecutionReply(input: {
  done: string[];
  skipped: string[];
  confirmations: string[];
  readouts: string[];
}): string {
  const sections: string[] = [];

  if (input.done.length > 0) {
    sections.push(["Done:", ...input.done.map((item) => `- ${item}`)].join("\n"));
  }

  if (input.skipped.length > 0) {
    sections.push(["Skipped:", ...input.skipped.map((item) => `- ${item}`)].join("\n"));
  }

  if (input.confirmations.length > 0) {
    sections.push(["Needs confirmation:", ...input.confirmations.map((item) => `- ${item}`)].join("\n"));
  }

  sections.push(...input.readouts);

  return sections.length > 0 ? sections.join("\n\n") : "I could not confidently execute anything from that message.";
}

function formatMultiIntentEventDone(event: StoredEvent): string {
  if (event.type === "career.application_sent" && typeof event.data.count === "number") {
    return `Logged ${event.data.count} job application${event.data.count === 1 ? "" : "s"}.`;
  }

  if (event.type === "health.workout_completed" && typeof event.data.duration_minutes === "number") {
    return `Logged ${event.data.duration_minutes} min training.`;
  }

  if (event.type === "learning.reading_session_completed" && typeof event.data.duration_minutes === "number") {
    return `Logged ${event.data.duration_minutes} min reading.`;
  }

  return `Logged ${event.type}.`;
}

function formatGoalPrioritiesForConversation(goals: Goal[]): string {
  const activeGoals = goals.filter((goal) => goal.status === "active");

  if (activeGoals.length === 0) {
    return "No active goals.";
  }

  return [
    "Goal priorities:",
    ...activeGoals.map((goal, index) => `${index + 1}. ${goal.title} - ${goal.priority ?? "medium"} (${goal.importanceScore ?? 25})`)
  ].join("\n");
}

function toActionSummary(action: ActionItem) {
  return {
    id: action.id,
    title: action.title,
    status: action.status,
    dueAt: action.dueAt,
    snoozedUntil: action.snoozedUntil,
    goalId: action.goalId,
    goalTitleSnapshot: action.goalTitleSnapshot,
    project: action.project,
    actionType: action.actionType,
    evidence: action.evidence
  };
}

function toGoalSummary(goal: Goal): GoalSummary {
  return {
    id: goal.id,
    title: goal.title,
    status: goal.status,
    category: goal.category,
    templateId: goal.templateId
  };
}

function formatActionClarificationReply(resolution: ReturnType<typeof resolveActionReference>): string {
  if (resolution.ambiguousMatches.length > 0) {
    return [
      "Which action do you mean?",
      ...resolution.ambiguousMatches.slice(0, 5).map((action) => `- ${action.title} (${action.id})`)
    ].join("\n");
  }

  return "I could not confidently match that to an open action. Use /actions to check the exact one.";
}

async function createActionTargetClarification(
  userId: string,
  detection: ReturnType<typeof detectConversationControlIntent>,
  resolution: ReturnType<typeof resolveActionReference>,
  now?: Date
): Promise<{ candidates: PendingActionCandidate[]; timezone: string }> {
  const settings = await getOrCreateNotificationSettings(userId);
  const candidates = resolution.ambiguousMatches
    .map(toPendingActionCandidate)
    .sort(comparePendingActionCandidates)
    .slice(0, 5);
  let parsedDueAt: string | undefined;

  if (detection.intent === "snooze_action" || detection.intent === "reschedule_action") {
    const parsedTime = parseConversationControlTime(detection.timeText ?? "", {
      now,
      timezone: settings.timezone,
      preferences: settings
    });

    parsedDueAt = parsedTime.dueAt?.toISOString();
  }

  await replacePendingAction(userId, {
    type: "action_target_clarification",
    summary: `Clarify action target: ${detection.targetText ?? "action"}`,
    payload: {
      originalText: detection.targetText,
      intendedOperation: detection.intent,
      candidateActions: candidates,
      selectedTimeText: detection.timeText,
      parsedDueAt
    },
    expiresAt: pendingDecisionExpiry()
  });

  return { candidates, timezone: settings.timezone };
}

function formatActionTargetClarificationReply(candidates: PendingActionCandidate[], timezone = "Europe/Madrid"): string {
  return [
    "Which action do you mean?",
    ...candidates.map((action, index) => `${index + 1}. ${formatPendingActionCandidate(action, timezone)}`),
    `Reply 1-${candidates.length}, or 'cancel'.`
  ].join("\n");
}


function formatGoalClarificationReply(resolution: ReturnType<typeof resolveGoalReference>): string {
  if (resolution.ambiguousMatches.length > 0) {
    return [
      "Which goal do you mean?",
      ...resolution.ambiguousMatches.slice(0, 5).map((goal) => `- ${goal.title} (${goal.id})`)
    ].join("\n");
  }

  return "I could not confidently match that to an active goal. Use /goal_priorities to check the exact one.";
}

function findGoalBySelector<T extends { id: string; title: string }>(goals: T[], selector: string): T | undefined {
  const trimmed = selector.trim().replace(/^["']|["']$/g, "");
  const numericIndex = Number(trimmed);

  if (Number.isInteger(numericIndex) && numericIndex >= 1 && numericIndex <= goals.length) {
    return goals[numericIndex - 1];
  }

  const normalizedSelector = normalizeManualActionTitleKey(trimmed);
  return goals.find((goal) => goal.id === trimmed || normalizeManualActionTitleKey(goal.title) === normalizedSelector);
}

function formatLocalDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function dispatchActionRemindersForUser(userId: string, now: Date): Promise<ActionReminderDispatch[]> {
  const settings = await getOrCreateNotificationSettings(userId);
  const candidates = await getActionItemsEligibleForReminder({
    userId,
    now,
    limit: 20
  });
  const reminders: ActionReminderDispatch[] = [];

  for (const candidate of candidates) {
    const message = formatActionReminderMessage(candidate.actionItem, candidate.reminderType, settings.timezone);

    await createActionItemReminderLog({
      userId,
      actionItemId: candidate.actionItem.id,
      reminderType: candidate.reminderType,
      sentAt: now
    });

    if (candidate.reminderType === "snoozed") {
      await createActionItemReminderLog({
        userId,
        actionItemId: candidate.actionItem.id,
        reminderType: "due",
        sentAt: now
      });
      await reopenSnoozedActionItem(userId, candidate.actionItem.id);
    }

    reminders.push({
      actionItem: sanitizeActionItem(candidate.actionItem),
      reminderType: candidate.reminderType,
      message
    });
  }

  return reminders;
}

function formatActionReminderMessage(actionItem: ActionItem, reminderType: ActionItemReminderType, timezone = "Europe/Madrid"): string {
  const isOverdue = reminderType === "due" && Boolean(actionItem.dueAt && actionItem.dueAt < new Date());
  const header = reminderType === "snoozed" ? "Snoozed action is back:" : isOverdue ? "Action overdue:" : "Action due:";
  const dueLine = actionItem.dueAt ? `due: ${formatLocalDateTime(actionItem.dueAt, timezone)}` : undefined;

  return [
    header,
    actionItem.title,
    dueLine,
    `complete: /complete_action ${actionItem.id}`,
    `snooze tomorrow: /snooze_action ${actionItem.id} tomorrow`,
    `archive: /archive_action ${actionItem.id}`
  ]
    .filter(Boolean)
    .join("\n");
}

function shouldDeferConversationControlToMessageProcessor(
  message: string,
  detection: ReturnType<typeof detectConversationControlIntent>
): boolean {
  const text = normalizeForComparison(message);

  if (!text) {
    return false;
  }

  if (looksLikeEmailRuleOrGmailConversationText(text)) {
    return true;
  }

  if (detection.intent === "archive_action" && looksLikeBulkPronounResetRequest(text)) {
    return true;
  }

  return false;
}

function looksLikeBulkPronounResetRequest(text: string): boolean {
  return (
    /\b(delete|remove|clear|archive|reset|elimina|eliminar|borra|borrar)\b/.test(text) &&
    /\b(all|everything|every|them|em|all of them|all of em|todos|todas|totes|reset)\b/.test(text)
  );
}

async function syncGithubPublicConnection(connection: IntegrationConnection) {
  const startedAt = new Date();

  try {
    const config = parseGithubConnectionConfig(connection.config);
    let eventsCreated = 0;
    let personalCommitEvents = 0;
    let repoActivityEvents = 0;
    const repoSummaries = new Map<string, { repo: string; personalCommitEvents: number; repoActivityEvents: number }>();

    for (const repo of config.repos) {
      const commits = await fetchGithubCommits(repo.owner, repo.repo);

      for (const commit of commits) {
        const externalId = `github:${repo.owner}/${repo.repo}:commit:${commit.sha}`;
        const matchesAuthor = matchesGithubAuthor(commit, config.authorLogin);
        const shouldCreateCommit = Boolean(config.authorLogin && matchesAuthor);
        const shouldCreateRepoActivity = !shouldCreateCommit && config.includeRepoActivity;

        if (!shouldCreateCommit && !shouldCreateRepoActivity) {
          continue;
        }

        const eventType = shouldCreateCommit ? "coding.commit_created" : "coding.repo_activity_detected";
        const created = await createExternalEventIfNotExists(connection.userId, {
          type: eventType,
          timestamp: parseGithubCommitDate(commit) ?? new Date(),
          source: "github",
          provider: "github",
          externalId,
          data: githubCommitEventData(repo.owner, repo.repo, commit, externalId, shouldCreateCommit),
          confidence: shouldCreateCommit ? 0.95 : 0.8,
          evidence: [
            commit.commit.message.split("\n")[0] ?? "GitHub commit",
            `${repo.owner}/${repo.repo}`,
            commit.sha.slice(0, 7)
          ]
        });

        if (created.created) {
          eventsCreated += 1;
          const repoName = `${repo.owner}/${repo.repo}`;
          const repoSummary = repoSummaries.get(repoName) ?? {
            repo: repoName,
            personalCommitEvents: 0,
            repoActivityEvents: 0
          };

          if (eventType === "coding.commit_created") {
            personalCommitEvents += 1;
            repoSummary.personalCommitEvents += 1;
          } else {
            repoActivityEvents += 1;
            repoSummary.repoActivityEvents += 1;
          }

          repoSummaries.set(repoName, repoSummary);
        }
      }
    }

    await updateIntegrationConnectionSyncState(connection.userId, connection.id, {
      status: "active",
      lastSyncedAt: new Date(),
      lastError: null
    });

    const syncLog = await createIntegrationSyncLog({
      userId: connection.userId,
      connectionId: connection.id,
      integrationId: connection.integrationId,
      status: "success",
      startedAt,
      finishedAt: new Date(),
      eventsCreated
    });

    return {
      status: "success" as const,
      connectionId: connection.id,
      integrationId: connection.integrationId,
      eventsCreated,
      personalCommitEvents,
      repoActivityEvents,
      repoSummaries: [...repoSummaries.values()],
      syncLog
    };
  } catch (error) {
    const reason = shortErrorMessage(error);

    await updateIntegrationConnectionSyncState(connection.userId, connection.id, {
      status: "error",
      lastError: reason
    });

    const syncLog = await createIntegrationSyncLog({
      userId: connection.userId,
      connectionId: connection.id,
      integrationId: connection.integrationId,
      status: "error",
      startedAt,
      finishedAt: new Date(),
      eventsCreated: 0,
      error: reason
    });

    return {
      status: "error" as const,
      connectionId: connection.id,
      integrationId: connection.integrationId,
      eventsCreated: 0,
      personalCommitEvents: 0,
      repoActivityEvents: 0,
      repoSummaries: [],
      error: reason.includes(":") ? `GitHub sync failed for ${reason}` : `GitHub sync failed: ${reason}`,
      syncLog
    };
  }
}

async function syncGmailConnection(connection: IntegrationConnection) {
  const startedAt = new Date();
  const rules = dedupeActiveEmailRulesForSync(await getActiveEmailSignalRulesForConnection(connection.userId, connection.id));
  const emailRuleDiagnostics = await buildEmailRuleDiagnostics(connection, rules);
  let errorStage: GmailErrorStage | undefined;

  if (rules.length === 0) {
    const syncLog = await createIntegrationSyncLog({
      userId: connection.userId,
      connectionId: connection.id,
      integrationId: connection.integrationId,
      status: "success",
      startedAt,
      finishedAt: new Date(),
      eventsCreated: 0
    });

    return {
      status: "success" as const,
      connectionId: connection.id,
      integrationId: connection.integrationId,
      eventsCreated: 0,
      personalCommitEvents: 0,
      repoActivityEvents: 0,
      repoSummaries: [],
      emailSummaries: [],
      pendingEmailReviewCount: await getPendingEmailReviewCount(connection.userId),
      emailRuleDiagnostics,
      syncLog
    };
  }

  let eventsCreated = 0;
  const emailSummaries: EmailRuleSyncSummary[] = [];
  const processedMessageIds = new Set<string>();

  try {
    const accessToken = await getValidGmailAccessToken(connection);

    for (const rule of rules) {
      const ruleSummary = createEmailRuleSyncSummary(rule);

      try {
        Object.assign(ruleSummary, await syncEmailSignalRule({ userId: connection.userId, accessToken, rule, processedMessageIds }));
        eventsCreated += ruleSummary.eventsCreated;

        await updateEmailSignalRuleSyncState(connection.userId, rule.id, {
          lastSyncedAt: new Date(),
          lastError: null
        });

        emailSummaries.push(ruleSummary);
      } catch (error) {
        errorStage = gmailErrorStage(error);
        ruleSummary.lastError = safeGmailErrorMessage(error);
        ruleSummary.lastErrorStage = errorStage;
        console.error("Gmail rule sync failed", {
          connectionId: connection.id,
          ruleId: rule.id,
          stage: errorStage,
          error: ruleSummary.lastError
        });
        emailSummaries.push(ruleSummary);
        await updateEmailSignalRuleSyncState(connection.userId, rule.id, {
          lastError: safeGmailErrorMessage(error)
        });
        throw error;
      }
    }

    await withGmailStage("classification", () =>
      syncGmailRecentMessagesAgainstActiveRules({
        userId: connection.userId,
        connectionId: connection.id,
        accessToken,
        rules,
        summaries: emailSummaries,
        processedMessageIds
      })
    );

    await updateIntegrationConnectionSyncState(connection.userId, connection.id, {
      status: "active",
      lastSyncedAt: new Date(),
      lastError: null
    });

    await writeGmailLastSyncDiagnostics(connection, buildGmailLastSyncDiagnostics(connection, rules, emailSummaries, "success"));

    const syncLog = await createIntegrationSyncLog({
      userId: connection.userId,
      connectionId: connection.id,
      integrationId: connection.integrationId,
      status: "success",
      startedAt,
      finishedAt: new Date(),
      eventsCreated
    });

    return {
      status: "success" as const,
      connectionId: connection.id,
      integrationId: connection.integrationId,
      eventsCreated,
      personalCommitEvents: 0,
      repoActivityEvents: 0,
      repoSummaries: [],
      emailSummaries,
      pendingEmailReviewCount: await getPendingEmailReviewCount(connection.userId),
      emailRuleDiagnostics,
      syncLog
    };
  } catch (error) {
    const reason = safeGmailErrorMessage(error);
    errorStage = gmailErrorStage(error);
    const shouldMarkConnectionError = isGmailConnectionError(error);
    console.error("Gmail connection sync failed", {
      connectionId: connection.id,
      stage: errorStage,
      error: reason
    });

    await updateIntegrationConnectionSyncState(connection.userId, connection.id, {
      status: shouldMarkConnectionError ? "error" : undefined,
      lastError: reason
    });

    await writeGmailLastSyncDiagnostics(
      connection,
      buildGmailLastSyncDiagnostics(connection, rules, emailSummaries, "error", reason, errorStage)
    );

    const syncLog = await createIntegrationSyncLog({
      userId: connection.userId,
      connectionId: connection.id,
      integrationId: connection.integrationId,
      status: "error",
      startedAt,
      finishedAt: new Date(),
      eventsCreated,
      error: reason
    });

    return {
      status: "error" as const,
      connectionId: connection.id,
      integrationId: connection.integrationId,
      eventsCreated,
      personalCommitEvents: 0,
      repoActivityEvents: 0,
      repoSummaries: [],
      emailSummaries,
      pendingEmailReviewCount: await getPendingEmailReviewCount(connection.userId),
      emailRuleDiagnostics,
      error: reason,
      errorStage,
      syncLog
    };
  }
}

async function recordGmailBackgroundSyncAttempt(input: {
  userId: string;
  connectionId: string;
  attemptedAt: Date;
  status: "success" | "error";
  error?: string;
}): Promise<void> {
  const latestConnection = await getIntegrationConnection(input.userId, input.connectionId);

  if (!latestConnection || latestConnection.integrationId !== "gmail") {
    return;
  }

  await updateIntegrationConnectionConfig(
    input.userId,
    input.connectionId,
    writeGmailBackgroundSyncAttempt(latestConnection.config, {
      attemptedAt: input.attemptedAt,
      status: input.status,
      error: input.error
    })
  );
}

async function writeGmailLastSyncDiagnostics(connection: IntegrationConnection, diagnostics: GmailLastSyncDiagnostics): Promise<void> {
  const latestConnection = await getIntegrationConnection(connection.userId, connection.id);
  const config = isRecord(latestConnection?.config) ? { ...latestConnection.config } : isRecord(connection.config) ? { ...connection.config } : {};
  config.gmailLastSyncDiagnostics = JSON.parse(JSON.stringify(diagnostics)) as Record<string, unknown>;

  await updateIntegrationConnectionConfig(connection.userId, connection.id, config);
}

function buildGmailLastSyncDiagnostics(
  connection: IntegrationConnection,
  rules: EmailSignalRule[],
  summaries: EmailRuleSyncSummary[],
  status: "success" | "error",
  error?: string,
  errorStage?: GmailErrorStage
): GmailLastSyncDiagnostics {
  const totals = gmailSyncTotals(summaries);
  const aiRuleMatcher = gmailLastSyncAiRuleMatcherStatus(summaries);
  const decisions = summaries.flatMap((summary) => summary.syncDecisionDebug ?? []).slice(0, 20);

  return {
    checkedAt: new Date().toISOString(),
    connectionId: connection.id,
    status,
    aiRuleMatcher: aiRuleMatcher.status,
    aiRuleMatcherReason: aiRuleMatcher.reason,
    rules: rules.map((rule) => ({
      id: rule.id,
      name: rule.name,
      adapterId: rule.adapterId
    })),
    summary: {
      messagesChecked: totals.messagesFound + totals.aiMessagesChecked,
      processed: totals.processed,
      reviewItemsCreated: totals.reviewItemsCreated,
      eventsCreated: totals.eventsCreated,
      llmClassified: totals.llmClassified,
      llmUnavailable: totals.llmUnavailable,
      llmErrors: totals.llmErrors
    },
    decisions,
    error: error ? safeGmailErrorMessage(error) : undefined,
    errorStage
  };
}

function gmailLastSyncAiRuleMatcherStatus(summaries: EmailRuleSyncSummary[]): {
  status: GmailLastSyncDiagnostics["aiRuleMatcher"];
  reason?: string;
} {
  const totals = gmailSyncTotals(summaries);

  if (!gmailRuleMatchClassifierAvailable()) {
    return {
      status: "unavailable",
      reason: "AI rule matching unavailable; deterministic Gmail queries still ran."
    };
  }

  if (totals.aiRuleMatchErrors > 0 && totals.aiMessagesChecked > 0) {
    return {
      status: totals.aiRuleMatches > 0 || totals.aiRuleMatchSkipped > 0 ? "degraded" : "error",
      reason: "AI rule matching had errors for some checked messages."
    };
  }

  return { status: "available" };
}

function dedupeActiveEmailRulesForSync(rules: EmailSignalRule[]): EmailSignalRule[] {
  const seen = new Set<string>();
  const deduped: EmailSignalRule[] = [];

  for (const rule of rules) {
    const key = isBuiltInEmailAdapter(rule.adapterId)
      ? ["builtin", rule.connectionId, rule.adapterId, normalizeForComparison(rule.query ?? "")].join("|")
      : `rule:${rule.id}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push(rule);
  }

  return deduped;
}

async function buildEmailRuleDiagnostics(
  connection: IntegrationConnection,
  activeRules: EmailSignalRule[]
): Promise<EmailRuleDiagnostics> {
  const rules = await getEmailSignalRules(connection.userId);
  const rulesForConnection = rules.filter((rule) => rule.connectionId === connection.id);
  const activeRuleIds = new Set(activeRules.map((rule) => rule.id));
  const rejectedRuleReasons = rulesForConnection
    .filter((rule) => !activeRuleIds.has(rule.id))
    .map((rule) => {
      if (rule.status !== "active") {
        return `${rule.id}: status ${rule.status}`;
      }

      if (connection.integrationId !== "gmail") {
        return `${rule.id}: connection is ${connection.integrationId}, not gmail`;
      }

      if (connection.status !== "active") {
        return `${rule.id}: connection status ${connection.status}`;
      }

      return `${rule.id}: not loaded`;
    });

  return {
    totalEmailRules: rules.length,
    rulesForConnection: rulesForConnection.length,
    activeRulesForConnection: activeRules.length,
    staleOrArchivedRules: rulesForConnection.filter((rule) => rule.status !== "active").length,
    rejectedRuleReasons
  };
}

function createEmailRuleSyncSummary(rule: EmailSignalRule): EmailRuleSyncSummary {
  return {
    ruleId: rule.id,
    adapterId: rule.adapterId,
    query: rule.query,
    fetchStrategy: rule.fetchStrategy,
    classifierMode: rule.classifierMode,
    lookbackDays: rule.lookbackDays,
    maxMessagesPerSync: rule.maxMessagesPerSync,
    maxEventsPerSync: rule.maxEventsPerSync,
    messagesFound: 0,
    processed: 0,
    ignoredUnknown: 0,
    filteredMarketing: 0,
    needsReview: 0,
    llmClassified: 0,
    llmUnavailable: 0,
    llmErrors: 0,
    llmNeedsReview: 0,
    llmIgnored: 0,
    aiMessagesChecked: 0,
    aiRuleMatches: 0,
    aiRuleMatchSkipped: 0,
    aiRuleMatchUnavailable: 0,
    aiRuleMatchErrors: 0,
    aiBodyFetched: 0,
    aiBodyFetchFailed: 0,
    reviewItemsCreated: 0,
    reviewItemsAlreadyPending: 0,
    reviewItemsRejectedDeduped: 0,
    reviewItemsSemanticDeduped: 0,
    lowConfidenceIgnored: 0,
    deduped: 0,
    semanticDeduped: 0,
    archivedCleanupReprocessed: 0,
    skippedDueMaxEventsPerSync: 0,
    eventsCreated: 0,
    signalCounts: {},
    reviewSignalCounts: {},
    suppressedRepeatSender: 0,
    reviewCandidateDebug: [],
    syncDecisionDebug: []
  };
}

async function syncGmailRecentMessagesAgainstActiveRules(input: {
  userId: string;
  connectionId: string;
  accessToken: string;
  rules: EmailSignalRule[];
  summaries: EmailRuleSyncSummary[];
  processedMessageIds: Set<string>;
}): Promise<void> {
  if (input.rules.length === 0 || input.summaries.length === 0) {
    return;
  }

  if (!gmailRuleMatchClassifierAvailable()) {
    for (const summary of input.summaries) {
      summary.aiRuleMatchUnavailable += 1;
    }
    return;
  }

  const maxLookbackDays = Math.min(30, Math.max(...input.rules.map((rule) => rule.lookbackDays || 7), 7));
  const maxMessages = Math.min(
    Number(process.env.GMAIL_RULE_MATCH_MAX_MESSAGES_PER_SYNC ?? 25) || 25,
    Math.max(...input.rules.map((rule) => rule.maxMessagesPerSync || 25), 10),
    25
  );
  const recentMessageIds = await withGmailStage("gmail_search", () =>
    searchGmailMessages(input.accessToken, `newer_than:${maxLookbackDays}d`, maxMessages)
  );
  const candidateIds = recentMessageIds.filter((messageId) => !input.processedMessageIds.has(messageId)).slice(0, maxMessages);

  if (candidateIds.length === 0) {
    return;
  }

  const activeGoals = await getActiveGoals(input.userId);
  const ruleDescriptors = buildGmailRuleMatchRules(input.rules, activeGoals);
  const summariesByRuleId = new Map(input.summaries.map((summary) => [summary.ruleId, summary]));
  const fallbackSummary = input.summaries[0];
  const anyRuleAllowsNewsletters = input.rules.some((rule) => ruleAllowsNewsletterEmails(rule));
  const anyRuleAllowsSecurityCodes = input.rules.some((rule) => ruleAllowsSecurityAuthAccountEmails(rule));
  // fix/private-alpha-email-review-detail-and-general-mail-understanding (generic sweep full-body
  // follow-up, Task 5): an explicit, separate cap on how many candidates get a SECOND (full-body)
  // fetch this sync — distinct from maxMessages (which caps the candidate list itself) since only
  // a subset of candidates ever reach this point (most get filtered by the cheap prefilter above
  // or matched/rejected from subject+snippet alone). Defaults to the same value as maxMessages, so
  // by default every surviving candidate can still get one, but this stays independently tunable.
  const maxBodyFetches = Math.min(Number(process.env.GMAIL_RULE_MATCH_MAX_BODY_FETCHES_PER_SYNC ?? maxMessages) || maxMessages, maxMessages);
  let bodyFetchesUsed = 0;

  for (const messageId of candidateIds) {
    let message = await withGmailStage("gmail_message_fetch", () => getGmailMessageMetadata(input.accessToken, messageId));
    let fields = gmailMessageRuleMatchFields(message);
    fallbackSummary.aiMessagesChecked += 1;
    input.processedMessageIds.add(message.id);

    // Task 5: a deterministic backstop, not a replacement for the LLM's own judgment (the prompt
    // already tells it to ignore bulk/security content unless a rule explicitly asks for it) —
    // this just guarantees that behavior even if the model doesn't reliably follow it, and skips
    // the LLM call entirely (cheaper, and strictly safer) when nothing active could possibly want
    // this message anyway.
    const noiseCategory = genericBulkNoiseCategory(`${fields.subject} ${fields.snippet}`);
    if (noiseCategory === "newsletter" && !anyRuleAllowsNewsletters) {
      fallbackSummary.aiRuleMatchSkipped += 1;
      fallbackSummary.syncDecisionDebug.push(gmailSyncDecisionDebug(message, { decision: "skipped", skipReason: "generic newsletter/bulk content prefilter" }));
      continue;
    }
    if (noiseCategory === "security_code" && !anyRuleAllowsSecurityCodes) {
      fallbackSummary.aiRuleMatchSkipped += 1;
      fallbackSummary.syncDecisionDebug.push(gmailSyncDecisionDebug(message, { decision: "skipped", skipReason: "generic security/verification code prefilter" }));
      continue;
    }

    // Only reached by a candidate the cheap prefilter above did NOT already reject — this is the
    // one place the generic sweep pays for a second (format=full) fetch, gated by its own explicit
    // per-sync cap. A fetch failure here is caught and logged, never thrown — the message still
    // gets classified from subject/snippet alone, exactly as it would have before this existed.
    if (bodyFetchesUsed < maxBodyFetches) {
      const bodyResult = await fetchGmailBodyExcerptForRuleMatch(input.accessToken, messageId);
      bodyFetchesUsed += 1;
      if (bodyResult) {
        message = bodyResult.fullMessage;
        fields = gmailMessageRuleMatchFields(message, bodyResult.bodyExcerpt);
        fallbackSummary.aiBodyFetched += 1;
      } else {
        fallbackSummary.aiBodyFetchFailed += 1;
      }
    }

    try {
      const classification = await classifyGmailMessageAgainstRules({
        source: "gmail",
        message: fields,
        rules: ruleDescriptors,
        activeGoals: activeGoals.map((goal) => ({ id: goal.id, title: goal.title, category: goal.category }))
      });

      if (!classification.shouldCreateReview || !classification.matchedRuleId) {
        fallbackSummary.aiRuleMatchSkipped += 1;
        fallbackSummary.llmClassified += 1;
        fallbackSummary.llmIgnored += 1;
        fallbackSummary.syncDecisionDebug.push(gmailSyncDecisionDebug(message, {
          decision: "skipped",
          skipReason: classification.skipReason ?? "no active rule matched",
          confidence: classification.confidence,
          suggestedReviewTitle: classification.suggestedReviewTitle,
          detectedDateOrDeadline: classification.detectedDateOrDeadline
        }));
        continue;
      }

      const matchedRule = input.rules.find((rule) => rule.id === classification.matchedRuleId);
      const matchedSummary = matchedRule ? summariesByRuleId.get(matchedRule.id) : undefined;

      if (!matchedRule || !matchedSummary) {
        fallbackSummary.aiRuleMatchSkipped += 1;
        fallbackSummary.llmClassified += 1;
        fallbackSummary.llmIgnored += 1;
        fallbackSummary.syncDecisionDebug.push(gmailSyncDecisionDebug(message, {
          decision: "skipped",
          skipReason: "AI matched a rule that is not active",
          confidence: classification.confidence,
          suggestedReviewTitle: classification.suggestedReviewTitle,
          detectedDateOrDeadline: classification.detectedDateOrDeadline
        }));
        continue;
      }

      if (matchedSummary !== fallbackSummary) {
        fallbackSummary.aiMessagesChecked = Math.max(0, fallbackSummary.aiMessagesChecked - 1);
        matchedSummary.aiMessagesChecked += 1;
      }

      if (classification.confidence < matchedRule.minReviewConfidence) {
        matchedSummary.aiRuleMatchSkipped += 1;
        matchedSummary.lowConfidenceIgnored += 1;
        matchedSummary.llmClassified += 1;
        matchedSummary.llmIgnored += 1;
        matchedSummary.syncDecisionDebug.push(gmailSyncDecisionDebug(message, {
          decision: "skipped",
          matchedRuleId: matchedRule.id,
          matchedRuleName: matchedRule.name,
          skipReason: "matched active rule below review confidence",
          confidence: classification.confidence,
          suggestedReviewTitle: classification.suggestedReviewTitle,
          detectedDateOrDeadline: classification.detectedDateOrDeadline
        }));
        continue;
      }

      if (isReviewItemCapReached(matchedRule, matchedSummary)) {
        matchedSummary.aiRuleMatchSkipped += 1;
        matchedSummary.skippedDueMaxEventsPerSync += 1;
        matchedSummary.syncDecisionDebug.push(gmailSyncDecisionDebug(message, {
          decision: "skipped",
          matchedRuleId: matchedRule.id,
          matchedRuleName: matchedRule.name,
          skipReason: "review item cap reached for rule",
          confidence: classification.confidence,
          suggestedReviewTitle: classification.suggestedReviewTitle,
          detectedDateOrDeadline: classification.detectedDateOrDeadline
        }));
        continue;
      }

      matchedSummary.aiRuleMatches += 1;
      matchedSummary.llmClassified += 1;
      matchedSummary.llmNeedsReview += 1;
      matchedSummary.needsReview += 1;
      const reviewResult = await withGmailStage("event_creation", () =>
        createEmailReviewItemForClassification({
          userId: input.userId,
          connectionId: input.connectionId,
          rule: matchedRule,
          message,
          classification: gmailRuleMatchToEmailClassification(matchedRule, message, classification)
        })
      );
      recordEmailReviewItemResult(matchedSummary, reviewResult);
      matchedSummary.syncDecisionDebug.push(gmailSyncDecisionDebug(message, {
        decision: gmailSyncDecisionForReviewStatus(reviewResult.status),
        matchedRuleId: matchedRule.id,
        matchedRuleName: matchedRule.name,
        skipReason: reviewResult.status === "created" ? undefined : reviewResult.status,
        confidence: classification.confidence,
        suggestedReviewTitle: classification.suggestedReviewTitle,
        detectedDateOrDeadline: classification.detectedDateOrDeadline
      }));
    } catch (error) {
      const safeError = safeShortErrorReason(error instanceof Error ? error.message : String(error));
      fallbackSummary.aiRuleMatchErrors += 1;
      fallbackSummary.llmErrors += 1;
      fallbackSummary.syncDecisionDebug.push(gmailSyncDecisionDebug(message, {
        decision: "skipped",
        skipReason: `AI rule matcher failed: ${safeError}`
      }));
    }
  }
}

function gmailRuleMatchClassifierAvailable(): boolean {
  return Boolean(
    process.env.OPENAI_API_KEY ||
      process.env.GMAIL_RULE_MATCH_LLM_MOCK_RESPONSE ||
      process.env.GMAIL_RULE_MATCH_LLM_MOCK_THROW === "true"
  );
}

function buildGmailRuleMatchRules(rules: EmailSignalRule[], activeGoals: Goal[]): GmailRuleMatchRule[] {
  const goalsById = new Map(activeGoals.map((goal) => [goal.id, goal]));

  return rules.map((rule) => ({
    id: rule.id,
    name: rule.name,
    adapterId: rule.adapterId,
    description: gmailRuleMatchDescription(rule),
    query: rule.query,
    goalTitle: rule.goalId ? goalsById.get(rule.goalId)?.title : undefined,
    examples: gmailRuleMatchExamples(rule)
  }));
}

function gmailRuleMatchDescription(rule: EmailSignalRule): string {
  if (rule.adapterId === "job_search_email") {
    return "Recruiter and job-search emails: recruiter replies, interview scheduling, job application confirmations, rejections, offers, and application follow-up.";
  }

  if (rule.adapterId === "work_action_email") {
    return "Work/project action emails: requests, deadlines, follow-ups, feedback requests, blockers, and meeting/action scheduling that may need a user decision.";
  }

  // fix/private-alpha-gmail-generic-signal-engine: a real, user-authored description (Task 3 —
  // gmail.rule.create's own `description` arg) is always the strongest signal when present, since
  // it's the user's OWN explanation of what counts as a match, not a synthesized guess — prefer it
  // over the generic name-only fallback below.
  if (rule.description) {
    return rule.domain ? `[${rule.domain}] ${rule.description}` : rule.description;
  }

  return `Custom review-first Gmail tracking rule named "${rule.name}"${rule.domain ? ` (domain: ${rule.domain})` : ""}. Match emails relevant to the rule name, query, sender, keywords, and linked goal if present.`;
}

function gmailRuleMatchExamples(rule: EmailSignalRule): string[] {
  if (rule.adapterId === "job_search_email") {
    return ["Quick call about frontend role", "Interview invitation", "Unfortunately your application"];
  }

  if (rule.adapterId === "work_action_email") {
    return ["Can you review the dashboard by Friday?", "Brainstorm meeting tomorrow", "Waiting on you for feedback"];
  }

  const normalized = normalizeForComparison(`${rule.name} ${rule.query ?? ""} ${rule.description ?? ""} ${rule.domain ?? ""}`);
  const examples: string[] = [];
  if (/\bendesa\b|invoice|bill|factura|receipt|recibo/.test(normalized)) {
    examples.push("Your Endesa bill is ready", "Factura disponible");
  }
  if (/security|login|account alert|unknown device|2fa|verification/.test(normalized)) {
    examples.push("New login from unknown device", "Security alert");
  }
  if (/apartment|rental|rent|flat|viewing/.test(normalized)) {
    examples.push("Viewing appointment for apartment");
  }
  // fix/private-alpha-gmail-generic-signal-engine: broadened past the original handful of
  // hardcoded domains — each of these is a real category from the product goal (flights, car
  // maintenance, bills, appointments, subscriptions, legal/admin), matched against name/query/
  // description/domain together so a rule works whether the user gave a rich description or just
  // a short label.
  if (/flight|airline|boarding|itinerary|travel|trip/.test(normalized)) {
    examples.push("Your flight has been changed", "Flight cancellation notice", "Check-in now open for your flight");
  }
  if (/insurance|policy|coverage|seguro|poliza/.test(normalized)) {
    examples.push("Your insurance policy renewal", "Coverage change notice");
  }
  if (/\bcar\b|vehicle|mechanic|garage|mot\b|itv\b|repair/.test(normalized)) {
    examples.push("Your car service appointment is confirmed", "Vehicle repair estimate ready");
  }
  if (/subscription|renewal|membership|plan renew/.test(normalized)) {
    examples.push("Your subscription renews soon", "Membership renewal notice");
  }
  if (/legal|tax|government|admin|deadline|gov\.|hacienda|dgt/.test(normalized)) {
    examples.push("Action required before your filing deadline", "Document requires your signature");
  }
  if (/appointment|doctor|clinic|dentist|health/.test(normalized)) {
    examples.push("Your appointment has been rescheduled", "Appointment confirmation");
  }
  return examples;
}

function gmailRuleMatchToEmailClassification(
  rule: EmailSignalRule,
  message: GmailMessage,
  classification: GmailRuleMatchClassification
): ReturnType<typeof classifyJobSearchEmail> {
  const subject = getGmailHeader(message, "subject");
  const from = getGmailHeader(message, "from");
  const detectedDateOrDeadline = classification.detectedDateOrDeadline ?? undefined;
  const extracted: Record<string, unknown> = {
    aiMatchedRuleId: rule.id,
    aiMatchedRuleName: rule.name,
    suggestedReviewTitle: classification.suggestedReviewTitle,
    subject,
    from
  };

  if (detectedDateOrDeadline) {
    extracted.detectedDateOrDeadline = detectedDateOrDeadline;
    extracted.deadline = detectedDateOrDeadline;
  }

  // fix/private-alpha-gmail-generic-signal-engine: advisory only — re-validated against a closed
  // enum by deriveEmailReviewPriorityAndDomain before it can ever reach the EmailReviewItem.priority
  // column, exactly like every other LLM-derived value this function passes through `extracted`.
  if (classification.priority) {
    extracted.suggestedPriority = classification.priority;
  }
  if (classification.signalKind) {
    extracted.signalKind = classification.signalKind;
  }

  if (rule.adapterId === "custom_email_review") {
    extracted.customRuleName = rule.name;
  }

  if (rule.goalId) {
    extracted.goalId = rule.goalId;
  }

  return {
    decision: "needs_review",
    eventType: gmailRuleMatchEventType(rule, message, classification),
    confidence: classification.confidence,
    reason: "ai_rule_match",
    evidence: sanitizeEmailText(
      [classification.suggestedReviewTitle, classification.reason, message.snippet].filter(Boolean).join(" - "),
      300
    ),
    extracted,
    metadata: {
      classifierMode: rule.classifierMode === "llm" ? "llm" : "hybrid",
      adapterId: rule.adapterId,
      source: "gmail",
      classifier: "llm"
    }
  };
}

function gmailRuleMatchEventType(
  rule: EmailSignalRule,
  message: GmailMessage,
  classification: GmailRuleMatchClassification
): string | undefined {
  const text = normalizeForComparison(
    [getGmailHeader(message, "subject"), message.snippet, classification.reason, classification.suggestedReviewTitle].join(" ")
  );

  if (rule.adapterId === "work_action_email") {
    if (classification.detectedDateOrDeadline || /\b(deadline|due|by friday|tomorrow|meeting|scheduled|schedule)\b/.test(text)) {
      return "work_deadline_detected";
    }
    if (/\bfollow up\b|waiting on you/.test(text)) {
      return "work_follow_up_requested";
    }
    return "work_action_required";
  }

  if (rule.adapterId === "job_search_email") {
    // fix/private-alpha-gmail-classifier-precision-and-proactive-diagnostics: this is a SEPARATE
    // classification path from packages/core/src/ingestion.ts's classifyJobSearchText (used for
    // the AI/semantic rule-match fallback pass, not the primary per-rule keyword sync) — same
    // class of bug was possible here independently: "interview|schedule|scheduled|meeting|call"
    // is exactly loose enough for a quant/interview-prep newsletter to trip. Tightened to real
    // scheduling/invitation language, matching isInterviewScheduled's own bar. The final fallback
    // no longer defaults an unmatched signal to "recruiter reply" — decision is always
    // "needs_review" either way (see below), so an honest "uncertain signal" review label
    // (proposedEventType left undefined) beats confidently guessing a specific bucket.
    //
    // fix/private-alpha-gmail-review-llm-instruction-routing (Task 4): two real reported false
    // positives, checked FIRST and unconditionally — a LinkedIn "X reacted to your post"/"ha
    // reaccionado a esta publicación" social notification was classified as a HIGH-PRIORITY JOB
    // OFFER, and a "Ciklum busca personal para el puesto..." job-alert/listing email was
    // classified as a RECRUITER REPLY. Neither is ever a real 1:1 message from a company about
    // THIS user's own application — a social-network notification is never a job offer no matter
    // what job-adjacent words happen to appear nearby, and a job alert/listing digest is never a
    // personal recruiter reply, exactly the same reasoning isJobNewsletterOrPromotional/
    // hasStrongJobContext already apply in ingestion.ts's classifyJobSearchText — mirrored here
    // since this is a genuinely separate classification path (LLM-assisted rule match, not the
    // rules-only classifier). Neither check is job-keyword-gated on purpose: a LinkedIn reaction
    // email that ALSO happens to mention "job"/"role" nearby (a job-related post) is still a
    // reaction notification, not an offer.
    if (
      /\b(reacted to|liked|commented on|shared) your (post|profile)\b|\bha reaccionado a esta publicaci[oó]n\b|\bha comentado tu publicaci[oó]n\b|\bcoment[oó] tu publicaci[oó]n\b|\bnew connection request\b|\bwants to connect\b/.test(
        text
      )
    ) {
      return undefined;
    }
    if (
      /\bjob alert\b|\bjob alerts\b|\bjobs you may be interested in\b|\bjobs for you\b|\brecommended jobs\b|\bnew jobs matching\b|\bweekly job digest\b|\bjob digest\b|\bbusca personal para el puesto\b|\bbuscamos personal para\b|\boferta de empleo\b.{0,20}\bnewsletter\b/.test(
        text
      )
    ) {
      return undefined;
    }
    if (/\b(schedule (an|your|a technical) interview|interview invitation|invite(d)? you to interview|book a (call|time)|calendar invite|phone screen|technical screen|onsite interview|interview scheduled)\b/.test(text)) {
      return "career.interview_scheduled";
    }
    if (/\boffer letter|job offer|offer of employment|employment agreement\b/.test(text)) {
      return "career.offer_received";
    }
    if (/\bunfortunately|reject|rejection|not selected|not moving forward\b/.test(text)) {
      return "career.rejection_received";
    }
    if (/\bapplication received|thanks for applying|application confirmation\b/.test(text)) {
      return "career.application_confirmation_received";
    }
    if (/\brecruiter|hiring team|talent acquisition\b/.test(text)) {
      return "career.recruiter_reply_received";
    }
    return undefined;
  }

  return undefined;
}

function gmailMessageRuleMatchFields(message: GmailMessage, bodyExcerpt?: string) {
  return {
    id: message.id,
    from: getGmailHeader(message, "from"),
    to: getGmailHeader(message, "to"),
    subject: getGmailHeader(message, "subject"),
    date: getGmailHeader(message, "date"),
    snippet: message.snippet ?? "",
    ...(bodyExcerpt ? { bodyExcerpt } : {})
  };
}

/**
 * fix/private-alpha-email-review-detail-and-general-mail-understanding (generic sweep full-body
 * follow-up): the ONLY place the generic AI rule-match sweep gets real body content — a second,
 * conditional readonly fetch (format=full) for a message that already passed the cheap subject/
 * snippet noise prefilter, reusing the exact same decode/clean pipeline (decodeGmailBodyDetailed +
 * cleanEmailBodyForDisplay) the primary per-rule sync and the review-detail command already use.
 * Never fetched for every candidate — only for ones the cheap prefilter didn't already reject —
 * and any fetch failure here is caught locally so the sweep honestly falls back to subject/snippet-
 * only classification for that one message instead of aborting the whole sync.
 */
async function fetchGmailBodyExcerptForRuleMatch(accessToken: string, messageId: string): Promise<{ fullMessage: GmailMessage; bodyExcerpt?: string } | undefined> {
  try {
    const fullMessage = await withGmailStage("gmail_message_fetch", () => getGmailMessage(accessToken, messageId));
    const decoded = decodeGmailBodyDetailed(fullMessage.payload);
    const bodyExcerpt = decoded.text
      ? cleanEmailBodyForDisplay(decoded.text, { isHtml: decoded.isHtml, maxLength: CLASSIFIER_BODY_LENGTH })
      : undefined;
    return { fullMessage, bodyExcerpt };
  } catch {
    return undefined;
  }
}

function gmailSyncDecisionDebug(
  message: GmailMessage,
  decision: Omit<GmailSyncDecisionDebug, "messageId" | "subject" | "from" | "date" | "labels">
): GmailSyncDecisionDebug {
  return {
    messageId: message.id,
    subject: sanitizeEmailText(getGmailHeader(message, "subject"), 120),
    from: sanitizeEmailText(getGmailHeader(message, "from"), 120),
    date: sanitizeEmailText(getGmailHeader(message, "date"), 120),
    labels: sanitizeGmailLabels(message.labelIds),
    ...decision
  };
}

function sanitizeGmailLabels(labels: string[] | undefined): string[] | undefined {
  const safeLabels = (labels ?? [])
    .filter((label) => /^[A-Z_]+$/.test(label))
    .filter((label) => ["INBOX", "SENT", "UNREAD", "IMPORTANT", "CATEGORY_PERSONAL", "CATEGORY_UPDATES"].includes(label));

  return safeLabels.length > 0 ? safeLabels.slice(0, 6) : undefined;
}

function gmailSyncDecisionForReviewStatus(
  status: Awaited<ReturnType<typeof createEmailReviewItemForClassification>>["status"]
): GmailSyncDecisionDebug["decision"] {
  if (status === "created") {
    return "created_review";
  }
  if (status === "already_pending" || status === "semantic_pending") {
    return "already_pending";
  }
  if (status === "rejected_deduped" || status === "semantic_rejected") {
    return "rejected_deduped";
  }
  if (status === "approved_deduped" || status === "semantic_approved" || status === "archived_deduped") {
    return "approved_deduped";
  }
  if (status === "active_event_deduped") {
    return "active_event_deduped";
  }
  return "skipped";
}

async function syncEmailSignalRule(input: {
  userId: string;
  accessToken: string;
  rule: EmailSignalRule;
  processedMessageIds?: Set<string>;
}): Promise<EmailRuleSyncSummary> {
  const summary = createEmailRuleSyncSummary(input.rule);
  const messageIds = await withGmailStage("gmail_search", () => fetchEmailMessageIds(input.accessToken, input.rule));
  summary.messagesFound = messageIds.length;
  const rejectedSenders = await buildRejectedSenderSuppressionMap(input.userId, input.rule.id);

  for (const messageId of messageIds.slice(0, input.rule.maxMessagesPerSync)) {
    if (summary.eventsCreated >= input.rule.maxEventsPerSync) {
      summary.skippedDueMaxEventsPerSync += 1;
      continue;
    }

    const message = await withGmailStage("gmail_message_fetch", () => getGmailMessage(input.accessToken, messageId));
    input.processedMessageIds?.add(message.id);
    const text = gmailMessageToText(message);
    const classificationResult = await withGmailStage("classification", () => classifyEmailForRule(input.rule, message, text));
    const classification = classificationResult.classification;
    if (classificationResult.llmStatus === "classified") {
      summary.llmClassified += 1;
      if (classification.decision === "needs_review") {
        summary.llmNeedsReview += 1;
      }
      if (classification.decision === "ignore") {
        summary.llmIgnored += 1;
      }
    } else if (classificationResult.llmStatus === "unavailable") {
      summary.llmUnavailable += 1;
    } else if (classificationResult.llmStatus === "error") {
      summary.llmErrors += 1;
    }
    summary.processed += 1;

    if (classification.reason === "filtered_marketing" || classification.reason === "filtered_non_action_email") {
      summary.filteredMarketing += 1;
      continue;
    }

    if (classification.decision === "ignore") {
      if (classification.confidence < input.rule.minReviewConfidence) {
        summary.lowConfidenceIgnored += 1;
      } else {
        summary.ignoredUnknown += 1;
      }
      continue;
    }

    // High-signal job-search types (offer, interview) always go to review, even at auto-log
    // confidence — a real decision or real prep is at stake, so a human confirms before it's
    // treated as settled, and it lands in the review queue where morning/evening surfacing and
    // gmail_nudge can flag it prominently instead of it quietly becoming just another logged event.
    const isHighSignalJobSearchType = Boolean(classification.eventType && HIGH_SIGNAL_JOB_SEARCH_EVENT_TYPES.has(classification.eventType));

    if (
      classification.decision === "needs_review" ||
      input.rule.reviewBeforeLogging ||
      classification.confidence < input.rule.minAutoLogConfidence ||
      isHighSignalJobSearchType
    ) {
      if (isReviewItemCapReached(input.rule, summary)) {
        summary.skippedDueMaxEventsPerSync += 1;
        continue;
      }

      if (classification.confidence < input.rule.minReviewConfidence) {
        summary.lowConfidenceIgnored += 1;
        continue;
      }

      // Task 6 (fix/private-alpha-gmail-classifier-precision-and-proactive-diagnostics): a sender
      // already rejected 2+ times for this rule, with none of those rejections a genuine high-
      // signal type (interview/offer), gets skipped here rather than raised for review again —
      // "reject all, they are just spam or job newsletter no interviews" should mean the next
      // newsletter from that exact address doesn't keep coming back. Never applies to a high-
      // signal candidate (interview/offer), regardless of sender history — a real interview or
      // offer always still surfaces. Exact sender address only, never a bare domain, so a genuine
      // recruiter at a large shared domain (e.g. a big employer, or gmail.com) is never silenced
      // by an unrelated newsletter rejection from the same domain.
      if (!isHighSignalJobSearchType) {
        const senderEmail = extractEmailAddress(getGmailHeader(message, "from"));
        const senderHistory = senderEmail ? rejectedSenders.get(senderEmail) : undefined;
        if (senderHistory && senderHistory.count >= 2 && !senderHistory.hasHighSignal) {
          summary.suppressedRepeatSender += 1;
          continue;
        }
      }

      summary.needsReview += 1;
      const reviewResult = await withGmailStage("event_creation", () =>
        createEmailReviewItemForClassification({
          userId: input.userId,
          connectionId: input.rule.connectionId,
          rule: input.rule,
          message,
          classification
        })
      );
      recordEmailReviewItemResult(summary, reviewResult);
      // Only count a genuinely NEW review item toward the sync reply — a re-sync of an already-
      // pending/decided email must report "no new items", not re-announce the same signal as
      // freshly found. Written to reviewSignalCounts, NEVER signalCounts — this branch is reached
      // precisely because the item is NOT confirmed/logged (needs_review, review-first policy, or
      // a high-signal forced review), so it must never be reported as a found/confirmed event type.
      if (reviewResult.status === "created" && classification.eventType && JOB_SEARCH_SIGNAL_EVENT_TYPES.has(classification.eventType)) {
        summary.reviewSignalCounts[classification.eventType] = (summary.reviewSignalCounts[classification.eventType] ?? 0) + 1;
      }

      continue;
    }

    if (!classification.eventType || !EventTypeSchema.safeParse(classification.eventType).success) {
      summary.ignoredUnknown += 1;
      continue;
    }

    const externalId = `gmail:${input.rule.id}:${message.id}`;
    const externalDuplicate = await withGmailStage("event_creation", () => findExternalEvent(input.userId, "gmail", externalId));

    if (
      externalDuplicate &&
      !(externalDuplicate.status === "archived" && externalDuplicate.archiveReason === "cleanup gmail rule test events")
    ) {
      summary.deduped += 1;
      continue;
    }

    const eventType = EventTypeSchema.parse(classification.eventType);
    const subject = getGmailHeader(message, "subject");
    const from = getGmailHeader(message, "from");
    const semanticDuplicate = await withGmailStage("event_creation", () =>
      findGmailSemanticDuplicateEvent({
        userId: input.userId,
        ruleId: input.rule.id,
        eventType,
        subject,
        from,
        company: typeof classification.extracted.company === "string" ? classification.extracted.company : undefined,
        role: typeof classification.extracted.role === "string" ? classification.extracted.role : undefined,
        project: typeof classification.extracted.project === "string" ? classification.extracted.project : undefined,
        deadline: typeof classification.extracted.deadline === "string" ? classification.extracted.deadline : undefined,
        actionRequired: typeof classification.extracted.actionRequired === "boolean" ? classification.extracted.actionRequired : undefined
      })
    );

    if (semanticDuplicate) {
      summary.semanticDeduped += 1;
      continue;
    }

    // fix/private-alpha-gmail-review-quality-and-dedupe (Task 6): the exact-key semantic dedup
    // above only catches a byte-for-byte-normalized subject+sender repeat, but a real duplicate
    // application confirmation for the same job (an ATS auto-reply vs. a recruiter's own
    // confirmation) routinely differs in both — and at high classifier confidence, never enters the
    // review queue's own loose dedup at all. Scoped narrowly to application confirmations only, so
    // a genuinely distinct recruiter reply/interview/offer/rejection is never silently dropped.
    if (eventType === "career.application_confirmation_received") {
      const companyDayDuplicateEvent = await withGmailStage("event_creation", () =>
        findCompanyRoleDayDuplicateEvent({
          userId: input.userId,
          eventType,
          company: typeof classification.extracted.company === "string" ? classification.extracted.company : undefined,
          role: typeof classification.extracted.role === "string" ? classification.extracted.role : undefined,
          referenceDate: new Date()
        })
      );

      if (companyDayDuplicateEvent) {
        summary.semanticDeduped += 1;
        continue;
      }
    }

    const created = await withGmailStage("event_creation", () => createExternalEventIfNotExists(
      input.userId,
      {
        type: eventType,
        timestamp: new Date(),
        source: "gmail",
        provider: "gmail",
        externalId,
        data: {
          ...classification.extracted,
          provider: "gmail",
          emailAdapterId: input.rule.adapterId,
          adapterId: input.rule.adapterId === "job_search_email" ? "job_search_text" : input.rule.adapterId,
          classification: classification.reason,
          ruleId: input.rule.id,
          gmailMessageId: message.id,
          threadId: message.threadId,
          subject,
          from,
          snippet: message.snippet,
          confidence: classification.confidence,
          reason: classification.reason,
          externalId
        },
        confidence: classification.confidence,
        evidence: [classification.evidence]
      },
      {
        ignoreArchivedCleanup: true
      }
    ));

    if (created.created) {
      summary.eventsCreated += 1;
      if (JOB_SEARCH_SIGNAL_EVENT_TYPES.has(eventType)) {
        summary.signalCounts[eventType] = (summary.signalCounts[eventType] ?? 0) + 1;
      }
      await withGmailStage("event_creation", () =>
        approvePendingGmailReviewItemsForSemanticEvent({
          userId: input.userId,
          ruleId: input.rule.id,
          adapterId: input.rule.adapterId,
          proposedEventType: eventType,
          subject,
          from,
          company: typeof classification.extracted.company === "string" ? classification.extracted.company : undefined,
          role: typeof classification.extracted.role === "string" ? classification.extracted.role : undefined,
          project: typeof classification.extracted.project === "string" ? classification.extracted.project : undefined,
          deadline: typeof classification.extracted.deadline === "string" ? classification.extracted.deadline : undefined,
          actionRequired: typeof classification.extracted.actionRequired === "boolean" ? classification.extracted.actionRequired : undefined,
          eventId: created.event.id
        })
      );
      if (created.ignoredArchivedCleanup) {
        summary.archivedCleanupReprocessed += 1;
      }
    } else {
      summary.deduped += 1;
    }
  }

  return summary;
}

function recordEmailReviewItemResult(
  summary: EmailRuleSyncSummary,
  reviewResult: Awaited<ReturnType<typeof createEmailReviewItemForClassification>>
): void {
  summary.reviewCandidateDebug.push(reviewResult.debug as EmailReviewCandidateDebug);

  if (reviewResult.status === "created") {
    summary.reviewItemsCreated += 1;
  } else if (reviewResult.status === "already_pending") {
    summary.reviewItemsAlreadyPending += 1;
  } else if (reviewResult.status === "rejected_deduped") {
    summary.reviewItemsRejectedDeduped += 1;
  } else if (reviewResult.status === "semantic_pending") {
    summary.reviewItemsSemanticDeduped += 1;
    summary.reviewItemsAlreadyPending += 1;
  } else if (reviewResult.status === "semantic_rejected") {
    summary.reviewItemsSemanticDeduped += 1;
    summary.reviewItemsRejectedDeduped += 1;
  } else if (
    reviewResult.status === "semantic_approved" ||
    reviewResult.status === "approved_deduped" ||
    reviewResult.status === "archived_deduped"
  ) {
    summary.reviewItemsSemanticDeduped += 1;
  } else if (reviewResult.status === "active_event_deduped") {
    summary.semanticDeduped += 1;
  }
}

async function fetchEmailMessageIds(accessToken: string, rule: EmailSignalRule): Promise<string[]> {
  if (rule.fetchStrategy === "query") {
    return searchGmailMessagesForRule(accessToken, rule);
  }

  if (rule.fetchStrategy === "all_recent") {
    return searchGmailMessages(accessToken, `newer_than:${rule.lookbackDays}d`, rule.maxMessagesPerSync);
  }

  throw new GmailSyncError("GMAIL_SYNC_FAILED", "Fetch strategy not implemented yet.", "gmail_search");
}

async function classifyEmailForRule(
  rule: EmailSignalRule,
  message: GmailMessage,
  text: string
): Promise<{ classification: ReturnType<typeof classifyJobSearchEmail>; llmStatus?: "classified" | "unavailable" | "error" }> {
  const securityNoise = ruleAllowsSecurityAuthAccountEmails(rule) ? undefined : classifySecurityAuthEmailNoise(rule, message, text);
  if (securityNoise) {
    return { classification: securityNoise };
  }

  // Task 5 (fix/private-alpha-gmail-generic-signal-engine): custom_email_review's own match here
  // is a dumb "the Gmail search query found it, so review it" pass-through — unlike job_search_
  // email/work_action_email, it never routes through classifyJobSearchText's own newsletter
  // filter at all. A rule with an empty/weak query (falling back to expandGmailQueriesForRule's
  // broad `newer_than:Nd` search) could otherwise flood review with bulk newsletter content this
  // rule never actually asked for — the same deterministic backstop the AI rule-match sweep uses.
  if (rule.adapterId === "custom_email_review" && !ruleAllowsNewsletterEmails(rule) && genericBulkNoiseCategory(text) === "newsletter") {
    return {
      classification: {
        decision: "ignore",
        eventType: undefined,
        confidence: 0.05,
        reason: "filtered_non_action_email",
        evidence: text.slice(0, 300),
        extracted: {},
        metadata: {
          classifierMode: rule.classifierMode,
          adapterId: rule.adapterId,
          source: "gmail",
          classifier: "rules"
        }
      }
    };
  }

  if (rule.adapterId === "custom_email_review") {
    return {
      classification: {
        decision: "needs_review",
        eventType: undefined,
        confidence: 0.8,
        reason: "custom_email_match",
        evidence: text.slice(0, 300),
        extracted: {
          customRuleName: rule.name,
          query: rule.query,
          goalId: rule.goalId,
          subject: getGmailHeader(message, "subject"),
          from: getGmailHeader(message, "from")
        },
        metadata: {
          classifierMode: rule.classifierMode,
          adapterId: rule.adapterId,
          source: "gmail",
          classifier: "rules"
        }
      }
    };
  }

  const rulesClassification = classifyEmailWithRules(rule.adapterId, text);

  if (!["job_search_email", "work_action_email"].includes(rule.adapterId)) {
    return { classification: rulesClassification };
  }

  if (isHardEmailClassification(rulesClassification)) {
    return { classification: rulesClassification };
  }

  if (rule.classifierMode === "rules") {
    return { classification: rulesClassification };
  }

  if (rule.classifierMode === "hybrid" && rulesClassification.decision === "log_event" && rulesClassification.confidence >= rule.minAutoLogConfidence) {
    return { classification: rulesClassification };
  }

  if (
    rule.classifierMode === "hybrid" &&
    rulesClassification.reason !== "unknown" &&
    !(rulesClassification.decision === "log_event" && rulesClassification.confidence < rule.minAutoLogConfidence)
  ) {
    return { classification: rulesClassification };
  }

  if (!process.env.OPENAI_API_KEY) {
    if (rule.classifierMode === "llm") {
      return {
        classification: unavailableEmailClassification(rule.adapterId, text, rule.classifierMode, rule.minReviewConfidence),
        llmStatus: "unavailable"
      };
    }

    return { classification: rulesClassification, llmStatus: "unavailable" };
  }

  try {
    // fix/private-alpha-email-review-detail-and-general-mail-understanding (Part 5 audit finding):
    // this previously passed `message.snippet` as bodyText too — classifyEmailWithLLM's own input
    // schema already has a real bodyText field, but the caller never filled it with anything beyond
    // the ~100-char Gmail snippet, so the LLM fallback classifier (the path an ambiguous email
    // actually reaches) was silently snippet-limited even though the deterministic rules classifier
    // right above it already sees the full decoded, cleaned body via gmailMessageToText.
    const decodedBody = decodeGmailBodyDetailed(message.payload);
    const bodyText = decodedBody.text
      ? cleanEmailBodyForDisplay(decodedBody.text, { isHtml: decodedBody.isHtml, maxLength: CLASSIFIER_BODY_LENGTH })
      : (message.snippet ?? "");
    const llmClassification = await classifyEmailWithLLM({
      adapterId: rule.adapterId === "work_action_email" ? "work_action_email" : "job_search_email",
      source: "gmail",
      subject: getGmailHeader(message, "subject"),
      from: getGmailHeader(message, "from"),
      snippet: message.snippet,
      bodyText,
      allowedEventTypes: rule.adapterId === "work_action_email" ? WorkActionEmailAllowedEventTypes : JobSearchEmailAllowedEventTypes,
      classifierMode: rule.classifierMode === "llm" ? "llm" : "hybrid",
      minAutoLogConfidence: rule.minAutoLogConfidence,
      minReviewConfidence: rule.minReviewConfidence
    });

    return { classification: llmClassification, llmStatus: "classified" };
  } catch {
    return {
      classification: {
        decision: rule.classifierMode === "llm" ? "needs_review" : rulesClassification.decision,
        eventType: undefined,
        confidence: rule.classifierMode === "llm" ? rule.minReviewConfidence : rulesClassification.confidence,
        reason: "LLM classifier failed.",
        evidence: text.slice(0, 300),
        extracted: {},
        metadata: {
          classifierMode: rule.classifierMode,
          adapterId: rule.adapterId,
          source: "gmail",
          classifier: "llm"
        }
      },
      llmStatus: "error"
    };
  }
}

function ruleAllowsSecurityAuthAccountEmails(rule: EmailSignalRule): boolean {
  const normalized = normalizeForComparison(`${rule.name} ${rule.query ?? ""} ${rule.description ?? ""}`);
  return /\b(security|account alert|login alert|unknown device|authentication|2fa|verification|password reset)\b/.test(normalized);
}

/** Task 5 (fix/private-alpha-gmail-generic-signal-engine): the generic mirror of
 * ruleAllowsSecurityAuthAccountEmails — a rule must explicitly say it wants newsletter/bulk
 * content (e.g. "track newsletters about X") before the deterministic prefilter below lets one
 * through to the LLM rule-matcher at all. */
function ruleAllowsNewsletterEmails(rule: EmailSignalRule): boolean {
  const normalized = normalizeForComparison(`${rule.name} ${rule.query ?? ""} ${rule.description ?? ""}`);
  return /\b(newsletters?|digests?|bulletins?|mailing lists?)\b/.test(normalized);
}

/**
 * Task 5 (fix/private-alpha-gmail-generic-signal-engine): a lightweight, generic deterministic
 * noise check run BEFORE any message reaches the LLM rule-matcher sweep (syncGmailRecentMessages
 * AgainstActiveRules) — that sweep previously had NO prefilter of its own at all (unlike the
 * primary per-rule job-search/work-action path, which already had isJobNewsletterOrPromotional/
 * isSecurityAuthAccountEmail as a deterministic backstop), leaving it entirely up to the LLM's own
 * judgment whether a bulk newsletter or a bare security code should match a rule. Returns which
 * noise category (if any) the message looks like; the caller only calls the LLM if no active rule
 * in this sync explicitly opts into that exact category (ruleAllowsNewsletterEmails /
 * ruleAllowsSecurityAuthAccountEmails) — deliberately narrow phrase lists shared with (not
 * duplicated from) the job-search path's own generic bulk-content signals, so a real 1:1 email is
 * never mistaken for noise.
 */
function genericBulkNoiseCategory(text: string): "newsletter" | "security_code" | undefined {
  const normalized = normalizeForComparison(text);
  if (/\b(unsubscribe|view in browser|view this email in your browser|sponsored)\b/.test(normalized) || /\bnewsletters?\b/.test(normalized)) {
    return "newsletter";
  }
  if (isSecurityAuthAccountEmail(text)) {
    return "security_code";
  }
  return undefined;
}

function isHardEmailClassification(classification: ReturnType<typeof classifyJobSearchEmail>): boolean {
  return ["filtered_marketing", "application_action_required", "filtered_non_action_email"].includes(classification.reason);
}

function isReviewItemCapReached(rule: EmailSignalRule, summary: EmailRuleSyncSummary): boolean {
  const cap = rule.adapterId === "work_action_email" ? Math.min(3, rule.maxEventsPerSync) : rule.maxEventsPerSync;

  return summary.reviewItemsCreated >= cap;
}

function classifyEmailWithRules(adapterId: string, text: string): ReturnType<typeof classifyJobSearchEmail> {
  if (adapterId === "work_action_email") {
    return classifyWorkActionEmail({ text, classifierMode: "rules", llmAvailable: false });
  }

  return classifyJobSearchEmail({ text, classifierMode: "rules", llmAvailable: false });
}

function unavailableEmailClassification(
  adapterId: string,
  text: string,
  classifierMode: "llm" | "hybrid" | "rules",
  minReviewConfidence: number
): ReturnType<typeof classifyJobSearchEmail> {
  if (adapterId === "work_action_email") {
    return {
      decision: "needs_review",
      confidence: minReviewConfidence,
      reason: "LLM classifier unavailable",
      evidence: text.slice(0, 300),
      extracted: {},
      metadata: {
        classifierMode,
        adapterId,
        source: "gmail",
        classifier: "llm"
      }
    };
  }

  return classifyJobSearchEmail({ text, classifierMode: "llm", llmAvailable: false });
}

function classifySecurityAuthEmailNoise(
  rule: EmailSignalRule,
  message: GmailMessage,
  text: string
): ReturnType<typeof classifyJobSearchEmail> | undefined {
  if (!isSecurityAuthAccountEmail(text)) {
    return undefined;
  }

  // Task 7 (fix/private-alpha-gmail-classifier-precision-and-proactive-diagnostics): deliberately
  // does NOT carve out an exception for application-flow security codes (e.g. "Security code for
  // your application to Blockchain.com") — a pre-existing, separately tested policy
  // (tests/email-review-dedupe.test.ts's "Gmail security and auth emails are hard-filtered...")
  // hard-filters every security/verification/OTP code regardless of context, since relaying a
  // real security code back through chat is its own risk independent of whether it's tied to a
  // job application. Task 7's own instruction allows this ("route to review or ignore per current
  // policy") — the fix here is limited to humanEmailReviewEventLabel's label map (so if such an
  // email DOES reach review through a different path, e.g. the AI/semantic rule-match sync, it
  // never falls back to a generic "event" label) and does not touch this filter.
  return {
    decision: "ignore",
    eventType: undefined,
    confidence: 0.05,
    reason: "filtered_non_action_email",
    evidence: text.slice(0, 300),
    extracted: {
      subject: getGmailHeader(message, "subject"),
      from: getGmailHeader(message, "from")
    },
    metadata: {
      classifierMode: rule.classifierMode,
      adapterId: rule.adapterId,
      source: "gmail",
      classifier: "rules"
    }
  };
}

// fix/private-alpha-gmail-review-quality-and-dedupe (Task 2): delegates to
// @operator-agent/core's isSecurityOrAuthEmail (packages/core/src/ingestion.ts) instead of
// maintaining a second, independently-drifting phrase list — that shared list is also what the
// deterministic job_search_email/work_action_email classifier itself checks first, so a
// verification/auth-code email is hard-excluded identically everywhere it could be classified.
function isSecurityAuthAccountEmail(text: string): boolean {
  return isSecurityOrAuthEmail(text);
}

const REVIEW_PRIORITY_VALUES = new Set(["low", "normal", "high"]);

/**
 * fix/private-alpha-gmail-generic-signal-engine: generalizes what used to be a career-only
 * concept — previously ONLY career.offer_received/career.interview_scheduled could ever be "high
 * priority" (HIGH_SIGNAL_JOB_SEARCH_EVENT_TYPES), so a flight cancellation or an insurance
 * deadline could never get the same treatment no matter how urgent. The generic LLM rule-matcher
 * (classifyGmailMessageAgainstRules) can now suggest a priority/domain for ANY rule — but it is
 * only ever a SUGGESTION: validated against a closed enum here (never trusted as free text into a
 * DB column), and job_search_email/work_action_email keep their exact pre-existing behavior
 * (still forced high via HIGH_SIGNAL_JOB_SEARCH_EVENT_TYPES) regardless of what the LLM suggests,
 * so this can never change job-search precision/regression behavior.
 */
function deriveEmailReviewPriorityAndDomain(
  rule: EmailSignalRule,
  classification: ReturnType<typeof classifyJobSearchEmail>,
  proposedEventType: string | undefined
): { priority: "low" | "normal" | "high"; domain: string | undefined } {
  const domain = rule.domain;

  if (proposedEventType && HIGH_SIGNAL_JOB_SEARCH_EVENT_TYPES.has(proposedEventType)) {
    return { priority: "high", domain };
  }

  const suggested = classification.extracted.suggestedPriority;
  if (typeof suggested === "string" && REVIEW_PRIORITY_VALUES.has(suggested)) {
    return { priority: suggested as "low" | "normal" | "high", domain };
  }

  return { priority: "normal", domain };
}

async function createEmailReviewItemForClassification(input: {
  userId: string;
  connectionId: string;
  rule: EmailSignalRule;
  message: GmailMessage;
  classification: ReturnType<typeof classifyJobSearchEmail>;
}) {
  const subject = sanitizeEmailText(getGmailHeader(input.message, "subject"), 120);
  const from = sanitizeEmailText(getGmailHeader(input.message, "from"), 120);
  const reviewExternalId = `gmail-review:${input.rule.id}:${input.message.id}`;
  const proposedEventType = input.classification.eventType ?? safeEmailReviewProposedType(input.classification.reason);
  const { priority, domain } = deriveEmailReviewPriorityAndDomain(input.rule, input.classification, proposedEventType);
  const company = typeof input.classification.extracted.company === "string" ? input.classification.extracted.company : undefined;
  const role = typeof input.classification.extracted.role === "string" ? input.classification.extracted.role : undefined;
  const project = typeof input.classification.extracted.project === "string" ? input.classification.extracted.project : undefined;
  const deadline = typeof input.classification.extracted.deadline === "string" ? input.classification.extracted.deadline : undefined;
  const actionRequired = typeof input.classification.extracted.actionRequired === "boolean" ? input.classification.extracted.actionRequired : undefined;
  const semanticKey = buildEmailReviewSemanticKey({
    userId: input.userId,
    ruleId: input.rule.id,
    provider: "gmail",
    proposedEventType,
    subject,
    from,
    company,
    role,
    project,
    deadline,
    actionRequired
  });
  const baseDebug = {
    subject: truncatePlainText(subject ?? "", 120),
    from: truncatePlainText(from ?? "", 120),
    proposedEventType,
    company,
    role,
    project,
    deadline,
    actionRequired,
    semanticKey
  };

  // refactor/private-alpha-canonical-progress-command-engine (Task 8): a real reported "duplicate
  // Kraken listing" bug — a generic job-listing/newsletter broadcast has no specific proposedEventType,
  // and findGmailSemanticDuplicateReviewItem below immediately no-ops without one, so two rules (or
  // two sync passes) matching the exact same message produced two separate pending rows. Checked
  // first, unconditionally, scoped to the exact underlying Gmail message — never a fuzzy match.
  const exactDuplicate = await findGmailDuplicateReviewItemByProviderMessageId({
    userId: input.userId,
    provider: "gmail",
    providerMessageId: input.message.id
  });

  if (exactDuplicate) {
    if (exactDuplicate.status === "pending") {
      return { status: "semantic_pending" as const, item: exactDuplicate, debug: { ...baseDebug, decision: "existing_pending_exact_message", matchedReviewId: exactDuplicate.id, matchedReviewStatus: exactDuplicate.status } };
    }
    if (exactDuplicate.status === "rejected") {
      return { status: "semantic_rejected" as const, item: exactDuplicate, debug: { ...baseDebug, decision: "existing_rejected_exact_message", matchedReviewId: exactDuplicate.id, matchedReviewStatus: exactDuplicate.status } };
    }
    if (exactDuplicate.status === "approved") {
      return { status: "semantic_approved" as const, item: exactDuplicate, debug: { ...baseDebug, decision: "existing_approved_exact_message", matchedReviewId: exactDuplicate.id, matchedReviewStatus: exactDuplicate.status } };
    }
  }

  if (EventTypeSchema.safeParse(proposedEventType).success) {
    const activeEvent = await findGmailSemanticDuplicateEvent({
      userId: input.userId,
      ruleId: input.rule.id,
      eventType: EventTypeSchema.parse(proposedEventType),
      subject,
      from,
      company,
      role,
      project,
      deadline,
      actionRequired
    });

    if (activeEvent) {
      return {
        status: "active_event_deduped" as const,
        event: activeEvent,
        debug: {
          ...baseDebug,
          decision: "active_event_exists",
          matchedEventId: activeEvent.id
        }
      };
    }
  }

  const semanticReview = await findGmailSemanticDuplicateReviewItem({
    userId: input.userId,
    ruleId: input.rule.id,
    adapterId: input.rule.adapterId,
    provider: "gmail",
    proposedEventType,
    subject,
    from,
    company,
    role,
    project,
    deadline,
    actionRequired
  });

  if (semanticReview) {
    if (semanticReview.status === "pending") {
      return {
        status: "semantic_pending" as const,
        item: semanticReview,
        debug: {
          ...baseDebug,
          decision: "existing_pending",
          matchedReviewId: semanticReview.id,
          matchedReviewStatus: semanticReview.status
        }
      };
    }

    if (semanticReview.status === "rejected") {
      return {
        status: "semantic_rejected" as const,
        item: semanticReview,
        debug: {
          ...baseDebug,
          decision: "existing_rejected",
          matchedReviewId: semanticReview.id,
          matchedReviewStatus: semanticReview.status
        }
      };
    }

    if (semanticReview.status === "approved") {
      return {
        status: "semantic_approved" as const,
        item: semanticReview,
        debug: {
          ...baseDebug,
          decision: "existing_approved",
          matchedReviewId: semanticReview.id,
          matchedReviewStatus: semanticReview.status
        }
      };
    }

    const created = await upsertEmailReviewItem({
      userId: input.userId,
      connectionId: input.connectionId,
      ruleId: input.rule.id,
      adapterId: input.rule.adapterId,
      provider: "gmail",
      providerMessageId: input.message.id,
      externalId: reviewExternalId,
      subject,
      from,
      snippet: input.message.snippet ? sanitizeEmailText(input.message.snippet, 200) : undefined,
      evidence: sanitizeEmailText(input.classification.evidence, 300),
      proposedEventType,
      confidence: input.classification.confidence,
      reason: input.classification.reason,
      extracted: input.classification.extracted,
      priority,
      domain
    });

    return {
      ...created,
      debug: {
        ...baseDebug,
        decision: created.status === "created" ? "created" : "archived_ignored",
        matchedReviewId: semanticReview.id,
        matchedReviewStatus: semanticReview.status
      }
    };
  }

  // fix/private-alpha-gmail-review-quality-and-dedupe (Task 6): the exact-key semantic dedup above
  // only catches a byte-for-byte-normalized subject+sender repeat. Same-day same-company (and, when
  // both extracted, same-role) application confirmations are still real duplicates even when their
  // subject/sender differ — this loose fallback only ever applies to application-confirmation
  // reviews, never to recruiter replies/interviews/offers/rejections, so a genuinely distinct
  // high-signal email is never silently swallowed.
  if (proposedEventType === "career.application_confirmation_received" && company) {
    const companyDayDuplicate = await findCompanyRoleDayDuplicateReviewItem({
      userId: input.userId,
      proposedEventType,
      company,
      role,
      referenceDate: input.message.internalDate ? new Date(Number(input.message.internalDate)) : new Date()
    });

    if (companyDayDuplicate) {
      if (companyDayDuplicate.status === "pending") {
        return {
          status: "semantic_pending" as const,
          item: companyDayDuplicate,
          debug: {
            ...baseDebug,
            decision: "existing_pending_company_day",
            matchedReviewId: companyDayDuplicate.id,
            matchedReviewStatus: companyDayDuplicate.status
          }
        };
      }

      if (companyDayDuplicate.status === "rejected") {
        return {
          status: "semantic_rejected" as const,
          item: companyDayDuplicate,
          debug: {
            ...baseDebug,
            decision: "existing_rejected_company_day",
            matchedReviewId: companyDayDuplicate.id,
            matchedReviewStatus: companyDayDuplicate.status
          }
        };
      }

      if (companyDayDuplicate.status === "approved") {
        return {
          status: "semantic_approved" as const,
          item: companyDayDuplicate,
          debug: {
            ...baseDebug,
            decision: "existing_approved_company_day",
            matchedReviewId: companyDayDuplicate.id,
            matchedReviewStatus: companyDayDuplicate.status
          }
        };
      }
    }
  }

  const created = await upsertEmailReviewItem({
    userId: input.userId,
    connectionId: input.connectionId,
    ruleId: input.rule.id,
    adapterId: input.rule.adapterId,
    provider: "gmail",
    providerMessageId: input.message.id,
    externalId: reviewExternalId,
    subject,
    from,
    snippet: input.message.snippet ? sanitizeEmailText(input.message.snippet, 200) : undefined,
    evidence: sanitizeEmailText(input.classification.evidence, 300),
    proposedEventType,
    confidence: input.classification.confidence,
    reason: input.classification.reason,
    extracted: input.classification.extracted,
    priority,
    domain
  });

  return {
    ...created,
    debug: {
      ...baseDebug,
      decision: created.status === "created" ? "created" : dedupeDecisionForReviewStatus(created.status),
      matchedReviewId: "item" in created ? created.item.id : undefined,
      matchedReviewStatus: "item" in created ? created.item.status : undefined
    }
  };
}

function safeEmailReviewProposedType(reason: string): string | undefined {
  return [
    "application_action_required",
    "security_code",
    "verify_email",
    "work_action_required",
    "work_deadline_detected",
    "work_follow_up_requested",
    "work_project_update_detected"
  ].includes(reason)
    ? reason
    : undefined;
}

function dedupeDecisionForReviewStatus(status: string): EmailReviewCandidateDebug["decision"] {
  if (status === "already_pending") {
    return "existing_pending";
  }

  if (status === "rejected_deduped") {
    return "existing_rejected";
  }

  if (status === "approved_deduped") {
    return "existing_approved";
  }

  if (status === "archived_deduped") {
    return "archived_ignored";
  }

  return "invalid_ignored";
}

function buildEmailReviewSemanticKey(input: {
  userId: string;
  ruleId: string;
  provider: "gmail";
  proposedEventType?: string;
  subject?: string;
  from?: string;
  company?: string;
  role?: string;
  project?: string;
  deadline?: string;
  actionRequired?: boolean;
}): string {
  return [
    input.userId,
    input.ruleId,
    input.provider,
    input.proposedEventType ?? "none",
    normalizeDebugSemanticText(input.subject),
    normalizeDebugEmailAddress(input.from),
    normalizeDebugSemanticText(input.company),
    normalizeDebugSemanticText(input.role),
    normalizeDebugSemanticText(input.project),
    normalizeDebugSemanticText(input.deadline),
    typeof input.actionRequired === "boolean" ? String(input.actionRequired) : ""
  ].join("|");
}

function normalizeDebugSemanticText(value?: string): string {
  return (value ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s@.+-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeDebugEmailAddress(value?: string): string {
  const normalized = normalizeDebugSemanticText(value);
  const match = normalized.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/);
  return match?.[0] ?? normalized;
}

function sanitizeIntegrationConnection(connection: IntegrationConnection) {
  return {
    id: connection.id,
    userId: connection.userId,
    integrationId: connection.integrationId,
    status: connection.status,
    config: sanitizeIntegrationConfig(connection),
    lastSyncedAt: connection.lastSyncedAt,
    lastError: sanitizeIntegrationLastError(connection.integrationId, connection.lastError),
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt
  };
}

function sanitizeEmailSignalRule(rule: EmailSignalRule) {
  return {
    ...rule,
    lastError: sanitizeIntegrationLastError("gmail", rule.lastError)
  };
}


export function sanitizeActionItem(item: ActionItem) {
  return {
    ...item,
    evidence: item.evidence ? truncatePlainText(item.evidence, 500) : undefined,
    description: item.description ? truncatePlainText(item.description, 500) : undefined
  };
}


function appendPendingEmailReviewLine(message: string, count: number): string {
  return [message, pendingEmailReviewLine(count)].filter(Boolean).join("\n\n");
}


function sanitizeIntegrationLastError(integrationId: string, error?: string): string | undefined {
  if (!error) {
    return undefined;
  }

  if (integrationId === "gmail") {
    return safeGmailErrorMessage(error);
  }

  return truncatePlainText(error, 200);
}

function sanitizeIntegrationConfig(connection: IntegrationConnection): Record<string, unknown> {
  if (connection.integrationId === "github_public") {
    return {
      repos: connection.config.repos,
      authorLogin: connection.config.authorLogin,
      includeRepoActivity: connection.config.includeRepoActivity
    };
  }

  if (connection.integrationId === "gmail") {
    const storage = gmailTokenStorageInfo(connection.config);

    return {
      provider: "gmail",
      scope: typeof connection.config.scope === "string" ? connection.config.scope : "gmail.readonly",
      email: typeof connection.config.email === "string" ? connection.config.email : undefined,
      hasRefreshToken: storage.hasRefreshToken,
      tokenStorage: storage.tokenStorage,
      expiresAt: storage.expiresAt || undefined
    };
  }

  return {};
}

function gmailTokenStorageInfo(config: Record<string, unknown>): {
  tokenStorage: "encrypted" | "legacy_plaintext" | "missing";
  hasRefreshToken: boolean;
  expiresAt?: number;
} {
  if (isEncryptedSecretJsonEnvelope(config.token)) {
    return {
      tokenStorage: "encrypted",
      hasRefreshToken: config.hasRefreshToken === true,
      expiresAt: typeof config.tokenExpiresAt === "number" ? config.tokenExpiresAt : undefined
    };
  }

  const legacy = normalizeGmailToken(readLegacyGmailTokenConfig(config));
  if (legacy.accessToken || legacy.refreshToken) {
    return {
      tokenStorage: "legacy_plaintext",
      hasRefreshToken: Boolean(legacy.refreshToken),
      expiresAt: legacy.expiresAt || undefined
    };
  }

  return {
    tokenStorage: "missing",
    hasRefreshToken: false
  };
}

function normalizeGithubPublicConnectionInput(input: GithubPublicConnectionInput): GithubPublicConnectionInput {
  return {
    ...input,
    repos: input.repos
      .map((repo) => ({
        owner: repo.owner.trim().toLowerCase(),
        repo: repo.repo.trim().toLowerCase()
      }))
      .sort((left, right) => `${left.owner}/${left.repo}`.localeCompare(`${right.owner}/${right.repo}`)),
    authorLogin: input.authorLogin?.trim().toLowerCase(),
    includeRepoActivity: input.includeRepoActivity ?? !input.authorLogin
  };
}

async function preserveActiveGmailRulesForOAuthReconnect(
  userId: string,
  connectedConnection: IntegrationConnection,
  email: string | undefined
): Promise<number> {
  const [connections, rules] = await Promise.all([
    getIntegrationConnections(userId),
    getEmailSignalRules(userId)
  ]);
  const activeRuleConnectionIds = new Set(rules.filter((rule) => rule.status === "active").map((rule) => rule.connectionId));
  const candidateConnections = connections.filter(
    (connection) =>
      connection.integrationId === "gmail" &&
      connection.status !== "archived" &&
      connection.id !== connectedConnection.id &&
      activeRuleConnectionIds.has(connection.id)
  );

  if (candidateConnections.length === 0) {
    return 0;
  }

  const normalizedEmail = normalizeGmailAccountEmail(email);
  const sameAccountConnections = normalizedEmail
    ? candidateConnections.filter((connection) => normalizeGmailAccountEmail(connection.config.email) === normalizedEmail)
    : [];
  const sourceConnections =
    sameAccountConnections.length > 0
      ? sameAccountConnections
      : candidateConnections.length === 1
        ? candidateConnections
        : [];

  if (sourceConnections.length === 0) {
    return 0;
  }

  return reassignActiveEmailSignalRulesToConnection(userId, {
    fromConnectionIds: sourceConnections.map((connection) => connection.id),
    toConnectionId: connectedConnection.id
  });
}

function normalizeGmailAccountEmail(value: unknown): string | undefined {
  return typeof value === "string" && value.includes("@") ? value.trim().toLowerCase() : undefined;
}

function findDuplicateGithubConnection(
  connections: Awaited<ReturnType<typeof getIntegrationConnections>>,
  input: GithubPublicConnectionInput
) {
  const expectedKey = githubConnectionDedupeKey(input);

  return connections.find(
    (connection) =>
      connection.integrationId === "github_public" &&
      (connection.status === "active" || connection.status === "paused") &&
      githubConnectionDedupeKey(parseGithubConnectionConfig(connection.config)) === expectedKey
  );
}

function githubConnectionDedupeKey(input: GithubPublicConnectionInput): string {
  const normalized = normalizeGithubPublicConnectionInput(input);
  const repos = normalized.repos.map((repo) => `${repo.owner}/${repo.repo}`).join(",");
  return `${repos}|author=${normalized.authorLogin ?? ""}`;
}

async function validateGithubPublicRepo(
  owner: string,
  repo: string,
  action: "connection" | "sync"
): Promise<{ httpStatus: number; message: string } | undefined> {
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "alecto-ai"
    }
  });

  if (response.ok) {
    return undefined;
  }

  if (response.status === 404) {
    return {
      httpStatus: 400,
      message: `GitHub ${action} failed for ${owner}/${repo}: repo not found or private. Public GitHub integration only supports public repos.`
    };
  }

  if (response.status === 403) {
    return {
      httpStatus: 429,
      message: `GitHub ${action} failed: GitHub rate limit reached. Try again later.`
    };
  }

  const body = await response.text();
  return {
    httpStatus: 502,
    message: `GitHub ${action} failed for ${owner}/${repo}: ${truncatePlainText(body || response.statusText, 160)}`
  };
}

function parseGithubConnectionConfig(config: Record<string, unknown>) {
  const parsed = GithubPublicConnectionInputSchema.safeParse(config);

  if (!parsed.success) {
    throw new Error("Invalid GitHub connection config");
  }

  return {
    ...parsed.data,
    includeRepoActivity: parsed.data.includeRepoActivity ?? !parsed.data.authorLogin
  };
}

async function fetchGithubCommits(owner: string, repo: string): Promise<GithubCommit[]> {
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits?per_page=10`, {
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "alecto-ai"
    }
  });

  if (!response.ok) {
    const body = await response.text();
    throw githubFetchError(owner, repo, response.status, body || response.statusText);
  }

  return (await response.json()) as GithubCommit[];
}

function githubFetchError(owner: string, repo: string, status: number, body: string): GithubFetchError {
  if (status === 404) {
    return new GithubFetchError(
      "GITHUB_REPO_NOT_FOUND_OR_PRIVATE",
      `${owner}/${repo}: repo not found or private. Public GitHub integration only supports public repos.`
    );
  }

  if (status === 403) {
    return new GithubFetchError("GITHUB_RATE_LIMITED", `${owner}/${repo}: GitHub rate limit reached. Try again later.`);
  }

  return new GithubFetchError("GITHUB_FETCH_FAILED", `${owner}/${repo}: ${truncatePlainText(body, 160)}`);
}

async function exchangeGmailOAuthCode(
  code: string,
  config: { clientId: string; clientSecret: string; redirectUri: string }
) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: "authorization_code"
    })
  });

  if (!response.ok) {
    throw new Error(`Gmail OAuth token exchange failed: ${truncatePlainText(await response.text(), 200)}`);
  }

  const token = (await response.json()) as GmailTokenResponse;
  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: Date.now() + (token.expires_in ?? 3600) * 1000,
    tokenType: token.token_type,
    scope: token.scope
  };
}

async function getGmailProfileEmail(accessToken: string): Promise<string | undefined> {
  const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
    headers: {
      authorization: `Bearer ${accessToken}`
    }
  });

  if (!response.ok) {
    return undefined;
  }

  const profile = (await response.json()) as { emailAddress?: unknown };
  return typeof profile.emailAddress === "string" ? profile.emailAddress : undefined;
}

async function getValidGmailAccessToken(connection: IntegrationConnection): Promise<string> {
  const token = await readGmailToken(connection);

  if (token.accessToken && token.expiresAt > Date.now() + 60_000) {
    return token.accessToken;
  }

  if (!token.refreshToken) {
    throw new GmailSyncError("GMAIL_AUTH_EXPIRED", "Gmail authorization expired. Reconnect Gmail.", "token_refresh");
  }

  const config = gmailOAuthConfig();

  if (!config) {
    throw new GmailSyncError("GMAIL_AUTH_EXPIRED", "Gmail authorization expired. Reconnect Gmail.", "token_refresh");
  }

  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: token.refreshToken,
      grant_type: "refresh_token"
    })
  });

  if (!response.ok) {
    throw gmailApiError("token refresh", response.status, await response.text());
  }

  const refreshed = (await response.json()) as GmailTokenResponse;
  const nextToken = {
    ...token,
    accessToken: refreshed.access_token,
    expiresAt: Date.now() + (refreshed.expires_in ?? 3600) * 1000,
    tokenType: refreshed.token_type ?? token.tokenType,
    scope: refreshed.scope ?? token.scope
  };

  await updateIntegrationConnectionConfig(connection.userId, connection.id, buildEncryptedGmailConnectionConfig(connection.config, nextToken));

  return nextToken.accessToken;
}

async function readGmailToken(connection: IntegrationConnection): Promise<GmailStoredToken> {
  if (isEncryptedSecretJsonEnvelope(connection.config.token)) {
    try {
      return normalizeGmailToken(decryptSecretJson(connection.config.token));
    } catch (error) {
      if (error instanceof SecretEncryptionError && error.message.includes("missing")) {
        throw new GmailSyncError(
          "GMAIL_ENCRYPTION_KEY_MISSING",
          "Gmail token encryption key is missing. Set ALECTO_SECRET_ENCRYPTION_KEY and restart.",
          "token_refresh"
        );
      }

      throw new GmailSyncError(
        "GMAIL_AUTH_EXPIRED",
        "Gmail token could not be read/decrypted. Reconnect Gmail.",
        "token_refresh"
      );
    }
  }

  const token = normalizeGmailToken(readLegacyGmailTokenConfig(connection.config));

  if ((token.accessToken || token.refreshToken) && getSecretEncryptionKeyFromEnv()) {
    await updateIntegrationConnectionConfig(connection.userId, connection.id, buildEncryptedGmailConnectionConfig(connection.config, token));
  }

  return token;
}

function readLegacyGmailTokenConfig(config: Record<string, unknown>): Record<string, unknown> {
  if (isRecord(config.token) && !isEncryptedSecretJsonEnvelope(config.token)) {
    return config.token;
  }

  return config;
}

function normalizeGmailToken(value: unknown): GmailStoredToken {
  const token = isRecord(value) ? value : {};
  return {
    accessToken: typeof token.accessToken === "string" ? token.accessToken : "",
    refreshToken: typeof token.refreshToken === "string" ? token.refreshToken : "",
    expiresAt: typeof token.expiresAt === "number" ? token.expiresAt : 0,
    tokenType: typeof token.tokenType === "string" ? token.tokenType : "Bearer",
    scope: typeof token.scope === "string" ? token.scope : ""
  };
}

function buildEncryptedGmailConnectionConfig(
  baseConfig: Record<string, unknown>,
  token: unknown
): Record<string, unknown> {
  const normalizedToken = normalizeGmailToken(token);
  const config = { ...baseConfig };
  delete config.accessToken;
  delete config.refreshToken;
  delete config.expiresAt;
  delete config.tokenType;
  config.provider = "gmail";
  config.scope = typeof config.scope === "string" ? config.scope : "gmail.readonly";

  try {
    config.token = encryptSecretJson(normalizedToken);
  } catch (error) {
    if (error instanceof SecretEncryptionError) {
      throw new GmailSyncError(
        "GMAIL_ENCRYPTION_KEY_MISSING",
        "Gmail token encryption key is missing. Set ALECTO_SECRET_ENCRYPTION_KEY and restart.",
        "token_refresh"
      );
    }

    throw error;
  }

  config.tokenStorage = "encrypted";
  config.hasRefreshToken = Boolean(normalizedToken.refreshToken);
  config.tokenExpiresAt = normalizedToken.expiresAt || undefined;
  return config;
}

async function searchGmailMessagesForRule(accessToken: string, rule: EmailSignalRule): Promise<string[]> {
  const queries = expandGmailQueriesForRule(rule);
  const messageIds = new Set<string>();

  for (const query of queries) {
    for (const messageId of await searchGmailMessages(accessToken, query, rule.maxMessagesPerSync)) {
      messageIds.add(messageId);
    }
  }

  return Array.from(messageIds);
}

function expandGmailQueriesForRule(rule: EmailSignalRule): string[] {
  if (rule.adapterId !== "job_search_email") {
    return rule.query ? [rule.query] : [`newer_than:${rule.lookbackDays}d`];
  }

  return [
    "newer_than:30d interview",
    'newer_than:30d "schedule an interview"',
    'newer_than:30d "thanks for applying"',
    "newer_than:30d recruiter",
    'newer_than:30d "talent acquisition"',
    "newer_than:30d unfortunately",
    'newer_than:30d "job offer"',
    'newer_than:30d "offer letter"',
    'newer_than:30d "offer of employment"',
    'newer_than:30d "employment agreement"',
    "newer_than:30d application",
    "newer_than:30d applying",
    'newer_than:30d "security code" application',
    'newer_than:30d "verification code" application',
    'newer_than:30d "resubmit your application"',
    'newer_than:30d "complete your application"'
  ];
}

async function searchGmailMessages(accessToken: string, query: string, maxResults = 10): Promise<string[]> {
  const params = new URLSearchParams({
    q: query,
    maxResults: String(Math.min(100, Math.max(1, maxResults)))
  });
  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?${params.toString()}`, {
    headers: {
      authorization: `Bearer ${accessToken}`
    }
  });

  if (!response.ok) {
    throw gmailApiError("search", response.status, await response.text());
  }

  const result = (await response.json()) as { messages?: Array<{ id?: string }> };
  return (result.messages ?? []).map((message) => message.id).filter((id): id is string => Boolean(id));
}

async function getGmailMessage(accessToken: string, messageId: string): Promise<GmailMessage> {
  const response = await fetch(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`,
    {
      headers: {
        authorization: `Bearer ${accessToken}`
      }
    }
  );

  if (!response.ok) {
    throw gmailApiError("message fetch", response.status, await response.text());
  }

  return (await response.json()) as GmailMessage;
}

async function getGmailMessageMetadata(accessToken: string, messageId: string): Promise<GmailMessage> {
  const params = new URLSearchParams({ format: "metadata" });
  for (const header of ["Subject", "From", "To", "Date"]) {
    params.append("metadataHeaders", header);
  }

  const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?${params.toString()}`, {
    headers: {
      authorization: `Bearer ${accessToken}`
    }
  });

  if (!response.ok) {
    throw gmailApiError("message fetch", response.status, await response.text());
  }

  return (await response.json()) as GmailMessage;
}

function gmailApiError(action: "token refresh" | "search" | "message fetch", status: number, body: string): GmailSyncError {
  const text = body.toLowerCase();
  const stage = gmailStageForAction(action);

  if (status === 400 && action === "search") {
    return new GmailSyncError("GMAIL_QUERY_INVALID", "Gmail search query failed. Check the email rule query.", stage);
  }

  if (action === "token refresh" && (text.includes("invalid_grant") || text.includes("invalid_request"))) {
    return new GmailSyncError("GMAIL_AUTH_EXPIRED", "Gmail authorization expired. Reconnect Gmail.", stage);
  }

  if (status === 401) {
    return new GmailSyncError("GMAIL_AUTH_EXPIRED", "Gmail authorization expired. Reconnect Gmail.", stage);
  }

  if (text.includes("gmail api has not been used") || text.includes("api has not been used") || text.includes("disabled")) {
    return new GmailSyncError(
      "GMAIL_PERMISSION",
      "Gmail API is disabled in Google Cloud project. Enable Gmail API and retry.",
      stage
    );
  }

  if (status === 403 && (text.includes("rate") || text.includes("quota"))) {
    return new GmailSyncError("GMAIL_RATE_LIMITED", "Gmail rate limit reached. Try again later.", stage);
  }

  if (text.includes("insufficient") || text.includes("scope") || text.includes("permission")) {
    return new GmailSyncError(
      "GMAIL_PERMISSION",
      "Gmail permission error. Reconnect Gmail and approve Gmail readonly access.",
      stage
    );
  }

  if (status === 403) {
    return new GmailSyncError(
      "GMAIL_PERMISSION",
      "Gmail permission error. Reconnect Gmail and approve Gmail readonly access.",
      stage
    );
  }

  if (status === 429) {
    return new GmailSyncError("GMAIL_RATE_LIMITED", "Gmail rate limit reached. Try again later.", stage);
  }

  return new GmailSyncError("GMAIL_SYNC_FAILED", `Gmail sync failed: ${safeGmailProviderReason(body, status)}`, stage);
}

function safeGmailErrorMessage(error: unknown): string {
  if (error instanceof GmailSyncError) {
    return error.message;
  }

  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();

  if (lower.startsWith("gmail sync failed:")) {
    return safeGmailErrorMessage(message.replace(/^gmail sync failed:\s*/i, ""));
  }

  if (lower.includes("gmail api has not been used") || lower.includes("disabled")) {
    return "Gmail API is disabled in Google Cloud project. Enable Gmail API and retry.";
  }

  if (lower.includes("gmail token encryption key is missing") || lower.includes("alecto_secret_encryption_key")) {
    return "Gmail token encryption key is missing. Set ALECTO_SECRET_ENCRYPTION_KEY and restart.";
  }

  if (lower.includes("token could not be read") || lower.includes("decrypt")) {
    return "Gmail token could not be read/decrypted. Reconnect Gmail.";
  }

  if (
    lower.includes("refresh token") ||
    lower.includes("invalid_grant") ||
    lower.includes("unauthorized") ||
    lower.includes("authorization expired") ||
    lower.includes("invalid credentials")
  ) {
    return "Gmail authorization expired. Reconnect Gmail.";
  }

  if (lower.includes("permission") || lower.includes("scope") || lower.includes("insufficient")) {
    return "Gmail permission error. Reconnect Gmail and approve Gmail readonly access.";
  }

  if (lower.includes("rate") || lower.includes("quota") || lower.includes("429")) {
    return "Gmail rate limit reached. Try again later.";
  }

  if (lower.includes("query") || lower.includes("search")) {
    return "Gmail search query failed. Check the email rule query.";
  }

  if (lower.includes("fetch strategy not implemented")) {
    return "Fetch strategy not implemented yet.";
  }

  return `Gmail sync failed: ${safeShortErrorReason(message)}`;
}

function gmailStageForAction(action: "token refresh" | "search" | "message fetch"): GmailErrorStage {
  if (action === "token refresh") {
    return "token_refresh";
  }

  return action === "search" ? "gmail_search" : "gmail_message_fetch";
}

async function withGmailStage<T>(stage: GmailErrorStage, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof GmailSyncError) {
      throw error;
    }

    throw new GmailSyncError("GMAIL_SYNC_FAILED", safeGmailErrorMessage(error), stage);
  }
}

function gmailErrorStage(error: unknown): GmailErrorStage | undefined {
  return error instanceof GmailSyncError ? error.stage : undefined;
}

function safeGmailProviderReason(body: string, status: number): string {
  const parsedMessage = parseProviderErrorMessage(body);
  return safeShortErrorReason(parsedMessage || `HTTP ${status}`);
}

function parseProviderErrorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as unknown;

    if (isRecord(parsed) && typeof parsed.error_description === "string") {
      return parsed.error_description;
    }

    if (isRecord(parsed)) {
      if (isRecord(parsed.error) && typeof parsed.error.message === "string") {
        return parsed.error.message;
      }

      if (typeof parsed.error === "string") {
        return parsed.error;
      }
    }
  } catch {
    // Fall through to a plain-text sanitizer below.
  }

  return body;
}

function safeShortErrorReason(message: string): string {
  const cleaned = truncatePlainText(message, 180)
    .replace(/ya29\.[A-Za-z0-9._-]+/g, "[redacted]")
    .replace(/1\/\/[A-Za-z0-9._-]+/g, "[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .trim();

  if (!cleaned || cleaned.startsWith("{") || cleaned.startsWith("[")) {
    return "unknown error";
  }

  return cleaned;
}

function isGmailConnectionError(error: unknown): boolean {
  return (
    error instanceof GmailSyncError &&
    (error.code === "GMAIL_AUTH_EXPIRED" || error.code === "GMAIL_PERMISSION" || error.code === "GMAIL_ENCRYPTION_KEY_MISSING")
  );
}

function gmailMessageToText(message: GmailMessage): string {
  // fix/private-alpha-gmail-classifier-precision-and-proactive-diagnostics: sanitized (not just
  // truncated) BEFORE classification, not only at display time — real bulk/newsletter senders
  // sometimes inject invisible/zero-width characters specifically to dodge naive keyword content
  // filters (e.g. "n​ewsletter" with a zero-width space mid-word breaks a plain .includes("newsletter")
  // match), so leaving them in the text the classifier itself reads would undermine the same
  // precision fix this task is otherwise making.
  const subject = sanitizeEmailText(getGmailHeader(message, "subject"), 500);
  const from = sanitizeEmailText(getGmailHeader(message, "from"), 500);
  const snippet = sanitizeEmailText(message.snippet ?? "", 2000);
  // fix/private-alpha-email-review-detail-and-general-mail-understanding (Task 5): runs through the
  // same general cleaner the review-detail command and the LLM understanding layer use (prefers
  // text/plain, falls back to HTML converted to readable text, strips script/style/tracking noise,
  // redacts secrets) — the deterministic classifier gets real body content, not just a raw decode.
  const decodedBody = decodeGmailBodyDetailed(message.payload);
  const body = decodedBody.text
    ? cleanEmailBodyForDisplay(decodedBody.text, { isHtml: decodedBody.isHtml, maxLength: CLASSIFIER_BODY_LENGTH })
    : sanitizeEmailText(message.snippet ?? "", CLASSIFIER_BODY_LENGTH);

  return [`Subject: ${subject}`, `From: ${from}`, `Snippet: ${snippet}`, `Body: ${body}`].filter(Boolean).join("\n");
}

/**
 * fix/private-alpha-email-review-detail-and-general-mail-understanding (Part 1 audit finding):
 * the old decodeGmailBody grabbed whichever text/* MIME part appeared first in document order,
 * with no way for the caller to know whether it got plain text or raw HTML. Prefers text/plain
 * explicitly (searched first, anywhere in the tree); only falls back to text/html when no
 * text/plain part exists at all — and tells the caller which one it got, so cleanEmailBodyForDisplay
 * knows whether to run HTML-to-text conversion.
 */
function decodeGmailBodyDetailed(part?: GmailMessagePart): { text: string; isHtml: boolean } {
  const plain = findGmailBodyPart(part, "text/plain");
  if (plain) {
    return { text: decodeBase64Url(plain), isHtml: false };
  }

  const html = findGmailBodyPart(part, "text/html");
  if (html) {
    return { text: decodeBase64Url(html), isHtml: true };
  }

  return { text: "", isHtml: false };
}

function findGmailBodyPart(part: GmailMessagePart | undefined, mimeType: "text/plain" | "text/html"): string | undefined {
  if (!part) {
    return undefined;
  }

  if (part.mimeType === mimeType && part.body?.data) {
    return part.body.data;
  }

  for (const child of part.parts ?? []) {
    const found = findGmailBodyPart(child, mimeType);
    if (found) {
      return found;
    }
  }

  return undefined;
}

function getGmailHeader(message: GmailMessage, name: string): string {
  return message.payload?.headers?.find((header) => header.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

/**
 * fix/private-alpha-gmail-classifier-precision-and-proactive-diagnostics (Task 6): pulls the bare
 * email address out of a raw "From" header (e.g. `"Jobs Newsletter" <jobs@example.com>`), used to
 * key repeat-rejection suppression on the exact sender address — never a bare domain, since a
 * domain-wide match risks silencing a genuine recruiter at a large company (e.g. gmail.com,
 * or a big employer's own domain) after one unrelated newsletter from that same domain.
 */
function extractEmailAddress(from: string): string | undefined {
  const match = from.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  return match ? match[0].toLowerCase() : undefined;
}

/**
 * fix/private-alpha-gmail-classifier-precision-and-proactive-diagnostics (Task 6): one rejected-
 * senders lookup per rule sync (not per message), keyed by exact sender address. `hasHighSignal`
 * records whether any of that sender's rejected items were ever a genuine high-signal type
 * (interview/offer) — if so, that sender's history is never used to suppress anything, since a
 * mixed history means this isn't a pure newsletter sender.
 */
async function buildRejectedSenderSuppressionMap(
  userId: string,
  ruleId: string
): Promise<Map<string, { count: number; hasHighSignal: boolean }>> {
  const rejected = await getRejectedEmailReviewSendersForRule(userId, ruleId);
  const map = new Map<string, { count: number; hasHighSignal: boolean }>();

  for (const item of rejected) {
    if (!item.from) {
      continue;
    }
    const sender = extractEmailAddress(item.from);
    if (!sender) {
      continue;
    }
    const existing = map.get(sender) ?? { count: 0, hasHighSignal: false };
    existing.count += 1;
    if (item.proposedEventType && HIGH_SIGNAL_JOB_SEARCH_EVENT_TYPES.has(item.proposedEventType)) {
      existing.hasHighSignal = true;
    }
    map.set(sender, existing);
  }

  return map;
}

function decodeBase64Url(value: string): string {
  try {
    return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch {
    return "";
  }
}

function matchesGithubAuthor(commit: GithubCommit, authorLogin?: string): boolean {
  if (!authorLogin) {
    return true;
  }

  const expected = authorLogin.toLowerCase();
  const candidates = [
    commit.author?.login,
    commit.committer?.login,
    commit.commit.author?.name,
    commit.commit.author?.email,
    commit.commit.committer?.name,
    commit.commit.committer?.email
  ];

  return candidates.some((candidate) => candidate?.toLowerCase().includes(expected));
}

function parseGithubCommitDate(commit: GithubCommit): Date | undefined {
  const value = commit.commit.author?.date ?? commit.commit.committer?.date;
  const date = value ? new Date(value) : undefined;

  return date && !Number.isNaN(date.getTime()) ? date : undefined;
}

function githubCommitEventData(
  owner: string,
  repo: string,
  commit: GithubCommit,
  externalId: string,
  isPersonal: boolean
) {
  return {
    provider: "github",
    isPersonal,
    activityKind: isPersonal ? "personal_commit" : "repo_activity",
    repo: `${owner}/${repo}`,
    sha: commit.sha,
    message: commit.commit.message,
    authorName: commit.commit.author?.name ?? commit.commit.committer?.name,
    authorLogin: commit.author?.login ?? commit.committer?.login,
    url: commit.html_url,
    externalId
  };
}

function shortErrorMessage(error: unknown): string {
  return truncatePlainText(error instanceof Error ? error.message : String(error), 200);
}

function parseOptionalDate(value: unknown): Date | undefined {
  return typeof value === "string" ? parseOptionalNow(value) : undefined;
}

function readReason(body: unknown, fallback: string): string {
  return isRecord(body) && typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : fallback;
}

function parseUndoLastBody(body: unknown): { scope: "event" | "group"; reason: string } {
  const scope = isRecord(body) && body.scope === "event" ? "event" : "group";
  return {
    scope,
    reason: readReason(body, "undo last")
  };
}

function parseCorrectEventBody(body: unknown) {
  if (!isRecord(body) || !isRecord(body.data)) {
    return undefined;
  }

  const type = typeof body.type === "string" ? EventTypeSchema.safeParse(body.type) : undefined;
  const timestamp = typeof body.timestamp === "string" ? new Date(body.timestamp) : undefined;
  const evidence =
    typeof body.evidence === "string"
      ? [body.evidence]
      : Array.isArray(body.evidence)
        ? body.evidence.filter((item): item is string => typeof item === "string")
        : undefined;

  if (type && !type.success) {
    return undefined;
  }

  if (timestamp && Number.isNaN(timestamp.getTime())) {
    return undefined;
  }

  return {
    type: type?.data,
    timestamp,
    data: body.data,
    evidence,
    reason: readReason(body, "corrected by user")
  };
}

function validateCorrectEventInput(type: string, data: Record<string, unknown>, hasTypeOverride: boolean): string | undefined {
  if (type === "reflection.daily_checkin_completed") {
    return "Correct the derived event instead, such as workout, sleep, energy, applications, or reading.";
  }

  if (
    type === "reflection.journal_entry_created" &&
    ("duration_minutes" in data || "duration_hours" in data || "count" in data || "value" in data)
  ) {
    return "This is a journal event. duration_minutes looks like a workout or reading correction. Pick a health.workout_completed or learning.reading_session_completed event id.";
  }

  const genericMessage = `This event is type ${type}, but the correction data does not match that type. Pick the correct event id or use a compatible field.`;

  if (type === "health.workout_completed") {
    return typeof data.duration_minutes === "number" ? undefined : genericMessage;
  }

  if (type === "learning.reading_session_completed") {
    return typeof data.duration_minutes === "number" ? undefined : genericMessage;
  }

  if (type === "health.sleep_logged") {
    return typeof data.duration_hours === "number" ? undefined : genericMessage;
  }

  if (type === "career.application_sent") {
    return typeof data.count === "number" ? undefined : genericMessage;
  }

  if (type === "reflection.energy_logged" || type === "reflection.anxiety_logged" || type === "reflection.focus_logged") {
    return isNumberInRange(data.value, 1, 10) ? undefined : genericMessage;
  }

  if (type === "reflection.impulse_logged") {
    const hasValidKind =
      data.kind === undefined || data.kind === "gambling" || data.kind === "trading" || data.kind === "general";
    return isNumberInRange(data.value, 0, 10) && hasValidKind ? undefined : genericMessage;
  }

  if (type === "reflection.journal_entry_created") {
    return typeof data.text === "string" ? undefined : genericMessage;
  }

  return hasTypeOverride ? undefined : genericMessage;
}

function isNumberInRange(value: unknown, min: number, max: number): boolean {
  return typeof value === "number" && value >= min && value <= max;
}

function formatGoalsResponse(goals: Awaited<ReturnType<typeof getGoals>>) {
  return {
    goals: sortGoalsForDisplay(goals),
    duplicateWarnings: findGoalDuplicateWarnings(goals)
  };
}

function formatCreateGoalResult(result: Awaited<ReturnType<typeof createGoal>>) {
  if (result.duplicate) {
    return {
      duplicate: true,
      existingGoal: result.existingGoal,
      message: `You already have a similar active goal: ${result.existingGoal.title}. Use /goals to review it or /archive_goal ${result.existingGoal.id} first.`
    };
  }

  return {
    duplicate: false,
    goal: result.goal
  };
}

function formatGoalPriorityBackfillMessage(result: Awaited<ReturnType<typeof backfillGoalPriorities>>): string {
  const lines = [`Updated ${result.updated} goal${result.updated === 1 ? "" : "s"}:`];

  if (result.updatedGoals.length > 0) {
    lines.push(...result.updatedGoals.map((item) => `- ${item.goal.title}: ${item.previousPriority} -> ${item.nextPriority}`));
  }

  if (result.skippedManual.length > 0) {
    lines.push(
      "",
      "Skipped manual priorities:",
      ...result.skippedManual.map((goal) => `- ${goal.title}: ${goal.priority}`)
    );
  }

  return lines.join("\n");
}

function composeCustomGoalProgressReply(
  goalTitle: string,
  input: { metricKey?: string; value?: string | number | boolean; unit?: string; note?: string }
): string {
  const metric = input.metricKey ? `${input.metricKey}${input.value !== undefined ? `=${input.value}` : ""}` : "progress";
  const unit = input.unit ? ` ${input.unit}` : "";
  const note = input.note ? ` (${input.note})` : "";
  return `Logged progress for ${goalTitle}: ${metric}${unit}${note}.`;
}

async function createDailyCheckInEvents(
  userId: string,
  answers: Array<{ key: string; value: string | number | boolean }>,
  evidenceText?: string
) {
  const answerMap = new Map(answers.map((answer) => [answer.key, answer.value]));
  const evidence = evidenceText ? [evidenceText] : undefined;
  const eventInputs: Parameters<typeof createEvents>[1] = [
    {
      type: "reflection.daily_checkin_completed",
      source: "manual",
      data: {
        answers: Object.fromEntries(answerMap)
      },
      confidence: 1,
      evidence: evidence ?? ["manual daily check-in"]
    }
  ];

  const energy = numberAnswer(answerMap.get("energy"));
  const anxiety = numberAnswer(answerMap.get("anxiety"));
  const focus = numberAnswer(answerMap.get("focus"));
  const gamblingImpulse = numberAnswer(answerMap.get("gambling_impulse") ?? answerMap.get("gambling"));
  const tradingImpulse = numberAnswer(answerMap.get("trading_impulse") ?? answerMap.get("trading"));
  const applications = numberAnswer(answerMap.get("applications"));
  const workoutMinutes = numberAnswer(answerMap.get("workout"));
  const readingMinutes = numberAnswer(answerMap.get("reading"));
  const sleepHours = numberAnswer(answerMap.get("sleep"));
  const notes = textAnswer(answerMap.get("notes"));

  if (energy !== undefined) {
    eventInputs.push({
      type: "reflection.energy_logged",
      source: "manual",
      data: { value: energy },
      confidence: 1,
      evidence: evidence ?? [`energy=${energy}`]
    });
  }

  if (anxiety !== undefined) {
    eventInputs.push({
      type: "reflection.anxiety_logged",
      source: "manual",
      data: { value: anxiety },
      confidence: 1,
      evidence: evidence ?? [`anxiety=${anxiety}`]
    });
  }

  if (focus !== undefined) {
    eventInputs.push({
      type: "reflection.focus_logged",
      source: "manual",
      data: { value: focus },
      confidence: 1,
      evidence: evidence ?? [`focus=${focus}`]
    });
  }

  if (gamblingImpulse !== undefined) {
    eventInputs.push({
      type: "reflection.impulse_logged",
      source: "manual",
      data: { kind: "gambling", value: gamblingImpulse },
      confidence: 1,
      evidence: evidence ?? [`gambling_impulse=${gamblingImpulse}`]
    });
  }

  if (tradingImpulse !== undefined) {
    eventInputs.push({
      type: "reflection.impulse_logged",
      source: "manual",
      data: { kind: "trading", value: tradingImpulse },
      confidence: 1,
      evidence: evidence ?? [`trading_impulse=${tradingImpulse}`]
    });
  }

  if (applications !== undefined) {
    eventInputs.push({
      type: "career.application_sent",
      source: "manual",
      data: { count: applications },
      confidence: 1,
      evidence: evidence ?? [`applications=${applications}`]
    });
  }

  if (workoutMinutes !== undefined) {
    eventInputs.push({
      type: "health.workout_completed",
      source: "manual",
      data: { duration_minutes: workoutMinutes },
      confidence: 1,
      evidence: evidence ?? [`workout=${workoutMinutes}`]
    });
  }

  if (readingMinutes !== undefined) {
    eventInputs.push({
      type: "learning.reading_session_completed",
      source: "manual",
      data: { duration_minutes: readingMinutes },
      confidence: 1,
      evidence: evidence ?? [`reading=${readingMinutes}`]
    });
  }

  if (sleepHours !== undefined) {
    eventInputs.push({
      type: "health.sleep_logged",
      source: "manual",
      data: { duration_hours: sleepHours },
      confidence: 1,
      evidence: evidence ?? [`sleep=${sleepHours}`]
    });
  }

  if (notes) {
    for (const event of extractHighConfidenceNoteEvents(notes, eventInputs.map((item) => item.type), evidenceText)) {
      eventInputs.push(event);
    }

    eventInputs.push({
      type: "reflection.journal_entry_created",
      source: "manual",
      data: { text: notes },
      confidence: 1,
      evidence: evidence ?? [notes]
    });
  }

  return createEvents(userId, eventInputs);
}

function composeNaturalCheckInReply(parsed: ReturnType<typeof parseDailyCheckinText>) {
  const parts: string[] = [];

  if (parsed.sleep !== undefined) {
    parts.push(`slept ${parsed.sleep}h`);
  }

  if (parsed.energy !== undefined) {
    parts.push(`energy ${parsed.energy}`);
  }

  if (parsed.anxiety !== undefined) {
    parts.push(`anxiety ${parsed.anxiety}`);
  }

  if (parsed.focus !== undefined) {
    parts.push(`focus ${parsed.focus}`);
  }

  if (parsed.gambling_impulse !== undefined) {
    parts.push(`gambling impulse ${parsed.gambling_impulse}`);
  }

  if (parsed.trading_impulse !== undefined) {
    parts.push(`trading impulse ${parsed.trading_impulse}`);
  }

  if (parsed.applications !== undefined) {
    parts.push(`${parsed.applications} application${parsed.applications === 1 ? "" : "s"}`);
  }

  if (parsed.workout !== undefined) {
    parts.push(`${parsed.workout} minutes of training`);
  }

  if (parsed.reading !== undefined) {
    parts.push(`${parsed.reading} minutes of reading`);
  }

  const interpretation = composeCheckInInterpretation(parsed);
  const summary = parts.length > 0 ? joinReadableList(parts) : "daily check-in";

  return `Check-in saved: ${summary}.${interpretation ? ` ${interpretation}` : ""}`;
}

function composeCheckInInterpretation(parsed: ReturnType<typeof parseDailyCheckinText>) {
  if ((parsed.anxiety ?? 0) >= 7 && (parsed.gambling_impulse ?? 0) >= 6) {
    return "Careful: high anxiety plus gambling impulse is a bad decision state.";
  }

  if (parsed.sleep !== undefined && parsed.sleep < 6) {
    return "Low sleep. Do not treat today's impulses as reliable signals.";
  }

  if (parsed.applications || parsed.workout || parsed.reading) {
    return "Good, there was real progress today.";
  }

  return "";
}

function formatCheckInConfirmation(answers: Array<{ key: string; value: string | number | boolean }>) {
  const labels: Record<string, string> = {
    energy: "energy",
    anxiety: "anxiety",
    focus: "focus",
    gambling_impulse: "gambling impulse",
    gambling: "gambling impulse",
    trading_impulse: "trading impulse",
    trading: "trading impulse",
    applications: "applications",
    workout: "workout minutes",
    reading: "reading minutes",
    sleep: "sleep hours"
  };

  const parts = answers
    .filter((answer) => answer.key !== "notes")
    .map((answer) => `${labels[answer.key] ?? answer.key} ${answer.value}`);

  return parts.length > 0 ? joinReadableList(parts) : "daily check-in";
}

function extractHighConfidenceNoteEvents(
  notes: string,
  existingTypes: string[],
  evidenceText?: string
): Parameters<typeof createEvents>[1] {
  const existingTypeSet = new Set(existingTypes);

  return extractEvents(notes)
    .filter((event) => event.confidence >= 0.9 && isSpecificExtractedEvent(event) && !existingTypeSet.has(event.type))
    .map((event) => ({
      type: event.type,
      source: "manual",
      data: event.data,
      confidence: event.confidence,
      evidence: evidenceText ? [evidenceText] : event.evidence
    }));
}

function isSpecificExtractedEvent(event: ReturnType<typeof extractEvents>[number]): boolean {
  return (
    (event.type === "career.application_sent" && typeof event.data.count === "number") ||
    (event.type === "health.workout_completed" && typeof event.data.duration_minutes === "number") ||
    (event.type === "health.sleep_logged" && typeof event.data.duration_hours === "number") ||
    (event.type === "learning.reading_session_completed" && typeof event.data.duration_minutes === "number")
  );
}

function numberAnswer(value: unknown): number | undefined {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function textAnswer(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function maybeCreateLowSleepImpulsePendingMemory(
  userId: string,
  newEvents: StoredEvent[]
): Promise<string | undefined> {
  if (!hasLowSleepHighImpulsePair(newEvents)) {
    return undefined;
  }

  const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
  const recentEvents = await getEventsSince(userId, since);
  const pairCount = countLowSleepHighImpulseOccurrences(recentEvents);

  if (pairCount < 2) {
    return undefined;
  }

  const summary = "Low sleep plus high gambling impulse appears to be a risk state for the user.";

  if (await hasSimilarActiveMemory(userId, summary)) {
    return undefined;
  }

  if (await hasPendingMemoryCreate(userId, summary)) {
    return undefined;
  }

  await createPendingAction(userId, {
    type: "memory_create",
    summary,
    payload: {
      type: "risk_pattern",
      summary,
      source: "system_inferred",
      confidence: 0.8,
      evidence: {
        matchedOccurrences: pairCount,
        windowDays: 14
      }
    },
    expiresAt: tomorrow()
  });

  return "I also noticed a repeated risk pattern. Reply yes to save it to memory or no to ignore.";
}

function hasLowSleepHighImpulsePair(events: StoredEvent[]): boolean {
  const sleep = events.find((event) => event.type === "health.sleep_logged");
  const impulse = events.find(
    (event) =>
      event.type === "reflection.impulse_logged" &&
      event.data.kind === "gambling" &&
      typeof event.data.value === "number" &&
      event.data.value >= 6
  );
  const sleepHours = sleep?.data.duration_hours;

  return typeof sleepHours === "number" && sleepHours < 6 && Boolean(impulse);
}

function countLowSleepHighImpulseOccurrences(events: StoredEvent[]): number {
  const checkInMatches = events.filter((event) => {
    if (event.type !== "reflection.daily_checkin_completed") {
      return false;
    }

    const answers = event.data.answers;

    if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
      return false;
    }

    const record = answers as Record<string, unknown>;
    const sleep = record.sleep;
    const gamblingImpulse = record.gambling_impulse ?? record.gambling;

    return (
      typeof sleep === "number" &&
      sleep < 6 &&
      typeof gamblingImpulse === "number" &&
      gamblingImpulse >= 6
    );
  }).length;

  if (checkInMatches > 0) {
    return checkInMatches;
  }

  return hasLowSleepHighImpulsePair(events) ? 1 : 0;
}

function appendPendingMemoryNotice(reply: string, notice?: string): string {
  return notice ? `${reply} ${notice}` : reply;
}

class GithubFetchError extends Error {
  constructor(
    readonly code: "GITHUB_REPO_NOT_FOUND_OR_PRIVATE" | "GITHUB_RATE_LIMITED" | "GITHUB_FETCH_FAILED",
    message: string
  ) {
    super(message);
  }
}

class GmailSyncError extends Error {
  constructor(
    readonly code:
      | "GMAIL_AUTH_EXPIRED"
      | "GMAIL_ENCRYPTION_KEY_MISSING"
      | "GMAIL_PERMISSION"
      | "GMAIL_RATE_LIMITED"
      | "GMAIL_QUERY_INVALID"
      | "GMAIL_SYNC_FAILED",
    message: string,
    readonly stage: GmailErrorStage
  ) {
    super(message);
  }
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
