import assert from "node:assert/strict";
import test from "node:test";
import {
  formatIntegrationSyncNotifications,
  type EmailSyncSummary,
  type IntegrationSyncResponse
} from "../apps/worker/src/integration-notifications.js";

function emailSummary(partial: Partial<EmailSyncSummary>): EmailSyncSummary {
  return {
    ruleId: partial.ruleId ?? "rule-1",
    adapterId: partial.adapterId ?? "custom_email_review",
    fetchStrategy: "query",
    classifierMode: "rules",
    lookbackDays: 30,
    maxMessagesPerSync: 25,
    maxEventsPerSync: 5,
    messagesFound: 1,
    processed: 1,
    ignoredUnknown: 0,
    filteredMarketing: 0,
    needsReview: 0,
    llmClassified: 0,
    llmUnavailable: 0,
    llmErrors: 0,
    llmNeedsReview: 0,
    llmIgnored: 0,
    reviewItemsCreated: 0,
    reviewItemsAlreadyPending: 0,
    reviewItemsSemanticDeduped: 0,
    reviewItemsRejectedDeduped: 0,
    lowConfidenceIgnored: 0,
    deduped: 0,
    semanticDeduped: 0,
    archivedCleanupReprocessed: 0,
    skippedDueMaxEventsPerSync: 0,
    eventsCreated: 0,
    ...partial
  };
}

function gmailResponse(emailSummaries: EmailSyncSummary[]): IntegrationSyncResponse {
  return {
    status: "success",
    connectionId: "gmail-connection",
    integrationId: "gmail",
    eventsCreated: emailSummaries.reduce((sum, summary) => sum + summary.eventsCreated, 0),
    emailSummaries
  };
}

test("scheduled Gmail sync notification bundles new email reviews without secrets", () => {
  const messages = formatIntegrationSyncNotifications(gmailResponse([
    emailSummary({ adapterId: "job_search_email", reviewItemsCreated: 1 }),
    emailSummary({ adapterId: "custom_email_review", reviewItemsCreated: 2 })
  ]));

  assert.deepEqual(messages, [
    '3 Gmail reviews are waiting: 1 job-search, 2 custom tracking. Say "email reviews" to handle them.'
  ]);
  assert.doesNotMatch(messages.join("\n"), /accessToken|refreshToken|ciphertext|"iv"|"tag"|raw/i);
});

test("scheduled Gmail sync notification is skipped when no new review items were created", () => {
  const messages = formatIntegrationSyncNotifications(gmailResponse([
    emailSummary({ adapterId: "custom_email_review", reviewItemsCreated: 0, reviewItemsAlreadyPending: 3 })
  ]));

  assert.deepEqual(messages, []);
});

test("scheduled Gmail sync can report new reviews and logged events in one compact batch", () => {
  const messages = formatIntegrationSyncNotifications(gmailResponse([
    emailSummary({ adapterId: "work_action_email", reviewItemsCreated: 1 }),
    emailSummary({ adapterId: "job_search_email", eventsCreated: 2 })
  ]));

  assert.deepEqual(messages, [
    '1 Gmail review is waiting: 1 work-action. Say "email reviews" to handle it.',
    "Gmail: 2 job-search email events logged."
  ]);
});
