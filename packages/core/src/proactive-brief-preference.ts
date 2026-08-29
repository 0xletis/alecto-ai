import { z } from "zod";
import type { MemoryEntry } from "./memory.js";

/**
 * fix/private-alpha-proactive-brief-llm-personalization: a durable record of what KIND of morning/
 * evening brief content a user asked for — "send me motivational quotes every morning", "give me a
 * reflection prompt", "I want tough love", "make it gentler". Stored as a MemoryEntry with type
 * "proactive_brief_preference" (see memory.ts) rather than a new Prisma table/column: MemoryEntry's
 * existing `data: Json?` field already fits this shape exactly, and reusing it means no schema
 * migration is needed for this feature.
 *
 * `scope: "goal"` links the preference to exactly one goal (a life-meaning goal's quote preference
 * must never leak into a job-search goal's brief); `scope: "global"` applies whenever no specific
 * goal is the clear target — either because none was named, or because none existed yet at request
 * time. Exactly one preference should ever be ACTIVE per (userId, scope, goalId) combination —
 * packages/db's upsertProactiveBriefPreference enforces this by archiving any existing match before
 * creating the new one, so a later "make it gentler" replaces rather than stacks on top of an
 * earlier "tough love" for the same goal/scope.
 */
export const ProactiveBriefStyleSchema = z.enum(["motivational", "reflection", "tough_love", "gentle", "practical"]);
export type ProactiveBriefStyle = z.infer<typeof ProactiveBriefStyleSchema>;

export const ProactiveBriefTypeSchema = z.enum(["morning", "evening", "both"]);
export type ProactiveBriefPreferenceMoment = z.infer<typeof ProactiveBriefTypeSchema>;

export const ProactiveBriefPreferenceDataSchema = z.object({
  scope: z.enum(["goal", "global"]),
  goalId: z.string().optional(),
  briefType: ProactiveBriefTypeSchema,
  style: ProactiveBriefStyleSchema,
  /** The user's own words for what they asked for, e.g. "motivational quotes" — shown back in
   * status/diagnosis copy and lightly informs the LLM prompt; never enforced verbatim. */
  contentRequest: z.string().min(1).max(200)
});
export type ProactiveBriefPreferenceData = z.infer<typeof ProactiveBriefPreferenceDataSchema>;

export interface ProactiveBriefPreference extends ProactiveBriefPreferenceData {
  id: string;
  createdAt: Date;
}

/** Parses the `data` JSON of every active "proactive_brief_preference" memory into a typed list,
 * silently dropping anything that fails schema validation (a hand-edited or pre-migration row)
 * rather than throwing — brief generation must never break because one stray memory is malformed. */
export function parseProactiveBriefPreferences(memories: MemoryEntry[]): ProactiveBriefPreference[] {
  const preferences: ProactiveBriefPreference[] = [];

  for (const memory of memories) {
    if (memory.type !== "proactive_brief_preference" || memory.status !== "active") {
      continue;
    }

    const parsed = ProactiveBriefPreferenceDataSchema.safeParse(memory.data);
    if (!parsed.success) {
      continue;
    }

    preferences.push({ ...parsed.data, id: memory.id, createdAt: memory.createdAt });
  }

  return preferences;
}

/**
 * The single preference that should shape THIS brief: a goal-scoped preference for the goal being
 * briefed always wins over a global one (an explicit "for this goal" request is more specific than
 * a general standing preference) — never both, and never a goal-scoped preference from a DIFFERENT
 * goal (the exact leak test 3D guards against). Among several matches for the same scope, the most
 * recently created wins, so a later "switch to tough love" supersedes an earlier "motivational"
 * even if upsertProactiveBriefPreference's own archive-on-write ever raced (defensive, not expected
 * in practice since that function archives synchronously before creating the replacement).
 */
export function resolveProactiveBriefPreference(
  preferences: ProactiveBriefPreference[],
  goalId: string | undefined,
  briefType: "morning" | "evening"
): ProactiveBriefPreference | undefined {
  const appliesToBriefType = (preference: ProactiveBriefPreference) =>
    preference.briefType === briefType || preference.briefType === "both";

  const goalScoped = goalId
    ? preferences
        .filter((preference) => preference.scope === "goal" && preference.goalId === goalId && appliesToBriefType(preference))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]
    : undefined;

  if (goalScoped) {
    return goalScoped;
  }

  return preferences
    .filter((preference) => preference.scope === "global" && appliesToBriefType(preference))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
}
