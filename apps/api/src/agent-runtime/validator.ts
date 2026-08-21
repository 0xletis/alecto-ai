import { parseActionDueDate } from "@operator-agent/core";
import type { EmailSignalRule } from "@operator-agent/db";
import { selectEmailRuleCandidate, type EmailRuleSelectionCandidate } from "../conversation/email-rule-selection.js";
import { computeLighterPlanRemoval, readPendingNextWeekPlanSuggestions, resolvePlanSuggestionRef } from "../planning/next-week.js";
import type { NextWeekPlanSuggestion } from "../server-types.js";
import { getToolDefinition } from "./tool-catalog.js";
import type { AgentEntity, ContextBundle, PlannedOperation, ValidatedOperation } from "./types.js";

export const ACTION_REFERENCE_TOOLS = new Set(["action.snooze", "action.complete", "action.archive"]);
const GMAIL_REVIEW_REFERENCE_TOOLS = new Set([
  "gmail.review.reject",
  "gmail.review.inspect",
  "gmail.review.to_action",
  "gmail.review.keep",
  "gmail.review.approve"
]);

export interface ValidateOperationsOptions {
  /**
   * True when `operations` came from one of this file's own deterministic shortcuts (runtime.ts)
   * rather than the real LLM planner — those already resolved any actionId through a verified
   * mechanism (the worker's own most-recently-reminded-action log, or the single visible action
   * when there's no ambiguity at all), so the actionId-grounding check below (which exists
   * specifically to catch the LLM PLANNER guessing) would only ever produce false rejections
   * here, never a real catch. Defaults to false (untrusted planner output) at every call site
   * that doesn't explicitly opt in.
   */
  deterministicSource?: boolean;
}

export function validateOperations(
  operations: PlannedOperation[],
  context: ContextBundle,
  message: string,
  options: ValidateOperationsOptions = {}
): ValidatedOperation[] {
  // A real Telegram smoke test found "complete action 10 and 9 now" (only 8 actions ever shown)
  // marked BOTH resulting action.complete operations "valid" and mutated real data — the planner
  // had emitted two separate action.complete calls, each with SOME actionId, and per-operation
  // validation had no way to see that the raw message named TWO explicit numbers at once: the
  // single-number override only fired when exactly one number was present, and the grounding
  // safety net below was deliberately skipped whenever ANY digit appeared in the message (on the
  // assumption a well-behaved planner would always route a multi-number request through
  // action.hygiene_apply instead — an assumption with no actual enforcement behind it). Resolved
  // here, once per turn, before any individual action.complete/archive/snooze op is validated:
  // every explicit number in the message is checked against the CURRENT session.visibleEntities
  // range, atomically — if even one is out of range, the whole set is blocked, never a partial
  // mutation on the refs that happened to be valid.
  const indexResolution = resolveExplicitActionIndexReferences(operations, context, message);

  if (indexResolution.applicable && indexResolution.blocked) {
    return operations.map((operation) => {
      if (!ACTION_REFERENCE_TOOLS.has(operation.tool)) {
        return validateOperation(operation, context, message, options);
      }
      return {
        tool: operation.tool,
        args: {},
        status: "invalid",
        requiresConfirmation: false,
        error: indexResolution.clarification,
        rationale: operation.rationale
      };
    });
  }

  return operations.map((operation, index) => {
    const override = indexResolution.applicable ? indexResolution.overridesByOpIndex?.get(index) : undefined;
    if (!override) {
      return validateOperation(operation, context, message, options);
    }
    // Already resolved deterministically above against the real visible list — deterministicSource
    // skips the grounding/outside-page checks below, which exist only to catch an UNVERIFIED
    // planner-supplied id, not to second-guess one this file already verified itself.
    const args = typeof operation.args === "object" && operation.args !== null && !Array.isArray(operation.args) ? (operation.args as Record<string, unknown>) : {};
    return validateOperation({ ...operation, args: { ...args, actionId: override } }, context, message, { ...options, deterministicSource: true });
  });
}

interface ExplicitActionIndexResolution {
  applicable: boolean;
  blocked?: boolean;
  clarification?: string;
  /** Position in the original `operations` array -> the real actionId that index resolves to. */
  overridesByOpIndex?: Map<number, string>;
}

