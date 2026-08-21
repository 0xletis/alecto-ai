import type { ActionItem } from "@operator-agent/db";

/**
 * Shared "what counts as a reminder companion row" detection — extracted so both
 * apps/api/src/agent-runtime/executor.ts (action.list/action.reminder_list/action.complete) and
 * apps/api/src/actions/hygiene-session.ts (analyzeActionHygiene) apply the exact same rule,
 * rather than each keeping its own copy that could quietly drift apart. Living here rather than
 * in executor.ts avoids a circular import (executor.ts already imports FROM hygiene-session.ts).
 *
 * A real Telegram smoke test found a "Reminder for Branding direction meeting" row still leaking
 * into a normal action list — its `actionType` was NOT "reminder" (legacy data, or created by an
 * older code path that predates that convention), so an `actionType === "reminder"` check alone
 * missed it. Detected generically here by ANY of: the current `actionType` convention, a
 * `pre_due_reminder:` sourceId (even paired with a wrong/missing actionType), or the denormalized
 * "Reminder for X"/"Reminder: X" title pattern the pre-due-reminder creator itself writes — so a
 * companion is recognized even if one of its own fields is stale or malformed, rather than
 * trusting a single field to always be internally consistent.
 */

const PRE_DUE_REMINDER_SOURCE_ID_RE = /^pre_due_reminder:([^:]+):\d+$/;
export const REMINDER_TITLE_PREFIX_RE = /^reminder\s*(for|:)\s*/i;

export function isReminderCompanionAction(action: Pick<ActionItem, "actionType" | "sourceId" | "title">): boolean {
  return action.actionType === "reminder" || Boolean(action.sourceId?.startsWith("pre_due_reminder:")) || REMINDER_TITLE_PREFIX_RE.test(action.title);
}

/**
 * Inverse of the `pre_due_reminder:<actionId>:<leadMinutes>` sourceId convention — resolves a
 * companion back to the real task it's about via a well-formed sourceId, or via the companion's
 * own denormalized title text when the sourceId is missing/malformed (a legacy or otherwise
 * broken row still recognized as a companion by isReminderCompanionAction above). Returns
 * undefined for a genuinely unlinked reminder, which callers treat as "show it, but don't pretend
 * it's tied to a specific task" rather than silently dropping it or guessing.
 */
export function resolveReminderParent<T extends Pick<ActionItem, "id" | "actionType" | "sourceId" | "title">>(reminder: T, candidates: T[]): T | undefined {
  const sourceIdMatch = reminder.actionType === "reminder" ? reminder.sourceId?.match(PRE_DUE_REMINDER_SOURCE_ID_RE) : undefined;
  const parentId = sourceIdMatch?.[1];
  if (parentId) {
    const parent = candidates.find((candidate) => candidate.id === parentId);
    if (parent) {
      return parent;
    }
  }

  const impliedTitle = reminder.title.replace(REMINDER_TITLE_PREFIX_RE, "").trim().toLowerCase();
  if (!impliedTitle) {
    return undefined;
  }
  return candidates.find((candidate) => candidate.title.trim().toLowerCase() === impliedTitle);
}
