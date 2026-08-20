import type { ActionItem } from "@operator-agent/db";

/**
 * Generic, dependency-free ActionItem status check extracted from
 * apps/api/src/server.ts, where it was called across daily brief, weekly
 * review, operator attention, and action-hygiene analysis — not specific to
 * any one of those, which is why it lives here rather than in
 * apps/api/src/legacy/action-hygiene-conversation.ts (which also needs it).
 */
export function isSnoozedDue(action: ActionItem, now: Date): boolean {
  return action.status === "snoozed" && Boolean(action.snoozedUntil && action.snoozedUntil <= now);
}
