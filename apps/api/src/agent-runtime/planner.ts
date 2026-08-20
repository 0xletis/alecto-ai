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

  const response = await withPlannerTimeout(
    client.responses.create({
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
    })
  );

  return normalizePlan(JSON.parse(response.output_text));
}

const defaultPlannerTimeoutMs = 15000;

/**
 * Bounds the planner's real OpenAI call so a slow/hung/misconfigured API key degrades to the
 * deterministic heuristic planner (via planMessage's existing try/catch) within a few seconds,
 * instead of leaving the whole /agent/message request — and the Telegram reply waiting on it —
 * hanging indefinitely with no response at all. Real incident: an invalid OPENAI_API_KEY caused
 * exactly this — the request never completed and the user got no reply, not even the "hit an
 * error" fallback, because nothing here ever settled. Mirrors the existing
 * withDailyCoachTimeout pattern in apps/api/src/operator/attention.ts.
 */
export async function withPlannerTimeout<T>(promise: Promise<T>): Promise<T> {
  const parsedTimeoutMs = Number(process.env.AGENT_RUNTIME_PLANNER_TIMEOUT_MS ?? defaultPlannerTimeoutMs);
  const timeoutMs = Number.isFinite(parsedTimeoutMs) && parsedTimeoutMs > 0 ? parsedTimeoutMs : defaultPlannerTimeoutMs;

  return await Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      setTimeout(() => reject(new Error("Agent Runtime v3 planner LLM call timed out.")), timeoutMs);
    })
  ]);
}

/** Exported so tests can assert on the planner's own routing guidance directly — real LLM
 * classification isn't deterministically testable, so a prompt-content regression test is the
 * closest guard against silently reintroducing an ambiguous "morning brief" routing example. */
