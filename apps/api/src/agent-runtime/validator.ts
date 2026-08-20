import { parseActionDueDate } from "@operator-agent/core";
import type { EmailSignalRule } from "@operator-agent/db";
import { selectEmailRuleCandidate, type EmailRuleSelectionCandidate } from "../conversation/email-rule-selection.js";
import { computeLighterPlanRemoval, readPendingNextWeekPlanSuggestions, resolvePlanSuggestionRef } from "../planning/next-week.js";
import type { NextWeekPlanSuggestion } from "../server-types.js";
import { getToolDefinition } from "./tool-catalog.js";
import type { AgentEntity, ContextBundle, PlannedOperation, ValidatedOperation } from "./types.js";

const ACTION_REFERENCE_TOOLS = new Set(["action.snooze", "action.complete", "action.archive"]);
const GMAIL_REVIEW_REFERENCE_TOOLS = new Set(["gmail.review.reject", "gmail.review.to_action", "gmail.review.approve"]);

export function validateOperations(operations: PlannedOperation[], context: ContextBundle): ValidatedOperation[] {
  return operations.map((operation) => validateOperation(operation, context));
}

function validateOperation(operation: PlannedOperation, context: ContextBundle): ValidatedOperation {
  const tool = getToolDefinition(operation.tool);

  if (!tool) {
    return {
      tool: operation.tool,
      args: {},
      status: "unsupported",
      requiresConfirmation: false,
      error: `"${operation.tool}" isn't something I can do yet`,
      rationale: operation.rationale
    };
  }

  if (typeof operation.args !== "object" || operation.args === null || Array.isArray(operation.args)) {
    return {
      tool: tool.name,
      args: {},
      status: "invalid",
      requiresConfirmation: false,
      error: "the planner returned malformed arguments",
      rationale: operation.rationale
    };
  }

  const parsed = tool.argsSchema.safeParse(stripNulls(operation.args));
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join(".") || "argument").join(", ");
    return {
      tool: tool.name,
      args: {},
      status: "invalid",
      requiresConfirmation: false,
      error: `the plan was missing required details (needs: ${fields})`,
      rationale: operation.rationale
    };
  }

  const args = parsed.data as Record<string, unknown>;

  if (ACTION_REFERENCE_TOOLS.has(tool.name) && !args.actionId) {
    const resolution = resolveSingleVisibleEntity(context.session.visibleEntities, "action");

    if (resolution.status === "resolved") {
      args.actionId = resolution.entity.id;
    } else if (resolution.status === "none") {
      return {
        tool: tool.name,
        args,
        status: "needs_clarification",
        requiresConfirmation: false,
        clarificationQuestion: "Which task do you mean? I don't have one in view right now.",
        rationale: operation.rationale
      };
    } else {
      return {
        tool: tool.name,
        args,
        status: "needs_clarification",
        requiresConfirmation: false,
        clarificationQuestion: "I see more than one task that could match — which one did you mean?",
        rationale: operation.rationale
      };
    }
  }

  if (tool.name === "action.hygiene_apply") {
    const resolution = resolveHygieneApplySelections(args.selections as HygieneApplySelectionArgs[], context);

    if (resolution.status === "needs_clarification") {
      return {
        tool: tool.name,
        args,
        status: "needs_clarification",
        requiresConfirmation: false,
        clarificationQuestion: resolution.question,
        rationale: operation.rationale
      };
    }

    args.selections = resolution.selections;
  }

  if (GMAIL_REVIEW_REFERENCE_TOOLS.has(tool.name) && !args.reviewId) {
    const resolution = resolveGmailReviewRef(args as { index?: number; ref?: string }, context);

    if (resolution.status === "needs_clarification") {
      return {
        tool: tool.name,
        args,
        status: "needs_clarification",
        requiresConfirmation: false,
        clarificationQuestion: resolution.question,
        rationale: operation.rationale
      };
    }

    args.reviewId = resolution.reviewId;
  }

  if (tool.name === "planning.next_week_edit" || tool.name === "planning.next_week_show_current") {
    const pendingApplyOp = context.session.pendingOperation?.operations[0];
    const openDraft = pendingApplyOp?.tool === "planning.next_week_apply";

    if (!openDraft) {
      return {
        tool: tool.name,
        args,
        status: "needs_clarification",
        requiresConfirmation: false,
        clarificationQuestion: 'I don\'t have a draft plan open right now. Say "plan next week" to see one.',
        rationale: operation.rationale
      };
    }
  }

  if (tool.name === "planning.next_week_edit") {
    // openDraft was already confirmed above; re-read here so TypeScript can narrow it back
    // from ContextBundle without an extra cast.
    const pendingApplyOp = context.session.pendingOperation!.operations[0];
    const current = readPendingNextWeekPlanSuggestions(pendingApplyOp.args.selections);
    const resolution = resolveNextWeekEditArgs(args, current);

    if (resolution.status === "needs_clarification") {
      return {
        tool: tool.name,
        args,
        status: "needs_clarification",
        requiresConfirmation: false,
        clarificationQuestion: resolution.question,
        rationale: operation.rationale
      };
    }

    // Rewrite to the executor's plain, pre-resolved shape — every index below is
    // guaranteed to exist in `current` and every natural ref has already been resolved to
    // one. The executor never re-resolves anything itself, so an invalid/ambiguous/unknown
    // reference can never partially apply: this whole operation is "needs_clarification"
    // instead, and nothing about it reaches the executor or touches session state.
    args.removeIndexes = resolution.removeIndexes;
    args.changes = resolution.changes;
  }

  // planning.next_week_apply is never planned by the LLM directly — it only ever runs via the
  // deterministic confirm whitelist re-executing an already-stored pendingOperation
  // (finalizeDeterministicConfirmation calls revalidateForExecution, not validateOperation, so
  // this check never blocks the real confirm path). This guards against a fresh LLM plan that
  // tries to invoke it directly with fabricated args and have it execute immediately.
  if (tool.name === "planning.next_week_apply") {
    return {
      tool: tool.name,
      args,
      status: "invalid",
      requiresConfirmation: false,
      error: "this can only be run by confirming an open plan draft",
      rationale: operation.rationale
    };
  }

  // Same reasoning as planning.next_week_apply above: weekly_review.save is never planned by
  // the LLM directly, only ever reached via the deterministic confirm whitelist (an exact
  // "yes"/"save this review"/etc.) re-executing an already-stored pendingOperation. Its args
  // (weekStartLocalDate/timezone) are set by weekly_review.start's pendingOperationUpdate, not
  // guessed by the LLM — a direct plan would have no real values to put there anyway.
  if (tool.name === "weekly_review.save") {
    return {
      tool: tool.name,
      args,
      status: "invalid",
      requiresConfirmation: false,
      error: "this can only be run by confirming an open weekly review",
      rationale: operation.rationale
    };
  }

  // Same reasoning again: gmail.rule.apply_update is never planned by the LLM directly, only
  // ever reached via the deterministic confirm whitelist re-executing an already-stored
  // pendingOperation. Its args (ruleId/ruleName) are set by gmail.rule.propose_update's
  // pendingOperationUpdate after resolving the real rule — a direct plan would have no real
  // rule id to put there anyway.
  if (tool.name === "gmail.rule.apply_update") {
    return {
      tool: tool.name,
      args,
      status: "invalid",
      requiresConfirmation: false,
      error: "this can only be run by confirming a pending Gmail rule change",
      rationale: operation.rationale
    };
  }

  // Same reasoning again: daily_loop.settings_apply_update is never planned by the LLM
  // directly, only ever reached via the deterministic confirm whitelist re-executing an
  // already-stored pendingOperation. Its args are the fully-resolved values (minutes, not
  // text) set by daily_loop.settings_propose_update's pendingOperationUpdate.
  if (tool.name === "daily_loop.settings_apply_update") {
    return {
      tool: tool.name,
      args,
      status: "invalid",
      requiresConfirmation: false,
      error: "this can only be run by confirming a pending daily-loop settings change",
      rationale: operation.rationale
    };
  }

  if (tool.name === "daily_loop.settings_propose_update" && args.enabled === undefined && !args.morningTimeText && !args.eveningTimeText) {
    return {
      tool: tool.name,
      args,
      status: "needs_clarification",
      requiresConfirmation: false,
      clarificationQuestion: "What would you like to change — turn the daily loop on/off, the morning-brief time, or the evening-review time?",
      rationale: operation.rationale
    };
  }

  // Same reasoning as daily_loop.settings_apply_update above: never planned by the LLM
  // directly, only ever reached via the deterministic confirm whitelist re-executing an
  // already-stored pendingOperation set by proactive.settings_propose_update.
  if (tool.name === "proactive.settings_apply_update") {
    return {
      tool: tool.name,
      args,
      status: "invalid",
      requiresConfirmation: false,
      error: "this can only be run by confirming a pending proactive settings change",
      rationale: operation.rationale
    };
  }

  // Same reasoning again: goal.create_apply is never planned by the LLM directly, only ever
  // reached via the deterministic confirm whitelist re-executing an already-stored
  // pendingOperation set by goal.create_propose. This is the one place an LLM-proposed goal
  // operating plan actually becomes a real Goal row — it must never happen without an exact
  // user confirmation of the plan goal.create_propose already showed them.
  if (tool.name === "goal.create_apply") {
    return {
      tool: tool.name,
      args,
      status: "invalid",
      requiresConfirmation: false,
      error: "this can only be run by confirming a pending goal creation proposal",
      rationale: operation.rationale
    };
  }

  if (
    tool.name === "proactive.settings_propose_update" &&
    args.morningBriefEnabled === undefined &&
    args.eveningCheckinEnabled === undefined &&
    args.gmailNudgeEnabled === undefined &&
    !args.morningTimeText &&
    !args.eveningTimeText
  ) {
    return {
      tool: tool.name,
      args,
      status: "needs_clarification",
      requiresConfirmation: false,
      clarificationQuestion: "What would you like to change — the morning brief, the evening check-in, or the Gmail nudge?",
      rationale: operation.rationale
    };
  }

  // Gmail rule creation: if an equivalent rule already exists (active or paused), there is
  // nothing to confirm — asking "shall I create it?" would be misleading when it either
  // already exists or would just create a confusing duplicate. Skip the confirmation gate
  // entirely; the executor decides the honest "already active" / "paused" response.
  if (tool.name === "gmail.rule.create") {
    const existing = findExistingCustomGmailRule(context.gmailRules, String(args.label ?? ""));
    if (existing) {
      return {
        tool: tool.name,
        args,
        status: "valid",
        requiresConfirmation: false,
        rationale: operation.rationale
      };
    }
  }

  return {
    tool: tool.name,
    args,
    status: tool.requiresConfirmation ? "needs_confirmation" : "valid",
    requiresConfirmation: tool.requiresConfirmation,
    rationale: operation.rationale
  };
}

