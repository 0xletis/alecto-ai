import { getOrCreateNotificationSettings } from "@operator-agent/db";

/**
 * Dependency-free (besides the DB) user-timezone lookup extracted from
 * apps/api/src/server.ts, where it was defined once privately and called
 * 43 times across nearly every domain in the file — not specific to
 * pending actions, which is why it lives here rather than in
 * apps/api/src/routes/pending-actions.ts (which also needs it).
 */
export async function getUserTimezone(userId: string): Promise<string> {
  try {
    const settings = await getOrCreateNotificationSettings(userId);
    return settings.timezone || "Europe/Madrid";
  } catch {
    return "Europe/Madrid";
  }
}
