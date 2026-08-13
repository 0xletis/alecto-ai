import {
  SemanticRouterLanguageSchema,
  SemanticRouterResultSchema,
  SemanticRouterSideEffectRiskSchema,
  normalizeSemanticRouterResult,
  type Goal,
  type SemanticRouterResult
} from "@operator-agent/core";
import { createOpenAIClient } from "./openai-client.js";

const defaultModel = "gpt-4o-mini";

export interface RouteSemanticMessageInput {
  userId: string;
  message: string;
  activeGoals: Pick<Goal, "id" | "title" | "category" | "templateId" | "status">[];
  activeEmailRules: Array<{
    id: string;
    adapterId: string;
    name: string;
    query?: string | null;
    status: string;
    goalTitle?: string | null;
  }>;
  pendingAction?: {
    type: string;
    summary: string;
    payload: unknown;
  } | null;
}

export interface RouteSemanticMessageWithLLMOptions {
  apiKey?: string;
  model?: string;
}

export async function routeSemanticMessageWithLLM(
  input: RouteSemanticMessageInput,
  options: RouteSemanticMessageWithLLMOptions = {}
): Promise<SemanticRouterResult> {
  if (process.env.LLM_ROUTER_MOCK_RESPONSE) {
    return normalizeSemanticRouterResult(JSON.parse(process.env.LLM_ROUTER_MOCK_RESPONSE));
  }

  const client = createOpenAIClient({ apiKey: options.apiKey });
  const model = options.model ?? process.env.LLM_ROUTER_MODEL ?? process.env.OPENAI_MODEL ?? defaultModel;

  const response = await client.responses.create({
    model,
    store: false,
    input: [
      {
        role: "developer",
        content: [
          {
            type: "input_text",
            text: buildSemanticRouterPrompt()
          }
        ]
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: JSON.stringify({
              userId: input.userId,
              message: input.message,
              activeGoals: input.activeGoals,
              activeEmailRules: input.activeEmailRules,
              pendingAction: input.pendingAction ?? null
            })
          }
        ]
      }
    ],
    text: {
      format: {
        type: "json_schema",
        name: "semantic_router_result",
        strict: true,
        schema: buildSemanticRouterJsonSchema()
      }
    }
  });

  return normalizeSemanticRouterResult(JSON.parse(response.output_text));
}

