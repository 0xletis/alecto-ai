import {
  approveEmailReviewItem,
  archiveActionItem,
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
  rejectEmailReviewItem,
  snoozeActionItem,
  type ActionItem,
  type EmailReviewItem,
  type EmailSignalRule
} from "@operator-agent/db";
import { parseActionDueDate } from "@operator-agent/core";
import type { AgentEntity, ContextBundle, ExecutedOperation, ValidatedOperation } from "./types.js";

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
              ? "No matching memories."
              : `I remembered: ${limited.map((memory) => memory.summary).join("; ")}.`,
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
        return {
          tool: operation.tool,
          status: "executed",
          summary:
            rules.length === 0
              ? "No active Gmail rules."
              : `${rules.length} active Gmail rule(s): ${rules.map((rule) => `"${rule.name}"`).join(", ")}.`,
          result: rules,
          entities: rules.map(gmailRuleToEntity)
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

        const existing = (await getEmailSignalRules(userId)).find(
          (rule) => rule.status === "active" && rule.adapterId === "custom_email_review" && normalize(rule.name) === normalize(label)
        );
        if (existing) {
          return {
            tool: operation.tool,
            status: "executed",
            summary: `${existing.name} tracking is already on. Matches go to email review before anything is logged.`,
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

      case "gmail.review.list": {
        const status = (args.status as EmailReviewItem["status"] | "all" | undefined) ?? "pending";
        const items = await getEmailReviewItems(userId, { status, limit: (args.limit as number | undefined) ?? 10 });
        return {
          tool: operation.tool,
          status: "executed",
          summary: items.length === 0 ? "No matching email reviews." : `${items.length} email review(s).`,
          result: items,
          entities: items.map(reviewToEntity)
        };
      }

      case "gmail.review.reject": {
        const updated = await rejectEmailReviewItem(userId, args.reviewId as string);
        if (!updated) return failed(operation.tool, "That email review no longer exists or was already decided.");
        return { tool: operation.tool, status: "executed", summary: "Rejected the email review.", result: updated };
      }

      case "gmail.review.to_action": {
        const reviewId = args.reviewId as string;
        const reviews = await getEmailReviewItems(userId, { status: "pending", limit: 50 });
        const review = reviews.find((item) => item.id === reviewId);
        if (!review) return failed(operation.tool, "That email review no longer exists or was already decided.");

        const { actionItem } = await createActionItemIfNotExists(userId, {
          source: "email_review",
          sourceId: review.id,
          title: review.subject ?? "Follow up from email",
          description: review.snippet,
          priority: "medium",
          evidence: review.evidence
        });
        await approveEmailReviewItem(userId, review.id, undefined, actionItem.id);
        return {
          tool: operation.tool,
          status: "executed",
          summary: `Turned the email review into task "${actionItem.title}".`,
          result: actionItem,
          entities: [actionToEntity(actionItem)]
        };
      }

      case "operator.today": {
        const dueToday = context.openActions.filter((action) => action.dueAt && isToday(action.dueAt));
        const summary = [
          `${context.openActions.length} open task(s), ${dueToday.length} due today.`,
          `${context.activeGoals.length} active goal(s).`,
          `${context.gmailReviews.length} pending Gmail review(s).`
        ].join(" ");
        return { tool: operation.tool, status: "executed", summary, result: { dueToday, openActions: context.openActions } };
      }

      case "operator.recent_changes": {
        const mutations = context.session.recentMutations;
        return {
          tool: operation.tool,
          status: "executed",
          summary: mutations.length === 0 ? "Nothing has changed yet in this conversation." : mutations.map((m) => m.summary).join("; "),
          result: mutations
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

function gmailRuleToEntity(rule: EmailSignalRule): AgentEntity {
  return { type: "gmail_rule", id: rule.id, label: rule.name };
}

function reviewToEntity(review: EmailReviewItem): AgentEntity {
  return { type: "gmail_review", id: review.id, label: review.subject ?? review.from ?? review.id };
}