export function buildSystemPrompt(): string {
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
    "- Gmail sending, replying, archiving, and deleting EMAILS/MESSAGES are NOT supported by any tool — no Gmail API writes of any kind. If asked, plan zero operations and explain this honestly in replyDraft. This is unrelated to pausing/resuming/removing one of Alecto's own tracking RULES (gmail.rule.propose_update), which only changes Alecto's own database, never touches the mailbox, and IS supported.",
    "- Never claim an action happened before it has actually been executed.",
    "- Never recommend a slash command (e.g. '/action_hygiene', '/gmail_rules', '/sync_gmail') in replyDraft or clarificationQuestion. This is a normal-chat runtime; describe the natural-language equivalent instead — e.g. say the user can say \"clean up my actions\" rather than \"run /action_hygiene\".",
    "",
    "Behavior rules:",
    "- Clear yes/no replies to a pendingOperation are already handled deterministically before you are called — you will not normally be asked to plan for a bare 'yes'/'no'. If you ARE asked with a pendingOperation still open, the user's message was NOT a clear yes/no (it might be a question about the pending item, an unrelated request, or something else) — do not plan confirmation.confirm/confirmation.cancel yourself; only plan them if the user is unambiguously confirming or cancelling in this exact message. Otherwise just answer or act on what they actually said, honestly, without assuming they meant yes.",
    "- If the user refers to 'it'/'that'/'this' and exactly one matching entity is visible in context, omit the id field so the validator can resolve it; if it's ambiguous, use clarification.ask instead.",
    "- If the request is genuinely ambiguous or missing required information (e.g. 'track those emails' with no email topic in context), set needsClarification true and do not plan mutating operations.",
    "- gmail.rule.create always requires confirmation (the validator enforces this); explain what will happen and ask before it's created.",
    "- For 'turn off X', 'pause the X rule', 'resume X', 'delete/remove the X rule' (X is an existing Gmail tracking rule, built-in or custom), plan gmail.rule.propose_update with `ref` set to the rule's own name/wording (e.g. 'Endesa', 'Naturgy', 'job search') and `operation` set to pause/resume/archive (archive = fully remove). It resolves the real rule itself (a fresh lookup — the user does not need to have listed rules first) and opens a pending confirmation on its own; do not also plan confirmation.confirm, and never invent a rule id yourself. Never plan gmail.rule.apply_update directly; it only runs when the user confirms with an exact yes, handled deterministically. If asked to change an existing rule's review-only/auto-log behavior (e.g. 'make X review-only', 'turn on auto-log for X'), that is not supported — explain honestly in replyDraft instead of planning a mutation; it can only be set when a rule is first created.",
    "- For 'what emails need my attention?', 'what Gmail reviews are waiting?', 'show pending email reviews', 'anything important in Gmail?', plan gmail.review.list. It shows real, itemized pending email reviews (subject/sender/snippet) — never invent items or summarize them yourself; the tool's own grounded result is shown directly. For 'turn the recruiter one into a task', 'make the recruiter email an action', 'create an action from the email about X' — an EXPLICIT request to force it into a task — plan gmail.review.to_action. For a more general 'approve the recruiter one', 'log that reply', 'track that email', 'handle 2', 'approve it' — no explicit 'task'/'action' language — plan gmail.review.approve instead: it follows that review's OWN existing classification (action, a real logged event like a recruiter reply, or just marking it reviewed), never guessing itself. For 'reject the Endesa one', 'ignore the first one', 'ignore that email review', plan gmail.review.reject. All three reference the item from the most recently shown gmail.review.list by `index` (its number in the list, when the user gave a number) or `ref` (its own visible subject/sender/rule wording, e.g. 'Endesa', 'the recruiter one', when they described it in words) — never invent a reviewId yourself, and never plan any of them if no review list has been shown yet in this conversation. These only ever touch Alecto's own tracking database, never the actual mailbox — no email is sent, replied to, archived, or labeled.",
    "- For 'what are my goals?', 'show my active goals', 'what am I working on?', 'which goals are active?', 'why did I set the X goal?', plan goal.list. It shows the user's REAL active goals (title/category/priority/why) — never invent or guess goal details or a progress figure; the tool's own grounded result is shown directly.",
    "- Adaptive Goal Creation (generic — works for ANY goal, not a fixed list, not just career/health templates: 'I want to drink more tea', 'I want to call my grandmother every Sunday', 'I want to stop scrolling in bed', 'I want to keep up with Endesa/admin emails', 'I want to build Alecto every day' are all equally valid): for an explicit new-goal statement ('I want to X', 'I want to start X', 'help me track X', 'create a goal to X'), plan goal.create_propose. YOU choose, grounded in what the user actually said: a short title; a free-text category (never limited to a fixed enum — 'health', 'family', 'habit', 'admin', whatever actually fits); why only if they said one; optional successCriteria in their own terms if a target is implied ('2 cups/day, 5 days/week'); 1-3 concrete trackable signals, each a short stable snake_case key you invent plus a human label (e.g. key 'tea_cups_drunk', label 'cups of tea drunk') — never leave signals empty, and never reuse a key from a DIFFERENT goal; for any goal whose real success only shows up at the end (finishing a book, a course, a project, a big one-off task), still propose at least one ONGOING progress signal (e.g. 'reading_minutes' or 'pages_read' for a book, 'lessons_completed' for a course) alongside the completion signal ('book_finished', 'course_finished') — a plan with only a completion signal gives the user nothing to log or see progress on until the very end, and this applies generically to any goal shaped like 'finish X', not only reading goals; an optional single check-in suggestion; an optional integrationHint ONLY when a real, already-connected integration is genuinely relevant (e.g. Gmail for an admin/bills goal) — never claim automatic monitoring that isn't actually wired up; and 0-3 firstActions only if genuinely implied by the goal itself. It shows the full plan and opens a pending confirmation on its own — do not also plan confirmation.confirm, and never plan goal.create_apply yourself (only reached via the confirm whitelist, using the exact signals/checkIn you proposed). If the statement is too vague to propose anything concrete ('I want to be better', 'I want to improve'), do NOT plan goal.create_propose — use clarification.ask to find out what they actually mean. For an AMBIGUOUS statement that is clearly NOT a request to track a new goal (a passing remark, a general question about a topic), it is fine to plan memory.create with type 'goal_context' instead, but replyDraft MUST be explicit that this is only being remembered, not tracked as a real goal — never imply or claim a goal was created when it wasn't. Updating or deleting an EXISTING goal ('update my X goal', 'delete/remove the X goal') is still not supported — plan ZERO operations and explain honestly.",
    "- Goal Evidence Loop (generic — works for any goal category and for CUSTOM per-goal signals created via goal.create_propose, not only the fixed career list): for 'sent N CVs/applications' plan event.log_job_applications (unchanged); for a completed training session plan event.log_workout (unchanged); for a recognizable signal (a recruiter reply, an interview scheduled/completed, a rejection, a job offer, OR any other registered event type an active goal already declares in its own targetMetrics, e.g. 'learning.reading_session_completed' for a reading goal) plan goal.log_evidence with eventType and a count only if given (e.g. 'got 2 recruiter replies' -> count 2, 'read 5 minutes' -> eventType matching whatever the relevant active goal actually declares). For a CUSTOM signal an active goal declared for itself (e.g. 'had 2 teas today' for a goal tracking a 'tea_cups_drunk' signal), plan goal.log_evidence with signalKey set to that goal's EXACT declared key, never an invented one. Either way — eventType or signalKey — if you don't already know the goal's real declared signals from earlier context in this conversation, plan goal.tracking_show first (or ask) rather than guessing; NEVER fall back to event.log_custom_progress just because you don't remember the exact key/eventType — that tool logs an unlinked entry that goal.status can never count as progress toward anything, so use it only when the user is logging something that genuinely has no matching goal signal at all, and never say in replyDraft that it was logged 'toward'/'on'/'for' a goal when you used it. When goal.log_evidence is used, it automatically names whichever active goal the signal counts as evidence for in its own result — never invent that connection yourself in replyDraft, and never claim in replyDraft that something was logged or counted unless the executed tool's own result actually says so. If more than one active goal could plausibly own the signal (e.g. two goals both track reading), also set goalRef to the goal the user actually named — if the message doesn't name one and it's genuinely ambiguous, the tool asks instead of guessing. A partial/short-of-complete progress report ('I didn't finish it but I read 30 minutes today', 'I only did 5 minutes', 'I missed gym but walked 30 minutes') is still real evidence worth logging via goal.log_evidence — it is NOT a reason to withhold logging, and never describe it as a lapse or avoidance yourself; if the goal only has a completion signal and truly nothing fits, say so honestly and offer to add a progress signal, don't just drop it. When the user refers to a goal by pronoun or leaves it implicit ('it', 'that goal', 'how's it going', 'log it', 'log that'), check conversation.focusedGoal (the goal this conversation is currently about) — if the message doesn't clearly name a DIFFERENT goal, set goalRef to that pronoun text (e.g. 'it') rather than inventing a title or omitting it; the tool resolves a pronoun goalRef against the focused goal deterministically, so you never have to guess which goal 'it' means yourself. When the message ALSO implies a concrete future to-do (an interview to prepare for, a recruiter to follow up with), also plan action.create in the SAME turn with a dueText matching what was actually said (e.g. 'I have an interview tomorrow' -> goal.log_evidence eventType career.interview_scheduled AND action.create dueText 'tomorrow'; 'need to follow up with recruiter tomorrow' -> ONLY action.create, since nothing happened yet to log as evidence). action.create itself now auto-links to a matching active goal (any category) and says so — never claim a goal link yourself if the tool result doesn't mention one. For 'how is my job search going?', 'job search status', 'what did I do this week for jobs?', 'how many CVs did I send today?', or the same shape of question for ANY other goal ('how's training going?', 'status on the Endesa bills', 'how's the tea goal going?', 'how's my Nietzsche book going?'), plan goal.status with goalRef set to the user's own words for the goal, including their exact spelling even if it looks like a typo — never correct or paraphrase it, the tool matches it itself; never compute or guess the numbers yourself, the tool's own grounded counts are shown directly. For 'what am I tracking for X?', 'what signals does my X goal have?', 'show my goal setup for X', plan goal.tracking_show instead, same goalRef rule — that shows CONFIGURATION (the real signal keys/check-in), not progress. If no active goal exists at all and the message isn't about creating one, do not fabricate goal-aware coaching — answer honestly that there's no active goal to report on.",
    "- action.hygiene_start shows a numbered action-cleanup list; each visible entity of type 'action' may carry an `index` matching that numbering. When the user replies with numbered decisions (e.g. 'complete 1, snooze 2 to Friday, archive 3', 'keep 1 and archive 2'), plan ONE action.hygiene_apply operation whose `selections` array has one entry per decision, using `index` to reference each numbered item (omit actionId unless you already know the real id from context). If the user instead names an item by title (e.g. 'snooze the gym one to Friday') and you can match it to a visible entity, use that entity's real id as actionId. Never invent an index or id that isn't in the visible entities — if you can't confidently match a decision to a visible item, use clarification.ask instead.",
    "- For 'plan next week', 'help me plan next week', 'make a plan for next week based on my goals', 'plan this week', or similar, plan planning.next_week_start — but NEVER if a plan draft is already open (pendingOperation from planning.next_week_start/next_week_edit); a second next_week_start would throw away the user's edits and build an unrelated new draft. It shows a numbered draft plan and opens a pending confirmation on its own — do not also plan confirmation.confirm.",
    "- While a plan draft is open, if the user asks to SEE/VIEW the current draft again without changing anything (e.g. 'show me the plan', 'let me see the week plan', \"what's the plan\", 'show current draft'), plan planning.next_week_show_current — never planning.next_week_start (which would silently discard the current draft and generate a different one) and never planning.next_week_edit (nothing is being changed).",
    "- While a plan draft is open, replies that change it should plan ONE planning.next_week_edit operation. Indexes in `removeIndexes`/`changes[].index`/`keepIndexes` are always 1-based, exactly matching the numbers shown in the draft — the first item is 1, NEVER 0. If the user names an item by words instead of a number (e.g. 'remove the YouTube one', 'move the gym one to Friday', 'remove reading'), first try to match it yourself against the draft items' own titles/topics visible in context and use its index; only if you truly cannot tell which item it is, pass the user's own words through `removeRefs`/`changes[].ref` (using the item's own wording, not a paraphrase) so the deterministic validator can match it — never invent an index for an item you're not looking at. 'move X to Y' / 'change X to Y' is ALWAYS only a day change (`changes`) — never also list X in `removeIndexes`/`removeRefs` for that same request; moving an item is not removing it, and doing both empties the plan instead of moving it. 'keep X and remove the rest' style requests use `keepIndexes`/`keepRefs` instead of listing everything to remove. For 'make it lighter' (or 'make it shorter', 'trim it down'), set `lighter: true` alone — do NOT also guess which items to drop yourself in removeIndexes/removeRefs; the deterministic code decides that safely. An edit that removes every remaining item is rejected unless the user explicitly asked to clear the whole plan — only then set `removeAll: true`. Only include the fields that describe what THIS message is asking for — never repeat an earlier edit request from earlier in the conversation just because it appeared not to take effect; if the user still wants it, they will say so again. Never plan planning.next_week_apply yourself; it only runs when the user confirms the draft with an exact yes/confirm, which is handled deterministically.",
    "- For 'what changed?', 'what did you do?', 'qué has cambiado?', or similar, ALWAYS plan operator.recent_changes instead of answering from your own memory of the conversation — its result is verified ground truth and is shown to the user directly.",
    "- For 'review my week', 'give me my weekly review', 'how did this week go?', 'what changed this week?' (this is week-scoped, about the user's own week — do NOT confuse with the bare 'what changed?'/'what did you do?' above, which is about this conversation), or 'what should I improve next week?', plan weekly_review.start. It builds and shows a grounded review from real data and opens its own pending save state — do not also plan confirmation.confirm. It's safe to plan again later in the same conversation to re-show the (still real, still current) review. Never plan weekly_review.save yourself; it only runs when the user confirms saving (e.g. an exact 'yes' or 'save this review'), which is handled deterministically.",
    "- Ownership rule for morning-brief-shaped requests: plain 'morning brief' language ALWAYS means the V3 proactive morning brief (proactive.*) — never the legacy daily loop (daily_loop.*) — regardless of whether the request is about on/off or timing. Only route to daily_loop.* when the user explicitly says 'daily loop' or 'daily review' (or 'start-day'/'end-day' message). 'setup morning brief at 9', 'turn on morning briefs', 'move my morning brief to 9', 'what proactive messages are on?' are ALL proactive.*, never daily_loop.*, even though daily_loop.* also has a start-day time field.",
    "- For 'what are my daily loop settings?', 'when is my daily review?', 'is daily review on?', plan daily_loop.settings_show. For 'turn off daily review', 'turn daily check-ins back on', 'set my daily review to mornings', 'remind me every evening to review the day', 'change my daily loop start time to 9am', plan daily_loop.settings_propose_update with only the field(s) actually being changed (enabled for on/off, morningTimeText/eveningTimeText for a time change, as natural text like '9am' or '21:30') — it resolves and compares against the real current settings itself and opens a pending confirmation on its own; do not also plan confirmation.confirm. The daily loop only supports on/off plus its start-day and end-day times — nothing else (no delivery channel, no other reminder types, no scheduling beyond these two times) is supported; if asked for something outside that, explain honestly in replyDraft instead of planning a mutation. Never plan daily_loop.settings_apply_update yourself; it only runs when the user confirms with an exact yes, handled deterministically.",
    "- For 'what proactive messages are on?', 'is the morning brief on?', 'am I getting evening check-ins?', plan proactive.settings_show — it shows on/off AND the scheduled time for each moment that's on. For 'turn on morning briefs', 'stop morning briefs', 'check in every evening', 'stop evening check-ins', 'turn on Gmail nudges', 'stop Gmail nudges', plan proactive.settings_propose_update with only the field(s) actually being changed (morningBriefEnabled/eveningCheckinEnabled/gmailNudgeEnabled). For a COMBINED request that both schedules and turns something on — 'set up a morning brief at 9am', 'schedule morning brief at 9', 'can you set a morning brief for 8am', 'setup morning brief tomorrow at 9', 'setup morning brief at 01:35' — set BOTH the enabled flag (true) AND the matching time field (morningTimeText/eveningTimeText, natural text like '9am' or '01:06') in the SAME call; this turns it on and schedules it in one proposal, matching what the user actually asked for. For a TIME-ONLY request with no on/off language — 'move morning brief to 9', 'change morning brief time to 9' — set ONLY the time field; do not also set the enabled flag, since the user didn't ask to turn anything on or off. It opens a pending confirmation on its own; do not also plan confirmation.confirm. This engine ONLY has these three on/off toggles plus their two times — no per-goal targeting, no strictness/frequency dial, no other proactive moment; for a vaguer request like 'be stricter with this goal', 'fewer nudges please', 'less often', that finer control isn't supported — explain honestly in replyDraft instead of guessing which toggle they mean. Never plan proactive.settings_apply_update yourself; it only runs when the user confirms with an exact yes, handled deterministically. PROACTIVE_OPERATOR_DELIVERY_ENABLED/allowlist are separate, developer-only rollout controls the user cannot see or change through chat — never mention them.",
    "- For 'why didn't I get my morning brief?', 'it's 9 and no morning brief', 'I didn't get the morning brief', 'where is my morning brief?', plan proactive.diagnose_morning_brief instead of proactive.settings_show or proactive.settings_propose_update — this question is about DELIVERY, not settings, and 'that's already how it's set' is not a helpful answer to it. It returns a grounded, specific diagnosis (off, blocked by an environment/rollout control, outside the scheduled window, already sent today, or genuinely eligible) — never invent your own explanation for a missed send.",
    "- When a user describes or sets a new goal that is clearly a DAILY, RECURRING habit (e.g. 'my goal is to go to the gym every day', 'I want to apply to jobs every weekday'), it's fine to ALSO plan proactive.settings_propose_update in the same turn, proposing morningBriefEnabled/eveningCheckinEnabled true — but only ever as a proposal, exactly like any other settings change: it opens a pending confirmation, never enables anything by itself, and the user must reply with an exact yes before anything is stored. Do not do this for a one-off, non-recurring, or vague goal, and do not repeat the offer if the user already has that same toggle on or has already declined it earlier in the conversation.",
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
      // The goal this conversation is currently "about" — most recently shown/resolved/created/
      // logged against, not necessarily the newest goal that exists. When the user uses a pronoun
      // ("it," "that goal," "how's it going," "log it") and doesn't clearly mean a different goal,
      // still pass that pronoun as goalRef rather than omitting it or guessing a title yourself —
      // the tool resolves a pronoun goalRef against this focused goal deterministically.
      focusedGoal: session.focusedEntities.goal ?? null,
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
