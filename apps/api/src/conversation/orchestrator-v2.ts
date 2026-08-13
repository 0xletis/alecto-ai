import {
  evaluateGoalGuardrails,
  segmentInboundMessage,
  type Goal,
  type ProcessMessageResult
} from "@operator-agent/core";
import type { PendingAction } from "@operator-agent/db";
import { buildConversationContext } from "./context.js";
import { buildAvailableOperationsCatalog } from "./operation-catalog.js";
import { executeConversationOperations, type ConversationExecutorCallbacks } from "./operation-executor.js";
import { planConversationOperations } from "./operation-planner.js";
import { validateConversationOperationPlan } from "./operation-validator.js";
import { composeConversationResponse } from "./response-composer.js";

export interface ConversationOrchestratorV2Callbacks extends ConversationExecutorCallbacks {
  getActiveGoals(userId: string): Promise<Goal[]>;
  getLatestPendingAction(userId: string): Promise<PendingAction | undefined>;
  createRiskGuardrailReply(
    userId: string,
    message: string,
    guardrail: ReturnType<typeof evaluateGoalGuardrails>
  ): Promise<ProcessMessageResult>;
}

export interface ConversationOrchestratorV2Result {
  handled: boolean;
  reply?: string;
  processResult?: ProcessMessageResult;
  routeDebug?: NonNullable<ProcessMessageResult["routeDebug"]>;
  mutation: boolean;
}

export function isConversationOrchestratorV2Enabled(): boolean {
  return process.env.CONVERSATION_ORCHESTRATOR_V2_ENABLED === "true";
}

export async function runConversationOrchestratorV2(input: {
  userId: string;
  message: string;
  now?: Date;
  callbacks: ConversationOrchestratorV2Callbacks;
}): Promise<ConversationOrchestratorV2Result> {
  const segment = segmentInboundMessage(input.message);

  if (segment.kind === "reference_text") {
    return {
      handled: true,
      reply: "That looks like pasted reference text, so I did not execute anything.",
      mutation: false,
      routeDebug: {
        routerSource: "conversation_orchestrator_v2",
        orchestrator: "v2",
        v2Enabled: isConversationOrchestratorV2Enabled(),
        intent: "reference_text",
        handlerName: "runConversationOrchestratorV2",
        handledBy: "v2",
        plannerUsed: "none",
        llmPlannerAttempted: false,
        llmPlannerUsed: false,
        contextLoaded: false,
        visibleContextType: "unknown",
        visibleEntityCount: 0,
        pendingConfirmation: false,
        mutationExecuted: false,
        semanticRouterAttempted: false,
        semanticRouterUsed: false,
        mutation: false,
        reason: segment.reason
      }
    };
  }

  const activeGoals = await input.callbacks.getActiveGoals(input.userId);
  const guardrail = evaluateGoalGuardrails({
    text: input.message,
    activeGoals
  });

  if (guardrail.triggered && !guardrail.isReferenceOnly) {
    const processResult = await input.callbacks.createRiskGuardrailReply(input.userId, input.message, guardrail);
    return {
      handled: true,
      processResult: {
        ...processResult,
        routeDebug: {
          ...processResult.routeDebug,
          routerSource: processResult.routeDebug?.routerSource ?? "deterministic_guardrail",
          intent: processResult.routeDebug?.intent ?? "goal_guardrail",
          handlerName: processResult.routeDebug?.handlerName ?? "createRiskGuardrailReply",
          orchestrator: "v2",
          v2Enabled: isConversationOrchestratorV2Enabled(),
          handledBy: "risk_guardrail",
          plannerUsed: "none",
          llmPlannerAttempted: false,
          llmPlannerUsed: false,
          contextLoaded: false,
          visibleContextType: "unknown",
          visibleEntityCount: 0,
          pendingConfirmation: false,
          mutationExecuted: true
        }
      },
      mutation: true
    };
  }

  const pendingAction = await input.callbacks.getLatestPendingAction(input.userId);
  const context = buildConversationContext({
    userId: input.userId,
    pendingAction,
    now: input.now
  });
  const availableOperations = buildAvailableOperationsCatalog(context);
  const plan = await planConversationOperations({
    message: input.message,
    context,
    availableOperations
  });

  if (!plan) {
    return {
      handled: false,
      mutation: false,
      routeDebug: buildRouteDebug({
        intent: "not_migrated",
        handlerName: "planConversationOperations",
        handledBy: "none",
        skippedReason: "No v2 operation matched this message.",
        plannerUsed: "none",
        context,
        mutationExecuted: false
      })
    };
  }

  const validation = validateConversationOperationPlan({
    plan,
    context,
    availableOperations
  });

  if (!validation.ok) {
    return {
      handled: true,
      reply: validation.safeReply,
      mutation: false,
      routeDebug: {
        ...buildRouteDebug({
          intent: plan.intent,
          handlerName: "validateConversationOperationPlan",
          handledBy: "v2",
          plannerUsed: plan.source,
          context,
          mutationExecuted: false
        }),
        intent: plan.intent,
        reason: validation.failureReasons.join("; ")
      }
    };
  }

  const execution = await executeConversationOperations({
    userId: input.userId,
    message: input.message,
    context,
    plan,
    operations: validation.operations,
    pendingAction,
    callbacks: input.callbacks
  });
  const latestPendingAction = await input.callbacks.getLatestPendingAction(input.userId);
  const latestContext = buildConversationContext({
    userId: input.userId,
    pendingAction: latestPendingAction,
    now: input.now
  });
  const debugContext = latestContext.visibleEntities.length > 0 || latestContext.pendingConfirmation
    ? latestContext
    : context;
  const reply = composeConversationResponse(execution);

  return {
    handled: true,
    reply,
    mutation: execution.mutated,
    routeDebug: {
      ...buildRouteDebug({
        intent: plan.intent,
        handlerName: "runConversationOrchestratorV2",
        handledBy: "v2",
        plannerUsed: plan.source,
        context: debugContext,
        mutationExecuted: didExecuteRealMutation(reply, execution.mutated)
      }),
      intent: plan.intent,
      reason: plan.operations.map((operation) => operation.reason ?? operation.name).join("; ")
    }
  };
}

