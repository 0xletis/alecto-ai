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
    description: "List the user's action items (open tasks/reminders), optionally filtered by status.",
    mutates: false,
    requiresConfirmation: false,
    argsSchema: z.object({
      status: z.enum(["open", "completed", "snoozed", "archived", "all"]).optional(),
      limit: z.number().int().positive().max(50).optional()
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
    description: "Mark an action item as completed.",
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
    description: "Report whether Gmail is connected and its sync status.",
    mutates: false,
    requiresConfirmation: false,
    argsSchema: z.object({})
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
      "Create a new custom, review-first Gmail tracking rule. Matches always go to email review first, never auto-logged, never instant.",
    mutates: true,
    requiresConfirmation: true,
    argsSchema: z.object({
      label: z.string().min(1).describe("Short human label for what to track, e.g. 'Endesa bills'."),
      matchHint: z.string().optional().describe("Extra keywords/sender hints to narrow the Gmail search query.")
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
    name: "gmail.review.list",
    description: "List pending Gmail email reviews awaiting a decision.",
    mutates: false,
    requiresConfirmation: false,
    argsSchema: z.object({
      status: z.enum(["pending", "approved", "rejected", "archived", "all"]).optional(),
      limit: z.number().int().positive().max(50).optional()
    })
  },
  {
    name: "gmail.review.reject",
    description: "Reject a pending Gmail email review item.",
    mutates: true,
    requiresConfirmation: false,
    argsSchema: z.object({ reviewId: z.string().min(1) })
  },
  {
    name: "gmail.review.to_action",
    description: "Convert a pending Gmail email review item into an action item.",
    mutates: true,
    requiresConfirmation: false,
    argsSchema: z.object({ reviewId: z.string().min(1) })
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
    schema = zodObjectToPlannerJsonSchema(inner);
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
