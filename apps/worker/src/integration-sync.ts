import {
  getActiveEmailSignalRulesForConnection,
  getActiveIntegrationConnectionsForSync,
  getOrCreateNotificationSettings,
  type IntegrationConnection
} from "@operator-agent/db";
import {
  evaluateGmailBackgroundSyncEligibility,
  gmailReviewNotificationsEnabled,
  gmailScheduledSyncRuntimeFromEnv,
  type GmailScheduledSyncRuntime
} from "@operator-agent/core";
import {
  formatIntegrationSyncNotifications,
  type IntegrationSyncResponse
} from "./integration-notifications.js";

export interface ScheduledIntegrationSyncOptions {
  now?: Date;
  integrationSyncEnabled?: boolean;
  integrationSyncIntervalMinutes?: number;
  gmailRuntime?: GmailScheduledSyncRuntime;
  getConnections?: () => Promise<IntegrationConnection[]>;
  getActiveGmailRuleCount?: (connection: IntegrationConnection) => Promise<number>;
  apiGet?: <T>(path: string) => Promise<T>;
  apiPost: <T>(path: string, body: unknown) => Promise<T>;
  sendTelegramMessage: (chatId: string, text: string) => Promise<void>;
  getNotificationSettings?: typeof getOrCreateNotificationSettings;
  logger?: Pick<Console, "log" | "error">;
}

export interface ScheduledIntegrationSyncResult {
  processedConnectionIds: string[];
  skippedConnectionIds: string[];
  notifiedUserIds: string[];
}

interface GmailBackgroundSyncSuccessLog {
  userId: string;
  connectionId: string;
  checkedCount: number;
  newReviewItemCount: number;
  notificationQueued: boolean;
  nextDueAt?: string;
}

interface ProactivePreviewResponse {
  decision:
    | { decision: "no_message"; reason: string }
    | {
        decision: "proposed_message";
        type: "morning_brief" | "evening_checkin" | "gmail_nudge";
        dedupeKey: string;
      };
  eligibility?: {
    wouldSend: boolean;
    blockedBy: string[];
  };
}

