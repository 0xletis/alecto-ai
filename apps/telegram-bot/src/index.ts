import { config } from "dotenv";
import { Bot, type Context } from "grammy";

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

  await ctx.reply(
    "I am your private operator agent. Tell me what you did, what you're thinking, or what you're about to do, and I'll help you track it or think clearly."
  );
});

bot.command("setup", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  await ctx.reply(
    [
      "Setup checklist:",
      "1. Run /whoami if owner needs your ID",
      "2. Run /set_style hard_guardian or /set_style balanced",
      "3. Create a goal with /create_goal category | title | why",
      "4. Send normal messages like \"today I sent 2 CVs and trained 45 minutes\"",
      "5. Use /review to check the day"
    ].join("\n")
  );
});

bot.command("profile", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  try {
    const response = await apiGet<ProfileResponse>(`/users/${getTelegramUserId(ctx)}/profile`);
    await ctx.reply(formatProfile(response.profile));
  } catch (error) {
    await replyWithApiError(ctx, error, "I could not fetch your profile right now.");
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
    await replyWithApiError(ctx, error, "I could not fetch your memories right now.");
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
    await ctx.reply("Saved to memory.");
  } catch (error) {
    await replyWithApiError(ctx, error, "I could not save that memory right now.");
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
    await replyWithApiError(ctx, error, "I could not archive that memory. Check the ID and try again.");
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
    await replyWithApiError(ctx, error, "I could not fetch notification settings right now.");
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
    await replyWithApiError(ctx, error, "I could not enable daily check-ins right now.");
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
    await replyWithApiError(ctx, error, "I could not disable daily check-ins right now.");
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
    await replyWithApiError(ctx, error, "I could not enable daily insight right now.");
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
    await replyWithApiError(ctx, error, "I could not disable daily insight right now.");
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
    await replyWithApiError(ctx, error, "I could not enable weekly insight right now.");
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
    await replyWithApiError(ctx, error, "I could not disable weekly insight right now.");
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
    await replyWithApiError(ctx, error, "I could not build your check-in prompt right now.");
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
    await replyWithApiError(ctx, error, "I could not update your style right now.");
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
    await replyWithApiError(ctx, error, "I could not create that goal right now.");
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
    await replyWithApiError(ctx, error, "I could not fetch goal templates right now.");
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
    await replyWithApiError(ctx, error, "I could not create that template goal right now.");
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
    await replyWithApiError(ctx, error, "I could not archive that goal. Check the goal ID and try again.");
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
    await replyWithApiError(ctx, error, "I could not fetch your daily review right now.");
  }
});

bot.command("insight", async (ctx) => {
  await sendInsight(ctx, "daily");
});

bot.command("daily_insight", async (ctx) => {
  await sendInsight(ctx, "daily");
});

bot.command("weekly", async (ctx) => {
  await sendInsight(ctx, "weekly");
});

bot.command("weekly_insight", async (ctx) => {
  await sendInsight(ctx, "weekly");
});

bot.command("goals", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  try {
    const response = await apiGet<GoalsResponse>(`/users/${getTelegramUserId(ctx)}/goals`);
    await ctx.reply(formatGoals(response.goals, response.duplicateWarnings ?? []));
  } catch (error) {
    await replyWithApiError(ctx, error, "I could not fetch your goals right now.");
  }
});

bot.command("events", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  try {
    const response = await apiGet<EventsResponse>(`/users/${getTelegramUserId(ctx)}/events/recent`);
    await ctx.reply(formatEvents(response.events));
  } catch (error) {
    await replyWithApiError(ctx, error, "I could not fetch your recent events right now.");
  }
});

