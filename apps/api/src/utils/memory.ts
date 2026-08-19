import type { MemoryEntry } from "@operator-agent/core";

/**
 * Generic operator-reflection memory classifier extracted from
 * apps/api/src/server.ts, where it was used both by the operator-reflection
 * context builder (stays in server.ts) and the legacy weekly-review cluster
 * (apps/api/src/legacy/weekly-review-conversation.ts), which also needs it.
 */
export function isOperatorReflectionMemory(memory: MemoryEntry): boolean {
  return memory.status === "active" && memory.data?.kind === "operator_reflection";
}
