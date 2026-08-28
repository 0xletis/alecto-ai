import { z } from "zod";

export const NotificationSettingsSchema = z.object({
  id: z.string(),
  userId: z.string(),
  telegramUserId: z.string().optional(),
  dailyCheckinEnabled: z.boolean().default(false),
  dailyCheckinTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  dailyInsightEnabled: z.boolean().default(false),
  dailyInsightTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  weeklyInsightEnabled: z.boolean().default(false),
  weeklyInsightDay: z.enum(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]).optional(),
  weeklyInsightTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  dailyLoopEnabled: z.boolean().default(false),
  // Product-level opt-in for Agent Runtime v3's Proactive Operator MVP — deliberately separate
  // from dailyLoopEnabled (a distinct, older feature: the legacy /daily-loop/start-day|end-day
  // messages). PROACTIVE_OPERATOR_DELIVERY_ENABLED/PROACTIVE_OPERATOR_ALLOWLIST remain developer
  // rollout controls (apps/worker/src/v3-proactive-delivery.ts); these three fields are the
  // actual per-user, per-moment product consent — no proactive message sends without both.
  morningBriefEnabled: z.boolean().default(false),
  eveningCheckinEnabled: z.boolean().default(false),
  gmailNudgeEnabled: z.boolean().default(false),
  timezone: z.string().default("Europe/Madrid"),
  defaultActionTimeMinutes: z.number().int().min(0).max(1439).default(540),
  morningTimeMinutes: z.number().int().min(0).max(1439).default(540),
  afternoonTimeMinutes: z.number().int().min(0).max(1439).default(900),
  eveningTimeMinutes: z.number().int().min(0).max(1439).default(1140),
  tonightTimeMinutes: z.number().int().min(0).max(1439).default(1200),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date()
});

export const UpdateNotificationSettingsInputSchema = z.object({
  telegramUserId: z.string().optional(),
  dailyCheckinEnabled: z.boolean().optional(),
  dailyCheckinTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  dailyInsightEnabled: z.boolean().optional(),
  dailyInsightTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  weeklyInsightEnabled: z.boolean().optional(),
  weeklyInsightDay: z.enum(["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]).optional(),
  weeklyInsightTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  dailyLoopEnabled: z.boolean().optional(),
  morningBriefEnabled: z.boolean().optional(),
  eveningCheckinEnabled: z.boolean().optional(),
  gmailNudgeEnabled: z.boolean().optional(),
  timezone: z.string().optional(),
  defaultActionTimeMinutes: z.number().int().min(0).max(1439).optional(),
  morningTimeMinutes: z.number().int().min(0).max(1439).optional(),
  afternoonTimeMinutes: z.number().int().min(0).max(1439).optional(),
  eveningTimeMinutes: z.number().int().min(0).max(1439).optional(),
  tonightTimeMinutes: z.number().int().min(0).max(1439).optional()
});

export type NotificationSettings = z.infer<typeof NotificationSettingsSchema>;
export type UpdateNotificationSettingsInput = z.infer<typeof UpdateNotificationSettingsInputSchema>;

/**
 * fix/private-alpha-proactive-worker-delivery-and-gmail-log-noise: NotificationSettings.telegramUserId
 * is ONLY ever written by the legacy Telegram slash commands (apps/telegram-bot/src/index.ts's
 * /set_daily_loop, /enable_checkin, etc via PATCH /users/:userId/notification-settings). A user who
 * enables morning brief/evening check-in through natural chat (proactive.settings_apply_update) never
 * gets that field set — it stays null forever. Root cause of a real production incident: a fully
 * configured tester (morningBriefEnabled, dailyLoopEnabled, correct timezone/time) never received a
 * single proactive message because every worker sender gated purely on telegramUserId being set.
 *
 * `userId` is always formatted "telegram:<digits>" for a real Telegram user throughout this system, so
 * that digit string IS the Telegram chat id — this derives it as a fallback. Shared between
 * apps/worker (every proactive/legacy sender) and apps/api (proactive delivery-status diagnosis), so
 * both sides agree on whether a user is actually reachable.
 */
export function telegramChatIdFromUserId(userId: string): string | undefined {
  const match = userId.match(/^telegram:(\d+)$/);
  return match?.[1];
}
