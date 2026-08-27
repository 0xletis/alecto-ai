/**
 * Pure type/interface declarations extracted from apps/api/src/server.ts as a
 * safe, behavior-invariant cleanup step (TypeScript types are fully erased at
 * compile time, so relocating them cannot change runtime behavior — any
 * wiring mistake is caught immediately by `tsc`, not shipped silently).
 *
 * These types describe shapes used throughout server.ts's legacy helper
 * functions (daily brief/operator-attention, weekly review, action hygiene,
 * next-week planning, daily coach, Gmail/GitHub sync). This file does not
 * change any of that logic — it only holds the shapes it's typed with.
 */

import type { ActionItem, ActionItemReminderType, getActiveGoals } from "@operator-agent/db";
import type { DailyCoachResponse, Goal, MemoryEntry, StoredEvent } from "@operator-agent/core";
import type { buildConversationControlDebugForUser, sanitizeActionItem } from "./server.js";

export interface GithubCommit {
  sha: string;
  html_url?: string;
  author?: {
    login?: string;
  } | null;
  committer?: {
    login?: string;
  } | null;
  commit: {
    message: string;
    author?: {
      name?: string;
      email?: string;
      date?: string;
    } | null;
    committer?: {
      name?: string;
      email?: string;
      date?: string;
    } | null;
  };
}

export interface GmailTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

export interface GmailStoredToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  tokenType: string;
  scope: string;
}

export interface GmailMessage {
  id: string;
  threadId?: string;
  snippet?: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: GmailMessagePart;
}

export interface EmailRuleSyncSummary {
  ruleId: string;
  adapterId: string;
  query?: string;
  fetchStrategy: string;
  classifierMode: string;
  lookbackDays: number;
  maxMessagesPerSync: number;
  maxEventsPerSync: number;
  messagesFound: number;
  processed: number;
  ignoredUnknown: number;
  filteredMarketing: number;
  needsReview: number;
  llmClassified: number;
  llmUnavailable: number;
  llmErrors: number;
  llmNeedsReview: number;
  llmIgnored: number;
  aiMessagesChecked: number;
  aiRuleMatches: number;
  aiRuleMatchSkipped: number;
  aiRuleMatchUnavailable: number;
  aiRuleMatchErrors: number;
  reviewItemsCreated: number;
  reviewItemsAlreadyPending: number;
  reviewItemsRejectedDeduped: number;
  reviewItemsSemanticDeduped: number;
  lowConfidenceIgnored: number;
  deduped: number;
  semanticDeduped: number;
  archivedCleanupReprocessed: number;
  skippedDueMaxEventsPerSync: number;
  eventsCreated: number;
  /** Per-eventType count of classified job-search signals (recruiter reply, application
   * confirmation, etc.) found this sync, regardless of whether each one was auto-logged or sent
   * to review — keyed by the same career.* eventType strings classifyJobSearchEmail produces.
   * Non-job-search rules never populate this. */
  signalCounts: Record<string, number>;
  lastError?: string;
  lastErrorStage?: GmailErrorStage;
  reviewCandidateDebug: EmailReviewCandidateDebug[];
  syncDecisionDebug: GmailSyncDecisionDebug[];
}

export interface GmailSyncDecisionDebug {
  messageId?: string;
  subject?: string;
  from?: string;
  date?: string;
  labels?: string[];
  matchedRuleId?: string;
  matchedRuleName?: string;
  decision: "created_review" | "already_pending" | "rejected_deduped" | "approved_deduped" | "active_event_deduped" | "skipped";
  skipReason?: string;
  confidence?: number;
  suggestedReviewTitle?: string;
  detectedDateOrDeadline?: string | null;
}

export interface GmailLastSyncDiagnostics {
  checkedAt: string;
  connectionId: string;
  status: "success" | "error";
  aiRuleMatcher: "available" | "unavailable" | "degraded" | "error";
  aiRuleMatcherReason?: string;
  rules: Array<{
    id: string;
    name: string;
    adapterId: string;
  }>;
  summary: {
    messagesChecked: number;
    processed: number;
    reviewItemsCreated: number;
    eventsCreated: number;
    llmClassified: number;
    llmUnavailable: number;
    llmErrors: number;
  };
  decisions: GmailSyncDecisionDebug[];
  error?: string;
  errorStage?: GmailErrorStage;
}

