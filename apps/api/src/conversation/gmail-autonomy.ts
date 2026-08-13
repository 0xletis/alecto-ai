import {
  effectiveGmailSyncIntervalMinutes,
  effectiveGmailSyncMode,
  gmailReviewNotificationsEnabled,
  gmailScheduledSyncRuntimeFromEnv,
  readGmailAutonomyPreferences,
  type GmailScheduledSyncRuntime,
  type GmailSyncMode
} from "@operator-agent/core";
import type { Goal } from "@operator-agent/core";
import {
  getActiveGoals,
  getEmailSignalRules,
  getIntegrationConnections,
  getOrCreateNotificationSettings,
  prisma,
  type EmailSignalRule,
  type IntegrationConnection
} from "@operator-agent/db";

export type GmailRuleKind = "job_search" | "work_action" | "custom" | "other";

export interface GmailRuleRecommendation {
  kind: GmailRuleKind;
  label: string;
  reason: string;
  example: string;
}

export interface GmailAutonomyState {
  gmailConnected: boolean;
  gmailAccount?: string;
  primaryConnection?: IntegrationConnection;
  activeRules: EmailSignalRule[];
  pausedRules: EmailSignalRule[];
  visibleRules: EmailSignalRule[];
  ruleKinds: GmailRuleKind[];
  pendingEmailReviewCount: number;
  lastSyncedAt?: Date;
  manualSyncAvailable: true;
  scheduledSyncAvailable: boolean;
  scheduledSyncEnabled: boolean;
  syncIntervalMinutes: number;
  syncMode: GmailSyncMode;
  reviewNotificationEnabled: boolean;
  notificationDeliveryAvailable: boolean;
  deliveryChannel: string;
  dailyDigestEnabled: false;
  dailyDigestSupported: false;
  workHoursOnlyEnabled: false;
  workHoursSupported: false;
  activeGoalsRelevantToGmail: Array<{ id: string; title: string; recommendationKind: GmailRuleKind }>;
  recommendedRules: GmailRuleRecommendation[];
  nextBestStep: string;
  runtime: GmailScheduledSyncRuntime;
}

export async function buildGmailAutonomyState(
  userId: string,
  runtime = gmailScheduledSyncRuntimeFromEnv()
): Promise<GmailAutonomyState> {
  const [connections, rules, activeGoals, notificationSettings, pendingEmailReviewCount] = await Promise.all([
    getIntegrationConnections(userId),
    getEmailSignalRules(userId),
    getActiveGoals(userId),
    getOrCreateNotificationSettings(userId),
    prisma.emailReviewItem.count({
      where: {
        userId,
        status: "pending"
      }
    })
  ]);
  const gmailConnections = connections.filter((connection) => connection.integrationId === "gmail" && connection.status !== "archived");
  const activeGmailConnections = gmailConnections.filter((connection) => connection.status === "active");
  const primaryConnection = activeGmailConnections[0] ?? gmailConnections[0];
  const activeConnectionIds = new Set(activeGmailConnections.map((connection) => connection.id));
  const visibleConnectionIds = new Set(gmailConnections.map((connection) => connection.id));
  const visibleRules = rules.filter((rule) => rule.status !== "archived" && visibleConnectionIds.has(rule.connectionId));
  const activeRules = visibleRules.filter((rule) => rule.status === "active" && activeConnectionIds.has(rule.connectionId));
  const pausedRules = visibleRules.filter((rule) => rule.status !== "active");
  const preferences = readGmailAutonomyPreferences(primaryConnection?.config);
  const syncMode = primaryConnection ? effectiveGmailSyncMode(preferences, runtime) : "unknown";
  const syncIntervalMinutes = effectiveGmailSyncIntervalMinutes(preferences, runtime);
  const recommendedRules = gmailRuleRecommendationsFromGoals(activeGoals, activeRules);
  const activeGoalsRelevantToGmail = relevantGmailGoals(activeGoals, activeRules);
  const lastSyncedAt = activeGmailConnections
    .map((connection) => connection.lastSyncedAt)
    .filter((value): value is Date => Boolean(value))
    .sort((left, right) => right.getTime() - left.getTime())[0];

  return {
    gmailConnected: activeGmailConnections.length > 0,
    gmailAccount: gmailAccountFromConnection(primaryConnection),
    primaryConnection,
    activeRules,
    pausedRules,
    visibleRules,
    ruleKinds: [...new Set(activeRules.map(gmailRuleKind))],
    pendingEmailReviewCount,
    lastSyncedAt,
    manualSyncAvailable: true,
    scheduledSyncAvailable: true,
    scheduledSyncEnabled: syncMode === "scheduled" && runtime.scheduledSyncEnabled,
    syncIntervalMinutes,
    syncMode,
    reviewNotificationEnabled: gmailReviewNotificationsEnabled(primaryConnection?.config),
    notificationDeliveryAvailable: Boolean(notificationSettings.telegramUserId),
    deliveryChannel: notificationSettings.telegramUserId ? "Telegram" : "not configured",
    dailyDigestEnabled: false,
    dailyDigestSupported: false,
    workHoursOnlyEnabled: false,
    workHoursSupported: false,
    activeGoalsRelevantToGmail,
    recommendedRules,
    nextBestStep: nextBestGmailStep({
      gmailConnected: activeGmailConnections.length > 0,
      activeRules,
      pendingEmailReviewCount,
      recommendedRules,
      syncMode,
      scheduledSyncEnabled: syncMode === "scheduled" && runtime.scheduledSyncEnabled
    }),
    runtime
  };
}

