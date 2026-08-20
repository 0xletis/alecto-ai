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
  getActionItems,
  getActiveMemories,
  getEmailReviewItems,
  getEmailSignalRules,
  getEventsSince,
  getOrCreateNotificationSettings,
  getNotificationLog,
  hasNotificationLog,
  snoozeActionItem,
  updateEmailSignalRule,
  updateNotificationSettings,
  type ActionItem,
  type EmailReviewItem,
  type EmailSignalRule
} from "@operator-agent/db";
import {
  countEvidenceForMetric,
  CUSTOM_SIGNAL_EVENT_TYPE,
  describeGoalEvidenceMatch,
  EventTypeSchema,
  findGoalsForEventType,
  findGoalsForSignalKey,
  parseActionDueDate,
  proactiveOperatorAllowlistActiveFromEnv,
  proactiveOperatorAllowlistFromEnv,
  proactiveOperatorDeliveryEnabledFromEnv,
  resolveActiveGoalReference,
  type EventTypeId,
  type Goal,
  type GoalMetric,
  type NotificationSettings,
  type StoredEvent
} from "@operator-agent/core";
import { inferActionGoalLink } from "../utils/action-goal-link.js";
import type { ActionHygieneAction, NextWeekPlanSuggestion, PlanWindowKind, WeeklyReviewContext, WeeklyReviewDraft } from "../server-types.js";
import { actionHygieneVisibleActions, analyzeActionHygiene } from "../actions/hygiene-session.js";
import { applyActionHygieneBatchOperations, type ActionHygieneBatchOperation, type HygieneOperation } from "../actions/hygiene.js";
import { findEmailRulesByTarget, sortEmailRuleCandidates } from "../conversation/email-rule-selection.js";
import {
  formatGmailRuleUpdateProposal,
  gmailRuleOperationVerb,
  gmailRuleTargetStateLabel,
  isGmailRuleAlreadyInTargetState,
  type GmailRuleOperation
} from "../gmail/gmail-rule-management.js";
import { getVisibleGmailEmailRules } from "../gmail/gmail-rule-service.js";
import {
  approveEmailReviewForUser,
  createActionItemFromEmailReview,
  formatGmailReviewListForChat,
  gmailReviewChatLabel,
  rejectEmailReviewForUser
} from "../email-reviews/email-review-service.js";
import { formatMinutesOfDay, parseTimeOfDayText } from "../operator/daily-loop-settings.js";
import { formatProactiveDeliveryDiagnosis, getProactiveDeliveryStatus } from "../operator/proactive-eligibility.js";
import { MORNING_BRIEF_DEDUPE_KEY } from "../operator/proactive.js";
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
import { formatDateInTimezone } from "../utils/datetime.js";
import { getUserTimezone } from "../utils/user-timezone.js";
import type { AgentEntity, AgentPendingOperation, ContextBundle, ExecutedOperation, ValidatedOperation } from "./types.js";
import { findExistingCustomGmailRule, type HygieneApplySelectionArgs } from "./validator.js";

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
        const items = await getActionItems(userId, { status, limit: (args.limit as number | undefined) ?? 10 });
        return {
          tool: operation.tool,
          status: "executed",
          summary:
            items.length === 0
              ? "No matching action items."
              : `Found ${items.length} action item(s): ${items.map((item) => `"${item.title}"`).join(", ")}.`,
          result: items,
          entities: items.map(actionToEntity)
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
          summary: `Snoozed "${updated.title}" to ${updated.snoozedUntil?.toDateString()}.`,
          result: updated
        };
      }

      case "action.complete": {
        const updated = await completeActionItem(userId, args.actionId as string);
        if (!updated) return failed(operation.tool, "That task no longer exists or is archived.");
        return { tool: operation.tool, status: "executed", summary: `Completed "${updated.title}".`, result: updated };
      }

      case "action.archive": {
        const updated = await archiveActionItem(userId, args.actionId as string);
        if (!updated) return failed(operation.tool, "That task no longer exists.");
        return { tool: operation.tool, status: "executed", summary: `Archived "${updated.title}".`, result: updated };
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
        const eventType = args.eventType as string | undefined;
        const signalKey = args.signalKey as string | undefined;
        const goalRef = args.goalRef as string | undefined;
        const count = (args.count as number | undefined) ?? 1;
        const notes = args.notes as string | undefined;

        if (!eventType && !signalKey) {
          return failed(operation.tool, "I need either a known signal type or a custom signal key to log this — try describing it again.");
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
        const parsedEventType = eventType ? EventTypeSchema.safeParse(eventType) : undefined;
        if (eventType && !parsedEventType?.success) {
          return failed(operation.tool, `"${eventType}" isn't a real event type I can log — try describing what happened again.`);
        }
        const verifiedEventType: EventTypeId | undefined = parsedEventType?.success ? parsedEventType.data : undefined;

        if (signalKey && findGoalsForSignalKey(context.activeGoals, signalKey).length === 0) {
          return failed(operation.tool, `I don't have a "${signalKey}" signal set up for any of your active goals. Say "what am I tracking for X?" to see the real signals.`);
        }

        let matchedGoals = verifiedEventType ? findGoalsForEventType(context.activeGoals, verifiedEventType) : findGoalsForSignalKey(context.activeGoals, signalKey!);

        // goalRef only ever NARROWS which of the already-verified matchedGoals this evidence is
        // attributed to (for the reply's own honesty) — it can never make an otherwise-invalid
        // signal valid, so an unresolved/ambiguous goalRef still logs the (already-verified) event
        // rather than blocking it; only the display note becomes "your goal" instead of naming one.
        if (goalRef && matchedGoals.length > 1) {
          const resolution = resolveActiveGoalReference(goalRef, matchedGoals, { mostRecent: matchedGoals[0] });
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
          result: created
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
        const created = await createEvent(userId, {
          type: "custom.goal_progress_logged",
          source: "manual",
          confidence: 1,
          data: { label: args.label, value: args.value },
          evidence: [args.notes as string | undefined, message].filter(Boolean) as string[]
        });
        return {
          tool: operation.tool,
          status: "executed",
          summary: `Logged progress: ${args.label}${args.value ? ` (${args.value})` : ""}.`,
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
        const connection = context.gmailConnection;
        return {
          tool: operation.tool,
          status: "executed",
          summary: connection
            ? `Gmail is ${connection.status}. Last synced: ${connection.lastSyncedAt ? connection.lastSyncedAt.toDateString() : "never"}.`
            : "Gmail is not connected.",
          result: connection
        };
      }

      case "gmail.rule.list": {
        const rules = (await getEmailSignalRules(userId)).filter((rule) => rule.status === "active");
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

        const rule = await createEmailSignalRule(userId, {
          connectionId: connection.id,
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
        return {
          tool: operation.tool,
          status: "executed",
          summary: `${rule.name} tracking is on. New matches go to email review before anything is logged — never instant, never auto-logged.`,
          result: rule
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
        return {
          tool: operation.tool,
          status: "executed",
          summary: result.message,
          result: result.review,
          entities: remaining.map((item, index) => reviewToEntity(item, index + 1, context.gmailRules))
        };
      }

      case "gmail.review.to_action": {
        const reviewId = args.reviewId as string;
        const reviews = await getEmailReviewItems(userId, { status: "pending", limit: 50 });
        const review = reviews.find((item) => item.id === reviewId);
        if (!review) return failed(operation.tool, "That email review no longer exists or was already decided.");

        const { actionItem } = await createActionItemFromEmailReview(userId, review);
        await approveEmailReviewItem(userId, review.id, undefined, actionItem.id);
        // Same reasoning as gmail.review.reject above: keep the other still-pending reviews
        // visible alongside the newly created action, not just the action alone.
        const remaining = await getEmailReviewItems(userId, { status: "pending", limit: 10 });
        return {
          tool: operation.tool,
          status: "executed",
          summary: `Turned the email review into task "${actionItem.title}".`,
          result: actionItem,
          entities: [actionToEntity(actionItem), ...remaining.map((item, index) => reviewToEntity(item, index + 1, context.gmailRules))]
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
        const outcome = resolveGoalReferenceTargets(goalRef, context.activeGoals);

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
          result: targetGoals
        };
      }

      case "goal.create_propose": {
        const title = args.title as string;
        const category = args.category as string;
        const why = args.why as string | undefined;
        const successCriteria = args.successCriteria as string | undefined;
        const signals = (args.signals as GoalPlanSignal[] | undefined) ?? [];
        const checkIn = args.checkIn as GoalPlanCheckIn | undefined;
        const integrationHint = args.integrationHint as string | undefined;
        const firstActions = (args.firstActions as string[] | undefined) ?? [];

        if (signals.length === 0) {
          return failed(operation.tool, "I need at least one trackable signal to propose a plan for this goal.");
        }

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
        const signals = (args.signals as GoalPlanSignal[] | undefined) ?? [];
        const checkIn = args.checkIn as GoalPlanCheckIn | undefined;
        const firstActions = (args.firstActions as string[] | undefined) ?? [];

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
        const outcome = resolveGoalReferenceTargets(goalRef, context.activeGoals);

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
          result: outcome.goals
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
          return {
            tool: operation.tool,
            status: "executed",
            summary: `That's already how it's set.\n\n${formatProactiveSettingsSummary(settings)}`
          };
        }

        return {
          tool: operation.tool,
          status: "executed",
          summary: `You're about to ${changes.map((change) => change.proposal).join(" and ")}. Reply yes to confirm or cancel.`,
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

function actionToEntity(action: ActionItem): AgentEntity {
  return { type: "action", id: action.id, label: action.title };
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
 * Always ends with an honest boundary: EDITING an existing goal isn't wired through chat yet —
 * creating a NEW one is (goal.create_propose, docs/10-v3-readiness-audit.md §21).
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
  lines.push("", "Editing or deleting an existing goal through chat isn't wired yet. Use /create_goal, or tell me about a new goal and I can propose a plan for it.");

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
 * goal" right after creating one, via mostRecent — activeGoals is already newest-first) is
 * "matched". Two or more goals landing within the resolver's ambiguity margin is "ambiguous" —
 * never silently guessed. A goalRef naming nothing real is "no_match" — also never silently
 * widened back to every goal, unlike the old inferGoalLinkForAction-based fallback here.
 */
function resolveGoalReferenceTargets(goalRef: string | undefined, activeGoals: Goal[]): GoalReferenceOutcome {
  if (activeGoals.length === 0) {
    return { status: "no_match", goals: [] };
  }

  if (!goalRef || !goalRef.trim()) {
    return { status: "all", goals: activeGoals };
  }

  const resolution = resolveActiveGoalReference(goalRef, activeGoals, { mostRecent: activeGoals[0] });

  if (resolution.status === "matched" && resolution.goal) {
    return { status: "matched", goals: [resolution.goal] };
  }

  if (resolution.status === "ambiguous" && resolution.candidates) {
    return { status: "ambiguous", goals: resolution.candidates };
  }

  return { status: "no_match", goals: [] };
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

  if (input.successCriteria) {
    lines.push(`Target: ${input.successCriteria}`);
  }

  lines.push("Signals:", ...input.signals.map((signal) => `- ${signal.label}`));

  if (input.checkIn) {
    lines.push("Check-in:", `- ${input.checkIn.cadence}: "${input.checkIn.question}"`);
  }

  if (input.integrationHint) {
    lines.push("Integration:", `- ${input.integrationHint}`);
  }

  if (input.firstActions.length > 0) {
    lines.push("First actions:", ...input.firstActions.map((action) => `- ${action}`));
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
    "Proactive messages:",
    `- Morning brief: ${morning}`,
    `- Evening check-in: ${evening}`,
    `- Gmail nudge: ${settings.gmailNudgeEnabled ? "on" : "off"}`
  ].join("\n");
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
        ? { proposal: "turn on the Gmail nudge", done: "the Gmail nudge is now on" }
        : { proposal: "turn off the Gmail nudge", done: "the Gmail nudge is now off" }
    );
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