/** Same matching rule the gmail.rule.create executor uses to detect a duplicate. */
export function findExistingCustomGmailRule(rules: EmailSignalRule[], label: string): EmailSignalRule | undefined {
  const normalized = label.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  return rules.find(
    (rule) =>
      (rule.status === "active" || rule.status === "paused") &&
      rule.adapterId === "custom_email_review" &&
      rule.name.trim().toLowerCase() === normalized
  );
}

const ZERO_WIDTH_CHARS_RE = /[​-‍﻿]/g;

/**
 * Sanitizes planner-supplied args before they reach a tool's zod schema:
 * - OpenAI Structured Outputs represents an omitted optional field as an
 *   explicit JSON `null` (strict mode forbids omitting declared properties).
 *   Our zod schemas use `.optional()` (undefined-based), so a literal `null`
 *   would otherwise fail validation for a field the user simply didn't set.
 * - Strips zero-width characters and surrounding whitespace from string
 *   values — real LLM output has been observed to include these, which are
 *   invisible but corrupt exact-match comparisons and stored data.
 * Recurses into nested arrays/objects (e.g. action.hygiene_apply's
 * `selections` array of objects) so the same null-to-omitted normalization
 * applies at every level, not just the top-level args object.
 */
function stripNulls(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === null) continue;
    result[key] = sanitizeValue(value);
  }
  return result;
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(ZERO_WIDTH_CHARS_RE, "").trim();
  }
  if (Array.isArray(value)) {
    return value.map(sanitizeValue);
  }
  if (value && typeof value === "object") {
    return stripNulls(value as Record<string, unknown>);
  }
  return value;
}

