# Operator Agent

Adaptive personal AI agent with goals, structured events, user operating profiles, risk states, intent routing, event extraction, and a Telegram-first MVP path.

## Documentation And Handoff

For orchestrator handoff, read:

- `docs/00-product-vision.md`
- `docs/01-system-architecture.md`
- `docs/05-agent-behavior.md`
- `docs/06-mvp-roadmap.md`
- `docs/07-implementation-status.md`
- `docs/08-product-capability-audit.md`
- `docs/09-architecture-inventory.md`

`docs/07-implementation-status.md` is the current implemented/partial/not-implemented ledger.
`docs/08-product-capability-audit.md` is the product capability and command-surface map.
`docs/09-architecture-inventory.md` is the current route ownership and server modularization audit.

After every implementation pass, update `README.md` and the relevant `docs/*.md` files before handing off. If a feature moves from planned to implemented, partial, or intentionally deferred, update `docs/07-implementation-status.md` too.

## Setup

```bash
pnpm install
docker compose up -d
pnpm db:generate
pnpm db:migrate
pnpm typecheck
pnpm build
```

## Local API Dev

Start the Fastify API without OpenAI analysis:

```bash
docker compose up -d
pnpm db:generate
pnpm db:migrate
USE_OPENAI_ANALYSIS=false pnpm dev:api
```

Start with optional OpenAI structured analysis:

```bash
docker compose up -d
pnpm db:generate
pnpm db:migrate
OPENAI_API_KEY=sk-... USE_OPENAI_ANALYSIS=true OPENAI_MODEL=gpt-4o-mini pnpm dev:api
```

You can also put these values in `.env` or your shell:

```bash
USE_OPENAI_ANALYSIS=true
LLM_ROUTER_ENABLED=false
DAILY_COACH_LLM_ENABLED=false
NEXT_WEEK_PLAN_LLM_ENABLED=false
OPENAI_MODEL=gpt-4o-mini
OPENAI_API_KEY=sk-...
```

When OpenAI analysis is disabled, missing, or fails validation, the API falls back to the rule-based pipeline.
The deterministic risk engine always runs after analysis and has final authority over RED betting/trading behavior.
`LLM_ROUTER_ENABLED=true` turns on the optional semantic router for normal free-text understanding. It runs after deterministic safety, pending decisions, command/reference handling, and known fast-path surfaces, but before generic chat fallbacks. It is designed for English, Spanish, and Catalan phrasing, and returns structured intent only; it cannot mutate the database directly. API executors still validate and perform any safe action. For Gmail rule conversations, Alecto keeps short-lived rule context so follow-ups such as `that rule`, `it`, `pause it`, or `when will you tell me about it?` can resolve to the recently discussed rule. `/messages/process` includes a non-user-facing `routeDebug` object with source, intent, confidence, language, side-effect risk, mutation flag, and compact reason so API smoke tests can verify whether a reply came from deterministic routing, LLM semantic routing, pending decisions, or guardrails.
**Agent Runtime v3** (`POST /agent/message`, `apps/api/src/agent-runtime/`) is the default runtime for normal Telegram chat — see the "Agent Runtime v3" section below. **Conversation Orchestrator v2 has been retired.** It briefly existed as an operation-planning path (`ConversationContext`, `AvailableOperations`, a structured OperationPlanner contract, deterministic validation/executors, a response composer) behind the `CONVERSATION_ORCHESTRATOR_V2_ENABLED` flag on `/messages/process`, plus a debug-only `/messages/process_v2` endpoint (retired earlier). Product confirmed no live deployment relied on the flag, so the whole branch and its `apps/api/src/conversation/{orchestrator-v2,context,operation-catalog,operation-planner,operation-validator,operation-executor,response-composer}.ts` modules were deleted. `/messages/process` is legacy-only now (deterministic + semantic routing, no v2 step) and remains the target of the explicit `TELEGRAM_AGENT_RUNTIME_V3_ENABLED=false` opt-out and for direct API callers who haven't moved to `/agent/message`. See `docs/09-architecture-inventory.md`'s "Conversation Orchestrator v2 — Full Retirement" for the deletion record and the current ownership map.
After intent, event extraction, and risk are finalized, `/messages/process` runs ResponseComposer v1.
The composer uses mode, risk state, profile, active goals, recent events, memories, and today's summary to produce the final reply.
If OpenAI is enabled, it may rewrite the deterministic fallback for tone, but it cannot create DB changes, invent facts, or override RED risk policy.
`/today` always builds its facts deterministically first. If `DAILY_COACH_LLM_ENABLED=true` and `OPENAI_API_KEY` is set, Alecto adds a compact LLM-written Coach section from the verified daily brief context only; if the LLM fails validation, the deterministic coach text is used.
`/plan_next_week` is deterministic by default. If `NEXT_WEEK_PLAN_LLM_ENABLED=true` and `OPENAI_API_KEY` is set, Alecto may merge in strictly validated JSON suggestions, but it still waits for explicit user confirmation before creating actions.

Start with your current environment:

```bash
pnpm dev:api
```

The API defaults to `http://localhost:3000`.

## Telegram Bot

Create a Telegram bot with BotFather, then add the token to your environment:

```bash
TELEGRAM_BOT_TOKEN=123456:your-token
API_BASE_URL=http://localhost:3000
```

Optionally restrict access to specific Telegram users. Entries can be raw numeric IDs or `telegram:<id>` values:

```bash
TELEGRAM_ALLOWED_USER_IDS=123456789,telegram:987654321
```

Replace placeholder IDs with your real Telegram user ID. Do not paste `telegram:YOUR_ID` literally. Run `/whoami` in the bot to get your ID.

If `TELEGRAM_ALLOWED_USER_IDS` is empty or missing, everyone is allowed. `/whoami` always works, even before a user is allowlisted, so people can send their Telegram ID to the owner.

Run the API and the Telegram bot in separate terminals:

```bash
pnpm dev:api
```

```bash
pnpm dev:telegram
```

Run the worker in a third terminal when you want proactive daily check-ins, insight delivery, integration sync, or action reminders:

```bash
pnpm dev:worker
```

Both the Telegram bot and worker need `TELEGRAM_BOT_TOKEN`. For local dev, reminder times use `Europe/Madrid` by default.

Telegram users are mapped to API users as `telegram:<telegramUserId>`, so each Telegram account has separate goals, events, and profile.

### Agent Runtime v3 (default Telegram normal-chat runtime)

Agent Runtime v3 (`POST /agent/message`, `apps/api/src/agent-runtime/`) is the **default** runtime for normal (non-command) Telegram text — no flag needed. `TELEGRAM_AGENT_RUNTIME_V3_ENABLED=false` is the explicit opt-out that falls back to the legacy `/messages/process` pipeline:

```bash
# default (unset) and TELEGRAM_AGENT_RUNTIME_V3_ENABLED=true both mean: use Agent Runtime v3
# only the literal string "false" opts back into the legacy pipeline
TELEGRAM_AGENT_RUNTIME_V3_ENABLED=false
```

- Slash commands (`/start`, `/help`, `/setup`, `/sync_gmail`, `/gmail_status`, `/gmail_rules`, etc.) and the Gmail OAuth callback/sync command flows keep using the existing handlers unchanged, regardless of this flag. Natural Gmail connect/reconnect/status requests, explicit Gmail/email sync requests, Gmail sync diagnostics (`why did Gmail sync find nothing?`), and Gmail alert preference changes are owned by Agent Runtime v3. V3 reuses the same OAuth URL builder and the same safe manual sync service; it never syncs Gmail unless the user explicitly asks to sync.
- If v3 errors, the bot replies with a short dev-safe message ("Agent v3 hit an error while handling that. Nothing was changed.") and logs the error — it does not fall back to `/messages/process`, so bugs stay visible instead of being silently masked.
- Agent Runtime v3's conversation/session state is **persisted** in the `AgentConversationSession` table (one row per `userId` + `channel`) — topic, pending confirmation, visible entities, recent mutations, and a bounded message history (last 20) all survive an API restart. A pending confirmation created before a restart can still be confirmed (`yes`) or cancelled (`no`/`cancel`) afterward. Each session has a sliding 24h TTL, refreshed on every turn; an expired session is treated as missing, so a stale pending confirmation can never execute — replying `yes` to one just gets "I don't have anything pending to confirm." See `apps/api/src/agent-runtime/session-store.ts` (DB mapping) and `conversation-session.ts` (per-turn load/mutate/save).
- The per-user in-memory lock (`apps/api/src/agent-runtime/user-lock.ts`) still serializes same-user turns end-to-end (including the DB read/write) — different users still process fully concurrently. DB persistence does not replace it.
- `/messages/process` and its supporting routers (deterministic surface router, legacy semantic router, `/conversation/control`, action hygiene parser) remain available but are now legacy for normal conversation — reachable only via the explicit `TELEGRAM_AGENT_RUNTIME_V3_ENABLED=false` opt-out or direct API calls. **New conversation/product work should go into Agent Runtime v3**, not the legacy pipeline. See docs/09-architecture-inventory.md's "Legacy conversation stack to remove or isolate" for what's still needed there and what isn't. Legacy code isn't deleted yet — that happens in a later cleanup pass, once v3 has proven parity.

