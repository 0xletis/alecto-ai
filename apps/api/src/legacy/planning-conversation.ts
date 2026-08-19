import { parseActionDueDate } from "@operator-agent/core";
import {
  createActionItemIfNotExists,
  getOrCreateNotificationSettings,
  replacePendingAction,
  rejectPendingAction,
  confirmPendingAction,
  type PendingAction
} from "@operator-agent/db";
import {
  actionInputFromPlanSuggestion,
  buildNextWeekPlanContext,
  findEquivalentOpenPlanAction,
  formatPlanDue,
  formatPlanSuggestionGroup,
  formatPlanTitle,
  formatSkippedNextWeekPlanSuggestion,
  getPendingPlanEnd,
  getPendingPlanStart,
  groupPlanSuggestions,
  isCreatableNewPlanSuggestion,
  readPendingNextWeekPlanSuggestions,
  toPendingNextWeekPlanSuggestion
} from "../planning/next-week.js";
import { addDaysToLocalDateString, localDateStartUtc, pendingDecisionExpiry } from "../utils/datetime.js";
import { getUserTimezone } from "../utils/user-timezone.js";
import type { NextWeekPlanContext, NextWeekPlanSuggestion } from "../server-types.js";

/**
 * Legacy next-week/current-week planning conversation cluster, extracted
 * from apps/api/src/server.ts. Handles the legacy PendingAction-coupled
 * reply flow (free-text opt-in-create parsing, storing/updating the
 * "next_week_plan" PendingAction row) for both the
 * POST /users/:userId/next-week-plan HTTP route (the backing implementation
 * for Telegram's /plan_next_week slash command) and the legacy
 * /messages/process conversation surface.
 *
 * The plan-context assembly and plan-suggestion generation this depends on
 * (buildNextWeekPlanContext, generateNextWeekPlanSuggestions, and the pure
 * formatting/dedup helpers) were split out into the non-legacy
 * apps/api/src/planning/next-week.ts module as part of the Next-Week
 * Planning V3 Migration, so Agent Runtime v3 can reuse them without
 * depending on this file's PendingAction-specific reply parser
 * (parseNextWeekPlanReply/resolveNextWeekPlanReply/replacePendingPlan, which
 * remain here). This file re-exports everything from planning/next-week.ts
 * so existing callers (server.ts, legacy/messages-process.ts) are unaffected.
 * See docs/09-architecture-inventory.md's "Next-Week Planning V3 Migration"
 * for the full boundary rationale.
 */

export * from "../planning/next-week.js";

export function formatNextWeekPlanMessage(context: NextWeekPlanContext, suggestions: NextWeekPlanSuggestion[]): string {
  const groups = groupPlanSuggestions(suggestions);
  return [
    formatPlanTitle(context),
    `Planning window: ${context.planStartLocalDate} to ${context.planEndLocalDate}`,
    "",
    "Needs cleanup:",
    ...formatPlanSuggestionGroup(groups.cleanup, context.timezone, "- None."),
    "",
    "Already scheduled:",
    ...formatPlanSuggestionGroup(groups.alreadyScheduled, context.timezone, "- None."),
    "",
    "Suggested new actions:",
    ...formatPlanSuggestionGroup(groups.newActions, context.timezone, "- None."),
    "",
    ...formatNextWeekPlanReplyExamples(suggestions)
  ].join("\n");
}

export async function replacePendingPlan(
  userId: string,
  context: NextWeekPlanContext,
  suggestions: NextWeekPlanSuggestion[],
  originalText: string
) {
  await replacePendingAction(userId, {
    type: "next_week_plan",
    summary: `${formatPlanTitle(context)} - ${context.planStartLocalDate} to ${context.planEndLocalDate}`,
    payload: {
      originalText,
      planWindowKind: context.planWindowKind,
      planStartLocalDate: context.planStartLocalDate,
      planEndLocalDate: context.planEndLocalDate,
      nextWeekStartLocalDate: context.planStartLocalDate,
      nextWeekEndLocalDate: context.planEndLocalDate,
      timezone: context.timezone,
      suggestions: suggestions.map(toPendingNextWeekPlanSuggestion)
    },
    expiresAt: pendingDecisionExpiry()
  });
}

