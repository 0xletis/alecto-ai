import { createMemory, rejectPendingAction, type PendingAction } from "@operator-agent/db";
import { loadContext } from "./context-loader.js";
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

  const gmailConnectionShortcut = gmailConnectionShortcutOperation(message, context);
  if (gmailConnectionShortcut) {
    return finalizeDeterministicOperation(context, message, gmailConnectionShortcut, "gmail_status");
  }

  const gmailNudgeSettingsShortcut = !pending ? gmailNudgeSettingsShortcutOperation(message) : undefined;
  if (gmailNudgeSettingsShortcut) {
    return finalizeDeterministicOperation(context, message, gmailNudgeSettingsShortcut, "proactive_settings");
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

  const { plan, plannerUsed } = await planMessage(message, context);

  const validatedOps = validateOperations(plan.operations, context);
  const toolValidationPassed = validatedOps.every((op) => op.status !== "invalid" && op.status !== "unsupported");

  // Pending-operation firewall: while a mutation is awaiting confirmation, no OTHER mutation
  // may run — not even a fresh, unrelated one, and not even a re-ask of the same one. This is
  // checked on the raw validated ops (any status), so it also blocks a plan that tries to
  // re-propose gmail.rule.create instead of emitting a genuine confirmation.
  if (pending && validatedOps.some((op) => getToolDefinition(op.tool)?.mutates === true)) {
    return finalize(context, {
      reply: `You still have a pending confirmation for ${pending.summary}. Confirm, cancel, or tell me a new request.`,
      operationsPlanned: plan.operations,
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

  const topic = resolveTopic(plan.operations, plan.topic, context.session.topic);

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

  const plannedPlanningOp = plan.operations.find((op) => isPlanningTool(op.tool));
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
    operationsPlanned: plan.operations,
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
  const mentionsAuthProblem = /\bgmail\b[\s\S]{0,50}\b(expired|unauthori[sz]ed|permission|scope|auth|authorization)\b|\b(expired|unauthori[sz]ed|permission|scope|auth|authorization)\b[\s\S]{0,50}\bgmail\b/.test(text);
  const contextualReconnectLink = asksForLink && /\b(connect|reconnect|authorize|reauthorize|fix|it)\b/.test(text) && hasRecentGmailContext(context);

  if ((mentionsGmailOrEmail && (asksConnectionAction || asksForLink)) || mentionsAuthProblem || contextualReconnectLink) {
    return { tool: "gmail.status", args: { includeLink: true }, rationale: "user asked for Gmail connection or reconnect help" };
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
