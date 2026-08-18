import type { FastifyInstance } from "fastify";
import {
  ProcessMessageInputSchema,
  type ProcessMessageInput,
  type ProcessMessageResult
} from "@operator-agent/core";

export const messageRouteOwnership = {
  process: {
    route: "/messages/process",
    owner: "conversation_orchestrator_v2_first",
    fallback: "legacy_message_pipeline",
    notes: "Production message endpoint. V2 owns migrated scopes, then legacy deterministic/semantic routing handles unmigrated surfaces."
  }
} as const;

export interface MessageRouteHandlers {
  process(input: ProcessMessageInput): Promise<ProcessMessageResult>;
}

export function registerMessageRoutes(server: FastifyInstance, handlers: MessageRouteHandlers): void {
  server.post("/messages/process", async (request, reply) => {
    const parsed = ProcessMessageInputSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid request body",
        issues: parsed.error.issues
      });
    }

    return handlers.process(parsed.data);
  });
}
