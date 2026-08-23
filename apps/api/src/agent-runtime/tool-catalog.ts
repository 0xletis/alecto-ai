import { z } from "zod";

export interface ToolDefinition {
  name: string;
  description: string;
  argsSchema: z.ZodTypeAny;
  mutates: boolean;
  /** Mutating tools that don't need a human confirmation round-trip (low blast radius, easily undone). */
  requiresConfirmation: boolean;
}

const actionIdField = z.string().min(1).optional().describe(
  "The id of the action item. Omit if the user is referring to one already visible in context (e.g. 'it', 'that task')."
);

/** One item of a next-week plan draft, as stored in planning.next_week_apply's pending args. Internal shape, never populated by the LLM directly. */
const planSelectionSchema = z.object({
  index: z.number().int().nonnegative(),
  title: z.string().min(1),
  reason: z.string(),
  goalId: z.string().optional(),
  goalTitle: z.string().optional(),
  priority: z.enum(["low", "medium", "high", "critical"]),
  actionPriority: z.enum(["low", "medium", "high"]).optional(),
  suggestedDueAt: z.string().min(1).describe("ISO 8601 date-time."),
  dedupeKey: z.string().optional()
});

export const toolCatalog: ToolDefinition[] = [
  {
    name: "action.list",
    description:
      "List the user's real action items — never a 'remind me before' reminder companion row, which is shown as a short metadata line on its parent action instead, not as its own list entry. Optionally filtered by status, and by overdueOnly for 'do i have any overdue actions', 'what tasks are overdue?' (open, past due only — never future or already-handled items).",
    mutates: false,
    requiresConfirmation: false,
    argsSchema: z.object({
      status: z.enum(["open", "completed", "snoozed", "archived", "all"]).optional(),
      limit: z.number().int().positive().max(50).optional(),
      overdueOnly: z.boolean().optional()
    })
  },
  {
    name: "action.create",
    description: "Create a new manual action/task for the user.",
    mutates: true,
    requiresConfirmation: false,
    argsSchema: z.object({
      title: z.string().min(1),
      notes: z.string().optional(),
      priority: z.enum(["low", "medium", "high"]).optional(),
      dueText: z.string().optional().describe("Natural language due date/time, e.g. 'tomorrow', 'friday at 5pm'.")
    })
  },
  {
    name: "action.snooze",
    description: "Snooze an action item to a later date.",
    mutates: true,
    requiresConfirmation: false,
    argsSchema: z.object({
      actionId: actionIdField,
      untilText: z.string().min(1).describe("Natural language snooze target, e.g. 'tomorrow', 'next monday'.")
    })
  },
  {
    name: "action.complete",
    description:
      "Mark an action item as completed. Use for 'complete it', 'done', 'finished', 'mark it done' (English), 'hecho', 'terminado', 'listo', 'ya lo hice' (Spanish), or 'fet', 'ja està fet', 'ja ho he fet' (Catalan). A bare acknowledgement like this refers to whichever task is currently in view or was just mentioned — omit actionId and let the validator resolve it.",
    mutates: true,
    requiresConfirmation: false,
    argsSchema: z.object({ actionId: actionIdField })
  },
  {
    name: "action.archive",
    description: "Archive an action item (dismiss without completing).",
    mutates: true,
    requiresConfirmation: false,
    argsSchema: z.object({ actionId: actionIdField })
  },
  {
    name: "action.reschedule",
    description:
      "Change an existing action item's due date/time without completing it and without creating a duplicate. Use for corrections like 'brainstorm meeting means 12pm not 12am, change it' or 'move the YouTube task to tomorrow afternoon'. Prefer actionId from visible context; otherwise pass ref using the task's visible wording.",
    mutates: true,
    requiresConfirmation: false,
    argsSchema: z.object({
      actionId: actionIdField,
      ref: z.string().min(1).optional().describe("The task's visible wording if actionId is not known, e.g. 'brainstorm meeting'."),
      dueText: z.string().min(1).optional().describe("A full natural-language due date/time, e.g. 'tomorrow afternoon'."),
      timeText: z.string().min(1).optional().describe("A time-only correction, e.g. '12pm'. Uses the action's existing local date.")
    })
  },
  {
    name: "action.create_pre_due_reminders",
    description:
      "Create real reminder action items due before already-scheduled action items. Use when the user asks 'remind me 30 minutes before each meeting'. This creates Alecto ActionItems that the existing reminder worker can deliver; it does not create calendar events.",
    mutates: true,
    requiresConfirmation: false,
    argsSchema: z.object({
      actionIds: z.array(z.string().min(1)).optional().describe("Action ids to remind about. Omit to use the currently visible meeting-like actions."),
      leadMinutes: z.number().int().nonnegative().max(1440).optional(),
      ref: z.string().min(1).optional().describe("Optional visible wording such as 'meetings' or 'brainstorm'.")
    })
  },
  {
    name: "action.reminder_list",
    description:
      "List only active reminder action items, not every task. Use for 'do I have any reminders on?', 'what reminders are set?', 'show my reminders' (English), '¿qué recordatorios tengo?', 'muéstrame mis recordatorios' (Spanish), or 'quins recordatoris tinc?' (Catalan). Read-only.",
    mutates: false,
    requiresConfirmation: false,
    argsSchema: z.object({})
  },
  {
    name: "action.meeting_list",
    description:
      "List only scheduled meeting-like action items/reminder tasks, with their due times and reminder times if present. Use for 'when are my meetings?' instead of dumping all actions.",
    mutates: false,
    requiresConfirmation: false,
    argsSchema: z.object({})
  },
  {
    name: "action.hygiene_start",
    description:
      "Show the user's action-cleanup candidates (stale/overdue action items worth completing, snoozing, or archiving). Use this for 'clean up my actions', 'help me clean up my tasks', 'what actions should I complete, snooze, or archive?', and similar requests.",
    mutates: false,
    requiresConfirmation: false,
    argsSchema: z.object({})
  },
  {
    name: "action.hygiene_apply",
    description:
      "Apply complete/snooze/archive/keep decisions to one or more actions from the most recently shown action-hygiene cleanup list (from action.hygiene_start). One selection per action the user decided on in this message, e.g. 'complete 1, snooze 2 to Friday, archive 3' becomes three selections.",
    mutates: true,
    requiresConfirmation: false,
    argsSchema: z.object({
      selections: z
        .array(
          z.object({
            index: z
              .number()
              .int()
              .positive()
              .optional()
              .describe("1-based position in the most recently shown action-hygiene list, e.g. 1 for the first item. Preferred way to reference an item."),
            actionId: z
              .string()
              .min(1)
              .optional()
              .describe("Direct action id, only if already known from visible context. Prefer index when a numbered hygiene list is visible."),
            decision: z.enum(["complete", "snooze", "archive", "keep"]).describe("keep means no change — explicitly decided to leave it as is."),
            snoozeUntilText: z
              .string()
              .optional()
              .describe("Natural language snooze target, required when decision is 'snooze', e.g. 'tomorrow', 'friday'.")
          })
        )
        .min(1)
        .max(10)
    })
  },
  {
    name: "planning.next_week_start",
    description:
      "Build and show a draft next-week (or this-week) action plan based on the user's goals, stale actions, and recent activity. Use for 'plan next week', 'help me plan next week', 'make a plan for next week based on my goals', 'plan this week'.",
    mutates: false,
    requiresConfirmation: false,
    argsSchema: z.object({
      windowKind: z.enum(["next_week", "current_week"]).optional().describe("Which week to plan. Defaults to next week if omitted or ambiguous.")
    })
  },
  {
    name: "planning.next_week_edit",
    description:
      "Edit the currently open next-week plan draft (from planning.next_week_start) before it's confirmed. Supports removing/changing items by their 1-based number OR by a natural description of the item (its own title/topic wording), plus a deterministic 'lighter' request that drops lower-priority items. Use for 'remove 2', 'remove the YouTube one', 'change 1 to Tuesday', 'move the gym one to Friday', 'keep job applications and remove the rest', 'make it lighter'. Only works while a plan draft is open.",
    mutates: false,
    requiresConfirmation: false,
    argsSchema: z.object({
      removeIndexes: z
        .array(z.number().int().positive())
        .optional()
        .describe("1-based positions to remove from the current draft, matching the numbers shown there. NEVER 0-based — the first item is 1, not 0. Use when the user gave a number."),
      removeRefs: z
        .array(z.string().min(1))
        .optional()
        .describe("Natural-language descriptions of items to remove, one per item, when the user described them in words instead of numbers — e.g. 'the YouTube one', 'reading', 'the car listings thing'. Use the item's own visible title/topic wording, not a paraphrase."),
      changes: z
        .array(
          z.object({
            index: z.number().int().positive().optional().describe("1-based position of the item to change, matching the numbers shown there (never 0-based). Set this OR ref, not both."),
            ref: z.string().min(1).optional().describe("Natural-language description of the item to change, using its own visible title/topic wording, when the user described it in words. Set this OR index, not both."),
            dueText: z.string().min(1).describe("New natural-language day/time for this item, e.g. 'Tuesday', 'Friday morning'.")
          })
        )
        .optional()
        .describe("Day/time changes to apply."),
      keepIndexes: z
        .array(z.number().int().positive())
        .optional()
        .describe("1-based positions to KEEP; every other visible item is removed. Use for 'keep X and remove the rest' style requests."),
      keepRefs: z
        .array(z.string().min(1))
        .optional()
        .describe("Natural-language descriptions of items to KEEP, using their own visible title/topic wording; every other visible item is removed. Use for 'keep X and remove the rest' style requests."),
      lighter: z
        .boolean()
        .optional()
        .describe("Set true only when the user asked to make the plan lighter/shorter/less (e.g. 'make it lighter'). Code deterministically decides which lower-priority items to drop — do not also set removeIndexes/removeRefs for this request."),
      removeAll: z
        .boolean()
        .optional()
        .describe("Set true ONLY when the user explicitly asked to clear/empty the whole plan (e.g. 'remove everything', 'clear the plan'). Required to let an edit result in zero items — otherwise an edit that would empty the plan is safely rejected instead of silently applied, to guard against an accidental full removal.")
    })
  },
  {
    name: "planning.next_week_show_current",
    description:
      "Show the currently open next-week plan draft again, unchanged — no regeneration, no edits. Use when the user asks to see/view/show the current draft (e.g. 'show me the plan', 'let me see the week plan', \"what's the plan\", 'show current draft') while a draft is open. Never use planning.next_week_start for this — that builds a brand-new draft from scratch and would discard any edits already made. Only works while a plan draft is open.",
    mutates: false,
    requiresConfirmation: false,
    argsSchema: z.object({})
  },
  {
    name: "planning.next_week_apply",
    description:
      "Internal: creates the action items from the current next-week plan draft. This is invoked automatically when the user confirms an open plan draft (e.g. 'yes'); never plan this tool directly.",
    mutates: true,
    requiresConfirmation: false,
    argsSchema: z.object({
      planStartLocalDate: z.string().min(1),
      planWindowKind: z.enum(["next_week", "current_week"]),
      selections: z.array(planSelectionSchema).max(10)
    })
  },
  {
    name: "weekly_review.start",
    description:
      "Build and show a grounded weekly review of the user's actual goals/actions/events/email activity this week — wins, stalls, guardrail activity, and up to 3 recommended next-week focuses, all computed from real data, never invented. Use for 'review my week', 'give me my weekly review', 'how did this week go?', 'what changed this week?' (week-scoped — NOT the same as a bare 'what changed?'/'what did you do?', which means operator.recent_changes instead), 'what should I improve next week?'. Safe to use again to re-show the review — it always reflects real current data.",
    mutates: false,
    requiresConfirmation: false,
    argsSchema: z.object({})
  },
  {
    name: "weekly_review.save",
    description:
      "Internal: saves the currently shown weekly review as a durable memory. This is invoked automatically when the user confirms saving (e.g. 'save this review', 'yes'); never plan this tool directly.",
    mutates: true,
    requiresConfirmation: false,
    argsSchema: z.object({
      weekStartLocalDate: z.string().min(1),
      timezone: z.string().min(1)
    })
  },
  {
    name: "event.log_job_applications",
    description: "Log that the user sent N job applications/CVs.",
    mutates: true,
    requiresConfirmation: false,
    argsSchema: z.object({
      count: z.number().int().positive().max(100),
      notes: z.string().optional()
    })
  },
  {
    name: "event.log_workout",
    description: "Log a completed workout/training session.",
    mutates: true,
    requiresConfirmation: false,
    argsSchema: z.object({
      minutes: z.number().positive().max(1440),
      activity: z.string().optional(),
      notes: z.string().optional()
    })
  },
  {
    name: "event.log_custom_progress",
    description: "Log a free-form progress entry that doesn't fit a specific event type.",
    mutates: true,
    requiresConfirmation: false,
    argsSchema: z.object({
      label: z.string().min(1),
      value: z.string().optional(),
      notes: z.string().optional()
    })
  },
  {
    name: "memory.create",
    description: "Store a durable fact/preference the user asked to be remembered.",
    mutates: true,
    requiresConfirmation: false,
    argsSchema: z.object({
      summary: z.string().min(1),
      type: z
        .enum(["preference", "goal_context", "pattern", "risk_pattern", "communication_style", "important_fact", "note"])
        .optional()
    })
  },
  {
    name: "memory.search",
    description: "Search the user's stored memories by keyword.",
    mutates: false,
    requiresConfirmation: false,
    argsSchema: z.object({
      query: z.string().optional(),
      limit: z.number().int().positive().max(20).optional()
    })
  },
  {
    name: "gmail.status",
    description:
      "Show Gmail connection/setup status and the real connect/reconnect OAuth link when needed. Use for 'connect Gmail', 'connect my email', 'integrate email', 'reconnect Gmail', 'send me the Gmail link', 'send me link to reconnect it' when Gmail is the recent topic, 'Gmail authorization expired', 'fix Gmail', or general Gmail status questions. Read-only; never syncs Gmail.",
    mutates: false,
    requiresConfirmation: false,
    argsSchema: z.object({
      includeLink: z.boolean().optional().describe("Set true when the user asks for the Gmail connect/reconnect link or setup action.")
    })
  },
  {
    name: "gmail.sync",
    description:
      "Run the existing safe manual Gmail sync now, using only active Gmail tracking rules. Use for explicit sync requests like 'sync Gmail', 'sync email', 'check Gmail now', 'check my email now', 'refresh Gmail', or 'look for new emails now'. Never use for Gmail status/setup, Gmail alerts, or rule-list questions.",
    mutates: true,
    requiresConfirmation: false,
    argsSchema: z.object({})
  },
  {
    name: "gmail.sync.debug",
    description:
      "Show the last safe Gmail sync diagnostic summary without running a sync. Use for 'why did Gmail sync find nothing?', 'show Gmail sync debug', or 'sync Gmail debug'. Read-only.",
    mutates: false,
    requiresConfirmation: false,
    argsSchema: z.object({})
  },
  {
    name: "gmail.autonomy.status",
    description:
      "Show whether Gmail checks are manual-only or on a scheduled interval, the interval if scheduled, and whether Gmail alerts (review notifications) are on. Use for 'when do you check Gmail?', 'is Gmail sync scheduled?', 'gmail sync settings', 'how often do you check my email?' (English); '¿cada cuánto miras mi email?', '¿cada cuánto revisas el correo?', 'configuración de sincronización de gmail' (Spanish); '¿cada quant mires el meu email?' (Catalan). This is always a read-only question, never a request to sync now — do NOT plan gmail.sync for it. Never confuse with gmail.rule.list (which shows WHAT is tracked, not HOW OFTEN Gmail itself is checked).",
    mutates: false,
    requiresConfirmation: false,
    argsSchema: z.object({})
  },
  {
    name: "gmail.autonomy.propose_update",
    description:
      "Propose changing HOW OFTEN Alecto checks Gmail in the background — manual-only (only when the user says 'sync Gmail') or scheduled on a real interval via the existing worker poll. Use for 'check Gmail every hour', 'check my email every 1h', 'review my emails every 30 minutes', 'check email sync every 1h', 'make Gmail manual only', 'stop checking Gmail automatically', 'turn off scheduled Gmail sync' (English); 'revisa mi correo cada hora', 'revisa mi email cada 30 minutos', 'pon el correo en manual' (Spanish). This is a GLOBAL Gmail-checking-frequency setting, never a specific named rule — do NOT use gmail.rule.propose_update for this, even though the wording ('check emails', 'review my emails', 'revisa mi correo') sounds similar; gmail.rule.propose_update is only for pausing/resuming/removing ONE specific, already-named tracking rule (e.g. 'pause Work action emails', 'stop tracking Endesa bills'), and the reverse is also true — never use this tool when the user names a specific rule. Opens a pending confirmation; does not mutate anything until confirmed. Never claims instant/webhook delivery — scheduled checks still run on the existing worker's periodic poll.",
    mutates: false,
    requiresConfirmation: false,
    argsSchema: z.object({
      syncMode: z.enum(["manual_only", "scheduled"]),
      intervalMinutes: z
        .number()
        .int()
        .positive()
        .max(24 * 60)
        .optional()
        .describe("Required when syncMode is 'scheduled' — the user's real requested interval in minutes, e.g. 60 for 'every hour', 30 for 'every 30 minutes', 120 for 'every 2 hours'. Omit for manual_only.")
    })
  },
  {
    name: "gmail.autonomy.apply_update",
    description: "Internal: applies the confirmed Gmail sync-frequency change. This is invoked automatically when the user confirms (e.g. 'yes'); never plan this tool directly.",
    mutates: true,
    requiresConfirmation: false,
    argsSchema: z.object({
      connectionId: z.string().min(1),
      syncMode: z.enum(["manual_only", "scheduled"]),
      intervalMinutes: z.number().int().positive().max(24 * 60).optional()
    })
  },
  {
    name: "gmail.rule.list",
    description: "List the user's active Gmail tracking rules.",
    mutates: false,
    requiresConfirmation: false,
    argsSchema: z.object({})
  },
  {
    name: "gmail.rule.create",
    description:
      "Create a new custom, review-first Gmail tracking rule. Matches always go to email review first, never auto-logged, never instant. Optionally links to an active goal and one of that goal's own declared signals, so approving a matching review can log real goal evidence — never invents a link the user didn't ask for.",
    mutates: true,
    requiresConfirmation: true,
    argsSchema: z.object({
      label: z.string().min(1).describe("Short human label for what to track, e.g. 'Endesa bills'."),
      matchHint: z.string().optional().describe("Extra keywords/sender hints to narrow the Gmail search query."),
      goalRef: z
        .string()
        .min(1)
        .optional()
        .describe(
          "The user's own wording for the goal this tracking is for, e.g. 'Endesa under 50', 'my job search' — only when the user actually connected this rule to a goal (e.g. 'track Endesa bills for my electricity goal'). Matched against real active goal titles, never an invented id. Omit if the user didn't reference a goal at all."
        ),
      signalKey: z
        .string()
        .min(1)
        .optional()
        .describe(
          "A CUSTOM signal key the referenced goal (goalRef) already declared in its own targetMetrics — copy it EXACTLY from context.activeGoals[].signals, never invent one. Set this XOR eventType, never both. Omit both if the goal has no signal that clearly matches what this rule tracks — the rule still gets created, just without evidence logging."
        ),
      eventType: z
        .string()
        .min(1)
        .optional()
        .describe(
          "A real, registered event type the referenced goal already declares (visible in context.activeGoals[].signals), e.g. 'career.recruiter_reply_received' — copy it EXACTLY, never invent one. Set this XOR signalKey, never both."
        )
    })
  },
  {
    name: "gmail.rule.enable_builtin",
    description:
      "Enable one of Alecto's built-in Gmail tracking rules. Use only for explicit built-in rule requests like 'enable job search rule' or 'enable work action rule'. Never confuse job search with work action.",
    mutates: true,
    requiresConfirmation: false,
    argsSchema: z.object({
      kind: z.enum(["job_search", "work_action"])
    })
  },
  {
    name: "gmail.rule.explain",
    description: "Explain whether a named Gmail rule exists and what it does.",
    mutates: false,
    requiresConfirmation: false,
    argsSchema: z.object({ label: z.string().min(1) })
  },
  {
    name: "gmail.rule.propose_update",
    description:
      "Propose pausing, resuming, or removing an existing Gmail tracking rule (built-in or custom) — resolves the target by name against the user's real rules (a fresh lookup; the user does not need to have listed rules first) and opens a pending confirmation. Use ONLY when the user clearly names a specific existing rule: 'turn off X', 'pause the X rule', 'resume X', 'delete/remove the X rule', 'stop tracking Endesa bills'. Never use this for a general Gmail-checking-frequency request that doesn't name a rule ('check Gmail every hour', 'review my emails every 1h', 'check email sync every 1h') — that always means gmail.autonomy.propose_update instead, even though both mention 'emails'/'review'. Does NOT support changing an existing rule's review/auto-log behavior — that's fixed when a rule is created and can't be changed afterward; if asked, explain that honestly instead of planning this.",
    mutates: false,
    requiresConfirmation: false,
    argsSchema: z.object({
      ref: z.string().min(1).describe("The rule's name or a distinctive part of it, exactly as the user referred to it (e.g. 'Endesa', 'Naturgy', 'job search'). Never invent an id."),
      operation: z.enum(["pause", "resume", "archive"]).describe("archive means fully remove/delete the rule.")
    })
  },
  {
    name: "gmail.rule.apply_update",
    description:
      "Internal: applies the confirmed Gmail rule change. This is invoked automatically when the user confirms (e.g. 'yes'); never plan this tool directly.",
    mutates: true,
    requiresConfirmation: false,
    argsSchema: z.object({
      ruleId: z.string().min(1),
      ruleName: z.string().min(1),
      operation: z.enum(["pause", "resume", "archive"])
    })
  },
  {
    name: "gmail.review.list",
    description:
      "List pending Gmail email reviews awaiting a decision — shows each item's real subject/sender and a short snippet so the user can reference one naturally afterward (e.g. 'turn the recruiter one into a task'). Use for 'what emails need my attention?', 'what Gmail reviews are waiting?', 'show pending email reviews', 'anything important in Gmail?'.",
    mutates: false,
    requiresConfirmation: false,
    argsSchema: z.object({
      status: z.enum(["pending", "approved", "rejected", "archived", "all"]).optional(),
      limit: z.number().int().positive().max(50).optional()
    })
  },
  {
    name: "gmail.review.reject",
    description:
      "Reject (ignore) a pending Gmail email review item from the most recently shown list — only affects Alecto's own tracking, never the actual mailbox (no email is sent, replied to, archived, or labeled). Use for 'reject the Endesa one', 'ignore the first one', 'ignore that email review', 'ignore 3', 'delete the newsletter' (English); 'borra el 3', 'descarta este correo', 'ignora el de Endesa' (Spanish); 'descarta el 3', 'ignora el de la newsletter' (Catalan). For 'ignore them', 'delete both', 'reject all of them' with no number given, plan ONE gmail.review.reject per currently visible review — never a single call with a vague ref like 'both' or 'them', which cannot resolve to one specific item. Reference each item by `index` (its number in the list) when the user gave a number, or `ref` (its own visible subject/sender/rule wording, e.g. 'Endesa', 'the recruiter one') when they described ONE item in words — never invent a reviewId yourself.",
    mutates: true,
    requiresConfirmation: false,
    argsSchema: z.object({
      reviewId: z.string().min(1).optional().describe("Direct review id, only if already known from context. Prefer index/ref."),
      index: z.number().int().positive().optional().describe("1-based position in the most recently shown Gmail review list."),
      ref: z.string().min(1).optional().describe("The item's own visible wording (subject/sender/rule name) when referenced by words instead of a number.")
    })
  },
  {
    name: "gmail.review.inspect",
    description:
      "Answer a question about one pending Gmail review item from the most recently shown list, using only the stored subject/sender/snippet/evidence. Use for questions like 'does the jobs newsletter one mention frontend developer jobs?', 'what does the second email say?' (English); '¿de qué trata el correo 2?', '¿qué dice el de Endesa?' (Spanish); 'de què va el correu 2?' (Catalan). If only snippet/evidence is stored, say that limitation instead of inventing details.",
    mutates: false,
    requiresConfirmation: false,
    argsSchema: z.object({
      reviewId: z.string().min(1).optional().describe("Direct review id, only if already known from context. Prefer index/ref."),
      index: z.number().int().positive().optional().describe("1-based position in the most recently shown Gmail review list."),
      ref: z.string().min(1).optional().describe("The item's visible wording, e.g. 'jobs newsletter'."),
      question: z.string().min(1).optional().describe("The user's exact question about the review.")
    })
  },
  {
    name: "gmail.review.to_action",
    description:
      "Convert a pending Gmail email review item into an action item, grounded in that email's real subject/content — never invents a task. Use for 'turn the recruiter one into a task', 'make the recruiter email an action', 'create an action from the email about X', 'convert 2 into a task for tomorrow' (English); 'convierte el 2 en tarea para mañana', 'haz una tarea del correo de Endesa' (Spanish); \"fes-ne una tasca per demà al matí\", 'fes una tasca del 2 per demà al matí' (Catalan). If the user asks for a due time, pass their exact timing phrase as dueText (e.g. '5 minutes from now', 'tomorrow morning', 'para mañana', 'per demà al matí'); if they say 'at the time it says in the email', omit dueText and the executor will parse the stored email snippet/evidence. If they ask for a reminder before it, set reminderLeadMinutes. If they ask to be reminded 'at that time' or 'at the same time' as the due time, set reminderLeadMinutes: 0. Reference the item by `index` (its number in the list) when the user gave a number, or `ref` (its own visible subject/sender/rule wording) when they described it in words — never invent a reviewId yourself.",
    mutates: true,
    requiresConfirmation: false,
    argsSchema: z.object({
      reviewId: z.string().min(1).optional().describe("Direct review id, only if already known from context. Prefer index/ref."),
      index: z.number().int().positive().optional().describe("1-based position in the most recently shown Gmail review list."),
      ref: z.string().min(1).optional().describe("The item's own visible wording (subject/sender/rule name) when referenced by words instead of a number."),
      dueText: z.string().min(1).optional().describe("Natural-language due time requested by the user, e.g. '5 minutes from now', 'tomorrow morning', 'tomorrow afternoon', 'next Monday'."),
      reminderLeadMinutes: z.number().int().nonnegative().max(1440).optional().describe("Lead time for a real reminder ActionItem, e.g. 30 for 'remind me 30 minutes before', or 0 for 'remind me at that time'.")
    })
  },
  {
    name: "gmail.review.keep",
    description:
      "Keep a pending Gmail email review item in review for later. This is a deliberate no-op decision for phrases like 'keep 4 in review for later', 'leave that one for later', 'keep both in review', 'keep them there for now', 'keep all of them pending' (English); 'deja los dos para luego', 'mantén ambos en revisión', 'déjalo para después' (Spanish); \"deixa'ls per després\" (Catalan). For a PLURAL reference ('them', 'both', 'all', 'los dos', 'ambos') with no specific number, plan ONE gmail.review.keep per currently visible review — never a single call with a vague ref like 'both', which cannot resolve to one specific item and would wrongly ask for clarification when the user's intent was already unambiguous. It must not create an action, event, memory, or Gmail mailbox change.",
    mutates: false,
    requiresConfirmation: false,
    argsSchema: z.object({
      reviewId: z.string().min(1).optional().describe("Direct review id, only if already known from context. Prefer index/ref."),
      index: z.number().int().positive().optional().describe("1-based position in the most recently shown Gmail review list."),
      ref: z.string().min(1).optional().describe("The item's own visible wording (subject/sender/rule name) when referenced by words instead of a number.")
    })
  },
  {
    name: "gmail.review.approve",
    description:
      "Approve a pending Gmail email review item the way its OWN classification already recommends — creates an action if it was classified as a work action, logs a real event (e.g. a recruiter reply, an interview, a rejection) if it was classified as a specific already-known event type, or just marks it reviewed if neither applies. Grounded entirely in that review's own pre-existing classification — never invents an event or action type itself. Use for 'approve the recruiter one', 'log that reply', 'track that email', 'approve 2', or any 'handle this the right way' request that is NOT explicitly asking to force it into a task (use gmail.review.to_action for that instead). Reference the item by `index` (its number in the list) when the user gave a number, or `ref` (its own visible subject/sender/rule wording) when they described it in words — never invent a reviewId yourself.",
    mutates: true,
    requiresConfirmation: false,
    argsSchema: z.object({
      reviewId: z.string().min(1).optional().describe("Direct review id, only if already known from context. Prefer index/ref."),
      index: z.number().int().positive().optional().describe("1-based position in the most recently shown Gmail review list."),
      ref: z.string().min(1).optional().describe("The item's own visible wording (subject/sender/rule name) when referenced by words instead of a number.")
    })
  },
  {
    name: "goal.list",
    description:
      "List the user's real active goals with title/category/priority/why. Use for 'what are my goals?', 'show my active goals', 'what am I working on?', 'which goals are active?', 'why did I set the X goal?'. Read-only — never creates, updates, or deletes a goal, and never invents or guesses a goal's details.",
    mutates: false,
    requiresConfirmation: false,
    argsSchema: z.object({})
  },
  {
    name: "goal.log_evidence",
    description:
      "Log a real, grounded event that counts as evidence toward whichever active goal declares it (a goal's own targetMetrics — set when the goal was created — decide the link; this never guesses). Works for any goal category, not just career/job-search. Use event.log_job_applications instead for 'sent N CVs/applications' and event.log_workout for training sessions. Set EITHER eventType (a registered event type that some active goal's targetMetrics already declares — e.g. 'career.recruiter_reply_received', or 'learning.reading_session_completed' for a reading goal; visible from goal.tracking_show) OR signalKey (a CUSTOM per-goal signal key, e.g. 'tea_cups_drunk', 'called_grandmother' — only use a signalKey that is one of the user's OWN active goals' declared custom signals, visible from goal.tracking_show or the goal's own creation; never invent one). If goalRef is omitted and more than one active goal could plausibly own this signal, this asks which goal instead of guessing. Examples: 'got 2 recruiter replies' (eventType career.recruiter_reply_received, count 2), 'I have an interview tomorrow' (eventType career.interview_scheduled — also consider planning action.create for the interview itself if a date was given), 'got rejected by Acme' (eventType career.rejection_received, notes 'Acme'), 'had 2 teas today' for a goal that declared a 'tea_cups_drunk' signal (signalKey 'tea_cups_drunk', count 2), 'read 5 minutes' for a reading goal that declared 'learning.reading_session_completed' or a custom 'reading_minutes' signal. Never invent a signal the user didn't actually describe, and never invent an eventType that isn't a real registered event type.",
    mutates: true,
    requiresConfirmation: false,
    argsSchema: z.object({
      eventType: z
        .string()
        .min(1)
        .optional()
        .describe("A real registered event type (e.g. 'career.recruiter_reply_received', 'learning.reading_session_completed') that some active goal already declares as one of its own targetMetrics — never invented, never guessed."),
      signalKey: z.string().min(1).optional().describe("A CUSTOM signal key an active goal already declared for itself — never invented, never a fixed eventType's own name."),
      goalRef: z.string().min(1).optional().describe("The goal's own wording as the user referred to it, when it matters for disambiguation (e.g. more than one active goal could own this signal). Matched against real active goal titles/categories, never an invented id. Omit if only one goal could plausibly own this signal."),
      count: z
        .number()
        .int()
        .positive()
        .max(1000)
        .optional()
        .describe(
          "Defaults to 1. Set to the user's own explicit count, e.g. 'got 2 recruiter replies' -> 2, 'had 2 teas' -> 2, 'read 30 minutes' -> 30 — this is a plain count of whatever unit the signal is in (replies, cups, minutes, pages, ...), not capped to a handful."
        ),
      notes: z.string().optional().describe("Free-text detail actually stated by the user, e.g. a company name — never invented.")
    })
  },
  {
    name: "goal.status",
    description:
      "Grounded progress summary for one active goal (or all active goals if none is clearly named) — real open actions linked to it, real recent evidence counted toward EACH of its declared signals (fixed or custom), and real pending Gmail reviews linked to it. Never invents counts or progress. If goalRef could plausibly mean more than one active goal, this asks which one instead of silently picking or falling back to a generic same-category goal. Use for 'how is my job search going?', 'job search status', 'what did I do this week for jobs?', 'how many CVs did I send today?', or the equivalent for any other active goal (e.g. 'how's training going?', 'how's the tea goal going?', 'how's my Nietzsche book going?').",
    mutates: false,
    requiresConfirmation: false,
    argsSchema: z.object({
      goalRef: z.string().min(1).optional().describe("The goal's own wording as the user referred to it (e.g. 'job search', 'training', 'Endesa bills', 'tea') — matched against real active goal titles/categories, never an invented id. Omit if the user didn't name a specific goal.")
    })
  },
  {
    name: "goal.create_propose",
    description:
      "Propose a full custom operating plan for a NEW goal the user just expressed — never applies anything until the user confirms. Works for ANY goal, not from a fixed list: 'I want to drink more tea', 'I want to call my grandmother every Sunday', 'I want to stop scrolling in bed', 'I want to keep up with Endesa/admin emails', 'I want to build Alecto every day' are all equally valid. You (the planner) choose: a short title, a category (free text, e.g. 'health', 'family', 'admin', 'habit', 'career' — never limited to a fixed enum), why if the user said one, optional successCriteria in the user's own terms (e.g. '2 cups/day, 5 days/week'), 1-3 trackable signals (each a short stable snake_case key like 'tea_cups_drunk' plus a human label — invent a REASONABLE key/label from the goal, never leave this empty), an optional single check-in suggestion, an optional integration hint (e.g. 'Gmail: Endesa emails' — only when genuinely relevant, e.g. an admin/bills goal), and 0-3 first actions genuinely implied by the goal. If the goal is too vague to propose anything concrete (e.g. just 'I want to be better'), do NOT call this — use clarification.ask instead to find out what they actually mean. Never create the goal directly; this only proposes, and only proactive.settings_propose_update-style confirmation (an exact 'yes') can turn it into a real goal via the internal goal.create_apply.",
    mutates: false,
    requiresConfirmation: false,
    argsSchema: z.object({
      title: z.string().min(1),
      category: z.string().min(1),
      why: z.string().optional().describe("Only if the user actually said why — never invented."),
      successCriteria: z.string().optional().describe("Concrete target in the user's own terms, e.g. '2 cups/day, 5 days/week'. Omit if genuinely unclear."),
      signals: z
        .array(
          z.object({
            key: z.string().min(1).describe("Short, stable snake_case identifier, e.g. 'tea_cups_drunk'. Must be unique to this goal."),
            label: z.string().min(1).describe("Human label, e.g. 'cups of tea drunk'."),
            unit: z.string().optional(),
            cadence: z.enum(["daily", "weekly"]).optional()
          })
        )
        .min(1)
        .max(5),
      checkIn: z
        .object({
          cadence: z.string().min(1).describe("e.g. 'evening', 'morning', 'weekly'."),
          question: z.string().min(1)
        })
        .optional(),
      integrationHint: z.string().optional().describe("Only when a real, existing integration is genuinely relevant, e.g. 'Gmail: track Endesa emails' — never claim automatic monitoring that isn't wired up."),
      firstActions: z.array(z.string().min(1)).max(3).optional().describe("Only actions genuinely implied by the goal itself, e.g. 'Buy tea' for a tea goal — never generic filler.")
    })
  },
  {
    name: "goal.create_apply",
    description: "Internal: creates the confirmed goal and its tracking config exactly as proposed. This is invoked automatically when the user confirms (e.g. 'yes'); never plan this tool directly.",
    mutates: true,
    requiresConfirmation: false,
    argsSchema: z.object({
      title: z.string().min(1),
      category: z.string().min(1),
      why: z.string().optional(),
      signals: z.array(z.object({ key: z.string().min(1), label: z.string().min(1), unit: z.string().optional(), cadence: z.enum(["daily", "weekly"]).optional() })),
      checkIn: z.object({ cadence: z.string().min(1), question: z.string().min(1) }).optional(),
      firstActions: z.array(z.string().min(1)).optional()
    })
  },
  {
    name: "goal.tracking_show",
    description:
      "Show what is actually configured for one active goal — its declared signals (with their real keys, so goal.log_evidence can be used correctly), check-in cadence, and why — never its progress (use goal.status for that). If goalRef could plausibly mean more than one active goal, this asks which one instead of silently picking. Use for 'what am I tracking for the tea goal?', 'what signals does my job search goal have?', 'show my goal setup for X', 'show tracking for my Nietzsche book'.",
    mutates: false,
    requiresConfirmation: false,
    argsSchema: z.object({
      goalRef: z.string().min(1).optional().describe("The goal's own wording — matched the same way goal.status matches it. Omit if the user didn't name a specific goal.")
    })
  },
  {
    name: "goal.archive_propose",
    description:
      "Propose archiving (making inactive, history kept) or pausing (temporarily inactive, resumable) one active goal — opens a pending confirmation, never applies until an exact 'yes'. Use for 'archive this goal', 'stop tracking this goal', 'delete this goal', 'remove this goal', 'I don't want to track Meditations anymore' (English); 'deja de seguir este objetivo', 'elimina este objetivo' (Spanish, operation archive); 'pausa este objetivo', 'pause this goal' (operation pause). 'Delete'/'remove'/'elimina' wording is honored as intent to archive (Alecto never permanently deletes goal history) — the tool's own response corrects the framing honestly, never silently reinterprets it as something else. goalRef is the goal's own wording as the user referred to it (a title, or a bare pronoun like 'this goal' right after it was shown/discussed) — matched the same way goal.status matches it, including 'this goal' resolving to whichever goal the conversation is currently focused on. If it could plausibly mean more than one active goal, or matches none, this asks/says so instead of guessing — never plan goal.archive_apply directly to force a target.",
    mutates: false,
    requiresConfirmation: false,
    argsSchema: z.object({
      goalRef: z.string().min(1).optional().describe("The goal's own wording, e.g. 'Meditations', 'this goal', 'my reading goal'. Never an invented id."),
      operation: z.enum(["archive", "pause"]).describe("archive = inactive, history kept, not resumable through chat today. pause = temporarily inactive, resumable via 'resume this goal'.")
    })
  },
  {
    name: "goal.archive_apply",
    description: "Internal: applies the confirmed goal archive/pause. This is invoked automatically when the user confirms (e.g. 'yes'); never plan this tool directly.",
    mutates: true,
    requiresConfirmation: false,
    argsSchema: z.object({
      goalId: z.string().min(1),
      goalTitle: z.string().min(1),
      operation: z.enum(["archive", "pause", "resume"])
    })
  },
  {
    name: "proactive.settings_show",
    description:
      "Show which automatic messages (morning brief, evening check-in, Gmail alerts) are currently on/off for the user, including their scheduled time when on. Use for 'what proactive messages are on?', 'is the morning brief on?', 'am I getting evening check-ins?', 'are Gmail alerts on?'.",
    mutates: false,
    requiresConfirmation: false,
    argsSchema: z.object({})
  },
  {
    name: "proactive.settings_propose_update",
    description:
      "Propose turning the morning brief / evening check-in / Gmail alerts on or off, and/or changing the morning-brief or evening-check-in time — shows what would change and opens a pending confirmation. Use for 'turn on morning briefs', 'stop morning briefs', 'check in every evening', 'stop evening check-ins', 'turn on Gmail alerts', 'stop Gmail alerts', 'tell me when important emails arrive', 'avísame de correos importantes'. For a combined request like 'set up a morning brief at 9am', 'schedule morning brief at 9', 'can you set a morning brief for 8am', set BOTH morningBriefEnabled: true AND morningTimeText — this turns it on AND sets the time in one proposal. For a time-only request like 'move morning brief to 9', 'change morning brief time to 9', set ONLY morningTimeText — do not also set morningBriefEnabled unless the user is actually asking to turn it on/off. Set only the field(s) actually being changed. Never enables anything by itself — the user must still confirm.",
    mutates: false,
    requiresConfirmation: false,
    argsSchema: z.object({
      morningBriefEnabled: z.boolean().optional().describe("Set true to turn the proactive morning brief on, false to turn it off."),
      eveningCheckinEnabled: z.boolean().optional().describe("Set true to turn the proactive evening check-in on, false to turn it off."),
      gmailNudgeEnabled: z.boolean().optional().describe("Internal field: set true to turn proactive Gmail/email alerts on, false to turn them off."),
      morningTimeText: z.string().optional().describe("New natural-language time for the morning brief, e.g. '9am', '01:06'. Setting this alone does NOT turn the morning brief on — also set morningBriefEnabled: true if the user wants it turned on."),
      eveningTimeText: z.string().optional().describe("New natural-language time for the evening check-in, e.g. '9:30pm', '21:30'. Setting this alone does NOT turn the evening check-in on.")
    })
  },
  {
    name: "proactive.settings_apply_update",
    description:
      "Internal: applies the confirmed proactive settings change. This is invoked automatically when the user confirms (e.g. 'yes'); never plan this tool directly.",
    mutates: true,
    requiresConfirmation: false,
    argsSchema: z.object({
      morningBriefEnabled: z.boolean().optional(),
      eveningCheckinEnabled: z.boolean().optional(),
      gmailNudgeEnabled: z.boolean().optional(),
      morningTimeMinutes: z.number().int().min(0).max(1439).optional(),
      eveningTimeMinutes: z.number().int().min(0).max(1439).optional()
    })
  },
  {
    name: "proactive.diagnose_morning_brief",
    description:
      "Diagnose why the proactive morning brief did or didn't (or won't) send — grounded in real settings and delivery state, never a generic settings summary. Use for 'why didn't I get my morning brief?', 'it's 9 and no morning brief', 'I didn't get the morning brief', 'where is my morning brief?'. Read-only.",
    mutates: false,
    requiresConfirmation: false,
    argsSchema: z.object({})
  },
  {
    name: "proactive.diagnose_evening_checkin",
    description:
      "Diagnose why the proactive evening check-in did or didn't (or won't) send — grounded in real settings and delivery state, never a generic settings summary. Use for 'why didn't you check in last night?', 'no evening check-in', 'it's 9pm and no check-in', 'where is my evening check-in?'. Read-only.",
    mutates: false,
    requiresConfirmation: false,
    argsSchema: z.object({})
  },
  {
    name: "operator.today",
    description: "Summarize what's on for today: open/due actions, active goals, today's logged progress.",
    mutates: false,
    requiresConfirmation: false,
    argsSchema: z.object({})
  },
  {
    name: "operator.recent_changes",
    description: "Summarize recent mutations this runtime has made in the current conversation.",
    mutates: false,
    requiresConfirmation: false,
    argsSchema: z.object({})
  },
  {
    name: "daily_loop.settings_show",
    description:
      "Show the user's current LEGACY daily-loop settings: whether it's on, and its start-day/end-day times. This is the older daily-loop feature, distinct from the V3 proactive morning brief (proactive.settings_show) — 'morning brief' on its own means the V3 proactive moment; only use this tool for explicit daily-loop language: 'what are my daily loop settings?', 'when is my daily review?', 'is the daily loop on?'.",
    mutates: false,
    requiresConfirmation: false,
    argsSchema: z.object({})
  },
  {
    name: "daily_loop.settings_propose_update",
    description:
      "Propose turning the LEGACY daily loop on/off and/or changing its start-day or end-day time — shows what would change and opens a pending confirmation. This is the older daily-loop feature, distinct from the V3 proactive morning brief (proactive.settings_propose_update) — only use this tool for explicit daily-loop language: 'turn off daily review', 'turn daily check-ins back on', 'set my daily review to mornings', 'remind me every evening to review the day', 'change my daily loop start time to 9am'. Plain 'morning brief' language ('set up a morning brief at 9', 'move my morning brief to 9', 'turn on morning briefs') always means the V3 proactive moment — use proactive.settings_propose_update for that instead, even if the wording resembles a time change. Set only the field(s) the user is actually asking to change. Does NOT support anything beyond on/off + the two times (e.g. delivery channel, default action reminder time, weekly insight day) — those aren't supported; explain that honestly instead of planning this.",
    mutates: false,
    requiresConfirmation: false,
    argsSchema: z.object({
      enabled: z.boolean().optional().describe("Set true to turn the legacy daily loop on, false to turn it off."),
      morningTimeText: z.string().optional().describe("New natural-language start-day time for the LEGACY daily loop, e.g. '9am', '09:00'. Do not use this for plain 'morning brief' requests — those mean the V3 proactive moment (proactive.settings_propose_update's morningTimeText) instead."),
      eveningTimeText: z.string().optional().describe("New natural-language end-day time for the LEGACY daily loop, e.g. '9:30pm', '21:30'.")
    })
  },
  {
    name: "daily_loop.settings_apply_update",
    description:
      "Internal: applies the confirmed daily-loop settings change. This is invoked automatically when the user confirms (e.g. 'yes'); never plan this tool directly.",
    mutates: true,
    requiresConfirmation: false,
    argsSchema: z.object({
      enabled: z.boolean().optional(),
      morningTimeMinutes: z.number().int().min(0).max(1439).optional(),
      eveningTimeMinutes: z.number().int().min(0).max(1439).optional()
    })
  },
  {
    name: "confirmation.confirm",
    description: "The user confirmed the currently pending operation(s).",
    mutates: false,
    requiresConfirmation: false,
    argsSchema: z.object({})
  },
  {
    name: "confirmation.cancel",
    description: "The user declined/cancelled the currently pending operation(s).",
    mutates: false,
    requiresConfirmation: false,
    argsSchema: z.object({})
  },
  {
    name: "clarification.ask",
    description: "Ask the user a clarifying question instead of acting, because the request is ambiguous or underspecified.",
    mutates: false,
    requiresConfirmation: false,
    argsSchema: z.object({ question: z.string().min(1) })
  }
];