/**
 * Parses every explicit number in the raw message (e.g. "complete action 10 and 9", "archive 1,
 * 3", "complete #2") and, whenever the turn contains at least one action.complete/archive/snooze
 * operation, resolves ALL of them against `context.session.visibleEntities`' own `index` field —
 * never the planner-supplied actionId, never context.openActions' DB ordering, never a fuzzy
 * match on the number itself. Numbers are paired to action-reference operations in the order both
 * appear (the Nth number named in the message maps to the Nth action-reference op the planner
 * produced) — the same order a well-behaved planner naturally emits them in. A count mismatch
 * (e.g. a stray unrelated number elsewhere in the message) is treated as unresolvable rather than
 * guessed at.
 */
function resolveExplicitActionIndexReferences(operations: PlannedOperation[], context: ContextBundle, message: string): ExplicitActionIndexResolution {
  const actionRefOpIndices = operations.map((op, i) => (ACTION_REFERENCE_TOOLS.has(op.tool) ? i : -1)).filter((i) => i >= 0);

  if (actionRefOpIndices.length === 0) {
    return { applicable: false };
  }

  const referencedNumbers = [...message.matchAll(/\d+/g)].map((match) => Number(match[0]));
  if (referencedNumbers.length === 0) {
    return { applicable: false };
  }

  const visibleActions = context.session.visibleEntities.filter((entity) => entity.type === "action");
  const maxIndex = visibleActions.reduce((max, entity) => Math.max(max, entity.index ?? 0), 0);
  const resolvedByNumber = new Map<number, string>();
  const invalidNumbers: number[] = [];

  for (const num of referencedNumbers) {
    const entity = visibleActions.find((item) => item.index === num);
    if (entity) {
      resolvedByNumber.set(num, entity.id);
    } else if (!invalidNumbers.includes(num)) {
      invalidNumbers.push(num);
    }
  }

  const countsMismatch = referencedNumbers.length !== actionRefOpIndices.length;
  const blocked = invalidNumbers.length > 0 || countsMismatch;

  logExplicitIndexDiagnostics(context.session.userId, {
    message,
    referencedNumbers,
    visibleIndexRange: maxIndex > 0 ? `1-${maxIndex}` : "(none shown)",
    allResolved: !blocked,
    plannerActionIdsIgnored: true,
    blockedAtomically: blocked
  });

  if (blocked) {
    const clarification = countsMismatch && invalidNumbers.length === 0 ? "Which numbers do you mean? Please name them one at a time or say 'show more actions'." : buildOutOfRangeClarification(invalidNumbers, referencedNumbers, maxIndex);
    return { applicable: true, blocked: true, clarification };
  }

  const overridesByOpIndex = new Map<number, string>();
  referencedNumbers.forEach((num, position) => {
    overridesByOpIndex.set(actionRefOpIndices[position], resolvedByNumber.get(num)!);
  });

  return { applicable: true, blocked: false, overridesByOpIndex };
}

/** Exact copy from the reported bug's own hard requirement — "I only showed N actions..." when
 * EVERY named number was out of range, "I can't do that because N isn't in the shown list..."
 * when some were valid and at least one wasn't (a partial mutation on the valid ones is unsafe). */
function buildOutOfRangeClarification(invalidNumbers: number[], allNumbers: number[], maxIndex: number): string {
  const range = maxIndex > 0 ? `1–${maxIndex}` : "the shown list";
  if (invalidNumbers.length === allNumbers.length) {
    return `I only showed ${maxIndex} action${maxIndex === 1 ? "" : "s"}. Use a number from ${range}, or say "show more actions".`;
  }
  const invalidList = invalidNumbers.join(" and ");
  const verb = invalidNumbers.length === 1 ? "isn't" : "aren't";
  return `I can't do that because ${invalidList} ${verb} in the shown list. Use ${range}, or say "show more actions".`;
}

function logExplicitIndexDiagnostics(
  userId: string,
  input: {
    message: string;
    referencedNumbers: number[];
    visibleIndexRange: string;
    allResolved: boolean;
    plannerActionIdsIgnored: boolean;
    blockedAtomically: boolean;
  }
): void {
  if (process.env.AGENT_RUNTIME_DIAGNOSTICS !== "true") {
    return;
  }
  console.log(
    "[agent-runtime-diagnostics]",
    JSON.stringify({
      phase: "explicit_action_index_check",
      userId,
      message: input.message,
      referencedNumbers: input.referencedNumbers,
      visibleIndexRange: input.visibleIndexRange,
      allResolved: input.allResolved,
      plannerActionIdsIgnored: input.plannerActionIdsIgnored,
      blockedAtomically: input.blockedAtomically
    })
  );
}

