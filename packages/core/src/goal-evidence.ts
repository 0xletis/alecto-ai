import type { Goal, GoalMetric } from "./goals.js";

/**
 * Generic Goal Evidence Loop MVP — the goal↔evidence linking primitive, extracted out of the
 * ad-hoc duplicated filters that already existed in apps/api/src/operator/proactive.ts's
 * buildEveningCheckin (targetMetrics matching) and packages/core/src/goal-linking.ts
 * (inferGoalLinkForAction, keyword-based action↔goal linking). Neither of those is job-search
 * specific, and neither is this: a Goal's own targetMetrics[].eventType is the ALREADY-GENERIC
 * declaration of "these event types count as evidence toward this goal" — set once when the goal
 * is created (from a template or manually), reused everywhere a goal needs to reason about real
 * evidence for ANY category (career, health, learning, finance, custom, ...), never hardcoded to
 * one domain here.
 *
 * Core concept (product decision): Goal + Evidence + Source + Confidence + Suggested Mutation.
 * - Goal: an existing, active Goal row — no new schema.
 * - Evidence: a real StoredEvent (existing event-registry.ts type) or an ActionItem — no new
 *   schema; "evidence" is not a new table, it's a lens on data that already exists.
 * - Source: existing StoredEvent.source ("manual" | "gmail" | ...) / ActionItem.source
 *   ("manual" | "email_review" | "system") — already tracked, already generic.
 * - Confidence: existing StoredEvent.confidence / EmailReviewItem.confidence /
 *   goal-linking.ts's inferGoalLinkForAction confidence score — already tracked, already generic.
 * - Suggested Mutation: which existing, narrow, deterministic tool the evidence should route
 *   through (event log, action create) — decided by the planner/executor, never invented raw DB
 *   writes by an LLM.
 *
 * Job search is the first concrete goal category exercised against this — see
 * tests/agent-runtime-goal-evidence.test.ts for the acceptance suite (job-search examples plus
 * one deliberately non-job example, an admin/bills goal, proving nothing here is job-search-
 * specific). docs/10-v3-readiness-audit.md documents this as the "Goal Evidence Loop MVP."
 */

/** Active goals that declare `eventType` as one of their own targetMetrics — i.e. goals this
 * event type is real, declared evidence for. Works for any domain: a "career.application_sent"
 * event matches a job-search goal exactly the same way a "health.workout_completed" event
 * matches a training goal, because both goals declare the link themselves via their own
 * targetMetrics, set at goal-creation time (from a template or manually) — nothing here reads or
 * branches on what the goal or event is ABOUT. */
export function findGoalsForEventType<T extends Pick<Goal, "status" | "targetMetrics">>(goals: T[], eventType: string): T[] {
  return goals.filter((goal) => goal.status === "active" && (goal.targetMetrics ?? []).some((metric) => metric.eventType === eventType));
}

/** A short, generic reply suffix naming the one matched goal ("this counts toward your \"X\"
 * goal."), or nothing when no goal declares this event type as evidence — never invents a
 * connection the goal itself didn't declare. When more than one active goal happens to share the
 * same eventType, names only the first (goal titles are meant to be specific enough that this is
 * rare; picking one over silently naming all of them keeps the reply short, per the product's
 * "keep it short" rule for proactive/status text). */
export function describeGoalEvidenceMatch(matchedGoals: Pick<Goal, "title">[]): string | undefined {
  if (matchedGoals.length === 0) {
    return undefined;
  }

  return `This counts toward your "${matchedGoals[0].title}" goal.`;
}

/**
 * Adaptive Goal Creation MVP (docs/10-v3-readiness-audit.md §21): the event type ANY custom,
 * per-goal signal is stored under — deliberately the SAME generic catch-all
 * event.log_custom_progress already wrote to, never a new EventType. The real per-signal
 * discriminator lives in `data.signalKey`, not `type`, since many different custom goals (tea,
 * calling family, screen time, ...) all share this one type.
 */
export const CUSTOM_SIGNAL_EVENT_TYPE = "custom.goal_progress_logged";