export interface EmailReviewCandidateDebug {
  subject?: string;
  from?: string;
  proposedEventType?: string;
  company?: string;
  role?: string;
  project?: string;
  deadline?: string;
  actionRequired?: boolean;
  decision:
    | "created"
    | "existing_pending"
    | "existing_rejected"
    | "existing_approved"
    | "active_event_exists"
    | "archived_ignored"
    | "invalid_ignored";
  matchedReviewId?: string;
  matchedReviewStatus?: string;
  matchedEventId?: string;
  semanticKey: string;
}

export interface EmailRuleDiagnostics {
  totalEmailRules: number;
  rulesForConnection: number;
  activeRulesForConnection: number;
  staleOrArchivedRules: number;
  rejectedRuleReasons: string[];
}

export type GmailErrorStage =
  | "rule_loading"
  | "token_refresh"
  | "gmail_search"
  | "gmail_message_fetch"
  | "classification"
  | "event_creation";

export interface DailyOperatorBrief {
  date: string;
  summary: string;
  coach: DailyCoachResponse;
  coachDebug: DailyCoachDebug;
  topPriorities: string[];
  openActions: DailyOperatorBriefAction[];
  overdueActions: DailyOperatorBriefAction[];
  goalStatus: DailyOperatorBriefGoalStatus[];
  recentWins: string[];
  risks: string[];
  emailAttention?: OperatorEmailAttentionSummary;
  actionHygiene?: {
    summary: string;
    needsDecision: number;
  };
  operatorReflection?: string;
  weeklyReviewDue?: boolean;
  suggestedNextStep: string;
  priorityDebug?: DailyOperatorBriefPriorityDebug[];
}

export type OperatorAttentionPriority = "critical" | "high" | "medium" | "low";

export interface OperatorAttentionItem {
  kind: "risk" | "action" | "email_review" | "goal" | "planning" | "hygiene";
  title: string;
  summary: string;
  priority: OperatorAttentionPriority;
  suggestedReply?: string;
  sourceId?: string;
}

export interface OperatorEmailAttentionSummary {
  pendingCount: number;
  workActionCount: number;
  jobSearchCount: number;
  customCount: number;
  otherCount: number;
  handledTodayCount: number;
  approvedTodayCount: number;
  rejectedTodayCount: number;
  gmailDerivedActionItemsToday: number;
  gmailDerivedEventsToday: number;
  topReviewSubjects: string[];
  priority: OperatorAttentionPriority;
  summary: string;
  userFacingLine?: string;
  syncMode: string;
  notificationPreference: "on" | "off";
}

export interface OperatorActionAttentionSummary {
  openCount: number;
  overdueCount: number;
  dueSoonCount: number;
  hygieneNeedsDecision: number;
  topActions: Array<{ id: string; title: string; dueAt?: string; priority: ActionItem["priority"] }>;
  summary: string;
}

export interface OperatorGoalAttentionSummary {
  activeCount: number;
  noProgressCount: number;
  criticalNoProgressCount: number;
  summary: string;
}

export interface OperatorRiskAttentionSummary {
  activeWatchouts: string[];
  guardrailTriggeredToday: boolean;
  summary: string;
}

export interface OperatorPlanningAttentionSummary {
  weeklyReviewDue: boolean;
  latestWeeklyReviewDate?: string;
  summary: string;
}

export interface OperatorAttentionState {
  userId: string;
  date: string;
  timezone: string;
  topAttentionItems: OperatorAttentionItem[];
  recommendedNextMove: string;
  emailAttentionSummary: OperatorEmailAttentionSummary;
  actionAttentionSummary: OperatorActionAttentionSummary;
  goalAttentionSummary: OperatorGoalAttentionSummary;
  riskAttentionSummary: OperatorRiskAttentionSummary;
  planningAttentionSummary: OperatorPlanningAttentionSummary;
  suggestedUserReplies: string[];
  missingClarification?: string;
  confidence: number;
  reasoning: string[];
}

