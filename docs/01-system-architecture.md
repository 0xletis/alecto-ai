# System Architecture

Status: current as of 2026-08-13. See `docs/07-implementation-status.md` for the detailed implementation ledger.

## Architecture Rule

Keep the core agent channel-agnostic.

Channel adapters convert external payloads into `NormalizedInboundMessage`. Core routing and business logic must not depend on Telegram `ctx`, Telegram chat IDs, inline buttons, or Telegram command menus.

Current channel status:
- [x] Telegram adapter
- [ ] WhatsApp adapter
- [ ] Web/API chat adapter
- [ ] OpenClaw gateway adapter

## Current Flow

```
Telegram update
  -> Telegram adapter
  -> NormalizedInboundMessage
  -> inbound message segmentation
  -> IntentRouter / command router
  -> optional Conversation Orchestrator v2 operation planner for migrated scopes
  -> API service layer
  -> core domain services
  -> Prisma/Postgres
  -> channel-neutral response
  -> Telegram formatting/send
```

The same core route should be usable later by WhatsApp, web, or API clients after they produce a `NormalizedInboundMessage`.

## Main Apps And Packages

- [x] `packages/core`: domain schemas and deterministic logic, including event ontology, risk states, check-ins, reminders, ingestion adapters, goal templates, intent routing, semantic-router schemas, daily priority scoring, LLM daily coach validation, and conversation-control helpers
- [x] `packages/db`: Prisma schema, generated client, and repository functions
- [x] `packages/llm`: optional OpenAI structured analysis helpers, including semantic message routing
- [x] `apps/api`: Fastify API; owns business mutations, operator attention composition, and orchestration
- [x] `apps/telegram-bot`: thin Telegram adapter over API routes
- [x] `apps/worker`: simple interval worker for proactive jobs

## Core Data

- [x] `User`
- [x] `Goal`
- [x] `Event`
- [x] `MemoryEntry`
- [x] `UserOperatingProfile`
- [x] `PendingAction` for confirmations/clarifications/pending decisions, including confirmed next-week planning suggestions
- [x] `NotificationSettings`
- [x] `NotificationLog`
- [x] `DailyLoopState`
- [x] `IntegrationConnection`
- [x] `IntegrationSyncLog`
- [x] `EmailSignalRule`
- [x] `EmailReviewItem`
- [x] `ActionItem`
- [x] `ActionItemReminderLog`

## Routing Priorities

Normal inbound text is segmented before intent routing.

1. Reference/log/example text is rejected as non-executable.
2. Slash commands and command batches are handled explicitly.
3. Pending decision replies are resolved before normal routing, but only when the reply fits the pending scope.
4. Guardrail/risk intent wins over action creation, check-ins, ingestion, planning, attention summaries, and generic chat.
5. Recent visible-list context is checked for action hygiene/action-control replies such as `archive 1`, `the dev jobs one`, or `archive all except the read one`.
6. Explicit memory requests route to memory/message processing.
7. Natural daily check-ins route to check-in parsing when signal strength is sufficient.
8. Pasted job-search emails/text route through generic ingestion.
9. Conversational action control handles complete/reschedule/snooze/archive/priority updates.
10. Multi-intent orchestration can combine safe event logging, control actions, and read-only summaries.
11. Natural operator-attention and email-attention questions route to shared attention/readout services, for example `anything important?`, `what needs my attention?`, `what should I handle first?`, `what emails need action?`, and Spanish/Catalan Gmail-attention variants.
12. Optional LLM semantic router can classify normal free text that missed deterministic phrase rules across operator surfaces and Gmail rule conversations. It targets English, Spanish, and Catalan phrasing and returns structured intent only: intent, operation, confidence, language, side-effect risk, confirmation requirement, target, extracted filters, goal hint, and safe issue text. API executors still validate and apply or reject any mutation.
13. Gmail rule conversations may store short-lived focused-rule context in the pending-action layer so follow-up references such as `that rule`, `it`, or `pause it` can resolve channel-neutrally. This context is not authorization to scan Gmail or mutate anything; it only helps deterministic executors resolve the target.
14. Conversation Orchestrator v2 Phase 1 can handle migrated context-bound operation planning through `ConversationContext`, `AvailableOperations`, deterministic validation, deterministic executors, and a response composer. It is available at `/messages/process_v2` and can be opt-in for `/messages/process` with `CONVERSATION_ORCHESTRATOR_V2_ENABLED=true`. Its runtime planner is deterministic today; the LLM operation planner module is not active on these paths yet.
15. Remaining messages route to message processing / response composition.