## Product Surfaces

Natural chat now covers the main operator surfaces. Users can ask things like `what can you do`, `help me set up`, `how do I start`, `what should I configure`, `what is missing`, `set up goals`, `how do reminders work`, `set up actions`, `set up daily loop`, `what should I do today`, `anything important?`, `what needs my attention?`, `what should I handle first?`, `what emails need action?`, `hay correos importantes de Gmail?`, `anything for my job search?`, `review my day`, `review my week`, `plan this week`, `plan my week`, `plan next week`, `clean up my tasks`, `show my goals`, `show my tasks`, `show my memories`, `connect Gmail`, `reconnect Gmail`, `send me the Gmail reconnect link`, `integrate email`, `what can Gmail track`, `what email rules are on`, `what email rules do we have`, `email reviews`, `correos pendientes`, `Gmail status`, `turn on Gmail alerts`, `tell me when important emails arrive`, `avísame de correos importantes`, `enable job search rule for Gmail`, `enable work action rule for Gmail`, `create a rule for Endesa bills`, `track Endesa bills from Gmail`, `only look for Endesa`, `looks for only Aigues de Barcelona instead of Endesa`, `que reglas de email tenemos activas`, `crea una regla de Gmail para facturas de Aigues de Barcelona`, `quan m'avisareu dels correus d'Endesa?`, `where will Endesa emails go?`, `when will you let me know about new emails?`, `remove Endesa rule`, `delete all email rules`, `sync Gmail`, `sync email`, `why did Gmail sync find nothing?`, or `sync integrations`. Slash commands remain shortcuts/backdoors for precision and debugging.

Operator Loop Integration v1 uses a shared attention state for natural "what needs attention" and email-attention questions. Pending Gmail review items are surfaced in `/today`, `/start_day`, `/end_day`, `/weekly`, and weekly planning as review inbox work. They are not converted into fake ActionItems; weekly planning can point the user to `email reviews`, but cleanup suggestions for reviews are non-creatable.

Conversational Action/Hygiene Control v2 uses short-lived visible-list context for cleanup and action-control follow-ups. After `/action_hygiene` or a natural cleanup list, replies like `archive 1, snooze 2 tomorrow`, `snooze it to tomorrow`, `archive all except the read one`, `arxiva tots menys el de llegir`, `snooze el de leer hasta mañana`, and `keep the YouTube one` resolve against the visible numbered actions before global fuzzy matching. Destructive batch changes ask for confirmation, unavailable operations are refused, incomplete snooze requests ask for a time, and recent changes can be answered without falling into Gmail review or generic coaching context. This is legacy `/messages/process` behavior (the old action-hygiene natural-language parser in `apps/api/src/server.ts`) — Conversation Orchestrator v2, which briefly owned a subset of this when its flag was enabled, has been retired; see `docs/09-architecture-inventory.md`. Agent Runtime v3's `action.*` tools cover single-item operations only, not this bulk/multi-item batch language yet.

First 5 Minutes Onboarding v1 is conversation-first and shared through the API. `/start` gives a short first-run intro with four natural examples. `/setup`, `help me set up`, and `what should I configure` show Ready, Needs attention, Optional, and Best next step sections. Goal, action/reminder, daily-loop, Gmail, and GitHub setup messages guide the next safe step without requiring command memorization. These guide replies do not mutate state. Gmail remains readonly local-MVP and does not scan until the user connects Gmail and explicitly enables an email rule. In Agent Runtime v3 normal chat, Gmail connect/reconnect/status questions include the real readonly OAuth URL when configured; expired Gmail authorization is shown as a reconnect action first, with active rules as secondary context. `turn on Gmail alerts`, `tell me when important emails arrive`, and `avísame de correos importantes` change only the proactive notification setting through a confirmation flow and never start a sync; if Gmail auth is expired, the reply says alerts need reconnecting before delivery can work. Natural Gmail setup/status/list replies inspect connection state, active rules, sync mode, and active goals to recommend job-search, work-action, or custom sender/keyword tracking when relevant; questions asking what is "on" or what rules exist show email rules instead of falling into action control. Natural explicit rule requests such as `enable job search rule for Gmail`, `enable work action rule for Gmail`, `create a rule for Endesa bills`, or `track Endesa bills from Gmail` use safe rule paths; built-in job-search/work-action rule enablement reuses or reactivates existing built-in rules and archives duplicate built-in copies instead of creating more. Custom tracking asks for confirmation first and creates email review items only. Gmail sync remains query/rule-based first, then may run an optional adaptive AI rule-matching pass over only recent safe metadata fields (sender, recipients, subject, date, snippet) for messages the query pass missed; this pass matches against active Gmail rule definitions and relevant active goals, creates review items only, and never sees full bodies by default. Pending and active custom Gmail rules can be edited or questioned in normal English/Spanish/Catalan, for example `only look for Endesa`, `looks for only Aigues de Barcelona instead of Endesa`, `busca solo Aigues de Barcelona, no Endesa`, `link it to energy consumption`, `enlazalo al objetivo de consumo de energia`, `where will these emails go?`, `when will you tell me about it?`, or `quan m'avisareu dels correus nous?`. Multi-rule cleanup such as `elimina Aigues de Barcelona y Endesa` or explicit built-in rule names asks for one confirmation before archiving the matched Gmail email rules. Natural email-rule list and reset replies group equivalent duplicate built-in rules so users do not see identical repeated lines. After listing email rules, contextual reset language such as `can u delete all of em?` is treated as Gmail email-rule cleanup, not task deletion; `delete all email rules` asks before archiving all visible Gmail rules and keeps the Gmail connection plus historical reviews/events.

Normal user commands:
- `/today`, `/start_day`, `/end_day`, `/tomorrow`
- `/actions`, `/action`, `/complete_action`, `/snooze_action`, `/archive_action`
- `/action_hygiene`, `/goals`, `/goal_priorities`, `/memory`, `/remember`

Review commands:
- `/review`: factual daily event summary
- `/insight` or `/daily_insight`: interpretive daily coaching
- `/weekly`: saved weekly operator review
- `/weekly_insight`: interpretive weekly coaching
- `/weekly_last`: latest saved weekly operator review
- `/plan_next_week`: propose confirmed next-week actions from weekly review, goals, hygiene, and priorities; natural `plan this week` covers the remaining current week

Setup and settings commands:
- `/setup`, `/whoami`, `/profile`, `/set_style`
- `/notifications`, `/reminder_settings`, `/set_reminder_time`
- `/daily_loop_settings`, `/set_daily_loop`
- `/enable_checkin`, `/enable_daily_insight`, `/enable_weekly_insight`

Integration commands:
- `/integrations`, `/my_integrations`
- `/connect_github`, `/sync_integrations`, `/sync_integration`
- `/connect_gmail`, `/my_email_rules`, `/enable_email_rule`, `/sync_gmail`
- `/email_reviews`, `/approve_email_review`, `/reject_email_review`

Debug/dev commands:
- all `/debug_*` commands
- `/trigger_action_reminders`
- `/send_checkin_now`, `/send_daily_insight_now`, `/send_weekly_insight_now`
- cleanup helpers such as `/cleanup_gmail_rule_events` and `/cleanup_email_reviews`

For the full command taxonomy and capability matrix, see `docs/08-product-capability-audit.md`.

Telegram commands:

