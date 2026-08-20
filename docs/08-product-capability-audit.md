# Product Capability Audit

Last updated: 2026-08-20

This is a product/architecture checkpoint. The implementation ledger remains `docs/07-implementation-status.md`. Route ownership and migration risks live in `docs/09-architecture-inventory.md`.

## Current Product Stage

Alecto is a **local technical alpha**.

It is usable by the founder over Telegram, with real local persistence, proactive worker jobs, Gmail/GitHub signal ingestion, ActionItems, daily/weekly operator loops, deterministic guardrails, and a conversation-first first-five-minutes onboarding/setup flow. It is not product-ready for non-technical users because auth, production OAuth/account linking, key management/rotation, settings UI, production scheduling, cross-channel UX, and broader product packaging are not ready.

## Capability Matrix

| Capability | Status | User surface | Data source | LLM role | Proactive? | Production blocker |
| --- | --- | --- | --- | --- | --- | --- |
| Telegram chat | implemented | Telegram bot | Telegram messages | optional response/analysis | yes, via worker | operational hardening |
| Normal message routing | implemented | natural text, slash commands | `NormalizedInboundMessage` | optional English/Spanish/Catalan semantic router/fallback with routeDebug metadata | no | broader semantic-router evals and cross-channel tests |
| Conversation-first UX parity | implemented | natural help/setup/review/planning/action readouts, explicit email-rule enable requests, and explicit sync requests | existing services | none required | no | richer cross-channel tests |
| First 5 Minutes Onboarding v1 | implemented | `/start`, `/setup`, natural setup/quickstart/goals/actions/daily-loop/integration messages | onboarding state from goals/actions/settings/integrations/hygiene | none | no | full guided wizard/settings UI |
| Goals | implemented | `/goals`, `/create_goal`, natural goal creation | Postgres `Goal` | optional classification | no | simpler onboarding |
| Events/check-ins | implemented | `/checkin`, natural logs, `/events`, `/review` | Postgres `Event` | optional extraction | daily check-in reminder | broader parser coverage |
| Memories | implemented | `/memory`, `/remember`, `/forget_memory` | Postgres `MemoryEntry` | optional inference | no | semantic retrieval missing |
| Operator reflections | implemented | `/reflect`, `/reflections` | events/goals/actions/memory | deterministic/local MVP | no | relevance/ranking maturity |
| User profile/tone | implemented | `/profile`, `/set_style` | `UserOperatingProfile` | optional wording | no | settings UI |
| Risk guardrails | implemented | natural text, action commands, insights | message + events + profile | cannot override RED | no | broader crisis protocols |
| Actions/reminders | implemented | `/action`, `/actions`, natural tasks | `ActionItem` | no required LLM | yes | scheduler robustness |
| Natural action control | implemented | natural complete/move/snooze/archive, visible-list replies | ActionItems/goals/PendingAction context | optional router only | no | broader evals and executor extraction |
| Multi-intent orchestration | implemented | natural multi-part messages | message segments + services | no required LLM | no | more regression tests |
| Daily loop | implemented | `/today`, `/start_day`, `/end_day`, `/tomorrow` | actions/goals/events/risks/Gmail reviews | optional Daily Coach | yes | UX consolidation |
| Operator attention | implemented | natural `anything important?`, `what needs my attention?`, `what emails need action?`, API `/operator-attention` | actions/goals/events/risks/hygiene/Gmail reviews/latest weekly review | optional semantic routing only | no | broader multilingual evals |
| Action hygiene | implemented | `/action_hygiene` | ActionItems | none | surfaced in daily loop | history/snooze analytics |
| Hygiene-session safety | implemented | natural replies such as `complete 1`, `snooze 2 tomorrow`, `archive all except the read one` | PendingAction + ActionItems | asks for missing time or confirmation | prevents fake cleanup success | full standalone interaction context store |
| Weekly review/planning | implemented | `/weekly`, `/weekly_last`, `/plan_next_week`, natural `plan this week` / `plan next week` | actions/events/goals/reflections/hygiene | optional guarded draft for review; plan is deterministic with optional mock-gated suggestions | no | more real-user planning polish |
| Weekly insight | implemented | `/weekly_insight` | active events/goals/memory/profile | optional polish | scheduled delivery available | overlaps with weekly review |
| Gmail readonly | partial | `/connect_gmail`, natural Gmail setup/status/list/sync/rule enable/custom tracking, natural autonomy preferences, multilingual pending and active custom-rule edits/questions/timing answers, bulk custom-rule removal confirmations, `/sync_gmail` | Gmail API | optional semantic router/classifier with hard deterministic filters first | manual sync or explicit per-user scheduled background sync when the worker master switch is enabled; bundled review notifications if enabled | production OAuth/account management, key rotation, broader real-user evals |
| Gmail review inbox | implemented | `/email_reviews`, natural `email reviews`, `show 1`, `approve 1`, `reject 2`, `reject all the rest reviews from Endesa`, `turn 3 into an action tomorrow` | EmailReviewItem | optional classifier/router | bundled scheduled review-waiting notifications | richer review UX, web UI |
| GitHub public sync | implemented | `/connect_github`, sync commands | public GitHub API | none | scheduled sync available | private/OAuth unsupported |
| Worker proactive jobs | implemented | settings + worker | DB schedules/logs | none | yes | production scheduling/observability |
| OpenAI/LLM layer | partial | env-gated | message/context packs | optional only | no | evals, cost, observability |
| Semantic memory/vector search | not implemented | none | none | not used | no | vector store/design |
| WhatsApp/OpenClaw/web/mobile | not implemented | none | none | none | no | channel adapters/UX |
| Production OAuth/auth | not implemented | Gmail local only | local MVP encrypted token config | none | no | auth/security design |
| Token encryption | implemented | none | encrypted DB config when `ALECTO_SECRET_ENCRYPTION_KEY` is set | none | no | key management/rotation |
| Calendar/health/wallet integrations | not implemented | registry/planned only | none | none | no | integration design |

