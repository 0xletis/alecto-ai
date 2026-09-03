import {
  CUSTOM_SIGNAL_EVENT_TYPE,
  EventTypeSchema,
  HIGH_SIGNAL_JOB_SEARCH_EVENT_TYPES,
  groupEmailIntelligenceItems,
  parseActionDueDate,
  type EmailIntelligenceSourceItem,
  type Goal,
  type StoredEvent
} from "@operator-agent/core";
import {
  approveEmailReviewItem,
  createActionItemIfNotExists,
  createExternalEventIfNotExists,
  getActionItem,
  getEmailReviewItem,
  getEmailReviewItems,
  getEmailSignalRules,
  getGoals,
  getOrCreateNotificationSettings,
  getPendingEmailReviewCount,
  rejectEmailReviewItem,
  replacePendingAction,
  type ActionItem,
  type CreateActionItemInput,
  type EmailReviewItem,
  type EmailSignalRule
} from "@operator-agent/db";
import type { EmailKind, EmailUnderstanding } from "@operator-agent/llm";
import { resolveActiveGoalIdsForGmailRule } from "../conversation/gmail-autonomy.js";
import { emailReviewKind, type EmailReviewKind } from "../utils/email-review.js";
import { inferActionGoalLink } from "../utils/action-goal-link.js";
import { truncatePlainText } from "../utils/text.js";
import { formatDateInTimezone } from "../utils/datetime.js";
import { formatLocalDateTime, pendingDecisionExpiry } from "../utils/datetime.js";
import { getUserTimezone } from "../utils/user-timezone.js";

/**
 * Pure email-review service layer, extracted from apps/api/src/server.ts.
 * Inbox listing/formatting, approve/reject, and email-review-to-action
 * conversion — everything that operates on already-synced EmailReviewItem
 * rows and does not touch Gmail OAuth, sync, or the raw provider API.
 * Depends only on @operator-agent/core, @operator-agent/db, and already-
 * extracted utils modules. Zero dependency on server.ts.
 *
 * Not moved here: `createEmailReviewItemForClassification` and its Gmail-
 * sync-only helpers (`safeEmailReviewProposedType`,
 * `dedupeDecisionForReviewStatus`, `buildEmailReviewSemanticKey`,
 * `getGmailHeader`) — these run inside the Gmail sync pipeline
 * (`syncEmailSignalRule`), take a raw Gmail API message and access token,
 * and stay in server.ts per this pass's explicit "do not touch Gmail OAuth/
 * sync" rule. Also not moved: the operator-attention email summary cluster
 * (`formatEmailAttentionForConversation`, `buildOperatorEmailAttentionSummary`,
 * `buildOperatorSuggestedReplies`, `emailAttentionPriorityLine`,
 * `looksLikeEmailAttentionQuery`) — a different, still-un-extracted domain
 * (operator attention/onboarding/daily-brief) that happens to summarize
 * email-review counts, not part of the email-review service itself.
 *
 * See apps/api/src/legacy/email-review-conversation.ts for the legacy
 * natural-language/pending-decision layer built on top of this service.
 */

export function sanitizeEmailReviewItem(item: EmailReviewItem) {
  return {
    ...item,
    evidence: item.evidence ? truncatePlainText(item.evidence, 500) : undefined,
    snippet: item.snippet ? truncatePlainText(item.snippet, 300) : undefined
  };
}
export interface EmailReviewInboxItem {
  number: number;
  reviewId: string;
  kind: EmailReviewKind;
  groupLabel: string;
  ruleName: string;
  trackingLabel: string;
  from?: string;
  subject?: string;
  snippet?: string;
  evidence?: string;
  proposedEventType?: string;
  proposedOutcome: string;
  goalTitle?: string;
  confidence: number;
  createdAt: string;
}

export interface EmailReviewInboxResponse {
  pendingReviewCount: number;
  groups: Array<{
    kind: EmailReviewKind;
    label: string;
    count: number;
    reviews: EmailReviewInboxItem[];
  }>;
  reviews: EmailReviewInboxItem[];
  message: string;
}

export type EmailReviewApprovalResult =
  | { status: "not_found" }
  | { status: "not_pending"; review: EmailReviewItem }
  | {
      status: "ok";
      emailReview: EmailReviewItem;
      event?: StoredEvent | null;
      actionItem?: ActionItem | null;
      message: string;
    };

export async function buildEmailReviewInboxResponse(
  userId: string,
  options: { storeContext?: boolean; limit?: number } = {}
): Promise<EmailReviewInboxResponse> {
  const limit = options.limit ?? 10;
  const [pendingReviewCount, reviews, rules, goals, timezone] = await Promise.all([
    getPendingEmailReviewCount(userId),
    getEmailReviewItems(userId, { status: "pending", limit }),
    getEmailSignalRules(userId),
    getGoals(userId),
    getUserTimezone(userId)
  ]);
  const ruleById = new Map(rules.map((rule) => [rule.id, rule]));
  const goalById = new Map(goals.map((goal) => [goal.id, goal.title]));
  const orderedReviews = [...reviews].sort((left, right) => {
    const kindDelta = emailReviewKindSortIndex(emailReviewKind(left)) - emailReviewKindSortIndex(emailReviewKind(right));
    if (kindDelta !== 0) {
      return kindDelta;
    }

    const updatedDelta = right.updatedAt.getTime() - left.updatedAt.getTime();
    if (updatedDelta !== 0) {
      return updatedDelta;
    }

    return (left.subject ?? "").localeCompare(right.subject ?? "");
  });
  const items = orderedReviews.map((review, index) =>
    toEmailReviewInboxItem({
      review,
      number: index + 1,
      rule: ruleById.get(review.ruleId),
      goalById,
      timezone
    })
  );
  const groups = groupEmailReviewInboxItems(items);

  if (options.storeContext) {
    await replacePendingAction(userId, {
      type: "email_review_context",
      summary: `${pendingReviewCount} email review${pendingReviewCount === 1 ? "" : "s"} visible`,
      payload: {
        operation: "email_review_context",
        reviews: items,
        pendingReviewCount,
        visibleCount: items.length
      },
      expiresAt: pendingDecisionExpiry()
    });
  }

  return {
    pendingReviewCount,
    groups,
    reviews: items,
    message: formatEmailReviewInboxMessage(pendingReviewCount, groups)
  };
}

