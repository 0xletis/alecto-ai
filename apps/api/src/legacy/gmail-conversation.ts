import { getEmailAdapterDefinition, isRiskControlGoal, type Goal, type SemanticRouterResult } from "@operator-agent/core";
import {
  archiveEmailSignalRule,
  createEmailSignalRule,
  getActiveGoals,
  getEmailSignalRules,
  getGoals,
  getIntegrationConnections,
  getLatestPendingAction,
  getPendingEmailReviewCount,
  replacePendingAction,
  updateEmailSignalRule,
  updateEmailSignalRuleDefinition,
  type EmailSignalRule,
  type PendingAction
} from "@operator-agent/db";
import {
  buildGmailAutonomyState,
  formatIntervalMinutes,
  gmailRuleBehaviorLabel,
  gmailSyncModeSentence,
  gmailSyncModeShortLabel
} from "../conversation/gmail-autonomy.js";
import {
  cleanEmailRuleTarget,
  findEmailRulesByTarget as findSelectableEmailRulesByTarget,
  resolveMultipleEmailRuleTargets,
  sortEmailRuleCandidates,
  splitEmailRuleTargets,
  toEmailRuleSelectionCandidate
} from "../conversation/email-rule-selection.js";
import {
  archiveStaleJobSearchEmailRules,
  formatGmailEmailRuleSelectionLines,
  getVisibleGmailEmailRules,
  groupEmailRulesForHumanDisplay,
  isBuiltInEmailAdapter,
  type EmailRuleHumanDisplayGroup
} from "../gmail/gmail-rule-service.js";
import { pendingDecisionExpiry } from "../utils/datetime.js";
import { arrayOfStrings, uniqueStrings } from "../utils/arrays.js";
import { isRecord, stringFromRecord } from "../utils/records.js";
import {
  isConfirmationMessage,
  isRejectionMessage,
  normalizeForComparison,
  pendingEmailReviewLine,
  sentenceLikeTitle
} from "../utils/text.js";

/**
 * Legacy Gmail natural-language conversation cluster, extracted from
 * apps/api/src/server.ts. Handles free-text Gmail rule creation/editing,
 * pronoun/target resolution against active rules, Gmail setup/status
 * replies, and Gmail autonomy-preference parsing for the legacy
 * /messages/process pipeline (handleSemanticRouterIntent,
 * detectDeterministicSemanticRouterIntent, detectConversationSurfaceIntent).
 * Agent Runtime v3 (apps/api/src/agent-runtime/) does not use this module —
 * it has its own independent Gmail handling. See
 * docs/09-architecture-inventory.md's "Legacy Gmail Conversation Cluster
 * Extraction" for what moved here and what stayed in server.ts (Gmail
 * sync-triggering and the shared, non-Gmail-specific dispatchers).
 */

export function noActiveGmailRulesMessage(): string {
  return "Gmail is connected, but no email tracking rules are active. Say 'enable job search rule for Gmail', 'enable work action rule for Gmail', or 'track Endesa bills from Gmail'.";
}

export async function formatEmailRulesForConversation(userId: string, message?: string): Promise<string> {
  const [connections, rules, goals, pendingReviewCount, autonomyState] = await Promise.all([
    getIntegrationConnections(userId),
    getEmailSignalRules(userId),
    getGoals(userId),
    getPendingEmailReviewCount(userId),
    buildGmailAutonomyState(userId)
  ]);
  const gmailConnections = connections.filter((connection) => connection.integrationId === "gmail" && connection.status !== "archived");

  if (gmailConnections.length === 0) {
    return "Gmail is not connected yet. Say 'connect Gmail' or use /connect_gmail.";
  }

  const connectionById = new Map(gmailConnections.map((connection) => [connection.id, connection]));
  const visibleRules = rules.filter((rule) => rule.status !== "archived" && connectionById.has(rule.connectionId));
  const activeRules = visibleRules.filter((rule) => rule.status === "active");
  const wantsActiveOnly = message
    ? /\b(on|active|enabled|running|now)\b/.test(normalizeForComparison(message))
    : false;

  if (visibleRules.length === 0) {
    return noActiveGmailRulesMessage();
  }

  const goalById = new Map(goals.map((goal) => [goal.id, goal.title]));
  const activeLines = groupEmailRulesForHumanDisplay(activeRules).map((group) =>
    formatEmailRuleConversationGroupLine(group, goalById)
  );
  const pausedLines = wantsActiveOnly
    ? []
    : groupEmailRulesForHumanDisplay(visibleRules.filter((rule) => rule.status !== "active")).map((group) =>
        formatEmailRuleConversationGroupLine(group, goalById)
      );
  const hiddenInactiveCount = wantsActiveOnly ? visibleRules.length - activeRules.length : 0;

  await maybeRememberGmailRuleConversationContext(userId, visibleRules, activeRules.length === 1 ? activeRules[0] : undefined);

  return [
    wantsActiveOnly ? "Email rules currently on:" : "Email rules currently configured:",
    "",
    activeLines.length > 0 ? "On:" : undefined,
    ...(activeLines.length > 0 ? activeLines.map((line) => `- ${line}`) : ["No active email rules."]),
    pausedLines.length > 0 ? "" : undefined,
    pausedLines.length > 0 ? "Paused/error:" : undefined,
    ...pausedLines.map((line) => `- ${line}`),
    "",
    `Mode: ${gmailSyncModeShortLabel(autonomyState)}. Manual sync: say 'sync Gmail'.`,
    `Review notifications: ${autonomyState.reviewNotificationEnabled ? "on" : "off"}.`,
    pendingEmailReviewLine(pendingReviewCount),
    hiddenInactiveCount > 0 ? `${hiddenInactiveCount} paused/error rule${hiddenInactiveCount === 1 ? " is" : "s are"} hidden here.` : undefined,
    "Full IDs and settings: /my_email_rules"
  ].filter((line) => line !== undefined).join("\n");
}

export function formatEmailRuleConversationLine(rule: EmailSignalRule, goalById: Map<string, string>): string {
  const goalTitle = rule.goalId ? goalById.get(rule.goalId) : undefined;
  const parts = [
    rule.name,
    rule.status !== "active" ? rule.status : undefined,
    emailRuleConversationBehavior(rule),
    `looks for: ${formatEmailRuleQueryForHumans(rule.query)}`,
    goalTitle ? `goal: ${goalTitle}` : undefined
  ];

  return parts.filter(Boolean).join(" - ");
}

export function formatEmailRuleConversationGroupLine(
  group: EmailRuleHumanDisplayGroup,
  goalById: Map<string, string>
): string {
  const line = formatEmailRuleConversationLine(group.primary, goalById);

  if (group.rules.length <= 1) {
    return line;
  }

  return `${line} - ${group.rules.length} duplicate rules; shown once`;
}

export function emailRuleConversationBehavior(rule: EmailSignalRule): string {
  if (rule.adapterId === "custom_email_review") {
    return "custom tracking, review first, auto-log off";
  }

  if (rule.adapterId === "work_action_email") {
    return "work actions, review first";
  }

  if (rule.adapterId === "job_search_email") {
    return rule.reviewBeforeLogging ? "job search, review first" : "job search, auto-log clear matches";
  }

  return rule.reviewBeforeLogging ? "review first" : "auto-log clear matches";
}

export async function maybeRememberGmailRuleConversationContext(
  userId: string,
  rules: EmailSignalRule[],
  focusedRule?: EmailSignalRule
): Promise<void> {
  const contextRules = rules
    .filter((rule) => rule.status !== "archived")
    .slice(0, 10);

  if (contextRules.length === 0) {
    return;
  }

  const latestPending = await getLatestPendingAction(userId);
  if (latestPending && !isPendingCustomGmailRuleContext(latestPending)) {
    return;
  }

  const goals = await getGoals(userId);
  const goalById = new Map(goals.map((goal) => [goal.id, goal.title]));

  await replacePendingAction(userId, {
    type: "custom_email_rule",
    summary: focusedRule ? `Gmail rule context: ${focusedRule.name}` : "Gmail rule context",
    payload: {
      operation: "rule_context",
      focusedRuleId: focusedRule?.id,
      rules: contextRules.map((rule) => ({
        id: rule.id,
        adapterId: rule.adapterId,
        name: rule.name,
        query: rule.query,
        status: rule.status,
        goalTitle: rule.goalId ? goalById.get(rule.goalId) ?? null : null
      }))
    },
    expiresAt: pendingDecisionExpiry()
  });
}

export async function enableEmailRuleForConversation(userId: string, kind: "job_search" | "work_action"): Promise<string> {
  const gmailConnection = (await getIntegrationConnections(userId)).find(
    (connection) => connection.integrationId === "gmail" && connection.status === "active"
  );

  if (!gmailConnection) {
    return "Gmail is not connected yet. Say 'connect Gmail' or use /connect_gmail.";
  }

  const adapterId = kind === "work_action" ? "work_action_email" : "job_search_email";
  const adapter = getEmailAdapterDefinition(adapterId);

  if (!adapter || adapter.status !== "available") {
    return "That email rule is not available yet.";
  }

  if (adapter.id === "job_search_email") {
    await archiveStaleJobSearchEmailRules(userId, gmailConnection.id);
  }

  const reusedRule = await reactivateOrReuseBuiltInEmailRule(userId, gmailConnection.id, adapter.id);

  if (reusedRule) {
    const actionLine = reusedRule.wasReactivated
      ? `${emailRuleHumanTitle(kind)} is back on.`
      : `${emailRuleHumanTitle(kind)} is already on.`;
    const duplicateLine =
      reusedRule.archivedDuplicateCount > 0
        ? `I archived ${reusedRule.archivedDuplicateCount} duplicate built-in rule${reusedRule.archivedDuplicateCount === 1 ? "" : "s"}.`
        : undefined;

    return [actionLine, duplicateLine, "", formatConversationEmailRuleEnabled(reusedRule.rule)].filter(Boolean).join("\n");
  }

  const input = conversationEmailRuleInputForKind(kind);
  const rule = await createEmailSignalRule(userId, {
    connectionId: gmailConnection.id,
    adapterId,
    name: input.name,
    reviewBeforeLogging: input.reviewBeforeLogging,
    fetchStrategy: input.fetchStrategy,
    classifierMode: input.classifierMode,
    lookbackDays: input.lookbackDays,
    maxMessagesPerSync: input.maxMessagesPerSync,
    maxEventsPerSync: input.maxEventsPerSync,
    minAutoLogConfidence: input.minAutoLogConfidence,
    minReviewConfidence: input.minReviewConfidence,
    query: adapter.defaultQuery ?? "",
    createdBy: "user"
  });

  return `${emailRuleHumanTitle(kind)} is on.\n\n${formatConversationEmailRuleEnabled(rule)}`;
}

