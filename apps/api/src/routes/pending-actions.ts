import type { FastifyInstance } from "fastify";
import {
  CreateGoalInputSchema,
  CustomGoalProgressInputSchema,
  PendingMemoryCreatePayloadSchema,
  UpdateUserOperatingProfileInputSchema,
  writeGmailAutonomyPreferences
} from "@operator-agent/core";
import {
  archiveActionItem,
  archiveEmailSignalRule,
  archiveGoal,
  confirmPendingAction,
  createEmailSignalRule,
  createGoal,
  createMemoryFromPendingPayload,
  getEmailSignalRules,
  getGoals,
  getIntegrationConnection,
  getPendingActions,
  rejectPendingAction,
  undoLastEvents,
  updateIntegrationConnectionConfig,
  updateUserOperatingProfile,
  type PendingAction
} from "@operator-agent/db";
import { buildGmailAutonomyState, formatIntervalMinutes } from "../conversation/gmail-autonomy.js";
import { formatGmailEmailRuleSelectionLines } from "../gmail/gmail-rule-service.js";
import { applyActionHygieneBatchOperations, readActionHygieneBatchOperations } from "../actions/hygiene.js";
import { createCustomGoalProgressEvent } from "../actions/goal-progress.js";
import { isRecord } from "../utils/records.js";
import { normalizeForComparison } from "../utils/text.js";
import { arrayOfStrings } from "../utils/arrays.js";
import { getUserTimezone } from "../utils/user-timezone.js";

/**
 * Pending-actions confirmation flow, extracted from apps/api/src/server.ts's
 * buildServer() as-is (pure move, no behavior change) — route paths,
 * request/response shapes, status codes, and DB mutations are all
 * unchanged. `applyPendingAction` and `findPendingAction` moved alongside
 * the routes since they were their only exclusive server.ts-local
 * dependencies once the Gmail rule service and action hygiene service
 * extractions (see docs/09-architecture-inventory.md) already cleaned up
 * everything else `applyPendingAction` touches.
 *
 * `applyPendingAction` is exported because it has one other caller that
 * stays in server.ts: the legacy `/messages/process` pending-decision
 * resolver's exact-confirmation-message branch ("say yes to confirm").
 * That's a one-directional import (server.ts -> this file), not circular —
 * this file has zero dependency on server.ts.
 */
export function registerPendingActionRoutes(server: FastifyInstance): void {
  server.get<{ Params: { userId: string } }>("/users/:userId/pending-actions", async (request) => ({
    pendingActions: await getPendingActions(request.params.userId)
  }));

  server.post<{ Params: { userId: string; pendingActionId: string } }>(
    "/users/:userId/pending-actions/:pendingActionId/confirm",
    async (request, reply) => {
      const pendingAction = await findPendingAction(request.params.userId, request.params.pendingActionId);

      if (!pendingAction) {
        return reply.status(404).send({
          error: "Pending action not found"
        });
      }

      if (pendingAction.type === "action_target_clarification") {
        return reply.status(400).send({
          error: "Reply with the number of the action you mean, or cancel."
        });
      }

      const applied = await applyPendingAction(request.params.userId, pendingAction);
      const confirmedAction = await confirmPendingAction(request.params.userId, pendingAction.id);

      return {
        pendingAction: confirmedAction,
        reply: applied.reply
      };
    }
  );

  server.post<{ Params: { userId: string; pendingActionId: string } }>(
    "/users/:userId/pending-actions/:pendingActionId/reject",
    async (request, reply) => {
      const pendingAction = await rejectPendingAction(request.params.userId, request.params.pendingActionId);

      if (!pendingAction) {
        return reply.status(404).send({
          error: "Pending action not found"
        });
      }

      return {
        pendingAction,
        reply: "Cancelled. I did not change anything."
      };
    }
  );
}

async function findPendingAction(userId: string, pendingActionId: string) {
  const pendingActions = await getPendingActions(userId);
  return pendingActions.find((action) => action.id === pendingActionId && action.status === "pending");
}

