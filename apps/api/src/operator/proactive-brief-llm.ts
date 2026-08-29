import { generateProactiveBriefMessage } from "@operator-agent/llm";
import { getProactiveBriefPreferences } from "@operator-agent/db";
import {
  resolveProactiveBriefPreference,
  resolveProductionDefaultedFlag,
  type Goal,
  type NotificationSettings,
  type ProactiveBriefContext,
  type ProactiveBriefPreference,
  type ProactiveBriefValidationFailureCode
} from "@operator-agent/core";
import type { ContextBundle } from "../agent-runtime/types.js";
import { assessTemporalHealth, formatTemporalHealthLabel, type ProactiveMessageProposal } from "./proactive.js";
import { formatDateInTimezone } from "../utils/datetime.js";

/**
 * fix/private-alpha-proactive-brief-llm-personalization: the ONLY place decideProactiveOperatorMessage's
 * output ever gets rewritten. Deliberately kept OUT of proactive.ts (decideProactiveOperatorMessage/
 * buildMorningBrief/buildEveningCheckin stay exactly as they were — pure, synchronous, zero new
 * inputs, zero regression risk to their own already-passing tests) — this module runs AFTER that
 * decision is already made, at the one place both the worker's real send and the preview route
 * actually read `decision.message` from: GET /users/:userId/operator/proactive/preview. Only ever
 * REPLACES `message`; never changes `decision`/`dedupeKey`/`entities`/whether anything sends —
 * the deterministic ProactiveMessageProposal remains the sole source of truth for WHETHER and
 * WHAT KIND of message goes out, and its own `message` is always the safe fallback text.
 *
 * gmail_nudge is deliberately never personalized here — it is already a specific, time-sensitive,
 * fully-factual notification about a real pending review; there is nothing to add without
 * repeating raw email content, which is expressly forbidden by Task 4's own output rules.
 */

export type ProactiveBriefPersonalizationSource =
  | "llm"
  | "fallback_not_applicable"
  | "fallback_disabled"
  | "fallback_timeout"
  | "fallback_error"
  | "fallback_invalid";

export interface ProactiveBriefPersonalizationDebug {
  source: ProactiveBriefPersonalizationSource;
  preferenceApplied?: { scope: "goal" | "global"; style: string; goalId?: string };
  goalId?: string;
  validationFailureCodes?: ProactiveBriefValidationFailureCode[];
}

export interface ProactiveBriefPersonalizationResult {
  message: string;
  debug: ProactiveBriefPersonalizationDebug;
}

// fix/private-alpha-launch-config-sanity: an unset PROACTIVE_BRIEF_LLM_ENABLED now defaults ON in
// production as long as OPENAI_API_KEY is actually present — an explicit "true"/"false" still
// always wins, and local dev/test keep defaulting OFF exactly as before.
export function shouldUseProactiveBriefLLM(): boolean {
  if (!process.env.OPENAI_API_KEY) {
    return false;
  }
  return resolveProductionDefaultedFlag(process.env.PROACTIVE_BRIEF_LLM_ENABLED, true);
}

export async function personalizeProactiveDecision(
  decision: ProactiveMessageProposal,
  context: ContextBundle,
  settings: NotificationSettings,
  now: Date
): Promise<ProactiveBriefPersonalizationResult> {
  if (decision.type !== "morning_brief" && decision.type !== "evening_checkin") {
    return { message: decision.message, debug: { source: "fallback_not_applicable" } };
  }

  const briefType = decision.type === "morning_brief" ? "morning" : "evening";
  const preferences = await getProactiveBriefPreferences(context.user.id);
  const goal = pickBriefGoal(preferences, context.activeGoals, briefType);
  const preference = resolveProactiveBriefPreference(preferences, goal?.id, briefType);
  const preferenceApplied = preference
    ? { scope: preference.scope, style: preference.style, goalId: preference.goalId }
    : undefined;

  if (!shouldUseProactiveBriefLLM()) {
    return { message: decision.message, debug: { source: "fallback_disabled", preferenceApplied, goalId: goal?.id } };
  }

  const llmContext = buildProactiveBriefContext(decision, context, settings, now, briefType, goal, preference);

  try {
    const response = await withProactiveBriefTimeout(generateProactiveBriefMessage(llmContext));
    return { message: response.message, debug: { source: "llm", preferenceApplied, goalId: goal?.id } };
  } catch (error) {
    console.warn("Proactive brief LLM personalization failed; using deterministic message.", error instanceof Error ? error.message : error);
    return {
      message: decision.message,
      debug: {
        source: proactiveBriefFallbackSource(error),
        preferenceApplied,
        goalId: goal?.id,
        validationFailureCodes: proactiveBriefValidationFailureCodes(error)
      }
    };
  }
}