export interface WeeklyReviewContext {
  userId: string;
  timezone: string;
  weekStartLocalDate: string;
  weekEndLocalDate: string;
  reviewedEndLocalDate: string;
  rangeStart: Date;
  rangeEnd: Date;
  activeGoals: Goal[];
  events: StoredEvent[];
  eventsByType: Record<string, number>;
  completedActions: ActionItem[];
  openActions: ActionItem[];
  overdueActions: ActionItem[];
  snoozedOrRescheduledActions: ActionItem[];
  archivedActions: ActionItem[];
  guardrailEvents: StoredEvent[];
  emailAttention: WeeklyEmailAttentionSummary;
  goalProgress: WeeklyGoalProgress[];
  goalsWithProgress: WeeklyGoalProgress[];
  goalsWithoutProgress: WeeklyGoalProgress[];
  actionHygiene: ActionHygieneReport;
  activeReflections: MemoryEntry[];
  dailyLoopCounts: {
    morningBriefs: number;
    eveningReviews: number;
  };
}

export interface WeeklyEmailAttentionSummary {
  reviewsCreated: number;
  reviewsApproved: number;
  reviewsRejected: number;
  pendingReviews: number;
  gmailDerivedActionItems: number;
  gmailDerivedEvents: number;
  byKind: {
    jobSearch: number;
    workAction: number;
    custom: number;
    other: number;
  };
}

export interface WeeklyGoalProgress {
  goalId: string;
  title: string;
  priority?: Goal["priority"];
  isRiskControl: boolean;
  progressCount: number;
  note: string;
}

export interface WeeklyReviewDraft {
  summary: string;
  wins: string[];
  stalls: string[];
  goalProgress: WeeklyGoalProgress[];
  guardrailSummary: Record<string, unknown>;
  patterns: string[];
  recommendedNextWeekActions: string[];
  reflectionIds: string[];
  source: "deterministic" | "llm" | "mixed";
}

export interface WeeklyReviewMemory {
  id: string;
  userId: string;
  weekStartLocalDate: string;
  weekEndLocalDate: string;
  reviewedEndLocalDate: string;
  timezone: string;
  status: "generated" | "archived";
  summary: string;
  wins: string[];
  stalls: string[];
  goalProgress: unknown[];
  guardrailSummary: Record<string, unknown>;
  emailAttention?: WeeklyEmailAttentionSummary;
  patterns: string[];
  recommendedNextWeekActions: string[];
  reflectionIds: string[];
  source: "deterministic" | "llm" | "mixed";
  createdAt: Date;
  updatedAt: Date;
}

export type OperatorReflectionType = "pattern" | "preference" | "friction" | "guardrail_pattern" | "goal_strategy" | "stale_goal";
export type OperatorReflectionSource = "daily_reflection" | "weekly_reflection" | "manual_debug";

export interface OperatorReflectionCandidate {
  type: OperatorReflectionType;
  title: string;
  summary: string;
  evidence: Record<string, unknown>;
  confidence: number;
  source: OperatorReflectionSource;
}

export interface OperatorReflectionContext {
  userId: string;
  timezone: string;
  dateRange: {
    start: string;
    end: string;
    since: Date;
    until: Date;
  };
  activeGoals: Awaited<ReturnType<typeof getActiveGoals>>;
  completedActions: ActionItem[];
  overdueActions: ActionItem[];
  snoozedOrRescheduledActions: ActionItem[];
  archivedActions: ActionItem[];
  events: StoredEvent[];
  guardrailEvents: StoredEvent[];
  existingReflections: MemoryEntry[];
  goalsWithoutProgress: Awaited<ReturnType<typeof getActiveGoals>>;
  counts: {
    completedActions: number;
    overdueActions: number;
    snoozedOrRescheduledActions: number;
    archivedActions: number;
    events: number;
    guardrailTriggers: number;
    activeGoals: number;
    existingReflections: number;
  };
}

export type ActionHygieneOption = "complete" | "snooze" | "archive" | "keep";

export interface ActionHygieneAction {
  actionId: string;
  title: string;
  dueAt?: string;
  linkedGoalTitle?: string;
  priority: ActionItem["priority"];
  daysOverdue?: number;
  snoozeCount?: number;
  lastTouchedAt?: string;
  reason: string;
  recommendedOptions: ActionHygieneOption[];
}

