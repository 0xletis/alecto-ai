import {
  approveEmailReviewItem,
  confirmPendingAction,
  getEmailReviewItem,
  prisma,
  rejectPendingAction,
  type PendingAction
} from "@operator-agent/db";
import { isRecord } from "../utils/records.js";
import { normalizeForComparison, ordinalSelectionIndex, safeErrorForLog, isRejectionMessage } from "../utils/text.js";
import { uniqueStrings } from "../utils/arrays.js";
import { formatLocalDateTime } from "../utils/datetime.js";
import { getUserTimezone } from "../utils/user-timezone.js";
import { type EmailReviewKind } from "../utils/email-review.js";
import {
  approveEmailReviewForUser,
  buildEmailReviewInboxResponse,
  createActionItemFromEmailReview,
  formatEmailReviewDetailsForContext,
  rejectEmailReviewForUser,
  type EmailReviewApprovalResult,
  type EmailReviewInboxItem
} from "../email-reviews/email-review-service.js";

/**
 * Legacy email-review natural-language conversation/pending-decision
 * cluster, extracted from apps/api/src/server.ts. Resolves the
 * "email_review_context" pending action created by
 * `buildEmailReviewInboxResponse({ storeContext: true })` — free-text
 * show/approve/reject/bulk/convert-to-action replies, called from
 * server.ts's resolvePendingDecisionReply (legacy /messages/process
 * pending-decision resolver) and its own handleSemanticRouterIntent
 * `email_review_action` branch. Depends only on
 * apps/api/src/email-reviews/email-review-service.ts and already-extracted
 * utils modules. Zero dependency on server.ts.
 */