/**
 * Re-checks an already-validated, previously-stored pending operation right
 * before it executes (e.g. on user confirmation). Args are already concrete
 * at this point (references like "it" were resolved when the operation was
 * first planned), so this only re-runs the tool's own schema check as a
 * defensive guard against stale/corrupted session state — it never re-does
 * entity resolution.
 */
export function revalidateForExecution(op: ValidatedOperation): ValidatedOperation {
  const tool = getToolDefinition(op.tool);

  if (!tool) {
    return { ...op, status: "unsupported", error: `"${op.tool}" isn't something I can do yet` };
  }

  const parsed = tool.argsSchema.safeParse(stripNulls(op.args));
  if (!parsed.success) {
    const fields = parsed.error.issues.map((issue) => issue.path.join(".") || "argument").join(", ");
    return { ...op, status: "invalid", error: `the plan was missing required details (needs: ${fields})` };
  }

  return { ...op, args: parsed.data as Record<string, unknown>, status: "valid" };
}

type EntityResolution =
  | { status: "resolved"; entity: AgentEntity }
  | { status: "none" }
  | { status: "ambiguous" };

function resolveSingleVisibleEntity(entities: AgentEntity[], type: AgentEntity["type"]): EntityResolution {
  const matches = entities.filter((entity) => entity.type === type);

  if (matches.length === 0) {
    return { status: "none" };
  }

  if (matches.length > 1) {
    return { status: "ambiguous" };
  }

  return { status: "resolved", entity: matches[0] };
}