/** Active goals that declare `signalKey` as one of their own targetMetrics — the custom-signal
 * counterpart to findGoalsForEventType above, for goals with no registered EventType behind them
 * at all (e.g. "tea_cups_drunk" for a "drink more tea" goal). Same shape, same guarantee: only
 * ever matches a signal the goal itself declared at creation time, never inferred here. */
export function findGoalsForSignalKey<T extends Pick<Goal, "status" | "targetMetrics">>(goals: T[], signalKey: string): T[] {
  return goals.filter((goal) => goal.status === "active" && (goal.targetMetrics ?? []).some((metric) => metric.signalKey === signalKey));
}

interface EvidenceEventLike {
  type: string;
  data?: Record<string, unknown>;
}

/**
 * How many of the given events count as evidence for ONE metric — registry-backed
 * (metric.eventType) or custom (metric.signalKey), whichever the metric actually declares. A
 * metric with neither never matches anything (never guesses). This is the one place that needs
 * to know both metric shapes exist; every caller (goal.status, morning brief, future callers)
 * just asks "how much evidence for this metric" without caring which kind it is.
 */
export function countEvidenceForMetric(metric: Pick<GoalMetric, "eventType" | "signalKey">, events: EvidenceEventLike[]): number {
  if (metric.eventType) {
    return events.filter((event) => event.type === metric.eventType).length;
  }

  if (metric.signalKey) {
    return events.filter((event) => event.type === CUSTOM_SIGNAL_EVENT_TYPE && event.data?.signalKey === metric.signalKey).length;
  }

  return 0;
}

/**
 * Goal Reference Fix pass, round 2 (a real Telegram smoke test): a goal proposed/created with
 * only a completion-style signal ("Meditations finished") gives the user nothing to log or see
 * until the very end, and — worse — if the user later reports real partial progress ("I read 30
 * minutes today"), there is no compatible declared signal to log it against at all, so either the
 * evidence is silently dropped or a confident-sounding reply overclaims. These two generic,
 * text-shape heuristics (never a specific book/goal title) classify a signal's key+label as
 * "progress-shaped" (an ongoing, repeatable unit — minutes, pages, sessions, reps, calls, ...) or
 * "completion-shaped" (a one-time done/finished marker) — used both when PROPOSING a new
 * book/reading goal (ensureBookGoalProgressSignal below) and when LOGGING evidence against an
 * EXISTING goal that turns out to only have a completion signal (see executor.ts's
 * goal.log_evidence). Deliberately permissive/best-effort, matching this module's existing
 * "never invents evidence, but a missed classification degrades to asking rather than a false
 * block" philosophy — these decide what to OFFER or PROPOSE, never what to write to the DB; every
 * actual mutation still goes through the existing find*For* verification above.
 */
// Deliberately does NOT include "reading" on its own — it appears just as often in a
// COMPLETION-shaped label ("finished reading the book") as a progress one, so it isn't a reliable
// signal either way; the actually-quantitative units below (minutes, pages, sessions, ...) are.
const PROGRESS_SIGNAL_TEXT_PATTERN = /\b(minutes?|mins?|hours?|pages?|chapters?|sessions?|reps?|sets?|cups?|calls?|steps?|miles?|applications?)\b/i;
const COMPLETION_SIGNAL_TEXT_PATTERN = /\b(finish(ed)?|complete(d)?|done)\b/i;

/** snake_case/kebab-case keys ("reading_minutes," "book-finished") have no real \b word boundary
 * at an underscore/hyphen — both are \w characters as far as regex is concerned — so a bare key
 * checked on its own (not paired with a human label that already has real spaces) needs those
 * separators normalized to spaces first, or "reading_minutes" would match neither pattern at all. */
function normalizeSignalText(text: string): string {
  return text.replace(/[_-]+/g, " ");
}

export function isProgressShapedSignalText(text: string): boolean {
  const normalized = normalizeSignalText(text);
  return PROGRESS_SIGNAL_TEXT_PATTERN.test(normalized) && !COMPLETION_SIGNAL_TEXT_PATTERN.test(normalized);
}

export function isCompletionShapedSignalText(text: string): boolean {
  return COMPLETION_SIGNAL_TEXT_PATTERN.test(normalizeSignalText(text));
}