export function parseNextWeekPlanReply(message: string):
  | { operation: "create"; all: true; indexes: number[] }
  | { operation: "create"; all: false; indexes: number[] }
  | { operation: "edit"; index: number; timeText: string }
  | { operation: "remove"; index: number }
  | { operation: "show" }
  | { operation: "skip" | "cancel" }
  | undefined {
  const originalTrimmed = message.trim();
  const trimmed = originalTrimmed.toLowerCase();

  if (/^(skip|cancel|no)$/i.test(trimmed)) {
    return { operation: trimmed === "no" ? "skip" : trimmed as "skip" | "cancel" };
  }

  if (/^show\s+plan$/i.test(trimmed)) {
    return { operation: "show" };
  }

  const edit = originalTrimmed.match(/^edit\s+(\d+)\s+to\s+(.+)$/i);
  if (edit) {
    return { operation: "edit", index: Number(edit[1]), timeText: edit[2].trim() };
  }

  const remove = trimmed.match(/^remove\s+(\d+)$/i);
  if (remove) {
    return { operation: "remove", index: Number(remove[1]) };
  }

  if (/^create\s+all(?:\s+new)?$/i.test(trimmed)) {
    return { operation: "create", all: true, indexes: [] };
  }

  const create = trimmed.match(/^create\s+(.+)$/i);
  if (create) {
    const indexes = [...create[1].matchAll(/\d+/g)].map((match) => Number(match[0])).filter((index) => index > 0);
    return indexes.length > 0 ? { operation: "create", all: false, indexes } : undefined;
  }

  return undefined;
}

export function formatNextWeekPlanReplyExamples(suggestions: NextWeekPlanSuggestion[]): string[] {
  const creatable = suggestions.filter(isCreatableNewPlanSuggestion);

  if (creatable.length === 0) {
    return [
      "Reply:",
      "Nothing new to create.",
      "- run /action_hygiene to resolve cleanup",
      "- ask what should I do today",
      "- skip"
    ];
  }

  const first = creatable[0].index;
  const lines = [
    "Reply:",
    `- create ${first}`
  ];

  if (creatable.length > 1) {
    lines.push(`- create ${first} and ${creatable[1].index}`);
  }

  lines.push(
    "- create all new",
    "- skip",
    `- edit ${first} to Friday morning`
  );

  return lines;
}

export function formatPendingNextWeekPlan(timezone: string, payload: Record<string, unknown>, suggestions: NextWeekPlanSuggestion[]): string {
  const start = getPendingPlanStart(payload);
  const end = getPendingPlanEnd(payload);
  const title = payload.planWindowKind === "current_week" ? "This week plan" : "Next week plan";
  const groups = groupPlanSuggestions(suggestions);

  return [
    title,
    `Planning window: ${start} to ${end}`,
    "",
    "Needs cleanup:",
    ...formatPlanSuggestionGroup(groups.cleanup, timezone, "- None."),
    "",
    "Already scheduled:",
    ...formatPlanSuggestionGroup(groups.alreadyScheduled, timezone, "- None."),
    "",
    "Suggested new actions:",
    ...formatPlanSuggestionGroup(groups.newActions, timezone, "- None."),
    "",
    ...formatNextWeekPlanReplyExamples(suggestions)
  ].join("\n");
}

