import { config } from "dotenv";
import {
  createNotificationLog,
  getActiveGoals,
  getActiveIntegrationConnectionsForSync,
  getOrCreateNotificationSettings,
  getOrCreateUserOperatingProfile,
  getRecentEvents,
  getUsersWithEnabledNotifications,
  hasNotificationLog
} from "@operator-agent/db";
import { buildDailyCheckinPrompt } from "@operator-agent/core";

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

await runTick();
setInterval(() => {
  runTick().catch((error) => {
    console.error("Worker tick failed", error);
  });
}, tickMs);

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

  if (integrationSyncEnabled) {
    await runIntegrationSync(now);
  }
}

async function runIntegrationSync(now: Date) {
  const intervalMs = Math.max(1, integrationSyncIntervalMinutes) * 60_000;
  const connections = await getActiveIntegrationConnectionsForSync();
  const notificationsByUser = new Map<string, string[]>();

  for (const connection of connections) {
    if (connection.lastSyncedAt && now.getTime() - connection.lastSyncedAt.getTime() < intervalMs) {
      continue;
    }

    try {
      const response = await apiPost<IntegrationSyncResponse>(
        `/users/${connection.userId}/integrations/${connection.id}/sync`,
        {}
      );
      const messages = formatIntegrationSyncNotifications(response);

      if (messages.length > 0) {
        notificationsByUser.set(connection.userId, [
          ...(notificationsByUser.get(connection.userId) ?? []),
          ...messages
        ]);
      }
    } catch (error) {
      console.error(`Integration sync failed for ${connection.id}`, error);

      if (!connection.lastError) {
        const reason = safeErrorMessage(error);
        notificationsByUser.set(connection.userId, [
          ...(notificationsByUser.get(connection.userId) ?? []),
          reason.startsWith("GitHub sync failed") ? reason : `GitHub sync failed: ${reason}`
        ]);
      }
    }
  }

  for (const [userId, messages] of notificationsByUser) {
    const settings = await getOrCreateNotificationSettings(userId);

    if (!settings.telegramUserId || messages.length === 0) {
      continue;
    }

    await sendTelegramMessage(settings.telegramUserId, messages.slice(0, 5).join("\n"));
  }
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

function safeErrorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }

  return "Integration sync failed.";
}

function formatIntegrationSyncNotifications(response: IntegrationSyncResponse): string[] {
  if (response.eventsCreated <= 0) {
    return [];
  }

  const summaries = response.repoSummaries ?? [];

  if (summaries.length === 0) {
    return [`GitHub: ${response.eventsCreated} new event${response.eventsCreated === 1 ? "" : "s"} detected.`];
  }

  return summaries.flatMap((summary) => {
    const messages: string[] = [];

    if (summary.personalCommitEvents > 0) {
      messages.push(
        `GitHub: ${summary.personalCommitEvents} personal commit${summary.personalCommitEvents === 1 ? "" : "s"} detected in ${summary.repo}.`
      );
    }

    if (summary.repoActivityEvents > 0) {
      messages.push(
        `GitHub: ${summary.repoActivityEvents} repo activity signal${summary.repoActivityEvents === 1 ? "" : "s"} detected in ${summary.repo}.`
      );
    }

    return messages;
  });
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

function formatLocalTime(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);

  return `${getPart(parts, "hour")}:${getPart(parts, "minute")}`;
}

function formatLocalDate(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);

  return `${getPart(parts, "year")}-${getPart(parts, "month")}-${getPart(parts, "day")}`;
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

function getPart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((part) => part.type === type)?.value ?? "";
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
  timezone: string;
}

interface InsightResponse {
  insight: InsightReport;
}

interface IntegrationSyncResponse {
  status: "success";
  connectionId: string;
  integrationId: string;
  eventsCreated: number;
  personalCommitEvents?: number;
  repoActivityEvents?: number;
  repoSummaries?: IntegrationRepoSyncSummary[];
}

interface IntegrationRepoSyncSummary {
  repo: string;
  personalCommitEvents: number;
  repoActivityEvents: number;
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
