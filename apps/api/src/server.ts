import Fastify from "fastify";
import {
  buildDailyReview,
  buildDailyInsight,
  buildDailyCheckinPrompt,
  buildCustomGoalConfig,
  buildConversationControlDebug,
  composeAgentResponse,
  buildWeeklyInsight,
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
  IngestTextBodySchema,
  CreateEmailSignalRuleInputSchema,
  UpdateEmailSignalRuleInputSchema,
  GithubPublicConnectionInputSchema,
  emailAdapterRegistry,
  getEmailAdapterDefinition,
  integrationRegistry,
  CreateMemoryInputSchema,
  PendingMemoryCreatePayloadSchema,
  processMessage,
  processMessageFromAnalysis,
  ProcessMessageInputSchema,
  routeIntent,
  parsedDailyCheckInToAnswers,
  parseDailyCheckinText,
  parseConversationControlTime,
  resolveActionReference,
  resolveGoalReference,
  routeIngestion,
  UpdateIntegrationConnectionInputSchema,
  UpdateNotificationSettingsInputSchema,
  UpdateUserOperatingProfileInputSchema,
  type IngestTextBody,
  type GithubPublicConnectionInput,
  type MessageIntent,
  type InsightReport,
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
  polishInsightWithOpenAI,
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
  updateEmailSignalRule,
  updateEmailSignalRuleSyncState,
  updateMemory,
  updateNotificationSettings,
  updateUserOperatingProfile,
  prisma
} from "@operator-agent/db";

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

  server.post("/messages/process", async (request, reply) => {
    const parsed = ProcessMessageInputSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid request body",
        issues: parsed.error.issues
      });
    }

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

    const latestPendingAction = await getLatestPendingAction(parsed.data.userId);

    if (latestPendingAction) {
      const pendingReply = await resolvePendingDecisionReply(parsed.data.userId, latestPendingAction, parsed.data.message);

      if (pendingReply) {
        return replyOnly(parsed.data.userId, parsed.data.message, pendingReply);
      }
    } else if (looksLikePendingDecisionReply(parsed.data.message)) {
      return replyOnly(parsed.data.userId, parsed.data.message, "That pending decision expired. Please ask again.");
    }

    if (looksLikeUnresolvedHygieneReply(parsed.data.message)) {
      return replyOnly(
        parsed.data.userId,
        parsed.data.message,
        "Run /action_hygiene first, then reply with a cleanup command like: snooze 1 tomorrow."
      );
    }

    if (looksLikeNextWeekPlanRequest(parsed.data.message)) {
      const timezone = await getUserTimezone(parsed.data.userId);
      const now = new Date();
      const context = await buildNextWeekPlanContext(parsed.data.userId, now, timezone);
      const suggestions = await generateNextWeekPlanSuggestions(context);

      await replacePendingAction(parsed.data.userId, {
        type: "next_week_plan",
        summary: `Next week plan - ${context.nextWeekStartLocalDate} to ${context.nextWeekEndLocalDate}`,
        payload: {
          originalText: parsed.data.message,
          nextWeekStartLocalDate: context.nextWeekStartLocalDate,
          nextWeekEndLocalDate: context.nextWeekEndLocalDate,
          timezone: context.timezone,
          suggestions: suggestions.map(toPendingNextWeekPlanSuggestion)
        },
        expiresAt: pendingDecisionExpiry()
      });

      return replyOnly(parsed.data.userId, parsed.data.message, formatNextWeekPlanMessage(context, suggestions));
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

    if (!surfaceGuardrail.triggered || surfaceGuardrail.isReferenceOnly) {
      const surfaceReply = await handleConversationSurfaceIntent(parsed.data.userId, parsed.data.message);

      if (surfaceReply) {
        return replyOnly(parsed.data.userId, parsed.data.message, surfaceReply);
      }
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

  server.get<{ Params: { userId: string }; Querystring: { includeArchived?: string } }>(
    "/users/:userId/memory",
    async (request) => ({
      memories:
        request.query.includeArchived === "true"
          ? await getMemories(request.params.userId)
          : await getActiveMemories(request.params.userId)
    })
  );

  server.post<{ Params: { userId: string } }>("/users/:userId/memory", async (request, reply) => {
    const parsed = CreateMemoryInputSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid request body",
        issues: parsed.error.issues
      });
    }

    return {
      memory: await createMemory(request.params.userId, {
        ...parsed.data,
        source: "manual"
      })
    };
  });

  server.patch<{ Params: { userId: string; memoryId: string } }>(
    "/users/:userId/memory/:memoryId/archive",
    async (request, reply) => {
      const memory = await archiveMemory(request.params.userId, request.params.memoryId);

      if (!memory) {
        return reply.status(404).send({
          error: "Memory not found"
        });
      }

      return { memory };
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
      message: formatWeeklyReview(review)
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

      await replacePendingAction(request.params.userId, {
        type: "next_week_plan",
        summary: `Next week plan - ${context.nextWeekStartLocalDate} to ${context.nextWeekEndLocalDate}`,
        payload: {
          originalText: "/plan_next_week",
          nextWeekStartLocalDate: context.nextWeekStartLocalDate,
          nextWeekEndLocalDate: context.nextWeekEndLocalDate,
          timezone: context.timezone,
          suggestions: suggestions.map(toPendingNextWeekPlanSuggestion)
        },
        expiresAt: pendingDecisionExpiry()
      });

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

  server.get<{ Params: { userId: string } }>("/users/:userId/notification-settings", async (request) => ({
    notificationSettings: await getOrCreateNotificationSettings(request.params.userId)
  }));

  server.patch<{ Params: { userId: string } }>("/users/:userId/notification-settings", async (request, reply) => {
    const parsed = UpdateNotificationSettingsInputSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid request body",
        issues: parsed.error.issues
      });
    }

    return {
      notificationSettings: await updateNotificationSettings(request.params.userId, parsed.data)
    };
  });

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

  server.get<{ Params: { userId: string } }>("/users/:userId/review/daily", async (request) => {
    const todayRange = getLocalTodayRange(new Date(), await getUserTimezone(request.params.userId));

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

  server.get<{ Params: { userId: string } }>("/users/:userId/checkins/daily/prompt", async (request) => ({
    prompt: buildDailyCheckinPrompt({
      activeGoals: await getActiveGoals(request.params.userId),
      userOperatingProfile: await getOrCreateUserOperatingProfile(request.params.userId),
      recentEvents: await getRecentEvents(request.params.userId, 20)
    })
  }));

  server.post<{ Params: { userId: string } }>("/users/:userId/ingest/text", async (request, reply) => {
    const parsed = IngestTextBodySchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid request body",
        issues: parsed.error.issues
      });
    }

    return ingestText(request.params.userId, parsed.data);
  });

  server.post<{ Params: { userId: string } }>("/users/:userId/ingest/job-search-text", async (request, reply) => {
    const parsed = IngestTextBodySchema.safeParse({
      ...(isRecord(request.body) ? request.body : {}),
      domainHint: "career"
    });

    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid request body",
        issues: parsed.error.issues
      });
    }

    return ingestText(request.params.userId, parsed.data);
  });

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

        await createGmailConnection(userId, {
          provider: "gmail",
          scope: "gmail.readonly",
          email,
          token
        });
      } catch {
        return reply.status(400).type("text/plain").send("Gmail connection failed. Try again from Telegram.");
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

    if (!adapter || adapter.status !== "available" || !["job_search_email", "work_action_email"].includes(adapter.id)) {
      return reply.status(400).send({
        error: "Unsupported email adapter."
      });
    }

    if (adapter.id === "job_search_email") {
      await archiveStaleJobSearchEmailRules(request.params.userId, connection.id);
    }

    const existingCurrentRule = (await getEmailSignalRules(request.params.userId)).find(
      (rule) =>
        rule.status === "active" &&
        rule.connectionId === connection.id &&
        rule.adapterId === adapter.id
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
      const review = await getEmailReviewItem(request.params.userId, request.params.reviewId);

      if (!review) {
        return reply.status(404).send({ error: "Email review item not found" });
      }

      if (review.status !== "pending") {
        if (review.status === "approved" && review.actionItemId) {
          const actionItem = await getActionItem(request.params.userId, review.actionItemId);

          if (actionItem) {
            return {
              emailReview: sanitizeEmailReviewItem(review),
              actionItem: sanitizeActionItem(actionItem),
              event: null,
              message: `Email review already approved. Action item exists: ${actionItem.title}`
            };
          }
        }

        return reply.status(400).send({
          error: `Email review item is already ${review.status}.`,
          emailReview: sanitizeEmailReviewItem(review)
        });
      }

      if (isWorkActionReviewType(review.proposedEventType)) {
        const actionInput = actionItemInputFromEmailReview(review);
        const goalLink = await inferActionGoalLink(
          request.params.userId,
          actionInput.title,
          actionInput.description,
          actionInput.evidence
        );
        actionInput.goalId = goalLink.goalId ?? undefined;
        actionInput.goalSlug = goalLink.goalSlug ?? undefined;
        actionInput.goalTitleSnapshot = goalLink.matchedGoalTitle;
        const result = await createActionItemIfNotExists(request.params.userId, actionInput);
        const updated = await approveEmailReviewItem(request.params.userId, request.params.reviewId, undefined, result.actionItem.id);

        return {
          emailReview: updated ? sanitizeEmailReviewItem(updated) : sanitizeEmailReviewItem(review),
          actionItem: sanitizeActionItem(result.actionItem),
          event: null,
          message: `Email review approved. Action item ${result.created ? "created" : "already exists"}: ${result.actionItem.title}`
        };
      }

      if (!review.proposedEventType || !EventTypeSchema.safeParse(review.proposedEventType).success) {
        const updated = await approveEmailReviewItem(request.params.userId, request.params.reviewId);

        return {
          emailReview: updated ? sanitizeEmailReviewItem(updated) : sanitizeEmailReviewItem(review),
          event: null,
          message: "This review item does not map to an approved event type yet. No event created."
        };
      }

      const eventExternalId = review.externalId.replace(/^gmail-review:/, "gmail:");
      const created = await createExternalEventIfNotExists(request.params.userId, {
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
      const updated = await approveEmailReviewItem(request.params.userId, request.params.reviewId, created.event.id);

      return {
        emailReview: updated ? sanitizeEmailReviewItem(updated) : sanitizeEmailReviewItem(review),
        event: created.event,
        message: created.created ? "Email review approved and event created." : "Email review approved. Event already existed."
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
        await replacePendingAction(request.params.userId, {
          type: "action_hygiene",
          summary: report.summary,
          payload: {
            originalText: "/action_hygiene",
            now: now.toISOString(),
            timezone,
            candidates: report.suggestedCleanupCandidates.map((candidate) => candidate.actionId),
            candidateActions: report.suggestedCleanupCandidates.map((candidate) => ({
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

      const result =
        connection.integrationId === "github_public"
          ? await syncGithubPublicConnection(connection)
          : await syncGmailConnection(connection);

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
  const topPriorities = buildOperatorTopPriorities({
    overdueActions,
    dueSoonActions,
    openActions: rankedActions,
    goalStatus,
    risks,
    priorityScores: rankedOpenActions.map((item) => item.score)
  });
  const suggestedNextStep = pickOperatorNextStep({
    overdueActions,
    dueSoonActions,
    openActions: rankedActions,
    goalStatus,
    now
  });
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
    summary: buildOperatorSummary({ openActions, overdueActions, activeGoals, todayEvents, risks }),
    coach: coachResult.coach,
    coachDebug: coachResult.debug,
    topPriorities,
    openActions: briefOpenActions,
    overdueActions: overdueActions.slice(0, 10).map(toBriefAction),
    goalStatus,
    recentWins,
    risks,
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

  return [
    `Today - ${brief.date}`,
    `First move: ${topAction ?? "Log one meaningful action."}`,
    overdue.length > 0 ? `Overdue: ${overdue.join(", ")}.` : undefined,
    alsoToday.length > 0 ? `Also today: ${alsoToday.join(", ")}.` : undefined,
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
        : "Action list is clean enough."
  };
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
  if (report.suggestedCleanupCandidates.length === 0 && report.overdueActions.length === 0) {
    return `Action hygiene:\n${report.summary}`;
  }

  const candidates = report.suggestedCleanupCandidates.length > 0 ? report.suggestedCleanupCandidates : report.overdueActions;

  return [
    "Action hygiene:",
    report.summary,
    report.overdueActions.length > 0
      ? ["Overdue:", ...report.overdueActions.slice(0, 10).map((action, index) => `${index + 1}. ${formatHygieneActionLine(action)}`)].join("\n")
      : undefined,
    "",
    "Suggested cleanup:",
    ...candidates.slice(0, 10).map((action) => `- ${action.title}: ${action.recommendedOptions.join(", ")}?`),
    "",
    "Reply with:",
    '- "snooze 1 tomorrow"',
    '- "archive 2"',
    '- "complete 1"',
    '- "keep 1"'
  ]
    .filter((line) => line !== undefined)
    .join("\n");
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

function sharesMeaningfulToken(left: string, right: string): boolean {
  const rightTokens = new Set(right.split(" ").filter((token) => token.length >= 4));
  return left.split(" ").some((token) => token.length >= 4 && rightTokens.has(token));
}

function normalizeForComparison(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ");
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
  const [activeGoals, actions, events, memories] = await Promise.all([
    getActiveGoals(userId),
    getActionItems(userId, { status: "all", limit: 300 }),
    getEventsBetween(userId, rangeStart, rangeEnd),
    getActiveMemories(userId)
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

  if (context.completedActions.length > 0) {
    wins.push(`Completed ${context.completedActions.length} action${context.completedActions.length === 1 ? "" : "s"}.`);
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
    patterns: arrayOfStrings(data.patterns).slice(0, 2),
    recommendedNextWeekActions: arrayOfStrings(data.recommendedNextWeekActions).slice(0, 3),
    reflectionIds: arrayOfStrings(data.reflectionIds),
    source: data.source === "llm" || data.source === "mixed" ? data.source : "deterministic",
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt
  };
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
    "Patterns:",
    review.patterns.length > 0 ? review.patterns.map((pattern) => `- ${pattern}`).join("\n") : "- No active operator reflections included.",
    "",
    "Next week:",
    review.recommendedNextWeekActions.length > 0
      ? review.recommendedNextWeekActions.map((action, index) => `${index + 1}. ${action}`).join("\n")
      : "No next-week actions suggested."
  ].join("\n");
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
    `goals with progress: ${context.goalsWithProgress.length}`,
    `goals without progress: ${context.goalsWithoutProgress.length}`,
    `active reflections: ${context.activeReflections.length}`,
    "events by type:",
    ...Object.entries(context.eventsByType).slice(0, 10).map(([type, count]) => `- ${type}: ${count}`)
  ].join("\n");
}

async function buildNextWeekPlanContext(userId: string, now: Date, timezone: string): Promise<NextWeekPlanContext> {
  const currentLocalDate = formatDateInTimezone(now, timezone);
  const currentWeekStart = startOfLocalWeek(currentLocalDate);
  const nextWeekStart = addDaysToLocalDateString(currentWeekStart, 7);
  const nextWeekEnd = addDaysToLocalDateString(nextWeekStart, 6);
  const nextWeekRangeStart = localDateStartUtc(nextWeekStart, timezone);
  const nextWeekRangeEnd = localDateStartUtc(addDaysToLocalDateString(nextWeekEnd, 1), timezone);
  const weeklyContext = await buildWeeklyReviewContext(userId, undefined, timezone, now);
  const [latestWeeklyReview, allActions, activeMemories] = await Promise.all([
    getLatestWeeklyReview(userId),
    getActionItems(userId, { status: "all", limit: 300 }),
    getActiveMemories(userId)
  ]);
  const openActions = allActions.filter((action) => action.status === "open" || isSnoozedDue(action, now));
  const futureActionsNextWeek = openActions.filter((action) =>
    isDateInRange(action.dueAt, nextWeekRangeStart, nextWeekRangeEnd) ||
    isDateInRange(action.snoozedUntil, nextWeekRangeStart, nextWeekRangeEnd)
  );

  return {
    userId,
    timezone,
    now,
    nextWeekStartLocalDate: nextWeekStart,
    nextWeekEndLocalDate: nextWeekEnd,
    nextWeekRangeStart,
    nextWeekRangeEnd,
    latestWeeklyReview,
    activeGoals: weeklyContext.activeGoals,
    goalsWithNoProgress: weeklyContext.goalsWithoutProgress,
    openActions,
    staleActions: weeklyContext.actionHygiene.suggestedCleanupCandidates,
    activeReflections: weeklyContext.activeReflections,
    recentEventsSummary: weeklyContext.eventsByType,
    guardrailGoals: weeklyContext.activeGoals.filter(isRiskControlGoal),
    guardrailEvents: weeklyContext.guardrailEvents,
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
      notCreatableReason: "Use /action_hygiene or say a natural cleanup command like snooze, complete, or archive."
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
      duplicateRisk: false
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
        duplicateRisk: false
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
        duplicateRisk: false
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
        duplicateRisk: false
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
      suggestedDueAt: localPlanDate(context, 0, 9 * 60)
    };
  }

  if (/youtube|channel|creative|script|video|creator|build_project/.test(key)) {
    return {
      ...base,
      title: "Write 5 bullets for the YouTube script",
      reason,
      suggestedDueAt: localPlanDate(context, 1, 16 * 60 + 30)
    };
  }

  if (/strength|health|training|workout|gym|energy/.test(key)) {
    return {
      ...base,
      title: "Do 2 strength sessions",
      reason,
      suggestedDueAt: localPlanDate(context, 2, 18 * 60)
    };
  }

  if (/sleep/.test(key)) {
    return {
      ...base,
      title: "Set sleep cutoff for 3 nights",
      reason,
      suggestedDueAt: localPlanDate(context, 0, 20 * 60)
    };
  }

  if (/read|reading|learning|book/.test(key)) {
    return {
      ...base,
      title: "Read 20 minutes on 3 days",
      reason,
      suggestedDueAt: localPlanDate(context, 1, 20 * 60)
    };
  }

  if (/car|vehicle|cheap car|buy car/.test(key)) {
    return {
      ...base,
      title: "Check cheap car listings twice",
      reason,
      suggestedDueAt: localPlanDate(context, 3, 16 * 60 + 30)
    };
  }

  return {
    ...base,
    title: `Do one concrete action for ${goal.title}`,
    reason,
    suggestedDueAt: localPlanDate(context, 2, 16 * 60 + 30)
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
                "You are Alecto's next-week planning assistant.",
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
    nextWeek: {
      startLocalDate: context.nextWeekStartLocalDate,
      endLocalDate: context.nextWeekEndLocalDate,
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
        suggestedDueAt: dueAt && dueAt >= context.nextWeekRangeStart && dueAt < context.nextWeekRangeEnd
          ? dueAt
          : localPlanDate(context, 2, 16 * 60 + 30),
        actionType: "generic",
        source: "weekly_plan",
        duplicateRisk: false
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
    const key = normalizeManualActionTitleKey(title);

    if (!title || seen.has(key) || containsUnsafePlanAction(title)) {
      continue;
    }

    seen.add(key);
    const duplicate = findEquivalentOpenPlanAction(context, title, suggestion.suggestedDueAt);
    normalized.push({
      ...suggestion,
      index: normalized.length + 1,
      title,
      reason: suggestion.reason.trim().slice(0, 220),
      priority: normalizePlanPriority(suggestion.priority),
      actionPriority: normalizePlanActionPriority(suggestion.actionPriority ?? suggestion.priority),
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
  dueAt?: Date
): ActionItem | undefined {
  const key = normalizeManualActionTitleKey(title);
  const dueLocalDate = dueAt ? formatDateInTimezone(dueAt, context.timezone) : "";

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

function summarizeNextWeekPlanContext(context: NextWeekPlanContext) {
  return {
    nextWeek: {
      start: context.nextWeekStartLocalDate,
      end: context.nextWeekEndLocalDate
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
    guardrailGoals: context.guardrailGoals.map((goal) => goal.title),
    recentEventsSummary: context.recentEventsSummary
  };
}

function formatNextWeekPlanContextDebug(context: NextWeekPlanContext): string {
  return [
    "Next-week plan context:",
    `nextWeek: ${context.nextWeekStartLocalDate} to ${context.nextWeekEndLocalDate}`,
    `latest weekly review: ${context.latestWeeklyReview ? `${context.latestWeeklyReview.id} (${context.latestWeeklyReview.weekStartLocalDate} to ${context.latestWeeklyReview.reviewedEndLocalDate})` : "none"}`,
    `active goals: ${context.activeGoals.length}`,
    `goals with no progress: ${context.goalsWithNoProgress.length}`,
    `open actions: ${context.openActions.length}`,
    `stale actions: ${context.staleActions.length}`,
    `active reflections: ${context.activeReflections.length}`,
    `future actions already scheduled: ${context.futureActionsNextWeek.length}`,
    `guardrail goals: ${context.guardrailGoals.length}`,
    "events by type:",
    ...Object.entries(context.recentEventsSummary).slice(0, 10).map(([type, count]) => `- ${type}: ${count}`)
  ].join("\n");
}

function formatNextWeekPlanMessage(context: NextWeekPlanContext, suggestions: NextWeekPlanSuggestion[]): string {
  return [
    `Next week plan - ${context.nextWeekStartLocalDate} to ${context.nextWeekEndLocalDate}`,
    "",
    "Suggested actions:",
    ...suggestions.map((suggestion) => formatNextWeekPlanSuggestionLine(suggestion, context.timezone)),
    "",
    "Reply:",
    "- create 1",
    "- create 1 and 2",
    "- create all",
    "- skip",
    "- edit 2 to Friday morning"
  ].join("\n");
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

    const nextWeekStart = typeof pendingAction.payload.nextWeekStartLocalDate === "string" ? pendingAction.payload.nextWeekStartLocalDate : "";
    const nextWeekEnd = typeof pendingAction.payload.nextWeekEndLocalDate === "string" ? pendingAction.payload.nextWeekEndLocalDate : "";
    const parsedTime = parseActionDueDate(parsed.timeText, {
      now: localDateStartUtc(nextWeekStart, timezone),
      timezone,
      preferences: await getOrCreateNotificationSettings(userId)
    });
    const dueAt = parsedTime.dueAt;

    if (!dueAt || !nextWeekStart || !nextWeekEnd || dueAt < localDateStartUtc(nextWeekStart, timezone) || dueAt >= localDateStartUtc(addDaysToLocalDateString(nextWeekEnd, 1), timezone)) {
      return "That edit does not land inside next week. Try: edit 2 to Friday morning.";
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
    const context = await buildNextWeekPlanContext(userId, new Date(), timezone);

    for (const suggestion of selected) {
      if (suggestion.creatable === false || suggestion.planKind === "cleanup") {
        skipped.push(formatSkippedNextWeekPlanSuggestion(suggestion));
        continue;
      }

      const duplicate = findEquivalentOpenPlanAction(context, suggestion.title, suggestion.suggestedDueAt);

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

  if (/^create\s+all$/i.test(trimmed)) {
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
        notCreatableReason: typeof item.notCreatableReason === "string" ? item.notCreatableReason : undefined
      };
    })
    .filter(Boolean) as NextWeekPlanSuggestion[];
}

function actionInputFromPlanSuggestion(suggestion: NextWeekPlanSuggestion, payload: Record<string, unknown>): CreateActionItemInput {
  const weekStart = typeof payload.nextWeekStartLocalDate === "string" ? payload.nextWeekStartLocalDate : "unknown-week";
  return {
    source: "system",
    sourceId: `weekly-plan:${weekStart}:${normalizeManualActionTitleKey(suggestion.title)}`,
    sourceProvider: "weekly_plan",
    goalId: suggestion.goalId,
    goalTitleSnapshot: suggestion.goalTitle,
    title: suggestion.title,
    description: suggestion.reason,
    priority: suggestion.actionPriority ?? normalizePlanActionPriority(suggestion.priority),
    dueAt: suggestion.suggestedDueAt,
    actionType: "generic",
    evidence: `Weekly plan suggestion: ${suggestion.reason}`
  };
}

function toPendingNextWeekPlanSuggestion(suggestion: NextWeekPlanSuggestion) {
  return {
    ...suggestion,
    suggestedDueAt: suggestion.suggestedDueAt.toISOString()
  };
}

function formatPendingNextWeekPlan(timezone: string, payload: Record<string, unknown>, suggestions: NextWeekPlanSuggestion[]): string {
  const start = typeof payload.nextWeekStartLocalDate === "string" ? payload.nextWeekStartLocalDate : "";
  const end = typeof payload.nextWeekEndLocalDate === "string" ? payload.nextWeekEndLocalDate : "";

  return [
    `Next week plan - ${start} to ${end}`,
    "",
    "Suggested actions:",
    ...suggestions.map((suggestion) => formatNextWeekPlanSuggestionLine(suggestion, timezone)),
    "",
    "Reply: create 1, create 1 and 2, create all, edit 2 to Friday morning, or skip."
  ].join("\n");
}

function formatNextWeekPlanSuggestionLine(suggestion: NextWeekPlanSuggestion, timezone: string): string {
  const tags = [
    suggestion.planKind === "cleanup" ? "cleanup" : undefined,
    suggestion.duplicateRisk ? suggestion.planKind === "cleanup" ? "already open" : "already covered" : undefined,
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
  if (suggestion.planKind === "cleanup" || suggestion.creatable === false) {
    return `${suggestion.title} is already an open action. Use /action_hygiene to complete, snooze, or archive it.`;
  }

  return `${suggestion.title} was skipped.`;
}

function localPlanDate(context: Pick<NextWeekPlanContext, "nextWeekStartLocalDate" | "timezone">, dayOffset: number, minutes: number): Date {
  const date = addDaysToLocalDateString(context.nextWeekStartLocalDate, dayOffset);
  const start = localDateStartUtc(date, context.timezone);
  return new Date(start.getTime() + minutes * 60_000);
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

function looksLikeNextWeekPlanRequest(message: string): boolean {
  const text = message.trim().toLowerCase();
  return /^(create|make|build|generate)\s+(the\s+)?(?:next\s+week\s+)?plan$/.test(text) ||
    /^(create|make|build|generate)\s+next\s+week\s+actions$/.test(text) ||
    /^plan\s+next\s+week$/.test(text);
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
    morningBriefs: context.dailyLoopCounts.morningBriefs,
    eveningReviews: context.dailyLoopCounts.eveningReviews
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
}): string {
  const parts = [
    `${input.openActions.length} open action${input.openActions.length === 1 ? "" : "s"}`,
    input.overdueActions.length > 0 ? `${input.overdueActions.length} overdue` : undefined,
    `${input.activeGoals.length} active goal${input.activeGoals.length === 1 ? "" : "s"}`,
    `${input.todayEvents.length} event${input.todayEvents.length === 1 ? "" : "s"} logged today`,
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
  | "daily_operator"
  | "start_day"
  | "daily_review"
  | "weekly_review"
  | "next_week_plan"
  | "action_hygiene"
  | "show_goals"
  | "show_actions"
  | "show_memory"
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
    const review = existing ? toWeeklyReviewMemory(existing) : await generateAndSaveWeeklyReview(userId, context);
    return formatWeeklyReview(review);
  }

  if (intent === "next_week_plan") {
    return createNextWeekPlanForConversation(userId, message);
  }

  if (intent === "action_hygiene") {
    const now = new Date();
    const timezone = await getUserTimezone(userId);
    const report = await analyzeActionHygiene(userId, now, timezone);
    await replacePendingAction(userId, {
      type: "action_hygiene",
      summary: report.summary,
      payload: {
        originalText: message,
        now: now.toISOString(),
        timezone,
        candidates: report.suggestedCleanupCandidates.map((candidate) => candidate.actionId),
        candidateActions: report.suggestedCleanupCandidates.map((candidate) => ({
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

  if (intent === "integration_guidance") {
    return formatIntegrationGuidance(message);
  }

  if (intent === "daily_loop_settings") {
    return handleNaturalDailyLoopSettings(userId, message);
  }

  return undefined;
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

  if (/\b(what should i do today|what should i do now|show today|show my day|today plan|what is my plan today)\b/.test(text)) {
    return "daily_operator";
  }

  if (/\b(review my day|what happened today|how did today go|daily review)\b/.test(text)) {
    return "daily_review";
  }

  if (/\b(review my week|how did this week go|weekly review)\b/.test(text)) {
    return "weekly_review";
  }

  if (looksLikeNextWeekPlanRequest(message) || /\b(plan next week|make next week actions|create a plan from the weekly review)\b/.test(text)) {
    return "next_week_plan";
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
    reply: "No. Hard stop. I am not helping you turn this into permission. Cooldown now. If it still matters later, bring a written thesis, exact size, invalidation point, and emotional state."
  };
}

async function buildConversationDailyReview(userId: string) {
  const todayRange = getLocalTodayRange(new Date(), await getUserTimezone(userId));
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

async function createNextWeekPlanForConversation(userId: string, originalText: string): Promise<string> {
  const timezone = await getUserTimezone(userId);
  const now = new Date();
  const context = await buildNextWeekPlanContext(userId, now, timezone);
  const suggestions = await generateNextWeekPlanSuggestions(context);
  await replacePendingAction(userId, {
    type: "next_week_plan",
    summary: `Next week plan - ${context.nextWeekStartLocalDate} to ${context.nextWeekEndLocalDate}`,
    payload: {
      originalText,
      nextWeekStartLocalDate: context.nextWeekStartLocalDate,
      nextWeekEndLocalDate: context.nextWeekEndLocalDate,
      timezone: context.timezone,
      suggestions: suggestions.map(toPendingNextWeekPlanSuggestion)
    },
    expiresAt: pendingDecisionExpiry()
  });

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
      "Gmail setup is two steps.",
      "1. Connect Gmail with readonly access.",
      "2. Enable one email rule, such as job search or work actions.",
      "",
      "Alecto will not scan Gmail until a rule is enabled. Uncertain emails go to review before becoming events or actions.",
      "Shortcuts: /connect_gmail, then /enable_email_rule job_search or /enable_email_rule work_action."
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

async function buildConversationControlDebugForUser(userId: string, text: string) {
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
    brief.actionHygiene ? `\nAction hygiene:\n- ${cleanupDecisionGrammar(brief.actionHygiene.needsDecision)} Run /action_hygiene.` : undefined,
    brief.weeklyReviewDue ? "\nWeekly review:\n- Weekly review due. Run /weekly." : undefined,
    brief.operatorReflection ? `\nPattern:\n${brief.operatorReflection}` : undefined,
    "",
    "Next move:",
    brief.suggestedNextStep
  ].join("\n");
}

function dueLabelFromPriorityScore(score: DailyPriorityScore): string {
  return (
    score.factors.find((factor) => factor === "overdue" || factor.startsWith("due today") || factor.startsWith("due tomorrow") || factor === "due later this week") ??
    "not due"
  );
}

function buildOperatorTopPriorities(input: {
  overdueActions: ActionItem[];
  dueSoonActions: ActionItem[];
  openActions: ActionItem[];
  goalStatus: DailyOperatorBriefGoalStatus[];
  risks: string[];
  priorityScores: DailyPriorityScore[];
}): string[] {
  const priorities: string[] = [];
  const seenActionIds = new Set<string>();
  const seenActionTitles = new Set<string>();
  const scoresByActionId = new Map(input.priorityScores.map((score) => [score.actionId, score]));

  const addActionPriority = (action: ActionItem) => {
    const titleKey = normalizeManualActionTitleKey(action.title);

    if (seenActionIds.has(action.id) || seenActionTitles.has(titleKey)) {
      return;
    }

    seenActionIds.add(action.id);
    seenActionTitles.add(titleKey);
    priorities.push(formatPriorityAction(action, scoresByActionId.get(action.id)));
  };

  input.openActions.forEach((action) => addActionPriority(action));

  return uniqueStrings(priorities).slice(0, 3);
}

function pickOperatorNextStep(input: {
  overdueActions: ActionItem[];
  dueSoonActions: ActionItem[];
  openActions: ActionItem[];
  goalStatus: DailyOperatorBriefGoalStatus[];
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

async function ingestText(userId: string, input: IngestTextBody) {
  const result = routeIngestion({
    userId,
    text: input.text,
    source: input.source,
    metadata: {
      domainHint: input.domainHint
    }
  });
  const validCandidates = result.eventCandidates.filter((candidate) => EventTypeSchema.safeParse(candidate.type).success);
  const events =
    validCandidates.length > 0
      ? await createEvents(
          userId,
          validCandidates.map((candidate) => ({
            type: EventTypeSchema.parse(candidate.type),
            source: "manual",
            data: {
              ...candidate.data,
              adapterId: result.adapterId,
              classification: result.classification,
              extracted: result.extracted ?? {},
              originalText: input.text.slice(0, 1000)
            },
            confidence: candidate.confidence,
            evidence: candidate.evidence
          }))
        )
      : [];

  return {
    result,
    events,
    reply: composeIngestionReply(result.classification, events.length)
  };
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
  const rules = await getActiveEmailSignalRulesForConnection(connection.userId, connection.id);
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
      emailRuleDiagnostics,
      error: reason,
      errorStage,
      syncLog
    };
  }
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

function sanitizeActionItem(item: ActionItem) {
  return {
    ...item,
    evidence: item.evidence ? truncatePlainText(item.evidence, 500) : undefined,
    description: item.description ? truncatePlainText(item.description, 500) : undefined
  };
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
    const token = readGmailToken(connection);

    return {
      provider: "gmail",
      scope: typeof connection.config.scope === "string" ? connection.config.scope : "gmail.readonly",
      email: typeof connection.config.email === "string" ? connection.config.email : undefined,
      hasRefreshToken: Boolean(token.refreshToken),
      expiresAt: token.expiresAt || undefined
    };
  }

  return {};
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
  const token = readGmailToken(connection);

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

  await updateIntegrationConnectionConfig(connection.userId, connection.id, {
    ...connection.config,
    token: nextToken
  });

  return nextToken.accessToken;
}

function readGmailToken(connection: IntegrationConnection) {
  const token = isRecord(connection.config.token) ? connection.config.token : {};
  return {
    accessToken: typeof token.accessToken === "string" ? token.accessToken : "",
    refreshToken: typeof token.refreshToken === "string" ? token.refreshToken : "",
    expiresAt: typeof token.expiresAt === "number" ? token.expiresAt : 0,
    tokenType: typeof token.tokenType === "string" ? token.tokenType : "Bearer",
    scope: typeof token.scope === "string" ? token.scope : ""
  };
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
    (error.code === "GMAIL_AUTH_EXPIRED" || error.code === "GMAIL_PERMISSION")
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

function composeIngestionReply(classification: string, eventCount: number): string {
  if (eventCount === 0 || classification === "unknown") {
    return "I could not classify this clearly. Paste more context or log it manually.";
  }

  return `Logged career event: ${classification.replace(/_/g, " ")}.`;
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

function shouldUseOpenAIAnalysis(): boolean {
  return process.env.USE_OPENAI_ANALYSIS === "true" && Boolean(process.env.OPENAI_API_KEY);
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
  if (isRejectionMessage(message)) {
    await rejectPendingAction(userId, pendingAction.id);
    return "Cancelled. I did not change anything.";
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
    return applied.reply;
  }

  return undefined;
}

async function resolveActionHygieneReply(
  userId: string,
  pendingAction: PendingAction,
  message: string,
  now = new Date()
): Promise<string | undefined> {
  if (
    /\s+\band\b\s+/i.test(message.trim()) &&
    /\b(?:complete|done|snooze|archive|delete|remove|keep)\b/i.test(message.trim())
  ) {
    return "Handle one hygiene action at a time. Try: complete 1 or snooze 2 tomorrow.";
  }

  if (/^snooze\s+(.+)$/i.test(message.trim()) && !parseActionHygieneReply(message)) {
    return "Add a time for the snooze. Try: snooze 2 tomorrow.";
  }

  const parsed = parseActionHygieneReply(message);

  if (!parsed) {
    return undefined;
  }

  const candidates = readPendingActionCandidates(pendingAction.payload.candidateActions);

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
      : "That hygiene session no longer has any options. Run /action_hygiene again.";
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
      goalTitleSnapshot: typeof item.goalTitleSnapshot === "string" ? item.goalTitleSnapshot : undefined
    }))
    .filter((item) => item.id && item.title);
}

function selectPendingActionCandidate(message: string, candidates: PendingActionCandidate[]): PendingActionCandidate | undefined {
  const trimmed = message.trim();
  const numeric = trimmed.match(/^#?(\d+)$/);

  if (numeric) {
    const index = Number(numeric[1]) - 1;
    return candidates[index];
  }

  const ordinalIndex = ordinalSelectionIndex(trimmed);

  if (ordinalIndex !== undefined) {
    return candidates[ordinalIndex];
  }

  const key = normalizeComparableText(trimmed);

  if (!key) {
    return undefined;
  }

  const matches = candidates.filter((candidate) => {
    const titleKey = normalizeComparableText(candidate.title);
    return titleKey === key || titleKey.includes(key) || key.includes(titleKey);
  });

  return matches.length === 1 ? matches[0] : undefined;
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
  return (
    isConfirmationMessage(trimmed) ||
    isRejectionMessage(trimmed) ||
    Boolean(parseActionHygieneReply(trimmed)) ||
    Boolean(parseNextWeekPlanReply(trimmed)) ||
    /^#?\d+$/.test(trimmed) ||
    /^(the\s+)?(first|second|third|fourth|fifth)(\s+one)?$/i.test(trimmed) ||
    /^(primero|primera|segundo|segunda|tercero|tercera|cuarto|cuarta|quinto|quinta)$/i.test(trimmed)
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
    /\b(?:complete|done|snooze|archive|delete|remove|keep)\s+#?\d+\s+\band\b\s+(?:complete|done|snooze|archive|delete|remove|keep)\s+#?\d+/i.test(trimmed)
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

async function findPendingAction(userId: string, pendingActionId: string) {
  const pendingActions = await getPendingActions(userId);
  return pendingActions.find((action) => action.id === pendingActionId && action.status === "pending");
}

function replyOnly(userId: string, message: string, response: string): ProcessMessageResult {
  return {
    userId,
    message,
    intent: "general_chat",
    mode: "mirror",
    riskState: "GREEN",
    extractedEvents: [],
    reply: response
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

interface GithubCommit {
  sha: string;
  html_url?: string;
  author?: {
    login?: string;
  } | null;
  committer?: {
    login?: string;
  } | null;
  commit: {
    message: string;
    author?: {
      name?: string;
      email?: string;
      date?: string;
    } | null;
    committer?: {
      name?: string;
      email?: string;
      date?: string;
    } | null;
  };
}

interface GmailTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

interface GmailMessage {
  id: string;
  threadId?: string;
  snippet?: string;
  payload?: GmailMessagePart;
}

interface EmailRuleSyncSummary {
  ruleId: string;
  adapterId: string;
  query?: string;
  fetchStrategy: string;
  classifierMode: string;
  lookbackDays: number;
  maxMessagesPerSync: number;
  maxEventsPerSync: number;
  messagesFound: number;
  processed: number;
  ignoredUnknown: number;
  filteredMarketing: number;
  needsReview: number;
  llmClassified: number;
  llmUnavailable: number;
  llmErrors: number;
  llmNeedsReview: number;
  llmIgnored: number;
  reviewItemsCreated: number;
  reviewItemsAlreadyPending: number;
  reviewItemsRejectedDeduped: number;
  reviewItemsSemanticDeduped: number;
  lowConfidenceIgnored: number;
  deduped: number;
  semanticDeduped: number;
  archivedCleanupReprocessed: number;
  skippedDueMaxEventsPerSync: number;
  eventsCreated: number;
  lastError?: string;
  lastErrorStage?: GmailErrorStage;
  reviewCandidateDebug: EmailReviewCandidateDebug[];
}

interface EmailReviewCandidateDebug {
  subject?: string;
  from?: string;
  proposedEventType?: string;
  company?: string;
  role?: string;
  project?: string;
  deadline?: string;
  actionRequired?: boolean;
  decision:
    | "created"
    | "existing_pending"
    | "existing_rejected"
    | "existing_approved"
    | "active_event_exists"
    | "archived_ignored"
    | "invalid_ignored";
  matchedReviewId?: string;
  matchedReviewStatus?: string;
  matchedEventId?: string;
  semanticKey: string;
}

interface EmailRuleDiagnostics {
  totalEmailRules: number;
  rulesForConnection: number;
  activeRulesForConnection: number;
  staleOrArchivedRules: number;
  rejectedRuleReasons: string[];
}

type GmailErrorStage =
  | "rule_loading"
  | "token_refresh"
  | "gmail_search"
  | "gmail_message_fetch"
  | "classification"
  | "event_creation";

interface DailyOperatorBrief {
  date: string;
  summary: string;
  coach: DailyCoachResponse;
  coachDebug: DailyCoachDebug;
  topPriorities: string[];
  openActions: DailyOperatorBriefAction[];
  overdueActions: DailyOperatorBriefAction[];
  goalStatus: DailyOperatorBriefGoalStatus[];
  recentWins: string[];
  risks: string[];
  actionHygiene?: {
    summary: string;
    needsDecision: number;
  };
  operatorReflection?: string;
  weeklyReviewDue?: boolean;
  suggestedNextStep: string;
  priorityDebug?: DailyOperatorBriefPriorityDebug[];
}

interface WeeklyReviewContext {
  userId: string;
  timezone: string;
  weekStartLocalDate: string;
  weekEndLocalDate: string;
  reviewedEndLocalDate: string;
  rangeStart: Date;
  rangeEnd: Date;
  activeGoals: Goal[];
  events: StoredEvent[];
  eventsByType: Record<string, number>;
  completedActions: ActionItem[];
  openActions: ActionItem[];
  overdueActions: ActionItem[];
  snoozedOrRescheduledActions: ActionItem[];
  archivedActions: ActionItem[];
  guardrailEvents: StoredEvent[];
  goalProgress: WeeklyGoalProgress[];
  goalsWithProgress: WeeklyGoalProgress[];
  goalsWithoutProgress: WeeklyGoalProgress[];
  actionHygiene: ActionHygieneReport;
  activeReflections: MemoryEntry[];
  dailyLoopCounts: {
    morningBriefs: number;
    eveningReviews: number;
  };
}

interface WeeklyGoalProgress {
  goalId: string;
  title: string;
  priority?: Goal["priority"];
  isRiskControl: boolean;
  progressCount: number;
  note: string;
}

interface WeeklyReviewDraft {
  summary: string;
  wins: string[];
  stalls: string[];
  goalProgress: WeeklyGoalProgress[];
  guardrailSummary: Record<string, unknown>;
  patterns: string[];
  recommendedNextWeekActions: string[];
  reflectionIds: string[];
  source: "deterministic" | "llm" | "mixed";
}

interface WeeklyReviewMemory {
  id: string;
  userId: string;
  weekStartLocalDate: string;
  weekEndLocalDate: string;
  reviewedEndLocalDate: string;
  timezone: string;
  status: "generated" | "archived";
  summary: string;
  wins: string[];
  stalls: string[];
  goalProgress: unknown[];
  guardrailSummary: Record<string, unknown>;
  patterns: string[];
  recommendedNextWeekActions: string[];
  reflectionIds: string[];
  source: "deterministic" | "llm" | "mixed";
  createdAt: Date;
  updatedAt: Date;
}

type OperatorReflectionType = "pattern" | "preference" | "friction" | "guardrail_pattern" | "goal_strategy" | "stale_goal";
type OperatorReflectionSource = "daily_reflection" | "weekly_reflection" | "manual_debug";

interface OperatorReflectionCandidate {
  type: OperatorReflectionType;
  title: string;
  summary: string;
  evidence: Record<string, unknown>;
  confidence: number;
  source: OperatorReflectionSource;
}

interface OperatorReflectionContext {
  userId: string;
  timezone: string;
  dateRange: {
    start: string;
    end: string;
    since: Date;
    until: Date;
  };
  activeGoals: Awaited<ReturnType<typeof getActiveGoals>>;
  completedActions: ActionItem[];
  overdueActions: ActionItem[];
  snoozedOrRescheduledActions: ActionItem[];
  archivedActions: ActionItem[];
  events: StoredEvent[];
  guardrailEvents: StoredEvent[];
  existingReflections: MemoryEntry[];
  goalsWithoutProgress: Awaited<ReturnType<typeof getActiveGoals>>;
  counts: {
    completedActions: number;
    overdueActions: number;
    snoozedOrRescheduledActions: number;
    archivedActions: number;
    events: number;
    guardrailTriggers: number;
    activeGoals: number;
    existingReflections: number;
  };
}

type ActionHygieneOption = "complete" | "snooze" | "archive" | "keep";

interface ActionHygieneAction {
  actionId: string;
  title: string;
  dueAt?: string;
  linkedGoalTitle?: string;
  priority: ActionItem["priority"];
  daysOverdue?: number;
  snoozeCount?: number;
  lastTouchedAt?: string;
  reason: string;
  recommendedOptions: ActionHygieneOption[];
}

interface ActionHygieneReport {
  staleActions: ActionHygieneAction[];
  overdueActions: ActionHygieneAction[];
  repeatedlySnoozedActions: ActionHygieneAction[];
  lowPriorityStaleActions: ActionHygieneAction[];
  suggestedCleanupCandidates: ActionHygieneAction[];
  summary: string;
}

interface NextWeekPlanContext {
  userId: string;
  timezone: string;
  now: Date;
  nextWeekStartLocalDate: string;
  nextWeekEndLocalDate: string;
  nextWeekRangeStart: Date;
  nextWeekRangeEnd: Date;
  latestWeeklyReview?: WeeklyReviewMemory;
  activeGoals: Goal[];
  goalsWithNoProgress: WeeklyGoalProgress[];
  openActions: ActionItem[];
  staleActions: ActionHygieneAction[];
  activeReflections: MemoryEntry[];
  recentEventsSummary: Record<string, number>;
  guardrailGoals: Goal[];
  guardrailEvents: StoredEvent[];
  futureActionsNextWeek: ActionItem[];
  reviewedWeek: {
    weekStartLocalDate: string;
    weekEndLocalDate: string;
    reviewedEndLocalDate: string;
  };
}

interface NextWeekPlanSuggestion {
  index: number;
  title: string;
  reason: string;
  goalId?: string;
  goalTitle?: string;
  priority: "low" | "medium" | "high" | "critical";
  actionPriority?: "low" | "medium" | "high";
  suggestedDueAt: Date;
  actionType: "generic";
  source: "weekly_plan";
  duplicateRisk: boolean;
  existingActionId?: string;
  existingActionTitle?: string;
  planKind?: "action" | "cleanup";
  creatable?: boolean;
  notCreatableReason?: string;
}

type DailyCoachSource = "llm" | "fallback_disabled" | "fallback_invalid" | "fallback_error" | "fallback_timeout";

interface DailyCoachDebug {
  source: DailyCoachSource;
  llmAttempted: boolean;
  validationStatus: "passed" | "failed" | "skipped";
  validationFailureCodes: string[];
  validationFailureSummary?: string;
  schemaValidationPassed: boolean;
  fallbackReason?: string;
  selectedActionTitle?: string;
  rawResponseType?: "json_object" | "text" | "empty" | "unknown";
  parsedFieldsPresent?: string[];
  responseLength?: number;
  diagnosisLength?: number;
  nextMoveLength?: number;
  warningLength?: number;
  encouragementLength?: number;
}

interface DailyCoachGenerationResult {
  coach: DailyCoachResponse;
  debug: DailyCoachDebug;
}

interface ConversationControlResponse {
  handled: boolean;
  reply?: string;
  debug: Awaited<ReturnType<typeof buildConversationControlDebugForUser>>;
  action?: unknown;
  goal?: unknown;
  brief?: DailyOperatorBrief;
  actions?: unknown[];
}

interface DailyOperatorBriefAction {
  id: string;
  title: string;
  status: ActionItem["status"];
  priority: ActionItem["priority"];
  dueAt?: string;
  snoozedUntil?: string;
  goalId?: string;
  goalTitle?: string;
}

interface DailyOperatorBriefGoalStatus {
  goalId: string;
  title: string;
  status: string;
  note: string;
  openActionTitle?: string;
  completedActionTitle?: string;
}

interface DailyOperatorBriefPriorityDebug {
  rank: number;
  actionId: string;
  title: string;
  score: number;
  rankReason: string;
  factors: string[];
}

interface ActionReminderDispatch {
  actionItem: ReturnType<typeof sanitizeActionItem>;
  reminderType: ActionItemReminderType;
  message: string;
}

interface GmailMessagePart {
  mimeType?: string;
  headers?: Array<{
    name: string;
    value: string;
  }>;
  body?: {
    data?: string;
  };
  parts?: GmailMessagePart[];
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
