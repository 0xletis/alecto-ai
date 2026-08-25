import {
  approveEmailReviewItem,
  archiveActionItem,
  archiveEmailSignalRule,
  completeActionItem,
  createActionItem,
  createActionItemIfNotExists,
  createEmailSignalRule,
  createEvent,
  createEvents,
  createGoal,
  createMemory,
  getActionItem,
  getActionItems,
  getActiveMemories,
  getEmailReviewItems,
  getEmailSignalRules,
  getEventsSince,
  getIntegrationConnection,
  getOrCreateNotificationSettings,
  getOrCreateUserOperatingProfile,
  getNotificationLog,
  hasNotificationLog,
  rescheduleActionItem,
  setGoalStatus,
  snoozeActionItem,
  updateEmailSignalRule,
  updateIntegrationConnectionConfig,
  updateNotificationSettings,
  updateUserOperatingProfile,
  type ActionItem,
  type EmailReviewItem,
  type EmailSignalRule,
  type IntegrationConnection
} from "@operator-agent/db";
import {
  countEvidenceForMetric,
  CUSTOM_SIGNAL_EVENT_TYPE,
  describeGoalEvidenceMatch,
  effectiveGmailSyncIntervalMinutes,
  ensureBookGoalProgressSignal,
  EventTypeSchema,
  findCompatibleProgressMetric,
  findGoalsForEventType,
  findGoalsForSignalKey,
  getEmailAdapterDefinition,
  gmailScheduledSyncRuntimeFromEnv,
  goalHasOnlyCompletionSignals,
  isProgressShapedSignalText,
  parseActionDueDate,
  proactiveOperatorAllowlistActiveFromEnv,
  proactiveOperatorAllowlistFromEnv,
  proactiveOperatorDeliveryEnabledFromEnv,
  readGmailAutonomyPreferences,
  resolveActiveGoalReference,
  writeGmailAutonomyPreferences,
  type EventTypeId,
  type Goal,
  type GoalMetric,
  type NotificationSettings,
  type StoredEvent,
  type UserOperatingProfile
} from "@operator-agent/core";
import { inferActionGoalLink } from "../utils/action-goal-link.js";
import type { ActionHygieneAction, NextWeekPlanSuggestion, PlanWindowKind, WeeklyReviewContext, WeeklyReviewDraft } from "../server-types.js";
import { actionHygieneVisibleActions, analyzeActionHygiene } from "../actions/hygiene-session.js";
import { isReminderCompanionAction, REMINDER_TITLE_PREFIX_RE, resolveReminderParent } from "../actions/reminder-companion.js";
import { applyActionHygieneBatchOperations, type ActionHygieneBatchOperation, type HygieneOperation } from "../actions/hygiene.js";
import { findEmailRulesByTarget, sortEmailRuleCandidates } from "../conversation/email-rule-selection.js";
import {
  formatGmailRuleUpdateProposal,
  gmailRuleOperationVerb,
  gmailRuleTargetStateLabel,
  isGmailRuleAlreadyInTargetState,
  type GmailRuleOperation
} from "../gmail/gmail-rule-management.js";
import { buildGmailOAuthUrl, gmailOAuthConfig, gmailOAuthLocalhostCallbackWarning, gmailOAuthMissingConfigMessage } from "../gmail/oauth.js";
import { buildGmailAutonomyState, formatIntervalMinutes, gmailSyncModeSentence } from "../conversation/gmail-autonomy.js";
import { archiveStaleJobSearchEmailRules, getVisibleGmailEmailRules } from "../gmail/gmail-rule-service.js";
import {
  approveEmailReviewForUser,
  createActionItemFromEmailReview,
  formatEmailReviewDetailsForContext,
  formatGmailReviewListForChat,
  gmailReviewChatLabel,
  rejectEmailReviewForUser
} from "../email-reviews/email-review-service.js";
import { formatMinutesOfDay, parseTimeOfDayText } from "../operator/daily-loop-settings.js";
import {
  formatEveningCheckinDeliveryDiagnosis,
  formatProactiveDeliveryDiagnosis,
  getEveningCheckinDeliveryStatus,
  getProactiveDeliveryStatus
} from "../operator/proactive-eligibility.js";
import { EVENING_CHECKIN_DEDUPE_KEY, MORNING_BRIEF_DEDUPE_KEY } from "../operator/proactive.js";
import {
  actionInputFromPlanSuggestion,
  buildNextWeekPlanContext,
  findEquivalentOpenPlanAction,
  formatPlanTitle,
  generateNextWeekPlanSuggestions,
  isCreatableNewPlanSuggestion,
  readPendingNextWeekPlanSuggestions,
  toPendingNextWeekPlanSuggestion
} from "../planning/next-week.js";
import { buildWeeklyReviewContext } from "../weekly-review/context.js";
import {
  buildWeeklyGuardrailNote,
  formatWeeklyEmailSignalsForReview,
  generateAndSaveWeeklyReview,
  generateDeterministicWeeklyReview
} from "../weekly-review/review.js";
import { addDaysToLocalDateString, formatDateInTimezone, formatLocalDateTime } from "../utils/datetime.js";
import { getUserTimezone } from "../utils/user-timezone.js";
import type { AgentEntity, AgentPendingOperation, ContextBundle, ExecutedOperation, ValidatedOperation } from "./types.js";
import { findExistingCustomGmailRule, type HygieneApplySelectionArgs } from "./validator.js";
import { gmailSyncDebugForAgentRuntime, syncGmailForAgentRuntime } from "./services.js";

