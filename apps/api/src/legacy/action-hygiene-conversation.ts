import { getLocalTodayRange, isRiskControlGoal, parseActionDueDate, type Goal } from "@operator-agent/core";
import {
  completeActionItem,
  confirmPendingAction,
  getActionItem,
  getActionItems,
  getActiveGoals,
  getOrCreateNotificationSettings,
  rejectPendingAction,
  replacePendingAction,
  snoozeActionItem,
  type ActionItem,
  type PendingAction
} from "@operator-agent/db";
import type { ActionHygieneAction, ActionHygieneOption, ActionHygieneReport } from "../server-types.js";
import {
  applyActionHygieneBatchOperations,
  type ActionHygieneBatchOperation,
  type HygieneOperation
} from "../actions/hygiene.js";
import { createGoalProgressFromCompletedAction } from "../actions/goal-progress.js";
import {
  readPendingActionCandidates,
  selectPendingActionCandidate,
  toPendingActionCandidate,
  type PendingActionCandidate
} from "../actions/pending-candidate.js";
import { isSnoozedDue } from "../utils/action-item.js";
import { goalPriorityRank } from "../utils/goal-priority.js";
import {
  daysBetween,
  daysBetweenLocalDates,
  formatDateInTimezone,
  formatLocalDateTime,
  pendingDecisionExpiry
} from "../utils/datetime.js";
import { normalizeForComparison } from "../utils/text.js";
import { getUserTimezone } from "../utils/user-timezone.js";

/**
 * Legacy action-hygiene natural-language conversation/session cluster,
 * extracted from apps/api/src/server.ts. Handles hygiene report analysis,
 * pending-action session creation/formatting (used by both the
 * GET /users/:userId/actions/hygiene HTTP route — the backing implementation
 * for Telegram's /action_hygiene and /debug_action_hygiene slash commands —
 * and the legacy conversation surfaces' "clean up my tasks" phrasing), and
 * the free-text batch/single-item hygiene reply parser (used by both the
 * POST /users/:userId/actions/hygiene/reply route and the legacy
 * /messages/process pending-decision resolver). Agent Runtime v3 does not
 * use this module — it has its own independent, single-item action tools.
 * See docs/09-architecture-inventory.md's "Action Hygiene Legacy Conversation
 * Cluster Extraction" for what moved here, what stayed in server.ts (the
 * shared resolvePendingDecisionReply dispatcher, the separate
 * action_target_clarification cluster, and the cross-type "recent action
 * mutation status" tracker), and why.
 */

export async function analyzeActionHygiene(userId: string, now: Date, timezone: string): Promise<ActionHygieneReport> {
  const [actions, goals] = await Promise.all([
    getActionItems(userId, { status: "all", limit: 200 }),
    getActiveGoals(userId)
  ]);
  const today = getLocalTodayRange(now, timezone);
  const goalsById = new Map(goals.map((goal) => [goal.id, goal]));
  const openActions = actions.filter((action) => action.status === "open" || isSnoozedDue(action, now));
  const analyzed = openActions
    .map((action) => analyzeActionHygieneItem(action, goalsById.get(action.goalId ?? ""), today, now, timezone))
    .filter(Boolean) as ActionHygieneAction[];
  const overdueActions = analyzed.filter((action) => action.daysOverdue !== undefined && action.daysOverdue >= 1);
  const staleActions = analyzed.filter((action) => action.daysOverdue !== undefined && action.daysOverdue >= 3);
  const lowPriorityStaleActions = analyzed.filter(
    (action) => action.priority === "low" && action.lastTouchedAt && daysBetween(new Date(action.lastTouchedAt), now) >= 7
  );
  const repeatedlySnoozedActions: ActionHygieneAction[] = [];
  const suggestedCleanupCandidates = uniqueHygieneActions([
    ...staleActions,
    ...overdueActions.filter((action) => !action.linkedGoalTitle || (action.daysOverdue ?? 0) >= 2),
    ...lowPriorityStaleActions
  ]).slice(0, 10);

  return {
    staleActions,
    overdueActions,
    repeatedlySnoozedActions,
    lowPriorityStaleActions,
    suggestedCleanupCandidates,
    summary:
      suggestedCleanupCandidates.length > 0
        ? cleanupDecisionGrammar(suggestedCleanupCandidates.length)
        : overdueActions.length > 0
          ? cleanupDecisionGrammar(overdueActions.length)
        : "Action list is clean enough."
  };
}

export async function createActionHygieneSession(
  userId: string,
  originalText: string,
  now: Date,
  createdBy: string
): Promise<{ report: ActionHygieneReport; timezone: string }> {
  const timezone = await getUserTimezone(userId);
  const report = await analyzeActionHygiene(userId, now, timezone);

  await storeActionHygieneSession(userId, originalText, now, timezone, report, createdBy);

  return { report, timezone };
}

