export type GmailSyncMode = "manual_only" | "scheduled" | "unknown";

export interface GmailAutonomyPreferences {
  syncMode?: Exclude<GmailSyncMode, "unknown">;
  syncIntervalMinutes?: number;
  reviewNotificationEnabled?: boolean;
  lastBackgroundSyncAttemptedAt?: string;
  lastBackgroundSyncedAt?: string;
  lastBackgroundSyncStatus?: "success" | "error";
  lastBackgroundSyncError?: string | null;
}

export interface GmailScheduledSyncRuntime {
  scheduledSyncEnabled: boolean;
  defaultIntervalMinutes: number;
}

export interface GmailScheduledConnectionLike {
  id?: string;
  userId?: string;
  integrationId: string;
  status: string;
  config: unknown;
  lastSyncedAt?: Date | null;
}

export interface GmailBackgroundSyncEligibility {
  globalEnabled: boolean;
  gmailConnected: boolean;
  connectionActive: boolean;
  activeRuleCount: number | undefined;
  syncMode: GmailSyncMode;
  intervalMinutes: number;
  lastBackgroundSyncAttemptedAt?: Date;
  lastBackgroundSyncedAt?: Date;
  nextDueAt?: Date;
  eligible: boolean;
  reason: string;
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
  const lastBackgroundSyncStatus = stringValue(rawPreferences.lastBackgroundSyncStatus);