export async function executeOperation(
  userId: string,
  operation: ValidatedOperation,
  context: ContextBundle,
  message: string
): Promise<ExecutedOperation> {
  const args = operation.args;

  try {
    switch (operation.tool) {
      case "action.list": {
        const status = (args.status as ActionItem["status"] | "all" | undefined) ?? "open";
        const limit = (args.limit as number | undefined) ?? 10;
        const overdueOnly = Boolean(args.overdueOnly);
        const settings = await getOrCreateNotificationSettings(userId);
        const now = new Date();

        // "Reminder" companion rows (actionType "reminder" — the "remind me N minutes before"
        // stubs action.create_pre_due_reminders creates) share the same ActionItem table/status
        // ordering as real tasks. A real Telegram smoke test showed them leaking into a plain
        // "show me my actions"/"do i have any overdue actions" reply as if they were standalone
        // tasks (e.g. "Reminder: Brainstorm meeting" listed right alongside "Brainstorm
        // meeting") — confusing and robotic. They are filtered out here; a real action that has
        // one is instead shown with a short "Reminder: N minutes before" metadata line.
        //
        // A separate real Telegram smoke test found the reply claiming "You have 10 open
        // actions" when 12 actually existed — the DB-level query's own limit silently truncated
        // the pool before anyone could tell the difference between "there are exactly 10" and
        // "there are more, only 10 shown." Reminder filtering happens client-side (packages/db
        // has no concept of a reminder companion), so an accurate total needs a wide-enough pool
        // to almost always capture a real user's FULL list rather than a second COUNT query — a
        // deliberate, documented tradeoff for a personal-operator product's realistic scale, not
        // a claim of exactness at unbounded scale.
        const ACTION_LIST_POOL_CAP = 500;
        const pool = await getActionItems(userId, { status, limit: ACTION_LIST_POOL_CAP });
        const realActions = pool
          .filter((item) => !isReminderCompanionAction(item))
          .filter((item) => !overdueOnly || (item.status === "open" && Boolean(item.dueAt) && item.dueAt! < now));
        const items = realActions.slice(0, limit);
        const truncated = realActions.length > items.length;

        const reminderByParentId = new Map<string, ActionItem>();
        for (const item of pool) {
          if (isReminderCompanionAction(item) && item.status !== "archived" && item.status !== "completed") {
            const parent = resolveReminderParent(item, pool);
            if (parent) {
              reminderByParentId.set(parent.id, item);
            }
          }
        }

        if (process.env.AGENT_RUNTIME_DIAGNOSTICS === "true") {
          const excludedCount = pool.filter(isReminderCompanionAction).length;
          console.log(
            "[agent-runtime-diagnostics]",
            JSON.stringify({
              phase: "action_list_reminder_filter",
              userId,
              poolSize: pool.length,
              excludedReminderCount: excludedCount,
              totalOpenActions: realActions.length,
              displayed: items.length,
              truncated
            })
          );
          console.log(
            "[agent-runtime-diagnostics]",
            JSON.stringify({
              phase: "action_list_visible_entities",
              userId,
              visibleEntities: items.map((item, index) => ({ index: index + 1, id: item.id, title: item.title }))
            })
          );
        }

        // "Show me more actions" after a page that already showed everything (nothing was
        // actually truncated) used to just re-print the identical numbered list with no
        // acknowledgement that there was nothing more — confusing since it looks like the
        // request was ignored. Only replaces the summary when there truly is nothing more to
        // show; a genuine "more" request against a truncated list still shows the next page
        // normally via formatActionListForChat below.
        if (!truncated && items.length > 0 && /\b(more|others?|the rest|additional)\b/i.test(message) && /\b(action|task)/i.test(message)) {
          return {
            tool: operation.tool,
            status: "executed",
            summary: `That's all ${items.length} ${status === "all" ? "" : `${status} `}action${items.length === 1 ? "" : "s"} — nothing more to show.`,
            result: items,
            entities: items.map((item, index) => actionToEntity(item, index + 1))
          };
        }

        return {
          tool: operation.tool,
          status: "executed",
          summary: formatActionListForChat(items, realActions.length, status, overdueOnly, reminderByParentId, settings.timezone),
          result: items,
          entities: items.map((item, index) => actionToEntity(item, index + 1))
        };
      }

      case "action.reminder_list": {
        const settings = await getOrCreateNotificationSettings(userId);
        const items = await getActionItems(userId, { status: "all", limit: 100 });
        const parentsById = new Map(items.filter((item) => !isReminderCompanionAction(item)).map((item) => [item.id, item]));
        // completeActionItem/archiveActionItem never cascade to a reminder companion (no
        // ActionItem schema change to add that link) — so once the parent task is done, its
        // reminder is still technically "open" in the DB unless something else already archived
        // it. Excluded here by parent status so it stops appearing as if it were still relevant,
        // rather than lingering as a separate active-looking reminder for a task that's finished.
        // A reminder whose parent can't be resolved at all (a genuinely unlinked/malformed
        // companion) is kept — shown honestly as unlinked rather than silently dropped.
        const reminders = activeReminderActionsFromActionList(items).filter((reminder) => {
          const parent = resolveReminderParent(reminder, items);
          return !parent || (parent.status !== "completed" && parent.status !== "archived");
        });
        return {
          tool: operation.tool,
          status: "executed",
          summary: formatReminderActionsForChat(reminders, items, settings.timezone),
          result: reminders,
          entities: reminders.map((reminder, index) => actionToEntity(reminder, index + 1))
        };
      }

      case "action.create": {
        const dueText = args.dueText as string | undefined;
        const parsedDate = dueText ? parseActionDueDate(dueText) : undefined;
        const title = args.title as string;
        const description = args.notes as string | undefined;
        // Generic goal linkage (Goal Evidence Loop MVP, docs/10-v3-readiness-audit.md §20) —
        // the exact same keyword/confidence-scored matcher gmail.review.to_action already uses
        // for email-derived actions, now also applied to manually created ones, so "need to
        // follow up with recruiter tomorrow" links to an active job-search goal exactly the same
        // way a bill-paying action would link to an active bills goal. Never invents a link below
        // the matcher's own confidence threshold.
        const goalLink = await inferActionGoalLink(userId, title, description);
        const created = await createActionItem(userId, {
          source: "manual",
          title,
          description,
          priority: (args.priority as ActionItem["priority"] | undefined) ?? "medium",
          dueAt: parsedDate?.dueAt ?? undefined,
          goalId: goalLink.goalId ?? undefined,
          goalSlug: goalLink.goalSlug ?? undefined,
          goalTitleSnapshot: goalLink.matchedGoalTitle
        });
        return {
          tool: operation.tool,
          status: "executed",
          summary: `Created task "${created.title}"${created.dueAt ? ` due ${created.dueAt.toDateString()}` : ""}.${goalLink.matchedGoalTitle ? ` Linked to your "${goalLink.matchedGoalTitle}" goal.` : ""}`,
          result: created,
          entities: [actionToEntity(created)]
        };
      }

      case "action.snooze": {
        const actionId = args.actionId as string;
        const untilText = args.untilText as string;
        const parsedDate = parseActionDueDate(untilText);
        if (!parsedDate.dueAt) {
          return failed(operation.tool, `Couldn't understand the snooze target "${untilText}".`);
        }
        const updated = await snoozeActionItem(userId, actionId, parsedDate.dueAt);
        if (!updated) {
          return failed(operation.tool, "That task no longer exists or is archived.");
        }
        return {
          tool: operation.tool,
          status: "executed",
          summary: operation.actionOutsideVisiblePage
            ? `Found "${updated.title}" outside your last shown list (an exact title match) and snoozed it to ${updated.snoozedUntil?.toDateString()}.`
            : `Snoozed "${updated.title}" to ${updated.snoozedUntil?.toDateString()}.`,
          result: updated
        };
      }

      case "action.complete": {
        const actionId = args.actionId as string;

        // "complete reminder for X" (explicitly naming a reminder companion, not the real task)
        // is a real reported pattern once the parent task is already done — completing the stub
        // too would just be a second, confusing "completion" of what is really one piece of work.
        // Resolved here rather than in validator.ts since it needs a real DB lookup, not just
        // session state. isReminderCompanionAction catches this even for a legacy/malformed
        // companion whose actionType isn't "reminder" — resolveReminderParent falls back to
        // matching its own denormalized title text when its sourceId can't be parsed.
        const target = await getActionItem(userId, actionId);
        if (target && isReminderCompanionAction(target)) {
          const pool = await getActionItems(userId, { status: "all", limit: 100 });
          const parent = resolveReminderParent(target, pool);

          if (parent && (parent.status === "completed" || parent.status === "archived")) {
            // A reminder isn't something you DO, so "complete" doesn't really fit it once it's
            // irrelevant — archived instead, quietly, so it stops appearing in any future normal
            // action/reminder list rather than lingering as a separate active-looking row.
            await archiveActionItem(userId, target.id);
            return {
              tool: operation.tool,
              status: "executed",
              summary: `"${parent.title}" is already ${parent.status}. That reminder was for it — nothing more to do.`,
              result: parent
            };
          }
        }

        const updated = await completeActionItem(userId, actionId);
        if (!updated) return failed(operation.tool, "That task no longer exists or is archived.");
        return {
          tool: operation.tool,
          status: "executed",
          summary: operation.actionOutsideVisiblePage
            ? `Found "${updated.title}" outside your last shown list (an exact title match) and completed it.`
            : `Completed "${updated.title}".`,
          result: updated
        };
      }

      case "action.archive": {
        const updated = await archiveActionItem(userId, args.actionId as string);
        if (!updated) return failed(operation.tool, "That task no longer exists.");
        return {
          tool: operation.tool,
          status: "executed",
          summary: operation.actionOutsideVisiblePage
            ? `Found "${updated.title}" outside your last shown list (an exact title match) and archived it.`
            : `Archived "${updated.title}".`,
          result: updated
        };
      }

      case "action.reschedule": {
        const actionId = args.actionId as string;
        const action = await getActionItem(userId, actionId);
        if (!action || action.status === "archived") {
          return failed(operation.tool, "That task no longer exists or is archived.");
        }

        const settings = await getOrCreateNotificationSettings(userId);
        const dueText = typeof args.dueText === "string" ? args.dueText.trim() : "";
        const timeText = typeof args.timeText === "string" ? args.timeText.trim() : "";
        const parsedDate = parseActionRescheduleDate(action, { dueText, timeText, timezone: settings.timezone });

        if (!parsedDate) {
          return failed(operation.tool, "I couldn't understand the new due time.");
        }

        const updated = await rescheduleActionItem(userId, action.id, parsedDate);
        if (!updated) {
          return failed(operation.tool, "That task no longer exists or is archived.");
        }

        const reminderUpdates = await updatePreDueReminderActions(userId, updated, settings.timezone);
        const reminderLine =
          reminderUpdates.length > 0
            ? `\nReminder updated: ${reminderUpdates.map((item) => formatLocalDateTime(item.dueAt, settings.timezone)).join(", ")}.`
            : "";

        return {
          tool: operation.tool,
          status: "executed",
          summary: `Action rescheduled: ${updated.title}\ndue: ${formatLocalDateTime(updated.dueAt, settings.timezone)}.${reminderLine}`,
          result: updated,
          entities: [actionToEntity(updated), ...reminderUpdates.map(actionToEntity)]
        };
      }

      case "action.create_pre_due_reminders": {
        const settings = await getOrCreateNotificationSettings(userId);
        const leadMinutes = (args.leadMinutes as number | undefined) ?? 30;
        const actionIds = Array.isArray(args.actionIds) ? (args.actionIds as string[]) : [];
        const actions = await resolveReminderTargetActions(userId, context, actionIds, args.ref as string | undefined);

        if (actions.length === 0) {
          return failed(operation.tool, "I couldn't find scheduled meeting tasks to remind you about.");
        }

        const reminders = await createOrUpdatePreDueReminderActions(userId, actions, leadMinutes, settings.timezone);
        if (reminders.length === 0) {
          return failed(operation.tool, "Those tasks do not have scheduled times, so I couldn't create before-time reminders.");
        }

        return {
          tool: operation.tool,
          status: "executed",
          summary: [
            `Reminders set ${leadMinutes} minutes before:`,
            ...reminders.map((item) => `- ${item.target.title}: ${formatLocalDateTime(item.reminder.dueAt, settings.timezone)}`)
          ].join("\n"),
          result: reminders,
          entities: [...actions.map(actionToEntity), ...reminders.map((item) => actionToEntity(item.reminder))]
        };
      }

      case "action.meeting_list": {
        const settings = await getOrCreateNotificationSettings(userId);
        const actions = await getActionItems(userId, { status: "all", limit: 100 });
        const meetings = meetingActionsFromActionList(actions);
        const reminders = preDueReminderActionsFromActionList(actions);

        return {
          tool: operation.tool,
          status: "executed",
          summary: formatMeetingActionsForChat(meetings, reminders, settings.timezone),
          result: { meetings, reminders },
          entities: meetings.map(actionToEntity)
        };
      }

      case "action.hygiene_start": {
        const timezone = await getUserTimezone(userId);
        const report = await analyzeActionHygiene(userId, new Date(), timezone);
        const visible = actionHygieneVisibleActions(report);

        if (visible.length === 0) {
          return {
            tool: operation.tool,
            status: "executed",
            summary: "Your actions look clean right now. No stale or overdue actions need cleanup.",
            result: report
          };
        }

        const summary = [
          "Here are the actions worth cleaning up:",
          ...visible.map((action, index) => `${index + 1}. ${hygieneActionLabel(action)}`),
          "",
          "Reply like: complete 1, snooze 2 to Friday, archive 3."
        ].join("\n");

        return {
          tool: operation.tool,
          status: "executed",
          summary,
          result: visible,
          entities: visible.map((action, index) => hygieneActionToEntity(action, index + 1))
        };
      }

      case "action.hygiene_apply": {
        const selections = (args.selections as HygieneApplySelectionArgs[]) ?? [];
        const timezone = await getUserTimezone(userId);
        const batchOps: ActionHygieneBatchOperation[] = [];
        const notes: string[] = [];

        for (const selection of selections) {
          if (!selection.actionId) {
            notes.push(
              `Item ${selection.index ?? "?"}: I couldn't find that in the current list. Say "clean up my actions" to see it again.`
            );
            continue;
          }

          const title = context.session.visibleEntities.find((entity) => entity.type === "action" && entity.id === selection.actionId)?.label ?? "";

          if (selection.decision === "snooze") {
            const parsedDate = parseActionDueDate(selection.snoozeUntilText ?? "");
            if (!parsedDate.dueAt) {
              notes.push(`${title || "That task"}: couldn't understand the snooze time "${selection.snoozeUntilText ?? ""}".`);
              continue;
            }
            batchOps.push({ operation: "snooze", actionId: selection.actionId, title, dueAt: parsedDate.dueAt.toISOString() });
            continue;
          }

          batchOps.push({ operation: selection.decision as HygieneOperation, actionId: selection.actionId, title });
        }

        if (batchOps.length === 0) {
          return failed(operation.tool, notes.join(" ") || "I couldn't match any of those to a visible action.");
        }

        const applied = await applyActionHygieneBatchOperations(userId, batchOps, timezone);
        return {
          tool: operation.tool,
          status: "executed",
          summary: [applied.reply, ...notes].filter(Boolean).join("\n"),
          result: applied
        };
      }

      case "planning.next_week_start": {
        const timezone = await getUserTimezone(userId);
        const windowKind = (args.windowKind as PlanWindowKind | undefined) ?? "next_week";
        const planContext = await buildNextWeekPlanContext(userId, new Date(), timezone, windowKind);
        const suggestions = await generateNextWeekPlanSuggestions(planContext);
        const creatable = suggestions
          .filter(isCreatableNewPlanSuggestion)
          .map((suggestion, i) => ({ ...suggestion, index: i + 1 }));

        if (creatable.length === 0) {
          return {
            tool: operation.tool,
            status: "executed",
            summary:
              "Nothing new to suggest right now — your open actions and goals already look covered. Say \"clean up my actions\" if you want to review what's open.",
            result: suggestions
          };
        }

        return {
          tool: operation.tool,
          status: "executed",
          summary: formatPlanDraftSummary(windowKind, creatable, timezone),
          result: creatable,
          entities: creatable.map((suggestion) => planSuggestionToEntity(suggestion)),
          pendingOperationUpdate: {
            topic: "next_week_planning",
            summary: `${formatPlanTitle(planContext)} draft (${creatable.length} item${creatable.length === 1 ? "" : "s"})`,
            operations: [nextWeekApplyOperation(planContext.planStartLocalDate, windowKind, creatable)]
          }
        };
      }

      case "planning.next_week_show_current": {
        // Deliberately re-renders the stored draft as-is — no regeneration, no
        // pendingOperationUpdate, no entities change. Session state (pendingOperation,
        // visibleEntities) is untouched by design: this tool only ever reads.
        const pending = context.session.pendingOperation as AgentPendingOperation;
        const pendingArgs = pending.operations[0].args;
        const timezone = await getUserTimezone(userId);
        const current = readPendingNextWeekPlanSuggestions(pendingArgs.selections);
        const windowKind = (pendingArgs.planWindowKind as PlanWindowKind | undefined) ?? "next_week";

        if (current.length === 0) {
          return {
            tool: operation.tool,
            status: "executed",
            summary: "The plan is now empty. Say cancel, or plan next week again to start over."
          };
        }

        return {
          tool: operation.tool,
          status: "executed",
          summary: formatPlanDraftSummary(windowKind, current, timezone),
          result: current
        };
      }

      case "planning.next_week_edit": {
        // The validator has already resolved every index/ref/day and guaranteed each
        // removeIndexes/changes[].index exists in the current draft — this executor only
        // ever runs with a fully-resolved, atomic edit, never a partially-invalid one.
        const pending = context.session.pendingOperation as AgentPendingOperation;
        const pendingArgs = pending.operations[0].args;
        const timezone = await getUserTimezone(userId);
        const current = readPendingNextWeekPlanSuggestions(pendingArgs.selections);
        const removeIndexes = new Set((args.removeIndexes as number[] | undefined) ?? []);
        const changes = (args.changes as Array<{ index: number; dueAt: Date }> | undefined) ?? [];

        const renumbered = current
          .filter((suggestion) => !removeIndexes.has(suggestion.index))
          .map((suggestion) => {
            const change = changes.find((c) => c.index === suggestion.index);
            return change ? { ...suggestion, suggestedDueAt: change.dueAt } : suggestion;
          })
          .map((suggestion, i) => ({ ...suggestion, index: i + 1 }));

        const windowKind = (pendingArgs.planWindowKind as PlanWindowKind | undefined) ?? "next_week";
        const planTitle = windowKind === "current_week" ? "This week plan" : "Next week plan";

        if (renumbered.length === 0) {
          return {
            tool: operation.tool,
            status: "executed",
            summary: "The plan is now empty. Say cancel, or plan next week again to start over.",
            entities: [],
            pendingOperationUpdate: {
              topic: "next_week_planning",
              summary: `${planTitle} draft (0 items)`,
              operations: [nextWeekApplyOperation(pendingArgs.planStartLocalDate as string, windowKind, renumbered)]
            }
          };
        }

        return {
          tool: operation.tool,
          status: "executed",
          summary: formatPlanDraftSummary(windowKind, renumbered, timezone),
          entities: renumbered.map((suggestion) => planSuggestionToEntity(suggestion)),
          pendingOperationUpdate: {
            topic: "next_week_planning",
            summary: `${planTitle} draft (${renumbered.length} item${renumbered.length === 1 ? "" : "s"})`,
            operations: [nextWeekApplyOperation(pendingArgs.planStartLocalDate as string, windowKind, renumbered)]
          }
        };
      }

      case "planning.next_week_apply": {
        const timezone = await getUserTimezone(userId);
        const planWindowKind = (args.planWindowKind as PlanWindowKind | undefined) ?? "next_week";
        const selections = readPendingNextWeekPlanSuggestions(args.selections);

        if (selections.length === 0) {
          return { tool: operation.tool, status: "executed", summary: "Nothing to create — the plan was empty.", result: [] };
        }

        const payload = { planStartLocalDate: args.planStartLocalDate as string, planWindowKind };
        const planContext = await buildNextWeekPlanContext(userId, new Date(), timezone, planWindowKind);
        const created: string[] = [];
        const createdWithDay: string[] = [];
        const covered: string[] = [];

        for (const suggestion of selections) {
          const duplicate = findEquivalentOpenPlanAction(planContext, suggestion.title, suggestion.suggestedDueAt, suggestion.dedupeKey);

          if (duplicate || suggestion.duplicateRisk) {
            covered.push(`${suggestion.title}${duplicate?.title ? ` (${duplicate.title})` : ""}`);
            continue;
          }

          const actionInput = actionInputFromPlanSuggestion(suggestion, payload);
          const result = await createActionItemIfNotExists(userId, actionInput);

          if (result.created) {
            created.push(result.actionItem.title);
            createdWithDay.push(`${formatPlanWeekday(suggestion.suggestedDueAt, timezone)}: ${result.actionItem.title}`);
          } else {
            covered.push(result.actionItem.title);
          }
        }

        const lines: string[] = [];
        if (createdWithDay.length > 0) {
          lines.push("Done. I created:", ...createdWithDay.map((line) => `- ${line}`));
        }
        if (covered.length > 0) {
          lines.push("Already covered:", ...covered.map((title) => `- ${title}`));
        }
        if (created.length === 0 && covered.length === 0) {
          lines.push("Nothing to create — the plan was empty.");
        }

        return {
          tool: operation.tool,
          status: "executed",
          summary: lines.join("\n"),
          result: { created, covered }
        };
      }

      case "weekly_review.start": {
        const timezone = await getUserTimezone(userId);
        const reviewContext = await buildWeeklyReviewContext(userId, undefined, timezone, new Date());
        const draft = generateDeterministicWeeklyReview(reviewContext);
        // Deliberately not just "wins is the placeholder sentence" — a thin week is also
        // thin on stalls/overdue actions, so this checks the underlying signal directly
        // rather than parsing generateDeterministicWeeklyReview's prose output.
        const isThin = reviewContext.events.length === 0 && reviewContext.completedActions.length === 0 && reviewContext.overdueActions.length === 0;

        return {
          tool: operation.tool,
          status: "executed",
          summary: isThin ? formatThinWeeklyReviewSummary(reviewContext) : formatWeeklyReviewDraftSummary(reviewContext, draft),
          result: { context: reviewContext, draft },
          pendingOperationUpdate: {
            topic: "weekly_review",
            summary: `Weekly review draft (${reviewContext.weekStartLocalDate} to ${reviewContext.reviewedEndLocalDate})`,
            operations: [
              {
                tool: "weekly_review.save",
                args: { weekStartLocalDate: reviewContext.weekStartLocalDate, timezone: reviewContext.timezone },
                status: "valid",
                requiresConfirmation: false
              }
            ]
          }
        };
      }

      case "weekly_review.save": {
        const weekStartLocalDate = args.weekStartLocalDate as string;
        const timezone = args.timezone as string;
        const reviewContext = await buildWeeklyReviewContext(userId, weekStartLocalDate, timezone, new Date());
        const saved = await generateAndSaveWeeklyReview(userId, reviewContext);

        return {
          tool: operation.tool,
          status: "executed",
          summary: `Saved your weekly review (${saved.weekStartLocalDate} to ${saved.reviewedEndLocalDate}). You can ask for it again anytime.`,
          result: saved
        };
      }

      case "event.log_job_applications": {
        const count = args.count as number;
        const created = await createEvents(
          userId,
          Array.from({ length: count }, () => ({
            type: "career.application_sent" as const,
            source: "manual" as const,
            confidence: 1,
            evidence: [args.notes as string | undefined, message].filter(Boolean) as string[]
          }))
        );
        const goalNote = describeGoalEvidenceMatch(findGoalsForEventType(context.activeGoals, "career.application_sent"));
        return {
          tool: operation.tool,
          status: "executed",
          summary: `Logged ${created.length} job application${created.length === 1 ? "" : "s"} sent.${goalNote ? ` ${goalNote}` : ""}`,
          result: created
        };
      }

      case "goal.log_evidence": {
        let signalKey = args.signalKey as string | undefined;
        let eventType = args.eventType as string | undefined;
        const goalRef = args.goalRef as string | undefined;
        const count = (args.count as number | undefined) ?? 1;
        const notes = args.notes as string | undefined;

        const currentFocusGoal = resolveCurrentFocusGoal(context);

        if (!eventType && !signalKey) {
          // A real-LLM eval run caught this too: even with the target goal's own real signals now
          // included in the planner's context payload, a call sometimes still omits both fields
          // entirely (no bad guess, just nothing) — rather than failing outright, check the one
          // goal this evidence is actually about (goalRef, else conversation focus, else — a real
          // RC smoke run caught this exact gap — the account's only active goal, when there is
          // exactly one): if it has EXACTLY ONE declared signal, there is no real ambiguity about
          // what a plain progress report against it could mean, so use that signal automatically.
          // The single-active-goal fallback is never a guess among several goals — it only ever
          // fires when there is nothing else the evidence COULD be about. Two or more declared
          // signals (or two or more active goals with no goalRef/focus) is genuinely ambiguous —
          // that case still fails honestly below.
          const referencedForMissingSignal = goalRef ? resolveGoalReferenceTargets(goalRef, context.activeGoals, currentFocusGoal) : undefined;
          const onlyActiveGoal = context.activeGoals.length === 1 ? context.activeGoals[0] : undefined;
          const targetGoalForMissingSignal =
            referencedForMissingSignal?.status === "matched" ? referencedForMissingSignal.goals[0] : (currentFocusGoal ?? onlyActiveGoal);
          const onlyMetric = targetGoalForMissingSignal?.targetMetrics?.length === 1 ? targetGoalForMissingSignal.targetMetrics[0] : undefined;

          if (onlyMetric?.signalKey) {
            signalKey = onlyMetric.signalKey;
          } else if (onlyMetric?.eventType) {
            eventType = onlyMetric.eventType;
          } else {
            return failed(operation.tool, "I need either a known signal type or a custom signal key to log this — try describing it again.");
          }
        }

        // eventType used to be a hardcoded 5-value career-only enum, which meant a real,
        // registered, goal-declared eventType outside that list (e.g.
        // "learning.reading_session_completed" for a reading goal) could never be logged through
        // here at all. Now any real registered event type is accepted (checked against the event
        // registry itself, generically, not a fixed whitelist) — matching the pre-existing
        // behavior that a fixed career eventType could always be logged even for a goal that
        // doesn't formally declare it as one of its own targetMetrics (e.g. "career.job_search"
        // goals list interview_scheduled as a relevant signal but don't all declare a metric for
        // it); a goal actually declaring the metric only changes the label/note shown below, never
        // whether the event itself can be logged. signalKey stays strict — unlike a registered
        // eventType, a custom signalKey has no existence at all outside some goal's own
        // declaration, so an unmatched one is never valid (unchanged from before this pass).
        // A real-LLM eval run caught this exact case: the planner sometimes sets BOTH eventType
        // and signalKey to the same guessed value (e.g. eventType: "tea_cups_drunk", signalKey:
        // "tea_cups_drunk" — the custom key duplicated into the wrong field). An invalid eventType
        // only fails the whole call when there's no signalKey to fall back to; when one is also
        // present, the bad eventType is simply ignored and signalKey drives the rest of this case,
        // since it's the one field that's actually meaningful here.
        const parsedEventType = eventType ? EventTypeSchema.safeParse(eventType) : undefined;
        if (eventType && !parsedEventType?.success && !signalKey) {
          return failed(operation.tool, `"${eventType}" isn't a real event type I can log — try describing what happened again.`);
        }
        let verifiedEventType: EventTypeId | undefined = parsedEventType?.success ? parsedEventType.data : undefined;

        // A second real-LLM eval finding: the planner sometimes supplies a genuinely VALID
        // eventType (a real registered type, e.g. "learning.reading_session_completed") AND a
        // signalKey in the same call, as a hedge. Blindly preferring eventType (the old behavior)
        // logged the event under a type the target goal never declares at all when the goal's
        // real metric is signalKey-based — an orphaned event goal.status can never count, with a
        // confident-sounding reply on top. Once the one goal this evidence is about is known (via
        // goalRef, else conversation focus), whichever field THAT goal actually declares wins; the
        // other is dropped. Left unchanged (falls through to the pre-existing eventType-first
        // default) when no target goal can be resolved at all, or when both/neither are declared.
        if (verifiedEventType && signalKey) {
          const referencedForBothFields = goalRef ? resolveGoalReferenceTargets(goalRef, context.activeGoals, currentFocusGoal) : undefined;
          const targetGoalForBothFields = referencedForBothFields?.status === "matched" ? referencedForBothFields.goals[0] : currentFocusGoal;
          if (targetGoalForBothFields) {
            const metrics = targetGoalForBothFields.targetMetrics ?? [];
            const declaresSignalKey = metrics.some((metric) => metric.signalKey === signalKey);
            const declaresEventType = metrics.some((metric) => metric.eventType === verifiedEventType);
            if (declaresSignalKey && !declaresEventType) {
              verifiedEventType = undefined;
            } else if (declaresEventType && !declaresSignalKey) {
              signalKey = undefined;
            }
          }
        }

        if (signalKey && findGoalsForSignalKey(context.activeGoals, signalKey).length === 0) {
          // No active goal declares this EXACT key. Only even attempt a fallback when the
          // REQUESTED key itself is progress-shaped ("reading_minutes," "pages_read") — this is
          // strictly for a naming mismatch against the one goal this evidence is actually about
          // (named via goalRef, else the conversation's current focus), never a reason to guess a
          // link for an unrelated key like "called_grandmother" just because some goal happens to
          // be in focus. A real Telegram smoke test hit the mismatch case: a book goal created with
          // only a completion signal had no compatible key for "I read 30 minutes today" at all.
          const referenced = goalRef ? resolveGoalReferenceTargets(goalRef, context.activeGoals, currentFocusGoal) : undefined;
          const targetGoal = referenced?.status === "matched" ? referenced.goals[0] : currentFocusGoal;

          if (targetGoal && isProgressShapedSignalText(signalKey)) {
            const compatibleMetric = findCompatibleProgressMetric(targetGoal);
            if (compatibleMetric?.signalKey) {
              // The goal DOES track ongoing progress, just under a different key than guessed
              // (e.g. guessed "reading_minutes" against a goal that declared "pages_read_daily")
              // — remap to the goal's own real key rather than failing over a naming mismatch.
              signalKey = compatibleMetric.signalKey;
            } else if (goalHasOnlyCompletionSignals(targetGoal)) {
              return failed(
                operation.tool,
                `"${targetGoal.title}" only tracks completion right now, not partial progress like this. Want me to add a progress signal (e.g. reading minutes) so I can log it?`
              );
            } else {
              return failed(operation.tool, `I don't have a "${signalKey}" signal set up for any of your active goals. Say "what am I tracking for X?" to see the real signals.`);
            }
          } else {
            return failed(operation.tool, `I don't have a "${signalKey}" signal set up for any of your active goals. Say "what am I tracking for X?" to see the real signals.`);
          }
        }

        let matchedGoals = verifiedEventType ? findGoalsForEventType(context.activeGoals, verifiedEventType) : findGoalsForSignalKey(context.activeGoals, signalKey!);

        // Narrows which of the already-verified matchedGoals this evidence is attributed to (for
        // the reply's own honesty) — never makes an otherwise-invalid signal valid, so an
        // unresolved/ambiguous reference still logs the (already-verified) event rather than
        // blocking it; only the display note becomes "your goal" instead of naming one. Prefers an
        // explicit goalRef, then the conversation's current focus (resolveActiveGoalReference's
        // own pronoun/empty-reference fallback), then just the first match.
        if (matchedGoals.length > 1) {
          const focusAmongMatched = matchedGoals.find((goal) => goal.id === currentFocusGoal?.id);
          const resolution = resolveActiveGoalReference(goalRef, matchedGoals, { mostRecent: matchedGoals[0], currentFocus: focusAmongMatched });
          if (resolution.status === "matched" && resolution.goal) {
            matchedGoals = [resolution.goal, ...matchedGoals.filter((goal) => goal.id !== resolution.goal!.id)];
          }
        }

        const created = await createEvents(
          userId,
          Array.from({ length: count }, () => ({
            type: verifiedEventType ?? CUSTOM_SIGNAL_EVENT_TYPE,
            source: "manual" as const,
            confidence: 1,
            data: signalKey ? { signalKey, notes } : notes ? { notes } : undefined,
            evidence: [notes, message].filter(Boolean) as string[]
          }))
        );
        const goalNote = describeGoalEvidenceMatch(matchedGoals);
        const signalLabel = describeSignalCount(matchedGoals[0], verifiedEventType, signalKey, created.length);
        return {
          tool: operation.tool,
          status: "executed",
          summary: `Logged ${signalLabel}${notes ? ` (${notes})` : ""}.${goalNote ? ` ${goalNote}` : ""}`,
          result: created,
          entities: matchedGoals[0] ? [goalToEntity(matchedGoals[0])] : undefined
        };
      }

      case "event.log_workout": {
        const created = await createEvent(userId, {
          type: "health.workout_completed",
          source: "manual",
          confidence: 1,
          data: { minutes: args.minutes, activity: args.activity },
          evidence: [args.notes as string | undefined, message].filter(Boolean) as string[]
        });
        return {
          tool: operation.tool,
          status: "executed",
          summary: `Logged ${args.minutes} minutes of ${(args.activity as string | undefined) ?? "training"}.`,
          result: created
        };
      }

      case "event.log_custom_progress": {
        const label = args.label as string;
        const value = args.value as string | undefined;
        const notes = args.notes as string | undefined;

        // A real-LLM eval run found the planner sometimes reaches for this generic, unlinked
        // fallback tool even when the goal in conversational focus already declares a matching
        // custom signal (e.g. "had 2 teas today" against a "cups of tea drunk" signal) — despite
        // explicit prompt guidance to prefer goal.log_evidence instead. Rather than depending only
        // on that guidance holding, this checks the focused goal for a metric whose OWN label
        // matches (case-insensitively) the given label — if found, logs REAL, linked evidence
        // through the same shape goal.log_evidence writes, so goal.status can actually count it;
        // only when nothing matches does this fall back to genuinely unlinked progress. Either way
        // this tool is GROUND_TRUTH_ONLY (see response-composer.ts) — its own honest summary is
        // always what's shown, never an LLM's pre-execution guess about whether something linked.
        const focusGoal = resolveCurrentFocusGoal(context);
        const matchedMetric = focusGoal?.targetMetrics?.find((metric) => metric.label.trim().toLowerCase() === label.trim().toLowerCase());
        const matchedEventType = matchedMetric?.eventType ? EventTypeSchema.safeParse(matchedMetric.eventType) : undefined;

        if (matchedMetric && (matchedMetric.signalKey || matchedEventType?.success)) {
          const created = await createEvents(userId, [
            {
              type: matchedEventType?.success ? matchedEventType.data : CUSTOM_SIGNAL_EVENT_TYPE,
              source: "manual" as const,
              confidence: 1,
              data: matchedMetric.signalKey ? { signalKey: matchedMetric.signalKey, notes } : notes ? { notes } : undefined,
              evidence: [notes, message].filter(Boolean) as string[]
            }
          ]);
          return {
            tool: operation.tool,
            status: "executed",
            summary: `Logged ${matchedMetric.label}${value ? ` (${value})` : ""}${notes ? ` (${notes})` : ""}. This counts toward your "${focusGoal!.title}" goal.`,
            result: created,
            entities: [goalToEntity(focusGoal!)]
          };
        }

        const created = await createEvent(userId, {
          type: "custom.goal_progress_logged",
          source: "manual",
          confidence: 1,
          data: { label, value },
          evidence: [notes, message].filter(Boolean) as string[]
        });
        return {
          tool: operation.tool,
          status: "executed",
          summary: `Logged progress: ${label}${value ? ` (${value})` : ""}. This isn't linked to a specific goal signal, so it won't show up in that goal's status.`,
          result: created
        };
      }

      case "memory.create": {
        const created = await createMemory(userId, {
          type: (args.type as never) ?? "note",
          summary: args.summary as string,
          source: "explicit_user_request",
          confidence: 1
        });
        return { tool: operation.tool, status: "executed", summary: `Remembered: ${created.summary}`, result: created };
      }

      case "memory.search": {
        const query = ((args.query as string | undefined) ?? "").toLowerCase().trim();
        const all = await getActiveMemories(userId);
        const matches = query ? all.filter((memory) => memory.summary.toLowerCase().includes(query)) : all;
        const limited = matches.slice(0, (args.limit as number | undefined) ?? 10);
        return {
          tool: operation.tool,
          status: "executed",
          summary:
            limited.length === 0
              ? "I don't have anything remembered that matches that."
              : `I remember: ${limited.map((memory) => memory.summary).join("; ")}.`,
          result: limited
        };
      }

      case "gmail.status": {
        const state = await buildGmailAutonomyState(userId);
        const connection = state.primaryConnection;
        const settings = await getOrCreateNotificationSettings(userId);
        return {
          tool: operation.tool,
          status: "executed",
          summary: formatGmailConnectionStatusForChat(
            userId,
            connection,
            state.activeRules,
            settings.timezone,
            args.includeLink === true,
            state.lastSyncedAt
          ),
          result: connection
        };
      }

      case "gmail.sync": {
        const state = await buildGmailAutonomyState(userId);
        const syncBlock = formatCanonicalGmailSyncBlock(userId, state);
        const summary = syncBlock ?? appendGmailSyncReconnectLink(userId, await syncGmailForAgentRuntime(userId));
        return {
          tool: operation.tool,
          status: "executed",
          summary,
          result: { message: summary }
        };
      }

      case "gmail.sync.debug": {
        const summary = await gmailSyncDebugForAgentRuntime(userId);
        return {
          tool: operation.tool,
          status: "executed",
          summary,
          result: { message: summary }
        };
      }

      case "gmail.autonomy.status": {
        const state = await buildGmailAutonomyState(userId);
        return {
          tool: operation.tool,
          status: "executed",
          summary: formatGmailAutonomyStatusForChat(state),
          result: {
            syncMode: state.syncMode,
            syncIntervalMinutes: state.syncIntervalMinutes,
            scheduledSyncEnabled: state.scheduledSyncEnabled,
            reviewNotificationEnabled: state.reviewNotificationEnabled
          }
        };
      }

      case "gmail.autonomy.propose_update": {
        const state = await buildGmailAutonomyState(userId);
        if (!state.gmailConnected || !state.primaryConnection) {
          return failed(operation.tool, "Gmail is not connected yet. Say 'connect Gmail' first.");
        }

        const syncMode = args.syncMode as "manual_only" | "scheduled";
        const intervalMinutes = args.intervalMinutes as number | undefined;

        if (syncMode === "scheduled" && !(typeof intervalMinutes === "number" && intervalMinutes > 0)) {
          return failed(operation.tool, "I need a real interval to schedule Gmail checks — try 'every hour' or 'every 30 minutes'.");
        }

        // Already in the requested state — say so honestly rather than opening a pointless
        // confirmation for a no-op change.
        if (syncMode === "manual_only" && state.syncMode === "manual_only") {
          return {
            tool: operation.tool,
            status: "executed",
            summary: "Gmail is already manual only. Nothing to change.",
            result: state
          };
        }
        if (syncMode === "scheduled" && state.syncMode === "scheduled" && state.syncIntervalMinutes === intervalMinutes) {
          return {
            tool: operation.tool,
            status: "executed",
            summary: `Gmail is already set to scheduled checks every ${formatIntervalMinutes(intervalMinutes!)}. Nothing to change.`,
            result: state
          };
        }

        const proposalLine =
          syncMode === "manual_only"
            ? "You're about to make Gmail manual only. I'll only check Gmail when you say \"sync Gmail\"."
            : `You're about to check Gmail every ${formatIntervalMinutes(intervalMinutes!)}.`;
        const alertsLine = `Gmail alerts are ${state.reviewNotificationEnabled ? "on" : "off"}.`;

        return {
          tool: operation.tool,
          status: "executed",
          summary: `${proposalLine} ${alertsLine} Reply yes to confirm or cancel.`,
          result: state,
          pendingOperationUpdate: {
            topic: "gmail_autonomy",
            summary: syncMode === "manual_only" ? "make Gmail manual only" : `set Gmail scheduled checks every ${formatIntervalMinutes(intervalMinutes!)}`,
            operations: [
              {
                tool: "gmail.autonomy.apply_update",
                args: {
                  connectionId: state.primaryConnection.id,
                  syncMode,
                  ...(syncMode === "scheduled" ? { intervalMinutes } : {})
                },
                status: "valid",
                requiresConfirmation: false
              }
            ]
          }
        };
      }

      case "gmail.autonomy.apply_update": {
        const connectionId = args.connectionId as string;
        const syncMode = args.syncMode as "manual_only" | "scheduled";
        const intervalMinutes = args.intervalMinutes as number | undefined;

        const connection = await getIntegrationConnection(userId, connectionId);
        if (!connection) {
          return failed(operation.tool, "That Gmail connection no longer exists.");
        }

        // writeGmailAutonomyPreferences (packages/core/src/gmail-autonomy.ts) merges into the
        // connection's own config — the SAME field evaluateGmailBackgroundSyncEligibility /
        // shouldSyncGmailConnectionOnSchedule (packages/core, used by the worker's actual
        // scheduled-sync tick) reads. This is a real, persisted write, not a preference the
        // worker has no way to see — no separate settings table, no risk of the two disagreeing.
        const nextConfig = writeGmailAutonomyPreferences(connection.config, {
          syncMode,
          ...(syncMode === "scheduled" && intervalMinutes ? { syncIntervalMinutes: intervalMinutes } : {})
        });
        const updated = await updateIntegrationConnectionConfig(userId, connectionId, nextConfig);
        if (!updated) {
          return failed(operation.tool, "That Gmail connection no longer exists.");
        }

        const effectiveInterval = effectiveGmailSyncIntervalMinutes(readGmailAutonomyPreferences(updated.config), gmailScheduledSyncRuntimeFromEnv());
        const summary =
          syncMode === "manual_only"
            ? "Done — Gmail is now manual only. I'll check when you say \"sync Gmail\"."
            : `Done — Gmail scheduled checks are now on every ${formatIntervalMinutes(effectiveInterval)}.`;

        return { tool: operation.tool, status: "executed", summary, result: updated };
      }

      case "gmail.rule.list": {
        const rules = (await buildGmailAutonomyState(userId)).activeRules;
        const summary =
          rules.length === 0
            ? "No active Gmail rules."
            : `Active Gmail rules:\n${rules.map((rule, index) => `${index + 1}. ${rule.name} — review-first tracking`).join("\n")}`;
        return {
          tool: operation.tool,
          status: "executed",
          summary,
          result: rules,
          entities: rules.map((rule, index) => gmailRuleToEntity(rule, index + 1))
        };
      }

      case "gmail.rule.create": {
        const connection = context.gmailConnection;
        if (!connection || connection.status !== "active") {
          return failed(operation.tool, "Gmail is not connected, so I can't create a tracking rule.");
        }
        const label = args.label as string;
        const matchHint = args.matchHint as string | undefined;
        const query = matchHint ? `${label} ${matchHint}`.trim() : label;

        const existing = findExistingCustomGmailRule(await getEmailSignalRules(userId), label);
        if (existing?.status === "active") {
          return {
            tool: operation.tool,
            // Nothing was actually created/changed — this must not read as a mutation.
            status: "skipped",
            summary: `${existing.name} tracking is already active. Matches go to email reviews first. It is not instant email arrival tracking.`,
            result: existing
          };
        }
        if (existing?.status === "paused") {
          return {
            tool: operation.tool,
            status: "skipped",
            summary: `${existing.name} tracking already exists but is currently paused. Resuming a paused rule isn't supported yet — let me know if you'd like a new rule instead.`,
            result: existing
          };
        }

        // Goal linking is STRICT (resolveGoalForLifecycleAction, not the permissive
        // resolveGoalReferenceTargets) and only even attempted when the user actually referenced a
        // goal — a rule's link is long-lived and drives future evidence, so it deserves the same
        // no-silent-guess bar as a lifecycle mutation, not the looser "fall back to whatever's most
        // recent" behavior used for a single read-only status question. An ambiguous reference asks
        // rather than guessing; a goalRef that matches nothing real still creates the rule, just
        // unlinked — the tool schema itself tells the planner to omit goalRef entirely when there
        // was no goal mentioned, so reaching here with an unmatched goalRef means the user named
        // something real that isn't currently an active goal, and blocking rule creation entirely
        // over that would be worse than creating it and saying so honestly.
        const goalRef = args.goalRef as string | undefined;
        const requestedSignalKey = args.signalKey as string | undefined;
        const requestedEventType = args.eventType as string | undefined;
        let linkedGoal: Goal | undefined;
        let noMatchGoalRef = false;

        if (goalRef && goalRef.trim()) {
          const outcome = resolveGoalForLifecycleAction(goalRef, context.activeGoals, resolveCurrentFocusGoal(context));
          if (outcome.status === "ambiguous") {
            return {
              tool: operation.tool,
              status: "executed",
              summary: describeAmbiguousGoalChoice(outcome.goals),
              result: outcome.goals
            };
          }
          if (outcome.status === "matched") {
            linkedGoal = outcome.goals[0];
          } else {
            noMatchGoalRef = true;
          }
        }

        // Never trusts the planner's signalKey/eventType directly — only accepted when it exactly
        // matches one of the LINKED goal's own declared targetMetrics (same convention
        // goal.log_evidence enforces above). A goal with no matching signal, or no goal linked at
        // all, still creates the rule — it just carries no evidence mapping, matching the tool's
        // own "omit both if nothing clearly matches" schema guidance.
        const metrics = linkedGoal?.targetMetrics ?? [];
        const signalKey = requestedSignalKey && metrics.some((metric) => metric.signalKey === requestedSignalKey) ? requestedSignalKey : undefined;
        const eventType =
          !signalKey && requestedEventType && EventTypeSchema.safeParse(requestedEventType).success && metrics.some((metric) => metric.eventType === requestedEventType)
            ? requestedEventType
            : undefined;

        const rule = await createEmailSignalRule(userId, {
          connectionId: connection.id,
          goalId: linkedGoal?.id,
          signalKey,
          eventType,
          adapterId: "custom_email_review",
          name: label,
          query,
          fetchStrategy: "query",
          lookbackDays: 30,
          maxMessagesPerSync: 25,
          maxEventsPerSync: 5,
          classifierMode: "rules",
          minAutoLogConfidence: 1,
          minReviewConfidence: 0.65,
          reviewBeforeLogging: true,
          createdBy: "user"
        });

        const goalNote = linkedGoal
          ? signalKey || eventType
            ? ` Matches you approve can count as "${linkedGoal.title}" evidence.`
            : ` Linked to "${linkedGoal.title}", but I didn't find a matching signal to log evidence automatically — you can still review and act on matches manually.`
          : noMatchGoalRef
            ? ` I didn't find an active goal matching "${goalRef}", so this isn't linked to a goal yet — let me know if you'd like to link it.`
            : "";

        return {
          tool: operation.tool,
          status: "executed",
          summary: `${rule.name} tracking is on. New matches go to email review before anything is logged — never instant, never auto-logged.${goalNote}`,
          result: rule
        };
      }

      case "gmail.rule.enable_builtin": {
        const result = await enableBuiltInGmailRuleForAgent(userId, args.kind as BuiltInGmailRuleKind);
        return {
          tool: operation.tool,
          status: result.changed ? "executed" : "skipped",
          summary: result.summary,
          result: result.rule
        };
      }

      case "gmail.rule.explain": {
        const label = normalize(args.label as string);
        const rule = (await getEmailSignalRules(userId)).find(
          (candidate) => candidate.status === "active" && normalize(candidate.name).includes(label)
        );
        return {
          tool: operation.tool,
          status: "executed",
          summary: rule
            ? `"${rule.name}" is active. It's review-first: matches go to email review, they are not auto-logged.`
            : `No active rule matches "${args.label}". Custom Gmail tracking would go to email review first and does not auto-log.`,
          result: rule
        };
      }

      case "gmail.rule.propose_update": {
        // Always a fresh DB lookup, never session.visibleEntities — a rule is a stable,
        // directly-nameable record (unlike an ephemeral generated plan draft), so "turn off
        // Endesa" must resolve correctly even if the user never ran gmail.rule.list first.
        const ref = args.ref as string;
        const gmailOperation = args.operation as GmailRuleOperation;
        const rules = await getVisibleGmailEmailRules(userId);
        const matches = sortEmailRuleCandidates(findEmailRulesByTarget(rules, ref));

        if (matches.length === 0) {
          return {
            tool: operation.tool,
            status: "executed",
            summary: `I couldn't find an active Gmail rule matching "${ref}". Nothing was changed.`
          };
        }

        if (matches.length > 1) {
          const shown = matches.slice(0, 5);
          return {
            tool: operation.tool,
            status: "executed",
            summary: ["I found more than one matching rule. Which one do you mean?", ...shown.map((rule, index) => `${index + 1}. ${rule.name}`)].join("\n"),
            entities: shown.map((rule, index) => gmailRuleToEntity(rule, index + 1))
          };
        }

        const rule = matches[0];

        if (isGmailRuleAlreadyInTargetState(rule, gmailOperation)) {
          return {
            tool: operation.tool,
            status: "executed",
            summary: `${rule.name} is already ${gmailRuleTargetStateLabel(gmailOperation)}. Nothing to change.`,
            entities: [gmailRuleToEntity(rule)]
          };
        }

        return {
          tool: operation.tool,
          status: "executed",
          summary: formatGmailRuleUpdateProposal(rule, gmailOperation),
          entities: [gmailRuleToEntity(rule)],
          pendingOperationUpdate: {
            topic: "gmail_rule_management",
            summary: `${gmailRuleOperationVerb(gmailOperation)} ${rule.name}`,
            operations: [
              {
                tool: "gmail.rule.apply_update",
                args: { ruleId: rule.id, ruleName: rule.name, operation: gmailOperation },
                status: "valid",
                requiresConfirmation: false
              }
            ]
          }
        };
      }

      case "gmail.rule.apply_update": {
        const ruleId = args.ruleId as string;
        const ruleName = args.ruleName as string;
        const gmailOperation = args.operation as GmailRuleOperation;

        const updated =
          gmailOperation === "archive"
            ? await archiveEmailSignalRule(userId, ruleId)
            : await updateEmailSignalRule(userId, ruleId, { status: gmailOperation === "pause" ? "paused" : "active" });

        if (!updated) {
          return failed(operation.tool, `${ruleName} no longer exists.`);
        }

        return {
          tool: operation.tool,
          status: "executed",
          summary: `Done — ${updated.name} is now ${gmailRuleTargetStateLabel(gmailOperation)}.`,
          result: updated
        };
      }

      case "gmail.review.list": {
        const status = (args.status as EmailReviewItem["status"] | "all" | undefined) ?? "pending";
        const items = await getEmailReviewItems(userId, { status, limit: (args.limit as number | undefined) ?? 10 });
        return {
          tool: operation.tool,
          status: "executed",
          summary: formatGmailReviewListForChat(items, context.gmailRules),
          result: items,
          entities: items.map((review, index) => reviewToEntity(review, index + 1, context.gmailRules))
        };
      }

      case "gmail.review.reject": {
        const result = await rejectEmailReviewForUser(userId, args.reviewId as string);
        if (result.status === "not_found") {
          return failed(operation.tool, "That email review no longer exists or was already decided.");
        }
        // Re-includes the OTHER still-pending reviews (re-numbered), not just this one's own
        // outcome — otherwise applyExecutionSideEffects's per-turn REPLACE semantics for
        // visibleEntities would silently drop them, breaking a very next "reject the other one"
        // that never re-lists in between.
        const remaining = await getEmailReviewItems(userId, { status: "pending", limit: 10 });
        const reviewNumber = typeof args.index === "number" ? ` ${args.index}` : "";
        const reviewLabel = result.review ? `: ${gmailReviewChatLabel(result.review, context.gmailRules)}` : "";
        return {
          tool: operation.tool,
          status: "executed",
          summary: `Ignored review${reviewNumber} (rejected)${reviewLabel}.`,
          result: result.review,
          entities: remaining.map((item, index) => reviewToEntity(item, index + 1, context.gmailRules))
        };
      }

      case "gmail.review.keep": {
        const reviewId = args.reviewId as string;
        const review = await getEmailReviewItems(userId, { status: "pending", limit: 50 }).then((items) =>
          items.find((item) => item.id === reviewId)
        );
        if (!review) {
          return failed(operation.tool, "That email review no longer exists or was already decided.");
        }
        const remaining = await getEmailReviewItems(userId, { status: "pending", limit: 10 });
        const reviewNumber = typeof args.index === "number" ? ` ${args.index}` : "";
        return {
          tool: operation.tool,
          status: "executed",
          summary: `Kept review${reviewNumber}: ${gmailReviewChatLabel(review, context.gmailRules)} in review for later.`,
          result: review,
          entities: remaining.map((item, index) => reviewToEntity(item, index + 1, context.gmailRules))
        };
      }

      case "gmail.review.inspect": {
        const reviewId = args.reviewId as string;
        const review = await getEmailReviewItems(userId, { status: "pending", limit: 50 }).then((items) =>
          items.find((item) => item.id === reviewId)
        );
        if (!review) {
          return failed(operation.tool, "That email review no longer exists or was already decided.");
        }

        return {
          tool: operation.tool,
          status: "executed",
          summary: formatGmailReviewQuestionAnswer(review, args.question as string | undefined),
          result: { details: await formatEmailReviewDetailsForContext(userId, review.id) }
        };
      }

      case "gmail.review.to_action": {
        const reviewId = args.reviewId as string;
        const plannedDueText = typeof args.dueText === "string" ? args.dueText.trim() : "";
        const rawDueText = plannedDueText || extractGmailReviewActionDueText(message);
        const dueText = rawDueText ? translateDueTextToEnglish(rawDueText) : rawDueText;
        const reviews = await getEmailReviewItems(userId, { status: "pending", limit: 50 });
        const review = reviews.find((item) => item.id === reviewId);
        if (!review) return failed(operation.tool, "That email review no longer exists or was already decided.");

        const { actionItem, created } = await createActionItemFromEmailReview(userId, review, { dueText });
        await approveEmailReviewItem(userId, review.id, undefined, actionItem.id);
        // Same reasoning as gmail.review.reject above: keep the other still-pending reviews
        // visible alongside the newly created action, not just the action alone.
        const remaining = await getEmailReviewItems(userId, { status: "pending", limit: 10 });
        const settings = await getOrCreateNotificationSettings(userId);
        const reminderLeadMinutes = typeof args.reminderLeadMinutes === "number" ? args.reminderLeadMinutes : undefined;
        // reminderLeadMinutes: 0 means "remind me AT the due time" (see tool-catalog.ts) — that
        // moment is already covered by the task's own due notification (sendDueActionReminders),
        // so creating a second, separate reminder ActionItem due at the exact same instant would
        // just make the worker send two notifications for one moment. Only a genuine BEFORE-time
        // request (a positive lead) warrants a real companion reminder.
        const wantsSeparateReminder = typeof reminderLeadMinutes === "number" && reminderLeadMinutes > 0;
        const reminders =
          wantsSeparateReminder && actionItem.dueAt
            ? await createOrUpdatePreDueReminderActions(userId, [actionItem], reminderLeadMinutes, settings.timezone)
            : [];
        const dueLabel = actionItem.dueAt
          ? dueText?.trim()
            ? ` for ${dueText.trim()} (${formatLocalDateTime(actionItem.dueAt, settings.timezone)})`
            : ` for ${formatLocalDateTime(actionItem.dueAt, settings.timezone)}`
          : "";
        const reminderLabel =
          reminders.length > 0
            ? ` Reminder: ${formatLocalDateTime(reminders[0]!.reminder.dueAt, settings.timezone)}.`
            : wantsSeparateReminder
              ? " I couldn't set a before-time reminder because the task has no scheduled time."
              : "";
        return {
          tool: operation.tool,
          status: "executed",
          summary: `${created ? "Created task" : "Task already exists"}: "${actionItem.title}"${dueLabel}.${reminderLabel}`,
          result: { actionItem, reminders },
          entities: [
            actionToEntity(actionItem),
            ...reminders.map((item) => actionToEntity(item.reminder)),
            ...remaining.map((item, index) => reviewToEntity(item, index + 1, context.gmailRules))
          ]
        };
      }

      case "gmail.review.approve": {
        const reviewId = args.reviewId as string;
        const result = await approveEmailReviewForUser(userId, reviewId);

        if (result.status === "not_found") {
          return failed(operation.tool, "That email review no longer exists or was already decided.");
        }
        if (result.status === "not_pending") {
          return failed(operation.tool, `That email review is already ${result.review.status}.`);
        }

        // Same reasoning as gmail.review.reject/to_action above: keep the other still-pending
        // reviews visible alongside whatever this approval produced (action, event, or neither).
        const remaining = await getEmailReviewItems(userId, { status: "pending", limit: 10 });
        const entities = [
          ...(result.actionItem ? [actionToEntity(result.actionItem)] : []),
          ...remaining.map((item, index) => reviewToEntity(item, index + 1, context.gmailRules))
        ];

        return {
          tool: operation.tool,
          status: "executed",
          summary: result.message,
          result: { emailReview: result.emailReview, event: result.event, actionItem: result.actionItem },
          entities
        };
      }

      case "goal.list": {
        return {
          tool: operation.tool,
          status: "executed",
          summary: formatGoalListForChat(context.activeGoals),
          result: context.activeGoals
        };
      }

      case "goal.status": {
        const goalRef = args.goalRef as string | undefined;
        const outcome = resolveGoalReferenceTargets(goalRef, context.activeGoals, resolveCurrentFocusGoal(context));

        if (outcome.status === "no_match") {
          if (context.activeGoals.length === 0) {
            return {
              tool: operation.tool,
              status: "executed",
              summary: "You don't have any active goals yet. Tell me what you want to work on and I can propose a plan to track it.",
              result: []
            };
          }
          return failed(operation.tool, `I couldn't find an active goal matching "${goalRef}". Say "show me all my goals" to see what's active.`);
        }

        if (outcome.status === "ambiguous") {
          return {
            tool: operation.tool,
            status: "executed",
            summary: describeAmbiguousGoalChoice(outcome.goals),
            result: outcome.goals
          };
        }

        const targetGoals = outcome.goals;
        const timezone = await getUserTimezone(userId);
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const recentEvents = await getEventsSince(userId, sevenDaysAgo);
        const todayLocalDate = formatDateInTimezone(new Date(), timezone);

        const summaries = targetGoals.map((goal) => formatGoalStatusForChat(goal, { openActions: context.openActions, gmailReviews: context.gmailReviews, gmailRules: context.gmailRules, recentEvents, timezone, todayLocalDate }));

        return {
          tool: operation.tool,
          status: "executed",
          summary: summaries.join("\n\n"),
          result: targetGoals,
          // Only for a single specifically-resolved goal ("matched"), never "all" — asking about
          // every goal at once must not narrow the conversation's focus to whichever happened to
          // be last in that list.
          entities: outcome.status === "matched" ? [goalToEntity(targetGoals[0])] : undefined
        };
      }

      case "goal.create_propose": {
        const title = args.title as string;
        const category = args.category as string;
        const why = args.why as string | undefined;
        const successCriteria = args.successCriteria as string | undefined;
        const rawSignals = (args.signals as GoalPlanSignal[] | undefined) ?? [];
        const checkIn = args.checkIn as GoalPlanCheckIn | undefined;
        const integrationHint = args.integrationHint as string | undefined;
        const firstActions = (args.firstActions as string[] | undefined) ?? [];

        if (rawSignals.length === 0) {
          return failed(operation.tool, "I need at least one trackable signal to propose a plan for this goal.");
        }

        // Deterministic, not left to the LLM's own discretion: a "finish/read a book"-shaped goal
        // proposed with only a completion signal ("book finished") gives the user nothing to log
        // until the very end — a real Telegram smoke test found prompt guidance alone didn't
        // reliably prevent this. Generic for any book/reading-shaped goal, never a specific title.
        const signals = ensureBookGoalProgressSignal({ title, category, signals: rawSignals });

        return {
          tool: operation.tool,
          status: "executed",
          summary: formatGoalPlanProposal({ title, successCriteria, signals, checkIn, integrationHint, firstActions }),
          pendingOperationUpdate: {
            topic: "goal_creation",
            summary: `create the "${title}" goal`,
            operations: [
              {
                tool: "goal.create_apply",
                args: { title, category, why, signals, checkIn, firstActions },
                status: "valid",
                requiresConfirmation: false
              }
            ]
          }
        };
      }

      case "goal.create_apply": {
        const title = args.title as string;
        const category = args.category as string;
        const why = args.why as string | undefined;
        const rawSignals = (args.signals as GoalPlanSignal[] | undefined) ?? [];
        const checkIn = args.checkIn as GoalPlanCheckIn | undefined;
        const firstActions = (args.firstActions as string[] | undefined) ?? [];

        // Defensive/idempotent — goal.create_apply is normally only reached with signals already
        // augmented by goal.create_propose above (the confirm whitelist re-executes the exact
        // pendingOperation args), but this keeps the guarantee even if that ever changes.
        const signals = ensureBookGoalProgressSignal({ title, category, signals: rawSignals });

        const targetMetrics: GoalMetric[] = signals.map((signal) => ({
          key: signal.key,
          label: signal.label,
          signalKey: signal.key,
          aggregation: "count",
          window: signal.cadence ?? "daily",
          unit: signal.unit
        }));
        const checkInConfig = checkIn ? [{ key: "custom_checkin", question: checkIn.question, answerType: "text" as const, cadence: checkIn.cadence }] : undefined;

        const result = await createGoal(userId, { title, category, why, targetMetrics, checkInConfig });

        if (result.duplicate) {
          return {
            tool: operation.tool,
            status: "executed",
            summary: `You already have an active goal called "${result.existingGoal.title}" — nothing new was created.`,
            result: result.existingGoal
          };
        }

        const createdActions: ActionItem[] = [];
        for (const actionTitle of firstActions) {
          const created = await createActionItem(userId, {
            source: "manual",
            title: actionTitle,
            priority: "medium",
            goalId: result.goal.id,
            goalTitleSnapshot: result.goal.title
          });
          createdActions.push(created);
        }

        const signalNames = signals.map((signal) => signal.label).join(", ");
        const checkInNote = checkIn ? ` and ${checkIn.cadence} check-ins` : "";
        const actionsNote = createdActions.length > 0 ? ` Created ${createdActions.length} first action${createdActions.length === 1 ? "" : "s"}.` : "";

        return {
          tool: operation.tool,
          status: "executed",
          summary: `Done — I'll track "${result.goal.title}" with ${signalNames}${checkInNote}.${actionsNote}`,
          result: result.goal,
          // The new goal itself is included here (not just its first actions) so an immediate
          // follow-up like "show tracking for it" / "how is that goal going?" has a real,
          // just-created entity to resolve against, not only its actions.
          entities: [goalToEntity(result.goal), ...createdActions.map(actionToEntity)]
        };
      }

      case "goal.tracking_show": {
        const goalRef = args.goalRef as string | undefined;
        const outcome = resolveGoalReferenceTargets(goalRef, context.activeGoals, resolveCurrentFocusGoal(context));

        if (outcome.status === "no_match") {
          if (context.activeGoals.length === 0) {
            return { tool: operation.tool, status: "executed", summary: "You don't have any active goals yet.", result: [] };
          }
          return failed(operation.tool, `I couldn't find an active goal matching "${goalRef}". Say "show me all my goals" to see what's active.`);
        }

        if (outcome.status === "ambiguous") {
          return {
            tool: operation.tool,
            status: "executed",
            summary: describeAmbiguousGoalChoice(outcome.goals),
            result: outcome.goals
          };
        }

        return {
          tool: operation.tool,
          status: "executed",
          summary: outcome.goals.map((goal) => formatGoalTrackingForChat(goal)).join("\n\n"),
          result: outcome.goals,
          entities: outcome.status === "matched" ? [goalToEntity(outcome.goals[0])] : undefined
        };
      }

      case "goal.archive_propose": {
        const goalRef = args.goalRef as string | undefined;
        const lifecycleOperation = args.operation as "archive" | "pause";
        const outcome = resolveGoalForLifecycleAction(goalRef, context.activeGoals, resolveCurrentFocusGoal(context));

        if (outcome.status === "no_match") {
          if (context.activeGoals.length === 0) {
            return { tool: operation.tool, status: "executed", summary: "You don't have any active goals to archive or pause.", result: [] };
          }
          return failed(operation.tool, `I couldn't find an active goal matching "${goalRef ?? ""}". Say "show me all my goals" to see what's active.`);
        }

        if (outcome.status === "ambiguous") {
          // Deliberately status "executed" with a question as the summary, exactly like goal
          // .status/goal.tracking_show's own ambiguous case above — never opens a pending
          // confirmation, so goal.archive_apply is never queued against an unresolved target.
          return {
            tool: operation.tool,
            status: "executed",
            summary: describeAmbiguousGoalChoice(outcome.goals),
            result: outcome.goals
          };
        }

        const goal = outcome.goals[0];
        const targetStatus = lifecycleOperation === "archive" ? "archived" : "paused";

        if (goal.status === targetStatus) {
          const stateLabel = goal.status === "archived" ? "archived" : "paused";
          return {
            tool: operation.tool,
            status: "executed",
            summary: `"${goal.title}" is already ${stateLabel}. Nothing to change.`,
            entities: [goalToEntity(goal)]
          };
        }

        // "delete"/"remove" (English) and "elimina"/"borra" (Spanish) are honored as intent to
        // archive — Alecto never permanently deletes goal history — but the confirmation must say
        // so honestly rather than silently reinterpreting the user's own destructive wording. A
        // critical-priority goal gets an extra friction line instead of the plain archive/delete
        // wording (never a hard block — the user can still confirm with a plain "yes") so an
        // important goal is never silently archived without the user noticing its weight.
        const usedDeleteWording = /\b(delete|remove|elimina[r]?|borra[r]?)\b/i.test(message);
        const isCriticalArchive = lifecycleOperation === "archive" && goal.priority === "critical";
        const summaryText =
          lifecycleOperation === "pause"
            ? `You're about to pause "${goal.title}". It will stop appearing as active, but history stays. Reply yes to confirm or cancel.`
            : isCriticalArchive
              ? `This is marked critical, so I won't archive it silently. If you really want to stop tracking it, reply yes to confirm or cancel.`
              : usedDeleteWording
                ? `I won't permanently delete the history. I can archive "${goal.title}" so it stops being active. Reply yes to confirm or cancel.`
                : `You're about to archive "${goal.title}". It will stop appearing as active, but history stays. Reply yes to confirm or cancel.`;

        return {
          tool: operation.tool,
          status: "executed",
          summary: summaryText,
          entities: [goalToEntity(goal)],
          pendingOperationUpdate: {
            topic: "goal_lifecycle",
            summary: `${lifecycleOperation} "${goal.title}"`,
            operations: [
              {
                tool: "goal.archive_apply",
                args: { goalId: goal.id, goalTitle: goal.title, operation: lifecycleOperation },
                status: "valid",
                requiresConfirmation: false
              }
            ]
          }
        };
      }

      case "goal.archive_apply": {
        const goalId = args.goalId as string;
        const goalTitle = args.goalTitle as string;
        const lifecycleOperation = args.operation as "archive" | "pause" | "resume";
        const nextStatus = lifecycleOperation === "resume" ? "active" : lifecycleOperation === "pause" ? "paused" : "archived";

        const updated = await setGoalStatus(userId, goalId, nextStatus);
        if (!updated) {
          return failed(operation.tool, `"${goalTitle}" no longer exists.`);
        }

        const verb = lifecycleOperation === "resume" ? "Resumed" : lifecycleOperation === "pause" ? "Paused" : "Archived";
        return {
          tool: operation.tool,
          status: "executed",
          summary: `${verb} "${goalTitle}".`,
          entities: [goalToEntity(updated)]
        };
      }

      case "operator.today": {
        const dueToday = context.openActions.filter((action) => action.dueAt && isToday(action.dueAt));
        const parts = [
          `${context.openActions.length} open task(s), ${dueToday.length} due today.`,
          `${context.activeGoals.length} active goal(s).`,
          `${context.gmailReviews.length} pending Gmail review(s).`
        ];
        // Natural next step instead of a slash-command recommendation — v3 normal chat
        // should never tell the user to run a command, only to say what they want in words.
        if (context.openActions.length > 0) {
          parts.push('Tell me "clean up my actions" and I\'ll help you decide what to complete, snooze, or archive.');
        }
        const summary = parts.join(" ");
        return { tool: operation.tool, status: "executed", summary, result: { dueToday, openActions: context.openActions } };
      }

      case "operator.recent_changes": {
        const mutations = context.session.recentMutations;
        const summary =
          mutations.length === 0
            ? "Nothing has changed yet in this conversation."
            : `Here's what I've recorded:\n${mutations.map((m) => `- ${m.summary.replace(/\.$/, "")}`).join("\n")}`;
        return {
          tool: operation.tool,
          status: "executed",
          summary,
          result: mutations
        };
      }

      case "proactive.settings_show": {
        const settings = await getOrCreateNotificationSettings(userId);
        return {
          tool: operation.tool,
          status: "executed",
          summary: formatProactiveSettingsSummary(settings),
          result: settings
        };
      }

      case "proactive.settings_propose_update": {
        const settings = await getOrCreateNotificationSettings(userId);
        const morningBriefEnabled = args.morningBriefEnabled as boolean | undefined;
        const eveningCheckinEnabled = args.eveningCheckinEnabled as boolean | undefined;
        const gmailNudgeEnabled = args.gmailNudgeEnabled as boolean | undefined;
        const morningTimeText = args.morningTimeText as string | undefined;
        const eveningTimeText = args.eveningTimeText as string | undefined;

        let morningTimeMinutes: number | undefined;
        if (morningTimeText) {
          morningTimeMinutes = parseTimeOfDayText(morningTimeText);
          if (morningTimeMinutes === undefined) {
            return { tool: operation.tool, status: "executed", summary: `I couldn't understand the morning time "${morningTimeText}". Try something like "9am" or "09:00".` };
          }
        }

        let eveningTimeMinutes: number | undefined;
        if (eveningTimeText) {
          eveningTimeMinutes = parseTimeOfDayText(eveningTimeText);
          if (eveningTimeMinutes === undefined) {
            return { tool: operation.tool, status: "executed", summary: `I couldn't understand the evening time "${eveningTimeText}". Try something like "9:30pm" or "21:30".` };
          }
        }

        const request = { morningBriefEnabled, eveningCheckinEnabled, gmailNudgeEnabled, morningTimeMinutes, eveningTimeMinutes };
        const changes = describeProactiveSettingsChanges(settings, request);

        if (changes.length === 0) {
          const reconnectNote = gmailNudgeEnabled === true ? gmailReconnectNoteAfterNudgeEnabled(userId, context.gmailConnection) : undefined;
          return {
            tool: operation.tool,
            status: "executed",
            summary: [
              `That's already how it's set.\n\n${formatProactiveSettingsSummary(settings)}`,
              reconnectNote
            ].filter(Boolean).join("\n\n")
          };
        }

        const reconnectNote = gmailNudgeEnabled === true ? gmailReconnectNoteForNudge(userId, context.gmailConnection) : undefined;
        return {
          tool: operation.tool,
          status: "executed",
          summary: [
            `You're about to ${changes.map((change) => change.proposal).join(" and ")}.`,
            reconnectNote ? `${reconnectNote} Reply yes to confirm or cancel.` : "Reply yes to confirm or cancel."
          ].join(" "),
          pendingOperationUpdate: {
            topic: "proactive_settings",
            summary: changes.map((change) => change.proposal).join(" and "),
            operations: [
              {
                tool: "proactive.settings_apply_update",
                args: request,
                status: "valid",
                requiresConfirmation: false
              }
            ]
          }
        };
      }

      case "proactive.settings_apply_update": {
        const morningBriefEnabled = args.morningBriefEnabled as boolean | undefined;
        const eveningCheckinEnabled = args.eveningCheckinEnabled as boolean | undefined;
        const gmailNudgeEnabled = args.gmailNudgeEnabled as boolean | undefined;
        const morningTimeMinutes = args.morningTimeMinutes as number | undefined;
        const eveningTimeMinutes = args.eveningTimeMinutes as number | undefined;
        const before = await getOrCreateNotificationSettings(userId);

        const updated = await updateNotificationSettings(userId, { morningBriefEnabled, eveningCheckinEnabled, gmailNudgeEnabled, morningTimeMinutes, eveningTimeMinutes });
        const changes = describeProactiveSettingsChanges(before, { morningBriefEnabled, eveningCheckinEnabled, gmailNudgeEnabled, morningTimeMinutes, eveningTimeMinutes });

        const reconnectNote = gmailNudgeEnabled === true ? gmailReconnectNoteAfterNudgeEnabled(userId, context.gmailConnection) : undefined;
        return {
          tool: operation.tool,
          status: "executed",
          summary: [
            changes.length > 0 ? `Done — ${changes.map((change) => change.done).join(" and ")}.` : "Done — nothing needed to change.",
            reconnectNote
          ].filter(Boolean).join("\n\n"),
          result: updated
        };
      }

      case "operator_profile.propose_update": {
        const directnessStyle = args.directness as "gentle" | "balanced" | "blunt" | undefined;
        const motivationalStyle = args.motivationalStyle as string | undefined;
        const accountabilityStyle = args.accountabilityStrictness as "relaxed" | "balanced" | "strict" | undefined;

        const directness = directnessStyle ? OPERATOR_PROFILE_STYLE_SCALE[directnessStyle] : undefined;
        const accountabilityStrictness = accountabilityStyle ? OPERATOR_PROFILE_STYLE_SCALE[accountabilityStyle] : undefined;

        const before = await getOrCreateUserOperatingProfile(userId);
        const changes = describeOperatorProfileChanges(before, { directness, motivationalStyle, accountabilityStrictness });

        if (changes.length === 0) {
          return { tool: operation.tool, status: "executed", summary: "That's already how I'm set up with you." };
        }

        return {
          tool: operation.tool,
          status: "executed",
          summary: `You're about to ${changes.map((change) => change.proposal).join(" and ")}. Reply yes to confirm or cancel.`,
          pendingOperationUpdate: {
            topic: "operator_profile",
            summary: changes.map((change) => change.proposal).join(" and "),
            operations: [
              {
                tool: "operator_profile.apply_update",
                args: { directness, motivationalStyle, accountabilityStrictness },
                status: "valid",
                requiresConfirmation: false
              }
            ]
          }
        };
      }

      case "operator_profile.apply_update": {
        const directness = args.directness as number | undefined;
        const motivationalStyle = args.motivationalStyle as string | undefined;
        const accountabilityStrictness = args.accountabilityStrictness as number | undefined;
        const before = await getOrCreateUserOperatingProfile(userId);

        const updated = await updateUserOperatingProfile(userId, { directness, motivationalStyle, accountabilityStrictness });
        const changes = describeOperatorProfileChanges(before, { directness, motivationalStyle, accountabilityStrictness });

        return {
          tool: operation.tool,
          status: "executed",
          summary: changes.length > 0 ? `Done — ${changes.map((change) => change.done).join(" and ")}.` : "Done — nothing needed to change.",
          result: updated
        };
      }

      case "proactive.diagnose_morning_brief": {
        const settings = await getOrCreateNotificationSettings(userId);
        const now = new Date();
        const sentForDate = formatDateInTimezone(now, settings.timezone);
        const morningKey = MORNING_BRIEF_DEDUPE_KEY;
        const [alreadySentToday, legacyDailyLoopLog] = await Promise.all([
          hasNotificationLog({ userId, type: morningKey, sentForDate }),
          getNotificationLog({ userId, type: "daily_loop_morning", sentForDate })
        ]);
        const legacyDailyLoopSentAt = legacyDailyLoopLog?.sentAt;

        const allowlistActive = proactiveOperatorAllowlistActiveFromEnv();
        const status = getProactiveDeliveryStatus({
          context,
          notificationSettings: settings,
          now,
          alreadySentDedupeKeys: alreadySentToday ? new Set([morningKey]) : new Set(),
          sentCountToday: alreadySentToday ? 1 : 0,
          deliveryEnabled: proactiveOperatorDeliveryEnabledFromEnv(),
          isAllowlisted: proactiveOperatorAllowlistFromEnv()(userId),
          legacyDailyLoopSentAt
        });

        return {
          tool: operation.tool,
          status: "executed",
          summary: formatProactiveDeliveryDiagnosis(status, settings, legacyDailyLoopSentAt, allowlistActive),
          result: { status }
        };
      }

      case "proactive.diagnose_evening_checkin": {
        const settings = await getOrCreateNotificationSettings(userId);
        const now = new Date();
        const sentForDate = formatDateInTimezone(now, settings.timezone);
        const eveningKey = EVENING_CHECKIN_DEDUPE_KEY;
        const [alreadySentToday, legacyDailyLoopLog] = await Promise.all([
          hasNotificationLog({ userId, type: eveningKey, sentForDate }),
          getNotificationLog({ userId, type: "daily_loop_evening", sentForDate })
        ]);
        const legacyDailyLoopSentAt = legacyDailyLoopLog?.sentAt;

        const allowlistActive = proactiveOperatorAllowlistActiveFromEnv();
        const status = getEveningCheckinDeliveryStatus({
          context,
          notificationSettings: settings,
          now,
          alreadySentDedupeKeys: alreadySentToday ? new Set([eveningKey]) : new Set(),
          sentCountToday: alreadySentToday ? 1 : 0,
          deliveryEnabled: proactiveOperatorDeliveryEnabledFromEnv(),
          isAllowlisted: proactiveOperatorAllowlistFromEnv()(userId),
          legacyDailyLoopSentAt
        });

        return {
          tool: operation.tool,
          status: "executed",
          summary: formatEveningCheckinDeliveryDiagnosis(status, settings, legacyDailyLoopSentAt, allowlistActive),
          result: { status }
        };
      }

      case "daily_loop.settings_show": {
        const settings = await getOrCreateNotificationSettings(userId);
        return {
          tool: operation.tool,
          status: "executed",
          summary: formatDailyLoopSettingsSummary(settings),
          result: settings
        };
      }

      case "daily_loop.settings_propose_update": {
        const settings = await getOrCreateNotificationSettings(userId);
        const morningTimeText = args.morningTimeText as string | undefined;
        const eveningTimeText = args.eveningTimeText as string | undefined;

        let morningTimeMinutes: number | undefined;
        if (morningTimeText) {
          morningTimeMinutes = parseTimeOfDayText(morningTimeText);
          if (morningTimeMinutes === undefined) {
            return { tool: operation.tool, status: "executed", summary: `I couldn't understand the morning time "${morningTimeText}". Try something like "9am" or "09:00".` };
          }
        }

        let eveningTimeMinutes: number | undefined;
        if (eveningTimeText) {
          eveningTimeMinutes = parseTimeOfDayText(eveningTimeText);
          if (eveningTimeMinutes === undefined) {
            return { tool: operation.tool, status: "executed", summary: `I couldn't understand the evening time "${eveningTimeText}". Try something like "9:30pm" or "21:30".` };
          }
        }

        const enabled = args.enabled as boolean | undefined;
        const changes = describeDailyLoopChanges(settings, { enabled, morningTimeMinutes, eveningTimeMinutes });

        if (changes.length === 0) {
          return {
            tool: operation.tool,
            status: "executed",
            summary: `That's already how it's set.\n\n${formatDailyLoopSettingsSummary(settings)}`
          };
        }

        return {
          tool: operation.tool,
          status: "executed",
          summary: `You're about to ${changes.map((change) => change.proposal).join(" and ")}. Reply yes to confirm or cancel.`,
          pendingOperationUpdate: {
            topic: "daily_loop_settings",
            summary: changes.map((change) => change.proposal).join(" and "),
            operations: [
              {
                tool: "daily_loop.settings_apply_update",
                args: {
                  enabled,
                  morningTimeMinutes,
                  eveningTimeMinutes
                },
                status: "valid",
                requiresConfirmation: false
              }
            ]
          }
        };
      }

      case "daily_loop.settings_apply_update": {
        const enabled = args.enabled as boolean | undefined;
        const morningTimeMinutes = args.morningTimeMinutes as number | undefined;
        const eveningTimeMinutes = args.eveningTimeMinutes as number | undefined;
        const before = await getOrCreateNotificationSettings(userId);

        const updated = await updateNotificationSettings(userId, {
          dailyLoopEnabled: enabled,
          morningTimeMinutes,
          eveningTimeMinutes
        });

        const changes = describeDailyLoopChanges(before, { enabled, morningTimeMinutes, eveningTimeMinutes });

        return {
          tool: operation.tool,
          status: "executed",
          summary: changes.length > 0 ? `Done — ${changes.map((change) => change.done).join(" and ")}.` : "Done — nothing needed to change.",
          result: updated
        };
      }

      default:
        return failed(operation.tool, `"${operation.tool}" has no executor implementation.`);
    }
  } catch (error) {
    return failed(operation.tool, error instanceof Error ? error.message : "Unknown execution error.");
  }
}

