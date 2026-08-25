import {
  ensureUser,
  getActionItems,
  getActiveGoals,
  getEmailReviewItems,
  getEmailSignalRules,
  getIntegrationConnections,
  getLatestPendingAction,
  getOrCreateUserOperatingProfile,
  getRecentEvents,
  getRelevantMemories
} from "@operator-agent/db";
import type { ContextBundle } from "./types.js";
import { loadSession } from "./conversation-session.js";

export async function loadContext(userId: string, channel: string): Promise<ContextBundle> {
  // Deliberately awaited BEFORE the Promise.all below, not inside it: several of those
  // queries (e.g. getOrCreateUserOperatingProfile) can INSERT a row with a foreign key to
  // User.id. Running them concurrently with ensureUser's own upsert races against it — on a
  // brand-new user's very first message, the FK insert can land before ensureUser's create
  // has committed, throwing a foreign-key-violation that crashes the whole turn. Awaiting
  // ensureUser first guarantees the User row exists before anything that depends on it runs.
  const user = await ensureUser(userId);

  const [
    activeGoals,
    openActions,
    deferredActions,
    recentEvents,
    memories,
    integrationConnections,
    gmailRules,
    gmailReviews,
    operatingProfile,
    session,
    legacyPendingAction
  ] = await Promise.all([
    getActiveGoals(userId),
    getActionItems(userId, { status: "open", limit: 20 }),
    // Snoozed/deferred actions are deliberately NOT part of openActions (that field means
    // "actionable right now," used throughout — morning brief, "existing open action wins"
    // duplicate-suppression, the planner's own backgroundOpenActions) — but goal.recommend_next_
    // action needs to see them too, or it has no way to know "the user already moved this to
    // tomorrow" and ends up proposing a near-duplicate for today (the exact reported bug this
    // exists to fix). A separate field, not a broadened openActions, so every existing "is this
    // actionable now" consumer keeps its current, correct meaning unchanged.
    getActionItems(userId, { status: "snoozed", limit: 20 }),
    getRecentEvents(userId, 15),
    getRelevantMemories(userId, { limit: 15 }),
    getIntegrationConnections(userId),
    getEmailSignalRules(userId),
    getEmailReviewItems(userId, { status: "pending", limit: 10 }),
    getOrCreateUserOperatingProfile(userId),
    loadSession(userId, channel),
    getLatestPendingAction(userId)
  ]);

  const activeGmailRuleConnectionIds = new Set(
    gmailRules.filter((rule) => rule.status === "active").map((rule) => rule.connectionId)
  );
  const gmailConnection =
    integrationConnections.find(
      (connection) =>
        connection.integrationId === "gmail" &&
        connection.status === "active" &&
        activeGmailRuleConnectionIds.has(connection.id)
    ) ??
    integrationConnections.find((connection) => connection.integrationId === "gmail" && connection.status === "active") ??
    integrationConnections.find((connection) => connection.integrationId === "gmail" && connection.status !== "archived") ??
    integrationConnections.find((connection) => connection.integrationId === "gmail");

  return {
    user,
    activeGoals,
    openActions,
    deferredActions,
    recentEvents,
    memories,
    gmailConnection,
    gmailRules,
    gmailReviews,
    operatingProfile,
    session,
    legacyPendingAction: legacyPendingAction ?? null
  };
}
