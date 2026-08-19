import { getEmailSignalRules, getIntegrationConnections, type EmailSignalRule } from "@operator-agent/db";
import { sortEmailRuleCandidates } from "../conversation/email-rule-selection.js";
import { normalizeForComparison } from "../utils/text.js";

/**
 * Pure Gmail rule-management helpers extracted from apps/api/src/server.ts.
 * Contains only rule listing/grouping/formatting logic with zero OAuth,
 * token, sync, or raw provider API dependencies — those stay in server.ts
 * (see docs/09-architecture-inventory.md's Gmail rule service extraction
 * entry for the full boundary rationale). `isBuiltInEmailAdapter` is
 * exported because server.ts's Gmail sync code also needs it; every other
 * export here is used by `applyPendingAction`'s custom_email_rule branch
 * and/or the legacy Gmail conversation handlers.
 */

export function isBuiltInEmailAdapter(adapterId: string): boolean {
  return adapterId === "job_search_email" || adapterId === "work_action_email";
}

export interface EmailRuleHumanDisplayGroup {
  primary: EmailSignalRule;
  rules: EmailSignalRule[];
}

export function groupEmailRulesForHumanDisplay(rules: EmailSignalRule[]): EmailRuleHumanDisplayGroup[] {
  const groups = new Map<string, EmailRuleHumanDisplayGroup>();

  for (const rule of sortEmailRuleCandidates(rules)) {
    const key = emailRuleHumanDisplayKey(rule);
    const existing = groups.get(key);

    if (existing) {
      existing.rules.push(rule);
    } else {
      groups.set(key, { primary: rule, rules: [rule] });
    }
  }

  return [...groups.values()];
}

function emailRuleHumanDisplayKey(rule: EmailSignalRule): string {
  if (isBuiltInEmailAdapter(rule.adapterId)) {
    return [
      "builtin",
      rule.connectionId,
      rule.adapterId,
      rule.status,
      normalizeForComparison(rule.query ?? "")
    ].join("|");
  }

  return `rule:${rule.id}`;
}

export function formatGmailEmailRuleSelectionLines(rules: EmailSignalRule[], options: { showStatus?: boolean } = {}): string[] {
  return groupEmailRulesForHumanDisplay(rules).map((group) => {
    const parts = [
      group.primary.name,
      options.showStatus && group.primary.status !== "active" ? group.primary.status : undefined,
      group.rules.length > 1 ? `${group.rules.length} duplicate rules` : undefined
    ];

    return `- ${parts.filter(Boolean).join(" - ")}`;
  });
}

export async function getVisibleGmailEmailRules(userId: string): Promise<EmailSignalRule[]> {
  const [rules, connections] = await Promise.all([getEmailSignalRules(userId), getIntegrationConnections(userId)]);
  const gmailConnectionIds = new Set(
    connections
      .filter((connection) => connection.integrationId === "gmail" && connection.status !== "archived")
      .map((connection) => connection.id)
  );

  return rules.filter((rule) => rule.status !== "archived" && gmailConnectionIds.has(rule.connectionId));
}