function formatGmailReviewQuestionAnswer(review: EmailReviewItem, question?: string): string {
  const subject = review.subject ?? "Gmail review";
  const sourceText = [review.subject, review.snippet, review.evidence]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const preview = sourceText ? truncateForChat(sourceText, 320) : "";
  const limitation = "I only have the stored subject, snippet, and evidence here, not the full Gmail body.";

  if (!sourceText) {
    return `${subject}: I do not have enough stored preview text to answer that safely. ${limitation}`;
  }

  const asked = normalizeSearchText(question ?? "");
  const source = normalizeSearchText(sourceText);
  const contentTerms = meaningfulQuestionTerms(asked);
  const matchedTerms = contentTerms.filter((term) => source.includes(term));

  if (contentTerms.length > 0) {
    if (matchedTerms.length > 0) {
      return `${subject}: yes, the stored preview mentions ${matchedTerms.slice(0, 4).join(", ")}.\nPreview: ${preview}\n${limitation}`;
    }
    return `${subject}: I do not see that in the stored preview.\nPreview: ${preview}\n${limitation}`;
  }

  return `${subject}:\nPreview: ${preview}\n${limitation}`;
}

function meaningfulQuestionTerms(text: string): string[] {
  const stopWords = new Set([
    "the",
    "one",
    "does",
    "have",
    "any",
    "info",
    "about",
    "with",
    "from",
    "that",
    "this",
    "email",
    "review",
    "mail",
    "mails",
    "emails",
    "job",
    "jobs",
    "newsletter"
  ]);
  return [...new Set(text.split(/\s+/).filter((term) => term.length >= 4 && !stopWords.has(term)))];
}

