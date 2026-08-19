import Fastify from "fastify";
import {
  buildDailyReview,
  buildCustomGoalConfig,
  buildConversationControlDebug,
  composeAgentResponse,
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
  extractManualAction,
  parseActionDueDate,
  normalizeManualActionTitleKey,
  extractEvents,
  findGoalDuplicateWarnings,
  getLocalTodayRange,
  isRiskControlGoal,
  getGoalTemplate,
  detectConversationControlIntent,
  isConversationalMutationIntent,
  analyzeMultiIntentMessage,
  evaluateGoalGuardrails,
  looksLikeMultiIntentText,
  goalTemplates,
  CreateEmailSignalRuleInputSchema,
  UpdateEmailSignalRuleInputSchema,
  GithubPublicConnectionInputSchema,
  emailAdapterRegistry,
  getEmailAdapterDefinition,
  integrationRegistry,
  processMessage,
  processMessageFromAnalysis,
  routeIntent,
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
  type GithubPublicConnectionInput,
  type MessageIntent,
  type AgentResponse,
  type AgentResponseComposerInput,
  type DailyCoachResponse,
  type GoalSummary,
  type Goal,
  type ConversationIntentPlan,
  type ConversationIntentPlanItem,
  type MemoryEntry,
  type ProcessMessageResult,
  type SemanticRouterResult,
  type StoredEvent,
  type UpdateUserOperatingProfileInput
} from "@operator-agent/core";
import {
  analyzeMessageWithOpenAI,
  classifyEmailWithLLM,
  composeResponseWithOpenAI,
  createOpenAIClient,
  JobSearchEmailAllowedEventTypes,
  WorkActionEmailAllowedEventTypes,
  routeSemanticMessageWithLLM,
  type OpenAIMessageAnalysis
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
  createActionItem,
  createActionItemIfNotExists,
  createNotificationLog,
  createMemory,
  createPendingAction,
  replacePendingAction,
  expireOldPendingActions,
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
  getPendingActions,
  getOrCreateUserOperatingProfile,
  getMemories,
  getPendingEmailReviewCount,
  getRecentEvents,
  getRecentActionItems,
  getRelevantMemories,
  findExternalEvent,
  findGmailSemanticDuplicateEvent,
  findGmailSemanticDuplicateReviewItem,
  hasRecentNotificationLog,
  confirmPendingAction,
  createExternalEventIfNotExists,
  createGithubPublicConnection,
  createIntegrationSyncLog,
  ensureUser,
  getActiveEmailSignalRulesForConnection,
  getEmailSignalRules,
  getEmailReviewItem,
  getEmailReviewItems,
  getActionItem,
  getActionItems,
  getActionItemsEligibleForReminder,
  linkActionItemToGoal,
  updateGoalPriority,
  getIntegrationConnection,
  getIntegrationConnections,
  approveEmailReviewItem,
  approvePendingGmailReviewItemsForSemanticEvent,
  rejectPendingAction,
  rejectEmailReviewItem,
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
  type PendingAction,
  type PendingActionType,
  type IntegrationConnection,
  type EmailSignalRule,
  type EmailReviewItem,
  type ActionItem,
  type ActionItemReminderType,
  type CreateActionItemInput,
  updateIntegrationConnection,
  updateIntegrationConnectionConfig,
  updateIntegrationConnectionSyncState,
  updateEmailSignalRuleDefinition,
  updateEmailSignalRule,
  updateEmailSignalRuleSyncState,
  updateMemory,
  updateNotificationSettings,
  updateUserOperatingProfile,
  prisma
} from "@operator-agent/db";
import {
  buildGmailAutonomyState,
  formatIntervalMinutes,
  gmailRuleBehaviorLabel,
  gmailSyncModeSentence
} from "./conversation/gmail-autonomy.js";
import {
  buildOperatorAttentionState,
  buildEndDayMessage,
  buildStartDayMessage,
  buildTomorrowPrepMessage,
  dailyLoopStateInput,
  formatConversationTodayReply,
  formatEmailAttentionForConversation,
  formatOperatorAttentionForConversation,
  formatOperatorNextMoveForConversation,
  generateDailyOperatorBrief,
  shouldUseDailyCoachLLM
} from "./operator/attention.js";
import {
  buildConversationDailyReview,
  buildOnboardingState,
  composeOnboardingReply,
  formatConversationDailyReview,
  handleNaturalDailyLoopSettings
} from "./legacy/daily-conversation.js";
import { registerMessageRoutes } from "./routes/messages.js";
import { registerAgentRoutes, defaultAgentRouteHandlers } from "./routes/agent.js";
import { registerMemoryRoutes } from "./routes/memory.js";
import { registerNotificationSettingsRoutes } from "./routes/notification-settings.js";
import { registerCheckinsIngestRoutes } from "./routes/checkins-ingest.js";
import { registerInsightRoutes } from "./routes/insights.js";
import { registerPendingActionRoutes, applyPendingAction } from "./routes/pending-actions.js";
import { isRecord, stringFromRecord } from "./utils/records.js";
import { shouldUseOpenAIAnalysis } from "./utils/env.js";
import { isSnoozedDue } from "./utils/action-item.js";
import { goalPriorityRank, sortGoalsForDisplay } from "./utils/goal-priority.js";
import { inferActionGoalLink } from "./utils/action-goal-link.js";
import {
  containsUnsafeReflectionLanguage,
  isConfirmationMessage,
  isRejectionMessage,
  normalizeComparableText,
  normalizeForComparison,
  ordinalSelectionIndex,
  pendingEmailReviewLine,
  safeErrorForLog,
  sentenceLikeTitle,
  truncatePlainText
} from "./utils/text.js";
import { isGuardrailEvent } from "./utils/events.js";
import { getActiveOperatorReflections, isOperatorReflectionMemory } from "./utils/memory.js";
import {
  comparePendingActionCandidates,
  formatPendingActionCandidate,
  readPendingActionCandidates,
  selectPendingActionCandidate,
  toPendingActionCandidate,
  type PendingActionCandidate
} from "./actions/pending-candidate.js";
import {
  analyzeActionHygiene,
  createActionHygieneSession,
  formatActionHygieneDebug,
  formatActionHygieneReport,
  looksLikeUnresolvedHygieneReply,
  maybeRememberRecentActionMutationStatusFromReply,
  parseActionHygieneReply,
  resolveActionHygieneReply,
  storeActionHygieneSession
} from "./legacy/action-hygiene-conversation.js";
import {
  actionInputFromPlanSuggestion,
  detectPlanningRequestKind,
  findEquivalentOpenPlanAction,
  formatNextWeekPlanContextDebug,
  formatNextWeekPlanMessage,
  formatPendingNextWeekPlan,
  formatPlanDue,
  formatSkippedNextWeekPlanSuggestion,
  generateNextWeekPlanSuggestions,
  getPendingPlanEnd,
  getPendingPlanStart,
  parseNextWeekPlanReply,
  readPendingNextWeekPlanSuggestions,
  replacePendingPlan,
  summarizeNextWeekPlanContext,
  toPendingNextWeekPlanSuggestion,
  type PlanningRequestKind
} from "./legacy/planning-conversation.js";
import {
  appendWeeklyPlanningNextStep,
  buildWeeklyReviewContext,
  formatWeeklyReview,
  formatWeeklyReviewContextDebug,
  generateAndSaveWeeklyReview,
  getLatestWeeklyReview,
  getWeeklyReviewForWeek,
  summarizeWeeklyReviewContext,
  toWeeklyReviewMemory
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
import {
  archiveStaleJobSearchEmailRules,
  formatGmailEmailRuleSelectionLines,
  getVisibleGmailEmailRules,
  groupEmailRulesForHumanDisplay,
  isBuiltInEmailAdapter,
  type EmailRuleHumanDisplayGroup
} from "./gmail/gmail-rule-service.js";
import {
  addDaysToLocalDateString,
  daysBetweenLocalDates,
  formatDateInTimezone,
  formatLocalDateTime,
  getDateTimePart,
  isDateInRange,
  localDateStartUtc,
  pendingDecisionExpiry,
  startOfLocalWeek
} from "./utils/datetime.js";
import {
  answerGmailRuleQuestionForConversation,
  editActiveCustomGmailRuleForConversation,
  editPendingCustomGmailRule,
  enableEmailRuleForConversation,
  extractGmailRuleQuestionTarget,
  extractPendingCustomRuleGoalCorrection,
  extractPendingCustomRuleRemovedKeywords,
  extractPendingCustomRuleReplacementKeywords,
  formatGmailCapabilityGuidance,
  formatGmailCustomRuleGuidance,
  formatGmailNotificationTimingForConversation,
  formatGmailSetupForConversation,
  formatEmailRulesForConversation,
  handleGmailAutonomyPreferenceForConversation,
  isPendingCustomGmailRuleContext,
  isPendingCustomGmailRuleCreate,
  isUnsupportedGmailAutonomyPreference,
  looksLikeContextualDeleteAllEmailRules,
  looksLikeCustomGmailTrackingRequest,
  looksLikeEmailRuleOrGmailConversationText,
  looksLikeGmailAutonomyPreference,
  looksLikeGmailNotificationTimingQuestion,
  looksLikeGmailRuleQuestion,
  manageCustomGmailRuleForConversation,
  noActiveGmailRulesMessage,
  parseGmailAutonomyPreference,
  proposeCustomGmailRuleForConversation,
  reactivateOrReuseBuiltInEmailRule,
  resolvePendingCustomEmailRuleReply,
  shouldReleasePendingGmailAutonomyFocus
} from "./legacy/gmail-conversation.js";
import { createGoalProgressFromCompletedAction, createCustomGoalProgressEvent } from "./actions/goal-progress.js";
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
  GithubCommit,
  GmailErrorStage,
  GmailMessage,
  GmailMessagePart,
  GmailStoredToken,
  GmailTokenResponse,
  NextWeekPlanContext,
  NextWeekPlanSuggestion,
  PlanWindowKind,
  OperatorReflectionCandidate,
  OperatorReflectionContext,
  OperatorReflectionType,
  WeeklyEmailAttentionSummary,
  WeeklyReviewContext,
  WeeklyReviewDraft,
  WeeklyReviewMemory
} from "./server-types.js";

type ProcessRouteDebug = NonNullable<ProcessMessageResult["routeDebug"]>;

