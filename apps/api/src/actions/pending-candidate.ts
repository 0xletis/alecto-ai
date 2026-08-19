import { isRecord } from "../utils/records.js";
import { formatLocalDateTime } from "../utils/datetime.js";
import { normalizeComparableText, ordinalSelectionIndex } from "../utils/text.js";
import type { ActionHygieneOption } from "../server-types.js";

/**
 * Shared "pending action candidate" selection/formatting layer, extracted
 * from apps/api/src/server.ts. Used by more than one legacy pending-decision
 * cluster — the action-hygiene natural-language reply parser
 * (apps/api/src/legacy/action-hygiene-conversation.ts) and server.ts's own
 * action_target_clarification handling (inside resolvePendingDecisionReply
 * and the conversational action-control flow) — so it lives here as its own
 * small shared module rather than inside the hygiene-specific module, which
 * would force server.ts to import hygiene-specific code for a
 * non-hygiene-specific need.
 */

export type PendingActionCandidate = {
  id: string;
  title: string;
  status: string;
  dueAt?: string;
  snoozedUntil?: string;
  goalId?: string;
  goalTitleSnapshot?: string;
  recommendedOptions?: ActionHygieneOption[];
};

export function toPendingActionCandidate(action: {
  id: string;
  title: string;
  status: string;
  dueAt?: Date | null;
  snoozedUntil?: Date | null;
  goalId?: string | null;
  goalTitleSnapshot?: string | null;
}): PendingActionCandidate {
  return {
    id: action.id,
    title: action.title,
    status: action.status,
    dueAt: action.dueAt?.toISOString(),
    snoozedUntil: action.snoozedUntil?.toISOString(),
    goalId: action.goalId ?? undefined,
    goalTitleSnapshot: action.goalTitleSnapshot ?? undefined
  };
}

export function formatPendingActionCandidate(action: PendingActionCandidate, timezone = "Europe/Madrid"): string {
  const due = action.dueAt ? ` - due ${formatLocalDateTime(new Date(action.dueAt), timezone)}` : "";
  const snoozed = action.snoozedUntil ? ` - snoozed until ${formatLocalDateTime(new Date(action.snoozedUntil), timezone)}` : "";
  return `${action.title}${due}${snoozed}`;
}

export function comparePendingActionCandidates(left: PendingActionCandidate, right: PendingActionCandidate): number {
  const leftTime = left.dueAt ? new Date(left.dueAt).getTime() : Number.POSITIVE_INFINITY;
  const rightTime = right.dueAt ? new Date(right.dueAt).getTime() : Number.POSITIVE_INFINITY;

  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  return left.title.localeCompare(right.title);
}
export function readPendingActionCandidates(value: unknown): PendingActionCandidate[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isRecord)
    .map((item) => ({
      id: typeof item.id === "string" ? item.id : "",
      title: typeof item.title === "string" ? item.title : "",
      status: typeof item.status === "string" ? item.status : "",
      dueAt: typeof item.dueAt === "string" ? item.dueAt : undefined,
      snoozedUntil: typeof item.snoozedUntil === "string" ? item.snoozedUntil : undefined,
      goalId: typeof item.goalId === "string" ? item.goalId : undefined,
      goalTitleSnapshot: typeof item.goalTitleSnapshot === "string" ? item.goalTitleSnapshot : undefined,
      recommendedOptions: readActionHygieneOptions(item.recommendedOptions)
    }))
    .filter((item) => item.id && item.title);
}

export function readActionHygieneOptions(value: unknown): ActionHygieneOption[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const options = value.filter((option): option is ActionHygieneOption =>
    option === "complete" || option === "snooze" || option === "archive" || option === "keep"
  );

  return options.length > 0 ? options : undefined;
}

export function selectPendingActionCandidate(message: string, candidates: PendingActionCandidate[]): PendingActionCandidate | undefined {
  const trimmed = message.trim();
  if (candidates.length === 1 && /^(it|that|this|them|those|one|the one|este|esta|eso|ese|esa|aquest|aquesta|ho)$/i.test(trimmed)) {
    return candidates[0];
  }

  const numeric = trimmed.match(/^(?:number\s+)?#?(\d+)$/i);

  if (numeric) {
    const index = Number(numeric[1]) - 1;
    return candidates[index];
  }

  const ordinalIndex = ordinalSelectionIndex(trimmed);

  if (ordinalIndex !== undefined) {
    return candidates[ordinalIndex];
  }

  const key = normalizeActionReferenceText(trimmed);

  if (!key) {
    return undefined;
  }

  const exactMatches = candidates.filter((candidate) => {
    const titleKey = normalizeActionReferenceText(candidate.title);
    return titleKey === key || titleKey.includes(key) || key.includes(titleKey);
  });

  if (exactMatches.length === 1) {
    return exactMatches[0];
  }

  const scored = candidates
    .map((candidate) => ({ candidate, score: scorePendingActionCandidateReference(key, candidate) }))
    .filter((item) => item.score >= 0.5)
    .sort((left, right) => right.score - left.score);

  if (scored.length === 0) {
    return undefined;
  }

  if (scored.length === 1 || scored[0].score - scored[1].score >= 0.18) {
    return scored[0].candidate;
  }

  return undefined;
}

export function normalizeActionReferenceText(value: string): string {
  return normalizeComparableText(value)
    .replace(/\b(the|this|that|those|these|one|ones|task|tasks|action|actions|item|items|el|la|los|las|un|una|uno|de|del|dels|aquest|aquesta|aquell|aquella)\b/g, " ")
    .replace(/\bdev\b/g, "developer")
    .replace(/\bcv\b/g, "resume")
    .replace(/\byt\b/g, "youtube")
    .replace(/\s+/g, " ")
    .trim();
}

export function scorePendingActionCandidateReference(referenceKey: string, candidate: PendingActionCandidate): number {
  const titleKey = normalizeActionReferenceText(candidate.title);
  const goalKey = normalizeActionReferenceText(candidate.goalTitleSnapshot ?? "");
  const haystack = `${titleKey} ${goalKey}`.trim();

  if (!referenceKey || !haystack) {
    return 0;
  }

  if (titleKey === referenceKey || haystack === referenceKey) {
    return 1;
  }

  if (haystack.includes(referenceKey)) {
    return 0.9;
  }

  const referenceTokens = meaningfulActionReferenceTokens(referenceKey);
  const haystackTokens = meaningfulActionReferenceTokens(haystack);

  if (referenceTokens.length === 0 || haystackTokens.length === 0) {
    return 0;
  }

  const matched = referenceTokens.filter((token) =>
    haystackTokens.some((candidateToken) => token === candidateToken || token.length >= 4 && candidateToken.startsWith(token) || candidateToken.length >= 4 && token.startsWith(candidateToken))
  );

  return matched.length / referenceTokens.length;
}

export function meaningfulActionReferenceTokens(value: string): string[] {
  return value
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !/^(to|for|with|and|you|can|please|pls|done|complete|archive|delete|remove|snooze|keep|review|write|check|send|apply)$/.test(token));
}