export async function approveEmailReviewForUser(userId: string, reviewId: string): Promise<EmailReviewApprovalResult> {
  const review = await getEmailReviewItem(userId, reviewId);

  if (!review) {
    return { status: "not_found" };
  }

  if (review.status !== "pending") {
    if (review.status === "approved" && review.actionItemId) {
      const actionItem = await getActionItem(userId, review.actionItemId);

      if (actionItem) {
        return {
          status: "ok",
          emailReview: review,
          actionItem,
          event: null,
          message: `Email review already approved. Action item exists: ${actionItem.title}`
        };
      }
    }

    return { status: "not_pending", review };
  }

  if (isWorkActionReviewType(review.proposedEventType)) {
    const result = await createActionItemFromEmailReview(userId, review, {});
    const updated = await approveEmailReviewItem(userId, review.id, undefined, result.actionItem.id);

    return {
      status: "ok",
      emailReview: updated ?? review,
      actionItem: result.actionItem,
      event: null,
      message: `Email review approved. Action item ${result.created ? "created" : "already exists"}: ${result.actionItem.title}`
    };
  }

  if (review.adapterId === "custom_email_review") {
    // Fresh lookup, never the goalId snapshot classification wrote into review.extracted — a
    // rule's own goal/signal mapping (see EmailSignalRule.signalKey/eventType, feat/gmail-rule-
    // signal-mapping) could have changed between classification and approval, and this mirrors
    // createActionItemFromEmailReview's own established pattern below for exactly the same reason.
    // No mapping (no rule, no linked goal, goal no longer active, or a signalKey/eventType that no
    // longer matches anything the goal itself declares) falls through to the exact old no-op
    // behavior — a custom rule with no mapping must keep behaving exactly as before this feature.
    const rule = (await getEmailSignalRules(userId)).find((item) => item.id === review.ruleId);
    const linkedGoal = rule?.goalId && (rule.signalKey || rule.eventType) ? (await getGoals(userId)).find((goal) => goal.id === rule.goalId && goal.status === "active") : undefined;
    const metrics = linkedGoal?.targetMetrics ?? [];
    const mappedSignalKey = linkedGoal && rule?.signalKey && metrics.some((metric) => metric.signalKey === rule.signalKey) ? rule.signalKey : undefined;
    const mappedEventType =
      linkedGoal && !mappedSignalKey && rule?.eventType && EventTypeSchema.safeParse(rule.eventType).success && metrics.some((metric) => metric.eventType === rule.eventType)
        ? rule.eventType
        : undefined;

    if (!linkedGoal || (!mappedSignalKey && !mappedEventType)) {
      const updated = await approveEmailReviewItem(userId, review.id);

      return {
        status: "ok",
        emailReview: updated ?? review,
        event: null,
        actionItem: null,
        message: "Custom email review approved. No event or action was created."
      };
    }

    // MVP extraction only: simple regex over the review's OWN already-stored subject/snippet/
    // evidence text — no attachment/PDF parsing, no re-fetch, no full email body sent anywhere.
    // Missing fields are simply omitted, never guessed.
    const extractedFields = extractGenericEvidenceFields([review.subject, review.snippet, review.evidence].filter(Boolean).join(" "));
    const eventExternalId = review.externalId.replace(/^gmail-review:/, "gmail:");
    const created = await createExternalEventIfNotExists(userId, {
      type: mappedEventType ? EventTypeSchema.parse(mappedEventType) : CUSTOM_SIGNAL_EVENT_TYPE,
      timestamp: new Date(),
      source: "gmail",
      provider: "gmail",
      externalId: eventExternalId,
      data: {
        ...(mappedSignalKey ? { signalKey: mappedSignalKey } : {}),
        ...extractedFields,
        provider: "gmail",
        emailAdapterId: review.adapterId,
        adapterId: review.adapterId,
        classification: review.reason,
        ruleId: review.ruleId,
        gmailMessageId: review.providerMessageId,
        subject: review.subject,
        from: review.from,
        snippet: review.snippet,
        confidence: review.confidence,
        reason: review.reason,
        reviewItemId: review.id,
        externalId: eventExternalId
      },
      confidence: review.confidence,
      evidence: review.evidence ? [review.evidence] : undefined
    });
    const updated = await approveEmailReviewItem(userId, review.id, created.event.id);
    const amountNote =
      typeof extractedFields.amount_eur === "number"
        ? ` (€${extractedFields.amount_eur.toFixed(2)})`
        : typeof extractedFields.amount_usd === "number"
          ? ` ($${extractedFields.amount_usd.toFixed(2)})`
          : "";

    return {
      status: "ok",
      emailReview: updated ?? review,
      event: created.event,
      actionItem: null,
      message: `${created.created ? "Custom email review approved and evidence logged" : "Custom email review approved. Evidence already logged"}${amountNote}. This counts toward "${linkedGoal.title}".`
    };
  }

  if (!review.proposedEventType || !EventTypeSchema.safeParse(review.proposedEventType).success) {
    const updated = await approveEmailReviewItem(userId, review.id);

    return {
      status: "ok",
      emailReview: updated ?? review,
      event: null,
      actionItem: null,
      message: "This review item does not map to an approved event type yet. No event created."
    };
  }

  const eventExternalId = review.externalId.replace(/^gmail-review:/, "gmail:");
  const created = await createExternalEventIfNotExists(userId, {
    type: EventTypeSchema.parse(review.proposedEventType),
    timestamp: new Date(),
    source: "gmail",
    provider: "gmail",
    externalId: eventExternalId,
    data: {
      ...review.extracted,
      provider: "gmail",
      emailAdapterId: review.adapterId,
      adapterId: review.adapterId === "job_search_email" ? "job_search_text" : review.adapterId,
      classification: review.reason,
      ruleId: review.ruleId,
      gmailMessageId: review.providerMessageId,
      subject: review.subject,
      from: review.from,
      snippet: review.snippet,
      confidence: review.confidence,
      reason: review.reason,
      reviewItemId: review.id,
      externalId: eventExternalId
    },
    confidence: review.confidence,
    evidence: review.evidence ? [review.evidence] : undefined
  });
  const updated = await approveEmailReviewItem(userId, review.id, created.event.id);

  return {
    status: "ok",
    emailReview: updated ?? review,
    event: created.event,
    actionItem: null,
    message: created.created ? "Email review approved and event created." : "Email review approved. Event already existed."
  };
}

export async function createActionItemFromEmailReview(
  userId: string,
  review: EmailReviewItem,
  options: { dueText?: string; now?: Date } = {}
): Promise<{ created: boolean; actionItem: ActionItem }> {
  const actionInput = actionItemInputFromEmailReview(review);
  const dueAt = await parseEmailReviewActionDueAt(userId, options.dueText, options.now);

  if (dueAt) {
    actionInput.dueAt = dueAt;
  } else if (!actionInput.dueAt) {
    actionInput.dueAt = await parseEmailReviewDetectedDeadline(userId, review, options.now);
  }

  const rule = (await getEmailSignalRules(userId)).find((item) => item.id === review.ruleId);
  const goals = await getGoals(userId);
  const linkedGoal = rule?.goalId ? goals.find((goal) => goal.id === rule.goalId && goal.status === "active") : undefined;

  if (linkedGoal) {
    actionInput.goalId = linkedGoal.id;
    actionInput.goalSlug = linkedGoal.templateId ?? undefined;
    actionInput.goalTitleSnapshot = linkedGoal.title;
  } else {
    const goalLink = await inferActionGoalLink(userId, actionInput.title, actionInput.description, actionInput.evidence);
    actionInput.goalId = goalLink.goalId ?? undefined;
    actionInput.goalSlug = goalLink.goalSlug ?? undefined;
    actionInput.goalTitleSnapshot = goalLink.matchedGoalTitle;
  }

  return createActionItemIfNotExists(userId, actionInput);
}

export async function parseEmailReviewDetectedDeadline(
  userId: string,
  review: EmailReviewItem,
  now = new Date()
): Promise<Date | undefined> {
  const deadlineText = detectedDeadlineTextFromEmailReview(review, now);

  if (!deadlineText) {
    return undefined;
  }

  const settings = await getOrCreateNotificationSettings(userId);
  const parsed = parseActionDueDate(deadlineText, {
    now,
    timezone: settings.timezone,
    preferences: settings
  });

  return parsed.invalidReason === "past_explicit_time" ? undefined : parsed.dueAt ?? undefined;
}

export async function parseEmailReviewActionDueAt(userId: string, dueText: string | undefined, now = new Date()): Promise<Date | undefined> {
  if (!dueText?.trim()) {
    return undefined;
  }

  const settings = await getOrCreateNotificationSettings(userId);
  const parsed = parseActionDueDate(dueText, {
    now,
    timezone: settings.timezone,
    preferences: settings
  });

  if (parsed.invalidReason === "past_explicit_time") {
    throw new Error("That time has already passed. Use a future time, or say 'now'.");
  }

  return parsed.dueAt ?? undefined;
}