export function conversationEmailRuleInputForKind(kind: "job_search" | "work_action") {
  if (kind === "work_action") {
    return {
      name: "Work action emails",
      reviewBeforeLogging: true,
      fetchStrategy: "query" as const,
      classifierMode: "hybrid" as const,
      lookbackDays: 7,
      maxMessagesPerSync: 25,
      maxEventsPerSync: 5,
      minAutoLogConfidence: 0.95,
      minReviewConfidence: 0.7
    };
  }

  return {
    name: "Job search emails",
    reviewBeforeLogging: false,
    fetchStrategy: "query" as const,
    classifierMode: "rules" as const,
    lookbackDays: 30,
    maxMessagesPerSync: 25,
    maxEventsPerSync: 10,
    minAutoLogConfidence: 0.9,
    minReviewConfidence: 0.65
  };
}

export function formatConversationEmailRuleEnabled(rule: EmailSignalRule): string {
  const isWorkAction = rule.adapterId === "work_action_email";
  const watchItems = isWorkAction
    ? ["work requests", "deadlines", "follow-ups", "feedback requests", "blockers"]
    : ["recruiter replies", "interview scheduling", "rejections", "offers", "application confirmations"];

  return [
    "What I will watch for:",
    ...watchItems.map((item) => `- ${item}`),
    "",
    isWorkAction
      ? "Work-action emails go to review before becoming action items."
      : "Clear job-search emails can become career events. Uncertain emails go to review.",
    "I only scan Gmail while this rule is active.",
    "Sync now: sync Gmail",
    "See rules: /my_email_rules"
  ].join("\n");
}

export function emailRuleHumanTitle(kind: "job_search" | "work_action"): string {
  return kind === "work_action" ? "Work-action email tracking" : "Job-search email tracking";
}

export async function reactivateOrReuseBuiltInEmailRule(
  userId: string,
  connectionId: string,
  adapterId: string
): Promise<{ rule: EmailSignalRule; wasReactivated: boolean; archivedDuplicateCount: number } | undefined> {
  if (!isBuiltInEmailAdapter(adapterId)) {
    return undefined;
  }

  const matchingRules = (await getEmailSignalRules(userId)).filter(
    (rule) =>
      rule.status !== "archived" &&
      rule.connectionId === connectionId &&
      rule.adapterId === adapterId
  );

  if (matchingRules.length === 0) {
    return undefined;
  }

  const primary = choosePrimaryBuiltInEmailRule(matchingRules);
  const wasReactivated = primary.status !== "active";
  const activePrimary = wasReactivated
    ? await updateEmailSignalRule(userId, primary.id, { status: "active" })
    : primary;

  if (!activePrimary) {
    return undefined;
  }

  let archivedDuplicateCount = 0;

  for (const rule of matchingRules) {
    if (rule.id === primary.id) {
      continue;
    }

    const archived = await archiveEmailSignalRule(userId, rule.id);
    if (archived) {
      archivedDuplicateCount += 1;
    }
  }

  return { rule: activePrimary, wasReactivated, archivedDuplicateCount };
}

export function choosePrimaryBuiltInEmailRule(rules: EmailSignalRule[]): EmailSignalRule {
  return [...rules].sort((left, right) => {
    const leftActive = left.status === "active" ? 1 : 0;
    const rightActive = right.status === "active" ? 1 : 0;

    if (leftActive !== rightActive) {
      return rightActive - leftActive;
    }

    return right.updatedAt.getTime() - left.updatedAt.getTime();
  })[0];
}


export async function formatGmailSetupForConversation(userId: string): Promise<string> {
  const state = await buildGmailAutonomyState(userId);

  if (!state.gmailConnected) {
    return [
      "Gmail setup",
      "",
      "Status: not connected.",
      "Access: readonly access after connection. Alecto cannot send emails or change labels.",
      "Scanning: off until Gmail is connected and at least one rule is enabled.",
      "",
      "What Gmail can track today:",
      "- Job search: recruiter replies, interviews, rejections, offers, application confirmations.",
      "- Work actions: requests, deadlines, follow-ups, feedback, blockers. These go to review first.",
      "- Custom tracking: sender and keyword rules. These go to review first and never auto-log.",
      "",
      formatGmailRecommendations(state.recommendedRules),
      "",
      "No webhooks yet. This is not instant arrival tracking.",
      `Next step: ${state.nextBestStep} Use /connect_gmail.`
    ].filter((line) => line !== undefined).join("\n");
  }

  const activeRuleLines =
    state.activeRules.length > 0
      ? groupEmailRulesForHumanDisplay(state.activeRules).map((group) => formatGmailSetupRuleLine(group.primary, group.rules.length))
      : ["- No active email tracking rules."];
  const pausedRuleLines =
    state.pausedRules.length > 0
      ? groupEmailRulesForHumanDisplay(state.pausedRules).map((group) => formatGmailSetupRuleLine(group.primary, group.rules.length))
      : [];

  return [
    "Gmail setup",
    "",
    `Status: connected${state.gmailAccount ? ` as ${state.gmailAccount}` : ""}.`,
    "Access: readonly access. Alecto cannot send emails or change labels.",
    "Alecto only scans Gmail through active rules.",
    `Mode: ${gmailSyncModeShortLabel(state)}.`,
    `Checks: ${gmailSyncModeSentence(state)}`,
    ...formatGmailBackgroundScheduleLines(state),
    `Notifications: review-waiting notifications ${state.reviewNotificationEnabled ? "on" : "off"}; delivery ${state.deliveryChannel}.`,
    state.pendingEmailReviewCount > 0 ? pendingEmailReviewLine(state.pendingEmailReviewCount) : undefined,
    "",
    "Active tracking:",
    ...activeRuleLines,
    pausedRuleLines.length > 0 ? "" : undefined,
    pausedRuleLines.length > 0 ? "Paused/error tracking:" : undefined,
    ...pausedRuleLines,
    "",
    formatGmailRecommendations(state.recommendedRules),
    "",
    "Review behavior: custom/work matches go to review; clear job-search matches can auto-log if that rule is on.",
    "Not available yet: instant webhooks, daily Gmail digest, work-hours-only checks, Gmail send/label actions.",
    `Next step: ${state.nextBestStep}`
  ].filter((line) => line !== undefined).join("\n");
}

export function emailRuleTitleForAdapter(adapterId: string): string {
  if (adapterId === "custom_email_review") {
    return "Custom Gmail tracking";
  }

  if (adapterId === "work_action_email") {
    return "Work-action email tracking";
  }

  if (adapterId === "job_search_email") {
    return "Job-search email tracking";
  }

  return "Email tracking rule";
}

export function formatGmailSetupRuleLine(rule: EmailSignalRule, duplicateCount = 1): string {
  const title = rule.adapterId === "custom_email_review" ? rule.name : emailRuleTitleForAdapter(rule.adapterId);
  const status = rule.status !== "active" ? `, ${rule.status}` : "";
  const duplicate = duplicateCount > 1 ? `, ${duplicateCount} duplicate rules shown once` : "";
  return `- ${title} - ${gmailRuleBehaviorLabel(rule)}${status}${duplicate}`;
}

export async function formatGmailCapabilityGuidance(userId: string): Promise<string> {
  const state = await buildGmailAutonomyState(userId);
  const activeLine =
    state.gmailConnected && state.activeRules.length > 0
      ? [
          "",
          "Active now:",
          ...groupEmailRulesForHumanDisplay(state.activeRules).map((group) => `- ${formatGmailSetupRuleLine(group.primary, group.rules.length).replace(/^- /, "")}`)
        ]
      : [];

  return [
    "Gmail works through explicit tracking rules. It does not read your whole inbox by default.",
    "",
    "Ready today:",
    "- Job search: recruiter replies, interviews, rejections, offers, application confirmations.",
    "- Work actions: requests, deadlines, follow-ups, feedback, blockers. These go to review first.",
    "- Custom tracking: sender and keyword rules. These go to review first and never auto-log.",
    "",
    ...activeLine,
    "",
    `Mode: ${gmailSyncModeShortLabel(state)}.`,
    state.pendingEmailReviewCount > 0 ? pendingEmailReviewLine(state.pendingEmailReviewCount) : undefined,
    formatGmailRecommendations(state.recommendedRules),
    "",
    "Custom rules and work-action matches go to email review before anything becomes an action or event.",
    "No webhooks yet. This is not instant arrival tracking.",
    `Next step: ${state.nextBestStep}`
  ].filter((line) => line !== undefined).join("\n");
}

export function formatGmailRecommendations(recommendations: Array<{ label: string; reason: string; example: string }>): string {
  if (recommendations.length === 0) {
    return "Recommended: nothing obvious missing from your active Gmail rules.";
  }

  return [
    "Recommended:",
    ...recommendations.map((recommendation) => `- ${recommendation.label}: ${recommendation.reason} ${recommendation.example}`)
  ].join("\n");
}

export function formatGmailCustomRuleGuidance(): string {
  return [
    "Custom Gmail tracking is review-first.",
    "",
    "Give me a sender, company, project, or 2-3 keywords.",
    "Examples:",
    '- "track Endesa bills from Gmail"',
    '- "track emails from client@example.com for dashboard project"',
    '- "watch emails mentioning invoice and Endesa"',
    "",
    "Matches go to email review only. Auto-log is off."
  ].join("\n");
}

export type GmailAutonomyPreferenceRequest =
  | { kind: "manual_only" }
  | { kind: "scheduled"; intervalMinutes: number }
  | { kind: "review_notifications"; enabled: boolean }
  | { kind: "daily_digest"; enabled: boolean; unsupported: true }
  | { kind: "work_hours"; unsupported: true };

export async function handleGmailAutonomyPreferenceForConversation(
  userId: string,
  message: string,
  _route?: SemanticRouterResult
): Promise<string> {
  const preference = parseGmailAutonomyPreference(message);

  if (!preference) {
    return formatGmailSetupForConversation(userId);
  }

  if (preference.kind === "daily_digest") {
    return preference.enabled
      ? "Daily Gmail digest is not implemented yet. Today I can show reviews when you say \"email reviews\" and notify when scheduled sync creates new review items."
      : "Daily Gmail digest is not implemented yet, so there is no digest to turn off. Today I can show reviews when you say \"email reviews\".";
  }

  if (preference.kind === "work_hours") {
    return "Work-hours Gmail checking is not implemented yet. Today I can use manual sync or scheduled worker mode for active Gmail rules.";
  }

  const state = await buildGmailAutonomyState(userId);

  if (!state.gmailConnected || !state.primaryConnection) {
    return "Gmail is not connected yet. Say 'connect Gmail' or use /connect_gmail.";
  }

  const payload =
    preference.kind === "manual_only"
      ? {
          operation: "gmail_autonomy_preference",
          connectionId: state.primaryConnection.id,
          preferenceKind: "manual_only",
          syncMode: "manual_only"
        }
      : preference.kind === "scheduled"
        ? {
            operation: "gmail_autonomy_preference",
            connectionId: state.primaryConnection.id,
            preferenceKind: "scheduled",
            syncMode: "scheduled",
            syncIntervalMinutes: preference.intervalMinutes
          }
        : {
            operation: "gmail_autonomy_preference",
            connectionId: state.primaryConnection.id,
            preferenceKind: preference.enabled ? "review_notifications_on" : "review_notifications_off",
            reviewNotificationEnabled: preference.enabled
          };

  await replacePendingAction(userId, {
    type: "custom_email_rule",
    summary: gmailAutonomyPendingSummary(preference),
    payload,
    expiresAt: pendingDecisionExpiry()
  });

  return gmailAutonomyConfirmationPrompt(preference, state);
}