function validateOperation(operation: PlannedOperation, context: ContextBundle, message: string, options: ValidateOperationsOptions): ValidatedOperation {
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
  let actionOutsideVisiblePage = false;

  if (ACTION_REFERENCE_TOOLS.has(tool.name) && args.actionId) {
    const visibleActions = context.session.visibleEntities.filter((entity) => entity.type === "action");

    // Any explicit number in the message was already resolved deterministically (or the whole
    // operation set already blocked) by validateOperations's own resolveExplicitActionIndexReferences
    // pre-pass, above the per-operation level this function operates at — by the time a
    // ACTION_REFERENCE_TOOLS op reaches here with a number still in the message, options
    // .deterministicSource is already true and the checks below are skipped entirely. This is
    // kept as a defensive, always-expected-false guard, not the primary index-resolution path.
    const referencedNumbers = [...message.matchAll(/\d+/g)].map((match) => Number(match[0]));
    const target = visibleActions.find((entity) => entity.id === args.actionId);

    // A real Telegram smoke test + a live-LLM eval reproduction found the planner directly
    // supplying a concrete (but wrong) actionId for a bare "complete it" with 10 equally
    // plausible open actions visible and no recent reminder — its own prompt instruction ("if
    // it's ambiguous, omit the id and let the validator resolve it") is advisory, not
    // enforced, and a supplied id previously bypassed the ambiguity check below entirely. When
    // more than one action is visible, a directly-supplied id is only trusted if the message
    // itself gives a real reason to believe THIS one was meant — otherwise it's discarded and
    // falls through to the same ambiguity resolution a missing id already gets, never silently
    // completing/archiving/snoozing the wrong task. A single explicit number ("complete 2") is
    // exempted: it was already resolved deterministically against the real visible list above,
    // not a word-overlap guess.
    if (!options.deterministicSource && visibleActions.length > 1 && referencedNumbers.length === 0 && target) {
      const tier = actionTitleMatchTier(message, target.label);
      // A truly bare pronoun ("complete it," "done") has no real words at all to name a target
      // with — actionGroundingWords(message) is empty — so there is nothing honest to suggest;
      // that case still falls through to the plain multi-way ambiguity clarification below,
      // exactly as before.
      const messageHasContent = actionGroundingWords(message).length > 0;
      logActionGroundingDiagnostics(context.session.userId, {
        tool: tool.name,
        message,
        suppliedActionId: String(args.actionId),
        targetLabel: target.label,
        groundingTokens: actionGroundingWords(message),
        matchTier: tier,
        trusted: tier === "exact" || tier === "word_exact" || tier === "fuzzy"
      });

      // A real Telegram smoke test found an old email-generated action (its title just a raw
      // email subject line, e.g. "Hola Miquel, tu opinión es muy importante para nosotros.")
      // treated as an equally trustworthy fuzzy-match candidate as a manually-created task — a
      // low-quality, LLM-classified title deserves a higher bar before it's ever suggested.
      // "fuzzy" alone isn't enough for one; only "exact"/"word_exact" are trusted either way.
      const isLowQualitySourceTarget = context.openActions.find((item) => item.id === target.id)?.source === "email_review";

      if (tier === "exact" || tier === "word_exact") {
        // A real, specific, unambiguous name match — trusted as-is, falls through to execute.
      } else if (tier === "fuzzy" && messageHasContent && !isLowQualitySourceTarget) {
        // A real but not exact reason to believe this is the one (a distinctive, non-generic
        // word fuzzy-matched, typo-tolerant only — not verbatim) — downgraded to a confirmable
        // suggestion rather than either auto-trusting or silently discarding it. A bare "yes" runs
        // this exact operation (see runtime.ts's markActionClarificationPendingIfNeeded); any
        // other reply is "not that one."
        const phrase = extractActionTargetPhrase(message);
        return {
          tool: tool.name,
          args,
          status: "needs_clarification",
          requiresConfirmation: false,
          clarificationQuestion: `I don't see an open action called "${phrase}". Did you mean "${target.label}"? Reply yes, or tell me which action.`,
          rationale: operation.rationale,
          suggestedConfirmOperation: { tool: tool.name, args: { ...args } }
        };
      } else if (messageHasContent) {
        // "generic" (shares only common words like "meeting") or "none" (shares nothing at all),
        // or a low-quality email-sourced target that only cleared "distinctive" — never produce a
        // "did you mean," only an honest "I don't see one called X" naming what was actually
        // asked for. Real Telegram smoke test: a second "complete brainstorm meeting" (after the
        // first had already completed it) suggested "Hola Miquel, tu opinión..." — the planner's
        // own next guess — with NOTHING in common with what the user said beyond generic
        // phrasing; that must never happen again.
        delete args.actionId;
        const phrase = extractActionTargetPhrase(message);
        return {
          tool: tool.name,
          args,
          status: "needs_clarification",
          requiresConfirmation: false,
          clarificationQuestion: `I don't see an open action called "${phrase}". Which action do you mean?`,
          rationale: operation.rationale
        };
      } else {
        // A truly bare pronoun with no content at all — falls through to the plain multi-way
        // ambiguity clarification below, unchanged from before.
        delete args.actionId;
      }
    } else if (!options.deterministicSource && !target && referencedNumbers.length === 0) {
      // The supplied id isn't even in the currently visible list at all — a real Telegram smoke
      // test found "complete brainstorm meeting" silently completing a real action that was NOT
      // in the shown top-10 page (item 11 of 12), with a plain "Completed" reply giving no hint
      // it came from outside the page. Verified against the wider open-actions pool (not just
      // what's currently on screen) and only auto-trusted for an "exact" or "word_exact" title
      // match — real, specific, verbatim evidence, the same bar as the visible-list check's
      // auto-trust tiers. A merely "fuzzy"/"generic"/"none" tier is always discarded here (never
      // auto-completing something the user can't even see on a weak guess), falling through to
      // the normal ambiguity clarification instead. A trusted match is flagged
      // (actionOutsideVisiblePage) so the executor's own reply can say plainly that it was found
      // outside the visible page, rather than silently completing something never actually shown.
      const candidate = context.openActions.find((item) => item.id === args.actionId);
      const tier = candidate ? actionTitleMatchTier(message, candidate.title) : "none";
      const trusted = tier === "exact" || tier === "word_exact";
      logActionGroundingDiagnostics(context.session.userId, {
        tool: tool.name,
        message,
        suppliedActionId: String(args.actionId),
        targetLabel: candidate?.title,
        groundingTokens: actionGroundingWords(message),
        matchTier: tier,
        trusted
      });

      if (candidate && trusted) {
        actionOutsideVisiblePage = true;
      } else {
        delete args.actionId;
      }
    }
  }

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
        clarificationQuestion: "Which action do you mean? Reply with the number or title.",
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

  if (tool.name === "action.reschedule" && !args.actionId) {
    const resolution = resolveActionRef(args as { ref?: string }, context);

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

    args.actionId = resolution.actionId;
  }

  if (tool.name === "action.reschedule" && !args.dueText && !args.timeText) {
    return {
      tool: tool.name,
      args,
      status: "needs_clarification",
      requiresConfirmation: false,
      clarificationQuestion: "What new time should I move that task to?",
      rationale: operation.rationale
    };
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

  // Same reasoning again: gmail.autonomy.apply_update is never planned by the LLM directly, only
  // ever reached via the deterministic confirm whitelist re-executing an already-stored
  // pendingOperation. Its args (connectionId/syncMode/intervalMinutes) are set by
  // gmail.autonomy.propose_update's pendingOperationUpdate after resolving the real connection —
  // a direct plan would have no real connection id to put there anyway.
  if (tool.name === "gmail.autonomy.apply_update") {
    return {
      tool: tool.name,
      args,
      status: "invalid",
      requiresConfirmation: false,
      error: "this can only be run by confirming a pending Gmail sync-schedule change",
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

  // Same reasoning again: goal.archive_apply is never planned by the LLM directly, only ever
  // reached via the deterministic confirm whitelist re-executing an already-stored
  // pendingOperation set by goal.archive_propose after resolving a real, unambiguous goal. A
  // direct plan would have no verified goalId/operation to put there anyway — this is the one
  // place an archive/pause actually happens, so it must never run without an exact confirmation
  // of the plan goal.archive_propose already showed the user.
  if (tool.name === "goal.archive_apply") {
    return {
      tool: tool.name,
      args,
      status: "invalid",
      requiresConfirmation: false,
      error: "this can only be run by confirming a pending goal archive/pause change",
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
      clarificationQuestion: "What would you like to change — the morning brief, the evening check-in, or Gmail alerts?",
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
    rationale: operation.rationale,
    ...(actionOutsideVisiblePage ? { actionOutsideVisiblePage: true } : {})
  };
}

const ACTION_GROUNDING_STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "to",
  "my",
  "of",
  "for",
  "and",
  "or",
  "on",
  "in",
  "at",
  "it",
  "that",
  "this",
  "one",
  "task",
  "action",
  "item",
  "please",
  "complete",
  "completed",
  "finish",
  "finished",
  "done",
  "archive",
  "archived",
  "dismiss",
  "snooze",
  "snoozed",
  "mark",
  "marked",
  "as",
  // A real Telegram smoke test found "complete brainstorm meeting" completing "Branding
  // direction meeting" — the only shared word was "meeting," a generic activity-shape word that
  // tells you nothing about WHICH meeting, exactly like "task"/"action"/"item" above. Widened
  // with the rest of the generic vocabulary a mutation request commonly uses regardless of which
  // real item is meant, so none of these ever count as evidence on their own.
  "meeting",
  "call",
  "thing",
  "todo",
  "reminder"
]);

/** A short word (>2 chars), stripped of the generic completion/archive/snooze vocabulary every
 * message in this family uses regardless of which task is meant — so "complete" or "done"
 * matching itself never counts as evidence the RIGHT task was identified. */
function actionGroundingWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !ACTION_GROUNDING_STOPWORDS.has(word));
}

