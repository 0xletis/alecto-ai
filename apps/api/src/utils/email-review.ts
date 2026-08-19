import type { EmailReviewItem } from "@operator-agent/db";

/**
 * Generic email-review-kind classification extracted from
 * apps/api/src/server.ts, where `EmailReviewKind` and `emailReviewKind` were
 * used both across email-review formatting/sorting code that stays in
 * server.ts and by the legacy weekly-review cluster
 * (apps/api/src/legacy/weekly-review-conversation.ts), which also needs
 * them. Sibling helpers (`emailReviewKindSortIndex`, `emailReviewGroupLabel`,
 * `normalizeEmailReviewKind`, `emailReviewKindFromTarget`) stay in
 * server.ts — only the type and the one function weekly review needs moved.
 */
export type EmailReviewKind = "job_search" | "work_action" | "custom_tracking" | "other";

export function emailReviewKind(review: EmailReviewItem): EmailReviewKind {
  if (review.adapterId === "job_search_email") {
    return "job_search";
  }

  if (review.adapterId === "work_action_email") {
    return "work_action";
  }

  if (review.adapterId === "custom_email_review") {
    return "custom_tracking";
  }

  return "other";
}