## Command Surface Map

### 1. Core User Commands

Commands a real user should know:
- `/today`
- `/start_day`
- `/end_day`
- `/tomorrow`
- `/actions`
- `/action <task>`
- `/complete_action ACTION_ID`
- `/snooze_action ACTION_ID <time>`
- `/archive_action ACTION_ID`
- `/action_hygiene`
- `/goals`
- `/goal_priorities`
- `/set_goal_priority GOAL_ID_OR_NUMBER low|medium|high|critical`
- `/memory`
- `/remember <text>`
- `/review`
- `/weekly`

### 2. Natural-Language-First Commands

These exist, but normal messages should often replace them:
- `/action`, `/todo`, `/add_action`
- `/complete_action`
- `/snooze_action`
- `/archive_action`
- `/create_goal`
- `/log_progress`
- `/checkin`
- `/remember`
- `/today`, `/review`, `/weekly`, `/plan_next_week`, `/action_hygiene`, `/goals`, `/actions`, `/memory`, and integration setup readouts

Expected natural alternatives:
- `I need to call Alex tomorrow`
- `move YouTube script to tomorrow afternoon`
- `done with apply to 2 jobs`
- `archive 1, snooze 2 tomorrow`
- `archive all except the read one`
- `the dev jobs one`
- `slept 6h, energy 5, anxiety 7, trained 30 min`
- `remember that I hate generic motivation`
- `what can you do`
- `help me set up`
- `what should I do today`
- `anything important?`
- `what needs my attention?`
- `what should I handle first?`
- `what emails need action?`
- `hay correos importantes de Gmail?`
- `anything for my job search?`
- `review my week`
- `plan this week`
- `plan next week`
- `clean up my tasks`
- `show my goals`
- `connect Gmail`
- `what can Gmail track`
- `what email rules are on`
- `email reviews`
- `correos pendientes`
- `show Gmail setup`
- `Gmail status`
- `enable job search rule for Gmail`
- `enable work action rule for Gmail`
- `create a rule for Endesa bills`
- `track Endesa bills from Gmail`
- `crea una regla de Gmail para facturas de Aigues de Barcelona`
- `when will you let me know about new emails?`
- `only look for Endesa`
- `looks for only Aigues de Barcelona instead of Endesa`
- `make that rule look for only Aigues de Barcelona instead of Endesa`
- `pause it`
- `busca solo Aigues de Barcelona, no Endesa`
- `quan m'avisareu dels correus d'Endesa?`
- `where will Endesa emails go?`
- `check Gmail every hour`
- `make Gmail manual only`
- `notify me when Gmail reviews are waiting`
- `don't notify me about Gmail reviews`
- `turn off Gmail review notifications`
- `daily Gmail digest`
- `check Gmail during work hours`
- `pause Endesa emails`
- `remove Endesa rule`
- `sync Gmail`
- `sync integrations`

