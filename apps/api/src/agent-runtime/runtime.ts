import { loadContext } from "./context-loader.js";
import {
  appendMessage,
  createPendingOperationRecord,
  getSession,
  recordMutation,
  setPendingOperation,
  setTopic,
  setVisibleEntities
} from "./conversation-session.js";
import { executeOperation } from "./executor.js";
import { planMessage } from "./planner.js";
import { composeReply } from "./response-composer.js";
import { getToolDefinition } from "./tool-catalog.js";
import { checkPolicyGuardrail, revalidateForExecution, validateOperations } from "./validator.js";
import type {
  AgentDebugInfo,
  AgentEntity,
  AgentMessageRequest,
  AgentMessageResponse,
  ContextBundle,
  ExecutedOperation,
  PlannedOperation
} from "./types.js";

const META_TOOLS = new Set(["confirmation.confirm", "confirmation.cancel", "clarification.ask"]);

// Anchored to the whole message so a compound reply like "yes but change the
// label" — which is NOT a clean confirmation — falls through to the planner
// instead of being blindly executed.
const AFFIRMATION_RE = /^(yes|yep|yeah|yup|confirm|do it|go ahead|sí|si|vale|ok|okay)[.!]?$/i;
const NEGATION_RE = /^(no|nope|nevermind|never mind|cancel|stop|don'?t)[.!]?$/i;

// Deliberately narrow, hardcoded-safe pattern: Gmail send/reply/forward/delete
// has no tool in the catalog at all, so this is enforced deterministically
// rather than left to the planner's judgment — it must never depend on
// whether the LLM correctly refuses in a given turn.
const UNSUPPORTED_GMAIL_ACTION_RE =
  /\b(reply|respond|answer)\b[\s\S]{0,40}\b(email|mail|message|gmail)\b|\bsend\b[\s\S]{0,20}\b(email|mail|reply)\b|\bforward\b[\s\S]{0,20}\b(email|mail)\b|\b(delete|remove)\b[\s\S]{0,20}\b(email|mail)\b[\s\S]{0,20}\b(gmail|inbox)\b/i;

const UNSUPPORTED_GMAIL_ACTION_REPLY =
  "I can't reply to Gmail messages or send emails yet. I can only read matching emails through active rules and create review items.";

export async function handleAgentMessage(request: AgentMessageRequest): Promise<AgentMessageResponse> {
  const { userId, message } = request;
  const context = await loadContext(userId);
  appendMessage(userId, "user", message);

  const guardrail = checkPolicyGuardrail(message, context.operatingProfile);
  if (guardrail.triggered) {
    return finalize(userId, {
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

  const trimmedMessage = message.trim();

  if (context.session.pendingOperation) {
    if (AFFIRMATION_RE.test(trimmedMessage)) {
      return finalizeDeterministicConfirmation(userId, context);
    }
    if (NEGATION_RE.test(trimmedMessage)) {
      return finalizeDeterministicCancellation(userId, context);
    }
  }

  if (UNSUPPORTED_GMAIL_ACTION_RE.test(trimmedMessage)) {
    // Deliberately does not touch pendingOperation: an unrelated, unsupported
    // request must not silently cancel or continue an unrelated pending flow.
    return finalize(userId, {
      reply: UNSUPPORTED_GMAIL_ACTION_REPLY,
      operationsPlanned: [],
      executedOps: [],
      plannerUsed: "none",
      llmPlannerAttempted: false,
      toolValidationPassed: true,
      topic: "gmail_unsupported_action"
    });
  }

  const { plan, plannerUsed } = await planMessage(message, context);

  const validatedOps = validateOperations(plan.operations, context);
  const toolValidationPassed = validatedOps.every((op) => op.status !== "invalid" && op.status !== "unsupported");

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
  // testing showed the model can over-eagerly treat an unrelated follow-up ("let me know
  // when I receive one") as a confirmation, which would wrongly execute a pending mutation
  // the user never actually approved. The regex pre-check above is the ONLY path that can
  // confirm/cancel; if it didn't match, this turn is treated as a normal message and the
  // pending operation is left exactly as-is. confirmation.confirm/cancel remain valid,
  // harmless no-ops if the planner emits them here anyway (excluded from executableOps).

  if (askMeta) {
    clarificationQuestion = String(askMeta.args.question ?? "Could you clarify what you mean?");
  } else {
    executedOps = await Promise.all(executableOps.map((op) => executeOperation(userId, op, context, message)));
    applyExecutionSideEffects(userId, executedOps);

    if (pendingConfirmationOps.length > 0) {
      const summary = pendingConfirmationOps.map((op) => `${op.tool}(${JSON.stringify(op.args)})`).join("; ");
      setPendingOperation(userId, createPendingOperationRecord(topic, summary, pendingConfirmationOps));
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

  return finalize(userId, {
    reply,
    operationsPlanned: plan.operations,
    executedOps,
    plannerUsed,
    llmPlannerAttempted: true,
    toolValidationPassed,
    topic
  });
}

async function finalizeDeterministicConfirmation(
  userId: string,
  context: ContextBundle,
  plannerUsed: "llm" | "fallback" | "none" = "none"
): Promise<AgentMessageResponse> {
  const pending = context.session.pendingOperation;

  if (!pending) {
    const reply = "There's nothing pending for me to confirm.";
    return finalize(userId, {
      reply,
      operationsPlanned: [],
      executedOps: [{ tool: "confirmation.confirm", status: "skipped", summary: reply }],
      plannerUsed,
      llmPlannerAttempted: plannerUsed !== "none",
      toolValidationPassed: true,
      topic: context.session.topic
    });
  }

  const revalidated = pending.operations.map((op) => revalidateForExecution(op));
  const readyOps = revalidated.filter((op) => op.status === "valid");
  const brokenOps = revalidated.filter((op) => op.status !== "valid");

  const executedOps = await Promise.all(readyOps.map((op) => executeOperation(userId, op, context, `[confirmed] ${pending.summary}`)));
  applyExecutionSideEffects(userId, executedOps);
  setPendingOperation(userId, null);

  const reply = composeReply({
    replyDraft: "",
    pendingConfirmationOps: [],
    executedOps,
    problemOps: brokenOps
  });

  return finalize(userId, {
    reply,
    operationsPlanned: pending.operations.map((op) => ({ tool: op.tool, args: op.args })),
    executedOps,
    plannerUsed,
    llmPlannerAttempted: plannerUsed !== "none",
    toolValidationPassed: brokenOps.length === 0,
    topic: pending.topic
  });
}

function finalizeDeterministicCancellation(
  userId: string,
  context: ContextBundle,
  plannerUsed: "llm" | "fallback" | "none" = "none"
): AgentMessageResponse {
  const pending = context.session.pendingOperation;
  setPendingOperation(userId, null);

  const reply = pending ? "Cancelled — I won't do that." : "There's nothing pending for me to cancel.";

  return finalize(userId, {
    reply,
    operationsPlanned: [],
    executedOps: [{ tool: "confirmation.cancel", status: pending ? "executed" : "skipped", summary: reply }],
    plannerUsed,
    llmPlannerAttempted: plannerUsed !== "none",
    toolValidationPassed: true,
    topic: pending ? pending.topic : context.session.topic
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

function finalize(userId: string, input: FinalizeInput): AgentMessageResponse {
  setTopic(userId, input.topic);
  appendMessage(userId, "assistant", input.reply);
  const needsConfirmation = Boolean(getSession(userId).pendingOperation);

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

function applyExecutionSideEffects(userId: string, executedOps: ExecutedOperation[]): void {
  const entities: AgentEntity[] = [];

  for (const op of executedOps) {
    if (op.status === "executed") {
      recordMutation(userId, op.summary);
    }
    if (op.entities) {
      entities.push(...op.entities);
    }
  }

  if (entities.length > 0) {
    setVisibleEntities(userId, dedupeEntities(entities));
  }
}

function dedupeEntities(entities: AgentEntity[]): AgentEntity[] {
  const seen = new Map<string, AgentEntity>();
  for (const entity of entities) {
    seen.set(`${entity.type}:${entity.id}`, entity);
  }
  return [...seen.values()];
}
