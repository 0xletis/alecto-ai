/**
 * Developer-facing rollout controls for Agent Runtime v3's Proactive Operator MVP —
 * PROACTIVE_OPERATOR_DELIVERY_ENABLED (global kill switch) and PROACTIVE_OPERATOR_ALLOWLIST
 * (OPTIONAL dev/testing rollout limiter — see below). Deliberately NOT the product-level consent
 * mechanism — that's NotificationSettings.morningBriefEnabled/eveningCheckinEnabled/
 * gmailNudgeEnabled, a genuine per-user opt-in, which remains the main safety layer for the
 * current solo/dev phase with no real users yet. Both apps/worker (the actual sender) and
 * apps/api (the preview route, for accurate wouldSend/blockedBy reporting) need to read the
 * exact same two env vars the exact same way, so this lives in @operator-agent/core rather than
 * being duplicated in each app.
 *
 * Rollout control model (product decision, docs/10-v3-readiness-audit.md §19):
 * - PROACTIVE_OPERATOR_DELIVERY_ENABLED is the global kill switch — required "true" for any real
 *   send, full stop.
 * - Per-user opt-in (morningBriefEnabled etc.) is the actual product consent — required.
 * - PROACTIVE_OPERATOR_ALLOWLIST is now OPTIONAL, not a required blocker: unset/empty means "do
 *   not further restrict delivery" (every opted-in user is eligible once the kill switch is on).
 *   When set, it's an ADDITIONAL narrowing limiter for controlled rollout — only listed users are
 *   eligible even if opted in.
 *
 * fix/private-alpha-launch-config-sanity: PROACTIVE_OPERATOR_DELIVERY_ENABLED left UNSET on one
 * Railway service was a real production incident (a fully opted-in tester's morning brief never
 * sent, with zero visibility) — this now defaults ON when genuinely unset in production
 * (NODE_ENV=production), via resolveProductionDefaultedFlag. An explicit "true"/"false" always
 * still wins on every environment; local dev/test keep defaulting OFF exactly as before.
 */

import { resolveProductionDefaultedFlag } from "./env-flags.js";

export function proactiveOperatorDeliveryEnabledFromEnv(): boolean {
  return resolveProductionDefaultedFlag(process.env.PROACTIVE_OPERATOR_DELIVERY_ENABLED, true);
}

/** True when PROACTIVE_OPERATOR_ALLOWLIST is actually configured (non-empty) — lets callers
 * report "no allowlist active" as a neutral fact, distinct from "allowlist active and excludes
 * this user," rather than collapsing both into one boolean. */
export function proactiveOperatorAllowlistActiveFromEnv(): boolean {
  const raw = process.env.PROACTIVE_OPERATOR_ALLOWLIST;
  return Boolean(raw && raw.trim());
}

/** A bare Telegram numeric id (e.g. "520894688") is normalized to the internal userId format
 * ("telegram:520894688") so a developer can list either form in PROACTIVE_OPERATOR_ALLOWLIST and
 * have it match — the internal userId format isn't something anyone should have to know to
 * configure this. Any other form (already prefixed, or a non-Telegram userId shape) passes
 * through unchanged. */
export function normalizeProactiveAllowlistId(rawId: string): string {
  const trimmed = rawId.trim();
  return /^\d+$/.test(trimmed) ? `telegram:${trimmed}` : trimmed;
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
      .map(normalizeProactiveAllowlistId)
  );
  return (userId: string) => allowed.has(userId);
}
