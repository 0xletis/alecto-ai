import Fastify from "fastify";
import { eventRegistry, processMessage, ProcessMessageInputSchema } from "@operator-agent/core";

export function buildServer() {
  const server = Fastify({
    logger: true
  });

  server.get("/health", async () => ({
    ok: true,
    service: "operator-agent-api"
  }));

  server.get("/events/types", async () => ({
    eventTypes: eventRegistry
  }));

  server.post("/messages/process", async (request, reply) => {
    const parsed = ProcessMessageInputSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid request body",
        issues: parsed.error.issues
      });
    }

    return processMessage(parsed.data);
  });

  return server;
}
