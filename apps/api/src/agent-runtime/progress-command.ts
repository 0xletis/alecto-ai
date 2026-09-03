import { randomUUID } from "node:crypto";
import {
  completeActionItem,
  createEvent,
  createExternalEventIfNotExists,
  getEventsSince,
  type ActionItem
} from "@operator-agent/db";
import {
  countEvidenceForMetric,
  resolveGoalMetricForCanonicalEvent,
  type CanonicalEventMetricBridge,
  type EventTypeId,
  type Goal,
  type GoalMetric,
  type StoredEvent
} from "@operator-agent/core";
import { EMAIL_KINDS, type EmailKind } from "@operator-agent/llm";
import { formatDateInTimezone } from "../utils/datetime.js";

/**
 * refactor/private-alpha-canonical-progress-command-engine: the ONE canonical write/verify path for
 * every route that can turn a user's words into real logged progress — a manual statement ("I sent
 * 1 CV today"), an email review ("mark it as cv sent"), or (in the future) any other activity kind
 * registered below. Before this module existed, `gmail.review.log_progress` and
 * `event.log_job_applications` each independently wrote events, resolved metrics, and composed
 * "Logged ..." replies — two implementations that LOOKED equivalent but had already drifted (see
 * the live "Logged 1 CV sent" / goal.status-shows-Application-to-Interview report this branch
 * fixes: the metric-bridge keyword match was too loose and picked the wrong signalKey metric on a
 * goal that had BOTH an "Applications sent" and an "Application to Interview" signal). Every
 * progress-writing caller now goes through `executeProgressCommand`, gets back one of exactly four
 * typed outcomes, and is FORBIDDEN from composing its own "Logged ..." copy unless the outcome is
 * `status: "logged"` — see each call site in executor.ts.
 *
 * Deliberately not over-generalized yet (per this task's own instruction): only one activity kind,
 * `application_sent`, is registered in PROGRESS_ACTIVITIES below. Adding a second (e.g. a future
 * `workout_completed`) means adding one more entry to that map — canonicalEventType, the
 * label-matching bridge (with an explicit excludeLabelKeywords set, learned from the bug above),
 * and eligibility rules if the activity can ever be sourced from an email review — the engine
 * itself (dedupe, verification, reconciliation, diagnostics) needs no changes.
 */

export type ProgressActivityKind = "application_sent";

export type ProgressCommandSource = "manual" | "gmail_review";

export interface ProgressCommandInput {
  userId: string;
  activityKind: ProgressActivityKind;
  quantity: number;
  occurredAt: Date;
  /** "Now," for the 7-day verification window and "is this today" — a SEPARATE field from
   * occurredAt because occurredAt can be legitimately backdated (an applied-date the email itself
   * states, or an explicit past date the user names), and the window/today comparisons must always
   * anchor to the real current moment, never to the (possibly past) event date itself. Callers pass
   * their own resolveAgentRuntimeNow()-equivalent so test-time-override env vars keep working. */
  now: Date;
  timezone: string;
  source: ProgressCommandSource;
  /** Every active goal that could plausibly own this activity — for `source: "manual"` this is
   * every active goal; for `source: "gmail_review"` this is normally just the review's own linked
   * goal (an empty array is valid — the write still happens against the canonical event type, just
   * with nothing to verify a goal-specific metric against). */
  targetGoals: Goal[];
  evidence: string[];
  /** Required when `source` is `"gmail_review"` — the SAME dedupe-safe write path
   * `createExternalEventIfNotExists` uses, keyed off the real underlying Gmail message so two
   * different review rows pointing at the same email (two rules watching one account) still dedupe
   * against each other, not just against repeats of the same review row. */
  externalIdBase?: string;
  /** Diagnostics-only (Task 9) — never used for write/verify logic, just threaded through every
   * structured log line so a live incident can be traced back to the exact review/message. */
  sourceReviewId?: string;
  sourceProviderMessageId?: string;
  /**
   * Only read when `source` is `"gmail_review"` — the eligibility guard. Omitting it for a Gmail
   * review is a programmer error (every gmail_review caller must classify first); passing it for a
   * manual command is harmless (never checked). `undefined`/non-"ok" emailKind falls back to
   * `fallbackReason` (the review's own already-stored classification) rather than going straight to
   * ambiguous — a fresh understanding call can legitimately be unavailable (no network, no LLM mock
   * in a test) while the review's own stored reason is still a real, trustworthy classification set
   * at sync time. Only when NEITHER resolves to a recognizable kind is the outcome truly ambiguous.
   */
  reviewClassification?: {
    emailKind: EmailKind | undefined;
    understandingStatus: "ok" | "needs_clarification" | "unavailable";
    fallbackReason?: string;
    fallbackProposedEventType?: string;
  };
  /** The user explicitly confirmed logging progress from an email this engine would otherwise
   * refuse (task's own example: "yes, count it anyway as a CV sent"). Bypasses the eligibility
   * guard but is always recorded in the diagnostic log and the written event's own evidence, so an
   * override is never silently indistinguishable from a normal eligible log. */
  explicitOverride?: boolean;
  /** Open actions to reconcile against (e.g. "Send 10 CVs") — pass `[]` when reconciliation isn't
   * relevant for this call. */
  openActions: ActionItem[];
}

