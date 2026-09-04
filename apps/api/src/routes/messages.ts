import type { FastifyInstance } from "fastify";
import {
  ProcessMessageInputSchema,
  type ProcessMessageInput,
  type ProcessMessageResult
} from "@operator-agent/core";
import { runExclusive } from "../agent-runtime/user-lock.js";

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

    // refactor/private-alpha-general-email-intelligence-workflow (gate 7 hardening): the same
    // per-user queue /agent/message's v3 path already uses (handleAgentMessage -> runExclusive,
    // apps/api/src/agent-runtime/runtime.ts) — this legacy pipeline had no concurrency control of
    // its own (two /messages/process calls, or a legacy call racing a v3 call, for the same user
    // could otherwise interleave pending-decision state). Sharing the SAME queue, keyed by userId,
    // serializes both paths against each other, not just against themselves.
    return runExclusive(parsed.data.userId, () => handlers.process(parsed.data));
  });
}