function detectedDeadlineTextFromEmailReview(review: EmailReviewItem, now: Date): string | undefined {
  const text = cleanEmailFragment([review.subject, review.snippet, review.evidence].filter(Boolean).join(" "));
  const relativeDateTime = relativeDateTimeTextFromEmailReviewText(text);

  if (relativeDateTime) {
    return relativeDateTime;
  }

  const match = text.match(
    /\b(?:by|before|after|on)?\s*(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,\s*(\d{4}))?\b/i
  );

  if (!match?.[1] || !match[2]) {
    return undefined;
  }

  const month = monthNumber(match[1]);
  const day = Number(match[2]);

  if (!month || day < 1 || day > 31) {
    return undefined;
  }

  const year = match[3] ? Number(match[3]) : now.getFullYear();
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function relativeDateTimeTextFromEmailReviewText(text: string): string | undefined {
  const time = "\\d{1,2}(?::\\d{2})?\\s*(?:a\\.?m\\.?|p\\.?m\\.?)";
  const relative = "(?:today|tomorrow|tonight)";
  const weekday = "(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)";
  const day = `(?:${relative}|(?:next\\s+)?${weekday})`;

  const dayThenTime = text.match(new RegExp(`\\b(${day})(?:\\s+(?:morning|afternoon|evening))?\\s+(?:at\\s+)?(${time})\\b`, "i"));
  if (dayThenTime?.[1] && dayThenTime[2]) {
    return `${dayThenTime[1]} at ${normalizeEmailReviewTimeText(dayThenTime[2])}`;
  }

  const timeThenDay = text.match(new RegExp(`\\b(?:at\\s+)?(${time})\\s+(?:on\\s+)?(${day})\\b`, "i"));
  if (timeThenDay?.[1] && timeThenDay[2]) {
    return `${timeThenDay[2]} at ${normalizeEmailReviewTimeText(timeThenDay[1])}`;
  }

  const dayPart = text.match(new RegExp(`\\b(${day}\\s+(?:morning|afternoon|evening|tonight))\\b`, "i"));
  return dayPart?.[1]?.trim();
}

function normalizeEmailReviewTimeText(text: string): string {
  return text.replace(/\s+/g, "").replace(/\./g, "").toLowerCase();
}

/**
 * Small, generic, rule-independent MVP extraction over a review's own already-stored
 * subject/snippet/evidence text — no per-rule extraction config, no attachment/PDF parsing, no
 * full email body sent anywhere. Produces well-known keys only when confidently found; a field
 * that isn't obviously present is simply omitted, never guessed (feat/gmail-rule-signal-mapping).
 */
export function extractGenericEvidenceFields(text: string): Record<string, number | string> {
  const fields: Record<string, number | string> = {};

  const eurMatch = text.match(/€\s?(\d{1,6}(?:[.,]\d{2})?)|(\d{1,6}(?:[.,]\d{2})?)\s?€/);
  const eurAmount = eurMatch ? parseAmountText(eurMatch[1] ?? eurMatch[2] ?? "") : undefined;
  if (eurAmount !== undefined) {
    fields.amount_eur = eurAmount;
  }

  const usdMatch = text.match(/\$\s?(\d{1,6}(?:[.,]\d{2})?)/);
  const usdAmount = usdMatch?.[1] ? parseAmountText(usdMatch[1]) : undefined;
  if (usdAmount !== undefined) {
    fields.amount_usd = usdAmount;
  }

  const date = extractDateField(text);
  if (date) {
    fields.date = date;
  }

  return fields;
}

function parseAmountText(raw: string): number | undefined {
  // Small bill/invoice amounts only — a comma is always a decimal separator here, never a
  // thousands separator (e.g. "43,20" -> 43.20, never 4320).
  const normalized = raw.includes(",") ? raw.replace(",", ".") : raw;
  const value = Number(normalized);
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : undefined;
}

function extractDateField(text: string): string | undefined {
  const numericMatch = text.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/);
  if (numericMatch?.[1] && numericMatch[2] && numericMatch[3]) {
    const first = Number(numericMatch[1]);
    const second = Number(numericMatch[2]);
    const year = numericMatch[3];
    // DD/MM vs MM/DD is genuinely ambiguous unless one part can only be a day (>12) — left blank
    // rather than guessed when both parts could be either.
    if (first > 12 && second <= 12) {
      return `${year}-${String(second).padStart(2, "0")}-${String(first).padStart(2, "0")}`;
    }
    if (second > 12 && first <= 12) {
      return `${year}-${String(first).padStart(2, "0")}-${String(second).padStart(2, "0")}`;
    }
    return undefined;
  }

  const monthMatch = text.match(
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,\s*(\d{4}))?\b/i
  );
  if (monthMatch?.[1] && monthMatch[2]) {
    const month = monthNumber(monthMatch[1]);
    const day = Number(monthMatch[2]);
    if (month && day >= 1 && day <= 31) {
      const year = monthMatch[3] ? Number(monthMatch[3]) : new Date().getFullYear();
      return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    }
  }

  return undefined;
}

function monthNumber(month: string): number | undefined {
  const months = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december"
  ];
  const index = months.indexOf(month.toLowerCase());
  return index === -1 ? undefined : index + 1;
}

export async function rejectEmailReviewForUser(userId: string, reviewId: string): Promise<{ status: "not_found" | "ok"; review?: EmailReviewItem; message: string }> {
  const review = await rejectEmailReviewItem(userId, reviewId);

  if (!review) {
    return { status: "not_found", message: "Email review item not found" };
  }

  return {
    status: "ok",
    review,
    message: review.status === "rejected" ? "Email review rejected." : `Email review item is already ${review.status}.`
  };
}
export function toEmailReviewInboxItem(input: {
  review: EmailReviewItem;
  number: number;
  rule?: EmailSignalRule;
  goalById: Map<string, string>;
  timezone: string;
}): EmailReviewInboxItem {
  const kind = emailReviewKind(input.review);
  const ruleName = input.rule?.name ?? "Gmail tracking";
  const goalTitle = input.rule?.goalId ? input.goalById.get(input.rule.goalId) : undefined;

  return {
    number: input.number,
    reviewId: input.review.id,
    kind,
    groupLabel: emailReviewGroupLabel(kind),
    ruleName,
    trackingLabel: emailReviewTrackingLabel(input.review),
    from: input.review.from ? truncatePlainText(input.review.from, 100) : undefined,
    subject: input.review.subject ? truncatePlainText(input.review.subject, 100) : undefined,
    snippet: input.review.snippet ? truncatePlainText(input.review.snippet, 180) : undefined,
    evidence: input.review.evidence ? truncatePlainText(input.review.evidence, 180) : undefined,
    proposedEventType: input.review.proposedEventType,
    proposedOutcome: emailReviewProposedOutcome(input.review),
    goalTitle,
    confidence: input.review.confidence,
    createdAt: formatLocalDateTime(input.review.createdAt, input.timezone)
  };
}

export function groupEmailReviewInboxItems(items: EmailReviewInboxItem[]) {
  const order: EmailReviewKind[] = ["job_search", "work_action", "custom_tracking", "other"];

  return order
    .map((kind) => {
      const reviews = items.filter((item) => item.kind === kind);
      return {
        kind,
        label: emailReviewGroupLabel(kind),
        count: reviews.length,
        reviews
      };
    })
    .filter((group) => group.count > 0);
}

export function emailReviewKindSortIndex(kind: EmailReviewKind): number {
  const order: EmailReviewKind[] = ["job_search", "work_action", "custom_tracking", "other"];
  const index = order.indexOf(kind);
  return index === -1 ? order.length : index;
}

export function formatEmailReviewInboxMessage(pendingReviewCount: number, groups: EmailReviewInboxResponse["groups"]): string {
  if (pendingReviewCount === 0) {
    return "No email reviews are waiting.";
  }

  const lines = [`Email reviews waiting: ${pendingReviewCount}`];

  for (const group of groups) {
    lines.push("", `${group.label}:`);

    for (const item of group.reviews) {
      lines.push(
        `${item.number}. ${item.subject ?? item.ruleName} - ${senderOrRuleLabel(item)} - ${item.createdAt}`,
        `   Proposed: ${item.proposedOutcome}`,
        item.kind === "custom_tracking"
          ? `   Say "show ${item.number}", "reject ${item.number}", or "turn ${item.number} into an action".`
          : `   Say "approve ${item.number}" or "reject ${item.number}".`
      );
    }
  }

  if (pendingReviewCount > visibleEmailReviewCount(groups)) {
    lines.push("", `Showing ${visibleEmailReviewCount(groups)}. Run /email_reviews all for recent handled items with IDs.`);
  }

  return lines.join("\n");
}

export function visibleEmailReviewCount(groups: EmailReviewInboxResponse["groups"]): number {
  return groups.reduce((count, group) => count + group.reviews.length, 0);
}

export function senderOrRuleLabel(item: EmailReviewInboxItem): string {
  const sender = item.from ? extractSafeSenderLabel(item.from) : "";
  return sender || item.ruleName;
}

export function extractSafeSenderLabel(value: string): string {
  const withoutEmail = value.replace(/<[^>]+>/g, "").replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, "").trim();
  return truncatePlainText(withoutEmail || value, 80);
}

/**
 * Compact, chat-appropriate label for one review item — real subject/sender/rule-name only,
 * never an invented summary. Used by Agent Runtime v3's gmail.review.list (see
 * apps/api/src/agent-runtime/executor.ts), distinct from the richer, grouped
 * EmailReviewInboxItem shape above which the dedicated /email-reviews HTTP route uses.
 */
export function gmailReviewChatLabel(review: EmailReviewItem, rules: EmailSignalRule[]): string {
  if (review.subject) {
    return truncatePlainText(review.subject, 80);
  }
  if (review.from) {
    return extractSafeSenderLabel(review.from);
  }
  const rule = rules.find((item) => item.id === review.ruleId);
  return rule?.name ?? "Email";
}

/** Real snippet/evidence text only, safely truncated — undefined (omitted) rather than invented when neither is available. */
export function gmailReviewChatDescription(review: EmailReviewItem): string | undefined {
  if (review.snippet) {
    return truncatePlainText(review.snippet, 140);
  }
  if (review.evidence) {
    return truncatePlainText(review.evidence, 140);
  }
  return undefined;
}

/**
 * fix/private-alpha-gmail-generic-signal-engine: generalizes what used to be a career-only check
 * (only career.offer_received/career.interview_scheduled could ever be "high priority", forced to
 * review even at auto-log confidence — apps/api/src/server.ts's syncEmailSignalRule) to any
 * review — a flight cancellation or an insurance deadline can now carry the same weight. Prefers
 * the review's own `priority` column (set generically at creation time by
 * deriveEmailReviewPriorityAndDomain) and falls back to the original career-only check only for
 * rows written before that column existed, so nothing already stored silently changes meaning.
 */
export function isHighPriorityGmailReview(review: Pick<EmailReviewItem, "proposedEventType" | "priority">): boolean {
  if (review.priority) {
    return review.priority === "high";
  }
  return Boolean(review.proposedEventType && HIGH_SIGNAL_JOB_SEARCH_EVENT_TYPES.has(review.proposedEventType));
}

