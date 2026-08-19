# Implementation Status

Last updated: 2026-08-18

Legend:
- `[x]` implemented and currently wired into the app
- `[~]` partially implemented, local-MVP only, or intentionally narrow
- `[ ]` not implemented

This file is the current handoff map for humans and orchestrator agents. When code changes add, remove, or materially alter behavior, update this file and the relevant README/docs section before finishing the implementation.

For product-level capability grouping and command-surface consolidation, read `docs/08-product-capability-audit.md`.
For route ownership, split-brain risks, and the server extraction plan, read `docs/09-architecture-inventory.md`.

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
- [x] Conversation-first UX parity for natural help, setup, daily/weekly review, planning, hygiene, goals/actions/memory, integration guidance, explicit email-rule enable requests, and explicit integration sync requests
- [x] Channel-neutral operator attention state/API: `GET /users/:userId/operator-attention` composes actions, goals, events, risks, hygiene, Gmail reviews, and latest weekly-review status for natural attention/email-attention questions and operator-loop surfaces
- [x] Optional LLM Semantic Router v4 for normal free-text understanding after deterministic safety/command/pending handling and before generic chat fallback; targets English/Spanish/Catalan phrasing, returns structured intent only, keeps short-lived Gmail-rule conversation context, and leaves all mutations to deterministic API executors
- [x] **Conversation Orchestrator v2 — retired.** Phase 1 shipped an operation-planning architecture (`ConversationContext`, `AvailableOperations`, an OperationPlanner contract, deterministic validation/execution, execution-result response composition) behind the `CONVERSATION_ORCHESTRATOR_V2_ENABLED` flag on `/messages/process`, plus a debug-only `/messages/process_v2` endpoint that exposed it unconditionally (retired earlier — zero production callers). A later audit could not prove from repository inspection alone that the flag was safe to delete (it could only confirm no *tracked* repo config set it, not that no live deployment did); product then confirmed no live deployment relied on it, and the whole branch plus its `apps/api/src/conversation/{orchestrator-v2,context,operation-catalog,operation-planner,operation-validator,operation-executor,response-composer}.ts` modules and its 32-test file were deleted. `/messages/process` now runs only the legacy deterministic/semantic pipeline that was already its fallback — no behavior change for any in-use scope. Agent Runtime v3 (`POST /agent/message`) remains the default normal-chat runtime and is unaffected. See `docs/09-architecture-inventory.md`'s "Conversation Orchestrator v2 — Full Retirement" for the deletion record.
- [~] Agent Runtime v3 (`apps/api/src/agent-runtime/`, `POST /agent/message`): isolated LLM-plan/deterministic-validate/deterministic-execute runtime, now the **default** runtime for normal (non-command) Telegram chat — `TELEGRAM_AGENT_RUNTIME_V3_ENABLED=false` is the explicit opt-out back to the legacy `/messages/process` pipeline; slash commands and Gmail OAuth/setup/sync are unaffected either way. Session state (topic, pending confirmation, visible entities, recent mutations, bounded history) is persisted per `userId`+`channel` in `AgentConversationSession` with a sliding 24h TTL, so it survives an API restart. A per-user in-memory lock serializes same-user turns. Tool catalog covers memory, progress-event logging, action list/create/snooze/complete/archive, and Gmail status/rule-create/rule-list/rule-explain/review — it does not yet cover full Gmail rule editing/removal, planning sessions, daily loop settings, or bulk/multi-item action hygiene batches, all of which remain legacy-only (see `docs/09-architecture-inventory.md`'s "Legacy conversation stack to remove or isolate" for the full breakdown). New conversation/product work should go into v3, not the legacy pipeline.
- [x] Architecture inventory v1 in `docs/09-architecture-inventory.md`: entry points, routing order, route ownership map, `server.ts` map, split-brain risks, ConversationContext audit, LLM OperationPlanner audit, and risk/guardrail generalization plan
- [~] API route modularization started beyond conversation helpers: `/messages/process` Fastify registration now lives in `apps/api/src/routes/messages.ts`; the actual process handler still depends on `apps/api/src/server.ts` helper glue until more surfaces are extracted. Server cleanup phase 1 additionally extracted `apps/api/src/server-types.ts` (39 pure types) and two genuinely zero-dependency route groups, `apps/api/src/routes/memory.ts` and `apps/api/src/routes/notification-settings.ts` — all behavior-preserving pure moves, `server.ts` down to 17,380 lines from 17,903. Server cleanup phase 2 extracted the check-in prompt and free-text ingestion routes into `apps/api/src/routes/checkins-ingest.ts` (`GET /users/:userId/checkins/daily/prompt`, `POST /users/:userId/ingest/text`, `POST /users/:userId/ingest/job-search-text`, plus their two exclusively-used private helpers `ingestText`/`composeIngestionReply`) and de-duplicated the `isRecord` type guard — previously defined privately in `server.ts` and called 53 times there — into `apps/api/src/utils/records.ts` so the new route module doesn't need a circular import back into `server.ts`; `server.ts` down to 17,293 lines. Server cleanup phase 3 extracted the daily/weekly insight routes into `apps/api/src/routes/insights.ts` (`GET /users/:userId/insights/daily`, `GET /users/:userId/insights/weekly`, plus their exclusively-used private helpers `maybePolishInsight`/`isDirectInsightProfile`/`startOfToday`/`startOfLastSevenDays`/`parseDateStart`/`addDays`) and de-duplicated `shouldUseOpenAIAnalysis` into `apps/api/src/utils/env.ts` for the same reason `isRecord` moved in phase 2; `server.ts` down to 17,172 lines. The `pending-actions` route group was inspected and skipped this pass because its confirm route's only risky dependency, `applyPendingAction`, is a ~345-line function entangled with Gmail rule management and action-hygiene batch operations (both already-flagged high-risk zones) and is also called from the legacy `/messages/process` chat-confirmation flow, not just this route — extracting it now would either drag those tangles along or force a circular import. Server cleanup phase 4 retired `/messages/process_v2` entirely (debug-only, zero production callers) — its route/handler were deleted, `runConversationOrchestratorV2ForMessage`'s now-dead `returnUnhandled` option was removed with it, and `tests/conversation-orchestrator-v2.test.ts` (34 tests) was rewritten to exercise the same Conversation Orchestrator v2 logic through `/messages/process` (with the flag forced on) instead — 32 tests remain, 2 were removed as testing debug-route-only behavior with no production equivalent; `server.ts` down to 17,122 lines. Server cleanup phase 5 retired Conversation Orchestrator v2 itself — the `CONVERSATION_ORCHESTRATOR_V2_ENABLED` branch and its 7 `apps/api/src/conversation/` modules were deleted (product confirmed no live deployment used the flag), along with the 32-test file and several now-orphaned `server.ts` helper functions that existed only to wire into v2's callback interface; a new 3-test regression file (`tests/messages-process-legacy.test.ts`) confirms `/messages/process` still works through the remaining legacy path and that Agent Runtime v3 is unaffected; `server.ts` down to 16,938 lines. Phase 6 deleted the now-unreachable `packages/llm/src/operation-planner.ts` (the LLM-calling half of v2's operation planner, flagged but left out-of-scope by phase 5) and its export from `packages/llm/src/index.ts`; no `server.ts` changes. While tracing that deletion, `packages/core/src/conversation-orchestrator.ts` was found to be fully unreachable too, but was left alone that pass — a different, more widely-depended-on package than that pass's scope covered. Phase 7 re-verified and deleted it: all 19 exported symbols (schemas, types, interfaces, `normalizeConversationOperationPlan`) confirmed zero consumers anywhere via word-boundary-anchored search, its export removed from `packages/core/src/index.ts`, and `pnpm typecheck` run across all 6 workspace packages to confirm nothing downstream broke — this closes out the v2-deletion chain that started in phase 5. Agent Runtime v3's own types (`apps/api/src/agent-runtime/types.ts`) and planner (`apps/api/src/agent-runtime/planner.ts`) are unrelated, independent implementations and were never affected by any of phases 5–7. Phase 8 began the Gmail-rules extraction queued after phase 3: mapped ~90 Gmail-related functions in `server.ts` into OAuth/token/provider-API, sync-worker, legacy conversation/semantic-router NL handling, and pure rule-management, then extracted only the last group into `apps/api/src/gmail/gmail-rule-service.ts` (`isBuiltInEmailAdapter`, `EmailRuleHumanDisplayGroup`, `groupEmailRulesForHumanDisplay`, `formatGmailEmailRuleSelectionLines`, `getVisibleGmailEmailRules`) — this closes the Gmail-side half of what was blocking `applyPendingAction`'s `custom_email_rule` branch, which turned out to depend on exactly one server.ts-local helper once traced (everything else it called was already a clean `@operator-agent/db` or `conversation/gmail-autonomy.ts` import). `normalizeForComparison` (58 unrelated call sites) was also de-duplicated into `apps/api/src/utils/text.ts`, following the same pattern as `isRecord`/`shouldUseOpenAIAnalysis` in earlier phases. The legacy conversation/semantic-router Gmail cluster (rule editing, pronoun/target resolution) was inspected and deliberately left in place — tangled with free-text NL parsing, not pure rule management. `server.ts` down to 16,875 lines; 6 new tests in `tests/gmail-rule-service.test.ts`. Action-hygiene (`applyActionHygieneBatchOperations`) is now the sole remaining tangle blocking `pending-actions`. See `docs/09-architecture-inventory.md`'s "Server.ts Map", "Conversation Orchestrator v2 — Full Retirement", "LLM Operation-Planner Package Cleanup", "Core Conversation-Orchestrator Types Cleanup", and "Gmail Rule Service Extraction" for the full reasoning and the remaining targets (action hygiene, then `pending-actions`) and why `/messages/process`'s own handler body remains the least safe to extract.
- [x] Short-lived interaction context for visible action/hygiene lists, recent action mutation status, focused Gmail rules, pending Gmail proposals, email review lists, and plan sessions through the existing pending-action layer
- [x] `/messages/process` routeDebug metadata for API smoke tests: router source, intent, handler, semantic-router usage, mutation flag, confidence, language, side-effect risk, confirmation requirement, and compact reason
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
- [x] Conversational Action/Hygiene Control v2: visible-number and natural-label resolution for hygiene/action lists, batch archive/complete/snooze/keep plans, all-except cleanup replies, confirmation before destructive batches, and short-lived recent mutation answers
- [x] ~~Conversation Orchestrator v2 golden transcript coverage~~ — retired along with v2 itself; see the Conversation Orchestrator v2 retirement entry above. This test coverage (action hygiene list creation/replies, batches, all-except cleanup, single-item pronoun replies, recent mutation status, explicit memory creation, multilingual references/progress aliases, natural confirmation variants, cross-domain safety, risk precedence, LLM planner success/fallback/timeout/debug fields) has no legacy equivalent and was not preserved, since it tested v2-specific mechanics that no longer exist.
- [~] Snooze history/count is inferred from available state where possible; no full action history model yet

## Daily And Weekly Operator Loop

- [x] `/today` daily operator brief
- [x] Natural daily operator requests such as `what should I do today` and `start my day`
- [x] Natural attention requests such as `anything important?`, `what needs my attention?`, `what should I handle first?`, `what emails need action?`, and Spanish/Catalan Gmail-attention variants route to operator/email attention summaries instead of generic coaching
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
- [x] Natural `/review` and `/today` use consistent user-local day ranges; natural weekly review refreshes stale current-week memories through the reviewed local date
- [x] Weekly review stored as `MemoryEntry` with `data.kind="weekly_review"`
- [x] Pending Gmail reviews are included in `/today`, `/start_day`, `/end_day`, `/weekly`, `/debug_weekly_context`, and next-week planning context as review inbox work, not as fake ActionItems
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
- [x] Scheduled integration sync, disabled by default with `INTEGRATION_SYNC_ENABLED=false`; Gmail background sync additionally requires explicit per-user scheduled mode and active Gmail rules
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
- [x] Gmail background sync eligibility/debug route for safe operator inspection: global worker availability, connection status, mode, interval, active rule count, last background attempt, next due time, and reason
- [x] Natural `sync Gmail`, `sync email`, and `sync integrations` requests route through safe API sync behavior instead of generic chat
- [x] Natural explicit email-rule requests such as `enable job search rule for Gmail` and `enable work action rule for Gmail` create/reuse active Gmail email rules through the same safe API path as `/enable_email_rule`
- [x] Gmail setup/rule replies use human tracking labels and explain what the rule watches for instead of exposing adapter IDs in normal user output
- [x] Natural Gmail setup/status/list wizard shows connection state, active tracking rules, manual vs scheduled sync, email-rule timing behavior, and goal-based rule recommendations
- [~] GitHub supports public repos only; no OAuth/private repo support
- [ ] Wallet public-address fetcher
- [ ] Health integrations
- [ ] Calendar integrations

## Gmail And Email

- [x] Gmail listed as generic readonly email source
- [x] Minimal Gmail OAuth callback for local MVP
- [x] Gmail OAuth tokens encrypted at rest in local DB config when `ALECTO_SECRET_ENCRYPTION_KEY` is configured
- [x] Existing legacy plaintext Gmail token config can be read and migrated to encrypted config on successful token read/sync when the key is available
- [x] Tokens and encrypted token envelopes are sanitized from all user/API-visible output
- [x] Email signal rules with query, fetch strategy, classifier mode, caps, thresholds, and review-before-logging
- [x] Email adapter registry
- [x] `job_search_email` adapter
- [x] `work_action_email` adapter
- [x] Conservative Gmail hard filters for security, marketing, account/admin, and non-work noise
- [x] Gmail security/auth/account noise is filtered before job-search classification and before custom review creation. Security-code, verification-code, OTP, login, password-reset, 2FA/authentication, suspicious-login, device-login, and account-recovery emails do not create EmailReviewItems in v1.
- [x] Gmail sync summaries and debug counters
- [x] Natural Gmail/email sync requests use the same readonly sync path and preserve token/ciphertext redaction
- [x] Natural Gmail email-rule enable requests require an active Gmail connection, preserve explicit rule approval, and do not auto-scan by themselves
- [x] Natural Gmail guidance explains implemented tracking choices, including confirmation-first custom sender/keyword tracking
- [x] Gmail setup/status replies recommend job-search tracking for active career/job-search goals and work-action tracking for work/project-like goals
- [x] Shared Gmail setup/autonomy state service for conversation surfaces. It reports connection status, account email when available, active/paused rule summaries, pending review count, last sync, manual/scheduled mode, worker availability, review-notification preference, delivery availability, Gmail-relevant active goals, recommendations, unsupported preferences, and next best step without exposing secrets or raw provider data.
- [x] Gmail autonomy preferences on Gmail connection config: `manual_only` vs `scheduled`, interval minutes, and review-waiting notification on/off. Natural changes such as `check Gmail every hour`, `make Gmail manual only`, and `notify me when Gmail reviews are waiting` ask for confirmation before DB mutation.
- [x] Gmail autonomy confirmation focus is hardened: negative notification phrases disable notifications, unrelated Gmail questions cancel stale preference confirmations, and missing/paused custom-rule questions explain review-first/no-auto-log behavior instead of returning a generic "could not identify" message.
- [x] Worker scheduled Gmail sync respects Gmail autonomy preferences: Gmail stays manual-only unless the user explicitly chose scheduled checks, manual-only Gmail connections are skipped, per-connection scheduled intervals use `lastBackgroundSyncAttemptedAt` instead of manual `lastSyncedAt`, no-active-rule connections are skipped, failed background attempts store safe status/error without tight retry loops, and proactive Gmail review notifications are suppressed when the connection preference disables them.
- [x] Natural Gmail digest and work-hours preference requests are recognized and answered honestly as not implemented; Alecto does not create fake settings.
- [x] Natural email-rule list requests such as `what email rules are on now` show active rules first and hide paused/error noise from the normal conversation view
- [x] Custom Gmail sender/keyword rule builder v1 through natural chat, e.g. `track Endesa bills from Gmail` or `track emails from client@example.com for dashboard project`
- [x] Custom Gmail rules are review-only: matches create EmailReviewItems and never auto-create Events or ActionItems
- [x] Custom Gmail rule management through natural chat for clear pause/resume/remove requests, with confirmation before removal
- [x] Pending custom Gmail rule conversation state: natural English/Spanish/Catalan edits to `looks for` keywords, replacement wording such as `Aigues de Barcelona instead of Endesa`, `solo Aigues de Barcelona, no Endesa`, and `en lloc de`, questions about where matches go, timing/sync questions, goal-link correction/removal, cancel, and confirmation before scanning
- [x] Active custom Gmail rule editing through natural chat: after rule list/status/edit replies, Alecto keeps short-lived rule context so follow-ups such as `make that rule look for only Aigues de Barcelona instead of Endesa`, `when will you tell me about it?`, `pause it`, and Spanish/Catalan equivalents resolve to the focused rule
- [x] Natural Gmail timing/status questions such as `when do u check my gmail?`, `when do u check my mail`, `do you check Gmail automatically?`, and `will you notify me about emails?` route to sync timing guidance before broad custom-rule creation or LLM semantic routing
- [x] Ambiguous custom Gmail rule management stores pending clarification before routing falls back. Example: `elimina Endesa` can be resolved by replying `1` or `Endesa emails`, then destructive removal asks for yes/no confirmation.
- [x] Multi-rule Gmail removal asks a bulk confirmation and archives matched Gmail email rules only after confirmation. Example: `elimina Aigues de Barcelona y Endesa`.
- [x] Gmail rule list/reset phrases avoid action-control and multi-intent fallback. Examples: `what email rules do we have`, `delete all email rules`, `turn all off and delete them`, and contextual `can u delete all of em?` after listing rules route to Gmail status/cleanup and never produce "I could not confidently match that to an open action."
- [x] Built-in Gmail rule duplicate cleanup is implemented. Natural lists and destructive confirmations group equivalent duplicate job-search/work-action rules, Gmail sync ignores exact duplicate built-in rules, and enabling a built-in rule reuses/reactivates one existing rule while archiving duplicate built-in copies.
- [x] Natural reset can archive all visible Gmail email rules, including job-search, work-action, custom, and paused rules, after confirmation. It does not delete the Gmail connection or historical email reviews/events.
- [x] Exact custom Gmail rule names ending in `emails` are preserved during selection, so `Endesa emails` can resolve that rule instead of collapsing to the broader `Endesa` target.
- [x] Utility/bill custom Gmail tracking avoids false health-goal links; Endesa/Aigues bill rules do not attach to `Improve strength and energy` unless an actual utility/expense goal exists.
- [x] Gmail-rule cross-context safety for targeted follow-ups. A target-specific request such as `ignore the Endesa ones` does not fall back to unrelated visible rule context such as work-action emails; it asks the user to show email reviews or Gmail rules when no matching Endesa context is visible.
- [x] LLM semantic-router API smoke coverage for multilingual Gmail rule list, custom-rule creation, pending-rule edits, timing questions, pause/resume management, and guardrail precedence when an LLM mock misroutes risky text
- [x] Expired pending confirmations no longer block fresh full-message requests such as `create a rule for Endesa bills`
- [x] Conversation repair for bad routing around pending Gmail rules; Alecto acknowledges the specific pending-rule problem instead of falling into generic support/coaching
- [x] Email review queue
- [x] Email Review Inbox v1: `/email_reviews`, `email reviews`, `show Gmail reviews`, `what emails need review`, `correos pendientes`, and Catalan variants show grouped pending reviews with human labels and short-lived visible numbers instead of adapter IDs or permanent IDs
- [x] Operator-loop Gmail review visibility: pending/handled Gmail reviews and Gmail-derived action/event counts can appear in attention summaries, daily/start/end-day replies, weekly review/debug context, and planning as non-creatable cleanup guidance
- [x] Email review context actions: after showing the inbox, `show 1`, `approve 1`, `reject 2`, `approve all job-search reviews`, `reject all Endesa reviews`, `reject all the rest reviews from Endesa`, and `turn 3 into an action tomorrow` resolve only against the visible pending review context and expire safely
- [x] Email Review Inbox visible numbers now follow display order across groups; `show 1` and `reject 5` resolve to the number the user saw
- [x] Bulk email review operations re-check current DB status and only mutate still-pending visible reviews. Already approved, rejected, action-converted, or missing reviews are reported separately as already handled.
- [x] Gmail sync replies include pending email review counts and user-friendly new-review/new-event summaries without raw bodies, provider payloads, tokens, ciphertext, IVs, or tags
- [x] Scheduled integration sync can send one bundled Telegram notification when new Gmail review items are created, e.g. grouped job-search/work-action/custom counts; unchanged pending reviews do not produce a new notification
- [x] Scheduled Gmail review notifications respect the Gmail connection review-notification preference. Manual sync still replies in-band.
- [x] Custom Gmail review approval remains review-only by default; explicit `turn N into an action` can create an ActionItem from a visible custom review
- [x] Review semantic dedupe
- [x] Review approval/rejection
- [x] Work-action review approval creates ActionItems instead of Events
- [~] Gmail OAuth/account management remains local-MVP; production auth, key management, and secret rotation are not implemented
- [~] LLM email classifier and semantic router are optional and post-processed by strict allowlists/executors; broader natural-language coverage has targeted API smoke tests but still needs a larger eval suite before production
- [x] ~~Conversation Orchestrator v2 modularization~~ — the `context`, `operation-catalog`, `operation-planner`, `operation-validator`, `operation-executor`, and `response-composer` modules under `apps/api/src/conversation/` have been deleted along with the rest of v2 (see the retirement entry above). `apps/api/src/conversation/gmail-autonomy.ts` and `email-rule-selection.ts` remain — they were never v2-specific. Message route registration stays at `apps/api/src/routes/messages.ts`. `apps/api/src/server.ts` remains oversized and still needs capability executors/services extracted (now targeting Agent Runtime v3's tool catalog, not v2's operation catalog).
- [x] Editing filters on an existing custom Gmail rule through API conversation routing; destructive removal still requires confirmation
- [ ] Gmail send/label modification
- [ ] Gmail webhooks, full-inbox/all-mail LLM monitoring, per-rule sync schedules, business-hours Gmail checks, and daily Gmail digest
- [ ] Additional planned adapters: finance receipts, learning deadlines, custom goal email signals

## Known Stubs Or Deferred Work

- [~] LLM weekly review support exists as guarded/fallback behavior; deterministic weekly review is the reliable path
- [ ] WhatsApp, OpenClaw, web UI, dashboard, mobile app
- [ ] Private GitHub support
- [ ] Full production OAuth/account management, key management, and secret rotation
- [ ] Vector DB/embeddings
- [ ] Billing, enterprise, multi-user product hardening beyond Telegram user mapping
