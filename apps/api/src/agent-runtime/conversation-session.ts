import { loadPersistedSession, persistSession } from "./session-store.js";
import type { AgentEntity, AgentPendingOperation, AgentSessionState, DeferredCapabilityProposal } from "./types.js";

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
const MAX_DEFERRED_CAPABILITY_PROPOSALS = 20;

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

/**
 * fix/private-alpha-conversation-kernel-context-routing: a real reported bug — "show my actions"
 * (visibleEntities: 1 action) followed by "show my goal progress" (goal.status's own executed op
 * sets entities: [the one matched goal] — no action entities at all) used to WIPE OUT the action
 * from session.visibleEntities entirely, because this function was a wholesale replace: `session.
 * visibleEntities = entities`. The very next "complete the open action"/"complete action 1" then
 * had nothing to resolve against ("I only showed 0 actions") even though the action was still
 * real, open, and had been shown just two turns ago. Now merges PER TYPE instead: only entity
 * types actually present in this turn's `entities` get replaced; every other type's previously
 * surfaced entities (a numbered action list, a Gmail review list, ...) survives untouched — each
 * surface (action/gmail_review/goal/...) keeps its own last-shown list independently, matching
 * how session.focusedEntities (a single entity per type) already behaved. Each entity is stamped
 * with `surfacedAt` here (never by callers) so mostRecentVisibleSurfaceType can tell which surface
 * the user actually saw most recently when a reply like "remove all" doesn't name one explicitly.
 */
export function setVisibleEntities(session: AgentSessionState, entities: AgentEntity[]): void {
  const surfacedAt = new Date().toISOString();
  const stamped = entities.map((entity) => ({ ...entity, surfacedAt }));
  const incomingTypes = new Set(stamped.map((entity) => entity.type));
  const preserved = session.visibleEntities.filter((entity) => !incomingTypes.has(entity.type));
  session.visibleEntities = [...preserved, ...stamped];
}

/**
 * A genuine full reset — every type, not just one. Calling setVisibleEntities(session, []) would
 * NOT do this under its own per-type-merge semantics above (an empty `entities` array names no
 * types to replace, so it would preserve everything, the opposite of a reset) — this is the
 * explicit, separate primitive for the few real "wipe all visible-entity context" moments (e.g.
 * cancelling a pending operation whose entities were specific to that now-abandoned flow).
 */
export function clearAllVisibleEntities(session: AgentSessionState): void {
  session.visibleEntities = [];
}

/**
 * The AgentEntity type most recently surfaced (highest surfacedAt) across every type currently in
 * session.visibleEntities — "which surface did the user actually see last," used to resolve an
 * ambiguous bare "remove all"/"reject all" (no explicit "actions"/"reviews"/"mail" qualifier)
 * against the right one instead of whichever type happens to still have entries in the array.
 * Entities persisted before this field existed (surfacedAt absent) sort last, never first.
 */
export function mostRecentVisibleSurfaceType(session: AgentSessionState): AgentEntity["type"] | undefined {
  let bestType: AgentEntity["type"] | undefined;
  let bestAt = "";
  for (const entity of session.visibleEntities) {
    const at = entity.surfacedAt ?? "";
    if (at > bestAt) {
      bestAt = at;
      bestType = entity.type;
    }
  }
  return bestType;
}

/**
 * Targeted removal, deliberately NOT a setVisibleEntities wholesale replace — a single archived
 * or completed action shouldn't blow away the rest of an otherwise-still-valid numbered list (a
 * fresh action.list already replaces the whole set correctly when that's actually what happened).
 * fix/private-alpha-action-state-consistency: without this, a mutated action's own entity stayed
 * in session.visibleEntities untouched, so a later bare "it"/index reference could resolve back to
 * an action that was already archived/completed — see executor.ts's action.archive/action.complete
 * cases (which set ExecutedOperation.removedEntityIds) for the real reported bug this closes.
 */
export function removeVisibleEntities(session: AgentSessionState, ids: readonly string[]): void {
  if (ids.length === 0) {
    return;
  }
  const idSet = new Set(ids);
  session.visibleEntities = session.visibleEntities.filter((entity) => !idSet.has(entity.id));
}

export function recordMutation(session: AgentSessionState, summary: string): void {
  session.recentMutations.unshift({ summary, at: new Date().toISOString() });

  if (session.recentMutations.length > MAX_MUTATIONS) {
    session.recentMutations = session.recentMutations.slice(0, MAX_MUTATIONS);
  }
}

/**
 * fix/private-alpha-launch-hardening-flakes-and-pending-clarity: records that the user explicitly
 * declined/deferred one capability proposal for one goal — "not now"/"cancel" on the whole queue,
 * or picking only a different subset. A plain marker, never a scheduler: it carries no re-offer
 * timer of its own, just a fact goal.create_apply can check before building its next proposal list
 * (see wasCapabilityProposalRecentlyDeferred below). Replaces any EXISTING marker for the same
 * (proposalId, goalId) pair rather than accumulating duplicates, so "decidedAt" always reflects the
 * user's most recent answer.
 */
export function recordDeferredCapabilityProposal(session: AgentSessionState, proposalId: string, goalId: string): void {
  const withoutExisting = session.deferredCapabilityProposals.filter((entry) => !(entry.proposalId === proposalId && entry.goalId === goalId));
  const entry: DeferredCapabilityProposal = { proposalId, goalId, decidedAt: new Date().toISOString() };
  session.deferredCapabilityProposals = [entry, ...withoutExisting].slice(0, MAX_DEFERRED_CAPABILITY_PROPOSALS);
}

/**
 * True only when the user was already asked about this exact (proposalId, goalId) pair earlier in
 * this SAME session and declined/deferred it — never a permanent block (there is no "never ask
 * again" marker here at all; that would need an explicit, separate, much stronger signal). An
 * explicit direct request for the capability (e.g. "turn on daily coaching") never consults this at
 * all — only the automatic post-goal-creation offer in goal.create_apply does.
 */
export function wasCapabilityProposalRecentlyDeferred(session: AgentSessionState, proposalId: string, goalId: string): boolean {
  return session.deferredCapabilityProposals.some((entry) => entry.proposalId === proposalId && entry.goalId === goalId);
}