function parseActionRescheduleDate(
  action: ActionItem,
  input: { dueText?: string; timeText?: string; timezone: string }
): Date | undefined {
  if (input.dueText?.trim()) {
    const parsed = parseActionDueDate(input.dueText, { timezone: input.timezone });
    return parsed.invalidReason ? undefined : parsed.dueAt ?? undefined;
  }

  if (input.timeText?.trim() && action.dueAt) {
    const localDate = formatDateInTimezone(action.dueAt, input.timezone);
    const parsed = parseActionDueDate(`${localDate} ${input.timeText}`, { timezone: input.timezone });
    return parsed.invalidReason ? undefined : parsed.dueAt ?? undefined;
  }

  return undefined;
}

async function resolveReminderTargetActions(
  userId: string,
  context: ContextBundle,
  actionIds: string[],
  ref?: string
): Promise<ActionItem[]> {
  const broadMeetingRef = !ref?.trim() || /\b(each|all|meeting|meetings|them|these|those)\b/i.test(ref);
  if (actionIds.length === 0 && broadMeetingRef) {
    return meetingActionsFromActionList(await getActionItems(userId, { status: "all", limit: 100 }));
  }

  const candidateIds =
    actionIds.length > 0
      ? actionIds
      : context.session.visibleEntities.filter((entity) => entity.type === "action").map((entity) => entity.id);
  const uniqueIds = [...new Set(candidateIds)];
  const actions = (
    await Promise.all(uniqueIds.map((actionId) => getActionItem(userId, actionId)))
  ).filter((action): action is ActionItem => Boolean(action && action.status !== "archived" && action.status !== "completed"));

  const meetingActions = meetingActionsFromActionList(actions);
  if (broadMeetingRef) {
    return meetingActions;
  }

  const normalizedRef = normalizeSearchText(ref ?? "");
  return meetingActions.filter((action) => normalizeSearchText(action.title).includes(normalizedRef));
}

