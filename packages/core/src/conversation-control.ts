import { z } from "zod";
import { normalizeManualActionTitleKey, parseActionDueDate, type ActionReminderPreferences } from "./action-intake.js";
import { evaluateGoalGuardrails } from "./goal-guardrails.js";
import { GoalPrioritySchema, normalizeGoalTitle, type Goal } from "./goals.js";

export const ConversationControlIntentSchema = z.enum([
  "complete_action",
  "archive_action",
  "snooze_action",
  "reschedule_action",
  "show_today",
  "show_actions",
  "set_goal_priority",
  "ask_next_move",
  "goal_guardrail",
  "unknown"
]);

export type ConversationControlIntent = z.infer<typeof ConversationControlIntentSchema>;

export interface ActionSummary {
  id: string;
  title: string;
  status: "open" | "completed" | "snoozed" | "archived";
  dueAt?: Date;
  snoozedUntil?: Date;
  goalId?: string;
  goalTitleSnapshot?: string;
  evidence?: string;
}

export interface GoalSummary {
  id: string;
  title: string;
  status: "active" | "paused" | "archived";
  category: string;
  templateId?: string;
}

export interface ConversationControlDetection {
  intent: ConversationControlIntent;
  confidence: number;
  targetText?: string;
  timeText?: string;
  goalText?: string;
  priority?: z.infer<typeof GoalPrioritySchema>;
  requiresConfirmation: boolean;
  blockedByGuardrail: boolean;
  reason: string;
}

export interface ActionReferenceResolution {
  actionId: string | null;
  confidence: number;
  reason: string;
  ambiguousMatches: ActionSummary[];
  resolvedAction?: ActionSummary;
}

export interface GoalReferenceResolution {
  goalId: string | null;
  confidence: number;
  reason: string;
  ambiguousMatches: GoalSummary[];
  resolvedGoal?: GoalSummary;
}

export interface ConversationControlDebug {
  intent: ConversationControlIntent;
  confidence: number;
  targetText?: string;
  timeText?: string;
  goalText?: string;
  priority?: z.infer<typeof GoalPrioritySchema>;
  resolvedAction?: ActionSummary;
  resolvedGoal?: GoalSummary;
  ambiguousActions?: ActionSummary[];
  ambiguousGoals?: GoalSummary[];
  requiresConfirmation: boolean;
  blockedByGuardrail: boolean;
  reason: string;
}

