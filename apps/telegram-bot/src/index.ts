import { config } from "dotenv";
import { Bot, type Context } from "grammy";
import {
  buildNormalizedInboundMessage,
  explainNormalizedInboundRoute,
  looksLikeMultiIntentText,
  routeNormalizedInboundMessage,
  segmentInboundMessage,
  shouldCheckRecentDailyCheckInReminder,
  splitPendingDecisionReplyWithCommands,
  type InboundRouteDebug,
  type NormalizedInboundMessage
} from "@operator-agent/core";

config({
  path: new URL("../../../.env", import.meta.url).pathname
});

const token = process.env.TELEGRAM_BOT_TOKEN;
const apiBaseUrl = process.env.API_BASE_URL ?? "http://localhost:3000";
const allowedUserIds = parseAllowedUserIds(process.env.TELEGRAM_ALLOWED_USER_IDS);

if (!token) {
  throw new Error("TELEGRAM_BOT_TOKEN is required.");
}

const bot = new Bot(token);

bot.use(async (ctx, next) => {
  const text = ctx.message?.text;

  if (!text) {
    await next();
    return;
  }

  const segment = segmentInboundMessage(text);

  if (text.trim().match(/^\/debug_route(?:@\w+)?\b/i)) {
    await next();
    return;
  }

  const pendingReplyWithCommands = splitPendingDecisionReplyWithCommands(text);

  if (pendingReplyWithCommands) {
    if (!(await guardAllowedUser(ctx))) {
      return;
    }

    const pendingAction = await getLatestPendingAction(ctx);

    if (pendingAction) {
      const pendingResponse = await apiPost<ProcessMessageResponse>("/messages/process", {
        userId: getTelegramUserId(ctx),
        message: pendingReplyWithCommands.replyText
      });
      const commandResponse =
        pendingReplyWithCommands.commands.length > 0
          ? await executeCommandBatch(ctx, pendingReplyWithCommands.commands)
          : undefined;

      await replyWithIntegrationMessage(ctx, [pendingResponse.reply, commandResponse].filter(Boolean).join("\n\n"));
      return;
    }
  }

  if (segment.kind === "command_batch") {
    if (!(await guardAllowedUser(ctx))) {
      return;
    }

    await replyWithIntegrationMessage(ctx, await executeCommandBatch(ctx, segment.commands));
    return;
  }

  if (segment.kind === "reference_text") {
    if (!(await guardAllowedUser(ctx))) {
      return;
    }

    await ctx.reply(
      segment.reason === "command_plus_extra_text"
        ? "That looks like a command plus extra text. Send one command per message or use a supported multiline command."
        : segment.reason === "mixed_text_and_command"
          ? "Send the action request and command separately."
          : "That looks like pasted reference text, so I did not execute any commands."
    );
    return;
  }

  await next();
});

bot.command("whoami", async (ctx) => {
  const telegramUserId = ctx.from?.id;

  if (!telegramUserId) {
    await ctx.reply("I could not read your Telegram ID.");
    return;
  }

  await ctx.reply(
    [
      `Your Telegram ID is ${telegramUserId}.`,
      `Your agent userId is telegram:${telegramUserId}.`,
      "Send this ID to the owner if you need access."
    ].join("\n")
  );
});

bot.command("start", async (ctx) => {
  if (!(await guardAllowedUser(ctx, "start"))) {
    return;
  }

  const response = await apiGet<OnboardingResponse>(`/users/${getTelegramUserId(ctx)}/onboarding/start`);
  await ctx.reply(response.message);
});

bot.command("setup", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  const response = await apiGet<OnboardingResponse>(`/users/${getTelegramUserId(ctx)}/onboarding/setup`);
  await ctx.reply(response.message);
});

bot.command("help", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  const response = await apiPost<ProcessMessageResponse>("/messages/process", {
    userId: getTelegramUserId(ctx),
    message: "what can you do"
  });
  await ctx.reply(response.reply);
});

bot.command("debug_route", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  const text = getCommandText(ctx);

  if (!text) {
    await ctx.reply("Usage: /debug_route <message>");
    return;
  }

  const inbound = buildNormalizedTelegramMessage(ctx, text);
  const debug = explainNormalizedInboundRoute(inbound);
  await ctx.reply(formatRouteDebug(debug));
});

bot.command("debug_conversation_intent", async (ctx) => {
  if (!(await guardDebugAllowedUser(ctx))) {
    return;
  }

  const text = getCommandText(ctx);

  if (!text) {
    await ctx.reply("Usage: /debug_conversation_intent <message>");
    return;
  }

  try {
    const response = await apiPost<ConversationControlResponse>(`/users/${getTelegramUserId(ctx)}/conversation/control`, {
      text,
      dryRun: true,
      now: buildNormalizedTelegramMessage(ctx, text).timestamp.toISOString()
    });
    await ctx.reply(formatConversationControlDebug(response.debug));
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not debug that conversational intent.");
  }
});

bot.command("debug_intent_plan", async (ctx) => {
  if (!(await guardDebugAllowedUser(ctx))) {
    return;
  }

  const text = getCommandText(ctx);

  if (!text) {
    await ctx.reply("Usage: /debug_intent_plan <message>");
    return;
  }

  try {
    const response = await apiPost<IntentPlanResponse>(`/users/${getTelegramUserId(ctx)}/conversation/multi-intent`, {
      text,
      dryRun: true,
      now: buildNormalizedTelegramMessage(ctx, text).timestamp.toISOString()
    });
    await ctx.reply(formatIntentPlanDebug(response));
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not debug that intent plan.");
  }
});

bot.command("profile", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  try {
    const response = await apiGet<ProfileResponse>(`/users/${getTelegramUserId(ctx)}/profile`);
    await ctx.reply(formatProfile(response.profile));
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not fetch your profile right now.");
  }
});

bot.command("memory", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  try {
    const response = await apiGet<MemoriesResponse>(`/users/${getTelegramUserId(ctx)}/memory`);
    await ctx.reply(formatMemories(response.memories));
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not fetch your memories right now.");
  }
});

bot.command("remember", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  const text = getCommandText(ctx);

  if (!text) {
    await ctx.reply("Usage: /remember I prefer direct feedback");
    return;
  }

  try {
    await apiPost<MemoryResponse>(`/users/${getTelegramUserId(ctx)}/memory`, {
      type: inferMemoryType(text),
      summary: normalizeMemorySummary(text)
    });
    const actionResponse = await tryCreateManualAction(ctx, text);
    await ctx.reply(actionResponse ? ["Saved to memory.", actionResponse.message].join("\n") : "Saved to memory.");
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not save that memory right now.");
  }
});

bot.command("forget_memory", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  const memoryId = getCommandText(ctx);

  if (!memoryId) {
    await ctx.reply("Usage: /forget_memory <memoryId>");
    return;
  }

  try {
    await apiPatch<MemoryResponse>(`/users/${getTelegramUserId(ctx)}/memory/${memoryId}/archive`, {});
    await ctx.reply("Archived memory.");
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not archive that memory. Check the ID and try again.");
  }
});

bot.command("reflect", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  try {
    const response = await apiPost<OperatorReflectionsResponse>(`/users/${getTelegramUserId(ctx)}/reflections/generate`, {});
    await ctx.reply(response.message);
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not generate operator reflections right now.");
  }
});

bot.command("reflections", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  try {
    const response = await apiGet<OperatorReflectionsResponse>(`/users/${getTelegramUserId(ctx)}/reflections`);
    await ctx.reply(response.message);
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not fetch operator reflections right now.");
  }
});

bot.command("forget_reflection", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  const reflectionId = getCommandText(ctx);

  if (!reflectionId) {
    await ctx.reply("Usage: /forget_reflection <reflectionIdOrNumber>");
    return;
  }

  try {
    const response = await apiPatch<OperatorReflectionResponse>(`/users/${getTelegramUserId(ctx)}/reflections/${encodeURIComponent(reflectionId)}/archive`, {});
    await ctx.reply(response.message);
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not archive that reflection. Check the ID and try again.");
  }
});

bot.command("debug_reflection_context", async (ctx) => {
  if (!(await guardDebugAllowedUser(ctx))) {
    return;
  }

  try {
    const response = await apiGet<OperatorReflectionContextResponse>(`/users/${getTelegramUserId(ctx)}/reflections/context`);
    await ctx.reply(response.message);
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not build reflection context right now.");
  }
});

bot.command("notifications", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  try {
    const response = await apiGet<NotificationSettingsResponse>(
      `/users/${getTelegramUserId(ctx)}/notification-settings`
    );
    await ctx.reply(formatNotificationSettings(response.notificationSettings));
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not fetch notification settings right now.");
  }
});

bot.command("reminder_settings", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  try {
    const response = await apiGet<NotificationSettingsResponse>(
      `/users/${getTelegramUserId(ctx)}/notification-settings`
    );
    await ctx.reply(formatReminderSettings(response.notificationSettings));
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not load reminder settings right now.");
  }
});

bot.command("set_reminder_time", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  const parsed = parseSetReminderTimeCommand(getCommandText(ctx));

  if (!parsed) {
    await ctx.reply("Usage: /set_reminder_time default 09:00\nOptions: default, morning, afternoon, evening, tonight");
    return;
  }

  try {
    const response = await apiPatch<NotificationSettingsResponse>(
      `/users/${getTelegramUserId(ctx)}/notification-settings`,
      { [parsed.field]: parsed.minutes }
    );
    await ctx.reply(formatReminderSettings(response.notificationSettings));
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not update reminder settings right now.");
  }
});

bot.command("daily_loop_settings", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  try {
    const response = await apiGet<NotificationSettingsResponse>(
      `/users/${getTelegramUserId(ctx)}/notification-settings`
    );
    await ctx.reply(formatDailyLoopSettings(response.notificationSettings));
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not load daily loop settings right now.");
  }
});

bot.command("set_daily_loop", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  const parsed = parseSetDailyLoopCommand(getCommandText(ctx));

  if (!parsed) {
    await ctx.reply("Usage: /set_daily_loop enabled on|off\n/set_daily_loop morning 09:00\n/set_daily_loop evening 21:00");
    return;
  }

  try {
    const response = await apiPatch<NotificationSettingsResponse>(
      `/users/${getTelegramUserId(ctx)}/notification-settings`,
      {
        ...parsed,
        telegramUserId: getRawTelegramUserId(ctx),
        timezone: "Europe/Madrid"
      }
    );
    await ctx.reply(formatDailyLoopSettings(response.notificationSettings));
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not update daily loop settings right now.");
  }
});

bot.command("enable_checkin", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  const time = getCommandText(ctx);

  if (!/^\d{2}:\d{2}$/.test(time)) {
    await ctx.reply("Usage: /enable_checkin 09:00");
    return;
  }

  try {
    const response = await apiPatch<NotificationSettingsResponse>(
      `/users/${getTelegramUserId(ctx)}/notification-settings`,
      {
        telegramUserId: getRawTelegramUserId(ctx),
        dailyCheckinEnabled: true,
        dailyCheckinTime: time,
        timezone: "Europe/Madrid"
      }
    );
    await ctx.reply(
      `Daily check-in enabled at ${response.notificationSettings.dailyCheckinTime} ${response.notificationSettings.timezone}.`
    );
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not enable daily check-ins right now.");
  }
});

bot.command("disable_checkin", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  try {
    await apiPatch<NotificationSettingsResponse>(`/users/${getTelegramUserId(ctx)}/notification-settings`, {
      dailyCheckinEnabled: false
    });
    await ctx.reply("Daily check-in disabled.");
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not disable daily check-ins right now.");
  }
});

bot.command("enable_daily_insight", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  const time = getCommandText(ctx);

  if (!/^\d{2}:\d{2}$/.test(time)) {
    await ctx.reply("Usage: /enable_daily_insight 21:30");
    return;
  }

  try {
    const response = await apiPatch<NotificationSettingsResponse>(
      `/users/${getTelegramUserId(ctx)}/notification-settings`,
      {
        telegramUserId: getRawTelegramUserId(ctx),
        dailyInsightEnabled: true,
        dailyInsightTime: time,
        timezone: "Europe/Madrid"
      }
    );
    await ctx.reply(
      `Daily insight enabled at ${response.notificationSettings.dailyInsightTime} ${response.notificationSettings.timezone}.`
    );
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not enable daily insight right now.");
  }
});

bot.command("disable_daily_insight", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  try {
    await apiPatch<NotificationSettingsResponse>(`/users/${getTelegramUserId(ctx)}/notification-settings`, {
      dailyInsightEnabled: false
    });
    await ctx.reply("Daily insight disabled.");
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not disable daily insight right now.");
  }
});

bot.command("enable_weekly_insight", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  const parsed = parseWeeklyInsightCommand(getCommandText(ctx));

  if (!parsed) {
    await ctx.reply("Usage: /enable_weekly_insight sunday 20:00");
    return;
  }

  try {
    const response = await apiPatch<NotificationSettingsResponse>(
      `/users/${getTelegramUserId(ctx)}/notification-settings`,
      {
        telegramUserId: getRawTelegramUserId(ctx),
        weeklyInsightEnabled: true,
        weeklyInsightDay: parsed.day,
        weeklyInsightTime: parsed.time,
        timezone: "Europe/Madrid"
      }
    );
    await ctx.reply(
      `Weekly insight enabled on ${response.notificationSettings.weeklyInsightDay} at ${response.notificationSettings.weeklyInsightTime} ${response.notificationSettings.timezone}.`
    );
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not enable weekly insight right now.");
  }
});

bot.command("disable_weekly_insight", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  try {
    await apiPatch<NotificationSettingsResponse>(`/users/${getTelegramUserId(ctx)}/notification-settings`, {
      weeklyInsightEnabled: false
    });
    await ctx.reply("Weekly insight disabled.");
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not disable weekly insight right now.");
  }
});

bot.command("send_checkin_now", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  try {
    const response = await apiGet<DailyCheckInPromptResponse>(`/users/${getTelegramUserId(ctx)}/checkins/daily/prompt`);
    await ctx.reply(response.prompt);
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not build your check-in prompt right now.");
  }
});

bot.command("send_daily_insight_now", async (ctx) => {
  await sendInsight(ctx, "daily");
});

bot.command("send_weekly_insight_now", async (ctx) => {
  await sendInsight(ctx, "weekly");
});

bot.command("set_style", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  const style = getCommandText(ctx);
  const payload =
    style === "hard_guardian" ? hardGuardianProfile() : style === "balanced" ? balancedProfile() : undefined;

  if (!payload) {
    await ctx.reply("Usage: /set_style hard_guardian or /set_style balanced");
    return;
  }

  try {
    const response = await apiPatch<ProfileResponse>(`/users/${getTelegramUserId(ctx)}/profile`, payload);
    await ctx.reply(
      [
        `Style updated: ${style}`,
        `directness: ${response.profile.directness}`,
        `confrontation: ${response.profile.confrontation}`,
        `gamblingGuardrails: ${response.profile.gamblingGuardrails}`,
        `cooldownPreference: ${response.profile.cooldownPreference}`,
        `vulnerableMode: ${response.profile.vulnerableMode}`
      ].join("\n")
    );
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not update your style right now.");
  }
});

bot.command("create_goal", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  const parsed = parseCreateGoal(getCommandText(ctx));

  if (!parsed) {
    await ctx.reply(
      [
        "Usage:",
        "/create_goal career | Find a new Web3 developer job | Build stable career capital",
        "/create_goal health | Improve strength and energy"
      ].join("\n")
    );
    return;
  }

  try {
    const response = await apiPost<GoalResponse>(`/users/${getTelegramUserId(ctx)}/goals`, parsed);
    if (response.duplicate) {
      await ctx.reply(formatDuplicateGoalMessage(response));
      return;
    }

    if (!response.goal) {
      await ctx.reply("I could not create that goal right now.");
      return;
    }

    await ctx.reply(`Goal created:\n${formatGoal(response.goal)}`);
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not create that goal right now.");
  }
});

bot.command("templates", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  try {
    const response = await apiGet<GoalTemplatesResponse>("/goal-templates");
    await ctx.reply(formatGoalTemplates(response.goalTemplates));
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not fetch goal templates right now.");
  }
});

bot.command("integrations", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  try {
    const response = await apiGet<IntegrationsResponse>("/integrations");
    await ctx.reply(formatIntegrationDefinitions(response.integrations));
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not fetch integrations right now.");
  }
});

bot.command("my_integrations", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  try {
    const includeArchived = getCommandText(ctx).trim().toLowerCase() === "all";
    const response = await apiGet<IntegrationConnectionsResponse>(`/users/${getTelegramUserId(ctx)}/integrations`);
    const [goals, rules] = await Promise.all([
      apiGet<GoalsResponse>(`/users/${getTelegramUserId(ctx)}/goals`),
      apiGet<EmailRulesResponse>(`/users/${getTelegramUserId(ctx)}/email-rules`)
    ]);
    await ctx.reply(
      [
        formatIntegrationConnections(response.connections, includeArchived),
        gmailRuleSuggestion(response.connections, goals.goals, rules.emailRules)
      ]
        .filter(Boolean)
        .join("\n\n")
    );
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not fetch your integrations right now.");
  }
});

bot.command("connect_github", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  const parsed = parseConnectGithubCommand(getCommandText(ctx));

  if (!parsed) {
    await ctx.reply("Usage: /connect_github OWNER/REPO or /connect_github OWNER/REPO author=LOGIN");
    return;
  }

  try {
    const response = await apiPost<IntegrationConnectionResponse>(
      `/users/${getTelegramUserId(ctx)}/integrations/github-public`,
      parsed
    );
    if (response.duplicate) {
      await ctx.reply(response.message ?? `GitHub integration already exists: ${response.connection.id}`);
      return;
    }

    await ctx.reply(`GitHub connected:\n${formatIntegrationConnection(response.connection)}`);
  } catch (error) {
    await replyWithIntegrationMessage(ctx, safeIntegrationErrorMessage(error));
  }
});

