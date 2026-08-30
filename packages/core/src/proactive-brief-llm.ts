import { z } from "zod";
import { ProactiveBriefStyleSchema, ProactiveBriefTypeSchema } from "./proactive-brief-preference.js";

/**
 * fix/private-alpha-proactive-brief-llm-personalization: the LLM composition layer for V3's
 * proactive morning brief / evening check-in. Mirrors packages/core/src/daily-coach.ts's own
 * "verified context in, schema-validated + fact-checked response out, deterministic fallback
 * always available" architecture deliberately — same safety shape, different content: this
 * module lets the actual brief TEXT vary (tone, a quote-style line, a reflection prompt) where
 * daily-coach.ts only ever varies a short diagnosis/next-move/warning/encouragement, but neither
 * module is ever allowed to invent a fact, create anything, or become the sole source of truth —
 * decideProactiveOperatorMessage (proactive.ts) has already fully decided WHETHER to send and
 * built a safe, deterministic `message` before this layer ever runs; this only ever tries to
 * REPLACE that text with a better-personalized one, falling back to the original on any failure.
 */

export const ProactiveBriefContextSchema = z.object({
  briefType: z.enum(["morning", "evening"]),
  date: z.string().min(1),
  timezone: z.string().min(1),
  /** The ONE goal this brief is actually about, when one exists — omitted for a goal-anchor-nudge
   * style brief (opted in but no active goals at all yet). */
  goal: z
    .object({
      id: z.string(),
      title: z.string(),
      category: z.string(),
      why: z.string().optional()
    })
    .optional(),
  /** Every OTHER active goal's title — used only for leak-prevention validation (a goal-scoped
   * preference or a goal-specific line must never reference a different goal). */
  otherActiveGoalTitles: z.array(z.string()).default([]),
  preference: z
    .object({
      style: ProactiveBriefStyleSchema,
      briefType: ProactiveBriefTypeSchema,
      contentRequest: z.string()
    })
    .optional(),
  openActionTitles: z.array(z.string()).default([]),
  overdueActionLines: z.array(z.string()).default([]),
  recentWins: z.array(z.string()).default([]),
  /** fix/private-alpha-live-action-and-coaching-regressions: durable "goal_context" memory
   * summaries (e.g. "resume and web CV are already up to date — do not suggest updating them") —
   * the exact same memory type/mechanism planner.ts's own "Durable goal-setup constraints"
   * instruction already saves for the chat path. A live incident found the morning brief LLM
   * contradicting this within a day of it being stated, because this context previously carried
   * NO memories at all (buildMorningBrief's own deterministic path only ever reads today's
   * risk_pattern memories, never goal_context). Capped the same way planner.ts caps
   * recentMemorySummaries, to keep the prompt small. */
  durableFacts: z.array(z.string()).default([]),
  /** Already redacted/summarized lines from describeGmailSignalsForBrief — never raw email
   * subject/body/sender beyond what that function already extracts safely. */
  gmailSignalLines: z.array(z.string()).default([]),
  riskNote: z.string().optional(),
  /** The real, already-computed, safe deterministic message — both the ultimate fallback AND the
   * grounding anchor validation checks against (e.g. "did the LLM invent a goal not named here or
   * in `goal`/`otherActiveGoalTitles`"). */
  deterministicFallbackMessage: z.string().min(1),
  userOperatingProfile: z
    .object({
      directness: z.number(),
      warmth: z.number(),
      preferredStyle: z.string()
    })
    .optional()
});
export type ProactiveBriefContext = z.infer<typeof ProactiveBriefContextSchema>;

export const ProactiveBriefResponseSchema = z.object({
  message: z.string().trim().min(1).max(900)
});
export type ProactiveBriefResponse = z.infer<typeof ProactiveBriefResponseSchema>;

export type ProactiveBriefValidationFailureCode =
  | "invalid_json"
  | "schema_missing_field"
  | "schema_invalid"
  | "too_long"
  | "empty"
  | "goal_leak"
  | "fabricated_progress_claim"
  | "fake_quote_attribution"
  | "long_quoted_span"
  | "silent_mutation_language"
  | "meta_disclosure"
  | "contradicts_durable_fact";

/**
 * fix/private-alpha-live-action-and-coaching-regressions: a real tester was told "resume already
 * up to date" once (saved as a durable "goal_context" memory per planner.ts's own instruction),
 * then had the morning brief suggest updating it anyway a day later. This exact contradiction was
 * already fixed once for goal.recommend_next_action (apps/api/src/agent-runtime/executor.ts) with
 * both a prompt instruction AND this deterministic regex backstop — "prompt guidance alone was not
 * reliable enough here on its own" per that fix's own comment. Shared here (not duplicated) so
 * executor.ts and this module can never drift on what counts as "already up to date" vs. "a
 * suggestion to update it." Deliberately scoped to resume/CV/portfolio specifically, the real
 * reported instances — not a generic "any stated fact" contradiction detector.
 */
export const RESUME_UP_TO_DATE_RE =
  /\b(resume|cv|web cv|portfolio)\b[\s\S]{0,50}\b(already )?(up.?to.?date|current|updated)\b|\b(already )?(up.?to.?date|current|updated)\b[\s\S]{0,50}\b(resume|cv|web cv|portfolio)\b/i;