- `/start`: API-backed first-run intro
- `/whoami`: show Telegram ID and derived agent userId
- `/setup`: API-backed setup overview with goals, actions, daily loop, integrations, missing items, and best next step
- `/debug_route <message>`: allowlist-only route debug; no side effects
- `/debug_conversation_intent <message>`: allowlist-only conversational control debug
- `/debug_intent_plan <message>`: allowlist-only multi-intent plan debug
- `/profile`: show operating profile
- `/memory`: show active user-visible memories
- `/remember <text>`: save a visible memory immediately
- `/forget_memory <memoryId>`: archive a memory
- `/reflect`: generate an operator reflection
- `/reflections`: show active operator reflections
- `/forget_reflection REFLECTION_ID`: archive an operator reflection
- `/debug_reflection_context`: allowlist-only reflection context debug
- `/notifications`: show notification settings
- `/reminder_settings`: show action reminder default times
- `/set_reminder_time default 09:00`: set the default action due time; also supports `morning`, `afternoon`, `evening`, and `tonight`
- `/daily_loop_settings`: show daily operating loop settings
- `/set_daily_loop morning=09:00 evening=21:30 enabled=true`: update daily loop settings
- `/enable_checkin 09:00`: enable daily check-in reminders at local time
- `/disable_checkin`: disable daily check-in reminders
- `/send_checkin_now`: preview the same goal-aware daily check-in prompt the worker sends
- `/enable_daily_insight 21:30`: enable scheduled daily insight delivery
- `/disable_daily_insight`: disable scheduled daily insight delivery
- `/enable_weekly_insight sunday 20:00`: enable scheduled weekly insight delivery
- `/disable_weekly_insight`: disable scheduled weekly insight delivery
- `/send_daily_insight_now`: send the current daily insight immediately without creating a notification log
- `/send_weekly_insight_now`: send the current weekly insight immediately without creating a notification log
- `/set_style hard_guardian`: apply hard guardian profile defaults
- `/set_style balanced`: apply balanced profile defaults
- `/templates`: show available goal templates
- `/integrations`: show available and planned integrations
- `/my_integrations`: show your connected integrations
- `/connect_github OWNER/REPO`: watch public repo activity as external context
- `/connect_github OWNER/REPO author=LOGIN`: connect a public repo and only log matching commits
- `/pause_integration CONNECTION_ID`: pause an integration
- `/resume_integration CONNECTION_ID`: resume a paused integration
- `/delete_integration CONNECTION_ID`: archive an integration while keeping historical events
- `/sync_integrations`: sync all active integrations
- `/sync_integration CONNECTION_ID`: sync one integration
- `/connect_gmail`: get the Gmail readonly OAuth URL
- `/my_email_rules`: show Gmail email signal rules
- `/enable_email_rule job_search`: enable job-search email scanning after Gmail is connected
- `/enable_email_rule work_action`: enable review-first work/action email scanning after Gmail is connected
- `/enable_email_rule job_search goal=GOAL_ID`: attach the job-search email rule to a goal
- Natural custom Gmail rules: say `track Endesa bills from Gmail`, `track emails from client@example.com for dashboard project`, or `watch emails mentioning invoice and Endesa`; Alecto proposes a review-first rule and waits for `yes`.
- `/pause_email_rule RULE_ID`: pause an email rule
- `/resume_email_rule RULE_ID`: resume a paused email rule
- `/set_email_rule_config RULE_ID key=value`: tune a rule, for example `maxMessagesPerSync=10 maxEventsPerSync=3 classifierMode=rules`
- `/delete_email_rule RULE_ID`: archive an email rule
- `/cleanup_gmail_rule_events RULE_ID`: archive active Gmail events created by one email rule
- `/email_reviews`: show the grouped Gmail email review inbox with short-lived visible numbers
- `/email_reviews all`: show recent pending/approved/rejected email review items
- `/approve_email_review REVIEW_ID`: approve a pending email review item; core career reviews create events, work-action reviews create action items
- `/reject_email_review REVIEW_ID`: reject a pending email review item
- `/cleanup_email_reviews RULE_ID`: archive pending email review items for one rule
- `/action_help`: show manual action examples
- `/action review homepage copy tomorrow`: create a manual action item
- `/todo apply to 2 jobs tonight`: create a manual action item
- `/add_action send the CV by Friday`: create a manual action item
- `/actions`: show open action items
- `/actions all`: show recent open/completed/snoozed/archived action items
- `/complete_action ACTION_ID`: mark an action item completed
- `/snooze_action ACTION_ID tomorrow afternoon`: snooze an action item; also supports `3d`, `YYYY-MM-DD`, `tomorrow at 6pm`, and similar simple times
- `/archive_action ACTION_ID`: archive an action item
- `/action_hygiene`: review stale/overdue actions and choose cleanup decisions
- `/debug_action_hygiene`: allowlist-only detailed action hygiene report
- Multi-line batches of safe read-only commands like `/actions` and `/today`, plus `/archive_action`, `/complete_action`, and `/snooze_action`, are handled one command per line. Pasted logs/examples with slash commands are treated as reference text and are not executed.
- `/trigger_action_reminders`: dev helper that sends due/snoozed action reminders now
- `/debug_make_action_due ACTION_ID`: allowlist-only dev helper that forces an action due for reminder testing
- `/debug_make_snoozed_due ACTION_ID`: allowlist-only dev helper that forces a snoozed action due for reminder testing
- `/debug_link_actions_to_goals`: allowlist-only helper that links clear existing actions to active goals
- `/debug_daily_coach`: allowlist-only dev helper that shows whether `/today` used LLM coach text or deterministic fallback, without secrets or raw provider errors
- `/sync_gmail`: manually sync active Gmail rules
- `/sync_gmail_debug`: manually sync Gmail and show safe per-rule counters
- `/create_goal category | title | why`: create a goal
- `/create_goal_from_template templateId | title | why`: create a structured goal from a template
- `/archive_goal <goalId>`: archive a goal
- `/checkin energy=6 anxiety=4 focus=7 gambling=2 applications=2 workout=45 reading=30 sleep=7 notes=Felt okay today`: save a manual daily check-in
- `/checkin_natural`: show natural-language daily check-in examples
- `/review`: daily review
- `/today`: concise daily operator brief with a Coach section, actions, goals, wins, risks, and one deterministic next move
- `/start_day`: morning operating brief
- `/end_day`: evening review with completed/open/overdue actions
- `/tomorrow`: tomorrow prep view
- `/debug_send_start_day [force]`: allowlist-only worker-style morning brief send test
- `/debug_send_end_day [force]`: allowlist-only worker-style evening review send test
- `/debug_daily_priorities`: allowlist-only daily priority scoring debug
- `/insight`: daily interpretive coaching insight
- `/daily_insight`: alias of `/insight`
- `/weekly`: generate and save the current weekly operator review; it suggests saying `plan next week` as the next step
- `/weekly force`: regenerate the current weekly operator review with deterministic fallback
- `/weekly_last`: show the latest saved weekly operator review
- `/debug_weekly_context`: allowlist-only dev helper for the weekly review context
- `/weekly_insight`: weekly interpretive coaching insight
- `/plan_next_week`: propose next-week ActionItems with separate action/goal priorities; output is grouped into cleanup, already scheduled, and suggested new actions; reply examples only reference creatable suggestions, for example `create 3`, `create all new`, `edit 3 to Friday morning`, or `skip`
- `/debug_next_week_plan_context`: allowlist-only dev helper for next-week plan context
- `/goals`: active goals
- `/goal_priorities`: show active goal priority weights
- `/set_goal_priority GOAL_ID_OR_NUMBER low|medium|high|critical`: update one goal priority
- `/debug_backfill_goal_priorities [force]`: allowlist-only helper to apply default goal priorities
- `/events [limit]`: recent active events with ids, defaults to 5 and caps at 20
- `/events_archived [limit]`: recent events including archived/corrected status, defaults to 5 and caps at 20
- `/undo_last_event`: archive the latest logged event group
- `/delete_event <eventId>`: archive one event
- `/correct_event EVENT_ID | {"duration_minutes":30}`: correct one event while preserving history
- `/ingest <text>`: route pasted text through the generic ingestion framework
- `/ingest_job <text>`: ingest pasted job-search/recruiter text with a career domain hint
- `/pending`: show current pending profile/goal/action/hygiene decision
- `/confirm`: confirm the latest pending change
- `/cancel`: cancel the latest pending change

Normal messages can also confirm or reject pending changes. Send `yes`, `confirm`, `si`, or `dale` to confirm. Send `no`, `cancel`, or `cancelar` to reject.

Events are factual logs. Memories are durable preferences, context, and patterns. Memories are user-visible, and inferred memories are created as pending actions that require confirmation.

Verify the routes from another terminal:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/events/types
curl http://localhost:3000/goal-templates
curl http://localhost:3000/integrations
curl http://localhost:3000/goal-templates/career.job_search

curl -X POST http://localhost:3000/users/local-user/goals \
  -H "Content-Type: application/json" \
  -d '{"title":"Apply to better jobs","category":"career","why":"Build a stronger career path"}'

curl -X POST http://localhost:3000/users/local-user/goals/from-template \
  -H "Content-Type: application/json" \
  -d '{"templateId":"career.job_search","title":"Find a new Web3 developer job","why":"Build stable career capital"}'

curl http://localhost:3000/users/local-user/profile

curl http://localhost:3000/users/local-user/memory

curl -X POST http://localhost:3000/users/local-user/memory \
  -H "Content-Type: application/json" \
  -d '{"type":"preference","summary":"User prefers direct, evidence-based feedback."}'

curl -X POST http://localhost:3000/messages/process \
  -H "Content-Type: application/json" \
  -d '{"userId":"local-user","message":"remember that I hate generic motivation"}'

curl -X POST http://localhost:3000/messages/process \
  -H "Content-Type: application/json" \
  -d '{"userId":"local-user","message":"remember that when I talk about gambling I want you to be stricter, not balanced"}'

curl -X POST http://localhost:3000/messages/process \
  -H "Content-Type: application/json" \
  -d '{"userId":"local-user","message":"recuerda que prefiero que me hables directo"}'

curl http://localhost:3000/users/local-user/memory

curl -X PATCH http://localhost:3000/users/dev-user/profile \
  -H "Content-Type: application/json" \
  -d '{
    "directness": 5,
    "warmth": 3,
    "confrontation": 5,
    "profanityAllowed": true,
    "motivationalStyle": "tough_love",
    "accountabilityStrictness": 5,
    "escalationStyle": "brutal_when_needed",
    "gamblingGuardrails": "hard_guardian",
    "selfDeceptionSensitivity": 5,
    "cooldownPreference": "hard_no",
    "vulnerableMode": "soften",
    "avoidingMode": "confront",
    "impulsiveMode": "guardian_mode"
  }'