type ActionTitleMatchTier = "exact" | "word_exact" | "fuzzy" | "generic" | "none";

function normalizeForActionMatch(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isDistinctiveActionToken(word: string): boolean {
  return word.length >= 5 && !ACTION_GROUNDING_STOPWORDS.has(word);
}

/** Plain Levenshtein edit distance — no dependency, small inputs (single words) only. Mirrors
 * packages/core/src/goal-reference.ts's own fuzzy word matcher, kept as a small local copy here
 * rather than a cross-package export since action grounding and goal-reference resolution are
 * unrelated concerns that happen to want the same small algorithm. */
function levenshteinDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const distances: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));

  for (let i = 0; i < rows; i++) distances[i][0] = i;
  for (let j = 0; j < cols; j++) distances[0][j] = j;

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      distances[i][j] = Math.min(distances[i - 1][j] + 1, distances[i][j - 1] + 1, distances[i - 1][j - 1] + cost);
    }
  }

  return distances[rows - 1][cols - 1];
}

/** Typo-tolerant word match — threshold scales with length so short words still need to be close
 * while a long/distinctive word tolerates a couple of edits (e.g. "brainstorm" vs "brianstorm"). */
function fuzzyActionWordMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const threshold = Math.max(1, Math.floor(Math.max(a.length, b.length) * 0.25));
  return levenshteinDistance(a, b) <= threshold;
}

