import type { StoredEvent } from "@operator-agent/core";

/**
 * Generic guardrail-event classifier extracted from apps/api/src/server.ts,
 * where it was used both by the operator-reflection context builder (stays
 * in server.ts) and the legacy weekly-review cluster
 * (apps/api/src/legacy/weekly-review-conversation.ts), which also needs it.
 */
export function isGuardrailEvent(event: StoredEvent): boolean {
  return /finance\.betting|finance\.trading|cooldown|large_bet|large_loss/i.test(event.type);
}
