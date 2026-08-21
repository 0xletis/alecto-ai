import { config } from "dotenv";
import {
  createNotificationLog,
  getActiveGoals,
  getOrCreateNotificationSettings,
  getOrCreateUserOperatingProfile,
  getRecentEvents,
  getUsersWithEnabledNotifications,
  hasNotificationLog
} from "@operator-agent/db";
import { buildDailyCheckinPrompt, proactiveOperatorAllowlistActiveFromEnv, proactiveOperatorDeliveryEnabledFromEnv } from "@operator-agent/core";
import { sendDueActionReminders as sendDueActionRemindersImpl } from "./action-reminders.js";
import { formatLocalDate, formatLocalTime, formatMinutesOfDay, getPart } from "./datetime.js";
import { runScheduledIntegrationSync } from "./integration-sync.js";
import { runV3ProactiveGmailNudges, runV3ProactiveMorningBriefs } from "./v3-proactive-delivery.js";
import { runLegacyDailyLoopMorningBriefs } from "./legacy-daily-loop-morning.js";

config({
  path: new URL("../../../.env", import.meta.url).pathname
});

const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
const apiBaseUrl = process.env.API_BASE_URL ?? "http://localhost:3000";
const tickMs = 60_000;
const integrationSyncEnabled = process.env.INTEGRATION_SYNC_ENABLED === "true";
const integrationSyncIntervalMinutes = Number(process.env.INTEGRATION_SYNC_INTERVAL_MINUTES ?? "15");

if (!telegramBotToken) {
  throw new Error("TELEGRAM_BOT_TOKEN is required.");
}

console.log(`Worker started. API base URL: ${apiBaseUrl}`);
logEffectiveProactiveDeliveryConfig();

await runTick();
setInterval(() => {
  runTick().catch((error) => {
    console.error("Worker tick failed", error);
  });
}, tickMs);

/** Logged once at startup so it's immediately visible whether the two developer rollout controls
 * are actually live in THIS process — .env is only read at startup, so a stale env value here is
 * the single most common source of "why isn't V3 sending" confusion. See
 * docs/10-v3-readiness-audit.md §19. */
function logEffectiveProactiveDeliveryConfig(): void {
  const deliveryEnabled = proactiveOperatorDeliveryEnabledFromEnv();
  const allowlistActive = proactiveOperatorAllowlistActiveFromEnv();
  const allowlistSummary = allowlistActive
    ? `active (${process.env.PROACTIVE_OPERATOR_ALLOWLIST})`
    : "inactive — no allowlist configured, every opted-in user is eligible";

  console.log(`V3 proactive delivery config: PROACTIVE_OPERATOR_DELIVERY_ENABLED=${deliveryEnabled}, PROACTIVE_OPERATOR_ALLOWLIST=${allowlistSummary}`);
}

async function runTick() {
  const settings = await getUsersWithEnabledNotifications();
  const now = new Date();

  for (const item of settings) {
    if (!item.telegramUserId) {
      continue;
    }

    const localTime = formatLocalTime(now, item.timezone);

    if (item.dailyCheckinEnabled && item.dailyCheckinTime === localTime) {
      await maybeSendDailyCheckin(item, now);
    }

    if (item.dailyInsightEnabled && item.dailyInsightTime === localTime) {
      await maybeSendDailyInsight(item, now);
    }

    if (
      item.weeklyInsightEnabled &&
      item.weeklyInsightTime === localTime &&
      item.weeklyInsightDay === formatLocalWeekday(now, item.timezone)
    ) {
      await maybeSendWeeklyInsight(item, now);
    }

  }

  // Legacy daily-loop morning message and V3's proactive morning brief are mutually exclusive
  // per user — see apps/worker/src/legacy-daily-loop-morning.ts's doc comment. Order between
  // these two calls does not matter: the legacy call skips based on configuration
  // (morningBriefEnabled + V3 delivery actually live for that user), not on whether V3 actually
  // sends this tick.
  await runLegacyDailyLoopMorningBriefs(settings, { apiGet, sendTelegramMessage });
  await runDailyEveningReviews(now, settings);

  // V3 proactive delivery remains opt-in and env-gated. morning_brief is time-triggered; Gmail
  // nudges only surface already-created EmailReviewItems and never scan Gmail by themselves.
  await runV3ProactiveMorningBriefs(settings, { apiGet, sendTelegramMessage });

  if (integrationSyncEnabled) {
    await runIntegrationSync(now);
  }

  await runV3ProactiveGmailNudges(settings, { now, apiGet, sendTelegramMessage });

  await sendDueActionReminders(now);
}

// Delegates to action-reminders.ts (see that file's own doc comment for why it lives separately
// from index.ts and how the bundled/numbered notification UX works) — kept as a thin wrapper here
// so the rest of index.ts's tick loop is unaffected.
async function sendDueActionReminders(now: Date) {
  await sendDueActionRemindersImpl(now, { sendTelegramMessage });
}

export async function runDailyEveningReviews(now = new Date(), settings?: NotificationSettings[]) {
  const notificationSettings = settings ?? (await getUsersWithEnabledNotifications());

  for (const item of notificationSettings) {
    if (!item.telegramUserId || !item.dailyLoopEnabled) {
      continue;
    }

    if (formatMinutesOfDay(item.eveningTimeMinutes) === formatLocalTime(now, item.timezone)) {
      await maybeSendDailyLoopEnd(item, now);
    }
  }
}

async function runIntegrationSync(now: Date) {
  await runScheduledIntegrationSync({
    now,
    integrationSyncEnabled,
    integrationSyncIntervalMinutes,
    apiGet,
    apiPost,
    sendTelegramMessage
  });
}

