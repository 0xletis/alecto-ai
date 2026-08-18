import type { AgentEntity, AgentPendingOperation, AgentSessionState } from "./types.js";

/**
 * Agent Runtime v3 has no dedicated conversation-history table yet (the only
 * legacy analog, PendingAction, is a single-row-per-user confirmation slot,
 * not a message log). This in-memory store is an intentional spike shortcut:
 * state does not survive a process restart and is not shared across API
 * instances. See agent-runtime limitations in the route's README notes.
 */
const sessions = new Map<string, AgentSessionState>();

const MAX_MESSAGES = 20;
const MAX_MUTATIONS = 10;
const PENDING_OPERATION_TTL_MS = 15 * 60 * 1000;

function emptySession(userId: string): AgentSessionState {
  return {
    userId,
    messages: [],
    topic: null,
    pendingOperation: null,
    visibleEntities: [],
    recentMutations: []
  };
}

export function getSession(userId: string): AgentSessionState {
  let session = sessions.get(userId);

  if (!session) {
    session = emptySession(userId);
    sessions.set(userId, session);
  }

  if (session.pendingOperation && new Date(session.pendingOperation.expiresAt).getTime() < Date.now()) {
    session.pendingOperation = null;
  }

  return session;
}

export function appendMessage(userId: string, role: "user" | "assistant", text: string): void {
  const session = getSession(userId);
  session.messages.push({ role, text, at: new Date().toISOString() });

  if (session.messages.length > MAX_MESSAGES) {
    session.messages = session.messages.slice(-MAX_MESSAGES);
  }
}

export function setTopic(userId: string, topic: string | null): void {
  getSession(userId).topic = topic;
}

export function setPendingOperation(userId: string, pendingOperation: AgentPendingOperation | null): void {
  getSession(userId).pendingOperation = pendingOperation;
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
    operations,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + PENDING_OPERATION_TTL_MS).toISOString()
  };
}

export function setVisibleEntities(userId: string, entities: AgentEntity[]): void {
  getSession(userId).visibleEntities = entities;
}

export function recordMutation(userId: string, summary: string): void {
  const session = getSession(userId);
  session.recentMutations.unshift({ summary, at: new Date().toISOString() });

  if (session.recentMutations.length > MAX_MUTATIONS) {
    session.recentMutations = session.recentMutations.slice(0, MAX_MUTATIONS);
  }
}

/** Test-only: clears all in-memory session state. */
export function resetAllSessions(): void {
  sessions.clear();
}