interface RoutedProcessReply {
  reply: string;
  routeDebug: ProcessRouteDebug;
}

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
    process: async (input) => {
      const parsed = { data: input };
      await ensureUser(parsed.data.userId);
      await expireOldPendingActions(parsed.data.userId);

    if (isStandaloneNowMessage(parsed.data.message)) {
      return replyOnly(parsed.data.userId, parsed.data.message, "What should I schedule now? Example: /action call Alex now");
    }

    const earlyGuardrailGoals = await getActiveGoals(parsed.data.userId);
    const earlyGuardrail = evaluateGoalGuardrails({
      text: parsed.data.message,
      activeGoals: earlyGuardrailGoals
    });

    if (earlyGuardrail.triggered && !earlyGuardrail.isReferenceOnly) {
      return createGuardianGuardrailReply(parsed.data.userId, parsed.data.message, earlyGuardrail);
    }

    let latestPendingAction = await getLatestPendingAction(parsed.data.userId);

    if (latestPendingAction) {
      if (shouldReleasePendingGmailAutonomyFocus(latestPendingAction, parsed.data.message)) {
        await rejectPendingAction(parsed.data.userId, latestPendingAction.id);
        latestPendingAction = undefined;
      } else {
        const pendingReply = await resolvePendingDecisionReply(parsed.data.userId, latestPendingAction, parsed.data.message);

        if (pendingReply) {
          return replyOnly(parsed.data.userId, parsed.data.message, pendingReply, {
            routerSource: "pending_decision",
            intent: latestPendingAction.type,
            handlerName: "resolvePendingDecisionReply",
            mutation:
              isConfirmationMessage(parsed.data.message) ||
              isRejectionMessage(parsed.data.message) ||
              (latestPendingAction.type === "email_review_context" && looksLikeEmailReviewContextAction(parsed.data.message)),
            reason: "Resolved existing pending decision before normal routing."
          });
        }
      }
    } else if (looksLikeExpiredPendingDecisionReply(parsed.data.message)) {
      return replyOnly(parsed.data.userId, parsed.data.message, "That pending decision expired. Please ask again.");
    }

    if (isPendingCustomGmailRuleCreate(latestPendingAction)) {
      const pendingGmailRoute = await handleSemanticRouterIntent(parsed.data.userId, parsed.data.message, latestPendingAction);

      if (pendingGmailRoute) {
        return replyOnly(parsed.data.userId, parsed.data.message, pendingGmailRoute.reply, pendingGmailRoute.routeDebug);
      }
    }

    if (looksLikeUnresolvedHygieneReply(parsed.data.message)) {
      return replyOnly(
        parsed.data.userId,
        parsed.data.message,
        "I don't have a visible cleanup item right now. Say 'clean up my tasks' first."
      );
    }

    const planningRequest = detectPlanningRequestKind(parsed.data.message);
    if (planningRequest) {
      return replyOnly(parsed.data.userId, parsed.data.message, await createPlanForConversation(parsed.data.userId, parsed.data.message, planningRequest));
    }

    const explicitMemory = extractExplicitMemory(parsed.data.message);

    if (explicitMemory) {
      await createMemory(parsed.data.userId, {
        ...explicitMemory,
        source: "explicit_user_request",
        confidence: 1,
        evidence: {
          message: parsed.data.message
        }
      });

      const actionResult = await maybeCreateManualActionFromText(parsed.data.userId, explicitMemory.summary);
      const replyText = actionResult.extraction.shouldCreateAction
        ? ["Saved to memory.", formatActionCreatedReply(actionResult)].join("\n")
        : actionResult.extraction.reason === "past_explicit_time"
          ? "Saved to memory.\nThat time has already passed. Use a future time, or say 'now'."
        : "Saved to memory.";

      return replyOnly(parsed.data.userId, parsed.data.message, replyText);
    }

    const activeGoalsForGuardrail = earlyGuardrailGoals;
    const surfaceGuardrail = evaluateGoalGuardrails({
      text: parsed.data.message,
      activeGoals: activeGoalsForGuardrail
    });

    if (surfaceGuardrail.triggered && !surfaceGuardrail.isReferenceOnly) {
      return createGuardianGuardrailReply(parsed.data.userId, parsed.data.message, surfaceGuardrail);
    }

    const directIntentBeforeSurface = routeIntent(parsed.data.message);

    if ((!surfaceGuardrail.triggered || surfaceGuardrail.isReferenceOnly) && !isFinancialRiskIntent(directIntentBeforeSurface)) {
      const surfaceReply = await handleConversationSurfaceIntent(parsed.data.userId, parsed.data.message);

      if (surfaceReply) {
        return replyOnly(parsed.data.userId, parsed.data.message, surfaceReply, {
          routerSource: "deterministic_surface",
          intent: detectConversationSurfaceIntent(parsed.data.message) ?? "unknown",
          handlerName: "handleConversationSurfaceIntent",
          mutation: surfaceReplyIncludesMutation(surfaceReply),
          reason: "Matched deterministic conversation surface intent."
        });
      }
    }

    const semanticRouterReply = await handleSemanticRouterIntent(parsed.data.userId, parsed.data.message, latestPendingAction);

    if (semanticRouterReply) {
      return replyOnly(parsed.data.userId, parsed.data.message, semanticRouterReply.reply, semanticRouterReply.routeDebug);
    }

    const recentEvents = await getRecentEvents(parsed.data.userId, 50);
    const activeGoals = activeGoalsForGuardrail;
    const activeMemories = await getActiveMemories(parsed.data.userId);
    const userOperatingProfile = await getOrCreateUserOperatingProfile(parsed.data.userId);
    const processInput = {
      ...parsed.data,
      recentEvents,
      userOperatingProfile
    };
    const manualActionResult = await maybeCreateManualActionFromText(parsed.data.userId, parsed.data.message);

    if (manualActionResult.extraction.shouldCreateAction) {
      return replyOnly(parsed.data.userId, parsed.data.message, formatActionCreatedReply(manualActionResult));
    }

    if (manualActionResult.extraction.reason === "past_explicit_time") {
      return replyOnly(parsed.data.userId, parsed.data.message, "That time has already passed. Use a future time, or say 'now'.");
    }

    const unhandledControlIntent = detectConversationControlIntent(parsed.data.message);

    if (isConversationalMutationIntent(unhandledControlIntent.intent)) {
      return replyOnly(
        parsed.data.userId,
        parsed.data.message,
        "I could not complete that change. Use /actions to check the exact task."
      );
    }

    const naturalCustomProgress = detectNaturalCustomProgress(parsed.data.message, activeGoals);

    if (naturalCustomProgress) {
      const event = await createCustomGoalProgressEvent(parsed.data.userId, naturalCustomProgress.goal, {
        metricKey: "focused_minutes",
        value: naturalCustomProgress.minutes,
        unit: "minutes",
        note: parsed.data.message
      });

      return {
        userId: parsed.data.userId,
        message: parsed.data.message,
        intent: "event_logging",
        mode: "fiscal",
        riskState: "GREEN",
        extractedEvents: [],
        reply: `Logged for ${naturalCustomProgress.goal.title}: ${naturalCustomProgress.minutes} focused minutes.`
      } satisfies ProcessMessageResult;
    }

    const ruleBasedStructuralProposal = detectStructuralProposal(parsed.data.message, activeGoals);

    if (ruleBasedStructuralProposal) {
      if (ruleBasedStructuralProposal.createPending !== false) {
        await createPendingAction(parsed.data.userId, {
          type: ruleBasedStructuralProposal.type,
          summary: ruleBasedStructuralProposal.summary,
          payload: ruleBasedStructuralProposal.payload,
          expiresAt: tomorrow()
        });
      }

      return replyOnly(parsed.data.userId, parsed.data.message, ruleBasedStructuralProposal.reply);
    }

    const openAIAnalysis = await maybeAnalyzeWithOpenAI(processInput, activeGoals, userOperatingProfile, activeMemories);
    const structuralProposal = detectOpenAIStructuralProposal(openAIAnalysis);

    if (structuralProposal) {
      if (structuralProposal.createPending !== false) {
        await createPendingAction(parsed.data.userId, {
          type: structuralProposal.type,
          summary: structuralProposal.summary,
          payload: structuralProposal.payload,
          expiresAt: tomorrow()
        });
      }

      return replyOnly(parsed.data.userId, parsed.data.message, structuralProposal.reply);
    }

    const result = withMemoryContextReply(analyzeMessage(processInput, openAIAnalysis), activeMemories);
    const savedEvents = await createEventsFromExtracted(result.userId, result.extractedEvents);
    const isRedFinancialRisk = isFinancialRiskIntent(result.intent) && result.riskState === "RED";
    const guardrail = evaluateGoalGuardrails({ text: result.message, activeGoals });

    if (isRedFinancialRisk) {
      const cooldownEvent = await createEvent(result.userId, {
        type: "finance.betting.cooldown_triggered",
        timestamp: new Date(),
        source: "manual",
        data: {
          intent: result.intent,
          reason: "red_risk_state",
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

      await maybeCreateRepeatedCooldownPendingMemory(result.userId, cooldownEvent);
      const composed = await composeFinalAgentResponse(result, {
        extractedEvents: [cooldownEvent]
      });

      return {
        ...result,
        reply: composed.reply
      };
    }

    const composed = await composeFinalAgentResponse(result, {
      extractedEvents: savedEvents.length > 0 ? savedEvents : undefined
    });

    return {
      ...result,
      reply: composed.reply
    } satisfies ProcessMessageResult;
    }
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
        error: "Gmail OAuth is not configured. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GMAIL_REDIRECT_URI."
      });
    }

    return {
      url: buildGmailOAuthUrl(request.params.userId, config)
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

        await createGmailConnection(userId, buildEncryptedGmailConnectionConfig({
          provider: "gmail",
          scope: "gmail.readonly",
          email
        }, token));
      } catch (error) {
        return reply.status(400).type("text/plain").send(safeGmailErrorMessage(error));
      }

      return reply.type("text/plain").send("Gmail connected. You can return to Telegram.");
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

function analyzeMessage(
  input: {
    userId: string;
    message: string;
    recentEvents: StoredEvent[];
    userOperatingProfile: Awaited<ReturnType<typeof getOrCreateUserOperatingProfile>>;
  },
  openAIAnalysis: OpenAIMessageAnalysis | undefined
): ProcessMessageResult {
  if (!openAIAnalysis) {
    return processMessage(input);
  }

  return processMessageFromAnalysis(input, {
    intent: openAIAnalysis.intent,
    mode: openAIAnalysis.mode,
    extractedEvents: openAIAnalysis.extractedEvents
  });
}

