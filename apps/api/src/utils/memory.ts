import type { MemoryEntry } from "@operator-agent/core";
import { getActiveMemories } from "@operator-agent/db";

/**
 * Generic operator-reflection memory classifier extracted from
 * apps/api/src/server.ts, where it was used both by the operator-reflection
 * context builder (stays in server.ts) and the legacy weekly-review cluster
 * (apps/api/src/legacy/weekly-review-conversation.ts), which also needs it.
 */
export function isOperatorReflectionMemory(memory: MemoryEntry): boolean {
  return memory.status === "active" && memory.data?.kind === "operator_reflection";
}

/**
 * Loads a user's active operator-reflection memories, extracted from
 * apps/api/src/server.ts, where it was used both by the operator-reflection
 * context builder (stays in server.ts, e.g. archiveOperatorReflection) and
 * the legacy daily-brief cluster
 * (apps/api/src/operator/attention.ts's generateDailyOperatorBrief), which
 * also needs it.
 */
export async function getActiveOperatorReflections(userId: string): Promise<MemoryEntry[]> {
  return (await getActiveMemories(userId))
    .filter(isOperatorReflectionMemory)
    .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
}