export interface HygieneApplySelectionArgs {
  index?: number;
  actionId?: string;
  decision: string;
  snoozeUntilText?: string;
}

type HygieneApplyResolution =
  | { status: "resolved"; selections: HygieneApplySelectionArgs[] }
  | { status: "needs_clarification"; question: string };

/**
 * Resolves each action.hygiene_apply selection's actionId deterministically
 * against the session's ground-truth visible entities — never trusts a raw
 * index the LLM invented from its own memory of the conversation. A direct
 * actionId supplied by the planner is trusted as-is, matching the existing
 * precedent for action.snooze/complete/archive (which never cross-check a
 * provided actionId either).
 *
 * If every selection fails to resolve — most commonly because there is no
 * action-hygiene list currently visible in the session — the whole operation
 * asks for clarification and nothing executes. If at least one selection
 * resolves, the rest are passed through unresolved (actionId left unset) so
 * the executor can report them individually as skipped, the same way
 * applyActionHygieneBatchOperations already reports an operation whose
 * action "no longer exists".
 */
function resolveHygieneApplySelections(selections: HygieneApplySelectionArgs[], context: ContextBundle): HygieneApplyResolution {
  const resolved = selections.map((selection) => {
    if (selection.actionId) {
      return selection;
    }

    if (typeof selection.index === "number") {
      const entity = context.session.visibleEntities.find((item) => item.type === "action" && item.index === selection.index);
      if (entity) {
        return { ...selection, actionId: entity.id };
      }
    }

    return selection;
  });

  const anyResolved = resolved.some((selection) => Boolean(selection.actionId));

  if (!anyResolved) {
    return {
      status: "needs_clarification",
      question: 'I don\'t have an action-cleanup list in view right now. Say "clean up my actions" to see one, then tell me what to do with each.'
    };
  }

  return { status: "resolved", selections: resolved };
}

interface GmailReviewRefResolution {
  status: "resolved" | "needs_clarification";
  reviewId?: string;
  question?: string;
}

/**
 * Resolves a gmail.review.reject/to_action reference deterministically against the session's
 * ground-truth visible gmail_review entities (set by the most recent gmail.review.list) — never
 * against hidden LLM memory, and never a fresh DB lookup (unlike gmail.rule.propose_update),
 * since a review's identity here is only meaningful in the context of "the list you just showed
 * me." An explicit numeric index always wins; free-text ref reuses the same
 * exact/normalized-name-then-token-overlap matcher gmail-conversation.ts's legacy numbered-list
 * flow already relies on (selectEmailRuleCandidate), generic over any {id, name, status}
 * candidate shape.
 */