curl -X POST http://localhost:3000/messages/process \
  -H "Content-Type: application/json" \
  -d '{"userId":"local-user","message":"I sent 2 CVs and trained 45 minutes"}'

curl -X POST http://localhost:3000/messages/process \
  -H "Content-Type: application/json" \
  -d '{"userId":"local-user","message":"This Polymarket bet is safe free money"}'

curl -X POST http://localhost:3000/messages/process \
  -H "Content-Type: application/json" \
  -d '{"userId":"local-user","message":"This bet is guaranteed safe free money"}'

curl http://localhost:3000/users/local-user/pending-actions

curl -X POST http://localhost:3000/messages/process \
  -H "Content-Type: application/json" \
  -d '{"userId":"local-user","message":"yes"}'

curl -X POST http://localhost:3000/messages/process \
  -H "Content-Type: application/json" \
  -d '{"userId":"local-user","message":"he mandado un par de cvs y luego he ido al gym casi una hora"}'

curl -X POST http://localhost:3000/messages/process \
  -H "Content-Type: application/json" \
  -d '{"userId":"local-user","message":"me siento raro y no se que hacer hoy"}'

curl -X POST http://localhost:3000/messages/process \
  -H "Content-Type: application/json" \
  -d '{"userId":"local-user","message":"I feel stuck"}'

curl -X POST http://localhost:3000/messages/process \
  -H "Content-Type: application/json" \
  -d '{"userId":"local-user","message":"I feel like shit today"}'

curl -X POST http://localhost:3000/messages/process \
  -H "Content-Type: application/json" \
  -d '{"userId":"local-user","message":"what next on the repo?"}'

curl -X POST http://localhost:3000/messages/process \
  -H "Content-Type: application/json" \
  -d '{"userId":"local-user","message":"quiero apostar 1000 porque esto es seguro"}'

curl -X POST http://localhost:3000/messages/process \
  -H "Content-Type: application/json" \
  -d '{"userId":"local-user","message":"quiero apostar otra vez porque es casi seguro"}'

curl -X POST http://localhost:3000/messages/process \
  -H "Content-Type: application/json" \
  -d '{"userId":"local-user","message":"be stricter with me and do not let me justify bets"}'

curl http://localhost:3000/users/local-user/pending-actions

curl -X POST http://localhost:3000/messages/process \
  -H "Content-Type: application/json" \
  -d '{"userId":"local-user","message":"yes"}'

curl -X POST http://localhost:3000/messages/process \
  -H "Content-Type: application/json" \
  -d '{"userId":"local-user","message":"I want to focus on gym"}'

curl -X POST http://localhost:3000/messages/process \
  -H "Content-Type: application/json" \
  -d '{"userId":"local-user","message":"I want to find a new job"}'

curl -X POST http://localhost:3000/messages/process \
  -H "Content-Type: application/json" \
  -d '{"userId":"local-user","message":"no"}'

curl -X POST http://localhost:3000/users/local-user/checkins/daily \
  -H "Content-Type: application/json" \
  -d '{
    "answers": [
      { "key": "energy", "value": 6 },
      { "key": "anxiety", "value": 4 },
      { "key": "focus", "value": 7 },
      { "key": "gambling_impulse", "value": 2 },
      { "key": "applications", "value": 2 },
      { "key": "workout", "value": 45 },
      { "key": "reading", "value": 30 },
      { "key": "sleep", "value": 7 },
      { "key": "notes", "value": "Felt okay, applied to jobs." }
    ]
  }'

curl -X POST http://localhost:3000/users/local-user/checkins/daily/text \
  -H "Content-Type: application/json" \
  -d '{"text":"slept 6h, energy 5, anxiety 7, sent 2 cvs, trained 40 min, read 20 min, no gambling impulse"}'

curl -X POST http://localhost:3000/users/local-user/checkins/daily/text \
  -H "Content-Type: application/json" \
  -d '{"text":"dormi 7 horas, energia 6, ansiedad 4, foco 7, mande 3 cvs y entrené 45 min"}'

curl -X POST http://localhost:3000/users/local-user/checkins/daily/text \
  -H "Content-Type: application/json" \
  -d '{"text":"energy 6 anxiety 3 focus 8, no bets, read for half an hour"}'

curl -X POST http://localhost:3000/users/local-user/checkins/daily/text \
  -H "Content-Type: application/json" \
  -d '{"text":"hoy fatal, dormí 5h, ansiedad 8, ganas de apostar 7"}'

curl -X POST http://localhost:3000/users/local-user/ingest/text \
  -H "Content-Type: application/json" \
  -d '{"source":"manual_paste","domainHint":"career","text":"Hi Miquel, we would like to schedule an interview for the Backend Engineer role at Example Labs. Are you available this week?"}'

curl -X POST http://localhost:3000/users/local-user/ingest/text \
  -H "Content-Type: application/json" \
  -d '{"source":"manual_paste","domainHint":"career","text":"Unfortunately, we decided to move forward with other candidates for the Product Engineer role."}'

curl -X POST http://localhost:3000/messages/process \
  -H "Content-Type: application/json" \
  -d '{"userId":"local-user","message":"quiero apostar, no tengo gambling impulse"}'

curl -X POST http://localhost:3000/users/local-user/checkins/daily/text \
  -H "Content-Type: application/json" \
  -d '{"text":"dormí 5h, ansiedad 7, ganas de apostar 8"}'

curl http://localhost:3000/users/local-user/events
curl http://localhost:3000/users/local-user/events/recent
curl "http://localhost:3000/users/local-user/events/recent?includeArchived=true"

curl -X POST http://localhost:3000/users/local-user/events/undo-last \
  -H "Content-Type: application/json" \
  -d '{"scope":"group","reason":"undo last"}'

curl -X PATCH http://localhost:3000/users/local-user/events/<eventId>/archive \
  -H "Content-Type: application/json" \
  -d '{"reason":"wrongly logged"}'

curl -X POST http://localhost:3000/users/local-user/events/<eventId>/correct \
  -H "Content-Type: application/json" \
  -d '{"data":{"duration_minutes":30},"reason":"corrected by user"}'

curl -X POST http://localhost:3000/users/local-user/events/<journalEventId>/correct \
  -H "Content-Type: application/json" \
  -d '{"data":{"duration_minutes":30},"reason":"wrong event id test"}'

# Telegram manual test:
# /correct_event <journalEventId> | {"duration_minutes":30}
# should show the journal/workout-readable validation error.
# /correct_event <eventId> | {bad json}
# should show: Invalid JSON. Example: /correct_event EVENT_ID | {"duration_minutes":30}

curl http://localhost:3000/users/local-user/goals
curl http://localhost:3000/users/local-user/checkins/daily/prompt
curl http://localhost:3000/users/local-user/review/daily
curl http://localhost:3000/users/local-user/insights/daily
curl 'http://localhost:3000/users/local-user/insights/daily?date=2026-07-11'
curl http://localhost:3000/users/local-user/insights/weekly
curl 'http://localhost:3000/users/local-user/insights/weekly?weekStart=2026-07-05'

curl -X POST http://localhost:3000/users/local-user/goals/custom-config \
  -H "Content-Type: application/json" \
  -d '{"title":"Build a YouTube channel","category":"creative"}'

curl -X POST http://localhost:3000/users/local-user/goals/<goalId>/progress \
  -H "Content-Type: application/json" \
  -d '{"metricKey":"focused_minutes","value":45,"unit":"minutes","note":"script draft"}'

curl -X PATCH http://localhost:3000/users/local-user/memory/<memoryId>/archive \
  -H "Content-Type: application/json" \
  -d '{}'