export function gmailRuleKind(rule: Pick<EmailSignalRule, "adapterId">): GmailRuleKind {
  if (rule.adapterId === "job_search_email") {
    return "job_search";
  }

  if (rule.adapterId === "work_action_email") {
    return "work_action";
  }

  if (rule.adapterId === "custom_email_review") {
    return "custom";
  }

  return "other";
}

export function gmailRuleKindLabel(kind: GmailRuleKind): string {
  if (kind === "job_search") {
    return "Job-search email tracking";
  }

  if (kind === "work_action") {
    return "Work-action email tracking";
  }

  if (kind === "custom") {
    return "Custom sender/keyword tracking";
  }

  return "Email tracking";
}

export function gmailRuleBehaviorLabel(rule: Pick<EmailSignalRule, "adapterId" | "reviewBeforeLogging">): string {
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

export function gmailSyncModeSentence(state: Pick<GmailAutonomyState, "syncMode" | "scheduledSyncEnabled" | "syncIntervalMinutes">): string {
  if (state.syncMode === "scheduled" && state.scheduledSyncEnabled) {
    return `Alecto checks active Gmail rules on the worker schedule, about every ${formatIntervalMinutes(state.syncIntervalMinutes)}.`;
  }

  if (state.syncMode === "scheduled") {
    return `Gmail is set to scheduled checks every ${formatIntervalMinutes(state.syncIntervalMinutes)}, but background sync is disabled in this local environment.`;
  }

  return "Alecto checks Gmail when you say 'sync Gmail'.";
}

export function gmailSyncModeShortLabel(state: Pick<GmailAutonomyState, "syncMode" | "scheduledSyncEnabled" | "syncIntervalMinutes">): string {
  if (state.syncMode === "scheduled" && state.scheduledSyncEnabled) {
    return `scheduled, about every ${formatIntervalMinutes(state.syncIntervalMinutes)}`;
  }

  if (state.syncMode === "scheduled") {
    return `scheduled preference saved, background sync off`;
  }

  return "manual only";
}

export function formatIntervalMinutes(minutes: number): string {
  if (minutes === 60) {
    return "hour";
  }

  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hours`;
  }

  return `${minutes} minutes`;
}

function gmailAccountFromConnection(connection?: IntegrationConnection): string | undefined {
  const config = isRecord(connection?.config) ? connection.config : {};
  const email = config.email;
  return typeof email === "string" && email.includes("@") ? email : undefined;
}

function nextBestGmailStep(input: {
  gmailConnected: boolean;
  activeRules: EmailSignalRule[];
  pendingEmailReviewCount: number;
  recommendedRules: GmailRuleRecommendation[];
  syncMode: GmailSyncMode;
  scheduledSyncEnabled: boolean;
}): string {
  if (!input.gmailConnected) {
    return "Connect Gmail with readonly access.";
  }

  if (input.activeRules.length === 0) {
    return input.recommendedRules[0]?.example ?? "Choose one thing for Gmail to watch.";
  }

  if (input.pendingEmailReviewCount > 0) {
    return "Review the pending email items.";
  }

  if (input.syncMode === "scheduled" && !input.scheduledSyncEnabled) {
    return "Manual sync works now; background sync is disabled in this local environment.";
  }

  return input.syncMode === "scheduled" ? "Let scheduled sync run, or say 'sync Gmail' to check now." : "Say 'sync Gmail' when you want to check now.";
}

function relevantGmailGoals(goals: Goal[], activeRules: EmailSignalRule[]): Array<{ id: string; title: string; recommendationKind: GmailRuleKind }> {
  const activeAdapterIds = new Set(activeRules.map((rule) => rule.adapterId));
  const relevant: Array<{ id: string; title: string; recommendationKind: GmailRuleKind }> = [];

  for (const goal of goals) {
    const kind = gmailRecommendationKindForGoal(goal);
    if (!kind) {
      continue;
    }

    if (kind === "job_search" && activeAdapterIds.has("job_search_email")) {
      continue;
    }

    if (kind === "work_action" && activeAdapterIds.has("work_action_email")) {
      continue;
    }

    if (kind === "custom" && activeRules.some((rule) => rule.adapterId === "custom_email_review" && rule.goalId === goal.id)) {
      continue;
    }

    relevant.push({
      id: goal.id,
      title: goal.title,
      recommendationKind: kind
    });
  }

  return relevant;
}

function gmailRuleRecommendationsFromGoals(goals: Goal[], activeRules: EmailSignalRule[]): GmailRuleRecommendation[] {
  const activeAdapterIds = new Set(activeRules.map((rule) => rule.adapterId));
  const recommendations: GmailRuleRecommendation[] = [];
  const relevant = relevantGmailGoals(goals, activeRules);

  for (const item of relevant) {
    if (item.recommendationKind === "job_search" && !activeAdapterIds.has("job_search_email")) {
      pushUniqueRecommendation(recommendations, {
        kind: "job_search",
        label: "Job-search email tracking",
        reason: `Useful for ${item.title}.`,
        example: "Enable job-search email tracking."
      });
    }

    if (item.recommendationKind === "work_action" && !activeAdapterIds.has("work_action_email")) {
      pushUniqueRecommendation(recommendations, {
        kind: "work_action",
        label: "Work-action email tracking",
        reason: `Useful for ${item.title}.`,
        example: "Enable work-action email tracking."
      });
    }

    if (item.recommendationKind === "custom") {
      pushUniqueRecommendation(recommendations, {
        kind: "custom",
        label: "Custom sender/keyword tracking",
        reason: `Useful for ${item.title}.`,
        example: "Create a custom Gmail rule with the sender or keywords to watch."
      });
    }
  }

  if (recommendations.length === 0 && activeRules.length === 0) {
    recommendations.push({
      kind: "other",
      label: "Choose a Gmail tracking rule",
      reason: "Gmail can watch job search, work actions, or a custom sender/keyword rule.",
      example: "Tell me what Gmail should watch."
    });
  }

  return recommendations.slice(0, 3);
}

function pushUniqueRecommendation(recommendations: GmailRuleRecommendation[], recommendation: GmailRuleRecommendation): void {
  if (recommendations.some((item) => item.kind === recommendation.kind)) {
    return;
  }

  recommendations.push(recommendation);
}

function gmailRecommendationKindForGoal(goal: Goal): GmailRuleKind | undefined {
  if (goal.status !== "active") {
    return undefined;
  }

  const text = normalizeText(`${goal.title} ${goal.category} ${goal.templateId ?? ""}`);

  if (/\b(betting|gambling|trading|casino|impulsive betting|control betting)\b/.test(text)) {
    return undefined;
  }

  if (/\b(job|career|developer|cv|resume|recruiter|interview|application|empleo|trabajo|feina|developer job)\b/.test(text)) {
    return "job_search";
  }

  if (
    /\b(work|project|client|dashboard|coding|code|build|shipping|deep work|youtube|creative|startup|agency|freelance|trabajo|projecte|client)\b/.test(text)
  ) {
    return "work_action";
  }

  if (
    !/\b(health|strength|training|gym|workout|sleep|energy|energia|energia)\b/.test(text) &&
    /\b(bill|bills|expense|expenses|finance|utility|utilities|invoice|receipt|admin|tax|electricity|water|power|consumption|factura|facturas|recibo|recibos|luz|agua|aigua|endesa|aigues|aigues|consumo|despesa|despeses)\b/.test(text)
  ) {
    return "custom";
  }

  return undefined;
}

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s@.+-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
