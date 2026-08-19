import type { NotificationSettings } from "@operator-agent/core";
import type { ProactiveDecision, ProactiveMessageType } from "./proactive.js";

/**
 * Layers real send-eligibility on top of decideProactiveOperatorMessage's own content decision
 * — deliberately kept OUT of proactive.ts, which stays a pure content-decision module unaware of
 * env flags or per-user product consent. Two independent gates, per the product correction that
 * introduced user-level settings: PROACTIVE_OPERATOR_DELIVERY_ENABLED/PROACTIVE_OPERATOR_ALLOWLIST
 * are developer rollout controls (never the product UX); morningBriefEnabled/
 * eveningCheckinEnabled/gmailNudgeEnabled (packages/core/src/notifications.ts) are the actual
 * per-user, per-moment consent a real send additionally requires. Used by the preview route to
 * report wouldSend/blockedBy, and independently re-checked by apps/worker's own delivery code —
 * this module's output is informational for preview, never the sole gate a real send relies on.
 */

export type ProactiveBlockedReason =
  | "delivery_disabled"
  | "not_allowlisted"
  | "user_not_opted_in"
  | "quiet_hours"
  | "dedupe"
  | "no_candidate";

export interface ProactiveEligibilityInput {
  decision: ProactiveDecision;
  deliveryEnabled: boolean;
  isAllowlisted: boolean;
  notificationSettings: NotificationSettings;
}

export interface ProactiveEligibilityResult {
  wouldSend: boolean;
  blockedBy: ProactiveBlockedReason[];
}

const NO_MESSAGE_REASON_TO_BLOCKED_BY: Record<string, ProactiveBlockedReason> = {
  daily_loop_disabled: "quiet_hours",
  daily_max_reached: "dedupe",
  no_eligible_candidate: "no_candidate"
};

export function evaluateProactiveEligibility(input: ProactiveEligibilityInput): ProactiveEligibilityResult {
  const blockedBy: ProactiveBlockedReason[] = [];

  if (!input.deliveryEnabled) {
    blockedBy.push("delivery_disabled");
  }
  if (!input.isAllowlisted) {
    blockedBy.push("not_allowlisted");
  }

  if (input.decision.decision === "no_message") {
    blockedBy.push(NO_MESSAGE_REASON_TO_BLOCKED_BY[input.decision.reason] ?? "no_candidate");
    return { wouldSend: false, blockedBy };
  }

  if (!isUserOptedIn(input.decision.type, input.notificationSettings)) {
    blockedBy.push("user_not_opted_in");
  }

  return { wouldSend: blockedBy.length === 0, blockedBy };
}

function isUserOptedIn(type: ProactiveMessageType, settings: NotificationSettings): boolean {
  if (type === "morning_brief") return settings.morningBriefEnabled;
  if (type === "evening_checkin") return settings.eveningCheckinEnabled;
  return settings.gmailNudgeEnabled;
}
