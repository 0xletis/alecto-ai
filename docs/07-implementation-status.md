# Implementation Status

Last updated: 2026-08-10

Legend:
- `[x]` implemented and currently wired into the app
- `[~]` partially implemented, local-MVP only, or intentionally narrow
- `[ ]` not implemented

This file is the current handoff map for humans and orchestrator agents. When code changes add, remove, or materially alter behavior, update this file and the relevant README/docs section before finishing the implementation.

For product-level capability grouping and command-surface consolidation, read `docs/08-product-capability-audit.md`.

## Documentation Maintenance Rule

After every implementation pass:
- update `README.md` when commands, env vars, setup, API routes, or manual testing steps change
- update the relevant `docs/*.md` file when architecture, behavior, ontology, risk policy, profile fields, or roadmap status changes
- update this status file when a feature moves between not implemented, partial, and implemented
- keep status labels honest; do not mark a feature implemented just because a placeholder or stub exists
- run the normal validation command set when code changed: `pnpm typecheck`, `pnpm build`, and `pnpm test` when relevant

## Core Platform

- [x] TypeScript pnpm monorepo with `packages/core`, `packages/db`, `packages/llm`, `apps/api`, `apps/telegram-bot`, and `apps/worker`
- [x] Fastify API over Prisma/Postgres
- [x] Telegram-first channel adapter
- [x] Channel-agnostic `NormalizedInboundMessage` abstraction
- [x] Intent routing before business logic
- [x] Conversation-first UX parity for natural help, setup, daily/weekly review, planning, hygiene, goals/actions/memory, and integration guidance requests
- [x] User onboarding/setup simplification v1: shared API onboarding state/reply composer, `/start`, `/setup`, natural quickstart, missing setup, goals setup, daily-loop setup, and integration setup guidance
- [x] First 5 Minutes Onboarding v1: guide-style `/start`, setup overview with Ready/Needs attention/Optional/Best next step, state-aware next-step suggestions, action/reminder onboarding, and explicit Gmail/GitHub setup boundaries
- [x] Inbound message segmentation for single commands, command batches, reference text, and normal text
- [x] Safe command batches for read-only commands and selected action write commands
- [x] Reference/log/code-fence safety so pasted command examples are not executed
- [x] Worker process for proactive jobs
- [x] Product capability audit and command-surface map in `docs/08-product-capability-audit.md`
- [ ] Web UI/dashboard
- [ ] WhatsApp channel adapter
- [ ] OpenClaw gateway adapter
- [ ] Mobile app
- [ ] General OAuth/auth layer beyond Gmail local MVP

## User Profile And Memory

- [x] User operating profile with directness, warmth, confrontation, style, guardrail, and vulnerability preferences
- [x] `/set_style hard_guardian` and `/set_style balanced`
- [x] Explicit memory creation from `/remember` and natural memory phrases
- [x] Memory archive via `/forget_memory`
- [x] Pending memory suggestions for inferred patterns
- [x] Duplicate pending memory suggestion prevention
- [x] Operator reflection generation/list/archive/debug commands
- [~] Operator reflections are deterministic/local-MVP; no vector DB or embeddings
- [ ] Semantic memory retrieval through embeddings/vector search

## Goals

- [x] Goal CRUD basics and archive
- [x] Goal templates for job search, health, sleep, reading, finance/risk, deep work, creative/build, and social/custom shapes
- [x] Natural-language goal creation with confirmation
- [x] Custom goal config with metrics, check-in questions, and progress logging
- [x] Duplicate active goal warnings
- [x] Goal priority fields: `priority`, `importanceScore`, `priorityReason`
- [x] Default goal priority backfill with template/title aliases
- [x] `/goal_priorities`, `/set_goal_priority`, and `/debug_backfill_goal_priorities`
- [x] Goal-linked ActionItems
- [x] Completing linked actions creates generic goal-progress evidence without inventing domain facts
- [~] Goal matching is deterministic/rules-first and intentionally conservative

## Events And Check-Ins

- [x] Core event registry in `docs/02-event-ontology.md` and `packages/core`
- [x] Event extraction from chat
- [x] Structured `/checkin`
- [x] Natural-language check-in parsing in English/Spanish
- [x] Goal-aware daily check-in prompt builder
- [x] Daily check-in reminders through the worker
- [x] Event archive/delete/undo/correction
- [x] Event correction validation by event type
- [x] Parent daily-check-in answer sync when correcting derived check-in events
- [x] `/events [limit]` and `/events_archived [limit]` with Telegram-safe truncation
- [x] Daily factual `/review`
- [x] Daily review sums progress metrics and uses latest state metrics
- [~] Custom event types can be proposed conceptually, but only approved ontology types should be logged automatically

## Risk And Guardrails

- [x] Deterministic betting/trading risk detection
- [x] Guardian RED hard-stop behavior
- [x] Direct betting/trading intent takes priority over check-ins and generic chat
- [x] Risk guardrails for natural action creation and slash action commands
- [x] Multi-intent guardrail precedence
- [x] Cooldown events for RED betting/trading states
- [x] Risk-control goals excluded from normal stalled-goal lists and summarized as guardrails
- [ ] Crisis/BLACK-state protocol beyond current betting/trading guardrails

## Action Items