function buildRouteDebug(input: {
  intent: string;
  handlerName: string;
  handledBy: string;
  skippedReason?: string;
  plannerUsed: "deterministic" | "llm" | "legacy" | "none";
  context: ReturnType<typeof buildConversationContext>;
  mutationExecuted: boolean;
}) {
  return {
    routerSource: "conversation_orchestrator_v2",
    orchestrator: "v2",
    v2Enabled: isConversationOrchestratorV2Enabled(),
    intent: input.intent,
    handlerName: input.handlerName,
    handledBy: input.handledBy,
    skippedReason: input.skippedReason,
    plannerUsed: input.plannerUsed,
    llmPlannerAttempted: false,
    llmPlannerUsed: input.plannerUsed === "llm",
    contextLoaded: input.context.lastAssistantOutputType !== "unknown",
    visibleContextType: input.context.lastAssistantOutputType,
    visibleEntityCount: input.context.visibleEntities.length,
    contextCreatedBy: input.context.contextCreatedBy,
    pendingConfirmation: Boolean(input.context.pendingConfirmation),
    mutationExecuted: input.mutationExecuted,
    semanticRouterAttempted: false,
    semanticRouterUsed: false,
    mutation: input.mutationExecuted
  };
}

function didExecuteRealMutation(reply: string, operationMutates: boolean): boolean {
  if (!operationMutates) {
    return false;
  }

  return !/^(I will:|Confirm\b|Which\b|Reply\b|Run \/action_hygiene|I don't have a visible cleanup item|I can do that, but|I can .* but archive is not available|That hygiene session no longer has any options|I could not|No action|No pending|I did not find|Add a time|Kept for now)/i.test(reply.trim());
}
