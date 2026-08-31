import { archiveActionItem, completeActionItem, getActionItem, rescheduleActionItem } from "@operator-agent/db";
import { isRecord } from "../utils/records.js";
import { formatLocalDateTime } from "../utils/datetime.js";
import { createGoalProgressFromCompletedAction } from "./goal-progress.js";

/**
 * Action-hygiene batch-operation execution, extracted from
 * apps/api/src/server.ts. This is the one piece of action-hygiene code that
 * `applyPendingAction`'s `action_hygiene` branch actually depends on —
 * confirmed by reading that branch directly, it never calls the
 * session-creation/candidate-analysis/list-formatting cluster
 * (`analyzeActionHygiene`, `createActionHygieneSession`,
 * `formatActionHygieneReport`, etc.), which stays in server.ts. That
 * cluster was deliberately NOT extracted this pass — see
 * docs/09-architecture-inventory.md's "Action Hygiene Service Extraction"
 * for why (it pulls in 9+ generic-but-currently-server.ts-local helpers
 * used far beyond action hygiene — `getUserTimezone`, `pendingDecisionExpiry`,
 * `toPendingActionCandidate`, etc. — a much larger, higher-risk extraction
 * than this pass's mandate covers).
 *
 * `HygieneOperation` and `ActionHygieneBatchOperation` are exported because
 * server.ts's remaining natural-language hygiene-reply parser (still
 * tangled with the legacy semantic router, not extracted) also needs them.
 */

export type HygieneOperation = "archive" | "complete" | "snooze" | "keep";

export type ActionHygieneBatchOperation = {
  operation: HygieneOperation;
  actionId: string;
  title: string;
  timeText?: string;
  dueAt?: string;
};

export function readActionHygieneBatchOperations(value: unknown): ActionHygieneBatchOperation[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isRecord)
    .flatMap((item): ActionHygieneBatchOperation[] => {
      const operation = typeof item.operation === "string" ? item.operation : "";
      if (operation !== "archive" && operation !== "complete" && operation !== "snooze" && operation !== "keep") {
        return [];
      }

      const actionId = typeof item.actionId === "string" ? item.actionId : "";
      const title = typeof item.title === "string" ? item.title : "";

      if (!actionId || !title) {
        return [];
      }

      return [{
        operation,
        actionId,
        title,
        timeText: typeof item.timeText === "string" ? item.timeText : undefined,
        dueAt: typeof item.dueAt === "string" ? item.dueAt : undefined
      }];
    });
}

export async function applyActionHygieneBatchOperations(
  userId: string,
  operations: ActionHygieneBatchOperation[],
  timezone: string
): Promise<{ reply: string }> {
  const done: string[] = [];
  const skipped: string[] = [];

  for (const operation of operations) {
    const action = await getActionItem(userId, operation.actionId);

    if (!action) {
      skipped.push(`${operation.title}: no longer found`);
      continue;
    }

    if (action.status === "archived" || action.status === "completed") {
      skipped.push(`${action.title}: already ${action.status}`);
      continue;
    }

    if (operation.operation === "archive") {
      const archived = await archiveActionItem(userId, action.id);
      if (archived) {
        done.push(`Archived ${archived.title}`);
      }
      continue;
    }

    if (operation.operation === "complete") {
      const completed = await completeActionItem(userId, action.id);
      if (completed) {
        const progressEvent = await createGoalProgressFromCompletedAction(userId, completed);
        done.push(
          progressEvent?.created
            ? `Completed ${completed.title}; goal progress logged for ${progressEvent.goalTitle}`
            : `Completed ${completed.title}`
        );
      }
      continue;
    }

    if (operation.operation === "snooze") {
      const dueAt = operation.dueAt ? new Date(operation.dueAt) : undefined;
      if (!dueAt || Number.isNaN(dueAt.getTime())) {
        skipped.push(`${action.title}: missing new due time`);
        continue;
      }

      // fix/private-alpha-remove-user-facing-action-snooze: this batch decision still recognizes
      // the word "snooze" in a reply like "complete 1, snooze 2 to Friday, archive 3" (established
      // vocabulary, unchanged), but no longer sets the hidden "snoozed" status — it reschedules,
      // updating dueAt while keeping the action OPEN and visible, same as every other user-facing
      // move/postpone command now does.
      const updated = await rescheduleActionItem(userId, action.id, dueAt);
      if (updated) {
        done.push(`Moved ${updated.title} to ${formatLocalDateTime(updated.dueAt, timezone)}`);
      }
      continue;
    }

    done.push(`Kept ${action.title}`);
  }

  return {
    reply: [
      done.length > 0 ? "Done:" : "No action changes were made.",
      ...done.map((line) => `- ${line}`),
      skipped.length > 0 ? "" : undefined,
      skipped.length > 0 ? "Skipped:" : undefined,
      ...skipped.map((line) => `- ${line}`)
    ].filter((line) => line !== undefined).join("\n")
  };
}
