import type { FastifyInstance } from "fastify";
import { CreateMemoryInputSchema } from "@operator-agent/core";
import { archiveMemory, createMemory, getActiveMemories, getMemories } from "@operator-agent/db";

/**
 * Memory CRUD routes, extracted from apps/api/src/server.ts's buildServer()
 * as-is (pure move, no behavior change) — these handlers have no
 * dependency on any server.ts-private helper function, so there is no
 * circular-import risk in moving them here.
 */
export function registerMemoryRoutes(server: FastifyInstance): void {
  server.get<{ Params: { userId: string }; Querystring: { includeArchived?: string } }>(
    "/users/:userId/memory",
    async (request) => ({
      memories:
        request.query.includeArchived === "true"
          ? await getMemories(request.params.userId)
          : await getActiveMemories(request.params.userId)
    })
  );

  server.post<{ Params: { userId: string } }>("/users/:userId/memory", async (request, reply) => {
    const parsed = CreateMemoryInputSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid request body",
        issues: parsed.error.issues
      });
    }

    return {
      memory: await createMemory(request.params.userId, {
        ...parsed.data,
        source: "manual"
      })
    };
  });

  server.patch<{ Params: { userId: string; memoryId: string } }>(
    "/users/:userId/memory/:memoryId/archive",
    async (request, reply) => {
      const memory = await archiveMemory(request.params.userId, request.params.memoryId);

      if (!memory) {
        return reply.status(404).send({
          error: "Memory not found"
        });
      }

      return { memory };
    }
  );
}