interface ProgressVerificationMetric {
  goal: Goal;
  metric: GoalMetric;
}

export type ProgressCommandResult =
  | {
      status: "ineligible";
      commandId: string;
      reason: string;
      suggestion: "turn_into_action" | "none";
      emailKind: EmailKind | undefined;
    }
  | {
      status: "duplicate";
      commandId: string;
      events: StoredEvent[];
    }
  | {
      status: "verification_failed";
      commandId: string;
      events: StoredEvent[];
    }
  | {
      status: "logged";
      commandId: string;
      events: StoredEvent[];
      newlyCreatedCount: number;
      goal: Goal | undefined;
      todayCount: number;
      weekCount: number;
      completedAction: ActionItem | undefined;
      reconciliationNote: string;
      overrideUsed: boolean;
    };

/** How the written event's own quantity is displayed — "1 CV" / "3 CVs" — kept here rather than in
 * the goal's own metric label, since the SPOKEN reply ("Logged 1 CV sent") is about the ACTIVITY,
 * while the goal's metric label ("Applications sent") is about the GOAL'S OWN tracking language;
 * they're related but not always identical wording. */
interface ProgressActivityDefinition {
  canonicalEventType: EventTypeId;
  metricBridge: CanonicalEventMetricBridge;
  /** English-only singular/plural noun for the activity itself, used only in diagnostics/fallback
   * text — the user-facing reply always prefers the goal's own metric label when one resolved. */
  noun: { singular: string; plural: string };
  /** Eligibility for `source: "gmail_review"` — every real product-facing exception this task's
   * brief enumerates. Deliberately a closed map over EmailKind (not a heuristic), so a new EmailKind
   * added later fails closed (ambiguous, asks) rather than silently eligible. */
  eligibility: Record<EmailKind, { eligible: boolean; suggestion: "turn_into_action" | "none"; reason?: string }>;
}

const APPLICATION_SENT_INELIGIBLE = (reason: string, suggestion: "turn_into_action" | "none" = "none") => ({
  eligible: false as const,
  suggestion,
  reason
});

