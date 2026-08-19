import { EventTypeSchema, parseActionDueDate, type StoredEvent } from "@operator-agent/core";
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
import { emailReviewKind, type EmailReviewKind } from "../utils/email-review.js";
import { inferActionGoalLink } from "../utils/action-goal-link.js";
import { truncatePlainText } from "../utils/text.js";
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
    const updated = await approveEmailReviewItem(userId, review.id);

    return {
      status: "ok",
      emailReview: updated ?? review,
      event: null,
      actionItem: null,
      message: "Custom email review approved. No event or action was created."
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
    "career.rejection_received": "rejection",
    "career.offer_received": "job offer"
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
  const subjectAction = actionTitleFromText(subject);

  if (subjectAction && !/^follow up on\b/i.test(subjectAction)) {
    return subjectAction;
  }

  const bodyAction = actionTitleFromText(bodyText);

  if (bodyAction) {
    return bodyAction;
  }

  if (subjectAction) {
    return subjectAction;
  }

  if (project) {
    return `Follow up on ${cleanActionPhrase(project)}`;
  }

  return cleanActionPhrase(review.subject ?? "Review work action");
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
    .trim();

  if (!cleaned) {
    return "Review work action";
  }

  const capped = truncatePlainText(cleaned, 80);
  return `${capped.charAt(0).toUpperCase()}${capped.slice(1)}`;
}

export function cleanActionObject(value: string): string {
  const cleaned = value
    .replace(/&[a-z0-9#]+;/gi, " ")
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, " ")
    .replace(/\b(?:subject|from|snippet|body):.*$/i, "")
    .replace(/\s+/g, " ")
    .replace(/^the\s+/i, "")
    .trim();

  return truncatePlainText(cleaned || "work action", 73);
}

export function actionTitleFromText(text: string): string | undefined {
  const clean = cleanEmailFragment(text);

  if (!clean) {
    return undefined;
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