export async function resolveNextWeekPlanReply(userId: string, pendingAction: PendingAction, message: string): Promise<string | undefined> {
  const parsed = parseNextWeekPlanReply(message);

  if (!parsed) {
    return undefined;
  }

  if (parsed.operation === "skip" || parsed.operation === "cancel") {
    await rejectPendingAction(userId, pendingAction.id);
    return "Skipped next-week plan. No actions created.";
  }

  const timezone = typeof pendingAction.payload.timezone === "string" ? pendingAction.payload.timezone : await getUserTimezone(userId);
  const suggestions = readPendingNextWeekPlanSuggestions(pendingAction.payload.suggestions);

  if (parsed.operation === "show") {
    return formatPendingNextWeekPlan(timezone, pendingAction.payload, suggestions);
  }

  if (parsed.operation === "remove") {
    const kept = suggestions.filter((suggestion) => suggestion.index !== parsed.index)
      .map((suggestion, index) => ({ ...suggestion, index: index + 1 }));

    await replacePendingAction(userId, {
      type: "next_week_plan",
      summary: pendingAction.summary,
      payload: {
        ...pendingAction.payload,
        suggestions: kept.map(toPendingNextWeekPlanSuggestion)
      },
      expiresAt: pendingDecisionExpiry()
    });

    return formatPendingNextWeekPlan(timezone, pendingAction.payload, kept);
  }

  if (parsed.operation === "edit") {
    const suggestion = suggestions.find((item) => item.index === parsed.index);

    if (!suggestion) {
      return `No suggestion ${parsed.index}. Reply show plan to see the current list.`;
    }

    if (suggestion.creatable === false || suggestion.planKind === "cleanup") {
      return `Suggestion ${parsed.index} is cleanup for an existing action. I did not move it. Use /action_hygiene or say: move ${suggestion.existingActionTitle ?? suggestion.title} to ${parsed.timeText}.`;
    }

    if (suggestion.duplicateRisk || suggestion.existingActionId) {
      return `Suggestion ${parsed.index} is already covered by an existing action. I did not move it. To move the existing action, say: move ${suggestion.existingActionTitle ?? suggestion.title} to ${parsed.timeText}.`;
    }

    const planStart = getPendingPlanStart(pendingAction.payload);
    const planEnd = getPendingPlanEnd(pendingAction.payload);
    const parsedTime = parseActionDueDate(parsed.timeText, {
      now: localDateStartUtc(planStart, timezone),
      timezone,
      preferences: await getOrCreateNotificationSettings(userId)
    });
    const dueAt = parsedTime.dueAt;

    if (!dueAt || !planStart || !planEnd || dueAt < localDateStartUtc(planStart, timezone) || dueAt >= localDateStartUtc(addDaysToLocalDateString(planEnd, 1), timezone)) {
      return "That edit does not land inside the planning window. Try: edit 2 to Friday morning.";
    }

    const updated = suggestions.map((item) => item.index === parsed.index ? { ...item, suggestedDueAt: dueAt } : item);

    await replacePendingAction(userId, {
      type: "next_week_plan",
      summary: pendingAction.summary,
      payload: {
        ...pendingAction.payload,
        suggestions: updated.map(toPendingNextWeekPlanSuggestion)
      },
      expiresAt: pendingDecisionExpiry()
    });

    return `Updated suggestion ${parsed.index}: ${suggestion.title} -> ${formatPlanDue(dueAt, timezone)}.`;
  }

  if (parsed.operation === "create") {
    const selected = parsed.all ? suggestions : suggestions.filter((suggestion) => parsed.indexes.includes(suggestion.index));

    if (selected.length === 0) {
      return "No matching suggestions. Reply show plan to see the current list.";
    }

    const created: string[] = [];
    const covered: string[] = [];
    const skipped: string[] = [];
    const context = await buildNextWeekPlanContext(
      userId,
      new Date(),
      timezone,
      pendingAction.payload.planWindowKind === "current_week" ? "current_week" : "next_week"
    );

    for (const suggestion of selected) {
      if (suggestion.creatable === false || suggestion.planKind === "cleanup") {
        skipped.push(formatSkippedNextWeekPlanSuggestion(suggestion));
        continue;
      }

      const duplicate = findEquivalentOpenPlanAction(context, suggestion.title, suggestion.suggestedDueAt, suggestion.dedupeKey);

      if (duplicate || suggestion.duplicateRisk) {
        covered.push(`${suggestion.title}${duplicate?.title ? ` (${duplicate.title})` : ""}`);
        continue;
      }

      const actionInput = actionInputFromPlanSuggestion(suggestion, pendingAction.payload);
      const result = await createActionItemIfNotExists(userId, actionInput);

      if (result.created) {
        created.push(result.actionItem.title);
      } else {
        covered.push(result.actionItem.title);
      }
    }

    await confirmPendingAction(userId, pendingAction.id);

    return [
      skipped.length > 0 ? "Skipped:" : undefined,
      ...skipped.map((line) => `- ${line}`),
      created.length > 0 ? "Created actions:" : undefined,
      ...created.map((title) => `- ${title}`),
      covered.length > 0 ? "Already covered:" : undefined,
      ...covered.map((title) => `- ${title}`),
      created.length === 0 && covered.length === 0 ? "No actions created." : undefined
    ].filter(Boolean).join("\n");
  }

  return undefined;
}
