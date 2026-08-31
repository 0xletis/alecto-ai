import {
  addGoalTrackedMetric,
  approveEmailReviewItem,
  archiveActionItem,
  archiveEmailSignalRule,
  archiveIntegrationConnection,
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
  getGoals,
  getIntegrationConnection,
  getIntegrationConnections,
  getMostRecentNotificationLog,
  getOrCreateNotificationSettings,
  getOrCreateUserOperatingProfile,
  getNotificationLog,
  getProactiveBriefPreferences,
  hasNotificationLog,
  pauseActiveEmailSignalRulesForConnection,
  rescheduleActionItem,
  selfHealDailyLoopEnabled,
  setGoalStatus,
  updateEmailSignalRule,
  updateIntegrationConnection,
  updateIntegrationConnectionConfig,
  updateNotificationSettings,
  updateUserOperatingProfile,
  upsertProactiveBriefPreference,
  type ActionItem,
  type EmailReviewItem,
  type EmailSignalRule,
  type IntegrationConnection
} from "@operator-agent/db";
import {
  buildOpenActionCommandFooter,
  countEvidenceForMetric,
  CUSTOM_SIGNAL_EVENT_TYPE,
  describeGoalEvidenceMatch,
  effectiveGmailSyncIntervalMinutes,
  ensureBookGoalProgressSignal,
  EventTypeSchema,
  findCompatibleProgressMetric,
  findGoalsForEventType,
  findGoalsForSignalKey,
  formatDueLabelForChat,
  formatFullLocalDateTime,
  getEmailAdapterDefinition,
  gmailScheduledSyncRuntimeFromEnv,
  goalHasOnlyCompletionSignals,
  isProgressShapedSignalText,
  parseActionDueDate,
  proactiveOperatorAllowlistActiveFromEnv,
  proactiveOperatorAllowlistFromEnv,
  proactiveOperatorDeliveryEnabledFromEnv,
  decryptSecretJson,
  isEncryptedSecretJsonEnvelope,
  readGmailAutonomyPreferences,
  resolveActiveGoalReference,
  resolveProactiveBriefPreference,
  RESUME_UP_TO_DATE_RE,
  RESUME_UPDATE_SUGGESTION_RE,
  writeGmailAutonomyPreferences,
  type EventTypeId,
  type Goal,
  type GoalMetric,
  type NotificationSettings,
  type ProactiveBriefPreference,
  type ProactiveBriefStyle,
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
import {
  buildGmailOAuthUrl,
  gmailOAuthConfig,
  gmailOAuthLocalhostCallbackWarning,
  gmailOAuthMissingConfigMessage,
  revokeGoogleOAuthToken
} from "../gmail/oauth.js";
import {
  buildGmailAutonomyState,
  gmailRecommendationKindForGoal,
  formatIntervalMinutes,
  gmailSyncModeSentence,
  resolveActiveGoalIdsForGmailRule,
  resolveGoalForBuiltInGmailRuleLinking,
  suggestGmailWatcherForGoal,
  type GmailRuleKind
} from "../conversation/gmail-autonomy.js";
import { archiveStaleJobSearchEmailRules, getVisibleGmailEmailRules } from "../gmail/gmail-rule-service.js";
import {
  approveEmailReviewForUser,
  createActionItemFromEmailReview,
  formatEmailReviewDetailsForContext,
  formatGmailReviewListForChat,
  gmailReviewChatLabel,
  humanEmailReviewEventLabel,
  rejectEmailReviewForUser
} from "../email-reviews/email-review-service.js";
import { formatMinutesOfDay, parseTimeOfDayText } from "../operator/daily-loop-settings.js";
import {
  formatEveningCheckinDeliveryDiagnosis,
  formatProactiveDeliveryDiagnosis,
  getEveningCheckinDeliveryStatus,
  getProactiveDeliveryStatus,
  nextScheduledMomentLabel,
  proactiveStatusBlockedClause
} from "../operator/proactive-eligibility.js";
import { pickBriefGoal } from "../operator/proactive-brief-llm.js";
import {
  assessTemporalHealth,
  EVENING_CHECKIN_DEDUPE_KEY,
  formatTemporalHealthLabel,
  minutesOfDayInTimezone,
  MORNING_BRIEF_DEDUPE_KEY,
  rankOpenActions,
  type TemporalHealth
} from "../operator/proactive.js";
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
import { addDaysToLocalDateString, formatDateInTimezone, formatLocalDateTime, parseOptionalNow, startOfLocalWeek } from "../utils/datetime.js";
import { getUserTimezone } from "../utils/user-timezone.js";
import { wasCapabilityProposalRecentlyDeferred } from "./conversation-session.js";
import type { AgentEntity, AgentPendingOperation, ContextBundle, ExecutedOperation, ValidatedOperation } from "./types.js";
import { findExistingCustomGmailRule, type HygieneApplySelectionArgs } from "./validator.js";
import { gmailSyncDebugForAgentRuntime, syncGmailForAgentRuntime } from "./services.js";

/**
 * fix/private-alpha-launch-hardening-flakes-and-pending-clarity: proactive.diagnose_morning_brief/
 * diagnose_evening_checkin previously always called `new Date()` directly, with no way for a test
 * to pin "now" — the ONLY other consumer of this exact time-window math (the /operator/proactive/
 * preview route) already accepts an optional injected `now` via its own `?now=` query param
 * (apps/api/src/routes/agent.ts, parseOptionalNow), precisely so it can be tested deterministically
 * without racing real wall-clock minute-of-day arithmetic near a UTC day boundary. Mirrors that
 * exact same pattern here, gated behind an env var only a test would ever set (never reachable from
 * a real chat message — the LLM planner's tool args never carry a raw "now"): unset in production,
 * so `new Date()` is the real, unaltered behavior every deployment actually gets.
 *
 * fix/private-alpha-conversation-kernel-context-routing (follow-up): renamed from
 * resolveDiagnosisNow and widened to the action.create/reschedule/snooze date-parsing call sites
 * too — those previously always called parseActionDueDate with no `now` at all, so a real reported
 * flake had "move it to tonight at 20:00" (and the deadline-tightening confirmation test) fail
 * whenever the suite happened to run after the target hour, since "tonight at 20:00" genuinely IS
 * in the past once real wall-clock time passes 20:00. The product rule itself (an explicit past
 * time is correctly refused) was never wrong — only the tests had no way to pin "now" before the
 * target time, exactly the same gap this function already existed to close for proactive checks.
 */
function resolveAgentRuntimeNow(): Date {
  return parseOptionalNow(process.env.AGENT_RUNTIME_TEST_NOW) ?? new Date();
}

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
        const status = (args.status as ActionItem["status"] | "all" | "active" | undefined) ?? "open";
        const limit = (args.limit as number | undefined) ?? 10;
        const overdueOnly = Boolean(args.overdueOnly);
        const when = args.when as "today" | "tomorrow" | "this_week" | "this_week_and_overdue" | undefined;
        const settings = await getOrCreateNotificationSettings(userId);
        // fix/private-alpha-conversation-kernel-context-routing (flake fix): same class of bug as
        // the action.reschedule/snooze/create date-parsing call sites above — this used to always
        // call `new Date()` directly, so the "today" window (actionMatchesWhenWindow) had no way
        // for a test to pin "now," making a test with a "due in 1 hour" fixture flake whenever the
        // suite happened to run within an hour of local midnight (the fixture's dueAt silently
        // rolled onto tomorrow's local date). Real production behavior is unaffected: the env var
        // is unset outside tests, so this still resolves to the real, unaltered current time.
        const now = resolveAgentRuntimeNow();

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
        // A date-scoped query ("actions for tomorrow") means something categorically different
        // from a status filter — a snoozed action IS the answer to "what's coming back tomorrow,"
        // even though it's invisible to a plain status:"open" list. `when` therefore always widens
        // the pool to open+snoozed regardless of whatever `status` the planner also sent, rather
        // than layering on top of it — private-alpha's real reported bug was exactly this: "do i
        // have actions for tomorrow?" silently ran the default open-only list and could never see
        // the very action that had just been moved there.
        // fix/private-alpha-live-action-and-coaching-regressions: "active" is the same open+snoozed
        // widening `when` already does, for a genuinely UNSCOPED "show me all my actions" request —
        // a real Telegram transcript found "show me all actions" answered as if nothing existed,
        // because the only status this tool understood for "everything actionable" was strict
        // "open," which hides anything already snoozed/deferred. Never includes archived/completed
        // — those still require asking for them explicitly (status "archived"/"completed"/"all").
        //
        // fix/private-alpha-remove-user-facing-action-snooze: "open" (including the plain default,
        // no status/when at all — the exact shape of a bare "show me my actions") now gets this
        // SAME widening. Alecto actions are commitments — open, completed, or archived, nothing
        // else — so a plain open-actions view must never come back empty just because an action
        // happens to carry the old "snoozed" status. Nothing NEW ever becomes "snoozed" anymore
        // (action.snooze is deprecated for user-facing goal actions), but real historical rows
        // created before this change still exist and must stay visible, not lost, until they're
        // naturally moved again (which now always resolves them back to "open"). An explicit
        // status:"snoozed"/"completed"/"archived"/"all" request still narrows normally below.
        const pool =
          when || status === "active" || status === "open"
            ? (await getActionItems(userId, { status: "all", limit: ACTION_LIST_POOL_CAP })).filter(
                (item) => item.status === "open" || item.status === "snoozed"
              )
            : await getActionItems(userId, { status, limit: ACTION_LIST_POOL_CAP });
        let realActions = pool
          .filter((item) => !isReminderCompanionAction(item))
          .filter((item) => !overdueOnly || (item.status === "open" && Boolean(item.dueAt) && item.dueAt! < now))
          .filter((item) => !when || actionMatchesWhenWindow(item, when, now, settings.timezone));
        // Only a date-scoped query reorders by date — the plain list's own existing order
        // (status, then dueAt, then most-recently-touched) is unrelated and untouched otherwise.
        if (when) {
          realActions = [...realActions].sort((a, b) => (actionEffectiveDate(a)?.getTime() ?? 0) - (actionEffectiveDate(b)?.getTime() ?? 0));
        }
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
            summary: `That's all ${items.length} ${status === "all" || status === "active" ? "" : `${status} `}action${items.length === 1 ? "" : "s"} — nothing more to show.`,
            result: items,
            entities: items.map((item, index) => actionToEntity(item, index + 1))
          };
        }

        const baseSummary = formatActionListForChat(items, realActions.length, status, overdueOnly, reminderByParentId, settings.timezone, when);

        // Similar-deferred-action cleanup (fix/private-alpha-deferred-action-dedupe-and-today-
        // coaching, task 2) — ONLY for a date-scoped query, where two near-identical actions both
        // landing on the same day is exactly the shape worth flagging (a plain "show me my
        // actions" can have several genuinely different open tasks; that's normal, not a
        // duplicate). A real Telegram smoke test found the OLD text-only version of this
        // suggestion ("Want me to help merge or archive one?") had nothing behind it — "merge
        // them yes" had no real proposal to confirm and fell through to an unrelated, confusing
        // reply. This now opens a REAL pending confirmation: keep the first, archive the second —
        // never a vague question with no mechanism, and never a silent merge either.
        let duplicateCleanupUpdate: ExecutedOperation["pendingOperationUpdate"];
        let summary = baseSummary;
        if (when) {
          const similarPair = findSimilarActionPair(items);
          if (similarPair) {
            const [keep, archiveTarget] = similarPair;
            // fix/private-alpha-live-action-and-coaching-regressions (Task 5): when the duplicate
            // being archived is itself linked to a critical goal, action.archive's own guard
            // (right above, in the "action.archive" case) would otherwise ask a SECOND "this is
            // linked to a critical goal, archive only this action?" confirmation after the user
            // already said yes once to THIS proposal — the same real mutation confirmed twice.
            // Disclosing the critical-goal link right here, in this single proposal, and planning
            // action.archive_all_apply directly (the same already-established "confirmed target
            // never changes, never touches the goal" tool the guard itself hands off to) means one
            // "yes" is enough. A DIRECT "archive it" request for a critical-goal-linked action —
            // never routed through this duplicate-cleanup proposal at all — still gets its own
            // single confirmation from action.archive's guard, completely unchanged.
            const linkedCriticalGoal = archiveTarget.goalId
              ? context.activeGoals.find((goal) => goal.id === archiveTarget.goalId && goal.priority === "critical")
              : undefined;
            const criticalNote = linkedCriticalGoal
              ? ` It's linked to your critical "${linkedCriticalGoal.title}" goal — this only removes the duplicate action, never the goal.`
              : "";
            summary = `${baseSummary}\n\nYou have two similar actions scheduled. Keep "${cleanedTitleForDateDisplay(keep.title)}" and archive the duplicate?${criticalNote}\n\nReply yes to confirm or cancel.`;
            duplicateCleanupUpdate = {
              topic: "action_duplicate_cleanup",
              summary: `keep "${keep.title}" and archive the duplicate "${archiveTarget.title}"`,
              operations: linkedCriticalGoal
                ? [
                    {
                      tool: "action.archive_all_apply",
                      args: { actionIds: [archiveTarget.id] },
                      status: "valid",
                      requiresConfirmation: false
                    }
                  ]
                : [
                    {
                      tool: "action.archive",
                      args: { actionId: archiveTarget.id },
                      status: "valid",
                      requiresConfirmation: false
                    }
                  ]
            };
          }
        }

        return {
          tool: operation.tool,
          status: "executed",
          summary,
          result: items,
          entities: items.map((item, index) => actionToEntity(item, index + 1)),
          ...(duplicateCleanupUpdate ? { pendingOperationUpdate: duplicateCleanupUpdate } : {})
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
        const title = args.title as string;
        // fix/private-alpha-action-temporal-coaching: a real audit found a title like "Apply to
        // 3 more remote Web3 roles today" could be created with NO dueAt at all whenever the
        // planner set the temporal word only in the title and forgot to also set dueText — the
        // title said "today" but the row had nothing to ever become overdue against. This is a
        // narrow, deliberately-safe fallback ONLY: dueText (an explicit, separate field) always
        // wins when present; the title is parsed with the exact same deterministic parser only
        // when dueText is absent, and only its OWN found match is ever used — never a guessed or
        // invented date. A title with no temporal words at all (the common case) still gets no
        // dueAt, exactly as before.
        const parsedDate = dueText ? parseActionDueDate(dueText, { now: resolveAgentRuntimeNow() }) : parseActionDueDate(title, { now: resolveAgentRuntimeNow() });
        // Task 3/4 (launch-readiness): an EXPLICIT dueText (as opposed to the best-effort title
        // scan used when no dueText is given at all) that fails to resolve to a real date — a
        // weekday/day-of-month contradiction ("Thursday 26 August" when the 26th is a Wednesday),
        // an already-past explicit time, or genuinely unparseable/unsupported phrasing — must
        // never be silently dropped in favor of creating the task with no due date at all. Only
        // triggers when dueText was actually provided; the title-scan fallback path (no explicit
        // date given) is untouched, since finding nothing there is the normal, expected case.
        if (dueText && !parsedDate.dueAt) {
          return failed(
            operation.tool,
            parsedDate.clarification ??
              `I couldn't understand the due date "${dueText}". Try something like "Friday", "26 August", or "next Wednesday".`
          );
        }
        const description = args.notes as string | undefined;
        const explicitGoalId = args.goalId as string | undefined;
        // Generic goal linkage (Goal Evidence Loop MVP, docs/10-v3-readiness-audit.md §20) —
        // the exact same keyword/confidence-scored matcher gmail.review.to_action already uses
        // for email-derived actions, now also applied to manually created ones, so "need to
        // follow up with recruiter tomorrow" links to an active job-search goal exactly the same
        // way a bill-paying action would link to an active bills goal. Never invents a link below
        // the matcher's own confidence threshold. An explicit goalId (only ever set internally, by
        // goal.recommend_next_action's own proposed action) skips the inference entirely — the
        // goal is already known for certain, no need to re-guess it from the title.
        const goalLink = explicitGoalId
          ? { goalId: explicitGoalId, goalSlug: undefined, matchedGoalTitle: context.activeGoals.find((goal) => goal.id === explicitGoalId)?.title }
          : await inferActionGoalLink(userId, title, description);
        // fix/private-alpha-live-action-and-coaching-regressions (Task 4): a real Telegram
        // transcript found "yes do so and show me my actions so i can verify" creating a SECOND
        // "Send 3 CVs" action — action.create has no confirmation gate of its own
        // (requiresConfirmation: false; the planner's own replyDraft alone decides whether a
        // turn READS like a question), so a real planner call on the first message can genuinely
        // create the row while its own reply still asks "want me to?", leaving the next turn's
        // planner with no way to know it already happened, and it re-plans the same create.
        // createActionItemIfNotExists (already used elsewhere for source-linked actions) is
        // reused here for manual ones too — an exact-title, same-source, still-open-or-snoozed
        // match is treated as the same task rather than a new one; never silently drops the
        // request, always reports the real existing task honestly instead.
        const { created, actionItem } = await createActionItemIfNotExists(userId, {
          source: "manual",
          title,
          description,
          priority: (args.priority as ActionItem["priority"] | undefined) ?? "medium",
          dueAt: parsedDate?.dueAt ?? undefined,
          goalId: goalLink.goalId ?? undefined,
          goalSlug: goalLink.goalSlug ?? undefined,
          goalTitleSnapshot: goalLink.matchedGoalTitle
        });
        // fix/private-alpha-local-date-focus-and-gmail-confirmation-state: actionItem.dueAt.
        // toDateString() formats in the JS runtime's OWN system timezone (UTC on this app's
        // actual host), never the user's real one — a real reported bug had a "today" action
        // confirmed as "due Tue Aug 25" when it was already Wed Aug 26 in the user's own
        // timezone. formatDueLabelForChat is the SAME already-timezone-aware, already-tested
        // "due today/tomorrow/Wed Aug 26" formatter action.list's own per-item line already uses
        // — reused here for the same value, not a second implementation.
        const dueSettings = actionItem.dueAt ? await getOrCreateNotificationSettings(userId) : undefined;
        const dueLabel = actionItem.dueAt && dueSettings ? ` ${formatDueLabelForChat(actionItem.dueAt, dueSettings.timezone)}` : "";
        if (!created) {
          return failed(operation.tool, `you already have "${actionItem.title}"${dueLabel} — I won't create a duplicate`);
        }
        return {
          tool: operation.tool,
          status: "executed",
          summary: `Created task "${actionItem.title}"${dueLabel}.${goalLink.matchedGoalTitle ? ` Linked to your "${goalLink.matchedGoalTitle}" goal.` : ""}`,
          result: actionItem,
          entities: [actionToEntity(actionItem)]
        };
      }

      case "action.snooze": {
        // fix/private-alpha-remove-user-facing-action-snooze: Alecto actions are commitments —
        // open, completed, or archived, nothing else. action.snooze is deprecated for user-facing
        // goal actions and removed from the planner's own tool catalog (tool-catalog.ts); this
        // case only remains as a defense-in-depth alias for any caller that somehow still
        // constructs one (a stale pending operation, a future regression, etc.). It now behaves
        // exactly like action.reschedule — updates dueAt, keeps the action OPEN and visible in
        // every normal list — instead of the old "snoozed" status that hid a real Telegram user's
        // moved action from "show me my actions" entirely (the exact reported bug this closes).
        const actionId = args.actionId as string;
        const untilText = args.untilText as string;
        const settings = await getOrCreateNotificationSettings(userId);
        const parsedDate = parseActionDueDate(untilText, {
          timezone: settings.timezone,
          now: resolveAgentRuntimeNow(),
          preferences: settings
        });
        if (!parsedDate.dueAt) {
          return failed(operation.tool, parsedDate.clarification ?? `Couldn't understand the new due time "${untilText}".`);
        }
        const action = await getActionItem(userId, actionId);
        if (!action || action.status === "archived") {
          return failed(operation.tool, "That task no longer exists or is archived.");
        }
        const updated = await rescheduleActionItem(userId, actionId, parsedDate.dueAt);
        if (!updated) {
          return failed(operation.tool, "That task no longer exists or is archived.");
        }
        const whenLabel = formatDueLabelForChat(parsedDate.dueAt, settings.timezone).replace(/^due /, "");
        const foundNote = operation.actionOutsideVisiblePage ? "Found it outside your last shown list (an exact title match). " : "";
        // Mirrors rescheduleActionItem's own isDeferral rule (packages/db) exactly, so the note
        // shown here always agrees with whether postponeCount was actually just incremented.
        const isDeferral = action.status === "snoozed" || (Boolean(action.dueAt) && parsedDate.dueAt.getTime() > action.dueAt!.getTime());
        const coachingNote = isDeferral ? postponeCoachingNote(updated.postponeCount) : "";
        // fix/private-alpha-temporal-action-copy-and-dedup: a real transcript found the old
        // "bring X back" reply saying '...bring "Apply to 3 more remote Web3 roles today" back
        // tomorrow' — the title's own stale "today" contradicting the "tomorrow" right next to
        // it. Same display-only cleanup as action.list's per-item line, never the stored title.
        return {
          tool: operation.tool,
          status: "executed",
          summary: `${foundNote}Done — moved "${cleanedTitleForDateDisplay(updated.title)}" to ${whenLabel}.${coachingNote}`,
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
        // completeActionItem now also treats "already completed" as a no-op (same
        // fraudulent-second-success fix as action.archive) — this can't tell the three
        // undefined cases apart, so the reply stays honestly broad rather than guessing which.
        if (!updated) return failed(operation.tool, "That task no longer exists, or is already archived or completed.");

        // Lightweight post-completion coaching (fix/private-alpha-action-command-ux): a bare
        // "Completed action." was purely transactional. Now: acknowledge it, connect it to its
        // goal if it has one, then either point at the next real open action for that goal or —
        // if none remain — offer to suggest one. Never invents evidence/progress numbers that
        // weren't already logged elsewhere, and never creates anything on its own; this is only
        // ever a question, answered on the user's own next turn like any other proposal.
        const foundNote = operation.actionOutsideVisiblePage ? "Found it outside your last shown list (an exact title match). " : "";
        const linkedGoal = updated.goalId ? context.activeGoals.find((goal) => goal.id === updated.goalId) : undefined;
        const goalNote = linkedGoal ? ` for your "${linkedGoal.title}" goal` : "";

        let followUp = "";
        if (linkedGoal) {
          const remainingOpen = context.openActions.filter(
            (action) => action.goalId === linkedGoal.id && action.id !== updated.id && action.status === "open" && !isReminderCompanionAction(action)
          );
          if (remainingOpen.length === 0) {
            followUp = " You have no open actions left. Want me to suggest the next action?";
          } else {
            const next = rankOpenActions(remainingOpen)[0]!;
            followUp = ` Next up: "${next.title}".`;
          }
        }

        return {
          tool: operation.tool,
          status: "executed",
          summary: `${foundNote}Nice — marked "${updated.title}" complete${goalNote}.${followUp}`,
          result: updated,
          // fix/private-alpha-action-state-consistency: a completed action is terminal — leaving
          // it in session.visibleEntities let a stale "done"/"complete it" bare-pronoun reference
          // resolve back to the SAME id on a later turn. See action.archive's own matching comment
          // right below for the full reasoning; removeVisibleEntities does a targeted removal, not
          // a wholesale replace, so the rest of a still-relevant numbered list stays intact.
          removedEntityIds: [updated.id]
        };
      }

      case "action.archive": {
        const actionIdToArchive = args.actionId as string;

        // fix/private-alpha-action-archive-targeting: a real live-trust bug found "archive it"
        // silently escalated into archiving a WHOLE critical goal instead of the one action. This
        // guard is the action-scoped counterpart of goal.archive_propose's own isCriticalArchive
        // check below — it protects an action linked to a critical goal with a confirmation too,
        // but the target NEVER changes: the confirmed operation (action.archive_all_apply with
        // exactly this one actionId) still only ever archives the action, never the goal. Reusing
        // action.archive_all_apply here (rather than a new tool) is the SAME established pattern
        // action.archive_all_propose already uses for its own multi-action confirmation.
        const targetForCriticalCheck = await getActionItem(userId, actionIdToArchive);
        if (targetForCriticalCheck && targetForCriticalCheck.status !== "archived" && targetForCriticalCheck.goalId) {
          const linkedGoal = context.activeGoals.find((goal) => goal.id === targetForCriticalCheck.goalId);
          if (linkedGoal && linkedGoal.priority === "critical") {
            return {
              // Reports as action.archive_all_propose (mutates: false in the catalog), NOT
              // action.archive (mutates: true) — nothing was actually archived on this turn, and
              // response-composer.ts/the debug envelope's mutationExecuted flag trusts a tool's
              // static `mutates` declaration alone, with no way to know this specific call of a
              // mutates:true tool chose to only propose. Reusing archive_all_propose's own real,
              // already-registered identity (rather than inventing a parallel one) keeps this
              // honest without a tool-catalog change.
              tool: "action.archive_all_propose",
              status: "executed",
              summary: `This action is linked to a critical goal. Archive only this action?\n1. ${cleanedTitleForDateDisplay(targetForCriticalCheck.title)}\nReply yes to confirm or cancel.`,
              pendingOperationUpdate: {
                topic: "action_archive_critical_link",
                summary: `archive "${targetForCriticalCheck.title}"`,
                operations: [
                  {
                    tool: "action.archive_all_apply",
                    args: { actionIds: [targetForCriticalCheck.id] },
                    status: "valid",
                    requiresConfirmation: false
                  }
                ]
              }
            };
          }
        }

        const updated = await archiveActionItem(userId, args.actionId as string);
        // archiveActionItem now itself distinguishes "doesn't exist" from "already archived" (both
        // return undefined) — this reply can't tell which occurred, so it uses the same honest,
        // slightly-broader phrasing action.complete/action.snooze/action.reschedule already use
        // for the identical ambiguity, rather than claiming "no longer exists" for an action that
        // is actually still there, just already archived.
        if (!updated) return failed(operation.tool, "That task no longer exists or is archived.");
        const foundNote = operation.actionOutsideVisiblePage ? "Found it outside your last shown list (an exact title match). " : "";
        // Deliberately never phrased anywhere near "done"/"complete" — archiving is dismissal,
        // not completion, and a real product rule exists specifically so these two never blur.
        return {
          tool: operation.tool,
          status: "executed",
          summary: `${foundNote}Archived "${updated.title}" — I'll stop treating it as active.`,
          result: updated,
          // fix/private-alpha-action-state-consistency: a real reported bug found a bare "archive
          // it"/"remove it" right after an archive resolving to the SAME now-archived action again
          // (session.visibleEntities was never pruned post-mutation) — combined with
          // archiveActionItem previously having no "already archived" guard at all, this produced
          // a fraudulent second "Archived ..." success reply for a mutation that never actually
          // happened a second time. Removing the id here means a later bare "it" with nothing else
          // visible correctly falls through to "which task do you mean? I don't have one in view
          // right now" instead of silently re-targeting stale state.
          removedEntityIds: [updated.id]
        };
      }

      case "action.archive_all_propose": {
        const explicitIds = args.actionIds as string[] | undefined;
        const scope = args.scope as "visible" | "all" | undefined;

        // fix/private-alpha-deferred-action-dedupe-and-today-coaching: a real transcript found
        // "merge them yes" (right after Alecto's OWN duplicate-cleanup CTA, about two SNOOZED
        // actions from a "tomorrow" list) answered "You don't have any open actions to archive" —
        // both id-based paths below filtered candidates to status "open" only, so a visible but
        // DEFERRED action could never be archived this way, even though action.archive (the
        // single-item tool) never had that restriction.
        //
        // fix/private-alpha-action-state-consistency: scope "all" used to stay open-only on
        // purpose (a bare "archive all my actions" was read as "all my ACTIVE ones," not
        // everything ever deferred) — a real transcript then showed exactly why that reading
        // fails in practice: "remove my actions" answered "you don't have any open or scheduled
        // actions to archive" while a real snoozed/deferred action for tomorrow still existed, the
        // very thing the reply text itself claimed to have checked. The updated product rule is
        // explicit: "remove/clear/archive/delete my actions" means every action the user could
        // still reasonably call theirs to deal with — open OR scheduled/deferred — never just
        // completed or already-archived history. All three scopes now agree on that same
        // open-or-snoozed definition of "your actions."
        let targets: ActionItem[];
        if (explicitIds && explicitIds.length > 0) {
          // Already-resolved real ids (either from runtime.ts's own multi-archive collapse of
          // explicit numbers like "archive 1 and 2", or a rare direct planner call) — re-fetch
          // fresh rather than trusting the caller's snapshot, so a since-archived/completed item
          // never gets re-listed in the confirmation as if it were still open.
          const items = await Promise.all(explicitIds.map((id) => getActionItem(userId, id)));
          targets = items.filter((item): item is ActionItem => item !== undefined && (item.status === "open" || item.status === "snoozed"));
        } else if (scope === "visible") {
          const visibleActionIds = context.session.visibleEntities.filter((entity) => entity.type === "action").map((entity) => entity.id);
          const items = await Promise.all(visibleActionIds.map((id) => getActionItem(userId, id)));
          targets = items.filter((item): item is ActionItem => item !== undefined && (item.status === "open" || item.status === "snoozed"));
        } else {
          // scope "all" (or omitted, defensively) — the FULL real open-AND-snoozed pool, not
          // context.openActions' own 20-item context-loader cap, so "archive all my actions" is
          // honest about how many actions actually exist, matching action.list's own
          // ACTION_LIST_POOL_CAP reasoning for the same "don't silently truncate what 'all' means"
          // problem. Fetched as "all" and filtered client-side (same shape action.list's own
          // `when` branch already uses) rather than two separate queries.
          const pool = await getActionItems(userId, { status: "all", limit: 500 });
          targets = pool.filter((item) => (item.status === "open" || item.status === "snoozed") && !isReminderCompanionAction(item));
        }

        if (targets.length === 0) {
          return { tool: operation.tool, status: "executed", summary: "You don't have any open or scheduled actions to archive." };
        }

        const settingsForList = await getOrCreateNotificationSettings(userId);
        const list = targets
          .map((item, i) => {
            const deferredNote = item.status === "snoozed" && item.snoozedUntil ? ` — ${formatDeferredLabelForChat(item.snoozedUntil, settingsForList.timezone)}` : "";
            return `${i + 1}. ${cleanedTitleForDateDisplay(item.title)}${deferredNote}`;
          })
          .join("\n");
        const countLabel = targets.length === 1 ? "this action" : `these ${targets.length} actions`;
        return {
          tool: operation.tool,
          status: "executed",
          summary: `Archive ${countLabel}?\n${list}\nReply yes to confirm or cancel.`,
          pendingOperationUpdate: {
            topic: "action_bulk_archive",
            summary: `archive ${targets.length} action${targets.length === 1 ? "" : "s"}`,
            operations: [
              {
                tool: "action.archive_all_apply",
                args: { actionIds: targets.map((item) => item.id) },
                status: "valid",
                requiresConfirmation: false
              }
            ]
          }
        };
      }

      case "action.archive_all_apply": {
        const actionIds = args.actionIds as string[];
        const archived: ActionItem[] = [];
        for (const id of actionIds) {
          const updated = await archiveActionItem(userId, id);
          if (updated) archived.push(updated);
        }
        return {
          tool: operation.tool,
          status: "executed",
          summary: archived.length > 0 ? `Archived ${archived.length} action${archived.length === 1 ? "" : "s"}.` : "Nothing was archived — those actions no longer exist.",
          result: archived,
          // fix/private-alpha-action-state-consistency: this used to set `entities` here, which
          // (via setVisibleEntities' wholesale replace) turned session.visibleEntities into ONLY
          // these now-archived, terminal items — the same staleness risk as action.archive's own
          // single-item case, just for every bulk-archived action at once. removedEntityIds prunes
          // them out of whatever was visible instead, so a later bare "it"/index reference can
          // never resolve back to something this operation just archived.
          removedEntityIds: actionIds
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
        const parsedReschedule = parseActionRescheduleDate(action, { dueText, timeText, timezone: settings.timezone });

        if (!parsedReschedule.dueAt) {
          return failed(operation.tool, parsedReschedule.clarification ?? "I couldn't understand the new due time.");
        }
        const parsedDate = parsedReschedule.dueAt;

        // fix/private-alpha-local-date-focus-and-gmail-confirmation-state: rescheduling to the
        // EXACT same instant it's already due at (a real reported shape — "move it to wed 26"
        // when it's already due Wed 26, e.g. because the user was just double-checking after a
        // parse failure) is honest, not a real change — say so plainly instead of a normal
        // "Action rescheduled" reply implying something actually moved. A genuine time change on
        // the same day (e.g. "move it to today at 3pm") still proceeds normally below.
        if (action.dueAt && parsedDate.getTime() === action.dueAt.getTime()) {
          return {
            tool: operation.tool,
            status: "executed",
            summary: `It's already scheduled for ${formatDueLabelForChat(action.dueAt, settings.timezone).replace(/^due /, "")}. I can change the time if you want.`,
            result: action,
            entities: [actionToEntity(action)]
          };
        }

        // fix/private-alpha-coach-first-response-routing: "if a mutation would make the deadline
        // stricter/earlier, require explicit confirmation" — tightening a deadline is a bigger
        // deal than pushing it later or pulling a deferred item forward from nothing, so it gets
        // its own real pending confirmation rather than applying silently, even for an otherwise-
        // explicit reschedule command. `[confirmed] ` is the exact prefix finalizeDeterministicConfirmation
        // (runtime.ts) always uses for the message it passes to a re-run confirmed operation — checked
        // here instead of a new schema field so the SAME action.reschedule case can safely re-run on
        // confirmation without asking the same question again indefinitely.
        const isConfirmedReplay = message.startsWith("[confirmed] ");
        if (!isConfirmedReplay && action.dueAt && parsedDate.getTime() < action.dueAt.getTime()) {
          const currentLabel = formatDueLabelForChat(action.dueAt, settings.timezone).replace(/^due /, "");
          const newLabel = formatDueLabelForChat(parsedDate, settings.timezone).replace(/^due /, "");
          return {
            tool: "action.reschedule_stricter_propose",
            status: "executed",
            summary: `That would move "${action.title}" EARLIER — from ${currentLabel} to ${newLabel}. Want me to actually tighten the deadline, or leave it as is?`,
            pendingOperationUpdate: {
              topic: "action_reschedule_stricter",
              summary: `move "${action.title}" earlier, to ${newLabel}`,
              operations: [
                {
                  tool: "action.reschedule",
                  args: { actionId: action.id, ...(dueText ? { dueText } : {}), ...(timeText ? { timeText } : {}) },
                  status: "valid",
                  requiresConfirmation: false
                }
              ]
            }
          };
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
        // fix/private-alpha-remove-user-facing-action-snooze: action.reschedule is now the ONLY
        // user-facing way to push a due date later (action.snooze no longer does this for normal
        // chat), so the repeated-postponement coaching note moves here too — same postponeCoachingNote
        // helper action.snooze's own defense-in-depth alias uses, only ever appended for a genuine
        // push-later (never a tightening/correction, which never reaches this far, or a plain
        // pull-forward, which isn't the "avoidance" pattern this coaching exists to notice).
        // Mirrors rescheduleActionItem's own isDeferral rule (packages/db) exactly, so the note
        // shown here always agrees with whether postponeCount was actually just incremented.
        const isDeferral = action.status === "snoozed" || (Boolean(action.dueAt) && parsedDate.getTime() > action.dueAt!.getTime());
        const coachingNote = isDeferral ? postponeCoachingNote(updated.postponeCount) : "";

        // fix/private-alpha-remove-user-facing-action-snooze: setVisibleEntities merges PER TYPE
        // (conversation-session.ts) — since a rescheduled action is still open, not terminal, it
        // stays referenceable, but naively returning just this one action entity here replaces
        // the ENTIRE numbered action list with it, wiping every sibling's index. A real reported
        // regression: "show my actions" (3 items) -> "move 2 to tomorrow" -> "archive 3" failed
        // with "I only showed 0 actions" because index 3 no longer existed anywhere. Every other
        // previously-visible action entity is preserved here, unchanged, alongside the updated one.
        const otherVisibleActionEntities = context.session.visibleEntities.filter(
          (entity) => entity.type === "action" && entity.id !== updated.id
        );
        const updatedIndex = context.session.visibleEntities.find((entity) => entity.type === "action" && entity.id === updated.id)?.index;

        return {
          tool: operation.tool,
          status: "executed",
          summary: `Action rescheduled: ${cleanedTitleForDateDisplay(updated.title)}\ndue: ${formatLocalDateTime(updated.dueAt, settings.timezone)}.${reminderLine}${coachingNote}`,
          result: updated,
          entities: [...otherVisibleActionEntities, actionToEntity(updated, updatedIndex), ...reminderUpdates.map(actionToEntity)]
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

        // fix/private-alpha-gmail-review-llm-instruction-routing addendum (Task 3) — a real
        // reported bug: "I sent 3 CVs today" said "logged" but the open action "Send 3 CVs" stayed
        // open forever, and the goal progress view never mentioned it either. Reconciled here,
        // deterministically, only against a real OPEN action whose title states its OWN concrete
        // target count ("Send N CVs"/"apply to N jobs") — never guessed for a title with no number,
        // never re-completes an already-completed/archived action (context.openActions excludes
        // both by construction), and only auto-completes on a confident count match/overshoot; a
        // partial count mentions what's left instead of completing anything, and more than one
        // matching open action asks rather than guessing which one this was for.
        const reconciliation = reconcileApplicationsSentWithOpenAction(count, context.openActions);
        let completedAction: ActionItem | undefined;
        if (reconciliation.kind === "complete") {
          completedAction = await completeActionItem(userId, reconciliation.action.id);
        }

        // Task 4 (coach after progress) — a short, optional, non-mutating closing line rather than
        // a sterile receipt. Deterministic (no second LLM call from inside a GROUND_TRUTH_ONLY
        // tool) — never creates anything itself, only ever asks.
        const coachingNote = completedAction || goalNote ? " Want me to line up another small job-search action for today?" : "";

        return {
          tool: operation.tool,
          status: "executed",
          summary: `Logged ${created.length} job application${created.length === 1 ? "" : "s"} sent.${goalNote ? ` ${goalNote}` : ""}${reconciliation.note}${coachingNote}`,
          result: created,
          entities: completedAction ? [actionToEntity(completedAction)] : undefined
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

        // fix/private-alpha-gmail-review-llm-instruction-routing addendum (Task 3/4) — a real-LLM
        // eval run found the planner sometimes reaches for this general tool instead of
        // event.log_job_applications for "sent N CVs today" (both are valid per its own catalog
        // guidance). Reconciliation/coaching must not depend on which of the two equally-legitimate
        // tools it happened to pick — see event.log_job_applications's own case for the full
        // rationale, reused verbatim here rather than duplicated.
        let completedAction: ActionItem | undefined;
        let reconciliationNote = "";
        let coachingNote = "";
        if (verifiedEventType === "career.application_sent") {
          const reconciliation = reconcileApplicationsSentWithOpenAction(created.length, context.openActions);
          if (reconciliation.kind === "complete") {
            completedAction = await completeActionItem(userId, reconciliation.action.id);
          }
          reconciliationNote = reconciliation.note;
          coachingNote = completedAction || goalNote ? " Want me to line up another small job-search action for today?" : "";
        }

        return {
          tool: operation.tool,
          status: "executed",
          summary: `Logged ${signalLabel}${notes ? ` (${notes})` : ""}.${goalNote ? ` ${goalNote}` : ""}${reconciliationNote}${coachingNote}`,
          result: created,
          entities: [...(matchedGoals[0] ? [goalToEntity(matchedGoals[0])] : []), ...(completedAction ? [actionToEntity(completedAction)] : [])]
        };
      }

      case "goal.add_tracked_signal_propose": {
        const goalId = args.goalId as string;
        const goalTitle = args.goalTitle as string;
        const eventType = args.eventType as string | undefined;
        const signalKey = args.signalKey as string | undefined;
        const label = args.label as string;
        const labelSingular = args.labelSingular as string | undefined;
        const reason = args.reason as string;

        const goal = context.activeGoals.find((candidate) => candidate.id === goalId);
        if (!goal) {
          return failed(operation.tool, "I couldn't find that goal anymore, so I can't add a tracked signal to it.");
        }

        const alreadyTracked = (goal.targetMetrics ?? []).some(
          (metric) => (eventType && metric.eventType === eventType) || (signalKey && metric.signalKey === signalKey)
        );
        if (alreadyTracked) {
          return {
            tool: operation.tool,
            status: "skipped",
            summary: `"${goal.title}" already tracks ${label}.`,
            result: goal
          };
        }

        return {
          tool: operation.tool,
          status: "executed",
          summary: `${reason}. "${goalTitle}" doesn't currently track ${label}. Want me to add it as a tracked signal?`,
          pendingOperationUpdate: {
            topic: "goal_tracked_signal",
            summary: `add ${label} as a tracked signal for "${goalTitle}"`,
            operations: [
              {
                tool: "goal.add_tracked_signal_apply",
                args: { goalId, goalTitle, eventType: eventType ?? null, signalKey: signalKey ?? null, label, labelSingular: labelSingular ?? null },
                status: "valid",
                requiresConfirmation: false
              }
            ]
          }
        };
      }

      case "goal.add_tracked_signal_apply": {
        const goalId = args.goalId as string;
        const goalTitle = args.goalTitle as string;
        const eventType = args.eventType as string | null;
        const signalKey = args.signalKey as string | null;
        const label = args.label as string;
        const labelSingular = args.labelSingular as string | null;

        const metric: GoalMetric = {
          key: signalKey ?? eventType ?? label,
          label,
          labelSingular: labelSingular ?? undefined,
          eventType: eventType ?? undefined,
          signalKey: signalKey ?? undefined,
          aggregation: "count",
          window: "weekly"
        };

        const updated = await addGoalTrackedMetric(userId, goalId, metric);
        if (!updated) {
          return failed(operation.tool, `"${goalTitle}" no longer exists, so I couldn't add that tracked signal.`);
        }

        return {
          tool: operation.tool,
          status: "executed",
          summary: `Done — "${updated.title}" now tracks ${label}.`,
          result: updated,
          entities: [goalToEntity(updated)]
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
        const summary = args.summary as string;
        // fix/private-alpha-goal-context-and-evening-coaching: the planner is now prompted to
        // ALWAYS save a durable goal-setup fact via memory.create (see planner.ts's own "Durable
        // goal-setup constraints" rule) — a real gpt-4o-mini eval run found it re-saving the exact
        // same already-remembered fact on nearly every later turn, even a plain "ok, thanks",
        // despite the prompt already telling it to check context.recentMemorySummaries first. This
        // deterministic backstop is the actual guarantee against an unbounded pile-up of duplicate
        // memory rows; the prompt guidance alone was not reliable enough here, same lesson as the
        // resume/CV veto right below.
        const existing = await getActiveMemories(userId);
        const duplicate = existing.find((memory) => titlesLookSimilar(memory.summary, summary));
        if (duplicate) {
          return { tool: operation.tool, status: "executed", summary: `Already remembered: ${duplicate.summary}`, result: duplicate };
        }

        const created = await createMemory(userId, {
          type: (args.type as never) ?? "note",
          summary,
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
        // Only offered when Gmail is genuinely connected (not disconnected/archived) — a
        // proposal to enable a rule makes no sense before there's even a connection to attach
        // it to; that case already gets its own "connect Gmail" instruction above.
        const proposal = connection && connection.status !== "archived" ? buildGmailRuleProposal(state) : undefined;
        // A real reported bug: Gmail help hijacked a pending action.create proposal's confirm
        // slot entirely. The line above is always safe to show (it's just text), but the
        // CONFIRMABLE side of the proposal must never install itself as a second pendingOperation
        // while a different one (an action confirmation, another Gmail rule proposal, anything)
        // is already active — only one pendingOperation can exist at a time, and the existing one
        // always wins. Informational-only in that case; the user can still ask again once free.
        const existingPending = context.session.pendingOperation;
        const canProposeRuleNow = !existingPending || existingPending.topic === "gmail_rule_proposal";
        return {
          tool: operation.tool,
          status: "executed",
          summary: formatGmailConnectionStatusForChat(
            userId,
            connection,
            state.activeRules,
            settings.timezone,
            args.includeLink === true,
            state.lastSyncedAt,
            proposal?.line,
            context.activeGoals,
            context.gmailReviews,
            state,
            context.gmailRules
          ),
          result: connection,
          ...(proposal?.pendingOperationUpdate && canProposeRuleNow ? { pendingOperationUpdate: proposal.pendingOperationUpdate } : {})
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

      // fix/private-alpha-gmail-account-switch-and-personalized-examples: no disconnect flow
      // existed anywhere before this branch — the only precedent was archiveIntegrationConnection
      // (a generic soft-delete used by a REST-only route), never wired into the chat/tool layer,
      // never revoking anything at Google, and never touching the connection's own rules (which
      // would otherwise sit there forever reporting "N active rules" against an account Alecto no
      // longer has permission to read). This proposes it — a real pending confirmation, never
      // applied silently — quoting the actual connected email so the user knows exactly what
      // they're disconnecting.
      case "gmail.disconnect_propose": {
        const state = await buildGmailAutonomyState(userId);
        if (!state.gmailConnected || !state.primaryConnection) {
          return {
            tool: operation.tool,
            status: "executed",
            summary: "Gmail isn't connected right now — nothing to disconnect.",
            result: state
          };
        }
        const emailSuffix = state.gmailAccount ? ` as ${state.gmailAccount}` : "";
        return {
          tool: operation.tool,
          status: "executed",
          summary: `You're currently connected${emailSuffix}. Disconnect it? I'll stop syncing this account. Historical logged progress and reviews stay in your history.`,
          result: state,
          pendingOperationUpdate: {
            topic: "gmail_disconnect",
            summary: `disconnect Gmail${emailSuffix}`,
            operations: [
              {
                tool: "gmail.disconnect_apply",
                args: { connectionId: state.primaryConnection.id },
                status: "valid",
                requiresConfirmation: false
              }
            ]
          }
        };
      }

      case "gmail.disconnect_apply": {
        const connectionId = args.connectionId as string;
        const connection = await getIntegrationConnection(userId, connectionId);
        if (!connection) {
          return failed(operation.tool, "That Gmail connection no longer exists.");
        }
        // Best-effort — a disconnect must always succeed locally even if Google's own revoke
        // endpoint is unreachable or the token was already stale; see revokeGoogleOAuthToken's
        // own doc comment. Never surfaced as a failure to the user either way.
        await bestEffortRevokeGmailConnectionToken(connection);
        const archived = await archiveIntegrationConnection(userId, connectionId);
        if (!archived) {
          return failed(operation.tool, "That Gmail connection no longer exists.");
        }
        // Stops every rule still watching through this connection from counting as "active" —
        // never deletes them (archiveEmailSignalRule is a different, harsher operation this
        // deliberately does NOT call) and never touches a single historical event/review row.
        const pausedCount = await pauseActiveEmailSignalRulesForConnection(userId, connectionId);
        const emailSuffix = typeof connection.config.email === "string" && connection.config.email.trim() ? ` (${connection.config.email.trim()})` : "";
        const watcherNote = pausedCount > 0 ? ` and paused ${pausedCount} watcher${pausedCount === 1 ? "" : "s"} that were using it` : "";
        return {
          tool: operation.tool,
          status: "executed",
          summary: `Gmail disconnected${emailSuffix}. I've stopped syncing this account${watcherNote}. Your historical logged progress and reviews are still in your history. Say "connect Gmail" any time to reconnect.`,
          result: archived
        };
      }

      // A genuine account SWITCH — different from a plain disconnect in exactly one way: it never
      // pauses the connection's active rules, so the existing OAuth-callback reconnect logic
      // (preserveActiveGmailRulesForOAuthReconnect, apps/api/src/server.ts) can carry them forward
      // onto the new connection once the user finishes the new OAuth round-trip. If Gmail isn't
      // connected at all yet, there's nothing to disconnect first — this just hands back the
      // connect link directly, no confirmation needed.
      case "gmail.switch_account_propose": {
        const state = await buildGmailAutonomyState(userId);
        if (!state.gmailConnected || !state.primaryConnection) {
          const config = gmailOAuthConfig();
          if (!config) {
            return failed(operation.tool, gmailOAuthMissingConfigMessage());
          }
          const url = buildGmailOAuthUrl(userId, config);
          const warning = gmailOAuthLocalhostCallbackWarning(config);
          return {
            tool: operation.tool,
            status: "executed",
            summary: `Gmail isn't connected yet — here's the connect link: ${url}${warning ? ` ${warning}` : ""} Access is readonly — I can't send emails or change labels.`,
            result: state
          };
        }
        const emailSuffix = state.gmailAccount ? ` as ${state.gmailAccount}` : "";
        return {
          tool: operation.tool,
          status: "executed",
          summary: `You're currently connected${emailSuffix}. To use a different account, I'll disconnect this one first, then you can connect the new Gmail account. Historical progress stays. Continue?`,
          result: state,
          pendingOperationUpdate: {
            topic: "gmail_switch_account",
            summary: `switch Gmail account (currently${emailSuffix})`,
            operations: [
              {
                tool: "gmail.switch_account_apply",
                args: { connectionId: state.primaryConnection.id },
                status: "valid",
                requiresConfirmation: false
              }
            ]
          }
        };
      }

      case "gmail.switch_account_apply": {
        const connectionId = args.connectionId as string;
        const connection = await getIntegrationConnection(userId, connectionId);
        if (!connection) {
          return failed(operation.tool, "That Gmail connection no longer exists.");
        }
        await bestEffortRevokeGmailConnectionToken(connection);
        // Deliberately "paused," not "archived" — preserveActiveGmailRulesForOAuthReconnect (the
        // existing relink logic the new OAuth callback runs below) only ever considers NON-archived
        // connections as candidates to carry active rules FROM, so archiving here would silently
        // strand every watcher on this account instead of carrying it forward. "Paused" already
        // means "not connected, sync will never run" everywhere gmail.status/gmail.sync/the
        // worker's own eligibility check look — the safety property (old account never syncs
        // again) holds exactly the same either way.
        const paused = await updateIntegrationConnection(userId, connectionId, { status: "paused" });
        if (!paused) {
          return failed(operation.tool, "That Gmail connection no longer exists.");
        }
        const config = gmailOAuthConfig();
        if (!config) {
          return {
            tool: operation.tool,
            status: "executed",
            summary: "Old Gmail account disconnected. Gmail OAuth isn't configured right now, so I can't give you a connect link yet — set it up and try again.",
            result: paused
          };
        }
        const url = buildGmailOAuthUrl(userId, config);
        const warning = gmailOAuthLocalhostCallbackWarning(config);
        return {
          tool: operation.tool,
          status: "executed",
          summary: `Old Gmail account disconnected. Connect the new one here: ${url}${warning ? ` ${warning}` : ""} Your existing goal watchers will pick up the new account automatically once it's connected. Access is readonly — I can't send emails or change labels.`,
          result: paused
        };
      }

      case "gmail.rule.list": {
        // Task 7 (refactor/private-alpha-goal-driven-gmail-operator): the ADVANCED view — real
        // rule-level detail (domain, exact tracking policy, notifyPolicy, linked goal) — only ever
        // shown on an explicit ask ('show Gmail rules', 'what are you watching in Gmail?'). Normal
        // 'gmail status' stays goal-first (formatGmailConnectionStatusForChat); this is the one
        // place rule/notifyPolicy terminology is expected and appropriate.
        const rules = (await buildGmailAutonomyState(userId)).activeRules;
        const summary =
          rules.length === 0
            ? "No active Gmail rules."
            : `Active Gmail rules:\n${rules
                .map((rule, index) => {
                  const linkedGoal = resolveLinkedGoalForDisplay(rule, context.activeGoals);
                  // Only worth a separate "watches X" clause when it says something the rule's
                  // own name doesn't already — a custom rule with no real description just falls
                  // back to repeating its own name (gmailRuleWatchSummary), which would otherwise
                  // show up twice on the same line.
                  const watchSummary = gmailRuleWatchSummary(rule);
                  return [
                    `${index + 1}. ${rule.name}`,
                    rule.domain ? ` (${rule.domain})` : "",
                    ` — ${gmailRuleTrackingPolicyLabel(rule)}`,
                    ` — notifications ${rule.notifyPolicy === "notify" ? "on" : rule.notifyPolicy === "silent" ? "off" : "high-priority only"}`,
                    linkedGoal ? ` — linked to "${linkedGoal.title}"` : " — not linked to a goal",
                    watchSummary !== rule.name ? ` — watches ${watchSummary}` : ""
                  ].join("");
                })
                .join("\n")}`;
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
        const description = args.description as string | undefined;
        const domain = args.domain as string | undefined;

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
          domain,
          description,
          notifyPolicy: "review_only",
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
        const result = await enableBuiltInGmailRuleForAgent(
          userId,
          args.kind as BuiltInGmailRuleKind,
          context.activeGoals,
          resolveCurrentFocusGoal(context)?.id
        );
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
        let matches = sortEmailRuleCandidates(findEmailRulesByTarget(rules, ref));

        // refactor/private-alpha-goal-driven-gmail-operator: "stop using Gmail for my job goal" —
        // the user names a GOAL, not a rule, which findEmailRulesByTarget's name/query text match
        // can't resolve on its own. Falls back to strict goal resolution, then the rule(s) linked
        // to that goal — never guesses among multiple linked rules or multiple goal candidates.
        if (matches.length === 0) {
          const goalOutcome = resolveGoalForLifecycleAction(ref, context.activeGoals, resolveCurrentFocusGoal(context));
          if (goalOutcome.status === "matched") {
            const linkedGoal = goalOutcome.goals[0];
            matches = sortEmailRuleCandidates(rules.filter((rule) => rule.goalId === linkedGoal.id));
          } else if (goalOutcome.status === "ambiguous") {
            return {
              tool: operation.tool,
              status: "executed",
              summary: describeAmbiguousGoalChoice(goalOutcome.goals),
              result: goalOutcome.goals
            };
          }
        }

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
            : gmailOperation === "mute" || gmailOperation === "unmute"
              ? await updateEmailSignalRule(userId, ruleId, { notifyPolicy: gmailOperation === "mute" ? "review_only" : "notify" })
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

      case "gmail.goal_watcher.propose_enable": {
        const goalRef = args.goalRef as string | undefined;
        const goalOutcome = resolveGoalForLifecycleAction(goalRef, context.activeGoals, resolveCurrentFocusGoal(context));

        if (goalOutcome.status === "ambiguous") {
          return {
            tool: operation.tool,
            status: "executed",
            summary: describeAmbiguousGoalChoice(goalOutcome.goals),
            result: goalOutcome.goals
          };
        }

        if (goalOutcome.status === "no_match") {
          return {
            tool: operation.tool,
            status: "executed",
            summary: goalRef
              ? `I don't see an active goal matching "${goalRef}", so I can't set up Gmail for it.`
              : "I need to know which goal this is for — which one do you mean?"
          };
        }

        const goal = goalOutcome.goals[0];
        const suggestion = suggestGmailWatcherForGoal(goal);

        if (!suggestion) {
          return {
            tool: operation.tool,
            status: "executed",
            summary: `I don't see an obvious email signal for "${goal.title}" — if there's something specific you'd like me to watch for in Gmail for this, tell me and I'll set it up.`
          };
        }

        const connection = context.gmailConnection;
        if (!connection || connection.status !== "active") {
          const oauthUrl = gmailOAuthUrlForUser(userId);
          return {
            tool: operation.tool,
            status: "executed",
            summary: [
              `I can use Gmail readonly for "${goal.title}" to watch for ${suggestion.watchSummary}, but Gmail isn't connected yet.`,
              ...gmailOAuthActionLines("Connect Gmail here", oauthUrl),
              "Once it's connected, ask again and I'll set this up."
            ].join("\n")
          };
        }

        // Already covered — either an explicit link, or (for the two built-ins) the same
        // single-unambiguous-candidate read-time fallback resolveActiveGoalIdsForGmailRule uses
        // everywhere else, so this never proposes a duplicate watcher for a goal a built-in rule
        // already implicitly covers.
        const alreadyCovered = context.gmailRules
          .filter((rule) => rule.status === "active")
          .find((rule) => rule.goalId === goal.id || resolveActiveGoalIdsForGmailRule(rule, context.activeGoals).has(goal.id));

        if (alreadyCovered) {
          return {
            tool: operation.tool,
            status: "executed",
            summary: `I'm already using Gmail for "${goal.title}" (${alreadyCovered.name}). Say "what are you watching in Gmail?" to see the details.`,
            entities: [gmailRuleToEntity(alreadyCovered)]
          };
        }

        return {
          tool: operation.tool,
          status: "executed",
          summary: `I can use Gmail readonly for "${goal.title}" to watch for ${suggestion.watchSummary}. I won't send emails or change labels. Want me to enable that?`,
          pendingOperationUpdate: {
            topic: "gmail_goal_watcher",
            summary: `enable Gmail support for "${goal.title}"`,
            operations: [
              {
                tool: "gmail.goal_watcher.apply_enable",
                args: {
                  goalId: goal.id,
                  goalTitle: goal.title,
                  domain: suggestion.domain,
                  label: suggestion.label,
                  description: suggestion.description,
                  builtInKind: suggestion.builtInKind ?? null
                },
                status: "valid",
                requiresConfirmation: false
              }
            ]
          }
        };
      }

      case "gmail.goal_watcher.apply_enable": {
        const goalId = args.goalId as string;
        const goalTitle = args.goalTitle as string;
        const domain = args.domain as string;
        const label = args.label as string;
        const description = args.description as string;
        const builtInKind = args.builtInKind as "job_search" | "work_action" | null;

        const connection = context.gmailConnection;
        if (!connection || connection.status !== "active") {
          return failed(operation.tool, "Gmail is not connected anymore, so I can't enable this.");
        }

        if (builtInKind) {
          const result = await enableBuiltInGmailRuleForAgent(userId, builtInKind, context.activeGoals, goalId);
          return {
            tool: operation.tool,
            status: result.changed ? "executed" : "skipped",
            summary: result.changed
              ? `Done — I'm now using Gmail readonly for "${goalTitle}". Matches go to review first (or auto-log for the clearest ones); I'll surface anything relevant.`
              : result.summary,
            result: result.rule
          };
        }

        const existing = findExistingCustomGmailRule(await getEmailSignalRules(userId), label);
        if (existing?.status === "active") {
          return {
            tool: operation.tool,
            status: "skipped",
            summary: `I'm already using Gmail for "${goalTitle}" (${existing.name}).`,
            result: existing
          };
        }

        const rule = await createEmailSignalRule(userId, {
          connectionId: connection.id,
          goalId,
          adapterId: "custom_email_review",
          name: label,
          query: label,
          fetchStrategy: "query",
          lookbackDays: 30,
          maxMessagesPerSync: 25,
          maxEventsPerSync: 5,
          classifierMode: "rules",
          minAutoLogConfidence: 1,
          minReviewConfidence: 0.65,
          reviewBeforeLogging: true,
          domain,
          description,
          notifyPolicy: "review_only",
          createdBy: "user"
        });

        return {
          tool: operation.tool,
          status: "executed",
          summary: `Done — I'm now using Gmail readonly for "${goalTitle}", watching for ${description} Matches go to review first — I'll never send email or change labels.`,
          result: rule,
          entities: [gmailRuleToEntity(rule)]
        };
      }

      case "gmail.review.list": {
        const status = (args.status as EmailReviewItem["status"] | "all" | undefined) ?? "pending";
        const items = await getEmailReviewItems(userId, { status, limit: (args.limit as number | undefined) ?? 10 });
        const timezone = await getUserTimezone(userId);
        return {
          tool: operation.tool,
          status: "executed",
          summary: formatGmailReviewListForChat(items, context.gmailRules, context.activeGoals, timezone),
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

        // Task 4 (refactor/private-alpha-goal-driven-gmail-operator — smart goal evolution): a
        // real event was just logged for a goal-linked rule — if its signal isn't among the
        // goal's OWN declared targetMetrics yet, offer to add it as a tracked signal, the same
        // chained-confirmation mechanism goal.create_apply's dailyCoachingInterest/Gmail offers
        // already use. Never silently changes the goal — only ever offered, and only when the
        // signal genuinely isn't tracked yet.
        const evolutionOffer = buildGoalTrackedSignalEvolutionOffer(result.event, result.emailReview, context);

        return {
          tool: operation.tool,
          status: "executed",
          summary: evolutionOffer ? `${result.message}\n\n${evolutionOffer.summary}` : result.message,
          result: { emailReview: result.emailReview, event: result.event, actionItem: result.actionItem },
          entities,
          ...(evolutionOffer?.pendingOperationUpdate ? { pendingOperationUpdate: evolutionOffer.pendingOperationUpdate } : {})
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

      case "goal.recommend_next_action": {
        const goalRef = args.goalRef as string | undefined;
        const recommendation = args.recommendation as string;
        const proposedAction = args.proposedAction as string | undefined;

        const outcome = resolveGoalForRecommendation(goalRef, context.activeGoals, resolveCurrentFocusGoal(context));

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

        const goal = outcome.goals[0];
        const timezone = await getUserTimezone(userId);
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        const recentEvents = await getEventsSince(userId, sevenDaysAgo);
        const todayLocalDate = formatDateInTimezone(new Date(), timezone);
        const todayEvents = recentEvents.filter((event) => formatDateInTimezone(event.timestamp, timezone) === todayLocalDate);

        const metrics = goal.targetMetrics ?? [];
        const weekCounts = metrics.map((metric) => ({ metric, count: countEvidenceForMetric(metric, recentEvents) })).filter((entry) => entry.count > 0);
        const todayCounts = metrics.map((metric) => ({ metric, count: countEvidenceForMetric(metric, todayEvents) })).filter((entry) => entry.count > 0);

        const linkedOpenActions = rankOpenActions(context.openActions.filter((action) => action.goalId === goal.id && action.status === "open"));
        // fix/private-alpha-action-temporal-coaching: a real transcript found "what should I do
        // next?" right after moving "Apply to 3 more remote Web3 roles" to tomorrow proposing a
        // near-duplicate ("Apply to 3 more remote Web3 roles today") — proposedAction is LLM-
        // authored and the planner has no deterministic guarantee of checking deferred actions
        // itself, so this is the same kind of ground-truth veto linkedOpenActions already is for
        // open ones, just for snoozed ones. Only vetoes when the proposal is actually SIMILAR to
        // something already deferred — a genuinely different complementary task (e.g. "shortlist
        // 10 roles") still opens a real confirmation normally below.
        const linkedDeferredActions = context.deferredActions.filter((action) => action.goalId === goal.id);
        const similarDeferred =
          proposedAction && proposedAction.trim()
            ? linkedDeferredActions.find((action) => titlesLookSimilar(action.title, proposedAction))
            : undefined;

        const lines = [`"${goal.title}":`];
        if (weekCounts.length > 0) {
          lines.push(`This week: ${weekCounts.map((entry) => `${entry.count} ${countLabel(entry.metric, entry.count)}`).join(", ")}.`);
        }
        if (todayCounts.length > 0) {
          lines.push(`Today: ${todayCounts.map((entry) => `${entry.count} ${countLabel(entry.metric, entry.count)}`).join(", ")}.`);
        } else if (weekCounts.length === 0) {
          lines.push("No logged progress in the last 7 days.");
        }

        lines.push("", recommendation.trim());

        // Recommending an EXISTING open action always wins over proposing a new one — the
        // deterministic guard against ever duplicating a task the user already has open, no
        // matter what the planner set in proposedAction. Only when nothing is already open does a
        // genuinely new action (if any) get proposed, and even then only with a real confirmation.
        let pendingOperationUpdate: ExecutedOperation["pendingOperationUpdate"];
        // fix/private-alpha-action-temporal-coaching: an OVERDUE linked action outranks a merely
        // "existing open" one — the real reported concern was that a stale/overdue action just
        // sat there worded like any other open task, never flagged, while the coach kept talking
        // about creating something new. Never invents "overdue" from vibes — assessTemporalHealth
        // is the exact same grounded dueAt-vs-now (or createdAt-staleness) judgment action.list's
        // own per-item line uses, so the two surfaces can never disagree about what's overdue.
        const overdueLinked = linkedOpenActions
          .map((action) => ({ action, health: assessTemporalHealth(action, new Date(), timezone) }))
          .filter((entry): entry is { action: ActionItem; health: Extract<TemporalHealth, { kind: "overdue" }> } => entry.health.kind === "overdue")
          .sort((a, b) => b.health.daysOverdue - a.health.daysOverdue)[0];

        if (overdueLinked) {
          const { action: overdueAction, health } = overdueLinked;
          const label = formatTemporalHealthLabel(health)!;
          // First miss (1 day overdue): an honest, non-judgmental mention plus a shrink offer —
          // no challenge question yet, real life runs a day behind sometimes. 2-3 days: a genuine
          // question, not an accusation. 4+ days: concrete options, since a question alone hasn't
          // helped by this point.
          const tone =
            health.daysOverdue <= 1
              ? "I'd handle that first, but shrink it if needed — a smaller first step still counts. Want me to update the action?"
              : health.daysOverdue <= 3
                ? `Is it still the right action, or are you avoiding it? Either way, want me to update it?`
                : "Want to shrink it, move it, or archive it? Whatever keeps it honest is fine.";
          lines.push(
            "",
            `You have an overdue action — ${label}: "${cleanedTitleForDateDisplay(overdueAction.title)}". ${tone}`
          );
        } else if (linkedOpenActions.length > 0) {
          const top = linkedOpenActions.slice(0, 2);
          lines.push("", `Existing open action${top.length === 1 ? "" : "s"} you can use: ${top.map((action) => `"${action.title}"`).join(", ")}.`);
        } else if (similarDeferred) {
          const settings = await getOrCreateNotificationSettings(userId);
          const whenLabel = similarDeferred.snoozedUntil
            ? formatDueLabelForChat(similarDeferred.snoozedUntil, settings.timezone).replace(/^due /, "")
            : "later";
          lines.push(
            "",
            `You already moved "${cleanedTitleForDateDisplay(similarDeferred.title)}" to ${whenLabel} — I won't create another one for today. Say "move it back to today" if you'd rather pull it forward.`
          );
        } else if (proposedAction && proposedAction.trim() && mentionsResumeUpdate(proposedAction) && recentlyStatedResumeUpToDate(context)) {
          // fix/private-alpha-deferred-action-dedupe-and-today-coaching: a real transcript found
          // "Customize your resume for remote Web3 roles" proposed minutes after the user had
          // said their resume and web CV were already current — the prompt guidance asking the
          // model not to do this was, in practice, not reliable enough on its own. This is a
          // deterministic backstop on the one part of this with real consequences (the STRUCTURED
          // proposedAction, which becomes a real ActionItem title if confirmed) — never edits the
          // model's own free-text `recommendation` sentence above, since safely removing a clause
          // from arbitrary prose without breaking its grammar isn't reliably possible; the
          // strengthened prompt guidance is what keeps that sentence itself clean.
          lines.push("", "Skipping resume/CV work — you already said it's up to date. Let me know if you'd like a different next step.");
        } else if (proposedAction && proposedAction.trim()) {
          lines.push("", `Want me to create this action?\n${proposedAction.trim()}`, "", "Reply yes to confirm or cancel.");
          pendingOperationUpdate = {
            topic: "action_creation",
            summary: `create the action "${proposedAction.trim()}"`,
            operations: [
              {
                tool: "action.create",
                args: { title: proposedAction.trim(), priority: "medium", goalId: goal.id },
                status: "valid",
                requiresConfirmation: false
              }
            ]
          };
        }

        // similarDeferred is included here specifically so a follow-up "move it back to today"
        // can resolve it — action.reschedule's own ref resolver (validator.ts's resolveActionRef)
        // only ever looks at session.visibleEntities/context.openActions, never
        // context.deferredActions directly, so without this a snoozed action mentioned in the
        // reply text would otherwise be unreferenceable by a bare "it"/"that" on the next turn.
        const entities = similarDeferred
          ? [goalToEntity(goal), actionToEntity(similarDeferred)]
          : [goalToEntity(goal), ...linkedOpenActions.map((action, index) => actionToEntity(action, index + 1))];

        return {
          tool: operation.tool,
          status: "executed",
          summary: lines.join("\n"),
          result: goal,
          entities,
          ...(pendingOperationUpdate ? { pendingOperationUpdate } : {})
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
        const dailyCoachingInterest = Boolean(args.dailyCoachingInterest);

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
          summary: formatGoalPlanProposal({ title, successCriteria, signals, checkIn, integrationHint, firstActions, dailyCoachingInterest }),
          pendingOperationUpdate: {
            topic: "goal_creation",
            summary: `create the "${title}" goal`,
            operations: [
              {
                tool: "goal.create_apply",
                args: { title, category, why, signals, checkIn, firstActions, dailyCoachingInterest },
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
        const dailyCoachingInterest = Boolean(args.dailyCoachingInterest);

        // Defensive/idempotent — goal.create_apply is normally only reached with signals already
        // augmented by goal.create_propose above (the confirm whitelist re-executes the exact
        // pendingOperation args), but this keeps the guarantee even if that ever changes.
        const signals = ensureBookGoalProgressSignal({ title, category, signals: rawSignals });

        const targetMetrics: GoalMetric[] = signals.map((signal) => ({
          key: signal.key,
          label: signal.label,
          labelSingular: signal.labelSingular,
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
        const doneLine = `Done — I'll track "${result.goal.title}" with ${signalNames}${checkInNote}.${actionsNote}`;

        // fix/private-alpha-post-goal-coaching-confirmation: a real Telegram smoke test found the
        // prior version of this follow-up asked "Want me to turn on the morning brief and evening
        // check-in for this?" as plain text, with NO real pendingOperation behind it — the user's
        // next "yes" then had nothing to confirm ("I don't have anything pending to confirm").
        // Fixed by installing a REAL proactive.settings_apply_update pendingOperationUpdate here,
        // the exact same mechanism the standalone "turn on morning brief and evening check-in"
        // request already uses successfully — never a confirmation-shaped question with nothing
        // behind it. Only proposes the moment(s) actually still off; if both are already on, this
        // says so honestly and opens no pending operation at all.
        // refactor/private-alpha-goal-driven-gmail-operator: goal-driven Gmail — a newly-created
        // goal that's obviously email-relevant (job search, travel, insurance, car, bills/admin,
        // work/client projects) gets offered Gmail support right here, the same chained-follow-up
        // mechanism dailyCoachingInterest already uses below for morning/evening coaching. Only
        // ever offered, never enabled silently; only when Gmail is connected AND nothing already
        // covers this goal (an unrelated goal, or Gmail not connected, gets no offer at all — see
        // buildGmailGoalWatcherOffer).
        // feat/private-alpha-capability-proposal-queue: previously dailyCoachingInterest's own
        // chain took priority whenever BOTH applied in the same turn, since only ONE
        // pendingOperationUpdate could exist at a time — a goal that was both daily-coaching- and
        // Gmail-relevant silently never got the Gmail offer that turn. Both are now collected into
        // ONE combined proposal list; 0 proposals keeps today's plain doneLine (plus a Gmail
        // connect mention when relevant), exactly 1 reuses that proposal's own EXISTING focused
        // confirm copy/topic verbatim (no behavior change for the single-offer case), and 2+ are
        // shown together as a numbered list under one new "capability_proposals" pendingOperation
        // so a single "yes"/"both" confirms all of them (finalizeDeterministicConfirmation already
        // executes every operation in a pendingOperation's array) and "only X"/"just X" confirms a
        // named subset (runtime.ts's topic-scoped selective-confirm handling).
        const proposals: CapabilityProposal[] = [];
        let dailyAlreadyOnNote = "";
        let gmailConnectSuggestionLine: string | undefined;

        // fix/private-alpha-launch-hardening-flakes-and-pending-clarity: wasCapabilityProposalRecentlyDeferred
        // guards against re-offering a capability the user already explicitly declined/deferred for
        // THIS goal earlier in the session (Task 4: "do not re-offer immediately in the same
        // conversation"). goal.create_apply only ever runs for a genuinely NEW goal (a duplicate
        // title short-circuits above, before any proposal is built), so this can never actually
        // find a match today — kept anyway as the defensive, correct check for any future surface
        // that recomputes an EXISTING goal's capability proposals, mirroring this file's own
        // established "keeps the guarantee even if that ever changes" precedent elsewhere.
        if (dailyCoachingInterest) {
          const dailyProposal = await buildDailyCoachingProposal(userId);
          if (!dailyProposal) {
            dailyAlreadyOnNote = " Morning/evening coaching is already on.";
          } else if (!wasCapabilityProposalRecentlyDeferred(context.session, dailyProposal.id, result.goal.id)) {
            proposals.push(dailyProposal);
          }
        }

        const gmailOffer = await buildGmailGoalWatcherOffer(userId, result.goal, context);
        if (gmailOffer?.kind === "offer" && !wasCapabilityProposalRecentlyDeferred(context.session, gmailOffer.proposal.id, result.goal.id)) {
          proposals.push(gmailOffer.proposal);
        } else if (gmailOffer?.kind === "not_connected") {
          gmailConnectSuggestionLine = gmailOffer.connectSuggestionLine;
        }

        const baseLine = `${doneLine}${dailyAlreadyOnNote}`;
        const entities = [goalToEntity(result.goal), ...createdActions.map(actionToEntity)];

        if (proposals.length === 0) {
          return {
            tool: operation.tool,
            status: "executed",
            summary: gmailConnectSuggestionLine ? `${baseLine}\n\n${gmailConnectSuggestionLine}` : baseLine,
            result: result.goal,
            entities
          };
        }

        if (proposals.length === 1) {
          const only = proposals[0];
          return {
            tool: operation.tool,
            status: "executed",
            summary: `${baseLine}\n\n${only.standaloneSummary}`,
            result: result.goal,
            entities,
            pendingOperationUpdate: {
              topic: only.pendingTopic,
              summary: only.pendingSummary,
              operations: [{ tool: only.tool, args: only.args, status: "valid", requiresConfirmation: false }]
            }
          };
        }

        const numberedList = proposals.map((p, index) => `${index + 1}. ${p.label}: ${p.numberedDescription}.`).join("\n");
        return {
          tool: operation.tool,
          status: "executed",
          summary: `${baseLine}\n\nI can also help in ${proposals.length === 2 ? "two ways" : `${proposals.length} ways`}:\n${numberedList}\n\nWant me to enable both?`,
          result: result.goal,
          entities,
          pendingOperationUpdate: {
            topic: "capability_proposals",
            summary: `enable ${proposals.map((p) => p.label.toLowerCase()).join(" and ")} for "${result.goal.title}"`,
            operations: proposals.map((p, index) => ({
              tool: p.tool,
              args: p.args,
              status: "valid",
              requiresConfirmation: false,
              proposalId: p.id,
              proposalLabel: p.label,
              proposalAliases: p.aliases,
              proposalIndex: index + 1,
              proposalGoalId: result.goal.id
            }))
          }
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

        // Only for a real archive (never a pause — a paused goal is still resumable, so its open
        // actions should stay untouched too) — a real Telegram smoke test found archiving a goal
        // left its linked open actions silently open forever, breaking "start fresh." Only actions
        // with a REAL goalId link are ever auto-included; a title-only resemblance is reported
        // honestly, never silently swept in, since that could catch an unrelated action that just
        // happens to share a word with the goal's title.
        let linkedOpenActions: ActionItem[] = [];
        let unlinkedTitleMatches: ActionItem[] = [];
        if (lifecycleOperation === "archive") {
          const openPool = await getActionItems(userId, { status: "open", limit: 500 });
          linkedOpenActions = openPool.filter((item) => item.goalId === goal.id && !isReminderCompanionAction(item));
          const goalTitleWords = goal.title.toLowerCase().split(/\s+/).filter((word) => word.length > 3);
          unlinkedTitleMatches = openPool.filter(
            (item) =>
              item.goalId !== goal.id &&
              !isReminderCompanionAction(item) &&
              goalTitleWords.some((word) => item.title.toLowerCase().includes(word))
          );
        }

        const linkedActionsNote =
          linkedOpenActions.length > 0
            ? ` and its ${linkedOpenActions.length} open action${linkedOpenActions.length === 1 ? "" : "s"}:\n${linkedOpenActions.map((item, i) => `${i + 1}. ${item.title}`).join("\n")}`
            : "";
        const unlinkedNote =
          unlinkedTitleMatches.length > 0
            ? ` Note: ${unlinkedTitleMatches.length} other open action${unlinkedTitleMatches.length === 1 ? "" : "s"} mention${unlinkedTitleMatches.length === 1 ? "s" : ""} this goal by name but aren't formally linked, so I won't touch ${unlinkedTitleMatches.length === 1 ? "it" : "them"} automatically — say "archive all my actions" if you want to clean those up too.`
            : "";

        const summaryText =
          lifecycleOperation === "pause"
            ? `You're about to pause "${goal.title}". It will stop appearing as active, but history stays. Reply yes to confirm or cancel.`
            : isCriticalArchive
              ? `This is marked critical, so I won't archive it silently. If you really want to stop tracking it${linkedActionsNote}, reply yes to confirm or cancel.${unlinkedNote}`
              : usedDeleteWording
                ? `I won't permanently delete the history. I can archive "${goal.title}"${linkedActionsNote} so it stops being active. Reply yes to confirm or cancel.${unlinkedNote}`
                : `You're about to archive "${goal.title}"${linkedActionsNote}. It will stop appearing as active, but history stays. Reply yes to confirm or cancel.${unlinkedNote}`;

        return {
          tool: operation.tool,
          status: "executed",
          summary: summaryText,
          entities: [goalToEntity(goal)],
          pendingOperationUpdate: {
            topic: "goal_lifecycle",
            summary: linkedOpenActions.length > 0 ? `${lifecycleOperation} "${goal.title}" and its ${linkedOpenActions.length} open action${linkedOpenActions.length === 1 ? "" : "s"}` : `${lifecycleOperation} "${goal.title}"`,
            operations: [
              {
                tool: "goal.archive_apply",
                args: { goalId: goal.id, goalTitle: goal.title, operation: lifecycleOperation },
                status: "valid",
                requiresConfirmation: false
              },
              ...(linkedOpenActions.length > 0
                ? [
                    {
                      tool: "action.archive_all_apply",
                      args: { actionIds: linkedOpenActions.map((item) => item.id) },
                      status: "valid" as const,
                      requiresConfirmation: false
                    }
                  ]
                : [])
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

      // fix/private-alpha-action-archive-targeting: a real live-trust bug found "restore the goal
      // 'X'" (right after that exact goal had been mistakenly archived — see action.archive's own
      // critical-link guard above) routed to goal.create_propose instead, offering to create a
      // brand-new goal rather than recognizing "restore" as recovering the one that already
      // existed. Archived goals are searched FIRST and reported honestly — never silently creates
      // anything; goal.create_apply's own duplicate check only ever looks at ACTIVE goals, so
      // without this an archived goal is genuinely invisible to it.
      case "goal.restore_propose": {
        const goalRef = args.goalRef as string | undefined;

        // "Already active" must win over "not found" — restoring something that's already active
        // is a real, common, honest answer, not a dead end.
        const activeOutcome = resolveGoalForLifecycleAction(goalRef, context.activeGoals, resolveCurrentFocusGoal(context));
        if (activeOutcome.status === "matched") {
          const goal = activeOutcome.goals[0];
          return {
            tool: operation.tool,
            status: "executed",
            summary: `"${goal.title}" is already active — nothing to restore.`,
            entities: [goalToEntity(goal)]
          };
        }

        const allGoals = await getGoals(userId);
        const archivedGoals = allGoals.filter((goal) => goal.status === "archived");
        const notFoundSummary = goalRef
          ? `I don't see an archived goal matching "${goalRef}". Want me to create a new goal for this instead? Just tell me and I'll set it up.`
          : "You don't have any archived goals to restore.";

        if (archivedGoals.length === 0) {
          return { tool: operation.tool, status: "executed", summary: notFoundSummary };
        }

        const resolution = resolveActiveGoalReference(goalRef, archivedGoals, { status: "archived" });

        // fix/private-alpha-goal-restore-ambiguity-resolution: a real live-trust bug — several
        // archived goals sharing the same (or a similar) title used to produce a duplicated,
        // undifferentiated "Do you mean 'A', 'A', 'B'?" question with NO pendingOperation behind
        // it at all, so every follow-up (repeating the exact title, "the one archived today",
        // "none", "cancel") fell through to the planner or a bare "nothing pending" reply instead
        // of ever narrowing down. buildGoalRestoreDisambiguation installs a REAL, numbered,
        // timestamp-differentiated pending clarification instead — see runtime.ts's own
        // RESTORE_GOAL_DISAMBIGUATION_TOPIC dispatch for how a reply resolves it.
        if (resolution.status === "ambiguous" && resolution.candidates) {
          return buildGoalRestoreDisambiguation(userId, resolution.candidates, goalRef ?? "");
        }

        if (resolution.status !== "matched" || !resolution.goal) {
          return { tool: operation.tool, status: "executed", summary: notFoundSummary };
        }

        const goal = resolution.goal;
        return {
          tool: operation.tool,
          status: "executed",
          summary: buildGoalRestoreConfirmationSummary(goal, await getUserTimezone(userId)),
          entities: [goalToEntity(goal)],
          pendingOperationUpdate: buildGoalRestorePendingOperationUpdate(goal)
        };
      }

      case "goal.restore_apply": {
        const goalId = args.goalId as string;
        const goalTitle = args.goalTitle as string;
        const updated = await setGoalStatus(userId, goalId, "active");
        if (!updated) return failed(operation.tool, `"${goalTitle}" no longer exists.`);
        return {
          tool: operation.tool,
          status: "executed",
          // Deliberately never restores linked actions here — Task rule: "do not restore archived
          // actions unless explicitly requested." setGoalStatus only ever touches the goal's own
          // status column, so this is honest by construction, not just by wording — nothing else
          // was touched. Existing targetMetrics/checkInConfig/evidence history are untouched too
          // (setGoalStatus writes only the status column), so restoring never re-derives metrics
          // from scratch or duplicates the goal.
          summary: `Restored "${updated.title}". Its archived actions stay archived unless you ask me to restore them too.`,
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
        const summary = await buildTruthfulProactiveSettingsSummary(userId, settings, context);
        return {
          tool: operation.tool,
          status: "executed",
          summary,
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
          const truthfulSummary = await buildTruthfulProactiveSettingsSummary(userId, settings, context);
          return {
            tool: operation.tool,
            status: "executed",
            summary: [`That's already how it's set.\n\n${truthfulSummary}`, reconnectNote].filter(Boolean).join("\n\n")
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

        // fix/private-alpha-proactive-checkins-and-overdue-action-ux: a real transcript found the
        // morning brief and evening check-in both reported "on" (morningBriefEnabled/
        // eveningCheckinEnabled were genuinely true) yet nothing ever delivered — because
        // dailyLoopEnabled (a separate, older umbrella flag apps/worker's v3-proactive-delivery.ts
        // ALSO requires, defaulting to false) was never set by this tool at all; only the legacy
        // daily_loop.settings_apply_update tool ever touched it. A user saying "turn on morning
        // brief" has no way to know that internal prerequisite exists, let alone to separately ask
        // for it — so turning morningBriefEnabled/eveningCheckinEnabled ON here now also turns
        // dailyLoopEnabled on, whenever it isn't already. Deliberately one-directional: turning
        // morning/evening OFF never touches dailyLoopEnabled, since a user can independently run
        // just the legacy daily-loop feature through daily_loop.settings_apply_update, and turning
        // it off here would silently break that unrelated, still-active use — "Do NOT silently
        // disable reminders."
        const enablingProactiveMoment = morningBriefEnabled === true || eveningCheckinEnabled === true;
        const dailyLoopEnabled = enablingProactiveMoment && !before.dailyLoopEnabled ? true : undefined;

        const updated = await updateNotificationSettings(userId, {
          morningBriefEnabled,
          eveningCheckinEnabled,
          gmailNudgeEnabled,
          morningTimeMinutes,
          eveningTimeMinutes,
          dailyLoopEnabled
        });
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

      case "proactive.brief_preference_apply_update": {
        const goalRef = args.goalRef as string | undefined;
        const briefType = (args.briefType as "morning" | "evening" | "both" | undefined) ?? "morning";
        const style = args.style as ProactiveBriefStyle;
        const contentRequest = args.contentRequest as string;

        // Zero active goals at all means there is genuinely nothing to attach to yet — a global
        // preference, not an error. With at least one active goal, resolveGoalForRecommendation's
        // existing single-goal/current-focus auto-resolve, real-ambiguity-asks, never-guesses
        // semantics (already used by goal.recommend_next_action) apply unchanged.
        let goal: Goal | undefined;
        if (context.activeGoals.length > 0) {
          const outcome = resolveGoalForRecommendation(goalRef, context.activeGoals, resolveCurrentFocusGoal(context));

          if (outcome.status === "ambiguous") {
            const names = outcome.goals.map((candidate) => `"${candidate.title}"`).join(" or ");
            return {
              tool: operation.tool,
              status: "executed",
              summary: `Which goal should this apply to — ${names}? Or should it apply to your mornings generally, not tied to one goal?`
            };
          }

          if (outcome.status === "no_match" && goalRef) {
            return failed(operation.tool, `I don't see an active goal called "${goalRef}" — want this to apply generally instead, or a different goal?`);
          }

          goal = outcome.status === "matched" ? outcome.goals[0] : undefined;
        }

        const scope: "goal" | "global" = goal ? "goal" : "global";
        const styleSummaryPhrase = PROACTIVE_BRIEF_STYLE_SUMMARY_PHRASE[style] ?? "personalize it";

        await upsertProactiveBriefPreference(userId, {
          scope,
          goalId: goal?.id,
          briefType,
          style,
          contentRequest,
          summary: `Wants the ${briefType} brief to ${styleSummaryPhrase}${goal ? ` for goal "${goal.title}"` : ""} (asked for: "${contentRequest}").`
        });

        // "send me motivational quotes every morning" is also, implicitly, a request for the
        // morning brief itself to actually be on — mirrors proactive.settings_apply_update's own
        // dailyLoopEnabled self-heal below, so this is a single, complete action rather than
        // silently storing a preference nothing ever delivers until a SEPARATE settings turn.
        const settingsBefore = await getOrCreateNotificationSettings(userId);
        const wantsMorning = briefType === "morning" || briefType === "both";
        const wantsEvening = briefType === "evening" || briefType === "both";
        const needsMorningEnable = wantsMorning && !settingsBefore.morningBriefEnabled;
        const needsEveningEnable = wantsEvening && !settingsBefore.eveningCheckinEnabled;

        if (needsMorningEnable || needsEveningEnable) {
          await updateNotificationSettings(userId, {
            morningBriefEnabled: needsMorningEnable ? true : undefined,
            eveningCheckinEnabled: needsEveningEnable ? true : undefined,
            dailyLoopEnabled: true
          });
        }

        const enabledNote = needsMorningEnable && needsEveningEnable
          ? " Morning brief and evening check-in are now on."
          : needsMorningEnable
            ? " Morning brief is now on."
            : needsEveningEnable
              ? " Evening check-in is now on."
              : "";

        return {
          tool: operation.tool,
          status: "executed",
          summary: `Got it — I'll ${styleSummaryPhrase} in your ${briefType === "both" ? "morning and evening briefs" : `${briefType} brief`}${goal ? ` for "${goal.title}"` : ""}.${enabledNote}`,
          result: { scope, goalId: goal?.id, briefType, style, contentRequest }
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
        const settings = await selfHealDailyLoopEnabled(await getOrCreateNotificationSettings(userId));
        const now = resolveAgentRuntimeNow();
        const sentForDate = formatDateInTimezone(now, settings.timezone);
        const morningKey = MORNING_BRIEF_DEDUPE_KEY;
        const [v3SentLog, legacyDailyLoopLog] = await Promise.all([
          getNotificationLog({ userId, type: morningKey, sentForDate }),
          getNotificationLog({ userId, type: "daily_loop_morning", sentForDate })
        ]);
        const v3SentAt = v3SentLog?.sentAt;
        const legacyDailyLoopSentAt = legacyDailyLoopLog?.sentAt;

        const allowlistActive = proactiveOperatorAllowlistActiveFromEnv();
        const status = getProactiveDeliveryStatus({
          context,
          notificationSettings: settings,
          now,
          alreadySentDedupeKeys: v3SentAt ? new Set([morningKey]) : new Set(),
          sentCountToday: v3SentAt ? 1 : 0,
          deliveryEnabled: proactiveOperatorDeliveryEnabledFromEnv(),
          isAllowlisted: proactiveOperatorAllowlistFromEnv()(userId),
          legacyDailyLoopSentAt
        });

        return {
          tool: operation.tool,
          status: "executed",
          summary: formatProactiveDeliveryDiagnosis(status, settings, legacyDailyLoopSentAt, allowlistActive, v3SentAt),
          result: { status }
        };
      }

      case "proactive.diagnose_evening_checkin": {
        const settings = await selfHealDailyLoopEnabled(await getOrCreateNotificationSettings(userId));
        const now = resolveAgentRuntimeNow();
        const sentForDate = formatDateInTimezone(now, settings.timezone);
        const eveningKey = EVENING_CHECKIN_DEDUPE_KEY;
        const [v3SentLog, legacyDailyLoopLog] = await Promise.all([
          getNotificationLog({ userId, type: eveningKey, sentForDate }),
          getNotificationLog({ userId, type: "daily_loop_evening", sentForDate })
        ]);
        const v3SentAt = v3SentLog?.sentAt;
        const legacyDailyLoopSentAt = legacyDailyLoopLog?.sentAt;

        const allowlistActive = proactiveOperatorAllowlistActiveFromEnv();
        const status = getEveningCheckinDeliveryStatus({
          context,
          notificationSettings: settings,
          now,
          alreadySentDedupeKeys: v3SentAt ? new Set([eveningKey]) : new Set(),
          sentCountToday: v3SentAt ? 1 : 0,
          deliveryEnabled: proactiveOperatorDeliveryEnabledFromEnv(),
          isAllowlisted: proactiveOperatorAllowlistFromEnv()(userId),
          legacyDailyLoopSentAt
        });

        return {
          tool: operation.tool,
          status: "executed",
          summary: formatEveningCheckinDeliveryDiagnosis(status, settings, legacyDailyLoopSentAt, allowlistActive, v3SentAt),
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

// Task 3/4 (launch-readiness): returns the specific clarification (e.g. a weekday/day-of-month
// mismatch question) whenever parseActionDueDate produced one, rather than collapsing every
// failure into the same generic "couldn't understand" reply — the caller decides which message
// to actually show, but only ever proceeds to reschedule when dueAt is present.
function parseActionRescheduleDate(
  action: ActionItem,
  input: { dueText?: string; timeText?: string; timezone: string }
): { dueAt: Date | undefined; clarification?: string } {
  if (input.dueText?.trim()) {
    // fix/private-alpha-local-date-focus-and-gmail-confirmation-state: a date-only reschedule
    // ("move it to wed 26") used to always fall back to the DEFAULT action time (9am), silently
    // dropping whatever time the action was already scheduled for. When the action already has a
    // real dueAt, its own local time-of-day becomes the default parseActionDueDate falls back to
    // — this only ever affects the no-explicit-time fallback; an explicit time in the new phrase
    // ("move it to wed 26 at 3pm") still always wins, unchanged.
    const existingTimeMinutes = action.dueAt ? minutesOfDayInTimezone(action.dueAt, input.timezone) : undefined;
    const parsed = parseActionDueDate(input.dueText, {
      timezone: input.timezone,
      now: resolveAgentRuntimeNow(),
      preferences: existingTimeMinutes !== undefined ? { defaultActionTimeMinutes: existingTimeMinutes } : undefined
    });
    return { dueAt: parsed.invalidReason ? undefined : parsed.dueAt ?? undefined, clarification: parsed.clarification };
  }

  if (input.timeText?.trim() && action.dueAt) {
    const localDate = formatDateInTimezone(action.dueAt, input.timezone);
    const parsed = parseActionDueDate(`${localDate} ${input.timeText}`, {
      timezone: input.timezone,
      now: resolveAgentRuntimeNow()
    });
    return { dueAt: parsed.invalidReason ? undefined : parsed.dueAt ?? undefined, clarification: parsed.clarification };
  }

  return { dueAt: undefined };
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

/** The date that actually matters for THIS item right now — snoozedUntil for a deferred action
 * (dueAt is stale/irrelevant once something is snoozed), dueAt for everything else. Both the
 * per-item date label and date-scoped ("actions for tomorrow") filtering key off this, not off
 * dueAt alone — a real Telegram smoke test found a snoozed item's line showing no date at all,
 * since the old dueLine only ever read item.dueAt. */
function actionEffectiveDate(item: ActionItem): Date | undefined {
  return item.status === "snoozed" ? item.snoozedUntil : item.dueAt;
}

/** "actions for today/tomorrow" (task fix/private-alpha-action-temporal-coaching) — a date-scoped
 * query is answered from BOTH open and snoozed items (see the action.list case's own pool-widening
 * comment), matched against each item's own actionEffectiveDate in the user's real timezone. */
function actionMatchesWhenWindow(
  item: ActionItem,
  when: "today" | "tomorrow" | "this_week" | "this_week_and_overdue",
  now: Date,
  timezone: string
): boolean {
  const todayLocal = formatDateInTimezone(now, timezone);
  const effective = actionEffectiveDate(item);

  // fix/private-alpha-coach-first-response-routing (known gap from the previous branch): a mixed
  // query like "yesterday or this week?" was previously only answerable as a plain "this_week"
  // list, which silently drops anything overdue from BEFORE today — this_week's own window starts
  // at todayLocal. Same window as this_week otherwise (through this week's Sunday, inclusive), just
  // with no lower bound at all, so anything overdue by any amount is included alongside it.
  if (when === "this_week_and_overdue") {
    if (item.status === "open" && !item.dueAt) {
      return true;
    }
    if (!effective) {
      return false;
    }
    const effectiveLocal = formatDateInTimezone(effective, timezone);
    const weekEnd = addDaysToLocalDateString(startOfLocalWeek(todayLocal), 6);
    return effectiveLocal <= weekEnd;
  }

  if (when === "today") {
    // An open action with no due date at all is still part of "today" — it's actionable right
    // now, same as a plain "show me my actions" would treat it. A snoozed one only counts if it's
    // actually coming back today.
    if (item.status === "open" && !item.dueAt) {
      return true;
    }
    return effective ? formatDateInTimezone(effective, timezone) === todayLocal : false;
  }

  if (when === "tomorrow") {
    if (!effective) {
      return false;
    }
    return formatDateInTimezone(effective, timezone) === addDaysToLocalDateString(todayLocal, 1);
  }

  // this_week: today through this week's Sunday, inclusive — an undated open action is trivially
  // "this week" too (same reasoning as "today" above), but a dated item must actually fall inside
  // the window, not just exist.
  if (item.status === "open" && !item.dueAt) {
    return true;
  }
  if (!effective) {
    return false;
  }
  const effectiveLocal = formatDateInTimezone(effective, timezone);
  const weekEnd = addDaysToLocalDateString(startOfLocalWeek(todayLocal), 6);
  return effectiveLocal >= todayLocal && effectiveLocal <= weekEnd;
}

const WHEN_NOUN: Record<"today" | "tomorrow" | "this_week" | "this_week_and_overdue", string> = {
  today: "today",
  tomorrow: "tomorrow",
  this_week: "later this week",
  this_week_and_overdue: "this week, including anything overdue"
};

function formatActionListForChat(
  items: ActionItem[],
  totalMatching: number,
  status: ActionItem["status"] | "all" | "active",
  overdueOnly: boolean,
  reminderByParentId: Map<string, ActionItem>,
  timezone: string,
  when?: "today" | "tomorrow" | "this_week" | "this_week_and_overdue"
): string {
  const baseNoun = when ? "action" : overdueOnly ? "overdue action" : status === "all" || status === "active" ? "action" : `${status} action`;

  if (items.length === 0) {
    return when
      ? `You don't have any actions scheduled for ${WHEN_NOUN[when]}.`
      : `You don't have any ${baseNoun}s right now.`;
  }

  // Real Telegram smoke test: "2 action for tomorrows" — pluralizing the WHOLE phrase ("action
  // for tomorrow" + "s") puts the "s" after the wrong word. The noun itself is pluralized first,
  // THEN "for <when>" is appended after — the only way "actions for tomorrow" ever comes out
  // right. Also: "You have 10 open actions" when 12 actually existed — never claim a total that's
  // actually just the page size; "Showing N of M" the moment the real total is larger than what's
  // displayed.
  const pluralNoun = `${baseNoun}${items.length === 1 ? "" : "s"}`;
  const listPhrase = when ? `${pluralNoun} for ${WHEN_NOUN[when]}` : pluralNoun;
  const header = totalMatching > items.length ? `Showing ${items.length} of ${totalMatching} ${listPhrase}:` : `You have ${items.length} ${listPhrase}:`;

  const now = new Date();
  const lines = [header];
  items.forEach((item, index) => {
    const effectiveDate = actionEffectiveDate(item);
    const health = assessTemporalHealth(item, now, timezone);
    // An item's OWN title can carry a now-stale temporal word ("...roles today" moved to
    // tomorrow, now overdue, or — fix/private-alpha-remove-user-facing-action-snooze — simply
    // rescheduled while staying open, which no longer has its own distinct "snoozed" status to
    // key off of) — cleanedTitleForDateDisplay strips only a recognized TRAILING phrase for
    // display, never touching the stored row or anything mid-title, and safely leaves an
    // on-track item's title untouched when nothing trails it. Applied unconditionally here so
    // every item's date line is honest, regardless of which status produced it.
    const displayTitle = cleanedTitleForDateDisplay(item.title);
    // Temporal health (fix/private-alpha-action-temporal-coaching) wins over the plain date line
    // for an overdue item — "due Mon 18 Aug" for something 4 days late reads as a normal
    // upcoming task, not a problem; "overdue by 4 days" is the honest version. A snoozed item
    // says "moved to X," never "due X — snoozed" (fix/private-alpha-temporal-action-copy-and-
    // dedup: "snoozed" must never leak into user-facing copy, and "due" is simply the wrong verb
    // for something that was actively moved). A stale (no-dueAt) item has no date line to
    // replace, so its label is simply added.
    const dueLine =
      health.kind === "overdue"
        ? ` — ${formatTemporalHealthLabel(health)}`
        : item.status === "snoozed" && effectiveDate
          ? ` — ${formatDeferredLabelForChat(effectiveDate, timezone)}`
          : effectiveDate
            ? ` — ${formatDueLabelForChat(effectiveDate, timezone)}`
            : health.kind === "stale"
              ? ` — ${formatTemporalHealthLabel(health)}`
              : "";
    // A real Telegram smoke test found archived actions re-listed with no status label at all —
    // indistinguishable from a genuinely open task. Only needed when the pool is mixed (status
    // "all"): a single-status query ("show me archived actions") already says so in the header
    // noun above, so repeating it on every line would be redundant, not clearer. Never for
    // "snoozed" specifically — its dueLine above already says "moved to X," which both identifies
    // it AND avoids the forbidden raw status word; repeating "— snoozed" after that would be both
    // redundant and exactly the leak this task exists to close.
    const statusLine = (status === "all" || when) && item.status !== "open" && item.status !== "snoozed" ? ` — ${item.status}` : "";
    lines.push(`${index + 1}. ${displayTitle}${dueLine}${statusLine}`);
    const sourceLine = actionSourceLabel(item);
    if (sourceLine) {
      lines.push(`   ${sourceLine}`);
    }
    const reminder = reminderByParentId.get(item.id);
    if (reminder) {
      lines.push(`   ${formatReminderMetadataForChat(reminder)}`);
    }
  });
  // "Complete/snooze/archive" only ever applies to an OPEN action — showing it under a list of
  // archived/completed items reads as an instruction that would just fail if followed. Shown only
  // when at least one visible item is actually open. A real Telegram smoke test found the OLD
  // fixed "Reply: complete 1, snooze 2 tomorrow, archive 3." footer referencing index 3 even when
  // only one action was shown — this always reflects the REAL open indexes actually on screen.
  const openIndexes = items.map((item, index) => (item.status === "open" ? index + 1 : null)).filter((index): index is number => index !== null);
  const footer = buildOpenActionCommandFooter(openIndexes);
  if (footer) {
    lines.push("", footer);
  }

  return lines.join("\n");
}

/** "moved to tomorrow 11:00" — the SAME today/tomorrow/full-date-fallback shape as
 * formatDueLabelForChat, just for a deferred (snoozed) item specifically. fix/private-alpha-
 * temporal-action-copy-and-dedup: a real Telegram smoke test found a snoozed item's line reading
 * "... — due tomorrow 11:00 — snoozed", both leaking the user-facing-forbidden word "snoozed" AND
 * saying "due" for something that was actively MOVED, not originally due there. One line, one
 * honest verb, never the word "snooze"/"snoozed" back to the user. */
function formatDeferredLabelForChat(snoozedUntil: Date, timezone: string): string {
  return formatDueLabelForChat(snoozedUntil, timezone).replace(/^due /, "moved to ");
}

/**
 * fix/private-alpha-goal-restore-ambiguity-resolution: "archived today 01:39" / "archived
 * yesterday 22:14" / "archived 27/08/2026, 09:00" — the same relative-day shape as
 * formatDueLabelForChat, extended with "yesterday" (due-labels only ever look forward; a restore
 * candidate's archived/created moment is always in the past) since goal.restore_propose's
 * disambiguation display needs exactly this for BOTH archivedAt and createdAt.
 */
function formatPastRelativeLabelForChat(date: Date, timezone: string, verb: string, now: Date = new Date()): string {
  const todayLocal = formatDateInTimezone(now, timezone);
  const dateLocal = formatDateInTimezone(date, timezone);
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hour12: false }).format(date);

  if (dateLocal === todayLocal) {
    return `${verb} today ${time}`;
  }
  if (dateLocal === addDaysToLocalDateString(todayLocal, -1)) {
    return `${verb} yesterday ${time}`;
  }
  return `${verb} ${formatFullLocalDateTime(date, timezone)}`;
}

// Trailing temporal phrases safe to strip when a title is shown ALONGSIDE its own real date/
// status label — "Apply to roles today" next to "moved to tomorrow 11:00" reads as a flat
// contradiction otherwise. Deliberately a small, explicit, English-only set of phrases that only
// ever match at the very END of the title (never mid-title, never touching unrelated words) —
// this is a display-only cleanup, the STORED title is never rewritten, so nothing is lost and a
// phrase this doesn't recognize is safely left exactly as written rather than guessed at.
const TRAILING_TEMPORAL_PHRASE_RE = /\s*[-–—]?\s*(today|tomorrow|tonight|this (morning|afternoon|evening)|by (the end of (the )?week|end of week))\.?$/i;

/** Strips a recognized trailing temporal phrase for DISPLAY purposes only — the real ActionItem
 * row and its title are never modified. Falls back to the original title untouched whenever
 * stripping would leave nothing meaningful (e.g. a title that IS just "today"), so this can never
 * turn a real title into an empty or confusing fragment. */
function cleanedTitleForDateDisplay(title: string): string {
  const cleaned = title.replace(TRAILING_TEMPORAL_PHRASE_RE, "").trim();
  return cleaned.length >= 3 ? cleaned : title;
}

/** Repeated-postponement coaching (originally fix/private-alpha-action-temporal-coaching, now
 * shared by action.reschedule's own genuine-deferral case and action.snooze's defense-in-depth
 * alias — fix/private-alpha-remove-user-facing-action-snooze): the FIRST move of any action is
 * completely ordinary rescheduling, never challenged. The second gets a genuine, non-accusatory
 * question — real life does sometimes need two moves — and only the third-plus gets stronger,
 * concrete coaching. Grounded entirely in postponeCount (packages/db's own persistent counter,
 * now incremented by rescheduleActionItem itself for a genuine push-later), never guessed from
 * conversation history, and never blocks the move itself — the action is always actually moved
 * first, this is only ever appended after. */
function postponeCoachingNote(postponeCount: number): string {
  return postponeCount === 2
    ? " I can move it, but this is the second time. Is today genuinely blocked, or are you avoiding this?"
    : postponeCount >= 3
      ? " You've moved this several times. We should either shrink it, do a 10-minute version, or archive it."
      : "";
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

const PROACTIVE_BRIEF_STYLE_SUMMARY_PHRASE: Record<ProactiveBriefStyle, string> = {
  motivational: "include a short motivating line",
  reflection: "include a short reflection prompt",
  tough_love: "keep it direct and no-nonsense",
  gentle: "keep it warm and encouraging",
  practical: "keep it plain and practical"
};

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

const APPLICATION_ACTION_TARGET_COUNT_RE = /\b(?:send|submit|apply to)\s+(\d+)\s+(?:cvs?|applications?|jobs?)\b/i;

/** The action's OWN stated target count ("Send 3 CVs" -> 3) — undefined for a title with no
 * concrete number, which this reconciliation deliberately never guesses at. */
function parseApplicationActionTargetCount(title: string): number | undefined {
  const match = title.match(APPLICATION_ACTION_TARGET_COUNT_RE);
  return match?.[1] ? Number.parseInt(match[1], 10) : undefined;
}

type ApplicationsSentReconciliation = { kind: "complete"; action: ActionItem; note: string } | { kind: "partial" | "ambiguous" | "none"; note: string };

/**
 * fix/private-alpha-gmail-review-llm-instruction-routing addendum (Task 3): "I sent 3 CVs today"
 * completing the matching open "Send 3 CVs" action, deterministically. Only ever considers OPEN
 * actions (context.openActions already excludes completed/archived/snoozed by construction) whose
 * title states a real, concrete target count — never a guess for a vague title. A count that meets
 * or exceeds the target auto-completes (private-alpha's chosen default — see the task); a lower
 * count mentions what's left instead; more than one matching open action asks rather than picking
 * one; zero matches logs progress with no reconciliation note at all.
 */
function reconcileApplicationsSentWithOpenAction(sentCount: number, openActions: ActionItem[]): ApplicationsSentReconciliation {
  const matching = openActions
    .map((action) => ({ action, target: parseApplicationActionTargetCount(action.title) }))
    .filter((entry): entry is { action: ActionItem; target: number } => entry.target !== undefined);

  if (matching.length === 0) {
    return { kind: "none", note: "" };
  }

  if (matching.length > 1) {
    return {
      kind: "ambiguous",
      note: ` You have a few open actions this could complete (${matching.map((entry) => `"${entry.action.title}"`).join(", ")}) — say which one to mark done.`
    };
  }

  const { action, target } = matching[0]!;
  if (sentCount >= target) {
    return { kind: "complete", action, note: ` Marked "${action.title}" done.` };
  }

  return { kind: "partial", note: ` ${target - sentCount} more to go on "${action.title}".` };
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
/**
 * Goal resolution for goal.recommend_next_action — deliberately its own middle ground between
 * resolveGoalReferenceTargets (a bare/empty ref falls back to "all goals," fine for a read-only
 * status recap but wrong here: coaching only ever targets ONE goal at a time) and
 * resolveGoalForLifecycleAction (a bare/empty ref with no established focus is "no_match," too
 * strict for a single-goal user with nothing yet "focused" in conversation — asking "which goal?"
 * when there's obviously only one to mean is not what "identify the focused goal if obvious"
 * means). With no goalRef: the established conversation focus wins if there is one; otherwise a
 * single active goal is unambiguous and resolves on its own; two or more with no focus is a real
 * ambiguity and asks, never guesses. A named ref still goes through the same fuzzy title matching
 * resolveGoalForLifecycleAction already uses.
 */
function resolveGoalForRecommendation(goalRef: string | undefined, activeGoals: Goal[], currentFocus?: Goal): GoalReferenceOutcome {
  if (activeGoals.length === 0) {
    return { status: "no_match", goals: [] };
  }
  if (!goalRef || !goalRef.trim()) {
    if (currentFocus) {
      return { status: "matched", goals: [currentFocus] };
    }
    if (activeGoals.length === 1) {
      return { status: "matched", goals: activeGoals };
    }
    return { status: "ambiguous", goals: activeGoals };
  }
  return resolveGoalForLifecycleAction(goalRef, activeGoals, currentFocus);
}

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

const TITLE_SIMILARITY_STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "to",
  "for",
  "of",
  "in",
  "on",
  "at",
  "by",
  "and",
  "or",
  "this",
  "that",
  "more",
  "today",
  "tomorrow",
  "week",
  "end",
  "next",
  "some"
]);

/** Same underlying task, worded differently — "Apply to 3 more remote Web3 roles by the end of
 * the week" vs "Apply to 3 more remote Web3 roles today" share every real content word once
 * generic filler/temporal words (today, tomorrow, by, the, end, week) are stripped out; only
 * those two titles differing in exactly the temporal framing is precisely the shape
 * goal.recommend_next_action's deferred-action check needs to catch. Deliberately a plain
 * significant-word-overlap heuristic, not fuzzy/typo-tolerant — a real but different task
 * ("Update resume" vs "Update LinkedIn") must never be treated as the same one. */
function titlesLookSimilar(a: string, b: string): boolean {
  const words = (text: string) =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 2 && !TITLE_SIMILARITY_STOPWORDS.has(word));

  const wordsA = new Set(words(a));
  const wordsB = words(b);
  if (wordsA.size === 0 || wordsB.length === 0) {
    return false;
  }
  const overlap = wordsB.filter((word) => wordsA.has(word)).length;
  return overlap / Math.max(wordsA.size, wordsB.length) >= 0.6;
}

// A real transcript reported this exact fact getting contradicted THREE times now — checked
// against BOTH the visible recent conversation (this session's own messages, capped at
// MAX_MESSAGES in conversation-session.ts — genuinely just a handful of turns) AND
// context.memories' summaries (durable facts, possibly saved in an earlier session entirely).
// The recent-conversation check alone was never enough: a fact stated once during goal setup
// reliably ages out of that short window within a real, normal-length conversation, which is
// exactly what happened — see planner.ts's own goal-setup guidance, now updated to actually save
// this kind of fact as a memory.create'd "goal_context" entry so it survives past that window.
// Deliberately scoped to resume/CV/portfolio specifically (the real reported instances), not a
// generic "any stated fact" detector — that would be a much bigger, riskier feature than this
// focused pass calls for. RESUME_UP_TO_DATE_RE/RESUME_UPDATE_SUGGESTION_RE now live in
// @operator-agent/core (fix/private-alpha-live-action-and-coaching-regressions) so the proactive
// morning-brief LLM layer's own contradiction guard can never drift from this one.

function recentlyStatedResumeUpToDate(context: ContextBundle): boolean {
  const recentUserText = context.session.messages
    .filter((entry) => entry.role === "user")
    .map((entry) => entry.text)
    .join(" \n ");
  if (RESUME_UP_TO_DATE_RE.test(recentUserText)) {
    return true;
  }
  return context.memories.some((memory) => RESUME_UP_TO_DATE_RE.test(memory.summary));
}

function mentionsResumeUpdate(text: string): boolean {
  return RESUME_UPDATE_SUGGESTION_RE.test(text);
}

/** First pair of genuinely similar items in a (usually short, date-scoped) list — reuses
 * titlesLookSimilar so "similar" always means the same thing everywhere it's checked. Only
 * called on a small `when`-scoped result set, so the naive pairwise scan is cheap; never called
 * on the full unbounded action pool. */
function findSimilarActionPair(items: ActionItem[]): [ActionItem, ActionItem] | undefined {
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (titlesLookSimilar(items[i]!.title, items[j]!.title)) {
        return [items[i]!, items[j]!];
      }
    }
  }
  return undefined;
}

function describeAmbiguousGoalChoice(candidates: Goal[]): string {
  const names = candidates.map((goal) => `"${goal.title}"`);
  const last = names.pop();
  return `Do you mean ${names.length > 0 ? `${names.join(", ")} or ${last}` : last}?`;
}

/** Exact single-goal restore confirmation copy — shared by goal.restore_propose's direct-match
 * path and runtime.ts's disambiguation-resolved path, so the two can never say it differently. */
function buildGoalRestoreConfirmationSummary(goal: Goal, timezone: string): string {
  const recency = goal.archivedAt && formatDateInTimezone(goal.archivedAt, timezone) === formatDateInTimezone(new Date(), timezone) ? " from today" : "";
  return `I found the archived goal "${goal.title}"${recency}. Restore it? Reply yes to confirm or cancel.`;
}

function buildGoalRestorePendingOperationUpdate(goal: Goal): ExecutedOperation["pendingOperationUpdate"] {
  return {
    topic: "goal_restore",
    summary: `restore "${goal.title}"`,
    operations: [
      {
        tool: "goal.restore_apply",
        args: { goalId: goal.id, goalTitle: goal.title },
        status: "valid",
        requiresConfirmation: false
      }
    ]
  };
}

// Never shown a list longer than this without saying there's more — a real reported bug found a
// generic "here's everything" reply for a large ambiguous match set unreadable in a chat window.
const RESTORE_DISAMBIGUATION_DISPLAY_CAP = 8;

/**
 * fix/private-alpha-goal-restore-ambiguity-resolution: builds a REAL, numbered, timestamp-
 * differentiated pending clarification for several archived goals matching one restore request —
 * never a bare "Do you mean 'A', 'A', 'B'?" with duplicate, undifferentiated titles and no
 * pendingOperation behind it. Each candidate carries its own archivedAt/createdAt (ISO strings, so
 * they round-trip through the JSON-serialized pendingOperation) for runtime.ts's
 * matchGoalRestoreDisambiguation to resolve a later recency-shaped reply ("the one archived
 * today", "latest created") without a second DB round-trip.
 */
async function buildGoalRestoreDisambiguation(userId: string, candidates: Goal[], originalQuery: string): Promise<ExecutedOperation> {
  const timezone = await getUserTimezone(userId);
  const capped = candidates.slice(0, RESTORE_DISAMBIGUATION_DISPLAY_CAP);
  const overflowNote = candidates.length > capped.length ? `\n(and ${candidates.length - capped.length} more — try naming it more specifically)` : "";

  const lines = capped.map((goal, index) => {
    const archivedLabel = goal.archivedAt ? formatPastRelativeLabelForChat(goal.archivedAt, timezone, "archived") : "archived date unknown";
    const createdLabel = formatPastRelativeLabelForChat(goal.createdAt, timezone, "created");
    return `${index + 1}. ${goal.title} — ${archivedLabel} — ${createdLabel}`;
  });

  return {
    tool: "goal.restore_propose",
    status: "executed",
    summary: `I found several archived goals that match:\n${lines.join("\n")}${overflowNote}\nReply with a number, "latest archived", or "cancel".`,
    result: capped,
    pendingOperationUpdate: {
      topic: "restore_goal_disambiguation",
      summary: `restore one of ${capped.length} archived goals matching "${originalQuery}"`,
      operations: capped.map((goal, index) => ({
        tool: "goal.restore_apply",
        args: { goalId: goal.id, goalTitle: goal.title },
        status: "valid",
        requiresConfirmation: false,
        proposalIndex: index + 1,
        candidateCreatedAt: goal.createdAt.toISOString(),
        candidateArchivedAt: goal.archivedAt ? goal.archivedAt.toISOString() : null
      }))
    }
  };
}

/** "1 CVs sent" reads as a typo, not a real number — a real private-alpha transcript hit exactly
 * this. No general pluralization heuristic can reliably guess a label's singular form (the
 * countable noun isn't always the first or last word — "recruiter replies" vs "CVs sent"), so
 * this only ever uses the metric's own labelSingular when the count is exactly 1, falling back to
 * the plural label whenever a goal was created before that field existed. */
function countLabel(metric: GoalMetric, count: number): string {
  return count === 1 && metric.labelSingular ? metric.labelSingular : metric.label;
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
    lines.push(`This week: ${weekCounts.map((entry) => `${entry.count} ${countLabel(entry.metric, entry.count)}`).join(", ")}.`);
    if (todayCounts.length > 0) {
      lines.push(`Today: ${todayCounts.map((entry) => `${entry.count} ${countLabel(entry.metric, entry.count)}`).join(", ")}.`);
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
  labelSingular?: string;
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
  dailyCoachingInterest?: boolean;
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

  // A real Telegram smoke test found "add a morning message to motivate me and create some
  // actions every morning" turned into TWO fake firstActions ("Send a motivational message each
  // morning", "Create action items for the day") — those are Alecto's own proactive
  // responsibilities, never a user todo. dailyCoachingInterest routes that request here instead,
  // grounded in what the morning brief/evening check-in actually do today (rank/surface real open
  // actions and progress — never invent or auto-create new ones without a separate confirmation).
  if (input.dailyCoachingInterest) {
    lines.push(
      "Daily coaching:",
      "- Morning brief: motivation plus a look at this goal and your open actions, so I can suggest which ones to focus on today — I won't create new actions automatically without asking first.",
      "- Evening check-in: a quick review of today's progress on this goal."
    );
  }

  if (input.integrationHint) {
    // The disclaimer is appended here, deterministically, rather than left to the planner's own
    // integrationHint wording — every Gmail-adjacent proposal must say the same honest thing about
    // what Gmail integration actually does, regardless of how the LLM phrased the hint itself.
    if (/gmail/i.test(input.integrationHint)) {
      lines.push("Gmail:", `- ${input.integrationHint}`, "- I cannot send or reply to emails.");
    } else {
      lines.push("Integration:", `- ${input.integrationHint}`);
    }
  }

  // "Concrete" in the label itself, not just in the planner's own selection criteria — this line
  // never appears at all unless there's a genuinely concrete, one-off, USER-owned action to show
  // (per the firstActions-concreteness AND Alecto-responsibility prompt rules, an empty list here
  // is a normal, honest outcome, not a gap — the morning brief covers the rest, per dailyCoachingInterest above).
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

/**
 * fix/private-alpha-proactive-checkins-and-overdue-action-ux: a real transcript found this exact
 * status ("Morning brief: on, around 09:00") reported honestly-worded settings that nonetheless
 * NEVER delivered — the old formatProactiveSettingsSummary only ever read
 * morningBriefEnabled/eveningCheckinEnabled, never checking whether the worker would actually be
 * eligible to send (PROACTIVE_OPERATOR_DELIVERY_ENABLED, the allowlist, dailyLoopEnabled, or
 * today's own dedupe/candidate state) — the exact same six concerns
 * proactive.diagnose_morning_brief/diagnose_evening_checkin already computed via
 * getProactiveDeliveryStatus/getEveningCheckinDeliveryStatus for a DELIBERATE "why didn't it
 * send?" question. This reuses those same status functions so "is it on" can never disagree with
 * "would it actually send" — just phrased as a compact suffix instead of a full diagnosis
 * sentence, plus real next-due/last-sent state so the status is actually inspectable, not just a
 * boolean.
 */
async function buildTruthfulProactiveSettingsSummary(userId: string, settingsInput: NotificationSettings, context: ContextBundle): Promise<string> {
  // fix/private-alpha-proactive-launch-config-cleanup: an existing user who opted into morning/
  // evening BEFORE the fix that makes dailyLoopEnabled follow along automatically is otherwise
  // stuck reporting "blocked — the daily loop itself is off" forever, with no way to notice short
  // of manually re-toggling the setting. Self-heals right here, on every status read, so simply
  // asking "what proactive messages are on?" repairs it — no separate migration/backfill needed.
  const settings = await selfHealDailyLoopEnabled(settingsInput);
  const now = new Date();
  const sentForDate = formatDateInTimezone(now, settings.timezone);
  const deliveryEnabled = proactiveOperatorDeliveryEnabledFromEnv();
  const isAllowlisted = proactiveOperatorAllowlistFromEnv()(userId);
  const briefPreferences = await getProactiveBriefPreferences(userId);

  const morning = settings.morningBriefEnabled
    ? await buildMomentStatusLine({
        userId,
        settings,
        context,
        now,
        sentForDate,
        deliveryEnabled,
        isAllowlisted,
        dedupeKey: MORNING_BRIEF_DEDUPE_KEY,
        legacyType: "daily_loop_morning",
        scheduledMinutes: settings.morningTimeMinutes,
        momentPhrase: "morning brief",
        getStatus: (alreadySentDedupeKeys, sentCountToday, legacyDailyLoopSentAt) =>
          getProactiveDeliveryStatus({ context, notificationSettings: settings, now, alreadySentDedupeKeys, sentCountToday, deliveryEnabled, isAllowlisted, legacyDailyLoopSentAt })
      }) + (formatProactiveBriefStyleSuffix(briefPreferences, context, "morning") ?? "")
    : "off";

  const evening = settings.eveningCheckinEnabled
    ? await buildMomentStatusLine({
        userId,
        settings,
        context,
        now,
        sentForDate,
        deliveryEnabled,
        isAllowlisted,
        dedupeKey: EVENING_CHECKIN_DEDUPE_KEY,
        legacyType: "daily_loop_evening",
        scheduledMinutes: settings.eveningTimeMinutes,
        momentPhrase: "evening check-in",
        getStatus: (alreadySentDedupeKeys, sentCountToday, legacyDailyLoopSentAt) =>
          getEveningCheckinDeliveryStatus({ context, notificationSettings: settings, now, alreadySentDedupeKeys, sentCountToday, deliveryEnabled, isAllowlisted, legacyDailyLoopSentAt })
      }) + (formatProactiveBriefStyleSuffix(briefPreferences, context, "evening") ?? "")
    : "off";

  return ["Automatic messages:", `- Morning brief: ${morning}`, `- Evening check-in: ${evening}`, `- Gmail alerts: ${settings.gmailNudgeEnabled ? "on" : "off"}`].join("\n");
}

/**
 * fix/private-alpha-proactive-brief-llm-personalization (Task 9): "Style: motivational for 'Find
 * meaning and purpose in life'" — honest ONLY when a real, active proactive_brief_preference
 * exists; undefined (no suffix at all) otherwise, never a fabricated default style. Reuses
 * pickBriefGoal/resolveProactiveBriefPreference — the exact same functions that decide what the
 * NEXT real brief will actually contain — so status can never claim a style delivery wouldn't
 * actually apply.
 */
function formatProactiveBriefStyleSuffix(
  preferences: ProactiveBriefPreference[],
  context: ContextBundle,
  briefType: "morning" | "evening"
): string | undefined {
  const goal = pickBriefGoal(preferences, context.activeGoals, briefType);
  const preference = resolveProactiveBriefPreference(preferences, goal?.id, briefType);

  if (!preference) {
    return undefined;
  }

  return `\n  Style: ${preference.style}${goal ? ` for "${goal.title}"` : ""} (${preference.contentRequest})`;
}

async function buildMomentStatusLine(input: {
  userId: string;
  settings: NotificationSettings;
  context: ContextBundle;
  now: Date;
  sentForDate: string;
  deliveryEnabled: boolean;
  isAllowlisted: boolean;
  dedupeKey: string;
  legacyType: string;
  scheduledMinutes: number;
  momentPhrase: "morning brief" | "evening check-in";
  getStatus: (
    alreadySentDedupeKeys: Set<string>,
    sentCountToday: number,
    legacyDailyLoopSentAt: Date | undefined
  ) => ReturnType<typeof getProactiveDeliveryStatus> | ReturnType<typeof getEveningCheckinDeliveryStatus>;
}): Promise<string> {
  const [alreadySentToday, legacyDailyLoopLog, mostRecentLog] = await Promise.all([
    hasNotificationLog({ userId: input.userId, type: input.dedupeKey, sentForDate: input.sentForDate }),
    getNotificationLog({ userId: input.userId, type: input.legacyType, sentForDate: input.sentForDate }),
    getMostRecentNotificationLog(input.userId, input.dedupeKey)
  ]);

  const status = input.getStatus(alreadySentToday ? new Set([input.dedupeKey]) : new Set(), alreadySentToday ? 1 : 0, legacyDailyLoopLog?.sentAt);
  const onLabel = `on, around ${formatMinutesOfDay(input.scheduledMinutes)}`;
  const blocked = proactiveStatusBlockedClause(status, input.momentPhrase);

  if (blocked?.kind === "full_line") {
    return blocked.text;
  }
  if (blocked?.kind === "clause") {
    return `${onLabel} — ${blocked.text}`;
  }

  const nextDue = nextScheduledMomentLabel(input.scheduledMinutes, input.now, input.settings.timezone);
  const lastSent = mostRecentLog ? formatDueLabelForChat(mostRecentLog.sentAt, input.settings.timezone, input.now).replace(/^due /, "") : "never";
  return `${onLabel} — next due: ${nextDue} / last sent: ${lastSent}`;
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

/** Best-effort token extraction + revocation for a Gmail disconnect/switch — see
 * revokeGoogleOAuthToken's own doc comment for why this never throws or blocks the local
 * disconnect. Tolerates both the normal encrypted-token shape (EncryptedSecretJsonEnvelope) and a
 * legacy plaintext shape (same fallback readGmailToken/server.ts already tolerates elsewhere),
 * without needing to import that private, self-healing helper — revocation only needs a raw
 * token value, not the full read/refresh/self-heal machinery. */
async function bestEffortRevokeGmailConnectionToken(connection: IntegrationConnection): Promise<boolean> {
  try {
    const rawToken = (connection.config as Record<string, unknown> | undefined)?.token;
    const decoded = isEncryptedSecretJsonEnvelope(rawToken)
      ? decryptSecretJson<{ accessToken?: string; refreshToken?: string }>(rawToken)
      : (rawToken as { accessToken?: string; refreshToken?: string } | undefined);
    const tokenToRevoke = decoded?.refreshToken || decoded?.accessToken;
    if (!tokenToRevoke) {
      return false;
    }
    return await revokeGoogleOAuthToken(tokenToRevoke);
  } catch {
    return false;
  }
}

function formatGmailConnectionStatusForChat(
  userId: string,
  connection: IntegrationConnection | undefined,
  rules: EmailSignalRule[],
  timezone: string,
  includeLink: boolean,
  lastSyncedAt?: Date,
  // fix/private-alpha-pending-action-refinement-and-gmail-rule-ux: a real reported gap — Gmail
  // connected with no active rule always got the same generic "you can say enable job search
  // rule..." line, even when an active goal's own real signals (job/career/recruiter/CV wording)
  // clearly call for exactly one of those rules. When set (by buildGmailRuleProposal, using the
  // SAME goal-relevance data buildGmailAutonomyState already computes but the chat reply never
  // surfaced), this REPLACES that generic line with a specific, actionable proposal instead of
  // appending alongside it — showing both would be redundant.
  ruleProposalLine?: string,
  // fix/private-alpha-gmail-proactive-highsignal-and-goal-association: launch-readiness status
  // clarity — the per-rule line now names its linked goal when one resolves (stored OR the same
  // live single-candidate fallback rule-creation uses), and the whole reply states pending review
  // count + manual-vs-scheduled cadence, so "gmail status" alone answers what used to require
  // asking gmail.autonomy.status and goal.status separately too.
  activeGoals: Goal[] = [],
  // fix/private-alpha-gmail-generic-signal-engine (Task 10): was a bare pendingReviewCount number
  // — now the real pending review rows, so the per-rule line can show ITS OWN pending count and
  // the summary line can break the total down by priority, generically across every rule/domain,
  // not just job-search.
  pendingReviews: EmailReviewItem[] = [],
  autonomyState?: Awaited<ReturnType<typeof buildGmailAutonomyState>>,
  // fix/private-alpha-gmail-review-llm-instruction-routing (Task 5): the caller's FULL,
  // unfiltered rule list (active AND paused/archived — e.g. from an old Gmail account after a
  // switch) — see buildGoalFirstGmailSupportLines's own doc comment for why the per-goal pending
  // count needs this to stay consistent with gmail.review.list. Defaults to `rules` itself so any
  // other caller that only ever had active rules to begin with keeps its exact old behavior.
  allRules: EmailSignalRule[] = rules
): string {
  const oauthUrl = gmailOAuthUrlForUser(userId);
  const activeRules = rules.filter((rule) => rule.status === "active");
  // Task 7 (refactor/private-alpha-goal-driven-gmail-operator): the DEFAULT status is goal-first —
  // "Gmail support: Job search goal: on — watches X", never a raw rule list ("1. Job search
  // emails — review-first tracking") — a user should be able to tell what Alecto is doing for
  // their goals without learning what a "rule" is. The full rule-level detail (name, domain,
  // exact per-rule tracking policy) still exists, just moved to the explicit "show Gmail rules"
  // advanced view (gmail.rule.list), unchanged by this.
  const ruleLines = activeRules.length > 0 ? buildGoalFirstGmailSupportLines(activeRules, activeGoals, pendingReviews, allRules) : [];
  const highPriorityPendingCount = pendingReviews.filter((review) => review.priority === "high").length;
  const pendingReviewLine =
    activeRules.length > 0
      ? `Pending reviews: ${pendingReviews.length}${highPriorityPendingCount > 0 ? ` (${highPriorityPendingCount} high priority)` : ""}.`
      : undefined;
  const syncModeLine = autonomyState && activeRules.length > 0 ? gmailSyncModeSentence(autonomyState) : undefined;

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
      ? (ruleProposalLine ??
        "No email tracking rules are active yet. You can say \"enable job search rule for Gmail\", \"enable work action rule for Gmail\", or \"track Endesa bills from Gmail\".")
      : undefined,
    ...ruleLines,
    pendingReviewLine,
    syncModeLine ?? (activeRules.length === 0 ? "Sync only runs when you say \"sync Gmail\" or when scheduled Gmail checks are enabled." : undefined)
  ].filter(Boolean).join("\n");
}

/**
 * fix/private-alpha-pending-action-refinement-and-gmail-rule-ux: buildGmailAutonomyState already
 * computes state.recommendedRules (goal-relevance matching against real active goals' own
 * title/category wording, via gmailRecommendationKindForGoal) — this was already correct, tested
 * infrastructure, just never actually surfaced anywhere in the V3 chat path (only the legacy
 * slash-command flow's formatGmailRecommendations used it, as a passive "Recommended:" listing,
 * never an active, confirmable proposal). This turns the SAME top recommendation into a real,
 * user-facing proposal: a line worth showing, and — for job_search/work_action specifically,
 * where enabling really is just one confirmable gmail.rule.enable_builtin call — a real
 * pendingOperationUpdate a caller MAY choose to attach. "custom" recommendations need the user's
 * own sender/keyword input first, so they only ever get the informational line, never a
 * confirmable operation.
 */
export interface GmailRuleProposal {
  line: string;
  pendingOperationUpdate?: { topic: string; summary: string; operations: ValidatedOperation[] };
}

export function buildGmailRuleProposal(state: Awaited<ReturnType<typeof buildGmailAutonomyState>>): GmailRuleProposal | undefined {
  const top = state.recommendedRules[0];
  if (!top) {
    return undefined;
  }

  if (top.kind === "custom") {
    return { line: `Recommended: ${top.reason} Say "track <sender or keyword>" to set up a readonly custom rule.` };
  }

  const kind = top.kind;
  const label = kind === "job_search" ? "job-search" : "work-action";
  const watches = kind === "job_search" ? "recruiter replies and application updates" : "work-related email activity";

  return {
    line: `Gmail is connected, but no ${label} tracking rule is active yet. Want me to enable a readonly rule to watch ${watches} for this goal?`,
    pendingOperationUpdate: {
      topic: "gmail_rule_proposal",
      summary: `enable the ${label} Gmail rule`,
      operations: [
        {
          tool: "gmail.rule.enable_builtin",
          args: { kind },
          status: "valid",
          requiresConfirmation: false
        }
      ]
    }
  };
}

const GMAIL_RULE_KIND_LABEL: Record<Exclude<GmailRuleKind, "other">, string> = {
  job_search: "job-search",
  work_action: "work-action",
  custom: "custom"
};
const GMAIL_RULE_KIND_WATCHES: Record<Exclude<GmailRuleKind, "other">, string> = {
  job_search: "recruiter replies and application updates",
  work_action: "work-related email activity",
  custom: "the sender/keyword you set up"
};
const GMAIL_RULE_KIND_ADAPTER_ID: Record<Exclude<GmailRuleKind, "other">, string> = {
  job_search: "job_search_email",
  work_action: "work_action_email",
  custom: "custom_email_review"
};

/**
 * fix/private-alpha-pending-action-refinement-and-gmail-rule-ux: a real reported gap — "do you
 * use my mail for my goal?" got the exact same generic connection/rule status text as any other
 * Gmail question, technically true (Gmail connected, no rules active, therefore not in use) but
 * incomplete — it never said plainly that Gmail isn't being used FOR THE GOAL yet, and never
 * proposed the one obviously-relevant rule. This composes a direct yes/no answer instead, reusing
 * the exact same goal-relevance data (buildGmailAutonomyState/gmailRecommendationKindForGoal) the
 * rest of this file already computes — never a second, separate classification.
 */
export async function composeGmailGoalUsageStatusReply(
  userId: string,
  context: ContextBundle
): Promise<{ text: string; pendingOperationUpdate?: ExecutedOperation["pendingOperationUpdate"] }> {
  const state = await buildGmailAutonomyState(userId);
  const connection = state.primaryConnection;
  const oauthUrl = gmailOAuthUrlForUser(userId);

  if (!connection || connection.status === "archived") {
    return { text: ["No — Gmail is not connected yet.", ...gmailOAuthActionLines("Connect it here", oauthUrl)].join("\n") };
  }

  if (connection.status === "error") {
    return { text: ["No — " + gmailConnectionProblemLine(connection), ...gmailOAuthActionLines("Reconnect Gmail here", oauthUrl)].join("\n") };
  }

  if (connection.status === "paused") {
    return { text: "No — Gmail is paused right now, so I'm not using it for this goal. Reconnect it to pick tracking back up." };
  }

  const relevantKinds = new Set(
    context.activeGoals
      .map((goal) => gmailRecommendationKindForGoal(goal))
      .filter((kind): kind is Exclude<GmailRuleKind, "other"> => Boolean(kind) && kind !== "other")
  );
  const activeAdapterIds = new Set(state.activeRules.map((rule) => rule.adapterId));
  const coveredKind = [...relevantKinds].find((kind) => activeAdapterIds.has(GMAIL_RULE_KIND_ADAPTER_ID[kind]));

  if (coveredKind) {
    // fix/private-alpha-gmail-evidence-sync-and-review-flow (task 7): "is Gmail on for this
    // goal" and "how often does it actually check" used to only ever appear in TWO separate
    // replies (this one vs. gmail.autonomy.status) — a real audit found this specific "yes"
    // reply never distinguished manual-only from scheduled sync at all, which is exactly the
    // ambiguity between "I track this" and "I actually poll on a schedule" the task's four
    // status states are about. Reuses gmailSyncModeSentence verbatim — the SAME sentence
    // gmail.autonomy.status already shows — rather than composing new wording, so the two can
    // never drift apart on what "scheduled" actually means for this user right now.
    return {
      text: `Yes — Gmail is connected and the ${GMAIL_RULE_KIND_LABEL[coveredKind]} rule is active. I can use readonly email signals like ${GMAIL_RULE_KIND_WATCHES[coveredKind]}. ${gmailSyncModeSentence(state)}`
    };
  }

  const proposal = buildGmailRuleProposal(state);
  return {
    text: [
      "No — Gmail is connected, but I'm not using it for this goal yet because no matching email tracking rule is active.",
      proposal ? `\n${proposal.line}` : undefined
    ]
      .filter(Boolean)
      .join("\n"),
    pendingOperationUpdate: proposal?.pendingOperationUpdate
  };
}

/**
 * feat/private-alpha-capability-proposal-queue: a single post-goal-creation follow-up capability
 * that goal.create_apply can offer, pre-resolved to a real tool+args (Task 2 Rule: "the queue
 * contains already-resolved safe operations, but nothing executes until confirmed" — never raw
 * LLM prose). `numberedDescription` is the fragment used in the queue's numbered list ("2. Gmail
 * support: {numberedDescription}."); `standaloneSummary` is the EXACT existing single-offer reply
 * text, reused verbatim when this ends up being the only proposal this turn (Task 4: "if one
 * proposal, use existing focused confirm copy").
 */
interface CapabilityProposal {
  id: "daily_coaching" | "gmail_support";
  label: string;
  /**
   * fix/private-alpha-launch-hardening-flakes-and-pending-clarity: lowercase natural-language
   * words a selective reply ("only Gmail", "solo coaching") is matched against — carried onto the
   * pendingOperation's own ValidatedOperation.proposalAliases so runtime.ts never needs a
   * hardcoded per-capability keyword table. Adding a third proposal is just a third entry here.
   */
  aliases: string[];
  numberedDescription: string;
  standaloneSummary: string;
  pendingTopic: string;
  pendingSummary: string;
  tool: string;
  args: Record<string, unknown>;
}

type GmailGoalWatcherOfferResult =
  | { kind: "not_connected"; connectSuggestionLine: string }
  | { kind: "already_covered" }
  | { kind: "offer"; proposal: CapabilityProposal }
  | undefined;

/**
 * refactor/private-alpha-goal-driven-gmail-operator: goal.create_apply's chained Gmail offer — the
 * SAME suggestion/coverage logic as gmail.goal_watcher.propose_enable's own executor case (kept
 * here rather than imported from there to avoid a case-to-case dependency; both stay in sync only
 * because they're read from the SAME source of truth, suggestGmailWatcherForGoal). Returns
 * undefined for any goal with no obvious email signal (Task 2 Rule E — never forces Gmail).
 * Returns `{ kind: "not_connected" }` (a plain informational mention, nothing pending) when Gmail
 * isn't connected, and `{ kind: "already_covered" }` when a rule already covers this goal (Task 3
 * Rule: never ask about Gmail twice) — feat/private-alpha-capability-proposal-queue's
 * goal.create_apply reads the `kind` discriminant to decide whether this becomes a real queued
 * proposal, a plain connect mention, or nothing at all.
 */
async function buildGmailGoalWatcherOffer(userId: string, goal: Goal, context: ContextBundle): Promise<GmailGoalWatcherOfferResult> {
  const suggestion = suggestGmailWatcherForGoal(goal);
  if (!suggestion) {
    return undefined;
  }

  const connection = context.gmailConnection;
  if (!connection || connection.status !== "active") {
    const oauthUrl = gmailOAuthUrlForUser(userId);
    return {
      kind: "not_connected",
      connectSuggestionLine: [
        `I can use Gmail readonly for "${goal.title}" to watch for ${suggestion.watchSummary} — connect Gmail and ask me to set it up whenever you're ready.`,
        ...gmailOAuthActionLines("Connect Gmail here", oauthUrl)
      ].join("\n")
    };
  }

  const alreadyCovered = context.gmailRules
    .filter((rule) => rule.status === "active")
    .some((rule) => rule.goalId === goal.id || resolveActiveGoalIdsForGmailRule(rule, context.activeGoals).has(goal.id));
  if (alreadyCovered) {
    return { kind: "already_covered" };
  }

  return {
    kind: "offer",
    proposal: {
      id: "gmail_support",
      label: "Gmail support",
      aliases: ["gmail", "gmail support", "email"],
      numberedDescription: `watch ${suggestion.watchSummary}`,
      standaloneSummary: `I can use Gmail readonly for "${goal.title}" to watch for ${suggestion.watchSummary}. I won't send emails or change labels. Want me to enable that?`,
      pendingTopic: "gmail_goal_watcher",
      pendingSummary: `enable Gmail support for "${goal.title}"`,
      tool: "gmail.goal_watcher.apply_enable",
      args: {
        goalId: goal.id,
        goalTitle: goal.title,
        domain: suggestion.domain,
        label: suggestion.label,
        description: suggestion.description,
        builtInKind: suggestion.builtInKind ?? null
      }
    }
  };
}

/**
 * feat/private-alpha-capability-proposal-queue: goal.create_apply's chained daily-coaching offer —
 * the SAME morning-brief/evening-check-in-missing computation the pre-queue code inlined directly.
 * Returns undefined when both are already on (Task 3 Rule: never ask about daily coaching twice).
 */
async function buildDailyCoachingProposal(userId: string): Promise<CapabilityProposal | undefined> {
  const settings = await getOrCreateNotificationSettings(userId);
  const toEnable: string[] = [];
  const shortLabels: string[] = [];
  if (!settings.morningBriefEnabled) {
    toEnable.push(`Morning brief at ${formatMinutesOfDay(settings.morningTimeMinutes)}`);
    shortLabels.push("morning brief");
  }
  if (!settings.eveningCheckinEnabled) {
    toEnable.push(`Evening check-in at ${formatMinutesOfDay(settings.eveningTimeMinutes)}`);
    shortLabels.push("evening check-in");
  }
  if (toEnable.length === 0) {
    return undefined;
  }

  return {
    id: "daily_coaching",
    label: "Daily coaching",
    aliases: ["daily coaching", "coaching", "daily", "morning brief", "evening check-in", "checkin", "check-in"],
    numberedDescription: shortLabels.join(" and "),
    standaloneSummary: `Next: you're about to turn on:\n${toEnable.map((line) => `- ${line}`).join("\n")}\n\nReply yes to confirm or cancel.`,
    pendingTopic: "proactive_settings",
    pendingSummary: toEnable.map((line) => line.toLowerCase()).join(" and "),
    tool: "proactive.settings_apply_update",
    args: {
      morningBriefEnabled: settings.morningBriefEnabled ? undefined : true,
      eveningCheckinEnabled: settings.eveningCheckinEnabled ? undefined : true
    }
  };
}

/**
 * Task 4 (refactor/private-alpha-goal-driven-gmail-operator — smart goal evolution): called right
 * after a Gmail review approval logs a real event — if that event's signal (a real eventType, or
 * a custom signalKey) isn't among the linked goal's OWN declared targetMetrics, offers to add it,
 * the same chained-pendingOperationUpdate pattern buildGmailGoalWatcherOffer uses. Returns
 * undefined for: no event was created (approval didn't map to a real signal), the rule isn't
 * linked to any goal, the goal no longer resolves, the event carries no identifiable signal, or —
 * the common case — the goal already tracks this exact signal (an ordinary recruiter-reply
 * approval for a job-search goal that already declares that metric never triggers this).
 */
function buildGoalTrackedSignalEvolutionOffer(
  event: StoredEvent | null | undefined,
  emailReview: EmailReviewItem,
  context: ContextBundle
): { summary: string; pendingOperationUpdate?: ExecutedOperation["pendingOperationUpdate"] } | undefined {
  if (!event) {
    return undefined;
  }

  const rule = context.gmailRules.find((candidate) => candidate.id === emailReview.ruleId);
  if (!rule?.goalId) {
    return undefined;
  }

  const goal = context.activeGoals.find((candidate) => candidate.id === rule.goalId);
  if (!goal) {
    return undefined;
  }

  const signalKey = typeof event.data.signalKey === "string" ? event.data.signalKey : undefined;
  const eventType = event.type !== CUSTOM_SIGNAL_EVENT_TYPE ? event.type : undefined;
  if (!eventType && !signalKey) {
    return undefined;
  }

  const alreadyTracked = (goal.targetMetrics ?? []).some(
    (metric) => (eventType && metric.eventType === eventType) || (signalKey && metric.signalKey === signalKey)
  );
  if (alreadyTracked) {
    return undefined;
  }

  const label = eventType ? humanEmailReviewEventLabel(eventType) : (signalKey as string).replace(/_/g, " ");

  return {
    summary: `I found what looks like ${/^[aeiou]/i.test(label) ? "an" : "a"} ${label} — "${goal.title}" doesn't currently track this. Want me to add it as a tracked signal?`,
    pendingOperationUpdate: {
      topic: "goal_tracked_signal",
      summary: `add ${label} as a tracked signal for "${goal.title}"`,
      operations: [
        {
          tool: "goal.add_tracked_signal_apply",
          args: { goalId: goal.id, goalTitle: goal.title, eventType: eventType ?? null, signalKey: signalKey ?? null, label, labelSingular: null },
          status: "valid",
          requiresConfirmation: false
        }
      ]
    }
  };
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
  kind: BuiltInGmailRuleKind,
  activeGoals: Goal[],
  focusedGoalId?: string
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
      summary: [
        `${title} is already on.`,
        "",
        formatBuiltInGmailRuleEnabled(existingActive, resolveLinkedGoalForDisplay(existingActive, activeGoals)),
        gmailRuleEnableReconnectNote(userId, connection)
      ]
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
      summary: [
        `${title} is back on.`,
        "",
        formatBuiltInGmailRuleEnabled(updated, resolveLinkedGoalForDisplay(updated, activeGoals)),
        gmailRuleEnableReconnectNote(userId, connection)
      ]
        .filter(Boolean)
        .join("\n"),
      rule: updated
    };
  }

  // fix/private-alpha-gmail-proactive-highsignal-and-goal-association: the built-in rule is
  // created for the CONNECTION, with no goal named in conversation the way gmail.rule.create
  // requires — so this is the one moment to link it automatically, and only when it's genuinely
  // unambiguous (exactly one active job-search-shaped goal, or the conversation's current focus is
  // one of several). Anything less clear leaves goalId unset — no fake link — and the built-in
  // rule's evidence still surfaces generically via resolveActiveGoalIdsForGmailRule's read-time
  // fallback wherever that matters (morning brief, gmail.status, etc).
  const linkedGoal = kind === "job_search" ? resolveGoalForBuiltInGmailRuleLinking("job_search", activeGoals, focusedGoalId) : undefined;

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
    domain: defaults.domain,
    notifyPolicy: defaults.notifyPolicy,
    createdBy: "user",
    goalId: linkedGoal?.id
  });

  return {
    changed: true,
    summary: [`${title} is on.`, "", formatBuiltInGmailRuleEnabled(rule, linkedGoal), gmailRuleEnableReconnectNote(userId, connection)].filter(Boolean).join("\n"),
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
      minReviewConfidence: 0.7,
      domain: "work",
      // fix/private-alpha-gmail-generic-signal-engine: unchanged behavior, just named — both
      // built-ins were already nudge-eligible (buildGmailNudge in operator/proactive.ts has
      // always been able to surface either one), so "notify" here preserves that exactly rather
      // than silently narrowing it down to "review_only" the way any brand-new custom rule
      // defaults to.
      notifyPolicy: "notify" as const
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
    minReviewConfidence: 0.65,
    domain: "career",
    notifyPolicy: "notify" as const
  };
}

/**
 * Task 10 (fix/private-alpha-gmail-generic-signal-engine): the old status line called every
 * single rule "review-first tracking" — technically wrong for job_search_email, which auto-logs
 * clear signals at high confidence and only reviews the uncertain ones (reviewBeforeLogging:
 * false). Branches on that same real flag every rule already carries, generically, rather than
 * hardcoding per-adapter text.
 */
function gmailRuleTrackingPolicyLabel(rule: EmailSignalRule): string {
  return rule.reviewBeforeLogging ? "review-first tracking" : "auto-logs clear signals, reviews the rest";
}

function resolveLinkedGoalForDisplay(rule: EmailSignalRule, activeGoals: Goal[]): Goal | undefined {
  const goalId = [...resolveActiveGoalIdsForGmailRule(rule, activeGoals)][0];
  return goalId ? activeGoals.find((goal) => goal.id === goalId) : undefined;
}

/** Task 7 (refactor/private-alpha-goal-driven-gmail-operator): what a rule actually watches for,
 * in plain language — the built-ins reuse formatBuiltInGmailRuleEnabled's own exact wording (one
 * source of truth for "what job_search_email/work_action_email watch"), a custom rule uses its
 * own real `description` when present, falling back to its name only for a rule created before
 * that field existed. */
function gmailRuleWatchSummary(rule: EmailSignalRule): string {
  if (rule.adapterId === "job_search_email") {
    return "recruiter replies, application confirmations, interviews, offers, and rejections";
  }
  if (rule.adapterId === "work_action_email") {
    return "work requests, deadlines, follow-ups, feedback requests, and blockers";
  }
  return rule.description || rule.name;
}

/**
 * Task 7 (refactor/private-alpha-goal-driven-gmail-operator): groups active rules by the goal
 * they're linked to (resolveLinkedGoalForDisplay — a stored goalId, or the same read-time
 * single-candidate fallback used everywhere else) — a rule with no resolvable goal link falls
 * into one shared "General Gmail watch" bucket rather than being silently dropped, so a plain
 * custom rule (e.g. one created before any goal existed) still shows up honestly.
 */
function buildGoalFirstGmailSupportLines(
  activeRules: EmailSignalRule[],
  activeGoals: Goal[],
  pendingReviews: EmailReviewItem[],
  // fix/private-alpha-gmail-review-llm-instruction-routing (Task 5): a real reported bug —
  // "gmail status" said "Pending reviews: 1" while "show me the reviews" listed 4, right after a
  // Gmail account switch. gmail.review.list/getEmailReviewItems was never rule-status-filtered —
  // a pending review created by the OLD (now-paused) rule stays fully real and actionable — but
  // this function used to count only reviews tied to a CURRENTLY active rule, silently excluding
  // the switched-away rule's still-pending reviews from the per-goal total. `allRules` (the
  // caller's full, unfiltered rule list — active AND paused/archived) closes that gap: every rule
  // this goal has EVER owned now counts toward its pending total, matching exactly what
  // gmail.review.list itself shows, never silently losing a real pending review from the count.
  allRules: EmailSignalRule[]
): string[] {
  const groupOrder: string[] = [];
  const groups = new Map<string, { label: string; rules: EmailSignalRule[]; countedRuleIds: Set<string> }>();

  for (const rule of activeRules) {
    const linkedGoal = resolveLinkedGoalForDisplay(rule, activeGoals);
    const key = linkedGoal ? linkedGoal.id : "__general__";
    const label = linkedGoal ? linkedGoal.title : "General Gmail watch";
    if (!groups.has(key)) {
      groups.set(key, { label, rules: [], countedRuleIds: new Set() });
      groupOrder.push(key);
    }
    const group = groups.get(key)!;
    group.rules.push(rule);
    group.countedRuleIds.add(rule.id);
  }

  for (const rule of allRules) {
    const linkedGoal = resolveLinkedGoalForDisplay(rule, activeGoals);
    const key = linkedGoal ? linkedGoal.id : "__general__";
    groups.get(key)?.countedRuleIds.add(rule.id);
  }

  const lines = ["", "Gmail support:"];
  for (const key of groupOrder) {
    const group = groups.get(key)!;
    const pendingCount = pendingReviews.filter((review) => group.countedRuleIds.has(review.ruleId)).length;
    const watchSummary = [...new Set(group.rules.map((rule) => gmailRuleWatchSummary(rule)))].join("; ");
    lines.push(`- ${group.label}: on — watches ${watchSummary}${pendingCount > 0 ? ` — ${pendingCount} pending review${pendingCount === 1 ? "" : "s"}` : ""}`);
  }

  return lines;
}

function formatBuiltInGmailRuleEnabled(rule: EmailSignalRule, linkedGoal?: Goal): string {
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
      : "Clear job-search emails can become career events. Offers and interview emails always go to review first — everything else uncertain goes to review too.",
    linkedGoal ? `Linked to your "${linkedGoal.title}" goal.` : undefined,
    "I only scan Gmail while this rule is active.",
    "Sync now: say 'sync Gmail'."
  ].filter((line): line is string => line !== undefined).join("\n");
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
