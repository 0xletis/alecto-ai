import type { Goal } from "./goals.js";

/**
 * Generic goal-REFERENCE resolution — "which of the user's real active goals did they mean by
 * this text" — deliberately separate from goal-linking.ts's inferGoalLinkForAction, which
 * answers a different question ("does this ACTION belong to any goal's general domain") and was
 * never meant for this one. Reusing it here was the actual bug: a real Telegram smoke test asked
 * "show tracking for reading niezsche book" with two active goals — "Read more" (category
 * "learning") and "Finish reading Nietzsche book" — and inferGoalLinkForAction's coarse
 * category-bucket scoring (any "reading"-flavored text matches ANY "learning"-category goal at
 * confidence 0.9) beat the specific title-word match to the actually-named goal (0.85, and even
 * that was blocked outright by the "niezsche" typo, since inferGoalLinkForAction only does exact
 * substring matching, no fuzzy tolerance). A generic, less-relevant match beat a specific,
 * exactly-relevant one — backwards from what a reference resolver needs.
 *
 * Priority order here, highest first — a later tier is only even consulted if nothing in an
 * earlier tier matched anything:
 * 1. Near-exact title match (the reference basically IS the goal's title).
 * 2. A DISTINCTIVE token in the reference (long, specific, not a generic goal-phrasing word like
 *    "book"/"reading"/"goal") fuzzy-matches a word in the goal's title — typo-tolerant via edit
 *    distance, so "niezsche"/"nitzche"/"nietsche" all still resolve to a goal titled with
 *    "Nietzsche", generically (any rare/long word gets the same tolerance, not just this one).
 * 3. Generic exact keyword overlap between the reference and the title.
 * 4. Category-level match — the SAME kind of coarse signal inferGoalLinkForAction uses, but kept
 *    as the LOWEST priority here specifically because it's what caused the bug when treated as
 *    equal to (or higher than) a specific match.
 *
 * When two or more goals land within a small margin of the top score, the result is "ambiguous"
 * (candidates listed) rather than silently picking one — callers use this to ask a clarifying
 * question instead of guessing.
 */

const GENERIC_GOAL_WORDS = new Set([
  "goal",
  "goals",
  "more",
  "book",
  "books",
  "read",
  "reading",
  "finish",
  "finishing",
  "complete",
  "completing",
  "track",
  "tracking",
  "start",
  "starting",
  "help",
  "with",
  "about",
  "week",
  "weekly",
  "daily",
  "month",
  "monthly",
  "time",
  "minutes",
  "hours",
  "progress",
  "status",
  "going",
  "doing",
  "that",
  "this",
  "the"
]);

function normalizeGoalText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isDistinctiveWord(word: string): boolean {
  return word.length >= 6 && !GENERIC_GOAL_WORDS.has(word);
}

/** Plain Levenshtein edit distance — no dependency, small inputs (single words) only. */
function levenshteinDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const distances: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));

  for (let i = 0; i < rows; i++) distances[i][0] = i;
  for (let j = 0; j < cols; j++) distances[0][j] = j;

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      distances[i][j] = Math.min(distances[i - 1][j] + 1, distances[i][j - 1] + 1, distances[i - 1][j - 1] + cost);
    }
  }

  return distances[rows - 1][cols - 1];
}

/** Typo-tolerant word match, generic for any word — threshold scales with length so short words
 * still need to be close while long/distinctive words (like a proper noun) tolerate 1-2 edits. */
function fuzzyWordMatches(a: string, b: string): boolean {
  if (a === b) return true;
  const threshold = Math.max(1, Math.floor(Math.max(a.length, b.length) * 0.3));
  return levenshteinDistance(a, b) <= threshold;
}

/** Common first-person pronoun-style references ("it", "that goal", "this one") that name
 * nothing textually — callers treat these the same as no reference at all (fall back to
 * recency), rather than trying to text-match "it" against real goal titles. */
export function isPronounGoalReference(goalRef: string): boolean {
  const normalized = normalizeGoalText(goalRef);
  return ["it", "that", "this", "that goal", "this goal", "that one", "this one", "the new one", "the one i just made", "the one i just created"].includes(normalized);
}

export type ActiveGoalReferenceStatus = "matched" | "ambiguous" | "no_match";

export interface ActiveGoalReferenceResolution<T extends Goal = Goal> {
  status: ActiveGoalReferenceStatus;
  goal?: T;
  /** Populated when status is "ambiguous" — every goal within the ambiguity margin of the top score, best first. */
  candidates?: T[];
}

/**
 * Resolves free text (as the user phrased it) against a list of active goals. `mostRecent`,
 * when given, is used whenever `goalRef` is absent/empty/a bare pronoun — Goal rows are already
 * fetched newest-first (packages/db's getActiveGoals), so passing `activeGoals[0]` there is
 * normally all a caller needs for "show tracking for it" right after creating a goal.
 */
export function resolveActiveGoalReference<T extends Goal = Goal>(
  goalRef: string | undefined,
  activeGoals: T[],
  options: { mostRecent?: T } = {}
): ActiveGoalReferenceResolution<T> {
  const goals = activeGoals.filter((goal) => goal.status === "active");

  if (goals.length === 0) {
    return { status: "no_match" };
  }

  if (!goalRef || !goalRef.trim() || isPronounGoalReference(goalRef)) {
    return options.mostRecent ? { status: "matched", goal: options.mostRecent } : { status: "no_match" };
  }

  const normalizedRef = normalizeGoalText(goalRef);
  const refWords = normalizedRef.split(" ").filter(Boolean);

  const scored = goals
    .map((goal) => {
      const title = normalizeGoalText(goal.title);
      const category = normalizeGoalText(goal.category);
      const titleWords = title.split(" ").filter(Boolean);
      let score = 0;
      let reason = "no match";

      if (title === normalizedRef || (normalizedRef.length > 3 && (title.includes(normalizedRef) || normalizedRef.includes(title)))) {
        score = 100;
        reason = "near-exact title match";
      }

      const distinctiveRefWords = refWords.filter(isDistinctiveWord);
      const distinctiveMatches = distinctiveRefWords.filter((refWord) => titleWords.some((titleWord) => fuzzyWordMatches(refWord, titleWord)));
      if (distinctiveMatches.length > 0) {
        const distinctiveScore = 80 + distinctiveMatches.length * 5;
        if (distinctiveScore > score) {
          score = distinctiveScore;
          reason = `distinctive token match: ${distinctiveMatches.join(", ")}`;
        }
      }

      const genericMatches = refWords.filter((word) => word.length >= 4 && !isDistinctiveWord(word) && titleWords.includes(word));
      if (genericMatches.length > 0) {
        const genericScore = 40 + genericMatches.length * 5;
        if (genericScore > score) {
          score = genericScore;
          reason = "generic keyword overlap";
        }
      }

      if (score === 0 && category && refWords.some((word) => word.length >= 4 && category.includes(word))) {
        score = 20;
        reason = "category match";
      }

      if (options.mostRecent?.id === goal.id) {
        score += 1;
      }

      return { goal, score, reason };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return { status: "no_match" };
  }

  const AMBIGUITY_MARGIN = 10;
  const top = scored[0];
  const withinMargin = scored.filter((entry) => entry.score >= top.score - AMBIGUITY_MARGIN);

  if (withinMargin.length > 1) {
    return { status: "ambiguous", candidates: withinMargin.map((entry) => entry.goal) };
  }

  return { status: "matched", goal: top.goal };
}
