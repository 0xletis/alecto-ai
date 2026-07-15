import Fastify from "fastify";
import {
  buildDailyReview,
  buildDailyInsight,
  buildDailyCheckinPrompt,
  buildCustomGoalConfig,
  composeAgentResponse,
  buildWeeklyInsight,
  CreateGoalFromTemplateInputSchema,
  CreateGoalInputSchema,
  CustomGoalConfigInputSchema,
  CustomGoalProgressInputSchema,
  DailyCheckInInputSchema,
  DailyCheckInTextInputSchema,
  EventTypeSchema,
  eventRegistry,
  extractEvents,
  findGoalDuplicateWarnings,
  getGoalTemplate,
  goalTemplates,
  IngestTextBodySchema,
  GithubPublicConnectionInputSchema,
  integrationRegistry,
  CreateMemoryInputSchema,
  PendingMemoryCreatePayloadSchema,
  processMessage,
  processMessageFromAnalysis,
  ProcessMessageInputSchema,
  parsedDailyCheckInToAnswers,
  parseDailyCheckinText,
  routeIngestion,
  UpdateIntegrationConnectionInputSchema,
  UpdateNotificationSettingsInputSchema,
  UpdateUserOperatingProfileInputSchema,
  type IngestTextBody,
  type MessageIntent,
  type InsightReport,
  type AgentResponse,
  type AgentResponseComposerInput,
  type MemoryEntry,
  type ProcessMessageResult,
  type StoredEvent,
  type UpdateUserOperatingProfileInput
} from "@operator-agent/core";
import {
  analyzeMessageWithOpenAI,
  composeResponseWithOpenAI,
  polishInsightWithOpenAI,
  type OpenAIMessageAnalysis
} from "@operator-agent/llm";
import {
  archiveEvent,
  archiveEventGroup,
  archiveGoal,
  archiveMemory,
  correctEvent,
  createEvent,
  createEvents,
  createEventsFromExtracted,
  createGoal,
  createMemory,
  createMemoryFromPendingPayload,
  createPendingAction,
  expireOldPendingActions,
  getActiveGoals,
  getActiveMemories,
  getEventById,
  getEvents,
  getEventsSince,
  getGoals,
  getLatestPendingAction,
  getOrCreateNotificationSettings,
  getPendingActions,
  getOrCreateUserOperatingProfile,
  getMemories,
  getRecentEvents,
  getRelevantMemories,
  hasRecentNotificationLog,
  confirmPendingAction,
  createExternalEventIfNotExists,
  createGithubPublicConnection,
  createIntegrationSyncLog,
  ensureUser,
  getIntegrationConnection,
  getIntegrationConnections,
  rejectPendingAction,
  undoLastEvents,
  type PendingAction,
  type PendingActionType,
  type IntegrationConnection,
  updateIntegrationConnection,
  updateIntegrationConnectionSyncState,
  updateNotificationSettings,
  updateUserOperatingProfile
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

    const latestPendingAction = await getLatestPendingAction(parsed.data.userId);

    if (latestPendingAction && isConfirmationMessage(parsed.data.message)) {
      const applied = await applyPendingAction(parsed.data.userId, latestPendingAction);
      await confirmPendingAction(parsed.data.userId, latestPendingAction.id);
      return replyOnly(parsed.data.userId, parsed.data.message, applied.reply);
    }

    if (latestPendingAction && isRejectionMessage(parsed.data.message)) {
      await rejectPendingAction(parsed.data.userId, latestPendingAction.id);
      return replyOnly(parsed.data.userId, parsed.data.message, "Cancelled. I did not change anything.");
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

      return replyOnly(parsed.data.userId, parsed.data.message, "Saved to memory.");
    }

    const recentEvents = await getRecentEvents(parsed.data.userId, 50);
    const activeGoals = await getActiveGoals(parsed.data.userId);
    const activeMemories = await getActiveMemories(parsed.data.userId);
    const userOperatingProfile = await getOrCreateUserOperatingProfile(parsed.data.userId);
    const processInput = {
      ...parsed.data,
      recentEvents,
      userOperatingProfile
    };

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

    if (isRedFinancialRisk) {
      const cooldownEvent = await createEvent(result.userId, {
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

  server.get<{ Params: { userId: string } }>("/users/:userId/profile", async (request) => ({
    profile: await getOrCreateUserOperatingProfile(request.params.userId)
  }));

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
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    return {
      review: buildDailyReview({
        userId: request.params.userId,
        activeGoals: await getActiveGoals(request.params.userId),
        todayEvents: await getEventsSince(request.params.userId, todayStart),
        activeMemories: await getRelevantMemories(request.params.userId, {
          types: ["risk_pattern"],
          limit: 3
        })
      })
    };
  });

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
    connections: await getIntegrationConnections(request.params.userId)
  }));

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

      return {
        connection: await createGithubPublicConnection(request.params.userId, parsed.data)
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

      return { connection };
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

      if (connection.status === "paused") {
        return reply.status(400).send({
          error: "Integration connection is paused"
        });
      }

      if (connection.integrationId !== "github_public") {
        return reply.status(400).send({
          error: "Unsupported integration sync"
        });
      }

      const result = await syncGithubPublicConnection(connection);

      if (result.status === "error") {
        return reply.status(502).send({
          error: result.error,
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
  const todayEvents = await getEventsSince(userId, startOfToday());
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
          if (eventType === "coding.commit_created") {
            personalCommitEvents += 1;
          } else {
            repoActivityEvents += 1;
          }
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
      error: reason.includes(":") ? `GitHub sync failed for ${reason}` : `GitHub sync failed: ${reason}`,
      syncLog
    };
  }
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

async function applyPendingAction(userId: string, pendingAction: PendingAction): Promise<{ reply: string }> {
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

class GithubFetchError extends Error {
  constructor(
    readonly code: "GITHUB_REPO_NOT_FOUND_OR_PRIVATE" | "GITHUB_RATE_LIMITED" | "GITHUB_FETCH_FAILED",
    message: string
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
