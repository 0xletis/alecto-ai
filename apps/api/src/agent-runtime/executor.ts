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
  createMemory,
  getActionItems,
  getActiveMemories,
  getEmailReviewItems,
  getEmailSignalRules,
  getOrCreateNotificationSettings,
  snoozeActionItem,
  updateEmailSignalRule,
  updateNotificationSettings,
  type ActionItem,
  type EmailReviewItem,
  type EmailSignalRule
} from "@operator-agent/db";
import { parseActionDueDate, type Goal, type NotificationSettings } from "@operator-agent/core";
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
import { createActionItemFromEmailReview, formatGmailReviewListForChat, gmailReviewChatLabel, rejectEmailReviewForUser } from "../email-reviews/email-review-service.js";
import { formatMinutesOfDay, parseTimeOfDayText } from "../operator/daily-loop-settings.js";
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
        const created = await createActionItem(userId, {
          source: "manual",
          title: args.title as string,
          description: args.notes as string | undefined,
          priority: (args.priority as ActionItem["priority"] | undefined) ?? "medium",
          dueAt: parsedDate?.dueAt ?? undefined
        });
        return {
          tool: operation.tool,
          status: "executed",
          summary: `Created task "${created.title}"${created.dueAt ? ` due ${created.dueAt.toDateString()}` : ""}.`,
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
        return {
          tool: operation.tool,
          status: "executed",
          summary: `Logged ${created.length} job application${created.length === 1 ? "" : "s"} sent.`,
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

      case "goal.list": {
        return {
          tool: operation.tool,
          status: "executed",
          summary: formatGoalListForChat(context.activeGoals),
          result: context.activeGoals
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

        const changes = describeProactiveSettingsChanges(settings, { morningBriefEnabled, eveningCheckinEnabled, gmailNudgeEnabled });

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
                args: { morningBriefEnabled, eveningCheckinEnabled, gmailNudgeEnabled },
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
        const before = await getOrCreateNotificationSettings(userId);

        const updated = await updateNotificationSettings(userId, { morningBriefEnabled, eveningCheckinEnabled, gmailNudgeEnabled });
        const changes = describeProactiveSettingsChanges(before, { morningBriefEnabled, eveningCheckinEnabled, gmailNudgeEnabled });

        return {
          tool: operation.tool,
          status: "executed",
          summary: changes.length > 0 ? `Done — ${changes.map((change) => change.done).join(" and ")}.` : "Done — nothing needed to change.",
          result: updated
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
 * Always ends with the same honest boundary: goal editing isn't wired through chat yet.
 */
function formatGoalListForChat(goals: Goal[]): string {
  if (goals.length === 0) {
    return "You don't have active goals set yet. Use /create_goal for now, or tell me what you want to work on and I can remember the context.";
  }

  const lines = ["Your active goals:"];
  goals.forEach((goal, index) => {
    lines.push(`${index + 1}. ${goal.title} — ${goal.category} — ${goal.priority}`);
    if (goal.why) {
      lines.push(`   Why: ${goal.why}`);
    }
  });
  lines.push("", "Goal editing through chat is not wired yet. Use /create_goal or tell me if you want me to remember context.");

  return lines.join("\n");
}

function formatProactiveSettingsSummary(settings: NotificationSettings): string {
  return [
    "Proactive messages:",
    `- Morning brief: ${settings.morningBriefEnabled ? "on" : "off"}`,
    `- Evening check-in: ${settings.eveningCheckinEnabled ? "on" : "off"}`,
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
}

/**
 * Same shape as describeDailyLoopChanges below — compares a requested proactive-settings change
 * against the current settings and describes only the fields that would actually change, so
 * neither the pre-execution "You're about to..." nor the post-execution "Done — ..." phrasing
 * has to be derived from the other with string surgery.
 */
function describeProactiveSettingsChanges(current: NotificationSettings, request: ProactiveSettingsChangeRequest): ProactiveSettingsChangeDescription[] {
  const changes: ProactiveSettingsChangeDescription[] = [];

  if (request.morningBriefEnabled !== undefined && request.morningBriefEnabled !== current.morningBriefEnabled) {
    changes.push(
      request.morningBriefEnabled
        ? { proposal: "turn on the morning brief", done: "the morning brief is now on" }
        : { proposal: "turn off the morning brief", done: "the morning brief is now off" }
    );
  }

  if (request.eveningCheckinEnabled !== undefined && request.eveningCheckinEnabled !== current.eveningCheckinEnabled) {
    changes.push(
      request.eveningCheckinEnabled
        ? { proposal: "turn on the evening check-in", done: "the evening check-in is now on" }
        : { proposal: "turn off the evening check-in", done: "the evening check-in is now off" }
    );
  }

  if (request.gmailNudgeEnabled !== undefined && request.gmailNudgeEnabled !== current.gmailNudgeEnabled) {
    changes.push(
      request.gmailNudgeEnabled
        ? { proposal: "turn on the Gmail nudge", done: "the Gmail nudge is now on" }
        : { proposal: "turn off the Gmail nudge", done: "the Gmail nudge is now off" }
    );
  }

  return changes;
}

function formatDailyLoopSettingsSummary(settings: NotificationSettings): string {
  return [
    "Daily loop settings:",
    `- Daily review: ${settings.dailyLoopEnabled ? "on" : "off"}`,
    `- Morning brief: ${formatMinutesOfDay(settings.morningTimeMinutes)} (${settings.timezone})`,
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
    changes.push({ proposal: `move the morning brief to ${time}`, done: `the morning brief is now at ${time}` });
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
