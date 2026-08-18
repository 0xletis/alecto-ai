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

  const shape = tool.argsSchema.shape as Record<string, z.ZodTypeAny>;
  const keys = Object.keys(shape);
  const properties: Record<string, unknown> = {};

  for (const key of keys) {
    properties[key] = zodFieldToPlannerJsonSchema(shape[key]);
  }

  return { type: "object", additionalProperties: false, properties, required: keys };
}

function zodFieldToPlannerJsonSchema(field: z.ZodTypeAny): Record<string, unknown> {
  const optional = field.isOptional();
  const inner = unwrapOptional(field);

  if (inner instanceof z.ZodEnum) {
    const values = inner.options as string[];
    return optional ? { type: ["string", "null"], enum: [...values, null] } : { type: "string", enum: values };
  }
  if (inner instanceof z.ZodNumber) {
    return optional ? { type: ["number", "null"] } : { type: "number" };
  }
  if (inner instanceof z.ZodBoolean) {
    return optional ? { type: ["boolean", "null"] } : { type: "boolean" };
  }
  return optional ? { type: ["string", "null"] } : { type: "string" };
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
  return "string";
}
