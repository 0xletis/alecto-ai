import { createOpenAIClient } from "@operator-agent/llm";
import type { Goal, UserOperatingProfile } from "@operator-agent/core";
import type { ContextBundle } from "./types.js";

/**
 * Generic, goal-aligned guardrail check — replaces the old checkPolicyGuardrail (which lived in
 * validator.ts and only matched literal knownTriggers/knownFailureModes phrases). Alecto has no
 * hardcoded gambling/finance/health domain logic anywhere in this module: every intervention is
 * either (a) a literal match against a trigger phrase the USER configured, or (b) a semantic
 * conflict against a GOAL the user set themselves ("Stop gambling", "Quit smoking", "Train 3x/
 * week", "Apply to jobs every weekday" are all just user-authored Goal rows — nothing here knows
 * or cares which of those is about gambling versus fitness). This is deliberate: the product
 * direction is "Alecto detects behavior that conflicts with the user's own stated goals," not
 * "Alecto has a pile of domain-specific safety classifiers."
 */

const defaultModel = "gpt-4o-mini";

export type GuardrailDecision = "allow" | "soft_warn" | "hard_block" | "ask_clarification";
export type GuardrailPattern = "trigger_match" | "active_violation" | "avoidance" | "lapse_admission";

export interface GuardrailResult {
  decision: GuardrailDecision;
  /** Null only when decision is "allow" — nothing to say, normal planning continues. */
  reply: string | null;
  matchedGoalId: string | null;
  matchedGoalTitle: string | null;
  matchedTrigger: string | null;
  pattern: GuardrailPattern | null;
  /** Internal, loggable reason — not necessarily identical to the user-facing reply. */
  reason: string;
  /** Whether the LLM classification tier was actually invoked this turn (for debug/telemetry). */
  llmAttempted: boolean;
}

const ALLOW: GuardrailResult = {
  decision: "allow",
  reply: null,
  matchedGoalId: null,
  matchedGoalTitle: null,
  matchedTrigger: null,
  pattern: null,
  reason: "no_conflict",
  llmAttempted: false
};

