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
  sortDailyActionsByPriority,
  buildDeterministicDailyCoachResponse,
  DailyCoachValidationError,
  selectedDailyCoachActionTitle,
  extractEvents,
  classifyDueWindow,
  findGoalDuplicateWarnings,
  getLocalTodayRange,
  isRiskControlGoal,
  isWithinLocalDay,
  getGoalTemplate,
  detectConversationControlIntent,
  isConversationalMutationIntent,
  analyzeMultiIntentMessage,
  evaluateGoalGuardrails,
  inferGoalLinkForAction,
  looksLikeMultiIntentText,
  goalTemplates,
  CreateEmailSignalRuleInputSchema,
  UpdateEmailSignalRuleInputSchema,
  GithubPublicConnectionInputSchema,
  emailAdapterRegistry,
  getEmailAdapterDefinition,
  integrationRegistry,
  PendingMemoryCreatePayloadSchema,
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
  writeGmailAutonomyPreferences,
  writeGmailBackgroundSyncAttempt,
  UpdateIntegrationConnectionInputSchema,
  UpdateUserOperatingProfileInputSchema,
  type GithubPublicConnectionInput,
  type MessageIntent,
  type AgentResponse,
  type AgentResponseComposerInput,
  type DailyPriorityScore,
  type DailyBriefContext,
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
  generateDailyCoachResponse,
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
  createMemoryFromPendingPayload,
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
  cleanEmailRuleTarget,
  findEmailRulesByTarget as findSelectableEmailRulesByTarget,
  readEmailRuleSelectionCandidates,
  resolveMultipleEmailRuleTargets,
  selectEmailRuleCandidate,
  sortEmailRuleCandidates,
  splitEmailRuleTargets,
  toEmailRuleSelectionCandidate
} from "./conversation/email-rule-selection.js";
import {
  buildGmailAutonomyState,
  formatIntervalMinutes,
  gmailRuleBehaviorLabel,
  gmailSyncModeSentence,
  gmailSyncModeShortLabel
} from "./conversation/gmail-autonomy.js";
import { registerMessageRoutes } from "./routes/messages.js";
import { registerAgentRoutes, defaultAgentRouteHandlers } from "./routes/agent.js";
import { registerMemoryRoutes } from "./routes/memory.js";
import { registerNotificationSettingsRoutes } from "./routes/notification-settings.js";
import { registerCheckinsIngestRoutes } from "./routes/checkins-ingest.js";
import { registerInsightRoutes } from "./routes/insights.js";
import { isRecord } from "./utils/records.js";
import { shouldUseOpenAIAnalysis } from "./utils/env.js";
import { normalizeForComparison } from "./utils/text.js";
import {
  formatGmailEmailRuleSelectionLines,
  getVisibleGmailEmailRules,
  groupEmailRulesForHumanDisplay,
  isBuiltInEmailAdapter,
  type EmailRuleHumanDisplayGroup
} from "./gmail/gmail-rule-service.js";
import type {
  ActionHygieneAction,
  ActionHygieneOption,
  ActionHygieneReport,
  ActionReminderDispatch,
  ConversationControlResponse,
  DailyCoachGenerationResult,
  DailyCoachSource,
  DailyOperatorBrief,
  DailyOperatorBriefAction,
  DailyOperatorBriefGoalStatus,
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
  OperatorActionAttentionSummary,
  OperatorAttentionItem,
  OperatorAttentionPriority,
  OperatorAttentionState,
  OperatorEmailAttentionSummary,
  OperatorGoalAttentionSummary,
  OperatorPlanningAttentionSummary,
  OperatorReflectionCandidate,
  OperatorReflectionContext,
  OperatorReflectionType,
  OperatorRiskAttentionSummary,
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

  server.get<{ Params: { userId: string } }>("/users/:userId/pending-actions", async (request) => ({
    pendingActions: await getPendingActions(request.params.userId)
  }));

  server.post<{ Params: { userId: string; pendingActionId: string } }>(
    "/users/:userId/pending-actions/:pendingActionId/confirm",
    async (request, reply) => {
      const pendingAction = await findPendingAction(request.params.userId, request.params.pendingActionId);

      if (!pendingAction) {
        return reply.status(404).send({
          error: "Pending action not found"
        });
      }

      if (pendingAction.type === "action_target_clarification") {
        return reply.status(400).send({
          error: "Reply with the number of the action you mean, or cancel."
        });
      }

      const applied = await applyPendingAction(request.params.userId, pendingAction);
      const confirmedAction = await confirmPendingAction(request.params.userId, pendingAction.id);

      return {
        pendingAction: confirmedAction,
        reply: applied.reply
      };
    }
  );

  server.post<{ Params: { userId: string; pendingActionId: string } }>(
    "/users/:userId/pending-actions/:pendingActionId/reject",
    async (request, reply) => {
      const pendingAction = await rejectPendingAction(request.params.userId, request.params.pendingActionId);

      if (!pendingAction) {
        return reply.status(404).send({
          error: "Pending action not found"
        });
      }

      return {
        pendingAction,
        reply: "Cancelled. I did not change anything."
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

async function buildOperatorAttentionState(
  userId: string,
  now = new Date(),
  timezoneOverride?: string,
  prefetched: {
    actions?: ActionItem[];
    activeGoals?: Goal[];
    todayEvents?: StoredEvent[];
    recentEvents?: StoredEvent[];
    hygiene?: ActionHygieneReport;
  } = {}
): Promise<OperatorAttentionState> {
  const timezone = timezoneOverride ?? await getUserTimezone(userId);
  const todayRange = getLocalTodayRange(now, timezone);
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const [
    actions,
    activeGoals,
    todayEvents,
    recentEvents,
    pendingReviews,
    recentReviews,
    emailRules,
    gmailState,
    latestWeeklyReview
  ] = await Promise.all([
    prefetched.actions ? Promise.resolve(prefetched.actions) : getActionItems(userId, { status: "all", limit: 100 }),
    prefetched.activeGoals ? Promise.resolve(prefetched.activeGoals) : getActiveGoals(userId),
    prefetched.todayEvents ? Promise.resolve(prefetched.todayEvents) : getEventsBetween(userId, todayRange.start, todayRange.end),
    prefetched.recentEvents ? Promise.resolve(prefetched.recentEvents) : getEventsSince(userId, last24h),
    getEmailReviewItems(userId, { status: "pending", limit: 50 }),
    getEmailReviewItems(userId, { status: "all", limit: 50 }),
    getEmailSignalRules(userId),
    buildGmailAutonomyState(userId),
    getLatestWeeklyReview(userId)
  ]);
  const visibleActions = actions.filter((action) => action.status !== "archived");
  const openActions = visibleActions.filter((action) => action.status === "open" || isSnoozedDue(action, now));
  const overdueActions = openActions.filter((action) => action.dueAt && action.dueAt < now);
  const dueSoonActions = openActions.filter((action) => isActionDueSoon(action, now));
  const completedToday = visibleActions.filter((action) => action.status === "completed" && isWithinLocalDay(action.completedAt, todayRange));
  const goalStatusesToday = activeGoals.map((goal) => buildGoalStatusToday(goal, todayEvents, openActions, completedToday));
  const rankedOpenActions = sortDailyActionsByPriority(openActions, {
    goals: activeGoals,
    goalStatuses: goalStatusesToday,
    recentEvents,
    guardrailContext: {
      hardGuardrailTriggeredToday: todayEvents.some((event) => event.type === "finance.betting.cooldown_triggered")
    },
    now,
    timezone
  });
  const hygiene = prefetched.hygiene ?? await analyzeActionHygiene(userId, now, timezone);
  const ruleById = new Map(emailRules.map((rule) => [rule.id, rule]));
  const emailAttention = buildOperatorEmailAttentionSummary({
    pendingReviews,
    todayReviews: recentReviews.filter((review) => isWithinLocalDay(review.reviewedAt, todayRange)),
    todayEvents,
    actions: visibleActions,
    activeGoals,
    ruleById,
    todayRange,
    gmailSyncMode: gmailSyncModeShortLabel(gmailState),
    reviewNotificationEnabled: gmailState.reviewNotificationEnabled
  });
  const risks = uniqueStrings([...buildOperatorRisks(recentEvents), ...buildOperatorGuardrailWatchouts(activeGoals)]);
  const goalStatus = activeGoals.map((goal) => buildOperatorGoalStatus(goal, todayEvents, openActions, completedToday));
  const actionAttention = buildOperatorActionAttentionSummary({
    openActions,
    overdueActions,
    dueSoonActions,
    rankedOpenActions,
    hygiene
  });
  const goalAttention = buildOperatorGoalAttentionSummary(goalStatus, activeGoals);
  const riskAttention = buildOperatorRiskAttentionSummary(risks, todayEvents);
  const planningAttention = {
    weeklyReviewDue: await shouldPromptWeeklyReview(userId, now, timezone),
    latestWeeklyReviewDate: latestWeeklyReview?.reviewedEndLocalDate,
    summary: latestWeeklyReview
      ? `Latest weekly review covers ${latestWeeklyReview.weekStartLocalDate} to ${latestWeeklyReview.reviewedEndLocalDate}.`
      : "No saved weekly review yet."
  };
  const topAttentionItems = buildTopOperatorAttentionItems({
    rankedOpenActions,
    overdueActions,
    emailAttention,
    risks,
    hygiene,
    planningAttention
  });
  const recommendedNextMove = pickAttentionNextMove(topAttentionItems, {
    rankedOpenActions,
    overdueActions,
    emailAttention,
    goalStatus,
    now
  });

  return {
    userId,
    date: todayRange.date,
    timezone,
    topAttentionItems,
    recommendedNextMove,
    emailAttentionSummary: emailAttention,
    actionAttentionSummary: actionAttention,
    goalAttentionSummary: goalAttention,
    riskAttentionSummary: riskAttention,
    planningAttentionSummary: planningAttention,
    suggestedUserReplies: buildOperatorSuggestedReplies(emailAttention),
    confidence: topAttentionItems.length > 0 ? 0.88 : 0.72,
    reasoning: [
      `${openActions.length} open action${openActions.length === 1 ? "" : "s"}`,
      `${overdueActions.length} overdue action${overdueActions.length === 1 ? "" : "s"}`,
      `${emailAttention.pendingCount} pending Gmail review${emailAttention.pendingCount === 1 ? "" : "s"}`,
      `${risks.length} risk watchout${risks.length === 1 ? "" : "s"}`
    ]
  };
}

async function generateDailyOperatorBrief(userId: string, options: { now?: Date } = {}): Promise<DailyOperatorBrief> {
  const now = options.now ?? new Date();
  const timezone = await getUserTimezone(userId);
  const todayRange = getLocalTodayRange(now, timezone);
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const [actions, activeGoals, todayEvents, recentEvents, recentReviews, userOperatingProfile] = await Promise.all([
    getActionItems(userId, { status: "all", limit: 100 }),
    getActiveGoals(userId),
    getEventsBetween(userId, todayRange.start, todayRange.end),
    getEventsSince(userId, last24h),
    getEmailReviewItems(userId, { status: "all", limit: 10 }),
    getOrCreateUserOperatingProfile(userId)
  ]);
  const visibleActions = actions.filter((action) => action.status !== "archived");
  const openActions = visibleActions.filter((action) => action.status === "open" || isSnoozedDue(action, now));
  const overdueActions = openActions.filter((action) => action.dueAt && action.dueAt < now);
  const dueSoonActions = openActions.filter((action) => isActionDueSoon(action, now));
  const completedToday = visibleActions.filter(
    (action) => action.status === "completed" && isWithinLocalDay(action.completedAt, todayRange)
  );
  const goalStatusesToday = activeGoals.map((goal) => buildGoalStatusToday(goal, todayEvents, openActions, completedToday));
  const guardrailContext = {
    hardGuardrailTriggeredToday: todayEvents.some((event) => event.type === "finance.betting.cooldown_triggered")
  };
  const rankedOpenActions = sortDailyActionsByPriority(openActions, {
    goals: activeGoals,
    goalStatuses: goalStatusesToday,
    recentEvents,
    guardrailContext,
    now,
    timezone
  });
  const rankedActions = rankedOpenActions.map((item) => item.action);
  const priorityDebug = rankedOpenActions.map((item, index) => ({
    rank: index + 1,
    actionId: item.action.id,
    title: item.action.title,
    score: item.score.score,
    rankReason: uniqueStrings(item.score.factors).join(", "),
    factors: uniqueStrings(item.score.factors)
  }));
  const goalStatus = activeGoals.map((goal) => buildOperatorGoalStatus(goal, todayEvents, rankedActions, completedToday));
  const recentWins = buildOperatorRecentWins(todayEvents, completedToday, recentReviews, todayRange);
  const risks = uniqueStrings([...buildOperatorRisks(recentEvents), ...buildOperatorGuardrailWatchouts(activeGoals)]);
  const hygiene = await analyzeActionHygiene(userId, now, timezone);
  const attention = await buildOperatorAttentionState(userId, now, timezone, {
    actions,
    activeGoals,
    todayEvents,
    recentEvents,
    hygiene
  });
  const topPriorities = buildOperatorTopPriorities({
    overdueActions,
    dueSoonActions,
    openActions: rankedActions,
    goalStatus,
    risks,
    emailAttention: attention.emailAttentionSummary,
    priorityScores: rankedOpenActions.map((item) => item.score)
  });
  const suggestedNextStep = attention.topAttentionItems[0]?.kind === "risk" && rankedActions.length > 0
    ? pickOperatorNextStep({
        overdueActions,
        dueSoonActions,
        openActions: rankedActions,
        goalStatus,
        emailAttention: attention.emailAttentionSummary,
        now
      })
    : attention.recommendedNextMove;
  const briefContext = buildDailyBriefContext({
    date: todayRange.date,
    timezone,
    activeGoals,
    goalStatus,
    rankedOpenActions,
    recentWins,
    risks,
    suggestedNextStep,
    userOperatingProfile,
    todayEvents,
    completedToday
  });
  const coachResult = await maybeGenerateDailyCoach(briefContext);
  const briefOpenActions = rankedActions.slice(0, 10).map(toBriefAction);
  const activeReflections = await getActiveOperatorReflections(userId);
  const operatorReflection = selectRelevantOperatorReflection(activeReflections, {
    openActions: briefOpenActions,
    topPriorities
  });
  const weeklyReviewDue = await shouldPromptWeeklyReview(userId, now, timezone);

  return {
    date: todayRange.date,
    summary: buildOperatorSummary({ openActions, overdueActions, activeGoals, todayEvents, risks, emailAttention: attention.emailAttentionSummary }),
    coach: coachResult.coach,
    coachDebug: coachResult.debug,
    topPriorities,
    openActions: briefOpenActions,
    overdueActions: overdueActions.slice(0, 10).map(toBriefAction),
    goalStatus,
    recentWins,
    risks,
    emailAttention: attention.emailAttentionSummary.pendingCount > 0 || attention.emailAttentionSummary.handledTodayCount > 0
      ? attention.emailAttentionSummary
      : undefined,
    actionHygiene: hygiene.suggestedCleanupCandidates.length > 0 ? {
      summary: hygiene.summary,
      needsDecision: hygiene.suggestedCleanupCandidates.length
    } : undefined,
    operatorReflection: operatorReflection ? formatOperatorReflectionForBrief(operatorReflection) : undefined,
    weeklyReviewDue,
    suggestedNextStep,
    priorityDebug
  };
}

async function buildStartDayMessage(userId: string, now: Date): Promise<string> {
  const brief = await generateDailyOperatorBrief(userId, { now });
  const timezone = await getUserTimezone(userId);
  const topAction = firstRealPriority(brief);
  const overdue = brief.overdueActions.slice(0, 3).map((action) => action.title);
  const overdueIds = new Set(brief.overdueActions.map((action) => action.id));
  const alsoToday = brief.openActions
    .filter((action) => action.title !== topAction)
    .filter((action) => !overdueIds.has(action.id))
    .filter((action) => classifyDueWindow(action.dueAt ? new Date(action.dueAt) : undefined, now, timezone).startsWith("due today"))
    .slice(0, 3)
    .map((action) => action.title);
  const guardrail = brief.risks.find((risk) => /risk-control|guardrail|betting|trading|impulsive/i.test(risk));
  const hygiene = brief.actionHygiene;
  const emailAttention = brief.emailAttention && brief.emailAttention.pendingCount > 0
    ? `Email: ${brief.emailAttention.summary} Say "email reviews" to handle them.`
    : undefined;

  return [
    `Today - ${brief.date}`,
    `First move: ${topAction ?? "Log one meaningful action."}`,
    overdue.length > 0 ? `Overdue: ${overdue.join(", ")}.` : undefined,
    alsoToday.length > 0 ? `Also today: ${alsoToday.join(", ")}.` : undefined,
    emailAttention,
    hygiene ? `Hygiene: ${cleanupDecisionGrammar(hygiene.needsDecision)} Run /action_hygiene.` : undefined,
    brief.weeklyReviewDue ? "Weekly review due. Run /weekly." : undefined,
    brief.operatorReflection ? `Pattern: ${brief.operatorReflection}` : undefined,
    guardrail ? `Guardrail: ${formatLoopGuardrail(guardrail)}` : undefined,
    "Reply naturally with updates."
  ]
    .filter(Boolean)
    .join("\n");
}

async function buildEndDayMessage(userId: string, now: Date): Promise<string> {
  const brief = await generateDailyOperatorBrief(userId, { now });
  const completed = brief.recentWins.filter((win) => !/email review/i.test(win)).slice(0, 5);
  const hygiene = brief.actionHygiene;
  const emailAttention = brief.emailAttention;
  const stillOpen = [...brief.overdueActions, ...brief.openActions]
    .filter((action, index, actions) => actions.findIndex((item) => item.id === action.id) === index)
    .slice(0, 5)
    .map((action) => `${action.title}${action.dueAt && new Date(action.dueAt) < now ? " overdue" : action.dueAt ? ` due ${formatLocalDateTime(new Date(action.dueAt))}` : ""}`);

  return [
    "Evening review:",
    "Completed today:",
    completed.length > 0 ? completed.map((item) => `- ${item}`).join("\n") : "- Nothing completed is logged yet.",
    "",
    "Still open:",
    stillOpen.length > 0 ? stillOpen.map((item) => `- ${item}`).join("\n") : "- No open action items.",
    emailAttention && (emailAttention.pendingCount > 0 || emailAttention.handledTodayCount > 0)
      ? [
          "\nEmail signals:",
          emailAttention.handledTodayCount > 0 ? `- ${emailAttention.handledTodayCount} Gmail review${emailAttention.handledTodayCount === 1 ? "" : "s"} handled today.` : undefined,
          emailAttention.gmailDerivedActionItemsToday > 0 ? `- ${emailAttention.gmailDerivedActionItemsToday} Gmail-derived action item${emailAttention.gmailDerivedActionItemsToday === 1 ? "" : "s"} created today.` : undefined,
          emailAttention.gmailDerivedEventsToday > 0 ? `- ${emailAttention.gmailDerivedEventsToday} Gmail-derived event${emailAttention.gmailDerivedEventsToday === 1 ? "" : "s"} logged today.` : undefined,
          emailAttention.pendingCount > 0 ? `- ${emailAttention.pendingCount} Gmail review${emailAttention.pendingCount === 1 ? "" : "s"} still waiting.` : undefined
        ].filter(Boolean).join("\n")
      : undefined,
    hygiene ? "\nCleanup:\nReview overdue actions before tomorrow: /action_hygiene" : undefined,
    "",
    "Reply with what happened, what moved, or what to drop.",
    'Example: trained 30 min, move homepage to tomorrow morning.'
  ].join("\n");
}

async function buildTomorrowPrepMessage(userId: string, now: Date): Promise<string> {
  const timezone = await getUserTimezone(userId);
  const tomorrow = addDaysToLocalDateString(getLocalTodayRange(now, timezone).date, 1);
  const [actions, activeGoals, brief] = await Promise.all([
    getActionItems(userId, { status: "all", limit: 100 }),
    getActiveGoals(userId),
    generateDailyOperatorBrief(userId, { now })
  ]);
  const tomorrowActions = actions
    .filter((action) => (action.status === "open" || action.status === "snoozed") && action.dueAt && formatDateInTimezone(action.dueAt, timezone) === tomorrow)
    .slice(0, 10);
  const gaps = brief.goalStatus
    .filter((goal) => !isRiskControlGoalStatus(goal) && /no progress logged/i.test(goal.note))
    .slice(0, 3)
    .map((goal) => goal.title);
  const firstMove = tomorrowActions[0]?.title ?? gaps[0] ?? activeGoals.find((goal) => !isRiskControlGoal(goal))?.title;

  return [
    `Tomorrow - ${tomorrow}`,
    "Actions due tomorrow:",
    tomorrowActions.length > 0 ? tomorrowActions.map((action) => `- ${action.title}`).join("\n") : "- No actions due tomorrow.",
    "",
    "Goal gaps:",
    gaps.length > 0 ? gaps.map((gap) => `- ${gap}`).join("\n") : "- No obvious goal gaps from today's logs.",
    "",
    `Suggested first move tomorrow: ${firstMove ? firstMove : "Log one meaningful action."}`
  ].join("\n");
}

async function dailyLoopStateInput(userId: string, now: Date): Promise<{ localDate: string; timezone: string; sentAt: Date }> {
  const timezone = await getUserTimezone(userId);
  const today = getLocalTodayRange(now, timezone);

  return {
    localDate: today.date,
    timezone,
    sentAt: now
  };
}

function firstRealPriority(brief: DailyOperatorBrief): string | undefined {
  const openTitles = new Set(brief.openActions.map((action) => action.title));
  const priority = brief.topPriorities.find((item) => {
    const normalized = item.replace(/^Due soon:\s*/i, "").replace(/^Overdue:\s*/i, "").trim();
    return openTitles.has(normalized);
  });

  return priority?.replace(/^Due soon:\s*/i, "").replace(/^Overdue:\s*/i, "").trim() ?? brief.openActions[0]?.title;
}

function formatLoopGuardrail(risk: string): string {
  const match = risk.match(/Risk-control goal active:\s*(.+?)\./i);
  return match ? `Keep ${match[1]} locked today.` : risk;
}

function addDaysToLocalDateString(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days, 12, 0, 0, 0)).toISOString().slice(0, 10);
}

function formatDateInTimezone(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  return `${getDateTimePart(parts, "year")}-${getDateTimePart(parts, "month")}-${getDateTimePart(parts, "day")}`;
}

async function analyzeActionHygiene(userId: string, now: Date, timezone: string): Promise<ActionHygieneReport> {
  const [actions, goals] = await Promise.all([
    getActionItems(userId, { status: "all", limit: 200 }),
    getActiveGoals(userId)
  ]);
  const today = getLocalTodayRange(now, timezone);
  const goalsById = new Map(goals.map((goal) => [goal.id, goal]));
  const openActions = actions.filter((action) => action.status === "open" || isSnoozedDue(action, now));
  const analyzed = openActions
    .map((action) => analyzeActionHygieneItem(action, goalsById.get(action.goalId ?? ""), today, now, timezone))
    .filter(Boolean) as ActionHygieneAction[];
  const overdueActions = analyzed.filter((action) => action.daysOverdue !== undefined && action.daysOverdue >= 1);
  const staleActions = analyzed.filter((action) => action.daysOverdue !== undefined && action.daysOverdue >= 3);
  const lowPriorityStaleActions = analyzed.filter(
    (action) => action.priority === "low" && action.lastTouchedAt && daysBetween(new Date(action.lastTouchedAt), now) >= 7
  );
  const repeatedlySnoozedActions: ActionHygieneAction[] = [];
  const suggestedCleanupCandidates = uniqueHygieneActions([
    ...staleActions,
    ...overdueActions.filter((action) => !action.linkedGoalTitle || (action.daysOverdue ?? 0) >= 2),
    ...lowPriorityStaleActions
  ]).slice(0, 10);

  return {
    staleActions,
    overdueActions,
    repeatedlySnoozedActions,
    lowPriorityStaleActions,
    suggestedCleanupCandidates,
    summary:
      suggestedCleanupCandidates.length > 0
        ? cleanupDecisionGrammar(suggestedCleanupCandidates.length)
        : overdueActions.length > 0
          ? cleanupDecisionGrammar(overdueActions.length)
        : "Action list is clean enough."
  };
}

async function createActionHygieneSession(
  userId: string,
  originalText: string,
  now: Date,
  createdBy: string
): Promise<{ report: ActionHygieneReport; timezone: string }> {
  const timezone = await getUserTimezone(userId);
  const report = await analyzeActionHygiene(userId, now, timezone);

  await storeActionHygieneSession(userId, originalText, now, timezone, report, createdBy);

  return { report, timezone };
}

async function storeActionHygieneSession(
  userId: string,
  originalText: string,
  now: Date,
  timezone: string,
  report: ActionHygieneReport,
  createdBy: string
): Promise<void> {
  const visibleActions = actionHygieneVisibleActions(report);

  await replacePendingAction(userId, {
    type: "action_hygiene",
    summary: report.summary,
    payload: {
      originalText,
      now: now.toISOString(),
      timezone,
      visibleContextType: "action_hygiene_list",
      createdBy,
      candidates: visibleActions.map((candidate) => candidate.actionId),
      candidateActions: visibleActions.map((candidate) => ({
        ...toPendingActionCandidate({
          id: candidate.actionId,
          title: candidate.title,
          status: "open",
          dueAt: candidate.dueAt ? new Date(candidate.dueAt) : undefined,
          goalTitleSnapshot: candidate.linkedGoalTitle
        }),
        recommendedOptions: candidate.recommendedOptions
      }))
    },
    expiresAt: pendingDecisionExpiry()
  });
}

function analyzeActionHygieneItem(
  action: ActionItem,
  goal: Goal | undefined,
  today: ReturnType<typeof getLocalTodayRange>,
  now: Date,
  timezone: string
): ActionHygieneAction | undefined {
  if (goal && isRiskControlGoal(goal)) {
    return undefined;
  }

  const dueAt = action.dueAt;
  const daysOverdue = dueAt && dueAt < now ? daysBetweenLocalDates(formatDateInTimezone(dueAt, timezone), today.date) : undefined;
  const untouchedDays = daysBetween(action.updatedAt, now);
  const reasons: string[] = [];

  if (daysOverdue !== undefined && daysOverdue >= 1) {
    reasons.push(daysOverdue >= 3 ? `overdue ${daysOverdue} days` : `overdue ${daysOverdue} day${daysOverdue === 1 ? "" : "s"}`);
  }

  if (action.priority === "low" && untouchedDays >= 7) {
    reasons.push(`low priority and untouched ${untouchedDays} days`);
  }

  if (reasons.length === 0) {
    return undefined;
  }

  const goalPriority = goalPriorityRank(goal);
  const recommendedOptions = goalPriority >= 45
    ? ["complete", "snooze", "keep"] as ActionHygieneOption[]
    : action.goalId
      ? ["complete", "snooze", "archive", "keep"] as ActionHygieneOption[]
      : ["complete", "snooze", "archive", "keep"] as ActionHygieneOption[];

  return {
    actionId: action.id,
    title: action.title,
    dueAt: action.dueAt?.toISOString(),
    linkedGoalTitle: action.goalTitleSnapshot,
    priority: action.priority,
    daysOverdue,
    snoozeCount: undefined,
    lastTouchedAt: action.updatedAt.toISOString(),
    reason: reasons.join("; "),
    recommendedOptions
  };
}

function formatActionHygieneReport(report: ActionHygieneReport): string {
  const visibleActions = actionHygieneVisibleActions(report);

  if (visibleActions.length === 0) {
    return `Action hygiene:\n${report.summary}`;
  }

  return [
    "Action hygiene:",
    report.summary,
    visibleActions.some((action) => action.daysOverdue !== undefined && action.daysOverdue >= 1)
      ? ["Overdue:", ...visibleActions.map((action, index) => `${index + 1}. ${formatHygieneActionLine(action)}`)].join("\n")
      : undefined,
    "",
    "Suggested cleanup:",
    ...visibleActions.map((action, index) => `${index + 1}. ${action.title}: ${action.recommendedOptions.join(", ")}?`),
    "",
    "Reply with:",
    ...formatActionHygieneReplyExamples(visibleActions)
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

function actionHygieneVisibleActions(report: ActionHygieneReport): ActionHygieneAction[] {
  return uniqueHygieneActions([
    ...report.overdueActions,
    ...report.suggestedCleanupCandidates
  ]).slice(0, 10);
}

function formatActionHygieneReplyExamples(actions: ActionHygieneAction[]): string[] {
  const examples: string[] = [];
  const firstSnooze = actions.find((action) => action.recommendedOptions.includes("snooze"));
  const firstComplete = actions.find((action) => action.recommendedOptions.includes("complete"));
  const firstArchive = actions.find((action) => action.recommendedOptions.includes("archive"));
  const firstKeep = actions.find((action) => action.recommendedOptions.includes("keep"));

  if (firstSnooze) {
    examples.push(`- "snooze ${actions.indexOf(firstSnooze) + 1} tomorrow"`);
  }

  if (firstComplete) {
    examples.push(`- "complete ${actions.indexOf(firstComplete) + 1}"`);
  }

  if (firstArchive) {
    examples.push(`- "archive ${actions.indexOf(firstArchive) + 1}"`);
  }

  if (firstKeep) {
    examples.push(`- "keep ${actions.indexOf(firstKeep) + 1}"`);
  }

  return examples;
}

function formatActionHygieneDebug(report: ActionHygieneReport): string {
  return [
    "Action hygiene debug:",
    `summary: ${report.summary}`,
    `overdue: ${report.overdueActions.length}`,
    ...report.overdueActions.map((action) => `- ${action.title}: ${action.reason}; options=${action.recommendedOptions.join("/")}`),
    `stale: ${report.staleActions.length}`,
    ...report.staleActions.map((action) => `- ${action.title}: ${action.reason}`),
    `repeatedly snoozed: ${report.repeatedlySnoozedActions.length}`,
    `low priority stale: ${report.lowPriorityStaleActions.length}`,
    ...report.lowPriorityStaleActions.map((action) => `- ${action.title}: ${action.reason}`),
    `suggested cleanup: ${report.suggestedCleanupCandidates.length}`,
    ...report.suggestedCleanupCandidates.map((action) => `- ${action.title}: ${action.reason}`)
  ].join("\n");
}

function formatHygieneActionLine(action: ActionHygieneAction): string {
  return [
    `${action.title} - overdue ${action.daysOverdue ?? 0} day${action.daysOverdue === 1 ? "" : "s"}`,
    action.linkedGoalTitle ? `goal: ${action.linkedGoalTitle}` : undefined
  ]
    .filter(Boolean)
    .join(" - ");
}

function cleanupDecisionGrammar(count: number): string {
  return count === 1 ? "1 action needs a cleanup decision." : `${count} actions need cleanup decisions.`;
}

function uniqueHygieneActions(actions: ActionHygieneAction[]): ActionHygieneAction[] {
  const seen = new Set<string>();
  return actions.filter((action) => {
    if (seen.has(action.actionId)) {
      return false;
    }
    seen.add(action.actionId);
    return true;
  });
}

function goalPriorityRank(goal: Goal | undefined): number {
  if (!goal) {
    return 0;
  }

  if (typeof goal.importanceScore === "number") {
    return goal.importanceScore;
  }

  return goal.priority === "critical" ? 70 : goal.priority === "high" ? 45 : goal.priority === "medium" ? 25 : 10;
}

function daysBetweenLocalDates(fromDate: string, toDate: string): number {
  const [fromYear, fromMonth, fromDay] = fromDate.split("-").map(Number);
  const [toYear, toMonth, toDay] = toDate.split("-").map(Number);
  const from = Date.UTC(fromYear, fromMonth - 1, fromDay);
  const to = Date.UTC(toYear, toMonth - 1, toDay);
  return Math.max(0, Math.floor((to - from) / (24 * 60 * 60 * 1000)));
}

function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / (24 * 60 * 60 * 1000)));
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

async function getActiveOperatorReflections(userId: string): Promise<MemoryEntry[]> {
  return (await getActiveMemories(userId))
    .filter(isOperatorReflectionMemory)
    .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
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

function isOperatorReflectionMemory(memory: MemoryEntry): boolean {
  return memory.status === "active" && memory.data?.kind === "operator_reflection";
}

function selectRelevantOperatorReflection(reflections: MemoryEntry[], brief: { openActions: DailyOperatorBriefAction[]; topPriorities: string[] }): MemoryEntry | undefined {
  const topText = normalizeForComparison([brief.openActions[0]?.title, brief.topPriorities[0]].filter(Boolean).join(" "));

  return reflections.find((reflection) => {
    const title = typeof reflection.data?.title === "string" ? reflection.data.title : reflection.summary;
    return sharesMeaningfulToken(topText, normalizeForComparison(`${title} ${reflection.summary}`));
  }) ?? reflections[0];
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

function formatOperatorReflectionForBrief(reflection: MemoryEntry): string {
  const title = typeof reflection.data?.title === "string" ? reflection.data.title : reflection.summary;
  return `${title}.`;
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

function containsUnsafeReflectionLanguage(text: string): boolean {
  return /\b(lazy|addict|addicted|undisciplined|diagnosis|disorder|pathological|hopeless|failure)\b/i.test(text);
}

function isOperatorReflectionType(value: string): value is OperatorReflectionType {
  return ["pattern", "preference", "friction", "guardrail_pattern", "goal_strategy", "stale_goal"].includes(value);
}

function isGuardrailEvent(event: StoredEvent): boolean {
  return /finance\.betting|finance\.trading|cooldown|large_bet|large_loss/i.test(event.type);
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringFromRecord(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function finiteNumberFromRecord(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function sharesMeaningfulToken(left: string, right: string): boolean {
  const rightTokens = new Set(right.split(" ").filter((token) => token.length >= 4));
  return left.split(" ").some((token) => token.length >= 4 && rightTokens.has(token));
}

async function buildWeeklyReviewContext(
  userId: string,
  weekStartLocalDate: string | undefined,
  timezone: string,
  now: Date
): Promise<WeeklyReviewContext> {
  const currentLocalDate = formatDateInTimezone(now, timezone);
  const weekStart = weekStartLocalDate ?? startOfLocalWeek(currentLocalDate);
  const weekEnd = addDaysToLocalDateString(weekStart, 6);
  const reviewedEnd = currentLocalDate < weekEnd ? currentLocalDate : weekEnd;
  const rangeStart = localDateStartUtc(weekStart, timezone);
  const nextEnd = addDaysToLocalDateString(reviewedEnd, 1);
  const plannedRangeEnd = localDateStartUtc(nextEnd, timezone);
  const rangeEnd = now < plannedRangeEnd ? now : plannedRangeEnd;
  const [activeGoals, actions, events, memories, emailReviews] = await Promise.all([
    getActiveGoals(userId),
    getActionItems(userId, { status: "all", limit: 300 }),
    getEventsBetween(userId, rangeStart, rangeEnd),
    getActiveMemories(userId),
    getEmailReviewItems(userId, { status: "all", limit: 300 })
  ]);
  const actionInWeek = (action: ActionItem) =>
    isDateInRange(action.completedAt, rangeStart, rangeEnd) ||
    isDateInRange(action.updatedAt, rangeStart, rangeEnd) ||
    isDateInRange(action.createdAt, rangeStart, rangeEnd) ||
    isDateInRange(action.dueAt, rangeStart, rangeEnd);
  const completedActions = actions.filter((action) => action.status === "completed" && isDateInRange(action.completedAt, rangeStart, rangeEnd));
  const openActions = actions.filter((action) => (action.status === "open" || isSnoozedDue(action, now)) && isActionRelevantToReviewedRange(action, rangeStart, rangeEnd));
  const overdueActions = openActions.filter((action) => action.dueAt && action.dueAt < now);
  const snoozedOrRescheduledActions = actions.filter((action) => actionInWeek(action) && (action.status === "snoozed" || Boolean(action.snoozedUntil)));
  const archivedActions = actions.filter((action) => action.status === "archived" && actionInWeek(action));
  const guardrailEvents = events.filter(isGuardrailEvent);
  const activeReflections = memories.filter(isOperatorReflectionMemory);
  const hygiene = await analyzeActionHygiene(userId, now, timezone);
  const eventsByType = countEventsByType(events);
  const goalProgress = activeGoals.map((goal) => buildWeeklyGoalProgress(goal, events, completedActions));
  const goalsWithProgress = goalProgress.filter((goal) => goal.progressCount > 0);
  const goalsWithoutProgress = goalProgress.filter((goal) => goal.progressCount === 0 && !goal.isRiskControl);
  const dailyLoopCounts = await getWeeklyDailyLoopCounts(userId, weekStart, reviewedEnd);
  const emailAttention = buildWeeklyEmailAttentionSummary({
    emailReviews,
    actions,
    events,
    rangeStart,
    rangeEnd
  });

  return {
    userId,
    timezone,
    weekStartLocalDate: weekStart,
    weekEndLocalDate: weekEnd,
    reviewedEndLocalDate: reviewedEnd,
    rangeStart,
    rangeEnd,
    activeGoals,
    events,
    eventsByType,
    completedActions,
    openActions,
    overdueActions,
    snoozedOrRescheduledActions,
    archivedActions,
    guardrailEvents,
    emailAttention,
    goalProgress,
    goalsWithProgress,
    goalsWithoutProgress,
    actionHygiene: hygiene,
    activeReflections,
    dailyLoopCounts
  };
}

async function generateAndSaveWeeklyReview(userId: string, context: WeeklyReviewContext, options: { force?: boolean } = {}): Promise<WeeklyReviewMemory> {
  const deterministic = generateDeterministicWeeklyReview(context);
  const generated = options.force ? deterministic : await maybeGenerateLlmWeeklyReview(context) ?? deterministic;
  const existing = await getWeeklyReviewForWeek(userId, context.weekStartLocalDate);
  const data = {
    kind: "weekly_review",
    status: "generated",
    weekStartLocalDate: context.weekStartLocalDate,
    weekEndLocalDate: context.weekEndLocalDate,
    reviewedEndLocalDate: context.reviewedEndLocalDate,
    timezone: context.timezone,
    wins: generated.wins,
    stalls: generated.stalls,
    goalProgress: generated.goalProgress,
    guardrailSummary: generated.guardrailSummary,
    emailAttention: context.emailAttention,
    patterns: generated.patterns,
    recommendedNextWeekActions: generated.recommendedNextWeekActions,
    reflectionIds: generated.reflectionIds,
    source: generated.source
  };
  const evidence = {
    actionIds: uniqueStrings([
      ...context.completedActions.map((action) => action.id),
      ...context.overdueActions.map((action) => action.id),
      ...context.snoozedOrRescheduledActions.map((action) => action.id)
    ]).slice(0, 30),
    eventIds: context.events.map((event) => event.id).slice(0, 50),
    goalIds: context.activeGoals.map((goal) => goal.id),
    dateRange: {
      start: context.weekStartLocalDate,
      end: context.reviewedEndLocalDate
    },
    counts: weeklyContextCounts(context)
  };
  const summary = generated.summary;
  const memory = existing
    ? await updateMemory(userId, existing.id, { summary, data, evidence, confidence: 1 })
    : await createMemory(userId, {
      type: "pattern",
      summary,
      data,
      evidence,
      source: "system_inferred",
      confidence: 1
    });

  if (!memory) {
    throw new Error("Could not save weekly review.");
  }

  return toWeeklyReviewMemory(memory);
}

function generateDeterministicWeeklyReview(context: WeeklyReviewContext): WeeklyReviewDraft {
  const wins = weeklyReviewWins(context);
  const stalls = weeklyReviewStalls(context);
  const goalProgress = context.goalProgress.map((goal) => ({
    goalId: goal.goalId,
    title: goal.title,
    priority: goal.priority,
    isRiskControl: goal.isRiskControl,
    note: goal.note,
    progressCount: goal.progressCount
  }));
  const guardrailSummary = {
    triggers: context.guardrailEvents.length,
    note: buildWeeklyGuardrailNote(context)
  };
  const reflections = context.activeReflections.slice(0, 2);
  const recommendedNextWeekActions = buildNextWeekRecommendations(context).slice(0, 3);

  return {
    summary: buildWeeklyReviewSummary(context, wins, stalls),
    wins,
    stalls,
    goalProgress,
    guardrailSummary,
    patterns: reflections.map((reflection) => typeof reflection.data?.title === "string" ? reflection.data.title : reflection.summary),
    recommendedNextWeekActions,
    reflectionIds: reflections.map((reflection) => reflection.id),
    source: "deterministic"
  };
}

async function maybeGenerateLlmWeeklyReview(context: WeeklyReviewContext): Promise<WeeklyReviewDraft | undefined> {
  if (process.env.WEEKLY_REVIEW_LLM_ENABLED !== "true") {
    return undefined;
  }

  const mock = process.env.WEEKLY_REVIEW_LLM_MOCK_RESPONSE;

  if (!mock) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(mock) as unknown;
    const draft = parseWeeklyReviewDraft(parsed, context);
    return draft && isSafeWeeklyReviewDraft(draft, context) ? { ...draft, source: "llm" } : undefined;
  } catch {
    return undefined;
  }
}

function parseWeeklyReviewDraft(value: unknown, context: WeeklyReviewContext): WeeklyReviewDraft | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const wins = arrayOfStrings(value.wins).slice(0, 5);
  const stalls = arrayOfStrings(value.stalls).slice(0, 5);
  const recommendedNextWeekActions = arrayOfStrings(value.recommendedNextWeekActions).slice(0, 3);
  const summary = typeof value.summary === "string" ? value.summary.trim() : "";

  if (!summary || recommendedNextWeekActions.length > 3) {
    return undefined;
  }

  return {
    summary: summary.slice(0, 400),
    wins,
    stalls,
    goalProgress: context.goalProgress,
    guardrailSummary: {
      triggers: context.guardrailEvents.length,
      note: buildWeeklyGuardrailNote(context)
    },
    patterns: context.activeReflections.slice(0, 2).map((reflection) => typeof reflection.data?.title === "string" ? reflection.data.title : reflection.summary),
    recommendedNextWeekActions,
    reflectionIds: context.activeReflections.slice(0, 2).map((reflection) => reflection.id),
    source: "llm"
  };
}

function isSafeWeeklyReviewDraft(draft: WeeklyReviewDraft, context: WeeklyReviewContext): boolean {
  const text = [draft.summary, ...draft.wins, ...draft.stalls, ...draft.recommendedNextWeekActions].join(" ");

  if (containsUnsafeReflectionLanguage(text)) {
    return false;
  }

  if (draft.recommendedNextWeekActions.length > 3) {
    return false;
  }

  const allowedText = normalizeForComparison([
    ...context.activeGoals.map((goal) => goal.title),
    ...context.overdueActions.map((action) => action.title),
    ...context.snoozedOrRescheduledActions.map((action) => action.title),
    ...context.completedActions.map((action) => action.title),
    "job developer youtube script strength training reading homepage car application cv guardrail betting trading"
  ].join(" "));

  return draft.recommendedNextWeekActions.every((action) => sharesMeaningfulToken(normalizeForComparison(action), allowedText));
}

function weeklyReviewWins(context: WeeklyReviewContext): string[] {
  const wins: string[] = [];
  const workouts = countType(context.eventsByType, "health.workout_completed");
  const applications = countType(context.eventsByType, "career.application_sent");
  const customProgress = countType(context.eventsByType, "custom.goal_progress_logged");
  const emailReviewsHandled = context.emailAttention.reviewsApproved + context.emailAttention.reviewsRejected;

  if (context.completedActions.length > 0) {
    wins.push(`Completed ${context.completedActions.length} action${context.completedActions.length === 1 ? "" : "s"}.`);
  }

  if (emailReviewsHandled > 0) {
    wins.push(`Handled ${emailReviewsHandled} Gmail review${emailReviewsHandled === 1 ? "" : "s"}.`);
  }

  if (context.emailAttention.gmailDerivedActionItems > 0) {
    wins.push(`Created ${context.emailAttention.gmailDerivedActionItems} action item${context.emailAttention.gmailDerivedActionItems === 1 ? "" : "s"} from Gmail review.`);
  }

  if (context.emailAttention.gmailDerivedEvents > 0) {
    wins.push(`Logged ${context.emailAttention.gmailDerivedEvents} Gmail-derived event${context.emailAttention.gmailDerivedEvents === 1 ? "" : "s"}.`);
  }

  if (workouts > 0) {
    wins.push(`Logged ${workouts} workout${workouts === 1 ? "" : "s"}.`);
  }

  if (applications > 0) {
    wins.push(`Logged ${applications} job application event${applications === 1 ? "" : "s"}.`);
  }

  if (customProgress > 0) {
    wins.push(`Logged ${customProgress} custom progress event${customProgress === 1 ? "" : "s"}.`);
  }

  const movedGoals = context.goalsWithProgress.filter((goal) => !goal.isRiskControl).map((goal) => goal.title).slice(0, 2);
  if (movedGoals.length > 0) {
    wins.push(`Progress logged for ${movedGoals.join(", ")}.`);
  }

  return wins.length > 0 ? wins : ["No completed actions or progress events were logged this week."];
}

function weeklyReviewStalls(context: WeeklyReviewContext): string[] {
  const stalls: string[] = [];

  if (context.goalsWithoutProgress.length > 0) {
    stalls.push(`Goals with no progress: ${context.goalsWithoutProgress.map((goal) => goal.title).slice(0, 5).join(", ")}.`);
  }

  if (context.snoozedOrRescheduledActions.length > 0) {
    stalls.push(`Actions snoozed/rescheduled: ${context.snoozedOrRescheduledActions.length}.`);
  }

  if (context.actionHygiene.suggestedCleanupCandidates.length > 0) {
    stalls.push(`Overdue/stale actions needing decisions: ${context.actionHygiene.suggestedCleanupCandidates.length}.`);
  }

  if (context.emailAttention.pendingReviews > 0) {
    stalls.push(`${context.emailAttention.pendingReviews} Gmail review${context.emailAttention.pendingReviews === 1 ? "" : "s"} waiting for a decision.`);
  }

  return stalls.length > 0 ? stalls : ["No major stalls detected from logged data."];
}

function buildNextWeekRecommendations(context: WeeklyReviewContext): string[] {
  const recommendations: string[] = [];
  const jobGoal = context.activeGoals.find((goal) => /job|developer|career/i.test(`${goal.title} ${goal.templateId ?? ""}`));
  const creativeGoal = context.activeGoals.find((goal) => /youtube|creative|script|channel/i.test(`${goal.title} ${goal.category} ${goal.templateId ?? ""}`));
  const healthGoal = context.activeGoals.find((goal) => /strength|health|training|workout/i.test(`${goal.title} ${goal.category} ${goal.templateId ?? ""}`));
  const staleAction = context.actionHygiene.suggestedCleanupCandidates[0];

  if (jobGoal) {
    recommendations.push("Apply to 3 developer jobs.");
  }

  if (creativeGoal) {
    recommendations.push("Write 5 bullets for the YouTube script.");
  }

  if (healthGoal) {
    recommendations.push("Do 2 strength sessions.");
  }

  if (staleAction && recommendations.length < 3) {
    recommendations.push(`Decide ${staleAction.title}: complete, snooze, or archive.`);
  }

  if (context.guardrailEvents.length > 0 && recommendations.length < 3) {
    recommendations.push("Keep betting/trading out of task planning.");
  }

  return uniqueStrings(recommendations).slice(0, 3);
}

function buildWeeklyReviewSummary(context: WeeklyReviewContext, wins: string[], stalls: string[]): string {
  return `Verified reviewed period: ${context.completedActions.length} completed actions, ${context.events.length} events, ${context.guardrailEvents.length} guardrail trigger${context.guardrailEvents.length === 1 ? "" : "s"}. ${wins[0] ?? ""} ${stalls[0] ?? ""}`.trim();
}

function buildWeeklyGuardrailNote(context: WeeklyReviewContext): string {
  const riskGoals = context.activeGoals.filter(isRiskControlGoal);
  const goalPrefix = riskGoals.length > 0 ? `${riskGoals[0].title}: ` : "";

  if (context.guardrailEvents.length > 0) {
    return `${goalPrefix}triggered ${context.guardrailEvents.length} time${context.guardrailEvents.length === 1 ? "" : "s"}. Keep risky actions out of task creation.`;
  }

  return `${goalPrefix}no guardrail triggers logged this reviewed period.`;
}

function buildWeeklyGoalProgress(goal: Goal, events: StoredEvent[], completedActions: ActionItem[]) {
  const riskControl = isRiskControlGoal(goal);
  const goalEvents = events.filter((event) => stringFromRecord(event.data, "goalId") === goal.id || eventMatchesGoal(goal, event));
  const goalActions = completedActions.filter((action) => action.goalId === goal.id);
  const progressCount = goalEvents.length + goalActions.length;

  return {
    goalId: goal.id,
    title: goal.title,
    priority: goal.priority,
    isRiskControl: riskControl,
    progressCount,
    note: progressCount > 0
      ? `${progressCount} verified progress signal${progressCount === 1 ? "" : "s"}`
      : "no verified progress"
  };
}

function eventMatchesGoal(goal: Goal, event: StoredEvent): boolean {
  const text = `${goal.templateId ?? ""} ${goal.category} ${goal.title}`.toLowerCase();

  return (
    (/job|career/.test(text) && event.type.startsWith("career.")) ||
    (/health|strength|sleep/.test(text) && event.type.startsWith("health.")) ||
    (/reading|learning/.test(text) && event.type.startsWith("learning.")) ||
    (/betting|trading|finance/.test(text) && event.type.startsWith("finance."))
  );
}

async function getWeeklyReviewForWeek(userId: string, weekStartLocalDate: string): Promise<MemoryEntry | undefined> {
  return (await getActiveMemories(userId)).find((memory) => memory.data?.kind === "weekly_review" && memory.data.weekStartLocalDate === weekStartLocalDate);
}

async function getLatestWeeklyReview(userId: string): Promise<WeeklyReviewMemory | undefined> {
  const review = (await getMemories(userId))
    .filter((memory) => memory.status === "active" && memory.data?.kind === "weekly_review")
    .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())[0];

  return review ? toWeeklyReviewMemory(review) : undefined;
}

async function shouldPromptWeeklyReview(userId: string, now: Date, timezone: string): Promise<boolean> {
  const local = localWeekdayAndHour(now, timezone);

  if (!((local.weekday === "sunday" && local.hour >= 18) || (local.weekday === "monday" && local.hour < 12))) {
    return false;
  }

  const weekStart = startOfLocalWeek(formatDateInTimezone(now, timezone));
  return !(await getWeeklyReviewForWeek(userId, weekStart));
}

function toWeeklyReviewMemory(memory: MemoryEntry): WeeklyReviewMemory {
  const data = memory.data ?? {};

  return {
    id: memory.id,
    userId: memory.userId,
    weekStartLocalDate: typeof data.weekStartLocalDate === "string" ? data.weekStartLocalDate : "",
    weekEndLocalDate: typeof data.weekEndLocalDate === "string" ? data.weekEndLocalDate : "",
    reviewedEndLocalDate: typeof data.reviewedEndLocalDate === "string"
      ? data.reviewedEndLocalDate
      : typeof data.weekEndLocalDate === "string"
        ? data.weekEndLocalDate
        : "",
    timezone: typeof data.timezone === "string" ? data.timezone : "Europe/Madrid",
    status: data.status === "archived" ? "archived" : "generated",
    summary: memory.summary,
    wins: arrayOfStrings(data.wins),
    stalls: arrayOfStrings(data.stalls),
    goalProgress: Array.isArray(data.goalProgress) ? data.goalProgress : [],
    guardrailSummary: isRecord(data.guardrailSummary) ? data.guardrailSummary : {},
    emailAttention: parseStoredWeeklyEmailAttentionSummary(data.emailAttention),
    patterns: arrayOfStrings(data.patterns).slice(0, 2),
    recommendedNextWeekActions: arrayOfStrings(data.recommendedNextWeekActions).slice(0, 3),
    reflectionIds: arrayOfStrings(data.reflectionIds),
    source: data.source === "llm" || data.source === "mixed" ? data.source : "deterministic",
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt
  };
}

function parseStoredWeeklyEmailAttentionSummary(value: unknown): WeeklyEmailAttentionSummary | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const byKind = isRecord(value.byKind) ? value.byKind : {};

  return {
    reviewsCreated: finiteNumberFromRecord(value, "reviewsCreated"),
    reviewsApproved: finiteNumberFromRecord(value, "reviewsApproved"),
    reviewsRejected: finiteNumberFromRecord(value, "reviewsRejected"),
    pendingReviews: finiteNumberFromRecord(value, "pendingReviews"),
    gmailDerivedActionItems: finiteNumberFromRecord(value, "gmailDerivedActionItems"),
    gmailDerivedEvents: finiteNumberFromRecord(value, "gmailDerivedEvents"),
    byKind: {
      jobSearch: finiteNumberFromRecord(byKind, "jobSearch"),
      workAction: finiteNumberFromRecord(byKind, "workAction"),
      custom: finiteNumberFromRecord(byKind, "custom"),
      other: finiteNumberFromRecord(byKind, "other")
    }
  };
}

function formatWeeklyEmailSignalsForReview(emailAttention: WeeklyEmailAttentionSummary | undefined): string {
  if (!emailAttention) {
    return "- No Gmail review summary stored for this weekly review.";
  }

  const lines = [
    emailAttention.reviewsCreated > 0 ? `- ${emailAttention.reviewsCreated} Gmail review${emailAttention.reviewsCreated === 1 ? "" : "s"} created this reviewed period.` : undefined,
    emailAttention.reviewsApproved + emailAttention.reviewsRejected > 0
      ? `- ${emailAttention.reviewsApproved} approved, ${emailAttention.reviewsRejected} rejected.`
      : undefined,
    emailAttention.gmailDerivedActionItems > 0 ? `- ${emailAttention.gmailDerivedActionItems} action item${emailAttention.gmailDerivedActionItems === 1 ? "" : "s"} created from Gmail review.` : undefined,
    emailAttention.gmailDerivedEvents > 0 ? `- ${emailAttention.gmailDerivedEvents} Gmail-derived event${emailAttention.gmailDerivedEvents === 1 ? "" : "s"} logged.` : undefined,
    emailAttention.pendingReviews > 0 ? `- ${emailAttention.pendingReviews} Gmail review${emailAttention.pendingReviews === 1 ? "" : "s"} still waiting. Say "email reviews" to handle ${emailAttention.pendingReviews === 1 ? "it" : "them"}.` : undefined
  ].filter(Boolean);

  return lines.length > 0 ? lines.join("\n") : "- No Gmail review activity in this reviewed period.";
}

function formatWeeklyReview(review: WeeklyReviewMemory): string {
  const isSoFar = review.reviewedEndLocalDate && review.reviewedEndLocalDate < review.weekEndLocalDate;
  const title = isSoFar
    ? `Weekly review so far - ${review.weekStartLocalDate} to ${review.reviewedEndLocalDate}`
    : `Weekly review - ${review.weekStartLocalDate} to ${review.weekEndLocalDate}`;

  return [
    title,
    "",
    review.summary,
    "",
    "Wins:",
    review.wins.map((win) => `- ${win}`).join("\n"),
    "",
    "Stalled:",
    review.stalls.map((stall) => `- ${stall}`).join("\n"),
    "",
    "Guardrails:",
    `- ${typeof review.guardrailSummary.note === "string" ? review.guardrailSummary.note : "No guardrail summary."}`,
    "",
    "Email signals:",
    formatWeeklyEmailSignalsForReview(review.emailAttention),
    "",
    "Patterns:",
    review.patterns.length > 0 ? review.patterns.map((pattern) => `- ${pattern}`).join("\n") : "- No active operator reflections included.",
    "",
    "Next week:",
    review.recommendedNextWeekActions.length > 0
      ? review.recommendedNextWeekActions.map((action, index) => `${index + 1}. ${action}`).join("\n")
      : "No next-week actions suggested."
  ].join("\n");
}

function appendWeeklyPlanningNextStep(message: string): string {
  return `${message}\n\nNext: say 'plan next week' to turn this into actions.`;
}

function summarizeWeeklyReviewContext(context: WeeklyReviewContext) {
  return {
    weekWindow: {
      start: context.weekStartLocalDate,
      end: context.weekEndLocalDate
    },
    reviewedRange: {
      start: context.weekStartLocalDate,
      end: context.reviewedEndLocalDate
    },
    dateRange: {
      start: context.weekStartLocalDate,
      end: context.reviewedEndLocalDate
    },
    counts: weeklyContextCounts(context),
    eventsByType: context.eventsByType,
    emailAttention: context.emailAttention,
    goalsWithProgress: context.goalsWithProgress.map((goal) => goal.title),
    goalsWithoutProgress: context.goalsWithoutProgress.map((goal) => goal.title),
    activeReflections: context.activeReflections.map((reflection) => typeof reflection.data?.title === "string" ? reflection.data.title : reflection.summary)
  };
}

function formatWeeklyReviewContextDebug(context: WeeklyReviewContext): string {
  const counts = weeklyContextCounts(context);

  return [
    "Weekly review context:",
    `weekWindow: ${context.weekStartLocalDate} to ${context.weekEndLocalDate}`,
    `reviewedRange: ${context.weekStartLocalDate} to ${context.reviewedEndLocalDate}`,
    `completed actions: ${counts.completedActions}`,
    `open actions: ${counts.openActions}`,
    `overdue/stale actions: ${counts.overdueActions}`,
    `snoozes/reschedules: ${counts.snoozedOrRescheduledActions}`,
    `guardrail triggers: ${counts.guardrailTriggers}`,
    `Gmail reviews created: ${counts.gmailReviewsCreated}`,
    `Gmail reviews pending: ${counts.gmailReviewsPending}`,
    `Gmail-derived actions: ${counts.gmailDerivedActionItems}`,
    `Gmail-derived events: ${counts.gmailDerivedEvents}`,
    `goals with progress: ${context.goalsWithProgress.length}`,
    `goals without progress: ${context.goalsWithoutProgress.length}`,
    `active reflections: ${context.activeReflections.length}`,
    "events by type:",
    ...Object.entries(context.eventsByType).slice(0, 10).map(([type, count]) => `- ${type}: ${count}`)
  ].join("\n");
}

export type PlanWindowKind = "next_week" | "current_week";

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

async function generateNextWeekPlanSuggestions(context: NextWeekPlanContext): Promise<NextWeekPlanSuggestion[]> {
  const deterministic = generateDeterministicNextWeekPlanSuggestions(context);
  const llm = await maybeGenerateLlmNextWeekPlanSuggestions(context, deterministic);
  return normalizeNextWeekPlanSuggestions(context, [...deterministic, ...llm]).slice(0, 7);
}

function generateDeterministicNextWeekPlanSuggestions(context: NextWeekPlanContext): NextWeekPlanSuggestion[] {
  const suggestions: NextWeekPlanSuggestion[] = [];
  const normalGoals = [...context.activeGoals]
    .filter((goal) => !isRiskControlGoal(goal))
    .sort(compareGoalsForPlan(context));
  const staleAction = context.staleActions[0];

  if (staleAction) {
    suggestions.push({
      index: 0,
      title: `Resolve stale action: ${staleAction.title}`,
      reason: `${staleAction.title} needs a cleanup decision before next week gets noisy.`,
      goalId: undefined,
      goalTitle: staleAction.linkedGoalTitle,
      priority: staleAction.priority === "high" ? "high" : "medium",
      actionPriority: staleAction.priority === "high" ? "high" : "medium",
      suggestedDueAt: localPlanDate(context, 0, 9 * 60),
      actionType: "generic",
      source: "weekly_plan",
      duplicateRisk: true,
      existingActionId: staleAction.actionId,
      existingActionTitle: staleAction.title,
      planKind: "cleanup",
      creatable: false,
      dedupeKey: `weekly_plan.cleanup.${staleAction.actionId}`,
      notCreatableReason: "Use /action_hygiene or say a natural cleanup command like snooze, complete, or archive."
    });
  }

  if (context.emailAttention.pendingReviews > 0) {
    suggestions.push({
      index: 0,
      title: "Clear pending Gmail reviews",
      reason: `${context.emailAttention.pendingReviews} Gmail review${context.emailAttention.pendingReviews === 1 ? " is" : "s are"} already waiting for a decision.`,
      goalId: undefined,
      goalTitle: undefined,
      priority: context.emailAttention.byKind.workAction > 0 ? "high" : "medium",
      actionPriority: "medium",
      suggestedDueAt: localPlanDate(context, 0, 10 * 60),
      actionType: "generic",
      source: "weekly_plan",
      duplicateRisk: true,
      planKind: "cleanup",
      creatable: false,
      dedupeKey: "weekly_plan.email_reviews_cleanup",
      notCreatableReason: "Say \"email reviews\" or \"show me the important emails\"; those reviews already exist."
    });
  }

  for (const goal of normalGoals) {
    const suggestion = suggestionForGoal(context, goal);

    if (suggestion) {
      suggestions.push(suggestion);
    }

    if (suggestions.length >= 6) {
      break;
    }
  }

  const riskGoal = context.guardrailGoals[0];
  if (riskGoal && suggestions.length < 7) {
    suggestions.push({
      index: 0,
      title: "Review betting/trading guardrail rules",
      reason: context.guardrailEvents.length > 0
        ? `${riskGoal.title} had guardrail activity this week; keep next week clean.`
        : `${riskGoal.title} is active; keep risky actions out of planning.`,
      goalId: riskGoal.id,
      goalTitle: riskGoal.title,
      priority: normalizePlanPriority(riskGoal.priority),
      actionPriority: normalizePlanActionPriority(riskGoal.priority),
      suggestedDueAt: localPlanDate(context, 6, 18 * 60),
      actionType: "generic",
      source: "weekly_plan",
      duplicateRisk: false,
      dedupeKey: "weekly_plan.guardrail_review"
    });
  }

  if (suggestions.length < 3) {
    suggestions.push(
      {
        index: 0,
        title: "Review open actions and pick one to finish",
        reason: "The plan needs one concrete execution decision.",
        priority: "medium",
        actionPriority: "medium",
        suggestedDueAt: localPlanDate(context, 0, 9 * 60),
        actionType: "generic",
        source: "weekly_plan",
        duplicateRisk: false,
        dedupeKey: "weekly_plan.review_open_actions"
      },
      {
        index: 0,
        title: "Log one meaningful progress action",
        reason: "A weekly plan should produce at least one verified progress signal.",
        priority: "medium",
        actionPriority: "medium",
        suggestedDueAt: localPlanDate(context, 2, 16 * 60 + 30),
        actionType: "generic",
        source: "weekly_plan",
        duplicateRisk: false,
        dedupeKey: "weekly_plan.progress_action"
      },
      {
        index: 0,
        title: "Run weekly review before Sunday night",
        reason: "Close the loop with evidence before planning the following week.",
        priority: "low",
        actionPriority: "low",
        suggestedDueAt: localPlanDate(context, 6, 18 * 60),
        actionType: "generic",
        source: "weekly_plan",
        duplicateRisk: false,
        dedupeKey: "weekly_plan.run_weekly_review"
      }
    );
  }

  return suggestions;
}

function suggestionForGoal(context: NextWeekPlanContext, goal: Goal): NextWeekPlanSuggestion | undefined {
  const key = normalizeForComparison(`${goal.templateId ?? ""} ${goal.category} ${goal.title}`);
  const hasNoProgress = context.goalsWithNoProgress.some((item) => item.goalId === goal.id);
  const priority = normalizePlanPriority(goal.priority);
  const reason = hasNoProgress
    ? `${goal.title} had no progress this reviewed week.`
    : `${goal.title} is active; keep momentum concrete.`;
  const base = {
    index: 0,
    goalId: goal.id,
    goalTitle: goal.title,
    priority,
    actionPriority: normalizePlanActionPriority(priority),
    actionType: "generic" as const,
    source: "weekly_plan" as const,
    duplicateRisk: false
  };

  if (/job|career|developer|cv|application/.test(key)) {
    return {
      ...base,
      title: "Apply to 3 developer jobs",
      reason,
      suggestedDueAt: localPlanDate(context, 0, 9 * 60),
      dedupeKey: "weekly_plan.job_search_apply_3"
    };
  }

  if (/youtube|channel|creative|script|video|creator|build_project/.test(key)) {
    return {
      ...base,
      title: "Write 5 bullets for the YouTube script",
      reason,
      suggestedDueAt: localPlanDate(context, 1, 16 * 60 + 30),
      dedupeKey: "weekly_plan.youtube_script_bullets"
    };
  }

  if (/strength|health|training|workout|gym|energy/.test(key)) {
    return {
      ...base,
      title: "Do 2 strength sessions",
      reason,
      suggestedDueAt: localPlanDate(context, 2, 18 * 60),
      dedupeKey: "weekly_plan.strength_sessions"
    };
  }

  if (/sleep/.test(key)) {
    return {
      ...base,
      title: "Set sleep cutoff for 3 nights",
      reason,
      suggestedDueAt: localPlanDate(context, 0, 20 * 60),
      dedupeKey: "weekly_plan.sleep_cutoff"
    };
  }

  if (/read|reading|learning|book/.test(key)) {
    return {
      ...base,
      title: "Read 20 minutes on 3 days",
      reason,
      suggestedDueAt: localPlanDate(context, 1, 20 * 60),
      dedupeKey: "weekly_plan.reading_20_min_3_days"
    };
  }

  if (/car|vehicle|cheap car|buy car/.test(key)) {
    return {
      ...base,
      title: "Check cheap car listings twice",
      reason,
      suggestedDueAt: localPlanDate(context, 3, 16 * 60 + 30),
      dedupeKey: "weekly_plan.car_listings_twice"
    };
  }

  return {
    ...base,
    title: `Do one concrete action for ${goal.title}`,
    reason,
    suggestedDueAt: localPlanDate(context, 2, 16 * 60 + 30),
    dedupeKey: `weekly_plan.goal_action.${goal.id}`
  };
}

async function maybeGenerateLlmNextWeekPlanSuggestions(
  context: NextWeekPlanContext,
  deterministic: NextWeekPlanSuggestion[]
): Promise<NextWeekPlanSuggestion[]> {
  if (process.env.NEXT_WEEK_PLAN_LLM_ENABLED !== "true") {
    return [];
  }

  const mock = process.env.NEXT_WEEK_PLAN_LLM_MOCK_RESPONSE;

  if (mock) {
    try {
      const parsed = JSON.parse(mock) as unknown;
      return parseLlmNextWeekPlanSuggestions(parsed, context, deterministic);
    } catch {
      return [];
    }
  }

  if (!process.env.OPENAI_API_KEY) {
    return [];
  }

  try {
    const client = createOpenAIClient();
    const model = process.env.OPENAI_MODEL ?? "gpt-4o-mini";
    const response = await client.responses.create({
      model,
      store: false,
      input: [
        {
          role: "developer",
          content: [
            {
              type: "input_text",
              text: [
                "You are Alecto's weekly planning assistant.",
                "Code has already gathered verified context. You only propose small ActionItem suggestions.",
                "Do not create, update, delete, or imply any database mutation.",
                "Do not invent facts, goals, events, memories, due dates, or risk states.",
                "Every suggestion must reference an existing goal, a stale/open action, a verified weekly gap, or a deterministic suggestion.",
                "Do not suggest betting/trading actions or advice. Risk-control goals may only produce safe guardrail-review actions.",
                "No shame language, no fake motivation, no huge plans.",
                "Return strict JSON only."
              ].join("\n")
            }
          ]
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify(compactNextWeekPlanLlmContext(context, deterministic))
            }
          ]
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "next_week_plan_suggestions",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["suggestions"],
            properties: {
              suggestions: {
                type: "array",
                maxItems: 7,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["title", "reason", "goalId", "priority", "suggestedDueAt"],
                  properties: {
                    title: { type: "string" },
                    reason: { type: "string" },
                    goalId: { type: ["string", "null"] },
                    priority: { type: "string", enum: ["low", "medium", "high", "critical"] },
                    suggestedDueAt: { type: "string" }
                  }
                }
              }
            }
          }
        }
      }
    });

    return parseLlmNextWeekPlanSuggestions(JSON.parse(response.output_text) as unknown, context, deterministic);
  } catch {
    return [];
  }
}

function compactNextWeekPlanLlmContext(context: NextWeekPlanContext, deterministic: NextWeekPlanSuggestion[]) {
  return {
    planningWindow: {
      kind: context.planWindowKind,
      startLocalDate: context.planStartLocalDate,
      endLocalDate: context.planEndLocalDate,
      timezone: context.timezone
    },
    latestWeeklyReview: context.latestWeeklyReview
      ? {
          id: context.latestWeeklyReview.id,
          summary: context.latestWeeklyReview.summary,
          stalls: context.latestWeeklyReview.stalls.slice(0, 5),
          recommendedNextWeekActions: context.latestWeeklyReview.recommendedNextWeekActions.slice(0, 5)
        }
      : null,
    activeGoals: context.activeGoals.map((goal) => ({
      id: goal.id,
      title: goal.title,
      category: goal.category,
      templateId: goal.templateId,
      priority: goal.priority,
      importanceScore: goal.importanceScore
    })),
    goalsWithNoProgress: context.goalsWithNoProgress.map((goal) => ({
      goalId: goal.goalId,
      title: goal.title
    })),
    staleActions: context.staleActions.slice(0, 5).map((action) => ({
      id: action.actionId,
      title: action.title,
      dueAt: action.dueAt
    })),
    futureActionsAlreadyScheduled: context.futureActionsNextWeek.map((action) => ({
      id: action.id,
      title: action.title,
      dueAt: action.dueAt,
      goalId: action.goalId
    })),
    emailAttention: {
      pendingReviews: context.emailAttention.pendingReviews,
      reviewsCreated: context.emailAttention.reviewsCreated,
      reviewsApproved: context.emailAttention.reviewsApproved,
      reviewsRejected: context.emailAttention.reviewsRejected,
      gmailDerivedActionItems: context.emailAttention.gmailDerivedActionItems,
      gmailDerivedEvents: context.emailAttention.gmailDerivedEvents
    },
    guardrailGoals: context.guardrailGoals.map((goal) => ({
      id: goal.id,
      title: goal.title,
      priority: goal.priority
    })),
    deterministicSuggestions: deterministic.map((suggestion) => ({
      title: suggestion.title,
      goalId: suggestion.goalId,
      priority: suggestion.priority,
      actionPriority: suggestion.actionPriority ?? normalizePlanActionPriority(suggestion.priority),
      suggestedDueAt: suggestion.suggestedDueAt.toISOString()
    }))
  };
}

function parseLlmNextWeekPlanSuggestions(
  value: unknown,
  context: NextWeekPlanContext,
  deterministic: NextWeekPlanSuggestion[]
): NextWeekPlanSuggestion[] {
  const rawSuggestions = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.suggestions)
      ? value.suggestions
      : [];
  const allowedGoalIds = new Set(context.activeGoals.map((goal) => goal.id));
  const allowedText = normalizeForComparison([
    ...context.activeGoals.map((goal) => goal.title),
    ...context.staleActions.map((action) => action.title),
    ...deterministic.map((suggestion) => suggestion.title),
    "job developer youtube script strength training reading homepage car application cv guardrail"
  ].join(" "));

  return rawSuggestions
    .slice(0, 7)
    .filter(isRecord)
    .map((item): NextWeekPlanSuggestion | undefined => {
      const title = typeof item.title === "string" ? sentenceLikeTitle(item.title) : "";
      const reason = typeof item.reason === "string" ? item.reason.trim().slice(0, 220) : "";
      const goalId = typeof item.goalId === "string" && allowedGoalIds.has(item.goalId) ? item.goalId : undefined;
      const goal = goalId ? context.activeGoals.find((candidate) => candidate.id === goalId) : undefined;
      const priority = normalizePlanPriority(typeof item.priority === "string" ? item.priority : goal?.priority);
      const actionPriority = normalizePlanActionPriority(priority);
      const dueAt = typeof item.suggestedDueAt === "string" ? new Date(item.suggestedDueAt) : undefined;

      if (!title || !reason || containsUnsafePlanAction(title) || containsUnsafePlanAction(reason)) {
        return undefined;
      }

      if (!goalId && !sharesMeaningfulToken(normalizeForComparison(`${title} ${reason}`), allowedText)) {
        return undefined;
      }

      return {
        index: 0,
        title,
        reason,
        goalId,
        goalTitle: goal?.title,
        priority,
        actionPriority,
        suggestedDueAt: coercePlanDueAt(context, dueAt, 2, 16 * 60 + 30),
        actionType: "generic",
        source: "weekly_plan",
        duplicateRisk: false,
        dedupeKey: inferWeeklyPlanDedupeKey(title, goal?.title)
      };
    })
    .filter(Boolean) as NextWeekPlanSuggestion[];
}

function normalizeNextWeekPlanSuggestions(
  context: NextWeekPlanContext,
  suggestions: NextWeekPlanSuggestion[]
): NextWeekPlanSuggestion[] {
  const seen = new Set<string>();
  const normalized: NextWeekPlanSuggestion[] = [];

  for (const suggestion of suggestions) {
    const title = sentenceLikeTitle(suggestion.title);
    const dedupeKey = suggestion.dedupeKey ?? inferWeeklyPlanDedupeKey(title, suggestion.goalTitle);
    const key = dedupeKey ?? normalizeManualActionTitleKey(title);

    if (!title || seen.has(key) || containsUnsafePlanAction(title)) {
      continue;
    }

    seen.add(key);
    const suggestedDueAt = coercePlanDueAt(context, suggestion.suggestedDueAt, 2, 16 * 60 + 30);
    const duplicate = findEquivalentOpenPlanAction(context, title, suggestedDueAt, dedupeKey);
    normalized.push({
      ...suggestion,
      index: normalized.length + 1,
      title,
      reason: suggestion.reason.trim().slice(0, 220),
      priority: normalizePlanPriority(suggestion.priority),
      actionPriority: normalizePlanActionPriority(suggestion.actionPriority ?? suggestion.priority),
      suggestedDueAt,
      dedupeKey,
      duplicateRisk: suggestion.duplicateRisk || Boolean(duplicate),
      existingActionId: suggestion.existingActionId ?? duplicate?.id,
      existingActionTitle: suggestion.existingActionTitle ?? duplicate?.title,
      planKind: suggestion.planKind ?? "action",
      creatable: suggestion.creatable !== false,
      notCreatableReason: suggestion.notCreatableReason
    });
  }

  return normalized.slice(0, 7);
}

function compareGoalsForPlan(context: NextWeekPlanContext) {
  return (left: Goal, right: Goal) => {
    const leftNoProgress = context.goalsWithNoProgress.some((goal) => goal.goalId === left.id) ? 1 : 0;
    const rightNoProgress = context.goalsWithNoProgress.some((goal) => goal.goalId === right.id) ? 1 : 0;
    const leftPriority = goalPriorityRank(left);
    const rightPriority = goalPriorityRank(right);

    return rightPriority - leftPriority || rightNoProgress - leftNoProgress || left.createdAt.getTime() - right.createdAt.getTime();
  };
}

function findEquivalentOpenPlanAction(
  context: NextWeekPlanContext,
  title: string,
  dueAt?: Date,
  dedupeKey?: string
): ActionItem | undefined {
  const key = normalizeManualActionTitleKey(title);
  const dueLocalDate = dueAt ? formatDateInTimezone(dueAt, context.timezone) : "";

  if (dedupeKey) {
    const semanticDuplicate = context.openActions.find((action) => weeklyPlanDedupeKeyForAction(action) === dedupeKey);

    if (semanticDuplicate) {
      return semanticDuplicate;
    }
  }

  return context.openActions.find((action) => {
    const actionKey = normalizeManualActionTitleKey(action.title);
    if (actionKey !== key) {
      return false;
    }

    const actionDate = action.dueAt ?? action.snoozedUntil;
    const actionDueDate = actionDate ? formatDateInTimezone(actionDate, context.timezone) : "";
    return !dueLocalDate || !actionDueDate || actionDueDate === dueLocalDate || Boolean(actionDate);
  });
}

function inferWeeklyPlanDedupeKey(title: string, goalTitle?: string): string | undefined {
  const text = normalizeForComparison(`${title} ${goalTitle ?? ""}`);

  if (isGuardrailReviewPlanText(text)) {
    return "weekly_plan.guardrail_review";
  }

  if (/apply.*(developer|job)|developer.*job|job.*application|send.*cv|cv|resume/.test(text)) {
    return "weekly_plan.job_search_apply_3";
  }

  if (/youtube|script|channel|video/.test(text)) {
    return "weekly_plan.youtube_script_bullets";
  }

  if (/strength|training|workout|gym/.test(text)) {
    return "weekly_plan.strength_sessions";
  }

  if (/sleep.*cutoff|cutoff.*sleep/.test(text)) {
    return "weekly_plan.sleep_cutoff";
  }

  if (/read|reading|book/.test(text)) {
    return "weekly_plan.reading_20_min_3_days";
  }

  if (/car|vehicle|listings/.test(text)) {
    return "weekly_plan.car_listings_twice";
  }

  if (/review.*open.*actions|open.*actions.*finish/.test(text)) {
    return "weekly_plan.review_open_actions";
  }

  if (/gmail|email|mail|correo|correu/.test(text) && /review|pending|waiting|important|clear/.test(text)) {
    return "weekly_plan.email_reviews_cleanup";
  }

  if (/meaningful.*progress|progress.*action/.test(text)) {
    return "weekly_plan.progress_action";
  }

  if (/weekly.*review|review.*sunday/.test(text)) {
    return "weekly_plan.run_weekly_review";
  }

  return undefined;
}

function weeklyPlanDedupeKeyForAction(action: ActionItem): string | undefined {
  const sourceId = action.sourceId ?? "";
  const sourceMatch = sourceId.match(/weekly-plan:[^:]+:(weekly_plan\.[a-z0-9_.-]+)/);

  if (sourceMatch) {
    return sourceMatch[1];
  }

  return inferWeeklyPlanDedupeKey([
    action.title,
    action.description ?? "",
    action.evidence ?? "",
    action.goalTitleSnapshot ?? ""
  ].join(" "));
}

function isGuardrailReviewPlanText(text: string): boolean {
  return /review/.test(text) &&
    /guardrail|rules/.test(text) &&
    /betting|trading|risk|control impulsive betting|impulsive betting/.test(text);
}

function summarizeNextWeekPlanContext(context: NextWeekPlanContext) {
  return {
    planningWindow: {
      kind: context.planWindowKind,
      start: context.planStartLocalDate,
      end: context.planEndLocalDate
    },
    latestWeeklyReview: context.latestWeeklyReview
      ? {
          id: context.latestWeeklyReview.id,
          weekStartLocalDate: context.latestWeeklyReview.weekStartLocalDate,
          reviewedEndLocalDate: context.latestWeeklyReview.reviewedEndLocalDate
        }
      : undefined,
    activeGoals: context.activeGoals.length,
    goalsWithNoProgress: context.goalsWithNoProgress.map((goal) => goal.title),
    openActions: context.openActions.length,
    staleActions: context.staleActions.length,
    activeReflections: context.activeReflections.length,
    futureActionsAlreadyScheduled: context.futureActionsNextWeek.length,
    emailAttention: context.emailAttention,
    guardrailGoals: context.guardrailGoals.map((goal) => goal.title),
    recentEventsSummary: context.recentEventsSummary
  };
}

function formatNextWeekPlanContextDebug(context: NextWeekPlanContext): string {
  return [
    `${formatPlanTitle(context)} context:`,
    `planningWindow: ${context.planStartLocalDate} to ${context.planEndLocalDate}`,
    `latest weekly review: ${context.latestWeeklyReview ? `${context.latestWeeklyReview.id} (${context.latestWeeklyReview.weekStartLocalDate} to ${context.latestWeeklyReview.reviewedEndLocalDate})` : "none"}`,
    `active goals: ${context.activeGoals.length}`,
    `goals with no progress: ${context.goalsWithNoProgress.length}`,
    `open actions: ${context.openActions.length}`,
    `stale actions: ${context.staleActions.length}`,
    `Gmail reviews pending: ${context.emailAttention.pendingReviews}`,
    `Gmail reviews created this reviewed period: ${context.emailAttention.reviewsCreated}`,
    `Gmail-derived actions this reviewed period: ${context.emailAttention.gmailDerivedActionItems}`,
    `active reflections: ${context.activeReflections.length}`,
    `future actions already scheduled: ${context.futureActionsNextWeek.length}`,
    `guardrail goals: ${context.guardrailGoals.length}`,
    "events by type:",
    ...Object.entries(context.recentEventsSummary).slice(0, 10).map(([type, count]) => `- ${type}: ${count}`)
  ].join("\n");
}

function formatNextWeekPlanMessage(context: NextWeekPlanContext, suggestions: NextWeekPlanSuggestion[]): string {
  const groups = groupPlanSuggestions(suggestions);
  return [
    formatPlanTitle(context),
    `Planning window: ${context.planStartLocalDate} to ${context.planEndLocalDate}`,
    "",
    "Needs cleanup:",
    ...formatPlanSuggestionGroup(groups.cleanup, context.timezone, "- None."),
    "",
    "Already scheduled:",
    ...formatPlanSuggestionGroup(groups.alreadyScheduled, context.timezone, "- None."),
    "",
    "Suggested new actions:",
    ...formatPlanSuggestionGroup(groups.newActions, context.timezone, "- None."),
    "",
    ...formatNextWeekPlanReplyExamples(suggestions)
  ].join("\n");
}

function formatPlanTitle(context: NextWeekPlanContext): string {
  return context.planWindowKind === "current_week" ? "This week plan" : "Next week plan";
}

function groupPlanSuggestions(suggestions: NextWeekPlanSuggestion[]) {
  return {
    cleanup: suggestions.filter((suggestion) => suggestion.planKind === "cleanup"),
    alreadyScheduled: suggestions.filter((suggestion) => suggestion.planKind !== "cleanup" && (suggestion.duplicateRisk || suggestion.existingActionId)),
    newActions: suggestions.filter((suggestion) => suggestion.planKind !== "cleanup" && !suggestion.duplicateRisk && !suggestion.existingActionId)
  };
}

function formatPlanSuggestionGroup(suggestions: NextWeekPlanSuggestion[], timezone: string, emptyLine: string): string[] {
  return suggestions.length > 0
    ? suggestions.map((suggestion) => formatNextWeekPlanSuggestionLine(suggestion, timezone))
    : [emptyLine];
}

async function replacePendingPlan(
  userId: string,
  context: NextWeekPlanContext,
  suggestions: NextWeekPlanSuggestion[],
  originalText: string
) {
  await replacePendingAction(userId, {
    type: "next_week_plan",
    summary: `${formatPlanTitle(context)} - ${context.planStartLocalDate} to ${context.planEndLocalDate}`,
    payload: {
      originalText,
      planWindowKind: context.planWindowKind,
      planStartLocalDate: context.planStartLocalDate,
      planEndLocalDate: context.planEndLocalDate,
      nextWeekStartLocalDate: context.planStartLocalDate,
      nextWeekEndLocalDate: context.planEndLocalDate,
      timezone: context.timezone,
      suggestions: suggestions.map(toPendingNextWeekPlanSuggestion)
    },
    expiresAt: pendingDecisionExpiry()
  });
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

function parseNextWeekPlanReply(message: string):
  | { operation: "create"; all: true; indexes: number[] }
  | { operation: "create"; all: false; indexes: number[] }
  | { operation: "edit"; index: number; timeText: string }
  | { operation: "remove"; index: number }
  | { operation: "show" }
  | { operation: "skip" | "cancel" }
  | undefined {
  const originalTrimmed = message.trim();
  const trimmed = originalTrimmed.toLowerCase();

  if (/^(skip|cancel|no)$/i.test(trimmed)) {
    return { operation: trimmed === "no" ? "skip" : trimmed as "skip" | "cancel" };
  }

  if (/^show\s+plan$/i.test(trimmed)) {
    return { operation: "show" };
  }

  const edit = originalTrimmed.match(/^edit\s+(\d+)\s+to\s+(.+)$/i);
  if (edit) {
    return { operation: "edit", index: Number(edit[1]), timeText: edit[2].trim() };
  }

  const remove = trimmed.match(/^remove\s+(\d+)$/i);
  if (remove) {
    return { operation: "remove", index: Number(remove[1]) };
  }

  if (/^create\s+all(?:\s+new)?$/i.test(trimmed)) {
    return { operation: "create", all: true, indexes: [] };
  }

  const create = trimmed.match(/^create\s+(.+)$/i);
  if (create) {
    const indexes = [...create[1].matchAll(/\d+/g)].map((match) => Number(match[0])).filter((index) => index > 0);
    return indexes.length > 0 ? { operation: "create", all: false, indexes } : undefined;
  }

  return undefined;
}

function readPendingNextWeekPlanSuggestions(value: unknown): NextWeekPlanSuggestion[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isRecord)
    .map((item): NextWeekPlanSuggestion | undefined => {
      const title = typeof item.title === "string" ? item.title : "";
      const reason = typeof item.reason === "string" ? item.reason : "";
      const suggestedDueAt = typeof item.suggestedDueAt === "string" ? new Date(item.suggestedDueAt) : undefined;

      if (!title || !reason || !suggestedDueAt || Number.isNaN(suggestedDueAt.getTime())) {
        return undefined;
      }

      return {
        index: typeof item.index === "number" ? item.index : 0,
        title,
        reason,
        goalId: typeof item.goalId === "string" ? item.goalId : undefined,
        goalTitle: typeof item.goalTitle === "string" ? item.goalTitle : undefined,
        priority: normalizePlanPriority(typeof item.priority === "string" ? item.priority : undefined),
        actionPriority: normalizePlanActionPriority(typeof item.actionPriority === "string" ? item.actionPriority : typeof item.priority === "string" ? item.priority : undefined),
        suggestedDueAt,
        actionType: "generic",
        source: "weekly_plan",
        duplicateRisk: item.duplicateRisk === true,
        existingActionId: typeof item.existingActionId === "string" ? item.existingActionId : undefined,
        existingActionTitle: typeof item.existingActionTitle === "string" ? item.existingActionTitle : undefined,
        planKind: item.planKind === "cleanup" ? "cleanup" : "action",
        creatable: item.creatable !== false,
        notCreatableReason: typeof item.notCreatableReason === "string" ? item.notCreatableReason : undefined,
        dedupeKey: typeof item.dedupeKey === "string" ? item.dedupeKey : inferWeeklyPlanDedupeKey(title, typeof item.goalTitle === "string" ? item.goalTitle : undefined)
      };
    })
    .filter(Boolean) as NextWeekPlanSuggestion[];
}

function getPendingPlanStart(payload: Record<string, unknown>): string {
  return typeof payload.planStartLocalDate === "string"
    ? payload.planStartLocalDate
    : typeof payload.nextWeekStartLocalDate === "string"
      ? payload.nextWeekStartLocalDate
      : "";
}

function getPendingPlanEnd(payload: Record<string, unknown>): string {
  return typeof payload.planEndLocalDate === "string"
    ? payload.planEndLocalDate
    : typeof payload.nextWeekEndLocalDate === "string"
      ? payload.nextWeekEndLocalDate
      : "";
}

function actionInputFromPlanSuggestion(suggestion: NextWeekPlanSuggestion, payload: Record<string, unknown>): CreateActionItemInput {
  const weekStart = getPendingPlanStart(payload) || "unknown-week";
  const sourceKey = suggestion.dedupeKey ?? normalizeManualActionTitleKey(suggestion.title);
  return {
    source: "system",
    sourceId: `weekly-plan:${weekStart}:${sourceKey}`,
    sourceProvider: "weekly_plan",
    goalId: suggestion.goalId,
    goalTitleSnapshot: suggestion.goalTitle,
    title: suggestion.title,
    description: suggestion.reason,
    priority: suggestion.actionPriority ?? normalizePlanActionPriority(suggestion.priority),
    dueAt: suggestion.suggestedDueAt,
    actionType: "generic",
    evidence: `Weekly plan suggestion (${sourceKey}): ${suggestion.reason}`
  };
}

function toPendingNextWeekPlanSuggestion(suggestion: NextWeekPlanSuggestion) {
  return {
    ...suggestion,
    suggestedDueAt: suggestion.suggestedDueAt.toISOString()
  };
}

function formatPendingNextWeekPlan(timezone: string, payload: Record<string, unknown>, suggestions: NextWeekPlanSuggestion[]): string {
  const start = getPendingPlanStart(payload);
  const end = getPendingPlanEnd(payload);
  const title = payload.planWindowKind === "current_week" ? "This week plan" : "Next week plan";
  const groups = groupPlanSuggestions(suggestions);

  return [
    title,
    `Planning window: ${start} to ${end}`,
    "",
    "Needs cleanup:",
    ...formatPlanSuggestionGroup(groups.cleanup, timezone, "- None."),
    "",
    "Already scheduled:",
    ...formatPlanSuggestionGroup(groups.alreadyScheduled, timezone, "- None."),
    "",
    "Suggested new actions:",
    ...formatPlanSuggestionGroup(groups.newActions, timezone, "- None."),
    "",
    ...formatNextWeekPlanReplyExamples(suggestions)
  ].join("\n");
}

function formatNextWeekPlanReplyExamples(suggestions: NextWeekPlanSuggestion[]): string[] {
  const creatable = suggestions.filter(isCreatableNewPlanSuggestion);

  if (creatable.length === 0) {
    return [
      "Reply:",
      "Nothing new to create.",
      "- run /action_hygiene to resolve cleanup",
      "- ask what should I do today",
      "- skip"
    ];
  }

  const first = creatable[0].index;
  const lines = [
    "Reply:",
    `- create ${first}`
  ];

  if (creatable.length > 1) {
    lines.push(`- create ${first} and ${creatable[1].index}`);
  }

  lines.push(
    "- create all new",
    "- skip",
    `- edit ${first} to Friday morning`
  );

  return lines;
}

function isCreatableNewPlanSuggestion(suggestion: NextWeekPlanSuggestion): boolean {
  return suggestion.creatable !== false &&
    suggestion.planKind !== "cleanup" &&
    !suggestion.duplicateRisk &&
    !suggestion.existingActionId;
}

function formatNextWeekPlanSuggestionLine(suggestion: NextWeekPlanSuggestion, timezone: string): string {
  const tags = [
    suggestion.planKind === "cleanup" ? "cleanup" : undefined,
    suggestion.duplicateRisk
      ? suggestion.planKind === "cleanup" && suggestion.dedupeKey === "weekly_plan.email_reviews_cleanup"
        ? "already waiting"
        : suggestion.planKind === "cleanup"
          ? "already open"
          : "already covered"
      : undefined,
    suggestion.creatable === false ? "not creatable" : undefined
  ].filter(Boolean).join(" - ");
  const suffix = tags ? ` - ${tags}` : "";
  const details = [
    `${suggestion.index}. ${suggestion.title} - action priority: ${suggestion.actionPriority ?? normalizePlanActionPriority(suggestion.priority)} - goal priority: ${suggestion.priority} - ${formatPlanDue(suggestion.suggestedDueAt, timezone)}${suffix}`,
    `   Reason: ${suggestion.reason}`
  ];

  if (suggestion.creatable === false) {
    details.push(`   Not creatable: ${suggestion.notCreatableReason ?? "Use /action_hygiene to complete, snooze, or archive the existing action."}`);
  }

  return details.join("\n");
}

function formatSkippedNextWeekPlanSuggestion(suggestion: NextWeekPlanSuggestion): string {
  if (suggestion.dedupeKey === "weekly_plan.email_reviews_cleanup") {
    return `${suggestion.title} is already an email review inbox item. Say "email reviews" or "show me the important emails" to handle it.`;
  }

  if (suggestion.planKind === "cleanup" || suggestion.creatable === false) {
    return `${suggestion.title} is already an open action. Use /action_hygiene to complete, snooze, or archive it.`;
  }

  return `${suggestion.title} was skipped.`;
}

function localPlanDate(context: Pick<NextWeekPlanContext, "planStartLocalDate" | "timezone">, dayOffset: number, minutes: number): Date {
  const date = addDaysToLocalDateString(context.planStartLocalDate, dayOffset);
  const start = localDateStartUtc(date, context.timezone);
  return new Date(start.getTime() + minutes * 60_000);
}

function coercePlanDueAt(context: NextWeekPlanContext, dueAt: Date | undefined, fallbackDayOffset: number, fallbackMinutes: number): Date {
  if (dueAt && dueAt >= context.nextWeekRangeStart && dueAt < context.nextWeekRangeEnd) {
    return dueAt;
  }

  const fallback = localPlanDate(context, fallbackDayOffset, fallbackMinutes);
  if (fallback >= context.nextWeekRangeStart && fallback < context.nextWeekRangeEnd) {
    return fallback;
  }

  const endStart = localDateStartUtc(context.planEndLocalDate, context.timezone);
  const endFallback = new Date(endStart.getTime() + Math.min(fallbackMinutes, 18 * 60) * 60_000);
  return endFallback >= context.nextWeekRangeStart && endFallback < context.nextWeekRangeEnd
    ? endFallback
    : new Date(context.nextWeekRangeStart.getTime() + 9 * 60 * 60_000);
}

function formatPlanDue(date: Date, timezone: string): string {
  const weekday = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, weekday: "short" }).format(date);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  return `${weekday} ${time}`;
}

function normalizePlanPriority(value: unknown): NextWeekPlanSuggestion["priority"] {
  return value === "critical" || value === "high" || value === "medium" || value === "low" ? value : "medium";
}

function normalizePlanActionPriority(value: unknown): NextWeekPlanSuggestion["actionPriority"] {
  return value === "high" || value === "critical"
    ? "high"
    : value === "low"
      ? "low"
      : "medium";
}

function sentenceLikeTitle(value: string): string {
  const title = value
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);

  return title ? title.charAt(0).toUpperCase() + title.slice(1) : "";
}

function containsUnsafePlanAction(value: string): boolean {
  const text = value.toLowerCase();
  return /\b(place|open|make|take|size|enter|time|optimi[sz]e|justify)\s+(?:a\s+)?(?:bet|trade|long|short)\b/.test(text) ||
    /\b(?:bet|trade)\s+(?:small|later|with|if)\b/.test(text) ||
    /\b(?:20x|leverage|stop loss|entry|odds)\b/.test(text);
}

type PlanningRequestKind = "next_week" | "current_week" | "ambiguous";

function detectPlanningRequestKind(message: string): PlanningRequestKind | undefined {
  const text = message.trim().toLowerCase();

  if (!text) {
    return undefined;
  }

  if (
    /^(plan|make|create|build|generate)\s+(the\s+)?next\s+week(?:\s+(plan|actions))?$/.test(text) ||
    /^(make|create|build|generate)\s+next\s+week\s+actions$/.test(text) ||
    /^plan\s+the\s+next\s+week$/.test(text) ||
    /^create\s+a\s+plan\s+from\s+the\s+weekly\s+review$/.test(text)
  ) {
    return "next_week";
  }

  if (
    /^(plan|make|create|build|generate)\s+(my|this)\s+week(?:\s+plan)?$/.test(text) ||
    /^make\s+a\s+plan\s+for\s+this\s+week$/.test(text) ||
    /^what\s+should\s+i\s+focus\s+on\s+this\s+week$/.test(text)
  ) {
    return "current_week";
  }

  if (/^(make\s+a\s+plan|help\s+me\s+plan|what\s+should\s+i\s+plan)$/.test(text)) {
    return "ambiguous";
  }

  return undefined;
}

function looksLikeNextWeekPlanRequest(message: string): boolean {
  return detectPlanningRequestKind(message) === "next_week";
}

function isActionRelevantToReviewedRange(action: ActionItem, rangeStart: Date, rangeEnd: Date): boolean {
  if (isDateInRange(action.completedAt, rangeStart, rangeEnd)) {
    return true;
  }

  if (action.dueAt && action.dueAt < rangeEnd) {
    return true;
  }

  if (action.snoozedUntil && action.snoozedUntil < rangeEnd) {
    return true;
  }

  if (action.createdAt < rangeEnd && !action.dueAt && !action.snoozedUntil) {
    return true;
  }

  return false;
}

function weeklyContextCounts(context: WeeklyReviewContext) {
  return {
    completedActions: context.completedActions.length,
    openActions: context.openActions.length,
    overdueActions: context.overdueActions.length,
    snoozedOrRescheduledActions: context.snoozedOrRescheduledActions.length,
    archivedActions: context.archivedActions.length,
    events: context.events.length,
    guardrailTriggers: context.guardrailEvents.length,
    activeGoals: context.activeGoals.length,
    activeReflections: context.activeReflections.length,
    gmailReviewsCreated: context.emailAttention.reviewsCreated,
    gmailReviewsApproved: context.emailAttention.reviewsApproved,
    gmailReviewsRejected: context.emailAttention.reviewsRejected,
    gmailReviewsPending: context.emailAttention.pendingReviews,
    gmailDerivedActionItems: context.emailAttention.gmailDerivedActionItems,
    gmailDerivedEvents: context.emailAttention.gmailDerivedEvents,
    morningBriefs: context.dailyLoopCounts.morningBriefs,
    eveningReviews: context.dailyLoopCounts.eveningReviews
  };
}

function buildWeeklyEmailAttentionSummary(input: {
  emailReviews: EmailReviewItem[];
  actions: ActionItem[];
  events: StoredEvent[];
  rangeStart: Date;
  rangeEnd: Date;
}): WeeklyEmailAttentionSummary {
  const reviewsCreated = input.emailReviews.filter((review) => isDateInRange(review.createdAt, input.rangeStart, input.rangeEnd));
  const reviewsHandled = input.emailReviews.filter((review) => isDateInRange(review.reviewedAt, input.rangeStart, input.rangeEnd));
  const byKind = reviewsCreated.reduce(
    (counts, review) => {
      const kind = emailReviewKind(review);
      if (kind === "job_search") {
        counts.jobSearch += 1;
      } else if (kind === "work_action") {
        counts.workAction += 1;
      } else if (kind === "custom_tracking") {
        counts.custom += 1;
      } else {
        counts.other += 1;
      }
      return counts;
    },
    { jobSearch: 0, workAction: 0, custom: 0, other: 0 }
  );

  return {
    reviewsCreated: reviewsCreated.length,
    reviewsApproved: reviewsHandled.filter((review) => review.status === "approved").length,
    reviewsRejected: reviewsHandled.filter((review) => review.status === "rejected").length,
    pendingReviews: input.emailReviews.filter((review) => review.status === "pending").length,
    gmailDerivedActionItems: input.actions.filter(
      (action) => action.source === "email_review" && isDateInRange(action.createdAt, input.rangeStart, input.rangeEnd)
    ).length,
    gmailDerivedEvents: input.events.filter(
      (event) => event.source === "gmail" || event.provider === "gmail" || event.data.provider === "gmail"
    ).length,
    byKind
  };
}

async function getWeeklyDailyLoopCounts(userId: string, weekStart: string, weekEnd: string) {
  const states = await prisma.dailyLoopState.findMany({
    where: {
      userId,
      localDate: {
        gte: weekStart,
        lte: weekEnd
      }
    }
  });

  return {
    morningBriefs: states.filter((state) => state.morningBriefSentAt).length,
    eveningReviews: states.filter((state) => state.eveningReviewSentAt || state.eveningReviewCompletedAt).length
  };
}

function countEventsByType(events: StoredEvent[]): Record<string, number> {
  const counts: Record<string, number> = {};

  for (const event of events) {
    counts[event.type] = (counts[event.type] ?? 0) + 1;
  }

  return counts;
}

function countType(counts: Record<string, number>, type: string): number {
  return counts[type] ?? 0;
}

function startOfLocalWeek(localDate: string): string {
  const date = new Date(`${localDate}T12:00:00Z`);
  const day = date.getUTCDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  return addDaysToLocalDateString(localDate, mondayOffset);
}

function localDateStartUtc(localDate: string, timezone: string): Date {
  return getLocalTodayRange(new Date(`${localDate}T12:00:00Z`), timezone).start;
}

function localWeekdayAndHour(date: Date, timezone: string): { weekday: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    weekday: "long",
    hour: "2-digit",
    hour12: false
  }).formatToParts(date);

  return {
    weekday: (parts.find((part) => part.type === "weekday")?.value ?? "").toLowerCase(),
    hour: Number(parts.find((part) => part.type === "hour")?.value ?? 0)
  };
}

function isDateInRange(date: Date | undefined, start: Date, end: Date): boolean {
  return Boolean(date && date >= start && date < end);
}

function buildOperatorSummary(input: {
  openActions: ActionItem[];
  overdueActions: ActionItem[];
  activeGoals: Awaited<ReturnType<typeof getActiveGoals>>;
  todayEvents: StoredEvent[];
  risks: string[];
  emailAttention?: OperatorEmailAttentionSummary;
}): string {
  const parts = [
    `${input.openActions.length} open action${input.openActions.length === 1 ? "" : "s"}`,
    input.overdueActions.length > 0 ? `${input.overdueActions.length} overdue` : undefined,
    `${input.activeGoals.length} active goal${input.activeGoals.length === 1 ? "" : "s"}`,
    `${input.todayEvents.length} event${input.todayEvents.length === 1 ? "" : "s"} logged today`,
    input.emailAttention && input.emailAttention.pendingCount > 0
      ? `${input.emailAttention.pendingCount} Gmail review${input.emailAttention.pendingCount === 1 ? "" : "s"} waiting`
      : undefined,
    input.risks.length > 0 ? `${input.risks.length} risk watchout${input.risks.length === 1 ? "" : "s"}` : undefined
  ].filter(Boolean);

  return parts.length > 0 ? `Today has ${parts.join(", ")}.` : "Nothing material is logged for today yet.";
}

function buildDailyBriefContext(input: {
  date: string;
  timezone: string;
  activeGoals: Awaited<ReturnType<typeof getActiveGoals>>;
  goalStatus: DailyOperatorBriefGoalStatus[];
  rankedOpenActions: Array<{ action: ActionItem; score: DailyPriorityScore }>;
  recentWins: string[];
  risks: string[];
  suggestedNextStep: string;
  userOperatingProfile: Awaited<ReturnType<typeof getOrCreateUserOperatingProfile>>;
  todayEvents: StoredEvent[];
  completedToday: ActionItem[];
}): DailyBriefContext {
  const goalStatusById = new Map(input.goalStatus.map((goal) => [goal.goalId, goal]));

  return {
    date: input.date,
    timezone: input.timezone,
    activeGoals: input.activeGoals.map((goal) => {
      const status = goalStatusById.get(goal.id);
      const openLinkedActions = input.rankedOpenActions
        .map((item) => item.action)
        .filter((action) => action.goalId === goal.id)
        .map((action) => action.title);
      const completedLinkedActionsToday = input.completedToday
        .filter((action) => action.goalId === goal.id)
        .map((action) => action.title);

      return {
        id: goal.id,
        title: goal.title,
        priority: goal.priority,
        importanceScore: goal.importanceScore,
        statusToday: status?.note ?? "no progress logged today",
        openLinkedActions,
        completedLinkedActionsToday,
        guardrailActivityToday: input.todayEvents
          .filter((event) => event.type === "finance.betting.cooldown_triggered" && goal.id === event.data.goalId)
          .map((event) => event.type)
      };
    }),
    scoredPriorities: input.rankedOpenActions.slice(0, 10).map((item) => {
      const linkedGoal = input.activeGoals.find((goal) => goal.id === item.action.goalId);

      return {
        actionId: item.action.id,
        title: item.action.title,
        dueAt: item.action.dueAt?.toISOString(),
        dueLabel: dueLabelFromPriorityScore(item.score),
        score: item.score.score,
        rankReason: item.score.rankReason,
        linkedGoalTitle: linkedGoal?.title ?? item.action.goalTitleSnapshot,
        linkedGoalPriority: linkedGoal?.priority
      };
    }),
    recentWins: input.recentWins,
    risksOrWatchouts: input.risks,
    nextMove: input.suggestedNextStep,
    userOperatingProfile: {
      directness: input.userOperatingProfile.directness,
      warmth: input.userOperatingProfile.warmth,
      confrontation: input.userOperatingProfile.confrontation,
      verbosity: input.userOperatingProfile.verbosity,
      preferredStyle: input.userOperatingProfile.motivationalStyle
    }
  };
}

async function maybeGenerateDailyCoach(context: DailyBriefContext): Promise<DailyCoachGenerationResult> {
  const fallback = buildDeterministicDailyCoachResponse(context);

  if (!shouldUseDailyCoachLLM()) {
    return {
      coach: fallback,
      debug: {
        source: "fallback_disabled",
        llmAttempted: false,
        validationStatus: "skipped",
        validationFailureCodes: [],
        schemaValidationPassed: true,
        fallbackReason: "DAILY_COACH_LLM_ENABLED is not true or OPENAI_API_KEY is missing",
        selectedActionTitle: selectedDailyCoachActionTitle(context)
      }
    };
  }

  try {
    const coach = await withDailyCoachTimeout(generateDailyCoachResponse(context));

    return {
      coach,
      debug: {
        source: "llm",
        llmAttempted: true,
        validationStatus: "passed",
        validationFailureCodes: [],
        schemaValidationPassed: true,
        selectedActionTitle: selectedDailyCoachActionTitle(context)
      }
    };
  } catch (error) {
    console.warn("OpenAI daily coach failed; using deterministic coach.");
    const source = dailyCoachFallbackSource(error);

    return {
      coach: fallback,
      debug: {
        source,
        llmAttempted: true,
        validationStatus: source === "fallback_timeout" || source === "fallback_error" ? "skipped" : "failed",
        validationFailureCodes: dailyCoachValidationFailureCodes(error),
        validationFailureSummary: dailyCoachValidationFailureSummary(error, source),
        schemaValidationPassed: false,
        fallbackReason: dailyCoachFallbackReason(source),
        selectedActionTitle: selectedDailyCoachActionTitle(context),
        rawResponseType: error instanceof DailyCoachValidationError ? error.details.rawResponseType : undefined,
        parsedFieldsPresent: error instanceof DailyCoachValidationError ? error.details.parsedFieldsPresent : undefined,
        responseLength: error instanceof DailyCoachValidationError ? error.details.responseLength : undefined,
        diagnosisLength: error instanceof DailyCoachValidationError ? error.details.diagnosisLength : undefined,
        nextMoveLength: error instanceof DailyCoachValidationError ? error.details.nextMoveLength : undefined,
        warningLength: error instanceof DailyCoachValidationError ? error.details.warningLength : undefined,
        encouragementLength: error instanceof DailyCoachValidationError ? error.details.encouragementLength : undefined
      }
    };
  }
}

function shouldUseDailyCoachLLM(): boolean {
  return process.env.DAILY_COACH_LLM_ENABLED === "true" && Boolean(process.env.OPENAI_API_KEY);
}

async function withDailyCoachTimeout<T>(promise: Promise<T>): Promise<T> {
  const parsedTimeoutMs = Number(process.env.DAILY_COACH_LLM_TIMEOUT_MS ?? 3000);
  const timeoutMs = Number.isFinite(parsedTimeoutMs) ? parsedTimeoutMs : 3000;

  return await Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new DailyCoachTimeoutError()), Math.max(1, timeoutMs));
    })
  ]);
}

function dailyCoachFallbackSource(error: unknown): DailyCoachSource {
  if (error instanceof DailyCoachTimeoutError) {
    return "fallback_timeout";
  }

  if (error instanceof SyntaxError || (error && typeof error === "object" && "name" in error && error.name === "ZodError")) {
    return "fallback_invalid";
  }

  if (error instanceof DailyCoachValidationError) {
    return "fallback_invalid";
  }

  const message = error instanceof Error ? error.message : "";

  if (/invalid|validation|unsupported|changed deterministic next move|too long|betting\/trading advice/i.test(message)) {
    return "fallback_invalid";
  }

  return "fallback_error";
}

function dailyCoachValidationFailureCodes(error: unknown): string[] {
  if (error instanceof DailyCoachValidationError) {
    return error.failureCodes;
  }

  if (error instanceof SyntaxError) {
    return ["invalid_json"];
  }

  if (error && typeof error === "object" && "name" in error && error.name === "ZodError") {
    return ["schema_invalid"];
  }

  return [];
}

function dailyCoachValidationFailureSummary(error: unknown, source: DailyCoachSource): string | undefined {
  const codes = dailyCoachValidationFailureCodes(error);

  if (codes.length > 0) {
    return codes.join(", ");
  }

  if (source === "fallback_timeout") {
    return "timeout";
  }

  if (source === "fallback_error") {
    return "request_error";
  }

  return undefined;
}

function dailyCoachFallbackReason(source: DailyCoachSource): string {
  if (source === "fallback_invalid") {
    return "LLM response failed schema or policy validation";
  }

  if (source === "fallback_timeout") {
    return "LLM response timed out";
  }

  if (source === "fallback_error") {
    return "LLM request failed";
  }

  if (source === "fallback_disabled") {
    return "DAILY_COACH_LLM_ENABLED is not true or OPENAI_API_KEY is missing";
  }

  return "";
}

class DailyCoachTimeoutError extends Error {
  constructor() {
    super("Daily coach LLM timed out.");
  }
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

function noActiveGmailRulesMessage(): string {
  return "Gmail is connected, but no email tracking rules are active. Say 'enable job search rule for Gmail', 'enable work action rule for Gmail', or 'track Endesa bills from Gmail'.";
}

async function formatEmailRulesForConversation(userId: string, message?: string): Promise<string> {
  const [connections, rules, goals, pendingReviewCount, autonomyState] = await Promise.all([
    getIntegrationConnections(userId),
    getEmailSignalRules(userId),
    getGoals(userId),
    getPendingEmailReviewCount(userId),
    buildGmailAutonomyState(userId)
  ]);
  const gmailConnections = connections.filter((connection) => connection.integrationId === "gmail" && connection.status !== "archived");

  if (gmailConnections.length === 0) {
    return "Gmail is not connected yet. Say 'connect Gmail' or use /connect_gmail.";
  }

  const connectionById = new Map(gmailConnections.map((connection) => [connection.id, connection]));
  const visibleRules = rules.filter((rule) => rule.status !== "archived" && connectionById.has(rule.connectionId));
  const activeRules = visibleRules.filter((rule) => rule.status === "active");
  const wantsActiveOnly = message
    ? /\b(on|active|enabled|running|now)\b/.test(normalizeForComparison(message))
    : false;

  if (visibleRules.length === 0) {
    return noActiveGmailRulesMessage();
  }

  const goalById = new Map(goals.map((goal) => [goal.id, goal.title]));
  const activeLines = groupEmailRulesForHumanDisplay(activeRules).map((group) =>
    formatEmailRuleConversationGroupLine(group, goalById)
  );
  const pausedLines = wantsActiveOnly
    ? []
    : groupEmailRulesForHumanDisplay(visibleRules.filter((rule) => rule.status !== "active")).map((group) =>
        formatEmailRuleConversationGroupLine(group, goalById)
      );
  const hiddenInactiveCount = wantsActiveOnly ? visibleRules.length - activeRules.length : 0;

  await maybeRememberGmailRuleConversationContext(userId, visibleRules, activeRules.length === 1 ? activeRules[0] : undefined);

  return [
    wantsActiveOnly ? "Email rules currently on:" : "Email rules currently configured:",
    "",
    activeLines.length > 0 ? "On:" : undefined,
    ...(activeLines.length > 0 ? activeLines.map((line) => `- ${line}`) : ["No active email rules."]),
    pausedLines.length > 0 ? "" : undefined,
    pausedLines.length > 0 ? "Paused/error:" : undefined,
    ...pausedLines.map((line) => `- ${line}`),
    "",
    `Mode: ${gmailSyncModeShortLabel(autonomyState)}. Manual sync: say 'sync Gmail'.`,
    `Review notifications: ${autonomyState.reviewNotificationEnabled ? "on" : "off"}.`,
    pendingEmailReviewLine(pendingReviewCount),
    hiddenInactiveCount > 0 ? `${hiddenInactiveCount} paused/error rule${hiddenInactiveCount === 1 ? " is" : "s are"} hidden here.` : undefined,
    "Full IDs and settings: /my_email_rules"
  ].filter((line) => line !== undefined).join("\n");
}

function formatEmailRuleConversationLine(rule: EmailSignalRule, goalById: Map<string, string>): string {
  const goalTitle = rule.goalId ? goalById.get(rule.goalId) : undefined;
  const parts = [
    rule.name,
    rule.status !== "active" ? rule.status : undefined,
    emailRuleConversationBehavior(rule),
    `looks for: ${formatEmailRuleQueryForHumans(rule.query)}`,
    goalTitle ? `goal: ${goalTitle}` : undefined
  ];

  return parts.filter(Boolean).join(" - ");
}

function formatEmailRuleConversationGroupLine(
  group: EmailRuleHumanDisplayGroup,
  goalById: Map<string, string>
): string {
  const line = formatEmailRuleConversationLine(group.primary, goalById);

  if (group.rules.length <= 1) {
    return line;
  }

  return `${line} - ${group.rules.length} duplicate rules; shown once`;
}

function emailRuleConversationBehavior(rule: EmailSignalRule): string {
  if (rule.adapterId === "custom_email_review") {
    return "custom tracking, review first, auto-log off";
  }

  if (rule.adapterId === "work_action_email") {
    return "work actions, review first";
  }

  if (rule.adapterId === "job_search_email") {
    return rule.reviewBeforeLogging ? "job search, review first" : "job search, auto-log clear matches";
  }

  return rule.reviewBeforeLogging ? "review first" : "auto-log clear matches";
}

async function maybeRememberGmailRuleConversationContext(
  userId: string,
  rules: EmailSignalRule[],
  focusedRule?: EmailSignalRule
): Promise<void> {
  const contextRules = rules
    .filter((rule) => rule.status !== "archived")
    .slice(0, 10);

  if (contextRules.length === 0) {
    return;
  }

  const latestPending = await getLatestPendingAction(userId);
  if (latestPending && !isPendingCustomGmailRuleContext(latestPending)) {
    return;
  }

  const goals = await getGoals(userId);
  const goalById = new Map(goals.map((goal) => [goal.id, goal.title]));

  await replacePendingAction(userId, {
    type: "custom_email_rule",
    summary: focusedRule ? `Gmail rule context: ${focusedRule.name}` : "Gmail rule context",
    payload: {
      operation: "rule_context",
      focusedRuleId: focusedRule?.id,
      rules: contextRules.map((rule) => ({
        id: rule.id,
        adapterId: rule.adapterId,
        name: rule.name,
        query: rule.query,
        status: rule.status,
        goalTitle: rule.goalId ? goalById.get(rule.goalId) ?? null : null
      }))
    },
    expiresAt: pendingDecisionExpiry()
  });
}

async function enableEmailRuleForConversation(userId: string, kind: "job_search" | "work_action"): Promise<string> {
  const gmailConnection = (await getIntegrationConnections(userId)).find(
    (connection) => connection.integrationId === "gmail" && connection.status === "active"
  );

  if (!gmailConnection) {
    return "Gmail is not connected yet. Say 'connect Gmail' or use /connect_gmail.";
  }

  const adapterId = kind === "work_action" ? "work_action_email" : "job_search_email";
  const adapter = getEmailAdapterDefinition(adapterId);

  if (!adapter || adapter.status !== "available") {
    return "That email rule is not available yet.";
  }

  if (adapter.id === "job_search_email") {
    await archiveStaleJobSearchEmailRules(userId, gmailConnection.id);
  }

  const reusedRule = await reactivateOrReuseBuiltInEmailRule(userId, gmailConnection.id, adapter.id);

  if (reusedRule) {
    const actionLine = reusedRule.wasReactivated
      ? `${emailRuleHumanTitle(kind)} is back on.`
      : `${emailRuleHumanTitle(kind)} is already on.`;
    const duplicateLine =
      reusedRule.archivedDuplicateCount > 0
        ? `I archived ${reusedRule.archivedDuplicateCount} duplicate built-in rule${reusedRule.archivedDuplicateCount === 1 ? "" : "s"}.`
        : undefined;

    return [actionLine, duplicateLine, "", formatConversationEmailRuleEnabled(reusedRule.rule)].filter(Boolean).join("\n");
  }

  const input = conversationEmailRuleInputForKind(kind);
  const rule = await createEmailSignalRule(userId, {
    connectionId: gmailConnection.id,
    adapterId,
    name: input.name,
    reviewBeforeLogging: input.reviewBeforeLogging,
    fetchStrategy: input.fetchStrategy,
    classifierMode: input.classifierMode,
    lookbackDays: input.lookbackDays,
    maxMessagesPerSync: input.maxMessagesPerSync,
    maxEventsPerSync: input.maxEventsPerSync,
    minAutoLogConfidence: input.minAutoLogConfidence,
    minReviewConfidence: input.minReviewConfidence,
    query: adapter.defaultQuery ?? "",
    createdBy: "user"
  });

  return `${emailRuleHumanTitle(kind)} is on.\n\n${formatConversationEmailRuleEnabled(rule)}`;
}

function conversationEmailRuleInputForKind(kind: "job_search" | "work_action") {
  if (kind === "work_action") {
    return {
      name: "Work action emails",
      reviewBeforeLogging: true,
      fetchStrategy: "query" as const,
      classifierMode: "hybrid" as const,
      lookbackDays: 7,
      maxMessagesPerSync: 25,
      maxEventsPerSync: 5,
      minAutoLogConfidence: 0.95,
      minReviewConfidence: 0.7
    };
  }

  return {
    name: "Job search emails",
    reviewBeforeLogging: false,
    fetchStrategy: "query" as const,
    classifierMode: "rules" as const,
    lookbackDays: 30,
    maxMessagesPerSync: 25,
    maxEventsPerSync: 10,
    minAutoLogConfidence: 0.9,
    minReviewConfidence: 0.65
  };
}

function formatConversationEmailRuleEnabled(rule: EmailSignalRule): string {
  const isWorkAction = rule.adapterId === "work_action_email";
  const watchItems = isWorkAction
    ? ["work requests", "deadlines", "follow-ups", "feedback requests", "blockers"]
    : ["recruiter replies", "interview scheduling", "rejections", "offers", "application confirmations"];

  return [
    "What I will watch for:",
    ...watchItems.map((item) => `- ${item}`),
    "",
    isWorkAction
      ? "Work-action emails go to review before becoming action items."
      : "Clear job-search emails can become career events. Uncertain emails go to review.",
    "I only scan Gmail while this rule is active.",
    "Sync now: sync Gmail",
    "See rules: /my_email_rules"
  ].join("\n");
}

function emailRuleHumanTitle(kind: "job_search" | "work_action"): string {
  return kind === "work_action" ? "Work-action email tracking" : "Job-search email tracking";
}

async function reactivateOrReuseBuiltInEmailRule(
  userId: string,
  connectionId: string,
  adapterId: string
): Promise<{ rule: EmailSignalRule; wasReactivated: boolean; archivedDuplicateCount: number } | undefined> {
  if (!isBuiltInEmailAdapter(adapterId)) {
    return undefined;
  }

  const matchingRules = (await getEmailSignalRules(userId)).filter(
    (rule) =>
      rule.status !== "archived" &&
      rule.connectionId === connectionId &&
      rule.adapterId === adapterId
  );

  if (matchingRules.length === 0) {
    return undefined;
  }

  const primary = choosePrimaryBuiltInEmailRule(matchingRules);
  const wasReactivated = primary.status !== "active";
  const activePrimary = wasReactivated
    ? await updateEmailSignalRule(userId, primary.id, { status: "active" })
    : primary;

  if (!activePrimary) {
    return undefined;
  }

  let archivedDuplicateCount = 0;

  for (const rule of matchingRules) {
    if (rule.id === primary.id) {
      continue;
    }

    const archived = await archiveEmailSignalRule(userId, rule.id);
    if (archived) {
      archivedDuplicateCount += 1;
    }
  }

  return { rule: activePrimary, wasReactivated, archivedDuplicateCount };
}

function choosePrimaryBuiltInEmailRule(rules: EmailSignalRule[]): EmailSignalRule {
  return [...rules].sort((left, right) => {
    const leftActive = left.status === "active" ? 1 : 0;
    const rightActive = right.status === "active" ? 1 : 0;

    if (leftActive !== rightActive) {
      return rightActive - leftActive;
    }

    return right.updatedAt.getTime() - left.updatedAt.getTime();
  })[0];
}

async function formatGmailSetupForConversation(userId: string): Promise<string> {
  const state = await buildGmailAutonomyState(userId);

  if (!state.gmailConnected) {
    return [
      "Gmail setup",
      "",
      "Status: not connected.",
      "Access: readonly access after connection. Alecto cannot send emails or change labels.",
      "Scanning: off until Gmail is connected and at least one rule is enabled.",
      "",
      "What Gmail can track today:",
      "- Job search: recruiter replies, interviews, rejections, offers, application confirmations.",
      "- Work actions: requests, deadlines, follow-ups, feedback, blockers. These go to review first.",
      "- Custom tracking: sender and keyword rules. These go to review first and never auto-log.",
      "",
      formatGmailRecommendations(state.recommendedRules),
      "",
      "No webhooks yet. This is not instant arrival tracking.",
      `Next step: ${state.nextBestStep} Use /connect_gmail.`
    ].filter((line) => line !== undefined).join("\n");
  }

  const activeRuleLines =
    state.activeRules.length > 0
      ? groupEmailRulesForHumanDisplay(state.activeRules).map((group) => formatGmailSetupRuleLine(group.primary, group.rules.length))
      : ["- No active email tracking rules."];
  const pausedRuleLines =
    state.pausedRules.length > 0
      ? groupEmailRulesForHumanDisplay(state.pausedRules).map((group) => formatGmailSetupRuleLine(group.primary, group.rules.length))
      : [];

  return [
    "Gmail setup",
    "",
    `Status: connected${state.gmailAccount ? ` as ${state.gmailAccount}` : ""}.`,
    "Access: readonly access. Alecto cannot send emails or change labels.",
    "Alecto only scans Gmail through active rules.",
    `Mode: ${gmailSyncModeShortLabel(state)}.`,
    `Checks: ${gmailSyncModeSentence(state)}`,
    ...formatGmailBackgroundScheduleLines(state),
    `Notifications: review-waiting notifications ${state.reviewNotificationEnabled ? "on" : "off"}; delivery ${state.deliveryChannel}.`,
    state.pendingEmailReviewCount > 0 ? pendingEmailReviewLine(state.pendingEmailReviewCount) : undefined,
    "",
    "Active tracking:",
    ...activeRuleLines,
    pausedRuleLines.length > 0 ? "" : undefined,
    pausedRuleLines.length > 0 ? "Paused/error tracking:" : undefined,
    ...pausedRuleLines,
    "",
    formatGmailRecommendations(state.recommendedRules),
    "",
    "Review behavior: custom/work matches go to review; clear job-search matches can auto-log if that rule is on.",
    "Not available yet: instant webhooks, daily Gmail digest, work-hours-only checks, Gmail send/label actions.",
    `Next step: ${state.nextBestStep}`
  ].filter((line) => line !== undefined).join("\n");
}

function emailRuleTitleForAdapter(adapterId: string): string {
  if (adapterId === "custom_email_review") {
    return "Custom Gmail tracking";
  }

  if (adapterId === "work_action_email") {
    return "Work-action email tracking";
  }

  if (adapterId === "job_search_email") {
    return "Job-search email tracking";
  }

  return "Email tracking rule";
}

function formatGmailSetupRuleLine(rule: EmailSignalRule, duplicateCount = 1): string {
  const title = rule.adapterId === "custom_email_review" ? rule.name : emailRuleTitleForAdapter(rule.adapterId);
  const status = rule.status !== "active" ? `, ${rule.status}` : "";
  const duplicate = duplicateCount > 1 ? `, ${duplicateCount} duplicate rules shown once` : "";
  return `- ${title} - ${gmailRuleBehaviorLabel(rule)}${status}${duplicate}`;
}

async function formatGmailCapabilityGuidance(userId: string): Promise<string> {
  const state = await buildGmailAutonomyState(userId);
  const activeLine =
    state.gmailConnected && state.activeRules.length > 0
      ? [
          "",
          "Active now:",
          ...groupEmailRulesForHumanDisplay(state.activeRules).map((group) => `- ${formatGmailSetupRuleLine(group.primary, group.rules.length).replace(/^- /, "")}`)
        ]
      : [];

  return [
    "Gmail works through explicit tracking rules. It does not read your whole inbox by default.",
    "",
    "Ready today:",
    "- Job search: recruiter replies, interviews, rejections, offers, application confirmations.",
    "- Work actions: requests, deadlines, follow-ups, feedback, blockers. These go to review first.",
    "- Custom tracking: sender and keyword rules. These go to review first and never auto-log.",
    "",
    ...activeLine,
    "",
    `Mode: ${gmailSyncModeShortLabel(state)}.`,
    state.pendingEmailReviewCount > 0 ? pendingEmailReviewLine(state.pendingEmailReviewCount) : undefined,
    formatGmailRecommendations(state.recommendedRules),
    "",
    "Custom rules and work-action matches go to email review before anything becomes an action or event.",
    "No webhooks yet. This is not instant arrival tracking.",
    `Next step: ${state.nextBestStep}`
  ].filter((line) => line !== undefined).join("\n");
}

function formatGmailRecommendations(recommendations: Array<{ label: string; reason: string; example: string }>): string {
  if (recommendations.length === 0) {
    return "Recommended: nothing obvious missing from your active Gmail rules.";
  }

  return [
    "Recommended:",
    ...recommendations.map((recommendation) => `- ${recommendation.label}: ${recommendation.reason} ${recommendation.example}`)
  ].join("\n");
}

function formatGmailCustomRuleGuidance(): string {
  return [
    "Custom Gmail tracking is review-first.",
    "",
    "Give me a sender, company, project, or 2-3 keywords.",
    "Examples:",
    '- "track Endesa bills from Gmail"',
    '- "track emails from client@example.com for dashboard project"',
    '- "watch emails mentioning invoice and Endesa"',
    "",
    "Matches go to email review only. Auto-log is off."
  ].join("\n");
}

type GmailAutonomyPreferenceRequest =
  | { kind: "manual_only" }
  | { kind: "scheduled"; intervalMinutes: number }
  | { kind: "review_notifications"; enabled: boolean }
  | { kind: "daily_digest"; enabled: boolean; unsupported: true }
  | { kind: "work_hours"; unsupported: true };

async function handleGmailAutonomyPreferenceForConversation(
  userId: string,
  message: string,
  _route?: SemanticRouterResult
): Promise<string> {
  const preference = parseGmailAutonomyPreference(message);

  if (!preference) {
    return formatGmailSetupForConversation(userId);
  }

  if (preference.kind === "daily_digest") {
    return preference.enabled
      ? "Daily Gmail digest is not implemented yet. Today I can show reviews when you say \"email reviews\" and notify when scheduled sync creates new review items."
      : "Daily Gmail digest is not implemented yet, so there is no digest to turn off. Today I can show reviews when you say \"email reviews\".";
  }

  if (preference.kind === "work_hours") {
    return "Work-hours Gmail checking is not implemented yet. Today I can use manual sync or scheduled worker mode for active Gmail rules.";
  }

  const state = await buildGmailAutonomyState(userId);

  if (!state.gmailConnected || !state.primaryConnection) {
    return "Gmail is not connected yet. Say 'connect Gmail' or use /connect_gmail.";
  }

  const payload =
    preference.kind === "manual_only"
      ? {
          operation: "gmail_autonomy_preference",
          connectionId: state.primaryConnection.id,
          preferenceKind: "manual_only",
          syncMode: "manual_only"
        }
      : preference.kind === "scheduled"
        ? {
            operation: "gmail_autonomy_preference",
            connectionId: state.primaryConnection.id,
            preferenceKind: "scheduled",
            syncMode: "scheduled",
            syncIntervalMinutes: preference.intervalMinutes
          }
        : {
            operation: "gmail_autonomy_preference",
            connectionId: state.primaryConnection.id,
            preferenceKind: preference.enabled ? "review_notifications_on" : "review_notifications_off",
            reviewNotificationEnabled: preference.enabled
          };

  await replacePendingAction(userId, {
    type: "custom_email_rule",
    summary: gmailAutonomyPendingSummary(preference),
    payload,
    expiresAt: pendingDecisionExpiry()
  });

  return gmailAutonomyConfirmationPrompt(preference, state);
}

function isUnsupportedGmailAutonomyPreference(preference: GmailAutonomyPreferenceRequest | undefined): boolean {
  return preference?.kind === "daily_digest" || preference?.kind === "work_hours";
}

function gmailAutonomyPendingSummary(preference: GmailAutonomyPreferenceRequest): string {
  if (preference.kind === "manual_only") {
    return "Set Gmail to manual-only checks";
  }

  if (preference.kind === "scheduled") {
    return `Set Gmail scheduled checks every ${formatIntervalMinutes(preference.intervalMinutes)}`;
  }

  if (preference.kind === "review_notifications") {
    return preference.enabled ? "Turn Gmail review notifications on" : "Turn Gmail review notifications off";
  }

  return "Unsupported Gmail preference";
}

function gmailAutonomyConfirmationPrompt(
  preference: Exclude<GmailAutonomyPreferenceRequest, { unsupported: true }>,
  state: Awaited<ReturnType<typeof buildGmailAutonomyState>>
): string {
  if (preference.kind === "manual_only") {
    return [
      "I can make Gmail manual only.",
      "Alecto will check active Gmail rules only when you say \"sync Gmail\".",
      "This does not change your rules or email reviews.",
      "Confirm with \"yes\" or cancel."
    ].join("\n");
  }

  if (preference.kind === "scheduled") {
    return [
      `I can set Gmail to scheduled checks every ${formatIntervalMinutes(preference.intervalMinutes)} for active rules.`,
      "This is not instant email tracking; no webhooks yet.",
      "Custom/work uncertain matches still go to email reviews.",
      state.runtime.scheduledSyncEnabled
        ? "Review notifications use one bundled message when new reviews are waiting."
        : "Background sync is disabled in this local environment, so this saves the preference but will not run automatically until background sync is enabled.",
      "Confirm with \"yes\" or cancel."
    ].join("\n");
  }

  return [
    preference.enabled
      ? "I can turn Gmail review notifications on."
      : "I can turn Gmail review notifications off.",
    "This only affects proactive scheduled-sync review-waiting messages.",
    "Manual sync still replies in chat.",
    state.notificationDeliveryAvailable ? `Delivery: ${state.deliveryChannel}.` : "Notification delivery is not configured yet.",
    "Confirm with \"yes\" or cancel."
  ].join("\n");
}

function parseGmailAutonomyPreference(message: string): GmailAutonomyPreferenceRequest | undefined {
  const text = normalizeForComparison(message);

  if (!/\b(gmail|email|emails|mail|mails|inbox|review|reviews)\b/.test(text)) {
    return undefined;
  }

  if (/\b(digest|resumen)\b/.test(text) && /\b(gmail|email|emails|mail|mails)\b/.test(text)) {
    const enabled = !/\b(turn off|disable|stop|no|dont|don't|do not|quita|desactiva)\b/.test(text);
    return { kind: "daily_digest", enabled, unsupported: true };
  }

  if (/\b(work hours|working hours|business hours|horario laboral|laboral hours|laboral)\b/.test(text)) {
    return { kind: "work_hours", unsupported: true };
  }

  if (
    /\b(manual only|manually only|manual-only|only manually)\b/.test(text) ||
    /\b(make|set|check|keep)\b.*\b(gmail|email|mail)\b.*\bmanual\b/.test(text) ||
    /\b(gmail|email|mail)\b.*\bmanual\b.*\bonly\b/.test(text)
  ) {
    return { kind: "manual_only" };
  }

  const notificationOff =
    /\b(don t|dont|do not|stop|disable|turn off|no|quita|desactiva|deja de)\b.*\b(notify|notification|notifications|tell me|let me know|avis\w*|notifi\w*)\b/.test(text) ||
    /\b(notify|notification|notifications|tell me|let me know|avis\w*|notifi\w*)\b.*\b(off|disabled|no|not)\b/.test(text);

  if (notificationOff && /\b(gmail|email|mail|review|reviews)\b/.test(text)) {
    return { kind: "review_notifications", enabled: false };
  }

  if (/\b(will|do|does|can|could)\s+(you|u)\b.*\b(notify|notification|notifications|tell me|let me know)\b/.test(text)) {
    return undefined;
  }

  const notificationOn =
    /\b(notify me|tell me|let me know|notification|notifications|avisa|avisame|avísame)\b.*\b(gmail|email|mail|review|reviews|waiting|arrive|new)\b/.test(text) ||
    /\b(turn on|enable)\b.*\b(gmail|email|mail)\b.*\b(notification|notifications)\b/.test(text);

  if (notificationOn) {
    return { kind: "review_notifications", enabled: true };
  }

  const everyMinutes = text.match(/\bevery\s+(\d+)\s+minutes?\b|\bcada\s+(\d+)\s+minutos?\b/);
  if (everyMinutes) {
    const minutes = Number.parseInt(everyMinutes[1] ?? everyMinutes[2] ?? "", 10);
    if (Number.isFinite(minutes) && minutes > 0) {
      return { kind: "scheduled", intervalMinutes: minutes };
    }
  }

  const everyHours = text.match(/\bevery\s+(\d+)\s+hours?\b|\bcada\s+(\d+)\s+horas?\b/);
  if (everyHours) {
    const hours = Number.parseInt(everyHours[1] ?? everyHours[2] ?? "", 10);
    if (Number.isFinite(hours) && hours > 0) {
      return { kind: "scheduled", intervalMinutes: hours * 60 };
    }
  }

  if (/\b(every hour|hourly|cada hora)\b/.test(text)) {
    return { kind: "scheduled", intervalMinutes: 60 };
  }

  if (/\b(daily|once a day|once per day|every day|cada dia|cada día|una vez al dia|una vez al día)\b/.test(text)) {
    return { kind: "scheduled", intervalMinutes: 24 * 60 };
  }

  return undefined;
}

function looksLikeGmailAutonomyPreference(message: string): boolean {
  return Boolean(parseGmailAutonomyPreference(message));
}

function isPendingGmailAutonomyPreference(pendingAction: PendingAction | undefined): boolean {
  return Boolean(
    pendingAction &&
      pendingAction.status === "pending" &&
      pendingAction.type === "custom_email_rule" &&
      isRecord(pendingAction.payload) &&
      pendingAction.payload.operation === "gmail_autonomy_preference"
  );
}

function shouldReleasePendingGmailAutonomyFocus(pendingAction: PendingAction | undefined, message: string): boolean {
  if (!isPendingGmailAutonomyPreference(pendingAction)) {
    return false;
  }

  if (isConfirmationMessage(message) || isRejectionMessage(message)) {
    return false;
  }

  return true;
}

interface CustomGmailRuleProposal {
  displayName: string;
  senderFilters: string[];
  keywordFilters: string[];
  goalId?: string;
  goalTitle?: string;
  queryPreview: string;
  reviewBeforeLogging: true;
  adapterId: "custom_email_review";
  confidence: number;
  missingFields: string[];
}

function looksLikeCustomGmailTrackingRequest(message: string): boolean {
  const text = normalizeForComparison(message);
  const hasTrackVerb = /\b(track|watch|monitor|look for|follow|check)\b/.test(text);
  const hasRuleCreationVerb = /\b(create|enable|turn on|activate|set up|setup|add|make)\b/.test(text) && /\brules?\b/.test(text);

  if (!hasTrackVerb && !hasRuleCreationVerb) {
    return false;
  }

  if (/\b(sync|connect|status|what can|how does)\b/.test(text) || (!hasRuleCreationVerb && /\b(setup|set up)\b/.test(text))) {
    return false;
  }

  return (
    /\b(gmail|email|emails|mail|inbox)\b/.test(text) ||
    /\b(receipt|receipts|bill|bills|invoice|invoices|factura|facturas|payment|payments)\b/.test(text) ||
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(message)
  );
}

function looksLikeGmailRuleQuestion(message: string): boolean {
  const text = normalizeForComparison(message);

  if (looksLikeCustomGmailTrackingRequest(message)) {
    return false;
  }

  if (!/\b(gmail|email|emails|mail|inbox|rule|tracking|endesa|job search|work action)\b/.test(text)) {
    return false;
  }

  return (
    /\b(where|what|how|when|will|would|does|do|can|could|should|linked|link|goal|actions?|events?|reviews?|saved|auto log|scan|sync)\b/.test(text) &&
    /\?|\b(where|what|how|when|will|would|does|do|can|could|should)\b/.test(text)
  );
}

async function proposeCustomGmailRuleForConversation(
  userId: string,
  message: string,
  route?: SemanticRouterResult
): Promise<string> {
  const gmailConnection = (await getIntegrationConnections(userId)).find(
    (connection) => connection.integrationId === "gmail" && connection.status === "active"
  );

  if (!gmailConnection) {
    return "Gmail is not connected yet. Say 'connect Gmail' or use /connect_gmail.";
  }

  const goals = await getActiveGoals(userId);
  const proposal = buildCustomGmailRuleProposal(message, goals, route);

  if (proposal.missingFields.length > 0 || proposal.confidence < 0.65) {
    return "That is too broad. Give me a sender, company, project, or 2-3 keywords.";
  }

  await replacePendingAction(userId, {
    type: "custom_email_rule",
    summary: `Enable Gmail tracking: ${proposal.displayName}`,
    payload: {
      operation: "create_rule",
      connectionId: gmailConnection.id,
      ...proposal
    },
    expiresAt: pendingDecisionExpiry()
  });

  return formatCustomGmailRuleProposal(proposal);
}

function buildCustomGmailRuleProposal(message: string, goals: Goal[], route?: SemanticRouterResult): CustomGmailRuleProposal {
  const senderFilters = uniqueStrings((message.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []).map((item) => item.toLowerCase()));
  const routeSenderFilters = route?.senderFilters.map((sender) => sender.toLowerCase()).filter(Boolean) ?? [];
  const routeKeywordFilters = route?.keywordFilters.map(cleanCustomKeyword).filter(isUsefulCustomKeywordCandidate) ?? [];
  const finalSenderFilters = uniqueStrings([...senderFilters, ...routeSenderFilters]);
  const keywordFilters = routeKeywordFilters.length > 0 ? routeKeywordFilters : extractCustomGmailKeywords(message, finalSenderFilters);
  const goal = inferCustomGmailGoal(route?.goalHint ?? message, goals);
  const usefulKeywords = keywordFilters.filter((keyword) => !isBroadCustomEmailKeyword(keyword));
  const missingFields = finalSenderFilters.length === 0 && usefulKeywords.length < 1 ? ["sender_or_keywords"] : [];
  const displayName = buildCustomGmailRuleDisplayName(message, finalSenderFilters, keywordFilters);
  const queryPreview = buildCustomGmailQuery(finalSenderFilters, keywordFilters);

  return {
    displayName,
    senderFilters: finalSenderFilters,
    keywordFilters,
    goalId: goal?.id,
    goalTitle: goal?.title,
    queryPreview,
    reviewBeforeLogging: true,
    adapterId: "custom_email_review",
    confidence: missingFields.length === 0 ? finalSenderFilters.length > 0 || usefulKeywords.length >= 2 ? 0.85 : 0.7 : 0.35,
    missingFields
  };
}

function extractCustomGmailKeywords(message: string, senderFilters: string[]): string[] {
  const keywords: string[] = [];
  const text = normalizeForComparison(message);

  if (/\binvoices?\b/.test(text)) {
    keywords.push("invoice", "factura");
  }
  if (/\bbills?\b/.test(text)) {
    keywords.push("bill", "invoice", "factura");
  }
  if (/\breceipts?\b/.test(text)) {
    keywords.push("receipt");
  }
  if (/\bpayments?\b/.test(text)) {
    keywords.push("payment", "receipt");
  }
  if (/\bfacturas?\b/.test(text)) {
    keywords.push("factura", "invoice");
  }

  const fromPhrase = message.match(/\bfrom\s+([A-Z][A-Za-z0-9._ -]{1,40})(?:\s+(?:about|for|with|in|on)\b|$)/);
  if (fromPhrase && senderFilters.length === 0) {
    keywords.push(cleanCustomKeyword(fromPhrase[1]));
  }

  const aboutPhrase = message.match(/\b(?:about|for|mentioning|mentions?)\s+([A-Za-z0-9._@ -]{2,80})/i);
  if (aboutPhrase) {
    for (const part of aboutPhrase[1].split(/\s+(?:and|or)\s+|[,/]/i)) {
      const keyword = cleanCustomKeyword(part);
      if (keyword) {
        keywords.push(keyword);
      }
    }
  }

  for (const proper of message.match(/\b[A-Z][a-zA-Z0-9]{2,}\b/g) ?? []) {
    if (!/^(Gmail|Email|Mail|Inbox|Track|Watch|Monitor|I|Can|You)$/i.test(proper)) {
      keywords.push(proper);
    }
  }

  return uniqueStrings(keywords.map(cleanCustomKeyword).filter(isUsefulCustomKeywordCandidate)).slice(0, 8);
}

function cleanCustomKeyword(value: string): string {
  const cleaned = value
    .replace(/[<>"'`]/g, "")
    .replace(
      /\b(gmail|email|emails|correo|correos|mail|mails|inbox|rule|rules|regla|reglas|tracking|track|watch|monitor|please|the|my|from|about|for|project|goal|word|words|only|just|solo|solamente|nomes|nom[eé]s|unic|unica|[uú]nicament|busca|buscar|busque|busqui|mira|mirar|filtra|filtrar|palabra|palabras|paraula|paraules|clave|clau)\b/gi,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();

  return normalizeCustomKeywordSpelling(cleaned);
}

function normalizeCustomKeywordSpelling(value: string): string {
  return value
    .replace(/\bbarceloa\b/gi, "Barcelona")
    .replace(/\baigues\s+(?:the\s+)?barcelona\b/gi, "Aigues de Barcelona")
    .replace(/\baigues\s+de\s+barcelona\b/gi, "Aigues de Barcelona");
}

function isUsefulCustomKeywordCandidate(keyword: string): boolean {
  const clean = keyword.trim();
  const key = normalizeForComparison(clean);

  if (!clean || isBroadCustomEmailKeyword(clean)) {
    return false;
  }

  if (clean.length > 40) {
    return false;
  }

  if (
    /\b(can you|could you|would you|link|linked|goal|spending|less than|under|always|saved|action|actions|review|auto|log|notify|let me know)\b/i.test(clean)
  ) {
    return false;
  }

  return key.length >= 3;
}

function isBroadCustomEmailKeyword(keyword: string): boolean {
  return /^(gmail|email|emails|mail|inbox|message|messages|update|updates|all|every|anything|everything)$/i.test(keyword.trim());
}

function inferCustomGmailGoal(message: string, goals: Goal[]): Goal | undefined {
  const text = normalizeForComparison(message);
  const active = goals.filter((goal) => goal.status === "active" && !isRiskControlGoal(goal));
  const energyOrUtilityHint = /\b(energy|utility|utilities|consumption|energia|energía|consumo|consum|electric|electricity|electricidad|llum|luz|agua|aigua|water|gas|endesa|aigues|aigües|bill|bills|invoice|factura|facturas|receipt)\b/.test(text);

  if (/\bfinance goal\b|\breceipt|\bbill|\binvoice|\bfactura|\bpayment/.test(text)) {
    const finance = active.find((goal) => /finance|receipt|bill|invoice|factura|payment|money/.test(normalizeForComparison(`${goal.title} ${goal.category} ${goal.templateId ?? ""}`)));
    if (finance) {
      return finance;
    }
  }

  if (energyOrUtilityHint) {
    const utilityGoal = active.find((goal) => {
      const goalText = normalizeForComparison(`${goal.title} ${goal.category} ${goal.templateId ?? ""}`);
      const looksLikeUtilityGoal = /\b(utility|utilities|consumption|consume|consumo|consum|electric|electricity|electricidad|llum|luz|agua|aigua|water|gas|endesa|aigues|aigües|bills?|invoice|factura|expenses?|spending|costs?)\b/.test(goalText);
      const looksLikeEnergyConsumptionGoal = /\benergy|energia|energía\b/.test(goalText) && /\b(consumption|consume|consumo|consum|bill|bills|invoice|factura|expense|spending|cost)\b/.test(goalText);

      return looksLikeUtilityGoal || looksLikeEnergyConsumptionGoal;
    });

    if (utilityGoal) {
      return utilityGoal;
    }

    return undefined;
  }

  const matches = active.filter((goal) => {
    const goalText = normalizeForComparison(goal.title);
    const goalTokens = meaningfulCustomGmailGoalTokens(goalText);
    return goalText.length > 3 && (text.includes(goalText) || goalTokens.some((token) => text.includes(token)));
  });

  return matches.length === 1 ? matches[0] : undefined;
}

function meaningfulCustomGmailGoalTokens(value: string): string[] {
  return value
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(
      (token) =>
        token.length >= 4 &&
        !/^(track|watch|monitor|find|build|make|create|goal|goals|more|better|improve|control|gmail|email|emails|rule|rules)$/.test(token)
    );
}

function buildCustomGmailRuleDisplayName(message: string, senderFilters: string[], keywordFilters: string[]): string {
  const lower = normalizeForComparison(message);
  const primary = keywordFilters.find((keyword) => !/^(invoice|factura|bill|receipt|payment)$/i.test(keyword));
  const noun = lower.includes("receipt")
    ? "receipts"
    : lower.includes("bill") || lower.includes("factura")
      ? "bills"
      : lower.includes("invoice")
        ? "invoices"
        : "emails";

  if (primary) {
    return sentenceLikeTitle(`${primary} ${noun}`);
  }

  if (senderFilters[0]) {
    return sentenceLikeTitle(`${senderFilters[0]} ${noun}`);
  }

  return "Custom Gmail tracking";
}

function buildCustomGmailQuery(senderFilters: string[], keywordFilters: string[]): string {
  const parts = ["newer_than:30d"];
  parts.push(...senderFilters.map((sender) => `from:${sender}`));
  parts.push(...keywordFilters.filter((keyword) => !isBroadCustomEmailKeyword(keyword)).map(formatGmailQueryTerm));
  return parts.join(" ");
}

function formatGmailQueryTerm(term: string): string {
  const clean = term.trim();
  return /\s/.test(clean) ? `"${clean.replace(/"/g, "")}"` : clean;
}

function formatCustomGmailRuleProposal(proposal: CustomGmailRuleProposal): string {
  return [
    "I can set up a review-first Gmail rule.",
    "",
    "Rule:",
    `- name: ${proposal.displayName}`,
    `- looks for: ${proposal.keywordFilters.length > 0 ? proposal.keywordFilters.join(", ") : "emails from the sender"}`,
    `- sender: ${proposal.senderFilters.length > 0 ? proposal.senderFilters.join(", ") : "any"}`,
    proposal.goalTitle ? `- linked goal: ${proposal.goalTitle}` : undefined,
    "- creates: email review items only",
    "- auto-log: off",
    "",
    "Confirm with \"yes\" to enable it, or say \"no\" to cancel.",
    "No Gmail scan will happen before you confirm."
  ].filter(Boolean).join("\n");
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

function looksLikeContextualDeleteAllEmailRules(message: string): boolean {
  const text = normalizeForComparison(message);

  if (!/\b(delete|remove|clear|archive|reset|elimina|eliminar|borra|borrar)\b/.test(text)) {
    return false;
  }

  return (
    /\b(all|everything|every|all of them|all of em|em|them|todos|todas|totes)\b/.test(text) ||
    /\breset\b/.test(text)
  );
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

function safeErrorForLog(error: unknown): string {
  if (error && typeof error === "object" && "message" in error && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message.slice(0, 240);
  }

  return "Unknown error";
}

function isPendingCustomGmailRuleCreate(pendingAction: PendingAction | undefined): boolean {
  return Boolean(
    pendingAction &&
      pendingAction.status === "pending" &&
      pendingAction.type === "custom_email_rule" &&
      isRecord(pendingAction.payload) &&
      pendingAction.payload.operation === "create_rule"
  );
}

function isPendingCustomGmailRuleContext(pendingAction: PendingAction | undefined): boolean {
  return Boolean(
    pendingAction &&
      pendingAction.status === "pending" &&
      pendingAction.type === "custom_email_rule" &&
      isRecord(pendingAction.payload) &&
      pendingAction.payload.operation === "rule_context"
  );
}

function extractPendingCustomRuleReplacementKeywords(message: string): string[] {
  const replacements: string[] = [];
  const match = message.match(
    /\b(?:look(?:s)?\s+for|looking\s+for|keywords?|filters?|search(?:es)?\s+for|busca(?:r|ndo)?|busque|busqui|mirar|mira|filtra(?:r)?|palabras?\s+clave|paraules?\s+clau)\s+(?:just|only|solo|solamente|nom[eé]s|unic(?:o|a)?|[uú]nicament)?\s*([\p{L}0-9._@ ,/-]{2,160})/iu
  );

  if (match) {
    replacements.push(...splitCustomKeywordPhrase(extractCustomKeywordClause(match[1])));
  }

  const justMatch = message.match(/\b(?:just|only|solo|solamente|nom[eé]s|[uú]nicament)\s+([\p{L}][\p{L}0-9._ -]{2,60})\b/iu);
  if (replacements.length === 0 && justMatch) {
    replacements.push(cleanCustomKeyword(justMatch[1]));
  }

  return uniqueStrings(replacements.map(cleanCustomKeyword).filter(isUsefulCustomKeywordCandidate));
}

function extractPendingCustomRuleRemovedKeywords(message: string): string[] {
  const match = message.match(
    /\b(?:remove|drop|delete|quita(?:r)?|elimina(?:r)?|treu(?:re)?|saca(?:r)?)\s+(.+?)\s+(?:from|in|de|del|dels?|en)\s+(?:the\s+|la\s+|el\s+)?(?:rule|filter|keywords?|looks? for|regla|filtro|filtros|paraules?\s+clau|palabras?\s+clave)\b/iu
  );

  if (match) {
    return uniqueStrings(splitCustomKeywordPhrase(match[1]).map(cleanCustomKeyword).filter(isUsefulCustomKeywordCandidate));
  }

  const contrastMatch = message.match(/\b(?:instead of|rather than|en vez de|en lugar de|en lloc de|no|not|sin|sense)\s+([\p{L}0-9._@ -]{2,80})$/iu);
  return contrastMatch
    ? uniqueStrings(splitCustomKeywordPhrase(contrastMatch[1]).map(cleanCustomKeyword).filter(isUsefulCustomKeywordCandidate))
    : [];
}

function splitCustomKeywordPhrase(value: string): string[] {
  return value
    .replace(/\b(?:from|for|in|on|de|del|dels?|para|per|por|amb|con|please|thanks|gmail|email|correo|correos|mail|rule|regla|filter|filtro|keyword|keywords|palabra|palabras|paraula|paraules)\b.*$/iu, "")
    .split(/\s+(?:and|or|y|o|i)\s+|[,/]/iu)
    .map(cleanCustomKeyword)
    .filter(isUsefulCustomKeywordCandidate);
}

function extractCustomKeywordClause(value: string): string {
  const firstClause = value.split(/[.;?]/)[0] ?? value;
  return firstClause
    .replace(/\s+\b(?:instead of|rather than|en vez de|en lugar de|en lloc de)\b\s+.+$/iu, "")
    .replace(/\s+\b(?:not|no|sin|sense)\b\s+[\p{L}0-9._@ -]{2,80}$/iu, "")
    .replace(/,\s*(?:and|but|y|pero|i|per[oò])\s+.*$/iu, "")
    .replace(/\s+\b(?:and|but|y|pero|i|per[oò])\b\s+(?:can|could|would|should|do|does|will|where|what|how|link|linked|save|create|puede|puedes|podria|podrias|debe|deberia|donde|que|como|cuando|enlaza|vincula|guarda|crea)\b.*$/iu, "")
    .replace(/\s+\b(?:treu|quita|remove|drop|delete)\b\s+.+$/iu, "")
    .trim();
}

function extractPendingCustomRuleGoalCorrection(message: string): { goalHint?: string; shouldUnlinkGoal: boolean } | undefined {
  const text = normalizeForComparison(message);

  if (!/\b(goal|linked goal|link|objetivo|meta|vincula|enlaza|lliga|relaciona)\b/.test(text) && !/\b(for energy consumption|consumo de energia|consumo de energía|consum d energia|factura luz|factures llum)\b/.test(text)) {
    return undefined;
  }

  const shouldUnlinkGoal = /\b(wrong goal|not linked|do not link|don't link|remove linked goal|unlink|no goal|is not|isnt|isn't|objetivo equivocado|meta equivocada|no lo enlaces|no l enlaces|no ho vinculis|quita el objetivo|treu l objectiu|no es apuestas|no son apuestas|no es apostes|not betting|not trading)\b/.test(text);
  const goalHintMatch = message.match(/\bgoal\s+(?:to|for|about)\s+([A-Za-z][A-Za-z0-9 -]{2,80})/i) ??
    message.match(/\blink(?:ed)?\s+(?:it|this|rule)?\s*(?:to|with)\s+([A-Za-z][A-Za-z0-9 -]{2,80})/i) ??
    message.match(/\b(?:objetivo|meta)\s+(?:de|para|sobre)\s+([\p{L}][\p{L}0-9 -]{2,80})/iu) ??
    message.match(/\b(?:vincula|enlaza|lliga|relaciona)\s+(?:lo|la|esto|aixo|aix[oò]|it|this|rule)?\s*(?:a|con|amb|to|with)\s+([\p{L}][\p{L}0-9 -]{2,80})/iu) ??
    message.match(/\b(?:for|to|para|per|por)\s+([\p{L}][\p{L}0-9 -]{2,80})$/iu) ??
    message.match(/\b(?:it'?s|its|this is|esto es|aixo es|aix[oò] [eé]s)\s+(?:for|about|para|sobre|per)\s+([\p{L}][\p{L}0-9 -]{2,80})/iu);
  const goalHint = goalHintMatch ? cleanCustomKeyword(goalHintMatch[1]) : undefined;

  if (!goalHint && !shouldUnlinkGoal) {
    return undefined;
  }

  return {
    goalHint,
    shouldUnlinkGoal
  };
}

async function editPendingCustomGmailRule(
  userId: string,
  pendingAction: PendingAction | undefined,
  route: SemanticRouterResult
): Promise<string> {
  if (!isPendingCustomGmailRuleCreate(pendingAction) || !pendingAction || !isRecord(pendingAction.payload)) {
    return "There is no pending Gmail rule to edit. Say something like: track Endesa bills from Gmail.";
  }

  const currentKeywordFilters = arrayOfStrings(pendingAction.payload.keywordFilters).map(cleanCustomKeyword).filter(Boolean);
  const currentSenderFilters = arrayOfStrings(pendingAction.payload.senderFilters).map((sender) => sender.toLowerCase());
  const replacementKeywords = route.keywordFilters.map(cleanCustomKeyword).filter(isUsefulCustomKeywordCandidate);
  const removeKeywords = route.removeKeywordFilters.map((keyword) => normalizeForComparison(cleanCustomKeyword(keyword)));
  const keywordFilters = replacementKeywords.length > 0
    ? replacementKeywords
    : currentKeywordFilters.filter((keyword) => !removeKeywords.includes(normalizeForComparison(keyword)));
  const senderFilters = route.senderFilters.length > 0
    ? route.senderFilters.map((sender) => sender.toLowerCase())
    : currentSenderFilters;

  if (senderFilters.length === 0 && keywordFilters.filter((keyword) => !isBroadCustomEmailKeyword(keyword)).length === 0) {
    return "That would make the Gmail rule too broad. Give me a sender, company, project, or keyword.";
  }

  const goals = await getActiveGoals(userId);
  const requestedGoalHint = route.goalHint?.trim() || undefined;
  const goal = requestedGoalHint ? inferCustomGmailGoal(requestedGoalHint, goals) : undefined;
  const shouldDropRiskGoal = typeof pendingAction.payload.goalTitle === "string" && /betting|trading|impulsive|risk/i.test(pendingAction.payload.goalTitle);
  const goalId = goal?.id ?? (route.shouldUnlinkGoal || shouldDropRiskGoal ? undefined : stringFromRecord(pendingAction.payload, "goalId"));
  const goalTitle = goal?.title ?? (route.shouldUnlinkGoal || shouldDropRiskGoal ? undefined : stringFromRecord(pendingAction.payload, "goalTitle"));
  const displayName = replacementKeywords.length > 0 || shouldDropRiskGoal
    ? buildCustomGmailRuleDisplayName(keywordFilters.join(" "), senderFilters, keywordFilters)
    : stringFromRecord(pendingAction.payload, "displayName") ?? buildCustomGmailRuleDisplayName(keywordFilters.join(" "), senderFilters, keywordFilters);
  const queryPreview = buildCustomGmailQuery(senderFilters, keywordFilters);
  const updatedProposal: CustomGmailRuleProposal = {
    displayName,
    senderFilters,
    keywordFilters,
    goalId,
    goalTitle,
    queryPreview,
    reviewBeforeLogging: true,
    adapterId: "custom_email_review",
    confidence: 0.9,
    missingFields: []
  };

  await replacePendingAction(userId, {
    type: "custom_email_rule",
    summary: `Enable Gmail tracking: ${updatedProposal.displayName}`,
    payload: {
      ...pendingAction.payload,
      operation: "create_rule",
      ...updatedProposal
    },
    expiresAt: pendingDecisionExpiry()
  });

  return [
    "Updated the pending Gmail rule.",
    requestedGoalHint && !goal
      ? `I did not link a goal because I could not find an active goal matching "${requestedGoalHint}".`
      : undefined,
    shouldDropRiskGoal && !goal
      ? "I removed the previous risk-control goal link. This rule is not a betting/trading guardrail."
      : undefined,
    "",
    formatCustomGmailRuleProposal(updatedProposal)
  ].filter((line) => line !== undefined).join("\n");
}

async function editActiveCustomGmailRuleForConversation(
  userId: string,
  message: string,
  route: SemanticRouterResult,
  pendingAction?: PendingAction
): Promise<string> {
  const rules = (await getEmailSignalRules(userId)).filter(
    (rule) => rule.adapterId === "custom_email_review" && rule.status !== "archived"
  );
  const matches = resolveCustomGmailRulesForConversation(rules, message, route, pendingAction);

  if (matches.length === 0) {
    return "I could not find a matching custom Gmail rule. Say the rule name, like: change Endesa emails to only look for Aigues de Barcelona.";
  }

  if (matches.length > 1) {
    return [
      "Which custom Gmail rule do you mean?",
      ...matches.slice(0, 5).map((rule, index) => `${index + 1}. ${rule.name}`),
      "Reply with the rule name."
    ].join("\n");
  }

  const rule = matches[0];
  const currentFilters = parseCustomGmailRuleFilters(rule);
  const replacementKeywords = route.keywordFilters.map(cleanCustomKeyword).filter(isUsefulCustomKeywordCandidate);
  const removeKeywords = route.removeKeywordFilters.map((keyword) => normalizeForComparison(cleanCustomKeyword(keyword)));
  const senderFilters = route.senderFilters.length > 0
    ? uniqueStrings(route.senderFilters.map((sender) => sender.toLowerCase()).filter(Boolean))
    : currentFilters.senderFilters;
  const shouldReplaceKeywords = shouldReplaceCustomRuleKeywords(message, route);
  const keywordFilters = shouldReplaceKeywords && replacementKeywords.length > 0
    ? replacementKeywords
    : uniqueStrings([
        ...currentFilters.keywordFilters.filter((keyword) => !removeKeywords.includes(normalizeForComparison(keyword))),
        ...replacementKeywords
      ]);

  const queryChanged =
    replacementKeywords.length > 0 ||
    removeKeywords.length > 0 ||
    route.senderFilters.length > 0;

  if (!queryChanged && !route.goalHint && !route.shouldUnlinkGoal) {
    return "Tell me what to change on that Gmail rule. Example: make Endesa emails look only for Aigues de Barcelona.";
  }

  if (queryChanged && senderFilters.length === 0 && keywordFilters.filter((keyword) => !isBroadCustomEmailKeyword(keyword)).length === 0) {
    return "That would make the Gmail rule too broad. Give me a sender, company, project, or keyword.";
  }

  const goals = await getActiveGoals(userId);
  const requestedGoalHint = route.goalHint?.trim() || undefined;
  const goal = requestedGoalHint ? inferCustomGmailGoal(requestedGoalHint, goals) : undefined;
  const goalPatch = route.shouldUnlinkGoal
    ? null
    : goal
      ? goal.id
      : undefined;
  const query = queryChanged ? buildCustomGmailQuery(senderFilters, keywordFilters) : rule.query;
  const name = queryChanged ? buildCustomGmailRuleDisplayName(keywordFilters.join(" "), senderFilters, keywordFilters) : rule.name;

  const updated = await updateEmailSignalRuleDefinition(userId, rule.id, {
    name,
    query,
    goalId: goalPatch
  });

  if (!updated) {
    return "I could not update that Gmail rule.";
  }

  await maybeRememberGmailRuleConversationContext(userId, [updated], updated);

  const goalById = new Map((await getGoals(userId)).map((item) => [item.id, item.title]));
  const linkedGoalTitle = updated.goalId ? goalById.get(updated.goalId) : undefined;
  const warnings = [
    requestedGoalHint && !goal ? `I did not link a goal because I could not find an active goal matching "${requestedGoalHint}".` : undefined
  ].filter(Boolean);

  return [
    `Updated Gmail rule: ${updated.name}`,
    `Looks for: ${formatEmailRuleQueryForHumans(updated.query)}`,
    `Linked goal: ${linkedGoalTitle ?? "none"}`,
    "Matches still go to email review first. Auto-log is off.",
    ...warnings
  ].join("\n");
}

function parseCustomGmailRuleFilters(rule: EmailSignalRule): { senderFilters: string[]; keywordFilters: string[] } {
  const query = rule.query ?? "";
  const senderFilters = uniqueStrings(
    [...query.matchAll(/\bfrom:("[^"]+"|\S+)/gi)]
      .map((match) => match[1]?.replace(/^"|"$/g, "").toLowerCase() ?? "")
      .filter(Boolean)
  );
  const withoutControlTerms = query
    .replace(/\bnewer_than:\d+d\b/gi, " ")
    .replace(/\bfrom:("[^"]+"|\S+)/gi, " ");
  const quotedTerms = [...withoutControlTerms.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "");
  const unquoted = withoutControlTerms.replace(/"[^"]+"/g, " ").split(/\s+/);
  const keywordFilters = uniqueStrings(
    [...quotedTerms, ...unquoted]
      .map(cleanCustomKeyword)
      .filter(isUsefulCustomKeywordCandidate)
  );

  return { senderFilters, keywordFilters };
}

function shouldReplaceCustomRuleKeywords(message: string, route: SemanticRouterResult): boolean {
  const text = normalizeForComparison(message);
  return (
    route.removeKeywordFilters.length > 0 ||
    /\b(only|just|solo|solamente|nomes|només|unic|únicament|instead of|rather than|en vez de|en lugar de|en lloc de|replace|change to|cambia(?:r)? a|canvia(?:r)? a|use)\b/.test(text)
  );
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

async function answerGmailRuleQuestionForConversation(
  userId: string,
  message: string,
  pendingAction?: PendingAction,
  route?: SemanticRouterResult
): Promise<string> {
  if (route?.operation === "timing" || looksLikeGmailNotificationTimingQuestion(message)) {
    return formatGmailNotificationTimingForConversation(userId, message, pendingAction, route);
  }

  if (isPendingCustomGmailRuleCreate(pendingAction) && pendingAction && isRecord(pendingAction.payload)) {
    const goalTitle = stringFromRecord(pendingAction.payload, "goalTitle");
    const keywordFilters = arrayOfStrings(pendingAction.payload.keywordFilters);
    const senderFilters = arrayOfStrings(pendingAction.payload.senderFilters);
    const displayName = stringFromRecord(pendingAction.payload, "displayName") ?? "Custom Gmail tracking";

    return [
      `${displayName} is still pending. It is not scanning Gmail yet.`,
      `Looks for: ${keywordFilters.length > 0 ? keywordFilters.join(", ") : "emails from the sender"}`,
      `Sender: ${senderFilters.length > 0 ? senderFilters.join(", ") : "any"}`,
      `Linked goal: ${goalTitle ?? "none"}`,
      "Where matches go: email review only. It will not create actions or events automatically.",
      "Confirm with yes, cancel with no, or edit it in plain language."
    ].join("\n");
  }

  const rules = (await getEmailSignalRules(userId)).filter((rule) => rule.status !== "archived");
  const target = route?.target ?? extractGmailRuleQuestionTarget(message);
  const matches = target
    ? findEmailRulesByTarget(rules, target)
    : rules.length === 1
      ? rules
      : [];

  if (matches.length === 0) {
    if (isCustomGmailRuleQuestionTarget(target)) {
      return formatMissingCustomGmailRuleQuestion(target);
    }

    if (rules.length === 0) {
      return "No Gmail rules are active yet. Say what to track, for example: track Endesa bills from Gmail.";
    }

    return "I could not identify which Gmail rule you mean. Say the rule name, like: what happens with Endesa emails?";
  }

  if (matches.length > 1) {
    await maybeRememberGmailRuleConversationContext(userId, matches);
    return [
      "Which Gmail rule do you mean?",
      ...matches.slice(0, 5).map((rule, index) => `${index + 1}. ${rule.name}`),
      "Ask again with the rule name."
    ].join("\n");
  }

  const rule = matches[0];
  const [goals, state] = await Promise.all([getGoals(userId), buildGmailAutonomyState(userId)]);
  const goal = rule.goalId ? goals.find((item) => item.id === rule.goalId) : undefined;
  await maybeRememberGmailRuleConversationContext(userId, [rule], rule);

  if (rule.status !== "active" && rule.adapterId === "custom_email_review") {
    return [
      `${customGmailRuleSubject(rule.name)} tracking is ${rule.status}.`,
      "When active, custom Gmail matches go to email reviews first and do not auto-log.",
      `Say "resume ${customGmailRuleSubject(rule.name)} emails" to turn it back on.`
    ].join("\n");
  }

  return [
    `Gmail rule: ${rule.name}`,
    `Status: ${rule.status}`,
    `Looks for: ${formatEmailRuleQueryForHumans(rule.query)}`,
    `Linked goal: ${goal?.title ?? "none"}`,
    "Where matches go: email review first.",
    gmailRuleOutcomeExplanation(rule),
    gmailSyncModeSentence(state),
    gmailAutomaticSyncDetail(state)
  ].join("\n");
}

function isCustomGmailRuleQuestionTarget(target: string | undefined): target is string {
  if (!target) {
    return false;
  }

  const cleanTarget = normalizeForComparison(cleanEmailRuleTarget(target));
  return Boolean(cleanTarget) && cleanTarget !== "work action" && cleanTarget !== "job search" && target !== "work_action_email" && target !== "job_search_email";
}

function customGmailRuleSubject(value: string): string {
  return cleanEmailRuleTarget(value) || value.trim() || "That";
}

function formatMissingCustomGmailRuleQuestion(target: string): string {
  const subject = customGmailRuleSubject(target);

  return [
    `I don't see an active ${subject} Gmail rule right now.`,
    "Custom Gmail tracking goes to email reviews first and does not auto-log.",
    `Say "track ${subject} bills from Gmail" if you want to set it up.`
  ].join("\n");
}

function gmailRuleOutcomeExplanation(rule: EmailSignalRule): string {
  if (rule.adapterId === "custom_email_review") {
    return "Custom rules never auto-log or create actions. You can turn a review into an action after you inspect it.";
  }

  if (rule.adapterId === "work_action_email") {
    return "Work-action emails do not become tasks automatically. They wait in email review; approval can create an ActionItem.";
  }

  if (rule.adapterId === "job_search_email") {
    return rule.reviewBeforeLogging
      ? "Job-search matches wait for your approval before becoming career events."
      : "Clear job-search matches can become career events. Uncertain matches go to review.";
  }

  return rule.reviewBeforeLogging ? "Matches wait for your approval before becoming events or actions." : "Clear matches can be logged automatically; uncertain matches go to review.";
}

async function formatGmailNotificationTimingForConversation(
  userId: string,
  message: string,
  pendingAction?: PendingAction,
  route?: SemanticRouterResult
): Promise<string> {
  const state = await buildGmailAutonomyState(userId);

  if (isPendingCustomGmailRuleCreate(pendingAction) && pendingAction && isRecord(pendingAction.payload)) {
    const displayName = stringFromRecord(pendingAction.payload, "displayName") ?? "Custom Gmail tracking";

    return [
      `${displayName} is still pending, so it is not scanning Gmail yet.`,
      `After you confirm, ${gmailSyncModeSentence(state)}`,
      gmailAutomaticSyncDetail(state),
      "This is not instant arrival tracking yet. Gmail webhooks are not implemented.",
      "Matches go to email review first; they do not become actions or events automatically.",
      "Alecto cannot send emails or change labels."
    ].join("\n");
  }

  if (!state.gmailConnected) {
    return "Gmail is not connected yet. Say 'connect Gmail' or use /connect_gmail.";
  }

  const visibleRules = state.visibleRules;
  const rules = state.activeRules;
  const target = route?.target ?? extractGmailRuleQuestionTarget(message);
  const customMatches = resolveCustomGmailRulesForConversation(
    visibleRules.filter((rule) => rule.adapterId === "custom_email_review"),
    message,
    route,
    pendingAction
  );
  const targetMatches = target ? findEmailRulesByTarget(visibleRules, target) : [];
  const hasSpecificRuleMatch = targetMatches.length > 0 || customMatches.length > 0;

  if (!hasSpecificRuleMatch && isCustomGmailRuleQuestionTarget(target)) {
    return formatMissingCustomGmailRuleQuestion(target);
  }

  const matches = targetMatches.length > 0
    ? targetMatches
    : customMatches.length > 0
      ? customMatches
      : rules.length > 0
        ? rules
      : visibleRules;

  if (visibleRules.length === 0) {
    return [
      noActiveGmailRulesMessage(),
      `${gmailSyncModeSentence(state)}, but no active rule means no Gmail scanning.`,
      gmailAutomaticSyncDetail(state),
      "This is not instant arrival tracking yet. Gmail webhooks are not implemented.",
      "Alecto cannot send emails or change labels."
    ].join("\n");
  }

  const ruleLine =
    hasSpecificRuleMatch && matches.length === 1
      ? `For ${matches[0].name}${matches[0].status !== "active" ? ` (${matches[0].status})` : ""}:`
      : hasSpecificRuleMatch && matches.length > 1
        ? `For matching rules: ${matches.slice(0, 3).map((rule) => rule.name).join(", ")}.`
        : "For active Gmail rules:";

  await maybeRememberGmailRuleConversationContext(userId, matches.length > 0 ? matches : rules, matches.length === 1 ? matches[0] : undefined);

  return [
    ruleLine,
    matches.length === 1 && matches[0].status !== "active"
      ? "That rule is not active right now, so it will not check Gmail until you resume it."
      : gmailSyncModeSentence(state),
    gmailAutomaticSyncDetail(state),
    ...formatGmailBackgroundScheduleLines(state),
    "This is not instant arrival tracking yet. Gmail webhooks are not implemented.",
    "Only active Gmail rules are checked. Custom/work uncertain matches go to email review.",
    "Alecto cannot send emails or change labels.",
    state.reviewNotificationEnabled
      ? "Review notifications are on for scheduled sync."
      : "Review notifications are off. Manual sync still replies in chat.",
    pendingEmailReviewLine(state.pendingEmailReviewCount)
  ].filter(Boolean).join("\n");
}

function gmailAutomaticSyncDetail(state: Awaited<ReturnType<typeof buildGmailAutonomyState>>): string {
  if (state.syncMode === "scheduled" && state.scheduledSyncEnabled) {
    return `Automatic sync is on for active Gmail rules, about every ${formatIntervalMinutes(state.syncIntervalMinutes)}.`;
  }

  if (state.syncMode === "scheduled") {
    return "Automatic sync preference is saved, but background sync is disabled in this local environment.";
  }

  return "Automatic sync is off.";
}

function formatGmailBackgroundScheduleLines(state: Awaited<ReturnType<typeof buildGmailAutonomyState>>): string[] {
  if (state.syncMode !== "scheduled" || !state.scheduledSyncEnabled) {
    return [];
  }

  return [
    state.lastBackgroundSyncAttemptedAt
      ? `Last background check: ${formatRelativeTime(state.lastBackgroundSyncAttemptedAt)}.`
      : "Last background check: not yet.",
    state.nextBackgroundSyncAt
      ? `Next background check: ${formatFutureRelativeTime(state.nextBackgroundSyncAt)}.`
      : undefined
  ].filter((line): line is string => Boolean(line));
}

function formatRelativeTime(value: Date, now = new Date()): string {
  const diffMs = now.getTime() - value.getTime();

  if (Math.abs(diffMs) < 60_000) {
    return "just now";
  }

  if (diffMs < 0) {
    return formatFutureRelativeTime(value, now);
  }

  return `${formatDurationMinutes(Math.max(1, Math.round(diffMs / 60_000)))} ago`;
}

function formatFutureRelativeTime(value: Date, now = new Date()): string {
  const diffMs = value.getTime() - now.getTime();

  if (diffMs <= 0) {
    return "due now";
  }

  return `about ${formatDurationMinutes(Math.max(1, Math.ceil(diffMs / 60_000)))}`;
}

function formatDurationMinutes(minutes: number): string {
  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  if (remainingMinutes === 0) {
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }

  return `${hours} hour${hours === 1 ? "" : "s"} ${remainingMinutes} minute${remainingMinutes === 1 ? "" : "s"}`;
}

function looksLikeGmailNotificationTimingQuestion(message: string): boolean {
  const text = normalizeForComparison(message);

  if (!/\b(gmail|email|emails|mail|mails|inbox|rule|rules|endesa)\b/.test(text)) {
    return false;
  }

  return (
    /\bwhen\b.*\b(check|sync|scan|look|read)\b.*\b(gmail|email|emails|mail|mails|inbox)\b/.test(text) ||
    /\bhow\b.*\b(often|much|many|does|do)\b.*\b(check|sync|scan|look|read)\b/.test(text) ||
    /\b(do|does|will|would|can|could)\b.*\b(check|sync|scan|look|read|notify|tell|let me know)\b.*\b(automatically|background|arrival|arrive|new|gmail|email|emails|mail|mails)\b/.test(text) ||
    /\b(automatically|background|instant|webhook|webhooks)\b.*\b(gmail|email|emails|mail|mails|inbox|notify|notification|sync|check|scan)\b/.test(text) ||
    /\bwhen\b.*\b(let me know|tell me|notify|notification|new|arrive|comes?|come in|sync|check)\b/.test(text) ||
    /\b(let me know|tell me|notify|notification)\b.*\b(new|arrive|comes?|come in|sync|check|email|emails|mail|mails)\b/.test(text) ||
    /\bwhen they arrive\b/.test(text)
  );
}

async function manageCustomGmailRuleForConversation(
  userId: string,
  message: string,
  route?: SemanticRouterResult,
  pendingAction?: PendingAction
): Promise<string> {
  const parsed = parseCustomGmailRuleManagement(message, route);
  if (!parsed) {
    return "Tell me which custom Gmail rule to change. Example: pause Endesa emails.";
  }

  const rules = await getVisibleGmailEmailRules(userId);

  const contextualIgnoreReply = maybeHandleGmailRuleIgnoreWithoutVisibleReviewContext(message, rules, parsed.target);
  if (contextualIgnoreReply) {
    return contextualIgnoreReply;
  }

  if (parsed.operation === "archive" && isAllCustomGmailRulesTarget(message, parsed.target)) {
    const selectedRules = sortEmailRuleCandidates(
      normalizeForComparison(`${message} ${parsed.target ?? ""}`).includes("custom")
        ? rules.filter((rule) => rule.adapterId === "custom_email_review")
        : rules
    );

    if (selectedRules.length === 0) {
      return "No Gmail email rules matched. Gmail connection and historical email reviews were not changed.";
    }

    await replacePendingAction(userId, {
      type: "custom_email_rule",
      summary: `Archive ${selectedRules.length} Gmail email rules`,
      payload: {
        operation: "archive_rules",
        ruleScope: "gmail_email_rules",
        ruleIds: selectedRules.map((rule) => rule.id),
        ruleNames: selectedRules.map((rule) => rule.name)
      },
      expiresAt: pendingDecisionExpiry()
    });

    return [
      `Confirm remove ${selectedRules.length} Gmail email rule${selectedRules.length === 1 ? "" : "s"}?`,
      ...formatGmailEmailRuleSelectionLines(selectedRules, { showStatus: true }),
      "Reply yes to confirm or no to cancel."
    ].join("\n");
  }

  const targetParts = parsed.operation === "archive" && parsed.target ? splitEmailRuleTargets(parsed.target) : [];

  if (targetParts.length > 1) {
    const resolution = resolveMultipleEmailRuleTargets(rules, targetParts);

    if (resolution.unmatchedTargets.length > 0 || resolution.ambiguousTargets.length > 0) {
      return [
        "I can remove multiple custom Gmail rules, but I need clearer rule names.",
        resolution.unmatchedTargets.length > 0 ? `No match for: ${resolution.unmatchedTargets.join(", ")}` : undefined,
        ...resolution.ambiguousTargets.map(
          (item) => `Ambiguous: ${item.target} (${item.candidates.slice(0, 3).map((rule) => rule.name).join(", ")})`
        ),
        "Use exact rule names from /my_email_rules, or remove one rule at a time."
      ]
        .filter(Boolean)
        .join("\n");
    }

    if (resolution.matches.length > 1) {
      const selectedRules = sortEmailRuleCandidates(resolution.matches);
      await replacePendingAction(userId, {
        type: "custom_email_rule",
        summary: `Archive ${selectedRules.length} Gmail email rules`,
        payload: {
          operation: "archive_rules",
          ruleScope: "gmail_email_rules",
          ruleIds: selectedRules.map((rule) => rule.id),
          ruleNames: selectedRules.map((rule) => rule.name)
        },
        expiresAt: pendingDecisionExpiry()
      });

      return [
        `Confirm remove ${selectedRules.length} Gmail email rules?`,
        ...formatGmailEmailRuleSelectionLines(selectedRules, { showStatus: true }),
        "Reply yes to confirm or no to cancel."
      ].join("\n");
    }
  }

  const matches = sortEmailRuleCandidates(resolveCustomGmailRulesForConversation(rules, message, {
    ...defaultSemanticRoute("gmail_custom_rule_manage", parsed.operation === "archive" ? "remove" : parsed.operation, "Parsed custom Gmail rule management request."),
    target: parsed.target
  }, pendingAction));

  if (matches.length === 0) {
    const target = parsed.target ?? extractGmailRuleQuestionTarget(message) ?? extractLikelyRuleTargetsFromMessage(message)[0];
    if (target && isCustomGmailRuleQuestionTarget(target)) {
      return formatMissingEmailRuleManagementContext(target);
    }

    return "I could not find a matching custom Gmail rule. Use /my_email_rules to check the exact rule.";
  }

  if (matches.length > 1) {
    await replacePendingAction(userId, {
      type: "custom_email_rule",
      summary: `${parsed.operation === "archive" ? "Remove" : parsed.operation} custom Gmail rule`,
      payload: {
        operation: "clarify_rule_management",
        intendedOperation: parsed.operation,
        originalText: message,
        candidateRules: matches.slice(0, 5).map(toEmailRuleSelectionCandidate)
      },
      expiresAt: pendingDecisionExpiry()
    });

    return [
      "Which custom Gmail rule do you mean?",
      ...matches.slice(0, 5).map((rule, index) => `${index + 1}. ${rule.name}`),
      "Reply with the number or rule name, or cancel."
    ].join("\n");
  }

  const rule = matches[0];

  if (parsed.operation === "pause" || parsed.operation === "resume") {
    const status = parsed.operation === "pause" ? "paused" : "active";
    const updated = await updateEmailSignalRule(userId, rule.id, { status });
    if (updated) {
      await maybeRememberGmailRuleConversationContext(userId, [updated], updated);
    }
    return updated ? `Gmail rule ${status}: ${updated.name}` : "I could not update that Gmail rule.";
  }

  await replacePendingAction(userId, {
    type: "custom_email_rule",
    summary: `Archive Gmail rule: ${rule.name}`,
    payload: {
      operation: "archive_rule",
      ruleId: rule.id,
      ruleName: rule.name
    },
    expiresAt: pendingDecisionExpiry()
  });

  return `Confirm remove Gmail rule: ${rule.name}? Reply yes to confirm or no to cancel.`;
}

function maybeHandleGmailRuleIgnoreWithoutVisibleReviewContext(
  message: string,
  rules: EmailSignalRule[],
  routeTarget?: string | null
): string | undefined {
  if (!looksLikeIgnoreEmailItemsLanguage(message)) {
    return undefined;
  }

  const target = routeTarget ?? extractGmailRuleQuestionTarget(message) ?? extractLikelyRuleTargetsFromMessage(message)[0];

  if (!target || !isCustomGmailRuleQuestionTarget(target)) {
    return undefined;
  }

  const matches = findEmailRulesByTarget(rules, target);

  if (matches.length > 0) {
    return [
      `I don't see visible ${customGmailRuleSubject(target)} email reviews right now.`,
      `I do see ${matches.length === 1 ? "a Gmail rule" : "Gmail rules"} for that: ${matches.slice(0, 3).map((rule) => rule.name).join(", ")}.`,
      `Do you mean pause or remove ${matches.length === 1 ? "that rule" : "those rules"}?`
    ].join("\n");
  }

  return formatMissingEmailRuleManagementContext(target);
}

function looksLikeIgnoreEmailItemsLanguage(message: string): boolean {
  return /\b(ignore|reject|dismiss|clear|ignora|ignorar|rechaza|rechazar|descarta|descartar)\b/i.test(message);
}

function formatMissingEmailRuleManagementContext(target: string): string {
  const subject = customGmailRuleSubject(target);
  return `I don't see visible ${subject} reviews or an active ${subject} rule in this context. Say "email reviews" or "Gmail rules" first.`;
}

function parseCustomGmailRuleManagement(
  message: string,
  route?: SemanticRouterResult
): { operation: "pause" | "resume" | "archive"; target: string | null } | undefined {
  if (
    route &&
    (route.operation === "pause" || route.operation === "resume" || route.operation === "remove")
  ) {
    return {
      operation: route.operation === "remove" ? "archive" : route.operation,
      target: route.target
    };
  }

  const match = message.trim().match(/^(?:(?:also|tambien|también)\s+)?(?:(?:can|could|would)\s+(?:you|u)\s+(?:please\s+)?|(?:puedes|podrias|podrías)\s+)?(pause|resume|remove|delete|elimina|eliminar|borra|borrar|pausa|pausar|reanuda|reanudar|activa|activar)\s+(.+?)(?:\s+(?:gmail|email|mail)?\s*rules?)?$/i);
  if (!match) {
    return undefined;
  }

  const verb = match[1].toLowerCase();
  const operation =
    verb === "pause" || verb === "pausa" || verb === "pausar"
      ? "pause"
      : verb === "resume" || verb === "reanuda" || verb === "reanudar" || verb === "activa" || verb === "activar"
        ? "resume"
        : "archive";

  return {
    operation,
    target: match[2].trim()
  };
}

function isAllCustomGmailRulesTarget(message: string, target: string | null): boolean {
  const text = normalizeForComparison(`${message} ${target ?? ""}`);
  return /\b(all|every|todas|todos|totes|all active)\b/.test(text) && /\b(email|gmail|rule|rules|regla|reglas|custom|tracking)\b/.test(text);
}

function resolveCustomGmailRulesForConversation(
  rules: EmailSignalRule[],
  message: string,
  route?: SemanticRouterResult,
  pendingAction?: PendingAction
): EmailSignalRule[] {
  const targetCandidates = uniqueStrings([
    route?.target && !isPronounRuleTarget(route.target) ? route.target : undefined,
    extractGmailRuleQuestionTarget(message),
    ...(route?.removeKeywordFilters ?? []),
    ...extractLikelyRuleTargetsFromMessage(message)
  ].filter((value): value is string => Boolean(value && value.trim())));

  for (const target of targetCandidates) {
    const matches = findSelectableEmailRulesByTarget(rules, target);
    if (matches.length > 0) {
      return matches;
    }
  }

  if (targetCandidates.length > 0) {
    return [];
  }

  const contextMatches = getCustomGmailRuleContextMatches(rules, pendingAction);
  if (contextMatches.length > 0 && (hasRulePronoun(message, route) || rules.length > 1)) {
    return contextMatches;
  }

  return rules.length === 1 ? rules : [];
}

function defaultSemanticRoute(
  intent: SemanticRouterResult["intent"],
  operation: SemanticRouterResult["operation"],
  reason: string
): SemanticRouterResult {
  return {
    intent,
    operation,
    confidence: 0.9,
    reason,
    language: "unknown",
    sideEffectRisk: operation === "remove" ? "destructive" : operation === "status" || operation === "answer" || operation === "timing" ? "read" : "write",
    requiresConfirmation: operation === "remove",
    target: null,
    keywordFilters: [],
    senderFilters: [],
    removeKeywordFilters: [],
    goalHint: null,
    shouldUnlinkGoal: false,
    userFacingIssue: null
  };
}

function getCustomGmailRuleContextMatches(rules: EmailSignalRule[], pendingAction?: PendingAction): EmailSignalRule[] {
  if (!isPendingCustomGmailRuleContext(pendingAction) || !pendingAction || !isRecord(pendingAction.payload)) {
    return [];
  }

  const focusedRuleId = typeof pendingAction.payload.focusedRuleId === "string" ? pendingAction.payload.focusedRuleId : undefined;
  if (focusedRuleId) {
    const focused = rules.find((rule) => rule.id === focusedRuleId);
    if (focused) {
      return [focused];
    }
  }

  const contextRules = Array.isArray(pendingAction.payload.rules)
    ? pendingAction.payload.rules.filter(isRecord)
    : [];
  const customRuleIds = contextRules
    .filter((rule) => rule.adapterId === "custom_email_review")
    .map((rule) => (typeof rule.id === "string" ? rule.id : ""))
    .filter(Boolean);

  if (customRuleIds.length === 1) {
    const match = rules.find((rule) => rule.id === customRuleIds[0]);
    return match ? [match] : [];
  }

  return [];
}

function isPronounRuleTarget(target: string): boolean {
  return /^(it|this|that|this rule|that rule|esta|este|esa|ese|aquesta|aquest|aquella|aquell)$/i.test(target.trim());
}

function hasRulePronoun(message: string, route?: SemanticRouterResult): boolean {
  const text = normalizeForComparison(`${message} ${route?.target ?? ""}`);
  return /\b(it|this|that|that rule|this rule|these emails|those emails|esta regla|esa regla|aquesta regla|aquella regla)\b/.test(text);
}

function extractLikelyRuleTargetsFromMessage(message: string): string[] {
  return uniqueStrings(
    (message.match(/\b[A-Z][\p{L}0-9]{2,}(?:\s+(?:de|the)\s+[A-Z][\p{L}0-9]{2,}){0,3}/gu) ?? [])
      .map(cleanEmailRuleTarget)
      .filter(isUsefulCustomKeywordCandidate)
  );
}

function extractGmailRuleQuestionTarget(message: string): string | undefined {
  const text = normalizeForComparison(message);

  if (/\b(work action|work actions|work email|work emails|work mails|work tracking)\b/.test(text)) {
    return "work_action_email";
  }

  if (/\b(job search|job email|job emails|job mails|recruiter|application emails|career emails)\b/.test(text)) {
    return "job_search_email";
  }

  const explicitCustomTarget = extractCustomGmailRuleQuestionEntity(message);
  if (explicitCustomTarget) {
    return explicitCustomTarget;
  }

  const proper = message.match(/\b[A-Z][a-zA-Z0-9]{2,}\b/g)?.find((item) => !/^(Gmail|Email|Mail|Inbox|Rule|Rules|Alecto|I)$/i.test(item));
  if (proper) {
    return proper;
  }

  const match = message.match(/\b(?:about|for|with)\s+(.+?)(?:\s+(?:email|emails|gmail|rule|tracking)\b|[?.]|$)/i);
  return match ? cleanEmailRuleTarget(match[1]) : undefined;
}

function extractCustomGmailRuleQuestionEntity(message: string): string | undefined {
  const patterns = [
    /\bwhere\s+(?:do|does|will|would|can|could)?\s*(.+?)\s+(?:email|emails|mail|mails)\s+(?:go|land|arrive|show|appear)\b/i,
    /\bwhen\s+(?:do|does|will|would|can|could)?\s*(.+?)\s+(?:email|emails|mail|mails)\s+(?:arrive|come|come in|notify|show|go)\b/i,
    /\b(?:does|do|will|would|can|could)\s+(.+?)\s+(?:auto[\s-]?log|automatically log|create actions?|create events?|go to reviews?|be reviewed)\b/i
  ];

  for (const pattern of patterns) {
    const match = message.match(pattern);
    const target = match ? cleanEmailRuleTarget(match[1] ?? "") : "";
    if (isLikelyCustomGmailQuestionEntity(target)) {
      return target;
    }
  }

  return undefined;
}

function isLikelyCustomGmailQuestionEntity(target: string): boolean {
  const key = normalizeForComparison(target);
  if (!isUsefulCustomKeywordCandidate(target)) {
    return false;
  }

  return !/\b(u|you|your|me|my|i|we|us|they|them|gmail|email|mail|mails|inbox|check|sync|scan|read|look|notify|tell|let|know|automatic|automatically|background|new|review|reviews|rule|rules|go|arrive|arrives)\b/.test(key);
}

function findEmailRulesByTarget(rules: EmailSignalRule[], target: string): EmailSignalRule[] {
  const customMatches = findSelectableEmailRulesByTarget(rules.filter((rule) => rule.adapterId === "custom_email_review"), target);
  if (customMatches.length > 0) {
    return customMatches;
  }

  const targetKey = normalizeForComparison(cleanEmailRuleTarget(target));
  return rules.filter((rule) => {
    const haystack = normalizeForComparison(`${rule.name} ${rule.adapterId} ${rule.query ?? ""}`);
    return targetKey.length > 2 && haystack.includes(targetKey);
  });
}

function formatEmailRuleQueryForHumans(query: string | undefined): string {
  if (!query) {
    return "default adapter query";
  }

  const clean = query
    .replace(/\bnewer_than:\d+d\b/gi, "")
    .replace(/\bfrom:/gi, "from ")
    .replace(/"/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return clean || "default adapter query";
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

type OnboardingIntent =
  | "first_run_intro"
  | "setup_overview"
  | "quickstart"
  | "configure_goals"
  | "configure_actions"
  | "configure_daily_loop"
  | "configure_reminders"
  | "configure_integrations"
  | "explain_capabilities"
  | "missing_setup";

interface OnboardingState {
  userId: string;
  profileSummary: string;
  goalsCount: number;
  topGoals: string[];
  openActionsCount: number;
  overdueOrStaleActionsCount: number;
  dailyLoopEnabled: boolean;
  morningTime: string;
  eveningTime: string;
  actionReminderDefaultTime: string;
  notificationSummary: string;
  connectedIntegrationsCount: number;
  gmailStatus: "connected" | "not_connected";
  activeEmailRulesCount: number;
  githubConnectionCount: number;
  dailyBriefUsable: boolean;
  missingSetupItems: string[];
  recommendedNextStep: string;
  timezone: string;
}

async function buildOnboardingState(userId: string, now: Date, timezone: string): Promise<OnboardingState> {
  const [goals, actions, settings, connections, emailRules, profile, hygiene] = await Promise.all([
    getActiveGoals(userId),
    getActionItems(userId, { status: "open", limit: 100 }),
    getOrCreateNotificationSettings(userId),
    getIntegrationConnections(userId),
    getEmailSignalRules(userId),
    getOrCreateUserOperatingProfile(userId),
    analyzeActionHygiene(userId, now, timezone)
  ]);
  const activeConnections = connections.filter((connection) => connection.status === "active");
  const activeEmailRules = emailRules.filter((rule) => rule.status === "active");
  const gmailConnected = activeConnections.some((connection) => connection.integrationId === "gmail");
  const githubConnectionCount = activeConnections.filter((connection) => connection.integrationId === "github_public").length;
  const missingSetupItems = [
    goals.length === 0 ? "goals" : undefined,
    !settings.dailyLoopEnabled ? "daily loop" : undefined,
    actions.length === 0 ? "first action" : undefined,
    !gmailConnected ? "Gmail optional" : activeEmailRules.length === 0 ? "email rules optional" : undefined,
    githubConnectionCount === 0 ? "GitHub optional" : undefined
  ].filter((item): item is string => Boolean(item));
  const recommendedNextStep =
    goals.length === 0
      ? "Tell me a real goal, for example: I want to find a new developer job."
      : actions.length === 0
        ? "Create one concrete next action, for example: remind me to apply tomorrow."
        : !settings.dailyLoopEnabled
          ? "Say: turn on morning brief at 9 and evening review at 21:30."
          : hygiene.suggestedCleanupCandidates.length > 0
            ? "Say: clean up my tasks."
            : "Ask: what should I do today.";

  return {
    userId,
    profileSummary: `${profile.motivationalStyle}, directness ${profile.directness}/5, guardrails ${profile.gamblingGuardrails}`,
    goalsCount: goals.length,
    topGoals: sortGoalsForDisplay(goals).slice(0, 3).map((goal) => goal.title),
    openActionsCount: actions.length,
    overdueOrStaleActionsCount: hygiene.suggestedCleanupCandidates.length,
    dailyLoopEnabled: settings.dailyLoopEnabled,
    morningTime: formatMinutesOfDay(settings.morningTimeMinutes),
    eveningTime: formatMinutesOfDay(settings.eveningTimeMinutes),
    actionReminderDefaultTime: formatMinutesOfDay(settings.defaultActionTimeMinutes),
    notificationSummary: `timezone ${settings.timezone}, default action time ${formatMinutesOfDay(settings.defaultActionTimeMinutes)}`,
    timezone: settings.timezone,
    connectedIntegrationsCount: activeConnections.length,
    gmailStatus: gmailConnected ? "connected" : "not_connected",
    githubConnectionCount,
    activeEmailRulesCount: activeEmailRules.length,
    dailyBriefUsable: goals.length > 0 || actions.length > 0,
    missingSetupItems,
    recommendedNextStep
  };
}

function composeOnboardingReply(state: OnboardingState, intent: OnboardingIntent): string {
  if (intent === "first_run_intro") {
    return [
      "Hey, I'm Alecto. You can talk normally.",
      "",
      "I can help with:",
      "- deciding what to do today",
      "- tracking goals and actions",
      "- remembering preferences",
      "- reviewing your week",
      "- keeping guardrails around risky patterns",
      "",
      "Try:",
      '- "I want to find a new job"',
      '- "remind me to apply tomorrow"',
      '- "what should I do today"',
      '- "help me set up"',
      "",
      "Commands are optional shortcuts."
    ].join("\n");
  }

  if (intent === "explain_capabilities") {
    return [
      "I help you operate from evidence, not vibes.",
      "",
      "- Daily planning: what to do today, start/end day, tomorrow prep.",
      "- Goals: track active goals, priorities, and progress evidence.",
      "- Actions/reminders: create, complete, snooze, archive, and get due reminders.",
      "- Check-ins/events: log sleep, energy, anxiety, focus, training, reading, applications, and other approved events.",
      "- Memory: remember preferences and recurring patterns.",
      "- Guardrails: hard-stop betting/trading risk before it becomes a task or rationalization.",
      "- Weekly review/planning: review the week and propose next-week actions only after confirmation.",
      "- Signals: Gmail/GitHub can add context after explicit connection and approved rules.",
      "",
      "You can talk normally. Commands like /today, /actions, /weekly, and /plan_next_week are shortcuts."
    ].join("\n");
  }

  if (intent === "quickstart") {
    const firstStep =
      state.goalsCount === 0
        ? 'Start here: say "I want to find a new developer job" or another real goal.'
        : state.openActionsCount === 0
          ? 'Start here: say "remind me to apply tomorrow" or another concrete next action.'
          : state.overdueOrStaleActionsCount > 0
            ? 'Start here: say "clean up my tasks".'
            : 'Start here: ask "what should I do today".';

    return [
      "Quickstart:",
      "1. Set 1-3 real goals.",
      "2. Add one next action.",
      "3. Let Alecto pick the next move each day.",
      "",
      firstStep,
      "",
      "Examples:",
      '- "I want to find a new developer job"',
      '- "remind me to apply tomorrow"',
      '- "what should I do today"',
      "",
      `Best next step: ${state.recommendedNextStep}`
    ].join("\n");
  }

  if (intent === "configure_goals") {
    if (state.topGoals.length > 0) {
      return [
        "Goal setup:",
        `Current goals: ${state.topGoals.join(", ")}${state.goalsCount > state.topGoals.length ? `, +${state.goalsCount - state.topGoals.length} more` : ""}.`,
        "",
        "That is enough to operate. Adding more goals may add noise unless something truly matters now.",
        "",
        "If you do want another one, say it naturally. I will ask confirmation before creating it."
      ].join("\n");
    }

    return [
      "Goal setup:",
      "Choose 1-3 goals only. Fewer goals makes the operator loop sharper.",
      "",
      "Good first goals:",
      '- "I want to find a new developer job"',
      '- "I want to improve strength and energy"',
      '- "I want to read more"',
      "",
      "I will ask confirmation before creating a goal."
    ].join("\n");
  }

  if (intent === "configure_actions") {
    return [
      "Actions are concrete things you might do, with optional reminders.",
      "",
      "Try:",
      '- "remind me to apply to 3 jobs tomorrow"',
      '- "I need to review homepage copy Friday"',
      '- "move YouTube script to tomorrow afternoon"',
      "",
      "You can also say things like done with it, snooze it to tomorrow, or archive the car task. I will ask if the target is ambiguous."
    ].join("\n");
  }

  if (intent === "configure_daily_loop" || intent === "configure_reminders") {
    return [
      "Daily loop setup:",
      `- status: ${state.dailyLoopEnabled ? "on" : "off"}`,
      `- morning brief: ${state.morningTime} ${state.timezone}`,
      `- evening review: ${state.eveningTime} ${state.timezone}`,
      `- default action time: ${state.actionReminderDefaultTime}`,
      "",
      "Morning brief picks the first move. Evening review closes the day and catches cleanup.",
      'Natural option: "turn on morning brief at 9 and evening review at 21:30".',
      "Optional shortcut: /set_daily_loop morning=09:00 evening=21:30 enabled=true."
    ].join("\n");
  }

  if (intent === "configure_integrations") {
    return [
      "Integration setup:",
      `- Gmail: ${state.gmailStatus === "connected" ? "connected" : "not connected"}`,
      `- active email rules: ${state.activeEmailRulesCount}`,
      `- GitHub public connections: ${state.githubConnectionCount}`,
      "",
      "Gmail is readonly and local-MVP. It does not scan until you connect Gmail and explicitly enable a rule.",
      "Optional shortcuts: /connect_gmail, /enable_email_rule job_search, /connect_github OWNER/REPO author=LOGIN."
    ].join("\n");
  }

  const ready = [
    `Goals: ${state.goalsCount} active${state.topGoals.length > 0 ? ` (${state.topGoals.join(", ")})` : ""}`,
    `Actions: ${state.openActionsCount} open`,
    `Daily brief: ${state.dailyLoopEnabled ? `enabled, ${state.morningTime}` : "disabled"}`,
    `Evening review: ${state.dailyLoopEnabled ? `enabled, ${state.eveningTime}` : "disabled"}`
  ];
  const needsAttention = [
    state.goalsCount === 0 ? "No goals yet" : undefined,
    state.openActionsCount === 0 ? "No open actions yet" : undefined,
    !state.dailyLoopEnabled ? "Daily loop is off" : undefined,
    state.overdueOrStaleActionsCount > 0 ? cleanupDecisionGrammar(state.overdueOrStaleActionsCount) : undefined
  ].filter((item): item is string => Boolean(item));
  const optional = [
    `Gmail: ${state.gmailStatus === "connected" ? "connected" : "not connected"}`,
    `GitHub: ${state.githubConnectionCount} public ${state.githubConnectionCount === 1 ? "connection" : "connections"}`,
    `Email rules: ${state.activeEmailRulesCount} active`,
    `Timezone: ${state.timezone}`
  ];

  return [
    "Alecto setup",
    "",
    "Ready:",
    ...ready.map((item) => `- ${item}`),
    "",
    "Needs attention:",
    ...(needsAttention.length > 0 ? needsAttention : ["Nothing blocking the local alpha loop."]).map((item) => `- ${item}`),
    "",
    "Optional:",
    ...optional.map((item) => `- ${item}`),
    "",
    `Best next step: ${state.recommendedNextStep}`
  ].filter(Boolean).join("\n");
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

async function buildConversationDailyReview(userId: string, now = new Date()) {
  const todayRange = getLocalTodayRange(now, await getUserTimezone(userId));
  return buildDailyReview({
    userId,
    activeGoals: await getActiveGoals(userId),
    todayEvents: await getEventsBetween(userId, todayRange.start, todayRange.end),
    activeMemories: await getRelevantMemories(userId, {
      types: ["risk_pattern"],
      limit: 3
    })
  });
}

function formatConversationDailyReview(review: ReturnType<typeof buildDailyReview>): string {
  return [
    review.summary,
    review.checkIn.length > 0 ? `Check-in: ${review.checkIn.join(", ")}` : undefined,
    `Wins: ${review.wins.length > 0 ? review.wins.join(", ") : "none logged"}`,
    `Gaps: ${review.gaps.length > 0 ? review.gaps.join(", ") : "none obvious"}`,
    review.warnings.length > 0 ? `Warnings:\n${review.warnings.map((warning) => `- ${warning}`).join("\n")}` : undefined,
    `Next step: ${review.suggestedFocus}`
  ].filter(Boolean).join("\n");
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

async function handleNaturalDailyLoopSettings(userId: string, message: string): Promise<string> {
  const settings = await getOrCreateNotificationSettings(userId);
  const parsed = parseNaturalDailyLoopSettings(message);

  if (!parsed) {
    return [
      "I can help set the daily loop, but I need a concrete time.",
      "Examples: turn on morning brief at 09:00, set evening review at 21:30."
    ].join("\n");
  }

  const updated = await updateNotificationSettings(userId, {
    dailyLoopEnabled: true,
    morningTimeMinutes: parsed.morningTimeMinutes,
    eveningTimeMinutes: parsed.eveningTimeMinutes
  });

  return [
    "Daily loop updated.",
    parsed.morningTimeMinutes !== undefined ? `Morning brief: ${formatMinutesOfDay(parsed.morningTimeMinutes)} ${updated.timezone}` : undefined,
    parsed.eveningTimeMinutes !== undefined ? `Evening review: ${formatMinutesOfDay(parsed.eveningTimeMinutes)} ${updated.timezone}` : undefined,
    parsed.morningTimeMinutes === undefined && parsed.eveningTimeMinutes === undefined ? `Enabled with current times: morning ${formatMinutesOfDay(settings.morningTimeMinutes)}, evening ${formatMinutesOfDay(settings.eveningTimeMinutes)} ${updated.timezone}` : undefined
  ].filter(Boolean).join("\n");
}

function parseNaturalDailyLoopSettings(message: string): { morningTimeMinutes?: number; eveningTimeMinutes?: number } | undefined {
  const text = message.trim();
  const morningMatch = text.match(/\bmorning(?:\s+brief)?\s+(?:at|a las)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  const eveningMatch = text.match(/\b(?:evening|night)(?:\s+review)?\s+(?:at|a las)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  const parsed: { morningTimeMinutes?: number; eveningTimeMinutes?: number } = {};

  if (morningMatch) {
    parsed.morningTimeMinutes = parseNaturalTimeToMinutes(morningMatch[1], morningMatch[2], morningMatch[3]);
  }

  if (eveningMatch) {
    parsed.eveningTimeMinutes = parseNaturalTimeToMinutes(eveningMatch[1], eveningMatch[2], eveningMatch[3]);
  }

  if (parsed.morningTimeMinutes !== undefined || parsed.eveningTimeMinutes !== undefined) {
    return parsed;
  }

  const timeMatch = text.match(/\b(?:at|a las)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  const minutes = timeMatch ? parseNaturalTimeToMinutes(timeMatch[1], timeMatch[2], timeMatch[3]) : undefined;

  if (/\bmorning\b/i.test(text) && minutes !== undefined) {
    return { morningTimeMinutes: minutes };
  }

  if (/\bevening|night|review\b/i.test(text) && minutes !== undefined) {
    return { eveningTimeMinutes: minutes };
  }

  if (/\bremind me every morning\b/i.test(text)) {
    return {};
  }

  return undefined;
}

function parseNaturalTimeToMinutes(hourText: string, minuteText?: string, meridiem?: string): number | undefined {
  let hour = Number(hourText);
  const minute = minuteText ? Number(minuteText) : 0;

  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute > 59) {
    return undefined;
  }

  if (meridiem?.toLowerCase() === "pm" && hour < 12) {
    hour += 12;
  }

  if (meridiem?.toLowerCase() === "am" && hour === 12) {
    hour = 0;
  }

  if (hour < 0 || hour > 23) {
    return undefined;
  }

  return hour * 60 + minute;
}

function formatMinutesOfDay(minutes: number): string {
  const safe = Number.isInteger(minutes) && minutes >= 0 && minutes <= 1439 ? minutes : 0;
  const hours = Math.floor(safe / 60);
  const mins = safe % 60;
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
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

type PendingActionCandidate = {
  id: string;
  title: string;
  status: string;
  dueAt?: string;
  snoozedUntil?: string;
  goalId?: string;
  goalTitleSnapshot?: string;
  recommendedOptions?: ActionHygieneOption[];
};

function toPendingActionCandidate(action: {
  id: string;
  title: string;
  status: string;
  dueAt?: Date | null;
  snoozedUntil?: Date | null;
  goalId?: string | null;
  goalTitleSnapshot?: string | null;
}): PendingActionCandidate {
  return {
    id: action.id,
    title: action.title,
    status: action.status,
    dueAt: action.dueAt?.toISOString(),
    snoozedUntil: action.snoozedUntil?.toISOString(),
    goalId: action.goalId ?? undefined,
    goalTitleSnapshot: action.goalTitleSnapshot ?? undefined
  };
}

function formatActionTargetClarificationReply(candidates: PendingActionCandidate[], timezone = "Europe/Madrid"): string {
  return [
    "Which action do you mean?",
    ...candidates.map((action, index) => `${index + 1}. ${formatPendingActionCandidate(action, timezone)}`),
    `Reply 1-${candidates.length}, or 'cancel'.`
  ].join("\n");
}

function formatPendingActionCandidate(action: PendingActionCandidate, timezone = "Europe/Madrid"): string {
  const due = action.dueAt ? ` - due ${formatLocalDateTime(new Date(action.dueAt), timezone)}` : "";
  const snoozed = action.snoozedUntil ? ` - snoozed until ${formatLocalDateTime(new Date(action.snoozedUntil), timezone)}` : "";
  return `${action.title}${due}${snoozed}`;
}

function comparePendingActionCandidates(left: PendingActionCandidate, right: PendingActionCandidate): number {
  const leftTime = left.dueAt ? new Date(left.dueAt).getTime() : Number.POSITIVE_INFINITY;
  const rightTime = right.dueAt ? new Date(right.dueAt).getTime() : Number.POSITIVE_INFINITY;

  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  return left.title.localeCompare(right.title);
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

function formatConversationTodayReply(brief: DailyOperatorBrief): string {
  return [
    `Today - ${brief.date}`,
    "",
    "Status:",
    brief.summary,
    "",
    "Top priorities:",
    brief.topPriorities.length > 0 ? brief.topPriorities.map((item, index) => `${index + 1}. ${item}`).join("\n") : "No clear priorities yet.",
    brief.emailAttention && brief.emailAttention.pendingCount > 0 ? `\nGmail:\n- ${brief.emailAttention.summary} Say "show me the important emails" to inspect them.` : undefined,
    brief.actionHygiene ? `\nAction hygiene:\n- ${cleanupDecisionGrammar(brief.actionHygiene.needsDecision)} Run /action_hygiene.` : undefined,
    brief.weeklyReviewDue ? "\nWeekly review:\n- Weekly review due. Run /weekly." : undefined,
    brief.operatorReflection ? `\nPattern:\n${brief.operatorReflection}` : undefined,
    "",
    "Next move:",
    brief.suggestedNextStep
  ].join("\n");
}

function formatOperatorAttentionForConversation(state: OperatorAttentionState): string {
  if (state.topAttentionItems.length === 0) {
    return [
      "Nothing urgent is standing out.",
      state.actionAttentionSummary.summary,
      state.emailAttentionSummary.pendingCount > 0 ? state.emailAttentionSummary.summary : "No Gmail reviews are waiting.",
      "",
      `Next move: ${state.recommendedNextMove}`
    ].join("\n");
  }

  return [
    "What needs attention:",
    ...state.topAttentionItems.slice(0, 4).map((item, index) => `${index + 1}. ${item.title} - ${item.summary}`),
    state.emailAttentionSummary.pendingCount > 0 ? `\nGmail: ${state.emailAttentionSummary.summary}` : undefined,
    "",
    `Next move: ${state.recommendedNextMove}`,
    state.suggestedUserReplies.length > 0 ? `You can say: ${state.suggestedUserReplies.slice(0, 3).join(" / ")}` : undefined
  ].filter(Boolean).join("\n");
}

function formatOperatorNextMoveForConversation(state: OperatorAttentionState): string {
  const top = state.topAttentionItems[0];

  return [
    `First: ${state.recommendedNextMove}`,
    top ? `Why: ${top.summary}` : undefined,
    state.emailAttentionSummary.pendingCount > 0 ? `Gmail waiting: ${state.emailAttentionSummary.summary}` : undefined
  ].filter(Boolean).join("\n");
}

function formatEmailAttentionForConversation(state: OperatorAttentionState): string {
  const email = state.emailAttentionSummary;

  if (email.pendingCount === 0) {
    return [
      "No Gmail reviews are waiting.",
      email.handledTodayCount > 0
        ? `${email.handledTodayCount} Gmail review${email.handledTodayCount === 1 ? "" : "s"} handled today.`
        : undefined,
      `Mode: ${email.syncMode}. Review notifications: ${email.notificationPreference}.`,
      "Alecto cannot reply to emails or change Gmail labels."
    ].filter(Boolean).join("\n");
  }

  const lines = [
    `${email.pendingCount} Gmail review${email.pendingCount === 1 ? "" : "s"} need attention.`,
    email.workActionCount > 0 ? `- ${email.workActionCount} work-action email${email.workActionCount === 1 ? "" : "s"} may become task${email.workActionCount === 1 ? "" : "s"}.` : undefined,
    email.jobSearchCount > 0 ? `- ${email.jobSearchCount} job-search email${email.jobSearchCount === 1 ? "" : "s"} waiting.` : undefined,
    email.customCount > 0 ? `- ${email.customCount} custom tracking item${email.customCount === 1 ? "" : "s"} waiting.` : undefined,
    email.otherCount > 0 ? `- ${email.otherCount} other email review${email.otherCount === 1 ? "" : "s"} waiting.` : undefined,
    email.topReviewSubjects.length > 0 ? `Examples: ${email.topReviewSubjects.join("; ")}` : undefined,
    "",
    'Say "email reviews" or "show me the important emails" to inspect them.',
    "Alecto cannot reply to emails or change Gmail labels."
  ];

  return lines.filter(Boolean).join("\n");
}

function dueLabelFromPriorityScore(score: DailyPriorityScore): string {
  return (
    score.factors.find((factor) => factor === "overdue" || factor.startsWith("due today") || factor.startsWith("due tomorrow") || factor === "due later this week") ??
    "not due"
  );
}

function buildOperatorEmailAttentionSummary(input: {
  pendingReviews: EmailReviewItem[];
  todayReviews: EmailReviewItem[];
  todayEvents: StoredEvent[];
  actions: ActionItem[];
  activeGoals: Goal[];
  ruleById: Map<string, EmailSignalRule>;
  todayRange: ReturnType<typeof getLocalTodayRange>;
  gmailSyncMode: string;
  reviewNotificationEnabled: boolean;
}): OperatorEmailAttentionSummary {
  const pendingByKind = input.pendingReviews.reduce(
    (counts, review) => {
      const kind = emailReviewKind(review);
      counts[kind] += 1;
      return counts;
    },
    { job_search: 0, work_action: 0, custom_tracking: 0, other: 0 } as Record<EmailReviewKind, number>
  );
  const approvedToday = input.todayReviews.filter((review) => review.status === "approved").length;
  const rejectedToday = input.todayReviews.filter((review) => review.status === "rejected").length;
  const pendingCount = input.pendingReviews.length;
  const hasCareerGoal = input.activeGoals.some((goal) => /career|job|developer/i.test(`${goal.title} ${goal.category} ${goal.templateId ?? ""}`));
  const priority: OperatorAttentionPriority =
    pendingByKind.work_action > 0 || (pendingByKind.job_search > 0 && hasCareerGoal)
      ? "high"
      : pendingByKind.job_search > 0 || pendingByKind.custom_tracking > 0
        ? "medium"
        : "low";
  const parts = [
    pendingByKind.work_action > 0 ? `${pendingByKind.work_action} work-action` : undefined,
    pendingByKind.job_search > 0 ? `${pendingByKind.job_search} job-search` : undefined,
    pendingByKind.custom_tracking > 0 ? `${pendingByKind.custom_tracking} custom tracking` : undefined,
    pendingByKind.other > 0 ? `${pendingByKind.other} other` : undefined
  ].filter(Boolean);
  const gmailDerivedActionItemsToday = input.actions.filter(
    (action) => action.source === "email_review" && isWithinLocalDay(action.createdAt, input.todayRange)
  ).length;
  const gmailDerivedEventsToday = input.todayEvents.filter(
    (event) => event.source === "gmail" || event.provider === "gmail" || event.data.provider === "gmail"
  ).length;
  const summary = pendingCount > 0
    ? `${pendingCount} Gmail review${pendingCount === 1 ? "" : "s"} waiting: ${parts.join(", ")}.`
    : input.todayReviews.length > 0
      ? `${input.todayReviews.length} Gmail review${input.todayReviews.length === 1 ? "" : "s"} handled today.`
      : "No Gmail reviews are waiting.";

  return {
    pendingCount,
    workActionCount: pendingByKind.work_action,
    jobSearchCount: pendingByKind.job_search,
    customCount: pendingByKind.custom_tracking,
    otherCount: pendingByKind.other,
    handledTodayCount: input.todayReviews.length,
    approvedTodayCount: approvedToday,
    rejectedTodayCount: rejectedToday,
    gmailDerivedActionItemsToday,
    gmailDerivedEventsToday,
    topReviewSubjects: input.pendingReviews.slice(0, 3).map((review) => sanitizeShortEmailSubject(review.subject)),
    priority,
    summary,
    userFacingLine: pendingCount > 0 ? emailAttentionPriorityLine({ ...pendingByKind, pendingCount }) : undefined,
    syncMode: input.gmailSyncMode,
    notificationPreference: input.reviewNotificationEnabled ? "on" : "off"
  };
}

function buildOperatorActionAttentionSummary(input: {
  openActions: ActionItem[];
  overdueActions: ActionItem[];
  dueSoonActions: ActionItem[];
  rankedOpenActions: Array<{ action: ActionItem; score: DailyPriorityScore }>;
  hygiene: ActionHygieneReport;
}): OperatorActionAttentionSummary {
  return {
    openCount: input.openActions.length,
    overdueCount: input.overdueActions.length,
    dueSoonCount: input.dueSoonActions.length,
    hygieneNeedsDecision: input.hygiene.suggestedCleanupCandidates.length,
    topActions: input.rankedOpenActions.slice(0, 3).map(({ action }) => ({
      id: action.id,
      title: action.title,
      dueAt: action.dueAt?.toISOString(),
      priority: action.priority
    })),
    summary: `${input.openActions.length} open action${input.openActions.length === 1 ? "" : "s"}; ${input.overdueActions.length} overdue.`
  };
}

function buildOperatorGoalAttentionSummary(goalStatus: DailyOperatorBriefGoalStatus[], activeGoals: Goal[]): OperatorGoalAttentionSummary {
  const noProgress = goalStatus.filter((goal) => goal.status === "no_progress" && !isRiskControlGoalStatus(goal));
  const criticalNoProgress = noProgress.filter((status) => {
    const goal = activeGoals.find((item) => item.id === status.goalId);
    return goal?.priority === "critical";
  });

  return {
    activeCount: activeGoals.length,
    noProgressCount: noProgress.length,
    criticalNoProgressCount: criticalNoProgress.length,
    summary: `${activeGoals.length} active goal${activeGoals.length === 1 ? "" : "s"}; ${noProgress.length} with no progress today.`
  };
}

function buildOperatorRiskAttentionSummary(risks: string[], todayEvents: StoredEvent[]): OperatorRiskAttentionSummary {
  const guardrailTriggeredToday = todayEvents.some((event) => event.type === "finance.betting.cooldown_triggered");

  return {
    activeWatchouts: risks,
    guardrailTriggeredToday,
    summary: risks.length > 0 ? `${risks.length} risk watchout${risks.length === 1 ? "" : "s"}.` : "No risk watchouts from recent signals."
  };
}

function buildTopOperatorAttentionItems(input: {
  rankedOpenActions: Array<{ action: ActionItem; score: DailyPriorityScore }>;
  overdueActions: ActionItem[];
  emailAttention: OperatorEmailAttentionSummary;
  risks: string[];
  hygiene: ActionHygieneReport;
  planningAttention: OperatorPlanningAttentionSummary;
}): OperatorAttentionItem[] {
  const items: OperatorAttentionItem[] = [];
  const topAction = input.rankedOpenActions[0]?.action;

  if (input.risks.length > 0) {
    items.push({
      kind: "risk",
      title: "Risk guardrail",
      summary: input.risks[0],
      priority: "critical",
      suggestedReply: "what should I do today"
    });
  }

  if (topAction) {
    items.push({
      kind: "action",
      title: topAction.title,
      summary: input.overdueActions.some((action) => action.id === topAction.id) ? "Overdue action." : "Top scored open action.",
      priority: input.overdueActions.some((action) => action.id === topAction.id) ? "high" : topAction.priority === "high" ? "high" : "medium",
      sourceId: topAction.id
    });
  }

  if (input.emailAttention.pendingCount > 0) {
    items.push({
      kind: "email_review",
      title: `Handle ${input.emailAttention.pendingCount} Gmail review${input.emailAttention.pendingCount === 1 ? "" : "s"}`,
      summary: input.emailAttention.userFacingLine ?? input.emailAttention.summary,
      priority: input.emailAttention.priority,
      suggestedReply: "show me the important emails"
    });
  }

  if (input.hygiene.suggestedCleanupCandidates.length > 0) {
    items.push({
      kind: "hygiene",
      title: "Clean up stale actions",
      summary: input.hygiene.summary,
      priority: "medium",
      suggestedReply: "clean up my tasks"
    });
  }

  if (input.planningAttention.weeklyReviewDue) {
    items.push({
      kind: "planning",
      title: "Weekly review due",
      summary: "Close the week before planning.",
      priority: "medium",
      suggestedReply: "review my week"
    });
  }

  return items
    .sort((left, right) => attentionPriorityRank(right.priority) - attentionPriorityRank(left.priority))
    .slice(0, 5);
}

function pickAttentionNextMove(
  items: OperatorAttentionItem[],
  input: {
    rankedOpenActions: Array<{ action: ActionItem; score: DailyPriorityScore }>;
    overdueActions: ActionItem[];
    emailAttention: OperatorEmailAttentionSummary;
    goalStatus: DailyOperatorBriefGoalStatus[];
    now: Date;
  }
): string {
  const top = items[0];

  if (top?.kind === "risk") {
    return "Keep the guardrail locked first. Do not create risky actions.";
  }

  if (top?.kind === "email_review" && input.emailAttention.workActionCount > 0) {
    return "Start with the work-action Gmail review.";
  }

  if (top?.kind === "email_review" && input.emailAttention.jobSearchCount > 0) {
    return "Check the job-search Gmail review.";
  }

  if (top?.kind === "email_review") {
    return "Clear the waiting Gmail reviews.";
  }

  return pickOperatorNextStep({
    overdueActions: input.overdueActions,
    dueSoonActions: [],
    openActions: input.rankedOpenActions.map((item) => item.action),
    goalStatus: input.goalStatus,
    emailAttention: input.emailAttention,
    now: input.now
  });
}

function buildOperatorSuggestedReplies(emailAttention: OperatorEmailAttentionSummary): string[] {
  const replies = ["what should I handle first?", "show my tasks"];

  if (emailAttention.pendingCount > 0) {
    replies.unshift("show me the important emails");
    replies.push("email reviews");
  }

  return uniqueStrings(replies).slice(0, 4);
}

function attentionPriorityRank(priority: OperatorAttentionPriority): number {
  return priority === "critical" ? 4 : priority === "high" ? 3 : priority === "medium" ? 2 : 1;
}

function emailAttentionPriorityLine(input: Record<EmailReviewKind, number> & { pendingCount: number }): string {
  const parts = [
    input.work_action > 0 ? `${input.work_action} work-action email${input.work_action === 1 ? "" : "s"} may become task${input.work_action === 1 ? "" : "s"}` : undefined,
    input.job_search > 0 ? `${input.job_search} job-search email${input.job_search === 1 ? "" : "s"} waiting` : undefined,
    input.custom_tracking > 0 ? `${input.custom_tracking} custom tracking item${input.custom_tracking === 1 ? "" : "s"} waiting` : undefined,
    input.other > 0 ? `${input.other} other email review${input.other === 1 ? "" : "s"} waiting` : undefined
  ].filter(Boolean);

  return parts.join("; ") || `${input.pendingCount} Gmail review${input.pendingCount === 1 ? "" : "s"} waiting`;
}

function sanitizeShortEmailSubject(subject: string | undefined): string {
  return (subject ?? "Email review")
    .replace(/\b(accessToken|refreshToken|ciphertext|providerMessageId|raw)\b/gi, "[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 90);
}

function buildOperatorTopPriorities(input: {
  overdueActions: ActionItem[];
  dueSoonActions: ActionItem[];
  openActions: ActionItem[];
  goalStatus: DailyOperatorBriefGoalStatus[];
  risks: string[];
  emailAttention?: OperatorEmailAttentionSummary;
  priorityScores: DailyPriorityScore[];
}): string[] {
  const priorities: string[] = [];
  const seenActionIds = new Set<string>();
  const seenActionTitles = new Set<string>();
  const scoresByActionId = new Map(input.priorityScores.map((score) => [score.actionId, score]));
  const overdueActionIds = new Set(input.overdueActions.map((action) => action.id));
  const emailPriority = input.emailAttention && input.emailAttention.pendingCount > 0
    ? `Gmail reviews: ${input.emailAttention.userFacingLine ?? input.emailAttention.summary}`
    : undefined;
  let emailPriorityAdded = false;

  const addActionPriority = (action: ActionItem) => {
    const titleKey = normalizeManualActionTitleKey(action.title);

    if (seenActionIds.has(action.id) || seenActionTitles.has(titleKey)) {
      return;
    }

    seenActionIds.add(action.id);
    seenActionTitles.add(titleKey);
    priorities.push(formatPriorityAction(action, scoresByActionId.get(action.id)));
  };

  for (const action of input.openActions) {
    addActionPriority(action);

    if (!emailPriority || emailPriorityAdded) {
      continue;
    }

    const shouldInsertEmail =
      input.emailAttention?.priority === "high"
        ? overdueActionIds.has(action.id) || input.overdueActions.length === 0
        : input.emailAttention?.priority === "medium" && priorities.length >= 1;

    if (shouldInsertEmail) {
      priorities.push(emailPriority);
      emailPriorityAdded = true;
    }
  }

  if (emailPriority && !emailPriorityAdded) {
    priorities.push(emailPriority);
  }

  return uniqueStrings(priorities).slice(0, 3);
}

function pickOperatorNextStep(input: {
  overdueActions: ActionItem[];
  dueSoonActions: ActionItem[];
  openActions: ActionItem[];
  goalStatus: DailyOperatorBriefGoalStatus[];
  emailAttention?: OperatorEmailAttentionSummary;
  now: Date;
}): string {
  const topAction = input.openActions[0];
  if (topAction) {
    if (input.overdueActions.some((action) => action.id === topAction.id)) {
      return `Handle overdue action: ${topAction.title}.`;
    }

    if (topAction.dueAt && topAction.dueAt <= input.now) {
      return `Handle due action: ${topAction.title}.`;
    }

    return `Next upcoming action: ${topAction.title}.`;
  }

  if ((input.emailAttention?.workActionCount ?? 0) > 0) {
    return "Start with the work-action Gmail review.";
  }

  if ((input.emailAttention?.jobSearchCount ?? 0) > 0) {
    return "Check the job-search Gmail review.";
  }

  if ((input.emailAttention?.pendingCount ?? 0) > 0) {
    return "Clear the waiting Gmail reviews.";
  }

  const staleGoal = input.goalStatus.find((goal) => goal.status === "no_progress" && !isRiskControlGoalStatus(goal));
  if (staleGoal) {
    return `Log one concrete action for ${staleGoal.title}.`;
  }

  return "Log one meaningful action.";
}

function formatPriorityAction(action: ActionItem, score?: DailyPriorityScore): string {
  if (score?.factors.includes("overdue")) {
    return `Overdue: ${action.title}`;
  }

  if (score?.factors.some((factor) => factor.startsWith("due today") || factor === "due tomorrow morning" || factor === "due tomorrow")) {
    return `Due soon: ${action.title}`;
  }

  return action.title;
}

function buildGoalStatusToday(
  goal: Awaited<ReturnType<typeof getActiveGoals>>[number],
  todayEvents: StoredEvent[],
  openActions: ActionItem[],
  completedActions: ActionItem[]
) {
  const progressNote = goalProgressNoteForToday(goal, todayEvents);

  return {
    goalId: goal.id,
    hasProgressToday: progressNote !== "no progress logged today" || completedActions.some((action) => action.goalId === goal.id),
    hasCompletedActionToday: completedActions.some((action) => action.goalId === goal.id),
    hasOpenAction: openActions.some((action) => action.goalId === goal.id)
  };
}

function buildOperatorGoalStatus(
  goal: Awaited<ReturnType<typeof getActiveGoals>>[number],
  todayEvents: StoredEvent[],
  openActions: ActionItem[],
  completedActions: ActionItem[]
): DailyOperatorBriefGoalStatus {
  const openAction = openActions.find((action) => action.goalId === goal.id);
  const completedAction = completedActions.find((action) => action.goalId === goal.id);
  const progressNote = goalProgressNoteForToday(goal, todayEvents);
  const shouldShowProgressNote = progressNote !== "no progress logged today" || !completedAction;
  const note = [
    shouldShowProgressNote ? progressNote : undefined,
    completedAction ? `completed action: ${completedAction.title}` : undefined,
    openAction ? `open action: ${openAction.title}` : undefined
  ]
    .filter(Boolean)
    .join(", ");

  return {
    goalId: goal.id,
    title: goal.title,
    status: progressNote === "no progress logged today" && !completedAction ? "no_progress" : "progress",
    note,
    openActionTitle: openAction?.title,
    completedActionTitle: completedAction?.title
  };
}

function goalProgressNoteForToday(goal: Awaited<ReturnType<typeof getActiveGoals>>[number], events: StoredEvent[]): string {
  const templateId = goal.templateId ?? "";
  const category = goal.category;

  if (templateId === "career.job_search" || category === "career") {
    const applications = sumEventNumber(events, "career.application_sent", "count");
    const interviews = countEvent(events, "career.interview_scheduled");
    const replies = countEvent(events, "career.recruiter_reply_received");
    const parts = [
      applications > 0 ? `${applications} application${applications === 1 ? "" : "s"} sent today` : undefined,
      interviews > 0 ? `${interviews} interview${interviews === 1 ? "" : "s"} scheduled today` : undefined,
      replies > 0 ? `${replies} recruiter repl${replies === 1 ? "y" : "ies"} today` : undefined
    ].filter(Boolean);

    return parts.join(", ") || "no progress logged today";
  }

  if (templateId.includes("health") || category === "health") {
    const workouts = countEvent(events, "health.workout_completed");
    const steps = sumEventNumber(events, "health.steps_logged", "count");
    const parts = [
      workouts > 0 ? "training logged today" : undefined,
      steps > 0 ? `${steps} steps logged today` : undefined
    ].filter(Boolean);

    return parts.join(", ") || "no progress logged today";
  }

  if (templateId.includes("reading") || category === "learning") {
    const minutes = sumEventNumber(events, "learning.reading_session_completed", "duration_minutes");
    return minutes > 0 ? `${minutes} minutes reading today` : "no progress logged today";
  }

  if (templateId === "finance.control_betting_trading" || category === "finance") {
    const guardrails = events.filter((event) => event.type === "finance.betting.cooldown_triggered");

    if (guardrails.length > 0) {
      return "guardrail triggered today, no betting actions created";
    }

    return "no progress logged today";
  }

  const customLogs = events.filter((event) => event.type === "custom.goal_progress_logged" && event.data.goalId === goal.id);
  const focusedMinutes = customLogs.reduce((sum, event) => {
    const metricKey = typeof event.data.metricKey === "string" ? event.data.metricKey : "";
    const value = typeof event.data.value === "number" ? event.data.value : 0;
    return metricKey === "focused_minutes" || metricKey === "minutes" ? sum + value : sum;
  }, 0);

  if (customLogs.length > 0) {
    return focusedMinutes > 0
      ? `${customLogs.length} progress log${customLogs.length === 1 ? "" : "s"}, ${focusedMinutes} focused minutes`
      : `${customLogs.length} progress log${customLogs.length === 1 ? "" : "s"} today`;
  }

  return "no progress logged today";
}

function buildOperatorRecentWins(
  events: StoredEvent[],
  completedActions: ActionItem[],
  recentReviews: EmailReviewItem[],
  todayRange: ReturnType<typeof getLocalTodayRange>
): string[] {
  const wins = [
    ...completedActions.map((action) => `Completed action: ${action.title}`),
    sumEventNumber(events, "career.application_sent", "count") > 0
      ? `${sumEventNumber(events, "career.application_sent", "count")} application${sumEventNumber(events, "career.application_sent", "count") === 1 ? "" : "s"} sent`
      : undefined,
    countEvent(events, "health.workout_completed") > 0 ? "Training logged" : undefined,
    sumEventNumber(events, "learning.reading_session_completed", "duration_minutes") > 0
      ? `${sumEventNumber(events, "learning.reading_session_completed", "duration_minutes")} minutes reading`
      : undefined,
    countEvent(events, "custom.goal_progress_logged") > 0 ? `${countEvent(events, "custom.goal_progress_logged")} custom progress log${countEvent(events, "custom.goal_progress_logged") === 1 ? "" : "s"}` : undefined,
    recentReviews.some((review) => review.status === "approved" && isWithinLocalDay(review.reviewedAt, todayRange))
      ? "Email review approved today"
      : undefined
  ].filter(Boolean);

  return uniqueStrings(wins).slice(0, 5);
}

function buildOperatorRisks(events: StoredEvent[]): string[] {
  const risks = [];
  const cooldowns = countEvent(events, "finance.betting.cooldown_triggered");

  if (cooldowns > 0) {
    risks.push("Betting impulse detected recently. Do not open a bet today without cooldown.");
  }

  if (countEvent(events, "finance.betting.large_bet_detected") > 0) {
    risks.push("Large bet signal detected recently.");
  }

  if (countEvent(events, "finance.trading.large_loss_detected") > 0) {
    risks.push("Large trading loss detected recently.");
  }

  const latestAnxiety = latestEventNumber(events, "reflection.anxiety_logged", "value");
  const latestSleep = latestEventNumber(events, "health.sleep_logged", "duration_hours");
  const latestImpulse = latestImpulseValue(events);

  if (latestAnxiety !== undefined && latestAnxiety >= 7) {
    risks.push(`Anxiety is ${latestAnxiety}/10. Keep decisions smaller.`);
  }

  if (latestSleep !== undefined && latestSleep < 6) {
    risks.push(`Sleep is below 6h. No betting/trading decisions today.`);
  }

  if (latestImpulse !== undefined && latestImpulse >= 6) {
    risks.push(`Gambling/trading impulse is ${latestImpulse}/10. Do not act on it.`);
  }

  return uniqueStrings(risks).slice(0, 5);
}

function buildOperatorGuardrailWatchouts(activeGoals: Awaited<ReturnType<typeof getActiveGoals>>): string[] {
  return activeGoals
    .filter((goal) => isRiskControlGoal(goal))
    .map((goal) => `Risk-control goal active: ${goal.title}. Keep guardrail separate from normal task progress.`)
    .slice(0, 1);
}

function isRiskControlGoalStatus(goal: Pick<DailyOperatorBriefGoalStatus, "title">): boolean {
  return /\b(finance|betting|trading|gambling|impulse|risk|apuesta|apostar)\b/i.test(goal.title);
}

function toBriefAction(action: ActionItem): DailyOperatorBriefAction {
  return {
    id: action.id,
    title: action.title,
    status: action.status,
    priority: action.priority,
    dueAt: action.dueAt?.toISOString(),
    snoozedUntil: action.snoozedUntil?.toISOString(),
    goalId: action.goalId,
    goalTitle: action.goalTitleSnapshot
  };
}

function isSnoozedDue(action: ActionItem, now: Date): boolean {
  return action.status === "snoozed" && Boolean(action.snoozedUntil && action.snoozedUntil <= now);
}

function isActionDueSoon(action: ActionItem, now: Date): boolean {
  if (!action.dueAt) {
    return false;
  }

  const next24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  return action.dueAt >= now && action.dueAt <= next24h;
}

function countEvent(events: StoredEvent[], type: string): number {
  return events.filter((event) => event.type === type).length;
}

function sumEventNumber(events: StoredEvent[], type: string, key: string): number {
  return events
    .filter((event) => event.type === type)
    .reduce((sum, event) => sum + (typeof event.data[key] === "number" ? event.data[key] : 0), 0);
}

function latestEventNumber(events: StoredEvent[], type: string, key: string): number | undefined {
  const event = [...events]
    .filter((item) => item.type === type && typeof item.data[key] === "number")
    .sort((left, right) => right.timestamp.getTime() - left.timestamp.getTime())[0];

  return typeof event?.data[key] === "number" ? event.data[key] : undefined;
}

function latestImpulseValue(events: StoredEvent[]): number | undefined {
  const event = [...events]
    .filter(
      (item) =>
        item.type === "reflection.impulse_logged" &&
        typeof item.data.value === "number" &&
        (item.data.kind === "gambling" || item.data.kind === "trading")
    )
    .sort((left, right) => right.timestamp.getTime() - left.timestamp.getTime())[0];

  return typeof event?.data.value === "number" ? event.data.value : undefined;
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value && value.trim())))];
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

function formatLocalDateTime(date: Date | undefined, timezone = "Europe/Madrid"): string {
  if (!date) {
    return "not set";
  }

  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).format(date);
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

function getDateTimePart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((part) => part.type === type)?.value ?? "";
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

async function inferActionGoalLink(
  userId: string,
  actionTitle: string,
  actionDescription?: string,
  evidence?: string
) {
  return inferGoalLinkForAction({
    actionTitle,
    actionDescription,
    evidence,
    activeGoals: await getActiveGoals(userId)
  });
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

async function createGoalProgressFromCompletedAction(userId: string, actionItem: ActionItem) {
  if (!actionItem.goalId) {
    return undefined;
  }

  const goal = (await getGoals(userId)).find((item) => item.id === actionItem.goalId);
  const goalTitle = actionItem.goalTitleSnapshot ?? goal?.title ?? "Linked goal";
  const created = await createExternalEventIfNotExists(userId, {
    type: "custom.goal_progress_logged",
    source: "manual",
    provider: "action_completion",
    externalId: `action-completion:${actionItem.id}`,
    timestamp: actionItem.completedAt ?? new Date(),
    data: {
      goalId: actionItem.goalId,
      goalTitle,
      actionItemId: actionItem.id,
      actionTitle: actionItem.title,
      source: "action_completion"
    },
    confidence: 1,
    evidence: [`Completed action: ${actionItem.title}`]
  });

  return {
    ...created,
    goalTitle
  };
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

function looksLikeEmailRuleOrGmailConversationText(text: string): boolean {
  const hasEmailSurface = /\b(gmail|email|emails|mail|mails|inbox|correo|correos)\b/.test(text);
  const hasEmailRuleSurface = /\b(rule|rules|regla|reglas|checks?|tracking|track|watch|monitor)\b/.test(text);
  const hasEmailOperation =
    /\b(sync|check|connect|setup|set up|status|settings|configure|show|list|what|which|que|qué|delete|remove|clear|reset|archive|pause|resume|enable|activate|elimina|eliminar|borra|borrar|pausa|pausar|reanuda|reanudar|activa|activar)\b/.test(
      text
    );

  if ((hasEmailSurface || hasEmailRuleSurface) && hasEmailOperation) {
    return true;
  }

  return (
    /\b(endesa|aigues|aigües|barcelona)\b/.test(text) &&
    /\b(rule|rules|regla|reglas|email|emails|gmail|tracking|track|watch|monitor|delete|remove|clear|reset|archive|pause|resume|elimina|eliminar|borra|borrar|pausa|pausar)\b/.test(
      text
    )
  );
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

function sanitizeEmailReviewItem(item: EmailReviewItem) {
  return {
    ...item,
    evidence: item.evidence ? truncatePlainText(item.evidence, 500) : undefined,
    snippet: item.snippet ? truncatePlainText(item.snippet, 300) : undefined
  };
}

export function sanitizeActionItem(item: ActionItem) {
  return {
    ...item,
    evidence: item.evidence ? truncatePlainText(item.evidence, 500) : undefined,
    description: item.description ? truncatePlainText(item.description, 500) : undefined
  };
}

type EmailReviewKind = "job_search" | "work_action" | "custom_tracking" | "other";

interface EmailReviewInboxItem {
  number: number;
  reviewId: string;
  kind: EmailReviewKind;
  groupLabel: string;
  ruleName: string;
  trackingLabel: string;
  from?: string;
  subject?: string;
  snippet?: string;
  evidence?: string;
  proposedEventType?: string;
  proposedOutcome: string;
  goalTitle?: string;
  confidence: number;
  createdAt: string;
}

interface EmailReviewInboxResponse {
  pendingReviewCount: number;
  groups: Array<{
    kind: EmailReviewKind;
    label: string;
    count: number;
    reviews: EmailReviewInboxItem[];
  }>;
  reviews: EmailReviewInboxItem[];
  message: string;
}

type EmailReviewApprovalResult =
  | { status: "not_found" }
  | { status: "not_pending"; review: EmailReviewItem }
  | {
      status: "ok";
      emailReview: EmailReviewItem;
      event?: StoredEvent | null;
      actionItem?: ActionItem | null;
      message: string;
    };

async function buildEmailReviewInboxResponse(
  userId: string,
  options: { storeContext?: boolean; limit?: number } = {}
): Promise<EmailReviewInboxResponse> {
  const limit = options.limit ?? 10;
  const [pendingReviewCount, reviews, rules, goals, timezone] = await Promise.all([
    getPendingEmailReviewCount(userId),
    getEmailReviewItems(userId, { status: "pending", limit }),
    getEmailSignalRules(userId),
    getGoals(userId),
    getUserTimezone(userId)
  ]);
  const ruleById = new Map(rules.map((rule) => [rule.id, rule]));
  const goalById = new Map(goals.map((goal) => [goal.id, goal.title]));
  const orderedReviews = [...reviews].sort((left, right) => {
    const kindDelta = emailReviewKindSortIndex(emailReviewKind(left)) - emailReviewKindSortIndex(emailReviewKind(right));
    if (kindDelta !== 0) {
      return kindDelta;
    }

    const updatedDelta = right.updatedAt.getTime() - left.updatedAt.getTime();
    if (updatedDelta !== 0) {
      return updatedDelta;
    }

    return (left.subject ?? "").localeCompare(right.subject ?? "");
  });
  const items = orderedReviews.map((review, index) =>
    toEmailReviewInboxItem({
      review,
      number: index + 1,
      rule: ruleById.get(review.ruleId),
      goalById,
      timezone
    })
  );
  const groups = groupEmailReviewInboxItems(items);

  if (options.storeContext) {
    await replacePendingAction(userId, {
      type: "email_review_context",
      summary: `${pendingReviewCount} email review${pendingReviewCount === 1 ? "" : "s"} visible`,
      payload: {
        operation: "email_review_context",
        reviews: items,
        pendingReviewCount,
        visibleCount: items.length
      },
      expiresAt: pendingDecisionExpiry()
    });
  }

  return {
    pendingReviewCount,
    groups,
    reviews: items,
    message: formatEmailReviewInboxMessage(pendingReviewCount, groups)
  };
}

async function approveEmailReviewForUser(userId: string, reviewId: string): Promise<EmailReviewApprovalResult> {
  const review = await getEmailReviewItem(userId, reviewId);

  if (!review) {
    return { status: "not_found" };
  }

  if (review.status !== "pending") {
    if (review.status === "approved" && review.actionItemId) {
      const actionItem = await getActionItem(userId, review.actionItemId);

      if (actionItem) {
        return {
          status: "ok",
          emailReview: review,
          actionItem,
          event: null,
          message: `Email review already approved. Action item exists: ${actionItem.title}`
        };
      }
    }

    return { status: "not_pending", review };
  }

  if (isWorkActionReviewType(review.proposedEventType)) {
    const result = await createActionItemFromEmailReview(userId, review, {});
    const updated = await approveEmailReviewItem(userId, review.id, undefined, result.actionItem.id);

    return {
      status: "ok",
      emailReview: updated ?? review,
      actionItem: result.actionItem,
      event: null,
      message: `Email review approved. Action item ${result.created ? "created" : "already exists"}: ${result.actionItem.title}`
    };
  }

  if (review.adapterId === "custom_email_review") {
    const updated = await approveEmailReviewItem(userId, review.id);

    return {
      status: "ok",
      emailReview: updated ?? review,
      event: null,
      actionItem: null,
      message: "Custom email review approved. No event or action was created."
    };
  }

  if (!review.proposedEventType || !EventTypeSchema.safeParse(review.proposedEventType).success) {
    const updated = await approveEmailReviewItem(userId, review.id);

    return {
      status: "ok",
      emailReview: updated ?? review,
      event: null,
      actionItem: null,
      message: "This review item does not map to an approved event type yet. No event created."
    };
  }

  const eventExternalId = review.externalId.replace(/^gmail-review:/, "gmail:");
  const created = await createExternalEventIfNotExists(userId, {
    type: EventTypeSchema.parse(review.proposedEventType),
    timestamp: new Date(),
    source: "gmail",
    provider: "gmail",
    externalId: eventExternalId,
    data: {
      ...review.extracted,
      provider: "gmail",
      emailAdapterId: review.adapterId,
      adapterId: review.adapterId === "job_search_email" ? "job_search_text" : review.adapterId,
      classification: review.reason,
      ruleId: review.ruleId,
      gmailMessageId: review.providerMessageId,
      subject: review.subject,
      from: review.from,
      snippet: review.snippet,
      confidence: review.confidence,
      reason: review.reason,
      reviewItemId: review.id,
      externalId: eventExternalId
    },
    confidence: review.confidence,
    evidence: review.evidence ? [review.evidence] : undefined
  });
  const updated = await approveEmailReviewItem(userId, review.id, created.event.id);

  return {
    status: "ok",
    emailReview: updated ?? review,
    event: created.event,
    actionItem: null,
    message: created.created ? "Email review approved and event created." : "Email review approved. Event already existed."
  };
}

async function createActionItemFromEmailReview(
  userId: string,
  review: EmailReviewItem,
  options: { dueText?: string; now?: Date } = {}
): Promise<{ created: boolean; actionItem: ActionItem }> {
  const actionInput = actionItemInputFromEmailReview(review);
  const dueAt = await parseEmailReviewActionDueAt(userId, options.dueText, options.now);

  if (dueAt) {
    actionInput.dueAt = dueAt;
  }

  const rule = (await getEmailSignalRules(userId)).find((item) => item.id === review.ruleId);
  const goals = await getGoals(userId);
  const linkedGoal = rule?.goalId ? goals.find((goal) => goal.id === rule.goalId && goal.status === "active") : undefined;

  if (linkedGoal) {
    actionInput.goalId = linkedGoal.id;
    actionInput.goalSlug = linkedGoal.templateId ?? undefined;
    actionInput.goalTitleSnapshot = linkedGoal.title;
  } else {
    const goalLink = await inferActionGoalLink(userId, actionInput.title, actionInput.description, actionInput.evidence);
    actionInput.goalId = goalLink.goalId ?? undefined;
    actionInput.goalSlug = goalLink.goalSlug ?? undefined;
    actionInput.goalTitleSnapshot = goalLink.matchedGoalTitle;
  }

  return createActionItemIfNotExists(userId, actionInput);
}

async function parseEmailReviewActionDueAt(userId: string, dueText: string | undefined, now = new Date()): Promise<Date | undefined> {
  if (!dueText?.trim()) {
    return undefined;
  }

  const settings = await getOrCreateNotificationSettings(userId);
  const parsed = parseActionDueDate(dueText, {
    now,
    timezone: settings.timezone,
    preferences: settings
  });

  if (parsed.invalidReason === "past_explicit_time") {
    throw new Error("That time has already passed. Use a future time, or say 'now'.");
  }

  return parsed.dueAt ?? undefined;
}

async function rejectEmailReviewForUser(userId: string, reviewId: string): Promise<{ status: "not_found" | "ok"; review?: EmailReviewItem; message: string }> {
  const review = await rejectEmailReviewItem(userId, reviewId);

  if (!review) {
    return { status: "not_found", message: "Email review item not found" };
  }

  return {
    status: "ok",
    review,
    message: review.status === "rejected" ? "Email review rejected." : `Email review item is already ${review.status}.`
  };
}

async function resolveEmailReviewContextReply(
  userId: string,
  pendingAction: PendingAction,
  message: string
): Promise<string | undefined> {
  if (looksLikeEmailReviewInboxRequest(message)) {
    return (await buildEmailReviewInboxResponse(userId, { storeContext: true })).message;
  }

  const parsed = parseEmailReviewContextReply(message);

  if (!parsed) {
    return undefined;
  }

  if (parsed.operation === "cancel") {
    await rejectPendingAction(userId, pendingAction.id);
    return "Cancelled. I did not change anything.";
  }

  const items = readEmailReviewContextItems(pendingAction.payload.reviews);

  if (items.length === 0) {
    await rejectPendingAction(userId, pendingAction.id);
    return "No pending email reviews are visible right now. Run \"email reviews\" after Gmail finds reviews.";
  }

  if (parsed.operation === "show") {
    const item = selectEmailReviewContextItem(parsed.target, items);
    if (!item) {
      return emailReviewSelectionPrompt(items);
    }

    return formatEmailReviewDetailsForContext(userId, item.reviewId);
  }

  if (parsed.operation === "approve" || parsed.operation === "reject") {
    const lastHandledReviewIds = readEmailReviewContextHandledReviewIds(pendingAction.payload);
    const selectedItems = selectEmailReviewContextItems(parsed.target, items, parsed.bulk);

    if (selectedItems.status === "ambiguous") {
      return selectedItems.message;
    }

    const itemsToHandle = parsed.bulk && emailReviewTargetMentionsRest(parsed.target)
      ? selectedItems.items.filter((item) => !lastHandledReviewIds.has(item.reviewId))
      : selectedItems.items;

    if (itemsToHandle.length === 0) {
      return emailReviewSelectionPrompt(items);
    }

    const replies: string[] = [];
    const alreadyHandled: string[] = [];
    const handledReviewIds: string[] = [];

    for (const item of itemsToHandle) {
      const review = await getEmailReviewItem(userId, item.reviewId);

      if (!review) {
        alreadyHandled.push(`${item.number}: ${item.subject ?? item.ruleName} (not found)`);
        continue;
      }

      if (review.status !== "pending") {
        alreadyHandled.push(`${item.number}: ${item.subject ?? item.ruleName} (${review.status})`);
        continue;
      }

      if (parsed.operation === "approve") {
        const result = await approveEmailReviewForUser(userId, item.reviewId);
        replies.push(formatEmailReviewApprovalContextReply(result, item));
      } else {
        const result = await rejectEmailReviewForUser(userId, item.reviewId);
        replies.push(result.status === "ok" ? `Rejected ${item.number}: ${item.subject ?? item.ruleName}` : `Skipped ${item.number}: not found`);
      }

      handledReviewIds.push(item.reviewId);
    }

    await rememberEmailReviewContextHandled(userId, pendingAction, handledReviewIds);
    await closeEmailReviewContextIfDone(userId, pendingAction);

    return formatEmailReviewBulkContextReply(replies, alreadyHandled);
  }

  if (parsed.operation === "action") {
    const item = selectEmailReviewContextItem(parsed.target, items);
    if (!item) {
      return emailReviewSelectionPrompt(items);
    }

    const review = await getEmailReviewItem(userId, item.reviewId);
    if (!review) {
      return "I could not find that email review anymore. Run \"email reviews\" again.";
    }

    if (review.status !== "pending") {
      return `That email review is already ${review.status}. Run "email reviews" again.`;
    }

    try {
      const result = await createActionItemFromEmailReview(userId, review, { dueText: parsed.timeText });
      const updated = await approveEmailReviewItem(userId, review.id, undefined, result.actionItem.id);
      await rememberEmailReviewContextHandled(userId, pendingAction, [review.id]);
      await closeEmailReviewContextIfDone(userId, pendingAction);
      return [
        `Action ${result.created ? "created" : "already exists"} from email review: ${result.actionItem.title}`,
        result.actionItem.dueAt ? `due: ${formatLocalDateTime(result.actionItem.dueAt, await getUserTimezone(userId))}` : undefined,
        updated ? "Email review marked approved." : undefined
      ].filter(Boolean).join("\n");
    } catch (error) {
      return safeErrorForLog(error);
    }
  }

  return undefined;
}

function toEmailReviewInboxItem(input: {
  review: EmailReviewItem;
  number: number;
  rule?: EmailSignalRule;
  goalById: Map<string, string>;
  timezone: string;
}): EmailReviewInboxItem {
  const kind = emailReviewKind(input.review);
  const ruleName = input.rule?.name ?? "Gmail tracking";
  const goalTitle = input.rule?.goalId ? input.goalById.get(input.rule.goalId) : undefined;

  return {
    number: input.number,
    reviewId: input.review.id,
    kind,
    groupLabel: emailReviewGroupLabel(kind),
    ruleName,
    trackingLabel: emailReviewTrackingLabel(input.review),
    from: input.review.from ? truncatePlainText(input.review.from, 100) : undefined,
    subject: input.review.subject ? truncatePlainText(input.review.subject, 100) : undefined,
    snippet: input.review.snippet ? truncatePlainText(input.review.snippet, 180) : undefined,
    evidence: input.review.evidence ? truncatePlainText(input.review.evidence, 180) : undefined,
    proposedEventType: input.review.proposedEventType,
    proposedOutcome: emailReviewProposedOutcome(input.review),
    goalTitle,
    confidence: input.review.confidence,
    createdAt: formatLocalDateTime(input.review.createdAt, input.timezone)
  };
}

function groupEmailReviewInboxItems(items: EmailReviewInboxItem[]) {
  const order: EmailReviewKind[] = ["job_search", "work_action", "custom_tracking", "other"];

  return order
    .map((kind) => {
      const reviews = items.filter((item) => item.kind === kind);
      return {
        kind,
        label: emailReviewGroupLabel(kind),
        count: reviews.length,
        reviews
      };
    })
    .filter((group) => group.count > 0);
}

function emailReviewKindSortIndex(kind: EmailReviewKind): number {
  const order: EmailReviewKind[] = ["job_search", "work_action", "custom_tracking", "other"];
  const index = order.indexOf(kind);
  return index === -1 ? order.length : index;
}

function formatEmailReviewInboxMessage(pendingReviewCount: number, groups: EmailReviewInboxResponse["groups"]): string {
  if (pendingReviewCount === 0) {
    return "No email reviews are waiting.";
  }

  const lines = [`Email reviews waiting: ${pendingReviewCount}`];

  for (const group of groups) {
    lines.push("", `${group.label}:`);

    for (const item of group.reviews) {
      lines.push(
        `${item.number}. ${item.subject ?? item.ruleName} - ${senderOrRuleLabel(item)} - ${item.createdAt}`,
        `   Proposed: ${item.proposedOutcome}`,
        item.kind === "custom_tracking"
          ? `   Say "show ${item.number}", "reject ${item.number}", or "turn ${item.number} into an action".`
          : `   Say "approve ${item.number}" or "reject ${item.number}".`
      );
    }
  }

  if (pendingReviewCount > visibleEmailReviewCount(groups)) {
    lines.push("", `Showing ${visibleEmailReviewCount(groups)}. Run /email_reviews all for recent handled items with IDs.`);
  }

  return lines.join("\n");
}

function visibleEmailReviewCount(groups: EmailReviewInboxResponse["groups"]): number {
  return groups.reduce((count, group) => count + group.reviews.length, 0);
}

function senderOrRuleLabel(item: EmailReviewInboxItem): string {
  const sender = item.from ? extractSafeSenderLabel(item.from) : "";
  return sender || item.ruleName;
}

function extractSafeSenderLabel(value: string): string {
  const withoutEmail = value.replace(/<[^>]+>/g, "").replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, "").trim();
  return truncatePlainText(withoutEmail || value, 80);
}

async function formatEmailReviewDetailsForContext(userId: string, reviewId: string): Promise<string> {
  const review = await getEmailReviewItem(userId, reviewId);

  if (!review) {
    return "I could not find that email review anymore. Run \"email reviews\" again.";
  }

  const rule = (await getEmailSignalRules(userId)).find((item) => item.id === review.ruleId);
  const goal = rule?.goalId ? (await getGoals(userId)).find((item) => item.id === rule.goalId) : undefined;

  return [
    `Email review: ${review.subject ?? rule?.name ?? "Gmail item"}`,
    review.from ? `From: ${truncatePlainText(review.from, 120)}` : undefined,
    `Tracking: ${emailReviewTrackingLabel(review)}`,
    rule ? `Rule: ${rule.name}` : undefined,
    goal ? `Linked goal: ${goal.title}` : undefined,
    `Proposed: ${emailReviewProposedOutcome(review)}`,
    `Reason: ${truncatePlainText(review.reason, 160)}`,
    review.snippet ? `Preview: ${truncatePlainText(review.snippet, 260)}` : undefined,
    review.evidence ? `Evidence: ${truncatePlainText(review.evidence, 260)}` : undefined
  ].filter(Boolean).join("\n");
}

function emailReviewKind(review: EmailReviewItem): EmailReviewKind {
  if (review.adapterId === "job_search_email") {
    return "job_search";
  }

  if (review.adapterId === "work_action_email") {
    return "work_action";
  }

  if (review.adapterId === "custom_email_review") {
    return "custom_tracking";
  }

  return "other";
}

function emailReviewGroupLabel(kind: EmailReviewKind): string {
  if (kind === "job_search") {
    return "Job-search";
  }

  if (kind === "work_action") {
    return "Work actions";
  }

  if (kind === "custom_tracking") {
    return "Custom tracking";
  }

  return "Other";
}

function emailReviewTrackingLabel(review: EmailReviewItem): string {
  if (review.adapterId === "job_search_email") {
    return "job-search email tracking";
  }

  if (review.adapterId === "work_action_email") {
    return "work-action email tracking";
  }

  if (review.adapterId === "custom_email_review") {
    return "custom Gmail tracking";
  }

  return "Gmail tracking";
}

function emailReviewProposedOutcome(review: EmailReviewItem): string {
  if (isWorkActionReviewType(review.proposedEventType)) {
    return "create action";
  }

  if (review.adapterId === "custom_email_review") {
    return "review only";
  }

  if (review.proposedEventType && EventTypeSchema.safeParse(review.proposedEventType).success) {
    return `log ${humanEmailReviewEventLabel(review.proposedEventType)}`;
  }

  return review.proposedEventType ? "review only" : "unknown";
}

function humanEmailReviewEventLabel(eventType: string): string {
  const labels: Record<string, string> = {
    "career.application_confirmation_received": "application confirmation",
    "career.recruiter_reply_received": "recruiter reply",
    "career.interview_scheduled": "interview event",
    "career.rejection_received": "rejection",
    "career.offer_received": "job offer"
  };

  return labels[eventType] ?? "event";
}

function readEmailReviewContextItems(value: unknown): EmailReviewInboxItem[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isRecord)
    .map((item) => ({
      number: typeof item.number === "number" ? item.number : Number(item.number),
      reviewId: typeof item.reviewId === "string" ? item.reviewId : "",
      kind: normalizeEmailReviewKind(typeof item.kind === "string" ? item.kind : ""),
      groupLabel: typeof item.groupLabel === "string" ? item.groupLabel : "Other",
      ruleName: typeof item.ruleName === "string" ? item.ruleName : "Gmail tracking",
      trackingLabel: typeof item.trackingLabel === "string" ? item.trackingLabel : "Gmail tracking",
      from: typeof item.from === "string" ? item.from : undefined,
      subject: typeof item.subject === "string" ? item.subject : undefined,
      snippet: typeof item.snippet === "string" ? item.snippet : undefined,
      evidence: typeof item.evidence === "string" ? item.evidence : undefined,
      proposedEventType: typeof item.proposedEventType === "string" ? item.proposedEventType : undefined,
      proposedOutcome: typeof item.proposedOutcome === "string" ? item.proposedOutcome : "unknown",
      goalTitle: typeof item.goalTitle === "string" ? item.goalTitle : undefined,
      confidence: typeof item.confidence === "number" ? item.confidence : 0,
      createdAt: typeof item.createdAt === "string" ? item.createdAt : ""
    }))
    .filter((item) => Number.isFinite(item.number) && item.number > 0 && item.reviewId);
}

function readEmailReviewContextHandledReviewIds(payload: unknown): Set<string> {
  if (!isRecord(payload) || !Array.isArray(payload.lastHandledReviewIds)) {
    return new Set();
  }

  return new Set(payload.lastHandledReviewIds.filter((value): value is string => typeof value === "string" && value.length > 0));
}

async function rememberEmailReviewContextHandled(
  userId: string,
  pendingAction: PendingAction,
  reviewIds: string[]
): Promise<void> {
  if (reviewIds.length === 0 || !isRecord(pendingAction.payload)) {
    return;
  }

  const handledIds = uniqueStrings([...readEmailReviewContextHandledReviewIds(pendingAction.payload), ...reviewIds]);
  await prisma.pendingAction.updateMany({
    where: {
      id: pendingAction.id,
      userId,
      status: "pending"
    },
    data: {
      payload: {
        ...pendingAction.payload,
        lastHandledReviewIds: handledIds
      }
    }
  });
}

function emailReviewTargetMentionsRest(target: string): boolean {
  return /\b(rest|remaining|left|the rest|los dem[aá]s|las dem[aá]s|el resto|la resta)\b/i.test(target);
}

function formatEmailReviewBulkContextReply(changed: string[], alreadyHandled: string[]): string {
  const lines: string[] = [];

  if (changed.length > 0) {
    lines.push(...changed);
  } else if (alreadyHandled.length > 0) {
    lines.push("No pending matching reviews changed.");
  }

  if (alreadyHandled.length > 0) {
    lines.push("Already handled:");
    lines.push(...alreadyHandled.map((line) => `- ${line}`));
  }

  return lines.join("\n");
}

function normalizeEmailReviewKind(value: string): EmailReviewKind {
  return value === "job_search" || value === "work_action" || value === "custom_tracking" ? value : "other";
}

function parseEmailReviewContextReply(message: string):
  | { operation: "cancel" }
  | { operation: "show"; target: string }
  | { operation: "approve" | "reject"; target: string; bulk: boolean }
  | { operation: "action"; target: string; timeText?: string }
  | undefined {
  const trimmed = message.trim();
  const text = normalizeForComparison(trimmed);

  if (!trimmed) {
    return undefined;
  }

  if (isRejectionMessage(trimmed) || /^(cancel|cancelar|cancela|stop)$/i.test(trimmed)) {
    return { operation: "cancel" };
  }

  const showMatch = trimmed.match(/^(?:show|details?(?:\s+for)?|what\s+is|explain|muestra|ensen(?:a|ame)|ens[eé]ñ(?:a|ame)|detalles?(?:\s+de)?|que\s+es|qué\s+es)\s+(.+)$/i);
  if (showMatch?.[1] && extractEmailReviewReference(showMatch[1])) {
    return { operation: "show", target: showMatch[1].trim() };
  }

  const approveBulk = trimmed.match(/^(?:approve|accept|ok|yes|aprueba|acepta)\s+all(?:\s+(.+))?$/i);
  if (approveBulk) {
    return { operation: "approve", target: cleanEmailReviewBulkTarget(approveBulk[1]) || "all", bulk: true };
  }

  const rejectBulk = trimmed.match(/^(?:reject|clear|dismiss|no|rechaza|descarta|borra|limpia)\s+all(?:\s+(.+))?$/i);
  if (rejectBulk) {
    return { operation: "reject", target: cleanEmailReviewBulkTarget(rejectBulk[1]) || "all", bulk: true };
  }

  const approveMatch = trimmed.match(/^(?:approve\s+review|approve|accept|yes\s+to|ok\s+to|aprueba|acepta|si\s+a|sí\s+a)\s+(.+)$/i);
  if (approveMatch?.[1]) {
    return { operation: "approve", target: approveMatch[1].trim(), bulk: false };
  }

  const rejectMatch = trimmed.match(/^(?:reject\s+review|reject|no\s+to|dismiss|clear|rechaza|descarta|no\s+a)\s+(.+)$/i);
  if (rejectMatch?.[1]) {
    return { operation: "reject", target: rejectMatch[1].trim(), bulk: false };
  }

  const actionNumber = extractEmailReviewActionReference(trimmed);
  if (actionNumber) {
    return {
      operation: "action",
      target: actionNumber,
      timeText: extractEmailReviewActionTimeText(trimmed)
    };
  }

  if (/^#?\d+$/.test(trimmed) || ordinalSelectionIndex(trimmed) !== undefined) {
    return { operation: "show", target: trimmed };
  }

  if (/\b(email|gmail|correo|correu|review|revision|revisi[oó])\b/.test(text) && /\b(approve|reject|show|details|action|task|aprueba|rechaza|muestra|tarea)\b/.test(text)) {
    return { operation: "show", target: trimmed };
  }

  return undefined;
}

function cleanEmailReviewBulkTarget(value: string | undefined): string {
  if (!value) {
    return "";
  }

  return value
    .trim()
    .replace(/\s+(?:reviews?|items?|correos?|correus?)$/i, "")
    .trim();
}

function extractEmailReviewReference(message: string): string | undefined {
  const numeric = message.match(/(?:^|\s)#?(\d+)(?:\b|$)/);
  if (numeric?.[1]) {
    return numeric[1];
  }

  const ordinal = ordinalSelectionIndex(message);
  return ordinal !== undefined ? String(ordinal + 1) : undefined;
}

function extractEmailReviewActionReference(message: string): string | undefined {
  const trimmed = message.trim();
  const patterns = [
    /\b(?:turn|make|convert)\s+(?:review\s+|email\s+review\s+)?#?(\d+)\s+(?:into|to)\s+(?:an?\s+|the\s+)?(?:action|task|reminder)\b/i,
    /\b(?:turn|make|convert)\s+(?:review\s+|email\s+review\s+)?#?(\d+)\s+(?:an?\s+|the\s+)?(?:action|task|reminder)\b/i,
    /\b(?:create|make|add|haz|crea)\s+(?:an?\s+)?(?:action|task|tarea|reminder)\s+(?:from|for|about|de|para|sobre)\s+(?:review\s+|email\s+review\s+)?#?(\d+)\b/i,
    /\b(?:remind|reminder|recorda|recordam|recu[eé]rdame|recordarme)\b.*\b(?:about|for|de|para|sobre)\s+(?:review\s+|email\s+review\s+)?#?(\d+)\b/i
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  const ordinal = ordinalSelectionIndex(trimmed);
  if (
    ordinal !== undefined &&
    /\b(?:turn|make|convert|create|add|action|task|remind|reminder|haz|crea|tarea|recorda|recordam|recu[eé]rdame|recordarme)\b/i.test(trimmed)
  ) {
    return String(ordinal + 1);
  }

  return undefined;
}

function extractEmailReviewActionTimeText(message: string): string | undefined {
  const match = message.match(/\b(now|today.*|tomorrow.*|tonight.*|in\s+\d+\s+days?|next\s+\w+.*|\d{4}-\d{2}-\d{2}.*)$/i);
  return match?.[1]?.trim();
}

function selectEmailReviewContextItem(target: string, items: EmailReviewInboxItem[]): EmailReviewInboxItem | undefined {
  const selected = selectEmailReviewContextItems(target, items, false);
  return selected.status === "ok" && selected.items.length === 1 ? selected.items[0] : undefined;
}

function selectEmailReviewContextItems(
  target: string,
  items: EmailReviewInboxItem[],
  bulk: boolean
): { status: "ok"; items: EmailReviewInboxItem[] } | { status: "ambiguous"; message: string } {
  const trimmed = target.trim().replace(/[?.!]+$/g, "");
  const numeric = trimmed.match(/^#?(\d+)$/);

  if (numeric) {
    const index = Number(numeric[1]);
    return { status: "ok", items: items.filter((item) => item.number === index) };
  }

  const ordinalIndex = ordinalSelectionIndex(trimmed);
  if (ordinalIndex !== undefined) {
    return { status: "ok", items: items.filter((item) => item.number === ordinalIndex + 1) };
  }

  const text = normalizeForComparison(trimmed);
  const matchText = cleanEmailReviewSelectionTarget(trimmed);

  if (bulk && (text === "all" || text === "all reviews" || text === "todos" || text === "todas" || text === "tots" || text === "totes")) {
    const kinds = new Set(items.map((item) => item.kind));
    if (kinds.size === 1) {
      return { status: "ok", items };
    }

    return {
      status: "ambiguous",
      message: "Which group do you mean? Try: approve all job-search reviews, reject all custom reviews, or reject all Endesa reviews."
    };
  }

  const kind = emailReviewKindFromTarget(text);
  if (kind) {
    return { status: "ok", items: items.filter((item) => item.kind === kind) };
  }

  const matches = items.filter((item) => emailReviewContextItemMatches(item, matchText || text));
  if (!bulk && matches.length > 1) {
    return {
      status: "ambiguous",
      message: [
        "Which email review do you mean?",
        ...matches.slice(0, 5).map((item) => `${item.number}. ${item.subject ?? item.ruleName}`)
      ].join("\n")
    };
  }

  return { status: "ok", items: matches };
}

function cleanEmailReviewSelectionTarget(target: string): string {
  return normalizeForComparison(target)
    .replace(/\b(the|rest|remaining|left|all|reviews?|items?|emails?|email|gmail|mail|mails|correos?|correus?|from|about|for|de|del|dels|para|sobre)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function emailReviewKindFromTarget(text: string): EmailReviewKind | undefined {
  if (/\b(job|career|recruiter|application|interview|trabajo|feina)\b/.test(text)) {
    return "job_search";
  }

  if (/\b(work|action|deadline|client|project|trabajo|feina|tasca)\b/.test(text)) {
    return "work_action";
  }

  if (/\b(custom|tracking|personalizado|personalitzada)\b/.test(text)) {
    return "custom_tracking";
  }

  return undefined;
}

function emailReviewContextItemMatches(item: EmailReviewInboxItem, targetKey: string): boolean {
  if (!targetKey) {
    return false;
  }

  const haystack = normalizeForComparison([
    item.ruleName,
    item.subject,
    item.from,
    item.trackingLabel,
    item.groupLabel,
    item.goalTitle
  ].filter(Boolean).join(" "));

  return haystack.includes(targetKey) || targetKey.includes(normalizeForComparison(item.ruleName));
}

function emailReviewSelectionPrompt(items: EmailReviewInboxItem[]): string {
  return items.length > 0
    ? `Reply with 1-${items.length}, a visible subject, or run "email reviews" again.`
    : "Run \"email reviews\" again so I can number the visible items safely.";
}

function formatEmailReviewApprovalContextReply(result: EmailReviewApprovalResult, item: EmailReviewInboxItem): string {
  if (result.status === "not_found") {
    return `Skipped ${item.number}: not found`;
  }

  if (result.status === "not_pending") {
    return `Skipped ${item.number}: already ${result.review.status}`;
  }

  return `Approved ${item.number}: ${result.message.replace(/^Email review approved\.?\s*/i, "")}`;
}

async function closeEmailReviewContextIfDone(userId: string, pendingAction: PendingAction): Promise<void> {
  const items = readEmailReviewContextItems(pendingAction.payload.reviews);
  const statuses = await Promise.all(items.map((item) => getEmailReviewItem(userId, item.reviewId)));
  const hasPendingVisibleItem = statuses.some((item) => item?.status === "pending");

  if (!hasPendingVisibleItem) {
    await confirmPendingAction(userId, pendingAction.id);
  }
}

function isPendingEmailReviewContext(pendingAction: PendingAction | undefined): boolean {
  return Boolean(
    pendingAction &&
      pendingAction.status === "pending" &&
      pendingAction.type === "email_review_context" &&
      isRecord(pendingAction.payload) &&
      pendingAction.payload.operation === "email_review_context"
  );
}

function looksLikeEmailReviewInboxRequest(message: string): boolean {
  const text = normalizeForComparison(message);

  return (
    /^(email reviews?|gmail reviews?|emails? to review|show email reviews?|show gmail reviews?)$/.test(text) ||
    /\b(what|which|any|show|review|revisa|mostra|ensenya|quins?|que|qué)\b.*\b(email|emails|gmail|correo|correos|correu|correus)\b.*\b(review|approval|pending|waiting|pendientes?|pendents?|revisar|aprobaci[oó]n)\b/.test(text) ||
    /\b(correos pendientes|correus pendents|emails waiting|gmail items need review|emails need review|needs email approval)\b/.test(text)
  );
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

function looksLikeEmailReviewContextAction(message: string): boolean {
  const trimmed = message.trim();

  if (!trimmed) {
    return false;
  }

  if (/^#?\d+$/.test(trimmed) || ordinalSelectionIndex(trimmed) !== undefined) {
    return true;
  }

  return (
    /^(?:show|details?(?:\s+for)?|what\s+is|explain|muestra|detalles?(?:\s+de)?|que\s+es|qué\s+es)\s+#?\d+[?.!]?$/i.test(trimmed) ||
    /^(?:approve\s+review|approve|accept|yes\s+to|ok\s+to|aprueba|acepta|si\s+a|sí\s+a)\s+(?:#?\d+|all\b.*|job|job-search|work|custom|endesa|aigues|aigües)/i.test(trimmed) ||
    /^(?:reject\s+review|reject|no\s+to|dismiss|clear|rechaza|descarta|no\s+a)\s+(?:#?\d+|all\b.*|job|job-search|work|custom|endesa|aigues|aigües)/i.test(trimmed) ||
    Boolean(extractEmailReviewActionReference(trimmed))
  );
}

async function getPendingEmailReviewCount(userId: string): Promise<number> {
  await ensureUser(userId);
  return prisma.emailReviewItem.count({
    where: {
      userId,
      status: "pending"
    }
  });
}

function pendingEmailReviewLine(count: number): string | undefined {
  return count > 0
    ? `${count} email review${count === 1 ? "" : "s"} ${count === 1 ? "is" : "are"} waiting. Say "email reviews" to handle ${count === 1 ? "it" : "them"}.`
    : undefined;
}

function appendPendingEmailReviewLine(message: string, count: number): string {
  return [message, pendingEmailReviewLine(count)].filter(Boolean).join("\n\n");
}

function isWorkActionReviewType(type?: string): type is NonNullable<ActionItem["actionType"]> {
  return (
    type === "work_action_required" ||
    type === "work_deadline_detected" ||
    type === "work_follow_up_requested" ||
    type === "work_project_update_detected"
  );
}

function actionItemInputFromEmailReview(review: EmailReviewItem): CreateActionItemInput {
  const extracted = review.extracted ?? {};
  const project = stringValue(extracted.project);
  const title = buildActionTitle(review, project);

  return {
    source: "email_review",
    sourceId: review.id,
    sourceProvider: review.provider,
    sourceRuleId: review.ruleId,
    title,
    description: buildActionDescription(review),
    priority: "medium",
    dueAt: parseActionDueAt(extracted.deadline),
    project,
    actionType: isWorkActionReviewType(review.proposedEventType) ? review.proposedEventType : "generic",
    evidence: review.evidence ?? review.snippet
  };
}

function buildActionTitle(review: EmailReviewItem, project?: string): string {
  const subject = cleanEmailFragment(review.subject ?? "");
  const bodyText = cleanEmailFragment(extractBodyLikeText(review.evidence) || review.snippet || "");
  const subjectAction = actionTitleFromText(subject);

  if (subjectAction && !/^follow up on\b/i.test(subjectAction)) {
    return subjectAction;
  }

  const bodyAction = actionTitleFromText(bodyText);

  if (bodyAction) {
    return bodyAction;
  }

  if (subjectAction) {
    return subjectAction;
  }

  if (project) {
    return `Follow up on ${cleanActionPhrase(project)}`;
  }

  return cleanActionPhrase(review.subject ?? "Review work action");
}

function buildActionDescription(review: EmailReviewItem): string | undefined {
  const text = cleanEmailFragment(`${extractBodyLikeText(review.evidence) || review.evidence || ""} ${review.snippet ?? ""}`);

  if (/send (?:me |us )?any issues/i.test(text)) {
    return "Send any issues found.";
  }

  return text.trim() ? truncatePlainText(text, 240) : undefined;
}

function parseActionDueAt(value: unknown): Date | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }

  const dueAt = new Date(value);
  return Number.isNaN(dueAt.getTime()) ? undefined : dueAt;
}

function cleanActionPhrase(value: string): string {
  const cleaned = value
    .replace(/&[a-z0-9#]+;/gi, " ")
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, " ")
    .replace(/\b(?:subject|from|snippet|body):.*$/i, "")
    .replace(/\s+/g, " ")
    .replace(/^follow up on\s+/i, "")
    .replace(/^the\s+/i, "")
    .trim();

  if (!cleaned) {
    return "Review work action";
  }

  const capped = truncatePlainText(cleaned, 80);
  return `${capped.charAt(0).toUpperCase()}${capped.slice(1)}`;
}

function cleanActionObject(value: string): string {
  const cleaned = value
    .replace(/&[a-z0-9#]+;/gi, " ")
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, " ")
    .replace(/\b(?:subject|from|snippet|body):.*$/i, "")
    .replace(/\s+/g, " ")
    .replace(/^the\s+/i, "")
    .trim();

  return truncatePlainText(cleaned || "work action", 73);
}

function actionTitleFromText(text: string): string | undefined {
  const clean = cleanEmailFragment(text);

  if (!clean) {
    return undefined;
  }

  const reviewMatch = clean.match(/\b(?:please\s+)?review (?:the )?(.+?)(?:\s+by\b|\s+and\b|[.!?]|$)/i);

  if (reviewMatch?.[1]) {
    return `Review ${cleanActionObject(reviewMatch[1])}`;
  }

  const canReviewMatch = clean.match(/\bcan you review (?:the )?(.+?)(?:\s+by\b|\s+and\b|[.!?]|$)/i);

  if (canReviewMatch?.[1]) {
    return `Review ${cleanActionObject(canReviewMatch[1])}`;
  }

  const sendMatch = clean.match(/\b(?:please\s+)?send (?:me |us )?(.+?)(?:\s+by\b|\s+and\b|[.!?]|$)/i);

  if (sendMatch?.[1]) {
    return `Send ${cleanActionObject(sendMatch[1])}`;
  }

  const followUpMatch = clean.match(/\bfollow up on (.+?)(?:\s+by\b|[.!?]|$)/i);

  if (followUpMatch?.[1]) {
    return `Follow up on ${cleanActionObject(followUpMatch[1])}`;
  }

  return undefined;
}

function extractBodyLikeText(text?: string): string | undefined {
  if (!text) {
    return undefined;
  }

  const bodyMatch = text.match(/\bBody:\s*([\s\S]*)/i);

  if (bodyMatch?.[1]) {
    return bodyMatch[1];
  }

  const lines = text
    .split(/\r?\n/)
    .filter((line) => !/^\s*(subject|from|snippet):/i.test(line));

  return lines.join("\n");
}

function cleanEmailFragment(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, " ")
    .replace(/\b(?:subject|from|snippet|body):\s*/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function archiveStaleJobSearchEmailRules(userId: string, currentConnectionId: string): Promise<void> {
  const [rules, connections] = await Promise.all([getEmailSignalRules(userId), getIntegrationConnections(userId)]);
  const connectionById = new Map(connections.map((connection) => [connection.id, connection]));

  for (const rule of rules) {
    if (rule.status !== "active" || rule.adapterId !== "job_search_email" || rule.connectionId === currentConnectionId) {
      continue;
    }

    const connection = connectionById.get(rule.connectionId);

    if (!connection || connection.integrationId !== "gmail" || connection.status === "error" || connection.status === "archived") {
      await archiveEmailSignalRule(userId, rule.id);
    }
  }
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

function truncatePlainText(text: string, maxLength: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > maxLength ? `${clean.slice(0, maxLength - 3)}...` : clean;
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

async function getUserTimezone(userId: string): Promise<string> {
  try {
    const settings = await getOrCreateNotificationSettings(userId);
    return settings.timezone || "Europe/Madrid";
  } catch {
    return "Europe/Madrid";
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

function isConfirmationMessage(message: string): boolean {
  return /^(yes|y|ok|okay|confirm|confirmo|sí|si|dale|do it)$/i.test(message.trim());
}

function isRejectionMessage(message: string): boolean {
  return /^(no|cancel|cancelar|nope|stop|don't|dont)$/i.test(message.trim());
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

function sortGoalsForDisplay(goals: Awaited<ReturnType<typeof getGoals>>) {
  return [...goals].sort((left, right) => {
    if (left.status === "active" && right.status !== "active") {
      return -1;
    }

    if (left.status !== "active" && right.status === "active") {
      return 1;
    }

    return right.createdAt.getTime() - left.createdAt.getTime();
  });
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

async function createCustomGoalProgressEvent(
  userId: string,
  goal: Awaited<ReturnType<typeof getGoals>>[number],
  input: { metricKey?: string; value?: string | number | boolean; unit?: string; note?: string }
) {
  const events = await createEvents(userId, [
    {
      type: "custom.goal_progress_logged",
      source: "manual",
      data: {
        goalId: goal.id,
        goalTitle: goal.title,
        ...(input.metricKey ? { metricKey: input.metricKey } : {}),
        ...(input.value !== undefined ? { value: input.value } : {}),
        ...(input.unit ? { unit: input.unit } : {}),
        ...(input.note ? { note: input.note } : {})
      },
      confidence: 1,
      evidence: [input.note ?? input.metricKey ?? goal.title]
    }
  ]);

  return events[0];
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

function normalizeComparableText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

async function resolvePendingCustomEmailRuleReply(
  userId: string,
  pendingAction: PendingAction,
  message: string
): Promise<string | undefined> {
  if (pendingAction.type !== "custom_email_rule" || !isRecord(pendingAction.payload)) {
    return undefined;
  }

  const operation = typeof pendingAction.payload.operation === "string" ? pendingAction.payload.operation : "";

  if (operation !== "clarify_rule_management") {
    return undefined;
  }

  const intendedOperation = typeof pendingAction.payload.intendedOperation === "string"
    ? pendingAction.payload.intendedOperation
    : "";
  const candidates = readEmailRuleSelectionCandidates(pendingAction.payload.candidateRules);
  const selected = selectEmailRuleCandidate(message, candidates);

  if (!selected) {
    return candidates.length > 0
      ? `Reply with 1-${candidates.length}, the rule name, or cancel.`
      : "That pending Gmail rule decision no longer has any options. Please ask again.";
  }

  const rule = (await getEmailSignalRules(userId)).find((item) => item.id === selected.id && item.status !== "archived");

  if (!rule) {
    await rejectPendingAction(userId, pendingAction.id);
    return "I could not find that Gmail rule anymore. Use /my_email_rules to check the current rules.";
  }

  if (intendedOperation === "pause" || intendedOperation === "resume") {
    const status = intendedOperation === "pause" ? "paused" : "active";
    const updated = await updateEmailSignalRule(userId, rule.id, { status });

    await confirmPendingAction(userId, pendingAction.id);

    if (updated) {
      await maybeRememberGmailRuleConversationContext(userId, [updated], updated);
    }

    return updated ? `Gmail rule ${status}: ${updated.name}` : "I could not update that Gmail rule.";
  }

  if (intendedOperation === "archive") {
    await replacePendingAction(userId, {
      type: "custom_email_rule",
      summary: `Archive Gmail rule: ${rule.name}`,
      payload: {
        operation: "archive_rule",
        ruleId: rule.id,
        ruleName: rule.name
      },
      expiresAt: pendingDecisionExpiry()
    });

    return `Confirm remove Gmail rule: ${rule.name}? Reply yes to confirm or no to cancel.`;
  }

  await rejectPendingAction(userId, pendingAction.id);
  return "I could not complete that Gmail rule decision. Please ask again.";
}

async function resolveActionHygieneReply(
  userId: string,
  pendingAction: PendingAction,
  message: string,
  now = new Date()
): Promise<string | undefined> {
  const candidates = readPendingActionCandidates(pendingAction.payload.candidateActions);
  const batchPlan = await planActionHygieneBatchReply(userId, pendingAction, message, candidates, now);

  if (batchPlan) {
    if (batchPlan.errors.length > 0) {
      return batchPlan.errors.join("\n");
    }

    if (batchPlan.missingSnoozeTargets.length > 0) {
      return [
        "I can do that, but I need a snooze time for:",
        ...batchPlan.missingSnoozeTargets.map((candidate) => `- ${candidate.title}`),
        `Try: snooze ${batchPlan.missingSnoozeTargets[0]?.title ?? "that"} tomorrow.`
      ].join("\n");
    }

    if (batchPlan.operations.length === 0) {
      return "I did not find any visible hygiene actions to change.";
    }

    if (batchPlan.requiresConfirmation) {
      await replacePendingAction(userId, {
        type: "action_hygiene",
        summary: `Apply ${batchPlan.operations.length} hygiene action change${batchPlan.operations.length === 1 ? "" : "s"}`,
        payload: {
          operation: "batch_update",
          originalText: message,
          now: now.toISOString(),
          timezone: batchPlan.timezone,
          operations: batchPlan.operations,
          candidateActions: candidates
        },
        expiresAt: pendingDecisionExpiry()
      });

      return formatActionHygieneBatchConfirmation(batchPlan.operations, batchPlan.timezone);
    }

    const applied = await applyActionHygieneBatchOperations(userId, batchPlan.operations, batchPlan.timezone);
    await maybeRememberRecentActionMutationStatusFromReply(userId, applied.reply);
    await closeHygieneSessionIfDone(userId, pendingAction, now);
    return applied.reply;
  }

  if (/^snooze\s+(.+)$/i.test(message.trim()) && !parseActionHygieneReply(message)) {
    return "Add a time for the snooze. Try: snooze 2 tomorrow.";
  }

  const parsed = parseActionHygieneReply(message);

  if (!parsed) {
    return undefined;
  }

  if (parsed.operation === "bulk_archive_unlinked_stale") {
    const report = await analyzeActionHygiene(userId, now, await getUserTimezone(userId));
    const bulkCandidates = report.suggestedCleanupCandidates.filter((candidate) => !candidate.linkedGoalTitle);

    if (bulkCandidates.length === 0) {
      return "No unlinked stale tasks matched for bulk archive.";
    }

    await replacePendingAction(userId, {
      type: "action_hygiene",
      summary: `Archive ${bulkCandidates.length} unlinked stale action${bulkCandidates.length === 1 ? "" : "s"}`,
      payload: {
        operation: "bulk_archive",
        actionIds: bulkCandidates.map((candidate) => candidate.actionId),
        candidateActions: bulkCandidates.map((candidate) => ({
          id: candidate.actionId,
          title: candidate.title,
          dueAt: candidate.dueAt,
          status: "open"
        }))
      },
      expiresAt: pendingDecisionExpiry()
    });

    return [
      `Confirm archive ${bulkCandidates.length} unlinked stale action${bulkCandidates.length === 1 ? "" : "s"}?`,
      ...bulkCandidates.slice(0, 10).map((candidate) => `- ${candidate.title}`),
      "Reply yes to confirm or no to cancel."
    ].join("\n");
  }

  const selected = selectPendingActionCandidate(parsed.target, candidates);

  if (!selected) {
    return candidates.length > 0
      ? `Reply with 1-${candidates.length}, the action title, or cancel.`
      : formatNoVisibleHygieneContextReply(pendingAction);
  }

  if (!hygieneCandidateAllows(selected, parsed.operation)) {
    return formatHygieneOperationUnavailable(selected, parsed.operation);
  }

  const action = await getActionItem(userId, selected.id);

  if (!action || action.status === "archived") {
    await rejectPendingAction(userId, pendingAction.id);
    return "I could not find that action anymore. Use /actions to check the exact task.";
  }

  if (parsed.operation === "keep") {
    await closeHygieneSessionIfDone(userId, pendingAction, now);
    return `Kept for now: ${action.title}`;
  }

  if (parsed.operation === "complete") {
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
    await closeHygieneSessionIfDone(userId, pendingAction, now);

    return [
      `Action completed: ${completed.title}`,
      progressEvent?.created ? `Goal progress logged: ${progressEvent.goalTitle}` : undefined
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (parsed.operation === "archive") {
    await replacePendingAction(userId, {
      type: "action_archive",
      summary: `Archive action: ${action.title}`,
      payload: {
        originalText: message,
        intendedOperation: "archive_action",
        actionId: action.id,
        candidateActions: [toPendingActionCandidate(action)]
      },
      expiresAt: pendingDecisionExpiry()
    });

    return `Confirm archive action: ${action.title}? Reply yes to confirm or no to cancel.`;
  }

  if (parsed.operation === "snooze") {
    const settings = await getOrCreateNotificationSettings(userId);
    const parsedTime = parseActionDueDate(parsed.timeText ?? "", {
      now,
      timezone: settings.timezone,
      preferences: settings
    });

    if (parsedTime.invalidReason === "past_explicit_time") {
      return "That snooze time has already passed.";
    }

    if (!parsedTime.dueAt) {
      return "I could not parse the snooze time. Try: snooze 1 tomorrow.";
    }

    const updated = await snoozeActionItem(userId, action.id, parsedTime.dueAt);

    if (!updated) {
      await rejectPendingAction(userId, pendingAction.id);
      return "I could not update that action.";
    }

    await closeHygieneSessionIfDone(userId, pendingAction, now);
    return `Action snoozed until ${formatLocalDateTime(updated.snoozedUntil, settings.timezone)}: ${updated.title}`;
  }

  return undefined;
}

function formatNoVisibleHygieneContextReply(pendingAction?: PendingAction): string {
  const summary = typeof pendingAction?.summary === "string" ? pendingAction.summary : "";
  const payloadSummary = typeof pendingAction?.payload?.summary === "string" ? pendingAction.payload.summary : "";
  const text = `${summary} ${payloadSummary}`.toLowerCase();

  if (text.includes("clean enough")) {
    return "I don't have a visible cleanup item right now. Your action list is clean enough.";
  }

  return "I don't have a visible cleanup item right now. Say 'clean up my tasks' first.";
}

type HygieneOperation = "archive" | "complete" | "snooze" | "keep";

type ActionHygieneBatchOperation = {
  operation: HygieneOperation;
  actionId: string;
  title: string;
  timeText?: string;
  dueAt?: string;
};

type ActionHygieneBatchPlan = {
  operations: ActionHygieneBatchOperation[];
  missingSnoozeTargets: PendingActionCandidate[];
  errors: string[];
  requiresConfirmation: boolean;
  timezone: string;
};

async function planActionHygieneBatchReply(
  userId: string,
  pendingAction: PendingAction,
  message: string,
  candidates: PendingActionCandidate[],
  now: Date
): Promise<ActionHygieneBatchPlan | undefined> {
  const trimmed = normalizeHygieneBatchText(message);
  const comparison = normalizeForComparison(trimmed);

  if (
    !/\b(archive|delete|remove|complete|done|snooze|keep|archiva|arxiva|elimina|borra|pospon|ajorna)\b/.test(comparison) ||
    !(/\b(all|rest|except|menos|excepte|menys|and|y|i)\b/.test(comparison) || trimmed.includes(","))
  ) {
    return undefined;
  }

  const settings = await getOrCreateNotificationSettings(userId);
  const plan: ActionHygieneBatchPlan = {
    operations: [],
    missingSnoozeTargets: [],
    errors: [],
    requiresConfirmation: true,
    timezone: settings.timezone
  };

  if (candidates.length === 0) {
    plan.errors.push(formatNoVisibleHygieneContextReply(pendingAction));
    return plan;
  }

  if (tryPlanKeepOneArchiveRest(trimmed, candidates, plan)) {
    return plan;
  }

  if (await tryPlanAllExceptReply(trimmed, candidates, settings, now, plan)) {
    return plan;
  }

  if (await tryPlanAllReply(trimmed, candidates, settings, now, plan)) {
    return plan;
  }

  if (/\s+(?:and|y|i)\s+(?:archive|delete|remove|complete|done|snooze|keep)\b/i.test(trimmed)) {
    const operationSegments = trimmed
      .split(/\s+(?:and|y|i)\s+/i)
      .map((segment) => segment.trim())
      .filter(Boolean);

    for (const segment of operationSegments) {
      await addHygieneBatchOperationFromSegment(segment, candidates, settings, now, plan);
    }

    return plan;
  }

  if (await tryPlanSharedSnoozeTargets(trimmed, candidates, settings, now, plan)) {
    return plan;
  }

  if (/^(archive|delete|remove|complete|done|keep)\s+.+\b(and|y|i)\b.+$/i.test(trimmed)) {
    await addHygieneBatchOperationFromSegment(trimmed, candidates, settings, now, plan);
    return plan;
  }

  const segments = trimmed
    .split(/\s*,\s*/g)
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (segments.length <= 1) {
    return undefined;
  }

  for (const segment of segments) {
    await addHygieneBatchOperationFromSegment(segment, candidates, settings, now, plan);
  }

  return plan;
}

function normalizeHygieneBatchText(message: string): string {
  return message
    .trim()
    .replace(/\bu\b/gi, "you")
    .replace(/\bexpect\b/gi, "except")
    .replace(/\s+/g, " ");
}

function tryPlanKeepOneArchiveRest(
  message: string,
  candidates: PendingActionCandidate[],
  plan: ActionHygieneBatchPlan
): boolean {
  const match = message.match(/^keep\s+(.+?)\s*(?:,|\s+and\s+)?\s*archive\s+(?:the\s+)?rest$/i);
  if (!match) {
    return false;
  }

  const kept = selectPendingActionCandidate(match[1], candidates);
  if (!kept) {
    plan.errors.push(`I could not match "${match[1].trim()}" to one of the visible hygiene actions.`);
    return true;
  }

  addHygieneBatchOperation(plan, kept, "keep");
  for (const candidate of candidates.filter((item) => item.id !== kept.id)) {
    addHygieneBatchOperation(plan, candidate, "archive");
  }
  return true;
}

async function tryPlanAllExceptReply(
  message: string,
  candidates: PendingActionCandidate[],
  settings: Awaited<ReturnType<typeof getOrCreateNotificationSettings>>,
  now: Date,
  plan: ActionHygieneBatchPlan
): Promise<boolean> {
  const match = message.match(/^(archive|delete|remove|complete|done|snooze|keep)\s+all\s+(?:except|menos|excepte|menys)\s+(.+)$/i);
  if (!match) {
    return false;
  }

  const operation = hygieneOperationFromVerb(match[1]);
  const { exceptionText, exceptionSnoozeTimeText, mentionedSnooze } = parseAllExceptException(match[2]);
  const exception = selectPendingActionCandidate(exceptionText, candidates);

  if (!exception) {
    plan.errors.push(`I could not match "${exceptionText}" to one of the visible hygiene actions.`);
    return true;
  }

  const rest = candidates.filter((candidate) => candidate.id !== exception.id);

  if (operation === "snooze") {
    if (!exceptionSnoozeTimeText) {
      plan.missingSnoozeTargets.push(...rest);
    } else {
      await addSnoozeOperations(rest, exceptionSnoozeTimeText, settings, now, plan);
    }
  } else if (operation !== "keep") {
    for (const candidate of rest) {
      addHygieneBatchOperation(plan, candidate, operation);
    }
  }

  if (mentionedSnooze) {
    if (!exceptionSnoozeTimeText) {
      plan.missingSnoozeTargets.push(exception);
    } else {
      await addSnoozeOperations([exception], exceptionSnoozeTimeText, settings, now, plan);
    }
  }

  return true;
}

function parseAllExceptException(value: string): {
  exceptionText: string;
  exceptionSnoozeTimeText?: string;
  mentionedSnooze: boolean;
} {
  const [beforeComma, ...afterComma] = value.split(/\s*,\s*/);
  const rawException = beforeComma ?? value;
  const tail = afterComma.join(", ");
  const combined = `${rawException} ${tail}`.trim();
  const snoozeMatch = combined.match(/\b(?:snooze|pospone|posponer|ajorna|ajornar)\b(?:\s+(?:that|it|them|ese|esa|aquest|aquesta))?\s*(?:to|until|for|a|hasta|fins)?\s*(.*)$/i);
  const mentionedSnooze = Boolean(snoozeMatch);
  const exceptionText = rawException
    .replace(/\bthat\s+you\s+can\s+(?:snooze|pospone|posponer|ajorna|ajornar).*$/i, "")
    .replace(/\b(?:snooze|pospone|posponer|ajorna|ajornar).*$/i, "")
    .trim();
  const exceptionSnoozeTimeText = snoozeMatch?.[1]?.trim() || undefined;

  return {
    exceptionText,
    exceptionSnoozeTimeText,
    mentionedSnooze
  };
}

async function tryPlanAllReply(
  message: string,
  candidates: PendingActionCandidate[],
  settings: Awaited<ReturnType<typeof getOrCreateNotificationSettings>>,
  now: Date,
  plan: ActionHygieneBatchPlan
): Promise<boolean> {
  const match = message.match(/^(archive|delete|remove|complete|done|snooze|keep)\s+all(?:\s+(?:to|until|for)\s+(.+))?$/i);
  if (!match) {
    return false;
  }

  const operation = hygieneOperationFromVerb(match[1]);
  if (operation === "snooze") {
    const timeText = match[2]?.trim();
    if (!timeText) {
      plan.missingSnoozeTargets.push(...candidates);
    } else {
      await addSnoozeOperations(candidates, timeText, settings, now, plan);
    }
  } else if (operation !== "keep") {
    for (const candidate of candidates) {
      addHygieneBatchOperation(plan, candidate, operation);
    }
  } else {
    for (const candidate of candidates) {
      addHygieneBatchOperation(plan, candidate, operation);
    }
  }

  return true;
}

async function tryPlanSharedSnoozeTargets(
  message: string,
  candidates: PendingActionCandidate[],
  settings: Awaited<ReturnType<typeof getOrCreateNotificationSettings>>,
  now: Date,
  plan: ActionHygieneBatchPlan
): Promise<boolean> {
  const match = message.match(/^snooze\s+(.+?)\s+(?:to|until|for)\s+(.+)$/i);
  if (!match || !/\b(and|y|i)\b|,/.test(match[1])) {
    return false;
  }

  const targets = splitHygieneTargetList(match[1]);
  for (const target of targets) {
    const selected = selectPendingActionCandidate(target, candidates);
    if (!selected) {
      plan.errors.push(`I could not match "${target}" to one of the visible hygiene actions.`);
      continue;
    }
    await addSnoozeOperations([selected], match[2], settings, now, plan);
  }

  return true;
}

async function addHygieneBatchOperationFromSegment(
  segment: string,
  candidates: PendingActionCandidate[],
  settings: Awaited<ReturnType<typeof getOrCreateNotificationSettings>>,
  now: Date,
  plan: ActionHygieneBatchPlan
): Promise<void> {
  const simpleMultiTarget = segment.match(/^(archive|delete|remove|complete|done|keep)\s+(.+)$/i);
  if (simpleMultiTarget && /\b(and|y|i)\b/.test(normalizeForComparison(simpleMultiTarget[2]))) {
    const operation = hygieneOperationFromVerb(simpleMultiTarget[1]);
    for (const target of splitHygieneTargetList(simpleMultiTarget[2])) {
      const selected = selectPendingActionCandidate(target, candidates);
      if (!selected) {
        plan.errors.push(`I could not match "${target}" to one of the visible hygiene actions.`);
      } else {
        addHygieneBatchOperation(plan, selected, operation);
      }
    }
    return;
  }

  const missingSnooze = segment.match(/^snooze\s+(.+)$/i);
  const parsed = parseActionHygieneReply(segment);

  if (!parsed) {
    if (missingSnooze) {
      const selected = selectPendingActionCandidate(missingSnooze[1], candidates);
      if (selected) {
        plan.missingSnoozeTargets.push(selected);
      } else {
        plan.errors.push(`I could not match "${missingSnooze[1].trim()}" to one of the visible hygiene actions.`);
      }
      return;
    }

    plan.errors.push(`Could not handle "${segment}".`);
    return;
  }

  const selected = selectPendingActionCandidate(parsed.target, candidates);
  if (!selected) {
    plan.errors.push(`I could not match "${parsed.target}" to one of the visible hygiene actions.`);
    return;
  }

  if (parsed.operation === "bulk_archive_unlinked_stale") {
    plan.errors.push(`Could not handle "${segment}" inside a batch.`);
    return;
  }

  if (parsed.operation === "snooze") {
    await addSnoozeOperations([selected], parsed.timeText, settings, now, plan);
    return;
  }

  addHygieneBatchOperation(plan, selected, parsed.operation);
}

function splitHygieneTargetList(value: string): string[] {
  return value
    .split(/\s+(?:and|y|i)\s+|,/i)
    .map((part) => part.trim())
    .filter(Boolean);
}

async function addSnoozeOperations(
  candidates: PendingActionCandidate[],
  timeText: string,
  settings: Awaited<ReturnType<typeof getOrCreateNotificationSettings>>,
  now: Date,
  plan: ActionHygieneBatchPlan
): Promise<void> {
  const parsedTime = parseActionDueDate(timeText, {
    now,
    timezone: settings.timezone,
    preferences: settings
  });

  if (parsedTime.invalidReason === "past_explicit_time") {
    plan.errors.push("That snooze time has already passed.");
    return;
  }

  if (!parsedTime.dueAt) {
    plan.missingSnoozeTargets.push(...candidates);
    return;
  }

  for (const candidate of candidates) {
    addHygieneBatchOperation(plan, candidate, "snooze", timeText, parsedTime.dueAt.toISOString());
  }
}

function addHygieneBatchOperation(
  plan: ActionHygieneBatchPlan,
  candidate: PendingActionCandidate,
  operation: HygieneOperation,
  timeText?: string,
  dueAt?: string
): void {
  if (!hygieneCandidateAllows(candidate, operation)) {
    plan.errors.push(formatHygieneOperationUnavailable(candidate, operation));
    return;
  }

  plan.operations.push({
    operation,
    actionId: candidate.id,
    title: candidate.title,
    timeText,
    dueAt
  });
}

function hygieneCandidateAllows(candidate: PendingActionCandidate, operation: HygieneOperation): boolean {
  return !candidate.recommendedOptions || candidate.recommendedOptions.length === 0 || candidate.recommendedOptions.includes(operation);
}

function formatHygieneOperationUnavailable(candidate: PendingActionCandidate, operation: HygieneOperation): string {
  const options = candidate.recommendedOptions && candidate.recommendedOptions.length > 0
    ? candidate.recommendedOptions
    : ["complete", "snooze", "keep"] as ActionHygieneOption[];

  if (operation === "archive") {
    return `I can ${formatInlineOptions(options)} ${candidate.title}, but archive is not available for this item.`;
  }

  return `${candidate.title}: ${operation} is not available. I can ${formatInlineOptions(options)} this action.`;
}

function formatInlineOptions(options: ActionHygieneOption[]): string {
  const unique = [...new Set(options)];
  if (unique.length <= 1) {
    return unique[0] ?? "keep";
  }

  return `${unique.slice(0, -1).join(", ")}, or ${unique[unique.length - 1]}`;
}

function hygieneOperationFromVerb(value: string): HygieneOperation {
  const verb = value.toLowerCase();
  if (verb === "done") {
    return "complete";
  }
  if (verb === "delete" || verb === "remove" || verb === "archiva" || verb === "arxiva" || verb === "elimina" || verb === "borra") {
    return "archive";
  }
  if (verb === "pospon" || verb === "ajorna") {
    return "snooze";
  }
  return verb as HygieneOperation;
}

function formatActionHygieneBatchConfirmation(operations: ActionHygieneBatchOperation[], timezone: string): string {
  return [
    "I will:",
    ...operations.map((operation) => `- ${formatActionHygieneBatchOperation(operation, timezone)}`),
    "Confirm with \"yes\" or cancel."
  ].join("\n");
}

function formatActionHygieneBatchOperation(operation: ActionHygieneBatchOperation, timezone: string): string {
  if (operation.operation === "archive") {
    return `archive ${operation.title}`;
  }

  if (operation.operation === "complete") {
    return `complete ${operation.title}`;
  }

  if (operation.operation === "keep") {
    return `keep ${operation.title}`;
  }

  const formatted = operation.dueAt ? formatLocalDateTime(new Date(operation.dueAt), timezone) : operation.timeText ?? "the chosen time";
  return `snooze ${operation.title} to ${formatted}`;
}

async function applyActionHygieneBatchOperations(
  userId: string,
  operations: ActionHygieneBatchOperation[],
  timezone: string
): Promise<{ reply: string }> {
  const done: string[] = [];
  const skipped: string[] = [];

  for (const operation of operations) {
    const action = await getActionItem(userId, operation.actionId);

    if (!action) {
      skipped.push(`${operation.title}: no longer found`);
      continue;
    }

    if (action.status === "archived" || action.status === "completed") {
      skipped.push(`${action.title}: already ${action.status}`);
      continue;
    }

    if (operation.operation === "archive") {
      const archived = await archiveActionItem(userId, action.id);
      if (archived) {
        done.push(`Archived ${archived.title}`);
      }
      continue;
    }

    if (operation.operation === "complete") {
      const completed = await completeActionItem(userId, action.id);
      if (completed) {
        const progressEvent = await createGoalProgressFromCompletedAction(userId, completed);
        done.push(
          progressEvent?.created
            ? `Completed ${completed.title}; goal progress logged for ${progressEvent.goalTitle}`
            : `Completed ${completed.title}`
        );
      }
      continue;
    }

    if (operation.operation === "snooze") {
      const dueAt = operation.dueAt ? new Date(operation.dueAt) : undefined;
      if (!dueAt || Number.isNaN(dueAt.getTime())) {
        skipped.push(`${action.title}: missing snooze time`);
        continue;
      }

      const updated = await snoozeActionItem(userId, action.id, dueAt);
      if (updated) {
        done.push(`Snoozed ${updated.title} to ${formatLocalDateTime(updated.snoozedUntil, timezone)}`);
      }
      continue;
    }

    done.push(`Kept ${action.title}`);
  }

  return {
    reply: [
      done.length > 0 ? "Done:" : "No action changes were made.",
      ...done.map((line) => `- ${line}`),
      skipped.length > 0 ? "" : undefined,
      skipped.length > 0 ? "Skipped:" : undefined,
      ...skipped.map((line) => `- ${line}`)
    ].filter((line) => line !== undefined).join("\n")
  };
}

async function closeHygieneSessionIfDone(userId: string, pendingAction: PendingAction, now: Date): Promise<void> {
  const candidates = readPendingActionCandidates(pendingAction.payload.candidateActions);
  const remaining = await Promise.all(candidates.map((candidate) => getActionItem(userId, candidate.id)));
  const stillNeedsDecision = remaining.some((action) => {
    if (!action || action.status === "completed" || action.status === "archived") {
      return false;
    }

    if (action.status === "snoozed" && action.snoozedUntil && action.snoozedUntil.getTime() > now.getTime()) {
      return false;
    }

    return true;
  });

  if (!stillNeedsDecision) {
    await confirmPendingAction(userId, pendingAction.id);
  }
}

function readPendingActionCandidates(value: unknown): PendingActionCandidate[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isRecord)
    .map((item) => ({
      id: typeof item.id === "string" ? item.id : "",
      title: typeof item.title === "string" ? item.title : "",
      status: typeof item.status === "string" ? item.status : "",
      dueAt: typeof item.dueAt === "string" ? item.dueAt : undefined,
      snoozedUntil: typeof item.snoozedUntil === "string" ? item.snoozedUntil : undefined,
      goalId: typeof item.goalId === "string" ? item.goalId : undefined,
      goalTitleSnapshot: typeof item.goalTitleSnapshot === "string" ? item.goalTitleSnapshot : undefined,
      recommendedOptions: readActionHygieneOptions(item.recommendedOptions)
    }))
    .filter((item) => item.id && item.title);
}

function readActionHygieneOptions(value: unknown): ActionHygieneOption[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const options = value.filter((option): option is ActionHygieneOption =>
    option === "complete" || option === "snooze" || option === "archive" || option === "keep"
  );

  return options.length > 0 ? options : undefined;
}

function selectPendingActionCandidate(message: string, candidates: PendingActionCandidate[]): PendingActionCandidate | undefined {
  const trimmed = message.trim();
  if (candidates.length === 1 && /^(it|that|this|them|those|one|the one|este|esta|eso|ese|esa|aquest|aquesta|ho)$/i.test(trimmed)) {
    return candidates[0];
  }

  const numeric = trimmed.match(/^(?:number\s+)?#?(\d+)$/i);

  if (numeric) {
    const index = Number(numeric[1]) - 1;
    return candidates[index];
  }

  const ordinalIndex = ordinalSelectionIndex(trimmed);

  if (ordinalIndex !== undefined) {
    return candidates[ordinalIndex];
  }

  const key = normalizeActionReferenceText(trimmed);

  if (!key) {
    return undefined;
  }

  const exactMatches = candidates.filter((candidate) => {
    const titleKey = normalizeActionReferenceText(candidate.title);
    return titleKey === key || titleKey.includes(key) || key.includes(titleKey);
  });

  if (exactMatches.length === 1) {
    return exactMatches[0];
  }

  const scored = candidates
    .map((candidate) => ({ candidate, score: scorePendingActionCandidateReference(key, candidate) }))
    .filter((item) => item.score >= 0.5)
    .sort((left, right) => right.score - left.score);

  if (scored.length === 0) {
    return undefined;
  }

  if (scored.length === 1 || scored[0].score - scored[1].score >= 0.18) {
    return scored[0].candidate;
  }

  return undefined;
}

function normalizeActionReferenceText(value: string): string {
  return normalizeComparableText(value)
    .replace(/\b(the|this|that|those|these|one|ones|task|tasks|action|actions|item|items|el|la|los|las|un|una|uno|de|del|dels|aquest|aquesta|aquell|aquella)\b/g, " ")
    .replace(/\bdev\b/g, "developer")
    .replace(/\bcv\b/g, "resume")
    .replace(/\byt\b/g, "youtube")
    .replace(/\s+/g, " ")
    .trim();
}

function scorePendingActionCandidateReference(referenceKey: string, candidate: PendingActionCandidate): number {
  const titleKey = normalizeActionReferenceText(candidate.title);
  const goalKey = normalizeActionReferenceText(candidate.goalTitleSnapshot ?? "");
  const haystack = `${titleKey} ${goalKey}`.trim();

  if (!referenceKey || !haystack) {
    return 0;
  }

  if (titleKey === referenceKey || haystack === referenceKey) {
    return 1;
  }

  if (haystack.includes(referenceKey)) {
    return 0.9;
  }

  const referenceTokens = meaningfulActionReferenceTokens(referenceKey);
  const haystackTokens = meaningfulActionReferenceTokens(haystack);

  if (referenceTokens.length === 0 || haystackTokens.length === 0) {
    return 0;
  }

  const matched = referenceTokens.filter((token) =>
    haystackTokens.some((candidateToken) => token === candidateToken || token.length >= 4 && candidateToken.startsWith(token) || candidateToken.length >= 4 && token.startsWith(candidateToken))
  );

  return matched.length / referenceTokens.length;
}

function meaningfulActionReferenceTokens(value: string): string[] {
  return value
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !/^(to|for|with|and|you|can|please|pls|done|complete|archive|delete|remove|snooze|keep|review|write|check|send|apply)$/.test(token));
}

function parseActionHygieneReply(message: string):
  | { operation: "complete" | "archive" | "keep"; target: string }
  | { operation: "snooze"; target: string; timeText: string }
  | { operation: "bulk_archive_unlinked_stale"; target: string }
  | undefined {
  const trimmed = message.trim();

  if (!trimmed) {
    return undefined;
  }

  if (/^archive\s+all\s+unlinked\s+stale\s+tasks?$/i.test(trimmed)) {
    return {
      operation: "bulk_archive_unlinked_stale",
      target: "all"
    };
  }

  const snooze = trimmed.match(/^snooze\s+(.+?)\s+(?:to|until|for)?\s*(tomorrow.*|today.*|tonight.*|now|in\s+\d+\s+days?|next\s+\w+.*|\d{4}-\d{2}-\d{2}.*)$/i);

  if (snooze) {
    return {
      operation: "snooze",
      target: snooze[1].trim(),
      timeText: snooze[2].trim()
    };
  }

  const simple = trimmed.match(/^(complete|done|archive|delete|remove|keep)\s+(.+)$/i);

  if (!simple) {
    return undefined;
  }

  const verb = simple[1].toLowerCase();
  const operation = verb === "done"
    ? "complete"
    : verb === "delete" || verb === "remove"
      ? "archive"
      : verb as "complete" | "archive" | "keep";

  return {
    operation,
    target: simple[2].trim()
  };
}

function ordinalSelectionIndex(text: string): number | undefined {
  const normalized = normalizeComparableText(text);
  const map: Record<string, number> = {
    first: 0,
    "first one": 0,
    primero: 0,
    primera: 0,
    second: 1,
    "second one": 1,
    segundo: 1,
    segunda: 1,
    third: 2,
    "third one": 2,
    tercero: 2,
    tercera: 2,
    fourth: 3,
    "fourth one": 3,
    fourthone: 3,
    cuarto: 3,
    cuarta: 3,
    fifth: 4,
    "fifth one": 4,
    quinto: 4,
    quinta: 4
  };

  return map[normalized];
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

function looksLikeUnresolvedHygieneReply(message: string): boolean {
  const trimmed = message.trim();

  if (!trimmed) {
    return false;
  }

  return (
    /^snooze\s+(?:#?\d+|first|second|third|fourth|fifth|.+)$/i.test(trimmed) ||
    /^(complete|done|archive|delete|remove|keep)\s+(?:#?\d+|first|second|third|fourth|fifth)$/i.test(trimmed) ||
    /\b(?:complete|done|snooze|archive|delete|remove|keep)\s+#?\d+\s+\band\b\s+(?:complete|done|snooze|archive|delete|remove|keep)\s+#?\d+/i.test(trimmed) ||
    /^(?:archive|delete|remove|complete|done|snooze|keep)\s+all(?:\s+(?:except|menos|excepte|menys)\b.*)?$/i.test(trimmed) ||
    /^(?:archive|delete|remove|complete|done|snooze|keep)\s+.+,\s*(?:archive|delete|remove|complete|done|snooze|keep)\s+.+$/i.test(trimmed)
  );
}

async function applyPendingAction(userId: string, pendingAction: PendingAction): Promise<{ reply: string }> {
  if (pendingAction.type === "action_target_clarification") {
    return {
      reply: "Reply with the number of the action you mean, or cancel."
    };
  }

  if (pendingAction.type === "profile_update") {
    const profilePatch = pendingAction.payload.profilePatch;

    if (!isRecord(profilePatch)) {
      throw new Error("Invalid profile_update payload.");
    }

    await updateUserOperatingProfile(userId, UpdateUserOperatingProfileInputSchema.parse(profilePatch));

    return {
      reply: pendingAction.summary.toLowerCase().includes("hard guardian")
        ? "Confirmed. I updated your profile to hard guardian mode."
        : "Confirmed. I updated your profile."
    };
  }

  if (pendingAction.type === "goal_create") {
    const { title, category, why, templateId, targetMetrics, checkInConfig } = pendingAction.payload;

    if (typeof title !== "string" || typeof category !== "string") {
      throw new Error("Invalid goal_create payload.");
    }

    const result = await createGoal(userId, CreateGoalInputSchema.parse({
      title,
      category,
      why: typeof why === "string" ? why : undefined,
      templateId: typeof templateId === "string" ? templateId : undefined,
      targetMetrics: Array.isArray(targetMetrics) ? targetMetrics : undefined,
      checkInConfig: Array.isArray(checkInConfig) ? checkInConfig : undefined
    }));

    if (result.duplicate) {
      return {
        reply: `You already have a similar active goal: ${result.existingGoal.title}. Use /goals to review it or /archive_goal ${result.existingGoal.id} first.`
      };
    }

    return {
      reply: `Confirmed. I created the goal: ${title}.`
    };
  }

  if (pendingAction.type === "goal_progress_log") {
    const goalId = pendingAction.payload.goalId;

    if (typeof goalId !== "string") {
      throw new Error("Invalid goal_progress_log payload.");
    }

    const goal = (await getGoals(userId)).find((item) => item.id === goalId);

    if (!goal) {
      throw new Error("Goal not found.");
    }

    await createCustomGoalProgressEvent(userId, goal, CustomGoalProgressInputSchema.parse({
      metricKey: typeof pendingAction.payload.metricKey === "string" ? pendingAction.payload.metricKey : undefined,
      value: pendingAction.payload.value,
      unit: typeof pendingAction.payload.unit === "string" ? pendingAction.payload.unit : undefined,
      note: typeof pendingAction.payload.note === "string" ? pendingAction.payload.note : undefined
    }));

    return {
      reply: `Confirmed. Logged progress for ${goal.title}.`
    };
  }

  if (pendingAction.type === "custom_email_rule") {
    const operation = typeof pendingAction.payload.operation === "string" ? pendingAction.payload.operation : "";

    if (operation === "archive_rule") {
      const ruleId = typeof pendingAction.payload.ruleId === "string" ? pendingAction.payload.ruleId : "";
      const rule = await archiveEmailSignalRule(userId, ruleId);

      if (!rule) {
        throw new Error("Email rule not found.");
      }

      return {
        reply: `Gmail rule removed: ${rule.name}`
      };
    }

    if (operation === "archive_rules") {
      const ruleIds = arrayOfStrings(pendingAction.payload.ruleIds);
      const archivedRules = [];

      for (const ruleId of ruleIds) {
        const rule = await archiveEmailSignalRule(userId, ruleId);
        if (rule) {
          archivedRules.push(rule);
        }
      }

      if (archivedRules.length === 0) {
        throw new Error("Email rules not found.");
      }

      const ruleScope = typeof pendingAction.payload.ruleScope === "string" ? pendingAction.payload.ruleScope : "";
      const label = ruleScope === "gmail_email_rules" ? "Gmail email rules" : "Custom Gmail rules";

      return {
        reply: [
          `${label} removed: ${archivedRules.length}`,
          ...formatGmailEmailRuleSelectionLines(archivedRules)
        ].join("\n")
      };
    }

    if (operation === "create_rule") {
      const connectionId = typeof pendingAction.payload.connectionId === "string" ? pendingAction.payload.connectionId : "";
      const displayName = typeof pendingAction.payload.displayName === "string" ? pendingAction.payload.displayName : "Custom Gmail tracking";
      const queryPreview = typeof pendingAction.payload.queryPreview === "string" ? pendingAction.payload.queryPreview : "";
      const goalId = typeof pendingAction.payload.goalId === "string" ? pendingAction.payload.goalId : undefined;

      if (!connectionId || !queryPreview) {
        throw new Error("Invalid custom_email_rule payload.");
      }

      const connection = await getIntegrationConnection(userId, connectionId);

      if (!connection || connection.integrationId !== "gmail" || connection.status !== "active") {
        return {
          reply: "Gmail is not connected anymore. Say 'connect Gmail' and try again."
        };
      }

      const existing = (await getEmailSignalRules(userId)).find(
        (rule) =>
          rule.status === "active" &&
          rule.connectionId === connectionId &&
          rule.adapterId === "custom_email_review" &&
          normalizeForComparison(rule.query ?? "") === normalizeForComparison(queryPreview)
      );

      if (existing) {
        return {
          reply: `${existing.name} tracking is already on. New matches go to email review before anything is logged.`
        };
      }

      const rule = await createEmailSignalRule(userId, {
        connectionId,
        goalId,
        adapterId: "custom_email_review",
        name: displayName,
        query: queryPreview,
        fetchStrategy: "query",
        lookbackDays: 30,
        maxMessagesPerSync: 25,
        maxEventsPerSync: 5,
        classifierMode: "rules",
        minAutoLogConfidence: 1,
        minReviewConfidence: 0.65,
        reviewBeforeLogging: true,
        createdBy: "user"
      });

      return {
        reply: `${rule.name} tracking is on. New matches will go to email review before anything is logged.`
      };
    }

    if (operation === "gmail_autonomy_preference") {
      const connectionId = typeof pendingAction.payload.connectionId === "string" ? pendingAction.payload.connectionId : "";
      const connection = await getIntegrationConnection(userId, connectionId);

      if (!connection || connection.integrationId !== "gmail" || connection.status !== "active") {
        return {
          reply: "Gmail is not connected anymore. Say 'connect Gmail' and try again."
        };
      }

      const syncMode =
        pendingAction.payload.syncMode === "manual_only" || pendingAction.payload.syncMode === "scheduled"
          ? pendingAction.payload.syncMode
          : undefined;
      const syncIntervalMinutes =
        typeof pendingAction.payload.syncIntervalMinutes === "number"
          ? pendingAction.payload.syncIntervalMinutes
          : typeof pendingAction.payload.syncIntervalMinutes === "string"
            ? Number.parseInt(pendingAction.payload.syncIntervalMinutes, 10)
            : undefined;
      const reviewNotificationEnabled =
        typeof pendingAction.payload.reviewNotificationEnabled === "boolean"
          ? pendingAction.payload.reviewNotificationEnabled
          : undefined;
      const updatedConfig = writeGmailAutonomyPreferences(connection.config, {
        syncMode,
        syncIntervalMinutes,
        reviewNotificationEnabled
      });
      const updatedConnection = await updateIntegrationConnectionConfig(userId, connection.id, updatedConfig);

      if (!updatedConnection) {
        throw new Error("Gmail connection not found.");
      }

      const state = await buildGmailAutonomyState(userId);
      const preferenceKind = typeof pendingAction.payload.preferenceKind === "string" ? pendingAction.payload.preferenceKind : "";

      if (preferenceKind === "manual_only") {
        return {
          reply: "Gmail is set to manual only. I will check active rules when you say \"sync Gmail\"."
        };
      }

      if (preferenceKind === "scheduled") {
        const interval = typeof syncIntervalMinutes === "number" && Number.isFinite(syncIntervalMinutes)
          ? syncIntervalMinutes
          : state.syncIntervalMinutes;
        return {
          reply: state.runtime.scheduledSyncEnabled
            ? `Gmail scheduled checks are set to every ${formatIntervalMinutes(interval)} for active rules.`
            : `Gmail preference saved: checks every ${formatIntervalMinutes(interval)}. Background sync is currently disabled in this local environment, so I will only check when you say "sync Gmail" until background sync is enabled.`
        };
      }

      if (preferenceKind === "review_notifications_on" || preferenceKind === "review_notifications_off") {
        const enabled = preferenceKind === "review_notifications_on";
        return {
          reply: enabled
            ? "Gmail review notifications are on. Scheduled sync will send one bundled message when new reviews are waiting."
            : "Gmail review notifications are off. Manual sync will still reply in chat."
        };
      }

      return {
        reply: "Gmail preference updated."
      };
    }

    throw new Error("Invalid custom_email_rule operation.");
  }

  if (pendingAction.type === "goal_archive") {
    const goalId = pendingAction.payload.goalId;

    if (typeof goalId !== "string") {
      throw new Error("Invalid goal_archive payload.");
    }

    const goal = await archiveGoal(userId, goalId);

    if (!goal) {
      throw new Error("Goal not found.");
    }

    return {
      reply: `Confirmed. I archived the goal: ${goal.title}.`
    };
  }

  if (pendingAction.type === "action_archive") {
    const actionId = pendingAction.payload.actionId;

    if (typeof actionId !== "string") {
      throw new Error("Invalid action_archive payload.");
    }

    const action = await archiveActionItem(userId, actionId);

    if (!action) {
      throw new Error("Action item not found.");
    }

    return {
      reply: `Action archived: ${action.title}`
    };
  }

  if (pendingAction.type === "action_hygiene") {
    if (pendingAction.payload.operation === "batch_update") {
      const timezone = typeof pendingAction.payload.timezone === "string" ? pendingAction.payload.timezone : await getUserTimezone(userId);
      const operations = readActionHygieneBatchOperations(pendingAction.payload.operations);

      if (operations.length === 0) {
        return {
          reply: "No action hygiene changes were waiting."
        };
      }

      return applyActionHygieneBatchOperations(userId, operations, timezone);
    }

    if (pendingAction.payload.operation !== "bulk_archive" || !Array.isArray(pendingAction.payload.actionIds)) {
      return {
        reply: "Run /action_hygiene again and choose one action."
      };
    }

    const archived: string[] = [];

    for (const actionId of pendingAction.payload.actionIds) {
      if (typeof actionId !== "string") {
        continue;
      }

      const action = await archiveActionItem(userId, actionId);

      if (action) {
        archived.push(action.title);
      }
    }

    return {
      reply: archived.length > 0
        ? [`Archived ${archived.length} action${archived.length === 1 ? "" : "s"}:`, ...archived.map((title) => `- ${title}`)].join("\n")
        : "No matching actions were archived."
    };
  }

  if (pendingAction.type === "memory_create") {
    const payload = PendingMemoryCreatePayloadSchema.parse(pendingAction.payload);
    const memory = await createMemoryFromPendingPayload(userId, payload);

    return {
      reply: `Confirmed. I saved this to memory: ${memory.summary}`
    };
  }

  if (pendingAction.type === "event_undo_last") {
    const scope = pendingAction.payload.scope === "event" ? "event" : "group";
    const reason =
      typeof pendingAction.payload.reason === "string" ? pendingAction.payload.reason : "user requested undo";
    const events = await undoLastEvents(userId, { scope, reason });

    return {
      reply:
        events.length === 0
          ? "Confirmed, but there was no active event to archive."
          : `Confirmed. Archived ${events.length} event${events.length === 1 ? "" : "s"} from the last logged action.`
    };
  }

  throw new Error(`Unsupported pending action type: ${pendingAction.type}`);
}

function readActionHygieneBatchOperations(value: unknown): ActionHygieneBatchOperation[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isRecord)
    .flatMap((item): ActionHygieneBatchOperation[] => {
      const operation = typeof item.operation === "string" ? item.operation : "";
      if (operation !== "archive" && operation !== "complete" && operation !== "snooze" && operation !== "keep") {
        return [];
      }

      const actionId = typeof item.actionId === "string" ? item.actionId : "";
      const title = typeof item.title === "string" ? item.title : "";

      if (!actionId || !title) {
        return [];
      }

      return [{
        operation,
        actionId,
        title,
        timeText: typeof item.timeText === "string" ? item.timeText : undefined,
        dueAt: typeof item.dueAt === "string" ? item.dueAt : undefined
      }];
    });
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

async function maybeRememberRecentActionMutationStatusFromReply(userId: string, reply: string): Promise<void> {
  if (!replyStartsWithActionMutation(reply)) {
    return;
  }

  await replacePendingAction(userId, {
    type: "action_hygiene",
    summary: "Recent action changes",
    payload: {
      operation: "recent_mutation_status",
      summary: "Recent action changes",
      reply
    },
    expiresAt: new Date(Date.now() + 15 * 60 * 1000)
  });
}

function replyStartsWithActionMutation(reply: string): boolean {
  return /^(Done:|Action archived:|Archived \d+ actions?:|Action completed:|Action snoozed until|Action rescheduled:)/.test(reply.trim());
}

async function findPendingAction(userId: string, pendingActionId: string) {
  const pendingActions = await getPendingActions(userId);
  return pendingActions.find((action) => action.id === pendingActionId && action.status === "pending");
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

function pendingDecisionExpiry(): Date {
  return new Date(Date.now() + 60 * 60 * 1000);
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