// fix/private-alpha-email-review-router-cleanup: known non-eventType `reason` values that still
// deserve a real, specific display label — without this, "Okify ha visto tu solicitud" (reason
// "application_viewed", deliberately no proposedEventType — it's informational, not a real career
// event) rendered as the same generic "uncertain signal" text a genuinely unclassifiable email
// gets, which is exactly the "misclassified" symptom this task's live report complained about even
// after the underlying classification itself was fixed.
const KNOWN_NON_EVENT_REASON_LABELS: Record<string, string> = {
  application_viewed: "application viewed"
};

/** Real signal-type name when the classifier proposed one; a known non-eventType reason's own
 * label when that's what this is; "needs decision" (never a guessed category, and never the old
 * lazy "uncertain signal" catch-all — refactor/private-alpha-general-email-intelligence-workflow
 * Task 2: a bare "uncertain" label states confusion without direction, "needs decision" says what
 * Alecto actually knows — it has no determinable event type, so a human call is what's missing)
 * otherwise — e.g. an "action required" email with no determinable event type. */
export function gmailReviewSignalTypeLabel(review: Pick<EmailReviewItem, "proposedEventType" | "reason">): string {
  if (review.proposedEventType) {
    return humanEmailReviewEventLabel(review.proposedEventType);
  }
  return KNOWN_NON_EVENT_REASON_LABELS[review.reason] ?? "needs decision";
}

export type GmailReviewPresentationCategory = "confirmation" | "needs_review" | "noise";

/**
 * fix/private-alpha-gmail-review-quality-and-dedupe (Task 7): a real live-testing report — 10
 * pending reviews dumped as one flat, undifferentiated list ("too raw") mixed a verification code,
 * a welcome email, and a job alert in with genuine application confirmations and recruiter
 * signals, with no way to act on them as a batch. This buckets each review by what it actually is,
 * NOT by adapter/rule — recruiter replies, interviews, offers, and rejections always land in
 * "needs_review" (never auto-groupable as noise or silently bulk-approved, per the explicit "do not
 * hide important recruiter replies, interviews, offers, or rejections" rule); routine application
 * confirmations get their own low-stakes, batch-approvable bucket; anything that reads as
 * filtered/uncertain — a security code or onboarding email that reached review anyway (e.g. via a
 * custom rule), or genuinely unclassifiable content — is "noise", batch-rejectable without touching
 * anything real.
 */
export function gmailReviewPresentationCategory(review: Pick<EmailReviewItem, "reason" | "proposedEventType" | "confidence">): GmailReviewPresentationCategory {
  const NOISE_REASONS = new Set(["security_auth", "onboarding_noise", "filtered_marketing", "filtered_non_action_email", "unknown", "application_viewed"]);

  if (review.reason === "application_confirmation") {
    return "confirmation";
  }

  if (NOISE_REASONS.has(review.reason) && !review.proposedEventType) {
    return "noise";
  }

  return "needs_review";
}

export function gmailReviewPresentationCategoryLabel(category: GmailReviewPresentationCategory): string {
  if (category === "confirmation") {
    return "Likely application confirmations";
  }

  if (category === "noise") {
    return "Likely noise";
  }

  return "Needs review";
}

/**
 * Itemized (not bare-count) Gmail review list for normal V3 chat — each line grounded in that
 * review's own real subject/sender/snippet/evidence, numbered so a follow-up like "turn the
 * recruiter one into a task" or "reject 1" can resolve deterministically against this exact
 * list (see apps/api/src/agent-runtime/validator.ts's resolveGmailReviewRef). Also states the
 * classifier's own signal-type guess, received date, high-priority flag (offer/interview), and
 * linked goal when one resolves — enough for the user to decide without opening Gmail themselves.
 * Grouped into confirmations/needs-review/noise (Task 7) so the user can act on a whole category
 * at once ("log the application confirmations", "ignore the noise") instead of reading 10 raw rows
 * — numbering stays global across groups so every existing numbered-reference command still works.
 */
// fix/private-alpha-email-progress-count-and-review-ux (Task 6): a clean row — short label
// (extracted company when the classifier already captured one at sync/classification time, else
// the subject), role if extracted, classification, date, linked goal — never the raw stored
// snippet/evidence text (which can carry tracking-link fragments, invisible characters, and
// duplicated body text straight from the source email). No live refetch/LLM call here — list rows
// stay cheap; a full readonly refetch + understanding only ever happens on "details for N".
function gmailReviewRowLine(
  review: EmailReviewItem,
  rules: EmailSignalRule[],
  activeGoals: Goal[],
  timezone: string,
  numbers: number[]
): string {
  const extracted = (review.extracted ?? {}) as Record<string, unknown>;
  const company = typeof extracted.company === "string" && extracted.company.trim() ? extracted.company.trim() : undefined;
  const role = typeof extracted.role === "string" && extracted.role.trim() ? extracted.role.trim() : undefined;
  const label = company ?? gmailReviewChatLabel(review, rules);
  const signalType = gmailReviewSignalTypeLabel(review);
  const received = formatDateInTimezone(review.createdAt, timezone);
  const rule = rules.find((item) => item.id === review.ruleId);
  const linkedGoalId = rule ? [...resolveActiveGoalIdsForGmailRule(rule, activeGoals)][0] : undefined;
  const linkedGoal = linkedGoalId ? activeGoals.find((goal) => goal.id === linkedGoalId) : undefined;
  const priorityPrefix = isHighPriorityGmailReview(review) ? "[High priority] " : "";

  // fix/private-alpha-email-review-router-cleanup (Task 7): 2+ numbers means
  // groupSimilarEntriesForDisplay collapsed several same-subject/sender/day rows into one combined
  // line — every individual number stays addressable ("details for 5"), the text is just shared.
  const numberPrefix = numbers.length > 1 ? numbers.join(", ") : String(numbers[0]);
  const countPrefix = numbers.length > 1 ? `${numbers.length} similar ` : "";

  const parts = [label, role, signalType].filter((part): part is string => Boolean(part));

  return `${numberPrefix}. ${priorityPrefix}${countPrefix}${parts.join(" — ")} — Gmail, ${received}${linkedGoal ? ` — linked to "${linkedGoal.title}"` : ""}`;
}

// fix/private-alpha-email-progress-count-and-review-ux (Task 5): a real reported bug — the old
// footer always said "details for 3" and offered "log the application confirmations"/"reject the
// Endesa one" regardless of what was actually visible, including when only ONE review existed and
// no confirmation/noise group or Endesa-named review was anywhere on screen. Contextual now: a
// single review gets its own exact, grounded footer; a multi-review list only ever mentions a
// category command when that category is actually present, and never names a specific company —
// "with a number"/"one/all of them" instead of a fabricated example.
function gmailReviewListFooter(reviewCount: number, groups: Array<{ category: GmailReviewPresentationCategory }>): string {
  if (reviewCount === 1) {
    return 'Reply "details for 1", "mark it as counted", or "ignore it if already counted."';
  }

  const base = groups.length > 1 ? "Open details with a number." : "Reply with a number for details, or say what to do with one/all of them.";

  const suggestions: string[] = [];
  if (groups.some((group) => group.category === "confirmation")) {
    suggestions.push('"log the confirmations" if they are not already counted');
  }
  if (groups.some((group) => group.category === "noise")) {
    suggestions.push('"ignore the noise"');
  }

  return suggestions.length > 0 ? `${base} You can also say ${suggestions.join(" or ")}.` : base;
}

// fix/private-alpha-email-review-router-cleanup (Task 7): a real reported bug — a job-listing
// digest with no specific proposedEventType skips BOTH existing dedupe paths (findGmailSemanticDuplicateReviewItem
// requires one; the exact-providerMessageId check only ever catches the literal same message), so
// three genuinely different "new roles this week" emails for the same posting showed as three
// identical, undifferentiated "Engineering Manager - Frontend - Consumer en Kraken" rows. This
// groups same-subject/same-sender/same-calendar-day entries into ONE display line — never
// collapsing the underlying numbering itself, so "details for 2"/"ignore 2" still addresses that
// EXACT review individually; only the rendered TEXT is combined.
function groupSimilarEntriesForDisplay(
  entries: Array<{ review: EmailReviewItem; number: number }>,
  timezone: string
): Array<{ numbers: number[]; review: EmailReviewItem }> {
  const keyFor = (review: EmailReviewItem) =>
    `${(review.subject ?? "").trim().toLowerCase()}|${(review.from ?? "").trim().toLowerCase()}|${formatDateInTimezone(review.createdAt, timezone)}`;

  const groupedByKey = new Map<string, Array<{ review: EmailReviewItem; number: number }>>();
  for (const entry of entries) {
    const key = keyFor(entry.review);
    const existing = groupedByKey.get(key);
    if (existing) existing.push(entry);
    else groupedByKey.set(key, [entry]);
  }

  // Preserves the original entries' relative order — Map iteration order follows insertion order,
  // and each group's first-seen entry determines where its combined line appears. Only collapses
  // at 3+ members, deliberately not 2 — a real pre-existing test caught this: two DIFFERENT
  // security-advisory emails (different repos, genuinely worth seeing individually) happened to
  // share the exact same subject template, and collapsing a mere pair hid one of them. Three or
  // more identical subject/sender/day rows is the clearer, safer signal of an actual broadcast
  // digest (the live-reported "3 Kraken listings" shape), never a coincidence worth flattening.
  const seenKeys = new Set<string>();
  const result: Array<{ numbers: number[]; review: EmailReviewItem }> = [];
  for (const entry of entries) {
    const key = keyFor(entry.review);
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    const group = groupedByKey.get(key)!;
    if (group.length >= 3) {
      result.push({ numbers: group.map((item) => item.number), review: group[0]!.review });
    } else {
      for (const item of group) {
        result.push({ numbers: [item.number], review: item.review });
      }
    }
  }
  return result;
}