- [x] `ActionItem` model with manual/email/system sources, status, due/snooze fields, priority, project, action type, and goal link
- [x] Manual commands: `/action`, `/todo`, `/add_action`
- [x] Natural action intake
- [x] Shared title normalization and dedupe for manual actions
- [x] Natural date parsing with local timezone, reminder preferences, `now`, vague future rolling, and explicit-past rejection
- [x] `/actions`, `/actions all`
- [x] `/complete_action`, `/snooze_action`, `/archive_action`
- [x] Action reminder worker with 12-hour duplicate suppression
- [x] Dev helpers for due-action reminder testing
- [x] Conversational action control for complete/reschedule/snooze/archive/priority changes
- [x] Pending decisions for ambiguous or destructive conversational actions
- [x] Multi-intent conversational orchestrator
- [x] Action hygiene analyzer, `/action_hygiene`, `/debug_action_hygiene`, and hygiene-session replies
- [x] Hygiene reply hardening: sessions stay active across completed/snoozed candidates, incomplete snooze replies ask for a time, and generic chat cannot fake cleanup success
- [~] Snooze history/count is inferred from available state where possible; no full action history model yet

## Daily And Weekly Operator Loop

- [x] `/today` daily operator brief
- [x] Natural daily operator requests such as `what should I do today` and `start my day`
- [x] Daily priority scoring with goal priority weights
- [x] `/debug_daily_priorities`
- [x] Optional LLM Daily Coach with strict validation and deterministic fallback
- [x] `/debug_daily_coach`
- [x] `/start_day`, `/end_day`, `/tomorrow`
- [x] Daily loop settings and scheduled morning/evening worker delivery
- [x] Debug start/end-day send commands with idempotency and force mode
- [x] Local timezone day/week handling, defaulting to `Europe/Madrid`
- [x] Weekly operator review: `/weekly`, `/weekly force`, `/weekly_last`, `/debug_weekly_context`
- [x] Week-to-date weekly review display for current week
- [x] Weekly review stored as `MemoryEntry` with `data.kind="weekly_review"`
- [x] `/plan_next_week` proposes 3-7 next-week ActionItems and creates only explicitly selected items
- [x] Plan-next-week output distinguishes ActionItem priority from linked goal priority
- [x] Plan-next-week cleanup suggestions are non-creatable and point back to `/action_hygiene` or natural action control instead of creating meta cleanup tasks
- [x] Planning UX Consolidation v1: `/weekly` points to `plan next week`, natural `plan this week`/`plan my week` plan the remaining current local week, natural `plan next week` uses the next local week, ambiguous `make a plan` asks for this-vs-next-week unless there is active plan context, `create all new` creates only creatable suggestions, reply examples only reference creatable indexes, and recurring system suggestions use semantic duplicate keys such as guardrail-review aliases
- [x] `/debug_next_week_plan_context` shows next-week planning context without side effects

## Insights

- [x] Daily interpretive `/insight` and `/daily_insight`
- [x] Weekly interpretive `/weekly_insight`
- [x] Insight reports use active events/goals/memories/profile and risk signals
- [x] Custom goal progress counts as real activity
- [x] GitHub repo activity does not count as personal progress
- [~] Optional OpenAI polish is additive only and falls back deterministically

## Notifications And Worker

- [x] `NotificationSettings`
- [x] `NotificationLog` duplicate prevention for daily check-ins, daily insights, and weekly insights
- [x] Scheduled daily check-ins
- [x] Scheduled daily insight delivery
- [x] Scheduled weekly insight delivery
- [x] Scheduled daily loop morning/evening briefs
- [x] Action reminder logs and due/snoozed reminders
- [x] Scheduled integration sync, disabled by default with `INTEGRATION_SYNC_ENABLED=false`
- [~] Telegram delivery requires `telegramUserId`; no multi-channel notification routing yet

## Integrations

- [x] Integration registry
- [x] Integration lifecycle: pause/resume/archive
- [x] Duplicate GitHub connection prevention
- [x] Public GitHub repo integration
- [x] GitHub `author=LOGIN` personal commit semantics
- [x] GitHub repo activity semantics when no author is configured
- [x] GitHub safe 404/private/rate-limit errors
- [x] Scheduled and manual integration sync
- [~] GitHub supports public repos only; no OAuth/private repo support
- [ ] Wallet public-address fetcher
- [ ] Health integrations
- [ ] Calendar integrations

## Gmail And Email

- [x] Gmail listed as generic readonly email source
- [x] Minimal Gmail OAuth callback for local MVP
- [x] Tokens stored in local DB config and sanitized from all user/API-visible output
- [x] Email signal rules with query, fetch strategy, classifier mode, caps, thresholds, and review-before-logging
- [x] Email adapter registry
- [x] `job_search_email` adapter
- [x] `work_action_email` adapter
- [x] Conservative Gmail hard filters for security, marketing, account/admin, and non-work noise
- [x] Gmail sync summaries and debug counters
- [x] Email review queue
- [x] Review semantic dedupe
- [x] Review approval/rejection
- [x] Work-action review approval creates ActionItems instead of Events
- [~] Gmail token storage is local-MVP only; encrypt before production
- [~] LLM email classifier is optional and post-processed by strict allowlists
- [ ] Gmail send/label modification
- [ ] Additional planned adapters: finance receipts, learning deadlines, custom goal email signals

## Known Stubs Or Deferred Work

- [~] LLM weekly review support exists as guarded/fallback behavior; deterministic weekly review is the reliable path
- [ ] WhatsApp, OpenClaw, web UI, dashboard, mobile app
- [ ] Private GitHub support
- [ ] Full production token encryption/secret management
- [ ] Vector DB/embeddings
- [ ] Billing, enterprise, multi-user product hardening beyond Telegram user mapping