async function createOrUpdatePreDueReminderActions(
  userId: string,
  actions: ActionItem[],
  leadMinutes: number,
  timezone: string
): Promise<Array<{ target: ActionItem; reminder: ActionItem; created: boolean }>> {
  const results: Array<{ target: ActionItem; reminder: ActionItem; created: boolean }> = [];

  for (const action of actions) {
    // leadMinutes <= 0 would create a companion reminder due AT (or after) the main task's own
    // due time — the task's own due notification already covers that moment, so a separate
    // reminder here would just be a duplicate notification for the same instant. Callers that
    // mean "remind me at the due time" should rely on the task's own reminder, not this one.
    if (!action.dueAt || action.actionType === "reminder" || leadMinutes <= 0) {
      continue;
    }

    const dueAt = new Date(action.dueAt.getTime() - leadMinutes * 60_000);
    const existing = await findPreDueReminderAction(userId, action.id, leadMinutes);

    if (existing && existing.status !== "archived") {
      const updated =
        existing.dueAt?.getTime() === dueAt.getTime()
          ? existing
          : (await rescheduleActionItem(userId, existing.id, dueAt)) ?? existing;
      results.push({ target: action, reminder: updated, created: false });
      continue;
    }

    const created = await createActionItemIfNotExists(userId, {
      source: "system",
      sourceId: preDueReminderSourceId(action.id, leadMinutes),
      title: `Reminder: ${action.title}`,
      description: leadMinutes === 0 ? `Reminder when ${action.title} is due.` : `Reminder ${leadMinutes} minutes before ${action.title}.`,
      priority: action.priority,
      dueAt,
      project: action.project,
      actionType: "reminder",
      evidence: `Reminder for action ${action.id} at ${formatLocalDateTime(action.dueAt, timezone)}.`
    });
    results.push({ target: action, reminder: created.actionItem, created: created.created });
  }

  return results;
}

