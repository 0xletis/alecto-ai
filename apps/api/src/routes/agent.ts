import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { getOrCreateNotificationSettings, hasNotificationLog } from "@operator-agent/db";
import { proactiveOperatorAllowlistFromEnv, proactiveOperatorDeliveryEnabledFromEnv } from "@operator-agent/core";
import { loadContext } from "../agent-runtime/context-loader.js";
import { handleAgentMessage } from "../agent-runtime/runtime.js";
import type {
  AgentMessageRequest,
  AgentMessageResponse,
  PublicAgentMessageResponse,
  PublicExecutedOperation
} from "../agent-runtime/types.js";
import { evaluateProactiveEligibility } from "../operator/proactive-eligibility.js";
import { decideProactiveOperatorMessage, gmailNudgeDedupeKey, EVENING_CHECKIN_DEDUPE_KEY, MORNING_BRIEF_DEDUPE_KEY } from "../operator/proactive.js";
import { formatDateInTimezone, parseOptionalNow } from "../utils/datetime.js";

export const AgentMessageRequestSchema = z.object({
  userId: z.string().min(1),
  message: z.string().min(1),
  channel: z.enum(["telegram", "web", "api"]).default("api"),
  /** Opt-in only: includes raw DB rows/queries/connection details in operationsExecuted[].result. */
  debugRaw: z.boolean().optional().default(false)
});

export interface AgentRouteHandlers {
  message(input: AgentMessageRequest): Promise<AgentMessageResponse>;
}

/**
 * Agent Runtime v3 spike. Isolated from /messages/process and every legacy
 * router — see apps/api/src/agent-runtime/ for the implementation. Not wired
 * to Telegram; call this directly to try the new runtime.
 */
export function registerAgentRoutes(server: FastifyInstance, handlers: AgentRouteHandlers): void {
  server.post("/agent/message", async (request, reply) => {
    const parsed = AgentMessageRequestSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid request body",
        issues: parsed.error.issues
      });
    }

    const result = await handlers.message(parsed.data);
    return parsed.data.debugRaw ? result : toPublicResponse(result);
  });

  // Preview-only: computes and returns what the V3 Proactive Operator MVP WOULD send, without
  // sending anything or persisting a NotificationLog entry — decideProactiveOperatorMessage
  // itself never touches the DB. This is deliberately the only integration point for this pass
  // (per docs/10-v3-readiness-audit.md §13); wiring an actual scheduled send is a separate,
  // later decision. Reuses the exact same loadContext() every normal chat turn already uses.
  server.get<{ Params: { userId: string }; Querystring: { now?: string; channel?: string } }>(
    "/users/:userId/operator/proactive/preview",
    async (request) => {
      const userId = request.params.userId;
      const now = parseOptionalNow(request.query.now) ?? new Date();
      const channel = request.query.channel ?? "telegram";

      const [context, notificationSettings] = await Promise.all([loadContext(userId, channel), getOrCreateNotificationSettings(userId)]);

      const sentForDate = formatDateInTimezone(now, notificationSettings.timezone);
      const candidateDedupeKeys = [MORNING_BRIEF_DEDUPE_KEY, EVENING_CHECKIN_DEDUPE_KEY, ...context.gmailReviews.map((review) => gmailNudgeDedupeKey(review.id))];
      const sentFlags = await Promise.all(candidateDedupeKeys.map((type) => hasNotificationLog({ userId, type, sentForDate })));
      const alreadySentDedupeKeys = new Set(candidateDedupeKeys.filter((_, index) => sentFlags[index]));

      const decision = decideProactiveOperatorMessage({
        context,
        notificationSettings,
        now,
        alreadySentDedupeKeys,
        sentCountToday: alreadySentDedupeKeys.size
      });

      // Informational only — env flags are developer rollout controls, not the product UX (see
      // docs/10-v3-readiness-audit.md §15). apps/worker's own delivery code independently
      // re-checks every one of these before an actual send; this route never writes the DB.
      const eligibility = evaluateProactiveEligibility({
        decision,
        deliveryEnabled: proactiveOperatorDeliveryEnabledFromEnv(),
        isAllowlisted: proactiveOperatorAllowlistFromEnv()(userId),
        notificationSettings
      });

      return { decision, eligibility };
    }
  );
}

export function defaultAgentRouteHandlers(): AgentRouteHandlers {
  return { message: handleAgentMessage };
}

function toPublicResponse(response: AgentMessageResponse): PublicAgentMessageResponse {
  return {
    ...response,
    operationsExecuted: response.operationsExecuted.map(toPublicExecutedOperation)
  };
}

function toPublicExecutedOperation(op: AgentMessageResponse["operationsExecuted"][number]): PublicExecutedOperation {
  return { tool: op.tool, status: op.status, summary: op.summary, error: op.error, entities: op.entities };
}
