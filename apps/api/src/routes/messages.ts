import type { FastifyInstance } from "fastify";
import {
  ProcessMessageInputSchema,
  type ProcessMessageInput,
  type ProcessMessageResult
} from "@operator-agent/core";

export const messageRouteOwnership = {
  processV2: {
    route: "/messages/process_v2",
    owner: "conversation_orchestrator_v2",
    fallback: "none",
    notes: "Debug-only v2 endpoint. It returns not_migrated instead of falling through to legacy processing."
  },
  process: {
    route: "/messages/process",
    owner: "conversation_orchestrator_v2_first",
    fallback: "legacy_message_pipeline",
    notes: "Production message endpoint. V2 owns migrated scopes, then legacy deterministic/semantic routing handles unmigrated surfaces."
  }
} as const;

export interface MessageRouteHandlers {
  processV2(input: ProcessMessageInput): Promise<ProcessMessageResult>;
  process(input: ProcessMessageInput): Promise<ProcessMessageResult>;
}

export function registerMessageRoutes(server: FastifyInstance, handlers: MessageRouteHandlers): void {
  server.post("/messages/process_v2", async (request, reply) => {
    const parsed = ProcessMessageInputSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid request body",
        issues: parsed.error.issues
      });
    }

    return handlers.processV2(parsed.data);
  });

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