async function buildAgentContext(userId: string) {
  const activeGoals = await getActiveGoals(userId);
  const recentEvents = await getRecentEvents(userId, 10);
  const memories = await getRelevantMemories(userId, { limit: 5 });
  const profile = await getOrCreateUserOperatingProfile(userId);
  const todayRange = getLocalTodayRange(new Date(), await getUserTimezone(userId));
  const todayEvents = await getEventsBetween(userId, todayRange.start, todayRange.end);
  const todaySummary = buildDailyReview({
    userId,
    activeGoals,
    todayEvents,
    activeMemories: memories
  }).summary;

  return {
    activeGoals,
    recentEvents,
    memories,
    profile,
    todaySummary
  };
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


async function buildNextWeekPlanContext(
  userId: string,
  now: Date,
  timezone: string,
  planWindowKind: PlanWindowKind = "next_week"
): Promise<NextWeekPlanContext> {
  const currentLocalDate = formatDateInTimezone(now, timezone);
  const currentWeekStart = startOfLocalWeek(currentLocalDate);
  const currentWeekEnd = addDaysToLocalDateString(currentWeekStart, 6);
  const nextWeekStart = addDaysToLocalDateString(currentWeekStart, 7);
  const nextWeekEnd = addDaysToLocalDateString(nextWeekStart, 6);
  const planStartLocalDate = planWindowKind === "current_week" ? currentLocalDate : nextWeekStart;
  const planEndLocalDate = planWindowKind === "current_week" ? currentWeekEnd : nextWeekEnd;
  const planRangeStart = localDateStartUtc(planStartLocalDate, timezone);
  const planRangeEnd = localDateStartUtc(addDaysToLocalDateString(planEndLocalDate, 1), timezone);
  const weeklyContext = await buildWeeklyReviewContext(userId, undefined, timezone, now);
  const [latestWeeklyReview, allActions, activeMemories] = await Promise.all([
    getLatestWeeklyReview(userId),
    getActionItems(userId, { status: "all", limit: 300 }),
    getActiveMemories(userId)
  ]);
  const openActions = allActions.filter((action) => action.status === "open" || isSnoozedDue(action, now));
  const futureActionsNextWeek = openActions.filter((action) =>
    isDateInRange(action.dueAt, planRangeStart, planRangeEnd) ||
    isDateInRange(action.snoozedUntil, planRangeStart, planRangeEnd)
  );

  return {
    userId,
    timezone,
    now,
    planWindowKind,
    planStartLocalDate,
    planEndLocalDate,
    nextWeekStartLocalDate: planStartLocalDate,
    nextWeekEndLocalDate: planEndLocalDate,
    nextWeekRangeStart: planRangeStart,
    nextWeekRangeEnd: planRangeEnd,
    latestWeeklyReview,
    activeGoals: weeklyContext.activeGoals,
    goalsWithNoProgress: weeklyContext.goalsWithoutProgress,
    openActions,
    staleActions: weeklyContext.actionHygiene.suggestedCleanupCandidates,
    activeReflections: weeklyContext.activeReflections,
    recentEventsSummary: weeklyContext.eventsByType,
    guardrailGoals: weeklyContext.activeGoals.filter(isRiskControlGoal),
    guardrailEvents: weeklyContext.guardrailEvents,
    emailAttention: weeklyContext.emailAttention,
    futureActionsNextWeek,
    reviewedWeek: {
      weekStartLocalDate: weeklyContext.weekStartLocalDate,
      weekEndLocalDate: weeklyContext.weekEndLocalDate,
      reviewedEndLocalDate: weeklyContext.reviewedEndLocalDate
    }
  };
}

async function resolveNextWeekPlanReply(userId: string, pendingAction: PendingAction, message: string): Promise<string | undefined> {
  const parsed = parseNextWeekPlanReply(message);

  if (!parsed) {
    return undefined;
  }

  if (parsed.operation === "skip" || parsed.operation === "cancel") {
    await rejectPendingAction(userId, pendingAction.id);
    return "Skipped next-week plan. No actions created.";
  }

  const timezone = typeof pendingAction.payload.timezone === "string" ? pendingAction.payload.timezone : await getUserTimezone(userId);
  const suggestions = readPendingNextWeekPlanSuggestions(pendingAction.payload.suggestions);

  if (parsed.operation === "show") {
    return formatPendingNextWeekPlan(timezone, pendingAction.payload, suggestions);
  }

  if (parsed.operation === "remove") {
    const kept = suggestions.filter((suggestion) => suggestion.index !== parsed.index)
      .map((suggestion, index) => ({ ...suggestion, index: index + 1 }));

    await replacePendingAction(userId, {
      type: "next_week_plan",
      summary: pendingAction.summary,
      payload: {
        ...pendingAction.payload,
        suggestions: kept.map(toPendingNextWeekPlanSuggestion)
      },
      expiresAt: pendingDecisionExpiry()
    });

    return formatPendingNextWeekPlan(timezone, pendingAction.payload, kept);
  }

  if (parsed.operation === "edit") {
    const suggestion = suggestions.find((item) => item.index === parsed.index);

    if (!suggestion) {
      return `No suggestion ${parsed.index}. Reply show plan to see the current list.`;
    }

    if (suggestion.creatable === false || suggestion.planKind === "cleanup") {
      return `Suggestion ${parsed.index} is cleanup for an existing action. I did not move it. Use /action_hygiene or say: move ${suggestion.existingActionTitle ?? suggestion.title} to ${parsed.timeText}.`;
    }

    if (suggestion.duplicateRisk || suggestion.existingActionId) {
      return `Suggestion ${parsed.index} is already covered by an existing action. I did not move it. To move the existing action, say: move ${suggestion.existingActionTitle ?? suggestion.title} to ${parsed.timeText}.`;
    }

    const planStart = getPendingPlanStart(pendingAction.payload);
    const planEnd = getPendingPlanEnd(pendingAction.payload);
    const parsedTime = parseActionDueDate(parsed.timeText, {
      now: localDateStartUtc(planStart, timezone),
      timezone,
      preferences: await getOrCreateNotificationSettings(userId)
    });
    const dueAt = parsedTime.dueAt;

    if (!dueAt || !planStart || !planEnd || dueAt < localDateStartUtc(planStart, timezone) || dueAt >= localDateStartUtc(addDaysToLocalDateString(planEnd, 1), timezone)) {
      return "That edit does not land inside the planning window. Try: edit 2 to Friday morning.";
    }

    const updated = suggestions.map((item) => item.index === parsed.index ? { ...item, suggestedDueAt: dueAt } : item);

    await replacePendingAction(userId, {
      type: "next_week_plan",
      summary: pendingAction.summary,
      payload: {
        ...pendingAction.payload,
        suggestions: updated.map(toPendingNextWeekPlanSuggestion)
      },
      expiresAt: pendingDecisionExpiry()
    });

    return `Updated suggestion ${parsed.index}: ${suggestion.title} -> ${formatPlanDue(dueAt, timezone)}.`;
  }

  if (parsed.operation === "create") {
    const selected = parsed.all ? suggestions : suggestions.filter((suggestion) => parsed.indexes.includes(suggestion.index));

    if (selected.length === 0) {
      return "No matching suggestions. Reply show plan to see the current list.";
    }

    const created: string[] = [];
    const covered: string[] = [];
    const skipped: string[] = [];
    const context = await buildNextWeekPlanContext(
      userId,
      new Date(),
      timezone,
      pendingAction.payload.planWindowKind === "current_week" ? "current_week" : "next_week"
    );

    for (const suggestion of selected) {
      if (suggestion.creatable === false || suggestion.planKind === "cleanup") {
        skipped.push(formatSkippedNextWeekPlanSuggestion(suggestion));
        continue;
      }

      const duplicate = findEquivalentOpenPlanAction(context, suggestion.title, suggestion.suggestedDueAt, suggestion.dedupeKey);

      if (duplicate || suggestion.duplicateRisk) {
        covered.push(`${suggestion.title}${duplicate?.title ? ` (${duplicate.title})` : ""}`);
        continue;
      }

      const actionInput = actionInputFromPlanSuggestion(suggestion, pendingAction.payload);
      const result = await createActionItemIfNotExists(userId, actionInput);

      if (result.created) {
        created.push(result.actionItem.title);
      } else {
        covered.push(result.actionItem.title);
      }
    }

    await confirmPendingAction(userId, pendingAction.id);

    return [
      skipped.length > 0 ? "Skipped:" : undefined,
      ...skipped.map((line) => `- ${line}`),
      created.length > 0 ? "Created actions:" : undefined,
      ...created.map((title) => `- ${title}`),
      covered.length > 0 ? "Already covered:" : undefined,
      ...covered.map((title) => `- ${title}`),
      created.length === 0 && covered.length === 0 ? "No actions created." : undefined
    ].filter(Boolean).join("\n");
  }

  return undefined;
}

type ConversationSurfaceIntent =
  | "capability_help"
  | "setup_state"
  | "quickstart"
  | "configure_goals"
  | "configure_actions"
  | "configure_daily_loop"
  | "configure_integrations"
  | "operator_attention_query"
  | "operator_next_move_query"
  | "daily_operator"
  | "start_day"
  | "daily_review"
  | "weekly_review"
  | "next_week_plan"
  | "current_week_plan"
  | "ambiguous_plan"
  | "action_hygiene"
  | "show_goals"
  | "show_actions"
  | "show_memory"
  | "email_attention_query"
  | "email_review_inbox"
  | "email_review_action"
  | "email_review_summary"
  | "goal_signal_query"
  | "email_rules_list"
  | "gmail_sync"
  | "integration_sync"
  | "gmail_sync_guidance"
  | "gmail_setup"
  | "gmail_autonomy_preference"
  | "gmail_capability_guidance"
  | "gmail_custom_rule_guidance"
  | "gmail_custom_rule_request"
  | "gmail_custom_rule_manage"
  | "gmail_rule_question"
  | "gmail_custom_rule_edit_guidance"
  | "enable_job_search_email_rule"
  | "enable_work_action_email_rule"
  | "integration_guidance"
  | "daily_loop_settings";

async function handleConversationSurfaceIntent(userId: string, message: string): Promise<string | undefined> {
  const intent = detectConversationSurfaceIntent(message);

  if (!intent) {
    return undefined;
  }

  if (intent === "capability_help") {
    return composeOnboardingReply(await buildOnboardingState(userId, new Date(), await getUserTimezone(userId)), "explain_capabilities");
  }

  if (intent === "setup_state") {
    return composeOnboardingReply(await buildOnboardingState(userId, new Date(), await getUserTimezone(userId)), "setup_overview");
  }

  if (intent === "quickstart") {
    return composeOnboardingReply(await buildOnboardingState(userId, new Date(), await getUserTimezone(userId)), "quickstart");
  }

  if (intent === "configure_goals") {
    return composeOnboardingReply(await buildOnboardingState(userId, new Date(), await getUserTimezone(userId)), "configure_goals");
  }

  if (intent === "configure_actions") {
    return composeOnboardingReply(await buildOnboardingState(userId, new Date(), await getUserTimezone(userId)), "configure_actions");
  }

  if (intent === "configure_daily_loop") {
    return composeOnboardingReply(await buildOnboardingState(userId, new Date(), await getUserTimezone(userId)), "configure_daily_loop");
  }

  if (intent === "configure_integrations") {
    return composeOnboardingReply(await buildOnboardingState(userId, new Date(), await getUserTimezone(userId)), "configure_integrations");
  }

  if (intent === "operator_attention_query") {
    return formatOperatorAttentionForConversation(await buildOperatorAttentionState(userId));
  }

  if (intent === "operator_next_move_query") {
    const state = await buildOperatorAttentionState(userId);
    return formatOperatorNextMoveForConversation(state);
  }

  if (intent === "daily_operator") {
    return formatConversationTodayReply(await generateDailyOperatorBrief(userId));
  }

  if (intent === "start_day") {
    return buildStartDayMessage(userId, new Date());
  }

  if (intent === "daily_review") {
    return formatConversationDailyReview(await buildConversationDailyReview(userId));
  }

  if (intent === "weekly_review") {
    const timezone = await getUserTimezone(userId);
    const now = new Date();
    const context = await buildWeeklyReviewContext(userId, undefined, timezone, now);
    const existing = await getWeeklyReviewForWeek(userId, context.weekStartLocalDate);
    const existingReview = existing ? toWeeklyReviewMemory(existing) : undefined;
    const shouldRegenerate =
      !existingReview ||
      !existingReview.reviewedEndLocalDate ||
      existingReview.reviewedEndLocalDate < context.reviewedEndLocalDate;
    const review = shouldRegenerate ? await generateAndSaveWeeklyReview(userId, context) : existingReview;
    return appendWeeklyPlanningNextStep(formatWeeklyReview(review));
  }

  if (intent === "next_week_plan") {
    return createPlanForConversation(userId, message, "next_week");
  }

  if (intent === "current_week_plan") {
    return createPlanForConversation(userId, message, "current_week");
  }

  if (intent === "ambiguous_plan") {
    return createPlanForConversation(userId, message, "ambiguous");
  }

  if (intent === "action_hygiene") {
    const now = new Date();
    const { report } = await createActionHygieneSession(userId, message, now, "legacy_conversation_surface");
    return formatActionHygieneReport(report);
  }

  if (intent === "show_goals") {
    return formatGoalsForConversation(await getGoals(userId));
  }

  if (intent === "show_actions") {
    return formatActionsForConversation(await getActionItems(userId, { status: "open", limit: 10 }));
  }

  if (intent === "show_memory") {
    return formatMemoriesForConversation(await getActiveMemories(userId));
  }

  if (intent === "email_attention_query" || intent === "email_review_summary" || intent === "goal_signal_query") {
    return formatEmailAttentionForConversation(await buildOperatorAttentionState(userId));
  }

  if (intent === "email_review_inbox") {
    return (await buildEmailReviewInboxResponse(userId, { storeContext: true })).message;
  }

  if (intent === "email_review_action") {
    return "Run \"email reviews\" first so I can number the visible items safely.";
  }

  if (intent === "email_rules_list") {
    return formatEmailRulesForConversation(userId, message);
  }

  if (intent === "gmail_sync") {
    return syncGmailForConversation(userId);
  }

  if (intent === "integration_sync") {
    return syncIntegrationsForConversation(userId);
  }

  if (intent === "gmail_sync_guidance") {
    return looksLikeGmailNotificationTimingQuestion(message)
      ? formatGmailNotificationTimingForConversation(userId, message)
      : "For Gmail, say 'sync Gmail' after connecting Gmail and enabling a rule.";
  }

  if (intent === "gmail_setup") {
    return formatGmailSetupForConversation(userId);
  }

  if (intent === "gmail_autonomy_preference") {
    return handleGmailAutonomyPreferenceForConversation(userId, message);
  }

  if (intent === "gmail_capability_guidance") {
    return formatGmailCapabilityGuidance(userId);
  }

  if (intent === "gmail_custom_rule_guidance") {
    return formatGmailCustomRuleGuidance();
  }

  if (intent === "gmail_custom_rule_request") {
    return proposeCustomGmailRuleForConversation(userId, message);
  }

  if (intent === "gmail_custom_rule_manage") {
    return manageCustomGmailRuleForConversation(userId, message);
  }

  if (intent === "gmail_rule_question") {
    return answerGmailRuleQuestionForConversation(userId, message);
  }

  if (intent === "gmail_custom_rule_edit_guidance") {
    return "Keyword edits for custom Gmail rules are not ready yet. For now, remove the rule and create a new one with the filters you want.";
  }

  if (intent === "enable_job_search_email_rule") {
    return enableEmailRuleForConversation(userId, "job_search");
  }

  if (intent === "enable_work_action_email_rule") {
    return enableEmailRuleForConversation(userId, "work_action");
  }

  if (intent === "integration_guidance") {
    return formatIntegrationGuidance(message);
  }

  if (intent === "daily_loop_settings") {
    return handleNaturalDailyLoopSettings(userId, message);
  }

  return undefined;
}

async function syncGmailForConversation(userId: string): Promise<string> {
  const gmailConnections = (await getIntegrationConnections(userId)).filter(
    (connection) => connection.integrationId === "gmail" && connection.status === "active"
  );

  if (gmailConnections.length === 0) {
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
    if (safeError.includes("Gmail token encryption key is missing") || safeError.startsWith("Gmail sync failed:")) {
      return safeError;
    }

    return `Gmail sync failed: ${safeError}`;
  }

  if ((result.emailSummaries?.length ?? 0) === 0 && result.emailRuleDiagnostics?.activeRulesForConnection === 0) {
    return appendPendingEmailReviewLine(noActiveGmailRulesMessage(), result.pendingEmailReviewCount ?? 0);
  }

  const totals = gmailSyncTotals(result.emailSummaries ?? []);
  return [
    formatGmailSyncTotalsForConversation(totals),
    pendingEmailReviewLine(result.pendingEmailReviewCount ?? 0)
  ].filter(Boolean).join("\n\n");
}

function formatGmailSyncTotalsForConversation(totals: ReturnType<typeof gmailSyncTotals>): string {
  if (totals.reviewItemsCreated > 0 && totals.eventsCreated > 0) {
    return `Gmail sync: ${totals.messagesFound} messages checked, ${totals.reviewItemsCreated} new review item${totals.reviewItemsCreated === 1 ? "" : "s"}, ${totals.eventsCreated} event${totals.eventsCreated === 1 ? "" : "s"} logged.`;
  }

  if (totals.reviewItemsCreated > 0) {
    return `Gmail sync: ${totals.messagesFound} messages checked, ${totals.reviewItemsCreated} new review item${totals.reviewItemsCreated === 1 ? "" : "s"}.`;
  }

  if (totals.eventsCreated > 0) {
    return `Gmail sync: ${totals.messagesFound} messages checked, ${totals.eventsCreated} event${totals.eventsCreated === 1 ? "" : "s"} logged.`;
  }

  return `Gmail sync: ${totals.messagesFound} messages checked, 0 new items.`;
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
      processed: totals.processed + summary.processed,
      ignoredUnknown: totals.ignoredUnknown + summary.ignoredUnknown,
      deduped: totals.deduped + summary.deduped,
      semanticDeduped: totals.semanticDeduped + summary.semanticDeduped,
      reviewItemsCreated: totals.reviewItemsCreated + summary.reviewItemsCreated,
      eventsCreated: totals.eventsCreated + summary.eventsCreated
    }),
    {
      messagesFound: 0,
      processed: 0,
      ignoredUnknown: 0,
      deduped: 0,
      semanticDeduped: 0,
      reviewItemsCreated: 0,
      eventsCreated: 0
    }
  );
}

function dedupeLines(lines: string[]): string[] {
  return [...new Set(lines.filter((line) => line.trim().length > 0))];
}