export function isUnsupportedGmailAutonomyPreference(preference: GmailAutonomyPreferenceRequest | undefined): boolean {
  return preference?.kind === "daily_digest" || preference?.kind === "work_hours";
}

export function gmailAutonomyPendingSummary(preference: GmailAutonomyPreferenceRequest): string {
  if (preference.kind === "manual_only") {
    return "Set Gmail to manual-only checks";
  }

  if (preference.kind === "scheduled") {
    return `Set Gmail scheduled checks every ${formatIntervalMinutes(preference.intervalMinutes)}`;
  }

  if (preference.kind === "review_notifications") {
    return preference.enabled ? "Turn Gmail review notifications on" : "Turn Gmail review notifications off";
  }

  return "Unsupported Gmail preference";
}

export function gmailAutonomyConfirmationPrompt(
  preference: Exclude<GmailAutonomyPreferenceRequest, { unsupported: true }>,
  state: Awaited<ReturnType<typeof buildGmailAutonomyState>>
): string {
  if (preference.kind === "manual_only") {
    return [
      "I can make Gmail manual only.",
      "Alecto will check active Gmail rules only when you say \"sync Gmail\".",
      "This does not change your rules or email reviews.",
      "Confirm with \"yes\" or cancel."
    ].join("\n");
  }

  if (preference.kind === "scheduled") {
    return [
      `I can set Gmail to scheduled checks every ${formatIntervalMinutes(preference.intervalMinutes)} for active rules.`,
      "This is not instant email tracking; no webhooks yet.",
      "Custom/work uncertain matches still go to email reviews.",
      state.runtime.scheduledSyncEnabled
        ? "Review notifications use one bundled message when new reviews are waiting."
        : "Background sync is disabled in this local environment, so this saves the preference but will not run automatically until background sync is enabled.",
      "Confirm with \"yes\" or cancel."
    ].join("\n");
  }

  return [
    preference.enabled
      ? "I can turn Gmail review notifications on."
      : "I can turn Gmail review notifications off.",
    "This only affects proactive scheduled-sync review-waiting messages.",
    "Manual sync still replies in chat.",
    state.notificationDeliveryAvailable ? `Delivery: ${state.deliveryChannel}.` : "Notification delivery is not configured yet.",
    "Confirm with \"yes\" or cancel."
  ].join("\n");
}

export function parseGmailAutonomyPreference(message: string): GmailAutonomyPreferenceRequest | undefined {
  const text = normalizeForComparison(message);

  if (!/\b(gmail|email|emails|mail|mails|inbox|review|reviews)\b/.test(text)) {
    return undefined;
  }

  if (/\b(digest|resumen)\b/.test(text) && /\b(gmail|email|emails|mail|mails)\b/.test(text)) {
    const enabled = !/\b(turn off|disable|stop|no|dont|don't|do not|quita|desactiva)\b/.test(text);
    return { kind: "daily_digest", enabled, unsupported: true };
  }

  if (/\b(work hours|working hours|business hours|horario laboral|laboral hours|laboral)\b/.test(text)) {
    return { kind: "work_hours", unsupported: true };
  }

  if (
    /\b(manual only|manually only|manual-only|only manually)\b/.test(text) ||
    /\b(make|set|check|keep)\b.*\b(gmail|email|mail)\b.*\bmanual\b/.test(text) ||
    /\b(gmail|email|mail)\b.*\bmanual\b.*\bonly\b/.test(text)
  ) {
    return { kind: "manual_only" };
  }

  const notificationOff =
    /\b(don t|dont|do not|stop|disable|turn off|no|quita|desactiva|deja de)\b.*\b(notify|notification|notifications|tell me|let me know|avis\w*|notifi\w*)\b/.test(text) ||
    /\b(notify|notification|notifications|tell me|let me know|avis\w*|notifi\w*)\b.*\b(off|disabled|no|not)\b/.test(text);

  if (notificationOff && /\b(gmail|email|mail|review|reviews)\b/.test(text)) {
    return { kind: "review_notifications", enabled: false };
  }

  if (/\b(will|do|does|can|could)\s+(you|u)\b.*\b(notify|notification|notifications|tell me|let me know)\b/.test(text)) {
    return undefined;
  }

  const notificationOn =
    /\b(notify me|tell me|let me know|notification|notifications|avisa|avisame|avísame)\b.*\b(gmail|email|mail|review|reviews|waiting|arrive|new)\b/.test(text) ||
    /\b(turn on|enable)\b.*\b(gmail|email|mail)\b.*\b(notification|notifications)\b/.test(text);

  if (notificationOn) {
    return { kind: "review_notifications", enabled: true };
  }

  const everyMinutes = text.match(/\bevery\s+(\d+)\s+minutes?\b|\bcada\s+(\d+)\s+minutos?\b/);
  if (everyMinutes) {
    const minutes = Number.parseInt(everyMinutes[1] ?? everyMinutes[2] ?? "", 10);
    if (Number.isFinite(minutes) && minutes > 0) {
      return { kind: "scheduled", intervalMinutes: minutes };
    }
  }

  const everyHours = text.match(/\bevery\s+(\d+)\s+hours?\b|\bcada\s+(\d+)\s+horas?\b/);
  if (everyHours) {
    const hours = Number.parseInt(everyHours[1] ?? everyHours[2] ?? "", 10);
    if (Number.isFinite(hours) && hours > 0) {
      return { kind: "scheduled", intervalMinutes: hours * 60 };
    }
  }

  if (/\b(every hour|hourly|cada hora)\b/.test(text)) {
    return { kind: "scheduled", intervalMinutes: 60 };
  }

  if (/\b(daily|once a day|once per day|every day|cada dia|cada día|una vez al dia|una vez al día)\b/.test(text)) {
    return { kind: "scheduled", intervalMinutes: 24 * 60 };
  }

  return undefined;
}

export function looksLikeGmailAutonomyPreference(message: string): boolean {
  return Boolean(parseGmailAutonomyPreference(message));
}

export function isPendingGmailAutonomyPreference(pendingAction: PendingAction | undefined): boolean {
  return Boolean(
    pendingAction &&
      pendingAction.status === "pending" &&
      pendingAction.type === "custom_email_rule" &&
      isRecord(pendingAction.payload) &&
      pendingAction.payload.operation === "gmail_autonomy_preference"
  );
}

export function shouldReleasePendingGmailAutonomyFocus(pendingAction: PendingAction | undefined, message: string): boolean {
  if (!isPendingGmailAutonomyPreference(pendingAction)) {
    return false;
  }

  if (isConfirmationMessage(message) || isRejectionMessage(message)) {
    return false;
  }

  return true;
}

export interface CustomGmailRuleProposal {
  displayName: string;
  senderFilters: string[];
  keywordFilters: string[];
  goalId?: string;
  goalTitle?: string;
  queryPreview: string;
  reviewBeforeLogging: true;
  adapterId: "custom_email_review";
  confidence: number;
  missingFields: string[];
}

export function looksLikeCustomGmailTrackingRequest(message: string): boolean {
  const text = normalizeForComparison(message);
  const hasTrackVerb = /\b(track|watch|monitor|look for|follow|check)\b/.test(text);
  const hasRuleCreationVerb = /\b(create|enable|turn on|activate|set up|setup|add|make)\b/.test(text) && /\brules?\b/.test(text);

  if (!hasTrackVerb && !hasRuleCreationVerb) {
    return false;
  }

  if (/\b(sync|connect|status|what can|how does)\b/.test(text) || (!hasRuleCreationVerb && /\b(setup|set up)\b/.test(text))) {
    return false;
  }

  return (
    /\b(gmail|email|emails|mail|inbox)\b/.test(text) ||
    /\b(receipt|receipts|bill|bills|invoice|invoices|factura|facturas|payment|payments)\b/.test(text) ||
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(message)
  );
}

export function looksLikeGmailRuleQuestion(message: string): boolean {
  const text = normalizeForComparison(message);

  if (looksLikeCustomGmailTrackingRequest(message)) {
    return false;
  }

  if (!/\b(gmail|email|emails|mail|inbox|rule|tracking|endesa|job search|work action)\b/.test(text)) {
    return false;
  }

  return (
    /\b(where|what|how|when|will|would|does|do|can|could|should|linked|link|goal|actions?|events?|reviews?|saved|auto log|scan|sync)\b/.test(text) &&
    /\?|\b(where|what|how|when|will|would|does|do|can|could|should)\b/.test(text)
  );
}

export async function proposeCustomGmailRuleForConversation(
  userId: string,
  message: string,
  route?: SemanticRouterResult
): Promise<string> {
  const gmailConnection = (await getIntegrationConnections(userId)).find(
    (connection) => connection.integrationId === "gmail" && connection.status === "active"
  );

  if (!gmailConnection) {
    return "Gmail is not connected yet. Say 'connect Gmail' or use /connect_gmail.";
  }

  const goals = await getActiveGoals(userId);
  const proposal = buildCustomGmailRuleProposal(message, goals, route);

  if (proposal.missingFields.length > 0 || proposal.confidence < 0.65) {
    return "That is too broad. Give me a sender, company, project, or 2-3 keywords.";
  }

  await replacePendingAction(userId, {
    type: "custom_email_rule",
    summary: `Enable Gmail tracking: ${proposal.displayName}`,
    payload: {
      operation: "create_rule",
      connectionId: gmailConnection.id,
      ...proposal
    },
    expiresAt: pendingDecisionExpiry()
  });

  return formatCustomGmailRuleProposal(proposal);
}

export function buildCustomGmailRuleProposal(message: string, goals: Goal[], route?: SemanticRouterResult): CustomGmailRuleProposal {
  const senderFilters = uniqueStrings((message.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) ?? []).map((item) => item.toLowerCase()));
  const routeSenderFilters = route?.senderFilters.map((sender) => sender.toLowerCase()).filter(Boolean) ?? [];
  const routeKeywordFilters = route?.keywordFilters.map(cleanCustomKeyword).filter(isUsefulCustomKeywordCandidate) ?? [];
  const finalSenderFilters = uniqueStrings([...senderFilters, ...routeSenderFilters]);
  const keywordFilters = routeKeywordFilters.length > 0 ? routeKeywordFilters : extractCustomGmailKeywords(message, finalSenderFilters);
  const goal = inferCustomGmailGoal(route?.goalHint ?? message, goals);
  const usefulKeywords = keywordFilters.filter((keyword) => !isBroadCustomEmailKeyword(keyword));
  const missingFields = finalSenderFilters.length === 0 && usefulKeywords.length < 1 ? ["sender_or_keywords"] : [];
  const displayName = buildCustomGmailRuleDisplayName(message, finalSenderFilters, keywordFilters);
  const queryPreview = buildCustomGmailQuery(finalSenderFilters, keywordFilters);

  return {
    displayName,
    senderFilters: finalSenderFilters,
    keywordFilters,
    goalId: goal?.id,
    goalTitle: goal?.title,
    queryPreview,
    reviewBeforeLogging: true,
    adapterId: "custom_email_review",
    confidence: missingFields.length === 0 ? finalSenderFilters.length > 0 || usefulKeywords.length >= 2 ? 0.85 : 0.7 : 0.35,
    missingFields
  };
}