### 3. Review And Planning Commands

- `/review`: factual daily review of logged events. Does not store a durable review.
- `/insight` and `/daily_insight`: interpretive daily coaching report. Does not store a durable review.
- `/today`: operator brief for the current local day, focused on actions, priorities, goals, risks, and next move. Does not store a weekly memory.
- `/start_day`: morning brief from the daily operating loop. Can be sent proactively by the worker.
- `/end_day`: evening review from the daily operating loop. Can be sent proactively by the worker.
- `/tomorrow`: next-day prep view.
- `/weekly`: saved weekly operator review. Stores/updates one weekly review memory for the local week.
- `/weekly force`: regenerates the weekly operator review.
- `/weekly_last`: shows the latest saved weekly operator review.
- `/weekly_insight`: interpretive weekly insight report. Separate from saved `/weekly`.
- `/plan_next_week`: proposes next-week ActionItems from the latest weekly review, active goals, hygiene, priorities, guardrails, and existing future actions. It displays ActionItem priority separately from linked goal priority, because critical goals create high-priority actions when the ActionItem model does not support `critical`. Cleanup suggestions for stale existing actions are shown as non-creatable and point to `/action_hygiene` or natural action control. Recurring system suggestions use semantic duplicate keys, so equivalent guardrail-review titles are already-covered instead of recreated. It creates no actions until the user replies with a shown creatable selection, `create all new`, or another explicit selection.
- Natural planning supports `plan this week` / `plan my week` for the remaining current local week and `plan next week` for the next local week. Ambiguous `make a plan` asks whether the user means this week or next week unless there is active plan context.

### 4. Integration Setup Commands

- `/integrations`
- `/my_integrations`
- `/connect_github OWNER/REPO`
- `/connect_github OWNER/REPO author=LOGIN`
- `/pause_integration CONNECTION_ID`
- `/resume_integration CONNECTION_ID`
- `/delete_integration CONNECTION_ID`
- `/sync_integrations`
- `/sync_integration CONNECTION_ID`
- `/connect_gmail`
- `/my_email_rules`
- `/enable_email_rule job_search`
- `/enable_email_rule work_action`
- `/pause_email_rule RULE_ID`
- `/resume_email_rule RULE_ID`
- `/set_email_rule_config RULE_ID key=value`
- `/delete_email_rule RULE_ID`
- `/sync_gmail`
- `/sync_gmail_debug`
- `/cleanup_gmail_rule_events RULE_ID`
- `/email_reviews`
- `/email_reviews all`
- `/approve_email_review REVIEW_ID`
- `/reject_email_review REVIEW_ID`
- `/cleanup_email_reviews RULE_ID`

### 5. Admin And Settings Commands

- `/setup`
- `/whoami`
- `/profile`
- `/set_style hard_guardian`
- `/set_style balanced`
- `/notifications`
- `/reminder_settings`
- `/set_reminder_time default 09:00`
- `/daily_loop_settings`
- `/set_daily_loop morning=09:00 evening=21:30 enabled=true`
- `/enable_checkin 09:00`
- `/disable_checkin`
- `/enable_daily_insight 21:30`
- `/disable_daily_insight`
- `/enable_weekly_insight sunday 20:00`
- `/disable_weekly_insight`
- `/templates`
- `/goal_plan GOAL_ID`
- `/create_goal_from_template`
- `/archive_goal`
- `/forget_memory`
- `/forget_reflection`
- `/events`
- `/events_archived`
- `/undo_last_event`
- `/delete_event`
- `/correct_event`

