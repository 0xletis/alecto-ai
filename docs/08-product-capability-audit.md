# Product Capability Audit

Last updated: 2026-08-06

This is a product/architecture checkpoint. The implementation ledger remains `docs/07-implementation-status.md`.

## Current Product Stage

Alecto is a **local technical alpha**.

It is usable by the founder over Telegram, with real local persistence, proactive worker jobs, Gmail/GitHub signal ingestion, ActionItems, daily/weekly operator loops, and deterministic guardrails. It is not product-ready for non-technical users because onboarding, auth, token encryption, settings UI, production scheduling, and cross-channel UX are not ready.

## Capability Matrix

| Capability | Status | User surface | Data source | LLM role | Proactive? | Production blocker |
| --- | --- | --- | --- | --- | --- | --- |
| Telegram chat | implemented | Telegram bot | Telegram messages | optional response/analysis | yes, via worker | operational hardening |
| Normal message routing | implemented | natural text, slash commands | `NormalizedInboundMessage` | optional fallback only | no | more channel tests |
| Goals | implemented | `/goals`, `/create_goal`, natural goal creation | Postgres `Goal` | optional classification | no | simpler onboarding |
| Events/check-ins | implemented | `/checkin`, natural logs, `/events`, `/review` | Postgres `Event` | optional extraction | daily check-in reminder | broader parser coverage |
| Memories | implemented | `/memory`, `/remember`, `/forget_memory` | Postgres `MemoryEntry` | optional inference | no | semantic retrieval missing |
| Operator reflections | implemented | `/reflect`, `/reflections` | events/goals/actions/memory | deterministic/local MVP | no | relevance/ranking maturity |
| User profile/tone | implemented | `/profile`, `/set_style` | `UserOperatingProfile` | optional wording | no | settings UI |
| Risk guardrails | implemented | natural text, action commands, insights | message + events + profile | cannot override RED | no | broader crisis protocols |
| Actions/reminders | implemented | `/action`, `/actions`, natural tasks | `ActionItem` | no required LLM | yes | scheduler robustness |
| Natural action control | implemented | natural complete/move/snooze/archive | ActionItems/goals | no required LLM | no | ambiguity coverage |
| Multi-intent orchestration | implemented | natural multi-part messages | message segments + services | no required LLM | no | more regression tests |
| Daily loop | implemented | `/today`, `/start_day`, `/end_day`, `/tomorrow` | actions/goals/events/risks | optional Daily Coach | yes | UX consolidation |
| Action hygiene | implemented | `/action_hygiene` | ActionItems | none | surfaced in daily loop | history/snooze analytics |
| Weekly review/planning | implemented | `/weekly`, `/weekly_last`, `/plan_next_week` | actions/events/goals/reflections/hygiene | optional guarded draft for review; plan is deterministic with optional mock-gated suggestions | no | planning UX consolidation |
| Weekly insight | implemented | `/weekly_insight` | active events/goals/memory/profile | optional polish | scheduled delivery available | overlaps with weekly review |
| Gmail readonly | partial | `/connect_gmail`, `/sync_gmail` | Gmail API | optional classifier | scheduled sync available | token encryption/OAuth production |
| Gmail review queue | implemented | `/email_reviews`, approve/reject | EmailReviewItem | optional classifier | no direct push yet | reviewer UX |
| GitHub public sync | implemented | `/connect_github`, sync commands | public GitHub API | none | scheduled sync available | private/OAuth unsupported |
| Worker proactive jobs | implemented | settings + worker | DB schedules/logs | none | yes | production scheduling/observability |
| OpenAI/LLM layer | partial | env-gated | message/context packs | optional only | no | evals, cost, observability |
| Semantic memory/vector search | not implemented | none | none | not used | no | vector store/design |
| WhatsApp/OpenClaw/web/mobile | not implemented | none | none | none | no | channel adapters/UX |
| Production OAuth/auth | not implemented | Gmail local only | local MVP tokens | none | no | auth/security design |
| Token encryption | not implemented | none | DB config contains local tokens | none | no | encryption/key management |
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

Expected natural alternatives:
- `I need to call Alex tomorrow`
- `move YouTube script to tomorrow afternoon`
- `done with apply to 2 jobs`
- `slept 6h, energy 5, anxiety 7, trained 30 min`
- `remember that I hate generic motivation`

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
- `/plan_next_week`: proposes next-week ActionItems from the latest weekly review, active goals, hygiene, priorities, guardrails, and existing future actions. It displays ActionItem priority separately from linked goal priority, because critical goals create high-priority actions when the ActionItem model does not support `critical`. Cleanup suggestions for stale existing actions are shown as non-creatable and point to `/action_hygiene` or natural action control. It creates no actions until the user replies with `create 1`, `create all`, or another explicit selection.

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
| `/today` | daily operator brief | actions/goals/events/risks/hygiene | no | deterministic with optional validated Daily Coach | "What should I do now/today?" |
| `/start_day` | morning operating brief | actions/goals/risks/hygiene | can mark sent in worker/debug path | deterministic | start-of-day execution |
| `/end_day` | evening review | completed/open actions/events/risks | can mark sent in worker/debug path | deterministic | close the day |
| `/tomorrow` | next-day prep | tomorrow actions and open priorities | no | deterministic | prepare tomorrow |
| `/weekly` | saved weekly operator review | actions/events/goals/reflections/guardrails | yes, `MemoryEntry` weekly review | deterministic with guarded optional LLM draft | create durable weekly record |
| `/plan_next_week` | confirmed next-week planning | weekly review/goals/actions/hygiene/guardrails | yes, selected `ActionItem`s only after explicit user reply | deterministic with optional mock-gated suggestion parse | turn review into next-week execution |
| `/weekly_insight` | interpretive weekly insight | active weekly events/goals/memory/profile | no | deterministic with optional polish | quick weekly coaching read |