export function extractCustomGmailKeywords(message: string, senderFilters: string[]): string[] {
  const keywords: string[] = [];
  const text = normalizeForComparison(message);

  if (/\binvoices?\b/.test(text)) {
    keywords.push("invoice", "factura");
  }
  if (/\bbills?\b/.test(text)) {
    keywords.push("bill", "invoice", "factura");
  }
  if (/\breceipts?\b/.test(text)) {
    keywords.push("receipt");
  }
  if (/\bpayments?\b/.test(text)) {
    keywords.push("payment", "receipt");
  }
  if (/\bfacturas?\b/.test(text)) {
    keywords.push("factura", "invoice");
  }

  const fromPhrase = message.match(/\bfrom\s+([A-Z][A-Za-z0-9._ -]{1,40})(?:\s+(?:about|for|with|in|on)\b|$)/);
  if (fromPhrase && senderFilters.length === 0) {
    keywords.push(cleanCustomKeyword(fromPhrase[1]));
  }

  const aboutPhrase = message.match(/\b(?:about|for|mentioning|mentions?)\s+([A-Za-z0-9._@ -]{2,80})/i);
  if (aboutPhrase) {
    for (const part of aboutPhrase[1].split(/\s+(?:and|or)\s+|[,/]/i)) {
      const keyword = cleanCustomKeyword(part);
      if (keyword) {
        keywords.push(keyword);
      }
    }
  }

  for (const proper of message.match(/\b[A-Z][a-zA-Z0-9]{2,}\b/g) ?? []) {
    if (!/^(Gmail|Email|Mail|Inbox|Track|Watch|Monitor|I|Can|You)$/i.test(proper)) {
      keywords.push(proper);
    }
  }

  return uniqueStrings(keywords.map(cleanCustomKeyword).filter(isUsefulCustomKeywordCandidate)).slice(0, 8);
}