```

Expected:

- `/health` returns `{ "ok": true, "service": "operator-agent-api" }`
- `/events/types` returns the initial core event registry from `docs/02-event-ontology.md`
- `/goal-templates` returns structured goal templates such as `career.job_search`, `health.strength_energy`, `health.sleep_better`, `learning.reading_more`, and `finance.control_betting_trading`.
- `/integrations` returns Integration Registry v1. `github_public` and `gmail` are available; `wallet_public` is planned.
- Gmail is a generic readonly email source. It does not scan anything until the user connects Gmail and explicitly enables an email rule.
- `job_search_email` searches user-approved Gmail results for recruiter replies, interview scheduling, application confirmations, rejections, and offers, then feeds the existing `job_search_text` ingestion adapter.
- `work_action_email` is a review-first adapter for action requests, deadlines, follow-ups, feedback, blockers, and project updates. It uses the existing Gmail source and readonly scope.
- `custom_email_review` supports user-approved sender/keyword Gmail tracking, for example Endesa bills or a client/project sender. It is review-only: matches become EmailReviewItems and never auto-create Events or ActionItems.
- Planned email adapters include richer finance receipts, learning deadlines, and custom goal email signals.
- User-facing Gmail setup is natural: `connect Gmail`, `show Gmail setup`, `Gmail status`, `what can Gmail track`, `what email rules are on`, `enable job search rule for Gmail`, `enable work action rule for Gmail`, `create a rule for Endesa bills`, `track Endesa bills from Gmail`, and `sync Gmail`.
- Natural Gmail setup/status/list replies show whether Gmail is connected, which tracking rules are active, manual-only vs scheduled mode, whether review-waiting notifications are enabled, pending review count, and goal-based recommendations for job-search, work-action, or custom sender/keyword tracking. Timing questions explain that Gmail is checked on manual sync or scheduled integration sync, not instantly on email arrival. Questions about rules that are "on" show active rules first and hide paused/error records from the normal view.
- Normal Gmail rule replies use human labels such as "Job-search email tracking", "Work-action email tracking", and custom rule names; internal adapter IDs are kept for debug/developer surfaces.
- Gmail autonomy preferences are stored on the Gmail connection config for the local MVP. Natural requests such as `check Gmail manually only`, `make Gmail manual only`, `check Gmail every hour`, `check Gmail every 2 hours`, `check Gmail daily`, `notify me when Gmail reviews are waiting`, `don't notify me about Gmail reviews`, and `turn off Gmail review notifications` ask for confirmation before changing settings. Unrelated Gmail questions cancel stale preference confirmations so a later generic `yes` does not mutate old settings. Gmail stays manual-only unless the user explicitly chooses scheduled checks. If the worker is globally disabled, Alecto says the preference was saved but background checks are not active locally.
- Proactive Gmail alerts are implemented through Agent Runtime V3 for already-created `EmailReviewItem` rows. The internal delivery type remains `gmail_nudge`, but user-facing copy says Gmail alerts/email alerts. They require `PROACTIVE_OPERATOR_DELIVERY_ENABLED=true`, user opt-in via `NotificationSettings.gmailNudgeEnabled`, a Telegram route, and the existing V3 quiet-hours/dedupe checks. Delivery stores a safe visible review reference so the user can reply naturally, for example `turn it into a task` or `ignore it`. This is notification delivery only: Gmail polling/review creation still comes from manual sync or scheduled worker sync.
- Equivalent duplicate built-in job-search/work-action rules are grouped in natural output, ignored during sync as exact duplicates, and cleaned when the built-in rule is enabled again.
- Email rules control the fetch strategy, lookback window, classifier mode, message cap, event cap, and confidence thresholds. Supported fetch strategies are `query` and `all_recent`; `sender_allowlist` and `label` are reserved for later and fail safely.
- Classifier modes are `rules`, `hybrid`, and `llm`. `rules` uses the deterministic classifier and never calls OpenAI. `hybrid` keeps hard deterministic filters first, uses rules for obvious high-confidence classifications, and can use OpenAI only for ambiguous cases when `OPENAI_API_KEY` is available. `llm` still applies hard filters before OpenAI and does not crash without a key; it marks the email for review instead of auto-logging.
- Rule sync is capped by `maxMessagesPerSync` and `maxEventsPerSync`, creates at most one event per email, and only logs approved event types from the ontology.
- Gmail OAuth tokens are stored encrypted at rest in local Postgres JSON config when `ALECTO_SECRET_ENCRYPTION_KEY` is set. Existing legacy plaintext local tokens can still be read and migrate to encrypted config on the next successful token read/sync when the key is available. Tokens, encrypted ciphertext, IVs, and auth tags are never returned by the OAuth callback, `/my_integrations`, sync responses, or Telegram replies.
- Never commit `.env`. If OAuth tokens are leaked during local testing, revoke the Google app/session and reconnect Gmail.
- `/sync_gmail` reports safe user counters, including messages checked, new review items, and new events. Agent Runtime v3 explicit phrases such as `sync Gmail`, `sync email`, `check Gmail now`, and `refresh Gmail` use the same safe manual sync path instead of passive status. If pending email reviews exist, the reply says how many are waiting and points the user to `email reviews`. Manual sync remains separate from the background schedule and does not reset the next scheduled Gmail check. Natural timing questions such as `when do you check Gmail?`, `do you check Gmail automatically?`, and `will you notify me about emails?` explain manual sync, scheduled sync status, review-notification preference, review handling, and that Gmail webhooks/instant arrival tracking are not implemented. Gmail status and rule-list replies use the same active-rule source; if multiple Gmail connections exist, active rules on an active connection are preferred, and expired/error connections return a safe reconnect message rather than raw provider details. `/sync_gmail_debug` adds per-rule IDs, LLM counters, and last errors without email bodies or tokens.
- `/users/:userId/operator-attention?now=...` returns the channel-neutral attention state used by natural attention questions, email-attention questions, `/today`, weekly review context, and planning. It includes actions, goals, risks, hygiene, latest weekly-review status, and Gmail review counts without tokens, provider payloads, or raw email bodies.
- Custom sender/keyword Gmail rules are implemented as a narrow v1 builder through natural chat. They require Gmail to be connected, reject broad requests such as "watch every email", ask for confirmation before enabling, and create email reviews only. Pending proposals and active custom rules can be corrected with replacement language such as "looks for only Aigues de Barcelona instead of Endesa", "busca solo Aigues de Barcelona, no Endesa", or Catalan equivalents. Alecto keeps short-lived rule context after rule list/status/edit replies, so follow-ups like "pause it", "when will you tell me about it?", or "can u delete all of em? i want a reset" resolve to the recently discussed rule context. Ambiguous rule management such as `elimina Endesa` stores a pending clarification; exact rule names such as `Endesa emails` are preserved; multi-target removal such as `elimina Aigues de Barcelona y Endesa` asks for one bulk confirmation; `delete all email rules` asks to remove all visible Gmail email rules, including job-search/work-action/paused rules, and destructive removal still asks for yes/no confirmation. The Gmail connection, historical email reviews, and historical events are kept. Utility/bill tracking such as Endesa or Aigues does not auto-link to the health goal just because that goal contains the word "energy." Expired pending confirmations do not block fresh Gmail rule requests.
- Email Review Inbox v1 is implemented. Natural phrases such as `email reviews`, `show Gmail reviews`, `what emails need review`, `correos pendientes`, and Catalan equivalents show grouped pending reviews for job-search, work-action, custom tracking, and other/unknown. Visible numbers are assigned in display order. Normal output uses human labels and short safe snippets, not adapter IDs, raw email bodies, raw provider JSON, tokens, ciphertext, IVs, or tags.
- After showing the email review inbox, Alecto stores a short-lived visible-number context. Follow-ups such as `show 1`, `approve 1`, `reject 2`, `approve all job-search reviews`, `reject all Endesa reviews`, `reject all the rest reviews from Endesa`, and `turn 3 into an action tomorrow` resolve only against the visible inbox and only mutate reviews that are still pending. Expired context asks the user to run `email reviews` again. Visible numbers are not permanent IDs.
- Custom Gmail reviews stay review-only by default. Approving one marks it handled but does not create unsupported Events or ActionItems; the user must explicitly say something like `turn 3 into an action tomorrow` to create an ActionItem from a custom review.
- Not implemented yet: Gmail webhooks, full-inbox/all-mail LLM monitoring, per-rule sync schedules, business-hours sync profiles, daily Gmail digest, Gmail send/label/archive/delete email mutation, and goal-specific/per-rule proactive email-notification preferences.
- Gmail dedupe skips active duplicates. Events archived by `/cleanup_gmail_rule_events` can be reprocessed after classifier fixes; normal manual archives still block recreation.
- Gmail `job_search_email` is conservative. It requires strong recruiting/job context, ignores obvious security/auth/account emails, marketing/newsletter/promotional emails, and never treats the word `offer` alone as a career offer. Security-code, verification-code, OTP, login, password-reset, and account-recovery emails are filtered before job-search or custom review creation.
- Gmail emails below auto-log confidence are not logged automatically. Uncertain messages count as `needs review`; weak matches count as low-confidence ignored or unknown.
- Gmail `needs_review` classifications create pending email review items. Approving only creates an event when the proposed event type is already in the core ontology.
- `work_action_email` reviews are different: approving `work_action_required`, `work_deadline_detected`, `work_follow_up_requested`, or `work_project_update_detected` creates an ActionItem, not an Event.
- ActionItems are things to do. Events are things that happened. Use `/action`, `/todo`, `/add_action`, `/actions`, `/complete_action`, `/snooze_action`, and `/archive_action` to manage open work items.
- Natural concrete task messages such as `I need to review homepage copy tomorrow` or `remind me to call Alex Friday` create manual ActionItems. Vague reflections and betting/trading reminders do not create actions.
- Conversational action/hygiene replies use visible context first. After `/action_hygiene`, users can say `archive 1, snooze 2 tomorrow`, `archive all except the read one`, `the dev jobs one`, or `did you archive those?`; Alecto asks confirmation for destructive batches, asks for missing snooze times, and only claims mutations that were actually written.
- Conversation-first operator requests such as `what can you do`, `help me set up`, `what should I do today`, `review my day`, `review my week`, `plan this week`, `plan my week`, `plan next week`, `clean up my tasks`, `show my goals`, `show my tasks`, `show my memories`, `connect Gmail`, `connect GitHub`, `what email rules are on`, `enable job search rule for Gmail`, `enable work action rule for Gmail`, `create a rule for Endesa bills`, `track Endesa bills from Gmail`, `when will you let me know about new emails?`, `sync Gmail`, and `sync integrations` route to the same existing read-only, explicit-mutation, or confirmation-first product surfaces.
- Hygiene-session replies are guarded against fake success: incomplete replies such as `snooze 2` ask for a time, and cleanup sessions remain active while other listed actions still need decisions.
- Natural daily-loop settings such as `turn on morning brief at 9` update settings only after the database write succeeds. Ambiguous settings requests return a concrete example instead of pretending a change happened.
- `/remember` still saves memory. If the remembered text clearly contains a concrete future task, Alecto also creates or reuses a manual ActionItem.
- Use `/cleanup_gmail_rule_events RULE_ID` to archive test Gmail events from one rule without deleting historical data.
- `/messages/process` returns a rule-based intent, mode, risk state, extracted events, and reply. Extracted events are saved in Postgres through Prisma.
- Explicit memory phrases like `remember that`, `recuerda que`, or `guarda que` create visible memories immediately and reply `Saved to memory.`
- `/users/:userId/memory` returns active memories by default. Use `?includeArchived=true` to include archived/rejected memories.
- Telegram routes explicit memory and direct betting/trading intent to `/messages/process` before considering natural check-ins.
- Natural check-ins need state context like sleep/anxiety/energy/focus, at least two progress signals, or a recent daily reminder plus a state/progress signal. Gambling words alone do not make a check-in.
- Events auto-log when detected. Profile changes, goal creation, and goal archiving proposed from natural language are stored as pending actions first and require confirmation.
- Inferred risk memories, such as repeated betting cooldowns or repeated low sleep plus high gambling impulse, are stored as `memory_create` pending actions. Reply `yes` to save the memory or `no` to ignore it.
- Repeated guardian messages should not spam duplicate `memory_create` suggestions when a similar active memory or pending memory already exists.
- Natural-language goal creation uses a matching template when obvious, but still asks for confirmation before creating the goal.
- Natural-language custom goal creation generates target metrics and check-in questions before confirmation.
- Custom goals can log progress with `custom.goal_progress_logged`, either through `POST /users/:userId/goals/:goalId/progress` or Telegram `/log_progress`.
- Telegram `/goal_plan <goalId>` shows the saved template/custom metrics, check-in questions, and progress logging examples.
- Telegram `/log_progress <goalId> | metric=focused_minutes value=45 unit=minutes note=focused block` logs structured custom progress immediately.
- Telegram `/log_progress <goalId> | worked for 45 minutes on the first draft` parses free text into a simple custom progress event.
- Natural messages like `log progress for Build a YouTube channel: worked for 45 minutes` create a pending confirmation before writing the progress event.
- Duplicate active goals are blocked by default when the title, template, or similar category/title already exists. Use `/goals` to review similar goals or archive the older one first.
- `/users/:userId/checkins/daily` saves a manual check-in as reflection events and daily review includes check-in values.
- `/users/:userId/checkins/daily/text` parses natural-language check-ins and creates the same structured events as `/checkins/daily`.
- Event reads ignore archived/corrected events by default. Add `includeArchived=true` to inspect archived/corrected audit history.
- Event corrections archive the original event as `corrected` and create a replacement event; undo/archive operations do not hard-delete events.
- Correction data is validated against the event type. For example, correcting a journal event with `duration_minutes` is rejected; correct the derived workout or reading event instead.
- Correcting a derived check-in event, such as workout duration, also updates the parent `reflection.daily_checkin_completed.data.answers` for that group.
- Check-in fields `applications`, `workout`, `reading`, and `sleep` create structured progress events. Notes are journal context unless they contain clear numeric phrases like `sent 2 CVs`, `trained 45 minutes`, or `read 30 minutes`.
- Telegram normal messages that look like daily check-ins are sent to `/checkins/daily/text`. Structured `/checkin key=value` still works.
- Generic ingestion uses the flow raw input -> ingestion router -> adapter registry -> adapter parse result -> normalized events. Future adapters should register with the ingestion registry instead of adding one-off pipelines.
- `job_search_text` is the first ingestion adapter. It classifies pasted recruiter/job-search text as application confirmation, recruiter reply, interview scheduled, rejection, offer, or unknown.
- `/ingest` and `/ingest_job` call `POST /users/:userId/ingest/text`. Telegram also routes obvious pasted job-search emails, such as recruiter interview scheduling or rejection emails, to ingestion. Casual logs like `i sent 2 cvs today` stay on the normal message/check-in path.
- `/events` and `/events_archived` truncate long data/evidence fields to avoid Telegram message length failures. Use `/events 10` or `/events_archived 10` for more, up to 20.
- Natural check-in warnings include high anxiety plus gambling impulse and low sleep.
- Daily check-in reminders, daily insights, weekly insights, and due action reminders are sent by `pnpm dev:worker`.
- Daily reminders send once per user per day because of `NotificationLog`. Daily insights use `daily_insight` logs, and weekly insights use `weekly_insight` logs.
- Use `/send_checkin_now`, `/send_daily_insight_now`, and `/send_weekly_insight_now` to test message text repeatedly without creating notification logs.
- Action reminders are sent when an open action is due or a snoozed action is back. Reminder logs prevent repeats within 12 hours, and snoozed actions are reopened after the reminder is sent.
- Action due dates use reminder preferences from `/reminder_settings`. Date-only phrases like `tomorrow` use the default action time, while `tomorrow afternoon`, `tomorrow evening`, `tonight`, `Friday morning`, and `tomorrow at 6pm` resolve to configured stable times.
- Action reminders can route only users mapped as `telegram:<id>`. Use `/debug_make_action_due`, `/debug_make_snoozed_due`, and `/trigger_action_reminders` for local testing without waiting for real due times. The debug force commands require `TELEGRAM_ALLOWED_USER_IDS`.
- Daily check-in prompts are goal-aware. Active goal templates influence the prompt, for example career goals ask about applications and interviews, health goals ask about workout/sleep, finance goals ask about impulse and thesis-before-risk.
- Custom goals with check-in config add up to two goal-specific lines to the daily check-in prompt.
- `/send_checkin_now` previews the same goal-aware prompt the worker sends.
- `/enable_daily_insight 21:30` sends `/insight` output once per day at the configured local time.
- `/enable_weekly_insight sunday 20:00` sends weekly insight output once for that week at the configured local weekday/time.
- Daily review sums progress metrics like applications, workout minutes, and reading minutes, but uses the latest state metrics for sleep, energy, anxiety, focus, and impulse.
- `/review` is factual. `/insight` and `/weekly_insight` are interpretive coaching reports built from active events, goals, memories, profile, and risk signals.
- `/today` and `/review` use the same user-local day boundaries, and natural weekly review refreshes current-week saved reviews through the latest reviewed local date instead of showing a stale week-to-date range.
- `/weekly` is a saved operator review for the current local Monday-Sunday week. It uses actions, events, goals, guardrails, action hygiene, daily-loop state, and active operator reflections; it stores one `weekly_review` memory per week and updates it on reruns.
- Daily insight identifies meaningful progress, gaps, risk state, relevant memory signals, and 1-3 recommended next actions.
- Weekly insight aggregates the last 7 days by default and looks for repeated patterns such as cooldowns, low sleep, high anxiety, and clustered progress.
- When `USE_OPENAI_ANALYSIS=true` and `OPENAI_API_KEY` is set, `/messages/process` uses OpenAI structured output for intent/mode/event analysis, validates the JSON, then still runs deterministic risk policy.
- When `LLM_ROUTER_ENABLED=true` and `OPENAI_API_KEY` is set, `/messages/process` can use an LLM semantic router for messages that fall just outside deterministic phrase rules. It is wired for the main operator surfaces, Gmail setup/sync/custom-rule create/edit/manage/question flows, recent Gmail-rule context, and conversation repair across English, Spanish, and Catalan phrasing; mutation still happens only through API executors. Route debug includes semantic language, confidence, and side-effect risk for API smoke tests.
- `CONVERSATION_ORCHESTRATOR_V2_ENABLED` and `LLM_OPERATION_PLANNER_ENABLED` no longer do anything — Conversation Orchestrator v2 has been retired (see `docs/09-architecture-inventory.md`). `/messages/process` route debug still reports `handledBy`, `plannerUsed`, `llmPlannerAttempted`, `llmPlannerUsed`, `llmPlannerFailedReason`, `policyPrecheckResult`, `mutationExecuted`, and whether legacy semantic routing was attempted/used — these are populated by the remaining legacy routers, not v2.
- ResponseComposer v1 is the final normal-chat reply layer. It supports `fiscal`, `guardian`, `support`, `mirror`, `builder`, and `review` style replies from the same structured context pack.
- Composer context includes active goals, last 10 active events, up to 5 relevant memories, the user operating profile, and today's factual summary.
- Deterministic composer fallback always works without OpenAI. If OpenAI composition fails, the fallback reply is returned.
- Guardian RED replies remain deterministic and do not validate betting/trading behavior.
- When OpenAI is enabled, insight wording may be lightly polished from the deterministic report. The LLM should not invent facts, metrics, risks, memories, or actions; if polish fails, the deterministic insight is returned.
- `/messages/process` fetches the user's operating profile and adapts guardian/vulnerable reply tone without overriding deterministic risk policy.
- RED betting/trading messages save a `finance.betting.cooldown_triggered` event and use recent stored events as risk context.
- `/users/:userId/review/daily` summarizes today's stored events against active goals.
- Daily review includes a concise `Memory signals` section when active risk-pattern memories are relevant to today's events.
- Daily review and insights treat `custom.goal_progress_logged` as real progress for custom goals, including summed minutes when the unit is `minutes`.
- GitHub public repo sync creates `coding.repo_activity_detected` when no `author=LOGIN` filter is set. That is external context, not personal progress.
- GitHub public repo sync creates `coding.commit_created` only when `author=LOGIN` is configured and the commit matches that user. Those personal commits can count as wins/progress.
- The public GitHub integration does not support private repos. A private or nonexistent repo returns a clean sync error and updates the connection `lastError`.
- Older GitHub `coding.commit_created` events without `data.isPersonal=true` are treated as unverified activity, not personal progress.
- GitHub events use `source=github`, provider metadata, and external IDs for dedupe. Running the same sync twice should not create duplicate events.
- Duplicate GitHub connections are prevented for the same normalized repo list and same `author=LOGIN`. Same repo with a different author is allowed.
- Manual sync uses `/sync_integrations` or `/sync_integration CONNECTION_ID`.
- Automatic integration sync is disabled by default. Set `INTEGRATION_SYNC_ENABLED=true` on the worker to sync active integrations in the background.
- Automatic sync interval defaults to 15 minutes. Override with `INTEGRATION_SYNC_INTERVAL_MINUTES=15`.
- Scheduled sync skips paused, archived, and error integrations, and skips active integrations synced less than the configured interval ago.
- Scheduled sync supports active GitHub and Gmail integrations. Gmail background sync runs only when the global worker switch is on, Gmail is active, at least one Gmail rule is active, and the user explicitly chose scheduled Gmail checks.
- Gmail background sync uses `gmailAutonomy.lastBackgroundSyncAttemptedAt` for the interval, so manual `/sync_gmail` does not reset the schedule. Failed background attempts update the safe background status/error and avoid a tight retry loop.
- Scheduled sync sends Telegram only when new events are created, when new Gmail review items are created, or when a connection first enters an error state. Gmail review notifications are bundled by the legacy integration notifier unless V3 Gmail alert delivery is live and eligible for that user, in which case the legacy review notification is suppressed to avoid duplicates.

