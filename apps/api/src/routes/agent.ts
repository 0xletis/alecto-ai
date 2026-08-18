import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { handleAgentMessage } from "../agent-runtime/runtime.js";
import type {
  AgentMessageRequest,
  AgentMessageResponse,
  PublicAgentMessageResponse,
  PublicExecutedOperation
} from "../agent-runtime/types.js";

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
