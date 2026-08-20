import { createMemory, getMostRecentlyRemindedActionItem, rejectPendingAction, type PendingAction } from "@operator-agent/db";
import { loadContext } from "./context-loader.js";
import { parseGmailAutonomyPreference, type GmailAutonomyPreferenceRequest } from "../legacy/gmail-conversation.js";
import { appendMessage, createPendingOperationRecord, recordMutation, saveSession, setPendingOperation, setTopic, setVisibleEntities } from "./conversation-session.js";
import { executeOperation } from "./executor.js";
import { checkGoalGuardrail, type GuardrailResult } from "./goal-guardrails.js";
import { planMessage } from "./planner.js";
import { composeReply, isGroundTruthOnlyTool, summarizePendingOperations } from "./response-composer.js";
import { getToolDefinition } from "./tool-catalog.js";
import { runExclusive } from "./user-lock.js";
import { revalidateForExecution, validateOperations } from "./validator.js";
import type {
  AgentDebugInfo,
  AgentEntity,
  AgentMessageRequest,
  AgentMessageResponse,
  AgentPendingOperation,
  AgentSessionState,
  ContextBundle,
  ExecutedOperation,
  PlannedOperation,
  PlanningTraceEntry,
  ValidatedOperation
} from "./types.js";

const META_TOOLS = new Set(["confirmation.confirm", "confirmation.cancel", "clarification.ask"]);

// Exact, whitelisted, whole-message-only confirm/cancel vocabulary. Anything that doesn't
// match exactly (after trimming/lowercasing/dropping a single trailing "."/"!") is NOT treated
// as a confirmation or cancellation — it falls through to the pending-operation firewall below
// or to the planner. This is deliberately much stricter than free-form affirmation detection:
// a false "yes" that executes an unapproved mutation is a far worse failure than asking the
// user to reply with an exact word.
const CONFIRM_WHITELIST = new Set([
  "yes",
  "y",
  "yep",
  "confirm",
  "do it",
  "ok",
  "okay",
  "sure",
  "vale",
  "va",
  "sí",
  "si",
  "perfecto",
  "perfect",
  "looks good",
  "save this review",
  "save the review",
  "save it"
]);
const CANCEL_WHITELIST = new Set(["no", "cancel", "stop", "never mind", "forget it", "cancelar", "cancela"]);

const NO_PENDING_REPLY = "I don't have anything pending to confirm.";

// Deliberately narrow, hardcoded-safe pattern: Gmail send/reply/forward/delete
// has no tool in the catalog at all, so this is enforced deterministically
// rather than left to the planner's judgment — it must never depend on
// whether the LLM correctly refuses in a given turn. Runs unconditionally,
// including while a pending operation is open, and never touches pendingOperation.
const UNSUPPORTED_GMAIL_ACTION_RE =
  /\b(reply|respond|answer)\b[\s\S]{0,40}\b(email|mail|message|gmail)\b|\bsend\b[\s\S]{0,20}\b(email|mail|reply)\b|\bforward\b[\s\S]{0,20}\b(email|mail)\b|\b(delete|remove)\b[\s\S]{0,20}\b(email|mail)\b[\s\S]{0,20}\b(gmail|inbox)\b/i;

const UNSUPPORTED_GMAIL_ACTION_REPLY =
  "I can't reply to Gmail messages or send emails yet. I can only read matching emails through active rules and create review items.";

// Covers "let me know when I receive one/it arrives", "notify me when I get one", "just let
// me know", "I wanna know", "about those emails", "when they arrive", and close paraphrases.
// Only ever checked while the pending operation is specifically a gmail.rule.create — a narrow
// enough gate that a broader phrase match here is safe.
const GMAIL_PENDING_NOTIFICATION_FOLLOWUP_RE =
  /\b(let me know|notify me|keep me posted|tell me)\b|\bi wanna know\b|\bi want to know\b|\bwhen (i receive|i get|it arrives|they arrive)\b|\babout (those|these|that) emails?\b/i;