export async function checkGoalGuardrail(message: string, context: ContextBundle): Promise<GuardrailResult> {
  const trigger = findTriggerMatch(message, context.operatingProfile);
  if (trigger) {
    const goal = findGoalRelatedToTrigger(trigger, context.activeGoals);
    return {
      decision: "hard_block",
      reply: goal
        ? composeGoalConflictReply("hard_block", "trigger_match", goal.title, context.operatingProfile)
        : "This touches something you've asked me to be careful about. I'm not going to act on it automatically — let's slow down and talk it through first.",
      matchedGoalId: goal?.id ?? null,
      matchedGoalTitle: goal?.title ?? null,
      matchedTrigger: trigger,
      pattern: "trigger_match",
      reason: `configured_trigger:${trigger}`,
      llmAttempted: false
    };
  }

  if (context.activeGoals.length === 0) {
    return ALLOW;
  }

  // A real Telegram smoke test found the LLM classification tier below misreading ordinary
  // progress reports — "i didnt finish it but i read 30min today," "log it," "I only did 5
  // minutes," "I missed gym but walked 30min," "I sent 1 CV, not 3" — as "lapse_admission"/
  // "avoidance" against a goal, purely because they mention a shortfall word ("didn't
  // finish"/"missed"/"only") alongside real activity. Reporting partial progress toward an
  // ongoing tracked goal is not sabotage of it; it's exactly the kind of evidence goal.log_evidence
  // exists to capture. This is a deterministic, generic shape check — any quantified activity
  // ("<number> <unit>") or an explicit logging phrase ("log it," "logged that") — not a per-domain
  // classifier, so it applies the same way to reading, gym, job applications, or anything else the
  // user tracks. It only ever widens what reaches normal planning; an explicit user-configured
  // trigger above still always hard-stops regardless of shape, and the LLM tier below still runs
  // for genuinely ambiguous or avoidance-shaped messages (a message with no quantity/log phrase at
  // all, e.g. "I'd rather watch TV than read tonight," still reaches classification as before).
  if (looksLikeProgressReport(message)) {
    return { ...ALLOW, reason: "progress_report_shape" };
  }

  // fix/private-alpha-action-temporal-coaching: a real Telegram transcript found "snooze it for
  // later this week" classified as goal avoidance — the LLM tier below has no visibility into
  // WHAT the user is actually looking at, so a deferral verb next to a real, singular, currently-
  // visible action read as skipping something rather than rescheduling it. Deliberately gated on
  // exactly one visible action (the same bar runtime.ts's own bare-reference shortcuts use) —
  // this is deliberately NOT the primary fix (runtime.ts's own actionDeferralAmbiguousWeekClarification
  // and the broadened ACTION_SNOOZE_PATTERN shortcut intercept the common cases before the
  // guardrail is ever reached at all), just a second, independent layer for phrasing outside that
  // shortcut's own vocabulary. Only ever widens what's allowed through, same as the progress-
  // report shape check above; genuinely vague avoidance ("I don't want to do this goal anymore")
  // matches neither pattern and still reaches the LLM tier below unchanged.
  if (looksLikeActionSchedulingLanguage(message, context)) {
    return { ...ALLOW, reason: "action_scheduling_shape" };
  }

  const classification = await classifyGoalConflict(message, context.activeGoals);
  if (!classification) {
    return { ...ALLOW, llmAttempted: true };
  }

  if (classification.conflict === "none") {
    return { ...ALLOW, llmAttempted: true, reason: classification.reason };
  }

  // Never trust an id the model wasn't actually given — an invented/mismatched id collapses
  // straight back to allow rather than blocking on a goal that doesn't really exist.
  const goal = classification.goalId ? context.activeGoals.find((candidate) => candidate.id === classification.goalId) : undefined;
  if (!goal) {
    return { ...ALLOW, llmAttempted: true, reason: "classification_named_unknown_goal" };
  }

  if (classification.conflict === "ask_clarification") {
    return {
      decision: "ask_clarification",
      reply: classification.clarifyingQuestion?.trim() || `Is this related to your goal to ${lowerFirst(goal.title)}, or something else?`,
      matchedGoalId: goal.id,
      matchedGoalTitle: goal.title,
      matchedTrigger: null,
      pattern: null,
      reason: classification.reason,
      llmAttempted: true
    };
  }

  const decision = classification.conflict; // "soft_warn" | "hard_block"
  const pattern = classification.pattern ?? (decision === "hard_block" ? "active_violation" : "avoidance");

  return {
    decision,
    reply: composeGoalConflictReply(decision, pattern, goal.title, context.operatingProfile),
    matchedGoalId: goal.id,
    matchedGoalTitle: goal.title,
    matchedTrigger: null,
    pattern,
    reason: classification.reason,
    llmAttempted: true
  };
}

/**
 * Exact match semantics preserved from the old checkPolicyGuardrail: reacts only to phrases the
 * user's own profile already lists, never to a hardcoded domain vocabulary.
 */
function findTriggerMatch(message: string, profile: UserOperatingProfile): string | null {
  const text = message.toLowerCase();
  const candidates = [...(profile.knownTriggers ?? []), ...(profile.knownFailureModes ?? [])];
  const matched = candidates.find((candidate) => candidate.trim().length > 0 && text.includes(candidate.trim().toLowerCase()));
  return matched ?? null;
}

const STOPWORDS = new Set(["a", "an", "the", "to", "my", "of", "for", "and", "or", "on", "in", "at"]);

/** Best-effort: does a configured trigger phrase share a significant word with one of the user's own active goals, so the reply can name the goal instead of the generic fallback? */
function findGoalRelatedToTrigger(trigger: string, goals: Goal[]): Goal | undefined {
  const triggerWords = significantWords(trigger);
  if (triggerWords.length === 0) return undefined;

  return goals.find((goal) => {
    const goalWords = new Set(significantWords(`${goal.title} ${goal.why ?? ""}`));
    return triggerWords.some((word) => goalWords.has(word));
  });
}

/** A quantified unit ("30 minutes," "5 pages," "2 CVs," "1 rep") or an explicit intent to record
 * something ("log it," "logged that") — generic activity-report shapes, not tied to any one
 * domain's vocabulary. Deliberately permissive (a few false exemptions fail open to normal
 * planning, matching this module's existing "a missed intervention degrades to ordinary chat,
 * never a false block" philosophy) rather than trying to also rule out every message that merely
 * mentions a number for some other reason. */
const QUANTIFIED_ACTIVITY_PATTERN =
  /\b\d+(\.\d+)?\s*(min(ute)?s?|hrs?|hours?|pages?|chapters?|sessions?|reps?|sets?|cups?|calls?|cvs?|applications?|miles?|km|steps?|times?)\b/i;