export const toolNames = toolCatalog.map((tool) => tool.name);

export function getToolDefinition(name: string): ToolDefinition | undefined {
  return toolCatalog.find((tool) => tool.name === name);
}

export function toolCatalogPromptSummary(): string {
  return toolCatalog
    .map((tool) => `- ${tool.name}: ${tool.description} args shape: ${describeArgsShape(tool.argsSchema)}`)
    .join("\n");
}

/**
 * A real JSON Schema (not prose) for a tool's args, shaped for OpenAI
 * Structured Outputs' strict mode: every property is listed in `required`,
 * and optionality is modeled via a nullable type rather than omission —
 * strict mode does not allow omitting a declared property.
 */
export function toolArgsPlannerJsonSchema(tool: ToolDefinition): Record<string, unknown> {
  if (!(tool.argsSchema instanceof z.ZodObject)) {
    return { type: "object", additionalProperties: false, properties: {}, required: [] };
  }

  return zodObjectToPlannerJsonSchema(tool.argsSchema);
}

/**
 * Recursively builds a JSON Schema for a ZodObject's fields, shaped for
 * OpenAI Structured Outputs' strict mode (every property listed in
 * `required`, optionality modeled via a nullable type). Used both for a
 * tool's top-level args and for nested object shapes inside an array field
 * (e.g. action.hygiene_apply's `selections`).
 */
