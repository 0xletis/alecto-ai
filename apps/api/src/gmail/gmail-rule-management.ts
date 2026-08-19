import type { EmailSignalRule } from "@operator-agent/db";

/**
 * Pure Gmail rule-MUTATION helpers (as opposed to gmail-rule-service.ts's
 * listing/grouping/formatting) — supported operations, plain-language
 * descriptions, and target-state checks for the three rule changes actually
 * backed by existing DB behavior: pause, resume, and remove (archive).
 * Deliberately does NOT include review-only/auto-log toggling for an
 * existing rule — that value is fixed at rule-creation time only
 * (apps/api/src/legacy/gmail-conversation.ts's conversationEmailRuleInputForKind,
 * custom rules' hardcoded reviewBeforeLogging: true) and there is no
 * existing conversational or HTTP path that changes it afterward, so it
 * isn't "existing domain behavior" this module can safely expose.
 *
 * New, non-legacy module (nothing here existed as a single reusable unit
 * before — legacy/gmail-conversation.ts's manageCustomGmailRuleForConversation
 * inlines the equivalent logic entangled with PendingAction/SemanticRouterResult
 * conversation state) so Agent Runtime v3 can apply the same three mutations
 * without importing from legacy/*. The actual target-name matching
 * (findEmailRulesByTarget) and DB mutations (updateEmailSignalRule/
 * archiveEmailSignalRule) were already non-legacy before this module existed
 * and are used directly, not duplicated.
 */

export type GmailRuleOperation = "pause" | "resume" | "archive";

export function gmailRuleOperationVerb(operation: GmailRuleOperation): string {
  if (operation === "pause") return "pause";
  if (operation === "resume") return "resume";
  return "remove";
}

/** The rule's status once `operation` has been applied — used both to check "already in that state" and to phrase the final "Done" reply. */
export function gmailRuleTargetStateLabel(operation: GmailRuleOperation): string {
  if (operation === "pause") return "paused";
  if (operation === "resume") return "active";
  return "removed";
}

export function isGmailRuleAlreadyInTargetState(rule: EmailSignalRule, operation: GmailRuleOperation): boolean {
  if (operation === "pause") return rule.status === "paused";
  if (operation === "resume") return rule.status === "active";
  return rule.status === "archived";
}

export function formatGmailRuleUpdateProposal(rule: EmailSignalRule, operation: GmailRuleOperation): string {
  if (operation === "pause") {
    return `You're about to pause ${rule.name}. I'll stop tracking matching emails for that rule. Reply yes to confirm or cancel.`;
  }
  if (operation === "resume") {
    return `You're about to resume ${rule.name}. I'll start tracking matching emails for that rule again. Reply yes to confirm or cancel.`;
  }
  return `You're about to remove ${rule.name}. I'll stop tracking it entirely. Reply yes to confirm or cancel.`;
}
