import { loadContext } from "./context-loader.js";
import { appendMessage, createPendingOperationRecord, recordMutation, saveSession, setPendingOperation, setTopic, setVisibleEntities } from "./conversation-session.js";
import { executeOperation } from "./executor.js";
import { planMessage } from "./planner.js";
import { composeReply, summarizePendingOperations } from "./response-composer.js";
import { getToolDefinition } from "./tool-catalog.js";
import { runExclusive } from "./user-lock.js";
import { checkPolicyGuardrail, revalidateForExecution, validateOperations } from "./validator.js";
import type {
  AgentDebugInfo,
  AgentEntity,
  AgentMessageRequest,
  AgentMessageResponse,
  AgentPendingOperation,
  AgentSessionState,
  ContextBundle,
  ExecutedOperation,
  PlannedOperation
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
  "perfect"
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

export async function handleAgentMessage(request: AgentMessageRequest): Promise<AgentMessageResponse> {
  return runExclusive(request.userId, () => processAgentMessage(request));
}

async function processAgentMessage(request: AgentMessageRequest): Promise<AgentMessageResponse> {
  const { userId, message, channel } = request;
  const context = await loadContext(userId, channel);
  appendMessage(context.session, "user", message);

  const guardrail = checkPolicyGuardrail(message, context.operatingProfile);
  if (guardrail.triggered) {
    return finalize(context, {
      reply:
        "This touches something you've asked me to be careful about. I'm not going to act on it automatically — let's slow down and talk it through first.",
      operationsPlanned: [],
      executedOps: [],
      plannerUsed: "none",
      llmPlannerAttempted: false,
      toolValidationPassed: true,
      topic: context.session.topic
    });
  }

  const pending = context.session.pendingOperation;
  const normalized = normalizeExactMessage(message);

  // Exact confirm/cancel is checked FIRST and ALWAYS — regardless of whether a pending
  // operation exists — so a bare "yes"/"no" with nothing pending gets the deterministic
  // "nothing pending" reply instead of falling through to the LLM planner, which has been
  // observed to invent an unrelated action (e.g. listing Gmail rules) for a lone "yes".
  if (CONFIRM_WHITELIST.has(normalized)) {
    return pending ? finalizeDeterministicConfirmation(context) : finalizeNoPendingReply(context, "confirmation.confirm");
  }
  if (CANCEL_WHITELIST.has(normalized)) {
    return pending ? finalizeDeterministicCancellation(context) : finalizeNoPendingReply(context, "confirmation.cancel");
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

  return finalize(context, {
    reply,
    operationsPlanned: plan.operations,
    executedOps,
    plannerUsed,
    llmPlannerAttempted: true,
    toolValidationPassed,
    topic
  });
}

function normalizeExactMessage(message: string): string {
  return message.trim().toLowerCase().replace(/[.!]+$/, "");
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

async function finalizeDeterministicConfirmation(context: ContextBundle): Promise<AgentMessageResponse> {
  const { userId } = context.session;
  const pending = context.session.pendingOperation as AgentPendingOperation;

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

  return finalize(context, {
    reply,
    operationsPlanned: pending.operations.map((op) => ({ tool: op.tool, args: op.args })),
    executedOps,
    plannerUsed: "none",
    llmPlannerAttempted: false,
    toolValidationPassed: brokenOps.length === 0,
    topic: pending.topic
  });
}

async function finalizeDeterministicCancellation(context: ContextBundle): Promise<AgentMessageResponse> {
  const pending = context.session.pendingOperation as AgentPendingOperation;
  setPendingOperation(context.session, null);

  const reply = "Cancelled — I won't do that.";

  return finalize(context, {
    reply,
    operationsPlanned: [],
    executedOps: [{ tool: "confirmation.cancel", status: "executed", summary: reply }],
    plannerUsed: "none",
    llmPlannerAttempted: false,
    toolValidationPassed: true,
    topic: pending.topic
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
      pendingOperation: needsConfirmation
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
    if (op.tool.startsWith("gmail.review")) return "gmail_reviews";
    if (op.tool === "gmail.status") return "gmail_status";
    if (op.tool.startsWith("memory.")) return "memory";
    if (op.tool.startsWith("event.")) return "progress_logging";
    if (op.tool.startsWith("action.")) return "action_cleanup";
    if (op.tool.startsWith("operator.")) return "operator_summary";
  }
  return null;
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
  }

  if (entities.length > 0) {
    setVisibleEntities(session, dedupeEntities(entities));
  }
}

function dedupeEntities(entities: AgentEntity[]): AgentEntity[] {
  const seen = new Map<string, AgentEntity>();
  for (const entity of entities) {
    seen.set(`${entity.type}:${entity.id}`, entity);
  }
  return [...seen.values()];
}
