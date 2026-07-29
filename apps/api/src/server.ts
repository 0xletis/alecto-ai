import Fastify from "fastify";
import {
  buildDailyReview,
  buildDailyInsight,
  buildDailyCheckinPrompt,
  buildCustomGoalConfig,
  composeAgentResponse,
  buildWeeklyInsight,
  classifyJobSearchEmail,
  classifyWorkActionEmail,
  CreateGoalFromTemplateInputSchema,
  CreateGoalInputSchema,
  CustomGoalConfigInputSchema,
  CustomGoalProgressInputSchema,
  DailyCheckInInputSchema,
  DailyCheckInTextInputSchema,
  EventTypeSchema,
  eventRegistry,
  extractManualAction,
  normalizeManualActionTitleKey,
  extractEvents,
  findGoalDuplicateWarnings,
  getGoalTemplate,
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
  parsedDailyCheckInToAnswers,
  parseDailyCheckinText,
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
  type MemoryEntry,
  type ProcessMessageResult,
  type StoredEvent,
  type UpdateUserOperatingProfileInput
} from "@operator-agent/core";
import {
  analyzeMessageWithOpenAI,
  classifyEmailWithLLM,
  composeResponseWithOpenAI,
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
  getIntegrationConnection,
  getIntegrationConnections,
  approveEmailReviewItem,
  approvePendingGmailReviewItemsForSemanticEvent,
  rejectPendingAction,
  rejectEmailReviewItem,
  completeActionItem,
  archiveActionItem,
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
  type CreateActionItemInput,
  updateIntegrationConnection,
  updateIntegrationConnectionConfig,
  updateIntegrationConnectionSyncState,
  updateEmailSignalRule,
  updateEmailSignalRuleSyncState,
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

      const actionResult = await maybeCreateManualActionFromText(parsed.data.userId, explicitMemory.summary);
      const replyText = actionResult.extraction.shouldCreateAction
        ? ["Saved to memory.", formatActionCreatedReply(actionResult)].join("\n")
        : "Saved to memory.";

      return replyOnly(parsed.data.userId, parsed.data.message, replyText);
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
    const manualActionResult = await maybeCreateManualActionFromText(parsed.data.userId, parsed.data.message);

    if (manualActionResult.extraction.shouldCreateAction) {
      return replyOnly(parsed.data.userId, parsed.data.message, formatActionCreatedReply(manualActionResult));
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

  server.get<{ Params: { userId: string } }>("/users/:userId/today", async (request) => ({
    brief: await generateDailyOperatorBrief(request.params.userId)
  }));

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

  server.post<{ Params: { userId: string } }>(
    "/users/:userId/actions/manual",
    async (request, reply) => {
      const body = isRecord(request.body) ? request.body : {};
      const text = typeof body.text === "string" ? body.text : "";

      if (!text.trim()) {
        return reply.status(400).send({ error: "Action text is required." });
      }

      const result = await maybeCreateManualActionFromText(request.params.userId, text, { forceActionIntent: true });

      if (!result.extraction.shouldCreateAction) {
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

  server.patch<{ Params: { userId: string; actionId: string } }>(
    "/users/:userId/actions/:actionId/complete",
    async (request, reply) => {
      const actionItem = await completeActionItem(request.params.userId, request.params.actionId);

      if (!actionItem) {
        return reply.status(404).send({ error: "Action item not found" });
      }

      return {
        action: sanitizeActionItem(actionItem),
        message: `Action completed: ${actionItem.title}`
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
      const body = request.body as { snoozedUntil?: string };
      const snoozedUntil = body.snoozedUntil ? new Date(body.snoozedUntil) : undefined;

      if (!snoozedUntil || Number.isNaN(snoozedUntil.getTime())) {
        return reply.status(400).send({ error: "Invalid snoozedUntil" });
      }

      const actionItem = await snoozeActionItem(request.params.userId, request.params.actionId, snoozedUntil);

      if (!actionItem) {
        return reply.status(404).send({ error: "Action item not found" });
      }

      return {
        action: sanitizeActionItem(actionItem),
        message: `Action snoozed until ${actionItem.snoozedUntil?.toISOString()}: ${actionItem.title}`
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

async function generateDailyOperatorBrief(userId: string): Promise<DailyOperatorBrief> {
  const now = new Date();
  const todayStart = startOfToday();
  const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const [actions, activeGoals, todayEvents, recentEvents, recentReviews] = await Promise.all([
    getRecentActionItems(userId, 50),
    getActiveGoals(userId),
    getEventsSince(userId, todayStart),
    getEventsSince(userId, last24h),
    getEmailReviewItems(userId, { status: "all", limit: 10 })
  ]);
  const visibleActions = actions.filter((action) => action.status !== "archived");
  const openActions = visibleActions.filter((action) => action.status === "open" || isSnoozedDue(action, now));
  const overdueActions = openActions.filter((action) => action.dueAt && action.dueAt < now);
  const dueSoonActions = openActions.filter((action) => isActionDueSoon(action, now));
  const completedToday = visibleActions.filter(
    (action) => action.status === "completed" && action.completedAt && action.completedAt >= todayStart
  );
  const goalStatus = activeGoals.map((goal) => buildOperatorGoalStatus(goal, todayEvents));
  const recentWins = buildOperatorRecentWins(todayEvents, completedToday, recentReviews);
  const risks = buildOperatorRisks(recentEvents);
  const topPriorities = buildOperatorTopPriorities({
    overdueActions,
    dueSoonActions,
    openActions,
    goalStatus,
    risks
  });
  const suggestedNextStep = pickOperatorNextStep({
    overdueActions,
    dueSoonActions,
    openActions,
    goalStatus
  });

  return {
    date: formatLocalDate(now),
    summary: buildOperatorSummary({ openActions, overdueActions, activeGoals, todayEvents, risks }),
    topPriorities,
    openActions: openActions.slice(0, 10).map(toBriefAction),
    overdueActions: overdueActions.slice(0, 10).map(toBriefAction),
    goalStatus,
    recentWins,
    risks,
    suggestedNextStep
  };
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

function buildOperatorTopPriorities(input: {
  overdueActions: ActionItem[];
  dueSoonActions: ActionItem[];
  openActions: ActionItem[];
  goalStatus: DailyOperatorBriefGoalStatus[];
  risks: string[];
}): string[] {
  const priorities: string[] = [];
  const seenActionIds = new Set<string>();
  const seenActionTitles = new Set<string>();

  const addActionPriority = (action: ActionItem, label?: string) => {
    const titleKey = normalizeManualActionTitleKey(action.title);

    if (seenActionIds.has(action.id) || seenActionTitles.has(titleKey)) {
      return;
    }

    seenActionIds.add(action.id);
    seenActionTitles.add(titleKey);
    priorities.push(label ? `${label}: ${action.title}` : action.title);
  };

  input.overdueActions.forEach((action) => addActionPriority(action, "Overdue"));
  input.dueSoonActions.forEach((action) => addActionPriority(action, "Due soon"));
  input.openActions.forEach((action) => addActionPriority(action));

  for (const goal of input.goalStatus.filter((item) => item.status === "no_progress")) {
    priorities.push(`Log progress for ${goal.title}`);
  }

  priorities.push(...input.risks.slice(0, 1));

  return uniqueStrings(priorities).slice(0, 3);
}

function pickOperatorNextStep(input: {
  overdueActions: ActionItem[];
  dueSoonActions: ActionItem[];
  openActions: ActionItem[];
  goalStatus: DailyOperatorBriefGoalStatus[];
}): string {
  const overdue = input.overdueActions[0];
  if (overdue) {
    return `Handle overdue action: ${overdue.title}.`;
  }

  const due = input.dueSoonActions[0];
  if (due) {
    return `Handle due action: ${due.title}.`;
  }

  const open = input.openActions[0];
  if (open) {
    return `Do this first: ${open.title}.`;
  }

  const staleGoal = input.goalStatus.find((goal) => goal.status === "no_progress");
  if (staleGoal) {
    return `Log one concrete action for ${staleGoal.title}.`;
  }

  return "Log one meaningful action.";
}

function buildOperatorGoalStatus(
  goal: Awaited<ReturnType<typeof getActiveGoals>>[number],
  todayEvents: StoredEvent[]
): DailyOperatorBriefGoalStatus {
  const note = goalProgressNoteForToday(goal, todayEvents);

  return {
    goalId: goal.id,
    title: goal.title,
    status: note === "no progress logged today" ? "no_progress" : "progress",
    note
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

function buildOperatorRecentWins(events: StoredEvent[], completedActions: ActionItem[], recentReviews: EmailReviewItem[]): string[] {
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
    recentReviews.some((review) => review.status === "approved" && review.reviewedAt && review.reviewedAt >= startOfToday())
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

function toBriefAction(action: ActionItem): DailyOperatorBriefAction {
  return {
    id: action.id,
    title: action.title,
    status: action.status,
    priority: action.priority,
    dueAt: action.dueAt?.toISOString(),
    snoozedUntil: action.snoozedUntil?.toISOString()
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

function formatLocalDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function maybeCreateManualActionFromText(
  userId: string,
  text: string,
  options: { forceActionIntent?: boolean } = {}
): Promise<{
  extraction: ReturnType<typeof extractManualAction>;
  action?: ActionItem;
  duplicate: boolean;
}> {
  const extraction = extractManualAction({ text }, { forceActionIntent: options.forceActionIntent });

  if (!extraction.shouldCreateAction || !extraction.title) {
    return { extraction, duplicate: false };
  }

  const duplicate = await findDuplicateManualAction(userId, extraction.title, extraction.dueAt);

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
  const action = await createActionItem(userId, {
    source: "manual",
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

async function findDuplicateManualAction(userId: string, title: string, dueAt?: Date): Promise<ActionItem | undefined> {
  const actions = await getRecentActionItems(userId, 100);
  const titleKey = normalizeManualActionTitleKey(title);
  const dueKey = dueAt ? formatLocalDate(dueAt) : "";

  return actions.find((action) => {
    if (action.source !== "manual" || (action.status !== "open" && action.status !== "snoozed")) {
      return false;
    }

    const actionDueKey = action.dueAt ? formatLocalDate(action.dueAt) : "";
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
    ? `due: ${input.extraction.dueText ?? formatLocalDate(input.action.dueAt)}`
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
  topPriorities: string[];
  openActions: DailyOperatorBriefAction[];
  overdueActions: DailyOperatorBriefAction[];
  goalStatus: DailyOperatorBriefGoalStatus[];
  recentWins: string[];
  risks: string[];
  suggestedNextStep: string;
}

interface DailyOperatorBriefAction {
  id: string;
  title: string;
  status: ActionItem["status"];
  priority: ActionItem["priority"];
  dueAt?: string;
  snoozedUntil?: string;
}

interface DailyOperatorBriefGoalStatus {
  goalId: string;
  title: string;
  status: string;
  note: string;
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