const PROGRESS_ACTIVITIES: Record<ProgressActivityKind, ProgressActivityDefinition> = {
  application_sent: {
    canonicalEventType: "career.application_sent",
    noun: { singular: "CV", plural: "CVs" },
    metricBridge: {
      eventType: "career.application_sent",
      // Requires "sent"/"submitted" actually co-occurring with cv/application/resume — a bare
      // "\b(applications?|cvs?)\b" (the pre-fix regex) also matched an unrelated LATER-lifecycle
      // metric like "Application to Interview," which is exactly the live bug this branch fixes.
      labelKeywords: /\b(cvs?|applications?|resumes?)\b[\s\S]{0,15}\b(sent|submitted)\b|\b(sent|submitted)\b[\s\S]{0,15}\b(cvs?|applications?|resumes?)\b/i,
      // Defense in depth even against a label that WOULD otherwise pass labelKeywords (e.g. a
      // hypothetical "applications sent to interview" label) — any later-lifecycle word disqualifies
      // a candidate outright, since "applications sent" is a first-touch signal, never a status change.
      excludeLabelKeywords: /\b(interview|offer|reply|replies|rejection|rejected|recruiter|screen(ing)?|assessment)\b/i
    },
    eligibility: {
      application_confirmation: { eligible: true, suggestion: "none" },
      recruiter_reply: APPLICATION_SENT_INELIGIBLE("This is a recruiter reply, not an application confirmation.", "turn_into_action"),
      application_viewed: APPLICATION_SENT_INELIGIBLE("This is just a status ping saying your application was viewed — nothing new was sent."),
      interview: APPLICATION_SENT_INELIGIBLE("This is about an interview, not a CV being sent.", "turn_into_action"),
      offer: APPLICATION_SENT_INELIGIBLE("This is a job offer, not a CV being sent.", "turn_into_action"),
      rejection: APPLICATION_SENT_INELIGIBLE("This is a rejection, not a CV being sent — I won't log it as progress."),
      job_alert: APPLICATION_SENT_INELIGIBLE("This looks like a job listing/alert, not an application confirmation you sent."),
      security_auth: APPLICATION_SENT_INELIGIBLE("This looks like a security/verification email, not an application confirmation."),
      onboarding: APPLICATION_SENT_INELIGIBLE("This looks like an onboarding/welcome email, not an application confirmation."),
      receipt: APPLICATION_SENT_INELIGIBLE("This doesn't look like a job application at all."),
      invoice: APPLICATION_SENT_INELIGIBLE("This doesn't look like a job application at all."),
      travel_booking: APPLICATION_SENT_INELIGIBLE("This doesn't look like a job application at all."),
      flight_update: APPLICATION_SENT_INELIGIBLE("This doesn't look like a job application at all."),
      insurance: APPLICATION_SENT_INELIGIBLE("This doesn't look like a job application at all."),
      admin_notice: APPLICATION_SENT_INELIGIBLE("This doesn't look like a job application at all."),
      appointment: APPLICATION_SENT_INELIGIBLE("This doesn't look like a job application at all."),
      subscription: APPLICATION_SENT_INELIGIBLE("This doesn't look like a job application at all."),
      personal_message: APPLICATION_SENT_INELIGIBLE("This email is a personal/networking suggestion, not an application confirmation."),
      marketing: APPLICATION_SENT_INELIGIBLE("This looks like a marketing/status email, not an application confirmation."),
      unknown: APPLICATION_SENT_INELIGIBLE("I'm not confident what kind of email this is.")
    }
  }
};

function resolveVerificationMetrics(targetGoals: Goal[], bridge: CanonicalEventMetricBridge): ProgressVerificationMetric[] {
  return targetGoals
    .map((goal) => {
      const metric = resolveGoalMetricForCanonicalEvent(goal, bridge);
      return metric ? { goal, metric } : undefined;
    })
    .filter((entry): entry is ProgressVerificationMetric => Boolean(entry));
}

function countProgress(events: StoredEvent[], canonicalEventType: EventTypeId, verificationMetrics: ProgressVerificationMetric[]): number {
  if (verificationMetrics.length === 0) {
    return events.filter((event) => event.type === canonicalEventType).length;
  }
  return verificationMetrics.reduce((sum, { metric }) => sum + countEvidenceForMetric(metric, events), 0);
}

// A handful of pre-existing review.reason values predate emailReviewClassificationFromUnderstanding
// (or are its own noise-folded output) and don't literally match an EmailKind string — mapped here
// so the FALLBACK path (used when a fresh understanding call is unavailable — no network, or no
// mock in a test) still resolves a real classification instead of going straight to ambiguous.
const REASON_TO_EMAIL_KIND_FALLBACK: Record<string, EmailKind> = {
  job_offer: "offer",
  filtered_marketing: "marketing",
  onboarding_noise: "onboarding"
};

