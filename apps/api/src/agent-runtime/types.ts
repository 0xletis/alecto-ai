import type {
  ActionItem,
  EmailReviewItem,
  EmailSignalRule,
  IntegrationConnection,
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
}

export interface AgentEntity {
  type: "action" | "goal" | "gmail_rule" | "gmail_review" | "memory" | "event";
  id: string;
  label: string;
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
}
