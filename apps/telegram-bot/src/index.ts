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
    await ctx.reply(`Goal created:\n${formatGoal(response.goal)}`);
  } catch (error) {
    await replyWithApiError(ctx, error, "I could not create that goal right now.");
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

bot.command("goals", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  try {
    const response = await apiGet<GoalsResponse>(`/users/${getTelegramUserId(ctx)}/goals`);
    const activeGoals = response.goals.filter((goal) => goal.status === "active");
    await ctx.reply(formatGoals(activeGoals));
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

bot.on("message:text", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  try {
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
  const telegramUserId = ctx.from?.id;

  if (!telegramUserId) {
    throw new Error("Telegram user id is missing.");
  }

  return `telegram:${telegramUserId}`;
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

async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`);

  if (!response.ok) {
    throw new Error(`API GET ${path} failed with ${response.status}`);
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
    throw new Error(`API POST ${path} failed with ${response.status}`);
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
    throw new Error(`API PATCH ${path} failed with ${response.status}`);
  }

  return (await response.json()) as T;
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

function formatDailyReview(review: DailyReview) {
  return [
    review.summary,
    "",
    `Wins: ${review.wins.length > 0 ? review.wins.join(", ") : "none logged"}`,
    `Gaps: ${review.gaps.length > 0 ? review.gaps.join(", ") : "none obvious"}`,
    `Focus: ${review.suggestedFocus}`
  ].join("\n");
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

function formatGoals(goals: Goal[]) {
  if (goals.length === 0) {
    return "No active goals yet. Create one with /create_goal category | title | why";
  }

  return goals.map(formatGoal).join("\n\n");
}

function formatGoal(goal: Goal) {
  return [
    `id: ${goal.id}`,
    `title: ${goal.title}`,
    `category: ${goal.category}`,
    `status: ${goal.status}`,
    goal.why ? `why: ${goal.why}` : undefined
  ]
    .filter(Boolean)
    .join("\n");
}

function formatEvents(events: Event[]) {
  if (events.length === 0) {
    return "No recent events yet.";
  }

  return events.map(formatEvent).join("\n\n");
}

function formatEvent(event: Event) {
  return [
    `type: ${event.type}`,
    `time: ${new Date(event.timestamp).toLocaleString()}`,
    `data: ${formatEventData(event)}`,
    event.evidence && event.evidence.length > 0 ? `evidence: ${event.evidence.slice(0, 2).join("; ")}` : undefined
  ]
    .filter(Boolean)
    .join("\n");
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

interface GoalsResponse {
  goals: Goal[];
}

interface GoalResponse {
  goal: Goal;
}

interface EventsResponse {
  events: Event[];
}

interface ProfileResponse {
  profile: Profile;
}

interface DailyReview {
  summary: string;
  wins: string[];
  gaps: string[];
  suggestedFocus: string;
}

interface Goal {
  id: string;
  title: string;
  category: string;
  status: string;
  why?: string;
}

interface Event {
  type: string;
  timestamp: string;
  data: Record<string, unknown>;
  evidence?: string[];
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