export async function resolveEmailReviewContextReply(
  userId: string,
  pendingAction: PendingAction,
  message: string
): Promise<string | undefined> {
  if (looksLikeEmailReviewInboxRequest(message)) {
    return (await buildEmailReviewInboxResponse(userId, { storeContext: true })).message;
  }

  const parsed = parseEmailReviewContextReply(message);

  if (!parsed) {
    return undefined;
  }

  if (parsed.operation === "cancel") {
    await rejectPendingAction(userId, pendingAction.id);
    return "Cancelled. I did not change anything.";
  }

  const items = readEmailReviewContextItems(pendingAction.payload.reviews);

  if (items.length === 0) {
    await rejectPendingAction(userId, pendingAction.id);
    return "No pending email reviews are visible right now. Run \"email reviews\" after Gmail finds reviews.";
  }

  if (parsed.operation === "show") {
    const item = selectEmailReviewContextItem(parsed.target, items);
    if (!item) {
      return emailReviewSelectionPrompt(items);
    }

    return formatEmailReviewDetailsForContext(userId, item.reviewId);
  }

  if (parsed.operation === "approve" || parsed.operation === "reject") {
    const lastHandledReviewIds = readEmailReviewContextHandledReviewIds(pendingAction.payload);
    const selectedItems = selectEmailReviewContextItems(parsed.target, items, parsed.bulk);

    if (selectedItems.status === "ambiguous") {
      return selectedItems.message;
    }

    const itemsToHandle = parsed.bulk && emailReviewTargetMentionsRest(parsed.target)
      ? selectedItems.items.filter((item) => !lastHandledReviewIds.has(item.reviewId))
      : selectedItems.items;

    if (itemsToHandle.length === 0) {
      return emailReviewSelectionPrompt(items);
    }

    const replies: string[] = [];
    const alreadyHandled: string[] = [];
    const handledReviewIds: string[] = [];

    for (const item of itemsToHandle) {
      const review = await getEmailReviewItem(userId, item.reviewId);

      if (!review) {
        alreadyHandled.push(`${item.number}: ${item.subject ?? item.ruleName} (not found)`);
        continue;
      }

      if (review.status !== "pending") {
        alreadyHandled.push(`${item.number}: ${item.subject ?? item.ruleName} (${review.status})`);
        continue;
      }

      if (parsed.operation === "approve") {
        const result = await approveEmailReviewForUser(userId, item.reviewId);
        replies.push(formatEmailReviewApprovalContextReply(result, item));
      } else {
        const result = await rejectEmailReviewForUser(userId, item.reviewId);
        replies.push(result.status === "ok" ? `Rejected ${item.number}: ${item.subject ?? item.ruleName}` : `Skipped ${item.number}: not found`);
      }

      handledReviewIds.push(item.reviewId);
    }

    await rememberEmailReviewContextHandled(userId, pendingAction, handledReviewIds);
    await closeEmailReviewContextIfDone(userId, pendingAction);

    return formatEmailReviewBulkContextReply(replies, alreadyHandled);
  }

  if (parsed.operation === "action") {
    const item = selectEmailReviewContextItem(parsed.target, items);
    if (!item) {
      return emailReviewSelectionPrompt(items);
    }

    const review = await getEmailReviewItem(userId, item.reviewId);
    if (!review) {
      return "I could not find that email review anymore. Run \"email reviews\" again.";
    }

    if (review.status !== "pending") {
      return `That email review is already ${review.status}. Run "email reviews" again.`;
    }

    try {
      const result = await createActionItemFromEmailReview(userId, review, { dueText: parsed.timeText });
      const updated = await approveEmailReviewItem(userId, review.id, undefined, result.actionItem.id);
      await rememberEmailReviewContextHandled(userId, pendingAction, [review.id]);
      await closeEmailReviewContextIfDone(userId, pendingAction);
      return [
        `Action ${result.created ? "created" : "already exists"} from email review: ${result.actionItem.title}`,
        result.actionItem.dueAt ? `due: ${formatLocalDateTime(result.actionItem.dueAt, await getUserTimezone(userId))}` : undefined,
        updated ? "Email review marked approved." : undefined
      ].filter(Boolean).join("\n");
    } catch (error) {
      return safeErrorForLog(error);
    }
  }

  return undefined;
}
export function readEmailReviewContextItems(value: unknown): EmailReviewInboxItem[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(isRecord)
    .map((item) => ({
      number: typeof item.number === "number" ? item.number : Number(item.number),
      reviewId: typeof item.reviewId === "string" ? item.reviewId : "",
      kind: normalizeEmailReviewKind(typeof item.kind === "string" ? item.kind : ""),
      groupLabel: typeof item.groupLabel === "string" ? item.groupLabel : "Other",
      ruleName: typeof item.ruleName === "string" ? item.ruleName : "Gmail tracking",
      trackingLabel: typeof item.trackingLabel === "string" ? item.trackingLabel : "Gmail tracking",
      from: typeof item.from === "string" ? item.from : undefined,
      subject: typeof item.subject === "string" ? item.subject : undefined,
      snippet: typeof item.snippet === "string" ? item.snippet : undefined,
      evidence: typeof item.evidence === "string" ? item.evidence : undefined,
      proposedEventType: typeof item.proposedEventType === "string" ? item.proposedEventType : undefined,
      proposedOutcome: typeof item.proposedOutcome === "string" ? item.proposedOutcome : "unknown",
      goalTitle: typeof item.goalTitle === "string" ? item.goalTitle : undefined,
      confidence: typeof item.confidence === "number" ? item.confidence : 0,
      createdAt: typeof item.createdAt === "string" ? item.createdAt : ""
    }))
    .filter((item) => Number.isFinite(item.number) && item.number > 0 && item.reviewId);
}

export function readEmailReviewContextHandledReviewIds(payload: unknown): Set<string> {
  if (!isRecord(payload) || !Array.isArray(payload.lastHandledReviewIds)) {
    return new Set();
  }

  return new Set(payload.lastHandledReviewIds.filter((value): value is string => typeof value === "string" && value.length > 0));
}

export async function rememberEmailReviewContextHandled(
  userId: string,
  pendingAction: PendingAction,
  reviewIds: string[]
): Promise<void> {
  if (reviewIds.length === 0 || !isRecord(pendingAction.payload)) {
    return;
  }

  const handledIds = uniqueStrings([...readEmailReviewContextHandledReviewIds(pendingAction.payload), ...reviewIds]);
  await prisma.pendingAction.updateMany({
    where: {
      id: pendingAction.id,
      userId,
      status: "pending"
    },
    data: {
      payload: {
        ...pendingAction.payload,
        lastHandledReviewIds: handledIds
      }
    }
  });
}

export function emailReviewTargetMentionsRest(target: string): boolean {
  return /\b(rest|remaining|left|the rest|los dem[aá]s|las dem[aá]s|el resto|la resta)\b/i.test(target);
}