bot.command("connect_gmail", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  try {
    const response = await apiGet<GmailOAuthUrlResponse>(
      `/users/${getTelegramUserId(ctx)}/integrations/gmail/oauth-url`
    );
    await ctx.reply(`Connect Gmail:\n${response.url}`);
  } catch (error) {
    await replyWithIntegrationMessage(ctx, safeIntegrationErrorMessage(error));
  }
});

bot.command("my_email_rules", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  try {
    const [rules, integrations] = await Promise.all([
      apiGet<EmailRulesResponse>(`/users/${getTelegramUserId(ctx)}/email-rules`),
      apiGet<IntegrationConnectionsResponse>(`/users/${getTelegramUserId(ctx)}/integrations`)
    ]);
    await ctx.reply(formatEmailRules(rules.emailRules, integrations.connections));
  } catch (error) {
    await replyWithIntegrationMessage(ctx, safeIntegrationErrorMessage(error));
  }
});

bot.command("enable_email_rule", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  const parsed = parseEnableEmailRuleCommand(getCommandText(ctx));

  if (!parsed || !["job_search", "work_action"].includes(parsed.kind)) {
    await ctx.reply("Usage: /enable_email_rule job_search|work_action or /enable_email_rule job_search goal=GOAL_ID");
    return;
  }

  try {
    const integrations = await apiGet<IntegrationConnectionsResponse>(`/users/${getTelegramUserId(ctx)}/integrations`);
    const gmailConnection = integrations.connections.find(
      (connection) => connection.integrationId === "gmail" && connection.status === "active"
    );

    if (!gmailConnection) {
      await ctx.reply("Connect Gmail first with /connect_gmail.");
      return;
    }

    const response = await apiPost<EmailRuleResponse>(`/users/${getTelegramUserId(ctx)}/email-rules`, {
      connectionId: gmailConnection.id,
      goalId: parsed.goalId,
      ...emailRuleInputForKind(parsed.kind)
    });

    await ctx.reply(formatEmailRuleEnabledReply(response, gmailConnection));
  } catch (error) {
    await replyWithIntegrationMessage(ctx, safeIntegrationErrorMessage(error));
  }
});

bot.command("pause_email_rule", async (ctx) => {
  await updateEmailRuleStatusCommand(ctx, "paused");
});

bot.command("resume_email_rule", async (ctx) => {
  await updateEmailRuleStatusCommand(ctx, "active");
});

bot.command("set_email_rule_config", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  const parsed = parseSetEmailRuleConfigCommand(getCommandText(ctx));

  if (!parsed) {
    await ctx.reply("Usage: /set_email_rule_config RULE_ID maxMessagesPerSync=10 maxEventsPerSync=3 classifierMode=rules");
    return;
  }

  try {
    const [response, integrations] = await Promise.all([
      apiPatch<EmailRuleResponse>(`/users/${getTelegramUserId(ctx)}/email-rules/${parsed.ruleId}`, parsed.input),
      apiGet<IntegrationConnectionsResponse>(`/users/${getTelegramUserId(ctx)}/integrations`)
    ]);
    const connection = integrations.connections.find((item) => item.id === response.emailRule.connectionId);
    await ctx.reply(`Email rule updated:\n${formatEmailRule(response.emailRule, connection)}`);
  } catch (error) {
    await replyWithIntegrationMessage(ctx, safeIntegrationErrorMessage(error));
  }
});

bot.command("delete_email_rule", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  const ruleId = getCommandText(ctx);

  if (!ruleId) {
    await ctx.reply("Usage: /delete_email_rule RULE_ID");
    return;
  }

  try {
    const response = await apiDelete<EmailRuleMutationResponse>(`/users/${getTelegramUserId(ctx)}/email-rules/${ruleId}`);
    await ctx.reply(response.message ?? `Email rule archived: ${ruleId}`);
  } catch (error) {
    await replyWithIntegrationMessage(ctx, safeIntegrationErrorMessage(error));
  }
});

bot.command("cleanup_gmail_rule_events", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  const ruleId = getCommandText(ctx);

  if (!ruleId) {
    await ctx.reply("Usage: /cleanup_gmail_rule_events RULE_ID");
    return;
  }

  try {
    const response = await apiPost<GmailRuleCleanupResponse>(
      `/users/${getTelegramUserId(ctx)}/email-rules/${ruleId}/cleanup-events`,
      {}
    );
    await ctx.reply(response.message ?? `Archived ${response.count} Gmail events for rule ${ruleId}.`);
  } catch (error) {
    await replyWithIntegrationMessage(ctx, safeIntegrationErrorMessage(error));
  }
});

bot.command("email_reviews", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  const showAll = getCommandText(ctx).trim().toLowerCase() === "all";

  try {
    const response = await apiGet<EmailReviewsResponse>(
      `/users/${getTelegramUserId(ctx)}/email-reviews${showAll ? "?status=all" : ""}`
    );
    await replyWithIntegrationMessage(ctx, formatEmailReviews(response.emailReviews, showAll));
  } catch (error) {
    await replyWithIntegrationMessage(ctx, safeIntegrationErrorMessage(error));
  }
});

bot.command("approve_email_review", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  const reviewId = getCommandText(ctx);

  if (!reviewId) {
    await ctx.reply("Usage: /approve_email_review REVIEW_ID");
    return;
  }

  try {
    const response = await apiPost<EmailReviewMutationResponse>(
      `/users/${getTelegramUserId(ctx)}/email-reviews/${reviewId}/approve`,
      {}
    );
    await ctx.reply(response.message ?? "Email review approved.");
  } catch (error) {
    await replyWithIntegrationMessage(ctx, safeIntegrationErrorMessage(error));
  }
});

bot.command("reject_email_review", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  const reviewId = getCommandText(ctx);

  if (!reviewId) {
    await ctx.reply("Usage: /reject_email_review REVIEW_ID");
    return;
  }

  try {
    const response = await apiPost<EmailReviewMutationResponse>(
      `/users/${getTelegramUserId(ctx)}/email-reviews/${reviewId}/reject`,
      {}
    );
    await ctx.reply(response.message ?? "Email review rejected.");
  } catch (error) {
    await replyWithIntegrationMessage(ctx, safeIntegrationErrorMessage(error));
  }
});

bot.command("cleanup_email_reviews", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  const ruleId = getCommandText(ctx);

  if (!ruleId) {
    await ctx.reply("Usage: /cleanup_email_reviews RULE_ID");
    return;
  }

  try {
    const response = await apiPost<EmailReviewCleanupResponse>(
      `/users/${getTelegramUserId(ctx)}/email-rules/${ruleId}/cleanup-reviews`,
      {}
    );
    await ctx.reply(response.message ?? `Archived ${response.count} pending email review items for rule ${ruleId}.`);
  } catch (error) {
    await replyWithIntegrationMessage(ctx, safeIntegrationErrorMessage(error));
  }
});

bot.command("action_help", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  await ctx.reply(
    [
      "Action examples:",
      "- /action review homepage copy tomorrow",
      "- /todo apply to 2 jobs tonight",
      "- /add_action send the CV by Friday",
      "- remind me to call Alex Friday"
    ].join("\n")
  );
});

bot.command("action", async (ctx) => {
  await createManualActionFromCommand(ctx, "/action");
});

bot.command("todo", async (ctx) => {
  await createManualActionFromCommand(ctx, "/todo");
});

bot.command("add_action", async (ctx) => {
  await createManualActionFromCommand(ctx, "/add_action");
});

bot.command("actions", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  const showAll = getCommandText(ctx).trim().toLowerCase() === "all";

  try {
    const response = await apiGet<ActionsResponse>(`/users/${getTelegramUserId(ctx)}/actions${showAll ? "?status=all" : ""}`);
    await replyWithIntegrationMessage(ctx, formatActions(response.actions, showAll));
  } catch (error) {
    await replyWithIntegrationMessage(ctx, safeIntegrationErrorMessage(error));
  }
});

bot.command("action_hygiene", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  try {
    const response = await apiGet<ActionHygieneResponse>(`/users/${getTelegramUserId(ctx)}/actions/hygiene`);
    await ctx.reply(response.message);
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not analyze action hygiene right now.");
  }
});

bot.command("debug_action_hygiene", async (ctx) => {
  if (!(await guardDebugAllowedUser(ctx))) {
    return;
  }

  try {
    const response = await apiGet<ActionHygieneResponse>(`/users/${getTelegramUserId(ctx)}/actions/hygiene?debug=true`);
    await ctx.reply(response.message);
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not analyze action hygiene right now.");
  }
});

bot.command("complete_action", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  const actionId = getCommandText(ctx);

  if (!actionId) {
    await ctx.reply("Usage: /complete_action ACTION_ID");
    return;
  }

  try {
    const response = await apiPatch<ActionMutationResponse>(`/users/${getTelegramUserId(ctx)}/actions/${actionId}/complete`, {});
    await ctx.reply(response.message ?? "Action completed.");
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not complete that action. Check the ID and try again.");
  }
});

bot.command("archive_action", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  const actionId = getCommandText(ctx);

  if (!actionId) {
    await ctx.reply("Usage: /archive_action ACTION_ID");
    return;
  }

  try {
    const response = await apiPatch<ActionMutationResponse>(`/users/${getTelegramUserId(ctx)}/actions/${actionId}/archive`, {});
    await ctx.reply(response.message ?? "Action archived.");
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not archive that action. Check the ID and try again.");
  }
});

bot.command("snooze_action", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  const parsed = parseSnoozeActionCommand(getCommandText(ctx));

  if (!parsed) {
    await ctx.reply("Usage: /snooze_action ACTION_ID tomorrow\nOr: /snooze_action ACTION_ID 3d\nOr: /snooze_action ACTION_ID 2026-08-01");
    return;
  }

  try {
    const response = await apiPatch<ActionMutationResponse>(`/users/${getTelegramUserId(ctx)}/actions/${parsed.actionId}/snooze`, {
      snoozeText: parsed.value
    });
    await ctx.reply(response.message ?? "Action snoozed.");
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not snooze that action. Check the ID and time.");
  }
});

bot.command("trigger_action_reminders", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  try {
    const response = await apiPost<ActionReminderTriggerResponse>(
      `/users/${getTelegramUserId(ctx)}/actions/reminders/trigger`,
      {}
    );
    await ctx.reply(response.message);
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not trigger action reminders right now.");
  }
});

bot.command("debug_make_action_due", async (ctx) => {
  if (!(await guardDebugAllowedUser(ctx))) {
    return;
  }

  const actionId = getCommandText(ctx);

  if (!actionId) {
    await ctx.reply("Usage: /debug_make_action_due ACTION_ID");
    return;
  }

  try {
    const response = await apiPatch<ActionMutationResponse>(
      `/users/${getTelegramUserId(ctx)}/actions/${actionId}/debug-force-due`,
      {}
    );
    await ctx.reply(response.message ?? `Action forced due: ${response.action.title}`);
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not force that action due.");
  }
});

bot.command("debug_make_snoozed_due", async (ctx) => {
  if (!(await guardDebugAllowedUser(ctx))) {
    return;
  }

  const actionId = getCommandText(ctx);

  if (!actionId) {
    await ctx.reply("Usage: /debug_make_snoozed_due ACTION_ID");
    return;
  }

  try {
    const response = await apiPatch<ActionMutationResponse>(
      `/users/${getTelegramUserId(ctx)}/actions/${actionId}/debug-force-snoozed-due`,
      {}
    );
    await ctx.reply(response.message ?? `Action forced snoozed due: ${response.action.title}`);
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not force that action snoozed due.");
  }
});

bot.command("debug_link_actions_to_goals", async (ctx) => {
  if (!(await guardDebugAllowedUser(ctx))) {
    return;
  }

  try {
    const response = await apiPost<{ linked: number; message: string }>(
      `/users/${getTelegramUserId(ctx)}/actions/debug-link-goals`,
      {}
    );
    await ctx.reply(response.message ?? `Linked ${response.linked} actions to goals.`);
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not link actions to goals right now.");
  }
});

bot.command("sync_gmail", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  try {
    const integrations = await apiGet<IntegrationConnectionsResponse>(`/users/${getTelegramUserId(ctx)}/integrations`);
    const gmailConnections = integrations.connections.filter(
      (connection) => connection.integrationId === "gmail" && (connection.status === "active" || connection.status === "error")
    );

    if (gmailConnections.length === 0) {
      await ctx.reply("No active Gmail integration. Connect Gmail with /connect_gmail.");
      return;
    }

    const results = [];

    for (const connection of gmailConnections) {
      try {
        results.push(await syncIntegration(ctx, connection.id));
      } catch (error) {
        results.push(formatIntegrationSyncFailure(connection, error));
      }
    }

    await replyWithIntegrationMessage(ctx, formatBatchIntegrationSyncResults(results));
  } catch (error) {
    await replyWithIntegrationMessage(ctx, `Integration sync failed: ${safeIntegrationErrorMessage(error)}`);
  }
});

bot.command("sync_gmail_debug", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  try {
    const integrations = await apiGet<IntegrationConnectionsResponse>(`/users/${getTelegramUserId(ctx)}/integrations`);
    const gmailConnections = integrations.connections.filter(
      (connection) => connection.integrationId === "gmail" && connection.status === "active"
    );

    if (gmailConnections.length === 0) {
      await ctx.reply("No active Gmail integration. Connect Gmail with /connect_gmail.");
      return;
    }

    const results = [];

    for (const connection of gmailConnections) {
      if (connection.status === "error") {
        results.push(formatGmailConnectionErrorDebug(connection));
        continue;
      }

      const response = await postIntegrationSyncForDebug(ctx, connection.id);
      results.push(formatGmailSyncDebug(connection, response));
    }

    await replyWithIntegrationMessage(ctx, results.join("\n\n"));
  } catch (error) {
    await replyWithIntegrationMessage(ctx, `Gmail sync failed: ${safeGmailIntegrationErrorMessage(error)}`);
  }
});

bot.command("pause_integration", async (ctx) => {
  await updateIntegrationStatusCommand(ctx, "paused");
});

bot.command("resume_integration", async (ctx) => {
  await updateIntegrationStatusCommand(ctx, "active");
});

bot.command("delete_integration", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  const connectionId = getCommandText(ctx);

  if (!connectionId) {
    await ctx.reply("Usage: /delete_integration CONNECTION_ID");
    return;
  }

  try {
    const response = await apiDelete<IntegrationConnectionMutationResponse>(
      `/users/${getTelegramUserId(ctx)}/integrations/${connectionId}`
    );
    await ctx.reply(response.message ?? "Integration archived. Historical events were kept.");
  } catch (error) {
    await replyWithIntegrationMessage(ctx, safeIntegrationErrorMessage(error));
  }
});

bot.command("sync_integrations", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  try {
    const response = await apiGet<IntegrationConnectionsResponse>(`/users/${getTelegramUserId(ctx)}/integrations`);
    const activeConnections = response.connections.filter((connection) => connection.status === "active");

    if (activeConnections.length === 0) {
      await ctx.reply("No active integrations to sync.");
      return;
    }

    const results: string[] = [];

    for (const connection of activeConnections) {
      try {
        results.push(await syncIntegration(ctx, connection.id));
      } catch (error) {
        results.push(formatIntegrationSyncFailure(connection, error));
      }
    }

    await replyWithIntegrationMessage(ctx, formatBatchIntegrationSyncResults(results));
  } catch (error) {
    await replyWithIntegrationMessage(ctx, `Integration sync failed: ${safeIntegrationErrorMessage(error)}`);
  }
});

bot.command("sync_integration", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  const connectionId = getCommandText(ctx);

  if (!connectionId) {
    await ctx.reply("Usage: /sync_integration CONNECTION_ID");
    return;
  }

  try {
    await replyWithIntegrationMessage(ctx, await syncIntegration(ctx, connectionId));
  } catch (error) {
    await replyWithIntegrationMessage(ctx, `Integration sync failed: ${safeIntegrationErrorMessage(error)}`);
  }
});

bot.command("create_goal_from_template", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  const parsed = parseCreateGoalFromTemplate(getCommandText(ctx));

  if (!parsed) {
    await ctx.reply(
      [
        "Usage:",
        "/create_goal_from_template career.job_search | Find a new Web3 developer job | Build stable career capital"
      ].join("\n")
    );
    return;
  }

  try {
    const response = await apiPost<GoalResponse>(`/users/${getTelegramUserId(ctx)}/goals/from-template`, parsed);
    if (response.duplicate) {
      await ctx.reply(formatDuplicateGoalMessage(response));
      return;
    }

    if (!response.goal) {
      await ctx.reply("I could not create that template goal right now.");
      return;
    }

    await ctx.reply(`Goal created:\n${formatGoal(response.goal)}`);
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not create that template goal right now.");
  }
});

bot.command("goal_plan", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  const goalId = getCommandText(ctx);

  if (!goalId) {
    await ctx.reply("Usage: /goal_plan <goalId>");
    return;
  }

  try {
    const goalsResponse = await apiGet<GoalsResponse>(`/users/${getTelegramUserId(ctx)}/goals`);
    const goal = goalsResponse.goals.find((item) => item.id === goalId);

    if (!goal) {
      await ctx.reply("I could not find that goal. Run /goals and copy the id.");
      return;
    }

    if (goal.targetMetrics?.length || goal.checkInConfig?.length) {
      await ctx.reply(formatGoalPlan(goal));
      return;
    }

    const configResponse = await apiPost<CustomGoalConfigResponse>(`/users/${getTelegramUserId(ctx)}/goals/custom-config`, {
      title: goal.title,
      why: goal.why,
      category: goal.category
    });

    await ctx.reply(
      [
        formatGoalPlan({
          ...goal,
          targetMetrics: configResponse.config.targetMetrics,
          checkInConfig: configResponse.config.checkInConfig
        }),
        "",
        "This goal has no saved custom config yet. Use these as a suggested plan for now."
      ].join("\n")
    );
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not build that goal plan right now.");
  }
});

