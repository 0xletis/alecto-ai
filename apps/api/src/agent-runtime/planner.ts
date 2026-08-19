import { createOpenAIClient } from "@operator-agent/llm";
import { toolArgsPlannerJsonSchema, toolCatalog, toolCatalogPromptSummary, toolNames } from "./tool-catalog.js";
import type { ContextBundle, RawPlan } from "./types.js";

const defaultModel = "gpt-4o-mini";

export interface PlannerResult {
  plan: RawPlan;
  plannerUsed: "llm" | "fallback";
}

export async function planMessage(message: string, context: ContextBundle): Promise<PlannerResult> {
  try {
    const plan = await planWithLLM(message, context);
    return { plan, plannerUsed: "llm" };
  } catch {
    return { plan: heuristicPlan(message, context), plannerUsed: "fallback" };
  }
}

async function planWithLLM(message: string, context: ContextBundle): Promise<RawPlan> {
  const mockThrow = process.env.AGENT_RUNTIME_PLANNER_MOCK_THROW === "true";
  if (mockThrow) {
    throw new Error("Mock agent-runtime planner failure.");
  }

  // Test-only: simulates real LLM latency so tests can prove per-user request
  // serialization without depending on network timing.
  const mockDelayMs = Number(process.env.AGENT_RUNTIME_PLANNER_MOCK_DELAY_MS ?? 0);
  if (Number.isFinite(mockDelayMs) && mockDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, mockDelayMs));
  }

  const mockResponse = process.env.AGENT_RUNTIME_PLANNER_MOCK_RESPONSE;
  if (mockResponse) {
    return normalizePlan(JSON.parse(mockResponse));
  }

  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }

  const client = createOpenAIClient();
  const model = process.env.AGENT_RUNTIME_PLANNER_MODEL ?? process.env.OPENAI_MODEL ?? defaultModel;

  const response = await client.responses.create({
    model,
    store: false,
    input: [
      { role: "developer", content: [{ type: "input_text", text: buildSystemPrompt() }] },
      { role: "user", content: [{ type: "input_text", text: buildUserPayload(message, context) }] }
    ],
    text: {
      format: {
        type: "json_schema",
        name: "agent_operation_plan",
        strict: true,
        schema: buildPlanJsonSchema()
      }
    }
  });

  return normalizePlan(JSON.parse(response.output_text));
}

