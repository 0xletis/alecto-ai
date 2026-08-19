/**
 * Generic, dependency-free string-normalization helper extracted from
 * apps/api/src/server.ts, where it was defined once privately and called
 * ~59 times for unrelated comparisons (goals, reflections, next-week plans,
 * email rules, etc.). Moved here — rather than into the new
 * apps/api/src/gmail/gmail-rule-service.ts, which also needs it — so the
 * Gmail module's own exports stay focused on Gmail-rule concerns instead of
 * re-exporting an unrelated generic utility.
 */
export function normalizeForComparison(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ");
}

/**
 * Generic title-casing helper extracted from apps/api/src/server.ts, where
 * it was used both for goal/suggestion titles and inside the legacy Gmail
 * conversation cluster (apps/api/src/legacy/gmail-conversation.ts) — moved
 * here so both call sites share one implementation instead of the Gmail
 * module reaching back into server.ts.
 */
export function sentenceLikeTitle(value: string): string {
  const title = value
    .replace(/[.!?]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);

  return title ? title.charAt(0).toUpperCase() + title.slice(1) : "";
}

/**
 * Generic "N email reviews are waiting" formatter extracted from
 * apps/api/src/server.ts, where it was called both by Gmail sync-result
 * formatting that stayed in server.ts and by the extracted legacy Gmail
 * conversation cluster — moved here so both share one implementation.
 */
export function pendingEmailReviewLine(count: number): string | undefined {
  return count > 0
    ? `${count} email review${count === 1 ? "" : "s"} ${count === 1 ? "is" : "are"} waiting. Say "email reviews" to handle ${count === 1 ? "it" : "them"}.`
    : undefined;
}

/**
 * Generic yes/no message classifiers extracted from apps/api/src/server.ts,
 * where they were used across every kind of pending-decision confirmation
 * (not just Gmail rules) — moved here so the legacy Gmail conversation
 * cluster (apps/api/src/legacy/gmail-conversation.ts) can use them without
 * importing back from server.ts.
 */
export function isConfirmationMessage(message: string): boolean {
  return /^(yes|y|ok|okay|confirm|confirmo|sí|si|dale|do it)$/i.test(message.trim());
}

export function isRejectionMessage(message: string): boolean {
  return /^(no|cancel|cancelar|nope|stop|don't|dont)$/i.test(message.trim());
}