bot.command("log_progress", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  const parsed = parseLogProgressCommand(getCommandText(ctx));

  if (!parsed) {
    await ctx.reply(
      [
        "Usage:",
        "/log_progress <goalId> | metric=focused_minutes value=45 unit=minutes note=focused block",
        "/log_progress <goalId> | worked for 45 minutes on the first draft"
      ].join("\n")
    );
    return;
  }

  try {
    const response = await apiPost<GoalProgressResponse>(
      `/users/${getTelegramUserId(ctx)}/goals/${parsed.goalId}/progress`,
      parsed.progress
    );
    await ctx.reply(response.reply);
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not log that goal progress right now.");
  }
});

bot.command("archive_goal", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  const goalId = getCommandText(ctx);

  if (!goalId) {
    await ctx.reply("Usage: /archive_goal <goalId>");
    return;
  }

  try {
    const response = await apiPatch<GoalResponse>(`/users/${getTelegramUserId(ctx)}/goals/${goalId}/archive`, {});
    if (!response.goal) {
      await ctx.reply("I could not archive that goal. Check the goal ID and try again.");
      return;
    }

    await ctx.reply(`Goal archived:\n${formatGoal(response.goal)}`);
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not archive that goal. Check the goal ID and try again.");
  }
});

bot.command("review", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  try {
    const review = await apiGet<DailyReviewResponse>(`/users/${getTelegramUserId(ctx)}/review/daily`);
    await ctx.reply(formatDailyReview(review.review));
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not fetch your daily review right now.");
  }
});

bot.command("today", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  try {
    const response = await apiGet<DailyOperatorBriefResponse>(`/users/${getTelegramUserId(ctx)}/today`);
    await ctx.reply(formatDailyOperatorBrief(response.brief));
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not fetch today's brief right now.");
  }
});

bot.command("start_day", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  try {
    const response = await apiGet<DailyLoopMessageResponse>(`/users/${getTelegramUserId(ctx)}/daily-loop/start-day`);
    await ctx.reply(response.message);
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not build your day-start brief right now.");
  }
});

bot.command("end_day", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  try {
    const response = await apiGet<DailyLoopMessageResponse>(`/users/${getTelegramUserId(ctx)}/daily-loop/end-day`);
    await ctx.reply(response.message);
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not build your evening review right now.");
  }
});

bot.command("tomorrow", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  try {
    const response = await apiGet<DailyLoopMessageResponse>(`/users/${getTelegramUserId(ctx)}/daily-loop/tomorrow`);
    await ctx.reply(response.message);
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not build tomorrow prep right now.");
  }
});

bot.command("debug_send_start_day", async (ctx) => {
  if (!(await guardDebugAllowedUser(ctx))) {
    return;
  }

  try {
    const force = String(ctx.match ?? "").trim().toLowerCase() === "force";
    const response = await apiGet<DailyLoopMessageResponse>(
      `/users/${getTelegramUserId(ctx)}/daily-loop/start-day?markSent=true${force ? "&force=true" : ""}`
    );
    await ctx.reply(response.message);
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not send the debug start-day brief right now.");
  }
});

bot.command("debug_send_end_day", async (ctx) => {
  if (!(await guardDebugAllowedUser(ctx))) {
    return;
  }

  try {
    const force = String(ctx.match ?? "").trim().toLowerCase() === "force";
    const response = await apiGet<DailyLoopMessageResponse>(
      `/users/${getTelegramUserId(ctx)}/daily-loop/end-day?markSent=true${force ? "&force=true" : ""}`
    );
    await ctx.reply(response.message);
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not send the debug end-day review right now.");
  }
});

bot.command("debug_daily_priorities", async (ctx) => {
  if (!(await guardDebugAllowedUser(ctx))) {
    return;
  }

  try {
    const response = await apiGet<DailyPriorityDebugResponse>(`/users/${getTelegramUserId(ctx)}/today/debug-priorities`);
    await ctx.reply(formatDailyPriorityDebug(response.priorities));
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not score daily priorities right now.");
  }
});

bot.command("debug_daily_coach", async (ctx) => {
  if (!(await guardDebugAllowedUser(ctx))) {
    return;
  }

  try {
    const response = await apiGet<DailyCoachDebugResponse>(`/users/${getTelegramUserId(ctx)}/today/debug-daily-coach`);
    await ctx.reply(formatDailyCoachDebug(response));
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not debug the daily coach right now.");
  }
});

bot.command("insight", async (ctx) => {
  await sendInsight(ctx, "daily");
});

bot.command("daily_insight", async (ctx) => {
  await sendInsight(ctx, "daily");
});

bot.command("weekly", async (ctx) => {
  await sendWeeklyReview(ctx);
});

bot.command("weekly_insight", async (ctx) => {
  await sendInsight(ctx, "weekly");
});

bot.command("weekly_last", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  try {
    const response = await apiGet<WeeklyReviewResponse>(`/users/${getTelegramUserId(ctx)}/weekly-review/last`);
    await ctx.reply(response.message);
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not fetch your last weekly review right now.");
  }
});

bot.command("debug_weekly_context", async (ctx) => {
  if (!(await guardDebugAllowedUser(ctx))) {
    return;
  }

  try {
    const response = await apiGet<WeeklyReviewContextResponse>(`/users/${getTelegramUserId(ctx)}/weekly-review/context`);
    await ctx.reply(response.message);
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not debug the weekly review context right now.");
  }
});

bot.command("plan_next_week", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  try {
    const response = await apiPost<NextWeekPlanResponse>(`/users/${getTelegramUserId(ctx)}/next-week-plan`, {});
    await ctx.reply(response.message);
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not build next week's plan right now.");
  }
});

bot.command("debug_next_week_plan_context", async (ctx) => {
  if (!(await guardDebugAllowedUser(ctx))) {
    return;
  }

  try {
    const response = await apiGet<NextWeekPlanContextResponse>(`/users/${getTelegramUserId(ctx)}/next-week-plan/context`);
    await ctx.reply(response.message);
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not debug the next-week plan context right now.");
  }
});

bot.command("goals", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  try {
    const response = await apiGet<GoalsResponse>(`/users/${getTelegramUserId(ctx)}/goals`);
    await ctx.reply(formatGoals(response.goals, response.duplicateWarnings ?? []));
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not fetch your goals right now.");
  }
});

bot.command("goal_priorities", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  try {
    const response = await apiGet<GoalPrioritiesResponse>(`/users/${getTelegramUserId(ctx)}/goals/priorities`);
    await ctx.reply(formatGoalPriorities(response.goals));
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not fetch goal priorities right now.");
  }
});

bot.command("set_goal_priority", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  const parsed = parseSetGoalPriorityCommand(getCommandText(ctx));

  if (!parsed) {
    await ctx.reply("Usage: /set_goal_priority GOAL_ID_OR_NUMBER low|medium|high|critical");
    return;
  }

  try {
    const response = await apiPatch<GoalPriorityUpdateResponse>(`/users/${getTelegramUserId(ctx)}/goals/priority`, parsed);
    await ctx.reply(response.message);
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not update that goal priority.");
  }
});

bot.command("debug_backfill_goal_priorities", async (ctx) => {
  if (!(await guardDebugAllowedUser(ctx))) {
    return;
  }

  try {
    const force = getCommandText(ctx).trim().toLowerCase() === "force";
    const response = await apiPost<GoalPriorityBackfillResponse>(`/users/${getTelegramUserId(ctx)}/goals/priorities/backfill`, {
      force
    });
    await ctx.reply(response.message);
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not backfill goal priorities right now.");
  }
});

bot.command("events", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  try {
    const limit = parseEventLimit(getCommandText(ctx));
    const response = await apiGet<EventsResponse>(`/users/${getTelegramUserId(ctx)}/events`);
    const events = response.events.slice(-limit).reverse();
    await replyWithEventList(
      ctx,
      formatEvents(events, {
        intro: formatEventsIntro("events", events.length, response.events.length, limit)
      })
    );
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not fetch your recent events right now.");
  }
});

bot.command("events_archived", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  try {
    const limit = parseEventLimit(getCommandText(ctx));
    const response = await apiGet<EventsResponse>(`/users/${getTelegramUserId(ctx)}/events?includeArchived=true`);
    const events = response.events.slice(-limit).reverse();
    await replyWithEventList(
      ctx,
      formatEvents(events, {
        alwaysShowStatus: true,
        intro: formatEventsIntro("events_archived", events.length, response.events.length, limit, " including archived/corrected")
      })
    );
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not fetch archived events right now.");
  }
});

bot.command("undo_last_event", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  try {
    const response = await apiPost<EventArchiveResponse>(`/users/${getTelegramUserId(ctx)}/events/undo-last`, {
      scope: "group",
      reason: "undo last event command"
    });
    await ctx.reply(formatArchiveResult(response));
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not undo the last event right now.");
  }
});

bot.command("delete_event", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  const eventId = getCommandText(ctx);

  if (!eventId) {
    await ctx.reply("Usage: /delete_event <eventId>");
    return;
  }

  try {
    await apiPatch<EventResponse>(`/users/${getTelegramUserId(ctx)}/events/${eventId}/archive`, {
      reason: "archived from Telegram"
    });
    await ctx.reply(`Archived event ${eventId}.`);
  } catch (error) {
    if (isFetchError(error)) {
      await replyWithApiFailure(ctx, error, "I could not archive that event. Check the ID and try again.");
      return;
    }

    const existingEvent = await findEventIncludingArchived(ctx, eventId);

    if (existingEvent && existingEvent.status !== "active") {
      await ctx.reply("That event is already archived/corrected.");
      return;
    }

    await ctx.reply("I could not find that event. Check the ID and try again.");
  }
});

bot.command("correct_event", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  const parsed = parseCorrectEventCommand(getCommandText(ctx));

  if (!parsed) {
    await ctx.reply('Usage: /correct_event EVENT_ID | {"duration_minutes":30}');
    return;
  }

  if ("error" in parsed) {
    await ctx.reply('Invalid JSON. Example: /correct_event EVENT_ID | {"duration_minutes":30}');
    return;
  }

  try {
    const response = await postCorrectEvent(
      `/users/${getTelegramUserId(ctx)}/events/${parsed.eventId}/correct`,
      {
        type: parsed.type,
        data: parsed.data,
        reason: "corrected from Telegram"
      }
    );

    if (!response.ok) {
      await ctx.reply(response.error);
      return;
    }

    await ctx.reply(`Corrected event. Old event archived, replacement created: ${response.replacement.id}.`);
  } catch (error) {
    console.error("Telegram correct_event failed", error);
    await replyWithApiFailure(ctx, error, "I could not correct that event. Check the ID and data format.");
  }
});

bot.command("ingest", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  const text = getCommandText(ctx);

  if (!text) {
    await ctx.reply("Usage: /ingest pasted recruiter or job-search text");
    return;
  }

  try {
    const response = await apiPost<IngestionResponse>(`/users/${getTelegramUserId(ctx)}/ingest/text`, {
      text,
      source: "telegram"
    });
    await ctx.reply(response.reply);
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not ingest that text right now.");
  }
});

bot.command("ingest_job", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  const text = getCommandText(ctx);

  if (!text) {
    await ctx.reply("Usage: /ingest_job pasted recruiter or job-search text");
    return;
  }

  try {
    const response = await apiPost<IngestionResponse>(`/users/${getTelegramUserId(ctx)}/ingest/text`, {
      text,
      source: "telegram",
      domainHint: "career"
    });
    await ctx.reply(response.reply);
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not ingest that job-search text right now.");
  }
});

bot.command("checkin", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  const parsed = parseCheckIn(getCommandText(ctx));

  if (!parsed) {
    await ctx.reply(
      [
        "/checkin energy=6 anxiety=4 focus=7 gambling=2 applications=2 workout=45 reading=30 sleep=7 notes=Felt okay today",
        "",
        "applications/workout/reading/sleep count as progress events.",
        "notes are journal context, not guaranteed structured progress unless you include clear numbers."
      ].join("\n")
    );
    return;
  }

  try {
    const response = await apiPost<CheckInResponse>(`/users/${getTelegramUserId(ctx)}/checkins/daily`, parsed);
    await ctx.reply(response.reply);
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not save that check-in right now.");
  }
});

bot.command("checkin_natural", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  await ctx.reply(
    [
      "Natural check-in examples:",
      "- slept 6h, energy 5, anxiety 7, sent 2 cvs, trained 40 min",
      "- dormi 7 horas, energia 6, ansiedad 4, foco 7, mande 3 cvs y entrené 45 min",
      "- hoy fatal, dormí 5h, ansiedad 8, ganas de apostar 7"
    ].join("\n")
  );
});

bot.command("pending", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  try {
    const response = await apiGet<PendingActionsResponse>(`/users/${getTelegramUserId(ctx)}/pending-actions`);
    await ctx.reply(formatPendingActions(response.pendingActions));
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not fetch pending actions right now.");
  }
});

bot.command("confirm", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  try {
    const pendingAction = await getLatestPendingAction(ctx);

    if (!pendingAction) {
      await ctx.reply("No pending action.");
      return;
    }

    const response = await apiPost<PendingActionMutationResponse>(
      `/users/${getTelegramUserId(ctx)}/pending-actions/${pendingAction.id}/confirm`,
      {}
    );
    await ctx.reply(response.reply);
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not confirm that pending action right now.");
  }
});

bot.command("cancel", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  try {
    const pendingAction = await getLatestPendingAction(ctx);

    if (!pendingAction) {
      await ctx.reply("No pending action.");
      return;
    }

    const response = await apiPost<PendingActionMutationResponse>(
      `/users/${getTelegramUserId(ctx)}/pending-actions/${pendingAction.id}/reject`,
      {}
    );
    await ctx.reply(response.reply);
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not cancel that pending action right now.");
  }
});

bot.on("message:text", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  try {
    const inbound = buildNormalizedTelegramMessage(ctx);
    const recentDailyCheckInReminder = shouldCheckRecentDailyCheckInReminder(inbound)
      ? await getRecentDailyCheckInReminder(inbound)
      : false;
    const route = routeNormalizedInboundMessage(inbound, { recentDailyCheckInReminder });

    if (route.kind === "command") {
      await ctx.reply("Unknown command. Try /help.");
      return;
    }

    if (looksLikeMultiIntentText(inbound.text)) {
      const multi = await apiPost<MultiIntentResponse>(`/users/${inbound.userId}/conversation/multi-intent`, {
        text: inbound.text,
        now: inbound.timestamp.toISOString()
      });

      if (multi.handled) {
        await ctx.reply(multi.reply);
        return;
      }
    }

    if (route.kind === "daily_checkin") {
      const response = await apiPost<NaturalCheckInResponse>(`/users/${inbound.userId}/checkins/daily/text`, {
        text: inbound.text
      });

      await ctx.reply(response.reply);
      return;
    }

    if (route.kind === "ingest_text") {
      const response = await apiPost<IngestionResponse>(`/users/${inbound.userId}/ingest/text`, {
        text: inbound.text,
        source: route.source,
        domainHint: route.domainHint
      });

      await ctx.reply(response.reply);
      return;
    }

    const control = await apiPost<ConversationControlResponse>(`/users/${inbound.userId}/conversation/control`, {
      text: inbound.text,
      now: inbound.timestamp.toISOString()
    });

    if (control.handled) {
      await ctx.reply(control.reply ?? "Done.");
      return;
    }

    const response = await apiPost<ProcessMessageResponse>("/messages/process", {
      userId: inbound.userId,
      message: inbound.text
    });

    await ctx.reply(response.reply);
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not process that message right now.");
  }
});

bot.catch((error) => {
  console.error("Telegram bot error", error);
});

await bot.start({
  onStart: (botInfo) => {
    console.log(`Telegram bot started as @${botInfo.username}`);
  }
});

async function guardAllowedUser(ctx: Context, command?: "start"): Promise<boolean> {
  const telegramUserId = ctx.from?.id;

  if (!telegramUserId || !isAllowedTelegramUser(String(telegramUserId))) {
    await ctx.reply(
      command === "start"
        ? "This private agent is not available for this Telegram account. Send /whoami to get your Telegram ID and ask the owner for access."
        : "This private agent is not available for this Telegram account. Send /whoami to get your Telegram ID."
    );
    return false;
  }

  return true;
}

async function guardDebugAllowedUser(ctx: Context): Promise<boolean> {
  if (!isDebugAllowedUser(ctx)) {
    await ctx.reply("Debug commands are only available to allowlisted users.");
    return false;
  }

  return true;
}

function isDebugAllowedUser(ctx: Context): boolean {
  const telegramUserId = ctx.from?.id;
  return Boolean(telegramUserId && allowedUserIds?.has(String(telegramUserId)));
}

function isAllowedTelegramUser(telegramUserId: string): boolean {
  return !allowedUserIds || allowedUserIds.has(telegramUserId);
}

function getTelegramUserId(ctx: Context): string {
  return `telegram:${getRawTelegramUserId(ctx)}`;
}

function getRawTelegramUserId(ctx: Context): string {
  const telegramUserId = ctx.from?.id;

  if (!telegramUserId) {
    throw new Error("Telegram user id is missing.");
  }

  return String(telegramUserId);
}

function parseAllowedUserIds(value?: string): Set<string> | undefined {
  const ids = value
    ?.split(",")
    .map((id) => id.trim())
    .filter(Boolean)
    .map((id) => id.replace(/^telegram:/, ""));

  return ids && ids.length > 0 ? new Set(ids) : undefined;
}