// refactor/private-alpha-general-email-intelligence-workflow — Stage E of the email intelligence
// pipeline: the DEFAULT presentation for a pending queue, replacing a flat "10+ uncertain rows"
// dump with grouped, actionable decisions. Never shown for anything but the live PENDING queue —
// "show raw email reviews"/"show queue"/"show all emails" (runtime.ts's own explicit escape hatch)
// still get the plain formatGmailReviewListForChat list below, unchanged.
const NOISE_BUCKET_PLURAL_LABELS: Record<string, string> = {
  job_alert: "job alert",
  profile_status: "profile/status notification",
  connection_suggestion: "connection suggestion",
  security_auth: "security code",
  onboarding: "onboarding email",
  marketing: "marketing email",
  receipt: "receipt",
  filtered_marketing: "job alert/marketing email",
  security_auth_noise: "security code",
  onboarding_noise: "onboarding email",
  filtered_non_action_email: "filtered email"
};

function pluralNoiseLabel(reason: string, count: number): string {
  const singular = NOISE_BUCKET_PLURAL_LABELS[reason] ?? "email";
  return count === 1 ? singular : `${singular}${singular.endsWith("s") ? "es" : "s"}`;
}

export function formatEmailIntelligenceSummaryForChat(reviews: EmailReviewItem[], timezone: string): string {
  if (reviews.length === 0) {
    return "No email reviews are waiting.";
  }

  const numbered = reviews.map((review, index) => ({ review, index: index + 1 }));
  const sourceItems: EmailIntelligenceSourceItem[] = numbered.map(({ review, index }) => ({
    id: review.id,
    index,
    subject: review.subject ?? "",
    from: review.from ?? "",
    reason: review.reason,
    proposedEventType: review.proposedEventType,
    extracted: (review.extracted ?? {}) as Record<string, unknown>,
    createdAt: review.createdAt,
    priority: review.priority
  }));

  const groups = groupEmailIntelligenceItems(sourceItems, timezone);
  const reviewsById = new Map(reviews.map((review) => [review.id, review] as const));
  const today = formatDateInTimezone(new Date(), timezone);

  const dateLabelFor = (group: (typeof groups)[number]) => (formatDateInTimezone(group.occurredAt, timezone) === today ? "today" : formatDateInTimezone(group.occurredAt, timezone));

  const lines: string[] = [`Gmail found ${reviews.length} relevant email${reviews.length === 1 ? "" : "s"}.`];

  const newApplications = groups.filter((group) => group.bucket === "count_ready" && !group.isDuplicateGroup);
  const duplicateApplications = groups.filter((group) => group.bucket === "count_ready" && group.isDuplicateGroup);
  const statusUpdates = groups.filter((group) => group.bucket === "status_update");
  const actionWorthy = groups.filter((group) => group.bucket === "action_worthy");
  const needsDecision = groups.filter((group) => group.bucket === "needs_decision");
  const noise = groups.filter((group) => group.bucket === "noise");

  if (newApplications.length > 0) {
    lines.push("", "Likely new applications:");
    for (const group of newApplications) {
      lines.push(`${group.memberIndexes[0]}. ${group.title} — ${dateLabelFor(group)}`);
    }
  }

  if (duplicateApplications.length > 0) {
    lines.push("", "Possible duplicate confirmations:");
    for (const group of duplicateApplications) {
      lines.push(`${group.memberIndexes[0]}. ${group.entity ?? group.title} — ${group.memberReviewIds.length} confirmation emails, likely 1 application`);
    }
  }

  if (statusUpdates.length > 0) {
    lines.push("", "Status updates:");
    for (const group of statusUpdates) {
      const review = reviewsById.get(group.primaryReviewId);
      const label = review ? gmailReviewSignalTypeLabel(review) : "status update";
      lines.push(`${group.memberIndexes[0]}. ${group.entity ?? group.title} ${label === "application viewed" ? "viewed your application" : label}`);
    }
  }

  if (actionWorthy.length > 0) {
    lines.push("", "Action-worthy:");
    for (const group of actionWorthy) {
      const review = reviewsById.get(group.primaryReviewId);
      const label = review ? gmailReviewSignalTypeLabel(review) : "needs review";
      lines.push(`${group.memberIndexes[0]}. ${group.title} — ${label}`);
    }
  }

  if (needsDecision.length > 0) {
    lines.push("", "Needs decision:");
    for (const group of needsDecision) {
      lines.push(`${group.memberIndexes[0]}. ${group.title} — not enough evidence to classify confidently; open details for N to see why`);
    }
  }

  if (noise.length > 0) {
    const byReason = new Map<string, number>();
    for (const group of noise) {
      const review = reviewsById.get(group.primaryReviewId);
      const reason = review?.reason ?? "unknown";
      byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
    }
    lines.push("", "Noise hidden:");
    for (const [reason, count] of byReason) {
      lines.push(`- ${count} ${pluralNoiseLabel(reason, count)}`);
    }
  }

  const totalApplications = newApplications.length + duplicateApplications.length;
  if (totalApplications > 0) {
    const rawEmailCount = newApplications.length + duplicateApplications.reduce((sum, group) => sum + group.memberReviewIds.length, 0);
    lines.push(
      "",
      "Suggested:",
      rawEmailCount === totalApplications
        ? `Count ${totalApplications} application${totalApplications === 1 ? "" : "s"}, or review details first?`
        : `Count ${totalApplications} unique application${totalApplications === 1 ? "" : "s"}, or count ${rawEmailCount} confirmation emails/manual applications?`
    );
  } else if (needsDecision.length > 0) {
    lines.push("", "Say \"details for N\" to look at any of these, or \"ignore the noise\" to clear what's left.");
  }

  lines.push("", 'Say "show raw email reviews" to see every item individually.');

  return lines.join("\n");
}

export function formatGmailReviewListForChat(
  reviews: EmailReviewItem[],
  rules: EmailSignalRule[],
  activeGoals: Goal[] = [],
  timezone = "UTC"
): string {
  if (reviews.length === 0) {
    return "No email reviews are waiting.";
  }

  const numbered = reviews.map((review, index) => ({ review, number: index + 1 }));
  const categoryOrder: GmailReviewPresentationCategory[] = ["confirmation", "noise", "needs_review"];
  const groups = categoryOrder
    .map((category) => ({
      category,
      label: gmailReviewPresentationCategoryLabel(category),
      entries: numbered.filter(({ review }) => gmailReviewPresentationCategory(review) === category)
    }))
    .filter((group) => group.entries.length > 0);

  const lines = [reviews.length === 1 ? "Pending Gmail review:" : "Pending Gmail reviews:"];
  const showGroupHeadings = groups.length > 1;

  for (const group of groups) {
    if (showGroupHeadings) {
      lines.push("", `${group.label}:`);
    }

    for (const { numbers, review } of groupSimilarEntriesForDisplay(group.entries, timezone)) {
      lines.push(gmailReviewRowLine(review, rules, activeGoals, timezone, numbers));
    }
  }

  lines.push("", gmailReviewListFooter(reviews.length, groups));

  return lines.join("\n");
}

export async function formatEmailReviewDetailsForContext(userId: string, reviewId: string): Promise<string> {
  const review = await getEmailReviewItem(userId, reviewId);

  if (!review) {
    return "I could not find that email review anymore. Run \"email reviews\" again.";
  }

  const rule = (await getEmailSignalRules(userId)).find((item) => item.id === review.ruleId);
  const goal = rule?.goalId ? (await getGoals(userId)).find((item) => item.id === rule.goalId) : undefined;

  return [
    `Email review: ${review.subject ?? rule?.name ?? "Gmail item"}`,
    review.from ? `From: ${truncatePlainText(review.from, 120)}` : undefined,
    `Tracking: ${emailReviewTrackingLabel(review)}`,
    rule ? `Rule: ${rule.name}` : undefined,
    goal ? `Linked goal: ${goal.title}` : undefined,
    `Proposed: ${emailReviewProposedOutcome(review)}`,
    `Reason: ${truncatePlainText(review.reason, 160)}`,
    review.snippet ? `Preview: ${truncatePlainText(review.snippet, 260)}` : undefined,
    review.evidence ? `Evidence: ${truncatePlainText(review.evidence, 260)}` : undefined
  ].filter(Boolean).join("\n");
}