Gmail OAuth setup:

```bash
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
GMAIL_REDIRECT_URI=http://localhost:3000/oauth/gmail/callback
ALECTO_SECRET_ENCRYPTION_KEY=base64-32-byte-key
```

Generate a local encryption key with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Create a Google OAuth client with the redirect URI above and the readonly Gmail scope. Then run `/connect_gmail`, open the returned URL, complete consent, and enable scanning with `/enable_email_rule job_search`. The OAuth callback only displays `Gmail connected. You can return to Telegram.`

Gmail remains readonly. It does not scan until an email rule is explicitly enabled. Gmail send/label mutation and production OAuth/account management are not implemented.

Integration Registry v1 manual test:

```bash
curl http://localhost:3000/integrations
curl http://localhost:3000/email-adapters

curl -X POST http://localhost:3000/users/dev-user/integrations/github-public \
  -H "Content-Type: application/json" \
  -d '{"repos":[{"owner":"vercel","repo":"next.js"}]}'

curl http://localhost:3000/users/dev-user/integrations

curl -X POST http://localhost:3000/users/dev-user/integrations/CONNECTION_ID/sync \
  -H "Content-Type: application/json" \
  -d '{}'

curl http://localhost:3000/users/dev-user/integrations/gmail/oauth-url

curl -X POST http://localhost:3000/users/dev-user/email-rules \
  -H "Content-Type: application/json" \
  -d '{"connectionId":"GMAIL_CONNECTION_ID","adapterId":"job_search_email","name":"Job search emails"}'
```