async function handleSemanticRouterIntent(
  userId: string,
  message: string,
  pendingAction?: PendingAction
): Promise<RoutedProcessReply | undefined> {
  const deterministicRoute = detectDeterministicSemanticRouterIntent(message, pendingAction);
  const semanticRouterAttempted = shouldUseSemanticRouterLLM();
  const llmRoute = semanticRouterAttempted ? await maybeRouteSemanticMessageWithLLM(userId, message, pendingAction) : undefined;
  const route = selectSemanticRouterRoute(deterministicRoute, llmRoute, pendingAction);
  const routerSource = route && llmRoute && route === llmRoute ? "llm_semantic" : "deterministic_semantic";

  if (!route || route.intent === "unknown" || route.confidence < 0.68) {
    return undefined;
  }

  let reply: string | undefined;
  let handlerName = "handleSemanticRouterIntent";
  let mutation = false;

  if (route.intent === "capability_help") {
    handlerName = "composeOnboardingReply";
    reply = composeOnboardingReply(await buildOnboardingState(userId, new Date(), await getUserTimezone(userId)), "explain_capabilities");
  }

  if (route.intent === "quickstart") {
    handlerName = "composeOnboardingReply";
    reply = composeOnboardingReply(await buildOnboardingState(userId, new Date(), await getUserTimezone(userId)), "quickstart");
  }

  if (route.intent === "setup_state") {
    handlerName = "composeOnboardingReply";
    reply = composeOnboardingReply(await buildOnboardingState(userId, new Date(), await getUserTimezone(userId)), "setup_overview");
  }

  if (route.intent === "configure_goals") {
    handlerName = "composeOnboardingReply";
    reply = composeOnboardingReply(await buildOnboardingState(userId, new Date(), await getUserTimezone(userId)), "configure_goals");
  }

  if (route.intent === "configure_actions") {
    handlerName = "composeOnboardingReply";
    reply = composeOnboardingReply(await buildOnboardingState(userId, new Date(), await getUserTimezone(userId)), "configure_actions");
  }

  if (route.intent === "configure_daily_loop") {
    handlerName = "composeOnboardingReply";
    reply = composeOnboardingReply(await buildOnboardingState(userId, new Date(), await getUserTimezone(userId)), "configure_daily_loop");
  }

  if (route.intent === "configure_integrations") {
    handlerName = "composeOnboardingReply";
    reply = composeOnboardingReply(await buildOnboardingState(userId, new Date(), await getUserTimezone(userId)), "configure_integrations");
  }

  if (route.intent === "operator_attention_query") {
    handlerName = "buildOperatorAttentionState";
    reply = formatOperatorAttentionForConversation(await buildOperatorAttentionState(userId));
  }

  if (route.intent === "operator_next_move_query") {
    handlerName = "buildOperatorAttentionState";
    reply = formatOperatorNextMoveForConversation(await buildOperatorAttentionState(userId));
  }

  if (route.intent === "daily_operator") {
    handlerName = "generateDailyOperatorBrief";
    reply = formatConversationTodayReply(await generateDailyOperatorBrief(userId));
  }

  if (route.intent === "start_day") {
    handlerName = "buildStartDayMessage";
    reply = await buildStartDayMessage(userId, new Date());
  }

  if (route.intent === "daily_review") {
    handlerName = "buildConversationDailyReview";
    reply = formatConversationDailyReview(await buildConversationDailyReview(userId, new Date()));
  }

  if (route.intent === "weekly_review") {
    handlerName = "generateAndSaveWeeklyReview";
    const timezone = await getUserTimezone(userId);
    const now = new Date();
    const context = await buildWeeklyReviewContext(userId, undefined, timezone, now);
    const existing = await getWeeklyReviewForWeek(userId, context.weekStartLocalDate);
    const existingReview = existing ? toWeeklyReviewMemory(existing) : undefined;
    const shouldRegenerate =
      !existingReview ||
      !existingReview.reviewedEndLocalDate ||
      existingReview.reviewedEndLocalDate < context.reviewedEndLocalDate;
    const review = shouldRegenerate ? await generateAndSaveWeeklyReview(userId, context) : existingReview;
    reply = appendWeeklyPlanningNextStep(formatWeeklyReview(review));
    mutation = shouldRegenerate;
  }

  if (route.intent === "current_week_plan" || route.intent === "next_week_plan" || route.intent === "ambiguous_plan") {
    handlerName = "createPlanForConversation";
    reply = await createPlanForConversation(
      userId,
      message,
      route.intent === "current_week_plan" ? "current_week" : route.intent === "next_week_plan" ? "next_week" : "ambiguous"
    );
    mutation = true;
  }

  if (route.intent === "action_hygiene") {
    handlerName = "analyzeActionHygiene";
    const now = new Date();
    const { report } = await createActionHygieneSession(userId, message, now, "legacy_semantic_surface");
    reply = formatActionHygieneReport(report);
    mutation = true;
  }

  if (route.intent === "show_goals") {
    handlerName = "formatGoalsForConversation";
    reply = formatGoalsForConversation(await getGoals(userId));
  }

  if (route.intent === "show_actions") {
    handlerName = "formatActionsForConversation";
    reply = formatActionsForConversation(await getActionItems(userId, { status: "open", limit: 10 }));
  }

  if (route.intent === "show_memory") {
    handlerName = "formatMemoriesForConversation";
    reply = formatMemoriesForConversation(await getActiveMemories(userId));
  }

  if (route.intent === "email_attention_query" || route.intent === "email_review_summary" || route.intent === "goal_signal_query") {
    handlerName = "buildOperatorAttentionState";
    reply = formatEmailAttentionForConversation(await buildOperatorAttentionState(userId));
  }

  if (route.intent === "email_review_inbox") {
    handlerName = "buildEmailReviewInboxResponse";
    reply = (await buildEmailReviewInboxResponse(userId, { storeContext: true })).message;
    mutation = true;
  }

  if (route.intent === "email_review_action") {
    handlerName = "resolveEmailReviewContextReply";
    const emailReviewContext = isPendingEmailReviewContext(pendingAction) ? pendingAction : undefined;
    reply = emailReviewContext
      ? await resolveEmailReviewContextReply(userId, emailReviewContext, message)
      : "Run \"email reviews\" first so I can number the visible items safely.";
    mutation = Boolean(reply && !/^Run "email reviews"/.test(reply));
  }

  if (route.intent === "email_rules_list") {
    handlerName = "formatEmailRulesForConversation";
    reply = await formatEmailRulesForConversation(userId, message);
  }

  if (route.intent === "integration_guidance") {
    handlerName = "formatIntegrationGuidance";
    reply = formatIntegrationGuidance(message);
  }

  if (route.intent === "integration_sync") {
    handlerName = "syncIntegrationsForConversation";
    reply = await syncIntegrationsForConversation(userId);
    mutation = true;
  }

  if (route.intent === "daily_loop_settings") {
    handlerName = "handleNaturalDailyLoopSettings";
    reply = await handleNaturalDailyLoopSettings(userId, message);
    mutation = reply.startsWith("Daily loop updated.");
  }

  if (route.intent === "gmail_capability_guidance") {
    handlerName = "formatGmailCapabilityGuidance";
    reply = await formatGmailCapabilityGuidance(userId);
  }

  if (route.intent === "gmail_setup") {
    handlerName = "formatGmailSetupForConversation";
    reply = await formatGmailSetupForConversation(userId);
  }

  if (route.intent === "gmail_autonomy_preference") {
    handlerName = "handleGmailAutonomyPreferenceForConversation";
    reply = await handleGmailAutonomyPreferenceForConversation(userId, message, route);
    mutation = reply.startsWith("I can set Gmail") || reply.startsWith("I can turn") || reply.startsWith("I can make Gmail");
  }

  if (route.intent === "gmail_sync") {
    handlerName = "syncGmailForConversation";
    reply = await syncGmailForConversation(userId);
    mutation = true;
  }

  if (route.intent === "gmail_sync_guidance") {
    handlerName = "formatGmailNotificationTimingForConversation";
    reply = looksLikeGmailNotificationTimingQuestion(message)
      ? await formatGmailNotificationTimingForConversation(userId, message, pendingAction, route)
      : "For Gmail, say 'sync Gmail' after connecting Gmail and enabling a rule.";
  }

  if (route.intent === "enable_job_search_email_rule") {
    handlerName = "enableEmailRuleForConversation";
    reply = await enableEmailRuleForConversation(userId, "job_search");
    mutation = reply.includes(" is on.");
  }

  if (route.intent === "enable_work_action_email_rule") {
    handlerName = "enableEmailRuleForConversation";
    reply = await enableEmailRuleForConversation(userId, "work_action");
    mutation = reply.includes(" is on.");
  }

  if (route.intent === "gmail_custom_rule_request") {
    if (route.confidence < 0.65) {
      handlerName = "proposeCustomGmailRuleForConversation";
      reply = "That is too broad. Give me a sender, company, project, or 2-3 keywords.";
    } else {
      handlerName = "proposeCustomGmailRuleForConversation";
      reply = await proposeCustomGmailRuleForConversation(userId, message, route);
      mutation = true;
    }
  }

  if (route.intent === "gmail_custom_rule_edit_pending") {
    if (isPendingCustomGmailRuleCreate(pendingAction)) {
      handlerName = "editPendingCustomGmailRule";
      reply = await editPendingCustomGmailRule(userId, pendingAction, route);
      mutation = reply.startsWith("Updated the pending Gmail rule.");
    } else {
      handlerName = "editActiveCustomGmailRuleForConversation";
      reply = await editActiveCustomGmailRuleForConversation(userId, message, route, pendingAction);
      mutation = reply.startsWith("Updated Gmail rule:");
    }
  }

  if (route.intent === "gmail_custom_rule_edit") {
    handlerName = "editActiveCustomGmailRuleForConversation";
    reply = await editActiveCustomGmailRuleForConversation(userId, message, route, pendingAction);
    mutation = reply.startsWith("Updated Gmail rule:");
  }

  if (route.intent === "gmail_custom_rule_manage") {
    handlerName = "manageCustomGmailRuleForConversation";
    reply = await manageCustomGmailRuleForConversation(userId, message, route, pendingAction);
    mutation =
      reply.startsWith("Gmail rule active:") ||
      reply.startsWith("Gmail rule paused:") ||
      reply.startsWith("Confirm remove Gmail rule:") ||
      reply.startsWith("Confirm remove ") && reply.includes("Gmail email rule");
  }

  if (route.intent === "gmail_rule_question") {
    handlerName = "answerGmailRuleQuestionForConversation";
    reply = await answerGmailRuleQuestionForConversation(userId, message, pendingAction, route);
  }

  if (route.intent === "conversation_repair") {
    handlerName = "formatConversationRepairReply";
    reply = formatConversationRepairReply(pendingAction, route);
  }

  if (!reply) {
    return undefined;
  }

  return {
    reply,
    routeDebug: {
      routerSource,
      intent: route.intent,
      handlerName,
      orchestrator: "legacy",
      handledBy: "legacy_semantic",
      plannerUsed: "legacy",
      semanticRouterAttempted,
      semanticRouterUsed: true,
      legacySemanticAttempted: true,
      legacySemanticUsed: true,
      operationPlanValidated: false,
      policyPrecheckResult: "passed",
      mutation,
      mutationExecuted: mutation,
      confidence: route.confidence,
      language: route.language,
      sideEffectRisk: route.sideEffectRisk,
      requiresConfirmation: route.requiresConfirmation,
      reason: route.reason
    }
  };
}

function selectSemanticRouterRoute(
  deterministicRoute: SemanticRouterResult | undefined,
  llmRoute: SemanticRouterResult | undefined,
  pendingAction?: PendingAction
): SemanticRouterResult | undefined {
  const usableLlmRoute = llmRoute && llmRoute.intent !== "unknown" && llmRoute.confidence >= 0.68 ? llmRoute : undefined;

  if (deterministicRoute?.intent === "conversation_repair") {
    return deterministicRoute;
  }

  if (deterministicRoute?.sideEffectRisk === "destructive") {
    return deterministicRoute;
  }

  if (usableLlmRoute && (isPendingCustomGmailRuleCreate(pendingAction) || isPendingCustomGmailRuleContext(pendingAction))) {
    return usableLlmRoute;
  }

  return deterministicRoute ?? usableLlmRoute;
}