async function updatePreDueReminderActions(userId: string, action: ActionItem, timezone: string): Promise<ActionItem[]> {
  if (!action.dueAt) {
    return [];
  }

  const actions = await getActionItems(userId, { status: "all", limit: 100 });
  const reminders = actions.filter((item) => item.source === "system" && item.sourceId?.startsWith(`pre_due_reminder:${action.id}:`));
  const updated: ActionItem[] = [];

  for (const reminder of reminders) {
    const leadMinutes = reminder.sourceId ? preDueReminderLeadMinutes(reminder.sourceId) : undefined;
    if (leadMinutes === undefined || reminder.status === "archived") {
      continue;
    }
    const dueAt = new Date(action.dueAt.getTime() - leadMinutes * 60_000);
    updated.push((await rescheduleActionItem(userId, reminder.id, dueAt)) ?? reminder);
  }

  return updated.sort((left, right) => (left.dueAt?.getTime() ?? 0) - (right.dueAt?.getTime() ?? 0));
}

async function findPreDueReminderAction(userId: string, actionId: string, leadMinutes: number): Promise<ActionItem | undefined> {
  const actions = await getActionItems(userId, { status: "all", limit: 100 });
  return actions.find((item) => item.source === "system" && item.sourceId === preDueReminderSourceId(actionId, leadMinutes));
}

function preDueReminderSourceId(actionId: string, leadMinutes: number): string {
  return `pre_due_reminder:${actionId}:${leadMinutes}`;
}

/**
 * Inverse of preDueReminderSourceId — resolves a "remind me N minutes before" companion
 * ActionItem (actionType "reminder", source "system") back to the real task it's about. Exported
 * for runtime.ts's resolveMostRecentlyNotifiedOrVisibleActionId: the worker's own
 * ActionItemReminderLog points at the companion stub's own id when a positive-lead reminder
 * fires, and a bare "complete it" right after must resolve to the real task, never silently
 * complete the stub while the real task stays open and due.
 */
export function parentActionIdFromReminderSourceId(actionType: string | null | undefined, sourceId: string | null | undefined): string | undefined {
  if (actionType !== "reminder" || !sourceId) {
    return undefined;
  }
  const match = sourceId.match(/^pre_due_reminder:([^:]+):\d+$/);
  return match?.[1];
}


function preDueReminderLeadMinutes(sourceId: string): number | undefined {
  const match = sourceId.match(/^pre_due_reminder:[^:]+:(\d+)$/);
  const minutes = match?.[1] ? Number(match[1]) : undefined;
  return minutes !== undefined && Number.isInteger(minutes) && minutes >= 0 ? minutes : undefined;
}

function activeReminderActionsFromActionList(actions: ActionItem[]): ActionItem[] {
  return actions
    .filter((action) => action.status !== "archived" && action.status !== "completed")
    .filter(isReminderCompanionAction)
    .filter((action) => Boolean(action.dueAt))
    .sort((left, right) => (left.dueAt?.getTime() ?? Number.POSITIVE_INFINITY) - (right.dueAt?.getTime() ?? Number.POSITIVE_INFINITY));
}

function meetingActionsFromActionList(actions: ActionItem[]): ActionItem[] {
  return actions
    .filter((action) => action.status !== "archived" && action.status !== "completed")
    .filter((action) => !isReminderCompanionAction(action))
    .filter((action) => Boolean(action.dueAt))
    .filter(isMeetingLikeAction)
    .sort((left, right) => (left.dueAt?.getTime() ?? Number.POSITIVE_INFINITY) - (right.dueAt?.getTime() ?? Number.POSITIVE_INFINITY));
}

function preDueReminderActionsFromActionList(actions: ActionItem[]): ActionItem[] {
  return actions.filter(
    (action) => action.status !== "archived" && action.status !== "completed" && isReminderCompanionAction(action) && Boolean(action.sourceId?.startsWith("pre_due_reminder:"))
  );
}

function isMeetingLikeAction(action: ActionItem): boolean {
  const text = normalizeSearchText([action.title, action.description, action.evidence].filter(Boolean).join(" "));
  return /\b(meeting|call|interview|appointment|brainstorm|sync|standup|stand up|review session)\b/.test(text);
}

function formatMeetingActionsForChat(meetings: ActionItem[], reminders: ActionItem[], timezone: string): string {
  if (meetings.length === 0) {
    return "I don't see any scheduled meeting tasks right now.";
  }

  const lines = ["Your meetings:"];
  meetings.forEach((meeting) => {
    const reminder = reminders.find((item) => item.sourceId?.startsWith(`pre_due_reminder:${meeting.id}:`));
    lines.push(
      `- ${meeting.title} — ${formatLocalDateTime(meeting.dueAt, timezone)}${reminder?.dueAt ? `. Reminder: ${formatLocalDateTime(reminder.dueAt, timezone)}` : ""}.`
    );
  });
  return lines.join("\n");
}

/**
 * Numbered, natural-language action list — deliberately parallel to action.hygiene_start's own
 * "Reply like: complete 1, snooze 2 to Friday, archive 3." numbered format (same convention, same
 * generic action.hygiene_apply resolution by visible-entity index), so a normal "show me my
 * actions" list and a hygiene cleanup list behave the same way for a numbered follow-up reply.
 * `items` never includes a reminder companion row (filtered by the caller) — a real action with
 * one gets a short "Reminder: N minutes before" metadata line instead of the companion being
 * listed as if it were its own task.
 */
/**
 * Light provenance label for a real action list entry — real Telegram smoke test found
 * old email-generated actions (a raw email subject line like "Hola Miquel, tu opinión es muy
 * importante para nosotros.") sitting in the list with no indication they came from an
 * automated Gmail rule rather than something the user actually asked to track, and later fuzzy-
 * matched against an unrelated command as if they were an equally-trustworthy manual task.
 * ActionItem.source/sourceProvider already carry this (no schema change needed) — just never
 * surfaced to chat before. Returns undefined for a manually-created or system action, which
 * needs no such caveat.
 */
function actionSourceLabel(action: ActionItem): string | undefined {
  if (action.source !== "email_review") {
    return undefined;
  }
  return action.sourceProvider === "gmail" ? "(from Gmail)" : "(from email review)";
}

function formatActionListForChat(
  items: ActionItem[],
  totalMatching: number,
  status: ActionItem["status"] | "all",
  overdueOnly: boolean,
  reminderByParentId: Map<string, ActionItem>,
  timezone: string
): string {
  const statusNoun = status === "all" ? "action" : `${status} action`;
  const noun = overdueOnly ? "overdue action" : statusNoun;

  if (items.length === 0) {
    return `You don't have any ${noun}s right now.`;
  }

  // Real Telegram smoke test: "You have 10 open actions" when 12 actually existed — never claim
  // a total that's actually just the page size. Only the exact count when everything is shown;
  // "Showing N of M" the moment the real total is larger than what's displayed.
  const header =
    totalMatching > items.length
      ? `Showing ${items.length} of ${totalMatching} ${noun}s:`
      : `You have ${items.length} ${noun}${items.length === 1 ? "" : "s"}:`;

  const lines = [header];
  items.forEach((item, index) => {
    const dueLine = item.dueAt ? ` — ${formatDueLabelForChat(item.dueAt, timezone)}` : "";
    lines.push(`${index + 1}. ${item.title}${dueLine}`);
    const sourceLine = actionSourceLabel(item);
    if (sourceLine) {
      lines.push(`   ${sourceLine}`);
    }
    const reminder = reminderByParentId.get(item.id);
    if (reminder) {
      lines.push(`   ${formatReminderMetadataForChat(reminder)}`);
    }
  });
  lines.push("", "Reply: complete 1, snooze 2 tomorrow, archive 3.");

  return lines.join("\n");
}

/** "due today 14:30" / "due tomorrow 09:00" / a full date+time fallback further out — generic
 * relative-day phrasing, not specific to any one caller, so any due-date-bearing list (actions,
 * overdue queries) can read naturally instead of showing a raw timestamp. */
function formatDueLabelForChat(dueAt: Date, timezone: string): string {
  const todayLocal = formatDateInTimezone(new Date(), timezone);
  const dueLocal = formatDateInTimezone(dueAt, timezone);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false }).format(dueAt);

  if (dueLocal === todayLocal) {
    return `due today ${time}`;
  }
  if (dueLocal === addDaysToLocalDateString(todayLocal, 1)) {
    return `due tomorrow ${time}`;
  }
  return `due ${formatLocalDateTime(dueAt, timezone)}`;
}

/** Short parent-action metadata line for a linked pre-due reminder — "Reminder: 30 minutes
 * before" / "Reminder at due time" / a generic fallback when the lead time can't be parsed back
 * out of the reminder's own sourceId (shouldn't happen for a well-formed pre_due_reminder row). */
function formatReminderMetadataForChat(reminder: ActionItem): string {
  const leadMinutes = reminder.sourceId ? preDueReminderLeadMinutes(reminder.sourceId) : undefined;
  if (leadMinutes === undefined) {
    return "Reminder set";
  }
  return leadMinutes === 0 ? "Reminder at due time" : `Reminder: ${leadMinutes} minutes before`;
}

/**
 * Reminders shown grouped under the parent action's own title (never the companion's own
 * denormalized "Reminder: X" title, and never the parent's separate due time confused for the
 * reminder's own earlier due time) — "Brainstorm meeting — reminder 30 minutes before (due today
 * 09:00)" reads as one fact about one task, not two disconnected list entries.
 */
function formatReminderActionsForChat(reminders: ActionItem[], candidates: ActionItem[], timezone: string): string {
  if (reminders.length === 0) {
    return "No reminders are currently scheduled.";
  }

  const linked = reminders.filter((reminder) => resolveReminderParent(reminder, candidates));
  const unlinked = reminders.filter((reminder) => !resolveReminderParent(reminder, candidates));

  const lines = ["Your reminders:"];
  linked.forEach((reminder) => {
    const parent = resolveReminderParent(reminder, candidates)!;
    const leadMinutes = reminder.sourceId ? preDueReminderLeadMinutes(reminder.sourceId) : undefined;
    const leadLine = leadMinutes === undefined ? "" : ` — ${leadMinutes === 0 ? "reminder at due time" : `reminder ${leadMinutes} minutes before`}`;
    const dueLine = parent.dueAt ? ` (due ${formatDueLabelForChat(parent.dueAt, timezone)})` : ` (${formatLocalDateTime(reminder.dueAt, timezone)})`;
    lines.push(`- ${parent.title}${leadLine}${dueLine}`);
  });

  // A reminder whose parent can't be resolved at all (deleted, or a genuinely malformed legacy
  // row with no matching title) — shown honestly as unlinked rather than silently hidden or
  // mixed in as if it belonged to a real, current task.
  if (unlinked.length > 0) {
    lines.push("", "Unlinked reminders (no matching task found):");
    unlinked.forEach((reminder) => {
      lines.push(`- ${reminderTitleForChat(reminder.title)} (${formatLocalDateTime(reminder.dueAt, timezone)})`);
    });
  }

  return lines.join("\n");
}

function reminderTitleForChat(title: string): string {
  return title.replace(REMINDER_TITLE_PREFIX_RE, "").trim() || title;
}

function normalizeSearchText(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9.+#/-]+/g, " ")
    .trim();
}

function truncateForChat(text: string, maxLength: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length <= maxLength ? clean : `${clean.slice(0, maxLength - 3).trimEnd()}...`;
}

// packages/core's parseActionDueDate (used by createActionItemFromEmailReview below) only
// recognizes English day-part phrasing ("tomorrow morning") — it has no Spanish/Catalan support
// at all, and is shared by several other tools (action.create/snooze/reschedule), so widening it
// directly risks a much larger blast radius than this one call site needs. This is a narrow,
// V3-only translation of the handful of due-date phrases these tests actually exercise, applied
// only to gmail.review.to_action's dueText, not a general Spanish/Catalan date parser. Ordered
// longest-phrase-first so e.g. "demà al matí" is translated whole before the bare "demà" fallback
// would otherwise only catch "demà" and leave "al matí" untouched.
// Trailing \b is unreliable right after à/í — JS regex's \w (and therefore \b) is ASCII-only by
// default, so a boundary check immediately following one of these accented letters silently never
// matches; a non-letter lookahead is used instead wherever a pattern ends on one.
const NOT_FOLLOWED_BY_LETTER = "(?![a-zA-Z])";
const DUE_TEXT_ES_CA_TRANSLATIONS: Array<[RegExp, string]> = [
  [/\bmañana\s+por\s+la\s+mañana\b/gi, "tomorrow morning"],
  [/\bmañana\s+por\s+la\s+tarde\b/gi, "tomorrow afternoon"],
  [/\bmañana\s+por\s+la\s+noche\b/gi, "tomorrow evening"],
  [new RegExp(`\\bdemà\\s+al\\s+mat[ií]${NOT_FOLLOWED_BY_LETTER}`, "gi"), "tomorrow morning"],
  [/\bdemà\s+a\s+la\s+tarda\b/gi, "tomorrow afternoon"],
  [/\bdemà\s+al\s+vespre\b/gi, "tomorrow evening"],
  [/\bdemà\s+a\s+la\s+nit\b/gi, "tomorrow evening"],
  [new RegExp(`\\bdemà${NOT_FOLLOWED_BY_LETTER}`, "gi"), "tomorrow"],
  [/\bmañana\b/gi, "tomorrow"],
  [/\bhoy\b/gi, "today"],
  [/\bavui\b/gi, "today"],
  [/\besta\s+noche\b/gi, "tonight"],
  [/\baquesta\s+nit\b/gi, "tonight"]
];

function translateDueTextToEnglish(text: string): string {
  let result = text;
  for (const [pattern, replacement] of DUE_TEXT_ES_CA_TRANSLATIONS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

function extractGmailReviewActionDueText(message: string): string | undefined {
  const text = message.replace(/\s+/g, " ").trim();
  if (!text) {
    return undefined;
  }

  const minuteRelative = text.match(/\b(?:in\s+\d{1,4}\s+(?:minutes?|mins?)|\d{1,4}\s+(?:minutes?|mins?)\s+from\s+now)\b/i);
  if (minuteRelative?.[0]) {
    return minuteRelative[0].trim();
  }

  const relativeDayMatch = text.match(
    /\b(?:for|by|before|on|to|until|at)\s+((?:today|tomorrow|tonight|now)(?:\s+(?:morning|afternoon|evening|tonight))?)\b/i
  );
  if (relativeDayMatch?.[1]) {
    return relativeDayMatch[1].trim();
  }

  const bareRelativeDayMatch = text.match(/\b((?:today|tomorrow|tonight|now)(?:\s+(?:morning|afternoon|evening|tonight))?)\b/i);
  if (bareRelativeDayMatch?.[1]) {
    return bareRelativeDayMatch[1].trim();
  }

  const weekday = "(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)";
  const weekdayMatch = text.match(new RegExp(`\\b(?:for|by|before|on|to|until)\\s+((?:next\\s+)?${weekday}(?:\\s+(?:morning|afternoon|evening|tonight))?)\\b`, "i"));
  if (weekdayMatch?.[1]) {
    return weekdayMatch[1].trim();
  }

  const month = "(?:january|february|march|april|may|june|july|august|september|october|november|december)";
  const dateMatch = text.match(new RegExp(`\\b(by|before|on)\\s+(${month}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,\\s*\\d{4})?)\\b`, "i"));
  if (dateMatch?.[1] && dateMatch[2]) {
    return `${dateMatch[1]} ${dateMatch[2]}`.trim();
  }

  return undefined;
}

function failed(tool: string, error: string): ExecutedOperation {
  return { tool, status: "failed", summary: error, error };
}

function normalize(text: string): string {
  return text.trim().toLowerCase();
}

function isToday(date: Date): boolean {
  const now = new Date();
  return date.toDateString() === now.toDateString();
}

function actionToEntity(action: ActionItem, index?: number): AgentEntity {
  return { type: "action", id: action.id, label: action.title, index };
}

function goalToEntity(goal: Goal): AgentEntity {
  return { type: "goal", id: goal.id, label: goal.title };
}

function gmailRuleToEntity(rule: EmailSignalRule, index?: number): AgentEntity {
  return { type: "gmail_rule", id: rule.id, label: rule.name, index };
}

function reviewToEntity(review: EmailReviewItem, index: number, rules: EmailSignalRule[]): AgentEntity {
  return { type: "gmail_review", id: review.id, label: gmailReviewChatLabel(review, rules), index };
}

function hygieneActionLabel(action: ActionHygieneAction): string {
  return action.daysOverdue !== undefined && action.daysOverdue >= 1 ? `${action.title} — overdue` : action.title;
}

function hygieneActionToEntity(action: ActionHygieneAction, index: number): AgentEntity {
  return { type: "action", id: action.actionId, label: action.title, index };
}

function planSuggestionToEntity(suggestion: NextWeekPlanSuggestion): AgentEntity {
  return { type: "plan_suggestion", id: suggestion.dedupeKey ?? `plan-suggestion-${suggestion.index}`, label: suggestion.title, index: suggestion.index };
}

function formatPlanWeekday(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: timezone, weekday: "long" }).format(date);
}

function formatPlanDraftSummary(windowKind: PlanWindowKind, selections: NextWeekPlanSuggestion[], timezone: string): string {
  return [
    `Here's a draft plan for ${windowKind === "current_week" ? "this week" : "next week"}:`,
    ...selections.map((suggestion) => `${suggestion.index}. ${formatPlanWeekday(suggestion.suggestedDueAt, timezone)} — ${suggestion.title}`),
    "",
    'Tell me naturally what to change — for example: "move the gym one to Friday", "remove the YouTube item", "make it lighter", or "yes" to create it.'
  ].join("\n");
}