// fix/private-alpha-email-review-detail-and-general-mail-understanding (Part 4/7): a human label
// for EmailUnderstanding's general emailKind enum — deliberately covers every domain the task lists
// (travel, invoices, insurance, admin, subscriptions, personal mail), not just the career.* event
// types humanEmailReviewEventLabel above already covers. Kept separate from that function rather
// than merged into it: humanEmailReviewEventLabel labels a review's own STORED, already-decided
// proposedEventType (a narrower, registered-event-type vocabulary); this labels the LLM
// understanding layer's freshly-reasoned, broader emailKind for one specific "details for N" call.
export function humanEmailKindLabel(kind: EmailKind): string {
  const labels: Record<EmailKind, string> = {
    application_confirmation: "application confirmation",
    recruiter_reply: "recruiter reply",
    application_viewed: "application viewed",
    interview: "interview",
    offer: "job offer",
    rejection: "rejection",
    job_alert: "job alert / listing",
    security_auth: "security / verification code",
    onboarding: "welcome / account setup",
    receipt: "receipt",
    invoice: "invoice",
    travel_booking: "travel booking",
    flight_update: "flight update",
    insurance: "insurance",
    admin_notice: "admin notice",
    appointment: "appointment",
    subscription: "subscription",
    personal_message: "personal message",
    marketing: "marketing",
    // refactor/private-alpha-general-email-intelligence-workflow (Task 2): "unknown" here means the
    // LLM understanding layer genuinely could not classify this email from the available body/
    // context — reserved for that specific case, never a lazy default. "needs details" says what's
    // actually missing (more of the body, or context this label alone can't supply) rather than the
    // old bare "uncertain signal," which stated confusion without saying what was unsure.
    unknown: "needs details"
  };

  return labels[kind] ?? "needs details";
}

/** fix/private-alpha-email-review-resolution-and-stale-classification: the general emailKind the
 * LLM understanding layer produces maps to a `reason` string always, and to a registered
 * EventTypeSchema `proposedEventType` only for the career.* kinds that already have one (the same
 * mapping ingestion.ts's own eventTypeForJobClassification uses) - every other domain (invoice,
 * travel, insurance, admin, ...) sets reason only, leaving proposedEventType undefined exactly like
 * a freshly-classified review of that kind already would, since there is no registered event type
 * for those domains yet. Used only to REFRESH stale metadata on an existing pending review (Task 3)
 * - never to decide what gmail.review.approve should log, which still always reads directly from
 * whatever the review's own (now-refreshed) proposedEventType/reason says at approval time. */
export function emailReviewClassificationFromUnderstanding(kind: EmailKind): { reason: string; proposedEventType?: string } {
  const eventTypesByKind: Partial<Record<EmailKind, string>> = {
    application_confirmation: "career.application_confirmation_received",
    recruiter_reply: "career.recruiter_reply_received",
    interview: "career.interview_scheduled",
    offer: "career.offer_received",
    rejection: "career.rejection_received"
  };
  const reasonsByKind: Partial<Record<EmailKind, string>> = {
    job_alert: "filtered_marketing",
    // fix/private-alpha-production-email-progress-truth (Task 8): a LinkedIn/job-platform account-
    // status notification ("you're no longer showing recruiters you're open to work") is classified
    // as "marketing" by understand-email.ts's own prompt guidance — grouped as noise here the same
    // way a job_alert already is, rather than falling through to "needs review" for lack of a
    // recognized noise reason.
    marketing: "filtered_marketing",
    security_auth: "security_auth",
    onboarding: "onboarding_noise"
  };

  return {
    reason: reasonsByKind[kind] ?? kind,
    proposedEventType: eventTypesByKind[kind]
  };
}

/** Human phrase for EmailUnderstanding's suggestedUserAction enum, matching the "Suggested action:"
 * line of the review-detail response (Part 2's exact template: approve / ignore / turn into action
 * / ask clarification, plus "monitor" for an informational item with nothing to decide yet). */
export function humanSuggestedActionLabel(action: EmailUnderstanding["suggestedUserAction"]): string {
  const labels: Record<EmailUnderstanding["suggestedUserAction"], string> = {
    approve: "approve",
    ignore: "ignore",
    turn_into_action: "turn into an action",
    ask_clarification: "ask you for a bit more detail before deciding",
    monitor: "keep monitoring — nothing to decide right now"
  };

  return labels[action];
}

/** fix/private-alpha-email-progress-count-and-review-ux (Task 9): a real reported bug — an email
 * clearly classified as "application confirmation" still showed "Suggested action: keep monitoring
 * — nothing to decide right now," because the detail view trusted the LLM's own free-form
 * `suggestedUserAction` enum value verbatim, and a confirmation-shaped email doesn't reliably make
 * the model pick "approve" over "monitor." The concrete next step is DERIVED from the email's own
 * classified kind here — a fact the classifier already committed to — rather than re-trusted from a
 * second, looser LLM field. `ask_clarification` (a low-confidence/needs_clarification result) always
 * wins regardless of kind, since the classifier itself said it isn't sure what this is. */
export function suggestedActionCopyForEmailKind(kind: EmailKind, understandingStatus: "ok" | "needs_clarification"): string {
  if (understandingStatus === "needs_clarification") {
    return humanSuggestedActionLabel("ask_clarification");
  }

  const copyByKind: Partial<Record<EmailKind, string>> = {
    application_confirmation: "Mark as CV sent if not already counted, or ignore if already counted.",
    recruiter_reply: "Turn this into a follow-up action, or ignore if already handled.",
    application_viewed: "Nothing to do — just a status update. Ignore, or monitor for a real reply.",
    interview: "Turn this into a follow-up action, or ignore if already handled.",
    offer: "Turn this into a follow-up action, or ignore if already handled.",
    rejection: "Log this outcome, or ignore if already noted.",
    job_alert: "Ignore — this is a listing/broadcast, not a personal reply.",
    marketing: "Ignore — this is a listing/broadcast, not a personal reply.",
    security_auth: "Ignore — this is a verification code, nothing to act on.",
    onboarding: "Ignore, unless it needs a setup step — then turn it into an action.",
    receipt: "Turn into an action if payment is due, or mark handled if already paid.",
    invoice: "Turn into an action if payment is due, or mark handled if already paid.",
    travel_booking: "Monitor, or turn into an action if it needs a response (rebooking, check-in).",
    flight_update: "Monitor, or turn into an action if it needs a response (rebooking, check-in).",
    insurance: "Turn into an action if it needs a response, otherwise monitor.",
    admin_notice: "Turn into an action if there's a deadline or appointment to keep, otherwise monitor.",
    appointment: "Turn into an action if there's a deadline or appointment to keep, otherwise monitor.",
    subscription: "Turn into an action if you want to change or cancel it, otherwise ignore.",
    personal_message: "Reply personally — nothing for me to track here."
  };

  return copyByKind[kind] ?? humanSuggestedActionLabel("ask_clarification");
}

export interface GmailReviewDetailResponseInput {
  number: number;
  title: string;
  currentClassification: string;
  linkedGoalTitle?: string;
  whyItMatters: string;
  /** fix/private-alpha-email-progress-count-and-review-ux (Task 7): already-formatted "Label:
   * value" lines (e.g. "Company: Iqana", "Applied: 1 Sep 2026") from EmailUnderstanding's
   * keyDetails (job-application-shaped) or keyFacts (every other domain) — omitted entirely when
   * neither produced anything real, never a placeholder "not available" line. */
  keyDetailLines?: string[];
  importantText: string;
  suggestedAction: string;
}

/**
 * The exact user-facing shape Part 2 specifies: a short title, the current classification, the
 * linked goal (only when one resolves), a grounded one-line explanation, the cleaned/redacted
 * important text, and the suggested next step - read-only, never itself a mutation.
 */
export function formatGmailReviewDetailResponse(input: GmailReviewDetailResponseInput): string {
  const lines = [`Review ${input.number} — ${input.title}`, `Current classification: ${input.currentClassification}`];

  if (input.linkedGoalTitle) {
    lines.push(`Linked goal: ${input.linkedGoalTitle}`);
  }

  lines.push(`Why it matters: ${input.whyItMatters}`);

  if (input.keyDetailLines && input.keyDetailLines.length > 0) {
    lines.push("Key details:", ...input.keyDetailLines.map((line) => `- ${line}`));
  }

  lines.push("Important text:", input.importantText, "Suggested action:", input.suggestedAction);

  return lines.join("\n");
}