export async function applyPendingAction(userId: string, pendingAction: PendingAction): Promise<{ reply: string }> {
  if (pendingAction.type === "action_target_clarification") {
    return {
      reply: "Reply with the number of the action you mean, or cancel."
    };
  }

  if (pendingAction.type === "profile_update") {
    const profilePatch = pendingAction.payload.profilePatch;

    if (!isRecord(profilePatch)) {
      throw new Error("Invalid profile_update payload.");
    }

    await updateUserOperatingProfile(userId, UpdateUserOperatingProfileInputSchema.parse(profilePatch));

    return {
      reply: pendingAction.summary.toLowerCase().includes("hard guardian")
        ? "Confirmed. I updated your profile to hard guardian mode."
        : "Confirmed. I updated your profile."
    };
  }

  if (pendingAction.type === "goal_create") {
    const { title, category, why, templateId, targetMetrics, checkInConfig } = pendingAction.payload;

    if (typeof title !== "string" || typeof category !== "string") {
      throw new Error("Invalid goal_create payload.");
    }

    const result = await createGoal(userId, CreateGoalInputSchema.parse({
      title,
      category,
      why: typeof why === "string" ? why : undefined,
      templateId: typeof templateId === "string" ? templateId : undefined,
      targetMetrics: Array.isArray(targetMetrics) ? targetMetrics : undefined,
      checkInConfig: Array.isArray(checkInConfig) ? checkInConfig : undefined
    }));

    if (result.duplicate) {
      return {
        reply: `You already have a similar active goal: ${result.existingGoal.title}. Use /goals to review it or /archive_goal ${result.existingGoal.id} first.`
      };
    }

    return {
      reply: `Confirmed. I created the goal: ${title}.`
    };
  }

  if (pendingAction.type === "goal_progress_log") {
    const goalId = pendingAction.payload.goalId;

    if (typeof goalId !== "string") {
      throw new Error("Invalid goal_progress_log payload.");
    }

    const goal = (await getGoals(userId)).find((item) => item.id === goalId);

    if (!goal) {
      throw new Error("Goal not found.");
    }

    await createCustomGoalProgressEvent(userId, goal, CustomGoalProgressInputSchema.parse({
      metricKey: typeof pendingAction.payload.metricKey === "string" ? pendingAction.payload.metricKey : undefined,
      value: pendingAction.payload.value,
      unit: typeof pendingAction.payload.unit === "string" ? pendingAction.payload.unit : undefined,
      note: typeof pendingAction.payload.note === "string" ? pendingAction.payload.note : undefined
    }));

    return {
      reply: `Confirmed. Logged progress for ${goal.title}.`
    };
  }

  if (pendingAction.type === "custom_email_rule") {
    const operation = typeof pendingAction.payload.operation === "string" ? pendingAction.payload.operation : "";

    if (operation === "archive_rule") {
      const ruleId = typeof pendingAction.payload.ruleId === "string" ? pendingAction.payload.ruleId : "";
      const rule = await archiveEmailSignalRule(userId, ruleId);

      if (!rule) {
        throw new Error("Email rule not found.");
      }

      return {
        reply: `Gmail rule removed: ${rule.name}`
      };
    }

    if (operation === "archive_rules") {
      const ruleIds = arrayOfStrings(pendingAction.payload.ruleIds);
      const archivedRules = [];

      for (const ruleId of ruleIds) {
        const rule = await archiveEmailSignalRule(userId, ruleId);
        if (rule) {
          archivedRules.push(rule);
        }
      }

      if (archivedRules.length === 0) {
        throw new Error("Email rules not found.");
      }

      const ruleScope = typeof pendingAction.payload.ruleScope === "string" ? pendingAction.payload.ruleScope : "";
      const label = ruleScope === "gmail_email_rules" ? "Gmail email rules" : "Custom Gmail rules";

      return {
        reply: [
          `${label} removed: ${archivedRules.length}`,
          ...formatGmailEmailRuleSelectionLines(archivedRules)
        ].join("\n")
      };
    }

    if (operation === "create_rule") {
      const connectionId = typeof pendingAction.payload.connectionId === "string" ? pendingAction.payload.connectionId : "";
      const displayName = typeof pendingAction.payload.displayName === "string" ? pendingAction.payload.displayName : "Custom Gmail tracking";
      const queryPreview = typeof pendingAction.payload.queryPreview === "string" ? pendingAction.payload.queryPreview : "";
      const goalId = typeof pendingAction.payload.goalId === "string" ? pendingAction.payload.goalId : undefined;

      if (!connectionId || !queryPreview) {
        throw new Error("Invalid custom_email_rule payload.");
      }

      const connection = await getIntegrationConnection(userId, connectionId);

      if (!connection || connection.integrationId !== "gmail" || connection.status !== "active") {
        return {
          reply: "Gmail is not connected anymore. Say 'connect Gmail' and try again."
        };
      }

      const existing = (await getEmailSignalRules(userId)).find(
        (rule) =>
          rule.status === "active" &&
          rule.connectionId === connectionId &&
          rule.adapterId === "custom_email_review" &&
          normalizeForComparison(rule.query ?? "") === normalizeForComparison(queryPreview)
      );

      if (existing) {
        return {
          reply: `${existing.name} tracking is already on. New matches go to email review before anything is logged.`
        };
      }

      const rule = await createEmailSignalRule(userId, {
        connectionId,
        goalId,
        adapterId: "custom_email_review",
        name: displayName,
        query: queryPreview,
        fetchStrategy: "query",
        lookbackDays: 30,
        maxMessagesPerSync: 25,
        maxEventsPerSync: 5,
        classifierMode: "rules",
        minAutoLogConfidence: 1,
        minReviewConfidence: 0.65,
        reviewBeforeLogging: true,
        createdBy: "user"
      });

      return {
        reply: `${rule.name} tracking is on. New matches will go to email review before anything is logged.`
      };
    }

    if (operation === "gmail_autonomy_preference") {
      const connectionId = typeof pendingAction.payload.connectionId === "string" ? pendingAction.payload.connectionId : "";
      const connection = await getIntegrationConnection(userId, connectionId);

      if (!connection || connection.integrationId !== "gmail" || connection.status !== "active") {
        return {
          reply: "Gmail is not connected anymore. Say 'connect Gmail' and try again."
        };
      }

      const syncMode =
        pendingAction.payload.syncMode === "manual_only" || pendingAction.payload.syncMode === "scheduled"
          ? pendingAction.payload.syncMode
          : undefined;
      const syncIntervalMinutes =
        typeof pendingAction.payload.syncIntervalMinutes === "number"
          ? pendingAction.payload.syncIntervalMinutes
          : typeof pendingAction.payload.syncIntervalMinutes === "string"
            ? Number.parseInt(pendingAction.payload.syncIntervalMinutes, 10)
            : undefined;
      const reviewNotificationEnabled =
        typeof pendingAction.payload.reviewNotificationEnabled === "boolean"
          ? pendingAction.payload.reviewNotificationEnabled
          : undefined;
      const updatedConfig = writeGmailAutonomyPreferences(connection.config, {
        syncMode,
        syncIntervalMinutes,
        reviewNotificationEnabled
      });
      const updatedConnection = await updateIntegrationConnectionConfig(userId, connection.id, updatedConfig);

      if (!updatedConnection) {
        throw new Error("Gmail connection not found.");
      }

      const state = await buildGmailAutonomyState(userId);
      const preferenceKind = typeof pendingAction.payload.preferenceKind === "string" ? pendingAction.payload.preferenceKind : "";

      if (preferenceKind === "manual_only") {
        return {
          reply: "Gmail is set to manual only. I will check active rules when you say \"sync Gmail\"."
        };
      }

      if (preferenceKind === "scheduled") {
        const interval = typeof syncIntervalMinutes === "number" && Number.isFinite(syncIntervalMinutes)
          ? syncIntervalMinutes
          : state.syncIntervalMinutes;
        return {
          reply: state.runtime.scheduledSyncEnabled
            ? `Gmail scheduled checks are set to every ${formatIntervalMinutes(interval)} for active rules.`
            : `Gmail preference saved: checks every ${formatIntervalMinutes(interval)}. Background sync is currently disabled in this local environment, so I will only check when you say "sync Gmail" until background sync is enabled.`
        };
      }

      if (preferenceKind === "review_notifications_on" || preferenceKind === "review_notifications_off") {
        const enabled = preferenceKind === "review_notifications_on";
        return {
          reply: enabled
            ? "Gmail review notifications are on. Scheduled sync will send one bundled message when new reviews are waiting."
            : "Gmail review notifications are off. Manual sync will still reply in chat."
        };
      }

      return {
        reply: "Gmail preference updated."
      };
    }

    throw new Error("Invalid custom_email_rule operation.");
  }

  if (pendingAction.type === "goal_archive") {
    const goalId = pendingAction.payload.goalId;

    if (typeof goalId !== "string") {
      throw new Error("Invalid goal_archive payload.");
    }

    const goal = await archiveGoal(userId, goalId);

    if (!goal) {
      throw new Error("Goal not found.");
    }

    return {
      reply: `Confirmed. I archived the goal: ${goal.title}.`
    };
  }

  if (pendingAction.type === "action_archive") {
    const actionId = pendingAction.payload.actionId;

    if (typeof actionId !== "string") {
      throw new Error("Invalid action_archive payload.");
    }

    const action = await archiveActionItem(userId, actionId);

    if (!action) {
      throw new Error("Action item not found.");
    }

    return {
      reply: `Action archived: ${action.title}`
    };
  }

  if (pendingAction.type === "action_hygiene") {
    if (pendingAction.payload.operation === "batch_update") {
      const timezone = typeof pendingAction.payload.timezone === "string" ? pendingAction.payload.timezone : await getUserTimezone(userId);
      const operations = readActionHygieneBatchOperations(pendingAction.payload.operations);

      if (operations.length === 0) {
        return {
          reply: "No action hygiene changes were waiting."
        };
      }

      return applyActionHygieneBatchOperations(userId, operations, timezone);
    }

    if (pendingAction.payload.operation !== "bulk_archive" || !Array.isArray(pendingAction.payload.actionIds)) {
      return {
        reply: "Run /action_hygiene again and choose one action."
      };
    }

    const archived: string[] = [];

    for (const actionId of pendingAction.payload.actionIds) {
      if (typeof actionId !== "string") {
        continue;
      }

      const action = await archiveActionItem(userId, actionId);

      if (action) {
        archived.push(action.title);
      }
    }

    return {
      reply: archived.length > 0
        ? [`Archived ${archived.length} action${archived.length === 1 ? "" : "s"}:`, ...archived.map((title) => `- ${title}`)].join("\n")
        : "No matching actions were archived."
    };
  }

  if (pendingAction.type === "memory_create") {
    const payload = PendingMemoryCreatePayloadSchema.parse(pendingAction.payload);
    const memory = await createMemoryFromPendingPayload(userId, payload);

    return {
      reply: `Confirmed. I saved this to memory: ${memory.summary}`
    };
  }

  if (pendingAction.type === "event_undo_last") {
    const scope = pendingAction.payload.scope === "event" ? "event" : "group";
    const reason =
      typeof pendingAction.payload.reason === "string" ? pendingAction.payload.reason : "user requested undo";
    const events = await undoLastEvents(userId, { scope, reason });

    return {
      reply:
        events.length === 0
          ? "Confirmed, but there was no active event to archive."
          : `Confirmed. Archived ${events.length} event${events.length === 1 ? "" : "s"} from the last logged action.`
    };
  }

  throw new Error(`Unsupported pending action type: ${pendingAction.type}`);
}