### 6. Debug And Dev Commands

- `/debug_route`
- `/debug_conversation_intent`
- `/debug_intent_plan`
- `/debug_reflection_context`
- `/debug_action_hygiene`
- `/trigger_action_reminders`
- `/debug_make_action_due`
- `/debug_make_snoozed_due`
- `/debug_link_actions_to_goals`
- `/debug_daily_coach`
- `/debug_send_start_day`
- `/debug_send_end_day`
- `/debug_daily_priorities`
- `/debug_weekly_context`
- `/debug_backfill_goal_priorities`
- `/send_checkin_now`
- `/send_daily_insight_now`
- `/send_weekly_insight_now`

### 7. Deprecated, Stub, Or Placeholder Commands

No commands are currently removed or deprecated at runtime. There are no known user-facing placeholder commands in the main operator loop.

## Review Surface Distinction

| Command | Purpose | Source data | Stores anything? | Deterministic or LLM-assisted? | When to use |
| --- | --- | --- | --- | --- | --- |
| `/review` | factual daily event summary | active events/check-ins/goals | no | deterministic | "What did I log today?" |
| `/insight` | interpretive daily coaching | events/goals/memory/profile/risk | no | deterministic with optional polish | "What does today mean?" |
| `/daily_insight` | alias of `/insight` | same as `/insight` | no | same as `/insight` | user preference/clarity |
| `/today` | daily operator brief | actions/goals/events/risks/hygiene/Gmail reviews | no | deterministic with optional validated Daily Coach | "What should I do now/today?" |
| `/start_day` | morning operating brief | actions/goals/risks/hygiene/Gmail reviews | can mark sent in worker/debug path | deterministic | start-of-day execution |
| `/end_day` | evening review | completed/open actions/events/risks/Gmail reviews | can mark sent in worker/debug path | deterministic | close the day |
| `/tomorrow` | next-day prep | tomorrow actions and open priorities | no | deterministic | prepare tomorrow |
| `/weekly` | saved weekly operator review | actions/events/goals/reflections/guardrails/Gmail reviews | yes, `MemoryEntry` weekly review | deterministic with guarded optional LLM draft | create durable weekly record |
| `/plan_next_week` | confirmed next-week planning | weekly review/goals/actions/hygiene/guardrails/Gmail reviews | yes, selected `ActionItem`s only after explicit user reply; Gmail-review cleanup is non-creatable | deterministic with optional mock-gated suggestion parse | turn review into next-week execution |
| natural `plan this week` / `plan my week` | confirmed remaining-week planning | weekly review/goals/actions/hygiene/guardrails/Gmail reviews | yes, selected `ActionItem`s only after explicit user reply; Gmail-review cleanup is non-creatable | deterministic with optional mock-gated suggestion parse | create a current-week action plan without command memorization |
| `/weekly_insight` | interpretive weekly insight | active weekly events/goals/memory/profile | no | deterministic with optional polish | quick weekly coaching read |

## Message-First Happy Path

The target product should work mostly without command memorization:

1. Morning: Alecto sends a `/start_day`-style brief with the first move, top open actions, and guardrail watchouts.
2. During the day: the user replies naturally with updates, tasks, reschedules, completions, or reflections.
3. Alecto routes natural help/setup/review/planning/readout requests to the existing services; it logs events/actions only when appropriate, asks clarification when ambiguous, and asks confirmation before destructive changes.
4. Visible list replies use the last relevant action, hygiene, Gmail-rule, email-review, or planning context before global matching.
5. Due actions and snoozed actions resurface automatically through reminders.
6. Email/GitHub sync quietly gathers approved signals; Gmail review items wait for user approval before becoming events or actions and surface in natural attention, `/today`, `/start_day`, `/end_day`, `/weekly`, and planning as inbox work.
7. Evening: Alecto sends an `/end_day`-style review and asks for remaining cleanup.
8. Weekly: Alecto creates a `/weekly` operator review, points the user to `plan next week`, then `/plan_next_week` or natural planning proposes a confirmed action plan.
9. The user approves selected actions; Alecto does not silently invent plans or mutate state.
10. API smoke tests can inspect `routeDebug` on `/messages/process` to confirm whether a reply came from deterministic routing, LLM semantic routing, pending decisions, or guardrails.

