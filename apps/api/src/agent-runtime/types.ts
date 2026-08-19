import type {
  ActionItem,
  EmailReviewItem,
  EmailSignalRule,
  IntegrationConnection,
  PendingAction,
  ensureUser
} from "@operator-agent/db";
import type { Goal, MemoryEntry, StoredEvent, UserOperatingProfile } from "@operator-agent/core";

export type AgentUser = Awaited<ReturnType<typeof ensureUser>>;

export type AgentChannel = "telegram" | "web" | "api";

export interface AgentMessageRequest {
  userId: string;
  message: string;
  channel: AgentChannel;
}

export interface AgentMessageResponse {
  reply: string;
  operationsPlanned: PlannedOperation[];
  operationsExecuted: ExecutedOperation[];
  needsConfirmation: boolean;
  debug: AgentDebugInfo;
}

/**
 * The default, user-facing shape of an executed operation — no raw DB rows,
 * Gmail queries, connection ids, or other internals. The route strips
 * ExecutedOperation down to this unless the request opts into debugRaw.
 */
export type PublicExecutedOperation = Pick<ExecutedOperation, "tool" | "status" | "summary" | "error" | "entities">;

export interface PublicAgentMessageResponse extends Omit<AgentMessageResponse, "operationsExecuted"> {
  operationsExecuted: PublicExecutedOperation[];
}

export interface AgentDebugInfo {
  runtime: "agent_v3";
  plannerUsed: "llm" | "fallback" | "none";
  llmPlannerAttempted: boolean;
  llmPlannerUsed: boolean;
  toolValidationPassed: boolean;
  mutationExecuted: boolean;
  conversationTopic: string | null;
  pendingOperation: boolean;
  /**
   * True whenever a legacy PendingAction (from a slash-command flow like
   * /action_hygiene, a Gmail rule proposal, etc.) blocked or redirected this
   * turn. See ContextBundle.legacyPendingAction and runtime.ts's handling of
   * it — v3 never executes a legacy PendingAction itself, only detects it,
   * defers to /confirm, or safely cancels it via /cancel's own DB function.
   */
  legacyPendingActionDetected: boolean;
  /**
   * Dev/test-only diagnostic snapshot of a planning.* turn's full pipeline, populated only
   * when AGENT_RUNTIME_PLANNING_TRACE=true (never set in production) and only for turns that
   * actually touch a planning tool or a planning pendingOperation. Contains the user's own
   * message/plan args for their own turn, nothing cross-user — still gated behind the env
   * var so it never appears in a normal response. See runtime.ts's recordPlanningTrace.
   */
  planningTrace?: PlanningTraceEntry;
}

export interface PlanningTraceEntry {
  message: string;
  plannedTool: string | null;
  plannedArgs: Record<string, unknown> | null;
  validationStatus: ValidatedOperationStatus | null;
  validationError: string | null;
  resolvedArgs: Record<string, unknown> | null;
  executorStatus: ExecutedOperation["status"] | null;
  executorSummary: string | null;
  pendingOperationBefore: AgentPendingOperation | null;
  pendingOperationAfter: AgentPendingOperation | null;
  visibleEntitiesBefore: AgentEntity[];
  visibleEntitiesAfter: AgentEntity[];
  composerSource: string;
}

/** One operation as proposed by the planner, before validation. */
export interface PlannedOperation {
  tool: string;
  args: Record<string, unknown>;
  rationale?: string;
}

export interface RawPlan {
  topic: string;
  intent: string;
  operations: PlannedOperation[];
  needsClarification: boolean;
  clarificationQuestion: string | null;
  replyDraft: string;
}

export type ValidatedOperationStatus =
  | "valid"
  | "needs_confirmation"
  | "needs_clarification"
  | "invalid"
  | "unsupported";

export interface ValidatedOperation {
  tool: string;
  args: Record<string, unknown>;
  status: ValidatedOperationStatus;
  requiresConfirmation: boolean;
  error?: string;
  clarificationQuestion?: string;
  rationale?: string;
}

export interface ExecutedOperation {
  tool: string;
  status: "executed" | "skipped" | "failed";
  summary: string;
  result?: unknown;
  error?: string;
  /** Entities this operation surfaced, to become the session's new visible-entities set (e.g. after action.list). */
  entities?: AgentEntity[];
  /**
   * Lets a "valid"-status (not requiresConfirmation) executed operation directly install,
   * replace, or clear the session's pendingOperation as a side effect of running — used by
   * multi-turn propose/edit/confirm flows (e.g. next-week planning) where the tool that
   * computes and shows the proposal must actually execute to display real data, unlike
   * gmail.rule.create's static pre-execution confirmation prompt. Absent/undefined is a
   * complete no-op (the normal pendingConfirmationOps-driven path in runtime.ts is
   * untouched); explicit null clears any existing pendingOperation.
   */
  pendingOperationUpdate?: { topic: string; summary: string; operations: ValidatedOperation[] } | null;
}

export interface AgentEntity {
  type: "action" | "goal" | "gmail_rule" | "gmail_review" | "memory" | "event" | "plan_suggestion";
  id: string;
  label: string;
  /**
   * 1-based position in the most recently shown numbered list (e.g. an
   * action-hygiene cleanup list), when this entity was surfaced as part of
   * one. Lets a reply like "complete 1" resolve deterministically against
   * ground-truth session state instead of hidden LLM memory. Absent for
   * entities not shown as part of a numbered list.
   */
  index?: number;
}

export interface AgentMutationRecord {
  summary: string;
  at: string;
}

export interface AgentPendingOperation {
  id: string;
  topic: string;
  summary: string;
  operations: ValidatedOperation[];
  createdAt: string;
  expiresAt: string;
}

export interface AgentSessionMessage {
  role: "user" | "assistant";
  text: string;
  at: string;
}

export interface AgentSessionState {
  userId: string;
  channel: string;
  messages: AgentSessionMessage[];
  topic: string | null;
  pendingOperation: AgentPendingOperation | null;
  visibleEntities: AgentEntity[];
  recentMutations: AgentMutationRecord[];
}

export interface ContextBundle {
  user: AgentUser;
  activeGoals: Goal[];
  openActions: ActionItem[];
  recentEvents: StoredEvent[];
  memories: MemoryEntry[];
  gmailConnection: IntegrationConnection | undefined;
  gmailRules: EmailSignalRule[];
  gmailReviews: EmailReviewItem[];
  operatingProfile: UserOperatingProfile;
  session: AgentSessionState;
  /**
   * The user's active legacy PendingAction row, if any — created by a
   * slash-command flow (e.g. /action_hygiene, a custom Gmail rule proposal)
   * that still lives entirely in server.ts's legacy resolver. Deliberately
   * separate from session.pendingOperation, which is v3's own, unrelated
   * confirmation mechanism — the two must never be conflated. v3 only reads
   * this to detect/inform/safely-cancel; it never runs legacy's
   * applyPendingAction itself (that function is entangled with Gmail-rule
   * and action-hygiene helpers that are not safely importable here without
   * a circular import back into server.ts).
   */
  legacyPendingAction: PendingAction | null;
}
