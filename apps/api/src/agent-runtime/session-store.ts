import { getAgentConversationSession, upsertAgentConversationSession } from "@operator-agent/db";
import type {
  AgentEntity,
  AgentFocusedEntities,
  AgentMutationRecord,
  AgentPendingOperation,
  AgentSessionMessage,
  AgentSessionState,
  DeferredCapabilityProposal,
  ValidatedOperation
} from "./types.js";

/**
 * Sliding TTL for the whole session (topic, pending confirmation, visible
 * entities, recent mutations, message history) — refreshed on every saved
 * turn. An expired row is treated as if it never existed: a stale pending
 * confirmation must never survive past this window, even though the row
 * itself may still physically exist in the DB until a cleanup job runs.
 */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export function emptySession(userId: string, channel: string): AgentSessionState {
  return {
    userId,
    channel,
    messages: [],
    topic: null,
    pendingOperation: null,
    visibleEntities: [],
    focusedEntities: {},
    recentMutations: [],
    deferredCapabilityProposals: []
  };
}

/** Loads the persisted session for (userId, channel), or a fresh empty one if missing/expired. */
export async function loadPersistedSession(userId: string, channel: string): Promise<AgentSessionState> {
  const row = await getAgentConversationSession(userId, channel);

  if (!row) {
    return emptySession(userId, channel);
  }

  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
    return emptySession(userId, channel);
  }

  return {
    userId,
    channel,
    topic: typeof row.topic === "string" ? row.topic : null,
    pendingOperation: asPendingOperation(row.pendingOperation),
    visibleEntities: asEntityArray(row.visibleEntities),
    focusedEntities: asFocusedEntities(row.focusedEntities),
    recentMutations: asMutationArray(row.recentMutations),
    messages: asMessageArray(row.messages),
    deferredCapabilityProposals: asDeferredCapabilityProposalArray(row.deferredCapabilityProposals)
  };
}

/** Persists the given session state, refreshing its 24h sliding TTL. */
export async function persistSession(session: AgentSessionState): Promise<void> {
  await upsertAgentConversationSession(session.userId, session.channel, {
    topic: session.topic,
    focusedEntities: session.focusedEntities,
    pendingOperation: session.pendingOperation,
    visibleEntities: session.visibleEntities,
    recentMutations: session.recentMutations,
    messages: session.messages,
    deferredCapabilityProposals: session.deferredCapabilityProposals,
    expiresAt: new Date(Date.now() + SESSION_TTL_MS)
  });
}

// --- Defensive parsing of round-tripped JSON columns ---------------------
// This data was always written by persistSession() above, so a light
// structural check (not full schema validation) is enough: it exists purely
// to fail safe (empty/null) against a corrupted or manually-edited row
// rather than to validate an external/untrusted input source.

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function asEntityArray(value: unknown): AgentEntity[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (item): item is AgentEntity => isRecord(item) && typeof item.id === "string" && typeof item.type === "string" && typeof item.label === "string"
  );
}

function isAgentEntity(value: unknown): value is AgentEntity {
  return isRecord(value) && typeof value.id === "string" && typeof value.type === "string" && typeof value.label === "string";
}

function asFocusedEntities(value: unknown): AgentFocusedEntities {
  if (!isRecord(value)) {
    return {};
  }
  const result: AgentFocusedEntities = {};
  for (const [type, entity] of Object.entries(value)) {
    if (isAgentEntity(entity) && entity.type === type) {
      result[entity.type] = entity;
    }
  }
  return result;
}

function asMutationArray(value: unknown): AgentMutationRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is AgentMutationRecord => isRecord(item) && typeof item.summary === "string" && typeof item.at === "string");
}

function asMessageArray(value: unknown): AgentSessionMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (item): item is AgentSessionMessage =>
      isRecord(item) && (item.role === "user" || item.role === "assistant") && typeof item.text === "string" && typeof item.at === "string"
  );
}

function asDeferredCapabilityProposalArray(value: unknown): DeferredCapabilityProposal[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (item): item is DeferredCapabilityProposal =>
      isRecord(item) && typeof item.proposalId === "string" && typeof item.goalId === "string" && typeof item.decidedAt === "string"
  );
}

function asValidatedOperation(value: unknown): ValidatedOperation | null {
  if (!isRecord(value) || typeof value.tool !== "string" || typeof value.status !== "string" || !isRecord(value.args)) {
    return null;
  }
  return value as unknown as ValidatedOperation;
}

function asPendingOperation(value: unknown): AgentPendingOperation | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.topic !== "string" ||
    typeof value.summary !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.expiresAt !== "string" ||
    !Array.isArray(value.operations)
  ) {
    return null;
  }

  const operations = value.operations.map(asValidatedOperation).filter((op): op is ValidatedOperation => op !== null);

  if (operations.length === 0) {
    return null;
  }

  return {
    id: value.id,
    topic: value.topic,
    summary: value.summary,
    createdAt: value.createdAt,
    expiresAt: value.expiresAt,
    operations
  };
}
