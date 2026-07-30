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
  timezone: z.string().optional(),
  defaultActionTimeMinutes: z.number().int().min(0).max(1439).optional(),
  morningTimeMinutes: z.number().int().min(0).max(1439).optional(),
  afternoonTimeMinutes: z.number().int().min(0).max(1439).optional(),
  eveningTimeMinutes: z.number().int().min(0).max(1439).optional(),
  tonightTimeMinutes: z.number().int().min(0).max(1439).optional()
});

export type NotificationSettings = z.infer<typeof NotificationSettingsSchema>;
export type UpdateNotificationSettingsInput = z.infer<typeof UpdateNotificationSettingsInputSchema>;