function getCommandText(ctx: Context): string {
  return typeof ctx.match === "string" ? ctx.match.trim() : "";
}

async function executeCommandBatch(ctx: Context, commands: string[]): Promise<string> {
  const replies: string[] = [];
  const limitedCommands = commands.slice(0, 10);

  for (const command of limitedCommands) {
    replies.push(await executeBatchCommandLine(ctx, command));
  }

  const header =
    commands.length > limitedCommands.length
      ? `Processed first ${limitedCommands.length} commands (limit 10):`
      : `Processed ${limitedCommands.length} command${limitedCommands.length === 1 ? "" : "s"}:`;
  const numberedReplies = replies.map((reply, index) => `${index + 1}. ${truncateText(reply, 900)}`);

  if (commands.length > limitedCommands.length) {
    numberedReplies.push(`Skipped ${commands.length - limitedCommands.length} extra command${commands.length - limitedCommands.length === 1 ? "" : "s"}. Send a smaller batch.`);
  }

  return [header, ...numberedReplies].join("\n");
}

async function executeBatchCommandLine(ctx: Context, commandLine: string): Promise<string> {
  const parsed = parseBatchCommandLine(commandLine);

  if (!parsed) {
    return `Could not parse command: ${truncateText(commandLine, 80)}`;
  }

  try {
    if (parsed.name === "actions") {
      const showAll = parsed.args.trim().toLowerCase() === "all";
      const response = await apiGet<ActionsResponse>(`/users/${getTelegramUserId(ctx)}/actions${showAll ? "?status=all" : ""}`);
      return `/${parsed.name}: ${formatActions(response.actions, showAll)}`;
    }

    if (parsed.name === "today") {
      const response = await apiGet<DailyOperatorBriefResponse>(`/users/${getTelegramUserId(ctx)}/today`);
      return `/${parsed.name}: ${formatDailyOperatorBrief(response.brief)}`;
    }

    if (parsed.name === "goals") {
      const response = await apiGet<GoalsResponse>(`/users/${getTelegramUserId(ctx)}/goals`);
      return `/${parsed.name}: ${formatGoals(response.goals, response.duplicateWarnings ?? [])}`;
    }

    if (parsed.name === "goal_priorities") {
      const response = await apiGet<GoalPrioritiesResponse>(`/users/${getTelegramUserId(ctx)}/goals/priorities`);
      return `/${parsed.name}: ${formatGoalPriorities(response.goals)}`;
    }

    if (parsed.name === "debug_daily_priorities") {
      if (!isDebugAllowedUser(ctx)) {
        return `/${parsed.name}: Debug commands are only available to allowlisted users.`;
      }

      const response = await apiGet<DailyPriorityDebugResponse>(`/users/${getTelegramUserId(ctx)}/today/debug-priorities`);
      return `/${parsed.name}: ${formatDailyPriorityDebug(response.priorities)}`;
    }

    if (parsed.name === "debug_daily_coach") {
      if (!isDebugAllowedUser(ctx)) {
        return `/${parsed.name}: Debug commands are only available to allowlisted users.`;
      }

      const response = await apiGet<DailyCoachDebugResponse>(`/users/${getTelegramUserId(ctx)}/today/debug-daily-coach`);
      return `/${parsed.name}: ${formatDailyCoachDebug(response)}`;
    }

    if (parsed.name === "weekly") {
      const force = parsed.args.trim().toLowerCase() === "force";
      const response = await apiPost<WeeklyReviewResponse>(`/users/${getTelegramUserId(ctx)}/weekly-review`, { force });
      return `/${parsed.name}: ${response.message}`;
    }

    if (parsed.name === "weekly_last") {
      const response = await apiGet<WeeklyReviewResponse>(`/users/${getTelegramUserId(ctx)}/weekly-review/last`);
      return `/${parsed.name}: ${response.message}`;
    }

    if (parsed.name === "debug_weekly_context") {
      if (!isDebugAllowedUser(ctx)) {
        return `/${parsed.name}: Debug commands are only available to allowlisted users.`;
      }

      const response = await apiGet<WeeklyReviewContextResponse>(`/users/${getTelegramUserId(ctx)}/weekly-review/context`);
      return `/${parsed.name}: ${response.message}`;
    }

    if (parsed.name === "events") {
      const limit = parseEventLimit(parsed.args);
      const response = await apiGet<EventsResponse>(`/users/${getTelegramUserId(ctx)}/events`);
      const events = response.events.slice(-limit).reverse();
      return `/${parsed.name}: ${formatEvents(events, {
        intro: formatEventsIntro("events", events.length, response.events.length, limit)
      })}`;
    }

    if (parsed.name === "memory") {
      const response = await apiGet<MemoriesResponse>(`/users/${getTelegramUserId(ctx)}/memory`);
      return `/${parsed.name}: ${formatMemories(response.memories)}`;
    }

    if (parsed.name === "reminder_settings") {
      const response = await apiGet<NotificationSettingsResponse>(`/users/${getTelegramUserId(ctx)}/notification-settings`);
      return `/${parsed.name}: ${formatReminderSettings(response.notificationSettings)}`;
    }

    if (parsed.name === "archive_action") {
      if (!parsed.args) {
        return "Usage: /archive_action ACTION_ID";
      }

      const response = await apiPatch<ActionMutationResponse>(`/users/${getTelegramUserId(ctx)}/actions/${parsed.args}/archive`, {});
      return response.message ?? `Action archived: ${parsed.args}`;
    }

    if (parsed.name === "complete_action") {
      if (!parsed.args) {
        return "Usage: /complete_action ACTION_ID";
      }

      const response = await apiPatch<ActionMutationResponse>(`/users/${getTelegramUserId(ctx)}/actions/${parsed.args}/complete`, {});
      return response.message ?? `Action completed: ${parsed.args}`;
    }

    if (parsed.name === "snooze_action") {
      const snooze = parseSnoozeActionCommand(parsed.args);

      if (!snooze) {
        return "Usage: /snooze_action ACTION_ID tomorrow";
      }

      const response = await apiPatch<ActionMutationResponse>(`/users/${getTelegramUserId(ctx)}/actions/${snooze.actionId}/snooze`, {
        snoozeText: snooze.value
      });
      return response.message ?? `Action snoozed: ${snooze.actionId}`;
    }

    return `/${parsed.name}: skipped, unsupported batch command`;
  } catch (error) {
    return safeActionCommandErrorMessage(error);
  }
}

function safeActionCommandErrorMessage(error: unknown): string {
  if (isFetchError(error)) {
    return "I cannot reach the agent API right now. Make sure the API server is running.";
  }

  const message = safeErrorMessage(error);

  if (!message) {
    return "I could not run that action command. Check the ID and try again.";
  }

  if (message.includes("404") || message.toLowerCase().includes("not found")) {
    return "Action not found. Check the ID and try again.";
  }

  return message;
}

function parseBatchCommandLine(commandLine: string): { name: string; args: string } | undefined {
  const match = commandLine.trim().match(/^\/([a-zA-Z0-9_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/);

  if (!match) {
    return undefined;
  }

  return {
    name: match[1].toLowerCase(),
    args: (match[2] ?? "").trim()
  };
}

function parseCreateGoal(text: string) {
  const [category, title, why] = text.split("|").map((part) => part.trim());

  if (!category || !title) {
    return undefined;
  }

  return {
    category,
    title,
    why: why || undefined
  };
}

function emailRuleInputForKind(kind: string) {
  if (kind === "work_action") {
    return {
      adapterId: "work_action_email",
      name: "Work action emails",
      fetchStrategy: "query",
      classifierMode: "hybrid",
      reviewBeforeLogging: true,
      lookbackDays: 7,
      maxMessagesPerSync: 25,
      maxEventsPerSync: 5,
      minAutoLogConfidence: 0.95,
      minReviewConfidence: 0.7
    };
  }

  return {
    adapterId: "job_search_email",
    name: "Job search emails",
    reviewBeforeLogging: false
  };
}

function parseCreateGoalFromTemplate(text: string) {
  const [templateId, title, why] = text.split("|").map((part) => part.trim());

  if (!templateId || !title) {
    return undefined;
  }

  return {
    templateId,
    title,
    why: why || undefined
  };
}

function parseLogProgressCommand(text: string): { goalId: string; progress: CustomGoalProgressInput } | undefined {
  const [goalId, progressText] = text.split("|").map((part) => part.trim());

  if (!goalId || !progressText) {
    return undefined;
  }

  if (/\bmetric=/i.test(progressText)) {
    return {
      goalId,
      progress: parseStructuredProgress(progressText)
    };
  }

  const minutes = progressText.match(/\b(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|minutos?)\b/i);

  return {
    goalId,
    progress: minutes
      ? {
          metricKey: "focused_minutes",
          value: Number(minutes[1]),
          unit: "minutes",
          note: progressText
        }
      : {
          metricKey: "progress_actions",
          value: 1,
          note: progressText
        }
  };
}

function parseStructuredProgress(text: string): CustomGoalProgressInput {
  const noteMatch = text.match(/\bnote=(.+)$/i);
  const withoutNote = noteMatch ? text.slice(0, noteMatch.index).trim() : text;
  const pairs = Object.fromEntries(
    withoutNote
      .split(/\s+/)
      .map((part) => part.split("="))
      .filter(([key, value]) => key && value)
      .map(([key, value]) => [key.toLowerCase(), value])
  );

  return {
    metricKey: pairs.metric,
    value: pairs.value !== undefined ? parseProgressValue(pairs.value) : undefined,
    unit: pairs.unit,
    note: noteMatch?.[1]?.trim()
  };
}

function parseProgressValue(value: string): string | number | boolean {
  if (/^(true|yes)$/i.test(value)) {
    return true;
  }

  if (/^(false|no)$/i.test(value)) {
    return false;
  }

  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : value;
}

function parseWeeklyInsightCommand(text: string): { day: string; time: string } | undefined {
  const [day, time] = text.toLowerCase().split(/\s+/).filter(Boolean);
  const validDays = new Set(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]);

  if (!validDays.has(day) || !/^\d{2}:\d{2}$/.test(time ?? "")) {
    return undefined;
  }

  return { day, time };
}

function parseConnectGithubCommand(text: string) {
  const [repoText, ...rest] = text.split(/\s+/).filter(Boolean);
  const [owner, repo] = (repoText ?? "").split("/");

  if (!owner || !repo) {
    return undefined;
  }

  const authorArg = rest.find((part) => part.startsWith("author="));
  const authorLogin = authorArg?.replace(/^author=/, "").trim();

  return {
    repos: [{ owner, repo }],
    ...(authorLogin ? { authorLogin } : {})
  };
}

function parseEnableEmailRuleCommand(text: string): { kind: string; goalId?: string } | undefined {
  const [kind, ...rest] = text.split(/\s+/).filter(Boolean);

  if (!kind) {
    return undefined;
  }

  const goalArg = rest.find((part) => part.startsWith("goal="));
  const goalId = goalArg?.replace(/^goal=/, "").trim();

  return {
    kind,
    ...(goalId ? { goalId } : {})
  };
}

function parseSetEmailRuleConfigCommand(
  text: string
): { ruleId: string; input: Record<string, string | number | boolean | null> } | undefined {
  const [ruleId, ...parts] = text.split(/\s+/).filter(Boolean);

  if (!ruleId || parts.length === 0) {
    return undefined;
  }

  const numberKeys = new Set([
    "lookbackDays",
    "maxMessagesPerSync",
    "maxEventsPerSync",
    "minAutoLogConfidence",
    "minReviewConfidence"
  ]);
  const allowedKeys = new Set([
    ...numberKeys,
    "fetchStrategy",
    "classifierMode",
    "query",
    "reviewBeforeLogging"
  ]);
  const validFetchStrategies = new Set(["query", "all_recent", "sender_allowlist", "label"]);
  const validClassifierModes = new Set(["rules", "llm", "hybrid"]);
  const input: Record<string, string | number | boolean | null> = {};

  for (const part of parts) {
    const [key, ...valueParts] = part.split("=");
    const value = valueParts.join("=");

    if (!key || !allowedKeys.has(key) || value === "") {
      return undefined;
    }

    if (numberKeys.has(key)) {
      const numberValue = Number(value);

      if (!Number.isFinite(numberValue)) {
        return undefined;
      }

      input[key] = numberValue;
      continue;
    }

    if (key === "reviewBeforeLogging") {
      if (!/^(true|false)$/i.test(value)) {
        return undefined;
      }

      input[key] = value.toLowerCase() === "true";
      continue;
    }

    if (key === "fetchStrategy" && !validFetchStrategies.has(value)) {
      return undefined;
    }

    if (key === "classifierMode" && !validClassifierModes.has(value)) {
      return undefined;
    }

    input[key] = key === "query" && value === "null" ? null : value;
  }

  return { ruleId, input };
}

function parseEventLimit(text: string): number {
  const limit = Number(text.trim() || "5");

  if (!Number.isFinite(limit)) {
    return 5;
  }

  return Math.min(20, Math.max(1, Math.floor(limit)));
}

function formatEventsIntro(command: string, shownCount: number, totalCount: number, limit: number, suffix = ""): string {
  const base = `Showing ${shownCount} most recent events${suffix}.`;
  const nextLimit = limit < 10 ? 10 : 20;

  if (limit >= 20 || totalCount <= limit) {
    return base;
  }

  return `${base} Use /${command} ${nextLimit} for more.`;
}

function parseCheckIn(text: string) {
  if (!text) {
    return undefined;
  }

  const answers: Array<{ key: string; value: string | number | boolean }> = [];
  const notesIndex = text.search(/\bnotes=/i);
  const pairText = notesIndex >= 0 ? text.slice(0, notesIndex).trim() : text;
  const notes = notesIndex >= 0 ? text.slice(notesIndex + "notes=".length).trim() : "";
  const pairs = pairText.split(/\s+/).filter(Boolean);

  for (const pair of pairs) {
    const [key, ...valueParts] = pair.split("=");
    const value = valueParts.join("=");

    if (!key || !value) {
      continue;
    }

    answers.push({
      key: normalizeCheckInKey(key),
      value: parseCheckInValue(value)
    });
  }

  if (notes) {
    answers.push({
      key: "notes",
      value: notes
    });
  }

  return answers.length > 0 ? { answers } : undefined;
}

function normalizeCheckInKey(key: string) {
  if (key === "gambling") {
    return "gambling_impulse";
  }

  if (key === "trading") {
    return "trading_impulse";
  }

  return key;
}

function parseCheckInValue(value: string): string | number | boolean {
  if (/^(true|yes)$/i.test(value)) {
    return true;
  }

  if (/^(false|no)$/i.test(value)) {
    return false;
  }

  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : value;
}

function buildNormalizedTelegramMessage(ctx: Context, textOverride?: string): NormalizedInboundMessage {
  const externalUserId = String(ctx.from?.id ?? "");
  const timestamp = ctx.message?.date ? new Date(ctx.message.date * 1000) : new Date();

  return buildNormalizedInboundMessage({
    channel: "telegram",
    userId: getTelegramUserId(ctx),
    externalUserId,
    text: textOverride ?? ctx.message?.text ?? "",
    messageType: "text",
    timestamp,
    metadata: {
      chatId: ctx.chat?.id,
      messageId: ctx.message?.message_id,
      username: ctx.from?.username
    }
  });
}

function formatRouteDebug(debug: InboundRouteDebug): string {
  return [
    `intentType: ${debug.intentType}`,
    `confidence: ${debug.confidence.toFixed(2)}`,
    `handlerName: ${debug.handlerName}`,
    `shouldRunGenericChat: ${String(debug.shouldRunGenericChat)}`,
    "allowedSideEffects:",
    `- createEvent: ${String(debug.allowedSideEffects.createEvent)}`,
    `- createAction: ${String(debug.allowedSideEffects.createAction)}`,
    `- createMemory: ${String(debug.allowedSideEffects.createMemory)}`,
    `- sendNotification: ${String(debug.allowedSideEffects.sendNotification)}`,
    `- callLLM: ${String(debug.allowedSideEffects.callLLM)}`,
    debug.goal ? `goal: ${debug.goal}` : undefined,
    debug.severity ? `severity: ${debug.severity}` : undefined,
    debug.isReferenceOnly !== undefined ? `isReferenceOnly: ${String(debug.isReferenceOnly)}` : undefined,
    `reason: ${debug.reason}`
  ]
    .filter(Boolean)
    .join("\n");
}

function formatConversationControlDebug(debug: ConversationControlDebug): string {
  return [
    `intent: ${debug.intent}`,
    `confidence: ${debug.confidence.toFixed(2)}`,
    debug.targetText ? `targetText: ${debug.targetText}` : undefined,
    debug.timeText ? `timeText: ${debug.timeText}` : undefined,
    debug.goalText ? `goalText: ${debug.goalText}` : undefined,
    debug.priority ? `priority: ${debug.priority}` : undefined,
    debug.resolvedAction ? `resolvedAction: ${debug.resolvedAction.title} (${debug.resolvedAction.id})` : undefined,
    debug.resolvedGoal ? `resolvedGoal: ${debug.resolvedGoal.title} (${debug.resolvedGoal.id})` : undefined,
    debug.ambiguousActions && debug.ambiguousActions.length > 0
      ? `ambiguousActions: ${debug.ambiguousActions.map((action) => action.title).join(", ")}`
      : undefined,
    debug.ambiguousGoals && debug.ambiguousGoals.length > 0
      ? `ambiguousGoals: ${debug.ambiguousGoals.map((goal) => goal.title).join(", ")}`
      : undefined,
    `requiresConfirmation: ${debug.requiresConfirmation ? "yes" : "no"}`,
    `blockedByGuardrail: ${debug.blockedByGuardrail ? "yes" : "no"}`,
    `reason: ${debug.reason}`
  ]
    .filter(Boolean)
    .join("\n");
}

function formatIntentPlanDebug(response: IntentPlanResponse): string {
  return [
    `isMultiIntent: ${response.plan.isMultiIntent ? "yes" : "no"}`,
    `reason: ${response.plan.reason}`,
    "intents:",
    ...response.debug.map((intent, index) =>
      [
        `${index + 1}. type: ${intent.type}`,
        `   textSpan: ${intent.textSpan}`,
        intent.targetText ? `   targetText: ${intent.targetText}` : undefined,
        intent.timeText ? `   timeText: ${intent.timeText}` : undefined,
        intent.goalText ? `   goalText: ${intent.goalText}` : undefined,
        intent.priority ? `   priority: ${intent.priority}` : undefined,
        `   confidence: ${intent.confidence.toFixed(2)}`,
        `   wouldExecute: ${intent.wouldExecute ? "yes" : "no"}`,
        `   requiresConfirmation: ${intent.requiresConfirmation ? "yes" : "no"}`,
        `   blockedByGuardrail: ${intent.blockedByGuardrail ? "yes" : "no"}`,
        `   reason: ${intent.reason}`
      ]
        .filter(Boolean)
        .join("\n")
    )
  ].join("\n");
}

async function getRecentDailyCheckInReminder(message: NormalizedInboundMessage): Promise<boolean> {
  try {
    const response = await apiGet<RecentDailyCheckInReminderResponse>(
      `/users/${message.userId}/notification-logs/recent-daily-checkin`
    );
    return response.recent;
  } catch (error) {
    console.error("Could not check recent daily check-in reminder", error);
    return false;
  }
}

async function sendInsight(ctx: Context, periodType: "daily" | "weekly") {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  try {
    const path = periodType === "daily" ? "/insights/daily" : "/insights/weekly";
    const response = await apiGet<InsightResponse>(`/users/${getTelegramUserId(ctx)}${path}`);
    await ctx.reply(formatInsight(response.insight));
  } catch (error) {
    await replyWithApiFailure(
      ctx,
      error,
      periodType === "daily"
        ? "I could not fetch your daily insight right now."
        : "I could not fetch your weekly insight right now."
    );
  }
}

async function sendWeeklyReview(ctx: Context) {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  try {
    const force = getCommandText(ctx).trim().toLowerCase() === "force";
    const response = await apiPost<WeeklyReviewResponse>(`/users/${getTelegramUserId(ctx)}/weekly-review`, { force });
    await ctx.reply(response.message);
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not generate your weekly review right now.");
  }
}

async function syncIntegration(ctx: Context, connectionId: string): Promise<string> {
  const response = await apiPost<IntegrationSyncResponse>(
    `/users/${getTelegramUserId(ctx)}/integrations/${connectionId}/sync`,
    {}
  );
  const personalCommits = response.personalCommitEvents ?? 0;
  const repoActivity = response.repoActivityEvents ?? 0;

  if (response.integrationId === "gmail") {
    return formatGmailSyncSummary(response);
  }

  if (personalCommits === 0 && repoActivity > 0) {
    return `Synced ${response.integrationId}: ${repoActivity} repo activity event${repoActivity === 1 ? "" : "s"}.`;
  }

  if (personalCommits > 0 && repoActivity === 0) {
    return `Synced ${response.integrationId}: ${personalCommits} personal commit${personalCommits === 1 ? "" : "s"}.`;
  }

  if (personalCommits > 0 && repoActivity > 0) {
    return `Synced ${response.integrationId}: ${personalCommits} personal commit${personalCommits === 1 ? "" : "s"} and ${repoActivity} repo activity event${repoActivity === 1 ? "" : "s"}.`;
  }

  return `Synced ${response.integrationId}: ${response.eventsCreated} new event${response.eventsCreated === 1 ? "" : "s"}.`;
}

async function postIntegrationSyncForDebug(ctx: Context, connectionId: string): Promise<IntegrationSyncResponse> {
  const response = await fetch(`${apiBaseUrl}/users/${getTelegramUserId(ctx)}/integrations/${connectionId}/sync`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({})
  });

  const body = (await response.json()) as IntegrationSyncResponse & { error?: string };

  if (!response.ok && !body.integrationId) {
    throw new Error(body.error ?? `API POST sync failed with ${response.status}`);
  }

  return body;
}