function resolveGmailReviewRef(args: { index?: number; ref?: string }, context: ContextBundle): GmailReviewRefResolution {
  const visibleReviews = context.session.visibleEntities.filter((entity) => entity.type === "gmail_review");

  if (visibleReviews.length === 0) {
    return {
      status: "needs_clarification",
      question: 'I don\'t have any Gmail reviews in view right now. Say "what emails need my attention?" to see them.'
    };
  }

  if (typeof args.index === "number") {
    const entity = visibleReviews.find((item) => item.index === args.index);
    if (entity) {
      return { status: "resolved", reviewId: entity.id };
    }
    return { status: "needs_clarification", question: `I don't see a #${args.index} in the list I just showed you — which one did you mean?` };
  }

  if (args.ref) {
    const candidates: EmailRuleSelectionCandidate[] = visibleReviews.map((entity) => ({ id: entity.id, name: entity.label, status: "pending" }));
    const selected = selectEmailRuleCandidate(args.ref, candidates);
    if (selected) {
      return { status: "resolved", reviewId: selected.id };
    }
    return { status: "needs_clarification", question: `I couldn't tell which email review "${args.ref}" refers to — which one did you mean?` };
  }

  return { status: "needs_clarification", question: "Which email review do you mean?" };
}

interface NextWeekEditChangeArgs {
  index?: number;
  ref?: string;
  dueText: string;
}

type NextWeekEditResolution =
  | { status: "resolved"; removeIndexes: number[]; changes: Array<{ index: number; dueAt: Date }> }
  | { status: "needs_clarification"; question: string };

/**
 * Deterministically resolves a whole planning.next_week_edit call — numbered
 * indexes, natural-language refs, keep-the-rest inversion, and "lighter" —
 * into a plain, pre-resolved shape the executor can apply without doing any
 * resolution itself. Atomic by design: EVERY index/ref in the request
 * (removeIndexes, removeRefs, changes[].index/ref, keepIndexes, keepRefs,
 * lighter) must resolve against the current draft, or the whole call becomes
 * "needs_clarification" and nothing is returned for partial application —
 * this is what makes "remove 1" with a bad/stale index safe: it can never
 * mutate the pending draft only partway, and a later "change 1 to Tuesday"
 * still sees the untouched original draft.
 */
