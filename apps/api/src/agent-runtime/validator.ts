import type { UserOperatingProfile } from "@operator-agent/core";
import type { EmailSignalRule } from "@operator-agent/db";
import { getToolDefinition } from "./tool-catalog.js";
import type { AgentEntity, ContextBundle, PlannedOperation, ValidatedOperation } from "./types.js";

const ACTION_REFERENCE_TOOLS = new Set(["action.snooze", "action.complete", "action.archive"]);

export interface PolicyGuardrailResult {
  triggered: boolean;
  reason?: string;
  matchedTrigger?: string;
}

/**
 * Generic, data-driven guardrail: it reacts to whatever the user's own
 * UserOperatingProfile.knownTriggers / knownFailureModes contain, never to a
 * hardcoded domain (e.g. gambling). A user with no configured triggers never
 * hits this check, regardless of what they say.
 */
export function checkPolicyGuardrail(message: string, profile: UserOperatingProfile): PolicyGuardrailResult {
  const text = message.toLowerCase();
  const candidates = [...(profile.knownTriggers ?? []), ...(profile.knownFailureModes ?? [])];

  const matched = candidates.find((trigger) => trigger.trim().length > 0 && text.includes(trigger.trim().toLowerCase()));

  if (!matched) {
    return { triggered: false };
  }

  return {
    triggered: true,
    reason: "message_matches_configured_trigger",
    matchedTrigger: matched
  };
}

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

  if (tool.name === "planning.next_week_edit") {
    const openDraft = context.session.pendingOperation?.operations[0]?.tool === "planning.next_week_apply";

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

    const removeIndexes = (args.removeIndexes as number[] | undefined) ?? [];
    const changes = (args.changes as Array<{ index: number; dueText: string }> | undefined) ?? [];

    if (removeIndexes.length === 0 && changes.length === 0) {
      return {
        tool: tool.name,
        args,
        status: "needs_clarification",
        requiresConfirmation: false,
        clarificationQuestion: "What would you like to change about the plan — remove an item, or change its day?",
        rationale: operation.rationale
      };
    }
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