export function formatEmailReviewBulkContextReply(changed: string[], alreadyHandled: string[]): string {
  const lines: string[] = [];

  if (changed.length > 0) {
    lines.push(...changed);
  } else if (alreadyHandled.length > 0) {
    lines.push("No pending matching reviews changed.");
  }

  if (alreadyHandled.length > 0) {
    lines.push("Already handled:");
    lines.push(...alreadyHandled.map((line) => `- ${line}`));
  }

  return lines.join("\n");
}

export function normalizeEmailReviewKind(value: string): EmailReviewKind {
  return value === "job_search" || value === "work_action" || value === "custom_tracking" ? value : "other";
}

export function parseEmailReviewContextReply(message: string):
  | { operation: "cancel" }
  | { operation: "show"; target: string }
  | { operation: "approve" | "reject"; target: string; bulk: boolean }
  | { operation: "action"; target: string; timeText?: string }
  | undefined {
  const trimmed = message.trim();
  const text = normalizeForComparison(trimmed);

  if (!trimmed) {
    return undefined;
  }

  if (isRejectionMessage(trimmed) || /^(cancel|cancelar|cancela|stop)$/i.test(trimmed)) {
    return { operation: "cancel" };
  }

  const showMatch = trimmed.match(/^(?:show|details?(?:\s+for)?|what\s+is|explain|muestra|ensen(?:a|ame)|ens[eé]ñ(?:a|ame)|detalles?(?:\s+de)?|que\s+es|qué\s+es)\s+(.+)$/i);
  if (showMatch?.[1] && extractEmailReviewReference(showMatch[1])) {
    return { operation: "show", target: showMatch[1].trim() };
  }

  const approveBulk = trimmed.match(/^(?:approve|accept|ok|yes|aprueba|acepta)\s+all(?:\s+(.+))?$/i);
  if (approveBulk) {
    return { operation: "approve", target: cleanEmailReviewBulkTarget(approveBulk[1]) || "all", bulk: true };
  }

  const rejectBulk = trimmed.match(/^(?:reject|clear|dismiss|no|rechaza|descarta|borra|limpia)\s+all(?:\s+(.+))?$/i);
  if (rejectBulk) {
    return { operation: "reject", target: cleanEmailReviewBulkTarget(rejectBulk[1]) || "all", bulk: true };
  }

  const approveMatch = trimmed.match(/^(?:approve\s+review|approve|accept|yes\s+to|ok\s+to|aprueba|acepta|si\s+a|sí\s+a)\s+(.+)$/i);
  if (approveMatch?.[1]) {
    return { operation: "approve", target: approveMatch[1].trim(), bulk: false };
  }

  const rejectMatch = trimmed.match(/^(?:reject\s+review|reject|no\s+to|dismiss|clear|rechaza|descarta|no\s+a)\s+(.+)$/i);
  if (rejectMatch?.[1]) {
    return { operation: "reject", target: rejectMatch[1].trim(), bulk: false };
  }

  const actionNumber = extractEmailReviewActionReference(trimmed);
  if (actionNumber) {
    return {
      operation: "action",
      target: actionNumber,
      timeText: extractEmailReviewActionTimeText(trimmed)
    };
  }

  if (/^#?\d+$/.test(trimmed) || ordinalSelectionIndex(trimmed) !== undefined) {
    return { operation: "show", target: trimmed };
  }

  if (/\b(email|gmail|correo|correu|review|revision|revisi[oó])\b/.test(text) && /\b(approve|reject|show|details|action|task|aprueba|rechaza|muestra|tarea)\b/.test(text)) {
    return { operation: "show", target: trimmed };
  }

  return undefined;
}

export function cleanEmailReviewBulkTarget(value: string | undefined): string {
  if (!value) {
    return "";
  }

  return value
    .trim()
    .replace(/\s+(?:reviews?|items?|correos?|correus?)$/i, "")
    .trim();
}

