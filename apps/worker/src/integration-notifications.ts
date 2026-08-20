export interface IntegrationSyncResponse {
  status: "success" | "error";
  connectionId: string;
  integrationId: string;
  eventsCreated: number;
  personalCommitEvents?: number;
  repoActivityEvents?: number;
  repoSummaries?: IntegrationRepoSyncSummary[];
  emailSummaries?: EmailSyncSummary[];
  pendingEmailReviewCount?: number;
  errorStage?: GmailErrorStage;
}

export interface IntegrationRepoSyncSummary {
  repo: string;
  personalCommitEvents: number;
  repoActivityEvents: number;
}

export interface EmailSyncSummary {
  ruleId: string;
  adapterId: string;
  query?: string;
  fetchStrategy: string;
  classifierMode: string;
  lookbackDays: number;
  maxMessagesPerSync: number;
  maxEventsPerSync: number;
  messagesFound: number;
  processed: number;
  ignoredUnknown: number;
  filteredMarketing: number;
  needsReview: number;
  llmClassified: number;
  llmUnavailable: number;
  llmErrors: number;
  llmNeedsReview: number;
  llmIgnored: number;
  reviewItemsCreated: number;
  reviewItemsAlreadyPending: number;
  reviewItemsSemanticDeduped: number;
  reviewItemsRejectedDeduped: number;
  lowConfidenceIgnored: number;
  deduped: number;
  semanticDeduped: number;
  archivedCleanupReprocessed: number;
  skippedDueMaxEventsPerSync: number;
  eventsCreated: number;
  lastError?: string;
  lastErrorStage?: GmailErrorStage;
  reviewCandidateDebug?: unknown[];
}

export type GmailErrorStage =
  | "rule_loading"
  | "token_refresh"
  | "gmail_search"
  | "gmail_message_fetch"
  | "classification"
  | "event_creation";

export interface IntegrationSyncNotificationOptions {
  gmailReviewNotificationsEnabled?: boolean;
  suppressGmailReviewNotification?: boolean;
}

export function formatIntegrationSyncNotifications(
  response: IntegrationSyncResponse,
  options: IntegrationSyncNotificationOptions = {}
): string[] {
  if (response.integrationId === "gmail" && response.emailSummaries?.length) {
    const eventTotal = response.emailSummaries.reduce((sum, summary) => sum + summary.eventsCreated, 0);
    const reviewTotal = response.emailSummaries.reduce((sum, summary) => sum + summary.reviewItemsCreated, 0);
    const messages: string[] = [];

    if (reviewTotal > 0 && options.gmailReviewNotificationsEnabled !== false && options.suppressGmailReviewNotification !== true) {
      const groupSummary = formatGmailReviewGroupSummary(response.emailSummaries);
      messages.push(
        `${reviewTotal} Gmail review${reviewTotal === 1 ? "" : "s"} ${reviewTotal === 1 ? "is" : "are"} waiting${groupSummary ? `: ${groupSummary}` : ""}. Say "email reviews" to handle ${reviewTotal === 1 ? "it" : "them"}.`
      );
    }

    if (eventTotal > 0) {
      messages.push(`Gmail: ${eventTotal} job-search email event${eventTotal === 1 ? "" : "s"} logged.`);
    }

    return messages;
  }

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

function formatGmailReviewGroupSummary(summaries: EmailSyncSummary[]): string {
  const counts = new Map<string, number>();

  for (const summary of summaries) {
    if (summary.reviewItemsCreated <= 0) {
      continue;
    }

    const label =
      summary.adapterId === "job_search_email"
        ? "job-search"
        : summary.adapterId === "work_action_email"
          ? "work-action"
          : summary.adapterId === "custom_email_review"
            ? "custom tracking"
            : "other";
    counts.set(label, (counts.get(label) ?? 0) + summary.reviewItemsCreated);
  }

  return [...counts.entries()].map(([label, count]) => `${count} ${label}`).join(", ");
}