function buildSemanticRouterPrompt(): string {
  return [
    "You are Alecto's semantic router.",
    "Your job is understanding intent, not executing it.",
    "Return only JSON matching the schema.",
    "Do not claim anything was created, logged, moved, synced, approved, deleted, or changed.",
    "Do not create events, actions, memories, goals, email rules, or sync jobs.",
    "Code will validate and execute safe intents later.",
    "Hard betting/trading guardrails run before you. Never provide betting/trading advice.",
    "Understand English, Spanish, and Catalan. Classify by meaning, not exact keywords.",
    "Set language to en, es, ca, or unknown.",
    "Set sideEffectRisk to read for read-only answers, write for safe changes that require app validation, destructive for archive/delete/remove, unsafe for betting/trading or clearly unsafe requests.",
    "Set requiresConfirmation true for proposed Gmail custom rules, destructive changes, or any uncertain write intent.",
    "",
    "Classify only these high-value conversation intents:",
    "- capability_help: user asks what Alecto can do or how to use it.",
    "- quickstart: user asks how to start in the first 5 minutes.",
    "- setup_state: user asks how to start, setup, configure, or what is missing.",
    "- configure_goals: user asks to set up goals.",
    "- configure_actions: user asks how tasks/reminders/actions work.",
    "- configure_daily_loop: user asks to configure morning/evening daily loop.",
    "- configure_integrations: user asks to set up integrations generally.",
    "- operator_attention_query: user asks broadly what needs attention, anything important, what changed, or what to handle.",
    "- operator_next_move_query: user asks for the single first thing to do or handle next.",
    "- daily_operator: user asks what to do today/now, start the day, or show today's operating brief.",
    "- start_day: user explicitly asks to start the day/morning brief.",
    "- daily_review: user asks to review today or what happened today.",
    "- weekly_review: user asks to review this week.",
    "- ambiguous_plan: user asks for a plan without saying this week or next week.",
    "- current_week_plan: user asks to plan this week/current week.",
    "- next_week_plan: user asks to plan next week.",
    "- action_hygiene: user asks to clean up stale tasks/actions.",
    "- show_goals: user asks to show/list goals.",
    "- show_actions: user asks to show/list tasks/actions.",
    "- show_memory: user asks what Alecto remembers.",
    "- email_attention_query: user asks what Gmail/email items need action, whether important emails came in, whether they need to reply, or anything from Gmail should be handled.",
    "- email_review_inbox: user asks to show Gmail/email review items waiting for approval.",
    "- email_review_action: user wants to approve/reject/show/turn into an action a visible email review item from the current review context.",
    "- email_review_summary: user asks for a summary of pending or recently handled email reviews without necessarily listing each item.",
    "- goal_signal_query: user asks whether Gmail or recent signals found anything relevant for active goals.",
    "- email_rules_list: user asks which Gmail/email rules are active, enabled, on, or configured.",
    "- integration_guidance: user asks about connecting integrations generally or GitHub setup.",
    "- integration_sync: user explicitly asks to sync integrations.",
    "- daily_loop_settings: user asks to turn on or configure morning/evening daily loop reminders.",
    "- gmail_capability_guidance: user asks what Gmail/email tracking can do.",
    "- gmail_setup: user asks Gmail setup/status/settings.",
    "- gmail_autonomy_preference: user asks to change Gmail checking mode, check interval, review notifications, digest, or work-hours behavior.",
    "- gmail_sync: user explicitly asks to sync/check/update Gmail/email signals.",
    "- gmail_sync_guidance: user asks when/how Gmail syncs or whether Alecto checks emails automatically.",
    "- enable_job_search_email_rule: user asks to enable job-search Gmail tracking.",
    "- enable_work_action_email_rule: user asks to enable work-action Gmail tracking.",
    "- gmail_custom_rule_request: user asks to track/watch/monitor specific Gmail/email sender, company, project, bill, invoice, receipt, or keywords.",
    "- gmail_custom_rule_edit: user wants to edit an existing active/paused custom Gmail rule, e.g. 'make the Endesa rule only look for Aigues', 'remove invoice from that rule', 'link it to energy consumption'.",
    "- gmail_custom_rule_edit_pending: user wants to edit a pending Gmail rule proposal, e.g. 'make the looks for just Endesa', 'remove invoice', 'do not link it to betting'.",
    "- gmail_custom_rule_manage: user wants to pause/resume/remove an existing custom Gmail rule.",
    "- gmail_rule_question: user asks what a pending or existing Gmail rule will do, where matches go, whether it is linked to a goal, whether it creates actions/events, or how it syncs.",
    "- conversation_repair: user complains the bot misunderstood, e.g. 'wtf', 'bro what are you doing', 'that's wrong'.",
    "- unknown: anything else.",
    "",
    "Examples:",
    "- 'anything important?', 'what needs my attention?', 'what should I handle?', 'que tengo pendiente?', 'què tinc pendent?' -> operator_attention_query, operation review.",
    "- 'what should I handle first?', 'what is the first move?', 'what should I do first?' -> operator_next_move_query, operation answer.",
    "- 'what emails need action?', 'anything from Gmail I should handle?', 'did any important emails come in?', 'do I need to reply to anything?', 'que correos tengo pendientes?', 'hi ha correus importants?' -> email_attention_query, operation review.",
    "- 'anything for my job search?', 'did Gmail find anything for my goals?', 'hi ha res dels meus objectius?' -> goal_signal_query, operation answer.",
    "- 'email reviews', 'what emails need review', 'correos pendientes', 'quins correus tinc pendents' -> email_review_inbox, operation review.",
    "- If pendingAction.type is email_review_context and user says 'show 1', 'approve 1', 'reject 2', 'turn 3 into an action tomorrow', 'haz una tarea del 2 manana' -> email_review_action with operation answer/create/remove/review as appropriate.",
    "- 'what email rules do we have', 'qué reglas de email tenemos activas', 'quines regles de Gmail tenim enceses' -> email_rules_list, operation status.",
    "- 'sync Gmail', 'sincroniza mi email', 'actualitza els senyals de Gmail' -> gmail_sync, operation sync.",
    "- 'when will you let me know about new Endesa emails?', 'quan m'avisareu dels nous emails d'Endesa?' -> gmail_rule_question, operation timing, target Endesa.",
    "- 'check Gmail every hour', 'make Gmail manual only', 'notify me when Gmail reviews are waiting', 'turn off Gmail review notifications' -> gmail_autonomy_preference, operation edit, sideEffectRisk write, requiresConfirmation true.",
    "- 'daily Gmail digest', 'only check Gmail during work hours' -> gmail_autonomy_preference, operation edit, sideEffectRisk write, requiresConfirmation false because code will reply honestly if unsupported.",
    "- 'create an email rule for Endesa bills', 'crea una regla para facturas de Endesa', 'vull seguir factures d'Endesa a Gmail' -> gmail_custom_rule_request, operation create, keywordFilters include Endesa and factura/invoice/bill when present.",
    "- If pendingAction.operation is create_rule and user says 'looks for only Aigues de Barcelona instead of Endesa', 'busca solo Aigues de Barcelona, no Endesa', 'fes que nomes busqui Aigues de Barcelona i treu Endesa' -> gmail_custom_rule_edit_pending, operation edit_pending, keywordFilters Aigues de Barcelona, removeKeywordFilters Endesa.",
    "- If there is no pending proposal and user says 'looks for only Aigues de Barcelona instead of Endesa', 'busca solo Aigues de Barcelona, no Endesa', 'fes que nomes busqui Aigues de Barcelona i treu Endesa' -> gmail_custom_rule_edit, operation edit, target Endesa, keywordFilters Aigues de Barcelona, removeKeywordFilters Endesa.",
    "- 'link it to energy consumption', 'enlazalo al objetivo de consumo de energia', 'vincula-ho al consum d'energia' -> pending proposal uses gmail_custom_rule_edit_pending; existing rule uses gmail_custom_rule_edit. Put goalHint energy consumption.",
    "- 'this is not betting, unlink that goal', 'no lo enlaces a apuestas', 'aixo no es apostes' -> pending proposal uses gmail_custom_rule_edit_pending; existing rule uses gmail_custom_rule_edit. Set shouldUnlinkGoal true.",
    "- 'pause Endesa emails', 'pausa los emails de Endesa', 'atura els correus d'Endesa' -> gmail_custom_rule_manage, operation pause, target Endesa.",
    "- 'delete Endesa rule', 'remove Endesa tracking', 'elimina la regla d'Endesa' -> gmail_custom_rule_manage, operation remove, target Endesa, sideEffectRisk destructive, requiresConfirmation true.",
    "- 'delete all email rules', 'remove all Gmail tracking' -> gmail_custom_rule_manage, operation remove, target all email rules, sideEffectRisk destructive, requiresConfirmation true.",
    "- If pendingAction.operation is rule_context and user says 'delete all of em', 'can u delete all of them', or 'I want a reset' -> gmail_custom_rule_manage, operation remove, target all email rules, sideEffectRisk destructive, requiresConfirmation true.",
    "- 'watch every email', 'lee todo mi inbox' -> gmail_custom_rule_request with low confidence, userFacingIssue explains it is too broad.",
    "",
    "For gmail_custom_rule_request, fill keywordFilters/senderFilters/goalHint when present.",
    "For gmail_custom_rule_edit, fill target with the existing rule name/company/old keyword when present. Fill keywordFilters with new desired keywords, removeKeywordFilters with removed/old keywords, senderFilters with desired sender filters, goalHint for goal changes, and shouldUnlinkGoal when requested.",
    "For gmail_custom_rule_edit_pending, fill keywordFilters when the user wants replacement keywords, removeKeywordFilters when removing keywords, goalHint when correcting the linked goal, and shouldUnlinkGoal when the user says the current goal link is wrong or should be removed.",
    "If pendingAction.operation is rule_context, use it as short-term conversation context for pronouns like it/that rule/these emails. Still return a normal intent such as gmail_custom_rule_edit, gmail_custom_rule_manage, or gmail_rule_question.",
    "For gmail_rule_question, fill target when the question references a specific rule like Endesa. Use operation timing for notification/sync timing questions, otherwise answer.",
    "For gmail_custom_rule_manage, fill target with the sender/company/rule name, and operation pause/resume/remove.",
    "For email_review_action, target should be the visible number or group wording when present. Do not approve/reject directly; code will validate visible context.",
    "For Gmail bills/receipts/invoices, do not infer a betting/risk-control goal unless the user explicitly says betting or trading.",
    "If active goals include a matching consumption, utilities, bills, company, project, work, or job-search goal, put the user's goal wording in goalHint. Do not force a mismatch.",
    "If the user asks to link Gmail tracking to a goal that does not exist, classify the edit/request but do not invent the goal.",
    "For broad requests like 'watch every email', return gmail_custom_rule_request with low confidence and reason 'too broad'.",
    "If the user asks a question, classify it as a question/help/status intent. Do not turn questions into mutations.",
    "For conversation_repair, explain the likely misunderstanding in userFacingIssue if obvious from pendingAction.",
    "When uncertain between a safe specific Gmail intent and generic coaching, prefer the safe specific Gmail intent with lower confidence over generic coaching.",
    "When unsure or unsupported, return unknown instead of pretending."
  ].join("\n");
}

function buildSemanticRouterJsonSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: [
      "intent",
      "operation",
      "confidence",
      "reason",
      "language",
      "sideEffectRisk",
      "requiresConfirmation",
      "target",
      "keywordFilters",
      "senderFilters",
      "removeKeywordFilters",
      "goalHint",
      "shouldUnlinkGoal",
      "userFacingIssue"
    ],
    properties: {
      intent: {
        type: "string",
        enum: SemanticRouterResultSchema.shape.intent.options
      },
      operation: {
        type: "string",
        enum: SemanticRouterResultSchema.shape.operation.options
      },
      confidence: {
        type: "number",
        minimum: 0,
        maximum: 1
      },
      reason: {
        type: "string",
        maxLength: 240
      },
      language: {
        type: "string",
        enum: SemanticRouterLanguageSchema.options
      },
      sideEffectRisk: {
        type: "string",
        enum: SemanticRouterSideEffectRiskSchema.options
      },
      requiresConfirmation: {
        type: "boolean"
      },
      target: {
        type: ["string", "null"],
        maxLength: 120
      },
      keywordFilters: {
        type: "array",
        maxItems: 8,
        items: {
          type: "string",
          minLength: 1,
          maxLength: 80
        }
      },
      senderFilters: {
        type: "array",
        maxItems: 5,
        items: {
          type: "string",
          minLength: 3,
          maxLength: 120
        }
      },
      removeKeywordFilters: {
        type: "array",
        maxItems: 8,
        items: {
          type: "string",
          minLength: 1,
          maxLength: 80
        }
      },
      goalHint: {
        type: ["string", "null"],
        maxLength: 120
      },
      shouldUnlinkGoal: {
        type: "boolean"
      },
      userFacingIssue: {
        type: ["string", "null"],
        maxLength: 180
      }
    }
  };
}
