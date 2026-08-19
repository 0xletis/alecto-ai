import type { Goal } from "@operator-agent/core";

/**
 * Generic goal-priority scoring helper extracted from
 * apps/api/src/server.ts, where it was called across goal sorting and
 * action-hygiene analysis — not specific to action hygiene, which is why it
 * lives here rather than in
 * apps/api/src/legacy/action-hygiene-conversation.ts (which also needs it).
 */
export function goalPriorityRank(goal: Goal | undefined): number {
  if (!goal) {
    return 0;
  }

  if (typeof goal.importanceScore === "number") {
    return goal.importanceScore;
  }

  return goal.priority === "critical" ? 70 : goal.priority === "high" ? 45 : goal.priority === "medium" ? 25 : 10;
}