/**
 * A goal-scoped preference reliably anchors the brief to ITS OWN goal only when it's the single
 * unambiguous goal-scoped preference for this brief type — never guessed among several. A lone
 * active goal is a safe, obvious anchor even with no preference at all (Task 7's goal-specific
 * tone needs a goal to key off of). Two-or-more active goals with no single clear goal-scoped
 * preference stays anchor-less on purpose: guessing which of several goals "the" brief is about
 * would risk exactly the cross-goal leak Task 3D exists to prevent.
 *
 * Exported so executor.ts's status/diagnosis copy (proactive.settings_show) can pick the exact
 * same goal this module would — status must never claim a style preference for a different goal
 * than the one delivery would actually apply it to.
 */
export function pickBriefGoal(
  preferences: ProactiveBriefPreference[],
  activeGoals: Goal[],
  briefType: "morning" | "evening"
): Goal | undefined {
  const relevantGoalScoped = preferences.filter(
    (preference) => preference.scope === "goal" && (preference.briefType === briefType || preference.briefType === "both")
  );

  if (relevantGoalScoped.length === 1) {
    const goal = activeGoals.find((candidate) => candidate.id === relevantGoalScoped[0]!.goalId);
    if (goal) {
      return goal;
    }
  }

  return activeGoals.length === 1 ? activeGoals[0] : undefined;
}

export function buildProactiveBriefContext(
  decision: ProactiveMessageProposal,
  context: ContextBundle,
  settings: NotificationSettings,
  now: Date,
  briefType: "morning" | "evening",
  goal: Goal | undefined,
  preference: ProactiveBriefPreference | undefined
): ProactiveBriefContext {
  const goalScopedActions = context.openActions.filter((action) => !goal || action.goalId === goal.id);
  const overdueActionLines = goalScopedActions
    .map((action) => ({ action, health: assessTemporalHealth(action, now, settings.timezone) }))
    .filter((entry) => entry.health.kind === "overdue")
    .map((entry) => `${entry.action.title} — ${formatTemporalHealthLabel(entry.health)}`);

  return {
    briefType,
    date: formatDateInTimezone(now, settings.timezone),
    timezone: settings.timezone,
    goal: goal ? { id: goal.id, title: goal.title, category: goal.category, why: goal.why } : undefined,
    otherActiveGoalTitles: context.activeGoals.filter((candidate) => candidate.id !== goal?.id).map((candidate) => candidate.title),
    preference: preference ? { style: preference.style, briefType: preference.briefType, contentRequest: preference.contentRequest } : undefined,
    openActionTitles: goalScopedActions.slice(0, 10).map((action) => action.title),
    overdueActionLines,
    // V3's deterministic morning/evening brief has no "recent wins" concept today (unlike the
    // legacy daily coach's DailyBriefContext) — left empty rather than invented, so validation
    // correctly treats ANY progress claim in the LLM's response as unsupported and rejects it.
    recentWins: [],
    gmailSignalLines: context.gmailReviews.length > 0 ? [`${context.gmailReviews.length} Gmail review${context.gmailReviews.length === 1 ? "" : "s"} pending.`] : [],
    deterministicFallbackMessage: decision.message,
    userOperatingProfile: {
      directness: context.operatingProfile.directness,
      warmth: context.operatingProfile.warmth,
      preferredStyle: context.operatingProfile.motivationalStyle
    }
  };
}

async function withProactiveBriefTimeout<T>(promise: Promise<T>): Promise<T> {
  const parsedTimeoutMs = Number(process.env.PROACTIVE_BRIEF_LLM_TIMEOUT_MS ?? 4000);
  const timeoutMs = Number.isFinite(parsedTimeoutMs) ? parsedTimeoutMs : 4000;

  return await Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new ProactiveBriefTimeoutError()), Math.max(1, timeoutMs));
    })
  ]);
}

class ProactiveBriefTimeoutError extends Error {
  constructor() {
    super("Proactive brief LLM call timed out.");
  }
}

function proactiveBriefFallbackSource(error: unknown): ProactiveBriefPersonalizationSource {
  if (error instanceof ProactiveBriefTimeoutError) {
    return "fallback_timeout";
  }

  if (isValidationLikeError(error)) {
    return "fallback_invalid";
  }

  return "fallback_error";
}

function proactiveBriefValidationFailureCodes(error: unknown): ProactiveBriefValidationFailureCode[] | undefined {
  if (error && typeof error === "object" && "failureCodes" in error) {
    return (error as { failureCodes: ProactiveBriefValidationFailureCode[] }).failureCodes;
  }

  return undefined;
}

function isValidationLikeError(error: unknown): boolean {
  if (error instanceof SyntaxError) {
    return true;
  }

  return Boolean(error && typeof error === "object" && "failureCodes" in error);
}