// The SYNC-TIME classifier (classify-email.ts) stores `reason` as EITHER the matched eventType
// string itself (e.g. "career.recruiter_reply_received") or a free-form LLM sentence for a
// needs_review row with no specific eventType — NOT the closed EmailKind vocabulary
// emailReviewClassificationFromUnderstanding produces for an on-demand refresh. `proposedEventType`
// (a real, schema-backed EventTypeSchema member) is the more reliable structured signal when
// present, so it's checked before falling back to treating `reason` as a literal EmailKind string.
const EVENT_TYPE_TO_EMAIL_KIND_FALLBACK: Record<string, EmailKind> = {
  "career.application_confirmation_received": "application_confirmation",
  "career.recruiter_reply_received": "recruiter_reply",
  "career.interview_scheduled": "interview",
  "career.offer_received": "offer",
  "career.rejection_received": "rejection"
};

function resolveEmailKindFromStoredReview(input: { reason?: string; proposedEventType?: string }): EmailKind | undefined {
  if (input.proposedEventType && EVENT_TYPE_TO_EMAIL_KIND_FALLBACK[input.proposedEventType]) {
    return EVENT_TYPE_TO_EMAIL_KIND_FALLBACK[input.proposedEventType];
  }
  const reason = input.reason;
  if (!reason) {
    return undefined;
  }
  if ((EMAIL_KINDS as readonly string[]).includes(reason)) {
    return reason as EmailKind;
  }
  return REASON_TO_EMAIL_KIND_FALLBACK[reason];
}

/**
 * The eligibility guard (Task 3 of this branch) — the ONLY place a Gmail-review-sourced progress
 * command can be refused before anything is written. `explicitOverride` always wins (the user was
 * already warned once and chose to proceed anyway), but is still surfaced to the caller/diagnostics
 * so an override is never silently indistinguishable from a normal, eligible log. Prefers a FRESH,
 * successful understanding call's own emailKind (the most current read of the actual email) but
 * falls back to the review's own already-stored reason when a fresh call is unavailable — only
 * genuinely unrecognizable input (neither resolves to a real EmailKind) is treated as ambiguous.
 */
function checkEligibility(
  activity: ProgressActivityDefinition,
  input: Pick<ProgressCommandInput, "source" | "reviewClassification" | "explicitOverride">
): { eligible: true } | { eligible: false; reason: string; suggestion: "turn_into_action" | "none"; emailKind: EmailKind | undefined } {
  if (input.source !== "gmail_review" || input.explicitOverride) {
    return { eligible: true };
  }

  const classification = input.reviewClassification;
  const emailKind =
    classification?.understandingStatus === "ok" && classification.emailKind
      ? classification.emailKind
      : resolveEmailKindFromStoredReview({ reason: classification?.fallbackReason, proposedEventType: classification?.fallbackProposedEventType });

  if (!emailKind) {
    return {
      eligible: false,
      reason: "I couldn't confidently tell what kind of email this is.",
      suggestion: "none",
      emailKind: classification?.emailKind
    };
  }

  const rule = activity.eligibility[emailKind];
  if (rule.eligible) {
    return { eligible: true };
  }

  return { eligible: false, reason: rule.reason ?? "This email isn't eligible for that kind of progress.", suggestion: rule.suggestion, emailKind };
}

const APPLICATION_ACTION_TARGET_COUNT_RE = /\b(?:send|submit|apply to)\s+(\d+)\s+(?:cvs?|applications?|jobs?)\b/i;

function parseApplicationActionTargetCount(title: string): number | undefined {
  const match = title.match(APPLICATION_ACTION_TARGET_COUNT_RE);
  return match?.[1] ? Number.parseInt(match[1], 10) : undefined;
}

type ReconciliationOutcome = { kind: "complete"; action: ActionItem; note: string } | { kind: "partial" | "ambiguous" | "none"; note: string };

/**
 * fix/private-alpha-gmail-review-llm-instruction-routing addendum (Task 3, carried over verbatim):
 * "I sent 3 CVs today" completing the matching open "Send 3 CVs" action, deterministically. Only
 * ever considers OPEN actions whose title states a real, concrete target count — never a guess for
 * a vague title. A count that meets or exceeds the target auto-completes; a lower count mentions
 * what's left instead; more than one matching open action asks rather than picking one.
 */