async function maybeSendDailyCheckin(item: NotificationSettings, now: Date) {
  if (!item.telegramUserId) {
    return;
  }

  const sentForDate = formatLocalDate(now, item.timezone);
  const logInput = {
    userId: item.userId,
    type: "daily_checkin",
    sentForDate
  };

  if (await hasNotificationLog(logInput)) {
    return;
  }

  const prompt = buildDailyCheckinPrompt({
    activeGoals: await getActiveGoals(item.userId),
    userOperatingProfile: await getOrCreateUserOperatingProfile(item.userId),
    recentEvents: await getRecentEvents(item.userId, 20)
  });

  await sendTelegramMessage(item.telegramUserId, prompt);
  const logged = await createNotificationLog(logInput);

  if (logged) {
    console.log(`Sent daily check-in to ${item.userId} for ${sentForDate}.`);
  }
}

async function maybeSendDailyInsight(item: NotificationSettings, now: Date) {
  if (!item.telegramUserId) {
    return;
  }

  const sentForDate = formatLocalDate(now, item.timezone);
  const logInput = {
    userId: item.userId,
    type: "daily_insight",
    sentForDate
  };

  if (await hasNotificationLog(logInput)) {
    return;
  }

  const response = await apiGet<InsightResponse>(`/users/${item.userId}/insights/daily`);
  await sendTelegramMessage(item.telegramUserId, formatInsight(response.insight));
  const logged = await createNotificationLog(logInput);

  if (logged) {
    console.log(`Sent daily insight to ${item.userId} for ${sentForDate}.`);
  }
}

async function maybeSendWeeklyInsight(item: NotificationSettings, now: Date) {
  if (!item.telegramUserId) {
    return;
  }

  const sentForDate = formatLocalWeekStart(now, item.timezone);
  const logInput = {
    userId: item.userId,
    type: "weekly_insight",
    sentForDate
  };

  if (await hasNotificationLog(logInput)) {
    return;
  }

  const response = await apiGet<InsightResponse>(`/users/${item.userId}/insights/weekly`);
  await sendTelegramMessage(item.telegramUserId, formatInsight(response.insight));
  const logged = await createNotificationLog(logInput);

  if (logged) {
    console.log(`Sent weekly insight to ${item.userId} for week ${sentForDate}.`);
  }
}

async function maybeSendDailyLoopEnd(item: NotificationSettings, now: Date) {
  if (!item.telegramUserId) {
    return;
  }

  const sentForDate = formatLocalDate(now, item.timezone);
  const logInput = {
    userId: item.userId,
    type: "daily_loop_evening",
    sentForDate
  };

  if (await hasNotificationLog(logInput)) {
    return;
  }

  const response = await apiGet<DailyLoopMessageResponse>(
    `/users/${item.userId}/daily-loop/end-day?markSent=true&now=${encodeURIComponent(now.toISOString())}`
  );
  await sendTelegramMessage(item.telegramUserId, response.message);
  const logged = await createNotificationLog(logInput);

  if (logged) {
    console.log(`Sent daily loop evening review to ${item.userId} for ${sentForDate}.`);
  }
}

async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`);

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`API GET ${path} failed with ${response.status}: ${body}`);
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
    const text = await response.text();
    throw new Error(parseApiError(text) ?? `API POST ${path} failed with ${response.status}`);
  }

  return (await response.json()) as T;
}

function parseApiError(text: string): string | undefined {
  if (!text.trim()) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(text) as { error?: unknown };
    return typeof parsed.error === "string" && parsed.error.trim() ? parsed.error : undefined;
  } catch {
    return text.trim();
  }
}

async function sendTelegramMessage(chatId: string, text: string) {
  const response = await fetch(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      chat_id: chatId,
      text
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Telegram sendMessage failed with ${response.status}: ${body}`);
  }
}

function formatLocalWeekday(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long"
  }).format(date).toLowerCase();
}

function formatLocalWeekStart(date: Date, timezone: string): string {
  const localDate = parseLocalDateParts(date, timezone);
  const dayIndex = localDate.getUTCDay();
  const daysSinceMonday = dayIndex === 0 ? 6 : dayIndex - 1;
  localDate.setUTCDate(localDate.getUTCDate() - daysSinceMonday);
  return localDate.toISOString().slice(0, 10);
}

function parseLocalDateParts(date: Date, timezone: string): Date {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  return new Date(`${getPart(parts, "year")}-${getPart(parts, "month")}-${getPart(parts, "day")}T00:00:00Z`);
}

function formatInsight(insight: InsightReport) {
  return [
    insight.headline,
    insight.summary,
    "",
    formatSection("Wins", insight.wins),
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

interface NotificationSettings {
  userId: string;
  telegramUserId?: string;
  dailyCheckinEnabled: boolean;
  dailyCheckinTime?: string;
  dailyInsightEnabled: boolean;
  dailyInsightTime?: string;
  weeklyInsightEnabled: boolean;
  weeklyInsightDay?: string;
  weeklyInsightTime?: string;
  dailyLoopEnabled: boolean;
  morningBriefEnabled: boolean;
  gmailNudgeEnabled: boolean;
  timezone: string;
  morningTimeMinutes: number;
  eveningTimeMinutes: number;
}

interface InsightResponse {
  insight: InsightReport;
}

interface DailyLoopMessageResponse {
  message: string;
}

interface InsightReport {
  headline: string;
  summary: string;
  wins: string[];
  risks: string[];
  patterns: string[];
  goalProgress: Array<{
    title: string;
    note: string;
  }>;
  memorySignals: string[];
  recommendedActions: string[];
  hardTruth?: string;
}
