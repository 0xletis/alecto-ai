import type { Goal } from "./goals.js";

/**
 * fix/private-alpha-gmail-account-switch-and-personalized-examples (Part B): a real reported gap —
 * Alecto suggested the same generic "40 min gym, 2 CVs"-shaped example for ANY active goal,
 * including ones with nothing to do with a gym or a job search. Deterministic (never LLM-invented)
 * category buckets, matched from a goal's OWN templateId/category/title — never a metric or number
 * the goal didn't actually declare — so the suggested phrase is always at least plausible for what
 * the goal is really about.
 */
export type ProgressExampleCategory = "job_search" | "fitness" | "life_meaning" | "finance_admin" | "travel";

const PROGRESS_EXAMPLES: Record<ProgressExampleCategory, string[]> = {
  job_search: ["sent 2 CVs", "got 1 recruiter reply", "scheduled 1 interview", "got 1 rejection"],
  fitness: ["45 min gym", "8k steps", "slept 7h"],
  life_meaning: ["journaled 10 minutes", "had one meaningful conversation", "did one mindful activity"],
  finance_admin: ["paid one bill", "reviewed one invoice", "called insurance"],
  travel: ["checked flight update", "confirmed hotel booking"]
};

const CATEGORY_LABEL: Record<ProgressExampleCategory, string> = {
  job_search: "job-search",
  fitness: "fitness",
  life_meaning: "meaning",
  finance_admin: "finance",
  travel: "travel"
};

const JOB_SEARCH_TITLE_RE = /\b(job|jobs|career|cv|cvs|resume|r[eé]sum[eé]|recruiter|interview|application)\b/i;
const FITNESS_TITLE_RE = /\b(gym|workout|fitness|run|running|steps|exercise|training|sleep)\b/i;
const LIFE_MEANING_TITLE_RE = /\b(journal\w*|meaning\w*|mindful\w*|meditat\w*|reflect\w*|gratitude|purpose\w*|connection\w*)\b/i;
const FINANCE_ADMIN_TITLE_RE = /\b(bill|bills|invoice|invoices|insurance|admin|tax|taxes|paperwork)\b/i;
const TRAVEL_TITLE_RE = /\b(travel|trip|flight|hotel|vacation|itinerary)\b/i;

/**
 * Deterministic goal -> example-category classification. Reuses the same style as
 * gmail-autonomy.ts's goal-relevance matching (templateId/category first, then a keyword fallback
 * on the goal's own title) rather than re-deriving a new heuristic from scratch, since goal
 * categories are free text (not a fixed enum — see goal.create_propose) and most real goals never
 * use one of the small set of built-in templateIds.
 */
export function progressExampleCategoryForGoal(goal: Goal): ProgressExampleCategory | undefined {
  const templateId = goal.templateId ?? "";
  const category = goal.category.toLowerCase();
  const title = goal.title;

  if (templateId === "career.job_search" || category.includes("career") || JOB_SEARCH_TITLE_RE.test(title)) {
    return "job_search";
  }

  if (templateId === "health.strength_energy" || templateId === "health.sleep_better" || category.includes("health") || FITNESS_TITLE_RE.test(title)) {
    return "fitness";
  }

  if (templateId === "social.social_connection" || category.includes("social") || LIFE_MEANING_TITLE_RE.test(title)) {
    return "life_meaning";
  }

  // Deliberately excludes finance.control_betting_trading — that template is about gambling/
  // trading impulse control, a different concept from bills/admin, and already has its own
  // dedicated "Risk: gambling/trading impulse..." example (reminders.ts) that this must not
  // collide with.
  if (templateId !== "finance.control_betting_trading" && (category.includes("admin") || FINANCE_ADMIN_TITLE_RE.test(title))) {
    return "finance_admin";
  }

  if (category.includes("travel") || TRAVEL_TITLE_RE.test(title)) {
    return "travel";
  }

  return undefined;
}

/** Exact live-UX wording: `Examples for your job-search goal: 'sent 2 CVs', 'got 1 recruiter reply', 'scheduled 1 interview'.` */
export function progressExamplesLineForGoal(goal: Goal): string | undefined {
  const category = progressExampleCategoryForGoal(goal);
  if (!category) {
    return undefined;
  }
  const examples = PROGRESS_EXAMPLES[category]
    .slice(0, 3)
    .map((example) => `'${example}'`)
    .join(", ");
  return `Examples for your ${CATEGORY_LABEL[category]} goal: ${examples}.`;
}

/** One example phrase for a single goal — e.g. for inline use in a sentence rather than its own line. */
export function progressExamplePhraseForGoal(goal: Goal): string | undefined {
  const category = progressExampleCategoryForGoal(goal);
  return category ? PROGRESS_EXAMPLES[category][0] : undefined;
}

/**
 * One examples line per distinct matched category across the given goals (never repeating the
 * same category twice for two goals that both classify the same way), or the honest no-goal
 * fallback when nothing matches (including a genuinely empty goals list).
 */
export function progressExamplesForGoals(goals: Goal[]): string {
  const seen = new Set<ProgressExampleCategory>();
  const lines: string[] = [];

  for (const goal of goals) {
    const category = progressExampleCategoryForGoal(goal);
    if (!category || seen.has(category)) {
      continue;
    }
    seen.add(category);
    const line = progressExamplesLineForGoal(goal);
    if (line) {
      lines.push(line);
    }
  }

  if (lines.length === 0) {
    return "Tell me what you did, and I'll help log it against the right goal.";
  }

  return lines.join("\n");
}