// fix/private-alpha-live-action-and-coaching-regressions: the original verb list here only ever
// matched the bare infinitive ("update"), never a real inflection ("updating", "updated") — a live
// incident's own transcript said "updating your resume," which this regex silently let through.
// Each verb now allows an optional -e/-ing/-ed/-es suffix.
export const RESUME_UPDATE_SUGGESTION_RE =
  /\b(updat|customiz|improv|tailor|revis|polish|refresh|prepar)(e|es|ed|ing|s)?\b[\s\S]{0,25}\b(resume|cv|web cv|portfolio)\b|\b(resume|cv|web cv|portfolio)\b[\s\S]{0,25}\b(updat|customiz|improv|tailor|revis|polish|refresh|prepar)(e|es|ed|ing|s)?\b/i;

export class ProactiveBriefValidationError extends Error {
  constructor(
    public readonly failureCodes: ProactiveBriefValidationFailureCode[],
    message = "Proactive brief response failed validation."
  ) {
    super(message);
  }
}

/**
 * The safe, always-available fallback — literally the deterministic message
 * decideProactiveOperatorMessage already computed. Never re-derived here: re-deriving it would
 * risk drifting from the one buildMorningBrief/buildEveningCheckin already produced and tested.
 */
export function buildDeterministicProactiveBriefResponse(context: ProactiveBriefContext): ProactiveBriefResponse {
  return ProactiveBriefResponseSchema.parse({ message: context.deterministicFallbackMessage });
}

/**
 * A small, deliberately non-exhaustive denylist of names commonly attached to fabricated
 * "inspirational quote" attributions — Task 5's own explicit example. Not a claim that quoting
 * these people is inherently wrong; a real Alecto has no way to verify a generated line was
 * actually said by any of them, so ANY such name appearing is treated as a fabricated attribution
 * and rejected outright, per Task 5's own recommendation to use original, unattributed lines
 * unless a real approved-quote list is implemented (it is not, yet).
 */
const FABRICATED_ATTRIBUTION_NAMES = [
  "nietzsche",
  "marcus aurelius",
  "viktor frankl",
  "seneca",
  "aristotle",
  "socrates",
  "confucius",
  "rumi",
  "buddha",
  "einstein",
  "gandhi",
  "emerson",
  "thoreau",
  "epictetus"
];

export function validateProactiveBriefResponseAgainstContext(
  response: unknown,
  context: ProactiveBriefContext
): ProactiveBriefResponse {
  const failureCodes: ProactiveBriefValidationFailureCode[] = [];
  const schemaResult = ProactiveBriefResponseSchema.safeParse(response);

  if (!schemaResult.success) {
    const isMissingField = typeof response === "object" && response !== null && !("message" in response);
    throw new ProactiveBriefValidationError([isMissingField ? "schema_missing_field" : "schema_invalid"]);
  }

  const parsed = schemaResult.data;
  const text = parsed.message;
  const lower = text.toLowerCase();

  if (text.length > 900) {
    failureCodes.push("too_long");
  }

  for (const otherTitle of context.otherActiveGoalTitles) {
    if (otherTitle.trim().length > 3 && lower.includes(otherTitle.toLowerCase())) {
      failureCodes.push("goal_leak");
    }
  }

  if (claimsFabricatedProgress(lower, context)) {
    failureCodes.push("fabricated_progress_claim");
  }

  if (context.durableFacts.some((fact) => RESUME_UP_TO_DATE_RE.test(fact)) && RESUME_UPDATE_SUGGESTION_RE.test(text)) {
    failureCodes.push("contradicts_durable_fact");
  }

  if (FABRICATED_ATTRIBUTION_NAMES.some((name) => lower.includes(name))) {
    failureCodes.push("fake_quote_attribution");
  }

  if (hasAttributionPattern(text)) {
    failureCodes.push("fake_quote_attribution");
  }

  if (hasLongQuotedSpan(text)) {
    failureCodes.push("long_quoted_span");
  }

  if (/\bi('| ha)ve (created|logged|added|scheduled|updated|deleted|archived|marked)\b/i.test(text)) {
    failureCodes.push("silent_mutation_language");
  }

  if (/\bas an ai\b|\blanguage model\b|\bi cannot\b|\bi'm unable to\b/i.test(lower)) {
    failureCodes.push("meta_disclosure");
  }

  if (failureCodes.length > 0) {
    throw new ProactiveBriefValidationError(Array.from(new Set(failureCodes)));
  }

  return parsed;
}

function claimsFabricatedProgress(lowerText: string, context: ProactiveBriefContext): boolean {
  const countWord = "(?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten)";
  const pattern = new RegExp(`\\b(?:sent|submitted|completed|finished|applied to|logged)\\s+${countWord}\\b`, "i");

  if (!pattern.test(lowerText)) {
    return false;
  }

  const knownWinsText = context.recentWins.join(" ").toLowerCase();
  return !pattern.test(knownWinsText);
}

/** A quote (single or double, curly or straight) immediately followed by an em/en dash or hyphen
 * and a capitalized name-shaped token — the classic fabricated-attribution shape:
 * "Some inspiring line." — Marcus Aurelius */
function hasAttributionPattern(text: string): boolean {
  return /["'‘’“”][^"'‘’“”]{3,}["'‘’“”]\s*[-—–]\s*[A-Z][\p{L}.]+(?:\s+[A-Z][\p{L}.]+){0,3}/u.test(text);
}

/** A quoted span longer than ~25 words risks reproducing a real, possibly copyrighted quote
 * verbatim — rejected regardless of attribution, per Task 5's "no long copyrighted quote" rule. */
function hasLongQuotedSpan(text: string): boolean {
  const matches = text.match(/["'‘’“”]([^"'‘’“”]{1,})["'‘’“”]/gu);

  if (!matches) {
    return false;
  }

  return matches.some((match) => match.split(/\s+/).filter(Boolean).length > 25);
}