function buildSystemPrompt(): string {
  return [
    "You are Alecto's Agent Runtime v3 planner.",
    "You only PLAN operations as structured JSON. You never write to any database and your reply text is only a draft.",
    "Deterministic code will validate every operation against a fixed tool catalog, resolve ambiguous references, enforce policy, and execute allowed operations.",
    "",
    "Tool catalog (use only these tool names, and match args exactly to the given shape):",
    toolCatalogPromptSummary(),
    "",
    "Honesty rules you must respect in replyDraft and clarificationQuestion:",
    "- Custom Gmail tracking rules are review-first: matches create an email review, they are never auto-logged and never instant/webhook-driven.",
    "- Gmail checks happen on a scheduled or manual sync, not the instant an email arrives.",
    "- Gmail sending, replying, archiving, and deleting are NOT supported by any tool. If asked, plan zero operations and explain this honestly in replyDraft.",
    "- Never claim an action happened before it has actually been executed.",
    "- Never recommend a slash command (e.g. '/action_hygiene', '/gmail_rules', '/sync_gmail') in replyDraft or clarificationQuestion. This is a normal-chat runtime; describe the natural-language equivalent instead — e.g. say the user can say \"clean up my actions\" rather than \"run /action_hygiene\".",
    "",
    "Behavior rules:",
    "- Clear yes/no replies to a pendingOperation are already handled deterministically before you are called — you will not normally be asked to plan for a bare 'yes'/'no'. If you ARE asked with a pendingOperation still open, the user's message was NOT a clear yes/no (it might be a question about the pending item, an unrelated request, or something else) — do not plan confirmation.confirm/confirmation.cancel yourself; only plan them if the user is unambiguously confirming or cancelling in this exact message. Otherwise just answer or act on what they actually said, honestly, without assuming they meant yes.",
    "- If the user refers to 'it'/'that'/'this' and exactly one matching entity is visible in context, omit the id field so the validator can resolve it; if it's ambiguous, use clarification.ask instead.",
    "- If the request is genuinely ambiguous or missing required information (e.g. 'track those emails' with no email topic in context), set needsClarification true and do not plan mutating operations.",
    "- gmail.rule.create always requires confirmation (the validator enforces this); explain what will happen and ask before it's created.",
    "- action.hygiene_start shows a numbered action-cleanup list; each visible entity of type 'action' may carry an `index` matching that numbering. When the user replies with numbered decisions (e.g. 'complete 1, snooze 2 to Friday, archive 3', 'keep 1 and archive 2'), plan ONE action.hygiene_apply operation whose `selections` array has one entry per decision, using `index` to reference each numbered item (omit actionId unless you already know the real id from context). If the user instead names an item by title (e.g. 'snooze the gym one to Friday') and you can match it to a visible entity, use that entity's real id as actionId. Never invent an index or id that isn't in the visible entities — if you can't confidently match a decision to a visible item, use clarification.ask instead.",
    "- For 'plan next week', 'help me plan next week', 'make a plan for next week based on my goals', 'plan this week', or similar, plan planning.next_week_start — but NEVER if a plan draft is already open (pendingOperation from planning.next_week_start/next_week_edit); a second next_week_start would throw away the user's edits and build an unrelated new draft. It shows a numbered draft plan and opens a pending confirmation on its own — do not also plan confirmation.confirm.",
    "- While a plan draft is open, if the user asks to SEE/VIEW the current draft again without changing anything (e.g. 'show me the plan', 'let me see the week plan', \"what's the plan\", 'show current draft'), plan planning.next_week_show_current — never planning.next_week_start (which would silently discard the current draft and generate a different one) and never planning.next_week_edit (nothing is being changed).",
    "- While a plan draft is open, replies that change it should plan ONE planning.next_week_edit operation. Indexes in `removeIndexes`/`changes[].index`/`keepIndexes` are always 1-based, exactly matching the numbers shown in the draft — the first item is 1, NEVER 0. If the user names an item by words instead of a number (e.g. 'remove the YouTube one', 'move the gym one to Friday', 'remove reading'), first try to match it yourself against the draft items' own titles/topics visible in context and use its index; only if you truly cannot tell which item it is, pass the user's own words through `removeRefs`/`changes[].ref` (using the item's own wording, not a paraphrase) so the deterministic validator can match it — never invent an index for an item you're not looking at. 'move X to Y' / 'change X to Y' is ALWAYS only a day change (`changes`) — never also list X in `removeIndexes`/`removeRefs` for that same request; moving an item is not removing it, and doing both empties the plan instead of moving it. 'keep X and remove the rest' style requests use `keepIndexes`/`keepRefs` instead of listing everything to remove. For 'make it lighter' (or 'make it shorter', 'trim it down'), set `lighter: true` alone — do NOT also guess which items to drop yourself in removeIndexes/removeRefs; the deterministic code decides that safely. An edit that removes every remaining item is rejected unless the user explicitly asked to clear the whole plan — only then set `removeAll: true`. Only include the fields that describe what THIS message is asking for — never repeat an earlier edit request from earlier in the conversation just because it appeared not to take effect; if the user still wants it, they will say so again. Never plan planning.next_week_apply yourself; it only runs when the user confirms the draft with an exact yes/confirm, which is handled deterministically.",
    "- For 'what changed?', 'what did you do?', 'qué has cambiado?', or similar, ALWAYS plan operator.recent_changes instead of answering from your own memory of the conversation — its result is verified ground truth and is shown to the user directly.",
    "- Keep replyDraft concise and specific about what you understood/did, in the user's own language.",
    "- Return only JSON matching the schema."
  ].join("\n");
}