/** fix/private-alpha-email-progress-count-and-review-ux (Task 7): turns EmailUnderstanding's
 * structured keyDetails/keyFacts into the "Key details:" bullet lines above — company/role/
 * location/status/nextStep only when the model actually stated them (never a placeholder for a
 * missing one), "Applied: <date>" formatted from the raw stated date text via
 * parseStatedDateText/formatKeyDetailDate so it reads like a real date rather than the model's raw
 * phrasing. Falls back to keyFacts verbatim for every non-job-application domain. */
// fix/private-alpha-production-email-progress-truth (Task 7): a real reported bug — the default
// detail view showed literal "Status: null" / "Next step: null" lines. The field really was absent
// (the model had nothing real to report), but a smaller model doesn't always reliably emit the JSON
// `null` type for an unset nullable field — it sometimes writes the four-character STRING "null"
// instead, which a plain truthiness check treats as present. Filters that (and other placeholder-ish
// non-answers a model can emit the same way — "n/a", "none", "unknown", or empty/whitespace) before
// treating a field as real content.
const EMPTY_DETAIL_VALUE_RE = /^\s*(null|n\/a|none|unknown|-)?\s*$/i;

function hasMeaningfulDetailValue(value: string | null | undefined): value is string {
  return typeof value === "string" && !EMPTY_DETAIL_VALUE_RE.test(value);
}

export function keyDetailLinesFromUnderstanding(understanding: Pick<EmailUnderstanding, "keyDetails" | "keyFacts">): string[] {
  const details = understanding.keyDetails;
  if (details) {
    const lines: string[] = [];
    if (hasMeaningfulDetailValue(details.company)) lines.push(`Company: ${details.company}`);
    if (hasMeaningfulDetailValue(details.role)) lines.push(`Role: ${details.role}`);
    if (hasMeaningfulDetailValue(details.location)) lines.push(`Location: ${details.location}`);
    if (hasMeaningfulDetailValue(details.appliedDate)) lines.push(`Applied: ${details.appliedDate}`);
    if (hasMeaningfulDetailValue(details.status)) lines.push(`Status: ${details.status}`);
    if (hasMeaningfulDetailValue(details.nextStep)) lines.push(`Next step: ${details.nextStep}`);
    return lines;
  }

  return (understanding.keyFacts ?? []).filter((fact) => hasMeaningfulDetailValue(fact));
}

export function emailReviewGroupLabel(kind: EmailReviewKind): string {
  if (kind === "job_search") {
    return "Job-search";
  }

  if (kind === "work_action") {
    return "Work actions";
  }

  if (kind === "custom_tracking") {
    return "Custom tracking";
  }

  return "Other";
}

export function emailReviewTrackingLabel(review: EmailReviewItem): string {
  if (review.adapterId === "job_search_email") {
    return "job-search email tracking";
  }

  if (review.adapterId === "work_action_email") {
    return "work-action email tracking";
  }

  if (review.adapterId === "custom_email_review") {
    return "custom Gmail tracking";
  }

  return "Gmail tracking";
}

export function emailReviewProposedOutcome(review: EmailReviewItem): string {
  if (isWorkActionReviewType(review.proposedEventType)) {
    return "create action";
  }

  if (review.adapterId === "custom_email_review") {
    return "review only";
  }

  if (review.proposedEventType && EventTypeSchema.safeParse(review.proposedEventType).success) {
    return `log ${humanEmailReviewEventLabel(review.proposedEventType)}`;
  }

  return review.proposedEventType ? "review only" : "unknown";
}

export function humanEmailReviewEventLabel(eventType: string): string {
  const labels: Record<string, string> = {
    "career.application_confirmation_received": "application confirmation",
    "career.recruiter_reply_received": "recruiter reply",
    "career.interview_scheduled": "interview event",
    "career.interview_completed": "completed interview",
    "career.rejection_received": "rejection",
    "career.offer_received": "job offer",
    // fix/private-alpha-gmail-classifier-precision-and-proactive-diagnostics: these are
    // safeEmailReviewProposedType's own non-eventType reason strings (server.ts) — an
    // "action required to complete your application" email was falling through to the generic
    // "event" label here, which told the user nothing. None of these ever map to a real
    // EventTypeSchema member, so approving one still can't silently create progress from an
    // action-required/portal email alone (email-review-service.ts's own approve path already
    // requires a valid EventTypeSchema proposedEventType before logging anything). A genuine
    // security/verification code email never reaches here at all — it's hard-filtered earlier
    // (server.ts's classifySecurityAuthEmailNoise, deliberately, regardless of job-application
    // context) — these two entries exist only in case that policy is ever relaxed to let one
    // through, so it still never falls back to generic "event".
    application_action_required: "application portal action required",
    security_code: "application portal / security code",
    verify_email: "application portal / verification"
  };

  return labels[eventType] ?? "event";
}
export function isWorkActionReviewType(type?: string): type is NonNullable<ActionItem["actionType"]> {
  return (
    type === "work_action_required" ||
    type === "work_deadline_detected" ||
    type === "work_follow_up_requested" ||
    type === "work_project_update_detected"
  );
}

export function actionItemInputFromEmailReview(review: EmailReviewItem): CreateActionItemInput {
  const extracted = review.extracted ?? {};
  const project = stringValue(extracted.project);
  const title = buildActionTitle(review, project);

  return {
    source: "email_review",
    sourceId: review.id,
    sourceProvider: review.provider,
    sourceRuleId: review.ruleId,
    title,
    description: buildActionDescription(review),
    priority: "medium",
    dueAt: parseActionDueAt(extracted.deadline),
    project,
    actionType: isWorkActionReviewType(review.proposedEventType) ? review.proposedEventType : "generic",
    evidence: review.evidence ?? review.snippet
  };
}

export function buildActionTitle(review: EmailReviewItem, project?: string): string {
  const subject = cleanEmailFragment(review.subject ?? "");
  const bodyText = cleanEmailFragment(extractBodyLikeText(review.evidence) || review.snippet || "");
  const securityAlertAction = securityAlertActionTitle(subject, bodyText, `${review.subject ?? ""} ${review.snippet ?? ""} ${review.evidence ?? ""} ${review.from ?? ""}`);
  const securityAdvisoryAction = securityAdvisoryActionTitle(subject, bodyText);
  const subjectAction = actionTitleFromText(subject);
  const bodyAction = actionTitleFromText(bodyText);

  if (securityAlertAction) {
    return securityAlertAction;
  }

  if (securityAdvisoryAction) {
    return securityAdvisoryAction;
  }

  if (subjectAction && !/^follow up on\b/i.test(subjectAction)) {
    return subjectAction;
  }

  if (bodyAction) {
    return bodyAction;
  }

  if (subjectAction) {
    return subjectAction;
  }

  const contextualAction = contextualActionTitleFromReview(review, subject, bodyText);

  if (contextualAction) {
    return contextualAction;
  }

  if (project) {
    return `Follow up on ${cleanActionPhrase(project)}`;
  }

  return cleanActionPhrase(review.subject ?? "Review work action");
}

/**
 * Google/provider account "security alert" notifications (new sign-in, suspicious activity —
 * "Alerta de seguridad para X", "Security alert for your account") are a different email shape
 * from a GitHub-style "security advisory" (a code vulnerability, handled separately below): there
 * is no upgrade/review-object sentence to extract an action phrase from, only a subject naming the
 * account and a snippet/evidence description of the alert. Falling through to the generic
 * actionTitleFromText/contextualActionTitleFromReview path on this shape produced a real, reported
 * bug: a raw, truncated classifier description ended up glued into the title verbatim. The fix is
 * the same pattern as securityAdvisoryActionTitle below — detect the shape early and build a
 * clean, generic title naming the actual account, never a specific provider's exact wording.
 */
function securityAlertActionTitle(subject: string, bodyText: string, rawText: string): string | undefined {
  const combined = `${subject} ${bodyText}`;
  if (!/\b(security alert|alerta de seguridad|security notification|new sign-?in|suspicious sign-?in|inicio de sesion)\b/i.test(combined)) {
    return undefined;
  }

  // The account address must come from the RAW subject/snippet/evidence/from — cleanEmailFragment
  // (used to build the already-cleaned `subject`/`bodyText` above) deliberately strips every email
  // address it finds, so by the time this runs the one address that actually matters (the account
  // the alert is ABOUT, e.g. "Alerta de seguridad para X@gmail.com") is already gone from those.
  const account = extractEmailAddressFromText(rawText);
  return account ? `Review security alert for ${account}` : "Review Gmail security alert";
}

function extractEmailAddressFromText(text: string): string | undefined {
  return text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i)?.[0];
}