function detectDeterministicSemanticRouterIntent(message: string, pendingAction?: PendingAction): SemanticRouterResult | undefined {
  const text = normalizeForComparison(message);
  const hasPendingCustomRule = isPendingCustomGmailRuleCreate(pendingAction);

  if (isPendingCustomGmailRuleContext(pendingAction)) {
    if (looksLikeContextualDeleteAllEmailRules(message)) {
      return {
        intent: "gmail_custom_rule_manage",
        operation: "remove",
        confidence: 0.92,
        reason: "User asks to delete/reset all email rules in the current Gmail rule context.",
        language: "unknown",
        sideEffectRisk: "destructive",
        requiresConfirmation: true,
        target: "all email rules",
        keywordFilters: [],
        senderFilters: [],
        removeKeywordFilters: [],
        goalHint: null,
        shouldUnlinkGoal: false,
        userFacingIssue: null
      };
    }
  }

  if (hasPendingCustomRule) {
    const replacementKeywords = extractPendingCustomRuleReplacementKeywords(message);
    const removeKeywordFilters = extractPendingCustomRuleRemovedKeywords(message);
    const goalCorrection = extractPendingCustomRuleGoalCorrection(message);

    if (replacementKeywords.length > 0 || removeKeywordFilters.length > 0 || goalCorrection) {
      return {
        intent: "gmail_custom_rule_edit_pending",
        operation: "edit_pending",
        confidence: 0.92,
        reason: "User is editing the pending Gmail custom rule proposal.",
        language: "unknown",
        sideEffectRisk: "write",
        requiresConfirmation: true,
        target: null,
        keywordFilters: replacementKeywords,
        senderFilters: [],
        removeKeywordFilters,
        goalHint: goalCorrection?.goalHint ?? null,
        shouldUnlinkGoal: goalCorrection?.shouldUnlinkGoal ?? false,
        userFacingIssue: null
      };
    }

    if (looksLikeGmailRuleQuestion(message)) {
      return {
        intent: "gmail_rule_question",
        operation: "answer",
        confidence: 0.9,
        reason: "User is asking about the pending Gmail rule proposal.",
        language: "unknown",
        sideEffectRisk: "read",
        requiresConfirmation: false,
        target: null,
        keywordFilters: [],
        senderFilters: [],
        removeKeywordFilters: [],
        goalHint: null,
        shouldUnlinkGoal: false,
        userFacingIssue: null
      };
    }
  }

  if (looksLikeGmailAutonomyPreference(message)) {
    const preference = parseGmailAutonomyPreference(message);
    return {
      intent: "gmail_autonomy_preference",
      operation: "edit",
      confidence: 0.94,
      reason: "User asks to change Gmail checking or notification preferences.",
      language: "unknown",
      sideEffectRisk: "write",
      requiresConfirmation: !isUnsupportedGmailAutonomyPreference(preference),
      target: null,
      keywordFilters: [],
      senderFilters: [],
      removeKeywordFilters: [],
      goalHint: null,
      shouldUnlinkGoal: false,
      userFacingIssue: null
    };
  }

  if (/\b(wtf|what are you doing|bro what|that's wrong|this is wrong|not good|you misunderstood|wrong goal|wrong rule)\b/.test(text)) {
    return {
      intent: "conversation_repair",
      operation: "repair",
      confidence: 0.86,
      reason: "User is complaining about a misunderstanding.",
      language: "unknown",
      sideEffectRisk: "none",
      requiresConfirmation: false,
      target: null,
      keywordFilters: [],
      senderFilters: [],
      removeKeywordFilters: [],
      goalHint: null,
      shouldUnlinkGoal: false,
      userFacingIssue: null
    };
  }

  if (
    /\b(anything important|what needs my attention|what should i handle|what should i focus on|what changed since yesterday|que tengo pendiente|qué tengo pendiente|que tinc pendent|què tinc pendent|hi ha alguna cosa important)\b/.test(text)
  ) {
    return {
      intent: /\b(first|primero|primer|handle first|do first|next move)\b/.test(text) ? "operator_next_move_query" : "operator_attention_query",
      operation: "review",
      confidence: 0.9,
      reason: "User asks for the current operator attention state.",
      language: "unknown",
      sideEffectRisk: "read",
      requiresConfirmation: false,
      target: null,
      keywordFilters: [],
      senderFilters: [],
      removeKeywordFilters: [],
      goalHint: null,
      shouldUnlinkGoal: false,
      userFacingIssue: null
    };
  }

  if (looksLikeEmailReviewInboxRequest(message)) {
    return {
      intent: "email_review_inbox",
      operation: "review",
      confidence: 0.94,
      reason: "User asks to show pending email review items.",
      language: "unknown",
      sideEffectRisk: "read",
      requiresConfirmation: false,
      target: null,
      keywordFilters: [],
      senderFilters: [],
      removeKeywordFilters: [],
      goalHint: null,
      shouldUnlinkGoal: false,
      userFacingIssue: null
    };
  }

  if (looksLikeEmailAttentionQuery(message)) {
    return {
      intent: "email_attention_query",
      operation: "review",
      confidence: 0.9,
      reason: "User asks whether Gmail/email items need action.",
      language: "unknown",
      sideEffectRisk: "read",
      requiresConfirmation: false,
      target: null,
      keywordFilters: [],
      senderFilters: [],
      removeKeywordFilters: [],
      goalHint: null,
      shouldUnlinkGoal: false,
      userFacingIssue: null
    };
  }

  if (isPendingEmailReviewContext(pendingAction) && looksLikeEmailReviewContextAction(message)) {
    return {
      intent: "email_review_action",
      operation: "review",
      confidence: 0.92,
      reason: "User is responding to visible email review context.",
      language: "unknown",
      sideEffectRisk: /reject|clear|dismiss|rechaza|descarta|borra|approve|accept|yes|aprueba|acepta|turn|make|create|task|action|remind|haz|crea|tarea/i.test(message)
        ? "write"
        : "read",
      requiresConfirmation: false,
      target: extractEmailReviewReference(message) ?? null,
      keywordFilters: [],
      senderFilters: [],
      removeKeywordFilters: [],
      goalHint: null,
      shouldUnlinkGoal: false,
      userFacingIssue: null
    };
  }

  if (looksLikeGmailNotificationTimingQuestion(message)) {
    return {
      intent: "gmail_sync_guidance",
      operation: "timing",
      confidence: 0.96,
      reason: "User asks when or how Gmail/email checks and notifications happen.",
      language: "unknown",
      sideEffectRisk: "read",
      requiresConfirmation: false,
      target: extractGmailRuleQuestionTarget(message) ?? null,
      keywordFilters: [],
      senderFilters: [],
      removeKeywordFilters: [],
      goalHint: null,
      shouldUnlinkGoal: false,
      userFacingIssue: null
    };
  }

  return undefined;
}

async function maybeRouteSemanticMessageWithLLM(
  userId: string,
  message: string,
  pendingAction?: PendingAction
): Promise<SemanticRouterResult | undefined> {
  if (!shouldUseSemanticRouterLLM()) {
    return undefined;
  }

  try {
    const [activeGoals, emailRules, goals] = await Promise.all([
      getActiveGoals(userId),
      getEmailSignalRules(userId),
      getGoals(userId)
    ]);
    const goalById = new Map(goals.map((goal) => [goal.id, goal.title]));

    return await routeSemanticMessageWithLLM({
      userId,
      message,
      activeGoals: activeGoals.map((goal) => ({
        id: goal.id,
        title: goal.title,
        category: goal.category,
        templateId: goal.templateId,
        status: goal.status
      })),
      activeEmailRules: emailRules
        .filter((rule) => rule.status !== "archived")
        .map((rule) => ({
          id: rule.id,
          adapterId: rule.adapterId,
          name: rule.name,
          query: rule.query,
          status: rule.status,
          goalTitle: rule.goalId ? goalById.get(rule.goalId) ?? null : null
        })),
      pendingAction: pendingAction
        ? {
            type: pendingAction.type,
            summary: pendingAction.summary,
            payload: sanitizePendingActionForSemanticRouter(pendingAction)
          }
        : null
    });
  } catch (error) {
    console.warn("Semantic router LLM failed; continuing deterministic routing.", safeErrorForLog(error));
    return undefined;
  }
}

function shouldUseSemanticRouterLLM(): boolean {
  return process.env.LLM_ROUTER_ENABLED === "true" && (Boolean(process.env.OPENAI_API_KEY) || Boolean(process.env.LLM_ROUTER_MOCK_RESPONSE));
}

function sanitizePendingActionForSemanticRouter(pendingAction: PendingAction): Record<string, unknown> {
  if (pendingAction.type !== "custom_email_rule" || !isRecord(pendingAction.payload)) {
    return {
      type: pendingAction.type,
      summary: pendingAction.summary
    };
  }

  return {
    operation: pendingAction.payload.operation,
    displayName: pendingAction.payload.displayName,
    keywordFilters: pendingAction.payload.keywordFilters,
    senderFilters: pendingAction.payload.senderFilters,
    goalTitle: pendingAction.payload.goalTitle,
    queryPreview: pendingAction.payload.queryPreview,
    focusedRuleId: pendingAction.payload.focusedRuleId,
    rules: pendingAction.payload.rules
  };
}

function formatConversationRepairReply(pendingAction: PendingAction | undefined, route: SemanticRouterResult): string {
  if (isPendingCustomGmailRuleCreate(pendingAction)) {
    return [
      "You are right to call that out.",
      "I was handling a pending Gmail rule. I should edit that rule or ask a clear question, not invent progress.",
      route.userFacingIssue ? `Issue: ${route.userFacingIssue}` : undefined,
      "Tell me the exact change, for example: \"make the Gmail rule look only for Endesa\" or \"remove the linked goal\"."
    ].filter(Boolean).join("\n");
  }

  return [
    "You are right to call that out.",
    "I should not pretend I changed something unless the database update actually happened.",
    "Tell me the exact change you wanted, or use /actions, /my_email_rules, or /today to check the current state."
  ].join("\n");
}

function detectConversationSurfaceIntent(message: string): ConversationSurfaceIntent | undefined {
  const text = normalizeForComparison(message);

  if (!text) {
    return undefined;
  }

  if (/^(help|what can you do|how do you work|how do i use this|how to use this|what do you help with)$/.test(text)) {
    return "capability_help";
  }

  if (/^(how do i start|how should i start|where do i start|start using alecto)$/.test(text)) {
    return "quickstart";
  }

  if (/^(help me set up|what should i configure|what is missing|setup|show setup|set me up)$/.test(text)) {
    return "setup_state";
  }

  if (/\b(set up goals|setup goals|help me choose goals|i want to set a goal|configure goals)\b/.test(text)) {
    return "configure_goals";
  }

  if (/\b(set up actions|setup actions|how do reminders work|how do tasks work|create my first task|set up tasks|setup tasks|configure actions|configure tasks)\b/.test(text)) {
    return "configure_actions";
  }

  if (/\b(set up daily loop|setup daily loop|configure daily loop|set up reminders|configure reminders)\b/.test(text)) {
    return "configure_daily_loop";
  }

  if (/\b(turn on|enable|set)\b.*\b(morning brief|evening review|daily loop|morning|evening)\b/.test(text) || /\bremind me every morning\b/.test(text)) {
    return "daily_loop_settings";
  }

  if (/\b(start my day|morning brief)\b/.test(text)) {
    return "start_day";
  }

  if (
    /\b(anything important|what needs my attention|what should i handle|what should i focus on|what changed since yesterday|what is important|que tengo pendiente|qué tengo pendiente|que tinc pendent|què tinc pendent|hi ha alguna cosa important)\b/.test(text)
  ) {
    return /\b(first|primero|primer|handle first|do first|next move)\b/.test(text)
      ? "operator_next_move_query"
      : "operator_attention_query";
  }

  if (/\b(what should i do today|what should i do now|show today|show my day|today plan|what is my plan today)\b/.test(text)) {
    return "daily_operator";
  }

  if (/\b(review my day|what happened today|how did today go|daily review)\b/.test(text)) {
    return "daily_review";
  }

  if (/\b(review my week|how did this week go|weekly review)\b/.test(text)) {
    return "weekly_review";
  }

  const planningRequest = detectPlanningRequestKind(message);
  if (planningRequest === "next_week") {
    return "next_week_plan";
  }

  if (planningRequest === "current_week") {
    return "current_week_plan";
  }

  if (planningRequest === "ambiguous") {
    return "ambiguous_plan";
  }

  if (/\b(clean up my tasks|clean up tasks|what tasks are stale|help me clean actions|clean up my actions|stale tasks)\b/.test(text)) {
    return "action_hygiene";
  }

  if (/\b(show my goals|show goals|list my goals|list goals)\b/.test(text)) {
    return "show_goals";
  }

  if (/\b(show my tasks|show tasks|show my actions|show actions|list tasks|list actions)\b/.test(text)) {
    return "show_actions";
  }

  if (/\b(show my memories|show memories|show my memory|list memories|what do you remember)\b/.test(text)) {
    return "show_memory";
  }

  if (looksLikeEmailReviewInboxRequest(message)) {
    return "email_review_inbox";
  }

  if (looksLikeEmailReviewContextAction(message)) {
    return "email_review_action";
  }

  if (looksLikeEmailAttentionQuery(message)) {
    return /\b(summary|resumen|resum)\b/.test(text) ? "email_review_summary" : "email_attention_query";
  }

  if (/\b(sync integrations|sync my integrations|update integrations|update my integrations|sync all integrations)\b/.test(text)) {
    return "integration_sync";
  }

  if (
    /\b(enable|turn on|activate|set up|setup|create)\b.*\b(job search|job|recruiter|application)\b.*\b(email rule|gmail rule|rule|gmail|email)\b/.test(text) ||
    /\b(enable|turn on|activate|set up|setup|create)\b.*\b(email rule|gmail rule|rule|gmail|email)\b.*\b(job search|job|recruiter|application)\b/.test(text)
  ) {
    return "enable_job_search_email_rule";
  }

  if (
    /\b(enable|turn on|activate|set up|setup|create)\b.*\b(work action|work actions|work email|work emails)\b.*\b(email rule|gmail rule|rule|gmail|email)\b/.test(text) ||
    /\b(enable|turn on|activate|set up|setup|create)\b.*\b(email rule|gmail rule|rule|gmail|email)\b.*\b(work action|work actions|work email|work emails)\b/.test(text)
  ) {
    return "enable_work_action_email_rule";
  }

  if (looksLikeGmailAutonomyPreference(message)) {
    return "gmail_autonomy_preference";
  }

  if (
    /^(connect gmail|set up gmail|setup gmail|gmail setup|show gmail setup|gmail status|show gmail status|configure gmail|gmail settings)$/.test(text) ||
    /\b(gmail|email)\b.*\b(setup|set up|status|settings|configure|configured|watching)\b/.test(text) ||
    /\b(how does gmail work|should gmail help with my goals|what gmail tracking is on)\b/.test(text)
  ) {
    return "gmail_setup";
  }

  if (
    /\b(sync gmail|sync my gmail|sync email|sync my email|check gmail now|check my gmail now|update gmail signals|update my gmail signals)\b/.test(text)
  ) {
    return "gmail_sync";
  }

  if (looksLikeGmailNotificationTimingQuestion(message)) {
    return "gmail_sync_guidance";
  }

  if (/\b(check my messages|check messages|check inbox|check my inbox|any emails|any email)\b/.test(text)) {
    return "gmail_sync_guidance";
  }

  if (
    /\b(show|list)\b.*\b(gmail|email)\b.*\brules?\b/.test(text) ||
    /\b(what|which|que|qué|quines?)\b.*\b(gmail|email)\b.*\b(rules?|checks?|tracking)\b/.test(text) ||
    /\b(gmail|email)\b.*\b(rules?|checks?|tracking)\b.*\b(have|tenemos|configured|on|active|enabled|running)\b/.test(text) ||
    /\b(what|which)\b.*\b(gmail|email)\b.*\brules?\b.*\b(on|active|enabled|configured|have|running)\b/.test(text) ||
    /\b(what|which)\b.*\brules?\b.*\b(gmail|email)\b.*\b(on|active|enabled|configured|have|running)\b/.test(text)
  ) {
    return "email_rules_list";
  }

  if (
    /\b(pause|resume|remove|delete|elimina|eliminar|borra|borrar|pausa|pausar|reanuda|reanudar|activa|activar)\b.*\b(gmail|email|mail|rule|rules|regla|reglas|tracking|emails|correos)\b/.test(text) ||
    /\b(reset|delete|remove|clear|archive)\b.*\b(all|every)\b.*\b(gmail|email|mail)\b.*\b(rules?|tracking|checks?)\b/.test(text) ||
    /\b(elimina|eliminar|borra|borrar|pausa|pausar|reanuda|reanudar|activa|activar)\b.*\b(endesa|aigues|aigües|barcelona)\b/.test(text)
  ) {
    return "gmail_custom_rule_manage";
  }

  if (/\b(what can gmail|how does gmail|gmail work|email tracking|gmail tracking|gmail rules|email rules)\b/.test(text)) {
    return "gmail_capability_guidance";
  }

  if (looksLikeGmailRuleQuestion(message)) {
    return "gmail_rule_question";
  }

  if (/\b(add|remove|change|edit)\s+(?:a\s+)?keyword\b/.test(text) && /\b(gmail|email|rule|tracking)\b/.test(text)) {
    return "gmail_custom_rule_edit_guidance";
  }

  if (looksLikeCustomGmailTrackingRequest(message)) {
    return "gmail_custom_rule_request";
  }

  if (/\b(endesa|receipt|receipts|bill|bills|invoice|invoices|custom gmail|custom email|keyword|keywords|filter|filters)\b/.test(text) && /\b(gmail|email|mail|inbox)\b/.test(text)) {
    return "gmail_custom_rule_guidance";
  }

  if (/\b(set up integrations|setup integrations|connect integrations)\b/.test(text)) {
    return "configure_integrations";
  }

  if (/\b(connect gmail|connect email|set up gmail|setup gmail|set up email|setup email|connect github|set up github|setup github)\b/.test(text)) {
    return "integration_guidance";
  }

  return undefined;
}

async function createGuardianGuardrailReply(
  userId: string,
  message: string,
  guardrail: ReturnType<typeof evaluateGoalGuardrails>
): Promise<ProcessMessageResult> {
  const intent = routeIntent(message);
  await createEvent(userId, {
    type: "finance.betting.cooldown_triggered",
    timestamp: new Date(),
    source: "manual",
    data: {
      intent,
      reason: "goal_guardrail",
      guardrail: {
        goalId: guardrail.goalId,
        goalTitle: guardrail.goalTitle,
        category: guardrail.guardrailCategory,
        severity: guardrail.severity,
        responseMode: guardrail.responseMode,
        blockedActionCreation: guardrail.blockedActionCreation,
        cooldownRequired: guardrail.cooldownRequired,
        reason: guardrail.reason
      }
    },
    evidence: [message],
    confidence: guardrail.confidence
  });

  return {
    userId,
    message,
    intent: isFinancialRiskIntent(intent) ? intent : "financial_impulse",
    mode: "guardian",
    riskState: "RED",
    extractedEvents: [],
    reply: "No. Hard stop. I am not helping you turn this into permission. Cooldown now. If it still matters later, bring a written thesis, exact size, invalidation point, and emotional state.",
    routeDebug: {
      routerSource: "deterministic_guardrail",
      intent: "goal_guardrail",
      handlerName: "createGuardianGuardrailReply",
      semanticRouterAttempted: false,
      semanticRouterUsed: false,
      mutation: true,
      policyPrecheckResult: "blocked_by_guardrail",
      reason: guardrail.reason
    }
  };
}

async function createPlanForConversation(userId: string, originalText: string, requestKind: PlanningRequestKind): Promise<string> {
  if (requestKind === "ambiguous") {
    const pending = await getLatestPendingAction(userId);

    if (pending?.type === "next_week_plan") {
      const timezone = typeof pending.payload.timezone === "string" ? pending.payload.timezone : await getUserTimezone(userId);
      return formatPendingNextWeekPlan(timezone, pending.payload, readPendingNextWeekPlanSuggestions(pending.payload.suggestions));
    }

    const recentWeeklyReview = await getLatestWeeklyReview(userId);

    if (!recentWeeklyReview) {
      return "Do you mean this week or next week?";
    }

    requestKind = "next_week";
  }

  const timezone = await getUserTimezone(userId);
  const now = new Date();
  const context = await buildNextWeekPlanContext(userId, now, timezone, requestKind === "current_week" ? "current_week" : "next_week");
  const suggestions = await generateNextWeekPlanSuggestions(context);
  await replacePendingPlan(userId, context, suggestions, originalText);

  return formatNextWeekPlanMessage(context, suggestions);
}

function formatGoalsForConversation(goals: Awaited<ReturnType<typeof getGoals>>): string {
  const active = sortGoalsForDisplay(goals).filter((goal) => goal.status === "active");
  if (active.length === 0) {
    return "No active goals.";
  }

  return ["Active goals:", ...active.slice(0, 10).map((goal, index) => `${index + 1}. ${goal.title} - ${goal.priority ?? "medium"}`)].join("\n");
}

function formatActionsForConversation(actions: Awaited<ReturnType<typeof getActionItems>>): string {
  if (actions.length === 0) {
    return "No open action items.";
  }

  return [
    "Open actions:",
    ...actions.slice(0, 10).map((action) =>
      `- ${action.title}${action.dueAt ? ` - due ${formatLocalDateTime(action.dueAt)}` : ""}${action.goalTitleSnapshot ? ` - goal: ${action.goalTitleSnapshot}` : ""}`
    )
  ].join("\n");
}

function formatMemoriesForConversation(memories: MemoryEntry[]): string {
  const visibleMemories = uniqueConversationMemories(memories);

  if (visibleMemories.length === 0) {
    return "No active memories.";
  }

  return ["Active memories:", ...visibleMemories.slice(0, 10).map((memory) => `- ${memory.summary}`)].join("\n");
}

function uniqueConversationMemories(memories: MemoryEntry[]): MemoryEntry[] {
  const seen = new Set<string>();
  const visible: MemoryEntry[] = [];

  for (const memory of memories) {
    if (isRecord(memory.data) && memory.data.kind === "weekly_review") {
      continue;
    }

    const key = normalizeComparableText(memory.summary);

    if (!key || seen.has(key)) {
      continue;
    }

    seen.add(key);
    visible.push(memory);
  }

  return visible;
}

function formatIntegrationGuidance(message: string): string {
  const text = normalizeForComparison(message);

  if (/\bgmail\b/.test(text)) {
    return [
      "Gmail setup is explicit and readonly.",
      "1. Connect Gmail with readonly access.",
      "2. Choose what Alecto should watch for.",
      "",
      "Ready today:",
      "- Job search: recruiter replies, interviews, rejections, offers, application confirmations.",
      "- Work actions: requests, deadlines, follow-ups, feedback, blockers. These go to review first.",
      "- Custom tracking: sender and keyword rules. These go to review first and never auto-log.",
      "",
      "Alecto will not scan Gmail until a rule is enabled.",
      "",
      "Say:",
      '- "enable job search rule for Gmail"',
      '- "enable work action rule for Gmail"',
      '- "track Endesa bills from Gmail"',
      "",
      "Shortcut: /connect_gmail"
    ].join("\n");
  }

  if (/\bgithub\b/.test(text)) {
    return [
      "GitHub setup is for public repos only.",
      "Use author=LOGIN when you want matching commits to count as personal progress. Without it, repo activity is only context.",
      "",
      "Example: /connect_github OWNER/REPO author=LOGIN."
    ].join("\n");
  }

  return [
    "Integrations are explicit and opt-in.",
    "- Gmail: readonly, rule-based scanning only after approval.",
    "- GitHub: public repos only; author=LOGIN is needed for personal commit progress.",
    "Optional shortcuts: /connect_gmail, /connect_github OWNER/REPO author=LOGIN, /my_integrations."
  ].join("\n");
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

function formatLocalActionDueKey(date: Date, timezone = "Europe/Madrid"): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);

  return `${getDateTimePart(parts, "year")}-${getDateTimePart(parts, "month")}-${getDateTimePart(parts, "day")} ${getDateTimePart(parts, "hour")}:${getDateTimePart(parts, "minute")}`;
}