Telegram integration commands:

```text
/integrations
/my_integrations
/connect_github vercel/next.js
/connect_github letisfarre/alecto-ai author=letisfarre
/connect_gmail
/my_email_rules
/enable_email_rule job_search
/enable_email_rule job_search goal=GOAL_ID
/enable_email_rule work_action
/pause_email_rule RULE_ID
/resume_email_rule RULE_ID
/set_email_rule_config RULE_ID maxMessagesPerSync=10 maxEventsPerSync=3 classifierMode=rules
/set_email_rule_config RULE_ID classifierMode=hybrid
/set_email_rule_config RULE_ID classifierMode=llm
/set_email_rule_config RULE_ID fetchStrategy=all_recent lookbackDays=7
/delete_email_rule RULE_ID
/cleanup_gmail_rule_events RULE_ID
/email_reviews
/email_reviews all
/approve_email_review REVIEW_ID
/reject_email_review REVIEW_ID
/pause_integration CONNECTION_ID
/resume_integration CONNECTION_ID
/delete_integration CONNECTION_ID
/sync_integrations
/sync_integration CONNECTION_ID
/sync_gmail
/sync_gmail_debug
```

Manual insight tests:

- Normal progress day: log applications, workout, reading, and a stable check-in. `/insight` should show real wins and simple next actions.
- High-risk day: log sleep below 6h, anxiety 7+, gambling impulse 6+, or trigger a betting cooldown. `/insight` should include risks and hard guardian wording for direct/hard profiles.
- Low activity day: run `/insight` before logging events. It should say the signal is low and recommend one concrete action.
- Weekly insight summary: log events across multiple days, then run `/weekly_insight`. It should aggregate applications, workouts, reading, sleep/anxiety/focus averages, cooldown count, check-ins, and consistency patterns.
- Weekly operator review: complete or snooze actions, trigger a guardrail if relevant, add/refine an operator reflection, then run `/weekly`. It should save one weekly review memory and `/weekly_last` should show it.
- Weekly planning: run `/weekly`, then say `plan next week` or run `/plan_next_week`. Natural `plan this week` and `plan my week` plan the remaining current local week. Plan output shows `Planning window`, `Needs cleanup`, `Already scheduled`, and `Suggested new actions`. It should propose safe goal-linked actions, display action priority separately from goal priority, and create none until the user replies with a shown creatable selection, `create all new`, or another explicit selection. Stale cleanup suggestions and already-covered items are non-creatable and skipped by `create all new`. Recurring system suggestions use semantic duplicate keys, so old and new guardrail-review titles are treated as the same plan item.
- Planning UX smoke: `/weekly`, `plan next week`, `plan this week`, `plan my week`, `make a plan`, `create all new`, `/actions`, and `I need a plan to bet safely next week`. Pass if `/weekly` suggests planning next, the planning window is correct, cleanup is not creatable, already-covered/guardrail-review aliases are not recreated, reply examples only reference creatable suggestions, `create all new` creates only new actions, and betting/trading planning hits the hard guardrail.
- First 5 Minutes Onboarding: send `/start`, `help me set up`, `how do I start`, `what should I configure`, `set up goals`, `how do reminders work`, `set up daily loop`, `connect Gmail`, and `connect GitHub`. The replies should feel like a guide, not documentation; show a clear next step; avoid command dumps; expose no tokens/raw email/provider errors; and create no goals/actions/integrations/email rules unless the user gives an explicit mutation request.
- Conversation-first UX: send natural messages such as `what can you do`, `help me set up`, `what should I do today`, `review my week`, `plan next week`, `clean up my tasks`, `show my tasks`, `connect Gmail`, `show Gmail setup`, `what can Gmail track`, `what email rules are on`, `que reglas de email tenemos activas`, `enable job search rule for Gmail`, `create a rule for Endesa bills`, `track Endesa bills from Gmail`, `crea una regla de Gmail para facturas de Aigues de Barcelona`, `looks for only Aigues de Barcelona instead of Endesa`, `busca solo Aigues de Barcelona, no Endesa`, `make that rule look for only Aigues de Barcelona instead of Endesa`, `pause it`, `quan m'avisareu dels correus d'Endesa?`, `when will you let me know about new emails?`, `sync Gmail`, and `sync integrations`. They should route to the existing surfaces without exposing tokens, raw email bodies, or creating actions unless explicit confirmation/selection is required.
- Conversational action/hygiene smoke: run `/action_hygiene`, then try `archive 1, snooze 2 tomorrow`, `archive all except the read one`, `the dev jobs one`, and `did you do the archive?`. Alecto should use the visible numbered list, ask for missing snooze times, ask confirmation before destructive batches, remember recent action changes briefly, and never route these replies to Gmail review handling.
- Custom Gmail tracking smoke: with Gmail connected, send `track Endesa bills from Gmail`, verify Alecto proposes a review-first rule and waits for `yes`; send `yes`, then `sync Gmail`. Matching emails should create email reviews only. `watch every email` should be rejected as too broad. `pause Endesa emails` should pause the custom rule. `remove Endesa rule` should ask for confirmation before archiving. If both `Endesa emails` and `Endesa bills` exist, `elimina Endesa` should ask which rule, `1` or `Endesa emails` should continue to the removal confirmation, and `no` should cancel without falling into generic Gmail timing/help. `elimina Aigues de Barcelona y Endesa` should ask one confirmation for the matched custom rules. After `what email rules do we have`, `can u delete all of em? i want a reset`, `turn all off and delete them`, or `delete all email rules` should ask to remove all visible Gmail email rules and should not route to action control or multi-intent skips. If duplicate built-in work/job rules exist from older test state, natural lists and destructive confirmations should show one grouped line with a duplicate count; enabling that built-in rule again should reuse one rule and archive duplicate copies.
- Email Review Inbox smoke: after Gmail sync creates pending reviews, send `email reviews`, `show 1`, `approve 1`, `reject 2`, `approve all job-search reviews`, `reject all Endesa reviews`, `reject all the rest reviews from Endesa`, and `turn 3 into an action tomorrow`. Replies should use grouped visible numbers in display order, mutate only still-pending visible reviews, hide adapter IDs/raw bodies/secrets, keep custom reviews review-only unless explicitly turned into actions, and ask to show reviews again if the context expires.
- Semantic-router smoke: after a pending custom Gmail rule exists, send `make the looks for just Endesa`, `looks for only Aigues de Barcelona instead of Endesa`, or `busca solo Aigues de Barcelona, no Endesa`; the pending rule should update instead of logging a check-in or generic progress. After listing or editing an active custom rule, send `make that rule look for only Aigues de Barcelona instead of Endesa`, `when will you tell me about it?`, and `pause it`; Alecto should update/answer/pause the focused rule. Ask `quan m'avisareu dels correus d'Endesa?`; Alecto should explain sync timing. Send `bro what are u doing`; Alecto should acknowledge the routing failure specifically, not give generic support coaching.
- Gmail background sync smoke: with Gmail connected and at least one active rule, say `check Gmail every hour`, confirm, then run the worker with `INTEGRATION_SYNC_ENABLED=true`. The due worker pass should call the same safe Gmail sync path as `/sync_gmail` and create reviews/events according to the active rules. If new reviews are created, expect either one legacy bundled review-waiting notification or one V3 Gmail alert when `PROACTIVE_OPERATOR_DELIVERY_ENABLED=true` and the user has Gmail alerts opted in; never both for the same eligible review. Manual `sync Gmail` should still work and should not reset the background due time. Use `GET /users/:userId/integrations/gmail/background-sync/debug?now=...` to inspect eligibility, last background attempt, next due time, active rule count, and safe reason fields without tokens.