function buildUserPayload(message: string, context: ContextBundle): string {
  const { session } = context;

  return JSON.stringify({
    message,
    conversation: {
      topic: session.topic,
      pendingOperation: session.pendingOperation
        ? { topic: session.pendingOperation.topic, summary: session.pendingOperation.summary }
        : null,
      visibleEntities: session.visibleEntities,
      recentMessages: session.messages.slice(-10)
    },
    context: {
      activeGoals: context.activeGoals.map((goal) => ({ id: goal.id, title: goal.title })),
      openActions: context.openActions.map((action) => ({ id: action.id, title: action.title, dueAt: action.dueAt })),
      gmailConnected: Boolean(context.gmailConnection && context.gmailConnection.status === "active"),
      gmailRules: context.gmailRules
        .filter((rule) => rule.status === "active")
        .map((rule) => ({ id: rule.id, name: rule.name, query: rule.query })),
      pendingGmailReviewCount: context.gmailReviews.length,
      recentMemorySummaries: context.memories.slice(0, 10).map((memory) => memory.summary)
    }
  });
}

function buildPlanJsonSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["topic", "intent", "operations", "needsClarification", "clarificationQuestion", "replyDraft"],
    properties: {
      topic: { type: "string", minLength: 1, maxLength: 80 },
      intent: { type: "string", minLength: 1, maxLength: 200 },
      operations: {
        type: "array",
        maxItems: 5,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["tool", "args", "rationale"],
          properties: {
            tool: { type: "string", enum: toolNames },
            args: { anyOf: toolCatalog.map((tool) => toolArgsPlannerJsonSchema(tool)) },
            rationale: { type: ["string", "null"], maxLength: 300 }
          }
        }
      },
      needsClarification: { type: "boolean" },
      clarificationQuestion: { type: ["string", "null"], maxLength: 300 },
      replyDraft: { type: "string", maxLength: 1000 }
    }
  };
}

function normalizePlan(raw: unknown): RawPlan {
  const value = raw as Partial<RawPlan> & { operations?: unknown[] };

  return {
    topic: typeof value.topic === "string" && value.topic.length > 0 ? value.topic : "general",
    intent: typeof value.intent === "string" ? value.intent : "",
    operations: Array.isArray(value.operations)
      ? value.operations.map((op) => {
          const o = op as { tool?: unknown; args?: unknown; rationale?: unknown };
          return {
            tool: typeof o.tool === "string" ? o.tool : "",
            args: o.args && typeof o.args === "object" && !Array.isArray(o.args) ? (o.args as Record<string, unknown>) : {},
            rationale: typeof o.rationale === "string" ? o.rationale : undefined
          };
        })
      : [],
    needsClarification: Boolean(value.needsClarification),
    clarificationQuestion: typeof value.clarificationQuestion === "string" ? value.clarificationQuestion : null,
    replyDraft: typeof value.replyDraft === "string" ? value.replyDraft : ""
  };
}

/**
 * Keyword-based safety net used only when the LLM planner is unavailable or
 * fails (missing OPENAI_API_KEY, network error, etc). Deliberately narrow:
 * it exists so the runtime degrades gracefully rather than to be a full
 * natural-language understander. Golden-transcript tests inject mocked LLM
 * plans instead of relying on this path.
 */
function heuristicPlan(message: string, context: ContextBundle): RawPlan {
  const text = message.trim().toLowerCase();
  const { session } = context;

  if (session.pendingOperation) {
    if (/^(yes|yep|yeah|confirm|do it|go ahead|sí|si|vale)\b/.test(text)) {
      return blankPlan(session.topic ?? "confirmation", "confirm pending operation", [
        { tool: "confirmation.confirm", args: {} }
      ]);
    }

    if (/^(no|nevermind|never mind|cancel|stop)\b/.test(text)) {
      return blankPlan(session.topic ?? "confirmation", "cancel pending operation", [
        { tool: "confirmation.cancel", args: {} }
      ]);
    }
  }

  return {
    topic: session.topic ?? "general",
    intent: "fallback_no_match",
    operations: [],
    needsClarification: true,
    clarificationQuestion: "I couldn't confidently understand that without my language model available. Could you rephrase?",
    replyDraft: "I couldn't confidently understand that without my language model available. Could you rephrase?"
  };
}

function blankPlan(topic: string, intent: string, operations: RawPlan["operations"]): RawPlan {
  return {
    topic,
    intent,
    operations,
    needsClarification: false,
    clarificationQuestion: null,
    replyDraft: ""
  };
}