const LOG_INTENT_PATTERN = /\blog(ged|ging)\b|\blog\s+(it|that|this)\b/i;

function looksLikeProgressReport(message: string): boolean {
  return QUANTIFIED_ACTIVITY_PATTERN.test(message) || LOG_INTENT_PATTERN.test(message);
}

// Mirrors runtime.ts's own ACTION_SNOOZE_PATTERN vocabulary (kept as a separate, independent
// pattern rather than a shared import — this module has no other dependency on runtime.ts, and
// duplicating a small, stable keyword list is safer here than introducing one purely for this).
// Deliberately excludes bare "not today"/"not now" — those two are genuinely ambiguous between
// "move this task" and "I'm skipping my actual commitment today," and are already handled with
// proper context (a real single visible action, via the LLM prompt/validator) at the tool layer;
// this guardrail-level check only ever allows through phrasing unambiguous enough to be safe
// without that extra context.
const ACTION_SCHEDULING_LANGUAGE_PATTERN =
  /\b(snooze|move (it|this|that)|bring (it|this|that) back|park (it|this|that)|push (it|this|that)|defer|remind me)\b|\bmu[eé]velo\b|\bp[aá]salo\b|\brecu[eé]rdamelo\b|\bmou-ho\b|\bpassa-ho\b|\brecorda-m['’]ho\b/i;

function looksLikeActionSchedulingLanguage(message: string, context: ContextBundle): boolean {
  const singleVisibleAction = context.session.visibleEntities.filter((entity) => entity.type === "action").length === 1;
  return singleVisibleAction && ACTION_SCHEDULING_LANGUAGE_PATTERN.test(message);
}

function significantWords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2 && !STOPWORDS.has(word));
}

function lowerFirst(text: string): string {
  return text.length === 0 ? text : text[0].toLowerCase() + text.slice(1);
}

/**
 * Deterministic reply templates parameterized by the matched goal + pattern + the user's own
 * profile tone — never raw LLM prose. Works identically for any goal (gambling, finance,
 * smoking, job search, training, sleep, or anything else the user defines) because it only ever
 * plugs in the goal's own title; there is no per-domain branch anywhere in this function.
 */
function composeGoalConflictReply(decision: "hard_block" | "soft_warn", pattern: GuardrailPattern, goalTitle: string, profile: UserOperatingProfile): string {
  const direct = profile.directness >= 4;
  const goal = lowerFirst(goalTitle.trim());

  if (decision === "hard_block") {
    return direct
      ? `No. That conflicts with your goal to ${goal}. Don't do it — pause and think about what's driving this before you act.`
      : `That conflicts with your goal to ${goal}. I'd rather you paused here — what's driving this right now?`;
  }

  if (pattern === "lapse_admission") {
    return `Noted — but that's a lapse against your goal to ${goal}. Want to log it and plan the next step?`;
  }

  // avoidance (default soft_warn pattern)
  return direct
    ? `That's avoidance of your goal to ${goal}. Handle the priority first, then decide if this still deserves the time.`
    : `This looks like it might be pulling you away from your goal to ${goal}. Want to handle that first?`;
}

interface GoalConflictClassification {
  conflict: "none" | "soft_warn" | "hard_block" | "ask_clarification";
  goalId: string | null;
  pattern: "active_violation" | "avoidance" | "lapse_admission" | null;
  clarifyingQuestion: string | null;
  reason: string;
}

const CLASSIFICATION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    conflict: { type: "string", enum: ["none", "soft_warn", "hard_block", "ask_clarification"] },
    goalId: { type: ["string", "null"] },
    pattern: { type: ["string", "null"], enum: ["active_violation", "avoidance", "lapse_admission", null] },
    clarifyingQuestion: { type: ["string", "null"] },
    reason: { type: "string" }
  },
  required: ["conflict", "goalId", "pattern", "clarifyingQuestion", "reason"]
} as const;

/**
 * Only ever called when the user has at least one active goal — classifies the message against
 * THOSE goals only, nothing else. Returns null (never throws) when no key/mock is configured, or
 * on any classification failure — the caller treats null exactly like "no conflict found",
 * matching this module's fail-open-to-normal-chat philosophy: a missed intervention degrades to
 * ordinary planning, never a false block.
 */
