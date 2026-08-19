/**
 * Developer-facing rollout controls for Agent Runtime v3's Proactive Operator MVP —
 * PROACTIVE_OPERATOR_DELIVERY_ENABLED (global kill switch) and PROACTIVE_OPERATOR_ALLOWLIST
 * (dev/testing rollout allowlist). Deliberately NOT the product-level consent mechanism — that's
 * NotificationSettings.morningBriefEnabled/eveningCheckinEnabled/gmailNudgeEnabled, a genuine
 * per-user opt-in. Both apps/worker (the actual sender) and apps/api (the preview route, for
 * accurate wouldSend/blockedBy reporting) need to read the exact same two env vars the exact
 * same way, so this lives in @operator-agent/core rather than being duplicated in each app.
 */

export function proactiveOperatorDeliveryEnabledFromEnv(): boolean {
  return process.env.PROACTIVE_OPERATOR_DELIVERY_ENABLED === "true";
}

export function proactiveOperatorAllowlistFromEnv(): (userId: string) => boolean {
  const raw = process.env.PROACTIVE_OPERATOR_ALLOWLIST;
  if (!raw || !raw.trim()) {
    return () => true;
  }
  const allowed = new Set(
    raw
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean)
  );
  return (userId: string) => allowed.has(userId);
}