export async function storeActionHygieneSession(
  userId: string,
  originalText: string,
  now: Date,
  timezone: string,
  report: ActionHygieneReport,
  createdBy: string
): Promise<void> {
  const visibleActions = actionHygieneVisibleActions(report);

  await replacePendingAction(userId, {
    type: "action_hygiene",
    summary: report.summary,
    payload: {
      originalText,
      now: now.toISOString(),
      timezone,
      visibleContextType: "action_hygiene_list",
      createdBy,
      candidates: visibleActions.map((candidate) => candidate.actionId),
      candidateActions: visibleActions.map((candidate) => ({
        ...toPendingActionCandidate({
          id: candidate.actionId,
          title: candidate.title,
          status: "open",
          dueAt: candidate.dueAt ? new Date(candidate.dueAt) : undefined,
          goalTitleSnapshot: candidate.linkedGoalTitle
        }),
        recommendedOptions: candidate.recommendedOptions
      }))
    },
    expiresAt: pendingDecisionExpiry()
  });
}

export function analyzeActionHygieneItem(
  action: ActionItem,
  goal: Goal | undefined,
  today: ReturnType<typeof getLocalTodayRange>,
  now: Date,
  timezone: string
): ActionHygieneAction | undefined {
  if (goal && isRiskControlGoal(goal)) {
    return undefined;
  }

  const dueAt = action.dueAt;
  const daysOverdue = dueAt && dueAt < now ? daysBetweenLocalDates(formatDateInTimezone(dueAt, timezone), today.date) : undefined;
  const untouchedDays = daysBetween(action.updatedAt, now);
  const reasons: string[] = [];

  if (daysOverdue !== undefined && daysOverdue >= 1) {
    reasons.push(daysOverdue >= 3 ? `overdue ${daysOverdue} days` : `overdue ${daysOverdue} day${daysOverdue === 1 ? "" : "s"}`);
  }

  if (action.priority === "low" && untouchedDays >= 7) {
    reasons.push(`low priority and untouched ${untouchedDays} days`);
  }

  if (reasons.length === 0) {
    return undefined;
  }

  const goalPriority = goalPriorityRank(goal);
  const recommendedOptions = goalPriority >= 45
    ? ["complete", "snooze", "keep"] as ActionHygieneOption[]
    : action.goalId
      ? ["complete", "snooze", "archive", "keep"] as ActionHygieneOption[]
      : ["complete", "snooze", "archive", "keep"] as ActionHygieneOption[];

  return {
    actionId: action.id,
    title: action.title,
    dueAt: action.dueAt?.toISOString(),
    linkedGoalTitle: action.goalTitleSnapshot,
    priority: action.priority,
    daysOverdue,
    snoozeCount: undefined,
    lastTouchedAt: action.updatedAt.toISOString(),
    reason: reasons.join("; "),
    recommendedOptions
  };
}

export function formatActionHygieneReport(report: ActionHygieneReport): string {
  const visibleActions = actionHygieneVisibleActions(report);

  if (visibleActions.length === 0) {
    return `Action hygiene:\n${report.summary}`;
  }

  return [
    "Action hygiene:",
    report.summary,
    visibleActions.some((action) => action.daysOverdue !== undefined && action.daysOverdue >= 1)
      ? ["Overdue:", ...visibleActions.map((action, index) => `${index + 1}. ${formatHygieneActionLine(action)}`)].join("\n")
      : undefined,
    "",
    "Suggested cleanup:",
    ...visibleActions.map((action, index) => `${index + 1}. ${action.title}: ${action.recommendedOptions.join(", ")}?`),
    "",
    "Reply with:",
    ...formatActionHygieneReplyExamples(visibleActions)
  ]
    .filter((line) => line !== undefined)
    .join("\n");
}

export function actionHygieneVisibleActions(report: ActionHygieneReport): ActionHygieneAction[] {
  return uniqueHygieneActions([
    ...report.overdueActions,
    ...report.suggestedCleanupCandidates
  ]).slice(0, 10);
}