function formatWeeklyReviewDraftSummary(context: WeeklyReviewContext, draft: WeeklyReviewDraft): string {
  return [
    "Here's your weekly review:",
    "",
    draft.summary,
    "",
    "Wins:",
    ...draft.wins.map((win) => `- ${win}`),
    "",
    "Stalls:",
    ...draft.stalls.map((stall) => `- ${stall}`),
    "",
    "Guardrails:",
    `- ${buildWeeklyGuardrailNote(context)}`,
    "",
    "Email signals:",
    formatWeeklyEmailSignalsForReview(context.emailAttention),
    "",
    "Patterns:",
    draft.patterns.length > 0 ? draft.patterns.map((pattern) => `- ${pattern}`).join("\n") : "- No active operator reflections included.",
    "",
    "Next move:",
    draft.recommendedNextWeekActions.length > 0
      ? draft.recommendedNextWeekActions.map((action, index) => `${index + 1}. ${action}`).join("\n")
      : "- No next-week focus suggested from this week's data.",
    "",
    'Reply: "save this review" to keep it, or "cancel".'
  ].join("\n");
}

function formatThinWeeklyReviewSummary(context: WeeklyReviewContext): string {
  const openParts = [
    context.openActions.length > 0 ? `${context.openActions.length} open action${context.openActions.length === 1 ? "" : "s"}` : undefined,
    context.activeGoals.length > 0 ? `${context.activeGoals.length} active goal${context.activeGoals.length === 1 ? "" : "s"}` : undefined
  ].filter(Boolean);

  return [
    "Not much was logged this week. I can still review open goals/actions, but the event history is thin.",
    openParts.length > 0 ? `Right now: ${openParts.join(", ")}.` : undefined,
    'Reply: "save this review" to keep it, or "cancel".'
  ].filter(Boolean).join("\n");
}

/**
 * Grounded in real Goal rows only — title/category/priority/why, never an invented progress
 * figure (targetMetrics/checkInConfig would need real event aggregation this tool doesn't do).
 * Closing line was rewritten from an "editing/deleting isn't wired yet" boundary (stale since
 * §29's goal.archive_propose/goal.archive_apply shipped) to a natural-examples line covering both
 * lifecycle management and the other real goal tools — see docs/10-v3-readiness-audit.md §29/§30.
 */
function formatGoalListForChat(goals: Goal[]): string {
  if (goals.length === 0) {
    return "You don't have active goals set yet. Tell me what you want to work on and I can propose a plan to track it.";
  }

  const lines = ["Your active goals:"];
  goals.forEach((goal, index) => {
    lines.push(`${index + 1}. ${goal.title} — ${goal.category} — ${goal.priority}`);
    if (goal.why) {
      lines.push(`   Why: ${goal.why}`);
    }
  });
  lines.push(
    "",
    'You can manage goals naturally: "pause the Meditations goal", "archive the car goal", "show progress on job search", or "log 20 pages for reading".'
  );

  return lines.join("\n");
}

/** Grammatically correct singular/plural for a small set of career event types that predate
 * per-goal metric labels — kept only as the LAST-RESORT fallback inside describeSignalCount below,
 * for the rare case evidence is logged for an eventType no active goal's own metric declares a
 * label for (evidence still logs; only the English wording falls back). Separate from
 * email-review-service.ts's humanEmailReviewEventLabel, whose "log X"/outcome phrasing is never
 * pluralized by a count, unlike here. */
const EVENT_COUNT_LABELS: Record<string, [singular: string, plural: string]> = {
  "career.application_sent": ["application sent", "applications sent"],
  "career.recruiter_reply_received": ["recruiter reply", "recruiter replies"],
  "career.interview_scheduled": ["interview scheduled", "interviews scheduled"],
  "career.interview_completed": ["interview completed", "interviews completed"],
  "career.rejection_received": ["rejection", "rejections"],
  "career.offer_received": ["job offer", "job offers"]
};

function describeEventCount(eventType: string, count: number): string {
  const labels = EVENT_COUNT_LABELS[eventType];
  if (!labels) {
    return `${count} ${eventType} event${count === 1 ? "" : "s"}`;
  }

  return `${count} ${count === 1 ? labels[0] : labels[1]}`;
}

/**
 * Unified goal.log_evidence label: whichever active goal actually matched (eventType OR
 * signalKey) always wins with ITS OWN declared metric label — set at goal-creation time, from a
 * template or an adaptive goal.create_propose plan — the same label goal.status and
 * goal.tracking_show already show for that metric, so the logged confirmation and the later
 * status count are never described two different ways. describeEventCount's small hardcoded map
 * is only a fallback for the (rare) case a matched goal somehow has no label on that metric.
 */
function describeSignalCount(goal: Goal | undefined, eventType: string | undefined, signalKey: string | undefined, count: number): string {
  const metric = goal?.targetMetrics?.find((item) => (eventType && item.eventType === eventType) || (signalKey && item.signalKey === signalKey));
  if (metric) {
    return `${count} ${metric.label}`;
  }
  if (eventType) {
    return describeEventCount(eventType, count);
  }
  return `${count} ${signalKey}`;
}

export type GoalReferenceOutcomeStatus = "all" | "matched" | "ambiguous" | "no_match";

export interface GoalReferenceOutcome {
  status: GoalReferenceOutcomeStatus;
  /** "all"/"matched": the target goal(s) to act on. "ambiguous": the near-tied candidates, for a
   * clarifying question. "no_match": always empty. */
  goals: Goal[];
}

/**
 * Which active goal(s) goal.status / goal.tracking_show / goal.log_evidence's disambiguation
 * report on — delegates the actual text-matching to goal-reference.ts's
 * resolveActiveGoalReference (generic title/typo/category scoring, kept deliberately separate
 * from goal-linking.ts's inferGoalLinkForAction, which answers a different question — "which
 * goal's general DOMAIN does this new action belong to" — and was the wrong tool for THIS job: a
 * real Telegram smoke test asked "show tracking for reading niezsche book" with an active generic
 * "Read more" (learning) goal AND a just-created "Finish reading Nietzsche book" goal, and
 * inferGoalLinkForAction's coarse category-bucket scoring matched the generic goal at a HIGHER
 * confidence than the specific, exactly-named one — backwards from what naming a goal means).
 *
 * No goalRef at all means "report on every active goal" (unchanged prior behavior — e.g. "how are
 * my goals doing?"). A goalRef that resolves to exactly one goal (including a bare "it"/"that
 * goal" right after creating, showing, or logging against one — see `currentFocus` below, and
 * `mostRecent`, tried only when there's no focus yet) is "matched". Two or more goals landing
 * within the resolver's ambiguity margin is "ambiguous" — never silently guessed, UNLESS the
 * conversation's current focus is one of the tied candidates, in which case that's what "the one
 * we were just talking about" means and it wins without asking. A goalRef naming nothing real is
 * "no_match" — also never silently widened back to every goal, unlike the old
 * inferGoalLinkForAction-based fallback here.
 */
function resolveGoalReferenceTargets(goalRef: string | undefined, activeGoals: Goal[], currentFocus?: Goal): GoalReferenceOutcome {
  if (activeGoals.length === 0) {
    return { status: "no_match", goals: [] };
  }

  if (!goalRef || !goalRef.trim()) {
    return { status: "all", goals: activeGoals };
  }

  const resolution = resolveActiveGoalReference(goalRef, activeGoals, { mostRecent: activeGoals[0], currentFocus });

  if (resolution.status === "matched" && resolution.goal) {
    return { status: "matched", goals: [resolution.goal] };
  }

  if (resolution.status === "ambiguous" && resolution.candidates) {
    return { status: "ambiguous", goals: resolution.candidates };
  }

  return { status: "no_match", goals: [] };
}

/**
 * Goal resolution for lifecycle mutations (archive/pause) — deliberately STRICTER than
 * resolveGoalReferenceTargets above. That function falls back to `mostRecent` (activeGoals[0], the
 * newest-created goal) for a bare/empty reference, which is fine for a read-only goal.status
 * question but not safe for a mutation: "archive it" with no goalRef and no established
 * conversation focus must never silently archive "whichever goal happens to be newest" — it must
 * ask, or say there's nothing in view, never guess. `mostRecent` is intentionally omitted here;
 * only an explicit title match or the conversation's own currentFocus (e.g. right after
 * goal.status showed exactly one goal) can resolve a lifecycle target.
 */
function resolveGoalForLifecycleAction(goalRef: string | undefined, activeGoals: Goal[], currentFocus?: Goal): GoalReferenceOutcome {
  if (activeGoals.length === 0) {
    return { status: "no_match", goals: [] };
  }

  const resolution = resolveActiveGoalReference(goalRef, activeGoals, { currentFocus });

  if (resolution.status === "matched" && resolution.goal) {
    return { status: "matched", goals: [resolution.goal] };
  }

  if (resolution.status === "ambiguous" && resolution.candidates) {
    return { status: "ambiguous", goals: resolution.candidates };
  }

  return { status: "no_match", goals: [] };
}

/**
 * Whichever goal the CONVERSATION is currently about — see types.ts's AgentFocusedEntities —
 * re-verified against real, currently-active goals (never trusted as-is: the session only caches
 * an id+label, e.g. the goal could have been archived since). Undefined when nothing is focused
 * yet (a session's first goal-related turn) or the focused goal is no longer active.
 */
export function resolveCurrentFocusGoal(context: ContextBundle): Goal | undefined {
  const focusedGoalEntity = context.session.focusedEntities?.goal;
  return focusedGoalEntity ? context.activeGoals.find((goal) => goal.id === focusedGoalEntity.id) : undefined;
}

function describeAmbiguousGoalChoice(candidates: Goal[]): string {
  const names = candidates.map((goal) => `"${goal.title}"`);
  const last = names.pop();
  return `Do you mean ${names.length > 0 ? `${names.join(", ")} or ${last}` : last}?`;
}

/**
 * Grounded per-goal status line: real linked open actions, real evidence events counted this
 * week/today via the goal's own declared targetMetrics (goal-evidence.ts's
 * findGoalsForEventType, applied in reverse — which of THIS goal's metrics match each event),
 * and real pending Gmail reviews linked via the rule that created them. Never invents a count.
 */
function formatGoalStatusForChat(
  goal: Goal,
  input: { openActions: ActionItem[]; gmailReviews: EmailReviewItem[]; gmailRules: EmailSignalRule[]; recentEvents: StoredEvent[]; timezone: string; todayLocalDate: string }
): string {
  const metrics = goal.targetMetrics ?? [];
  const todayEvents = input.recentEvents.filter((event) => formatDateInTimezone(event.timestamp, input.timezone) === input.todayLocalDate);
  const linkedActions = input.openActions.filter((action) => action.goalId === goal.id);
  const linkedRuleIds = new Set(input.gmailRules.filter((rule) => rule.goalId === goal.id).map((rule) => rule.id));
  const linkedReviews = input.gmailReviews.filter((review) => linkedRuleIds.has(review.ruleId));

  // Iterates the goal's OWN declared metrics (goal-evidence.ts's countEvidenceForMetric),
  // uniformly handling registry-backed (eventType) and custom (signalKey) signals — no
  // special-casing needed here for either kind, and the metric's own `label` (set at goal
  // creation, from a template or an adaptive goal.create_propose plan) is always what's shown.
  const weekCounts = metrics.map((metric) => ({ metric, count: countEvidenceForMetric(metric, input.recentEvents) })).filter((entry) => entry.count > 0);
  const todayCounts = metrics.map((metric) => ({ metric, count: countEvidenceForMetric(metric, todayEvents) })).filter((entry) => entry.count > 0);

  const lines = [`"${goal.title}" (${goal.category}):`];

  if (weekCounts.length > 0) {
    lines.push(`This week: ${weekCounts.map((entry) => `${entry.count} ${entry.metric.label}`).join(", ")}.`);
    if (todayCounts.length > 0) {
      lines.push(`Today: ${todayCounts.map((entry) => `${entry.count} ${entry.metric.label}`).join(", ")}.`);
    }
  } else {
    lines.push("No logged progress in the last 7 days.");
  }

  if (linkedActions.length > 0) {
    lines.push(`Open actions: ${linkedActions.map((action) => `"${action.title}"`).join(", ")}.`);
  }

  if (linkedReviews.length > 0) {
    lines.push(`${linkedReviews.length} pending Gmail review${linkedReviews.length === 1 ? "" : "s"} linked to this goal.`);
  }

  return lines.join("\n");
}

interface GoalPlanSignal {
  key: string;
  label: string;
  unit?: string;
  cadence?: "daily" | "weekly";
}

interface GoalPlanCheckIn {
  cadence: string;
  question: string;
}

/** Deterministic formatting of an LLM-PROPOSED goal plan — args are structured (never raw prose),
 * so this is the one place that turns them into the exact "Goal: ... / Signals: ... / Want me to
 * create this goal?" shape, matching the product's desired UX precisely regardless of how the
 * planner phrased its own reasoning. */
function formatGoalPlanProposal(input: {
  title: string;
  successCriteria?: string;
  signals: GoalPlanSignal[];
  checkIn?: GoalPlanCheckIn;
  integrationHint?: string;
  firstActions: string[];
}): string {
  const lines = [`Good — I can track "${input.title}" like this:`, "", `Goal: ${input.title}`];

  // Explicit even when there's no target, not just a silently-omitted line — a real private-alpha
  // user asked for "no fixed target, just track how much I send," and a proposal that just leaves
  // the Target line out reads as an oversight rather than a deliberate choice honoring what they
  // asked for.
  lines.push(input.successCriteria ? `Target: ${input.successCriteria}` : "No fixed target yet — I'll show the count and trend.");

  lines.push("Tracking:", ...input.signals.map((signal) => `- ${signal.label}`));

  if (input.checkIn) {
    const cadenceLabel = input.checkIn.cadence.charAt(0).toUpperCase() + input.checkIn.cadence.slice(1);
    lines.push(`${cadenceLabel} check-in:`, `- "${input.checkIn.question}"`);
  }

  if (input.integrationHint) {
    // The disclaimer is appended here, deterministically, rather than left to the planner's own
    // integrationHint wording — every Gmail-adjacent proposal must say the same honest thing about
    // what Gmail integration actually does, regardless of how the LLM phrased the hint itself.
    const gmailDisclaimer = /gmail/i.test(input.integrationHint)
      ? " I can notify you about matching Gmail reviews; I cannot send or reply to emails."
      : "";
    lines.push("Integration:", `- ${input.integrationHint}${gmailDisclaimer}`);
  }

  // "Concrete" in the label itself, not just in the planner's own selection criteria — this line
  // never appears at all unless there's a genuinely concrete, one-off action to show (per the
  // firstActions-concreteness prompt rule, an empty list here is a normal, honest outcome, not a
  // gap the morning brief will fill in later).
  if (input.firstActions.length > 0) {
    lines.push("First concrete actions:", ...input.firstActions.map((action) => `- ${action}`));
  }

  lines.push("", "Want me to create this goal?");

  return lines.join("\n");
}

/** What's actually CONFIGURED for a goal (its own declared signals/check-in), never its progress
 * — the config-vs-progress split matches goal.list (details) vs goal.status (progress). Shows
 * each metric's real signalKey OR eventType when it has one, so a follow-up "had 2 teas"/"read 5
 * minutes" can be answered correctly by goal.log_evidence rather than the user (or the LLM)
 * needing to know the exact key/type already — before this, only signalKey was ever shown here,
 * so a template-based goal whose metric is eventType-backed (e.g. "Read more"'s
 * "learning.reading_session_completed") gave no machine-readable identifier at all. */
function formatGoalTrackingForChat(goal: Goal): string {
  const metrics = goal.targetMetrics ?? [];
  const lines = [`"${goal.title}" (${goal.category}):`];

  if (goal.why) {
    lines.push(`Why: ${goal.why}`);
  }

  if (metrics.length > 0) {
    lines.push("Signals:");
    for (const metric of metrics) {
      const keyNote = metric.signalKey ? ` [signal: ${metric.signalKey}]` : metric.eventType ? ` [event: ${metric.eventType}]` : "";
      lines.push(`- ${metric.label}${keyNote}`);
    }
  } else {
    lines.push("No tracked signals configured.");
  }

  const checkIn = (goal.checkInConfig ?? [])[0];
  if (checkIn) {
    const cadenceNote = checkIn.cadence ? `${checkIn.cadence}: ` : "";
    lines.push(`Check-in: ${cadenceNote}"${checkIn.question}"`);
  }

  return lines.join("\n");
}

function formatProactiveSettingsSummary(settings: NotificationSettings): string {
  const morning = settings.morningBriefEnabled ? `on, around ${formatMinutesOfDay(settings.morningTimeMinutes)}` : "off";
  const evening = settings.eveningCheckinEnabled ? `on, around ${formatMinutesOfDay(settings.eveningTimeMinutes)}` : "off";
  return [
    "Automatic messages:",
    `- Morning brief: ${morning}`,
    `- Evening check-in: ${evening}`,
    `- Gmail alerts: ${settings.gmailNudgeEnabled ? "on" : "off"}`
  ].join("\n");
}

type BuiltInGmailRuleKind = "job_search" | "work_action";

function formatCanonicalGmailSyncBlock(userId: string, state: Awaited<ReturnType<typeof buildGmailAutonomyState>>): string | undefined {
  const connection = state.primaryConnection;
  const oauthUrl = gmailOAuthUrlForUser(userId);

  if (!connection || state.authState === "disconnected") {
    return [
      "Gmail is not connected yet.",
      ...gmailOAuthActionLines("Connect Gmail here", oauthUrl),
      "After connecting, enable an email rule before any Gmail scan can run."
    ].join("\n");
  }

  if (state.authState === "expired" || state.authState === "error") {
    return [
      gmailConnectionProblemLine(connection),
      ...gmailOAuthActionLines("Reconnect Gmail here", oauthUrl),
      state.activeRules.length > 0
        ? `You have ${state.activeRules.length} active Gmail rule${state.activeRules.length === 1 ? "" : "s"}, but sync cannot run until Gmail is reconnected.`
        : "Sync cannot run until Gmail is reconnected.",
      ...formatActiveGmailRuleLines(state.activeRules)
    ].join("\n");
  }

  if (state.authState === "paused") {
    return [
      "Gmail is paused.",
      "Sync cannot run while the Gmail connection is paused.",
      ...formatActiveGmailRuleLines(state.activeRules)
    ].join("\n");
  }

  if (state.activeRules.length === 0) {
    return noActiveGmailRulesForAgent();
  }

  return undefined;
}

/** How often Gmail is actually being checked, distinct from formatGmailConnectionStatusForChat's
 * connection/rule status — a deliberately narrow answer for "when do you check Gmail?"-style
 * questions, never listing rules unless asked (that's gmail.rule.list's own job). */
