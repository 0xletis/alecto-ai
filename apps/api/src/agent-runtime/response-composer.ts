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
  if (input.clarificationQuestion) {
    return input.replyDraft ? `${input.replyDraft} ${input.clarificationQuestion}`.trim() : input.clarificationQuestion;
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

const GROUND_TRUTH_ONLY_TOOLS = new Set(["operator.recent_changes", "gmail.rule.create", "action.hygiene_apply"]);

/** "I couldn't <do the thing> because <reason>. Nothing was changed." — always names the failure, never implies success. */
function correctionLine(tool: string, detail: string): string {
  return `I couldn't ${humanAction(tool)} because ${detail}. Nothing was changed.`;
}

const HUMAN_ACTION: Record<string, string> = {
  "action.create": "create that task",
  "action.snooze": "snooze that task",
  "action.complete": "complete that task",
  "action.archive": "archive that task",
  "event.log_job_applications": "log those job applications",
  "event.log_workout": "log that workout",
  "event.log_custom_progress": "log that progress",
  "memory.create": "save that memory",
  "gmail.rule.create": "set up that Gmail rule",
  "gmail.review.reject": "reject that email review",
  "gmail.review.to_action": "turn that email into a task",
  "action.hygiene_apply": "apply those action cleanup decisions"
};

function humanAction(tool: string): string {
  return HUMAN_ACTION[tool] ?? "do that";
}

function executedSummaries(
  ops: ExecutedOperation[],
  matches: (tool: ReturnType<typeof getToolDefinition>) => boolean
): string[] {
  return ops
    .filter((op) => (op.status === "executed" || op.status === "skipped") && matches(getToolDefinition(op.tool)))
    .map((op) => op.summary);
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