function zodObjectToPlannerJsonSchema(schema: z.ZodObject<Record<string, z.ZodTypeAny>>): Record<string, unknown> {
  const shape = schema.shape as Record<string, z.ZodTypeAny>;
  const keys = Object.keys(shape);
  const properties: Record<string, unknown> = {};

  for (const key of keys) {
    properties[key] = zodFieldToPlannerJsonSchema(shape[key]);
  }

  return { type: "object", additionalProperties: false, properties, required: keys };
}

/**
 * Builds the JSON Schema node for one field, then layers on a `description`
 * (from zod's `.describe()`, if set) so the LLM actually sees the field's
 * guidance — e.g. "1-based ... never 0-based" — rather than only a bare
 * `{type: "number"}`. Every branch below must also encode `optional` into
 * the type (adding `"null"`), matching OpenAI Structured Outputs' strict
 * mode, which requires every property to be listed in `required` and models
 * optionality via a nullable type instead of omission — a field that is
 * `.optional()` but whose JSON type doesn't allow `null` leaves the LLM with
 * no schema-valid way to say "not set" (it was previously missing on the
 * array branch, which could make an optional array field like
 * planning.next_week_edit's `changes` behave unpredictably).
 */
function zodFieldToPlannerJsonSchema(field: z.ZodTypeAny): Record<string, unknown> {
  const optional = field.isOptional();
  const inner = unwrapOptional(field);
  const description = field.description ?? inner.description;

  let schema: Record<string, unknown>;

  if (inner instanceof z.ZodArray) {
    const element = inner.element as z.ZodTypeAny;
    const items = element instanceof z.ZodObject ? zodObjectToPlannerJsonSchema(element) : zodFieldToPlannerJsonSchema(element);
    schema = optional ? { type: ["array", "null"], items } : { type: "array", items };
  } else if (inner instanceof z.ZodObject) {
    // A real, separate latent bug found while adding tests for the tool/args discriminated-union
    // fix: unlike every other branch here, this one never modeled `optional` at all — an OPTIONAL
    // object field (e.g. goal.create_propose's `checkIn`) was emitted as plain `{type: "object"}`,
    // never `["object", "null"]`, so OpenAI's strict mode (which requires every property in
    // `required` and models optionality via nullability, never omission) left the model with NO
    // schema-valid way to actually omit it — it was structurally FORCED to invent a checkIn object
    // on every single goal.create_propose call, contradicting the tool's own "optional single
    // check-in suggestion" description. Fixed the same way every other branch already does it.
    const objectSchema = zodObjectToPlannerJsonSchema(inner);
    schema = optional ? { ...objectSchema, type: ["object", "null"] } : objectSchema;
  } else if (inner instanceof z.ZodEnum) {
    const values = inner.options as string[];
    schema = optional ? { type: ["string", "null"], enum: [...values, null] } : { type: "string", enum: values };
  } else if (inner instanceof z.ZodNumber) {
    schema = optional ? { type: ["number", "null"] } : { type: "number" };
  } else if (inner instanceof z.ZodBoolean) {
    schema = optional ? { type: ["boolean", "null"] } : { type: "boolean" };
  } else {
    schema = optional ? { type: ["string", "null"] } : { type: "string" };
  }

  return description ? { ...schema, description } : schema;
}