async function classifyGoalConflict(message: string, goals: Goal[]): Promise<GoalConflictClassification | null> {
  const mockResponse = process.env.AGENT_RUNTIME_GUARDRAIL_MOCK_RESPONSE;
  if (mockResponse) {
    try {
      return JSON.parse(mockResponse) as GoalConflictClassification;
    } catch {
      return null;
    }
  }

  if (!process.env.OPENAI_API_KEY) {
    return null;
  }

  try {
    const client = createOpenAIClient();
    const model = process.env.AGENT_RUNTIME_GUARDRAIL_MODEL ?? process.env.OPENAI_MODEL ?? defaultModel;

    const response = await withGuardrailTimeout(
      client.responses.create({
        model,
        store: false,
        input: [
          { role: "developer", content: [{ type: "input_text", text: buildGuardrailSystemPrompt() }] },
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: JSON.stringify({ message, goals: goals.map((goal) => ({ id: goal.id, title: goal.title, why: goal.why ?? null })) })
              }
            ]
          }
        ],
        text: {
          format: { type: "json_schema", name: "goal_conflict_classification", strict: true, schema: CLASSIFICATION_SCHEMA }
        }
      })
    );

    return JSON.parse(response.output_text) as GoalConflictClassification;
  } catch {
    return null;
  }
}

const defaultGuardrailTimeoutMs = 15000;

/**
 * Bounds this Tier 2 OpenAI call so a slow/hung/misconfigured API key falls back to "no
 * classification" (the enclosing try/catch already treats any error as null, i.e. allow) within
 * a few seconds, instead of hanging the whole turn — this runs on EVERY message once the user has
 * at least one active goal, before the main planner ever runs, so a hang here blocks everything
 * downstream too. Mirrors planner.ts's withPlannerTimeout and attention.ts's
 * withDailyCoachTimeout, both pre-existing precedent for this exact pattern.
 */
export async function withGuardrailTimeout<T>(promise: Promise<T>): Promise<T> {
  const parsedTimeoutMs = Number(process.env.AGENT_RUNTIME_GUARDRAIL_TIMEOUT_MS ?? defaultGuardrailTimeoutMs);
  const timeoutMs = Number.isFinite(parsedTimeoutMs) && parsedTimeoutMs > 0 ? parsedTimeoutMs : defaultGuardrailTimeoutMs;

  return await Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error("Agent Runtime v3 guardrail LLM call timed out.")), timeoutMs);
    })
  ]);
}

function buildGuardrailSystemPrompt(): string {
  return [
    "You classify whether a user's message conflicts with one of THEIR OWN previously stated goals.",
    "You are given the user's active goals below (id/title/why). Classify only against these — never infer, assume, or invent a goal that isn't listed. If nothing listed is relevant, return conflict:\"none\".",
    "",
    "- hard_block: the message describes the user's own intent to actively DO something that directly violates a listed cessation/restraint-style goal (e.g. explicit intent to gamble/bet/trade/spend/smoke when a goal says to stop, quit, avoid, or reduce exactly that).",
    "- soft_warn: the message describes avoiding, procrastinating on, or already having lapsed on a listed pursuit/build-style goal (e.g. choosing something else over a stated priority, admitting a missed workout/task) — the message must itself describe deprioritizing, skipping, or falling short on THAT goal, not merely be about a different topic.",
    "- ask_clarification: only when it's genuinely ambiguous whether this is the user's own real, present intent versus a hypothetical, a past unrelated event, a question about a topic, or something concerning someone else. If you use this, set clarifyingQuestion to a short, specific question.",
    "- none: neutral, unrelated messages, general questions about a topic, messages where the user is asking for help controlling/resisting/managing an urge related to a goal (wanting support for a goal is never itself a violation of it), AND expressing a NEW, additional, or different goal/intent to pursue (e.g. 'I want to start X too', 'I also want to track Y') — wanting to pursue something else, even a totally unrelated one, is never by itself avoidance of an existing goal; only classify it as soft_warn if the message EXPLICITLY frames the new thing as instead of, at the expense of, or a reason to skip the existing goal (e.g. 'I'll do X instead of my Y goal').",
    "",
    "Set pattern only when conflict is hard_block or soft_warn: \"active_violation\" for hard_block-style intent, \"avoidance\" for deprioritizing a pursuit goal, \"lapse_admission\" for self-reporting a past failure/lapse. Otherwise pattern is null.",
    "Set goalId to the exact id of the one matched goal, or null if conflict is \"none\".",
    "Keep reason to one short internal sentence — it is logged, not shown to the user.",
    "Return only JSON matching the schema."
  ].join("\n");
}
