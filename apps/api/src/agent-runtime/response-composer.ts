import { getToolDefinition } from "./tool-catalog.js";
import type { ExecutedOperation, ValidatedOperation } from "./types.js";

export interface ComposeReplyInput {
  replyDraft: string;
  clarificationQuestion?: string;
  pendingConfirmationOps: ValidatedOperation[];
  executedOps: ExecutedOperation[];
  problemOps: ValidatedOperation[];
}

/**
 * Deterministic, template-based composition — no second LLM call. The
 * planner's replyDraft carries natural-language framing, but it was written
 * BEFORE execution, so it is only trusted when nothing actually went wrong
 * AND the executed tool isn't itself the direct answer to the question.
 */
export function composeReply(input: ComposeReplyInput): string {
  // Never blended with replyDraft: a clarification means the turn's own attempted
  // operation was rejected (or nothing was attempted at all), so replyDraft — written by
  // the planner BEFORE validation/execution ran — may itself be a premature, false success
  // claim (e.g. "I've moved it to Friday" for a move that the validator actually rejected).
  // The clarification question is the only thing here grounded in what actually happened.
  if (input.clarificationQuestion) {
    return input.clarificationQuestion;
  }

  if (input.pendingConfirmationOps.length > 0) {
    const lines = input.replyDraft ? [input.replyDraft] : input.pendingConfirmationOps.map(describePendingConfirmation);
    return joinSentences(lines);
  }

  const hasProblems = input.problemOps.length > 0 || input.executedOps.some((op) => op.status === "failed");

  if (hasProblems) {
    const successLines = executedSummaries(input.executedOps, () => true);
    const correctionLines = [
      ...input.executedOps
        .filter((op) => op.status === "failed")
        .map((op) => correctionLine(op.tool, op.error ?? op.summary)),
      ...input.problemOps.map((op) => correctionLine(op.tool, op.error ?? `"${op.tool}" isn't something I can do yet`))
    ];

    const lines = [...successLines, ...correctionLines];
    return lines.length > 0 ? joinSentences(lines) : "I couldn't do that. Nothing was changed.";
  }

  // Some tools ARE the direct answer to the question (or the direct, honest outcome of a
  // mutation attempt) and their own deterministic summary always wins over the LLM's
  // pre-execution replyDraft — showing both produced duplicated/contradicting output in
  // practice (e.g. replyDraft says "I'll create it" while the tool's ground truth says it
  // already exists). Checked first, ahead of the general informational-tool rule below,
  // because gmail.rule.create is a mutating tool that still needs this treatment.
  const groundTruthOnly = executedSummaries(input.executedOps, (tool) => GROUND_TRUTH_ONLY_TOOLS.has(tool?.name ?? ""));
  if (groundTruthOnly.length > 0) {
    return groundTruthOnly.join("\n\n");
  }

  // Informational (read-only) tools are the answer itself — their ground-truth summary is
  // always the reply, never blended with the LLM's framing, which risks either duplicating
  // it verbatim or omitting the substance behind a vague sentence like "I'll list them now."
  const informationalSummaries = executedSummaries(input.executedOps, (tool) => tool?.mutates === false);
  if (informationalSummaries.length > 0) {
    return informationalSummaries.join("\n\n");
  }

  const leadLines: string[] = [];

  if (input.replyDraft) {
    leadLines.push(input.replyDraft);
  }

  // Mutating tools are trusted to be described by replyDraft; only fall back to the raw
  // summary when there's no draft at all (e.g. the fallback heuristic planner).
  if (!input.replyDraft) {
    const mutationSummaries = executedSummaries(input.executedOps, (tool) => tool?.mutates === true);
    if (mutationSummaries.length > 0) {
      leadLines.push(mutationSummaries.join(" "));
    }
  }

  return leadLines.length > 0 ? joinSentences(leadLines) : "I didn't find anything to act on.";
}