function securityAdvisoryActionTitle(subject: string, bodyText: string): string | undefined {
  const combined = `${subject} ${bodyText}`;
  if (!/\bsecurity advisory\b|\bvulnerabilit(?:y|ies)\b/i.test(combined)) {
    return undefined;
  }

  const vulnerability = combined.match(/\b(ssrf|denial of service|dos|cross-site scripting|xss|remote code execution|rce)\b/i)?.[1];
  const packageName = combined.match(/\b(?:security advisory on|affects)\s+([a-z0-9.+#/-]+)\b/i)?.[1];
  const vulnerabilityLabel = vulnerability ? normalizeVulnerabilityLabel(vulnerability) : undefined;
  const packageLabel = packageName ? cleanActionObject(packageName) : undefined;

  if (vulnerabilityLabel && packageLabel) {
    return `Review ${vulnerabilityLabel} security advisory for ${packageLabel}`;
  }
  if (vulnerabilityLabel) {
    return `Review ${vulnerabilityLabel} security advisory`;
  }
  if (packageLabel) {
    return `Review security advisory for ${packageLabel}`;
  }
  return "Review security advisory";
}

function normalizeVulnerabilityLabel(value: string): string {
  const lower = value.toLowerCase();
  if (lower === "dos") return "denial of service";
  if (lower === "xss") return "XSS";
  if (lower === "rce") return "RCE";
  if (lower === "ssrf") return "SSRF";
  return lower;
}

export function buildActionDescription(review: EmailReviewItem): string | undefined {
  const text = cleanEmailFragment(`${extractBodyLikeText(review.evidence) || review.evidence || ""} ${review.snippet ?? ""}`);

  if (/send (?:me |us )?any issues/i.test(text)) {
    return "Send any issues found.";
  }

  return text.trim() ? truncatePlainText(text, 240) : undefined;
}

export function parseActionDueAt(value: unknown): Date | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }

  const dueAt = new Date(value);
  return Number.isNaN(dueAt.getTime()) ? undefined : dueAt;
}

export function cleanActionPhrase(value: string): string {
  const cleaned = value
    .replace(/&[a-z0-9#]+;/gi, " ")
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, " ")
    .replace(/\b(?:subject|from|snippet|body):.*$/i, "")
    .replace(/\s+/g, " ")
    .replace(/^follow up on\s+/i, "")
    .replace(/^the\s+/i, "")
    .trim()
    .replace(/^[\s"'`]+|[\s"'`.,;:!?]+$/g, "");

  if (!cleaned) {
    return "Review work action";
  }

  const capped = truncateActionText(cleaned, 80);
  return `${capped.charAt(0).toUpperCase()}${capped.slice(1)}`;
}

export function cleanActionObject(value: string): string {
  const cleaned = value
    .replace(/&[a-z0-9#]+;/gi, " ")
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, " ")
    .replace(/\b(?:subject|from|snippet|body):.*$/i, "")
    .replace(/\s+(?:as soon as possible|asap)\b[\s\S]*$/i, "")
    .replace(/\s+(?:after|before|by|on)\s+\w+\s+\d{1,2}(?:st|nd|rd|th)?(?:,\s*\d{4})?\b[\s\S]*$/i, "")
    .replace(/\s+/g, " ")
    .replace(/^the\s+/i, "")
    .trim()
    .replace(/^[\s"'`]+|[\s"'`.,;:!?]+$/g, "");

  return truncateActionText(cleaned || "work action", 73);
}

export function actionTitleFromText(text: string): string | undefined {
  const clean = cleanEmailFragment(text);

  if (!clean) {
    return undefined;
  }

  const upgradeObjectMatch = clean.match(/\b(?:please\s+)?upgrade\s+(.+?)\s+to\s+(.+?)(?:\s+as soon as possible|\s+before\b|\s+by\b|\s+after\b|\s+and\b|$)/i);

  if (upgradeObjectMatch?.[1] && upgradeObjectMatch[2] && !/^to$/i.test(upgradeObjectMatch[1].trim())) {
    return `Upgrade ${cleanActionObject(upgradeObjectMatch[1])} to ${cleanActionObject(upgradeObjectMatch[2])}`;
  }

  const upgradeMatch = clean.match(/\b(?:please\s+)?upgrade\s+to\s+(.+?)(?:\s+as soon as possible|\s+before\b|\s+by\b|\s+after\b|\s+and\b|$)/i);

  if (upgradeMatch?.[1]) {
    return upgradeActionTitle(upgradeMatch[1]);
  }

  const upgradeVersionMatch = clean.match(
    /\b(?:please\s+)?upgrade\s+([a-z0-9][a-z0-9.+#/-]*(?:\s+[a-z0-9][a-z0-9.+#/-]*){0,3})\s+(\d+(?:\.\d+)*)(?:\s+as soon as possible|\s+asap|\s+before\b|\s+by\b|\s+after\b|\s+and\b|[.!?]|$)/i
  );

  if (upgradeVersionMatch?.[1] && upgradeVersionMatch[2]) {
    return `Upgrade ${cleanActionObject(upgradeVersionMatch[1])} to ${upgradeVersionMatch[2]}`;
  }

  const reviewMatch = clean.match(/\b(?:please\s+)?review (?:the )?(.+?)(?:\s+by\b|\s+and\b|[.!?]|$)/i);

  if (reviewMatch?.[1]) {
    return `Review ${cleanActionObject(reviewMatch[1])}`;
  }

  const canReviewMatch = clean.match(/\bcan you review (?:the )?(.+?)(?:\s+by\b|\s+and\b|[.!?]|$)/i);

  if (canReviewMatch?.[1]) {
    return `Review ${cleanActionObject(canReviewMatch[1])}`;
  }

  const sendMatch = clean.match(/\b(?:please\s+)?send (?:me |us )?(.+?)(?:\s+by\b|\s+and\b|[.!?]|$)/i);

  if (sendMatch?.[1]) {
    return `Send ${cleanActionObject(sendMatch[1])}`;
  }

  const followUpMatch = clean.match(/\bfollow up on (.+?)(?:\s+by\b|[.!?]|$)/i);

  if (followUpMatch?.[1]) {
    return `Follow up on ${cleanActionObject(followUpMatch[1])}`;
  }

  return undefined;
}

function contextualActionTitleFromReview(review: EmailReviewItem, subject: string, bodyText: string): string | undefined {
  const from = cleanEmailFragment(review.from ?? "");
  const combined = `${subject} ${bodyText} ${from}`;

  if (/\b(?:invoice|bill|factura|recibo)\b/i.test(combined)) {
    const vendor = invoiceVendorFromText(subject) ?? invoiceVendorFromText(from);
    return vendor ? `Review ${vendor} bill` : "Review invoice";
  }

  if (/\b(?:recruiter|talent acquisition|interview|availability|available|can we talk|schedule a call|schedule an interview)\b/i.test(combined)) {
    return /\b(?:availability|available|can we talk|schedule)\b/i.test(combined)
      ? "Reply to recruiter about availability"
      : "Reply to recruiter";
  }

  return undefined;
}

function upgradeActionTitle(rawObject: string): string {
  const object = cleanActionObject(rawObject);
  const versionMatch = object.match(/^(.+?)\s+(\d+(?:\.\d+)*)$/);

  if (versionMatch?.[1] && versionMatch[2]) {
    return `Upgrade ${cleanActionObject(versionMatch[1])} to ${versionMatch[2]}`;
  }

  return `Upgrade ${object}`;
}

function truncateActionText(text: string, maxLength: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= maxLength) {
    return clean;
  }

  const slice = clean.slice(0, maxLength - 3);
  const wordBoundary = slice.search(/\s+\S*$/);
  const capped = wordBoundary > 20 ? slice.slice(0, wordBoundary) : slice;
  return `${capped.trimEnd()}...`;
}

function invoiceVendorFromText(text: string): string | undefined {
  const beforeKeyword = text.match(/^(.+?)\s+(?:invoice|bill|factura|recibo)\b/i)?.[1];
  const candidate = beforeKeyword ?? text.match(/\b(?:from|de)\s+(.+?)\s+(?:invoice|bill|factura|recibo)\b/i)?.[1];

  if (!candidate) {
    return undefined;
  }

  const cleaned = cleanActionObject(candidate.replace(/^\[[^\]]+\]\s*/, ""));
  return cleaned && !/^(your|new|monthly|latest|the)$/i.test(cleaned) ? cleaned : undefined;
}

export function extractBodyLikeText(text?: string): string | undefined {
  if (!text) {
    return undefined;
  }

  const bodyMatch = text.match(/\bBody:\s*([\s\S]*)/i);

  if (bodyMatch?.[1]) {
    return bodyMatch[1];
  }

  const lines = text
    .split(/\r?\n/)
    .filter((line) => !/^\s*(subject|from|snippet):/i.test(line));

  return lines.join("\n");
}

export function cleanEmailFragment(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, " ")
    .replace(/\b(?:subject|from|snippet|body):\s*/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