export function formatActionHygieneReplyExamples(actions: ActionHygieneAction[]): string[] {
  const examples: string[] = [];
  const firstSnooze = actions.find((action) => action.recommendedOptions.includes("snooze"));
  const firstComplete = actions.find((action) => action.recommendedOptions.includes("complete"));
  const firstArchive = actions.find((action) => action.recommendedOptions.includes("archive"));
  const firstKeep = actions.find((action) => action.recommendedOptions.includes("keep"));

  if (firstSnooze) {
    examples.push(`- "snooze ${actions.indexOf(firstSnooze) + 1} tomorrow"`);
  }

  if (firstComplete) {
    examples.push(`- "complete ${actions.indexOf(firstComplete) + 1}"`);
  }

  if (firstArchive) {
    examples.push(`- "archive ${actions.indexOf(firstArchive) + 1}"`);
  }

  if (firstKeep) {
    examples.push(`- "keep ${actions.indexOf(firstKeep) + 1}"`);
  }

  return examples;
}

export function formatActionHygieneDebug(report: ActionHygieneReport): string {
  return [
    "Action hygiene debug:",
    `summary: ${report.summary}`,
    `overdue: ${report.overdueActions.length}`,
    ...report.overdueActions.map((action) => `- ${action.title}: ${action.reason}; options=${action.recommendedOptions.join("/")}`),
    `stale: ${report.staleActions.length}`,
    ...report.staleActions.map((action) => `- ${action.title}: ${action.reason}`),
    `repeatedly snoozed: ${report.repeatedlySnoozedActions.length}`,
    `low priority stale: ${report.lowPriorityStaleActions.length}`,
    ...report.lowPriorityStaleActions.map((action) => `- ${action.title}: ${action.reason}`),
    `suggested cleanup: ${report.suggestedCleanupCandidates.length}`,
    ...report.suggestedCleanupCandidates.map((action) => `- ${action.title}: ${action.reason}`)
  ].join("\n");
}

export function formatHygieneActionLine(action: ActionHygieneAction): string {
  return [
    `${action.title} - overdue ${action.daysOverdue ?? 0} day${action.daysOverdue === 1 ? "" : "s"}`,
    action.linkedGoalTitle ? `goal: ${action.linkedGoalTitle}` : undefined
  ]
    .filter(Boolean)
    .join(" - ");
}

export function cleanupDecisionGrammar(count: number): string {
  return count === 1 ? "1 action needs a cleanup decision." : `${count} actions need cleanup decisions.`;
}

export function uniqueHygieneActions(actions: ActionHygieneAction[]): ActionHygieneAction[] {
  const seen = new Set<string>();
  return actions.filter((action) => {
    if (seen.has(action.actionId)) {
      return false;
    }
    seen.add(action.actionId);
    return true;
  });
}