## Current Autonomy Level

- Can it read mail independently? **Partially.** Gmail can sync readonly after OAuth and explicit active email rules. Natural `show Gmail setup`, `Gmail status`, `what can Gmail track`, `what email rules are on`, `what email rules do we have`, `enable job search rule for Gmail`, `enable work action rule for Gmail`, and custom requests such as `create a rule for Endesa bills`, `track Endesa bills from Gmail`, or Spanish/Catalan equivalents explain current state and use safe rule paths; natural `sync Gmail` uses the same safe sync path. Natural timing questions such as `when do u check my gmail?`, `do you check Gmail automatically?`, and `will you notify me about emails?` explain manual sync, scheduled sync status, review-notification preference, no instant Gmail webhooks, and review handling before any broad custom-rule path can run. Natural preference changes such as `check Gmail every hour`, `make Gmail manual only`, and `turn off Gmail review notifications` ask for confirmation before saving Gmail connection preferences. Gmail stays manual-only by default; background Gmail sync runs only when the global worker master switch is enabled, the user explicitly chose scheduled checks, Gmail has at least one active rule, and the per-connection interval is due. Manual `sync Gmail` does not reset the background due time. If worker scheduling is globally disabled, Alecto says the preference is saved but background checks are not active locally. Daily digest and work-hours checks are recognized but not implemented. No active rule means no scanning. Custom sender/keyword tracking is implemented as review-only v1 and requires confirmation before enabling. Pending proposals and active custom rules can be edited or questioned in natural language, including keyword replacement wording such as `looks for only Aigues de Barcelona instead of Endesa`, `busca solo Aigues de Barcelona, no Endesa`, follow-ups like `make that rule look for only Aigues de Barcelona instead of Endesa` or `pause it`, and sync/timing questions such as `when will you let me know about it?` or `quan m'avisareu dels correus d'Endesa?`. Ambiguous rule management such as `elimina Endesa` stores a pending clarification, accepts number/name replies, and still confirms before removal. Multi-target cleanup such as `elimina Aigues de Barcelona y Endesa` asks one confirmation for matched Gmail email rules. Contextual reset/delete-all phrasing after a rule list, such as `can u delete all of em?`, `turn all off and delete them`, or `delete all email rules`, asks to remove all visible Gmail email rules after confirmation and does not fall into action-control or multi-intent matching. Duplicate built-in job-search/work-action rules are grouped in natural output, ignored during sync as exact duplicates, and cleaned when the built-in rule is enabled again. `email reviews` and Spanish/Catalan pending-email phrases show a grouped short-lived review inbox with visible numbers in display order; `show 1`, `approve 1`, `reject 2`, `reject all the rest reviews from Endesa`, and `turn 3 into an action tomorrow` operate only on still-pending visible reviews. Security/auth/account emails are hard-filtered before job-search or custom review creation. Scheduled sync can send one bundled "Gmail reviews are waiting" notification when new review items are created and the Gmail notification preference allows it. The Gmail connection and historical email reviews/events are kept. Utility/bill tracking avoids false links to the health `energy` goal unless a real utility/expense goal exists.
- Can it ask for updates alone? **Yes.** Worker can send daily check-ins, daily insights, weekly insights, and daily loop briefs.
- Can it create actions from email? **Yes, with review.** `work_action_email` creates review items; approval creates ActionItems.
- Can it send emails? **No.**
- Can it remember? **Yes.** Explicit memories are saved; inferred memories require confirmation.
- Can it use LLMs? **Yes, optionally.** OpenAI is env-gated and validated.
- Can it operate without LLMs? **Yes.** Deterministic fallback is required and implemented.
- Can it work for users today? **For a technical/founder local alpha user, yes.** For general users, no.
- What blocks production? **Auth/security, production OAuth/account linking, key management/rotation, onboarding, UX simplification, broader operator-attention evals, scheduling/observability, and product packaging.**