## API Routes

- `GET /health`
- `GET /events/types`
- `GET /integrations`
- `GET /email-adapters`
- `GET /goal-templates`
- `GET /goal-templates/:templateId`
- `POST /messages/process`
- `GET /users/:userId/events`
- `GET /users/:userId/events/recent`
- `PATCH /users/:userId/events/:eventId/archive`
- `PATCH /users/:userId/events/groups/:eventGroupId/archive`
- `POST /users/:userId/events/:eventId/correct`
- `POST /users/:userId/events/undo-last`
- `GET /users/:userId/goals`
- `GET /users/:userId/goals/priorities`
- `PATCH /users/:userId/goals/priorities`
- `POST /users/:userId/goals/priorities/backfill`
- `GET /users/:userId/profile`
- `PATCH /users/:userId/profile`
- `GET /users/:userId/onboarding/state`
- `GET /users/:userId/onboarding/start`
- `GET /users/:userId/onboarding/setup`
- `GET /users/:userId/memory`
- `POST /users/:userId/memory`
- `PATCH /users/:userId/memory/:memoryId/archive`
- `POST /users/:userId/reflections/generate`
- `GET /users/:userId/reflections`
- `PATCH /users/:userId/reflections/:reflectionId/archive`
- `GET /users/:userId/reflections/context`
- `GET /users/:userId/notification-settings`
- `PATCH /users/:userId/notification-settings`
- `GET /users/:userId/pending-actions`
- `POST /users/:userId/pending-actions/:pendingActionId/confirm`
- `POST /users/:userId/pending-actions/:pendingActionId/reject`
- `POST /users/:userId/goals`
- `POST /users/:userId/goals/from-template`
- `POST /users/:userId/goals/custom-config`
- `POST /users/:userId/goals/:goalId/progress`
- `PATCH /users/:userId/goals/:goalId/archive`
- `POST /users/:userId/checkins/daily`
- `POST /users/:userId/checkins/daily/text`
- `GET /users/:userId/checkins/daily/prompt`
- `POST /users/:userId/ingest/text`
- `POST /users/:userId/ingest/job-search-text`
- `GET /users/:userId/integrations`
- `GET /users/:userId/integrations/gmail/oauth-url`
- `GET /users/:userId/integrations/gmail/background-sync/debug`
- `GET /oauth/gmail/callback`
- `POST /users/:userId/integrations/github-public`
- `PATCH /users/:userId/integrations/:connectionId`
- `DELETE /users/:userId/integrations/:connectionId`
- `POST /users/:userId/integrations/:connectionId/sync`
- `GET /users/:userId/email-rules`
- `POST /users/:userId/email-rules`
- `PATCH /users/:userId/email-rules/:ruleId`
- `DELETE /users/:userId/email-rules/:ruleId`
- `GET /users/:userId/email-reviews/inbox`
- `POST /users/:userId/email-rules/:ruleId/cleanup-events`
- `POST /users/:userId/email-rules/:ruleId/cleanup-reviews`
- `GET /users/:userId/email-reviews`
- `GET /users/:userId/email-reviews?status=all`
- `POST /users/:userId/email-reviews/:reviewId/approve`
- `POST /users/:userId/email-reviews/:reviewId/reject`
- `GET /users/:userId/actions`
- `GET /users/:userId/actions?status=all`
- `GET /users/:userId/actions/hygiene`
- `POST /users/:userId/actions/hygiene/reply`
- `POST /users/:userId/actions/debug-link-goals`
- `POST /users/:userId/actions/manual`
- `PATCH /users/:userId/actions/:actionId/complete`
- `PATCH /users/:userId/actions/:actionId/snooze`
- `PATCH /users/:userId/actions/:actionId/archive`
- `POST /users/:userId/actions/reminders/trigger`
- `PATCH /users/:userId/actions/:actionId/debug-force-due`
- `PATCH /users/:userId/actions/:actionId/debug-force-snoozed-due`
- `GET /users/:userId/review/daily`
- `GET /users/:userId/today`
- `GET /users/:userId/daily-loop/start-day`
- `GET /users/:userId/daily-loop/end-day`
- `GET /users/:userId/daily-loop/tomorrow`
- `GET /users/:userId/today/debug-priorities`
- `GET /users/:userId/today/debug-daily-coach`
- `POST /users/:userId/conversation/control`
- `POST /users/:userId/conversation/multi-intent`
- `GET /users/:userId/insights/daily`
- `GET /users/:userId/insights/daily?date=YYYY-MM-DD`
- `GET /users/:userId/insights/weekly`
- `GET /users/:userId/insights/weekly?weekStart=YYYY-MM-DD`
- `POST /users/:userId/weekly-review`
- `GET /users/:userId/weekly-review/last`
- `GET /users/:userId/weekly-review/context`
- `GET /users/:userId/next-week-plan/context`
- `POST /users/:userId/next-week-plan`
- `POST /users/:userId/next-week-plan/reply`

## Packages

- `packages/core`: shared domain types, Zod schemas, risk states, user operating profile, ingestion registry/adapters, and the initial event registry.
- `packages/llm`: optional OpenAI structured message analyzer, semantic router, email classifier, daily coach, and response/insight polish helpers.
- `packages/db`: Prisma schema, client export, and repository functions for users, goals, events, memories, integrations, email rules/reviews, notifications, and action items.
- `apps/api`: Fastify API and main orchestration layer for messages, goals, events, actions, integrations, insights, daily loop, and weekly review.
- `apps/telegram-bot`: Telegram channel adapter that normalizes inbound messages and forwards business work to the API.
- `apps/worker`: interval worker for daily check-ins, insights, daily loop briefs, action reminders, and optional scheduled integration sync.

## Current Scope

This local MVP intentionally does not include UI, OpenClaw integration, WhatsApp, wallet/private-key functionality, private GitHub, vector DB/embeddings, or general app auth. Gmail has a minimal readonly OAuth flow for local MVP email ingestion with encrypted local token storage when `ALECTO_SECRET_ENCRYPTION_KEY` is configured, but production OAuth/account management and secret rotation are still not implemented.