export async function runScheduledIntegrationSync(
  options: ScheduledIntegrationSyncOptions
): Promise<ScheduledIntegrationSyncResult> {
  const now = options.now ?? new Date();
  const integrationSyncEnabled = options.integrationSyncEnabled ?? process.env.INTEGRATION_SYNC_ENABLED === "true";
  const integrationSyncIntervalMinutes = options.integrationSyncIntervalMinutes ?? Number(process.env.INTEGRATION_SYNC_INTERVAL_MINUTES ?? "15");
  const gmailRuntime = options.gmailRuntime ?? gmailScheduledSyncRuntimeFromEnv();
  const getConnections = options.getConnections ?? getActiveIntegrationConnectionsForSync;
  const getNotificationSettings = options.getNotificationSettings ?? getOrCreateNotificationSettings;
  const logger = options.logger ?? console;
  const processedConnectionIds: string[] = [];
  const skippedConnectionIds: string[] = [];
  const notifiedUserIds: string[] = [];

  if (!integrationSyncEnabled) {
    return {
      processedConnectionIds,
      skippedConnectionIds,
      notifiedUserIds
    };
  }

  const intervalMs = Math.max(1, integrationSyncIntervalMinutes) * 60_000;
  const connections = await getConnections();
  const notificationsByUser = new Map<string, string[]>();
  const gmailSuccessLogs: GmailBackgroundSyncSuccessLog[] = [];
  const notificationSentByUser = new Set<string>();

  for (const connection of connections) {
    let gmailEligibility: ReturnType<typeof evaluateGmailBackgroundSyncEligibility> | undefined;

    if (connection.integrationId === "gmail") {
      const activeRuleCount = await (options.getActiveGmailRuleCount ?? defaultActiveGmailRuleCount)(connection);
      gmailEligibility = evaluateGmailBackgroundSyncEligibility({
        connection,
        now,
        runtime: gmailRuntime,
        activeRuleCount
      });

      if (!gmailEligibility.eligible) {
        skippedConnectionIds.push(connection.id);
        logger.log?.(`Skipping Gmail background sync for ${connection.id}: ${gmailEligibility.reason}.`);
        continue;
      }
    } else if (connection.lastSyncedAt && now.getTime() - connection.lastSyncedAt.getTime() < intervalMs) {
      skippedConnectionIds.push(connection.id);
      continue;
    }

    try {
      const response = await options.apiPost<IntegrationSyncResponse>(
        `/users/${connection.userId}/integrations/${connection.id}/sync`,
        connection.integrationId === "gmail"
          ? { backgroundSync: true, backgroundAttemptedAt: now.toISOString() }
          : {}
      );
      processedConnectionIds.push(connection.id);

      const summary = connection.integrationId === "gmail" ? summarizeGmailSyncResponse(response) : undefined;
      const suppressLegacyGmailReviewNotification =
        connection.integrationId === "gmail" && summary && summary.newReviewItemCount > 0
          ? await shouldSuppressLegacyGmailReviewNotification(connection.userId, now, options.apiGet, logger)
          : false;

      const messages = formatIntegrationSyncNotifications(response, {
        gmailReviewNotificationsEnabled:
          connection.integrationId === "gmail" ? gmailReviewNotificationsEnabled(connection.config) : true,
        suppressGmailReviewNotification: suppressLegacyGmailReviewNotification
      });

      if (messages.length > 0) {
        notificationsByUser.set(connection.userId, [
          ...(notificationsByUser.get(connection.userId) ?? []),
          ...messages
        ]);
      }

      if (connection.integrationId === "gmail") {
        gmailSuccessLogs.push({
          userId: connection.userId,
          connectionId: connection.id,
          checkedCount: summary?.checkedCount ?? 0,
          newReviewItemCount: summary?.newReviewItemCount ?? 0,
          notificationQueued: messages.length > 0,
          nextDueAt: gmailEligibility
            ? new Date(now.getTime() + Math.max(1, gmailEligibility.intervalMinutes) * 60_000).toISOString()
            : undefined
        });
      }
    } catch (error) {
      processedConnectionIds.push(connection.id);
      logger.error?.(`Integration sync failed for ${connection.id}`, error);

      if (!connection.lastError) {
        const reason = safeErrorMessage(error);
        const prefix = connection.integrationId === "gmail" ? "Gmail sync failed" : "GitHub sync failed";
        notificationsByUser.set(connection.userId, [
          ...(notificationsByUser.get(connection.userId) ?? []),
          reason.startsWith(prefix) ? reason : `${prefix}: ${reason}`
        ]);
      }
    }
  }

  for (const [userId, messages] of notificationsByUser) {
    const settings = await getNotificationSettings(userId);

    if (!settings.telegramUserId || messages.length === 0) {
      continue;
    }

    await options.sendTelegramMessage(settings.telegramUserId, messages.slice(0, 5).join("\n"));
    notifiedUserIds.push(userId);
    notificationSentByUser.add(userId);
  }

  for (const entry of gmailSuccessLogs) {
    logger.log?.(
      [
        "Gmail background sync succeeded:",
        `userId=${entry.userId}`,
        `connectionId=${entry.connectionId}`,
        `checked=${entry.checkedCount}`,
        `newReviews=${entry.newReviewItemCount}`,
        `notificationSent=${entry.notificationQueued && notificationSentByUser.has(entry.userId) ? "yes" : "no"}`,
        entry.nextDueAt ? `nextDueAt=${entry.nextDueAt}` : undefined
      ].filter(Boolean).join(" ")
    );
  }

  return {
    processedConnectionIds,
    skippedConnectionIds,
    notifiedUserIds
  };
}

async function defaultActiveGmailRuleCount(connection: IntegrationConnection): Promise<number> {
  return (await getActiveEmailSignalRulesForConnection(connection.userId, connection.id)).length;
}

async function shouldSuppressLegacyGmailReviewNotification(
  userId: string,
  now: Date,
  apiGet: ScheduledIntegrationSyncOptions["apiGet"],
  logger: Pick<Console, "log" | "error">
): Promise<boolean> {
  if (!apiGet) {
    return false;
  }

  try {
    const preview = await apiGet<ProactivePreviewResponse>(`/users/${userId}/operator/proactive/preview?now=${encodeURIComponent(now.toISOString())}`);
    return preview.decision.decision === "proposed_message" && preview.decision.type === "gmail_nudge" && preview.eligibility?.wouldSend === true;
  } catch (error) {
    logger.error?.(`V3 proactive Gmail nudge preview failed for ${userId}; keeping legacy Gmail review notification fallback.`, error);
    return false;
  }
}

function summarizeGmailSyncResponse(response: IntegrationSyncResponse): { checkedCount: number; newReviewItemCount: number } {
  const summaries = "emailSummaries" in response && Array.isArray(response.emailSummaries)
    ? response.emailSummaries
    : [];

  return {
    checkedCount: summaries.reduce((sum, summary) => sum + summary.messagesFound, 0),
    newReviewItemCount: summaries.reduce((sum, summary) => sum + summary.reviewItemsCreated, 0)
  };
}

function safeErrorMessage(error: unknown): string {
  if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }

  return "Integration sync failed.";
}