`/messages/process` may include a non-user-facing `routeDebug` object for API smoke tests and local diagnostics. Telegram ignores it and sends only the reply text. The debug payload now includes semantic language/confidence/side-effect-risk fields when available so route quality can be tested without Telegram copy/paste loops.

Implementation note:
- [~] `apps/api/src/server.ts` still contains too much orchestration logic and should be split further. Extracted conversation modules now live in `apps/api/src/conversation/`, including Gmail rule selection helpers plus Conversation Orchestrator v2 Phase 1 context, operation catalog, planner, validator, executor, and response composer modules.
- [x] `GET /users/:userId/operator-attention?now=...` builds a channel-neutral operator attention state from actions, goals, events, risk signals, action hygiene, Gmail email reviews, and latest weekly-review status. `/today`, `/start_day`, `/end_day`, `/weekly`, planning, and natural attention/email-attention replies reuse this data instead of duplicating ad hoc logic.
- [~] Conversation Orchestrator v2 Phase 1 uses the existing `PendingAction` layer as the short-lived backing store for `ConversationContext`, so no DB schema migration was required. It currently migrates action hygiene list creation and visible-list replies, all-except cleanup batches, recent mutation questions, natural confirmation variants, cross-domain visible-context safety, reference-text safety, and betting/trading risk precedence. A fuller migration of action control, Gmail rules, email reviews, planning, and generic chat is still deferred.

## Integrations

Current:
- [x] GitHub public repo sync
- [x] Gmail readonly OAuth source
- [x] Email rules/subscriptions
- [x] `job_search_email`
- [x] `work_action_email`

Partial/local MVP:
- [~] Gmail OAuth tokens are encrypted at rest in DB JSON config when `ALECTO_SECRET_ENCRYPTION_KEY` is set, sanitized from output, and legacy plaintext local tokens migrate on read/sync; production OAuth/account management and key rotation are still not implemented
- [~] Scheduled integration sync is available but disabled by default through `INTEGRATION_SYNC_ENABLED=false`; Gmail additionally requires an explicit per-user scheduled preference and at least one active email rule

Not implemented:
- [ ] Gmail send/label mutations
- [ ] Private GitHub/OAuth GitHub
- [ ] Wallet integrations
- [ ] Calendar/health integrations

## Worker Responsibilities

The worker runs simple interval jobs. It does not use queues or a background job platform.

- [x] daily check-in reminders
- [x] daily insight delivery
- [x] weekly insight delivery
- [x] daily loop morning and evening delivery
- [x] due/snoozed ActionItem reminders
- [x] scheduled integration sync when enabled, including Gmail per-user manual-only/scheduled preference checks

Duplicate proactive sends are controlled by `NotificationLog`, `ActionItemReminderLog`, integration dedupe keys, and per-job idempotency checks.

## Documentation Maintenance

Every implementation pass should finish by checking:
- `README.md` for user-visible commands, setup, env vars, API routes, and manual tests
- this architecture doc when data flow or ownership changes
- `docs/07-implementation-status.md` for implemented/partial/not-implemented status
- `docs/08-product-capability-audit.md` for capability grouping and command-surface changes
- `docs/06-mvp-roadmap.md` when roadmap state changes
