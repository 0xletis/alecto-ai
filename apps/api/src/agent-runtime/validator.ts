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
 */
function stripNulls(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === null) continue;
    result[key] = typeof value === "string" ? value.replace(ZERO_WIDTH_CHARS_RE, "").trim() : value;
  }
  return result;
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