## Production Readiness Checklist

### Security/Auth

- [x] encrypt Gmail tokens at rest for the local MVP
- [ ] production OAuth/account linking
- [ ] multi-user auth and isolation beyond Telegram ID mapping
- [ ] secret management and rotation
- [ ] audit logging for sensitive operations

### Product UX

- [x] local alpha conversation-first first-five-minutes onboarding/setup flow
- [ ] production onboarding wizard/settings UI
- [ ] simplified command surface
- [ ] user settings UI
- [ ] dashboard/web/mobile/WhatsApp/OpenClaw surfaces
- [x] review/planning consolidation v1

### Reliability

- [ ] production scheduler or job queue
- [ ] worker health monitoring
- [ ] retry/backoff policy
- [ ] idempotency tests for every proactive job
- [ ] structured observability/logging

### Agent Quality

- [ ] semantic memory/vector search
- [ ] better reflection relevance/ranking
- [x] Planning UX Consolidation v1; `/weekly` points to planning, natural this-week/next-week planning is supported, grouped plan output separates cleanup/already scheduled/new actions, recurring system suggestions are semantically deduped, and reply examples only show creatable indexes
- [x] Conversational Action/Hygiene Control v2 covers visible-list references, cleanup batches, all-except replies, recent action mutation status, and cross-domain context safety
- [x] ~~Conversation Orchestrator v2 Phase 1~~ — **retired.** It covered an operation-planning path for selected scopes (`/messages/process_v2`, `CONVERSATION_ORCHESTRATOR_V2_ENABLED=true`, `ConversationContext`, `AvailableOperations`, structured planner contract, validator/executors, response composer). Product confirmed no live deployment relied on the flag; the branch, its `apps/api/src/conversation/` modules, and its golden-transcript test file were all deleted — see `docs/09-architecture-inventory.md`'s "Conversation Orchestrator v2 — Full Retirement". **Agent Runtime v3** (`POST /agent/message`) is the actual default normal-chat runtime today, and independently reimplements memory, progress logging, and selected read surfaces — unrelated to v2's code.
- [ ] broader guardrails beyond betting/trading
- [~] API smoke tests cover key conversation routing paths, including multilingual Gmail custom-rule setup/edit/question/manage flows, list/reset phrasing, bulk custom-rule cleanup, utility-goal-link safety, and LLM semantic-router mock routing. (Conversation Orchestrator v2's golden-transcript tests were deleted along with v2 itself — see `docs/09-architecture-inventory.md`. `tests/messages-process-legacy.test.ts` now covers `/messages/process`'s remaining legacy path plus confirming Agent Runtime v3 is unaffected.)
- [ ] broader eval set for routing, action control, Gmail rule wizard, multilingual conversation repair, and LLM coach validation

### Integrations

- [ ] Gmail send/label not implemented
- [ ] private GitHub not implemented
- [ ] calendar integrations not implemented
- [ ] health integrations not implemented
- [ ] wallet integrations not implemented

## Recommended Next Build Choices

### 1. Real-World Planning Polish - Recommended

Why:
- Planning UX Consolidation v1 is implemented, but real Telegram usage should decide the next simplifications.
- The highest leverage is now tightening wording, edge-case selection, and plan/session behavior from observed logs.

Suggested scope:
- Keep confirmation explicit.
- Do not add new planning commands.
- Preserve cleanup/already-covered/new grouping and `create all new` semantics.

Risk:
- Avoid auto-creating actions. Keep confirmation explicit.

### 2. Gmail Autonomy v1 Follow-Up

