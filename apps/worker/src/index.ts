import { config } from "dotenv";
import {
  createNotificationLog,
  getUsersWithDailyCheckinEnabled,
  hasNotificationLog
} from "@operator-agent/db";
import { dailyCheckinReminderText } from "@operator-agent/core";

config({
  path: new URL("../../../.env", import.meta.url).pathname
});

const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
const apiBaseUrl = process.env.API_BASE_URL ?? "http://localhost:3000";
const tickMs = 60_000;
const notificationType = "daily_checkin";

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
  const settings = await getUsersWithDailyCheckinEnabled();

  for (const item of settings) {
    if (!item.telegramUserId || !item.dailyCheckinTime) {
      continue;
    }

    const now = new Date();
    const localTime = formatLocalTime(now, item.timezone);

    if (localTime !== item.dailyCheckinTime) {
      continue;
    }

    const sentForDate = formatLocalDate(now, item.timezone);
    const logInput = {
      userId: item.userId,
      type: notificationType,
      sentForDate
    };

    if (await hasNotificationLog(logInput)) {
      continue;
    }

    await sendTelegramMessage(item.telegramUserId, dailyCheckinReminderText);
    const logged = await createNotificationLog(logInput);

    if (logged) {
      console.log(`Sent daily check-in to ${item.userId} for ${sentForDate}.`);
    }
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

function getPart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
  return parts.find((part) => part.type === type)?.value ?? "";
}