/** Generic "does this goal look like a book/reading goal" check — title or category only, never a
 * specific book title. Used only to decide whether to apply the book-goal signal defaults below;
 * a goal that happens to also mention "book"/"reading" for an unrelated reason gets, at worst, an
 * unused extra signal offered — never a wrong mutation, since nothing here writes to the DB. */
export function looksLikeBookOrReadingGoal(goal: Pick<Goal, "title" | "category">): boolean {
  return /\b(book|books|reading|read|novel|chapter|chapters)\b/i.test(`${goal.title} ${goal.category}`);
}

interface ProposedSignal {
  key: string;
  label: string;
  labelSingular?: string;
  unit?: string;
  cadence?: "daily" | "weekly";
}

/**
 * If a proposed book/reading goal's signals are completion-only (no progress-shaped signal at
 * all), prepends a generic "reading minutes" progress signal — deterministic, not left to the
 * LLM's own discretion, since prompt guidance alone did not reliably produce one in practice.
 * A no-op for any goal that isn't book/reading-shaped, already has a progress signal, or has no
 * signals yet at all (goal.create_propose's own "at least one signal" check handles that case).
 */
export function ensureBookGoalProgressSignal<T extends Pick<Goal, "title" | "category"> & { signals: ProposedSignal[] }>(
  input: T
): ProposedSignal[] {
  if (!looksLikeBookOrReadingGoal(input) || input.signals.length === 0) {
    return input.signals;
  }

  // Classified off the LABEL alone, never the key — a key derived from the goal's own title (as
  // the one this function injects below is) will often legitimately contain a completion word
  // like "finish" (from "Finish reading X"), which must not make the signal look completion-
  // shaped when its actual label ("reading minutes") plainly says otherwise.
  const hasProgressSignal = input.signals.some((signal) => isProgressShapedSignalText(signal.label));
  if (hasProgressSignal) {
    return input.signals;
  }

  const isCompletionOnly = input.signals.every((signal) => isCompletionShapedSignalText(signal.label));
  if (!isCompletionOnly) {
    return input.signals;
  }

  // The key is derived from the goal's own title, not a fixed "reading_minutes" constant — a
  // shared literal key across different book goals (e.g. two separate "finish book X"/"finish
  // book Y" goals) would make findGoalsForSignalKey's exact-key lookup match the WRONG goal
  // whenever a user's message doesn't specify one, exactly the kind of cross-goal mixup this
  // whole pass exists to prevent. Always ends in "_reading_minutes" so callers/tests can still
  // recognize it generically without needing the exact per-goal prefix.
  return [
    { key: `${slugifyForSignalKey(input.title)}_reading_minutes`, label: "reading minutes", labelSingular: "reading minute", unit: "minutes", cadence: "daily" },
    ...input.signals
  ];
}

function slugifyForSignalKey(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 24);
  return slug || "book";
}

/** The first declared metric on a goal that looks progress-shaped (by its own LABEL — never the
 * key, which may be a title-derived slug that legitimately contains an unrelated completion word,
 * e.g. "finish_reading_x_reading_minutes" for a goal titled "Finish reading X") — used to remap a
 * signalKey the LLM guessed to the goal's REAL declared key when they don't literally match but
 * both plainly mean "ongoing progress," e.g. a guessed "reading_minutes" against a goal that
 * actually declared "pages_read_daily" / "pages read." Never crosses goals: only ever looks at the
 * ONE goal already resolved (by goalRef or conversation focus) for this log attempt. */
export function findCompatibleProgressMetric<T extends Pick<Goal, "targetMetrics">>(goal: T): GoalMetric | undefined {
  return (goal.targetMetrics ?? []).find((metric) => isProgressShapedSignalText(metric.label));
}

/** True only when a goal has at least one declared signal and EVERY one of them is
 * completion-shaped by its own LABEL — i.e. there is genuinely no progress signal to log partial
 * evidence against. */
export function goalHasOnlyCompletionSignals<T extends Pick<Goal, "targetMetrics">>(goal: T): boolean {
  const metrics = goal.targetMetrics ?? [];
  return metrics.length > 0 && metrics.every((metric) => isCompletionShapedSignalText(metric.label));
}