function unwrapOptional(schema: z.ZodTypeAny): z.ZodTypeAny {
  return schema instanceof z.ZodOptional ? schema.unwrap() : schema;
}

function describeArgsShape(schema: z.ZodTypeAny): string {
  if (!(schema instanceof z.ZodObject)) {
    return "{}";
  }

  const shape = schema.shape as Record<string, z.ZodTypeAny>;
  const keys = Object.keys(shape);

  if (keys.length === 0) {
    return "{}";
  }

  const fields = keys.map((key) => `${key}${shape[key].isOptional() ? "?" : ""}: ${describeZodType(shape[key])}`);
  return `{ ${fields.join(", ")} }`;
}

function describeZodType(schema: z.ZodTypeAny): string {
  const inner = schema.isOptional() && "unwrap" in schema && typeof (schema as { unwrap?: () => z.ZodTypeAny }).unwrap === "function"
    ? (schema as unknown as { unwrap: () => z.ZodTypeAny }).unwrap()
    : schema;

  if (inner instanceof z.ZodEnum) {
    return inner.options.map((option: string) => `"${option}"`).join("|");
  }
  if (inner instanceof z.ZodNumber) {
    return "number";
  }
  if (inner instanceof z.ZodBoolean) {
    return "boolean";
  }
  if (inner instanceof z.ZodArray) {
    return `${describeZodType(inner.element as z.ZodTypeAny)}[]`;
  }
  if (inner instanceof z.ZodObject) {
    return describeArgsShape(inner);
  }
  return "string";
}