bot.command("events_archived", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  try {
    const response = await apiGet<EventsResponse>(`/users/${getTelegramUserId(ctx)}/events/recent?includeArchived=true`);
    await ctx.reply(formatEvents(response.events.slice(0, 10), { alwaysShowStatus: true }));
  } catch (error) {
    await replyWithApiError(ctx, error, "I could not fetch archived events right now.");
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
    await replyWithApiError(ctx, error, "I could not undo the last event right now.");
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
      await replyWithApiError(ctx, error, "I could not archive that event. Check the ID and try again.");
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
    await replyWithApiError(ctx, error, "I could not correct that event. Check the ID and data format.");
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
    await replyWithApiError(ctx, error, "I could not save that check-in right now.");
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
    await replyWithApiError(ctx, error, "I could not fetch pending actions right now.");
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
    await replyWithApiError(ctx, error, "I could not confirm that pending action right now.");
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
    await replyWithApiError(ctx, error, "I could not cancel that pending action right now.");
  }
});

bot.on("message:text", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  try {
    if (ctx.message.text.startsWith("/")) {
      return;
    }

    if (await shouldTreatAsNaturalCheckIn(ctx)) {
      const response = await apiPost<NaturalCheckInResponse>(`/users/${getTelegramUserId(ctx)}/checkins/daily/text`, {
        text: ctx.message.text
      });

      await ctx.reply(response.reply);
      return;
    }

    const response = await apiPost<ProcessMessageResponse>("/messages/process", {
      userId: getTelegramUserId(ctx),
      message: ctx.message.text
    });

    await ctx.reply(response.reply);
  } catch (error) {
    await replyWithApiError(ctx, error, "I could not process that message right now.");
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

function parseWeeklyInsightCommand(text: string): { day: string; time: string } | undefined {
  const [day, time] = text.toLowerCase().split(/\s+/).filter(Boolean);
  const validDays = new Set(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]);

  if (!validDays.has(day) || !/^\d{2}:\d{2}$/.test(time ?? "")) {
    return undefined;
  }

  return { day, time };
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

async function shouldTreatAsNaturalCheckIn(ctx: Context): Promise<boolean> {
  const message = ctx.message?.text ?? "";
  const signalCounts = countNaturalCheckInSignals(message);

  if (isExplicitMemoryRequest(message) || isDirectBettingTradingIntent(message)) {
    return false;
  }

  if (signalCounts.state >= 1 || signalCounts.progress >= 2) {
    return true;
  }

  if (signalCounts.state + signalCounts.progress + signalCounts.reminderOnlyImpulse < 1) {
    return false;
  }

  try {
    const response = await apiGet<RecentDailyCheckInReminderResponse>(
      `/users/${getTelegramUserId(ctx)}/notification-logs/recent-daily-checkin`
    );
    return response.recent;
  } catch (error) {
    console.error("Could not check recent daily check-in reminder", error);
    return false;
  }
}

function isExplicitMemoryRequest(message: string): boolean {
  return /\b(remember that|remember this|note that|recuerda que|acu[eé]rdate de que|guard[ae] que)\b/i.test(message);
}

function isDirectBettingTradingIntent(message: string): boolean {
  return /\b(quiero apostar|voy a apostar|i want to bet|i'?m going to bet|quiero tradear|voy a tradear|i want to trade|long|short|leverage)\b/i.test(
    message
  );
}

function countNaturalCheckInSignals(message: string): { state: number; progress: number; reminderOnlyImpulse: number } {
  const normalized = normalizeSignalText(message);
  const statePatterns = [
    /\benergy\b|\benergia\b/,
    /\banxiety\b|\bansiedad\b/,
    /\bfocus\b|\bfoco\b/,
    /\bslept\b|\bsleep\b|\bdormi\b|\bdormir\b/
  ];
  const progressPatterns = [
    /\b(?:sent|mande|mandado|envie|enviado)\s+\d*\s*(?:cvs?|applications?)\b|\b\d+\s*(?:cvs?|applications?)\b/,
    /\btrained\b|\bentrene\b|\bentrenado\b|\bgym\b|\bworkout\b/,
    /\bread\b|\blei\b|\breading\b/
  ];
  const reminderOnlyImpulsePatterns = [
    /\bganas de apostar\s*\d+(?:\.\d+)?\b/,
    /\b(?:gambling impulse|trading impulse)\s*(?:is|=|:)?\s*\d+(?:\.\d+)?\b/,
    /\bno (?:gambling impulse|trading impulse|bets?)\b/
  ];

  return {
    state: statePatterns.filter((pattern) => pattern.test(normalized)).length,
    progress: progressPatterns.filter((pattern) => pattern.test(normalized)).length,
    reminderOnlyImpulse: reminderOnlyImpulsePatterns.filter((pattern) => pattern.test(normalized)).length
  };
}

function normalizeSignalText(message: string): string {
  return message
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
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
    await replyWithApiError(
      ctx,
      error,
      periodType === "daily"
        ? "I could not fetch your daily insight right now."
        : "I could not fetch your weekly insight right now."
    );
  }
}

async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`);

  if (!response.ok) {
    throw await ApiError.fromResponse(response, `API GET ${path} failed with ${response.status}`);
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
    throw await ApiError.fromResponse(response, `API POST ${path} failed with ${response.status}`);
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
    throw await ApiError.fromResponse(response, `API PATCH ${path} failed with ${response.status}`);
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
  const parsedError = parseApiErrorText(responseText);

  return {
    ok: false,
    error: parsedError ?? (responseText.trim() || fallback)
  };
}

function parseApiErrorText(responseText: string): string | undefined {
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

async function replyWithApiError(ctx: Context, error: unknown, fallbackMessage: string) {
  console.error("Telegram API call failed", error);

  if (isFetchError(error)) {
    await ctx.reply("I cannot reach the agent API right now. Make sure the API server is running.");
    return;
  }

  await ctx.reply(fallbackMessage);
}

function isFetchError(error: unknown) {
  return error instanceof TypeError;
}

class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }

  static async fromResponse(response: Response, fallbackMessage: string): Promise<ApiError> {
    try {
      const body = (await response.json()) as { error?: unknown };
      return new ApiError(typeof body.error === "string" ? body.error : fallbackMessage, response.status);
    } catch {
      return new ApiError(fallbackMessage, response.status);
    }
  }
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
    `timezone: ${settings.timezone}`,
    `telegramUserId: ${settings.telegramUserId ?? "not set"}`
  ].join("\n");
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
    goal.why ? `why: ${goal.why}` : undefined,
    warning ? `Possible duplicate: this goal looks similar to ${warning.similarGoalTitle}.` : undefined
  ]
    .filter(Boolean)
    .join("\n");
}

function formatEvents(events: Event[], options: { alwaysShowStatus?: boolean } = {}) {
  if (events.length === 0) {
    return "No recent events yet.";
  }

  return events.map((event) => formatEvent(event, options)).join("\n\n");
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
  return [
    `id: ${pendingAction.id}`,
    `type: ${pendingAction.type}`,
    `summary: ${pendingAction.summary}`,
    `status: ${pendingAction.status}`
  ].join("\n");
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
    `data: ${formatEventData(event)}`,
    correctionHint(event),
    event.evidence && event.evidence.length > 0 ? `evidence: ${event.evidence.slice(0, 2).join("; ")}` : undefined
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
    return event.data.text;
  }

  if (event.type === "learning.reading_session_completed" && typeof event.data.duration_minutes === "number") {
    return `${event.data.duration_minutes} minutes of reading`;
  }

  return JSON.stringify(event.data);
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

interface InsightResponse {
  insight: InsightReport;
}

interface GoalsResponse {
  goals: Goal[];
  duplicateWarnings?: GoalDuplicateWarning[];
}

interface GoalResponse {
  duplicate?: boolean;
  goal?: Goal;
  existingGoal?: Goal;
  message?: string;
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

interface CheckInResponse {
  reply: string;
}

interface NaturalCheckInResponse {
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
  why?: string;
  templateId?: string;
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
  timezone: string;
}

interface PendingAction {
  id: string;
  type: string;
  summary: string;
  status: string;
}