async function maybeCreateManualActionFromText(
  userId: string,
  text: string,
  options: { forceActionIntent?: boolean; now?: Date } = {}
): Promise<{
  extraction: ReturnType<typeof extractManualAction>;
  action?: ActionItem;
  duplicate: boolean;
}> {
  const settings = await getOrCreateNotificationSettings(userId);
  const extraction = extractManualAction(
    { text },
    {
      forceActionIntent: options.forceActionIntent,
      now: options.now,
      timezone: settings.timezone,
      reminderPreferences: settings
    }
  );

  if (!extraction.shouldCreateAction || !extraction.title) {
    return { extraction, duplicate: false };
  }

  const duplicate = await findDuplicateManualAction(userId, extraction.title, extraction.dueAt, settings.timezone);

  if (duplicate) {
    return {
      extraction,
      action: duplicate,
      duplicate: true
    };
  }

  const description = [extraction.description, extraction.dueText && !extraction.dueAt ? `Due: ${extraction.dueText}.` : undefined]
    .filter(Boolean)
    .join(" ");
  const goalLink = await inferActionGoalLink(userId, extraction.title, description || undefined, extraction.evidence);
  const action = await createActionItem(userId, {
    source: "manual",
    goalId: goalLink.goalId ?? undefined,
    goalSlug: goalLink.goalSlug ?? undefined,
    goalTitleSnapshot: goalLink.matchedGoalTitle,
    title: extraction.title,
    description: description || undefined,
    priority: extraction.priority,
    dueAt: extraction.dueAt,
    project: extraction.project,
    actionType: extraction.actionType,
    evidence: extraction.evidence
  });

  return {
    extraction,
    action,
    duplicate: false
  };
}

async function findDuplicateManualAction(
  userId: string,
  title: string,
  dueAt?: Date,
  timezone = "Europe/Madrid"
): Promise<ActionItem | undefined> {
  const actions = await getRecentActionItems(userId, 100);
  const titleKey = normalizeManualActionTitleKey(title);
  const dueKey = dueAt ? formatLocalActionDueKey(dueAt, timezone) : "";

  return actions.find((action) => {
    if (action.source !== "manual" || (action.status !== "open" && action.status !== "snoozed")) {
      return false;
    }

    const actionDueKey = action.dueAt ? formatLocalActionDueKey(action.dueAt, timezone) : "";
    return normalizeManualActionTitleKey(action.title) === titleKey && actionDueKey === dueKey;
  });
}