const GROUND_TRUTH_ONLY_TOOLS = new Set([
  "operator.recent_changes",
  "action.reschedule",
  "action.create_pre_due_reminders",
  "action.reminder_list",
  "gmail.sync",
  "gmail.sync.debug",
  "gmail.rule.create",
  "gmail.rule.enable_builtin",
  "action.hygiene_apply",
  "planning.next_week_apply",
  "weekly_review.save",
  "gmail.rule.apply_update",
  "gmail.review.inspect",
  "daily_loop.settings_apply_update",
  "gmail.review.reject",
  "gmail.review.to_action",
  "gmail.review.keep",
  "proactive.settings_apply_update",
  // A real-LLM eval run found the planner's pre-execution replyDraft claiming evidence "counted
  // toward" a goal even when this call fell back to the genuinely unlinked path — its own summary
  // is specifically written to state the truth about whether/what was linked, so that truth must
  // always be what's shown, never the LLM's optimism. NOT goal.log_evidence too, deliberately:
  // that tool is routinely planned in the SAME turn as action.create (e.g. "I have an interview
  // tomorrow"), and groundTruthOnly below suppresses every OTHER op's summary in the turn, not
  // just replyDraft — adding it here silently dropped the action.create half of that reply.
  "event.log_custom_progress"
]);

/** Exposed only for runtime.ts's dev/test-only planning trace, to classify which composeReply branch produced a reply without duplicating its branch logic. */
export function isGroundTruthOnlyTool(tool: string): boolean {
  return GROUND_TRUTH_ONLY_TOOLS.has(tool);
}

/** "I couldn't <do the thing> because <reason>. Nothing was changed." — always names the failure, never implies success. */
function correctionLine(tool: string, detail: string): string {
  return `I couldn't ${humanAction(tool)} because ${detail}. Nothing was changed.`;
}

const HUMAN_ACTION: Record<string, string> = {
  "action.create": "create that task",
  "action.snooze": "snooze that task",
  "action.complete": "complete that task",
  "action.archive": "archive that task",
  "action.reschedule": "reschedule that task",
  "action.create_pre_due_reminders": "set those reminders",
  "action.reminder_list": "show your reminders",
  "event.log_job_applications": "log those job applications",
  "event.log_workout": "log that workout",
  "event.log_custom_progress": "log that progress",
  "memory.create": "save that memory",
  "gmail.sync": "sync Gmail",
  "gmail.sync.debug": "show Gmail sync diagnostics",
  "gmail.rule.create": "set up that Gmail rule",
  "gmail.rule.enable_builtin": "enable that Gmail rule",
  "gmail.review.reject": "reject that email review",
  "gmail.review.inspect": "inspect that email review",
  "gmail.review.to_action": "turn that email into a task",
  "gmail.review.keep": "keep that email review",
  "action.hygiene_apply": "apply those action cleanup decisions",
  "planning.next_week_apply": "create that plan",
  "weekly_review.save": "save that weekly review",
  "gmail.rule.apply_update": "update that Gmail rule",
  "daily_loop.settings_apply_update": "update your daily loop settings",
  "proactive.settings_apply_update": "update your proactive message settings"
};

function humanAction(tool: string): string {
  return HUMAN_ACTION[tool] ?? "do that";
}

function executedSummaries(
  ops: ExecutedOperation[],
  matches: (tool: ReturnType<typeof getToolDefinition>) => boolean
): string[] {
  const seen = new Set<string>();
  return ops
    .filter((op) => (op.status === "executed" || op.status === "skipped") && matches(getToolDefinition(op.tool)))
    .map((op) => op.summary)
    .filter((summary) => {
      if (seen.has(summary)) {
        return false;
      }
      seen.add(summary);
      return true;
    });
}

function joinSentences(lines: string[]): string {
  return lines
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => (/[.!?]$/.test(line) ? line : `${line}.`))
    .join(" ")
    .trim();
}

function describePendingConfirmation(op: ValidatedOperation): string {
  if (op.tool === "gmail.rule.create") {
    const label = String(op.args.label ?? "this");
    return `I can create a review-first Gmail rule for "${label}". Matches go to email reviews first. This is not instant email arrival tracking. Confirm?`;
  }

  return `I'm ready to run ${op.tool}. Shall I go ahead?`;
}

/** Short, human-readable noun phrase for a pending operation — used to store
 * AgentPendingOperation.summary and to reference it later (e.g. "you still
 * have a pending confirmation for <this>"). Never the raw tool/args dump. */
export function summarizePendingOperations(ops: ValidatedOperation[]): string {
  return ops.map(describePendingOperationLabel).join(", ");
}

function describePendingOperationLabel(op: ValidatedOperation): string {
  if (op.tool === "gmail.rule.create") {
    return `a Gmail tracking rule for "${String(op.args.label ?? "this")}"`;
  }

  return `"${op.tool}"`;
}