export interface ActionHygieneReport {
  staleActions: ActionHygieneAction[];
  overdueActions: ActionHygieneAction[];
  repeatedlySnoozedActions: ActionHygieneAction[];
  lowPriorityStaleActions: ActionHygieneAction[];
  suggestedCleanupCandidates: ActionHygieneAction[];
  summary: string;
}

export type PlanWindowKind = "next_week" | "current_week";

export interface NextWeekPlanContext {
  userId: string;
  timezone: string;
  now: Date;
  planWindowKind: PlanWindowKind;
  planStartLocalDate: string;
  planEndLocalDate: string;
  nextWeekStartLocalDate: string;
  nextWeekEndLocalDate: string;
  nextWeekRangeStart: Date;
  nextWeekRangeEnd: Date;
  latestWeeklyReview?: WeeklyReviewMemory;
  activeGoals: Goal[];
  goalsWithNoProgress: WeeklyGoalProgress[];
  openActions: ActionItem[];
  staleActions: ActionHygieneAction[];
  activeReflections: MemoryEntry[];
  recentEventsSummary: Record<string, number>;
  guardrailGoals: Goal[];
  guardrailEvents: StoredEvent[];
  emailAttention: WeeklyEmailAttentionSummary;
  futureActionsNextWeek: ActionItem[];
  reviewedWeek: {
    weekStartLocalDate: string;
    weekEndLocalDate: string;
    reviewedEndLocalDate: string;
  };
}

export interface NextWeekPlanSuggestion {
  index: number;
  title: string;
  reason: string;
  goalId?: string;
  goalTitle?: string;
  priority: "low" | "medium" | "high" | "critical";
  actionPriority?: "low" | "medium" | "high";
  suggestedDueAt: Date;
  actionType: "generic";
  source: "weekly_plan";
  duplicateRisk: boolean;
  existingActionId?: string;
  existingActionTitle?: string;
  planKind?: "action" | "cleanup";
  creatable?: boolean;
  notCreatableReason?: string;
  dedupeKey?: string;
}

export type DailyCoachSource = "llm" | "fallback_disabled" | "fallback_invalid" | "fallback_error" | "fallback_timeout";

export interface DailyCoachDebug {
  source: DailyCoachSource;
  llmAttempted: boolean;
  validationStatus: "passed" | "failed" | "skipped";
  validationFailureCodes: string[];
  validationFailureSummary?: string;
  schemaValidationPassed: boolean;
  fallbackReason?: string;
  selectedActionTitle?: string;
  rawResponseType?: "json_object" | "text" | "empty" | "unknown";
  parsedFieldsPresent?: string[];
  responseLength?: number;
  diagnosisLength?: number;
  nextMoveLength?: number;
  warningLength?: number;
  encouragementLength?: number;
}

export interface DailyCoachGenerationResult {
  coach: DailyCoachResponse;
  debug: DailyCoachDebug;
}

export interface ConversationControlResponse {
  handled: boolean;
  reply?: string;
  debug: Awaited<ReturnType<typeof buildConversationControlDebugForUser>>;
  action?: unknown;
  goal?: unknown;
  brief?: DailyOperatorBrief;
  actions?: unknown[];
}

export interface DailyOperatorBriefAction {
  id: string;
  title: string;
  status: ActionItem["status"];
  priority: ActionItem["priority"];
  dueAt?: string;
  snoozedUntil?: string;
  goalId?: string;
  goalTitle?: string;
}

export interface DailyOperatorBriefGoalStatus {
  goalId: string;
  title: string;
  status: string;
  note: string;
  openActionTitle?: string;
  completedActionTitle?: string;
}

export interface DailyOperatorBriefPriorityDebug {
  rank: number;
  actionId: string;
  title: string;
  score: number;
  rankReason: string;
  factors: string[];
}

export interface ActionReminderDispatch {
  actionItem: ReturnType<typeof sanitizeActionItem>;
  reminderType: ActionItemReminderType;
  message: string;
}

export interface GmailMessagePart {
  mimeType?: string;
  headers?: Array<{
    name: string;
    value: string;
  }>;
  body?: {
    data?: string;
  };
  parts?: GmailMessagePart[];
}
