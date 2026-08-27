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

// refactor/private-alpha-goal-driven-gmail-operator: "mute"/"unmute" added — unlike pause/resume/
// archive (which change whether a rule matches at all), these change ONLY notifyPolicy
// (packages/db's EmailSignalRule.notifyPolicy) — matches still go to review exactly as before,
// they just stop (mute) or resume (unmute) being eligible for a proactive gmail_nudge. This is
// what "make travel review-only"/"stop notifying me about flight emails"/"just put these in
// review" map to — deliberately distinct from review-only/auto-log toggling at rule-creation
// time, which genuinely still isn't supported afterward (see below).
export type GmailRuleOperation = "pause" | "resume" | "archive" | "mute" | "unmute";

export function gmailRuleOperationVerb(operation: GmailRuleOperation): string {
  if (operation === "pause") return "pause";
  if (operation === "resume") return "resume";
  if (operation === "archive") return "remove";
  if (operation === "mute") return "mute";
  return "unmute";
}

/** The rule's status/notifyPolicy once `operation` has been applied — used both to check "already
 * in that state" and to phrase the final "Done" reply. */
export function gmailRuleTargetStateLabel(operation: GmailRuleOperation): string {
  if (operation === "pause") return "paused";
  if (operation === "resume") return "active";
  if (operation === "archive") return "removed";
  if (operation === "mute") return "muted (matches still go to review, but won't send a notification)";
  return "unmuted (matches can notify you again)";
}

export function isGmailRuleAlreadyInTargetState(rule: EmailSignalRule, operation: GmailRuleOperation): boolean {
  if (operation === "pause") return rule.status === "paused";
  if (operation === "resume") return rule.status === "active";
  if (operation === "archive") return rule.status === "archived";
  if (operation === "mute") return rule.notifyPolicy !== "notify";
  return rule.notifyPolicy === "notify";
}

export function formatGmailRuleUpdateProposal(rule: EmailSignalRule, operation: GmailRuleOperation): string {
  if (operation === "pause") {
    return `You're about to pause ${rule.name}. I'll stop tracking matching emails for that rule. Reply yes to confirm or cancel.`;
  }
  if (operation === "resume") {
    return `You're about to resume ${rule.name}. I'll start tracking matching emails for that rule again. Reply yes to confirm or cancel.`;
  }
  if (operation === "archive") {
    return `You're about to remove ${rule.name}. I'll stop tracking it entirely. Reply yes to confirm or cancel.`;
  }
  if (operation === "mute") {
    return `You're about to mute ${rule.name}. Matches will still go to email review, but I won't send you a notification about them. Reply yes to confirm or cancel.`;
  }
  return `You're about to unmute ${rule.name}. I'll notify you again about its matches. Reply yes to confirm or cancel.`;
}