/**
 * Real Telegram smoke tests found two opposite failures from a plain "shares any non-generic
 * word" boolean: (1) "complete brainstorm meeting" was accepted against "Branding direction
 * meeting" because both share "meeting" (a generic activity-shape word, not real evidence), and
 * (2) once that was fixed, a REJECTED guess was still offered as a "did you mean" suggestion with
 * zero regard for whether it was actually plausible, suggesting "Hola Miquel, tu opinión..." — a
 * candidate sharing NOTHING with what the user said. This tiered scorer is the fix for both:
 * - "exact": the extracted target phrase basically IS the title (near-exact match) — trusted
 *   outright, never merely suggested.
 * - "distinctive": a real, specific, non-generic word (length >= 5, not in
 *   ACTION_GROUNDING_STOPWORDS) fuzzy-matches a word in the title — typo-tolerant, generic for any
 *   distinctive word, not a hardcoded name check. Real evidence, but not certain enough to
 *   auto-trust — callers downgrade this to a confirmable "did you mean X?" suggestion.
 * - "generic": only common/generic words overlap (e.g. "meeting," "task") — never enough on its
 *   own, either to trust OR to suggest.
 * - "none": no meaningful overlap at all.
 */
function actionTitleMatchTier(phrase: string, actionTitle: string): ActionTitleMatchTier {
  const normalizedPhrase = normalizeForActionMatch(extractActionTargetPhrase(phrase));
  const normalizedTitle = normalizeForActionMatch(actionTitle);

  if (!normalizedPhrase) {
    return "none";
  }

  if (normalizedPhrase === normalizedTitle || (normalizedPhrase.length > 3 && (normalizedTitle.includes(normalizedPhrase) || normalizedPhrase.includes(normalizedTitle)))) {
    return "exact";
  }

  const phraseWords = normalizedPhrase.split(" ").filter(Boolean);
  const titleWords = normalizedTitle.split(" ").filter(Boolean);
  const distinctivePhraseWords = phraseWords.filter(isDistinctiveActionToken);

  // A distinctive word appearing VERBATIM in the title ("complete the passport renewal task"
  // sharing "passport" with "Renew passport") is strong, specific, real-name evidence — trusted
  // the same as an exact title match, never merely suggested. A distinctive word that only
  // FUZZY-matches (typo-tolerant, not verbatim — "brainstorm" vs "branding" is NOT one of these;
  // that pair is simply too different) is real but less certain evidence, downgraded to a
  // confirmable "did you mean" suggestion instead of auto-trusted.
  if (distinctivePhraseWords.some((word) => titleWords.includes(word))) {
    return "word_exact";
  }
  if (distinctivePhraseWords.some((word) => titleWords.some((titleWord) => fuzzyActionWordMatch(word, titleWord)))) {
    return "fuzzy";
  }

  const hasGenericOverlap = phraseWords.some((word) => word.length > 2 && titleWords.includes(word));
  return hasGenericOverlap ? "generic" : "none";
}

