export type GmailSyncMode = "manual_only" | "scheduled" | "unknown";

export interface GmailAutonomyPreferences {
  syncMode?: Exclude<GmailSyncMode, "unknown">;
  syncIntervalMinutes?: number;
  reviewNotificationEnabled?: boolean;
}

export interface GmailScheduledSyncRuntime {
  scheduledSyncEnabled: boolean;
  defaultIntervalMinutes: number;
}

export interface GmailScheduledConnectionLike {
  integrationId: string;
  status: string;
  config: unknown;
  lastSyncedAt?: Date | null;
}

export function readGmailAutonomyPreferences(config: unknown): GmailAutonomyPreferences {
  const record = isRecord(config) ? config : {};
  const rawPreferences = isRecord(record.gmailAutonomy) ? record.gmailAutonomy : {};
  const rawSyncMode = stringValue(rawPreferences.syncMode) ?? stringValue(record.gmailSyncMode);
  const syncMode = rawSyncMode === "manual_only" || rawSyncMode === "scheduled" ? rawSyncMode : undefined;
  const rawInterval = numberValue(rawPreferences.syncIntervalMinutes) ?? numberValue(record.gmailSyncIntervalMinutes);
  const syncIntervalMinutes = normalizeIntervalMinutes(rawInterval);
  const rawReviewNotifications =
    booleanValue(rawPreferences.reviewNotificationEnabled) ?? booleanValue(record.gmailReviewNotificationEnabled);

  return {
    syncMode,
    syncIntervalMinutes,
    reviewNotificationEnabled: rawReviewNotifications
  };
}

export function writeGmailAutonomyPreferences(
  config: unknown,
  preferences: GmailAutonomyPreferences
): Record<string, unknown> {
  const record = isRecord(config) ? { ...config } : {};
  const current = isRecord(record.gmailAutonomy) ? { ...record.gmailAutonomy } : {};
  const next: Record<string, unknown> = {
    ...current
  };

  if (preferences.syncMode) {
    next.syncMode = preferences.syncMode;
  }

  if (preferences.syncIntervalMinutes !== undefined) {
    const interval = normalizeIntervalMinutes(preferences.syncIntervalMinutes);
    if (interval) {
      next.syncIntervalMinutes = interval;
    }
  }

  if (preferences.reviewNotificationEnabled !== undefined) {
    next.reviewNotificationEnabled = preferences.reviewNotificationEnabled;
  }

  return {
    ...record,
    gmailAutonomy: next
  };
}

export function gmailScheduledSyncRuntimeFromEnv(
  env: Record<string, string | undefined> = process.env
): GmailScheduledSyncRuntime {
  const defaultIntervalMinutes = normalizeIntervalMinutes(Number.parseInt(env.INTEGRATION_SYNC_INTERVAL_MINUTES ?? "15", 10)) ?? 15;

  return {
    scheduledSyncEnabled: env.INTEGRATION_SYNC_ENABLED === "true",
    defaultIntervalMinutes
  };
}

export function effectiveGmailSyncMode(
  preferences: GmailAutonomyPreferences,
  runtime: GmailScheduledSyncRuntime
): GmailSyncMode {
  if (preferences.syncMode) {
    return preferences.syncMode;
  }

  return runtime.scheduledSyncEnabled ? "scheduled" : "manual_only";
}

export function effectiveGmailSyncIntervalMinutes(
  preferences: GmailAutonomyPreferences,
  runtime: GmailScheduledSyncRuntime
): number {
  return preferences.syncIntervalMinutes ?? runtime.defaultIntervalMinutes;
}

export function gmailReviewNotificationsEnabled(config: unknown): boolean {
  return readGmailAutonomyPreferences(config).reviewNotificationEnabled !== false;
}

export function shouldSyncGmailConnectionOnSchedule(
  connection: GmailScheduledConnectionLike,
  now: Date,
  runtime: GmailScheduledSyncRuntime
): boolean {
  if (connection.integrationId !== "gmail" || connection.status !== "active" || !runtime.scheduledSyncEnabled) {
    return false;
  }

  const preferences = readGmailAutonomyPreferences(connection.config);
  if (effectiveGmailSyncMode(preferences, runtime) !== "scheduled") {
    return false;
  }

  const intervalMs = Math.max(1, effectiveGmailSyncIntervalMinutes(preferences, runtime)) * 60_000;
  return !connection.lastSyncedAt || now.getTime() - connection.lastSyncedAt.getTime() >= intervalMs;
}

function normalizeIntervalMinutes(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  const minutes = Math.round(value);
  return minutes > 0 && minutes <= 24 * 60 ? minutes : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}