export function extractEmailReviewReference(message: string): string | undefined {
  const numeric = message.match(/(?:^|\s)#?(\d+)(?:\b|$)/);
  if (numeric?.[1]) {
    return numeric[1];
  }

  const ordinal = ordinalSelectionIndex(message);
  return ordinal !== undefined ? String(ordinal + 1) : undefined;
}

export function extractEmailReviewActionReference(message: string): string | undefined {
  const trimmed = message.trim();
  const patterns = [
    /\b(?:turn|make|convert)\s+(?:review\s+|email\s+review\s+)?#?(\d+)\s+(?:into|to)\s+(?:an?\s+|the\s+)?(?:action|task|reminder)\b/i,
    /\b(?:turn|make|convert)\s+(?:review\s+|email\s+review\s+)?#?(\d+)\s+(?:an?\s+|the\s+)?(?:action|task|reminder)\b/i,
    /\b(?:create|make|add|haz|crea)\s+(?:an?\s+)?(?:action|task|tarea|reminder)\s+(?:from|for|about|de|para|sobre)\s+(?:review\s+|email\s+review\s+)?#?(\d+)\b/i,
    /\b(?:remind|reminder|recorda|recordam|recu[eé]rdame|recordarme)\b.*\b(?:about|for|de|para|sobre)\s+(?:review\s+|email\s+review\s+)?#?(\d+)\b/i
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match?.[1]) {
      return match[1];
    }
  }

  const ordinal = ordinalSelectionIndex(trimmed);
  if (
    ordinal !== undefined &&
    /\b(?:turn|make|convert|create|add|action|task|remind|reminder|haz|crea|tarea|recorda|recordam|recu[eé]rdame|recordarme)\b/i.test(trimmed)
  ) {
    return String(ordinal + 1);
  }

  return undefined;
}

export function extractEmailReviewActionTimeText(message: string): string | undefined {
  const match = message.match(/\b(now|today.*|tomorrow.*|tonight.*|in\s+\d+\s+days?|next\s+\w+.*|\d{4}-\d{2}-\d{2}.*)$/i);
  return match?.[1]?.trim();
}

export function selectEmailReviewContextItem(target: string, items: EmailReviewInboxItem[]): EmailReviewInboxItem | undefined {
  const selected = selectEmailReviewContextItems(target, items, false);
  return selected.status === "ok" && selected.items.length === 1 ? selected.items[0] : undefined;
}

