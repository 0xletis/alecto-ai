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
    // A single blocked multi-op request (e.g. two action.complete calls rejected together for
    // the same out-of-range numbered reference) produces the identical correction text once per
    // op — deduped the same way executedSummaries already dedupes matching success lines, so the
    // user sees one clear explanation, not the same sentence repeated back to back.
    const seenCorrections = new Set<string>();
    const correctionLines = [
      ...input.executedOps
        .filter((op) => op.status === "failed")
        .map((op) => correctionLine(op.tool, op.error ?? op.summary)),
      ...input.problemOps.map((op) =>
        op.standaloneError && op.error ? op.error : correctionLine(op.tool, op.error ?? `"${op.tool}" isn't something I can do yet`)
      )
    ].filter((line) => {
      if (seenCorrections.has(line)) {
        return false;
      }
      seenCorrections.add(line);
      return true;
    });

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

  // Informational (read-only) tools are the answer itself — their ground-truth summary is
  // always the reply, never blended with the LLM's framing, which risks either duplicating
  // it verbatim or omitting the substance behind a vague sentence like "I'll list them now."
  // Excludes anything already counted above so a tool that's BOTH (e.g. gmail.review.inspect)
  // isn't shown twice. Combined WITH groundTruthOnly, not returned separately: a real compound
  // turn (e.g. "delete it, and check email sync every 1h") executes gmail.review.reject
  // (ground-truth-only) AND opens a gmail.autonomy.propose_update confirmation (informational,
  // mutates:false) in the SAME turn — returning groundTruthOnly alone would silently drop the
  // second half of the reply even though both really happened/were proposed.
  const informationalSummaries = executedSummaries(
    input.executedOps,
    (tool) => tool?.mutates === false && !GROUND_TRUTH_ONLY_TOOLS.has(tool?.name ?? "")
  );
  const deterministicLines = [...groundTruthOnly, ...informationalSummaries];
  if (deterministicLines.length > 0) {
    return deterministicLines.join("\n\n");
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
  // A real Telegram smoke test found "archive 1 and 2" replying "Archiving the actions X and Y"
  // (the planner's own pre-execution replyDraft, present tense, sounds confident either way) while
  // both actions stayed open afterward — action.archive is a mutates:true tool, so without this
  // entry its reply defaults to whatever the LLM guessed would happen, never checked against
  // whether archiveActionItem actually found and updated a real row. Grouped with its bulk siblings
  // for the same reason: "Archived N actions" must only ever be said after the archive really ran.
  "action.archive",
  "action.archive_all_propose",
  "action.archive_all_apply",
  // Bundled together with action.archive_all_apply when a goal-archive confirmation also
  // includes its linked open actions (goal.archive_propose's own pendingOperationUpdate) — both
  // must land in the SAME bucket (groundTruthOnly, joined with "\n\n") or one silently drops: the
  // "mutates:true, no replyDraft" fallback path only ever fires when NOTHING landed in
  // groundTruthOnly/informationalSummaries first, so a bundle where only one sibling is ground-
  // truth-only would show that one's real outcome and lose the other's entirely.
  "goal.archive_apply",
  // A real Telegram smoke test found action.complete/action.snooze replies could be overridden by
  // the planner's own pre-execution replyDraft — mutates:true tools not in this set fall back to
  // whatever the LLM guessed would happen, never checked against whether the mutation actually
  // succeeded, what the action's real title is, or whether it's linked to a goal. The human,
  // coach-like phrasing for these two now lives entirely in their own executor cases below, using
  // only verified post-execution facts — never the model's own unverified claim.
  "action.complete",
  "action.snooze",
  "action.hygiene_apply",
  "planning.next_week_apply",
  "weekly_review.save",
  "gmail.rule.apply_update",
  "gmail.review.inspect",
  // A real-LLM eval run (feat/gmail-rule-signal-mapping, scenario 51) caught this: the planner's
  // pre-execution replyDraft ("I've approved the invoice email from ClientCo.") was shown instead
  // of the tool's own honest, grounded summary — which is the ONLY place a real extracted amount
  // (e.g. "$120.00") or a "this counts toward X" evidence note actually appears. Approving a review
  // is exactly the case groundTruthOnly exists for: the real outcome (whether evidence was logged,
  // what was extracted, which goal it counts toward) is only known AFTER execution, never before.
  "gmail.review.approve",
  "daily_loop.settings_apply_update",
  "gmail.review.reject",
  "gmail.review.to_action",
  "gmail.review.keep",
  "proactive.settings_apply_update",
  // feat/private-alpha-capability-proposal-queue: goal.create_apply's combined capability-proposal
  // confirmation can execute this alongside proactive.settings_apply_update in the SAME turn (e.g.
  // "yes" to both a daily-coaching and a Gmail-support proposal) — both must land in the SAME
  // bucket (groundTruthOnly, joined with "\n\n") or one silently drops, same reasoning as
  // action.archive_all_apply/goal.archive_apply being bundled together below.
  "gmail.goal_watcher.apply_enable",
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
  "gmail.autonomy.apply_update": "update Gmail's sync schedule",
  "daily_loop.settings_apply_update": "update your daily loop settings",
  "proactive.settings_apply_update": "update your proactive message settings",
  "gmail.goal_watcher.apply_enable": "enable Gmail support for that goal"
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
