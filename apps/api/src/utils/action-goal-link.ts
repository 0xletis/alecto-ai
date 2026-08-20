import { inferGoalLinkForAction } from "@operator-agent/core";
import { getActiveGoals } from "@operator-agent/db";

/**
 * Thin wrapper around @operator-agent/core's inferGoalLinkForAction that
 * loads the user's active goals first, extracted from apps/api/src/server.ts
 * where it was used both by manual action creation (stays in server.ts) and
 * the legacy email-review-to-action conversion
 * (apps/api/src/email-reviews/email-review-service.ts), which also needs it.
 */
export async function inferActionGoalLink(
  userId: string,
  actionTitle: string,
  actionDescription?: string,
  evidence?: string
) {
  return inferGoalLinkForAction({
    actionTitle,
    actionDescription,
    evidence,
    activeGoals: await getActiveGoals(userId)
  });
}