function reconcileWithOpenAction(sentCount: number, openActions: ActionItem[]): ReconciliationOutcome {
  const matching = openActions
    .map((action) => ({ action, target: parseApplicationActionTargetCount(action.title) }))
    .filter((entry): entry is { action: ActionItem; target: number } => entry.target !== undefined);

  if (matching.length === 0) {
    return { kind: "none", note: "" };
  }

  if (matching.length > 1) {
    return {
      kind: "ambiguous",
      note: ` You have a few open actions this could complete (${matching.map((entry) => `"${entry.action.title}"`).join(", ")}) — say which one to mark done.`
    };
  }

  const { action, target } = matching[0]!;
  if (sentCount >= target) {
    return { kind: "complete", action, note: ` Marked "${action.title}" done.` };
  }

  return { kind: "partial", note: ` ${target - sentCount} more to go on "${action.title}".` };
}

/**
 * The canonical progress-writing entry point (this branch's central deliverable). Owns: resolving
 * each target goal's own metric for this activity, the eligibility guard (gmail_review source
 * only), dedupe-safe writes (canonical event + a signalKey bridge event per goal whose own metric
 * is signalKey-shaped), action reconciliation, and read-after-write verification using the EXACT
 * same countEvidenceForMetric aggregation goal.status itself uses — never a parallel assumption.
 * Structured diagnostics (Task 9) are logged unconditionally, for every call, success or not.
 */