function formatGmailAutonomyStatusForChat(state: Awaited<ReturnType<typeof buildGmailAutonomyState>>): string {
  if (!state.gmailConnected || !state.primaryConnection) {
    return "Gmail is not connected yet, so there's no sync schedule to show. Say 'connect Gmail' first.";
  }

  return [gmailSyncModeSentence(state), `Gmail alerts are ${state.reviewNotificationEnabled ? "on" : "off"}.`].join("\n");
}

function formatGmailConnectionStatusForChat(
  userId: string,
  connection: IntegrationConnection | undefined,
  rules: EmailSignalRule[],
  timezone: string,
  includeLink: boolean,
  lastSyncedAt?: Date
): string {
  const oauthUrl = gmailOAuthUrlForUser(userId);
  const activeRules = rules.filter((rule) => rule.status === "active");
  const ruleLines = activeRules.length > 0
    ? ["", "Active rules:", ...activeRules.map((rule, index) => `${index + 1}. ${rule.name} — review-first tracking`)]
    : [];

  if (!connection || connection.status === "archived") {
    return [
      "Gmail is not connected yet.",
      ...gmailOAuthActionLines("Connect Gmail here", oauthUrl),
      "Access is readonly. Alecto cannot send emails or change labels.",
      "After connecting, enable an email rule before any Gmail scan can run.",
      ...ruleLines
    ].join("\n");
  }

  const email = typeof connection.config.email === "string" && connection.config.email.trim()
    ? ` as ${connection.config.email.trim()}`
    : "";
  const lastSynced = lastSyncedAt ?? connection.lastSyncedAt;
  const lastSyncedLabel = lastSynced ? formatDateInTimezone(lastSynced, timezone) : "never";

  if (connection.status === "error") {
    return [
      gmailConnectionProblemLine(connection),
      ...gmailOAuthActionLines("Reconnect Gmail here", oauthUrl),
      `Last synced: ${lastSyncedLabel}.`,
      ...ruleLines
    ].join("\n");
  }

  if (connection.status === "paused") {
    return [
      `Gmail is paused${email}.`,
      oauthUrl && includeLink ? `Reconnect Gmail here if you want to refresh access:\n${oauthUrl}` : undefined,
      `Last synced: ${lastSyncedLabel}.`,
      "Gmail sync will not run while the connection is paused.",
      ...ruleLines
    ].filter(Boolean).join("\n");
  }

  return [
    `Gmail is connected${email}.`,
    "Access: readonly. Alecto cannot send emails or change labels.",
    oauthUrl && includeLink ? `Reconnect Gmail here if you need to refresh access:\n${oauthUrl}` : undefined,
    `Last synced: ${lastSyncedLabel}.`,
    activeRules.length === 0
      ? "No email tracking rules are active yet. You can say \"enable job search rule for Gmail\", \"enable work action rule for Gmail\", or \"track Endesa bills from Gmail\"."
      : undefined,
    ...ruleLines,
    "Sync only runs when you say \"sync Gmail\" or when scheduled Gmail checks are enabled."
  ].filter(Boolean).join("\n");
}

function noActiveGmailRulesForAgent(): string {
  return "Gmail is connected, but no email tracking rules are active. Say 'enable job search rule for Gmail', 'enable work action rule for Gmail', or 'track Endesa bills from Gmail'.";
}

function formatActiveGmailRuleLines(rules: EmailSignalRule[]): string[] {
  return rules.length > 0
    ? ["", "Active rules:", ...rules.map((rule, index) => `${index + 1}. ${rule.name} — review-first tracking`)]
    : [];
}

async function enableBuiltInGmailRuleForAgent(
  userId: string,
  kind: BuiltInGmailRuleKind
): Promise<{ changed: boolean; summary: string; rule?: EmailSignalRule }> {
  const adapterId = kind === "work_action" ? "work_action_email" : "job_search_email";
  const adapter = getEmailAdapterDefinition(adapterId);

  if (!adapter || adapter.status !== "available") {
    return { changed: false, summary: "That Gmail tracking rule is not available yet." };
  }

  const state = await buildGmailAutonomyState(userId);
  const connection = state.primaryConnection;

  if (!connection || state.authState === "disconnected") {
    return { changed: false, summary: "Gmail is not connected yet. Say 'connect Gmail' first." };
  }

  const title = builtInGmailRuleHumanTitle(kind);
  const existingActive = state.visibleRules.find((rule) => rule.adapterId === adapterId && rule.status === "active");
  if (existingActive) {
    return {
      changed: false,
      summary: [`${title} is already on.`, "", formatBuiltInGmailRuleEnabled(existingActive), gmailRuleEnableReconnectNote(userId, connection)]
        .filter(Boolean)
        .join("\n"),
      rule: existingActive
    };
  }

  if (kind === "job_search") {
    await archiveStaleJobSearchEmailRules(userId, connection.id);
  }

  const reusable = state.visibleRules
    .filter((rule) => rule.adapterId === adapterId)
    .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())[0];

  if (reusable) {
    const updated = await updateEmailSignalRule(userId, reusable.id, { status: "active" });
    if (!updated) {
      return { changed: false, summary: `I could not turn ${title} on. Nothing was changed.` };
    }

    return {
      changed: true,
      summary: [`${title} is back on.`, "", formatBuiltInGmailRuleEnabled(updated), gmailRuleEnableReconnectNote(userId, connection)]
        .filter(Boolean)
        .join("\n"),
      rule: updated
    };
  }

  const defaults = builtInGmailRuleDefaults(kind);
  const rule = await createEmailSignalRule(userId, {
    connectionId: connection.id,
    adapterId,
    name: defaults.name,
    query: adapter.defaultQuery ?? "",
    fetchStrategy: defaults.fetchStrategy,
    lookbackDays: defaults.lookbackDays,
    maxMessagesPerSync: defaults.maxMessagesPerSync,
    maxEventsPerSync: defaults.maxEventsPerSync,
    classifierMode: defaults.classifierMode,
    minAutoLogConfidence: defaults.minAutoLogConfidence,
    minReviewConfidence: defaults.minReviewConfidence,
    reviewBeforeLogging: defaults.reviewBeforeLogging,
    createdBy: "user"
  });

  return {
    changed: true,
    summary: [`${title} is on.`, "", formatBuiltInGmailRuleEnabled(rule), gmailRuleEnableReconnectNote(userId, connection)].filter(Boolean).join("\n"),
    rule
  };
}

function builtInGmailRuleHumanTitle(kind: BuiltInGmailRuleKind): string {
  return kind === "work_action" ? "Work-action email tracking" : "Job-search email tracking";
}

function builtInGmailRuleDefaults(kind: BuiltInGmailRuleKind) {
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

function formatBuiltInGmailRuleEnabled(rule: EmailSignalRule): string {
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
    "Sync now: say 'sync Gmail'."
  ].join("\n");
}

function gmailRuleEnableReconnectNote(userId: string, connection: IntegrationConnection): string | undefined {
  if (connection.status !== "error") {
    return undefined;
  }

  const oauthUrl = gmailOAuthUrlForUser(userId);
  return oauthUrl
    ? `${gmailConnectionProblemLine(connection)} Reconnect Gmail before sync can run:\n${oauthUrl}`
    : `${gmailConnectionProblemLine(connection)} Reconnect Gmail before sync can run. ${gmailOAuthMissingConfigMessage()}`;
}

function appendGmailSyncReconnectLink(userId: string, summary: string): string {
  const lower = summary.toLowerCase();
  const needsLink =
    lower.includes("reconnect gmail") ||
    lower.includes("connect gmail") ||
    lower.includes("authorization expired") ||
    lower.includes("token could not") ||
    lower.includes("encryption key is missing");

  if (!needsLink || summary.includes("accounts.google.com/o/oauth2")) {
    return summary;
  }

  const oauthUrl = gmailOAuthUrlForUser(userId);
  if (!oauthUrl) {
    return summary;
  }

  const label = lower.includes("not connected") ? "Connect Gmail here" : "Reconnect Gmail here";
  return [summary, "", ...gmailOAuthActionLines(label, oauthUrl)].filter((line) => line !== undefined).join("\n");
}

function gmailOAuthUrlForUser(userId: string): string | undefined {
  const config = gmailOAuthConfig();
  return config ? buildGmailOAuthUrl(userId, config) : undefined;
}

function gmailOAuthActionLines(label: string, oauthUrl: string | undefined): string[] {
  if (!oauthUrl) {
    return [gmailOAuthMissingConfigMessage()];
  }

  const config = gmailOAuthConfig();
  const warning = config ? gmailOAuthLocalhostCallbackWarning(config) : undefined;
  return [`${label}:\n${oauthUrl}`, ...(warning ? [warning] : [])];
}

function gmailConnectionProblemLine(connection: IntegrationConnection): string {
  const lower = (connection.lastError ?? "").toLowerCase();

  if (lower.includes("api") && lower.includes("disabled")) {
    return "Gmail API is disabled in Google Cloud project. Enable Gmail API and retry.";
  }

  if (lower.includes("encryption key") || lower.includes("alecto_secret_encryption_key")) {
    return "Gmail token encryption key is missing. Set ALECTO_SECRET_ENCRYPTION_KEY and restart.";
  }

  if (lower.includes("permission") || lower.includes("scope") || lower.includes("insufficient")) {
    return "Gmail permission error. Reconnect Gmail and approve Gmail readonly access.";
  }

  return "Gmail authorization is expired.";
}

function gmailReconnectNoteForNudge(userId: string, connection: IntegrationConnection | undefined): string | undefined {
  if (!gmailConnectionNeedsReconnect(connection)) {
    return undefined;
  }

  const oauthUrl = gmailOAuthUrlForUser(userId);
  const problem = gmailNudgeConnectionProblem(connection);
  return oauthUrl
    ? `${problem}, so Gmail alerts won't work until you connect or reconnect Gmail: ${oauthUrl}.`
    : `${problem}, so Gmail alerts won't work until Gmail OAuth is configured. ${gmailOAuthMissingConfigMessage()}`;
}

function gmailReconnectNoteAfterNudgeEnabled(userId: string, connection: IntegrationConnection | undefined): string | undefined {
  if (!gmailConnectionNeedsReconnect(connection)) {
    return undefined;
  }

  const oauthUrl = gmailOAuthUrlForUser(userId);
  const problem = gmailNudgeConnectionProblem(connection);
  return oauthUrl
    ? `${problem}. Gmail needs connecting or reconnecting before alerts can work:\n${oauthUrl}`
    : `${problem}. Gmail needs connecting or reconnecting before alerts can work. ${gmailOAuthMissingConfigMessage()}`;
}

function gmailConnectionNeedsReconnect(connection: IntegrationConnection | undefined): boolean {
  return !connection || connection.status === "error" || connection.status === "archived";
}

function gmailNudgeConnectionProblem(connection: IntegrationConnection | undefined): string {
  if (!connection || connection.status === "archived") {
    return "Gmail is not connected yet";
  }

  return gmailConnectionProblemLine(connection);
}

interface ProactiveSettingsChangeDescription {
  proposal: string;
  done: string;
}

interface ProactiveSettingsChangeRequest {
  morningBriefEnabled?: boolean;
  eveningCheckinEnabled?: boolean;
  gmailNudgeEnabled?: boolean;
  morningTimeMinutes?: number;
  eveningTimeMinutes?: number;
}

/**
 * Same shape as describeDailyLoopChanges below — compares a requested proactive-settings change
 * against the current settings and describes only the fields that would actually change, so
 * neither the pre-execution "You're about to..." nor the post-execution "Done — ..." phrasing
 * has to be derived from the other with string surgery. A combined "turn it on AND set the time"
 * request (e.g. "set up a morning brief at 9am") is deliberately described as ONE fused change
 * ("turn on the morning brief at 09:00"), not two separate ones, matching how the user actually
 * phrased a single request. A time-only change on a currently-off (and not being turned on)
 * moment gets an explicit "but X is still off" caveat, so the reply never implies delivery is
 * about to start just because the time changed.
 */
function describeProactiveSettingsChanges(current: NotificationSettings, request: ProactiveSettingsChangeRequest): ProactiveSettingsChangeDescription[] {
  const changes: ProactiveSettingsChangeDescription[] = [];

  changes.push(...describeMomentChange("the morning brief", current.morningBriefEnabled, request.morningBriefEnabled, current.morningTimeMinutes, request.morningTimeMinutes));
  changes.push(...describeMomentChange("the evening check-in", current.eveningCheckinEnabled, request.eveningCheckinEnabled, current.eveningTimeMinutes, request.eveningTimeMinutes));

  if (request.gmailNudgeEnabled !== undefined && request.gmailNudgeEnabled !== current.gmailNudgeEnabled) {
    changes.push(
      request.gmailNudgeEnabled
        ? { proposal: "turn on Gmail alerts", done: "Gmail alerts are now on" }
        : { proposal: "turn off Gmail alerts", done: "Gmail alerts are now off" }
    );
  }

  return changes;
}

// Maps the planner's natural-language style words to the profile's internal 1-5 scale — kept
// deliberately small (one gentle/soft point, the schema default, one firm point) rather than
// exposing the full 1-5 range to the LLM, which would invite it to guess an arbitrary number.
const OPERATOR_PROFILE_STYLE_SCALE: Record<"gentle" | "balanced" | "blunt" | "relaxed" | "strict", number> = {
  gentle: 2,
  relaxed: 2,
  balanced: 3,
  blunt: 5,
  strict: 5
};

interface OperatorProfileChangeRequest {
  directness?: number;
  motivationalStyle?: string;
  accountabilityStrictness?: number;
}

function describeOperatorProfileChanges(
  current: UserOperatingProfile,
  request: OperatorProfileChangeRequest
): ProactiveSettingsChangeDescription[] {
  const changes: ProactiveSettingsChangeDescription[] = [];

  if (request.directness !== undefined && request.directness !== current.directness) {
    const label = request.directness >= 5 ? "be more blunt and direct" : request.directness <= 2 ? "be gentler and more encouraging" : "use a balanced tone";
    changes.push({ proposal: label, done: `I'll ${label} with you from now on` });
  }
  if (request.motivationalStyle !== undefined && request.motivationalStyle !== current.motivationalStyle) {
    changes.push({ proposal: `use a "${request.motivationalStyle}" motivational style`, done: `motivational style is now "${request.motivationalStyle}"` });
  }
  if (request.accountabilityStrictness !== undefined && request.accountabilityStrictness !== current.accountabilityStrictness) {
    const label = request.accountabilityStrictness >= 5 ? "hold you to your commitments strictly" : request.accountabilityStrictness <= 2 ? "go easy on accountability" : "keep a balanced level of accountability";
    changes.push({ proposal: label, done: `I'll now ${label}` });
  }

  return changes;
}

function describeMomentChange(
  label: string,
  currentEnabled: boolean,
  requestedEnabled: boolean | undefined,
  currentTimeMinutes: number,
  requestedTimeMinutes: number | undefined
): ProactiveSettingsChangeDescription[] {
  const enabledChanging = requestedEnabled !== undefined && requestedEnabled !== currentEnabled;
  const timeChanging = requestedTimeMinutes !== undefined && requestedTimeMinutes !== currentTimeMinutes;

  if (!enabledChanging && !timeChanging) {
    return [];
  }

  if (enabledChanging && requestedEnabled && timeChanging) {
    const time = formatMinutesOfDay(requestedTimeMinutes!);
    return [{ proposal: `turn on ${label} at ${time}`, done: `${label} is now on at ${time}` }];
  }

  const changes: ProactiveSettingsChangeDescription[] = [];

  if (enabledChanging) {
    changes.push(
      requestedEnabled
        ? { proposal: `turn on ${label}`, done: `${label} is now on` }
        : { proposal: `turn off ${label}`, done: `${label} is now off` }
    );
  }

  if (timeChanging) {
    const time = formatMinutesOfDay(requestedTimeMinutes!);
    const resultingEnabled = requestedEnabled !== undefined ? requestedEnabled : currentEnabled;
    const caveat = resultingEnabled ? "" : `, but ${label} is still off`;
    changes.push({ proposal: `move ${label} time to ${time}`, done: `${label} time is now ${time}${caveat}` });
  }

  return changes;
}

function formatDailyLoopSettingsSummary(settings: NotificationSettings): string {
  return [
    "Daily loop settings:",
    `- Daily review: ${settings.dailyLoopEnabled ? "on" : "off"}`,
    `- Start-day message: ${formatMinutesOfDay(settings.morningTimeMinutes)} (${settings.timezone})`,
    `- Evening review: ${formatMinutesOfDay(settings.eveningTimeMinutes)} (${settings.timezone})`
  ].join("\n");
}

interface DailyLoopChangeDescription {
  proposal: string;
  done: string;
}

interface DailyLoopChangeRequest {
  enabled?: boolean;
  morningTimeMinutes?: number;
  eveningTimeMinutes?: number;
}

/**
 * Compares a requested daily-loop change against the current settings and describes only the
 * fields that would actually change — in both the pre-execution "You're about to..." phrasing
 * and the post-execution "Done — ..." phrasing, so neither has to be derived from the other
 * with fragile string surgery. Returns an empty array when the request wouldn't change
 * anything (already in that state).
 */
function describeDailyLoopChanges(current: NotificationSettings, request: DailyLoopChangeRequest): DailyLoopChangeDescription[] {
  const changes: DailyLoopChangeDescription[] = [];

  if (request.enabled !== undefined && request.enabled !== current.dailyLoopEnabled) {
    changes.push(
      request.enabled
        ? { proposal: "turn daily loop reminders on", done: "daily loop reminders are now on" }
        : { proposal: "turn off daily review reminders", done: "daily review reminders are now off" }
    );
  }

  if (request.morningTimeMinutes !== undefined && request.morningTimeMinutes !== current.morningTimeMinutes) {
    const time = formatMinutesOfDay(request.morningTimeMinutes);
    changes.push({ proposal: `move the daily loop's start-day message to ${time}`, done: `the daily loop's start-day message is now at ${time}` });
  }

  if (request.eveningTimeMinutes !== undefined && request.eveningTimeMinutes !== current.eveningTimeMinutes) {
    const time = formatMinutesOfDay(request.eveningTimeMinutes);
    changes.push({ proposal: `move the evening review to ${time}`, done: `the evening review is now at ${time}` });
  }

  return changes;
}

function nextWeekApplyOperation(planStartLocalDate: string, windowKind: PlanWindowKind, selections: NextWeekPlanSuggestion[]): ValidatedOperation {
  return {
    tool: "planning.next_week_apply",
    args: {
      planStartLocalDate,
      planWindowKind: windowKind,
      selections: selections.map(toPendingNextWeekPlanSuggestion)
    },
    status: "valid",
    requiresConfirmation: false
  };
}