Why:
- It makes external signals more useful.
- Gmail already has OAuth, rules, review inbox, work/action adapters, custom sender/keyword review-only tracking, state-aware setup/status/timing replies, manual/scheduled sync preference, worker-executed scheduled background sync when globally enabled, review-notification preference, and bundled review-waiting notifications on scheduled sync.
- A good next step is making review handling and setup feel more guided without increasing email-side automation.
- Architecture boundary: do not design Gmail nudges as a one-off closed system. The long-term shape is `integration observation -> goal/action/calendar/memory/evidence candidate -> V3 tool/action`. `EmailReviewItem` remains fine as the current Gmail source object, but downstream product decisions should be generic operations such as create action, log goal evidence, ask clarification, or later suggest a calendar event. Calendar is not implemented and no fake Calendar tools should be added yet; document where it would plug in instead.

Suggested scope:
- Keep testing goal-linked Gmail recommendations from real usage: job/work goals should suggest relevant Gmail tracking, while utility/expense goals should suggest custom sender/keyword tracking.
- Add business-hours checks, per-rule schedules, and daily digest only after manual/scheduled connection-level preferences prove stable.
- Expand notification settings beyond connection-level review notifications only after the current bundled review-waiting notification has more real-user evals.
- Keep custom rules review-first unless the user explicitly chooses stronger automation.
- Treat full-inbox/all-mail LLM analysis and Gmail webhooks as later production work after OAuth/account settings, privacy copy, and cost controls are clearer.

Risk:
- More email automation increases privacy/security expectations.
- Production OAuth/account linking, key management, broader rule-management UX, and review-notification UX should come before broader Gmail autonomy.

### 3. Production Onboarding And Settings UX

Why:
- First 5 Minutes Onboarding v1 exists for the local alpha, but production users still need account/auth, secure settings, and a cleaner guided setup surface.

Risk:
- Do not mark production OAuth/account management, key management, or secret rotation complete until they are actually implemented.

## Recommendation

Build **Real-World Planning Polish** next only after another Telegram log pass.

First 5 Minutes Onboarding v1, Planning UX Consolidation v1, Operator Loop Integration + Natural Understanding v1, and Conversational Action/Hygiene Control v2 are now implemented for the local alpha. Gmail token encryption at rest, custom sender/keyword Gmail tracking v1, active Gmail rule editing, short-lived Gmail rule conversation context, bulk custom Gmail rule cleanup, Email Review Inbox v1, Gmail Setup + Autonomy Preferences v1, bundled scheduled review-waiting notifications, natural operator/email attention, and LLM Semantic Router v4 are implemented for the local MVP. Conversation Orchestrator v2 has been **retired** — the operation-planning path it briefly ran (behind `CONVERSATION_ORCHESTRATOR_V2_ENABLED=true` and `LLM_OPERATION_PLANNER_ENABLED=true`) was deleted after product confirmed no live deployment relied on it; see `docs/09-architecture-inventory.md`'s "Conversation Orchestrator v2 — Full Retirement". **Agent Runtime v3** (`POST /agent/message`) is the actual default normal-chat runtime today, independently reimplementing memory, progress logging, and selected read surfaces — unrelated to v2's deleted code. Route ownership/debug is documented in `docs/09-architecture-inventory.md`, and message route registration has moved out of `server.ts` into `apps/api/src/routes/`. Legacy `/messages/process` routing owns everything Agent Runtime v3's tool catalog doesn't yet cover (full Gmail rule management, planning, daily loop, bulk action hygiene, generic chat), and `server.ts` remains oversized. The next high-leverage work is migrating more surfaces into Agent Runtime v3's tool catalog, building a broader planner eval set from real Telegram logs across English, Spanish, and Catalan, smoothing Gmail review inbox/autonomy UX, and reducing observed operator-loop friction without adding integrations or auto-creating actions. Broader Gmail autonomy such as business-hours checks, daily digest, full-inbox LLM monitoring, and webhooks should wait until production OAuth/account management, key management/rotation, privacy copy, and cost controls are clearer.
