import { extractManualAction, normalizeManualActionTitleKey } from "@operator-agent/core";
import { createActionItem, getOrCreateNotificationSettings, getRecentActionItems, type ActionItem } from "@operator-agent/db";
import { inferActionGoalLink } from "../utils/action-goal-link.js";
import { formatLocalDateTime, getDateTimePart } from "../utils/datetime.js";

/**
 * Legacy manual-action-from-text creation cluster, extracted from
 * apps/api/src/server.ts, where it was shared between the legacy
 * /messages/process handler (apps/api/src/legacy/messages-process.ts), the
 * POST /users/:userId/actions/manual HTTP route, and the multi-intent
 * execution route (executeMultiIntentPlan), all of which stay/live in their
 * respective files and import from here one-directionally.
 */
export async function maybeCreateManualActionFromText(
  userId: string,
  text: string,
  options: { forceActionIntent?: boolean; now?: Date } = {}
): Promise<{
  extraction: ReturnType<typeof extractManualAction>;
  action?: ActionItem;
  duplicate: boolean;
}> {
  const settings = await getOrCreateNotificationSettings(userId);
  const extraction = extractManualAction(
    { text },
    {
      forceActionIntent: options.forceActionIntent,
      now: options.now,
      timezone: settings.timezone,
      reminderPreferences: settings
    }
  );

  if (!extraction.shouldCreateAction || !extraction.title) {
    return { extraction, duplicate: false };
  }

  const duplicate = await findDuplicateManualAction(userId, extraction.title, extraction.dueAt, settings.timezone);

  if (duplicate) {
    return {
      extraction,
      action: duplicate,
      duplicate: true
    };
  }

  const description = [extraction.description, extraction.dueText && !extraction.dueAt ? `Due: ${extraction.dueText}.` : undefined]
    .filter(Boolean)
    .join(" ");
  const goalLink = await inferActionGoalLink(userId, extraction.title, description || undefined, extraction.evidence);
  const action = await createActionItem(userId, {
    source: "manual",
    goalId: goalLink.goalId ?? undefined,
    goalSlug: goalLink.goalSlug ?? undefined,
    goalTitleSnapshot: goalLink.matchedGoalTitle,
    title: extraction.title,
    description: description || undefined,
    priority: extraction.priority,
    dueAt: extraction.dueAt,
    project: extraction.project,
    actionType: extraction.actionType,
    evidence: extraction.evidence
  });

  return {
    extraction,
    action,
    duplicate: false
  };
}

async function findDuplicateManualAction(
  userId: string,
  title: string,
  dueAt?: Date,
  timezone = "Europe/Madrid"
): Promise<ActionItem | undefined> {
  const actions = await getRecentActionItems(userId, 100);
  const titleKey = normalizeManualActionTitleKey(title);
  const dueKey = dueAt ? formatLocalActionDueKey(dueAt, timezone) : "";

  return actions.find((action) => {
    if (action.source !== "manual" || (action.status !== "open" && action.status !== "snoozed")) {
      return false;
    }

    const actionDueKey = action.dueAt ? formatLocalActionDueKey(action.dueAt, timezone) : "";
    return normalizeManualActionTitleKey(action.title) === titleKey && actionDueKey === dueKey;
  });
}

function formatLocalActionDueKey(date: Date, timezone = "Europe/Madrid"): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);

  return `${getDateTimePart(parts, "year")}-${getDateTimePart(parts, "month")}-${getDateTimePart(parts, "day")} ${getDateTimePart(parts, "hour")}:${getDateTimePart(parts, "minute")}`;
}

export function formatActionCreatedReply(input: {
  extraction: ReturnType<typeof extractManualAction>;
  action?: ActionItem;
  duplicate: boolean;
}): string {
  if (!input.action) {
    return "I could not turn that into a concrete action item.";
  }

  const dueLine = input.action.dueAt
    ? `due: ${formatLocalDateTime(input.action.dueAt, input.extraction.timezone)}`
    : input.extraction.dueText
      ? `due: ${input.extraction.dueText}`
      : undefined;

  return [
    input.duplicate ? `Action already exists: ${input.action.title}` : "Action created:",
    input.duplicate ? undefined : input.action.title,
    dueLine,
    `complete: /complete_action ${input.action.id}`,
    `snooze: /snooze_action ${input.action.id} tomorrow`,
    `archive: /archive_action ${input.action.id}`
  ]
    .filter(Boolean)
    .join("\n");
}