export async function resolveActionHygieneReply(
  userId: string,
  pendingAction: PendingAction,
  message: string,
  now = new Date()
): Promise<string | undefined> {
  const candidates = readPendingActionCandidates(pendingAction.payload.candidateActions);
  const batchPlan = await planActionHygieneBatchReply(userId, pendingAction, message, candidates, now);

  if (batchPlan) {
    if (batchPlan.errors.length > 0) {
      return batchPlan.errors.join("\n");
    }

    if (batchPlan.missingSnoozeTargets.length > 0) {
      return [
        "I can do that, but I need a snooze time for:",
        ...batchPlan.missingSnoozeTargets.map((candidate) => `- ${candidate.title}`),
        `Try: snooze ${batchPlan.missingSnoozeTargets[0]?.title ?? "that"} tomorrow.`
      ].join("\n");
    }

    if (batchPlan.operations.length === 0) {
      return "I did not find any visible hygiene actions to change.";
    }

    if (batchPlan.requiresConfirmation) {
      await replacePendingAction(userId, {
        type: "action_hygiene",
        summary: `Apply ${batchPlan.operations.length} hygiene action change${batchPlan.operations.length === 1 ? "" : "s"}`,
        payload: {
          operation: "batch_update",
          originalText: message,
          now: now.toISOString(),
          timezone: batchPlan.timezone,
          operations: batchPlan.operations,
          candidateActions: candidates
        },
        expiresAt: pendingDecisionExpiry()
      });

      return formatActionHygieneBatchConfirmation(batchPlan.operations, batchPlan.timezone);
    }

    const applied = await applyActionHygieneBatchOperations(userId, batchPlan.operations, batchPlan.timezone);
    await maybeRememberRecentActionMutationStatusFromReply(userId, applied.reply);
    await closeHygieneSessionIfDone(userId, pendingAction, now);
    return applied.reply;
  }

  if (/^snooze\s+(.+)$/i.test(message.trim()) && !parseActionHygieneReply(message)) {
    return "Add a time for the snooze. Try: snooze 2 tomorrow.";
  }

  const parsed = parseActionHygieneReply(message);

  if (!parsed) {
    return undefined;
  }

  if (parsed.operation === "bulk_archive_unlinked_stale") {
    const report = await analyzeActionHygiene(userId, now, await getUserTimezone(userId));
    const bulkCandidates = report.suggestedCleanupCandidates.filter((candidate) => !candidate.linkedGoalTitle);

    if (bulkCandidates.length === 0) {
      return "No unlinked stale tasks matched for bulk archive.";
    }

    await replacePendingAction(userId, {
      type: "action_hygiene",
      summary: `Archive ${bulkCandidates.length} unlinked stale action${bulkCandidates.length === 1 ? "" : "s"}`,
      payload: {
        operation: "bulk_archive",
        actionIds: bulkCandidates.map((candidate) => candidate.actionId),
        candidateActions: bulkCandidates.map((candidate) => ({
          id: candidate.actionId,
          title: candidate.title,
          dueAt: candidate.dueAt,
          status: "open"
        }))
      },
      expiresAt: pendingDecisionExpiry()
    });

    return [
      `Confirm archive ${bulkCandidates.length} unlinked stale action${bulkCandidates.length === 1 ? "" : "s"}?`,
      ...bulkCandidates.slice(0, 10).map((candidate) => `- ${candidate.title}`),
      "Reply yes to confirm or no to cancel."
    ].join("\n");
  }

  const selected = selectPendingActionCandidate(parsed.target, candidates);

  if (!selected) {
    return candidates.length > 0
      ? `Reply with 1-${candidates.length}, the action title, or cancel.`
      : formatNoVisibleHygieneContextReply(pendingAction);
  }

  if (!hygieneCandidateAllows(selected, parsed.operation)) {
    return formatHygieneOperationUnavailable(selected, parsed.operation);
  }

  const action = await getActionItem(userId, selected.id);

  if (!action || action.status === "archived") {
    await rejectPendingAction(userId, pendingAction.id);
    return "I could not find that action anymore. Use /actions to check the exact task.";
  }

  if (parsed.operation === "keep") {
    await closeHygieneSessionIfDone(userId, pendingAction, now);
    return `Kept for now: ${action.title}`;
  }

  if (parsed.operation === "complete") {
    if (action.status === "completed") {
      await confirmPendingAction(userId, pendingAction.id);
      return `Action already completed: ${action.title}`;
    }

    const completed = await completeActionItem(userId, action.id);

    if (!completed) {
      await rejectPendingAction(userId, pendingAction.id);
      return "I could not find that open action.";
    }

    const progressEvent = await createGoalProgressFromCompletedAction(userId, completed);
    await closeHygieneSessionIfDone(userId, pendingAction, now);

    return [
      `Action completed: ${completed.title}`,
      progressEvent?.created ? `Goal progress logged: ${progressEvent.goalTitle}` : undefined
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (parsed.operation === "archive") {
    await replacePendingAction(userId, {
      type: "action_archive",
      summary: `Archive action: ${action.title}`,
      payload: {
        originalText: message,
        intendedOperation: "archive_action",
        actionId: action.id,
        candidateActions: [toPendingActionCandidate(action)]
      },
      expiresAt: pendingDecisionExpiry()
    });

    return `Confirm archive action: ${action.title}? Reply yes to confirm or no to cancel.`;
  }

  if (parsed.operation === "snooze") {
    const settings = await getOrCreateNotificationSettings(userId);
    const parsedTime = parseActionDueDate(parsed.timeText ?? "", {
      now,
      timezone: settings.timezone,
      preferences: settings
    });

    if (parsedTime.invalidReason === "past_explicit_time") {
      return "That snooze time has already passed.";
    }

    if (!parsedTime.dueAt) {
      return "I could not parse the snooze time. Try: snooze 1 tomorrow.";
    }

    const updated = await snoozeActionItem(userId, action.id, parsedTime.dueAt);

    if (!updated) {
      await rejectPendingAction(userId, pendingAction.id);
      return "I could not update that action.";
    }

    await closeHygieneSessionIfDone(userId, pendingAction, now);
    return `Action snoozed until ${formatLocalDateTime(updated.snoozedUntil, settings.timezone)}: ${updated.title}`;
  }

  return undefined;
}

export function formatNoVisibleHygieneContextReply(pendingAction?: PendingAction): string {
  const summary = typeof pendingAction?.summary === "string" ? pendingAction.summary : "";
  const payloadSummary = typeof pendingAction?.payload?.summary === "string" ? pendingAction.payload.summary : "";
  const text = `${summary} ${payloadSummary}`.toLowerCase();

  if (text.includes("clean enough")) {
    return "I don't have a visible cleanup item right now. Your action list is clean enough.";
  }

  return "I don't have a visible cleanup item right now. Say 'clean up my tasks' first.";
}

export type ActionHygieneBatchPlan = {
  operations: ActionHygieneBatchOperation[];
  missingSnoozeTargets: PendingActionCandidate[];
  errors: string[];
  requiresConfirmation: boolean;
  timezone: string;
};

export async function planActionHygieneBatchReply(
  userId: string,
  pendingAction: PendingAction,
  message: string,
  candidates: PendingActionCandidate[],
  now: Date
): Promise<ActionHygieneBatchPlan | undefined> {
  const trimmed = normalizeHygieneBatchText(message);
  const comparison = normalizeForComparison(trimmed);

  if (
    !/\b(archive|delete|remove|complete|done|snooze|keep|archiva|arxiva|elimina|borra|pospon|ajorna)\b/.test(comparison) ||
    !(/\b(all|rest|except|menos|excepte|menys|and|y|i)\b/.test(comparison) || trimmed.includes(","))
  ) {
    return undefined;
  }

  const settings = await getOrCreateNotificationSettings(userId);
  const plan: ActionHygieneBatchPlan = {
    operations: [],
    missingSnoozeTargets: [],
    errors: [],
    requiresConfirmation: true,
    timezone: settings.timezone
  };

  if (candidates.length === 0) {
    plan.errors.push(formatNoVisibleHygieneContextReply(pendingAction));
    return plan;
  }

  if (tryPlanKeepOneArchiveRest(trimmed, candidates, plan)) {
    return plan;
  }

  if (await tryPlanAllExceptReply(trimmed, candidates, settings, now, plan)) {
    return plan;
  }

  if (await tryPlanAllReply(trimmed, candidates, settings, now, plan)) {
    return plan;
  }

  if (/\s+(?:and|y|i)\s+(?:archive|delete|remove|complete|done|snooze|keep)\b/i.test(trimmed)) {
    const operationSegments = trimmed
      .split(/\s+(?:and|y|i)\s+/i)
      .map((segment) => segment.trim())
      .filter(Boolean);

    for (const segment of operationSegments) {
      await addHygieneBatchOperationFromSegment(segment, candidates, settings, now, plan);
    }

    return plan;
  }

  if (await tryPlanSharedSnoozeTargets(trimmed, candidates, settings, now, plan)) {
    return plan;
  }

  if (/^(archive|delete|remove|complete|done|keep)\s+.+\b(and|y|i)\b.+$/i.test(trimmed)) {
    await addHygieneBatchOperationFromSegment(trimmed, candidates, settings, now, plan);
    return plan;
  }

  const segments = trimmed
    .split(/\s*,\s*/g)
    .map((segment) => segment.trim())
    .filter(Boolean);

  if (segments.length <= 1) {
    return undefined;
  }

  for (const segment of segments) {
    await addHygieneBatchOperationFromSegment(segment, candidates, settings, now, plan);
  }

  return plan;
}

export function normalizeHygieneBatchText(message: string): string {
  return message
    .trim()
    .replace(/\bu\b/gi, "you")
    .replace(/\bexpect\b/gi, "except")
    .replace(/\s+/g, " ");
}

export function tryPlanKeepOneArchiveRest(
  message: string,
  candidates: PendingActionCandidate[],
  plan: ActionHygieneBatchPlan
): boolean {
  const match = message.match(/^keep\s+(.+?)\s*(?:,|\s+and\s+)?\s*archive\s+(?:the\s+)?rest$/i);
  if (!match) {
    return false;
  }

  const kept = selectPendingActionCandidate(match[1], candidates);
  if (!kept) {
    plan.errors.push(`I could not match "${match[1].trim()}" to one of the visible hygiene actions.`);
    return true;
  }

  addHygieneBatchOperation(plan, kept, "keep");
  for (const candidate of candidates.filter((item) => item.id !== kept.id)) {
    addHygieneBatchOperation(plan, candidate, "archive");
  }
  return true;
}

export async function tryPlanAllExceptReply(
  message: string,
  candidates: PendingActionCandidate[],
  settings: Awaited<ReturnType<typeof getOrCreateNotificationSettings>>,
  now: Date,
  plan: ActionHygieneBatchPlan
): Promise<boolean> {
  const match = message.match(/^(archive|delete|remove|complete|done|snooze|keep)\s+all\s+(?:except|menos|excepte|menys)\s+(.+)$/i);
  if (!match) {
    return false;
  }

  const operation = hygieneOperationFromVerb(match[1]);
  const { exceptionText, exceptionSnoozeTimeText, mentionedSnooze } = parseAllExceptException(match[2]);
  const exception = selectPendingActionCandidate(exceptionText, candidates);

  if (!exception) {
    plan.errors.push(`I could not match "${exceptionText}" to one of the visible hygiene actions.`);
    return true;
  }

  const rest = candidates.filter((candidate) => candidate.id !== exception.id);

  if (operation === "snooze") {
    if (!exceptionSnoozeTimeText) {
      plan.missingSnoozeTargets.push(...rest);
    } else {
      await addSnoozeOperations(rest, exceptionSnoozeTimeText, settings, now, plan);
    }
  } else if (operation !== "keep") {
    for (const candidate of rest) {
      addHygieneBatchOperation(plan, candidate, operation);
    }
  }

  if (mentionedSnooze) {
    if (!exceptionSnoozeTimeText) {
      plan.missingSnoozeTargets.push(exception);
    } else {
      await addSnoozeOperations([exception], exceptionSnoozeTimeText, settings, now, plan);
    }
  }

  return true;
}

export function parseAllExceptException(value: string): {
  exceptionText: string;
  exceptionSnoozeTimeText?: string;
  mentionedSnooze: boolean;
} {
  const [beforeComma, ...afterComma] = value.split(/\s*,\s*/);
  const rawException = beforeComma ?? value;
  const tail = afterComma.join(", ");
  const combined = `${rawException} ${tail}`.trim();
  const snoozeMatch = combined.match(/\b(?:snooze|pospone|posponer|ajorna|ajornar)\b(?:\s+(?:that|it|them|ese|esa|aquest|aquesta))?\s*(?:to|until|for|a|hasta|fins)?\s*(.*)$/i);
  const mentionedSnooze = Boolean(snoozeMatch);
  const exceptionText = rawException
    .replace(/\bthat\s+you\s+can\s+(?:snooze|pospone|posponer|ajorna|ajornar).*$/i, "")
    .replace(/\b(?:snooze|pospone|posponer|ajorna|ajornar).*$/i, "")
    .trim();
  const exceptionSnoozeTimeText = snoozeMatch?.[1]?.trim() || undefined;

  return {
    exceptionText,
    exceptionSnoozeTimeText,
    mentionedSnooze
  };
}

export async function tryPlanAllReply(
  message: string,
  candidates: PendingActionCandidate[],
  settings: Awaited<ReturnType<typeof getOrCreateNotificationSettings>>,
  now: Date,
  plan: ActionHygieneBatchPlan
): Promise<boolean> {
  const match = message.match(/^(archive|delete|remove|complete|done|snooze|keep)\s+all(?:\s+(?:to|until|for)\s+(.+))?$/i);
  if (!match) {
    return false;
  }

  const operation = hygieneOperationFromVerb(match[1]);
  if (operation === "snooze") {
    const timeText = match[2]?.trim();
    if (!timeText) {
      plan.missingSnoozeTargets.push(...candidates);
    } else {
      await addSnoozeOperations(candidates, timeText, settings, now, plan);
    }
  } else if (operation !== "keep") {
    for (const candidate of candidates) {
      addHygieneBatchOperation(plan, candidate, operation);
    }
  } else {
    for (const candidate of candidates) {
      addHygieneBatchOperation(plan, candidate, operation);
    }
  }

  return true;
}

export async function tryPlanSharedSnoozeTargets(
  message: string,
  candidates: PendingActionCandidate[],
  settings: Awaited<ReturnType<typeof getOrCreateNotificationSettings>>,
  now: Date,
  plan: ActionHygieneBatchPlan
): Promise<boolean> {
  const match = message.match(/^snooze\s+(.+?)\s+(?:to|until|for)\s+(.+)$/i);
  if (!match || !/\b(and|y|i)\b|,/.test(match[1])) {
    return false;
  }

  const targets = splitHygieneTargetList(match[1]);
  for (const target of targets) {
    const selected = selectPendingActionCandidate(target, candidates);
    if (!selected) {
      plan.errors.push(`I could not match "${target}" to one of the visible hygiene actions.`);
      continue;
    }
    await addSnoozeOperations([selected], match[2], settings, now, plan);
  }

  return true;
}

export async function addHygieneBatchOperationFromSegment(
  segment: string,
  candidates: PendingActionCandidate[],
  settings: Awaited<ReturnType<typeof getOrCreateNotificationSettings>>,
  now: Date,
  plan: ActionHygieneBatchPlan
): Promise<void> {
  const simpleMultiTarget = segment.match(/^(archive|delete|remove|complete|done|keep)\s+(.+)$/i);
  if (simpleMultiTarget && /\b(and|y|i)\b/.test(normalizeForComparison(simpleMultiTarget[2]))) {
    const operation = hygieneOperationFromVerb(simpleMultiTarget[1]);
    for (const target of splitHygieneTargetList(simpleMultiTarget[2])) {
      const selected = selectPendingActionCandidate(target, candidates);
      if (!selected) {
        plan.errors.push(`I could not match "${target}" to one of the visible hygiene actions.`);
      } else {
        addHygieneBatchOperation(plan, selected, operation);
      }
    }
    return;
  }

  const missingSnooze = segment.match(/^snooze\s+(.+)$/i);
  const parsed = parseActionHygieneReply(segment);

  if (!parsed) {
    if (missingSnooze) {
      const selected = selectPendingActionCandidate(missingSnooze[1], candidates);
      if (selected) {
        plan.missingSnoozeTargets.push(selected);
      } else {
        plan.errors.push(`I could not match "${missingSnooze[1].trim()}" to one of the visible hygiene actions.`);
      }
      return;
    }

    plan.errors.push(`Could not handle "${segment}".`);
    return;
  }

  const selected = selectPendingActionCandidate(parsed.target, candidates);
  if (!selected) {
    plan.errors.push(`I could not match "${parsed.target}" to one of the visible hygiene actions.`);
    return;
  }

  if (parsed.operation === "bulk_archive_unlinked_stale") {
    plan.errors.push(`Could not handle "${segment}" inside a batch.`);
    return;
  }

  if (parsed.operation === "snooze") {
    await addSnoozeOperations([selected], parsed.timeText, settings, now, plan);
    return;
  }

  addHygieneBatchOperation(plan, selected, parsed.operation);
}

export function splitHygieneTargetList(value: string): string[] {
  return value
    .split(/\s+(?:and|y|i)\s+|,/i)
    .map((part) => part.trim())
    .filter(Boolean);
}

export async function addSnoozeOperations(
  candidates: PendingActionCandidate[],
  timeText: string,
  settings: Awaited<ReturnType<typeof getOrCreateNotificationSettings>>,
  now: Date,
  plan: ActionHygieneBatchPlan
): Promise<void> {
  const parsedTime = parseActionDueDate(timeText, {
    now,
    timezone: settings.timezone,
    preferences: settings
  });

  if (parsedTime.invalidReason === "past_explicit_time") {
    plan.errors.push("That snooze time has already passed.");
    return;
  }

  if (!parsedTime.dueAt) {
    plan.missingSnoozeTargets.push(...candidates);
    return;
  }

  for (const candidate of candidates) {
    addHygieneBatchOperation(plan, candidate, "snooze", timeText, parsedTime.dueAt.toISOString());
  }
}

export function addHygieneBatchOperation(
  plan: ActionHygieneBatchPlan,
  candidate: PendingActionCandidate,
  operation: HygieneOperation,
  timeText?: string,
  dueAt?: string
): void {
  if (!hygieneCandidateAllows(candidate, operation)) {
    plan.errors.push(formatHygieneOperationUnavailable(candidate, operation));
    return;
  }

  plan.operations.push({
    operation,
    actionId: candidate.id,
    title: candidate.title,
    timeText,
    dueAt
  });
}

export function hygieneCandidateAllows(candidate: PendingActionCandidate, operation: HygieneOperation): boolean {
  return !candidate.recommendedOptions || candidate.recommendedOptions.length === 0 || candidate.recommendedOptions.includes(operation);
}

export function formatHygieneOperationUnavailable(candidate: PendingActionCandidate, operation: HygieneOperation): string {
  const options = candidate.recommendedOptions && candidate.recommendedOptions.length > 0
    ? candidate.recommendedOptions
    : ["complete", "snooze", "keep"] as ActionHygieneOption[];

  if (operation === "archive") {
    return `I can ${formatInlineOptions(options)} ${candidate.title}, but archive is not available for this item.`;
  }

  return `${candidate.title}: ${operation} is not available. I can ${formatInlineOptions(options)} this action.`;
}

export function formatInlineOptions(options: ActionHygieneOption[]): string {
  const unique = [...new Set(options)];
  if (unique.length <= 1) {
    return unique[0] ?? "keep";
  }

  return `${unique.slice(0, -1).join(", ")}, or ${unique[unique.length - 1]}`;
}

export function hygieneOperationFromVerb(value: string): HygieneOperation {
  const verb = value.toLowerCase();
  if (verb === "done") {
    return "complete";
  }
  if (verb === "delete" || verb === "remove" || verb === "archiva" || verb === "arxiva" || verb === "elimina" || verb === "borra") {
    return "archive";
  }
  if (verb === "pospon" || verb === "ajorna") {
    return "snooze";
  }
  return verb as HygieneOperation;
}

export function formatActionHygieneBatchConfirmation(operations: ActionHygieneBatchOperation[], timezone: string): string {
  return [
    "I will:",
    ...operations.map((operation) => `- ${formatActionHygieneBatchOperation(operation, timezone)}`),
    "Confirm with \"yes\" or cancel."
  ].join("\n");
}

export function formatActionHygieneBatchOperation(operation: ActionHygieneBatchOperation, timezone: string): string {
  if (operation.operation === "archive") {
    return `archive ${operation.title}`;
  }

  if (operation.operation === "complete") {
    return `complete ${operation.title}`;
  }

  if (operation.operation === "keep") {
    return `keep ${operation.title}`;
  }

  const formatted = operation.dueAt ? formatLocalDateTime(new Date(operation.dueAt), timezone) : operation.timeText ?? "the chosen time";
  return `snooze ${operation.title} to ${formatted}`;
}

export async function closeHygieneSessionIfDone(userId: string, pendingAction: PendingAction, now: Date): Promise<void> {
  const candidates = readPendingActionCandidates(pendingAction.payload.candidateActions);
  const remaining = await Promise.all(candidates.map((candidate) => getActionItem(userId, candidate.id)));
  const stillNeedsDecision = remaining.some((action) => {
    if (!action || action.status === "completed" || action.status === "archived") {
      return false;
    }

    if (action.status === "snoozed" && action.snoozedUntil && action.snoozedUntil.getTime() > now.getTime()) {
      return false;
    }

    return true;
  });

  if (!stillNeedsDecision) {
    await confirmPendingAction(userId, pendingAction.id);
  }
}

export function parseActionHygieneReply(message: string):
  | { operation: "complete" | "archive" | "keep"; target: string }
  | { operation: "snooze"; target: string; timeText: string }
  | { operation: "bulk_archive_unlinked_stale"; target: string }
  | undefined {
  const trimmed = message.trim();

  if (!trimmed) {
    return undefined;
  }

  if (/^archive\s+all\s+unlinked\s+stale\s+tasks?$/i.test(trimmed)) {
    return {
      operation: "bulk_archive_unlinked_stale",
      target: "all"
    };
  }

  const snooze = trimmed.match(/^snooze\s+(.+?)\s+(?:to|until|for)?\s*(tomorrow.*|today.*|tonight.*|now|in\s+\d+\s+days?|next\s+\w+.*|\d{4}-\d{2}-\d{2}.*)$/i);

  if (snooze) {
    return {
      operation: "snooze",
      target: snooze[1].trim(),
      timeText: snooze[2].trim()
    };
  }

  const simple = trimmed.match(/^(complete|done|archive|delete|remove|keep)\s+(.+)$/i);

  if (!simple) {
    return undefined;
  }

  const verb = simple[1].toLowerCase();
  const operation = verb === "done"
    ? "complete"
    : verb === "delete" || verb === "remove"
      ? "archive"
      : verb as "complete" | "archive" | "keep";

  return {
    operation,
    target: simple[2].trim()
  };
}

export function looksLikeUnresolvedHygieneReply(message: string): boolean {
  const trimmed = message.trim();

  if (!trimmed) {
    return false;
  }

  return (
    /^snooze\s+(?:#?\d+|first|second|third|fourth|fifth|.+)$/i.test(trimmed) ||
    /^(complete|done|archive|delete|remove|keep)\s+(?:#?\d+|first|second|third|fourth|fifth)$/i.test(trimmed) ||
    /\b(?:complete|done|snooze|archive|delete|remove|keep)\s+#?\d+\s+\band\b\s+(?:complete|done|snooze|archive|delete|remove|keep)\s+#?\d+/i.test(trimmed) ||
    /^(?:archive|delete|remove|complete|done|snooze|keep)\s+all(?:\s+(?:except|menos|excepte|menys)\b.*)?$/i.test(trimmed) ||
    /^(?:archive|delete|remove|complete|done|snooze|keep)\s+.+,\s*(?:archive|delete|remove|complete|done|snooze|keep)\s+.+$/i.test(trimmed)
  );
}

export async function maybeRememberRecentActionMutationStatusFromReply(userId: string, reply: string): Promise<void> {
  if (!replyStartsWithActionMutation(reply)) {
    return;
  }

  await replacePendingAction(userId, {
    type: "action_hygiene",
    summary: "Recent action changes",
    payload: {
      operation: "recent_mutation_status",
      summary: "Recent action changes",
      reply
    },
    expiresAt: new Date(Date.now() + 15 * 60 * 1000)
  });
}

export function replyStartsWithActionMutation(reply: string): boolean {
  return /^(Done:|Action archived:|Archived \d+ actions?:|Action completed:|Action snoozed until|Action rescheduled:)/.test(reply.trim());
}