export function detectConversationControlIntent(text: string): ConversationControlDetection {
  const trimmed = text.trim();
  const lower = normalizeText(trimmed);

  if (!trimmed) {
    return unknown("empty text");
  }

  if (/\b(remember that|remember this|note that|recuerda que|acu[eé]rdate de que|guard[ae] que)\b/i.test(trimmed)) {
    return unknown("explicit memory request should be handled by message processing");
  }

  const guardrail = evaluateGoalGuardrails({ text: trimmed });
  if (guardrail.triggered && !guardrail.isReferenceOnly) {
    return {
      intent: "goal_guardrail",
      confidence: guardrail.confidence,
      requiresConfirmation: false,
      blockedByGuardrail: true,
      reason: guardrail.reason
    };
  }

  const goalPriority = detectGoalPriority(trimmed);
  if (goalPriority) {
    return goalPriority;
  }

  const showToday = /\b(show today|plan today|my plan today|what is my plan today|what'?s my plan today|what is due today|what'?s due today)\b/i.test(trimmed);
  if (showToday) {
    return {
      intent: "show_today",
      confidence: 0.9,
      requiresConfirmation: false,
      blockedByGuardrail: false,
      reason: "natural request for daily brief"
    };
  }

  if (/\b(what should i do now|what is my next move|what'?s my next move|next move|what should i do next)\b/i.test(trimmed)) {
    return {
      intent: "ask_next_move",
      confidence: 0.9,
      requiresConfirmation: false,
      blockedByGuardrail: false,
      reason: "natural request for next action"
    };
  }

  if (/\b(show my actions|show actions|list actions|what actions|what tasks|what is open|what'?s open)\b/i.test(trimmed)) {
    return {
      intent: "show_actions",
      confidence: 0.9,
      requiresConfirmation: false,
      blockedByGuardrail: false,
      reason: "natural request to show actions"
    };
  }

  const moveMatch = trimmed.match(/\b(?:move|snooze|reschedule|push)\s+(.+?)\s+(?:to|until|for)\s+(.+)$/i);
  if (moveMatch) {
    return {
      intent: /\bsnooze\b/i.test(trimmed) ? "snooze_action" : "reschedule_action",
      confidence: 0.85,
      targetText: cleanupActionReference(moveMatch[1]),
      timeText: moveMatch[2].trim(),
      requiresConfirmation: false,
      blockedByGuardrail: false,
      reason: "natural action reschedule/snooze request"
    };
  }

  const completeMatch =
    trimmed.match(/\b(?:done with|finished|completed)\s+(.+)$/i) ??
    trimmed.match(/\bmark\s+(.+?)\s+(?:done|complete|completed)$/i);
  if (completeMatch) {
    return {
      intent: "complete_action",
      confidence: 0.86,
      targetText: cleanupActionReference(completeMatch[1]),
      requiresConfirmation: false,
      blockedByGuardrail: false,
      reason: "natural action completion request"
    };
  }

  const archiveMatch = trimmed.match(/\b(?:remove|archive|delete|clear)\s+(.+?)(?:\s+(?:task|action))?$/i);
  if (archiveMatch && /\b(task|action)\b/i.test(trimmed)) {
    return {
      intent: "archive_action",
      confidence: 0.82,
      targetText: cleanupActionReference(archiveMatch[1]),
      requiresConfirmation: true,
      blockedByGuardrail: false,
      reason: "natural destructive action archive request"
    };
  }

  if (lower === "today" || lower === "show today") {
    return {
      intent: "show_today",
      confidence: 0.8,
      requiresConfirmation: false,
      blockedByGuardrail: false,
      reason: "short daily brief request"
    };
  }

  return unknown("no conversational control intent matched");
}

export function isConversationalMutationIntent(intent: ConversationControlIntent): boolean {
  return intent === "complete_action" || intent === "archive_action" || intent === "snooze_action" || intent === "reschedule_action";
}

export function resolveActionReference(
  _userId: string,
  text: string,
  candidateActions: ActionSummary[],
  options: { includeCompleted?: boolean; includeArchived?: boolean } = {}
): ActionReferenceResolution {
  const candidates = candidateActions.filter(
    (action) =>
      action.status === "open" ||
      action.status === "snoozed" ||
      (options.includeCompleted && action.status === "completed") ||
      (options.includeArchived && action.status === "archived")
  );
  const targetKey = normalizeReferenceKey(text);

  if (!targetKey) {
    return {
      actionId: null,
      confidence: 0,
      reason: "empty action reference",
      ambiguousMatches: []
    };
  }

  const scored = candidates
    .map((action) => ({ action, score: scoreActionReference(targetKey, action) }))
    .filter((item) => item.score >= 0.45)
    .sort((left, right) => right.score - left.score);

  if (scored.length === 0) {
    return {
      actionId: null,
      confidence: 0,
      reason: "no open/snoozed action matched the reference",
      ambiguousMatches: []
    };
  }

  const best = scored[0];
  const closeMatches = scored.filter((item) => Math.abs(item.score - best.score) <= 0.05);

  if (closeMatches.length > 1) {
    return {
      actionId: null,
      confidence: best.score,
      reason: "multiple actions matched the reference",
      ambiguousMatches: closeMatches.map((item) => item.action)
    };
  }

  return {
    actionId: best.action.id,
    confidence: best.score,
    reason: best.score >= 0.8 ? "strong action title match" : "weak action title match",
    ambiguousMatches: [],
    resolvedAction: best.action
  };
}

export function resolveGoalReference(text: string, activeGoals: GoalSummary[]): GoalReferenceResolution {
  const targetKey = normalizeReferenceKey(text);

  if (!targetKey) {
    return {
      goalId: null,
      confidence: 0,
      reason: "empty goal reference",
      ambiguousMatches: []
    };
  }

  const scored = activeGoals
    .filter((goal) => goal.status === "active")
    .map((goal) => ({ goal, score: scoreGoalReference(targetKey, goal) }))
    .filter((item) => item.score >= 0.45)
    .sort((left, right) => right.score - left.score);

  if (scored.length === 0) {
    return {
      goalId: null,
      confidence: 0,
      reason: "no active goal matched the reference",
      ambiguousMatches: []
    };
  }

  const best = scored[0];
  const closeMatches = scored.filter((item) => Math.abs(item.score - best.score) <= 0.05);

  if (closeMatches.length > 1) {
    return {
      goalId: null,
      confidence: best.score,
      reason: "multiple goals matched the reference",
      ambiguousMatches: closeMatches.map((item) => item.goal)
    };
  }

  return {
    goalId: best.goal.id,
    confidence: best.score,
    reason: best.score >= 0.75 ? "strong goal match" : "weak goal match",
    ambiguousMatches: [],
    resolvedGoal: best.goal
  };
}

export function buildConversationControlDebug(input: {
  text: string;
  actions?: ActionSummary[];
  goals?: GoalSummary[];
}): ConversationControlDebug {
  const detection = detectConversationControlIntent(input.text);
  const actionResolution = detection.targetText
    ? resolveActionReference("", detection.targetText, input.actions ?? [])
    : undefined;
  const goalResolution = detection.goalText
    ? resolveGoalReference(detection.goalText, input.goals ?? [])
    : undefined;

  return {
    intent: detection.intent,
    confidence: detection.confidence,
    targetText: detection.targetText,
    timeText: detection.timeText,
    goalText: detection.goalText,
    priority: detection.priority,
    resolvedAction: actionResolution?.resolvedAction,
    resolvedGoal: goalResolution?.resolvedGoal,
    ambiguousActions: actionResolution?.ambiguousMatches,
    ambiguousGoals: goalResolution?.ambiguousMatches,
    requiresConfirmation:
      detection.requiresConfirmation ||
      Boolean(actionResolution && (!actionResolution.actionId || actionResolution.confidence < 0.8 || actionResolution.ambiguousMatches.length > 0)) ||
      Boolean(goalResolution && (!goalResolution.goalId || goalResolution.confidence < 0.75 || goalResolution.ambiguousMatches.length > 0)),
    blockedByGuardrail: detection.blockedByGuardrail,
    reason: [detection.reason, actionResolution?.reason, goalResolution?.reason].filter(Boolean).join("; ")
  };
}

export function parseConversationControlTime(
  text: string,
  options: {
    now?: Date;
    timezone?: string;
    preferences?: Partial<ActionReminderPreferences>;
  }
) {
  return parseActionDueDate(`action ${text}`, options);
}

function detectGoalPriority(text: string): ConversationControlDetection | undefined {
  const priorityMatch = text.match(/\b(low|medium|high|critical)\s+priority\b/i) ?? text.match(/\b(low|medium|high|critical)\b/i);

  if (!priorityMatch) {
    return undefined;
  }

  if (!/\b(make|set|lower|raise|increase|decrease)\b/i.test(text)) {
    return undefined;
  }

  const priority = GoalPrioritySchema.parse(priorityMatch[1].toLowerCase());
  let goalText = text
    .replace(priorityMatch[0], "")
    .replace(/\b(make|set|lower|raise|increase|decrease)\b/gi, "")
    .replace(/\b(to|as|priority)\b/gi, "")
    .trim();

  if (!goalText) {
    goalText = text.slice(0, priorityMatch.index).trim();
  }

  return {
    intent: "set_goal_priority",
    confidence: 0.84,
    goalText: cleanupGoalReference(goalText),
    priority,
    requiresConfirmation: false,
    blockedByGuardrail: false,
    reason: "natural goal priority update request"
  };
}

function scoreActionReference(targetKey: string, action: ActionSummary): number {
  const titleKey = normalizeReferenceKey(action.title);
  const goalKey = normalizeReferenceKey(action.goalTitleSnapshot ?? "");

  if (targetKey === titleKey || titleKey.includes(targetKey)) {
    return 0.95;
  }

  if (targetKey.includes(titleKey)) {
    return 0.9;
  }

  const targetWords = keywordSet(targetKey);
  const titleWords = keywordSet(titleKey);
  const shared = [...titleWords].filter((word) => targetWords.has(word));
  let score =
    titleWords.size > 0 && targetWords.size > 0
      ? Math.max(shared.length / titleWords.size, shared.length / targetWords.size)
      : 0;

  if (goalKey && [...keywordSet(goalKey)].some((word) => targetWords.has(word))) {
    score += 0.12;
  }

  return Math.min(0.85, score);
}

function scoreGoalReference(targetKey: string, goal: GoalSummary): number {
  const titleKey = normalizeGoalTitle(goal.title);
  const templateKey = normalizeGoalTitle(goal.templateId ?? "");
  const categoryKey = normalizeGoalTitle(goal.category);

  if (targetKey === titleKey || titleKey.includes(targetKey) || targetKey.includes(titleKey)) {
    return 0.95;
  }

  const aliases = goalAliases(goal);
  if (aliases.some((alias) => targetKey.includes(alias))) {
    return 0.9;
  }

  const targetWords = keywordSet(targetKey);
  const titleWords = keywordSet(`${titleKey} ${templateKey} ${categoryKey}`);
  const shared = [...titleWords].filter((word) => targetWords.has(word));
  return Math.min(0.85, titleWords.size > 0 ? shared.length / titleWords.size : 0);
}

function goalAliases(goal: GoalSummary): string[] {
  const text = normalizeGoalTitle(`${goal.title} ${goal.category} ${goal.templateId ?? ""}`);
  const aliases: string[] = [];

  if (/\b(job|career|cv|developer)\b/.test(text)) {
    aliases.push("job search", "job", "career", "cv");
  }
  if (/\b(youtube|channel|video)\b/.test(text)) {
    aliases.push("youtube", "channel", "youtube script");
  }
  if (/\b(car|vehicle)\b/.test(text)) {
    aliases.push("car", "cheap car", "car listings");
  }
  if (/\b(strength|health|gym|energy)\b/.test(text)) {
    aliases.push("strength", "health", "gym");
  }
  if (/\b(read|reading|learning)\b/.test(text)) {
    aliases.push("reading", "read");
  }

  return aliases;
}

function cleanupActionReference(text: string): string {
  return text
    .replace(/\b(the|that|this|my)\b/gi, " ")
    .replace(/\b(task|action|item)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanupGoalReference(text: string): string {
  return text
    .replace(/\b(goal|priority)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeReferenceKey(text: string): string {
  return normalizeManualActionTitleKey(text)
    .replace(/\b(the|that|this|my|task|action|item|goal|priority)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function keywordSet(text: string): Set<string> {
  return new Set(
    normalizeText(text)
      .split(" ")
      .filter((word) => word.length >= 3 && !["the", "that", "this", "task", "action", "item", "goal"].includes(word))
  );
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function unknown(reason: string): ConversationControlDetection {
  return {
    intent: "unknown",
    confidence: 0,
    requiresConfirmation: false,
    blockedByGuardrail: false,
    reason
  };
}