// Deliberately narrow (allowlist, not blocklist): only genuinely broad, no-specific-capability
// operator/help/orientation questions — never a specific capability request (Gmail, planning,
// weekly review, action CRUD, goal.list's own phrases, etc.), which must always reach the
// planner unchanged. See goal-anchor-nudge below.
const BROAD_OPERATOR_QUESTION_RE =
  /^(so )?what should i do( today)?\??$|^what can you help( me)?( with)?\??$|^help me get (organized|started)\??$|^so what('s| is)? today\??$|^how do i (start|get started|begin)\??$|^where do i start\??$|^what now\??$|^what'?s next\??$/i;

const GOAL_ANCHOR_NUDGE_MARKER = "one real goal or guardrail";

// Exported so apps/operator/proactive.ts's morning-brief decision can reuse the exact same
// empty-user text (task explicitly asks for "goal-anchor nudge style") instead of duplicating it.
export const GOAL_ANCHOR_NUDGE_REPLY = [
  `I can help, but I work best with ${GOAL_ANCHOR_NUDGE_MARKER} to anchor to — right now you don't have one set.`,
  "",
  "A few examples:",
  "1. Find a new developer job",
  "2. Train 3x/week",
  "3. Avoid impulsive spending",
  "4. Build a project",
  "",
  "Goal creation through chat isn't wired yet, so use /create_goal for now — or tell me the context and I'll remember it."
].join("\n");

/**
 * True only for a genuinely empty user (no active goals, no configured knownTriggers/
 * knownFailureModes — so the goal-aligned guardrail engine, goal-guardrails.ts, has nothing to
 * work with either) asking a broad, capability-agnostic operator/help question, and only when
 * the nudge wasn't the very last thing shown (checked against session.messages — no new schema,
 * see wasGoalAnchorNudgeShownLast). This is deliberately conservative: any active goal, any
 * configured trigger/failure mode, a pending operation, or a specific capability request all
 * skip it, so it can never interrupt or repeat a real flow.
 */
function shouldShowGoalAnchorNudge(context: ContextBundle, message: string): boolean {
  if (context.session.pendingOperation) {
    return false;
  }
  if (context.activeGoals.length > 0) {
    return false;
  }
  const profile = context.operatingProfile;
  if ((profile.knownTriggers?.length ?? 0) > 0 || (profile.knownFailureModes?.length ?? 0) > 0) {
    return false;
  }
  if (!BROAD_OPERATOR_QUESTION_RE.test(message.trim())) {
    return false;
  }
  return !wasGoalAnchorNudgeShownLast(context.session);
}

function wasGoalAnchorNudgeShownLast(session: AgentSessionState): boolean {
  for (let i = session.messages.length - 1; i >= 0; i -= 1) {
    const entry = session.messages[i];
    if (entry.role === "assistant") {
      return entry.text.includes(GOAL_ANCHOR_NUDGE_MARKER);
    }
  }
  return false;
}

// --- Dev/test-only planning trace (never active in production unless explicitly opted in) ---

// Read fresh on every call, not cached at module load — tests toggle this per-turn via
// process.env, and a module-level constant would freeze whatever value was set at import time.
function isPlanningTraceEnabled(): boolean {
  return process.env.AGENT_RUNTIME_PLANNING_TRACE === "true";
}

function isPlanningTool(tool: string | undefined | null): boolean {
  return Boolean(tool && tool.startsWith("planning."));
}

function logAgentRuntimeDiagnostics(input: {
  phase: string;
  userId: string;
  plannerOps?: PlannedOperation[];
  explicitReviewIntentMap?: ExplicitGmailReviewIntentEntry[];
  finalOps?: PlannedOperation[];
  validatedOps?: ValidatedOperation[];
  mutationTools?: string[];
  /** Free-form context for a phase that isn't well captured by the structured fields above — e.g.
   * for "complete it"/"done", whether it resolved to a real ActionItem (and via which source:
   * the worker's own recent notification log, or a plain visible session entity) or fell through
   * to the normal planner entirely (meaning it could still end up targeting a Gmail review). */
  note?: string;
}): void {
  if (process.env.AGENT_RUNTIME_DIAGNOSTICS !== "true") {
    return;
  }

  console.log(
    "[agent-runtime-diagnostics]",
    JSON.stringify({
      phase: input.phase,
      userId: input.userId,
      runtimeSelected: "agent_v3",
      plannerOps: input.plannerOps?.map(safeDiagnosticOperation) ?? [],
      explicitReviewIntentMap:
        input.explicitReviewIntentMap?.map((entry) => ({ index: entry.index, intent: entry.intent, position: entry.position })) ?? [],
      finalOps: input.finalOps?.map(safeDiagnosticOperation) ?? [],
      validatedOps: input.validatedOps?.map((op) => ({ tool: op.tool, status: op.status })) ?? [],
      mutationTools: input.mutationTools ?? [],
      ...(input.note ? { note: input.note } : {})
    })
  );
}

function safeDiagnosticOperation(op: PlannedOperation): { tool: string; args: Record<string, unknown> } {
  const safeArgs: Record<string, unknown> = {};
  for (const key of ["index", "ref", "dueText", "reminderLeadMinutes", "leadMinutes", "status", "limit"]) {
    if (op.args[key] !== undefined) {
      safeArgs[key] = op.args[key];
    }
  }
  return { tool: op.tool, args: safeArgs };
}

interface PlanningTraceInputs {
  message: string;
  plannedOp: PlannedOperation | undefined;
  validatedOp: ValidatedOperation | undefined;
  executedOp: ExecutedOperation | undefined;
  pendingOperationBefore: AgentPendingOperation | null;
  visibleEntitiesBefore: AgentEntity[];
  composerSource: string;
}

/**
 * Builds and logs a full-pipeline trace for one planning.* turn — gated behind
 * AGENT_RUNTIME_PLANNING_TRACE=true (unset/false in every real deployment) and only produced
 * for turns that actually touch a planning tool or a planning pendingOperation, so it never
 * adds overhead or log volume to normal traffic. Logs only the acting user's own message/plan
 * for their own turn — never cross-user data — but stays behind the explicit opt-in anyway,
 * matching "do not leak sensitive data in production logs."
 */
function recordPlanningTrace(inputs: PlanningTraceInputs, session: AgentSessionState): PlanningTraceEntry | undefined {
  const involvesPlanning =
    isPlanningTool(inputs.plannedOp?.tool) ||
    isPlanningTool(inputs.pendingOperationBefore?.operations[0]?.tool) ||
    isPlanningTool(session.pendingOperation?.operations[0]?.tool);

  if (!isPlanningTraceEnabled() || !involvesPlanning) {
    return undefined;
  }

  const entry: PlanningTraceEntry = {
    message: inputs.message,
    plannedTool: inputs.plannedOp?.tool ?? null,
    plannedArgs: inputs.plannedOp?.args ?? null,
    validationStatus: inputs.validatedOp?.status ?? null,
    validationError: inputs.validatedOp?.error ?? inputs.validatedOp?.clarificationQuestion ?? null,
    resolvedArgs: inputs.validatedOp?.args ?? null,
    executorStatus: inputs.executedOp?.status ?? null,
    executorSummary: inputs.executedOp?.summary ?? null,
    pendingOperationBefore: inputs.pendingOperationBefore,
    pendingOperationAfter: session.pendingOperation,
    visibleEntitiesBefore: inputs.visibleEntitiesBefore,
    visibleEntitiesAfter: session.visibleEntities,
    composerSource: inputs.composerSource
  };

  console.log(`[planning-trace] user=${session.userId}`, JSON.stringify(entry));
  return entry;
}

/** Classifies which composeReply branch produced a reply, for tracing only — mirrors composeReply's own priority order without duplicating its logic. */
function inferComposerSource(input: {
  clarificationQuestion?: string;
  pendingConfirmationOps: ValidatedOperation[];
  executedOps: ExecutedOperation[];
  problemOps: ValidatedOperation[];
  replyDraft: string;
}): string {
  if (input.clarificationQuestion) return "clarification_question";
  if (input.pendingConfirmationOps.length > 0) return "pending_confirmation";
  if (input.problemOps.length > 0 || input.executedOps.some((op) => op.status === "failed")) return "problem_correction";
  if (input.executedOps.some((op) => (op.status === "executed" || op.status === "skipped") && isGroundTruthOnlyTool(op.tool))) {
    return "ground_truth_only";
  }
  if (input.executedOps.some((op) => (op.status === "executed" || op.status === "skipped") && getToolDefinition(op.tool)?.mutates === false)) {
    return "informational_summary";
  }
  if (input.replyDraft) return "reply_draft";
  if (input.executedOps.some((op) => (op.status === "executed" || op.status === "skipped") && getToolDefinition(op.tool)?.mutates === true)) {
    return "mutation_summary";
  }
  return "fallback_no_action";
}

export async function handleAgentMessage(request: AgentMessageRequest): Promise<AgentMessageResponse> {
  return runExclusive(request.userId, () => processAgentMessage(request));
}

const GENERIC_ERROR_REPLY = "I hit an unexpected problem there — please try again.";

/**
 * Last-resort safety net: ANY uncaught error anywhere in a turn (a DB hiccup, a malformed
 * timezone, an unexpected shape from a dependency) must still produce a normal response with
 * an honest reply, never crash the request and surface the Telegram layer's generic dev-safe
 * "Agent v3 hit an error" text for what could be a perfectly ordinary turn — e.g. a
 * transient failure on a brand-new user's very first message. Per-operation failures are
 * already caught inside executeOperation and reported as a grounded "failed" result; this
 * only catches what's truly unexpected, so it never masks or replaces that existing,
 * more specific error reporting. Nothing about the turn is persisted when this fires (no
 * saveSession call happened), so a crash here can never leave a half-written session.
 */
async function processAgentMessage(request: AgentMessageRequest): Promise<AgentMessageResponse> {
  try {
    if (process.env.AGENT_RUNTIME_FORCE_ERROR === "true") {
      throw new Error("AGENT_RUNTIME_FORCE_ERROR: forced failure for testing the top-level safety net.");
    }
    return await processAgentMessageInner(request);
  } catch (error) {
    console.error(`[agent-runtime] unexpected error handling user=${request.userId}`, error);
    return {
      reply: GENERIC_ERROR_REPLY,
      operationsPlanned: [],
      operationsExecuted: [],
      needsConfirmation: false,
      debug: {
        runtime: "agent_v3",
        plannerUsed: "none",
        llmPlannerAttempted: false,
        llmPlannerUsed: false,
        toolValidationPassed: false,
        mutationExecuted: false,
        conversationTopic: null,
        pendingOperation: false,
        legacyPendingActionDetected: false
      }
    };
  }
}

async function processAgentMessageInner(request: AgentMessageRequest): Promise<AgentMessageResponse> {
  const { userId, message, channel } = request;
  const context = await loadContext(userId, channel);
  appendMessage(context.session, "user", message);

  // Captured before anything in this turn can mutate them — setPendingOperation/
  // setVisibleEntities always reassign context.session.X to a new value rather than mutating
  // the existing object in place, so these references safely keep representing "before" for
  // the rest of the turn, including inside recordPlanningTrace's "after" comparison later.
  const pendingOperationBefore = context.session.pendingOperation;
  const visibleEntitiesBefore = context.session.visibleEntities;

  const pending = context.session.pendingOperation;
  const normalized = normalizeExactMessage(message);

  // Exact confirm/cancel is checked FIRST and ALWAYS — regardless of whether a pending
  // operation exists — so a bare "yes"/"no" with nothing pending gets the deterministic
  // "nothing pending" reply instead of falling through to the LLM planner, which has been
  // observed to invent an unrelated action (e.g. listing Gmail rules) for a lone "yes".
  if (CONFIRM_WHITELIST.has(normalized)) {
    if (pending) {
      return finalizeDeterministicConfirmation(context, message);
    }
    return context.legacyPendingAction
      ? finalizeLegacyPendingActionConfirm(context)
      : finalizeNoPendingReply(context, "confirmation.confirm");
  }
  if (CANCEL_WHITELIST.has(normalized)) {
    if (pending) {
      return finalizeDeterministicCancellation(context, message);
    }
    if (context.legacyPendingAction) {
      return finalizeLegacyPendingActionCancel(context, context.legacyPendingAction);
    }
    // No v3 pendingOperation and no legacy PendingAction to cancel — but a "cancel" here still
    // safely resets any visible-entity context (e.g. a numbered action-hygiene list), so a
    // stray later "complete 1" can't resolve against stale state. action.hygiene_apply never
    // requires confirmation, so there is nothing to reject, only this defensive reset.
    setVisibleEntities(context.session, []);
    return finalizeNoPendingReply(context, "confirmation.cancel");
  }

  if (UNSUPPORTED_GMAIL_ACTION_RE.test(message.trim())) {
    // Deliberately does not touch pendingOperation: an unrelated, unsupported
    // request must not silently cancel or continue an unrelated pending flow.
    return finalize(context, {
      reply: UNSUPPORTED_GMAIL_ACTION_REPLY,
      operationsPlanned: [],
      executedOps: [],
      plannerUsed: "none",
      llmPlannerAttempted: false,
      toolValidationPassed: true,
      topic: "gmail_unsupported_action"
    });
  }

  const gmailSyncDebugShortcut = gmailSyncDebugShortcutOperation(message);
  if (gmailSyncDebugShortcut) {
    return finalizeDeterministicOperation(context, message, gmailSyncDebugShortcut, "gmail_sync_debug");
  }

  const gmailSyncShortcut = gmailSyncShortcutOperation(message);
  if (gmailSyncShortcut) {
    return finalizeDeterministicOperation(context, message, gmailSyncShortcut, "gmail_sync");
  }

  const gmailBuiltInRuleShortcut = gmailBuiltInRuleEnableShortcutOperation(message, context);
  if (gmailBuiltInRuleShortcut) {
    return finalizeDeterministicOperation(context, message, gmailBuiltInRuleShortcut, "gmail_rule_management");
  }

  const gmailReviewListShortcut = gmailReviewListShortcutOperation(message, context);
  if (gmailReviewListShortcut) {
    return finalizeDeterministicOperation(context, message, gmailReviewListShortcut, "gmail_reviews");
  }

  const gmailReviewInspectShortcut = gmailReviewInspectShortcutOperation(message, context);
  if (gmailReviewInspectShortcut) {
    return finalizeDeterministicOperation(context, message, gmailReviewInspectShortcut, "gmail_reviews");
  }

  const reminderListShortcut = actionReminderListShortcutOperation(message);
  if (reminderListShortcut) {
    return finalizeDeterministicOperation(context, message, reminderListShortcut, "actions");
  }

  const meetingListShortcut = actionMeetingListShortcutOperation(message);
  if (meetingListShortcut) {
    return finalizeDeterministicOperation(context, message, meetingListShortcut, "actions");
  }

  const gmailConnectionShortcut = gmailConnectionShortcutOperation(message, context);
  if (gmailConnectionShortcut) {
    return finalizeDeterministicOperation(context, message, gmailConnectionShortcut, "gmail_status");
  }

  const gmailAutonomyStatusShortcut = gmailAutonomyStatusShortcutOperation(message);
  if (gmailAutonomyStatusShortcut) {
    return finalizeDeterministicOperation(context, message, gmailAutonomyStatusShortcut, "gmail_autonomy");
  }

  const gmailNudgeSettingsShortcut = !pending ? gmailNudgeSettingsShortcutOperation(message) : undefined;
  if (gmailNudgeSettingsShortcut) {
    return finalizeDeterministicOperation(context, message, gmailNudgeSettingsShortcut, "proactive_settings");
  }

  if (!pending) {
    // Checked FIRST, ahead of every Gmail-review shortcut: a bare "complete it"/"done"/"archive
    // it"/"snooze it tomorrow" right after the worker sends a due-action notification is a real,
    // reported failure mode otherwise — the real LLM planner has nothing but session.visibleEntities
    // to go on, and that can be stuck pointing at an already-decided Gmail review (rejecting a
    // review with an empty "remaining" list never clears it — see applyExecutionSideEffects — so
    // the LAST thing shown stays "visible" even after the user acted on it), producing exactly the
    // observed bug: "complete it" tried to re-decide an already-rejected email review instead of
    // completing the task the worker had just reminded them about. This resolves deterministically
    // BEFORE the planner ever sees the message, so that stale context can never cause a wrong tool
    // choice for this specific, unambiguous, high-value pattern. Only ever targets a real
    // ActionItem — see actionCompletionShortcutOperation's own explicit "no email/review wording"
    // guard for why a Gmail review is never in scope here at all.
    const actionCompletionShortcut = await actionCompletionShortcutOperation(message, context);
    if (actionCompletionShortcut) {
      return finalizeDeterministicOperation(context, message, actionCompletionShortcut, "actions");
    }

    // Checked ahead of the pure-review-only shortcuts below: only ever produces operations when
    // the message ALSO contains a Gmail sync-frequency request ("check email sync every 1h") —
    // a message with none returns [] immediately and falls through unchanged. Handles the
    // reported compound transcript ("delete it nothing important, and can u check email sync
    // every 1h?") as ONE turn: the visible review really gets rejected AND the sync-schedule
    // proposal really opens, rather than one silently overwriting or dropping the other.
    const gmailAutonomyCompoundShortcuts = gmailAutonomyCompoundShortcutOperations(message, context);
    if (gmailAutonomyCompoundShortcuts.length > 0) {
      return finalizeDeterministicOperations(context, message, gmailAutonomyCompoundShortcuts, "gmail_autonomy");
    }

    const gmailReviewTriageShortcuts = gmailReviewExplicitTriageShortcutOperations(message, context);
    if (gmailReviewTriageShortcuts.length > 0) {
      return finalizeDeterministicOperations(context, message, gmailReviewTriageShortcuts, "gmail_reviews");
    }

    const gmailReviewToActionShortcuts = gmailReviewToActionShortcutOperations(message, context);
    if (gmailReviewToActionShortcuts.length > 0) {
      return finalizeDeterministicOperations(context, message, gmailReviewToActionShortcuts, "gmail_reviews");
    }

    const actionTimeCorrectionShortcut = actionTimeCorrectionShortcutOperation(message, context);
    if (actionTimeCorrectionShortcut) {
      return finalizeDeterministicOperation(context, message, actionTimeCorrectionShortcut, "actions");
    }

    const preDueReminderShortcut = preDueReminderShortcutOperation(message, context);
    if (preDueReminderShortcut) {
      return finalizeDeterministicOperation(context, message, preDueReminderShortcut, "actions");
    }
  }

  // A legacy PendingAction (from a slash-command flow like /action_hygiene or a Gmail rule
  // proposal) still lives entirely in server.ts's legacy resolver — v3 has no tool that can
  // safely execute it (applyPendingAction is entangled with Gmail-rule/action-hygiene helpers
  // that aren't safely importable here). v3's own pendingOperation always takes precedence
  // (handled above); only once that's empty do we check for a legacy one. Explicit Gmail
  // connect/reconnect/alert requests above are safe read-only/proposal flows and must not be
  // swallowed by stale legacy pending state; everything else deflects before the planner.
  if (!pending && context.legacyPendingAction) {
    return finalizeLegacyPendingActionAmbiguous(context, context.legacyPendingAction);
  }

  if (pending) {
    const pendingGmailRule = pending.operations.find((op) => op.tool === "gmail.rule.create");
    if (pendingGmailRule && GMAIL_PENDING_NOTIFICATION_FOLLOWUP_RE.test(message.trim())) {
      const label = String(pendingGmailRule.args.label ?? "this");
      return finalize(context, {
        reply: `I can notify you when a manual or scheduled Gmail check creates a review for ${label}. This is not instant email arrival tracking. Matches go to email reviews first. Confirm creating this rule?`,
        operationsPlanned: [],
        executedOps: [],
        plannerUsed: "none",
        llmPlannerAttempted: false,
        toolValidationPassed: true,
        topic: pending.topic
      });
    }
  }

  if (shouldShowGoalAnchorNudge(context, message)) {
    return finalize(context, {
      reply: GOAL_ANCHOR_NUDGE_REPLY,
      operationsPlanned: [],
      executedOps: [],
      plannerUsed: "none",
      llmPlannerAttempted: false,
      toolValidationPassed: true,
      topic: "goal_anchor_nudge"
    });
  }

  // Checked here — AFTER every deterministic domain shortcut above (Gmail sync/autonomy/status/
  // alerts/reviews, action completion/snooze/archive, reminders, proactive settings) — rather
  // than as the very first thing in the turn. A real smoke test found "check gmail every hour"
  // classified as "avoidance" of an unrelated active reading goal, purely because the guardrail's
  // LLM tier ran on literally every message before anything else got a chance to recognize it as
  // a plain operational command. Goal-avoidance is only a meaningful question for a message that
  // ISN'T already a clear, unambiguous domain action — exactly the set of messages that reach
  // this point without an earlier shortcut having already handled them. This never widens what
  // the guardrail blocks, only narrows which messages are even offered to it.
  logAgentRuntimeDiagnostics({
    phase: "guardrail_check",
    userId,
    note: "no domain shortcut matched; message reaches goal-avoidance guardrail"
  });
  const guardrail = await checkGoalGuardrail(message, context);
  if (guardrail.decision !== "allow") {
    // hard_block/soft_warn are real, detected conflicts worth a durable trace (feeds existing
    // insight/daily-review pipelines that already read risk_pattern memories); ask_clarification
    // is not — nothing was actually confirmed yet, so nothing is logged.
    const executedOps: ExecutedOperation[] =
      guardrail.decision === "hard_block" || guardrail.decision === "soft_warn" ? [await logGuardrailIncident(userId, message, guardrail)] : [];
    applyExecutionSideEffects(context.session, executedOps);
    return finalize(context, {
      reply: guardrail.reply ?? "Let's pause here for a moment.",
      operationsPlanned: [],
      executedOps,
      plannerUsed: "none",
      llmPlannerAttempted: guardrail.llmAttempted,
      toolValidationPassed: true,
      topic: "guardrail"
    });
  }

  const { plan, plannerUsed } = await planMessage(message, context);
  const reconciledOperations = reconcileExplicitGmailReviewIntentOperations(message, context, plan.operations);

  const validatedOps = validateOperations(reconciledOperations, context);
  const toolValidationPassed = validatedOps.every((op) => op.status !== "invalid" && op.status !== "unsupported");
  const explicitReviewIntentPlan = buildExplicitGmailReviewIntentPlan(message, context);
  logAgentRuntimeDiagnostics({
    phase: "validated_operations",
    userId,
    plannerOps: plan.operations,
    explicitReviewIntentMap: explicitReviewIntentPlan?.entries,
    finalOps: reconciledOperations,
    validatedOps,
    mutationTools: validatedOps.filter((op) => op.status === "valid" && getToolDefinition(op.tool)?.mutates).map((op) => op.tool)
  });

  // Pending-operation firewall: while a mutation is awaiting confirmation, no OTHER mutation
  // may run — not even a fresh, unrelated one, and not even a re-ask of the same one. This is
  // checked on the raw validated ops (any status), so it also blocks a plan that tries to
  // re-propose gmail.rule.create instead of emitting a genuine confirmation.
  if (pending && validatedOps.some((op) => getToolDefinition(op.tool)?.mutates === true)) {
    return finalize(context, {
      reply: `You still have a pending confirmation for ${pending.summary}. Confirm, cancel, or tell me a new request.`,
      operationsPlanned: reconciledOperations,
      executedOps: [],
      plannerUsed,
      llmPlannerAttempted: true,
      toolValidationPassed,
      topic: pending.topic
    });
  }

  const metaOps = validatedOps.filter((op) => META_TOOLS.has(op.tool) && op.status === "valid");
  const referenceClarifications = validatedOps.filter((op) => op.status === "needs_clarification");
  const pendingConfirmationOps = validatedOps.filter((op) => op.status === "needs_confirmation");
  const problemOps = validatedOps.filter((op) => op.status === "invalid" || op.status === "unsupported");
  const executableOps = validatedOps.filter((op) => op.status === "valid" && !META_TOOLS.has(op.tool));

  const topic = resolveTopic(reconciledOperations, plan.topic, context.session.topic);

  let executedOps: ExecutedOperation[] = [];
  let clarificationQuestion: string | undefined;

  const askMeta = metaOps.find((op) => op.tool === "clarification.ask");

  // Deliberately does NOT trust an LLM-emitted confirmation.confirm/cancel here — live
  // testing showed the model can over-eagerly treat an unrelated follow-up as a confirmation.
  // The exact whitelist check above is the ONLY path that can confirm/cancel.

  if (askMeta) {
    clarificationQuestion = String(askMeta.args.question ?? "Could you clarify what you mean?");
  } else {
    executedOps = await Promise.all(executableOps.map((op) => executeOperation(userId, op, context, message)));
    applyExecutionSideEffects(context.session, executedOps);
    logAgentRuntimeDiagnostics({
      phase: "executed_operations",
      userId,
      finalOps: reconciledOperations,
      validatedOps,
      mutationTools: executedOps.filter((op) => op.status === "executed" && getToolDefinition(op.tool)?.mutates).map((op) => op.tool)
    });

    // pendingConfirmationOps can only be non-empty here when `pending` was null (the firewall
    // above already returned for any mutation attempt while a pending operation exists).
    if (pendingConfirmationOps.length > 0) {
      const summary = summarizePendingOperations(pendingConfirmationOps);
      setPendingOperation(context.session, createPendingOperationRecord(topic, summary, pendingConfirmationOps));
    }

    if (referenceClarifications.length > 0) {
      clarificationQuestion = referenceClarifications[0]?.clarificationQuestion;
    }
  }

  const reply = composeReply({
    replyDraft: plan.replyDraft,
    clarificationQuestion,
    pendingConfirmationOps,
    executedOps,
    problemOps
  });

  const plannedPlanningOp = reconciledOperations.find((op) => isPlanningTool(op.tool));
  const planningTrace = recordPlanningTrace(
    {
      message,
      plannedOp: plannedPlanningOp,
      validatedOp: validatedOps.find((op) => isPlanningTool(op.tool)),
      executedOp: executedOps.find((op) => isPlanningTool(op.tool)),
      pendingOperationBefore,
      visibleEntitiesBefore,
      composerSource: inferComposerSource({ clarificationQuestion, pendingConfirmationOps, executedOps, problemOps, replyDraft: plan.replyDraft })
    },
    context.session
  );

  return finalize(context, {
    reply,
    operationsPlanned: reconciledOperations,
    executedOps,
    plannerUsed,
    llmPlannerAttempted: true,
    toolValidationPassed,
    topic,
    planningTrace
  });
}

function normalizeExactMessage(message: string): string {
  return message.trim().toLowerCase().replace(/[.!]+$/, "");
}

async function finalizeDeterministicOperation(
  context: ContextBundle,
  message: string,
  plannedOperation: PlannedOperation,
  topic: string
): Promise<AgentMessageResponse> {
  logAgentRuntimeDiagnostics({
    phase: "domain_shortcut_matched",
    userId: context.session.userId,
    finalOps: [plannedOperation],
    note: `domain shortcut matched: ${plannedOperation.tool}; guardrail skipped because operational command matched`
  });
  const pendingOperationBefore = context.session.pendingOperation;
  const visibleEntitiesBefore = context.session.visibleEntities;
  const validatedOps = validateOperations([plannedOperation], context);
  const toolValidationPassed = validatedOps.every((op) => op.status !== "invalid" && op.status !== "unsupported");
  const pendingConfirmationOps = validatedOps.filter((op) => op.status === "needs_confirmation");
  const problemOps = validatedOps.filter((op) => op.status === "invalid" || op.status === "unsupported");
  const executableOps = validatedOps.filter((op) => op.status === "valid" && !META_TOOLS.has(op.tool));
  const executedOps = await Promise.all(executableOps.map((op) => executeOperation(context.session.userId, op, context, message)));
  applyExecutionSideEffects(context.session, executedOps);

  if (pendingConfirmationOps.length > 0) {
    const summary = summarizePendingOperations(pendingConfirmationOps);
    setPendingOperation(context.session, createPendingOperationRecord(topic, summary, pendingConfirmationOps));
  }

  const clarification = validatedOps.find((op) => op.status === "needs_clarification")?.clarificationQuestion;
  const reply = composeReply({
    replyDraft: "",
    clarificationQuestion: clarification,
    pendingConfirmationOps,
    executedOps,
    problemOps
  });

  const planningTrace = recordPlanningTrace(
    {
      message,
      plannedOp: plannedOperation,
      validatedOp: validatedOps[0],
      executedOp: executedOps.find((op) => isPlanningTool(op.tool)),
      pendingOperationBefore,
      visibleEntitiesBefore,
      composerSource: inferComposerSource({ clarificationQuestion: clarification, pendingConfirmationOps, executedOps, problemOps, replyDraft: "" })
    },
    context.session
  );

  return finalize(context, {
    reply,
    operationsPlanned: [plannedOperation],
    executedOps,
    plannerUsed: "none",
    llmPlannerAttempted: false,
    toolValidationPassed,
    topic,
    planningTrace
  });
}

async function finalizeDeterministicOperations(
  context: ContextBundle,
  message: string,
  plannedOperations: PlannedOperation[],
  topic: string
): Promise<AgentMessageResponse> {
  logAgentRuntimeDiagnostics({
    phase: "domain_shortcut_matched",
    userId: context.session.userId,
    finalOps: plannedOperations,
    note: `domain shortcut matched: ${plannedOperations.map((op) => op.tool).join(", ")}; guardrail skipped because operational command matched`
  });
  const pendingOperationBefore = context.session.pendingOperation;
  const visibleEntitiesBefore = context.session.visibleEntities;
  const validatedOps = validateOperations(plannedOperations, context);
  const toolValidationPassed = validatedOps.every((op) => op.status !== "invalid" && op.status !== "unsupported");
  const pendingConfirmationOps = validatedOps.filter((op) => op.status === "needs_confirmation");
  const problemOps = validatedOps.filter((op) => op.status === "invalid" || op.status === "unsupported");
  const executableOps = validatedOps.filter((op) => op.status === "valid" && !META_TOOLS.has(op.tool));
  const executedOps: ExecutedOperation[] = [];

  for (const op of executableOps) {
    executedOps.push(await executeOperation(context.session.userId, op, context, message));
  }
  applyExecutionSideEffects(context.session, executedOps);
  logAgentRuntimeDiagnostics({
    phase: "deterministic_operations_executed",
    userId: context.session.userId,
    finalOps: plannedOperations,
    validatedOps,
    mutationTools: executedOps.filter((op) => op.status === "executed" && getToolDefinition(op.tool)?.mutates).map((op) => op.tool)
  });

  if (pendingConfirmationOps.length > 0) {
    const summary = summarizePendingOperations(pendingConfirmationOps);
    setPendingOperation(context.session, createPendingOperationRecord(topic, summary, pendingConfirmationOps));
  }

  const clarification = validatedOps.find((op) => op.status === "needs_clarification")?.clarificationQuestion;
  const reply = composeReply({
    replyDraft: "",
    clarificationQuestion: clarification,
    pendingConfirmationOps,
    executedOps,
    problemOps
  });

  const planningTrace = recordPlanningTrace(
    {
      message,
      plannedOp: plannedOperations[0],
      validatedOp: validatedOps[0],
      executedOp: executedOps.find((op) => isPlanningTool(op.tool)),
      pendingOperationBefore,
      visibleEntitiesBefore,
      composerSource: inferComposerSource({ clarificationQuestion: clarification, pendingConfirmationOps, executedOps, problemOps, replyDraft: "" })
    },
    context.session
  );

  return finalize(context, {
    reply,
    operationsPlanned: plannedOperations,
    executedOps,
    plannerUsed: "none",
    llmPlannerAttempted: false,
    toolValidationPassed,
    topic,
    planningTrace
  });
}

function gmailReviewListShortcutOperation(message: string, context?: ContextBundle): PlannedOperation | undefined {
  const text = normalizeIntentText(message);
  if (!text) {
    return undefined;
  }

  const asksReviewList =
    /\b(show|list|see|view|open|pending|waiting|need|needs|attention)\b[\s\S]{0,50}\b(email reviews?|gmail reviews?|emails? to review|items? to review)\b/.test(text) ||
    /\b(email reviews?|gmail reviews?|emails? to review|items? to review)\b[\s\S]{0,50}\b(show|list|see|view|open|pending|waiting|need|needs|attention)\b/.test(text) ||
    /^email reviews?$/.test(text) ||
    /\bwhat emails? need (my )?attention\b/.test(text) ||
    (/^show me (?:the )?reviews?$/.test(text) && Boolean(context && (context.gmailReviews.length > 0 || hasRecentGmailContext(context)))) ||
    // "any emails left to review?", "anything left to review?" — a natural follow-up after
    // triaging some of a list, only trusted once the conversation has actually touched Gmail
    // reviews recently (same contextual gate as "show me the reviews" above), since "anything
    // left" alone is too generic a phrase to trust unconditionally.
    (/\b(any|anything)\b[\s\S]{0,30}\bleft\b[\s\S]{0,20}\b(review|reviews|emails?)\b|\b(emails?|reviews?)\b[\s\S]{0,20}\bleft\b[\s\S]{0,20}\breview\b/.test(text) &&
      Boolean(context && (context.gmailReviews.length > 0 || hasRecentGmailContext(context))));

  if (!asksReviewList) {
    return undefined;
  }

  return { tool: "gmail.review.list", args: { status: "pending" }, rationale: "user asked to see pending Gmail reviews" };
}

function gmailReviewInspectShortcutOperation(message: string, context: ContextBundle): PlannedOperation | undefined {
  const visibleReviews = context.session.visibleEntities.filter((entity) => entity.type === "gmail_review");
  if (visibleReviews.length === 0) {
    return undefined;
  }

  const text = normalizeIntentText(message);
  if (
    !text ||
    /\b(turn|convert|make|create|add|reject|ignore|approve|task|action|remind|reminder)\b/.test(text) ||
    gmailReviewListShortcutOperation(message, context)
  ) {
    return undefined;
  }

  const asksQuestion = /\b(does|do|is|are|has|have|hay|tiene|mentions?|contains?|info|what|which|tell me about)\b/.test(text) || text.endsWith("?");
  const selected = selectVisibleEntityMention(text, visibleReviews);
  if (!asksQuestion || !selected) {
    return undefined;
  }

  return {
    tool: "gmail.review.inspect",
    args: { reviewId: selected.id, question: message.trim() },
    rationale: "user asked about one visible Gmail review"
  };
}

type ExplicitGmailReviewIntent = "ignore" | "task" | "keep";

interface ExplicitGmailReviewIntentEntry {
  index: number;
  intent: ExplicitGmailReviewIntent;
  position: number;
  order: number;
}

interface ExplicitGmailReviewIntentPlan {
  operations: PlannedOperation[];
  entries: ExplicitGmailReviewIntentEntry[];
  dueText?: string;
  reminderLeadMinutes?: number;
}

function gmailReviewExplicitTriageShortcutOperations(message: string, context: ContextBundle): PlannedOperation[] {
  const plan = buildExplicitGmailReviewIntentPlan(message, context);
  if (!plan) {
    return [];
  }
  logAgentRuntimeDiagnostics({
    phase: "deterministic_gmail_review_triage",
    userId: context.session.userId,
    plannerOps: [],
    explicitReviewIntentMap: plan.entries,
    finalOps: plan.operations,
    mutationTools: plan.operations.filter((op) => getToolDefinition(op.tool)?.mutates).map((op) => op.tool)
  });
  return plan.operations;
}

function gmailReviewToActionShortcutOperations(message: string, context: ContextBundle): PlannedOperation[] {
  const visibleReviews = context.session.visibleEntities.filter((entity) => entity.type === "gmail_review");
  if (visibleReviews.length === 0) {
    return [];
  }

  const text = normalizeIntentText(message);
  if (!/\b(turn|convert|make|create|add)\b/.test(text) || !/\b(tasks?|actions?|reminders?)\b/.test(text)) {
    return [];
  }

  const indexes = extractVisibleIndexesFromReviewActionMessage(text, visibleReviews);
  const targetRefs: Array<{ index?: number; reviewId?: string }> = indexes.map((index) => ({ index }));

  if (targetRefs.length === 0) {
    const selected = selectVisibleEntityMention(text, visibleReviews);
    if (selected) {
      targetRefs.push(visibleEntityToGmailReviewRef(selected));
    } else if (visibleReviews.length === 1 && isGenericSingleVisibleReviewTaskReference(text)) {
      targetRefs.push(visibleEntityToGmailReviewRef(visibleReviews[0]!));
    } else {
      return [];
    }
  }

  const reminderLeadMinutes = extractPreDueReminderLeadMinutes(text);
  const dueText = /\b(time (?:they|it|each|the email|mail) (?:say|says)|time in (?:each )?(?:email|mail)|at the time)\b/.test(text)
    ? undefined
    : extractNaturalDueTextFromMessage(text);

  return targetRefs.map((targetRef) => ({
    tool: "gmail.review.to_action",
    args: {
      ...targetRef,
      ...(dueText ? { dueText } : {}),
      ...(reminderLeadMinutes !== undefined ? { reminderLeadMinutes } : {})
    },
    rationale: "user asked to turn visible Gmail reviews into tasks"
  }));
}

function reconcileExplicitGmailReviewIntentOperations(
  message: string,
  context: ContextBundle,
  operations: PlannedOperation[]
): PlannedOperation[] {
  const plan = buildExplicitGmailReviewIntentPlan(message, context);
  if (!plan) {
    return operations;
  }

  const reviewTools = new Set(["gmail.review.reject", "gmail.review.to_action", "gmail.review.keep", "gmail.review.approve"]);
  const nonReviewOps = operations.filter((op) => !reviewTools.has(op.tool));
  const finalOps = [...plan.operations, ...nonReviewOps];
  logAgentRuntimeDiagnostics({
    phase: "reconciled_gmail_review_triage",
    userId: context.session.userId,
    plannerOps: operations,
    explicitReviewIntentMap: plan.entries,
    finalOps,
    mutationTools: finalOps.filter((op) => getToolDefinition(op.tool)?.mutates).map((op) => op.tool)
  });
  return finalOps;
}

function buildExplicitGmailReviewIntentPlan(message: string, context: ContextBundle): ExplicitGmailReviewIntentPlan | undefined {
  const visibleReviews = context.session.visibleEntities.filter((entity) => entity.type === "gmail_review");
  if (visibleReviews.length === 0) {
    return undefined;
  }

  const text = normalizeIntentText(message);
  const visibleIndexSet = new Set(visibleReviews.map((entity) => entity.index).filter((index): index is number => typeof index === "number"));
  const entries = extractExplicitGmailReviewIntentEntries(text, visibleIndexSet);
  if (entries.length === 0) {
    return undefined;
  }

  const dueText = extractNaturalDueTextFromMessage(text);
  const reminderLeadMinutes = extractGmailReviewReminderLeadMinutes(text);
  const operations = entries.map<PlannedOperation>((entry) => {
    if (entry.intent === "ignore") {
      return {
        tool: "gmail.review.reject",
        args: { index: entry.index },
        rationale: "user explicitly asked to ignore a visible Gmail review"
      };
    }

    if (entry.intent === "keep") {
      return {
        tool: "gmail.review.keep",
        args: { index: entry.index },
        rationale: "user explicitly asked to keep a visible Gmail review pending"
      };
    }

    return {
      tool: "gmail.review.to_action",
      args: {
        index: entry.index,
        ...(dueText ? { dueText } : {}),
        ...(reminderLeadMinutes !== undefined ? { reminderLeadMinutes } : {})
      },
      rationale: "user explicitly asked to turn a visible Gmail review into a task"
    };
  });

  return { operations, entries, dueText, reminderLeadMinutes };
}

function extractExplicitGmailReviewIntentEntries(text: string, visibleIndexSet: Set<number>): ExplicitGmailReviewIntentEntry[] {
  const candidates: ExplicitGmailReviewIntentEntry[] = [];
  let order = 0;
  const addEntries = (intent: ExplicitGmailReviewIntent, position: number, rawIndexes: string) => {
    for (const index of extractIndexesFromText(rawIndexes, visibleIndexSet)) {
      candidates.push({ index, intent, position, order: order++ });
    }
  };
  // "keep them there for now", "keep both in review", "delete both" — a plural/all quantifier
  // with no explicit number at all means every currently visible review, not one specific,
  // ambiguous item. A real Telegram smoke test found "keep both in review for now" (with exactly
  // two visible reviews) sent to the LLM planner, which echoed one review's own subject text back
  // as a `ref` that then failed to resolve, producing a confusing "which one did you mean?" for a
  // message that was never actually ambiguous. This only ever fires when visibleReviews is
  // non-empty (buildExplicitGmailReviewIntentPlan's own early return), so it's already scoped to
  // an active Gmail-review-triage conversation.
  const addAllVisibleEntries = (intent: ExplicitGmailReviewIntent, position: number) => {
    for (const index of visibleIndexSet) {
      candidates.push({ index, intent, position, order: order++ });
    }
  };

  // Alecto never mutates the actual Gmail mailbox — "delete"/"remove"/"discard" a review is the
  // same real action as "ignore"/"reject" it (both just decide the EmailReviewItem, never the
  // email itself), so all of these verbs map to the identical "ignore" intent/gmail.review.reject
  // tool. A real Telegram smoke test's "u can delete 3 its nothing important" was silently missed
  // entirely because "delete" wasn't recognized as one of the ignore-intent verbs at all.
  for (const match of text.matchAll(/\b(?:ignore|ifnore|reject|skip|delete|remove|discard)\s+(?:number\s+)?((?:#?\d+\s*(?:,|\band\b|\by\b|&)?\s*)+)/g)) {
    if (match[1]) {
      addEntries("ignore", match.index ?? 0, match[1]);
    }
  }

  // The reversed phrasing — the index named first, then a dismissive judgment about it ("3 is
  // nothing important", "3 isn't relevant", "4 is junk/spam") — same intent, index-before-verb
  // word order instead of verb-before-index.
  for (const match of text.matchAll(
    /\b((?:#?\d+\s*(?:,|\band\b|\by\b|&)?\s*)+)\s+(?:is|are|isn't|is not|aren't|are not)\s+(?:nothing important|not important|not relevant|irrelevant|junk|spam)\b/g
  )) {
    if (match[1]) {
      addEntries("ignore", match.index ?? 0, match[1]);
    }
  }

  for (const match of text.matchAll(/\b(?:turn|convert|make|create|add)\s+((?:#?\d+\s*(?:,|\band\b|\by\b|&)?\s*)+)\s+(?:into|to|as)\s+(?:a\s+|an\s+)?(?:tasks?|actions?|reminders?)\b/g)) {
    if (match[1]) {
      addEntries("task", match.index ?? 0, match[1]);
    }
  }

  for (const match of text.matchAll(/\b(?:keep|leave)\s+((?:#?\d+\s*(?:,|\band\b|\by\b|&)?\s*)+)\s+(?:in\s+)?(?:review|reviews?|pending|for later)\b/g)) {
    if (match[1]) {
      addEntries("keep", match.index ?? 0, match[1]);
    }
  }

  for (const match of text.matchAll(/\b((?:#?\d+\s*(?:,|\band\b|\by\b|&)?\s*)+)\s+(?:keep|leave)\s+(?:them\s+|these\s+|those\s+)?(?:in\s+)?(?:review|reviews?|pending|for later)\b/g)) {
    if (match[1]) {
      addEntries("keep", match.index ?? 0, match[1]);
    }
  }

  // Plural/all quantifier, no explicit number — English "keep them"/"leave both"/"keep all of
  // them" (deliberately no trailing "review/pending" requirement here, unlike the numbered
  // pattern above: the reported transcript's exact phrase, "keep them there for now", has no
  // domain word at all, and this whole extraction only ever runs with real visible reviews). The
  // negative lookbehind excludes "them"/"these"/"those" immediately after a number ("4 and 6
  // keep them in review") — that's the INDEX-FIRST keep pattern below's own pass-through pronoun
  // referring back to the numbers just named, not a request to keep every visible review; without
  // this guard, a real mixed-triage message ("...4 and 6 keep them in review for later") had this
  // plural match incorrectly override the correctly-extracted numbered task/keep decisions for
  // OTHER, unrelated indexes elsewhere in the same message.
  {
    const match = text.match(/(?<!\d\s)\b(?:keep|leave)\s+(?:them|these|those|both|all(?:\s+of\s+them)?)\b/);
    if (match) {
      addAllVisibleEntries("keep", match.index ?? 0);
    }
  }
  // Spanish: "deja los dos para luego", "mantén ambos en revisión" (accents already stripped by
  // normalizeIntentText, so "mantén" arrives as "manten" and "revisión" as "revision").
  {
    const match = text.match(
      /\b(?:deja|dejalo|dejalos|dejalas|manten|mantenlo|mantenlos|mantenlas|guarda|guardalo|guardalos|guardalas)\b[\s\S]{0,20}\b(?:los\s+dos|las\s+dos|ambos|ambas|todos|todas)\b/
    );
    if (match) {
      addAllVisibleEntries("keep", match.index ?? 0);
    }
  }
  // Catalan: "deixa'ls per després" — the pronoun is fused onto the verb ("-ls" = "them"), so
  // this alone already means "leave them," no separate quantifier word needed.
  {
    const match = text.match(/\bdeixa'?ls\b/);
    if (match) {
      addAllVisibleEntries("keep", match.index ?? 0);
    }
  }

  // Plural/all quantifier for ignore/task intents too, English only for now — mirrors the keep
  // case above so "ignore them"/"delete both"/"turn both into tasks" don't hit the same
  // ambiguous-ref bug the keep phrasing did.
  {
    const match = text.match(/(?<!\d\s)\b(?:ignore|ifnore|reject|skip|delete|remove|discard)\s+(?:them|these|those|both|all(?:\s+of\s+them)?)\b/);
    if (match) {
      addAllVisibleEntries("ignore", match.index ?? 0);
    }
  }
  {
    const match = text.match(/(?<!\d\s)\b(?:turn|convert|make|create|add)\s+(?:them|these|those|both|all(?:\s+of\s+them)?)\s+(?:into|to|as)\s+(?:a\s+|an\s+)?(?:tasks?|actions?|reminders?)\b/);
    if (match) {
      addAllVisibleEntries("task", match.index ?? 0);
    }
  }

  const byIndex = new Map<number, ExplicitGmailReviewIntentEntry>();
  for (const candidate of candidates) {
    const current = byIndex.get(candidate.index);
    if (!current || gmailReviewIntentPriority(candidate.intent) > gmailReviewIntentPriority(current.intent)) {
      byIndex.set(candidate.index, candidate);
    }
  }

  return [...byIndex.values()].sort((left, right) => left.position - right.position || left.order - right.order || left.index - right.index);
}

function extractIndexesFromText(text: string, visibleIndexSet: Set<number>): number[] {
  const indexes = [...text.matchAll(/\b\d+\b/g)]
    .map((match) => Number(match[0]))
    .filter((index) => visibleIndexSet.has(index));
  return [...new Set(indexes)];
}

function gmailReviewIntentPriority(intent: ExplicitGmailReviewIntent): number {
  if (intent === "ignore") return 3;
  if (intent === "keep") return 2;
  return 1;
}

function extractGmailReviewReminderLeadMinutes(text: string): number | undefined {
  if (/\bremind\b[\s\S]{0,80}\b(?:at that time|at the same time|same time|then)\b/.test(text)) {
    return 0;
  }
  return extractPreDueReminderLeadMinutes(text);
}

const EMAIL_REVIEW_REFERENCE_PATTERN = /\b(email|emails|gmail|inbox|mail|mails|review|reviews)\b/;
const ACTION_COMPLETION_PATTERN = /\b(complete(d)?|finish(ed)?|mark(ed)? (?:it |that )?(?:as )?(?:done|complete))\b/;
// "hecho" (Spanish "done") and Catalan "fet"/"ja està fet" ("done"/"it's already done" — the
// clitic phrasing doesn't start with "fet", so it needs its own unanchored alternative alongside
// the simple leading-word case).
const ACTION_DONE_PATTERN = /^(done|finished|hecho|terminado|listo|fet|llest)\b|\bja\s+(esta|ho he)\s+fet\b/;
const ACTION_ARCHIVE_PATTERN = /\b(archive|dismiss)\b/;
const ACTION_SNOOZE_PATTERN = /\bsnooze\b/;
/** Generic pronoun/bare-acknowledgement reference only — a message that names something by its
 * own specific words ("complete the Nietzsche book goal") should still go through the normal
 * planner/validator resolution path, not this shortcut, which exists only for the truly ambiguous
 * "it"/"that"/bare-word case a worker notification leaves the user replying to. */
const GENERIC_ACTION_REFERENCE_PATTERN = /\b(it|that one|that|this one|this)\b/;

/**
 * Deterministic resolution for a generic "complete it"/"done"/"archive it"/"snooze it tomorrow"
 * reply — see the call site in processAgentMessageInner for why this exists and runs before the
 * planner. Never fires when the message itself references an email/Gmail review (requirement:
 * Alecto must only ever act on a Gmail review when the user explicitly says so), and only fires
 * for a generic pronoun-shaped reference, never a message that names something specific in its own
 * words (that's left to the normal planner + validator's resolveActionRef).
 */
async function actionCompletionShortcutOperation(message: string, context: ContextBundle): Promise<PlannedOperation | undefined> {
  const text = normalizeIntentText(message);
  // Any digit means the user named something by number ("complete 1, snooze 2, archive 3") —
  // that's an explicit numbered reference (or a multi-item batch) the normal planner + validator's
  // own numbered-list resolution already handles correctly; this shortcut exists only for the
  // genuinely ambiguous bare-pronoun case a worker notification leaves the user replying to.
  if (!text || EMAIL_REVIEW_REFERENCE_PATTERN.test(text) || /\d/.test(text)) {
    return undefined;
  }

  let tool: "action.complete" | "action.archive" | "action.snooze" | undefined;
  let untilText: string | undefined;

  if (ACTION_SNOOZE_PATTERN.test(text)) {
    untilText = extractNaturalDueTextFromMessage(text);
    // action.snooze's untilText is required — without one to extract, fall through rather than
    // plan an operation the validator can only reject.
    if (!untilText) {
      return undefined;
    }
    tool = "action.snooze";
  } else if (ACTION_ARCHIVE_PATTERN.test(text)) {
    tool = "action.archive";
  } else if (ACTION_COMPLETION_PATTERN.test(text) || ACTION_DONE_PATTERN.test(text)) {
    tool = "action.complete";
  } else {
    return undefined;
  }

  if (tool !== "action.snooze" && !GENERIC_ACTION_REFERENCE_PATTERN.test(text) && !ACTION_DONE_PATTERN.test(text)) {
    return undefined;
  }

  const resolved = await resolveMostRecentlyNotifiedOrVisibleActionId(context);
  logAgentRuntimeDiagnostics({
    phase: "action_completion_shortcut",
    userId: context.session.userId,
    note: resolved ? `resolved to ActionItem ${resolved.actionId} via ${resolved.source}, tool=${tool}` : "no ActionItem resolved — falling through to normal planner"
  });
  if (!resolved) {
    return undefined;
  }

  return {
    tool,
    args: { actionId: resolved.actionId, ...(untilText ? { untilText } : {}) },
    rationale: "user replied generically about the most recently notified/visible task, not a Gmail review"
  };
}

/**
 * Ground truth for "which task is 'it'" when the message itself gives no better clue: prefers
 * whichever real ActionItem the worker most recently actually notified the user about (via
 * sendDueActionReminders' own ActionItemReminderLog — see getMostRecentlyRemindedActionItem's doc
 * comment for why this exists at all: the worker has no way to update this chat session's own
 * visibleEntities, so relying on session state alone left "it" resolving to whatever was visible
 * from an unrelated EARLIER turn, e.g. a Gmail review the user had already rejected). Only trusts
 * a notification from the last 24 hours — an old, possibly-stale reminder from days ago is not a
 * safe silent target. Falls back to a plain visible "action" entity in session when no recent
 * notification exists at all (e.g. right after creating a task in the very same conversation,
 * before the worker has had any chance to notify about anything).
 */
async function resolveMostRecentlyNotifiedOrVisibleActionId(
  context: ContextBundle
): Promise<{ actionId: string; source: "reminded_by_worker" | "visible_session_entity" } | undefined> {
  const remindedAction = await getMostRecentlyRemindedActionItem(context.session.userId, {
    since: new Date(Date.now() - 24 * 60 * 60 * 1000)
  });
  if (remindedAction) {
    return { actionId: remindedAction.id, source: "reminded_by_worker" };
  }

  const visibleAction = context.session.visibleEntities.find((entity) => entity.type === "action");
  return visibleAction ? { actionId: visibleAction.id, source: "visible_session_entity" } : undefined;
}

function actionTimeCorrectionShortcutOperation(message: string, context: ContextBundle): PlannedOperation | undefined {
  const visibleActions = context.session.visibleEntities.filter((entity) => entity.type === "action");
  if (visibleActions.length === 0) {
    return undefined;
  }

  const text = normalizeIntentText(message);
  const times = [...text.matchAll(/\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/g)].map((match) => match[0]);
  if (times.length === 0 || !/\b(means|should be|not|change|correct)\b/.test(text)) {
    return undefined;
  }

  const timeText = times[times.length - 1];
  const rawRef = text.split(/\b(?:means|should be|change|correct)\b/)[0]?.trim() ?? "";
  const ref = rawRef.replace(/\b(the|that|this|task|action)\b/g, " ").replace(/\s+/g, " ").trim();

  return {
    tool: "action.reschedule",
    args: { ...(ref ? { ref } : {}), timeText },
    rationale: "user corrected the time for a visible scheduled task"
  };
}

function preDueReminderShortcutOperation(message: string, context: ContextBundle): PlannedOperation | undefined {
  const visibleActions = context.session.visibleEntities.filter((entity) => entity.type === "action");
  if (visibleActions.length === 0) {
    return undefined;
  }

  const text = normalizeIntentText(message);
  const leadMinutes = extractPreDueReminderLeadMinutes(text);
  if (!leadMinutes || !/\b(remind|reminder|recorda|recuerdame|avisame)\b/.test(text) || !/\bbefore\b/.test(text)) {
    return undefined;
  }

  return {
    tool: "action.create_pre_due_reminders",
    args: { leadMinutes, ref: text },
    rationale: "user asked for reminders before visible scheduled tasks"
  };
}

function actionReminderListShortcutOperation(message: string): PlannedOperation | undefined {
  const text = normalizeIntentText(message);
  if (!text) {
    return undefined;
  }

  const asksReminderList =
    /\b(do i have|have i got|any|what|which|show|list|see)\b[\s\S]{0,40}\breminders?\b/.test(text) ||
    /\breminders?\b[\s\S]{0,40}\b(on|set|scheduled|active|pending)\b/.test(text);

  return asksReminderList ? { tool: "action.reminder_list", args: {}, rationale: "user asked to see scheduled reminders" } : undefined;
}

function actionMeetingListShortcutOperation(message: string): PlannedOperation | undefined {
  const text = normalizeIntentText(message);
  if (!/\b(when|what time|show|list|see)\b[\s\S]{0,40}\b(meetings?|calls?|appointments?)\b/.test(text)) {
    return undefined;
  }
  return { tool: "action.meeting_list", args: {}, rationale: "user asked for scheduled meetings" };
}

function extractVisibleIndexesFromReviewActionMessage(text: string, visibleReviews: AgentEntity[]): number[] {
  const beforeTask = text.split(/\b(?:into|to|as)\s+(?:a\s+|an\s+)?(?:tasks?|actions?|reminders?)\b/)[0] ?? text;
  const visibleIndexSet = new Set(visibleReviews.map((entity) => entity.index).filter((index): index is number => typeof index === "number"));
  const indexes = [...beforeTask.matchAll(/\b\d+\b/g)]
    .map((match) => Number(match[0]))
    .filter((index) => visibleIndexSet.has(index));

  const ordinalIndexes = [
    ["first", 1],
    ["second", 2],
    ["third", 3],
    ["fourth", 4],
    ["fifth", 5]
  ] as const;
  for (const [word, index] of ordinalIndexes) {
    if (beforeTask.includes(word) && visibleIndexSet.has(index)) {
      indexes.push(index);
    }
  }

  return [...new Set(indexes)];
}

function extractPreDueReminderLeadMinutes(text: string): number | undefined {
  const match = text.match(/\b(\d{1,3})\s*(?:minutes?|mins?|min)\s+before\b/);
  if (match?.[1]) {
    const minutes = Number(match[1]);
    return Number.isInteger(minutes) && minutes > 0 ? minutes : undefined;
  }
  return /\bremind\b[\s\S]{0,30}\bbefore\b/.test(text) ? 30 : undefined;
}

function extractNaturalDueTextFromMessage(text: string): string | undefined {
  const minuteRelative = text.match(/\b(?:in\s+\d{1,4}\s+(?:minutes?|mins?)|\d{1,4}\s+(?:minutes?|mins?)\s+from\s+now)\b/);
  if (minuteRelative?.[0]) {
    return minuteRelative[0].trim();
  }

  const relative = text.match(/\b((?:today|tomorrow|tonight|now)(?:\s+(?:morning|afternoon|evening|tonight))?(?:\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?)\b/);
  if (relative?.[1]) {
    return relative[1].trim();
  }

  const weekday = text.match(
    /\b((?:next\s+)?(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)(?:\s+(?:morning|afternoon|evening|tonight))?(?:\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?)\b/
  );
  return weekday?.[1]?.trim();
}

function messageReferencesVisibleEntity(text: string, entities: AgentEntity[]): boolean {
  return Boolean(selectVisibleEntityMention(text, entities));
}

function selectVisibleEntityMention(text: string, entities: AgentEntity[]): AgentEntity | undefined {
  const textTokens = visibleReferenceTokens(text);
  if (textTokens.length === 0) {
    return undefined;
  }

  const scored = entities
    .map((entity) => {
      const labelTokens = new Set(visibleReferenceTokens(entity.label));
      const overlap = textTokens.filter((token) => labelTokens.has(token));
      return { entity, overlap, score: overlap.length };
    })
    .filter((item) => item.score > 0)
    .sort((left, right) => right.score - left.score);

  if (scored.length === 0) {
    return undefined;
  }

  const [first, second] = scored;
  if (!first) {
    return undefined;
  }

  if (first.score >= 2 && first.score > (second?.score ?? 0)) {
    return first.entity;
  }

  if (first.score === 1 && !second) {
    const token = first.overlap[0] ?? "";
    if (token.length >= 5) {
      return first.entity;
    }
  }

  return undefined;
}

function visibleEntityToGmailReviewRef(entity: AgentEntity): { index?: number; reviewId?: string } {
  return typeof entity.index === "number" ? { index: entity.index } : { reviewId: entity.id };
}

function isGenericSingleVisibleReviewTaskReference(text: string): boolean {
  const beforeTask = text.split(/\b(?:into|to|as)\s+(?:a\s+|an\s+)?(?:tasks?|actions?|reminders?)\b/)[0] ?? text;
  const specificWords = visibleReferenceTokens(beforeTask).filter(
    (token) => !/^(turn|convert|make|create|add|can|could|would|please|pls|email|gmail|mail|review|item|one|it|this|that)$/.test(token)
  );
  return specificWords.length === 0;
}

function visibleReferenceTokens(value: string): string[] {
  return [
    ...new Set(
      normalizeIntentText(value)
        .replace(/[^\p{L}\p{N}\s]/gu, " ")
        .split(/\s+/)
        .map((token) => token.trim())
        .filter(
          (token) =>
            token.length >= 3 &&
            !/^(the|and|for|with|from|into|onto|does|have|has|any|info|about|what|which|tell|says|say|task|tasks|action|actions|reminder|reminders|email|emails|gmail|mail|mails|review|reviews|item|items|one|this|that|it|they|them|each|turn|convert|make|create|add|please|could|would|can|you|me|my|your|hay|tiene|sobre|para|con|una|uno|las|los|del)$/.test(
              token
            )
        )
    )
  ];
}

/**
 * V3 Gmail autonomy — HOW OFTEN Gmail itself is checked (manual-only, or a real scheduled
 * interval via the existing worker poll), distinct from gmail.rule.* (WHAT is tracked). A real
 * Telegram smoke test found "review my emails every 1h" misrouted to gmail.rule.propose_update,
 * pausing the user's "Work action emails" rule instead — V3 had no tool for this concept at all,
 * so the real LLM planner reached for the closest-sounding existing one. Reuses legacy/gmail-
 * conversation.ts's own parseGmailAutonomyPreference (already correctly scoped to NOT match a
 * named-rule request like "pause X" — it only recognizes manual/every-N-minutes/hours/daily/
 * notification phrasing) rather than re-implementing that parsing from scratch; this only READS
 * that function, never touches /messages/process's own routing.
 */
function parseGmailAutonomyPreferenceForAgentRuntime(message: string): GmailAutonomyPreferenceRequest | undefined {
  const text = normalizeIntentText(message);

  // parseGmailAutonomyPreference's own topic guard accepts a bare "review"/"reviews" alone
  // (Gmail review items are one of the things it configures), but that word is also used by
  // OTHER, unrelated V3 features (the daily loop's "daily review", weekly review, action
  // review). A real regression this caused: "turn off daily review" (the daily-loop setting)
  // was reinterpreted as "review daily" -> Gmail scheduled-every-day, because the legacy
  // parser's "daily" pattern matched alongside "review" satisfying its topic guard. Require an
  // unambiguous Gmail/email word here before trusting the parser's result at all. Spanish/
  // Catalan "correo(s)"/"correu(s)" are checked separately below, not folded into this same
  // English-only gate, since the legacy parser's OWN internal topic guard is English-only too
  // (gmail|email|...|review) and would reject a Spanish-only message before ever reaching its
  // "cada hora" pattern — calling it for those messages would be pointless.
  const hasEnglishMailWord = /\b(gmail|email|emails|mail|mails|inbox)\b/.test(text);
  const hasSpanishOrCatalanMailWord = /\b(correo|correos|correu|correus)\b/.test(text);
  if (!hasEnglishMailWord && !hasSpanishOrCatalanMailWord) {
    return undefined;
  }

  if (hasEnglishMailWord) {
    const direct = parseGmailAutonomyPreference(message);
    if (direct) {
      return direct;
    }
  }

  // Spanish "cada hora"/"cada N minutos"/"cada N horas" for a message that only uses
  // "correo(s)"/"correu(s)" — never reaches parseGmailAutonomyPreference above at all, since
  // that shared legacy parser's own topic guard requires an English mail word. Added here as a
  // V3-only supplement rather than widening the shared legacy parser itself.
  const everyMinutesEs = text.match(/\bcada\s+(\d+)\s+minutos?\b/);
  if (everyMinutesEs?.[1]) {
    const minutes = Number.parseInt(everyMinutesEs[1], 10);
    if (Number.isFinite(minutes) && minutes > 0) {
      return { kind: "scheduled", intervalMinutes: minutes };
    }
  }
  const everyHoursEs = text.match(/\bcada\s+(\d+)\s+horas?\b/);
  if (everyHoursEs?.[1]) {
    const hours = Number.parseInt(everyHoursEs[1], 10);
    if (Number.isFinite(hours) && hours > 0) {
      return { kind: "scheduled", intervalMinutes: hours * 60 };
    }
  }
  if (/\bcada\s+hora\b/.test(text)) {
    return { kind: "scheduled", intervalMinutes: 60 };
  }

  // parseGmailAutonomyPreference doesn't recognize bare "Nh" shorthand ("every 1h") — the exact
  // phrasing the reported transcript used. Added here, as a V3-only supplement, rather than
  // widening the shared legacy parser itself.
  const hoursShorthand = text.match(/\bevery\s+(\d+)\s*h\b/);
  if (hoursShorthand?.[1]) {
    const hours = Number.parseInt(hoursShorthand[1], 10);
    if (Number.isFinite(hours) && hours > 0) {
      return { kind: "scheduled", intervalMinutes: hours * 60 };
    }
  }

  return undefined;
}

function looksLikeGmailAutonomyStatusQuery(text: string): boolean {
  return (
    // "you" is spelled out here as an explicit alternative alongside the "u" texting shorthand
    // ("when do u check email?") rather than folded into normalizeIntentText, since that
    // normalizer is shared by every other shortcut in this file and blindly rewriting "u" ->
    // "you" everywhere risks corrupting unrelated messages that use "u" for something else.
    /\bwhen\b[\s\S]{0,20}\b(do|does)\b[\s\S]{0,10}\b(you|u|it|alecto)\b[\s\S]{0,20}\bcheck\b[\s\S]{0,20}\b(gmail|email|emails|mail|inbox)\b/.test(text) ||
    /\bis\b[\s\S]{0,20}\b(gmail|email)\b[\s\S]{0,20}\bsync\b[\s\S]{0,20}\bscheduled\b/.test(text) ||
    /\b(gmail|email)\b[\s\S]{0,20}\bsync\b[\s\S]{0,20}\b(settings|schedule)\b/.test(text) ||
    /\bhow often\b[\s\S]{0,30}\bcheck\b[\s\S]{0,20}\b(gmail|email|emails|mail)\b/.test(text) ||
    // "do you check my email automatically?" — no "when"/"how often" at all, so this needs its
    // own explicit schedule-shaped qualifier to avoid swallowing an unrelated bare "do you check
    // email" (which reads more like a sync request than a status question).
    /\b(do|does)\b[\s\S]{0,10}\b(you|u|it|alecto)\b[\s\S]{0,20}\bcheck\b[\s\S]{0,20}\b(gmail|email|emails|mail|inbox)\b[\s\S]{0,20}\b(automatically|auto|regularly|on (a|your) schedule)\b/.test(
      text
    ) ||
    // Spanish "cada cuánto miras mi email?" / Catalan "cada quant mires el meu email?" — "cada
    // cuánto"/"cada quant" ("how often") is the direct equivalent of the English "how often"
    // branch above; accents are already stripped by normalizeIntentText ("cuánto" -> "cuanto").
    /\bcada\s+(cuanto|quant)\b[\s\S]{0,30}\b(miras|mira|revisas|revisa|checas|checa|chequeas|chequea|mires|revises)\b[\s\S]{0,20}\b(email|correo|correos|correu|correus|gmail|mail)\b/.test(
      text
    )
  );
}

function gmailAutonomyStatusShortcutOperation(message: string): PlannedOperation | undefined {
  const text = normalizeIntentText(message);
  if (!text) {
    return undefined;
  }

  return looksLikeGmailAutonomyStatusQuery(text)
    ? { tool: "gmail.autonomy.status", args: {}, rationale: "user asked how often Gmail is checked" }
    : undefined;
}

/**
 * Combines (a) an explicit Gmail sync-frequency change (manual-only or scheduled, via
 * parseGmailAutonomyPreferenceForAgentRuntime) with (b) any Gmail review the SAME message also
 * dismisses — either by explicit index (reusing buildExplicitGmailReviewIntentPlan) or, when
 * exactly one review is visible, by a bare pronoun ("delete it," "ignore it," "it's nothing
 * important" — no index at all, the exact shape the reported transcript used). Only ever fires
 * when an autonomy preference is genuinely present; a pure review-only message (no autonomy
 * language) returns nothing here and falls through unchanged to the existing review shortcuts.
 */
function gmailAutonomyCompoundShortcutOperations(message: string, context: ContextBundle): PlannedOperation[] {
  const preference = parseGmailAutonomyPreferenceForAgentRuntime(message);
  if (!preference || preference.kind === "review_notifications" || preference.kind === "daily_digest" || preference.kind === "work_hours") {
    return [];
  }

  const reviewPlan = buildExplicitGmailReviewIntentPlan(message, context);
  const reviewOps = reviewPlan ? [...reviewPlan.operations] : [];

  if (reviewOps.length === 0) {
    const visibleReviews = context.session.visibleEntities.filter((entity) => entity.type === "gmail_review");
    const text = normalizeIntentText(message);
    const dismissesReview = /\b(delete|remove|discard|ignore|ifnore|reject|skip)\b/.test(text) || /\bnothing important\b/.test(text);
    if (visibleReviews.length === 1 && dismissesReview) {
      reviewOps.push({
        tool: "gmail.review.reject",
        args: { reviewId: visibleReviews[0]!.id },
        rationale: "user dismissed the one visible Gmail review by pronoun, alongside a Gmail sync-frequency request"
      });
    }
  }

  const autonomyOp: PlannedOperation = {
    tool: "gmail.autonomy.propose_update",
    args:
      preference.kind === "manual_only"
        ? { syncMode: "manual_only" }
        : { syncMode: "scheduled", intervalMinutes: preference.intervalMinutes },
    rationale: "user asked to change Gmail's scheduled sync mode/interval"
  };

  return [...reviewOps, autonomyOp];
}

function gmailConnectionShortcutOperation(message: string, context: ContextBundle): PlannedOperation | undefined {
  const text = normalizeIntentText(message);
  if (!text || /\bsync\b/.test(text)) {
    return undefined;
  }
  if (looksLikeGmailAlertSettingsRequest(text)) {
    return undefined;
  }

  const mentionsGmailOrEmail = /\b(gmail|email|emails|mail|mails)\b/.test(text);
  const asksConnectionAction = /\b(connect|reconnect|integrate|setup|set up|authorize|reauthorize|fix)\b/.test(text);
  const asksForLink = /\blink\b|\boauth\b|\bauth url\b|\bauthori[sz]ation url\b/.test(text);
  const asksStatus = /\b(status|state|connected|connection|configured|setup)\b/.test(text);
  const mentionsAuthProblem = /\bgmail\b[\s\S]{0,50}\b(expired|unauthori[sz]ed|permission|scope|auth|authorization)\b|\b(expired|unauthori[sz]ed|permission|scope|auth|authorization)\b[\s\S]{0,50}\bgmail\b/.test(text);
  const contextualReconnectLink = asksForLink && /\b(connect|reconnect|authorize|reauthorize|fix|it)\b/.test(text) && hasRecentGmailContext(context);

  if ((mentionsGmailOrEmail && (asksConnectionAction || asksForLink || asksStatus)) || mentionsAuthProblem || contextualReconnectLink) {
    const includeLink = asksConnectionAction || asksForLink || mentionsAuthProblem || contextualReconnectLink;
    return { tool: "gmail.status", args: { includeLink }, rationale: "user asked for Gmail connection or reconnect help" };
  }

  return undefined;
}

function gmailSyncShortcutOperation(message: string): PlannedOperation | undefined {
  const text = normalizeIntentText(message);

  if (!text || looksLikeGmailAlertSettingsRequest(text)) {
    return undefined;
  }

  // "check Gmail every hour"/"check email sync every 1h" and "when do you check Gmail?" all
  // otherwise satisfy the "check ... gmail" pattern below (its trailing now/new group is
  // optional) and were being misrouted into an immediate one-off gmail.sync instead of the
  // scheduled-sync preference or status query they're actually asking for. Both defer to
  // gmailAutonomyStatusShortcutOperation/gmailAutonomyCompoundShortcutOperations instead.
  if (looksLikeGmailAutonomyStatusQuery(text)) {
    return undefined;
  }
  const autonomyPreference = parseGmailAutonomyPreferenceForAgentRuntime(message);
  if (autonomyPreference && (autonomyPreference.kind === "scheduled" || autonomyPreference.kind === "manual_only")) {
    return undefined;
  }

  const explicitSync =
    /\b(sync|refresh|update)\b[\s\S]{0,30}\b(gmail|email|emails|correo|correos|mail|mails)\b/.test(text) ||
    /\b(gmail|email|emails|correo|correos|mail|mails)\b[\s\S]{0,30}\b(sync|refresh|update)\b/.test(text) ||
    /\b(check|look for|buscar|busca|revisar|revisa)\b[\s\S]{0,35}\b(gmail|email|emails|correo|correos|mail|mails)\b[\s\S]{0,25}\b(now|new|nuevos?|ahora)?\b/.test(text) ||
    /\b(gmail|email|emails|correo|correos|mail|mails)\b[\s\S]{0,35}\b(now|new|nuevos?|ahora)\b/.test(text);

  if (!explicitSync) {
    return undefined;
  }

  return { tool: "gmail.sync", args: {}, rationale: "user explicitly asked to sync Gmail/email now" };
}

function gmailSyncDebugShortcutOperation(message: string): PlannedOperation | undefined {
  const text = normalizeIntentText(message);

  if (!text) {
    return undefined;
  }

  const asksDebug =
    /\bwhy\b[\s\S]{0,60}\bgmail\b[\s\S]{0,60}\b(find nothing|found nothing|no results|0 new|zero new|nothing)\b/.test(text) ||
    /\bshow\b[\s\S]{0,30}\bgmail\b[\s\S]{0,30}\bsync\b[\s\S]{0,20}\bdebug\b/.test(text) ||
    /\bgmail\b[\s\S]{0,30}\bsync\b[\s\S]{0,20}\bdebug\b/.test(text) ||
    /\bsync\b[\s\S]{0,20}\bgmail\b[\s\S]{0,20}\bdebug\b/.test(text);

  if (!asksDebug) {
    return undefined;
  }

  return { tool: "gmail.sync.debug", args: {}, rationale: "user asked for the last Gmail sync diagnostic summary" };
}

function gmailBuiltInRuleEnableShortcutOperation(message: string, context: ContextBundle): PlannedOperation | undefined {
  const text = normalizeIntentText(message);
  if (!text) {
    return undefined;
  }

  const asksToEnable = /\b(enable|turn on|activate|start|set up|setup|create|activa|activar|enciende|encender|pon|poner)\b/.test(text);
  if (!asksToEnable) {
    return undefined;
  }

  const mentionsRuleSurface =
    /\b(gmail|email|emails|correo|correos|mail|mails|rule|rules|tracking|check|one)\b/.test(text) || hasRecentGmailContext(context);
  if (!mentionsRuleSurface) {
    return undefined;
  }

  const mentionsJobSearch = /\b(job search|job-search|recruiter|recruiters|application|applications|cv|cvs|resume|resumes)\b/.test(text);
  const mentionsWorkAction = /\b(work action|work actions|work-action|work email|work emails|work requests?|deadlines?|follow-ups?|feedback requests?|blockers?)\b/.test(text);

  if (mentionsJobSearch && !mentionsWorkAction) {
    return { tool: "gmail.rule.enable_builtin", args: { kind: "job_search" }, rationale: "user asked to enable job-search Gmail tracking" };
  }

  if (mentionsWorkAction && !mentionsJobSearch) {
    return { tool: "gmail.rule.enable_builtin", args: { kind: "work_action" }, rationale: "user asked to enable work-action Gmail tracking" };
  }

  return undefined;
}

function gmailNudgeSettingsShortcutOperation(message: string): PlannedOperation | undefined {
  const text = normalizeIntentText(message);
  if (!looksLikeGmailAlertSettingsRequest(text)) {
    return undefined;
  }

  if (/\b(turn|switch|shut)\s+off\b|\b(stop|disable|desactiva|desactivar|para|deja)\b|\b(no more|don't|do not|dont|no me avises|no m avises)\b/.test(text)) {
    return { tool: "proactive.settings_propose_update", args: { gmailNudgeEnabled: false }, rationale: "user asked to turn off Gmail alerts" };
  }

  if (
    /\b(turn|switch|enable|activate|start)\s+(on\s+)?\b/.test(text) ||
    /\b(activa|activar|enciende|avisame|avisa me|notificame|notifica me)\b/.test(text) ||
    /\b(notify me|let me know|tell me|send me)\b/.test(text)
  ) {
    return { tool: "proactive.settings_propose_update", args: { gmailNudgeEnabled: true }, rationale: "user asked to turn on Gmail alerts" };
  }

  return undefined;
}

function looksLikeGmailAlertSettingsRequest(text: string): boolean {
  return (
    /\bgmail\b[\s\S]{0,50}\b(nudge|nudges|alert|alerts|notification|notifications|notify|avisos?|notificaciones?|avisa|avises|avisame|notifica)\b/.test(text) ||
    /\b(nudge|nudges|alert|alerts|notification|notifications|notify|avisos?|notificaciones?|avisa|avises|avisame|notifica)\b[\s\S]{0,50}\bgmail\b/.test(text) ||
    /\b(email|emails|correo|correos|mail|mails)\b[\s\S]{0,50}\b(alert|alerts|notification|notifications|notify|avisos?|notificaciones?|avisa|avises|avisame|notifica|important|importantes)\b/.test(text) ||
    /\b(alert|alerts|notification|notifications|notify|avisos?|notificaciones?|avisa|avises|avisame|notifica|important|importantes)\b[\s\S]{0,50}\b(email|emails|correo|correos|mail|mails)\b/.test(text) ||
    /\b(tell me|let me know|notify me|avisame|avisa me|no me avises|notificame|notifica me)\b[\s\S]{0,50}\b(email|emails|correo|correos|gmail)\b/.test(text) ||
    /\bgmail review\b[\s\S]{0,40}\b(notification|notifications|alert|alerts|nudge|nudges|aviso|avisos)\b/.test(text)
  );
}

function hasRecentGmailContext(context: ContextBundle): boolean {
  if (context.session.topic?.includes("gmail")) {
    return true;
  }
  if (context.session.pendingOperation?.summary.toLowerCase().includes("gmail")) {
    return true;
  }
  return context.session.messages.slice(-8).some((entry) => /\bgmail\b|\bemail rules?\b|\bemail reviews?\b/.test(entry.text.toLowerCase()));
}

function normalizeIntentText(message: string): string {
  return message
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

async function finalizeNoPendingReply(context: ContextBundle, tool: string): Promise<AgentMessageResponse> {
  return finalize(context, {
    reply: NO_PENDING_REPLY,
    operationsPlanned: [],
    executedOps: [{ tool, status: "skipped", summary: NO_PENDING_REPLY }],
    plannerUsed: "none",
    llmPlannerAttempted: false,
    toolValidationPassed: true,
    topic: context.session.topic
  });
}

async function finalizeDeterministicConfirmation(context: ContextBundle, message: string): Promise<AgentMessageResponse> {
  const { userId } = context.session;
  const pending = context.session.pendingOperation as AgentPendingOperation;
  const pendingOperationBefore = pending;
  const visibleEntitiesBefore = context.session.visibleEntities;

  const revalidated = pending.operations.map((op) => revalidateForExecution(op));
  const readyOps = revalidated.filter((op) => op.status === "valid");
  const brokenOps = revalidated.filter((op) => op.status !== "valid");

  const executedOps = await Promise.all(readyOps.map((op) => executeOperation(userId, op, context, `[confirmed] ${pending.summary}`)));
  applyExecutionSideEffects(context.session, executedOps);
  setPendingOperation(context.session, null);

  const reply = composeReply({
    replyDraft: "",
    pendingConfirmationOps: [],
    executedOps,
    problemOps: brokenOps
  });

  const planningTrace = recordPlanningTrace(
    {
      message,
      plannedOp: undefined,
      validatedOp: readyOps[0] ?? brokenOps[0],
      executedOp: executedOps.find((op) => isPlanningTool(op.tool)),
      pendingOperationBefore,
      visibleEntitiesBefore,
      composerSource: inferComposerSource({ pendingConfirmationOps: [], executedOps, problemOps: brokenOps, replyDraft: "" })
    },
    context.session
  );

  return finalize(context, {
    reply,
    operationsPlanned: pending.operations.map((op) => ({ tool: op.tool, args: op.args })),
    executedOps,
    plannerUsed: "none",
    llmPlannerAttempted: false,
    toolValidationPassed: brokenOps.length === 0,
    topic: pending.topic,
    planningTrace
  });
}

async function finalizeDeterministicCancellation(context: ContextBundle, message: string): Promise<AgentMessageResponse> {
  const pending = context.session.pendingOperation as AgentPendingOperation;
  const pendingOperationBefore = pending;
  const visibleEntitiesBefore = context.session.visibleEntities;
  setPendingOperation(context.session, null);
  setVisibleEntities(context.session, []);

  const reply = "Cancelled — I won't do that.";
  const executedOps: ExecutedOperation[] = [{ tool: "confirmation.cancel", status: "executed", summary: reply }];

  const planningTrace = recordPlanningTrace(
    {
      message,
      plannedOp: undefined,
      validatedOp: undefined,
      executedOp: undefined,
      pendingOperationBefore,
      visibleEntitiesBefore,
      composerSource: "cancellation"
    },
    context.session
  );

  return finalize(context, {
    reply,
    operationsPlanned: [],
    executedOps,
    plannerUsed: "none",
    llmPlannerAttempted: false,
    toolValidationPassed: true,
    topic: pending.topic,
    planningTrace
  });
}

const LEGACY_PENDING_ACTION_CONFIRM_REPLY =
  "I can't safely apply that kind of pending action from here yet. Reply with /confirm to complete it, or /cancel to drop it.";

async function finalizeLegacyPendingActionConfirm(context: ContextBundle): Promise<AgentMessageResponse> {
  // Deliberately does NOT call the legacy confirmPendingAction/applyPendingAction here: the
  // actual mutation logic (applyPendingAction) lives in server.ts, entangled with Gmail-rule and
  // action-hygiene helpers that aren't safely importable into agent-runtime without a circular
  // import back into server.ts. Marking it "confirmed" without running that logic would silently
  // skip the mutation the user is expecting — worse than doing nothing. The row is left untouched.
  return finalize(context, {
    reply: LEGACY_PENDING_ACTION_CONFIRM_REPLY,
    operationsPlanned: [],
    executedOps: [{ tool: "confirmation.confirm", status: "skipped", summary: LEGACY_PENDING_ACTION_CONFIRM_REPLY }],
    plannerUsed: "none",
    llmPlannerAttempted: false,
    toolValidationPassed: true,
    topic: context.session.topic
  });
}

async function finalizeLegacyPendingActionCancel(
  context: ContextBundle,
  legacyPendingAction: PendingAction
): Promise<AgentMessageResponse> {
  // Safe to execute directly: rejecting a pending action only ever marks the row
  // status="rejected" — it never runs applyPendingAction's type-specific mutation logic, so
  // there's no entangled Gmail/action-hygiene behavior to reproduce here.
  await rejectPendingAction(context.session.userId, legacyPendingAction.id);
  const reply = "Cancelled. I did not change anything.";

  return finalize(context, {
    reply,
    operationsPlanned: [],
    executedOps: [{ tool: "confirmation.cancel", status: "executed", summary: reply }],
    plannerUsed: "none",
    llmPlannerAttempted: false,
    toolValidationPassed: true,
    topic: context.session.topic
  });
}

async function finalizeLegacyPendingActionAmbiguous(
  context: ContextBundle,
  legacyPendingAction: PendingAction
): Promise<AgentMessageResponse> {
  const reply = `You have a pending action from the previous flow: ${legacyPendingAction.summary}. Confirm, cancel, or continue with a new request.`;

  return finalize(context, {
    reply,
    operationsPlanned: [],
    executedOps: [],
    plannerUsed: "none",
    llmPlannerAttempted: false,
    toolValidationPassed: true,
    topic: context.session.topic
  });
}

interface FinalizeInput {
  reply: string;
  operationsPlanned: PlannedOperation[];
  executedOps: ExecutedOperation[];
  plannerUsed: AgentDebugInfo["plannerUsed"];
  llmPlannerAttempted: boolean;
  toolValidationPassed: boolean;
  topic: string | null;
  planningTrace?: PlanningTraceEntry;
}

async function finalize(context: ContextBundle, input: FinalizeInput): Promise<AgentMessageResponse> {
  const { session } = context;
  setTopic(session, input.topic);
  appendMessage(session, "assistant", input.reply);
  const needsConfirmation = Boolean(session.pendingOperation);

  await saveSession(session);

  return {
    reply: input.reply,
    operationsPlanned: input.operationsPlanned,
    operationsExecuted: input.executedOps,
    needsConfirmation,
    debug: {
      runtime: "agent_v3",
      plannerUsed: input.plannerUsed,
      llmPlannerAttempted: input.llmPlannerAttempted,
      llmPlannerUsed: input.plannerUsed === "llm",
      toolValidationPassed: input.toolValidationPassed,
      mutationExecuted: input.executedOps.some((op) => op.status === "executed" && getToolDefinition(op.tool)?.mutates),
      conversationTopic: input.topic,
      pendingOperation: needsConfirmation,
      legacyPendingActionDetected: Boolean(context.legacyPendingAction),
      ...(input.planningTrace ? { planningTrace: input.planningTrace } : {})
    }
  };
}

/**
 * Topic is derived primarily from which tools actually ran this turn — ground
 * truth, immune to the live LLM repeating a stale topic label. Turns with no
 * operations (e.g. "let me know when I receive one") keep the prior topic
 * rather than trusting a freeform LLM string, since that's almost always a
 * continuation of the same flow, not a new one.
 */
function resolveTopic(operations: PlannedOperation[], planTopic: string, sessionTopic: string | null): string {
  const inferred = inferTopicFromOperations(operations);
  if (inferred) {
    return inferred;
  }
  if (operations.length === 0 && sessionTopic) {
    return sessionTopic;
  }
  return planTopic || sessionTopic || "general";
}

function inferTopicFromOperations(operations: PlannedOperation[]): string | null {
  for (const op of operations) {
    if (op.tool === "gmail.rule.create") return "gmail_rule_creation";
    if (op.tool === "gmail.rule.list" || op.tool === "gmail.rule.explain") return "gmail_rules";
    if (op.tool.startsWith("gmail.rule.")) return "gmail_rule_management";
    if (op.tool.startsWith("gmail.review")) return "gmail_reviews";
    if (op.tool === "gmail.sync") return "gmail_sync";
    if (op.tool === "gmail.sync.debug") return "gmail_sync_debug";
    if (op.tool === "gmail.status") return "gmail_status";
    if (op.tool.startsWith("memory.")) return "memory";
    if (op.tool.startsWith("event.")) return "progress_logging";
    if (op.tool.startsWith("action.")) return "action_cleanup";
    if (op.tool.startsWith("planning.")) return "next_week_planning";
    if (op.tool.startsWith("weekly_review.")) return "weekly_review";
    if (op.tool.startsWith("daily_loop.")) return "daily_loop_settings";
    if (op.tool.startsWith("goal.")) return "goals";
    if (op.tool.startsWith("proactive.")) return "proactive_settings";
    if (op.tool.startsWith("operator.")) return "operator_summary";
  }
  return null;
}

/**
 * Deterministic, not LLM-driven: the guardrail module only ever returns a classification, never
 * touches the DB itself (see goal-guardrails.ts's doc comment) — this is the one place that
 * turns a detected conflict into a durable record, reusing the existing memory.create/
 * risk_pattern mechanism already read by insights/daily-review, rather than inventing new schema.
 */
async function logGuardrailIncident(userId: string, message: string, guardrail: GuardrailResult): Promise<ExecutedOperation> {
  const target = guardrail.matchedGoalTitle ? `goal "${guardrail.matchedGoalTitle}"` : guardrail.matchedTrigger ? `configured trigger "${guardrail.matchedTrigger}"` : "a guardrail";
  const created = await createMemory(userId, {
    type: "risk_pattern",
    summary: `Guardrail (${guardrail.decision}): "${message}" conflicted with ${target}.`,
    source: "system_inferred",
    confidence: 1,
    evidence: { message, decision: guardrail.decision, pattern: guardrail.pattern, matchedGoalId: guardrail.matchedGoalId, matchedTrigger: guardrail.matchedTrigger }
  });
  return { tool: "memory.create", status: "executed", summary: `Remembered: ${created.summary}`, result: created };
}

function applyExecutionSideEffects(session: AgentSessionState, executedOps: ExecutedOperation[]): void {
  const entities: AgentEntity[] = [];

  for (const op of executedOps) {
    // Only tools that actually mutate belong in recentMutations. Recording read-only
    // executions here (e.g. operator.recent_changes itself) makes a "what changed?"
    // answer recurse into and duplicate its own prior answer on the next call.
    if (op.status === "executed" && getToolDefinition(op.tool)?.mutates === true) {
      recordMutation(session, op.summary);
    }
    if (op.entities) {
      entities.push(...op.entities);
    }
    // See ExecutedOperation.pendingOperationUpdate — a multi-turn propose/edit/confirm tool
    // (e.g. planning.next_week_start/_edit) installs or replaces the session's pending
    // operation this way, decoupled from the requiresConfirmation-driven path below it.
    if (op.pendingOperationUpdate !== undefined) {
      setPendingOperation(
        session,
        op.pendingOperationUpdate === null
          ? null
          : createPendingOperationRecord(op.pendingOperationUpdate.topic, op.pendingOperationUpdate.summary, op.pendingOperationUpdate.operations)
      );
    }
  }

  if (entities.length > 0) {
    setVisibleEntities(session, dedupeEntities(entities));
    updateFocusedEntities(session, entities);
  }
}

/**
 * Merges this turn's entities into session.focusedEntities, one slot per entity type, last one
 * this turn wins. Deliberately separate from setVisibleEntities above: visibleEntities is
 * replaced wholesale every turn that returns any entity (right for a numbered list, which really
 * is gone once a new one is shown), but a "current goal" (or any other focused entity) must stay
 * put across turns whose own operations don't touch that type at all — see
 * types.ts's AgentFocusedEntities doc comment for why this fixed a real multi-turn goal bug.
 */
function updateFocusedEntities(session: AgentSessionState, entities: AgentEntity[]): void {
  const next = { ...session.focusedEntities };
  for (const entity of entities) {
    next[entity.type] = entity;
  }
  session.focusedEntities = next;
}

function dedupeEntities(entities: AgentEntity[]): AgentEntity[] {
  const seen = new Map<string, AgentEntity>();
  for (const entity of entities) {
    seen.set(`${entity.type}:${entity.id}`, entity);
  }
  return [...seen.values()];
}