## Message-First Happy Path

The target product should work mostly without command memorization:

1. Morning: Alecto sends a `/start_day`-style brief with the first move, top open actions, and guardrail watchouts.
2. During the day: the user replies naturally with updates, tasks, reschedules, completions, or reflections.
3. Alecto logs events/actions only when appropriate, asks clarification when ambiguous, and asks confirmation before destructive changes.
4. Due actions and snoozed actions resurface automatically through reminders.
5. Email/GitHub sync quietly gathers approved signals; Gmail review items wait for user approval before becoming events or actions.
6. Evening: Alecto sends an `/end_day`-style review and asks for remaining cleanup.
7. Weekly: Alecto creates a `/weekly` operator review, then `/plan_next_week` proposes a confirmed next-week action plan.
8. The user approves selected actions; Alecto does not silently invent plans or mutate state.

## Current Autonomy Level

- Can it read mail independently? **Partially.** Gmail can sync readonly after OAuth and explicit active email rules. No rule means no scanning.
- Can it ask for updates alone? **Yes.** Worker can send daily check-ins, daily insights, weekly insights, and daily loop briefs.
- Can it create actions from email? **Yes, with review.** `work_action_email` creates review items; approval creates ActionItems.
- Can it send emails? **No.**
- Can it remember? **Yes.** Explicit memories are saved; inferred memories require confirmation.
- Can it use LLMs? **Yes, optionally.** OpenAI is env-gated and validated.
- Can it operate without LLMs? **Yes.** Deterministic fallback is required and implemented.
- Can it work for users today? **For a technical/founder local alpha user, yes.** For general users, no.
- What blocks production? **Auth/security, token encryption, onboarding, UX simplification, scheduling/observability, and product packaging.**

## Production Readiness Checklist

### Security/Auth

- [ ] encrypt Gmail tokens at rest
- [ ] production OAuth/account linking
- [ ] multi-user auth and isolation beyond Telegram ID mapping
- [ ] secret management and rotation
- [ ] audit logging for sensitive operations

### Product UX

- [ ] onboarding flow
- [ ] simplified command surface
- [ ] user settings UI
- [ ] dashboard/web/mobile/WhatsApp/OpenClaw surfaces
- [ ] review/planning consolidation

### Reliability

- [ ] production scheduler or job queue
- [ ] worker health monitoring
- [ ] retry/backoff policy
- [ ] idempotency tests for every proactive job
- [ ] structured observability/logging

### Agent Quality

- [ ] semantic memory/vector search
- [ ] better reflection relevance/ranking
- [~] better review-to-plan flow; `/plan_next_week` exists, but the UX can still be consolidated
- [ ] broader guardrails beyond betting/trading
- [ ] eval set for routing, action control, and LLM coach validation

### Integrations

- [ ] Gmail send/label not implemented
- [ ] private GitHub not implemented
- [ ] calendar integrations not implemented
- [ ] health integrations not implemented
- [ ] wallet integrations not implemented

## Recommended Next Build Choices

### 1. User Onboarding + Setup Simplification v1 - Recommended

Why:
- The command surface is powerful but heavy.
- A technical alpha user should not need to read the whole README.
- Better setup would reduce manual state repair and debug-command dependency.
- It can stay Telegram-first and avoid new integrations.

Suggested scope:
- A guided `/setup` flow that checks profile, goals, notifications, Gmail/GitHub status, and daily loop settings.
- A compact `/help` organized by daily use, planning, integrations, and debug commands.
- A "current state" handoff command for orchestrator/debug sessions.

Risk:
- It may drift into dashboard/UI work. Keep v1 Telegram-first.

### 2. Gmail Autonomy v1

Why:
- It makes external signals more useful.
- Gmail already has OAuth, rules, review queue, and work/action adapters.
- A good next step is proactive review notifications: "3 email items need approval."

Risk:
- More email automation increases privacy/security expectations.
- Token encryption should come first or be part of the milestone.

### 3. Planning UX Consolidation v1

Why:
- `/weekly` and `/plan_next_week` now work, but the user still has to know when to chain them.
- The planning loop can become smoother by suggesting `/plan_next_week` after a weekly review and showing existing future actions clearly.

Risk:
- Avoid auto-creating actions. Keep confirmation explicit.

## Recommendation

Build **User Onboarding + Setup Simplification v1** next.

It is the most useful next step after Plan Next Week v1: no new integrations, no OAuth, no dashboard, and it makes the current alpha easier to operate. Gmail Autonomy should wait until token encryption and review-notification UX are clearer.