export function selectEmailReviewContextItems(
  target: string,
  items: EmailReviewInboxItem[],
  bulk: boolean
): { status: "ok"; items: EmailReviewInboxItem[] } | { status: "ambiguous"; message: string } {
  const trimmed = target.trim().replace(/[?.!]+$/g, "");
  const numeric = trimmed.match(/^#?(\d+)$/);

  if (numeric) {
    const index = Number(numeric[1]);
    return { status: "ok", items: items.filter((item) => item.number === index) };
  }

  const ordinalIndex = ordinalSelectionIndex(trimmed);
  if (ordinalIndex !== undefined) {
    return { status: "ok", items: items.filter((item) => item.number === ordinalIndex + 1) };
  }

  const text = normalizeForComparison(trimmed);
  const matchText = cleanEmailReviewSelectionTarget(trimmed);

  if (bulk && (text === "all" || text === "all reviews" || text === "todos" || text === "todas" || text === "tots" || text === "totes")) {
    const kinds = new Set(items.map((item) => item.kind));
    if (kinds.size === 1) {
      return { status: "ok", items };
    }

    return {
      status: "ambiguous",
      message: "Which group do you mean? Try: approve all job-search reviews, reject all custom reviews, or reject all Endesa reviews."
    };
  }

  const kind = emailReviewKindFromTarget(text);
  if (kind) {
    return { status: "ok", items: items.filter((item) => item.kind === kind) };
  }

  const matches = items.filter((item) => emailReviewContextItemMatches(item, matchText || text));
  if (!bulk && matches.length > 1) {
    return {
      status: "ambiguous",
      message: [
        "Which email review do you mean?",
        ...matches.slice(0, 5).map((item) => `${item.number}. ${item.subject ?? item.ruleName}`)
      ].join("\n")
    };
  }

  return { status: "ok", items: matches };
}

export function cleanEmailReviewSelectionTarget(target: string): string {
  return normalizeForComparison(target)
    .replace(/\b(the|rest|remaining|left|all|reviews?|items?|emails?|email|gmail|mail|mails|correos?|correus?|from|about|for|de|del|dels|para|sobre)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function emailReviewKindFromTarget(text: string): EmailReviewKind | undefined {
  if (/\b(job|career|recruiter|application|interview|trabajo|feina)\b/.test(text)) {
    return "job_search";
  }

  if (/\b(work|action|deadline|client|project|trabajo|feina|tasca)\b/.test(text)) {
    return "work_action";
  }

  if (/\b(custom|tracking|personalizado|personalitzada)\b/.test(text)) {
    return "custom_tracking";
  }

  return undefined;
}

export function emailReviewContextItemMatches(item: EmailReviewInboxItem, targetKey: string): boolean {
  if (!targetKey) {
    return false;
  }

  const haystack = normalizeForComparison([
    item.ruleName,
    item.subject,
    item.from,
    item.trackingLabel,
    item.groupLabel,
    item.goalTitle
  ].filter(Boolean).join(" "));

  return haystack.includes(targetKey) || targetKey.includes(normalizeForComparison(item.ruleName));
}

export function emailReviewSelectionPrompt(items: EmailReviewInboxItem[]): string {
  return items.length > 0
    ? `Reply with 1-${items.length}, a visible subject, or run "email reviews" again.`
    : "Run \"email reviews\" again so I can number the visible items safely.";
}

export function formatEmailReviewApprovalContextReply(result: EmailReviewApprovalResult, item: EmailReviewInboxItem): string {
  if (result.status === "not_found") {
    return `Skipped ${item.number}: not found`;
  }

  if (result.status === "not_pending") {
    return `Skipped ${item.number}: already ${result.review.status}`;
  }

  return `Approved ${item.number}: ${result.message.replace(/^Email review approved\.?\s*/i, "")}`;
}

export async function closeEmailReviewContextIfDone(userId: string, pendingAction: PendingAction): Promise<void> {
  const items = readEmailReviewContextItems(pendingAction.payload.reviews);
  const statuses = await Promise.all(items.map((item) => getEmailReviewItem(userId, item.reviewId)));
  const hasPendingVisibleItem = statuses.some((item) => item?.status === "pending");

  if (!hasPendingVisibleItem) {
    await confirmPendingAction(userId, pendingAction.id);
  }
}

export function isPendingEmailReviewContext(pendingAction: PendingAction | undefined): boolean {
  return Boolean(
    pendingAction &&
      pendingAction.status === "pending" &&
      pendingAction.type === "email_review_context" &&
      isRecord(pendingAction.payload) &&
      pendingAction.payload.operation === "email_review_context"
  );
}

export function looksLikeEmailReviewInboxRequest(message: string): boolean {
  const text = normalizeForComparison(message);

  return (
    /^(email reviews?|gmail reviews?|emails? to review|show email reviews?|show gmail reviews?)$/.test(text) ||
    /\b(what|which|any|show|review|revisa|mostra|ensenya|quins?|que|qué)\b.*\b(email|emails|gmail|correo|correos|correu|correus)\b.*\b(review|approval|pending|waiting|pendientes?|pendents?|revisar|aprobaci[oó]n)\b/.test(text) ||
    /\b(correos pendientes|correus pendents|emails waiting|gmail items need review|emails need review|needs email approval)\b/.test(text)
  );
}
export function looksLikeEmailReviewContextAction(message: string): boolean {
  const trimmed = message.trim();

  if (!trimmed) {
    return false;
  }

  if (/^#?\d+$/.test(trimmed) || ordinalSelectionIndex(trimmed) !== undefined) {
    return true;
  }

  return (
    /^(?:show|details?(?:\s+for)?|what\s+is|explain|muestra|detalles?(?:\s+de)?|que\s+es|qué\s+es)\s+#?\d+[?.!]?$/i.test(trimmed) ||
    /^(?:approve\s+review|approve|accept|yes\s+to|ok\s+to|aprueba|acepta|si\s+a|sí\s+a)\s+(?:#?\d+|all\b.*|job|job-search|work|custom|endesa|aigues|aigües)/i.test(trimmed) ||
    /^(?:reject\s+review|reject|no\s+to|dismiss|clear|rechaza|descarta|no\s+a)\s+(?:#?\d+|all\b.*|job|job-search|work|custom|endesa|aigues|aigües)/i.test(trimmed) ||
    Boolean(extractEmailReviewActionReference(trimmed))
  );
}
