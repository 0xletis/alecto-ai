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
