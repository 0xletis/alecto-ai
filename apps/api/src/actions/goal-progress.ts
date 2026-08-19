import { createEvents, createExternalEventIfNotExists, getGoals, type ActionItem } from "@operator-agent/db";

/**
 * Extracted from apps/api/src/server.ts. Not action-hygiene-specific — used
 * by 5 different action-completion call sites (manual complete route,
 * conversational action control, action-hygiene batch operations) — so it
 * lives as a sibling to apps/api/src/actions/hygiene.ts rather than inside
 * it, matching what the code actually does rather than where it happened to
 * be called from most recently.
 */
export async function createGoalProgressFromCompletedAction(userId: string, actionItem: ActionItem) {
  if (!actionItem.goalId) {
    return undefined;
  }

  const goal = (await getGoals(userId)).find((item) => item.id === actionItem.goalId);
  const goalTitle = actionItem.goalTitleSnapshot ?? goal?.title ?? "Linked goal";
  const created = await createExternalEventIfNotExists(userId, {
    type: "custom.goal_progress_logged",
    source: "manual",
    provider: "action_completion",
    externalId: `action-completion:${actionItem.id}`,
    timestamp: actionItem.completedAt ?? new Date(),
    data: {
      goalId: actionItem.goalId,
      goalTitle,
      actionItemId: actionItem.id,
      actionTitle: actionItem.title,
      source: "action_completion"
    },
    confidence: 1,
    evidence: [`Completed action: ${actionItem.title}`]
  });

  return {
    ...created,
    goalTitle
  };
}

/**
 * Extracted from apps/api/src/server.ts alongside
 * createGoalProgressFromCompletedAction (same "create a goal progress
 * event" domain, different trigger — an explicit custom metric log rather
 * than an action completion). Used by the goal progress route,
 * conversational custom progress logging, and applyPendingAction's
 * goal_progress_log branch.
 */
export async function createCustomGoalProgressEvent(
  userId: string,
  goal: Awaited<ReturnType<typeof getGoals>>[number],
  input: { metricKey?: string; value?: string | number | boolean; unit?: string; note?: string }
) {
  const events = await createEvents(userId, [
    {
      type: "custom.goal_progress_logged",
      source: "manual",
      data: {
        goalId: goal.id,
        goalTitle: goal.title,
        ...(input.metricKey ? { metricKey: input.metricKey } : {}),
        ...(input.value !== undefined ? { value: input.value } : {}),
        ...(input.unit ? { unit: input.unit } : {}),
        ...(input.note ? { note: input.note } : {})
      },
      confidence: 1,
      evidence: [input.note ?? input.metricKey ?? goal.title]
    }
  ]);

  return events[0];
}
