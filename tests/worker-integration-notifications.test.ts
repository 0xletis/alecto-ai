import assert from "node:assert/strict";
import test from "node:test";
import {
  formatIntegrationSyncNotifications,
  type EmailSyncSummary,
  type IntegrationSyncResponse
} from "../apps/worker/src/integration-notifications.js";
import {
  gmailScheduledSyncRuntimeFromEnv,
  evaluateGmailBackgroundSyncEligibility,
  shouldSyncGmailConnectionOnSchedule,
  writeGmailBackgroundSyncAttempt
} from "../packages/core/src/index.ts";
import {
  runScheduledIntegrationSync
} from "../apps/worker/src/integration-sync.js";
import type { IntegrationConnection } from "../packages/db/src/index.ts";

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

function connection(partial: Partial<IntegrationConnection>): IntegrationConnection {
  return {
    id: partial.id ?? "connection-1",
    userId: partial.userId ?? "telegram:1",
    integrationId: partial.integrationId ?? "gmail",
    status: partial.status ?? "active",
    config: partial.config ?? {},
    lastSyncedAt: partial.lastSyncedAt,
    lastError: partial.lastError,
    createdAt: partial.createdAt ?? new Date("2026-08-12T08:00:00.000Z"),
    updatedAt: partial.updatedAt ?? new Date("2026-08-12T08:00:00.000Z")
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

test("scheduled Gmail sync review notification respects disabled preference", () => {
  const messages = formatIntegrationSyncNotifications(
    gmailResponse([
      emailSummary({ adapterId: "work_action_email", reviewItemsCreated: 2 })
    ]),
    { gmailReviewNotificationsEnabled: false }
  );

  assert.deepEqual(messages, []);
});

test("scheduled Gmail sync helper requires explicit scheduled mode and tracks background interval separately", () => {
  const now = new Date("2026-08-12T10:00:00.000Z");
  const runtime = gmailScheduledSyncRuntimeFromEnv({
    INTEGRATION_SYNC_ENABLED: "true",
    INTEGRATION_SYNC_INTERVAL_MINUTES: "15"
  });

  assert.equal(
    shouldSyncGmailConnectionOnSchedule({
      integrationId: "gmail",
      status: "active",
      config: {},
      lastSyncedAt: null
    }, now, runtime),
    false
  );

  assert.equal(
    shouldSyncGmailConnectionOnSchedule({
      integrationId: "gmail",
      status: "active",
      config: { gmailAutonomy: { syncMode: "manual_only" } },
      lastSyncedAt: new Date("2026-08-12T09:30:00.000Z")
    }, now, runtime),
    false
  );

  assert.equal(
    shouldSyncGmailConnectionOnSchedule({
      integrationId: "gmail",
      status: "active",
      config: { gmailAutonomy: { syncMode: "scheduled", syncIntervalMinutes: 60 } },
      lastSyncedAt: new Date("2026-08-12T09:59:00.000Z")
    }, now, runtime),
    true
  );

  assert.equal(
    shouldSyncGmailConnectionOnSchedule({
      integrationId: "gmail",
      status: "active",
      config: {
        gmailAutonomy: {
          syncMode: "scheduled",
          syncIntervalMinutes: 60,
          lastBackgroundSyncAttemptedAt: "2026-08-12T09:30:00.000Z"
        }
      },
      lastSyncedAt: null
    }, now, runtime),
    false
  );

  assert.equal(
    shouldSyncGmailConnectionOnSchedule({
      integrationId: "gmail",
      status: "active",
      config: {
        gmailAutonomy: {
          syncMode: "scheduled",
          syncIntervalMinutes: 60,
          lastBackgroundSyncAttemptedAt: "2026-08-12T08:30:00.000Z"
        }
      },
      lastSyncedAt: null
    }, now, runtime),
    true
  );
});

test("scheduled Gmail sync eligibility reports safe skip reasons", () => {
  const now = new Date("2026-08-12T10:00:00.000Z");
  const runtime = gmailScheduledSyncRuntimeFromEnv({
    INTEGRATION_SYNC_ENABLED: "true",
    INTEGRATION_SYNC_INTERVAL_MINUTES: "15"
  });

  assert.equal(
    evaluateGmailBackgroundSyncEligibility({
      connection: connection({
        config: { gmailAutonomy: { syncMode: "scheduled", syncIntervalMinutes: 60 } }
      }),
      now,
      runtime,
      activeRuleCount: 0
    }).reason,
    "no_active_rules"
  );

  assert.equal(
    evaluateGmailBackgroundSyncEligibility({
      connection: connection({
        config: { gmailAutonomy: { syncMode: "scheduled", syncIntervalMinutes: 60 } },
        status: "paused"
      }),
      now,
      runtime,
      activeRuleCount: 1
    }).reason,
    "connection_not_active"
  );

  assert.equal(
    evaluateGmailBackgroundSyncEligibility({
      connection: connection({
        config: { gmailAutonomy: { syncMode: "scheduled", syncIntervalMinutes: 60 } }
      }),
      now,
      runtime: { ...runtime, scheduledSyncEnabled: false },
      activeRuleCount: 1
    }).reason,
    "global_disabled"
  );

  const due = evaluateGmailBackgroundSyncEligibility({
    connection: connection({
      config: {
        gmailAutonomy: {
          syncMode: "scheduled",
          syncIntervalMinutes: 60,
          lastBackgroundSyncAttemptedAt: "2026-08-12T08:30:00.000Z"
        }
      }
    }),
    now,
    runtime,
    activeRuleCount: 1
  });

  assert.equal(due.eligible, true);
  assert.equal(due.reason, "due");
  assert.equal(due.nextDueAt?.toISOString(), "2026-08-12T09:30:00.000Z");
});

test("Gmail background sync attempt metadata records success and failure without manual sync coupling", () => {
  const success = writeGmailBackgroundSyncAttempt(
    { gmailAutonomy: { syncMode: "scheduled", syncIntervalMinutes: 60, lastBackgroundSyncError: "old" } },
    {
      attemptedAt: new Date("2026-08-12T10:00:00.000Z"),
      status: "success"
    }
  );

  assert.deepEqual(success.gmailAutonomy, {
    syncMode: "scheduled",
    syncIntervalMinutes: 60,
    lastBackgroundSyncError: null,
    lastBackgroundSyncAttemptedAt: "2026-08-12T10:00:00.000Z",
    lastBackgroundSyncedAt: "2026-08-12T10:00:00.000Z",
    lastBackgroundSyncStatus: "success"
  });

  const failure = writeGmailBackgroundSyncAttempt(
    { gmailAutonomy: { syncMode: "scheduled", syncIntervalMinutes: 60 } },
    {
      attemptedAt: new Date("2026-08-12T11:00:00.000Z"),
      status: "error",
      error: "Gmail authorization expired. Reconnect Gmail."
    }
  );

  assert.deepEqual(failure.gmailAutonomy, {
    syncMode: "scheduled",
    syncIntervalMinutes: 60,
    lastBackgroundSyncAttemptedAt: "2026-08-12T11:00:00.000Z",
    lastBackgroundSyncStatus: "error",
    lastBackgroundSyncError: "Gmail authorization expired. Reconnect Gmail."
  });
});

test("scheduled integration worker skips Gmail until explicit scheduled preference is due", async () => {
  const now = new Date("2026-08-12T10:00:00.000Z");
  const apiCalls: Array<{ path: string; body: unknown }> = [];
  const logs: string[] = [];
  const baseRuntime = {
    scheduledSyncEnabled: true,
    defaultIntervalMinutes: 15
  };

  const result = await runScheduledIntegrationSync({
    now,
    integrationSyncEnabled: true,
    gmailRuntime: baseRuntime,
    getConnections: async () => [
      connection({ id: "manual", config: { gmailAutonomy: { syncMode: "manual_only" } } }),
      connection({ id: "no-pref", config: {} }),
      connection({ id: "no-rules", config: { gmailAutonomy: { syncMode: "scheduled" } } }),
      connection({
        id: "not-due",
        config: {
          gmailAutonomy: {
            syncMode: "scheduled",
            syncIntervalMinutes: 60,
            lastBackgroundSyncAttemptedAt: "2026-08-12T09:30:00.000Z"
          }
        }
      }),
      connection({
        id: "due",
        config: {
          gmailAutonomy: {
            syncMode: "scheduled",
            syncIntervalMinutes: 60,
            lastBackgroundSyncAttemptedAt: "2026-08-12T08:30:00.000Z"
          }
        }
      })
    ],
    getActiveGmailRuleCount: async (gmailConnection) => gmailConnection.id === "no-rules" ? 0 : 1,
    apiPost: async (path, body) => {
      apiCalls.push({ path, body });
      return gmailResponse([emailSummary({ reviewItemsCreated: 0 })]) as IntegrationSyncResponse;
    },
    sendTelegramMessage: async () => {
      throw new Error("No notification expected");
    },
    logger: { log(message) { logs.push(message); }, error() {} }
  });

  assert.deepEqual(result.processedConnectionIds, ["due"]);
  assert.deepEqual(result.skippedConnectionIds, ["manual", "no-pref", "no-rules", "not-due"]);
  assert.deepEqual(apiCalls, [
    {
      path: "/users/telegram:1/integrations/due/sync",
      body: { backgroundSync: true, backgroundAttemptedAt: "2026-08-12T10:00:00.000Z" }
    }
  ]);
  assert.deepEqual(logs, [
    "Skipping Gmail background sync for manual: manual_only.",
    "Skipping Gmail background sync for no-pref: manual_only.",
    "Skipping Gmail background sync for no-rules: no_active_rules.",
    "Skipping Gmail background sync for not-due: not_due.",
    "Gmail background sync succeeded: userId=telegram:1 connectionId=due checked=1 newReviews=0 notificationSent=no nextDueAt=2026-08-12T11:00:00.000Z"
  ]);
  assert.doesNotMatch(logs.join("\n"), /accessToken|refreshToken|ciphertext|"iv"|"tag"|Subject:|Snippet:|Body:/i);
});

test("scheduled integration worker continues after one Gmail failure and bundles review notifications", async () => {
  const now = new Date("2026-08-12T10:00:00.000Z");
  const sent: Array<{ chatId: string; text: string }> = [];
  const logs: string[] = [];

  const result = await runScheduledIntegrationSync({
    now,
    integrationSyncEnabled: true,
    gmailRuntime: {
      scheduledSyncEnabled: true,
      defaultIntervalMinutes: 15
    },
    getConnections: async () => [
      connection({
        id: "failing",
        userId: "telegram:1",
        config: { gmailAutonomy: { syncMode: "scheduled", syncIntervalMinutes: 15 } }
      }),
      connection({
        id: "working",
        userId: "telegram:2",
        config: { gmailAutonomy: { syncMode: "scheduled", syncIntervalMinutes: 15 } }
      })
    ],
    getActiveGmailRuleCount: async () => 1,
    getNotificationSettings: async (userId) => ({
      userId,
      telegramUserId: userId === "telegram:1" ? "1" : "2",
      timezone: "Europe/Madrid",
      createdAt: now,
      updatedAt: now
    }),
    apiPost: async (path) => {
      if (path.includes("failing")) {
        throw new Error("Gmail authorization expired. Reconnect Gmail.");
      }

      return gmailResponse([emailSummary({ adapterId: "work_action_email", reviewItemsCreated: 2 })]) as IntegrationSyncResponse;
    },
    sendTelegramMessage: async (chatId, text) => {
      sent.push({ chatId, text });
    },
    logger: { log(message) { logs.push(message); }, error() {} }
  });

  assert.deepEqual(result.processedConnectionIds, ["failing", "working"]);
  assert.deepEqual(result.notifiedUserIds, ["telegram:1", "telegram:2"]);
  assert.deepEqual(sent, [
    { chatId: "1", text: "Gmail sync failed: Gmail authorization expired. Reconnect Gmail." },
    { chatId: "2", text: '2 Gmail reviews are waiting: 2 work-action. Say "email reviews" to handle them.' }
  ]);
  assert.deepEqual(logs, [
    "Gmail background sync succeeded: userId=telegram:2 connectionId=working checked=1 newReviews=2 notificationSent=yes nextDueAt=2026-08-12T10:15:00.000Z"
  ]);
});

test("scheduled Gmail review notifications are skipped when disabled or unroutable", async () => {
  const now = new Date("2026-08-12T10:00:00.000Z");
  const sent: Array<{ chatId: string; text: string }> = [];
  const logs: string[] = [];

  const result = await runScheduledIntegrationSync({
    now,
    integrationSyncEnabled: true,
    gmailRuntime: {
      scheduledSyncEnabled: true,
      defaultIntervalMinutes: 15
    },
    getConnections: async () => [
      connection({
        id: "disabled",
        userId: "telegram:1",
        config: {
          gmailAutonomy: {
            syncMode: "scheduled",
            syncIntervalMinutes: 15,
            reviewNotificationEnabled: false
          }
        }
      }),
      connection({
        id: "unroutable",
        userId: "internal-user",
        config: {
          gmailAutonomy: {
            syncMode: "scheduled",
            syncIntervalMinutes: 15
          }
        }
      })
    ],
    getActiveGmailRuleCount: async () => 1,
    getNotificationSettings: async (userId) => ({
      userId,
      telegramUserId: userId === "internal-user" ? undefined : "1",
      timezone: "Europe/Madrid",
      createdAt: now,
      updatedAt: now
    }),
    apiPost: async () => gmailResponse([emailSummary({ adapterId: "custom_email_review", reviewItemsCreated: 2 })]) as IntegrationSyncResponse,
    sendTelegramMessage: async (chatId, text) => {
      sent.push({ chatId, text });
    },
    logger: { log(message) { logs.push(message); }, error() {} }
  });

  assert.deepEqual(result.processedConnectionIds, ["disabled", "unroutable"]);
  assert.deepEqual(result.notifiedUserIds, []);
  assert.deepEqual(sent, []);
  assert.deepEqual(logs, [
    "Gmail background sync succeeded: userId=telegram:1 connectionId=disabled checked=1 newReviews=2 notificationSent=no nextDueAt=2026-08-12T10:15:00.000Z",
    "Gmail background sync succeeded: userId=internal-user connectionId=unroutable checked=1 newReviews=2 notificationSent=no nextDueAt=2026-08-12T10:15:00.000Z"
  ]);
});