function formatActionCreatedReply(input: {
  extraction: ReturnType<typeof extractManualAction>;
  action?: ActionItem;
  duplicate: boolean;
}): string {
  if (!input.action) {
    return "I could not turn that into a concrete action item.";
  }

  const dueLine = input.action.dueAt
    ? `due: ${formatLocalDateTime(input.action.dueAt, input.extraction.timezone)}`
    : input.extraction.dueText
      ? `due: ${input.extraction.dueText}`
      : undefined;

  return [
    input.duplicate ? `Action already exists: ${input.action.title}` : "Action created:",
    input.duplicate ? undefined : input.action.title,
    dueLine,
    `complete: /complete_action ${input.action.id}`,
    `snooze: /snooze_action ${input.action.id} tomorrow`,
    `archive: /archive_action ${input.action.id}`
  ]
    .filter(Boolean)
    .join("\n");
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

async function composeFinalAgentResponse(
  result: ProcessMessageResult,
  options: { extractedEvents?: StoredEvent[] } = {}
): Promise<AgentResponse> {
  const context = await buildAgentContext(result.userId);
  const input: AgentResponseComposerInput = {
    userId: result.userId,
    message: result.message,
    intent: result.intent,
    mode: result.mode,
    riskState: result.riskState,
    extractedEvents: options.extractedEvents,
    activeGoals: context.activeGoals,
    recentEvents: context.recentEvents,
    memories: context.memories,
    profile: context.profile,
    todaySummary: context.todaySummary
  };
  const fallback = composeAgentResponse(input);

  if (!shouldUseOpenAIAnalysis() || result.riskState === "RED" || fallback.mode === "support") {
    return fallback;
  }

  try {
    return await composeResponseWithOpenAI(input, fallback);
  } catch (error) {
    console.warn("OpenAI response composer failed; using deterministic reply.", error);
    return fallback;
  }
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

  try {
    const accessToken = await getValidGmailAccessToken(connection);

    for (const rule of rules) {
      const ruleSummary = createEmailRuleSyncSummary(rule);

      try {
        Object.assign(ruleSummary, await syncEmailSignalRule({ userId: connection.userId, accessToken, rule }));
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
    reviewCandidateDebug: []
  };
}

async function syncEmailSignalRule(input: {
  userId: string;
  accessToken: string;
  rule: EmailSignalRule;
}): Promise<EmailRuleSyncSummary> {
  const summary = createEmailRuleSyncSummary(input.rule);
  const messageIds = await withGmailStage("gmail_search", () => fetchEmailMessageIds(input.accessToken, input.rule));
  summary.messagesFound = messageIds.length;

  for (const messageId of messageIds.slice(0, input.rule.maxMessagesPerSync)) {
    if (summary.eventsCreated >= input.rule.maxEventsPerSync) {
      summary.skippedDueMaxEventsPerSync += 1;
      continue;
    }

    const message = await withGmailStage("gmail_message_fetch", () => getGmailMessage(input.accessToken, messageId));
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

    if (
      classification.decision === "needs_review" ||
      input.rule.reviewBeforeLogging ||
      classification.confidence < input.rule.minAutoLogConfidence
    ) {
      if (isReviewItemCapReached(input.rule, summary)) {
        summary.skippedDueMaxEventsPerSync += 1;
        continue;
      }

      if (classification.confidence < input.rule.minReviewConfidence) {
        summary.lowConfidenceIgnored += 1;
        continue;
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
  const securityNoise = classifySecurityAuthEmailNoise(rule, message, text);
  if (securityNoise) {
    return { classification: securityNoise };
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
    const llmClassification = await classifyEmailWithLLM({
      adapterId: rule.adapterId === "work_action_email" ? "work_action_email" : "job_search_email",
      source: "gmail",
      subject: getGmailHeader(message, "subject"),
      from: getGmailHeader(message, "from"),
      snippet: message.snippet,
      bodyText: text,
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

function isSecurityAuthAccountEmail(text: string): boolean {
  const normalized = normalizeForComparison(text);

  return [
    /\bsecurity code\b/,
    /\bverification code\b/,
    /\botp\b/,
    /\blogin code\b/,
    /\bsign in alert\b/,
    /\bsignin alert\b/,
    /\bsign in\b.*\balert\b/,
    /\bpassword reset\b/,
    /\breset your password\b/,
    /\baccount security\b/,
    /\btwo factor\b/,
    /\b2fa\b/,
    /\bauthentication\b/,
    /\bsuspicious login\b/,
    /\bdevice login\b/,
    /\bnew device\b.*\blogin\b/,
    /\baccount recovery\b/
  ].some((pattern) => pattern.test(normalized));
}

async function createEmailReviewItemForClassification(input: {
  userId: string;
  connectionId: string;
  rule: EmailSignalRule;
  message: GmailMessage;
  classification: ReturnType<typeof classifyJobSearchEmail>;
}) {
  const subject = getGmailHeader(input.message, "subject");
  const from = getGmailHeader(input.message, "from");
  const reviewExternalId = `gmail-review:${input.rule.id}:${input.message.id}`;
  const proposedEventType = input.classification.eventType ?? safeEmailReviewProposedType(input.classification.reason);
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
      snippet: input.message.snippet ? truncatePlainText(input.message.snippet, 300) : undefined,
      evidence: truncatePlainText(input.classification.evidence, 500),
      proposedEventType,
      confidence: input.classification.confidence,
      reason: input.classification.reason,
      extracted: input.classification.extracted
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
    snippet: input.message.snippet ? truncatePlainText(input.message.snippet, 300) : undefined,
    evidence: truncatePlainText(input.classification.evidence, 500),
    proposedEventType,
    confidence: input.classification.confidence,
    reason: input.classification.reason,
    extracted: input.classification.extracted
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





function looksLikeEmailAttentionQuery(message: string): boolean {
  const text = normalizeForComparison(message);

  if (!/\b(email|emails|gmail|mail|mails|inbox|correo|correos|correu|correus)\b/.test(text)) {
    return false;
  }

  return (
    /\b(need action|needs action|need my action|should handle|i should handle|important|came in|come in|anything from|reply|respond|pending|pendiente|pendientes|pendent|pendents|importante|importantes|importants?|accion|acción|accio|acció)\b/.test(text) ||
    /\b(do i need to reply|do i need to respond|did any important emails|what emails need action|what came in from gmail|anything from gmail|que correos tengo pendientes|qué correos tengo pendientes|hi ha correus importants)\b/.test(text)
  );
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

function gmailOAuthConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GMAIL_REDIRECT_URI ?? "http://localhost:3000/oauth/gmail/callback";

  return clientId && clientSecret ? { clientId, clientSecret, redirectUri } : undefined;
}

function buildGmailOAuthUrl(userId: string, config: { clientId: string; redirectUri: string }): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/gmail.readonly",
    access_type: "offline",
    prompt: "consent",
    state: Buffer.from(JSON.stringify({ userId }), "utf8").toString("base64url")
  });

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
}

function decodeGmailOAuthState(state: string): string | undefined {
  try {
    const parsed = JSON.parse(Buffer.from(state, "base64url").toString("utf8")) as { userId?: unknown };
    return typeof parsed.userId === "string" ? parsed.userId : undefined;
  } catch {
    return undefined;
  }
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

      throw new GmailSyncError("GMAIL_AUTH_EXPIRED", "Gmail authorization expired. Reconnect Gmail.", "token_refresh");
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

  if (lower.includes("gmail api has not been used") || lower.includes("disabled")) {
    return "Gmail API is disabled in Google Cloud project. Enable Gmail API and retry.";
  }

  if (lower.includes("gmail token encryption key is missing") || lower.includes("alecto_secret_encryption_key")) {
    return "Gmail token encryption key is missing. Set ALECTO_SECRET_ENCRYPTION_KEY and restart.";
  }

  if (lower.includes("refresh token") || lower.includes("invalid_grant") || lower.includes("unauthorized")) {
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
  const subject = getGmailHeader(message, "subject");
  const from = getGmailHeader(message, "from");
  const snippet = message.snippet ?? "";
  const body = decodeGmailBody(message.payload) || snippet;

  return [`Subject: ${subject}`, `From: ${from}`, `Snippet: ${snippet}`, `Body: ${body}`].filter(Boolean).join("\n");
}

function getGmailHeader(message: GmailMessage, name: string): string {
  return message.payload?.headers?.find((header) => header.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function decodeGmailBody(part?: GmailMessagePart): string {
  if (!part) {
    return "";
  }

  if (part.body?.data && (!part.mimeType || part.mimeType.startsWith("text/"))) {
    return decodeBase64Url(part.body.data);
  }

  return (part.parts ?? []).map(decodeGmailBody).filter(Boolean).join("\n").slice(0, 5000);
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

async function maybeAnalyzeWithOpenAI(
  input: {
    userId: string;
    message: string;
    recentEvents: StoredEvent[];
    userOperatingProfile: Awaited<ReturnType<typeof getOrCreateUserOperatingProfile>>;
  },
  activeGoals: Awaited<ReturnType<typeof getActiveGoals>>,
  userOperatingProfile: Awaited<ReturnType<typeof getOrCreateUserOperatingProfile>>,
  activeMemories: MemoryEntry[]
): Promise<OpenAIMessageAnalysis | undefined> {
  if (!shouldUseOpenAIAnalysis()) {
    return undefined;
  }

  try {
    return await analyzeMessageWithOpenAI({
      userId: input.userId,
      message: input.message,
      activeGoals,
      recentEvents: input.recentEvents,
      activeMemories,
      eventRegistry: [...eventRegistry],
      userOperatingProfile
    });
  } catch (error) {
    console.warn("OpenAI analysis failed; falling back to rule-based pipeline.", error);
    return undefined;
  }
}

function parseOptionalNow(value: string | undefined): Date | undefined {
  if (!value) {
    return undefined;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function parseOptionalDate(value: unknown): Date | undefined {
  return typeof value === "string" ? parseOptionalNow(value) : undefined;
}

function extractExplicitMemory(message: string): { type: MemoryEntry["type"]; summary: string } | undefined {
  const match = message.match(
    /\b(?:remember that|remember this|note that|acu[eé]rdate de que|recuerda que|guard[ae] que)\s+(.+)/i
  );
  const rawText = match?.[1]?.trim().replace(/[.!?]+$/g, "");

  if (!rawText) {
    return undefined;
  }

  const type = inferMemoryType(rawText);

  return {
    type,
    summary: normalizeMemorySummary(rawText)
  };
}

function inferMemoryType(text: string): MemoryEntry["type"] {
  if (/\b(prefiero|prefer|hate|odio|generic motivation|hablas? directo|directo|communication)\b/i.test(text)) {
    if (/\b(hablas? directo|directo|tone|communication|me hables|talk to me)\b/i.test(text)) {
      return "communication_style";
    }

    return "preference";
  }

  if (/\b(risk|apuesta|apostar|gambling|trading|betting)\b/i.test(text)) {
    return "risk_pattern";
  }

  if (/\b(goal|objetivo|context|porque|why)\b/i.test(text)) {
    return "goal_context";
  }

  return "note";
}

function normalizeMemorySummary(text: string): string {
  const trimmed = text.trim();
  const first = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return first.endsWith(".") ? first : `${first}.`;
}

function isStandaloneNowMessage(message: string): boolean {
  return /^now$/i.test(message.trim());
}

function isFinancialRiskIntent(intent: MessageIntent): boolean {
  return intent === "betting_intent" || intent === "trading_intent";
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

async function maybeCreateRepeatedCooldownPendingMemory(
  userId: string,
  cooldownEvent: StoredEvent
): Promise<string | undefined> {
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const cooldownEvents = (await getEventsSince(userId, since)).filter(
    (event) => event.type === "finance.betting.cooldown_triggered"
  );

  if (cooldownEvents.length < 2) {
    return undefined;
  }

  const summary = "User has repeated betting/trading cooldown events in the last 7 days.";

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
      confidence: 0.85,
      evidence: {
        cooldownCount: cooldownEvents.length,
        recentEventIds: cooldownEvents.map((event) => event.id),
        latestEventId: cooldownEvent.id
      }
    },
    expiresAt: tomorrow()
  });

  return "I also noticed a repeated risk pattern. Reply yes to save it to memory or no to ignore.";
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

async function hasSimilarActiveMemory(userId: string, summary: string): Promise<boolean> {
  return (await getActiveMemories(userId)).some(
    (memory) => memory.type === "risk_pattern" && areSimilarMemorySummaries(memory.summary, summary)
  );
}

async function hasPendingMemoryCreate(userId: string, summary: string): Promise<boolean> {
  return (await getPendingActions(userId)).some(
    (action) =>
      action.status === "pending" &&
      action.type === "memory_create" &&
      areSimilarMemorySummaries(action.summary, summary)
  );
}

function areSimilarMemorySummaries(left: string, right: string): boolean {
  const normalizedLeft = normalizeComparableText(left);
  const normalizedRight = normalizeComparableText(right);

  return (
    normalizedLeft === normalizedRight ||
    (isRepeatedCooldownSummary(normalizedLeft) && isRepeatedCooldownSummary(normalizedRight)) ||
    (isLowSleepGamblingImpulseSummary(normalizedLeft) && isLowSleepGamblingImpulseSummary(normalizedRight))
  );
}

function isRepeatedCooldownSummary(summary: string): boolean {
  return (
    summary.includes("repeated") &&
    (summary.includes("betting") || summary.includes("trading") || summary.includes("risk pattern")) &&
    summary.includes("cooldown")
  );
}

function isLowSleepGamblingImpulseSummary(summary: string): boolean {
  return summary.includes("low sleep") && summary.includes("gambling impulse");
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

function withMemoryContextReply(result: ProcessMessageResult, activeMemories: MemoryEntry[]): ProcessMessageResult {
  if (result.mode !== "guardian") {
    return result;
  }

  const riskMemory = activeMemories.find((memory) => memory.type === "risk_pattern");

  if (!riskMemory) {
    return result;
  }

  return {
    ...result,
    reply: `${result.reply} Memory signal: ${riskMemory.summary}`
  };
}

interface StructuralProposal {
  type: PendingActionType;
  summary: string;
  payload: Record<string, unknown>;
  reply: string;
  createPending?: boolean;
}

const hardGuardianPatch = {
  directness: 5,
  warmth: 3,
  confrontation: 5,
  profanityAllowed: true,
  motivationalStyle: "tough_love",
  accountabilityStrictness: 5,
  escalationStyle: "brutal_when_needed",
  gamblingGuardrails: "hard_guardian",
  selfDeceptionSensitivity: 5,
  cooldownPreference: "hard_no",
  vulnerableMode: "soften",
  avoidingMode: "confront",
  impulsiveMode: "guardian_mode"
} satisfies UpdateUserOperatingProfileInput;

const softProfilePatch = {
  directness: 3,
  warmth: 4,
  confrontation: 2,
  profanityAllowed: false,
  motivationalStyle: "gentle",
  accountabilityStrictness: 3,
  escalationStyle: "soft",
  gamblingGuardrails: "strict",
  selfDeceptionSensitivity: 4,
  cooldownPreference: "require_confirmation",
  vulnerableMode: "soften",
  avoidingMode: "nudge",
  impulsiveMode: "slow_down"
} satisfies UpdateUserOperatingProfileInput;

function detectStructuralProposal(
  message: string,
  activeGoals: Awaited<ReturnType<typeof getActiveGoals>>
): StructuralProposal | undefined {
  const normalized = message.toLowerCase();

  if (/\b(undo last event|undo last log|borra el ultimo evento|borra el último evento|deshaz el ultimo evento|deshaz el último evento)\b/i.test(message)) {
    return {
      type: "event_undo_last",
      summary: "Archive the last logged event/group",
      payload: {
        scope: "group",
        reason: "user requested undo"
      },
      reply: "Confirm undo last logged action? Reply yes to confirm or no to cancel."
    };
  }

  if (
    /\b(be stricter with me|be harder on me|don't let me justify bets|dont let me justify bets)\b/i.test(message) ||
    /(\bno me dejes justificar apuestas\b|\bs[eé] m[aá]s duro conmigo\b)/i.test(message)
  ) {
    return {
      type: "profile_update",
      summary: "Update profile to hard guardian mode",
      payload: { profilePatch: hardGuardianPatch },
      reply:
        "I can update your style to hard guardian: more direct, stricter on gambling/trading, and less validating of excuses. Reply yes to confirm or no to cancel."
    };
  }

  if (/\b(be softer|don't be so harsh|dont be so harsh|be more supportive)\b/i.test(message)) {
    return {
      type: "profile_update",
      summary: "Update profile to a softer support style",
      payload: { profilePatch: softProfilePatch },
      reply:
        "I can update your style to softer support: warmer, less confrontational, and more supportive. Reply yes to confirm or no to cancel."
    };
  }

  const archiveProposal = detectGoalArchiveProposal(message, activeGoals);

  if (archiveProposal) {
    return archiveProposal;
  }

  const progressProposal = detectCustomProgressProposal(message, activeGoals);

  if (progressProposal) {
    return progressProposal;
  }

  if (
    /\b(i want to focus on|create a goal to|my new focus is|i want to find|i want to get|i want to read|i want to stop|i want to build|i want to write|i want to create|i want to|quiero centrarme en|quiero mejorar|quiero buscar|quiero dormir|quiero|me gustar[ií]a)\b/i.test(
      message
    )
  ) {
    if (/\b(i want to bet|i want to trade|quiero apostar|quiero tradear)\b/i.test(message)) {
      return undefined;
    }

    const goalIntent = parseGoalCreationIntent(message);
    const classificationText = goalIntent?.goalText.toLowerCase() ?? normalized;
    const templateId = inferGoalTemplateId(classificationText);
    const template = templateId ? getGoalTemplate(templateId) : undefined;
    const category = template?.category ?? inferGoalCategory(classificationText);
    const title = templateId
      ? inferGoalTitle(goalIntent?.goalText ?? message, category, templateId)
      : goalIntent?.goalText ?? inferGoalTitle(message, category, templateId);
    const why = goalIntent?.why;
    const customConfig = templateId ? undefined : buildCustomGoalConfig({ title, category, why });

    return {
      type: "goal_create",
      summary: `Create goal: ${title}`,
      payload: {
        title,
        category: customConfig?.category ?? category,
        ...(why ? { why } : {}),
        ...(customConfig
          ? {
              targetMetrics: customConfig.targetMetrics,
              checkInConfig: customConfig.checkInConfig
            }
          : {}),
        ...(templateId ? { templateId } : {})
      },
      reply: customConfig
        ? formatCustomGoalCreateProposal(title, customConfig)
        : `I can create this goal: ${title} (${category}). Reply yes to confirm or no to cancel.`
    };
  }

  return undefined;
}

function parseGoalCreationIntent(message: string): { goalText: string; why?: string } | undefined {
  const withoutBoilerplate = message
    .replace(
      /^\s*(i want to focus on|create a goal to|my new focus is|i want to|i want|quiero centrarme en|quiero mejorar|quiero buscar|quiero|me gustar[ií]a)\s+/i,
      ""
    )
    .trim()
    .replace(/[.!?]+$/g, "");

  if (!withoutBoilerplate) {
    return undefined;
  }

  const whyMatch = withoutBoilerplate.match(
    /^(.+?)\s+(?:to create career leverage|to build discipline|for better mood|to feel better|to make more money|for more money|para crear palanca profesional|para tener m[aá]s disciplina)$/i
  );

  if (whyMatch?.[1]) {
    return {
      goalText: titleCaseGoal(whyMatch[1].trim()),
      why: withoutBoilerplate.slice(whyMatch[1].length).trim()
    };
  }

  return {
    goalText: titleCaseGoal(withoutBoilerplate)
  };
}

function detectCustomProgressProposal(
  message: string,
  activeGoals: Awaited<ReturnType<typeof getActiveGoals>>
): StructuralProposal | undefined {
  const match = message.match(
    /\b(?:log progress for|i made progress on|avance en)\s+(.+?)\s*:\s*(.+)$/i
  );

  if (!match) {
    return undefined;
  }

  const goalText = match[1]?.trim();
  const progressText = match[2]?.trim();

  if (!goalText || !progressText) {
    return undefined;
  }

  const goal = findGoalByTitleFragment(activeGoals, goalText);

  if (!goal) {
    return {
      type: "goal_progress_log",
      summary: "Goal progress needs a matching goal",
      payload: {},
      reply: "I am not sure which goal this belongs to. Run /goals, then use /log_progress <goalId> | <progress>.",
      createPending: false
    };
  }

  const progress = inferProgressInputFromText(progressText);

  return {
    type: "goal_progress_log",
    summary: `Log progress for ${goal.title}`,
    payload: {
      goalId: goal.id,
      ...progress
    },
    reply: `I can log progress for ${goal.title}: ${progress.note ?? progressText}. Reply yes to confirm or no to cancel.`
  };
}

function detectNaturalCustomProgress(
  message: string,
  activeGoals: Awaited<ReturnType<typeof getActiveGoals>>
): { goal: Awaited<ReturnType<typeof getActiveGoals>>[number]; minutes: number } | undefined {
  const match = message.match(
    /\b(?:worked|spent|hice)\s+(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|minutos?)\s+(?:on|en)\s+(?:my\s+)?(.+)$/i
  );

  if (!match?.[1] || !match[2]) {
    return undefined;
  }

  const minutes = Number(match[1]);

  if (!Number.isFinite(minutes)) {
    return undefined;
  }

  const goal = findMatchingCustomGoal(activeGoals, match[2]);

  return goal ? { goal, minutes } : undefined;
}

function findMatchingCustomGoal(
  activeGoals: Awaited<ReturnType<typeof getActiveGoals>>,
  text: string
) {
  const customGoals = activeGoals.filter((goal) => !goal.templateId && goal.status === "active");
  const normalizedText = normalizeComparableText(text);

  return customGoals.find((goal) => customGoalMatchesText(goal, normalizedText));
}

function customGoalMatchesText(goal: Awaited<ReturnType<typeof getActiveGoals>>[number], normalizedText: string): boolean {
  const goalTitle = normalizeComparableText(goal.title);

  if (goalTitle.includes(normalizedText) || normalizedText.includes(goalTitle)) {
    return true;
  }

  const goalWords = goalTitle.split(" ").filter((word) => word.length > 3);
  const hasSharedGoalWord = goalWords.some((word) => normalizedText.includes(word));

  if (hasSharedGoalWord) {
    return true;
  }

  if (
    /youtube|channel|script|video|content/.test(normalizedText) &&
    /youtube|channel|content|video/.test(goalTitle)
  ) {
    return true;
  }

  if (/car|dealership|seller|coche|carro/.test(normalizedText) && /car|coche|buy|cheap/.test(goalTitle)) {
    return true;
  }

  return false;
}

function findGoalByTitleFragment(
  activeGoals: Awaited<ReturnType<typeof getActiveGoals>>,
  goalText: string
) {
  const normalizedGoalText = normalizeComparableText(goalText);
  const matches = activeGoals.filter((goal) => {
    const normalizedTitle = normalizeComparableText(goal.title);
    return normalizedTitle === normalizedGoalText || normalizedTitle.includes(normalizedGoalText) || normalizedGoalText.includes(normalizedTitle);
  });

  return matches.length === 1 ? matches[0] : undefined;
}

function inferProgressInputFromText(text: string) {
  const minutesMatch = text.match(/\b(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|minutos?)\b/i);

  if (minutesMatch) {
    return {
      metricKey: "focused_minutes",
      value: Number(minutesMatch[1]),
      unit: "minutes",
      note: text
    };
  }

  return {
    metricKey: "progress_actions",
    value: 1,
    note: text
  };
}

function detectGoalArchiveProposal(
  message: string,
  activeGoals: Awaited<ReturnType<typeof getActiveGoals>>
): StructuralProposal | undefined {
  if (!/\b(archive|stop tracking|found a job|archiva|encontr[eé] trabajo)\b/i.test(message)) {
    return undefined;
  }

  const normalized = message.toLowerCase();
  const matchingGoals = activeGoals.filter((goal) => {
    const goalText = `${goal.title} ${goal.category}`.toLowerCase();

    if (normalized.includes("job") || normalized.includes("trabajo")) {
      return goal.category === "career" || goalText.includes("job");
    }

    return goal.title
      .toLowerCase()
      .split(/\s+/)
      .filter((word) => word.length > 3)
      .some((word) => normalized.includes(word));
  });

  if (matchingGoals.length !== 1) {
    return {
      type: "goal_archive",
      summary: "Goal archive needs an explicit goal id",
      payload: {},
      reply: "I am not sure which goal to archive. Run /goals and then /archive_goal <goalId>.",
      createPending: false
    };
  }

  const goal = matchingGoals[0];

  return {
    type: "goal_archive",
    summary: `Archive goal: ${goal.title}`,
    payload: { goalId: goal.id },
    reply: `I can archive this goal: ${goal.title} (${goal.category}). Reply yes to confirm or no to cancel.`
  };
}

function inferGoalCategory(message: string): string {
  if (/\b(job|cv|recruiter|interview|career|trabajo)\b/.test(message)) {
    return "career";
  }

  if (/\b(gym|strength|sleep|health|diet|steps|sueñ|salud)\b/.test(message)) {
    return "health";
  }

  if (/\b(read|study|course|learn|rust|leer|aprender|estudiar)\b/.test(message)) {
    return "learning";
  }

  if (/\b(startup|project|build|product)\b/.test(message)) {
    return "work";
  }

  if (/\b(betting|trading|gambling|bet|trade|apuesta|apostar)\b/.test(message)) {
    return "finance";
  }

  return "custom";
}

function inferGoalTemplateId(message: string): string | undefined {
  if (/\b(find a new job|find.*job|buscar trabajo|job search|cv|recruiter|interview)\b/.test(message)) {
    return "career.job_search";
  }

  if (/\b(get stronger|strength|gym|train|entrenar|fuerte)\b/.test(message)) {
    return "health.strength_energy";
  }

  if (/\b(sleep better|dormir mejor|sleep)\b/.test(message)) {
    return "health.sleep_better";
  }

  if (/\b(read more|leer m[aá]s|reading)\b/.test(message)) {
    return "learning.reading_more";
  }

  if (/\b(learn|study|course|rust|aprender|estudiar)\b/.test(message)) {
    return "learning.skill_learning";
  }

  if (/\b(stop betting|betting impulsively|control betting|control trading|apostar|apuestas|trading)\b/.test(message)) {
    return "finance.control_betting_trading";
  }

  if (/\b(build a startup|build.*project|startup|project|product)\b/.test(message)) {
    return "creative.build_project";
  }

  return undefined;
}

function inferGoalTitle(message: string, category: string, templateId?: string): string {
  const customTitle = inferSpecificGoalTitle(message);

  if (customTitle) {
    return customTitle;
  }

  const normalized = message.toLowerCase();

  if (templateId === "career.job_search") {
    return "Find a new job";
  }

  if (templateId === "health.strength_energy") {
    return "Improve strength and energy";
  }

  if (templateId === "health.sleep_better") {
    return "Sleep better";
  }

  if (templateId === "learning.reading_more") {
    return "Read more";
  }

  if (templateId === "finance.control_betting_trading") {
    return "Control betting and trading";
  }

  if (templateId === "creative.build_project") {
    return "Build project momentum";
  }

  if (category === "career") {
    return "Find a new job";
  }

  if (category === "health" && /\b(sleep|sueñ)/.test(normalized)) {
    return "Improve sleep";
  }

  if (category === "health") {
    return "Improve strength and energy";
  }

  if (category === "learning" && /\brust\b/i.test(message)) {
    return "Learn Rust";
  }

  if (category === "learning" && /\b(read|leer)\b/.test(normalized)) {
    return "Read more";
  }

  if (category === "learning") {
    return "Improve learning";
  }

  if (category === "work") {
    return "Build project momentum";
  }

  if (category === "finance") {
    return "Improve finance discipline";
  }

  return inferGenericGoalTitle(message) ?? "Clarify new focus";
}

function inferSpecificGoalTitle(message: string): string | undefined {
  const cleaned = message
    .replace(/^\s*(i want to focus on|create a goal to|my new focus is|i want to|quiero centrarme en|quiero mejorar|quiero buscar|quiero)\s+/i, "")
    .trim()
    .replace(/[.!?]+$/g, "");

  if (!cleaned || cleaned.length < 8) {
    return undefined;
  }

  if (/\b(read more|study|learn|leer m[aá]s|estudiar|aprender)\b/i.test(cleaned)) {
    return titleCaseGoal(
      cleaned
        .replace(/^read more and study consistently\s+(.+)$/i, "read more and study $1 consistently")
        .replace(/^leer m[aá]s y estudiar consistentemente\s+/i, "leer más y estudiar ")
    );
  }

  return undefined;
}

function titleCaseGoal(title: string): string {
  const trimmed = title.trim();
  return trimmed ? trimmed.charAt(0).toUpperCase() + trimmed.slice(1) : title;
}

function inferGenericGoalTitle(message: string): string | undefined {
  const cleaned = message
    .replace(/^\s*(i want to focus on|create a goal to|my new focus is|i want to|quiero centrarme en|quiero mejorar|quiero buscar|quiero)\s+/i, "")
    .trim()
    .replace(/[.!?]+$/g, "");

  return cleaned.length >= 8 && cleaned.length <= 90 ? titleCaseGoal(cleaned) : undefined;
}

function formatCustomGoalCreateProposal(title: string, config: ReturnType<typeof buildCustomGoalConfig>): string {
  const metrics = config.targetMetrics.map((metric) => metric.key).join(", ");
  const questions = config.checkInConfig.map((question) => question.question).slice(0, 3).join(" / ");

  return [
    `I can create this custom goal: ${title}.`,
    `Metrics: ${metrics}.`,
    `Check-ins: ${questions}.`,
    "Reply yes to confirm or no to cancel."
  ].join(" ");
}

function detectOpenAIStructuralProposal(analysis: OpenAIMessageAnalysis | undefined): StructuralProposal | undefined {
  const proposedAction = analysis?.proposedAction;

  if (!proposedAction || proposedAction.type === "none" || proposedAction.confidence < 0.7) {
    return undefined;
  }

  if (proposedAction.type === "profile_update" && isRecord(proposedAction.payload.profilePatch)) {
    return {
      type: "profile_update",
      summary: proposedAction.summary,
      payload: { profilePatch: proposedAction.payload.profilePatch },
      reply: `I can update your profile: ${proposedAction.summary}. Reply yes to confirm or no to cancel.`
    };
  }

  if (
    proposedAction.type === "goal_create" &&
    typeof proposedAction.payload.title === "string" &&
    typeof proposedAction.payload.category === "string"
  ) {
    const customConfig = buildCustomGoalConfig({
      title: proposedAction.payload.title,
      category: proposedAction.payload.category,
      why: typeof proposedAction.payload.why === "string" ? proposedAction.payload.why : undefined
    });

    return {
      type: "goal_create",
      summary: proposedAction.summary,
      payload: {
        title: proposedAction.payload.title,
        category: proposedAction.payload.category,
        why: typeof proposedAction.payload.why === "string" ? proposedAction.payload.why : undefined,
        targetMetrics: customConfig.targetMetrics,
        checkInConfig: customConfig.checkInConfig
      },
      reply: formatCustomGoalCreateProposal(proposedAction.payload.title, customConfig)
    };
  }

  if (proposedAction.type === "goal_archive" && typeof proposedAction.payload.goalId === "string") {
    return {
      type: "goal_archive",
      summary: proposedAction.summary,
      payload: { goalId: proposedAction.payload.goalId },
      reply: `I can archive this goal. Reply yes to confirm or no to cancel.`
    };
  }

  return undefined;
}

async function resolvePendingDecisionReply(
  userId: string,
  pendingAction: PendingAction,
  message: string
): Promise<string | undefined> {
  if (isPendingEmailReviewContext(pendingAction)) {
    return resolveEmailReviewContextReply(userId, pendingAction, message);
  }

  if (isPendingCustomGmailRuleContext(pendingAction)) {
    return undefined;
  }

  if (isRecentActionMutationContext(pendingAction)) {
    if (looksLikeRecentMutationStatusQuestion(message)) {
      return formatRecentActionMutationStatus(pendingAction);
    }

    if (isConfirmationMessage(message) || isRejectionMessage(message)) {
      await rejectPendingAction(userId, pendingAction.id);
      return "No pending change is waiting right now.";
    }

    return undefined;
  }

  if (isRejectionMessage(message)) {
    await rejectPendingAction(userId, pendingAction.id);
    return "Cancelled. I did not change anything.";
  }

  const customEmailRuleReply = await resolvePendingCustomEmailRuleReply(userId, pendingAction, message);

  if (customEmailRuleReply) {
    return customEmailRuleReply;
  }

  if (pendingAction.type === "action_target_clarification") {
    const candidates = readPendingActionCandidates(pendingAction.payload.candidateActions);
    const selected = selectPendingActionCandidate(message, candidates);

    if (!selected) {
      return candidates.length > 0
        ? `Reply with 1-${candidates.length}, the action title, or cancel.`
        : "That pending decision no longer has any options. Please ask again.";
    }

    const operation = typeof pendingAction.payload.intendedOperation === "string"
      ? pendingAction.payload.intendedOperation
      : "";
    const action = await getActionItem(userId, selected.id);

    if (!action) {
      await rejectPendingAction(userId, pendingAction.id);
      return "I could not find that action anymore. Use /actions to check the exact task.";
    }

    if (operation === "complete_action") {
      if (action.status === "completed") {
        await confirmPendingAction(userId, pendingAction.id);
        return `Action already completed: ${action.title}`;
      }

      const completed = await completeActionItem(userId, action.id);

      if (!completed) {
        await rejectPendingAction(userId, pendingAction.id);
        return "I could not find that open action.";
      }

      const progressEvent = await createGoalProgressFromCompletedAction(userId, completed);
      await confirmPendingAction(userId, pendingAction.id);

      return [
        `Action completed: ${completed.title}`,
        progressEvent?.created ? `Goal progress logged: ${progressEvent.goalTitle}` : undefined
      ]
        .filter(Boolean)
        .join("\n");
    }

    if (operation === "archive_action") {
      await replacePendingAction(userId, {
        type: "action_archive",
        summary: `Archive action: ${action.title}`,
        payload: {
          originalText: pendingAction.payload.originalText,
          intendedOperation: "archive_action",
          actionId: action.id,
          candidateActions: [toPendingActionCandidate(action)]
        },
        expiresAt: pendingDecisionExpiry()
      });

      return `Confirm archive action: ${action.title}? Reply yes to confirm or no to cancel.`;
    }

    if (operation === "snooze_action" || operation === "reschedule_action") {
      const settings = await getOrCreateNotificationSettings(userId);
      const dueAtText = typeof pendingAction.payload.parsedDueAt === "string" ? pendingAction.payload.parsedDueAt : "";
      const dueAt = dueAtText ? new Date(dueAtText) : undefined;

      if (!dueAt || Number.isNaN(dueAt.getTime())) {
        await rejectPendingAction(userId, pendingAction.id);
        return "I could not parse the new time. Try: tomorrow afternoon, 6pm, or Monday morning.";
      }

      const updated =
        operation === "snooze_action"
          ? await snoozeActionItem(userId, action.id, dueAt)
          : await rescheduleActionItem(userId, action.id, dueAt);

      if (!updated) {
        await rejectPendingAction(userId, pendingAction.id);
        return "I could not update that action.";
      }

      await confirmPendingAction(userId, pendingAction.id);

      return operation === "snooze_action"
        ? `Action snoozed until ${formatLocalDateTime(updated.snoozedUntil, settings.timezone)}: ${updated.title}`
        : [`Action rescheduled: ${updated.title}`, `due: ${formatLocalDateTime(updated.dueAt, settings.timezone)}`].join("\n");
    }

    return "I could not complete that pending decision. Please ask again.";
  }

  if (pendingAction.type === "action_hygiene" && typeof pendingAction.payload.operation !== "string") {
    const sessionNow =
      typeof pendingAction.payload.now === "string" ? parseOptionalNow(pendingAction.payload.now) ?? undefined : undefined;
    return resolveActionHygieneReply(userId, pendingAction, message, sessionNow);
  }

  if (pendingAction.type === "next_week_plan") {
    return resolveNextWeekPlanReply(userId, pendingAction, message);
  }

  if (isConfirmationMessage(message)) {
    const applied = await applyPendingAction(userId, pendingAction);
    await confirmPendingAction(userId, pendingAction.id);
    await maybeRememberRecentActionMutationStatus(userId, pendingAction, applied.reply);
    return applied.reply;
  }

  return undefined;
}

function looksLikePendingDecisionReply(message: string): boolean {
  const trimmed = message.trim();
  const hygieneReply = parseActionHygieneReply(trimmed);
  const hygieneTarget = hygieneReply?.target ?? "";
  const isNumberedHygieneReply = Boolean(
    hygieneReply &&
      (/^#?\d+$/.test(hygieneTarget) ||
        /^(first|second|third|fourth|fifth)(\s+one)?$/i.test(hygieneTarget) ||
        /^(primero|primera|segundo|segunda|tercero|tercera|cuarto|cuarta|quinto|quinta)$/i.test(hygieneTarget))
  );

  return (
    isConfirmationMessage(trimmed) ||
    isRejectionMessage(trimmed) ||
    isNumberedHygieneReply ||
    Boolean(parseNextWeekPlanReply(trimmed)) ||
    /^#?\d+$/.test(trimmed) ||
    /^(the\s+)?(first|second|third|fourth|fifth)(\s+one)?$/i.test(trimmed) ||
    /^(primero|primera|segundo|segunda|tercero|tercera|cuarto|cuarta|quinto|quinta)$/i.test(trimmed)
  );
}

function looksLikeExpiredPendingDecisionReply(message: string): boolean {
  const trimmed = message.trim();

  if (
    isConfirmationMessage(trimmed) ||
    isRejectionMessage(trimmed) ||
    /^#?\d+$/.test(trimmed) ||
    /^(the\s+)?(first|second|third|fourth|fifth)(\s+one)?$/i.test(trimmed) ||
    /^(primero|primera|segundo|segunda|tercero|tercera|cuarto|cuarta|quinto|quinta)$/i.test(trimmed)
  ) {
    return true;
  }

  return (
    /^(skip|cancel|show\s+plan)$/i.test(trimmed) ||
    /^create\s+(?:all(?:\s+new)?|(?:#?\d+\s*(?:,|\band\b)?\s*)+)$/i.test(trimmed) ||
    /^edit\s+#?\d+\s+to\s+.+$/i.test(trimmed) ||
    /^remove\s+#?\d+$/i.test(trimmed) ||
    looksLikeEmailReviewContextAction(trimmed)
  );
}

function isRecentActionMutationContext(pendingAction: PendingAction): boolean {
  return (
    pendingAction.type === "action_hygiene" &&
    isRecord(pendingAction.payload) &&
    pendingAction.payload.operation === "recent_mutation_status"
  );
}

function looksLikeRecentMutationStatusQuestion(message: string): boolean {
  const text = normalizeForComparison(message);
  return (
    /\b(did|do|done|changed|change|archive|archived|snooze|snoozed|complete|completed|happened|previous|last)\b/.test(text) &&
    /\b(you|u|it|all|them|those|that|command|stuff|do|did|changed)\b/.test(text)
  ) || /\b(que has cambiado|que hiciste|què has canviat|ho has fet|did you do it)\b/.test(text);
}

function formatRecentActionMutationStatus(pendingAction: PendingAction): string {
  const recentReply = typeof pendingAction.payload.reply === "string" ? pendingAction.payload.reply : "";
  const summary = typeof pendingAction.payload.summary === "string" ? pendingAction.payload.summary : "";

  if (recentReply) {
    return ["Last action changes:", recentReply].join("\n");
  }

  return summary ? `Last action changes: ${summary}` : "I do not have a recent action change recorded.";
}

async function maybeRememberRecentActionMutationStatus(
  userId: string,
  pendingAction: PendingAction,
  reply: string
): Promise<void> {
  if (pendingAction.type !== "action_hygiene" && pendingAction.type !== "action_archive" && pendingAction.type !== "action_target_clarification") {
    return;
  }

  await maybeRememberRecentActionMutationStatusFromReply(userId, reply);
}

function surfaceReplyIncludesMutation(reply: string): boolean {
  return (
    reply.startsWith("Daily loop updated.") ||
    reply.startsWith("Email rule enabled:") ||
    reply.startsWith("I can set up a review-first Gmail rule.") ||
    reply.startsWith("Gmail rule active:") ||
    reply.startsWith("Gmail rule paused:") ||
    reply.startsWith("I can make Gmail") ||
    reply.startsWith("I can set Gmail") ||
    reply.startsWith("I can turn Gmail review notifications") ||
    reply.startsWith("Confirm remove Gmail rule:") ||
    (reply.startsWith("Confirm remove ") && reply.includes("Gmail email rule")) ||
    reply.startsWith("Action hygiene:") ||
    reply.startsWith("Plan ") ||
    reply.startsWith("Weekly plan")
  );
}


function replyOnly(
  userId: string,
  message: string,
  response: string,
  routeDebug?: ProcessRouteDebug
): ProcessMessageResult {
  return {
    userId,
    message,
    intent: "general_chat",
    mode: "mirror",
    riskState: "GREEN",
    extractedEvents: [],
    reply: response,
    routeDebug
  };
}

function tomorrow(): Date {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return date;
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
