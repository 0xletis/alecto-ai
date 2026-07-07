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

bot.command("start", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  await ctx.reply(
    "I am your private operator agent. Tell me what you did, what you're thinking, or what you're about to do, and I'll help you track it or think clearly."
  );
});

bot.command("review", async (ctx) => {
  if (!(await guardAllowedUser(ctx))) {
    return;
  }

  try {
    const review = await apiGet<DailyReviewResponse>(`/users/${getTelegramUserId(ctx)}/review/daily`);
    await ctx.reply(formatDailyReview(review.review));
  } catch (error) {
    console.error("Telegram /review failed", error);
    await ctx.reply("I could not fetch your daily review right now.");
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
    console.error("Telegram /goals failed", error);
    await ctx.reply("I could not fetch your goals right now.");
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
    console.error("Telegram /events failed", error);
    await ctx.reply("I could not fetch your recent events right now.");
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
    console.error("Telegram message processing failed", error);
    await ctx.reply("I could not process that message right now.");
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

async function guardAllowedUser(ctx: Context): Promise<boolean> {
  const telegramUserId = ctx.from?.id;

  if (!telegramUserId) {
    await ctx.reply("This private agent is not available for this account.");
    return false;
  }

  if (allowedUserIds && !allowedUserIds.has(String(telegramUserId))) {
    await ctx.reply("This private agent is not available for this account.");
    return false;
  }

  return true;
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
    .filter(Boolean);

  return ids && ids.length > 0 ? new Set(ids) : undefined;
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

function formatDailyReview(review: DailyReview) {
  return [
    review.summary,
    "",
    `Wins: ${review.wins.length > 0 ? review.wins.join(", ") : "none logged"}`,
    `Gaps: ${review.gaps.length > 0 ? review.gaps.join(", ") : "none obvious"}`,
    `Focus: ${review.suggestedFocus}`
  ].join("\n");
}

function formatGoals(goals: Goal[]) {
  if (goals.length === 0) {
    return "No active goals yet.";
  }

  return goals.map((goal) => `- ${goal.title} (${goal.category})`).join("\n");
}

function formatEvents(events: Event[]) {
  if (events.length === 0) {
    return "No recent events yet.";
  }

  return events.map(formatEvent).join("\n");
}

function formatEvent(event: Event) {
  if (event.type === "career.application_sent" && typeof event.data.count === "number") {
    return `- ${event.data.count} application${event.data.count === 1 ? "" : "s"} sent`;
  }

  if (event.type === "health.workout_completed" && typeof event.data.duration_minutes === "number") {
    return `- ${event.data.duration_minutes} minutes of training`;
  }

  if (event.type === "health.sleep_logged" && typeof event.data.duration_hours === "number") {
    return `- ${event.data.duration_hours} hours of sleep`;
  }

  if (event.type === "learning.reading_session_completed" && typeof event.data.duration_minutes === "number") {
    return `- ${event.data.duration_minutes} minutes of reading`;
  }

  return `- ${event.type}`;
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

interface EventsResponse {
  events: Event[];
}

interface DailyReview {
  summary: string;
  wins: string[];
  gaps: string[];
  suggestedFocus: string;
}

interface Goal {
  title: string;
  category: string;
  status: string;
}

interface Event {
  type: string;
  data: Record<string, unknown>;
}
