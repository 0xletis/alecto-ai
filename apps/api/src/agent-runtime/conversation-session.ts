import { loadPersistedSession, persistSession } from "./session-store.js";
import type { AgentEntity, AgentPendingOperation, AgentSessionState } from "./types.js";

/**
 * Agent Runtime v3's conversation/session state, persisted via
 * AgentConversationSession (packages/db/prisma/schema.prisma). One session
 * object is loaded once at the start of a turn (loadSession), mutated
 * in-place synchronously through the turn via the setters below — exactly
 * like the old in-memory design, just operating on the loaded object
 * instead of a global Map — and written back once at the end of the turn
 * (saveSession). session-store.ts owns the actual DB round-trip and JSON
 * mapping; nothing here talks to Prisma directly.
 */

const MAX_MESSAGES = 20;
const MAX_MUTATIONS = 10;

export async function loadSession(userId: string, channel: string): Promise<AgentSessionState> {
  return loadPersistedSession(userId, channel);
}

export async function saveSession(session: AgentSessionState): Promise<void> {
  await persistSession(session);
}

export function appendMessage(session: AgentSessionState, role: "user" | "assistant", text: string): void {
  session.messages.push({ role, text, at: new Date().toISOString() });

  if (session.messages.length > MAX_MESSAGES) {
    session.messages = session.messages.slice(-MAX_MESSAGES);
  }
}

export function setTopic(session: AgentSessionState, topic: string | null): void {
  session.topic = topic;
}

export function setPendingOperation(session: AgentSessionState, pendingOperation: AgentPendingOperation | null): void {
  session.pendingOperation = pendingOperation;
}

export function createPendingOperationRecord(
  topic: string,
  summary: string,
  operations: AgentPendingOperation["operations"]
): AgentPendingOperation {
  const now = Date.now();

  return {
    id: `agent-pending-${now}-${Math.round(Math.random() * 1_000_000)}`,
    topic,
    summary,
    operations: stripUndefinedValues(operations) as AgentPendingOperation["operations"],
    createdAt: new Date(now).toISOString(),
    // Informational only — actual expiry is enforced at the session level (see
    // session-store.ts's 24h sliding TTL), not by this per-pending-operation field.
    expiresAt: new Date(now).toISOString()
  };
}

function stripUndefinedValues(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripUndefinedValues);
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) {
        result[key] = stripUndefinedValues(entry);
      }
    }
    return result;
  }

  return value;
}

export function setVisibleEntities(session: AgentSessionState, entities: AgentEntity[]): void {
  session.visibleEntities = entities;
}

export function recordMutation(session: AgentSessionState, summary: string): void {
  session.recentMutations.unshift({ summary, at: new Date().toISOString() });

  if (session.recentMutations.length > MAX_MUTATIONS) {
    session.recentMutations = session.recentMutations.slice(0, MAX_MUTATIONS);
  }
}