const ACTION_TARGET_VERB_PREFIX_RE =
  /^(please\s+)?(i(?:'ve| have)?\s+)?(complete[d]?|finish(?:ed)?|mark(?:ed)?|archive[d]?|dismiss(?:ed)?|snooze[d]?|done\s+with|done)\s+(the\s+|my\s+)?/i;
const ACTION_TARGET_TRAILING_RE = /\s+(please|now|already|too)\.?$/i;

/** Best-effort "what did the user actually call it" phrase for the "I don't see an open action
 * called X" clarification — strips the leading verb ("complete"/"archive"/"snooze"/...) and a
 * trailing filler word, then capitalizes the first letter so it reads as a quoted name rather
 * than a mid-sentence fragment. Never perfect (free text has no grammar contract), but far more
 * honest than echoing the whole raw message back, or a generic "that task" with no specifics. */
function extractActionTargetPhrase(message: string): string {
  const trimmed = message.trim();
  const withoutVerb = trimmed.replace(ACTION_TARGET_VERB_PREFIX_RE, "").replace(ACTION_TARGET_TRAILING_RE, "").trim();
  const phrase = withoutVerb || trimmed;
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

function logActionGroundingDiagnostics(
  userId: string,
  input: {
    tool: string;
    message: string;
    suppliedActionId: string;
    targetLabel: string | undefined;
    groundingTokens: string[];
    matchTier: ActionTitleMatchTier;
    trusted: boolean;
  }
): void {
  if (process.env.AGENT_RUNTIME_DIAGNOSTICS !== "true") {
    return;
  }
  console.log(
    "[agent-runtime-diagnostics]",
    JSON.stringify({
      phase: "action_grounding_check",
      userId,
      tool: input.tool,
      suppliedActionId: input.suppliedActionId,
      targetLabel: input.targetLabel,
      groundingTokens: input.groundingTokens,
      matchTier: input.matchTier,
      trusted: input.trusted,
      rejectedAsGenericOrNoMatch: !input.trusted
    })
  );
}

type ActionRefResolution =
  | { status: "resolved"; actionId: string }
  | { status: "needs_clarification"; question: string };

function resolveActionRef(args: { ref?: string }, context: ContextBundle): ActionRefResolution {
  const visibleActions = context.session.visibleEntities.filter((entity) => entity.type === "action");

  if (args.ref?.trim()) {
    const candidates: EmailRuleSelectionCandidate[] = [
      ...visibleActions.map((entity) => ({ id: entity.id, name: entity.label, status: "open" })),
      ...context.openActions
        .filter((action) => !visibleActions.some((entity) => entity.id === action.id))
        .map((action) => ({ id: action.id, name: action.title, status: action.status }))
    ];
    const selected = selectEmailRuleCandidate(args.ref, candidates);
    if (selected) {
      return { status: "resolved", actionId: selected.id };
    }
    return { status: "needs_clarification", question: `I couldn't tell which task "${args.ref}" refers to — which one did you mean?` };
  }

  const resolution = resolveSingleVisibleEntity(visibleActions, "action");
  if (resolution.status === "resolved") {
    return { status: "resolved", actionId: resolution.entity.id };
  }
  if (resolution.status === "none") {
    return { status: "needs_clarification", question: "Which task do you mean? I don't have one in view right now." };
  }
  return { status: "needs_clarification", question: "Which action do you mean? Reply with the number or title." };
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