  return {
    syncMode,
    syncIntervalMinutes,
    reviewNotificationEnabled: rawReviewNotifications,
    lastBackgroundSyncAttemptedAt: isoStringValue(rawPreferences.lastBackgroundSyncAttemptedAt),
    lastBackgroundSyncedAt: isoStringValue(rawPreferences.lastBackgroundSyncedAt),
    lastBackgroundSyncStatus: lastBackgroundSyncStatus === "success" || lastBackgroundSyncStatus === "error" ? lastBackgroundSyncStatus : undefined,
    lastBackgroundSyncError: nullableStringValue(rawPreferences.lastBackgroundSyncError)
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

  if (preferences.lastBackgroundSyncAttemptedAt !== undefined) {
    next.lastBackgroundSyncAttemptedAt = preferences.lastBackgroundSyncAttemptedAt;
  }

  if (preferences.lastBackgroundSyncedAt !== undefined) {
    next.lastBackgroundSyncedAt = preferences.lastBackgroundSyncedAt;
  }

  if (preferences.lastBackgroundSyncStatus !== undefined) {
    next.lastBackgroundSyncStatus = preferences.lastBackgroundSyncStatus;
  }

  if (preferences.lastBackgroundSyncError !== undefined) {
    next.lastBackgroundSyncError = preferences.lastBackgroundSyncError;
  }

  return {
    ...record,
    gmailAutonomy: next
  };
}

export function writeGmailBackgroundSyncAttempt(
  config: unknown,
  input: {
    attemptedAt: Date;
    status: "success" | "error";
    error?: string | null;
  }
): Record<string, unknown> {
  return writeGmailAutonomyPreferences(config, {
    lastBackgroundSyncAttemptedAt: input.attemptedAt.toISOString(),
    lastBackgroundSyncedAt: input.status === "success" ? input.attemptedAt.toISOString() : undefined,
    lastBackgroundSyncStatus: input.status,
    lastBackgroundSyncError: input.status === "error" ? input.error ?? "Gmail sync failed." : null
  });
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
  _runtime: GmailScheduledSyncRuntime
): GmailSyncMode {
  if (preferences.syncMode) {
    return preferences.syncMode;
  }

  return "manual_only";
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
  return evaluateGmailBackgroundSyncEligibility({
    connection,
    now,
    runtime
  }).eligible;
}

export function evaluateGmailBackgroundSyncEligibility(input: {
  connection: GmailScheduledConnectionLike;
  now: Date;
  runtime: GmailScheduledSyncRuntime;
  activeRuleCount?: number;
}): GmailBackgroundSyncEligibility {
  const preferences = readGmailAutonomyPreferences(input.connection.config);
  const syncMode = effectiveGmailSyncMode(preferences, input.runtime);
  const intervalMinutes = effectiveGmailSyncIntervalMinutes(preferences, input.runtime);
  const lastBackgroundSyncAttemptedAt = dateValue(preferences.lastBackgroundSyncAttemptedAt);
  const lastBackgroundSyncedAt = dateValue(preferences.lastBackgroundSyncedAt);
  const intervalMs = Math.max(1, intervalMinutes) * 60_000;
  const nextDueAt = lastBackgroundSyncAttemptedAt
    ? new Date(lastBackgroundSyncAttemptedAt.getTime() + intervalMs)
    : input.now;

  if (input.connection.integrationId !== "gmail") {
    return {
      globalEnabled: input.runtime.scheduledSyncEnabled,
      gmailConnected: false,
      connectionActive: input.connection.status === "active",
      activeRuleCount: input.activeRuleCount,
      syncMode,
      intervalMinutes,
      lastBackgroundSyncAttemptedAt,
      lastBackgroundSyncedAt,
      nextDueAt: undefined,
      eligible: false,
      reason: "not_gmail"
    };
  }

  if (input.connection.status !== "active") {
    return {
      globalEnabled: input.runtime.scheduledSyncEnabled,
      gmailConnected: true,
      connectionActive: false,
      activeRuleCount: input.activeRuleCount,
      syncMode,
      intervalMinutes,
      lastBackgroundSyncAttemptedAt,
      lastBackgroundSyncedAt,
      nextDueAt: undefined,
      eligible: false,
      reason: "connection_not_active"
    };
  }

  if (!input.runtime.scheduledSyncEnabled) {
    return {
      globalEnabled: false,
      gmailConnected: true,
      connectionActive: true,
      activeRuleCount: input.activeRuleCount,
      syncMode,
      intervalMinutes,
      lastBackgroundSyncAttemptedAt,
      lastBackgroundSyncedAt,
      nextDueAt: undefined,
      eligible: false,
      reason: "global_disabled"
    };
  }

  if (syncMode !== "scheduled") {
    return {
      globalEnabled: true,
      gmailConnected: true,
      connectionActive: true,
      activeRuleCount: input.activeRuleCount,
      syncMode,
      intervalMinutes,
      lastBackgroundSyncAttemptedAt,
      lastBackgroundSyncedAt,
      nextDueAt: undefined,
      eligible: false,
      reason: "manual_only"
    };
  }

  if (input.activeRuleCount !== undefined && input.activeRuleCount <= 0) {
    return {
      globalEnabled: true,
      gmailConnected: true,
      connectionActive: true,
      activeRuleCount: input.activeRuleCount,
      syncMode,
      intervalMinutes,
      lastBackgroundSyncAttemptedAt,
      lastBackgroundSyncedAt,
      nextDueAt: undefined,
      eligible: false,
      reason: "no_active_rules"
    };
  }

  if (nextDueAt.getTime() > input.now.getTime()) {
    return {
      globalEnabled: true,
      gmailConnected: true,
      connectionActive: true,
      activeRuleCount: input.activeRuleCount,
      syncMode,
      intervalMinutes,
      lastBackgroundSyncAttemptedAt,
      lastBackgroundSyncedAt,
      nextDueAt,
      eligible: false,
      reason: "not_due"
    };
  }

  return {
    globalEnabled: true,
    gmailConnected: true,
    connectionActive: true,
    activeRuleCount: input.activeRuleCount,
    syncMode,
    intervalMinutes,
    lastBackgroundSyncAttemptedAt,
    lastBackgroundSyncedAt,
    nextDueAt,
    eligible: true,
    reason: "due"
  };
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

function nullableStringValue(value: unknown): string | null | undefined {
  if (value === null) {
    return null;
  }

  return typeof value === "string" ? value : undefined;
}

function isoStringValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  return dateValue(value) ? value : undefined;
}

function dateValue(value: unknown): Date | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
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