function resolveNextWeekEditArgs(args: Record<string, unknown>, current: NextWeekPlanSuggestion[]): NextWeekEditResolution {
  const rawRemoveIndexes = (args.removeIndexes as number[] | undefined) ?? [];
  const removeRefs = (args.removeRefs as string[] | undefined) ?? [];
  const rawChanges = (args.changes as NextWeekEditChangeArgs[] | undefined) ?? [];
  const keepIndexes = (args.keepIndexes as number[] | undefined) ?? [];
  const keepRefs = (args.keepRefs as string[] | undefined) ?? [];
  const lighter = args.lighter === true;

  const nothingSpecified =
    rawRemoveIndexes.length === 0 &&
    removeRefs.length === 0 &&
    rawChanges.length === 0 &&
    keepIndexes.length === 0 &&
    keepRefs.length === 0 &&
    !lighter;

  if (nothingSpecified) {
    return {
      status: "needs_clarification",
      question: "What would you like to change about the plan — remove an item, change its day, or make it lighter?"
    };
  }

  const currentIndexes = new Set(current.map((suggestion) => suggestion.index));
  // Holds ready-made clarification questions, not raw tokens — the first one found is
  // returned verbatim, so each push site phrases its own failure precisely (unknown index vs.
  // unresolved ref vs. unparseable day all read differently to the user).
  const unresolved: string[] = [];
  const removeIndexes = new Set<number>();
  const changes: Array<{ index: number; dueAt: Date }> = [];
  const unknownIndex = (index: number) => unresolved.push(`There's no item ${index} in the current plan — say "yes" first to see the numbers, or describe the item in words.`);
  const unresolvedRef = (ref: string) => unresolved.push(`I couldn't match "${ref}" to one item in the current plan — could you say its number instead, or describe it differently?`);
  const unparseableDay = (dueText: string) => unresolved.push(`I couldn't understand the day "${dueText}" — try something like "Friday" or "Tuesday morning".`);

  for (const index of rawRemoveIndexes) {
    if (currentIndexes.has(index)) {
      removeIndexes.add(index);
    } else {
      unknownIndex(index);
    }
  }

  for (const ref of removeRefs) {
    const resolution = resolvePlanSuggestionRef(ref, current);
    if (resolution.status === "resolved") {
      removeIndexes.add(resolution.index);
    } else {
      unresolvedRef(ref);
    }
  }

  for (const change of rawChanges) {
    // Date parsing happens here, not in the executor, so a change with an unparseable day is
    // just as atomic as an unresolved index/ref — it fails the whole call via `unresolved`
    // rather than silently no-op-ing one item while the rest of the edit goes through.
    const parsedDueAt = parseActionDueDate(change.dueText).dueAt;

    // Exact index wins over a ref on the same entry (the schema asks for only one, but this
    // makes the precedence explicit and deterministic if both are ever set).
    if (typeof change.index === "number") {
      if (!currentIndexes.has(change.index)) {
        unknownIndex(change.index);
      } else if (!parsedDueAt) {
        unparseableDay(change.dueText);
      } else {
        changes.push({ index: change.index, dueAt: parsedDueAt });
      }
      continue;
    }
    if (change.ref) {
      const resolution = resolvePlanSuggestionRef(change.ref, current);
      if (resolution.status !== "resolved") {
        unresolvedRef(change.ref);
      } else if (!parsedDueAt) {
        unparseableDay(change.dueText);
      } else {
        changes.push({ index: resolution.index, dueAt: parsedDueAt });
      }
    }
  }

  if (keepIndexes.length > 0 || keepRefs.length > 0) {
    const keep = new Set<number>();
    for (const index of keepIndexes) {
      if (currentIndexes.has(index)) {
        keep.add(index);
      } else {
        unknownIndex(index);
      }
    }
    for (const ref of keepRefs) {
      const resolution = resolvePlanSuggestionRef(ref, current);
      if (resolution.status === "resolved") {
        keep.add(resolution.index);
      } else {
        unresolvedRef(ref);
      }
    }
    for (const suggestion of current) {
      if (!keep.has(suggestion.index)) {
        removeIndexes.add(suggestion.index);
      }
    }
  }

  if (lighter) {
    const reduction = computeLighterPlanRemoval(current);
    if (reduction.status === "unclear") {
      return {
        status: "needs_clarification",
        question: "I'm not confident which items to drop to make it lighter — tell me which one(s) to remove, or which day to keep light."
      };
    }
    for (const index of reduction.removeIndexes) {
      removeIndexes.add(index);
    }
  }

  if (unresolved.length > 0) {
    return { status: "needs_clarification", question: unresolved[0] };
  }

  // An explicit change to an item always wins over a remove of that SAME item, whatever
  // combination produced the conflict (a raw removeIndexes/removeRefs entry, keep-inversion,
  // or "lighter"). This is what real "move X to Y" turns need: live testing showed the
  // planner does not reliably follow the "never also list it in removeIndexes/removeRefs"
  // prompt instruction, and repeatedly sends a redundant remove for the exact item it's also
  // changing — rejecting the whole edit in that case (the previous behavior) made a plain
  // "move the jobs to Friday" permanently unusable on a single-item draft. You cannot
  // meaningfully both remove and change the same item, and "the user just told me the new
  // day for it" is the more specific, more recent signal of the two.
  for (const change of changes) {
    removeIndexes.delete(change.index);
  }

  // Guards against exactly the failure a real Telegram transcript surfaced: "move the jobs
  // to Friday" on a single-item draft got misinterpreted (or arrived alongside a stale
  // removeIndexes) such that removeIndexes covered the whole draft, silently emptying it
  // instead of changing its day. An edit that would remove every current item is rejected
  // unless the user explicitly asked to clear the whole plan (`removeAll: true`) — this is
  // checked on the FULLY merged removeIndexes (numeric + refs + keep-inversion + lighter),
  // not just the raw arg, so no path into this function can bypass it.
  if (removeIndexes.size >= current.length && args.removeAll !== true) {
    return {
      status: "needs_clarification",
      question:
        "That would remove everything in the plan. If you want to clear it completely, say so explicitly — otherwise tell me which item(s) to keep, or just the one to change."
    };
  }

  return { status: "resolved", removeIndexes: [...removeIndexes], changes };
}