export async function executeProgressCommand(input: ProgressCommandInput): Promise<ProgressCommandResult> {
  const commandId = randomUUID();
  const activity = PROGRESS_ACTIVITIES[input.activityKind];
  const primaryGoal = input.targetGoals[0];

  const eligibility = checkEligibility(activity, input);
  if (!eligibility.eligible) {
    console.log("[executeProgressCommand] ineligible", {
      commandId,
      userId: input.userId,
      goalId: primaryGoal?.id,
      activityKind: input.activityKind,
      source: input.source,
      reviewId: input.sourceReviewId,
      providerMessageId: input.sourceProviderMessageId,
      selectedReviewClassification: eligibility.emailKind,
      eligibilityResult: "ineligible",
      reason: eligibility.reason
    });
    return { status: "ineligible", commandId, reason: eligibility.reason, suggestion: eligibility.suggestion, emailKind: eligibility.emailKind };
  }

  const verificationMetrics = resolveVerificationMetrics(input.targetGoals, activity.metricBridge);
  const windowStart = new Date(input.now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const todayLocalDate = formatDateInTimezone(input.now, input.timezone);
  const occurredLocalDate = formatDateInTimezone(input.occurredAt, input.timezone);
  const occurredIsToday = occurredLocalDate === todayLocalDate;
  const occurredWithinWeek = input.occurredAt >= windowStart;

  const countBoth = (events: StoredEvent[]) => ({
    week: countProgress(events, activity.canonicalEventType, verificationMetrics),
    today: countProgress(
      events.filter((event) => formatDateInTimezone(event.timestamp, input.timezone) === todayLocalDate),
      activity.canonicalEventType,
      verificationMetrics
    )
  });

  const before = countBoth(await getEventsSince(input.userId, windowStart));
  const reconciliation = reconcileWithOpenAction(input.quantity, input.openActions);

  console.log("[executeProgressCommand] attempt", {
    commandId,
    userId: input.userId,
    goalId: primaryGoal?.id,
    activityKind: input.activityKind,
    source: input.source,
    reviewId: input.sourceReviewId,
    providerMessageId: input.sourceProviderMessageId,
    eligibilityResult: "eligible",
    resolvedMetricKeys: verificationMetrics.map(({ metric }) => metric.eventType ?? metric.signalKey ?? metric.key),
    occurredAt: input.occurredAt.toISOString(),
    todayLocalDate,
    baselineTodayCount: before.today,
    baselineWeekCount: before.week,
    overrideUsed: Boolean(input.explicitOverride)
  });

  const evidence = input.explicitOverride ? [...input.evidence, "user explicitly overrode the eligibility guard"] : input.evidence;
  const events: StoredEvent[] = [];
  let newlyCreatedCount = 0;

  for (let i = 0; i < input.quantity; i += 1) {
    if (input.externalIdBase) {
      const result = await createExternalEventIfNotExists(input.userId, {
        type: activity.canonicalEventType,
        source: input.source === "gmail_review" ? "gmail" : "manual",
        confidence: 1,
        timestamp: input.occurredAt,
        evidence,
        externalId: `${input.externalIdBase}:${i}`
      });
      events.push(result.event);
      if (result.created) newlyCreatedCount += 1;
    } else {
      events.push(await createEvent(input.userId, { type: activity.canonicalEventType, source: input.source === "gmail_review" ? "gmail" : "manual", confidence: 1, timestamp: input.occurredAt, evidence }));
      newlyCreatedCount += 1;
    }
  }

  for (const { goal, metric } of verificationMetrics) {
    if (!metric.signalKey || metric.eventType === activity.canonicalEventType) {
      continue;
    }
    for (let i = 0; i < input.quantity; i += 1) {
      if (input.externalIdBase) {
        const result = await createExternalEventIfNotExists(input.userId, {
          type: "custom.goal_progress_logged",
          source: input.source === "gmail_review" ? "gmail" : "manual",
          confidence: 1,
          timestamp: input.occurredAt,
          data: { signalKey: metric.signalKey },
          evidence,
          externalId: `${input.externalIdBase}:bridge:${goal.id}:${metric.signalKey}:${i}`
        });
        events.push(result.event);
      } else {
        events.push(
          await createEvent(input.userId, {
            type: "custom.goal_progress_logged",
            source: input.source === "gmail_review" ? "gmail" : "manual",
            confidence: 1,
            timestamp: input.occurredAt,
            data: { signalKey: metric.signalKey },
            evidence
          })
        );
      }
    }
  }

  if (newlyCreatedCount === 0) {
    console.log("[executeProgressCommand] result", {
      commandId,
      userId: input.userId,
      goalId: primaryGoal?.id,
      reviewId: input.sourceReviewId,
      providerMessageId: input.sourceProviderMessageId,
      writtenEventIds: events.map((event) => event.id),
      responsePath: "duplicate"
    });
    return { status: "duplicate", commandId, events };
  }

  const after = countBoth(await getEventsSince(input.userId, windowStart));
  // Kept as the pre-existing EMAIL_PROGRESS_VERIFICATION_FORCE_FAIL name (not renamed for this
  // engine) — every existing deterministic/LLM-eval test that exercises the verification-failure
  // branch already sets this exact variable; a rename here would silently stop forcing failure in
  // all of them without touching their own code.
  const forceVerificationFailure = process.env.EMAIL_PROGRESS_VERIFICATION_FORCE_FAIL === "true";
  const weekVerified = !forceVerificationFailure && (!occurredWithinWeek || after.week === before.week + newlyCreatedCount);
  const todayVerified = !forceVerificationFailure && (!occurredIsToday || after.today === before.today + newlyCreatedCount);
  const verified = weekVerified && todayVerified;

  console.log("[executeProgressCommand] result", {
    commandId,
    userId: input.userId,
    goalId: primaryGoal?.id,
    reviewId: input.sourceReviewId,
    providerMessageId: input.sourceProviderMessageId,
    writtenEventIds: events.map((event) => event.id),
    eventIds: events.map((event) => event.id),
    eventType: activity.canonicalEventType,
    count: newlyCreatedCount,
    baselineTodayCount: before.today,
    baselineWeekCount: before.week,
    postTodayCount: after.today,
    postWeekCount: after.week,
    resolvedMetric: verificationMetrics.map(({ metric }) => metric.eventType ?? metric.signalKey ?? metric.key),
    metricAggregationScope: verificationMetrics.length > 0 ? "goal-metric" : "global-canonical-type",
    verified,
    responsePath: verified ? "logged" : "verification_failed"
  });

  if (!verified) {
    return { status: "verification_failed", commandId, events };
  }

  let completedAction: ActionItem | undefined;
  if (reconciliation.kind === "complete") {
    completedAction = await completeActionItem(input.userId, reconciliation.action.id);
  }

  return {
    status: "logged",
    commandId,
    events,
    newlyCreatedCount,
    goal: primaryGoal,
    todayCount: after.today,
    weekCount: after.week,
    completedAction,
    reconciliationNote: reconciliation.note,
    overrideUsed: Boolean(input.explicitOverride)
  };
}
