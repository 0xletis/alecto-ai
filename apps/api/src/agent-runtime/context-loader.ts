import {
  ensureUser,
  getActionItems,
  getActiveGoals,
  getEmailReviewItems,
  getEmailSignalRules,
  getIntegrationConnections,
  getOrCreateUserOperatingProfile,
  getRecentEvents,
  getRelevantMemories
} from "@operator-agent/db";
import type { ContextBundle } from "./types.js";
import { getSession } from "./conversation-session.js";

export async function loadContext(userId: string): Promise<ContextBundle> {
  const [user, activeGoals, openActions, recentEvents, memories, integrationConnections, gmailRules, gmailReviews, operatingProfile] =
    await Promise.all([
      ensureUser(userId),
      getActiveGoals(userId),
      getActionItems(userId, { status: "open", limit: 20 }),
      getRecentEvents(userId, 15),
      getRelevantMemories(userId, { limit: 15 }),
      getIntegrationConnections(userId),
      getEmailSignalRules(userId),
      getEmailReviewItems(userId, { status: "pending", limit: 10 }),
      getOrCreateUserOperatingProfile(userId)
    ]);

  const gmailConnection = integrationConnections.find((connection) => connection.integrationId === "gmail");

  return {
    user,
    activeGoals,
    openActions,
    recentEvents,
    memories,
    gmailConnection,
    gmailRules,
    gmailReviews,
    operatingProfile,
    session: getSession(userId)
  };
}
