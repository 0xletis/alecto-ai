import type { FastifyInstance } from "fastify";
import { UpdateNotificationSettingsInputSchema } from "@operator-agent/core";
import { getOrCreateNotificationSettings, updateNotificationSettings } from "@operator-agent/db";

/**
 * Notification settings routes, extracted from apps/api/src/server.ts's
 * buildServer() as-is (pure move, no behavior change) — these handlers have
 * no dependency on any server.ts-private helper function, so there is no
 * circular-import risk in moving them here.
 */
export function registerNotificationSettingsRoutes(server: FastifyInstance): void {
  server.get<{ Params: { userId: string } }>("/users/:userId/notification-settings", async (request) => ({
    notificationSettings: await getOrCreateNotificationSettings(request.params.userId)
  }));

  server.patch<{ Params: { userId: string } }>("/users/:userId/notification-settings", async (request, reply) => {
    const parsed = UpdateNotificationSettingsInputSchema.safeParse(request.body);

    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid request body",
        issues: parsed.error.issues
      });
    }

    return {
      notificationSettings: await updateNotificationSettings(request.params.userId, parsed.data)
    };
  });
}