function formatGmailSyncSummary(response: IntegrationSyncResponse): string {
  if ((response.emailSummaries?.length ?? 0) === 0 && response.emailRuleDiagnostics?.activeRulesForConnection === 0) {
    return noActiveEmailRulesMessage();
  }

  const totals = gmailSyncTotals(response.emailSummaries ?? []);
  const newItems = totals.eventsCreated + totals.reviewItemsCreated;
  return `Gmail sync: ${totals.messagesFound} messages checked, ${newItems} new ${newItems === 1 ? "item" : "items"}.`;
}

function noActiveEmailRulesMessage(): string {
  return "Gmail is connected, but no email tracking rules are active. Say \"enable job search rule for Gmail\" or \"enable work action rule for Gmail\".";
}

function formatBatchIntegrationSyncResults(results: string[]): string {
  const noRuleResults = results.filter((result) => result === noActiveEmailRulesMessage());
  const otherResults = results.filter((result) => result !== noActiveEmailRulesMessage());

  if (otherResults.length === 0) {
    return noRuleResults.length > 0 ? noActiveEmailRulesMessage() : "No integration sync results.";
  }

  return dedupeTelegramLines(otherResults).join("\n\n");
}

function dedupeTelegramLines(lines: string[]): string[] {
  return [...new Set(lines.filter((line) => line.trim().length > 0))];
}

function formatGmailConnectionErrorDebug(connection: IntegrationConnection): string {
  return [
    `Gmail connection: ${connection.id}`,
    `status: ${connection.status}`,
    connection.lastError ? `lastError: ${safeGmailIntegrationMessageFromText(connection.lastError)}` : "lastError: Gmail sync failed.",
    "Reconnect Gmail with /connect_gmail."
  ].join("\n");
}

function formatGmailSyncDebug(connection: IntegrationConnection, response: IntegrationSyncResponse): string {
  const totals = gmailSyncTotals(response.emailSummaries ?? []);
  const activeRuleCount = response.emailRuleDiagnostics?.activeRulesForConnection ?? response.emailSummaries?.length ?? 0;
  const ruleLines =
    response.emailSummaries?.map(
      (summary) =>
        `- rule ${summary.ruleId} (${summary.adapterId}, ${summary.fetchStrategy}/${summary.classifierMode}): found ${summary.messagesFound}, processed ${summary.processed}, events ${summary.eventsCreated}, active deduped ${summary.deduped}, semantic deduped ${summary.semanticDeduped}, cleanup reprocessed ${summary.archivedCleanupReprocessed}, needs review ${summary.needsReview}, llm classified ${summary.llmClassified}, llm unavailable ${summary.llmUnavailable}, llm errors ${summary.llmErrors}, llm needs review ${summary.llmNeedsReview}, llm ignored ${summary.llmIgnored}, review created ${summary.reviewItemsCreated}, review pending ${summary.reviewItemsAlreadyPending}, review semantic deduped ${summary.reviewItemsSemanticDeduped}, review rejected/deduped ${summary.reviewItemsRejectedDeduped}, filtered marketing ${summary.filteredMarketing}, low confidence ${summary.lowConfidenceIgnored}, ignored unknown ${summary.ignoredUnknown}, skipped cap ${summary.skippedDueMaxEventsPerSync}${summary.lastErrorStage ? `, lastErrorStage: ${summary.lastErrorStage}` : ""}${summary.lastError ? `, lastError: ${safeGmailIntegrationMessageFromText(summary.lastError)}` : ""}`
    ) ?? [];
  const candidateLines =
    response.emailSummaries?.flatMap((summary) =>
      (summary.reviewCandidateDebug ?? []).slice(0, 12).map(formatEmailReviewCandidateDebug)
    ) ?? [];

  return [
    `Gmail connection: ${connection.id}`,
    response.emailRuleDiagnostics ? `total email rules: ${response.emailRuleDiagnostics.totalEmailRules}` : undefined,
    response.emailRuleDiagnostics ? `rules for connection: ${response.emailRuleDiagnostics.rulesForConnection}` : undefined,
    response.emailRuleDiagnostics
      ? `active rules for connection: ${response.emailRuleDiagnostics.activeRulesForConnection}`
      : undefined,
    response.emailRuleDiagnostics ? `stale/archived rules: ${response.emailRuleDiagnostics.staleOrArchivedRules}` : undefined,
    `active rules: ${activeRuleCount}`,
    response.emailRuleDiagnostics?.activeRulesForConnection === 0
      ? "No active email rules for current Gmail connection. Enable with /enable_email_rule job_search."
      : undefined,
    response.emailSummaries?.[0]?.fetchStrategy ? `fetchStrategy: ${response.emailSummaries[0].fetchStrategy}` : undefined,
    response.emailSummaries?.[0]?.classifierMode ? `classifierMode: ${response.emailSummaries[0].classifierMode}` : undefined,
    response.emailSummaries?.[0] ? `lookbackDays: ${response.emailSummaries[0].lookbackDays}` : undefined,
    response.emailSummaries?.[0] ? `maxMessagesPerSync: ${response.emailSummaries[0].maxMessagesPerSync}` : undefined,
    response.emailSummaries?.[0] ? `maxEventsPerSync: ${response.emailSummaries[0].maxEventsPerSync}` : undefined,
    `messages found: ${totals.messagesFound}`,
    `processed: ${totals.processed}`,
    `events created: ${totals.eventsCreated}`,
    `active deduped: ${totals.deduped}`,
    `semantic deduped: ${totals.semanticDeduped}`,
    `archived cleanup reprocessed: ${totals.archivedCleanupReprocessed}`,
    `needs review: ${totals.needsReview}`,
    `llm classified: ${totals.llmClassified}`,
    `llm unavailable: ${totals.llmUnavailable}`,
    `llm errors: ${totals.llmErrors}`,
    `llm needs review: ${totals.llmNeedsReview}`,
    `llm ignored: ${totals.llmIgnored}`,
    `review items created: ${totals.reviewItemsCreated}`,
    `review items already pending: ${totals.reviewItemsAlreadyPending}`,
    `review semantic deduped: ${totals.reviewItemsSemanticDeduped}`,
    `review items rejected/deduped: ${totals.reviewItemsRejectedDeduped}`,
    `filtered marketing: ${totals.filteredMarketing}`,
    `low confidence ignored: ${totals.lowConfidenceIgnored}`,
    `ignored unknown: ${totals.ignoredUnknown}`,
    `skipped due maxEventsPerSync: ${totals.skippedDueMaxEventsPerSync}`,
    response.errorStage ? `lastErrorStage: ${response.errorStage}` : undefined,
    response.error ? `lastError: ${safeGmailIntegrationMessageFromText(response.error)}` : undefined,
    ...(response.emailRuleDiagnostics?.rejectedRuleReasons.length
      ? response.emailRuleDiagnostics.rejectedRuleReasons.map((reason) => `rule not loaded: ${reason}`)
      : []),
    ...ruleLines,
    ...candidateLines
  ]
    .filter(Boolean)
    .join("\n");
}

function formatEmailReviewCandidateDebug(candidate: EmailReviewCandidateDebug): string {
  return [
    `review candidate: ${candidate.decision}`,
    candidate.subject ? `subject=${truncateText(candidate.subject, 80)}` : undefined,
    candidate.from ? `from=${truncateText(candidate.from, 80)}` : undefined,
    candidate.proposedEventType ? `type=${candidate.proposedEventType}` : undefined,
    candidate.company ? `company=${truncateText(candidate.company, 60)}` : undefined,
    candidate.role ? `role=${truncateText(candidate.role, 60)}` : undefined,
    candidate.project ? `project=${truncateText(candidate.project, 60)}` : undefined,
    candidate.deadline ? `deadline=${truncateText(candidate.deadline, 60)}` : undefined,
    typeof candidate.actionRequired === "boolean" ? `actionRequired=${candidate.actionRequired}` : undefined,
    candidate.matchedReviewId ? `matchedReviewId=${candidate.matchedReviewId}` : undefined,
    candidate.matchedReviewStatus ? `matchedReviewStatus=${candidate.matchedReviewStatus}` : undefined,
    candidate.matchedEventId ? `matchedEventId=${candidate.matchedEventId}` : undefined,
    `semanticKey=${truncateText(candidate.semanticKey, 220)}`
  ]
    .filter(Boolean)
    .join(" | ");
}

function gmailSyncTotals(summaries: EmailSyncSummary[]) {
  return summaries.reduce(
    (totals, summary) => ({
      messagesFound: totals.messagesFound + summary.messagesFound,
      processed: totals.processed + summary.processed,
      ignoredUnknown: totals.ignoredUnknown + summary.ignoredUnknown,
      filteredMarketing: totals.filteredMarketing + summary.filteredMarketing,
      needsReview: totals.needsReview + summary.needsReview,
      llmClassified: totals.llmClassified + summary.llmClassified,
      llmUnavailable: totals.llmUnavailable + summary.llmUnavailable,
      llmErrors: totals.llmErrors + summary.llmErrors,
      llmNeedsReview: totals.llmNeedsReview + summary.llmNeedsReview,
      llmIgnored: totals.llmIgnored + summary.llmIgnored,
      reviewItemsCreated: totals.reviewItemsCreated + summary.reviewItemsCreated,
      reviewItemsAlreadyPending: totals.reviewItemsAlreadyPending + summary.reviewItemsAlreadyPending,
      reviewItemsSemanticDeduped: totals.reviewItemsSemanticDeduped + summary.reviewItemsSemanticDeduped,
      reviewItemsRejectedDeduped: totals.reviewItemsRejectedDeduped + summary.reviewItemsRejectedDeduped,
      lowConfidenceIgnored: totals.lowConfidenceIgnored + summary.lowConfidenceIgnored,
      deduped: totals.deduped + summary.deduped,
      semanticDeduped: totals.semanticDeduped + summary.semanticDeduped,
      archivedCleanupReprocessed: totals.archivedCleanupReprocessed + summary.archivedCleanupReprocessed,
      skippedDueMaxEventsPerSync: totals.skippedDueMaxEventsPerSync + summary.skippedDueMaxEventsPerSync,
      eventsCreated: totals.eventsCreated + summary.eventsCreated
    }),
    {
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
      reviewItemsSemanticDeduped: 0,
      reviewItemsRejectedDeduped: 0,
      lowConfidenceIgnored: 0,
      deduped: 0,
      semanticDeduped: 0,
      archivedCleanupReprocessed: 0,
      skippedDueMaxEventsPerSync: 0,
      eventsCreated: 0
    }
  );
}

async function updateIntegrationStatusCommand(ctx: Context, status: "active" | "paused") {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  const connectionId = getCommandText(ctx);

  if (!connectionId) {
    await ctx.reply(`Usage: /${status === "active" ? "resume" : "pause"}_integration CONNECTION_ID`);
    return;
  }

  try {
    const response = await apiPatch<IntegrationConnectionResponse>(
      `/users/${getTelegramUserId(ctx)}/integrations/${connectionId}`,
      { status }
    );
    await ctx.reply(`Integration ${status}:\n${formatIntegrationConnection(response.connection)}`);
  } catch (error) {
    await replyWithIntegrationMessage(ctx, safeIntegrationErrorMessage(error));
  }
}

async function updateEmailRuleStatusCommand(ctx: Context, status: "active" | "paused") {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  const ruleId = getCommandText(ctx);

  if (!ruleId) {
    await ctx.reply(`Usage: /${status === "active" ? "resume" : "pause"}_email_rule RULE_ID`);
    return;
  }

  try {
    const [response, integrations] = await Promise.all([
      apiPatch<EmailRuleResponse>(`/users/${getTelegramUserId(ctx)}/email-rules/${ruleId}`, {
        status
      }),
      apiGet<IntegrationConnectionsResponse>(`/users/${getTelegramUserId(ctx)}/integrations`)
    ]);
    const connection = integrations.connections.find((item) => item.id === response.emailRule.connectionId);
    await ctx.reply(`Email rule ${status}:\n${formatEmailRule(response.emailRule, connection)}`);
  } catch (error) {
    await replyWithIntegrationMessage(ctx, safeIntegrationErrorMessage(error));
  }
}

function formatIntegrationSyncFailure(connection: IntegrationConnection, error: unknown): string {
  const reason =
    connection.integrationId === "gmail" ? safeGmailIntegrationErrorMessage(error) : safeIntegrationErrorMessage(error);

  return `Integration sync failed for ${connection.integrationId} ${connection.id}: ${reason}`;
}

function safeIntegrationErrorMessage(error: unknown): string {
  const fallback = "Integration request failed.";

  if (!error || typeof error !== "object") {
    return fallback;
  }

  const err = error as Record<string, unknown>;
  const message =
    typeof err.message === "string"
      ? err.message
      : typeof err.description === "string"
        ? err.description
        : "";

  if (!message) {
    return fallback;
  }

  if (message.includes("Cannot access") && message.includes("before initialization")) {
    return fallback;
  }

  if (message.toLowerCase().includes("gmail")) {
    return safeGmailIntegrationMessageFromText(message);
  }

  if (
    message.includes("repo not found or private") ||
    message.includes("Public GitHub integration only supports public repos")
  ) {
    return message;
  }

  if (message.includes("404") || message.toLowerCase().includes("not found")) {
    return "repo not found or private. Public GitHub integration only supports public repos.";
  }

  if (message.includes("403") || message.toLowerCase().includes("rate limit")) {
    return "GitHub rate limit reached. Try again later.";
  }

  return message;
}

function safeGmailIntegrationErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "Gmail sync failed.";
  }

  const err = error as Record<string, unknown>;
  const message =
    typeof err.message === "string"
      ? err.message
      : typeof err.description === "string"
        ? err.description
        : "";

  return safeGmailIntegrationMessageFromText(message);
}

function safeGmailIntegrationMessageFromText(message: string): string {
  const lower = message.toLowerCase();

  if (lower.startsWith("gmail sync failed:")) {
    return truncateText(message, 220);
  }

  if (lower.includes("gmail api has not been used") || lower.includes("disabled")) {
    return "Gmail API is disabled in Google Cloud project. Enable Gmail API and retry.";
  }

  if (lower.includes("authorization") || lower.includes("refresh") || lower.includes("invalid_grant")) {
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

  return "Gmail sync failed.";
}

async function replyWithIntegrationMessage(ctx: Context, message: string) {
  try {
    await ctx.reply(truncateText(message, 3900));
  } catch (error) {
    console.error("Telegram integration reply failed", error);
    try {
      await ctx.reply("Integration sync failed. Check /my_integrations for connection status.");
    } catch (replyError) {
      console.error("Telegram integration fallback reply failed", replyError);
    }
  }
}

async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`);

  if (!response.ok) {
    throw await errorFromResponse(response, `API GET ${path} failed with ${response.status}`);
  }

  return (await response.json()) as T;
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw await errorFromResponse(response, `API POST ${path} failed with ${response.status}`);
  }

  return (await response.json()) as T;
}

async function apiPatch<T>(path: string, body: unknown): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    throw await errorFromResponse(response, `API PATCH ${path} failed with ${response.status}`);
  }

  return (await response.json()) as T;
}

async function apiDelete<T>(path: string): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: "DELETE"
  });

  if (!response.ok) {
    throw await errorFromResponse(response, `API DELETE ${path} failed with ${response.status}`);
  }

  return (await response.json()) as T;
}

async function postCorrectEvent(
  path: string,
  body: unknown
): Promise<
  | ({ ok: true } & EventCorrectionResponse)
  | {
      ok: false;
      error: string;
    }
> {
  const fallback = "I could not correct that event. Check the ID and data format.";
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });

  if (response.ok) {
    return {
      ok: true,
      ...((await response.json()) as EventCorrectionResponse)
    };
  }

  const responseText = await response.text();
  const parsedError = parseApiFailureText(responseText);

  return {
    ok: false,
    error: parsedError ?? (responseText.trim() || fallback)
  };
}

function parseApiFailureText(responseText: string): string | undefined {
  if (!responseText.trim()) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(responseText) as { error?: unknown };
    return typeof parsed.error === "string" && parsed.error.trim() ? parsed.error : undefined;
  } catch {
    return undefined;
  }
}

async function replyWithApiFailure(ctx: Context, error: unknown, fallbackMessage: string) {
  console.error("Telegram API call failed", error);

  if (isFetchError(error)) {
    await ctx.reply("I cannot reach the agent API right now. Make sure the API server is running.");
    return;
  }

  const message = safeErrorMessage(error);

  if (message) {
    await ctx.reply(message);
    return;
  }

  await ctx.reply(fallbackMessage);
}

function isFetchError(error: unknown) {
  return error instanceof TypeError;
}

async function errorFromResponse(response: Response, fallbackMessage: string): Promise<Error> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return new Error(typeof body.error === "string" && body.error.trim() ? body.error : fallbackMessage);
  } catch {
    return new Error(fallbackMessage);
  }
}

function safeErrorMessage(error: unknown): string | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const candidate = error as { message?: unknown; description?: unknown };

  if (typeof candidate.message === "string" && candidate.message.trim()) {
    return candidate.message;
  }

  if (typeof candidate.description === "string" && candidate.description.trim()) {
    return candidate.description;
  }

  return undefined;
}

async function findEventIncludingArchived(ctx: Context, eventId: string): Promise<Event | undefined> {
  try {
    const response = await apiGet<EventsResponse>(`/users/${getTelegramUserId(ctx)}/events?includeArchived=true`);
    return response.events.find((event) => event.id === eventId);
  } catch (error) {
    console.error("Could not fetch event audit history", error);
    return undefined;
  }
}

function formatDailyReview(review: DailyReview) {
  return [
    review.summary,
    "",
    review.activeGoals.length > 0 ? `Active goals:\n${review.activeGoals.map(formatReviewGoal).join("\n")}` : undefined,
    review.warnings.length > 0 ? `Warnings:\n${review.warnings.map((warning) => `- ${warning}`).join("\n")}` : undefined,
    review.memorySignals.length > 0
      ? `Memory signals:\n${review.memorySignals.map((signal) => `- ${signal}`).join("\n")}`
      : undefined,
    review.checkIn.length > 0 ? `Check-in: ${review.checkIn.join(", ")}` : undefined,
    `Wins: ${review.wins.length > 0 ? review.wins.join(", ") : "none logged"}`,
    `Gaps: ${review.gaps.length > 0 ? review.gaps.join(", ") : "none obvious"}`,
    `Focus: ${review.suggestedFocus}`
  ]
    .filter(Boolean)
    .join("\n");
}

function formatDailyOperatorBrief(brief: DailyOperatorBrief): string {
  return [
    `Today - ${brief.date}`,
    "",
    "Status:",
    brief.summary,
    "",
    brief.coach ? formatDailyCoach(brief.coach) : undefined,
    brief.coach ? "" : undefined,
    "Top priorities:",
    brief.topPriorities.length > 0 ? brief.topPriorities.map((item, index) => `${index + 1}. ${item}`).join("\n") : "No clear priorities yet.",
    "",
    "Open actions:",
    brief.openActions.length > 0 ? brief.openActions.map(formatBriefAction).join("\n") : "No open action items.",
    "",
    brief.recentWins.length > 0 ? `Recent wins:\n${brief.recentWins.map((win) => `- ${win}`).join("\n")}` : undefined,
    brief.goalStatus.length > 0
      ? `Goals:\n${brief.goalStatus.map((goal) => `- ${goal.title}: ${goal.note}`).join("\n")}`
      : undefined,
    brief.risks.length > 0 ? `Risks / watchouts:\n${brief.risks.map((risk) => `- ${risk}`).join("\n")}` : undefined,
    brief.actionHygiene ? `Action hygiene:\n- ${formatCleanupDecisionGrammar(brief.actionHygiene.needsDecision)} Run /action_hygiene.` : undefined,
    brief.weeklyReviewDue ? "Weekly review:\n- Weekly review due. Run /weekly." : undefined,
    brief.operatorReflection ? `Pattern:\n${brief.operatorReflection}` : undefined,
    "",
    "Next move:",
    brief.suggestedNextStep
  ]
    .filter((item) => item !== undefined)
    .join("\n");
}

function formatDailyCoach(coach: DailyCoachResponse): string {
  return [
    "Coach:",
    coach.diagnosis,
    `Next move: ${coach.nextMove}`,
    coach.warning ? `Warning: ${coach.warning}` : undefined,
    coach.encouragement ?? undefined
  ]
    .filter(Boolean)
    .join("\n");
}

function formatCleanupDecisionGrammar(count: number): string {
  return count === 1 ? "1 action needs a cleanup decision." : `${count} actions need cleanup decisions.`;
}

function formatDailyPriorityDebug(priorities: DailyOperatorBriefPriorityDebug[]): string {
  if (priorities.length === 0) {
    return "No open actions to score.";
  }

  return priorities
    .map((priority) =>
      `${priority.rank}. ${priority.title} - score ${priority.score} - ${priority.rankReason || priority.factors.join(", ")}`
    )
    .join("\n");
}

function formatDailyCoachDebug(debug: DailyCoachDebugResponse): string {
  return [
    `coachSource: ${debug.coachSource}`,
    `DAILY_COACH_LLM_ENABLED: ${debug.dailyCoachLlmEnabled}`,
    `llmEnabled: ${debug.llmEnabled ? "yes" : "no"}`,
    `llmAttempted: ${debug.llmAttempted ? "yes" : "no"}`,
    `validationStatus: ${debug.validationStatus}`,
    `validationFailureCodes: ${debug.validationFailureCodes.length > 0 ? debug.validationFailureCodes.join(", ") : "none"}`,
    debug.validationFailureSummary ? `validationFailureSummary: ${debug.validationFailureSummary}` : undefined,
    `selected nextMove: ${debug.selectedNextMove}`,
    debug.selectedActionTitle ? `selectedActionTitle: ${debug.selectedActionTitle}` : undefined,
    `schema validation passed: ${debug.schemaValidationPassed ? "yes" : "no"}`,
    debug.fallbackReason ? `fallback reason: ${debug.fallbackReason}` : undefined,
    debug.rawResponseType ? `rawResponseType: ${debug.rawResponseType}` : undefined,
    debug.parsedFieldsPresent ? `parsedFieldsPresent: ${debug.parsedFieldsPresent.join(",") || "none"}` : undefined,
    typeof debug.responseLength === "number" ? `responseLength: ${debug.responseLength}` : undefined,
    typeof debug.diagnosisLength === "number" ? `diagnosisLength: ${debug.diagnosisLength}` : undefined,
    typeof debug.nextMoveLength === "number" ? `nextMoveLength: ${debug.nextMoveLength}` : undefined,
    typeof debug.warningLength === "number" ? `warningLength: ${debug.warningLength}` : undefined,
    typeof debug.encouragementLength === "number" ? `encouragementLength: ${debug.encouragementLength}` : undefined,
    "top 3 scored priorities:",
    debug.topPriorities.length > 0
      ? debug.topPriorities
          .map((priority) => `${priority.rank}. ${priority.title} - score ${priority.score} - ${priority.rankReason}`)
          .join("\n")
      : "none"
  ]
    .filter(Boolean)
    .join("\n");
}

function formatBriefAction(action: DailyOperatorBriefAction): string {
  const detail = action.dueAt
    ? `due ${formatLocalDateTime(action.dueAt)}`
    : action.snoozedUntil
      ? `snoozed until ${formatLocalDateTime(action.snoozedUntil)}`
      : undefined;
  const goal = action.goalTitle ? `goal: ${action.goalTitle}` : undefined;

  return `- ${action.title}${detail ? ` - ${detail}` : ""}${goal ? ` - ${goal}` : ""}`;
}

function formatInsight(insight: InsightReport) {
  return [
    insight.headline,
    insight.summary,
    "",
    formatSection("Wins", insight.wins),
    formatSection("Gaps", insight.gaps),
    formatSection("Risks", insight.risks),
    formatSection("Patterns", insight.patterns),
    insight.goalProgress.length > 0
      ? `Goals:\n${insight.goalProgress.map((goal) => `- ${goal.title}: ${goal.note}`).join("\n")}`
      : undefined,
    formatSection("Memory signals", insight.memorySignals),
    formatSection("Recommended actions", insight.recommendedActions),
    insight.hardTruth ? `Hard truth:\n${insight.hardTruth}` : undefined
  ]
    .filter(Boolean)
    .join("\n");
}

function formatSection(title: string, items: string[]) {
  return items.length > 0 ? `${title}:\n${items.map((item) => `- ${item}`).join("\n")}` : undefined;
}

function formatProfile(profile: Profile) {
  return [
    "Profile:",
    `directness: ${profile.directness}`,
    `warmth: ${profile.warmth}`,
    `confrontation: ${profile.confrontation}`,
    `motivationalStyle: ${profile.motivationalStyle}`,
    `gamblingGuardrails: ${profile.gamblingGuardrails}`,
    `cooldownPreference: ${profile.cooldownPreference}`,
    `vulnerableMode: ${profile.vulnerableMode}`,
    `avoidingMode: ${profile.avoidingMode}`,
    `impulsiveMode: ${profile.impulsiveMode}`
  ].join("\n");
}

function formatMemories(memories: MemoryEntry[]) {
  if (memories.length === 0) {
    return "No active memories yet.";
  }

  return memories.map(formatMemory).join("\n\n");
}

function formatMemory(memory: MemoryEntry) {
  return [
    `id: ${memory.id}`,
    `type: ${memory.type}`,
    `summary: ${memory.summary}`,
    `source: ${memory.source}`,
    `confidence: ${memory.confidence}`
  ].join("\n");
}

function inferMemoryType(text: string): MemoryEntry["type"] {
  if (/\b(prefiero|prefer|hate|odio|generic motivation|hablas? directo|directo)\b/i.test(text)) {
    if (/\b(hablas? directo|directo|tone|communication|me hables|talk to me)\b/i.test(text)) {
      return "communication_style";
    }

    return "preference";
  }

  if (/\b(risk|apuesta|apostar|gambling|trading|betting)\b/i.test(text)) {
    return "risk_pattern";
  }

  return "note";
}

function normalizeMemorySummary(text: string): string {
  const trimmed = text.trim();
  const first = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return first.endsWith(".") ? first : `${first}.`;
}

function formatNotificationSettings(settings: NotificationSettings) {
  return [
    "Notification settings:",
    `dailyCheckinEnabled: ${settings.dailyCheckinEnabled}`,
    `dailyCheckinTime: ${settings.dailyCheckinTime ?? "not set"}`,
    `dailyInsightEnabled: ${settings.dailyInsightEnabled}`,
    `dailyInsightTime: ${settings.dailyInsightTime ?? "not set"}`,
    `weeklyInsightEnabled: ${settings.weeklyInsightEnabled}`,
    `weeklyInsightDay: ${settings.weeklyInsightDay ?? "not set"}`,
    `weeklyInsightTime: ${settings.weeklyInsightTime ?? "not set"}`,
    `dailyLoopEnabled: ${settings.dailyLoopEnabled}`,
    `timezone: ${settings.timezone}`,
    `defaultActionTime: ${formatMinutesOfDay(settings.defaultActionTimeMinutes)}`,
    `morning: ${formatMinutesOfDay(settings.morningTimeMinutes)}`,
    `afternoon: ${formatMinutesOfDay(settings.afternoonTimeMinutes)}`,
    `evening: ${formatMinutesOfDay(settings.eveningTimeMinutes)}`,
    `tonight: ${formatMinutesOfDay(settings.tonightTimeMinutes)}`,
    `telegramUserId: ${settings.telegramUserId ?? "not set"}`
  ].join("\n");
}

function formatReminderSettings(settings: NotificationSettings) {
  return [
    "Reminder settings:",
    `timezone: ${settings.timezone}`,
    `default action time: ${formatMinutesOfDay(settings.defaultActionTimeMinutes)}`,
    `morning: ${formatMinutesOfDay(settings.morningTimeMinutes)}`,
    `afternoon: ${formatMinutesOfDay(settings.afternoonTimeMinutes)}`,
    `evening: ${formatMinutesOfDay(settings.eveningTimeMinutes)}`,
    `tonight: ${formatMinutesOfDay(settings.tonightTimeMinutes)}`
  ].join("\n");
}

function formatDailyLoopSettings(settings: NotificationSettings) {
  return [
    "Daily loop settings:",
    `enabled: ${settings.dailyLoopEnabled ? "yes" : "no"}`,
    `morning: ${formatMinutesOfDay(settings.morningTimeMinutes)}`,
    `evening: ${formatMinutesOfDay(settings.eveningTimeMinutes)}`,
    `timezone: ${settings.timezone}`
  ].join("\n");
}

function parseSetDailyLoopCommand(text: string): Partial<NotificationSettings> | undefined {
  const [field, value] = text.trim().split(/\s+/, 2);

  if (field === "enabled" && /^(on|off)$/i.test(value ?? "")) {
    return {
      dailyLoopEnabled: value?.toLowerCase() === "on"
    };
  }

  const minutes = parseMinutesOfDay(value ?? "");

  if (field === "morning" && minutes !== undefined) {
    return {
      morningTimeMinutes: minutes
    };
  }

  if (field === "evening" && minutes !== undefined) {
    return {
      eveningTimeMinutes: minutes
    };
  }

  return undefined;
}

function parseSetReminderTimeCommand(text: string): { field: keyof ReminderTimePatch; minutes: number } | undefined {
  const [kind, value] = text.trim().split(/\s+/, 2);
  const minutes = parseMinutesOfDay(value ?? "");
  const fieldByKind: Record<string, keyof ReminderTimePatch> = {
    default: "defaultActionTimeMinutes",
    morning: "morningTimeMinutes",
    afternoon: "afternoonTimeMinutes",
    evening: "eveningTimeMinutes",
    tonight: "tonightTimeMinutes"
  };

  if (!kind || minutes === undefined || !fieldByKind[kind]) {
    return undefined;
  }

  return {
    field: fieldByKind[kind],
    minutes
  };
}

function parseMinutesOfDay(value: string): number | undefined {
  const match = value.match(/^([01]\d|2[0-3]):([0-5]\d)$/);

  if (!match) {
    return undefined;
  }

  return Number(match[1]) * 60 + Number(match[2]);
}

function formatMinutesOfDay(minutes: number): string {
  const safeMinutes = Number.isInteger(minutes) && minutes >= 0 && minutes <= 1439 ? minutes : 0;
  const hour = Math.floor(safeMinutes / 60);
  const minute = safeMinutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function formatLocalDateTime(value: string | Date, timezone = "Europe/Madrid"): string {
  const date = value instanceof Date ? value : new Date(value);

  if (Number.isNaN(date.getTime())) {
    return String(value);
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

function formatGoals(goals: Goal[], duplicateWarnings: GoalDuplicateWarning[] = []) {
  if (goals.length === 0) {
    return "No active goals yet. Create one with /create_goal category | title | why";
  }

  const warnings = duplicateWarnings.map(
    (warning) => `Possible duplicate: this goal looks similar to ${warning.similarGoalTitle}.`
  );

  return [...goals.map((goal) => formatGoal(goal, duplicateWarnings)), ...warnings].join("\n\n");
}

function formatGoalTemplates(goalTemplates: GoalTemplate[]) {
  if (goalTemplates.length === 0) {
    return "No goal templates available.";
  }

  return goalTemplates.map((template) => `${template.id}: ${template.title}`).join("\n");
}

function formatIntegrationDefinitions(integrations: IntegrationDefinition[]) {
  if (integrations.length === 0) {
    return "No integrations registered.";
  }

  return integrations
    .map(
      (integration) =>
        [
          `${integration.id}: ${integration.name}`,
          `status: ${integration.status}`,
          `auth: ${integration.authType}`,
          `events: ${integration.producesEventTypes.join(", ")}`
        ].join("\n")
    )
    .join("\n\n");
}

function formatIntegrationConnections(connections: IntegrationConnection[], includeArchived = false) {
  const visibleConnections = includeArchived
    ? connections
    : connections.filter((connection) => connection.status !== "archived");

  if (visibleConnections.length === 0) {
    return "No integrations connected. Use /connect_github OWNER/REPO.";
  }

  return [
    ...visibleConnections.map(formatIntegrationConnection),
    !includeArchived && connections.some((connection) => connection.status === "archived")
      ? "Use /my_integrations all to include archived."
      : undefined
  ]
    .filter(Boolean)
    .join("\n\n");
}

function formatEmailRules(rules: EmailSignalRule[], connections: IntegrationConnection[] = []) {
  if (rules.length === 0) {
    return "No email rules yet. Use /enable_email_rule job_search after connecting Gmail.";
  }

  const connectionById = new Map(connections.map((connection) => [connection.id, connection]));
  return rules.map((rule) => formatEmailRule(rule, connectionById.get(rule.connectionId))).join("\n\n");
}

function formatEmailReviews(reviews: EmailReviewItem[], showAll: boolean): string {
  if (reviews.length === 0) {
    return showAll ? "No recent email review items." : "No pending email reviews.";
  }

  return reviews.map(formatEmailReview).join("\n\n");
}

function formatEmailReview(review: EmailReviewItem): string {
  return [
    `id: ${review.id}`,
    `status: ${review.status}`,
    review.from ? `from: ${truncateText(review.from, 120)}` : undefined,
    review.subject ? `subject: ${truncateText(review.subject, 120)}` : undefined,
    review.proposedEventType ? `suggestion: ${review.proposedEventType}` : undefined,
    `confidence: ${review.confidence}`,
    `reason: ${truncateText(review.reason, 120)}`,
    review.status === "archived" && review.archiveReason ? `archiveReason: ${review.archiveReason}` : undefined,
    review.evidence || review.snippet ? `evidence: ${truncateText(review.evidence ?? review.snippet ?? "", 220)}` : undefined,
    review.status === "pending" ? `approve: /approve_email_review ${review.id}` : undefined,
    review.status === "pending" ? `reject: /reject_email_review ${review.id}` : undefined
  ]
    .filter(Boolean)
    .join("\n");
}

function formatActions(actions: ActionItem[], showAll: boolean): string {
  if (actions.length === 0) {
    return showAll ? "No recent action items." : "No open action items.";
  }

  return actions.map(formatAction).join("\n\n");
}

function formatAction(action: ActionItem): string {
  return [
    `id: ${action.id}`,
    `title: ${truncateText(action.title, 120)}`,
    `status: ${action.status}`,
    `priority: ${action.priority}`,
    action.dueAt ? `dueAt: ${formatLocalDateTime(action.dueAt)}` : undefined,
    action.snoozedUntil ? `snoozedUntil: ${formatLocalDateTime(action.snoozedUntil)}` : undefined,
    action.goalTitleSnapshot ? `goal: ${truncateText(action.goalTitleSnapshot, 100)}` : undefined,
    action.project ? `project: ${truncateText(action.project, 80)}` : undefined,
    action.actionType ? `type: ${action.actionType}` : undefined,
    `source: ${action.source}`,
    action.description ? `description: ${truncateText(action.description, 180)}` : undefined,
    action.evidence ? `evidence: ${truncateText(action.evidence, 180)}` : undefined,
    action.status === "open" || action.status === "snoozed" ? `complete: /complete_action ${action.id}` : undefined,
    action.status === "open" || action.status === "snoozed" ? `snooze: /snooze_action ${action.id} tomorrow` : undefined,
    action.status !== "archived" ? `archive: /archive_action ${action.id}` : undefined
  ]
    .filter(Boolean)
    .join("\n");
}

async function createManualActionFromCommand(ctx: Context, commandName: string) {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  const text = getCommandText(ctx);

  if (!text) {
    await ctx.reply(`Usage: ${commandName} review homepage copy tomorrow`);
    return;
  }

  try {
    const routeDebug = explainNormalizedInboundRoute(buildNormalizedTelegramMessage(ctx, `${commandName} ${text}`));

    if (routeDebug.intentType === "command_with_guardrail" || routeDebug.intentType === "command_with_risk") {
      const riskResponse = await apiPost<ProcessMessageResponse>("/messages/process", {
        userId: getTelegramUserId(ctx),
        message: text
      });
      await ctx.reply(riskResponse.reply);
      return;
    }

    const response = await apiPost<ManualActionResponse>(`/users/${getTelegramUserId(ctx)}/actions/manual`, {
      text
    });
    await ctx.reply(response.message);
  } catch (error) {
    await replyWithApiFailure(ctx, error, "I could not create that action item.");
  }
}

async function tryCreateManualAction(ctx: Context, text: string): Promise<ManualActionResponse | undefined> {
  try {
    return await apiPost<ManualActionResponse>(`/users/${getTelegramUserId(ctx)}/actions/manual`, {
      text
    });
  } catch {
    return undefined;
  }
}

function parseSnoozeActionCommand(text: string): { actionId: string; value: string } | undefined {
  const match = text.trim().match(/^(\S+)\s+(.+)$/);
  const actionId = match?.[1];
  const value = match?.[2]?.trim();

  if (!actionId || !value) {
    return undefined;
  }

  return { actionId, value: value.match(/^\d+d$/i) ? `in ${value.slice(0, -1)} days` : value };
}

function formatEmailRule(rule: EmailSignalRule, connection?: IntegrationConnection) {
  const connectionStatus = connection?.status ?? "missing";
  const staleWarning =
    rule.status === "active" && connectionStatus !== "active"
      ? "warning: rule is attached to inactive Gmail connection"
      : undefined;
  const details = emailRuleDisplayDetails(rule);

  return [
    `id: ${rule.id}`,
    `tracks: ${details.title}`,
    `status: ${rule.status}`,
    details.description,
    `connectionId: ${rule.connectionId}`,
    `connectionStatus: ${connectionStatus}`,
    staleWarning,
    rule.goalId ? `goalId: ${rule.goalId}` : undefined,
    `mode: ${details.mode}`,
    rule.query ? `search filter: ${truncateText(rule.query, 140)}` : undefined,
    rule.lastSyncedAt ? `lastSyncedAt: ${new Date(rule.lastSyncedAt).toLocaleString()}` : undefined,
    rule.lastError ? `lastError: ${safeGmailIntegrationMessageFromText(rule.lastError)}` : undefined
  ]
    .filter(Boolean)
    .join("\n");
}

function formatEmailRuleEnabledReply(response: EmailRuleResponse, connection: IntegrationConnection): string {
  const rule = response.emailRule;
  const details = emailRuleDisplayDetails(rule);
  const alreadyExists = response.message?.includes("already exists");

  return [
    `${details.title} is ${alreadyExists ? "already on" : "on"}.`,
    "",
    "What I will watch for:",
    ...details.watchItems.map((item) => `- ${item}`),
    "",
    details.mode,
    "I only scan Gmail while this rule is active.",
    "",
    `Rule id: ${rule.id}`,
    typeof connection.config.email === "string" ? `Gmail account: ${connection.config.email}` : undefined,
    "Sync now: sync Gmail",
    "See rules: /my_email_rules"
  ].filter(Boolean).join("\n");
}

function emailRuleDisplayDetails(rule: EmailSignalRule): {
  title: string;
  description: string;
  watchItems: string[];
  mode: string;
} {
  if (rule.adapterId === "work_action_email") {
    return {
      title: "Work-action email tracking",
      description: "Watches for work requests, deadlines, follow-ups, feedback, blockers, and project updates.",
      watchItems: ["work requests", "deadlines", "follow-ups", "feedback requests", "blockers"],
      mode: "Work-action emails go to review before becoming action items."
    };
  }

  if (rule.adapterId === "job_search_email") {
    return {
      title: "Job-search email tracking",
      description: "Watches for recruiter replies, interviews, rejections, offers, and application confirmations.",
      watchItems: ["recruiter replies", "interview scheduling", "rejections", "offers", "application confirmations"],
      mode: "Clear job-search emails can become career events. Uncertain emails go to review."
    };
  }

  return {
    title: rule.name || "Email tracking rule",
    description: "Custom email tracking is not fully supported yet.",
    watchItems: ["emails matching this rule"],
    mode: "Uncertain emails go to review."
  };
}

function gmailRuleSuggestion(connections: IntegrationConnection[], goals: Goal[], rules: EmailSignalRule[]): string | undefined {
  const hasGmail = connections.some((connection) => connection.integrationId === "gmail" && connection.status === "active");
  const hasCareerGoal = goals.some((goal) => goal.status === "active" && (goal.category === "career" || goal.templateId === "career.job_search"));
  const hasJobSearchRule = rules.some((rule) => rule.status === "active" && rule.adapterId === "job_search_email");

  if (!hasGmail || !hasCareerGoal || hasJobSearchRule) {
    return undefined;
  }

  return "Gmail can track recruiter replies, interviews, rejections, and offers for your job-search goal. Enable with /enable_email_rule job_search.";
}

function formatIntegrationConnection(connection: IntegrationConnection) {
  if (connection.integrationId === "gmail") {
    return [
      `id: ${connection.id}`,
      "integration: gmail",
      `status: ${connection.status}`,
      typeof connection.config.email === "string" ? `email: ${connection.config.email}` : undefined,
      typeof connection.config.scope === "string" ? `scope: ${connection.config.scope}` : undefined,
      typeof connection.config.hasRefreshToken === "boolean"
        ? `hasRefreshToken: ${connection.config.hasRefreshToken}`
        : undefined,
      typeof connection.config.expiresAt === "number"
        ? `expiresAt: ${new Date(connection.config.expiresAt).toLocaleString()}`
        : undefined,
      connection.lastSyncedAt ? `lastSyncedAt: ${new Date(connection.lastSyncedAt).toLocaleString()}` : undefined,
      connection.lastError ? `lastError: ${safeGmailIntegrationMessageFromText(connection.lastError)}` : undefined
    ]
      .filter(Boolean)
      .join("\n");
  }

  const repos = Array.isArray(connection.config.repos)
    ? connection.config.repos
        .map((item) => {
          if (!item || typeof item !== "object") {
            return undefined;
          }

          const repo = item as { owner?: unknown; repo?: unknown };
          return typeof repo.owner === "string" && typeof repo.repo === "string" ? `${repo.owner}/${repo.repo}` : undefined;
        })
        .filter(Boolean)
        .join(", ")
    : "not set";

  return [
    `id: ${connection.id}`,
    `integration: ${connection.integrationId}`,
    `status: ${connection.status}`,
    `repos: ${repos}`,
    typeof connection.config.authorLogin === "string" ? `author: ${connection.config.authorLogin}` : undefined,
    connection.lastSyncedAt ? `lastSyncedAt: ${new Date(connection.lastSyncedAt).toLocaleString()}` : undefined,
    connection.lastError ? `lastError: ${safeIntegrationErrorMessage({ message: connection.lastError })}` : undefined
  ]
    .filter(Boolean)
    .join("\n");
}

function formatReviewGoal(goal: DailyReviewGoal) {
  return `- ${goal.title}: ${goal.status}`;
}

function formatDuplicateGoalMessage(response: GoalResponse) {
  if (!response.duplicate || !response.existingGoal) {
    return "I could not create that goal right now.";
  }

  return (
    response.message ??
    `You already have a similar active goal: ${response.existingGoal.title}. Use /goals to review it or /archive_goal ${response.existingGoal.id} first.`
  );
}

function formatGoal(goal: Goal, duplicateWarnings: GoalDuplicateWarning[] = []) {
  const warning = duplicateWarnings.find((item) => item.goalId === goal.id);

  return [
    `id: ${goal.id}`,
    `title: ${goal.title}`,
    `category: ${goal.category}`,
    goal.templateId ? `template: ${goal.templateId}` : undefined,
    `status: ${goal.status}`,
    `priority: ${goal.priority ?? "medium"}`,
    goal.importanceScore !== undefined ? `importanceScore: ${goal.importanceScore}` : undefined,
    goal.why ? `why: ${goal.why}` : undefined,
    warning ? `Possible duplicate: this goal looks similar to ${warning.similarGoalTitle}.` : undefined
  ]
    .filter(Boolean)
    .join("\n");
}

function formatGoalPriorities(goals: GoalPriorityListItem[]): string {
  if (goals.length === 0) {
    return "No active goals.";
  }

  return goals
    .map((goal) => `${goal.number}. ${goal.title} - ${goal.priority}${goal.importanceScore !== undefined ? ` (${goal.importanceScore})` : ""}`)
    .join("\n");
}

function parseSetGoalPriorityCommand(text: string): { goal: string; priority: string } | undefined {
  const match = text.trim().match(/^(.+?)\s+(low|medium|high|critical)$/i);

  if (!match) {
    return undefined;
  }

  return {
    goal: match[1].trim().replace(/^["']|["']$/g, ""),
    priority: match[2].toLowerCase()
  };
}

function formatGoalPlan(goal: Goal) {
  return [
    `Goal plan: ${goal.title}`,
    `id: ${goal.id}`,
    `category: ${goal.category}`,
    `template: ${goal.templateId ?? "custom"}`,
    goal.targetMetrics?.length
      ? `Metrics:\n${goal.targetMetrics.map((metric) => `- ${metric.key}: ${metric.label}${metric.unit ? ` (${metric.unit})` : ""}`).join("\n")}`
      : "Metrics: none configured",
    goal.checkInConfig?.length
      ? `Check-ins:\n${goal.checkInConfig.map((question) => `- ${question.question}`).join("\n")}`
      : "Check-ins: none configured",
    "Examples:",
    `/log_progress ${goal.id} | metric=focused_minutes value=45 unit=minutes note=focused block`,
    `/log_progress ${goal.id} | worked for 45 minutes on it`
  ].join("\n");
}

function formatEvents(events: Event[], options: { alwaysShowStatus?: boolean; intro?: string } = {}) {
  if (events.length === 0) {
    return "No recent events yet.";
  }

  return [options.intro, ...events.map((event) => formatEvent(event, options))].filter(Boolean).join("\n\n");
}

async function replyWithEventList(ctx: Context, message: string) {
  try {
    await ctx.reply(truncateText(message, 3900));
  } catch (error) {
    console.error("Telegram event list reply failed", error);
    await ctx.reply("Too many events to display. Try /events 5.");
  }
}

async function getLatestPendingAction(ctx: Context) {
  const response = await apiGet<PendingActionsResponse>(`/users/${getTelegramUserId(ctx)}/pending-actions`);
  return response.pendingActions.find((action) => action.status === "pending");
}

function formatPendingActions(pendingActions: PendingAction[]) {
  const activeActions = pendingActions.filter((action) => action.status === "pending");

  if (activeActions.length === 0) {
    return "No pending actions.";
  }

  return activeActions.map(formatPendingAction).join("\n\n");
}

function formatPendingAction(pendingAction: PendingAction) {
  const lines = [
    `id: ${pendingAction.id}`,
    `type: ${pendingAction.type}`,
    `summary: ${pendingAction.summary}`,
    `status: ${pendingAction.status}`,
    pendingAction.expiresAt ? `expiresAt: ${new Date(pendingAction.expiresAt).toLocaleString()}` : undefined
  ];

  const candidates = readPendingCandidates(pendingAction.payload?.candidateActions);

  if (candidates.length > 0) {
    lines.push(
      "candidates:",
      ...candidates.map((candidate, index) => {
        const due = candidate.dueAt ? ` - due ${new Date(candidate.dueAt).toLocaleString()}` : "";
        return `${index + 1}. ${candidate.title}${due}`;
      })
    );
  }

  return lines.filter(Boolean).join("\n");
}

function readPendingCandidates(value: unknown): Array<{ title: string; dueAt?: string }> {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
    .map((item) => ({
      title: typeof item.title === "string" ? item.title : "",
      dueAt: typeof item.dueAt === "string" ? item.dueAt : undefined
    }))
    .filter((item) => item.title);
}

function formatEvent(event: Event, options: { alwaysShowStatus?: boolean } = {}) {
  const status = event.status ?? "active";

  return [
    `id: ${event.id}`,
    event.eventGroupId ? `group: ${event.eventGroupId}` : undefined,
    options.alwaysShowStatus || status !== "active" ? `status: ${status}` : undefined,
    status === "corrected" && event.correctedByEventId ? `correctedByEventId: ${event.correctedByEventId}` : undefined,
    status === "archived" && event.archiveReason ? `archiveReason: ${event.archiveReason}` : undefined,
    `type: ${event.type}`,
    `time: ${new Date(event.timestamp).toLocaleString()}`,
    `data: ${truncateText(formatEventData(event), 300)}`,
    correctionHint(event),
    event.evidence && event.evidence.length > 0
      ? `evidence: ${truncateText(event.evidence.slice(0, 2).join("; "), 300)}`
      : undefined
  ]
    .filter(Boolean)
    .join("\n");
}

function correctionHint(event: Event): string | undefined {
  const hints: Record<string, string> = {
    "health.workout_completed": `correct with: /correct_event ${event.id} | {"duration_minutes":30}`,
    "learning.reading_session_completed": `correct with: /correct_event ${event.id} | {"duration_minutes":30}`,
    "health.sleep_logged": `correct with: /correct_event ${event.id} | {"duration_hours":7}`,
    "career.application_sent": `correct with: /correct_event ${event.id} | {"count":2}`,
    "reflection.energy_logged": `correct with: /correct_event ${event.id} | {"value":6}`
  };

  return event.status === "active" || !event.status ? hints[event.type] : undefined;
}

function formatArchiveResult(response: EventArchiveResponse) {
  if (response.count === 0) {
    return "No active event to archive.";
  }

  if (response.count === 1) {
    return "Archived last event.";
  }

  return `Archived ${response.count} events from the last action.`;
}

type ParsedCorrectEventCommand =
  | { eventId: string; type?: string; data: Record<string, unknown> }
  | { error: "invalid_json" };

function parseCorrectEventCommand(text: string): ParsedCorrectEventCommand | undefined {
  const parts = text.split("|").map((part) => part.trim()).filter(Boolean);
  const [eventId, second, third] = parts;

  if (!eventId || !second) {
    return undefined;
  }

  const type = second.startsWith("type=") ? second.replace(/^type=/, "").trim() : undefined;
  const jsonText = type ? third : second;

  if (!jsonText) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(jsonText) as unknown;

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: "invalid_json" };
    }

    return {
      eventId,
      type,
      data: parsed as Record<string, unknown>
    };
  } catch {
    return { error: "invalid_json" };
  }
}

function formatEventData(event: Event) {
  if (event.type === "career.application_sent" && typeof event.data.count === "number") {
    return `${event.data.count} application${event.data.count === 1 ? "" : "s"} sent`;
  }

  if (event.type === "health.workout_completed" && typeof event.data.duration_minutes === "number") {
    return `${event.data.duration_minutes} minutes of training`;
  }

  if (event.type === "health.sleep_logged" && typeof event.data.duration_hours === "number") {
    return `${event.data.duration_hours} hours of sleep`;
  }

  if (
    ["reflection.energy_logged", "reflection.anxiety_logged", "reflection.focus_logged", "reflection.impulse_logged"].includes(
      event.type
    ) &&
    typeof event.data.value === "number"
  ) {
    const label = event.type.replace("reflection.", "").replace("_logged", "").replace("_", " ");
    return `${label}: ${event.data.value}/10`;
  }

  if (event.type === "reflection.journal_entry_created" && typeof event.data.text === "string") {
    return truncateText(event.data.text, 300);
  }

  if (event.type === "learning.reading_session_completed" && typeof event.data.duration_minutes === "number") {
    return `${event.data.duration_minutes} minutes of reading`;
  }

  if (event.type === "custom.goal_progress_logged") {
    const metric = typeof event.data.metricKey === "string" ? event.data.metricKey : "progress";
    const value = event.data.value !== undefined ? `=${String(event.data.value)}` : "";
    const unit = typeof event.data.unit === "string" ? ` ${event.data.unit}` : "";
    const note = typeof event.data.note === "string" ? ` (${truncateText(event.data.note, 120)})` : "";
    return `${metric}${value}${unit}${note}`;
  }

  if (event.type === "coding.commit_created" || event.type === "coding.repo_activity_detected") {
    const repo = typeof event.data.repo === "string" ? event.data.repo : "repo";
    const sha = typeof event.data.sha === "string" ? event.data.sha.slice(0, 7) : "";
    const message = typeof event.data.message === "string" ? truncateText(event.data.message.split("\n")[0] ?? "", 120) : "";
    return [repo, sha, message].filter(Boolean).join(" ");
  }

  return truncateText(JSON.stringify(event.data), 300);
}

function truncateText(text: string, maxLength: number): string {
  return text.length > maxLength ? `${text.slice(0, Math.max(0, maxLength - 3))}...` : text;
}

function hardGuardianProfile() {
  return {
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
  };
}

function balancedProfile() {
  return {
    directness: 3,
    warmth: 3,
    confrontation: 3,
    profanityAllowed: false,
    motivationalStyle: "strategic",
    accountabilityStrictness: 3,
    escalationStyle: "firm",
    gamblingGuardrails: "strict",
    selfDeceptionSensitivity: 4,
    cooldownPreference: "require_confirmation",
    vulnerableMode: "soften",
    avoidingMode: "challenge",
    impulsiveMode: "guardian_mode"
  };
}

interface ProcessMessageResponse {
  reply: string;
}

interface DailyReviewResponse {
  review: DailyReview;
}

interface DailyOperatorBriefResponse {
  brief: DailyOperatorBrief;
}

interface WeeklyReviewResponse {
  review: unknown;
  message: string;
}

interface WeeklyReviewContextResponse {
  context: unknown;
  message: string;
}

interface NextWeekPlanResponse {
  context: unknown;
  suggestions: unknown[];
  message: string;
}

interface NextWeekPlanContextResponse {
  context: unknown;
  message: string;
}

interface DailyLoopMessageResponse {
  message: string;
}

interface DailyPriorityDebugResponse {
  priorities: DailyOperatorBriefPriorityDebug[];
  message: string;
}

interface DailyCoachDebugResponse {
  coachSource: "llm" | "fallback_disabled" | "fallback_invalid" | "fallback_error" | "fallback_timeout";
  dailyCoachLlmEnabled: string;
  llmEnabled: boolean;
  llmAttempted: boolean;
  validationStatus: "passed" | "failed" | "skipped";
  validationFailureCodes: string[];
  validationFailureSummary?: string;
  selectedNextMove: string;
  selectedActionTitle?: string;
  topPriorities: Array<{
    rank: number;
    actionId: string;
    title: string;
    score: number;
    rankReason: string;
  }>;
  schemaValidationPassed: boolean;
  fallbackReason?: string;
  rawResponseType?: "json_object" | "text" | "empty" | "unknown";
  parsedFieldsPresent?: string[];
  responseLength?: number;
  diagnosisLength?: number;
  nextMoveLength?: number;
  warningLength?: number;
  encouragementLength?: number;
}

interface ConversationControlResponse {
  handled: boolean;
  reply?: string;
  debug: ConversationControlDebug;
}

interface ConversationControlDebug {
  intent: string;
  confidence: number;
  targetText?: string;
  timeText?: string;
  goalText?: string;
  priority?: string;
  resolvedAction?: ConversationControlActionSummary;
  resolvedGoal?: ConversationControlGoalSummary;
  ambiguousActions?: ConversationControlActionSummary[];
  ambiguousGoals?: ConversationControlGoalSummary[];
  requiresConfirmation: boolean;
  blockedByGuardrail: boolean;
  reason: string;
}

interface ConversationControlActionSummary {
  id: string;
  title: string;
  status: string;
}

interface ConversationControlGoalSummary {
  id: string;
  title: string;
  status: string;
}

interface InsightResponse {
  insight: InsightReport;
}

interface GoalsResponse {
  goals: Goal[];
  duplicateWarnings?: GoalDuplicateWarning[];
}

interface GoalPrioritiesResponse {
  goals: GoalPriorityListItem[];
}

interface GoalPriorityListItem {
  number: number;
  id: string;
  title: string;
  category: string;
  templateId?: string;
  priority: string;
  importanceScore?: number;
  priorityReason?: string;
}

interface GoalPriorityUpdateResponse {
  goal: Goal;
  message: string;
}

interface GoalPriorityBackfillResponse {
  updated: number;
  updatedGoals: Array<{
    goal: Goal;
    previousPriority: string;
    nextPriority: string;
  }>;
  skippedManual: Goal[];
  message: string;
}

interface GoalResponse {
  duplicate?: boolean;
  goal?: Goal;
  existingGoal?: Goal;
  message?: string;
}

interface CustomGoalConfigResponse {
  config: {
    category: string;
    targetMetrics: GoalMetric[];
    checkInConfig: GoalCheckInQuestion[];
    suggestedLogExamples: string[];
  };
}

interface GoalProgressResponse {
  reply: string;
}

interface EventsResponse {
  events: Event[];
}

interface EventResponse {
  event: Event;
}

interface EventArchiveResponse {
  count: number;
  events: Event[];
}

interface EventCorrectionResponse {
  original: Event;
  replacement: Event;
}

interface GoalTemplatesResponse {
  goalTemplates: GoalTemplate[];
}

interface IntegrationsResponse {
  integrations: IntegrationDefinition[];
}

interface IntegrationConnectionsResponse {
  connections: IntegrationConnection[];
}

interface GmailOAuthUrlResponse {
  url: string;
}

interface EmailRulesResponse {
  emailRules: EmailSignalRule[];
}

interface EmailRuleResponse {
  emailRule: EmailSignalRule;
  message?: string;
}

interface EmailRuleMutationResponse {
  emailRule: EmailSignalRule;
  message?: string;
}

interface EmailReviewsResponse {
  emailReviews: EmailReviewItem[];
}

interface EmailReviewMutationResponse {
  emailReview: EmailReviewItem;
  event?: Event | null;
  actionItem?: ActionItem | null;
  message?: string;
}

interface ActionsResponse {
  actions: ActionItem[];
}

interface ActionMutationResponse {
  action: ActionItem;
  message?: string;
}

interface ActionReminderTriggerResponse {
  sent: number;
  message: string;
  reminders: Array<{
    actionItem: ActionItem;
    reminderType: "due" | "snoozed";
    message: string;
  }>;
}

interface ManualActionResponse {
  action?: ActionItem;
  duplicate: boolean;
  extraction: {
    shouldCreateAction: boolean;
    confidence: number;
    title?: string;
    description?: string;
    dueAt?: string;
    dueText?: string;
    priority: "low" | "medium" | "high";
    project?: string;
    actionType: "manual" | "reminder" | "follow_up" | "deadline" | "generic";
    needsConfirmation: boolean;
    reason: string;
    evidence: string;
  };
  message: string;
}

interface EmailReviewCleanupResponse {
  count: number;
  emailReviews: EmailReviewItem[];
  message?: string;
}

interface GmailRuleCleanupResponse {
  count: number;
  message?: string;
}

interface IntegrationConnectionResponse {
  connection: IntegrationConnection;
  duplicate?: boolean;
  message?: string;
}

interface IntegrationConnectionMutationResponse {
  connection: IntegrationConnection;
  message?: string;
}

interface IntegrationSyncResponse {
  status: "success" | "error";
  connectionId: string;
  integrationId: string;
  eventsCreated: number;
  personalCommitEvents?: number;
  repoActivityEvents?: number;
  repoSummaries?: IntegrationRepoSyncSummary[];
  emailSummaries?: EmailSyncSummary[];
  emailRuleDiagnostics?: EmailRuleDiagnostics;
  error?: string;
  errorStage?: GmailErrorStage;
}

interface IntegrationRepoSyncSummary {
  repo: string;
  personalCommitEvents: number;
  repoActivityEvents: number;
}

interface EmailSyncSummary {
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
  reviewItemsSemanticDeduped: number;
  reviewItemsRejectedDeduped: number;
  lowConfidenceIgnored: number;
  deduped: number;
  semanticDeduped: number;
  archivedCleanupReprocessed: number;
  skippedDueMaxEventsPerSync: number;
  eventsCreated: number;
  lastError?: string;
  lastErrorStage?: GmailErrorStage;
  reviewCandidateDebug?: EmailReviewCandidateDebug[];
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

interface CheckInResponse {
  reply: string;
}

interface NaturalCheckInResponse {
  reply: string;
}

interface IngestionResponse {
  reply: string;
}

interface RecentDailyCheckInReminderResponse {
  recent: boolean;
}

interface DailyCheckInPromptResponse {
  prompt: string;
}

interface ProfileResponse {
  profile: Profile;
}

interface MemoriesResponse {
  memories: MemoryEntry[];
}

interface MemoryResponse {
  memory: MemoryEntry;
}

interface NotificationSettingsResponse {
  notificationSettings: NotificationSettings;
}

interface PendingActionsResponse {
  pendingActions: PendingAction[];
}

interface PendingActionMutationResponse {
  pendingAction: PendingAction;
  reply: string;
}

interface MultiIntentResponse {
  handled: boolean;
  reply: string;
  plan: IntentPlan;
  debug: IntentPlanDebugItem[];
}

interface IntentPlanResponse {
  handled: boolean;
  plan: IntentPlan;
  debug: IntentPlanDebugItem[];
}

interface IntentPlan {
  isMultiIntent: boolean;
  reason: string;
  intents: IntentPlanItem[];
}

interface IntentPlanItem {
  type: string;
  textSpan: string;
  targetText?: string;
  timeText?: string;
  goalText?: string;
  priority?: string;
  confidence: number;
  requiresConfirmation?: boolean;
  blockedByGuardrail?: boolean;
  reason: string;
}

interface IntentPlanDebugItem extends IntentPlanItem {
  wouldExecute?: boolean;
}

interface DailyReview {
  summary: string;
  wins: string[];
  gaps: string[];
  suggestedFocus: string;
  activeGoals: DailyReviewGoal[];
  checkIn: string[];
  warnings: string[];
  memorySignals: string[];
}

interface DailyReviewGoal {
  title: string;
  status: string;
  templateId?: string;
}

interface DailyOperatorBrief {
  date: string;
  summary: string;
  coach?: DailyCoachResponse;
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

interface OperatorReflectionsResponse {
  reflections: MemoryEntry[];
  message: string;
}

interface OperatorReflectionResponse {
  reflection: MemoryEntry;
  message: string;
}

interface OperatorReflectionContextResponse {
  context: unknown;
  message: string;
}

interface ActionHygieneResponse {
  message: string;
  report: unknown;
}

interface DailyCoachResponse {
  diagnosis: string;
  nextMove: string;
  warning: string | null;
  encouragement: string | null;
}

interface DailyOperatorBriefAction {
  id: string;
  title: string;
  status: string;
  priority: string;
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

interface InsightReport {
  userId: string;
  periodType: "daily" | "weekly";
  periodStart: string;
  periodEnd: string;
  headline: string;
  summary: string;
  wins: string[];
  gaps: string[];
  risks: string[];
  patterns: string[];
  goalProgress: InsightGoalProgress[];
  memorySignals: string[];
  recommendedActions: string[];
  hardTruth?: string;
  generatedAt: string;
}

interface InsightGoalProgress {
  goalId: string;
  title: string;
  status: "progress" | "no_progress" | "risk" | "stable" | "custom";
  note: string;
}

interface Goal {
  id: string;
  title: string;
  category: string;
  status: string;
  priority?: string;
  importanceScore?: number;
  priorityReason?: string;
  why?: string;
  templateId?: string;
  targetMetrics?: GoalMetric[];
  checkInConfig?: GoalCheckInQuestion[];
}

interface GoalMetric {
  key: string;
  label: string;
  eventType?: string;
  aggregation: string;
  window: string;
  unit?: string;
}

interface GoalCheckInQuestion {
  key: string;
  question: string;
  answerType: string;
}

interface CustomGoalProgressInput {
  metricKey?: string;
  value?: string | number | boolean;
  unit?: string;
  note?: string;
}

interface GoalDuplicateWarning {
  goalId: string;
  similarGoalId: string;
  similarGoalTitle: string;
}

interface GoalTemplate {
  id: string;
  title: string;
  category: string;
}

interface IntegrationDefinition {
  id: string;
  name: string;
  description: string;
  status: "available" | "planned";
  authType: "none" | "api_key" | "oauth" | "manual";
  producesEventTypes: string[];
}

interface IntegrationConnection {
  id: string;
  userId: string;
  integrationId: string;
  status: "active" | "paused" | "error" | "archived";
  config: Record<string, unknown>;
  lastSyncedAt?: string;
  lastError?: string;
}

interface EmailSignalRule {
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
  lastSyncedAt?: string;
  lastError?: string;
}

interface EmailReviewItem {
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
  reviewedAt?: string;
  createdAt: string;
  updatedAt: string;
}

interface ActionItem {
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
  dueAt?: string;
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
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  snoozedUntil?: string;
}

interface Event {
  id: string;
  type: string;
  timestamp: string;
  data: Record<string, unknown>;
  evidence?: string[];
  status?: string;
  eventGroupId?: string;
  archiveReason?: string;
  correctedByEventId?: string;
}

interface Profile {
  directness: number;
  warmth: number;
  confrontation: number;
  motivationalStyle: string;
  gamblingGuardrails: string;
  cooldownPreference: string;
  vulnerableMode: string;
  avoidingMode: string;
  impulsiveMode: string;
}

interface MemoryEntry {
  id: string;
  type:
    | "preference"
    | "goal_context"
    | "pattern"
    | "risk_pattern"
    | "communication_style"
    | "important_fact"
    | "note";
  summary: string;
  source: string;
  confidence: number;
}

interface NotificationSettings {
  telegramUserId?: string;
  dailyCheckinEnabled: boolean;
  dailyCheckinTime?: string;
  dailyInsightEnabled: boolean;
  dailyInsightTime?: string;
  weeklyInsightEnabled: boolean;
  weeklyInsightDay?: string;
  weeklyInsightTime?: string;
  dailyLoopEnabled: boolean;
  timezone: string;
  defaultActionTimeMinutes: number;
  morningTimeMinutes: number;
  afternoonTimeMinutes: number;
  eveningTimeMinutes: number;
  tonightTimeMinutes: number;
}

interface ReminderTimePatch {
  defaultActionTimeMinutes?: number;
  morningTimeMinutes?: number;
  afternoonTimeMinutes?: number;
  eveningTimeMinutes?: number;
  tonightTimeMinutes?: number;
}

interface OnboardingResponse {
  message: string;
  state?: Record<string, unknown>;
}

interface PendingAction {
  id: string;
  type: string;
  summary: string;
  status: string;
  payload?: Record<string, unknown>;
  expiresAt?: string;
}