export function cleanCustomKeyword(value: string): string {
  const cleaned = value
    .replace(/[<>"'`]/g, "")
    .replace(
      /\b(gmail|email|emails|correo|correos|mail|mails|inbox|rule|rules|regla|reglas|tracking|track|watch|monitor|please|the|my|from|about|for|project|goal|word|words|only|just|solo|solamente|nomes|nom[eé]s|unic|unica|[uú]nicament|busca|buscar|busque|busqui|mira|mirar|filtra|filtrar|palabra|palabras|paraula|paraules|clave|clau)\b/gi,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();

  return normalizeCustomKeywordSpelling(cleaned);
}

export function normalizeCustomKeywordSpelling(value: string): string {
  return value
    .replace(/\bbarceloa\b/gi, "Barcelona")
    .replace(/\baigues\s+(?:the\s+)?barcelona\b/gi, "Aigues de Barcelona")
    .replace(/\baigues\s+de\s+barcelona\b/gi, "Aigues de Barcelona");
}

export function isUsefulCustomKeywordCandidate(keyword: string): boolean {
  const clean = keyword.trim();
  const key = normalizeForComparison(clean);

  if (!clean || isBroadCustomEmailKeyword(clean)) {
    return false;
  }

  if (clean.length > 40) {
    return false;
  }

  if (
    /\b(can you|could you|would you|link|linked|goal|spending|less than|under|always|saved|action|actions|review|auto|log|notify|let me know)\b/i.test(clean)
  ) {
    return false;
  }

  return key.length >= 3;
}

export function isBroadCustomEmailKeyword(keyword: string): boolean {
  return /^(gmail|email|emails|mail|inbox|message|messages|update|updates|all|every|anything|everything)$/i.test(keyword.trim());
}

export function inferCustomGmailGoal(message: string, goals: Goal[]): Goal | undefined {
  const text = normalizeForComparison(message);
  const active = goals.filter((goal) => goal.status === "active" && !isRiskControlGoal(goal));
  const energyOrUtilityHint = /\b(energy|utility|utilities|consumption|energia|energía|consumo|consum|electric|electricity|electricidad|llum|luz|agua|aigua|water|gas|endesa|aigues|aigües|bill|bills|invoice|factura|facturas|receipt)\b/.test(text);

  if (/\bfinance goal\b|\breceipt|\bbill|\binvoice|\bfactura|\bpayment/.test(text)) {
    const finance = active.find((goal) => /finance|receipt|bill|invoice|factura|payment|money/.test(normalizeForComparison(`${goal.title} ${goal.category} ${goal.templateId ?? ""}`)));
    if (finance) {
      return finance;
    }
  }

  if (energyOrUtilityHint) {
    const utilityGoal = active.find((goal) => {
      const goalText = normalizeForComparison(`${goal.title} ${goal.category} ${goal.templateId ?? ""}`);
      const looksLikeUtilityGoal = /\b(utility|utilities|consumption|consume|consumo|consum|electric|electricity|electricidad|llum|luz|agua|aigua|water|gas|endesa|aigues|aigües|bills?|invoice|factura|expenses?|spending|costs?)\b/.test(goalText);
      const looksLikeEnergyConsumptionGoal = /\benergy|energia|energía\b/.test(goalText) && /\b(consumption|consume|consumo|consum|bill|bills|invoice|factura|expense|spending|cost)\b/.test(goalText);

      return looksLikeUtilityGoal || looksLikeEnergyConsumptionGoal;
    });

    if (utilityGoal) {
      return utilityGoal;
    }

    return undefined;
  }

  const matches = active.filter((goal) => {
    const goalText = normalizeForComparison(goal.title);
    const goalTokens = meaningfulCustomGmailGoalTokens(goalText);
    return goalText.length > 3 && (text.includes(goalText) || goalTokens.some((token) => text.includes(token)));
  });

  return matches.length === 1 ? matches[0] : undefined;
}

export function meaningfulCustomGmailGoalTokens(value: string): string[] {
  return value
    .split(/\s+/)
    .map((token) => token.trim())
    .filter(
      (token) =>
        token.length >= 4 &&
        !/^(track|watch|monitor|find|build|make|create|goal|goals|more|better|improve|control|gmail|email|emails|rule|rules)$/.test(token)
    );
}

export function buildCustomGmailRuleDisplayName(message: string, senderFilters: string[], keywordFilters: string[]): string {
  const lower = normalizeForComparison(message);
  const primary = keywordFilters.find((keyword) => !/^(invoice|factura|bill|receipt|payment)$/i.test(keyword));
  const noun = lower.includes("receipt")
    ? "receipts"
    : lower.includes("bill") || lower.includes("factura")
      ? "bills"
      : lower.includes("invoice")
        ? "invoices"
        : "emails";

  if (primary) {
    return sentenceLikeTitle(`${primary} ${noun}`);
  }

  if (senderFilters[0]) {
    return sentenceLikeTitle(`${senderFilters[0]} ${noun}`);
  }

  return "Custom Gmail tracking";
}

export function buildCustomGmailQuery(senderFilters: string[], keywordFilters: string[]): string {
  const parts = ["newer_than:30d"];
  parts.push(...senderFilters.map((sender) => `from:${sender}`));
  parts.push(...keywordFilters.filter((keyword) => !isBroadCustomEmailKeyword(keyword)).map(formatGmailQueryTerm));
  return parts.join(" ");
}

export function formatGmailQueryTerm(term: string): string {
  const clean = term.trim();
  return /\s/.test(clean) ? `"${clean.replace(/"/g, "")}"` : clean;
}

export function formatCustomGmailRuleProposal(proposal: CustomGmailRuleProposal): string {
  return [
    "I can set up a review-first Gmail rule.",
    "",
    "Rule:",
    `- name: ${proposal.displayName}`,
    `- looks for: ${proposal.keywordFilters.length > 0 ? proposal.keywordFilters.join(", ") : "emails from the sender"}`,
    `- sender: ${proposal.senderFilters.length > 0 ? proposal.senderFilters.join(", ") : "any"}`,
    proposal.goalTitle ? `- linked goal: ${proposal.goalTitle}` : undefined,
    "- creates: email review items only",
    "- auto-log: off",
    "",
    "Confirm with \"yes\" to enable it, or say \"no\" to cancel.",
    "No Gmail scan will happen before you confirm."
  ].filter(Boolean).join("\n");
}


export function looksLikeContextualDeleteAllEmailRules(message: string): boolean {
  const text = normalizeForComparison(message);

  if (!/\b(delete|remove|clear|archive|reset|elimina|eliminar|borra|borrar)\b/.test(text)) {
    return false;
  }

  return (
    /\b(all|everything|every|all of them|all of em|em|them|todos|todas|totes)\b/.test(text) ||
    /\breset\b/.test(text)
  );
}


export function isPendingCustomGmailRuleCreate(pendingAction: PendingAction | undefined): boolean {
  return Boolean(
    pendingAction &&
      pendingAction.status === "pending" &&
      pendingAction.type === "custom_email_rule" &&
      isRecord(pendingAction.payload) &&
      pendingAction.payload.operation === "create_rule"
  );
}

export function isPendingCustomGmailRuleContext(pendingAction: PendingAction | undefined): boolean {
  return Boolean(
    pendingAction &&
      pendingAction.status === "pending" &&
      pendingAction.type === "custom_email_rule" &&
      isRecord(pendingAction.payload) &&
      pendingAction.payload.operation === "rule_context"
  );
}

export function extractPendingCustomRuleReplacementKeywords(message: string): string[] {
  const replacements: string[] = [];
  const match = message.match(
    /\b(?:look(?:s)?\s+for|looking\s+for|keywords?|filters?|search(?:es)?\s+for|busca(?:r|ndo)?|busque|busqui|mirar|mira|filtra(?:r)?|palabras?\s+clave|paraules?\s+clau)\s+(?:just|only|solo|solamente|nom[eé]s|unic(?:o|a)?|[uú]nicament)?\s*([\p{L}0-9._@ ,/-]{2,160})/iu
  );

  if (match) {
    replacements.push(...splitCustomKeywordPhrase(extractCustomKeywordClause(match[1])));
  }

  const justMatch = message.match(/\b(?:just|only|solo|solamente|nom[eé]s|[uú]nicament)\s+([\p{L}][\p{L}0-9._ -]{2,60})\b/iu);
  if (replacements.length === 0 && justMatch) {
    replacements.push(cleanCustomKeyword(justMatch[1]));
  }

  return uniqueStrings(replacements.map(cleanCustomKeyword).filter(isUsefulCustomKeywordCandidate));
}

export function extractPendingCustomRuleRemovedKeywords(message: string): string[] {
  const match = message.match(
    /\b(?:remove|drop|delete|quita(?:r)?|elimina(?:r)?|treu(?:re)?|saca(?:r)?)\s+(.+?)\s+(?:from|in|de|del|dels?|en)\s+(?:the\s+|la\s+|el\s+)?(?:rule|filter|keywords?|looks? for|regla|filtro|filtros|paraules?\s+clau|palabras?\s+clave)\b/iu
  );

  if (match) {
    return uniqueStrings(splitCustomKeywordPhrase(match[1]).map(cleanCustomKeyword).filter(isUsefulCustomKeywordCandidate));
  }

  const contrastMatch = message.match(/\b(?:instead of|rather than|en vez de|en lugar de|en lloc de|no|not|sin|sense)\s+([\p{L}0-9._@ -]{2,80})$/iu);
  return contrastMatch
    ? uniqueStrings(splitCustomKeywordPhrase(contrastMatch[1]).map(cleanCustomKeyword).filter(isUsefulCustomKeywordCandidate))
    : [];
}

export function splitCustomKeywordPhrase(value: string): string[] {
  return value
    .replace(/\b(?:from|for|in|on|de|del|dels?|para|per|por|amb|con|please|thanks|gmail|email|correo|correos|mail|rule|regla|filter|filtro|keyword|keywords|palabra|palabras|paraula|paraules)\b.*$/iu, "")
    .split(/\s+(?:and|or|y|o|i)\s+|[,/]/iu)
    .map(cleanCustomKeyword)
    .filter(isUsefulCustomKeywordCandidate);
}

export function extractCustomKeywordClause(value: string): string {
  const firstClause = value.split(/[.;?]/)[0] ?? value;
  return firstClause
    .replace(/\s+\b(?:instead of|rather than|en vez de|en lugar de|en lloc de)\b\s+.+$/iu, "")
    .replace(/\s+\b(?:not|no|sin|sense)\b\s+[\p{L}0-9._@ -]{2,80}$/iu, "")
    .replace(/,\s*(?:and|but|y|pero|i|per[oò])\s+.*$/iu, "")
    .replace(/\s+\b(?:and|but|y|pero|i|per[oò])\b\s+(?:can|could|would|should|do|does|will|where|what|how|link|linked|save|create|puede|puedes|podria|podrias|debe|deberia|donde|que|como|cuando|enlaza|vincula|guarda|crea)\b.*$/iu, "")
    .replace(/\s+\b(?:treu|quita|remove|drop|delete)\b\s+.+$/iu, "")
    .trim();
}

export function extractPendingCustomRuleGoalCorrection(message: string): { goalHint?: string; shouldUnlinkGoal: boolean } | undefined {
  const text = normalizeForComparison(message);

  if (!/\b(goal|linked goal|link|objetivo|meta|vincula|enlaza|lliga|relaciona)\b/.test(text) && !/\b(for energy consumption|consumo de energia|consumo de energía|consum d energia|factura luz|factures llum)\b/.test(text)) {
    return undefined;
  }

  const shouldUnlinkGoal = /\b(wrong goal|not linked|do not link|don't link|remove linked goal|unlink|no goal|is not|isnt|isn't|objetivo equivocado|meta equivocada|no lo enlaces|no l enlaces|no ho vinculis|quita el objetivo|treu l objectiu|no es apuestas|no son apuestas|no es apostes|not betting|not trading)\b/.test(text);
  const goalHintMatch = message.match(/\bgoal\s+(?:to|for|about)\s+([A-Za-z][A-Za-z0-9 -]{2,80})/i) ??
    message.match(/\blink(?:ed)?\s+(?:it|this|rule)?\s*(?:to|with)\s+([A-Za-z][A-Za-z0-9 -]{2,80})/i) ??
    message.match(/\b(?:objetivo|meta)\s+(?:de|para|sobre)\s+([\p{L}][\p{L}0-9 -]{2,80})/iu) ??
    message.match(/\b(?:vincula|enlaza|lliga|relaciona)\s+(?:lo|la|esto|aixo|aix[oò]|it|this|rule)?\s*(?:a|con|amb|to|with)\s+([\p{L}][\p{L}0-9 -]{2,80})/iu) ??
    message.match(/\b(?:for|to|para|per|por)\s+([\p{L}][\p{L}0-9 -]{2,80})$/iu) ??
    message.match(/\b(?:it'?s|its|this is|esto es|aixo es|aix[oò] [eé]s)\s+(?:for|about|para|sobre|per)\s+([\p{L}][\p{L}0-9 -]{2,80})/iu);
  const goalHint = goalHintMatch ? cleanCustomKeyword(goalHintMatch[1]) : undefined;

  if (!goalHint && !shouldUnlinkGoal) {
    return undefined;
  }

  return {
    goalHint,
    shouldUnlinkGoal
  };
}

export async function editPendingCustomGmailRule(
  userId: string,
  pendingAction: PendingAction | undefined,
  route: SemanticRouterResult
): Promise<string> {
  if (!isPendingCustomGmailRuleCreate(pendingAction) || !pendingAction || !isRecord(pendingAction.payload)) {
    return "There is no pending Gmail rule to edit. Say something like: track Endesa bills from Gmail.";
  }

  const currentKeywordFilters = arrayOfStrings(pendingAction.payload.keywordFilters).map(cleanCustomKeyword).filter(Boolean);
  const currentSenderFilters = arrayOfStrings(pendingAction.payload.senderFilters).map((sender) => sender.toLowerCase());
  const replacementKeywords = route.keywordFilters.map(cleanCustomKeyword).filter(isUsefulCustomKeywordCandidate);
  const removeKeywords = route.removeKeywordFilters.map((keyword) => normalizeForComparison(cleanCustomKeyword(keyword)));
  const keywordFilters = replacementKeywords.length > 0
    ? replacementKeywords
    : currentKeywordFilters.filter((keyword) => !removeKeywords.includes(normalizeForComparison(keyword)));
  const senderFilters = route.senderFilters.length > 0
    ? route.senderFilters.map((sender) => sender.toLowerCase())
    : currentSenderFilters;

  if (senderFilters.length === 0 && keywordFilters.filter((keyword) => !isBroadCustomEmailKeyword(keyword)).length === 0) {
    return "That would make the Gmail rule too broad. Give me a sender, company, project, or keyword.";
  }

  const goals = await getActiveGoals(userId);
  const requestedGoalHint = route.goalHint?.trim() || undefined;
  const goal = requestedGoalHint ? inferCustomGmailGoal(requestedGoalHint, goals) : undefined;
  const shouldDropRiskGoal = typeof pendingAction.payload.goalTitle === "string" && /betting|trading|impulsive|risk/i.test(pendingAction.payload.goalTitle);
  const goalId = goal?.id ?? (route.shouldUnlinkGoal || shouldDropRiskGoal ? undefined : stringFromRecord(pendingAction.payload, "goalId"));
  const goalTitle = goal?.title ?? (route.shouldUnlinkGoal || shouldDropRiskGoal ? undefined : stringFromRecord(pendingAction.payload, "goalTitle"));
  const displayName = replacementKeywords.length > 0 || shouldDropRiskGoal
    ? buildCustomGmailRuleDisplayName(keywordFilters.join(" "), senderFilters, keywordFilters)
    : stringFromRecord(pendingAction.payload, "displayName") ?? buildCustomGmailRuleDisplayName(keywordFilters.join(" "), senderFilters, keywordFilters);
  const queryPreview = buildCustomGmailQuery(senderFilters, keywordFilters);
  const updatedProposal: CustomGmailRuleProposal = {
    displayName,
    senderFilters,
    keywordFilters,
    goalId,
    goalTitle,
    queryPreview,
    reviewBeforeLogging: true,
    adapterId: "custom_email_review",
    confidence: 0.9,
    missingFields: []
  };

  await replacePendingAction(userId, {
    type: "custom_email_rule",
    summary: `Enable Gmail tracking: ${updatedProposal.displayName}`,
    payload: {
      ...pendingAction.payload,
      operation: "create_rule",
      ...updatedProposal
    },
    expiresAt: pendingDecisionExpiry()
  });

  return [
    "Updated the pending Gmail rule.",
    requestedGoalHint && !goal
      ? `I did not link a goal because I could not find an active goal matching "${requestedGoalHint}".`
      : undefined,
    shouldDropRiskGoal && !goal
      ? "I removed the previous risk-control goal link. This rule is not a betting/trading guardrail."
      : undefined,
    "",
    formatCustomGmailRuleProposal(updatedProposal)
  ].filter((line) => line !== undefined).join("\n");
}

export async function editActiveCustomGmailRuleForConversation(
  userId: string,
  message: string,
  route: SemanticRouterResult,
  pendingAction?: PendingAction
): Promise<string> {
  const rules = (await getEmailSignalRules(userId)).filter(
    (rule) => rule.adapterId === "custom_email_review" && rule.status !== "archived"
  );
  const matches = resolveCustomGmailRulesForConversation(rules, message, route, pendingAction);

  if (matches.length === 0) {
    return "I could not find a matching custom Gmail rule. Say the rule name, like: change Endesa emails to only look for Aigues de Barcelona.";
  }

  if (matches.length > 1) {
    return [
      "Which custom Gmail rule do you mean?",
      ...matches.slice(0, 5).map((rule, index) => `${index + 1}. ${rule.name}`),
      "Reply with the rule name."
    ].join("\n");
  }

  const rule = matches[0];
  const currentFilters = parseCustomGmailRuleFilters(rule);
  const replacementKeywords = route.keywordFilters.map(cleanCustomKeyword).filter(isUsefulCustomKeywordCandidate);
  const removeKeywords = route.removeKeywordFilters.map((keyword) => normalizeForComparison(cleanCustomKeyword(keyword)));
  const senderFilters = route.senderFilters.length > 0
    ? uniqueStrings(route.senderFilters.map((sender) => sender.toLowerCase()).filter(Boolean))
    : currentFilters.senderFilters;
  const shouldReplaceKeywords = shouldReplaceCustomRuleKeywords(message, route);
  const keywordFilters = shouldReplaceKeywords && replacementKeywords.length > 0
    ? replacementKeywords
    : uniqueStrings([
        ...currentFilters.keywordFilters.filter((keyword) => !removeKeywords.includes(normalizeForComparison(keyword))),
        ...replacementKeywords
      ]);

  const queryChanged =
    replacementKeywords.length > 0 ||
    removeKeywords.length > 0 ||
    route.senderFilters.length > 0;

  if (!queryChanged && !route.goalHint && !route.shouldUnlinkGoal) {
    return "Tell me what to change on that Gmail rule. Example: make Endesa emails look only for Aigues de Barcelona.";
  }

  if (queryChanged && senderFilters.length === 0 && keywordFilters.filter((keyword) => !isBroadCustomEmailKeyword(keyword)).length === 0) {
    return "That would make the Gmail rule too broad. Give me a sender, company, project, or keyword.";
  }

  const goals = await getActiveGoals(userId);
  const requestedGoalHint = route.goalHint?.trim() || undefined;
  const goal = requestedGoalHint ? inferCustomGmailGoal(requestedGoalHint, goals) : undefined;
  const goalPatch = route.shouldUnlinkGoal
    ? null
    : goal
      ? goal.id
      : undefined;
  const query = queryChanged ? buildCustomGmailQuery(senderFilters, keywordFilters) : rule.query;
  const name = queryChanged ? buildCustomGmailRuleDisplayName(keywordFilters.join(" "), senderFilters, keywordFilters) : rule.name;

  const updated = await updateEmailSignalRuleDefinition(userId, rule.id, {
    name,
    query,
    goalId: goalPatch
  });

  if (!updated) {
    return "I could not update that Gmail rule.";
  }

  await maybeRememberGmailRuleConversationContext(userId, [updated], updated);

  const goalById = new Map((await getGoals(userId)).map((item) => [item.id, item.title]));
  const linkedGoalTitle = updated.goalId ? goalById.get(updated.goalId) : undefined;
  const warnings = [
    requestedGoalHint && !goal ? `I did not link a goal because I could not find an active goal matching "${requestedGoalHint}".` : undefined
  ].filter(Boolean);

  return [
    `Updated Gmail rule: ${updated.name}`,
    `Looks for: ${formatEmailRuleQueryForHumans(updated.query)}`,
    `Linked goal: ${linkedGoalTitle ?? "none"}`,
    "Matches still go to email review first. Auto-log is off.",
    ...warnings
  ].join("\n");
}

export function parseCustomGmailRuleFilters(rule: EmailSignalRule): { senderFilters: string[]; keywordFilters: string[] } {
  const query = rule.query ?? "";
  const senderFilters = uniqueStrings(
    [...query.matchAll(/\bfrom:("[^"]+"|\S+)/gi)]
      .map((match) => match[1]?.replace(/^"|"$/g, "").toLowerCase() ?? "")
      .filter(Boolean)
  );
  const withoutControlTerms = query
    .replace(/\bnewer_than:\d+d\b/gi, " ")
    .replace(/\bfrom:("[^"]+"|\S+)/gi, " ");
  const quotedTerms = [...withoutControlTerms.matchAll(/"([^"]+)"/g)].map((match) => match[1] ?? "");
  const unquoted = withoutControlTerms.replace(/"[^"]+"/g, " ").split(/\s+/);
  const keywordFilters = uniqueStrings(
    [...quotedTerms, ...unquoted]
      .map(cleanCustomKeyword)
      .filter(isUsefulCustomKeywordCandidate)
  );

  return { senderFilters, keywordFilters };
}

export function shouldReplaceCustomRuleKeywords(message: string, route: SemanticRouterResult): boolean {
  const text = normalizeForComparison(message);
  return (
    route.removeKeywordFilters.length > 0 ||
    /\b(only|just|solo|solamente|nomes|només|unic|únicament|instead of|rather than|en vez de|en lugar de|en lloc de|replace|change to|cambia(?:r)? a|canvia(?:r)? a|use)\b/.test(text)
  );
}


export async function answerGmailRuleQuestionForConversation(
  userId: string,
  message: string,
  pendingAction?: PendingAction,
  route?: SemanticRouterResult
): Promise<string> {
  if (route?.operation === "timing" || looksLikeGmailNotificationTimingQuestion(message)) {
    return formatGmailNotificationTimingForConversation(userId, message, pendingAction, route);
  }

  if (isPendingCustomGmailRuleCreate(pendingAction) && pendingAction && isRecord(pendingAction.payload)) {
    const goalTitle = stringFromRecord(pendingAction.payload, "goalTitle");
    const keywordFilters = arrayOfStrings(pendingAction.payload.keywordFilters);
    const senderFilters = arrayOfStrings(pendingAction.payload.senderFilters);
    const displayName = stringFromRecord(pendingAction.payload, "displayName") ?? "Custom Gmail tracking";

    return [
      `${displayName} is still pending. It is not scanning Gmail yet.`,
      `Looks for: ${keywordFilters.length > 0 ? keywordFilters.join(", ") : "emails from the sender"}`,
      `Sender: ${senderFilters.length > 0 ? senderFilters.join(", ") : "any"}`,
      `Linked goal: ${goalTitle ?? "none"}`,
      "Where matches go: email review only. It will not create actions or events automatically.",
      "Confirm with yes, cancel with no, or edit it in plain language."
    ].join("\n");
  }

  const rules = (await getEmailSignalRules(userId)).filter((rule) => rule.status !== "archived");
  const target = route?.target ?? extractGmailRuleQuestionTarget(message);
  const matches = target
    ? findEmailRulesByTarget(rules, target)
    : rules.length === 1
      ? rules
      : [];

  if (matches.length === 0) {
    if (isCustomGmailRuleQuestionTarget(target)) {
      return formatMissingCustomGmailRuleQuestion(target);
    }

    if (rules.length === 0) {
      return "No Gmail rules are active yet. Say what to track, for example: track Endesa bills from Gmail.";
    }

    return "I could not identify which Gmail rule you mean. Say the rule name, like: what happens with Endesa emails?";
  }

  if (matches.length > 1) {
    await maybeRememberGmailRuleConversationContext(userId, matches);
    return [
      "Which Gmail rule do you mean?",
      ...matches.slice(0, 5).map((rule, index) => `${index + 1}. ${rule.name}`),
      "Ask again with the rule name."
    ].join("\n");
  }

  const rule = matches[0];
  const [goals, state] = await Promise.all([getGoals(userId), buildGmailAutonomyState(userId)]);
  const goal = rule.goalId ? goals.find((item) => item.id === rule.goalId) : undefined;
  await maybeRememberGmailRuleConversationContext(userId, [rule], rule);

  if (rule.status !== "active" && rule.adapterId === "custom_email_review") {
    return [
      `${customGmailRuleSubject(rule.name)} tracking is ${rule.status}.`,
      "When active, custom Gmail matches go to email reviews first and do not auto-log.",
      `Say "resume ${customGmailRuleSubject(rule.name)} emails" to turn it back on.`
    ].join("\n");
  }

  return [
    `Gmail rule: ${rule.name}`,
    `Status: ${rule.status}`,
    `Looks for: ${formatEmailRuleQueryForHumans(rule.query)}`,
    `Linked goal: ${goal?.title ?? "none"}`,
    "Where matches go: email review first.",
    gmailRuleOutcomeExplanation(rule),
    gmailSyncModeSentence(state),
    gmailAutomaticSyncDetail(state)
  ].join("\n");
}

export function isCustomGmailRuleQuestionTarget(target: string | undefined): target is string {
  if (!target) {
    return false;
  }

  const cleanTarget = normalizeForComparison(cleanEmailRuleTarget(target));
  return Boolean(cleanTarget) && cleanTarget !== "work action" && cleanTarget !== "job search" && target !== "work_action_email" && target !== "job_search_email";
}

export function customGmailRuleSubject(value: string): string {
  return cleanEmailRuleTarget(value) || value.trim() || "That";
}

export function formatMissingCustomGmailRuleQuestion(target: string): string {
  const subject = customGmailRuleSubject(target);

  return [
    `I don't see an active ${subject} Gmail rule right now.`,
    "Custom Gmail tracking goes to email reviews first and does not auto-log.",
    `Say "track ${subject} bills from Gmail" if you want to set it up.`
  ].join("\n");
}

export function gmailRuleOutcomeExplanation(rule: EmailSignalRule): string {
  if (rule.adapterId === "custom_email_review") {
    return "Custom rules never auto-log or create actions. You can turn a review into an action after you inspect it.";
  }

  if (rule.adapterId === "work_action_email") {
    return "Work-action emails do not become tasks automatically. They wait in email review; approval can create an ActionItem.";
  }

  if (rule.adapterId === "job_search_email") {
    return rule.reviewBeforeLogging
      ? "Job-search matches wait for your approval before becoming career events."
      : "Clear job-search matches can become career events. Uncertain matches go to review.";
  }

  return rule.reviewBeforeLogging ? "Matches wait for your approval before becoming events or actions." : "Clear matches can be logged automatically; uncertain matches go to review.";
}

export async function formatGmailNotificationTimingForConversation(
  userId: string,
  message: string,
  pendingAction?: PendingAction,
  route?: SemanticRouterResult
): Promise<string> {
  const state = await buildGmailAutonomyState(userId);

  if (isPendingCustomGmailRuleCreate(pendingAction) && pendingAction && isRecord(pendingAction.payload)) {
    const displayName = stringFromRecord(pendingAction.payload, "displayName") ?? "Custom Gmail tracking";

    return [
      `${displayName} is still pending, so it is not scanning Gmail yet.`,
      `After you confirm, ${gmailSyncModeSentence(state)}`,
      gmailAutomaticSyncDetail(state),
      "This is not instant arrival tracking yet. Gmail webhooks are not implemented.",
      "Matches go to email review first; they do not become actions or events automatically.",
      "Alecto cannot send emails or change labels."
    ].join("\n");
  }

  if (!state.gmailConnected) {
    return "Gmail is not connected yet. Say 'connect Gmail' or use /connect_gmail.";
  }

  const visibleRules = state.visibleRules;
  const rules = state.activeRules;
  const target = route?.target ?? extractGmailRuleQuestionTarget(message);
  const customMatches = resolveCustomGmailRulesForConversation(
    visibleRules.filter((rule) => rule.adapterId === "custom_email_review"),
    message,
    route,
    pendingAction
  );
  const targetMatches = target ? findEmailRulesByTarget(visibleRules, target) : [];
  const hasSpecificRuleMatch = targetMatches.length > 0 || customMatches.length > 0;

  if (!hasSpecificRuleMatch && isCustomGmailRuleQuestionTarget(target)) {
    return formatMissingCustomGmailRuleQuestion(target);
  }

  const matches = targetMatches.length > 0
    ? targetMatches
    : customMatches.length > 0
      ? customMatches
      : rules.length > 0
        ? rules
      : visibleRules;

  if (visibleRules.length === 0) {
    return [
      noActiveGmailRulesMessage(),
      `${gmailSyncModeSentence(state)}, but no active rule means no Gmail scanning.`,
      gmailAutomaticSyncDetail(state),
      "This is not instant arrival tracking yet. Gmail webhooks are not implemented.",
      "Alecto cannot send emails or change labels."
    ].join("\n");
  }

  const ruleLine =
    hasSpecificRuleMatch && matches.length === 1
      ? `For ${matches[0].name}${matches[0].status !== "active" ? ` (${matches[0].status})` : ""}:`
      : hasSpecificRuleMatch && matches.length > 1
        ? `For matching rules: ${matches.slice(0, 3).map((rule) => rule.name).join(", ")}.`
        : "For active Gmail rules:";

  await maybeRememberGmailRuleConversationContext(userId, matches.length > 0 ? matches : rules, matches.length === 1 ? matches[0] : undefined);

  return [
    ruleLine,
    matches.length === 1 && matches[0].status !== "active"
      ? "That rule is not active right now, so it will not check Gmail until you resume it."
      : gmailSyncModeSentence(state),
    gmailAutomaticSyncDetail(state),
    ...formatGmailBackgroundScheduleLines(state),
    "This is not instant arrival tracking yet. Gmail webhooks are not implemented.",
    "Only active Gmail rules are checked. Custom/work uncertain matches go to email review.",
    "Alecto cannot send emails or change labels.",
    state.reviewNotificationEnabled
      ? "Review notifications are on for scheduled sync."
      : "Review notifications are off. Manual sync still replies in chat.",
    pendingEmailReviewLine(state.pendingEmailReviewCount)
  ].filter(Boolean).join("\n");
}

export function gmailAutomaticSyncDetail(state: Awaited<ReturnType<typeof buildGmailAutonomyState>>): string {
  if (state.syncMode === "scheduled" && state.scheduledSyncEnabled) {
    return `Automatic sync is on for active Gmail rules, about every ${formatIntervalMinutes(state.syncIntervalMinutes)}.`;
  }

  if (state.syncMode === "scheduled") {
    return "Automatic sync preference is saved, but background sync is disabled in this local environment.";
  }

  return "Automatic sync is off.";
}

export function formatGmailBackgroundScheduleLines(state: Awaited<ReturnType<typeof buildGmailAutonomyState>>): string[] {
  if (state.syncMode !== "scheduled" || !state.scheduledSyncEnabled) {
    return [];
  }

  return [
    state.lastBackgroundSyncAttemptedAt
      ? `Last background check: ${formatRelativeTime(state.lastBackgroundSyncAttemptedAt)}.`
      : "Last background check: not yet.",
    state.nextBackgroundSyncAt
      ? `Next background check: ${formatFutureRelativeTime(state.nextBackgroundSyncAt)}.`
      : undefined
  ].filter((line): line is string => Boolean(line));
}

export function formatRelativeTime(value: Date, now = new Date()): string {
  const diffMs = now.getTime() - value.getTime();

  if (Math.abs(diffMs) < 60_000) {
    return "just now";
  }

  if (diffMs < 0) {
    return formatFutureRelativeTime(value, now);
  }

  return `${formatDurationMinutes(Math.max(1, Math.round(diffMs / 60_000)))} ago`;
}

export function formatFutureRelativeTime(value: Date, now = new Date()): string {
  const diffMs = value.getTime() - now.getTime();

  if (diffMs <= 0) {
    return "due now";
  }

  return `about ${formatDurationMinutes(Math.max(1, Math.ceil(diffMs / 60_000)))}`;
}

export function formatDurationMinutes(minutes: number): string {
  if (minutes < 60) {
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;

  if (remainingMinutes === 0) {
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }

  return `${hours} hour${hours === 1 ? "" : "s"} ${remainingMinutes} minute${remainingMinutes === 1 ? "" : "s"}`;
}

export function looksLikeGmailNotificationTimingQuestion(message: string): boolean {
  const text = normalizeForComparison(message);

  if (!/\b(gmail|email|emails|mail|mails|inbox|rule|rules|endesa)\b/.test(text)) {
    return false;
  }

  return (
    /\bwhen\b.*\b(check|sync|scan|look|read)\b.*\b(gmail|email|emails|mail|mails|inbox)\b/.test(text) ||
    /\bhow\b.*\b(often|much|many|does|do)\b.*\b(check|sync|scan|look|read)\b/.test(text) ||
    /\b(do|does|will|would|can|could)\b.*\b(check|sync|scan|look|read|notify|tell|let me know)\b.*\b(automatically|background|arrival|arrive|new|gmail|email|emails|mail|mails)\b/.test(text) ||
    /\b(automatically|background|instant|webhook|webhooks)\b.*\b(gmail|email|emails|mail|mails|inbox|notify|notification|sync|check|scan)\b/.test(text) ||
    /\bwhen\b.*\b(let me know|tell me|notify|notification|new|arrive|comes?|come in|sync|check)\b/.test(text) ||
    /\b(let me know|tell me|notify|notification)\b.*\b(new|arrive|comes?|come in|sync|check|email|emails|mail|mails)\b/.test(text) ||
    /\bwhen they arrive\b/.test(text)
  );
}

export async function manageCustomGmailRuleForConversation(
  userId: string,
  message: string,
  route?: SemanticRouterResult,
  pendingAction?: PendingAction
): Promise<string> {
  const parsed = parseCustomGmailRuleManagement(message, route);
  if (!parsed) {
    return "Tell me which custom Gmail rule to change. Example: pause Endesa emails.";
  }

  const rules = await getVisibleGmailEmailRules(userId);

  const contextualIgnoreReply = maybeHandleGmailRuleIgnoreWithoutVisibleReviewContext(message, rules, parsed.target);
  if (contextualIgnoreReply) {
    return contextualIgnoreReply;
  }

  if (parsed.operation === "archive" && isAllCustomGmailRulesTarget(message, parsed.target)) {
    const selectedRules = sortEmailRuleCandidates(
      normalizeForComparison(`${message} ${parsed.target ?? ""}`).includes("custom")
        ? rules.filter((rule) => rule.adapterId === "custom_email_review")
        : rules
    );

    if (selectedRules.length === 0) {
      return "No Gmail email rules matched. Gmail connection and historical email reviews were not changed.";
    }

    await replacePendingAction(userId, {
      type: "custom_email_rule",
      summary: `Archive ${selectedRules.length} Gmail email rules`,
      payload: {
        operation: "archive_rules",
        ruleScope: "gmail_email_rules",
        ruleIds: selectedRules.map((rule) => rule.id),
        ruleNames: selectedRules.map((rule) => rule.name)
      },
      expiresAt: pendingDecisionExpiry()
    });

    return [
      `Confirm remove ${selectedRules.length} Gmail email rule${selectedRules.length === 1 ? "" : "s"}?`,
      ...formatGmailEmailRuleSelectionLines(selectedRules, { showStatus: true }),
      "Reply yes to confirm or no to cancel."
    ].join("\n");
  }

  const targetParts = parsed.operation === "archive" && parsed.target ? splitEmailRuleTargets(parsed.target) : [];

  if (targetParts.length > 1) {
    const resolution = resolveMultipleEmailRuleTargets(rules, targetParts);

    if (resolution.unmatchedTargets.length > 0 || resolution.ambiguousTargets.length > 0) {
      return [
        "I can remove multiple custom Gmail rules, but I need clearer rule names.",
        resolution.unmatchedTargets.length > 0 ? `No match for: ${resolution.unmatchedTargets.join(", ")}` : undefined,
        ...resolution.ambiguousTargets.map(
          (item) => `Ambiguous: ${item.target} (${item.candidates.slice(0, 3).map((rule) => rule.name).join(", ")})`
        ),
        "Use exact rule names from /my_email_rules, or remove one rule at a time."
      ]
        .filter(Boolean)
        .join("\n");
    }

    if (resolution.matches.length > 1) {
      const selectedRules = sortEmailRuleCandidates(resolution.matches);
      await replacePendingAction(userId, {
        type: "custom_email_rule",
        summary: `Archive ${selectedRules.length} Gmail email rules`,
        payload: {
          operation: "archive_rules",
          ruleScope: "gmail_email_rules",
          ruleIds: selectedRules.map((rule) => rule.id),
          ruleNames: selectedRules.map((rule) => rule.name)
        },
        expiresAt: pendingDecisionExpiry()
      });

      return [
        `Confirm remove ${selectedRules.length} Gmail email rules?`,
        ...formatGmailEmailRuleSelectionLines(selectedRules, { showStatus: true }),
        "Reply yes to confirm or no to cancel."
      ].join("\n");
    }
  }

  const matches = sortEmailRuleCandidates(resolveCustomGmailRulesForConversation(rules, message, {
    ...defaultSemanticRoute("gmail_custom_rule_manage", parsed.operation === "archive" ? "remove" : parsed.operation, "Parsed custom Gmail rule management request."),
    target: parsed.target
  }, pendingAction));

  if (matches.length === 0) {
    const target = parsed.target ?? extractGmailRuleQuestionTarget(message) ?? extractLikelyRuleTargetsFromMessage(message)[0];
    if (target && isCustomGmailRuleQuestionTarget(target)) {
      return formatMissingEmailRuleManagementContext(target);
    }

    return "I could not find a matching custom Gmail rule. Use /my_email_rules to check the exact rule.";
  }

  if (matches.length > 1) {
    await replacePendingAction(userId, {
      type: "custom_email_rule",
      summary: `${parsed.operation === "archive" ? "Remove" : parsed.operation} custom Gmail rule`,
      payload: {
        operation: "clarify_rule_management",
        intendedOperation: parsed.operation,
        originalText: message,
        candidateRules: matches.slice(0, 5).map(toEmailRuleSelectionCandidate)
      },
      expiresAt: pendingDecisionExpiry()
    });

    return [
      "Which custom Gmail rule do you mean?",
      ...matches.slice(0, 5).map((rule, index) => `${index + 1}. ${rule.name}`),
      "Reply with the number or rule name, or cancel."
    ].join("\n");
  }

  const rule = matches[0];

  if (parsed.operation === "pause" || parsed.operation === "resume") {
    const status = parsed.operation === "pause" ? "paused" : "active";
    const updated = await updateEmailSignalRule(userId, rule.id, { status });
    if (updated) {
      await maybeRememberGmailRuleConversationContext(userId, [updated], updated);
    }
    return updated ? `Gmail rule ${status}: ${updated.name}` : "I could not update that Gmail rule.";
  }

  await replacePendingAction(userId, {
    type: "custom_email_rule",
    summary: `Archive Gmail rule: ${rule.name}`,
    payload: {
      operation: "archive_rule",
      ruleId: rule.id,
      ruleName: rule.name
    },
    expiresAt: pendingDecisionExpiry()
  });

  return `Confirm remove Gmail rule: ${rule.name}? Reply yes to confirm or no to cancel.`;
}

export function maybeHandleGmailRuleIgnoreWithoutVisibleReviewContext(
  message: string,
  rules: EmailSignalRule[],
  routeTarget?: string | null
): string | undefined {
  if (!looksLikeIgnoreEmailItemsLanguage(message)) {
    return undefined;
  }

  const target = routeTarget ?? extractGmailRuleQuestionTarget(message) ?? extractLikelyRuleTargetsFromMessage(message)[0];

  if (!target || !isCustomGmailRuleQuestionTarget(target)) {
    return undefined;
  }

  const matches = findEmailRulesByTarget(rules, target);

  if (matches.length > 0) {
    return [
      `I don't see visible ${customGmailRuleSubject(target)} email reviews right now.`,
      `I do see ${matches.length === 1 ? "a Gmail rule" : "Gmail rules"} for that: ${matches.slice(0, 3).map((rule) => rule.name).join(", ")}.`,
      `Do you mean pause or remove ${matches.length === 1 ? "that rule" : "those rules"}?`
    ].join("\n");
  }

  return formatMissingEmailRuleManagementContext(target);
}

export function looksLikeIgnoreEmailItemsLanguage(message: string): boolean {
  return /\b(ignore|reject|dismiss|clear|ignora|ignorar|rechaza|rechazar|descarta|descartar)\b/i.test(message);
}

export function formatMissingEmailRuleManagementContext(target: string): string {
  const subject = customGmailRuleSubject(target);
  return `I don't see visible ${subject} reviews or an active ${subject} rule in this context. Say "email reviews" or "Gmail rules" first.`;
}

export function parseCustomGmailRuleManagement(
  message: string,
  route?: SemanticRouterResult
): { operation: "pause" | "resume" | "archive"; target: string | null } | undefined {
  if (
    route &&
    (route.operation === "pause" || route.operation === "resume" || route.operation === "remove")
  ) {
    return {
      operation: route.operation === "remove" ? "archive" : route.operation,
      target: route.target
    };
  }

  const match = message.trim().match(/^(?:(?:also|tambien|también)\s+)?(?:(?:can|could|would)\s+(?:you|u)\s+(?:please\s+)?|(?:puedes|podrias|podrías)\s+)?(pause|resume|remove|delete|elimina|eliminar|borra|borrar|pausa|pausar|reanuda|reanudar|activa|activar)\s+(.+?)(?:\s+(?:gmail|email|mail)?\s*rules?)?$/i);
  if (!match) {
    return undefined;
  }

  const verb = match[1].toLowerCase();
  const operation =
    verb === "pause" || verb === "pausa" || verb === "pausar"
      ? "pause"
      : verb === "resume" || verb === "reanuda" || verb === "reanudar" || verb === "activa" || verb === "activar"
        ? "resume"
        : "archive";

  return {
    operation,
    target: match[2].trim()
  };
}

export function isAllCustomGmailRulesTarget(message: string, target: string | null): boolean {
  const text = normalizeForComparison(`${message} ${target ?? ""}`);
  return /\b(all|every|todas|todos|totes|all active)\b/.test(text) && /\b(email|gmail|rule|rules|regla|reglas|custom|tracking)\b/.test(text);
}

export function resolveCustomGmailRulesForConversation(
  rules: EmailSignalRule[],
  message: string,
  route?: SemanticRouterResult,
  pendingAction?: PendingAction
): EmailSignalRule[] {
  const targetCandidates = uniqueStrings([
    route?.target && !isPronounRuleTarget(route.target) ? route.target : undefined,
    extractGmailRuleQuestionTarget(message),
    ...(route?.removeKeywordFilters ?? []),
    ...extractLikelyRuleTargetsFromMessage(message)
  ].filter((value): value is string => Boolean(value && value.trim())));

  for (const target of targetCandidates) {
    const matches = findSelectableEmailRulesByTarget(rules, target);
    if (matches.length > 0) {
      return matches;
    }
  }

  if (targetCandidates.length > 0) {
    return [];
  }

  const contextMatches = getCustomGmailRuleContextMatches(rules, pendingAction);
  if (contextMatches.length > 0 && (hasRulePronoun(message, route) || rules.length > 1)) {
    return contextMatches;
  }

  return rules.length === 1 ? rules : [];
}

export function defaultSemanticRoute(
  intent: SemanticRouterResult["intent"],
  operation: SemanticRouterResult["operation"],
  reason: string
): SemanticRouterResult {
  return {
    intent,
    operation,
    confidence: 0.9,
    reason,
    language: "unknown",
    sideEffectRisk: operation === "remove" ? "destructive" : operation === "status" || operation === "answer" || operation === "timing" ? "read" : "write",
    requiresConfirmation: operation === "remove",
    target: null,
    keywordFilters: [],
    senderFilters: [],
    removeKeywordFilters: [],
    goalHint: null,
    shouldUnlinkGoal: false,
    userFacingIssue: null
  };
}

export function getCustomGmailRuleContextMatches(rules: EmailSignalRule[], pendingAction?: PendingAction): EmailSignalRule[] {
  if (!isPendingCustomGmailRuleContext(pendingAction) || !pendingAction || !isRecord(pendingAction.payload)) {
    return [];
  }

  const focusedRuleId = typeof pendingAction.payload.focusedRuleId === "string" ? pendingAction.payload.focusedRuleId : undefined;
  if (focusedRuleId) {
    const focused = rules.find((rule) => rule.id === focusedRuleId);
    if (focused) {
      return [focused];
    }
  }

  const contextRules = Array.isArray(pendingAction.payload.rules)
    ? pendingAction.payload.rules.filter(isRecord)
    : [];
  const customRuleIds = contextRules
    .filter((rule) => rule.adapterId === "custom_email_review")
    .map((rule) => (typeof rule.id === "string" ? rule.id : ""))
    .filter(Boolean);

  if (customRuleIds.length === 1) {
    const match = rules.find((rule) => rule.id === customRuleIds[0]);
    return match ? [match] : [];
  }

  return [];
}

export function isPronounRuleTarget(target: string): boolean {
  return /^(it|this|that|this rule|that rule|esta|este|esa|ese|aquesta|aquest|aquella|aquell)$/i.test(target.trim());
}

export function hasRulePronoun(message: string, route?: SemanticRouterResult): boolean {
  const text = normalizeForComparison(`${message} ${route?.target ?? ""}`);
  return /\b(it|this|that|that rule|this rule|these emails|those emails|esta regla|esa regla|aquesta regla|aquella regla)\b/.test(text);
}

export function extractLikelyRuleTargetsFromMessage(message: string): string[] {
  return uniqueStrings(
    (message.match(/\b[A-Z][\p{L}0-9]{2,}(?:\s+(?:de|the)\s+[A-Z][\p{L}0-9]{2,}){0,3}/gu) ?? [])
      .map(cleanEmailRuleTarget)
      .filter(isUsefulCustomKeywordCandidate)
  );
}

export function extractGmailRuleQuestionTarget(message: string): string | undefined {
  const text = normalizeForComparison(message);

  if (/\b(work action|work actions|work email|work emails|work mails|work tracking)\b/.test(text)) {
    return "work_action_email";
  }

  if (/\b(job search|job email|job emails|job mails|recruiter|application emails|career emails)\b/.test(text)) {
    return "job_search_email";
  }

  const explicitCustomTarget = extractCustomGmailRuleQuestionEntity(message);
  if (explicitCustomTarget) {
    return explicitCustomTarget;
  }

  const proper = message.match(/\b[A-Z][a-zA-Z0-9]{2,}\b/g)?.find((item) => !/^(Gmail|Email|Mail|Inbox|Rule|Rules|Alecto|I)$/i.test(item));
  if (proper) {
    return proper;
  }

  const match = message.match(/\b(?:about|for|with)\s+(.+?)(?:\s+(?:email|emails|gmail|rule|tracking)\b|[?.]|$)/i);
  return match ? cleanEmailRuleTarget(match[1]) : undefined;
}

export function extractCustomGmailRuleQuestionEntity(message: string): string | undefined {
  const patterns = [
    /\bwhere\s+(?:do|does|will|would|can|could)?\s*(.+?)\s+(?:email|emails|mail|mails)\s+(?:go|land|arrive|show|appear)\b/i,
    /\bwhen\s+(?:do|does|will|would|can|could)?\s*(.+?)\s+(?:email|emails|mail|mails)\s+(?:arrive|come|come in|notify|show|go)\b/i,
    /\b(?:does|do|will|would|can|could)\s+(.+?)\s+(?:auto[\s-]?log|automatically log|create actions?|create events?|go to reviews?|be reviewed)\b/i
  ];

  for (const pattern of patterns) {
    const match = message.match(pattern);
    const target = match ? cleanEmailRuleTarget(match[1] ?? "") : "";
    if (isLikelyCustomGmailQuestionEntity(target)) {
      return target;
    }
  }

  return undefined;
}

export function isLikelyCustomGmailQuestionEntity(target: string): boolean {
  const key = normalizeForComparison(target);
  if (!isUsefulCustomKeywordCandidate(target)) {
    return false;
  }

  return !/\b(u|you|your|me|my|i|we|us|they|them|gmail|email|mail|mails|inbox|check|sync|scan|read|look|notify|tell|let|know|automatic|automatically|background|new|review|reviews|rule|rules|go|arrive|arrives)\b/.test(key);
}

export function findEmailRulesByTarget(rules: EmailSignalRule[], target: string): EmailSignalRule[] {
  const customMatches = findSelectableEmailRulesByTarget(rules.filter((rule) => rule.adapterId === "custom_email_review"), target);
  if (customMatches.length > 0) {
    return customMatches;
  }

  const targetKey = normalizeForComparison(cleanEmailRuleTarget(target));
  return rules.filter((rule) => {
    const haystack = normalizeForComparison(`${rule.name} ${rule.adapterId} ${rule.query ?? ""}`);
    return targetKey.length > 2 && haystack.includes(targetKey);
  });
}

export function formatEmailRuleQueryForHumans(query: string | undefined): string {
  if (!query) {
    return "default adapter query";
  }

  const clean = query
    .replace(/\bnewer_than:\d+d\b/gi, "")
    .replace(/\bfrom:/gi, "from ")
    .replace(/"/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return clean || "default adapter query";
}


export function looksLikeEmailRuleOrGmailConversationText(text: string): boolean {
  const hasEmailSurface = /\b(gmail|email|emails|mail|mails|inbox|correo|correos)\b/.test(text);
  const hasEmailRuleSurface = /\b(rule|rules|regla|reglas|checks?|tracking|track|watch|monitor)\b/.test(text);
  const hasEmailOperation =
    /\b(sync|check|connect|setup|set up|status|settings|configure|show|list|what|which|que|qué|delete|remove|clear|reset|archive|pause|resume|enable|activate|elimina|eliminar|borra|borrar|pausa|pausar|reanuda|reanudar|activa|activar)\b/.test(
      text
    );

  if ((hasEmailSurface || hasEmailRuleSurface) && hasEmailOperation) {
    return true;
  }

  return (
    /\b(endesa|aigues|aigües|barcelona)\b/.test(text) &&
    /\b(rule|rules|regla|reglas|email|emails|gmail|tracking|track|watch|monitor|delete|remove|clear|reset|archive|pause|resume|elimina|eliminar|borra|borrar|pausa|pausar)\b/.test(
      text
    )
  );
}
