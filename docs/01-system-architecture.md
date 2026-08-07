# System Architecture

Status: current as of 2026-08-06. See `docs/07-implementation-status.md` for the detailed implementation ledger.

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
  -> API service layer
  -> core domain services
  -> Prisma/Postgres
  -> channel-neutral response
  -> Telegram formatting/send
```

The same core route should be usable later by WhatsApp, web, or API clients after they produce a `NormalizedInboundMessage`.

## Main Apps And Packages

- [x] `packages/core`: domain schemas and deterministic logic, including event ontology, risk states, check-ins, reminders, ingestion adapters, goal templates, intent routing, daily priority scoring, LLM daily coach validation, and conversation-control helpers
- [x] `packages/db`: Prisma schema, generated client, and repository functions
- [x] `packages/llm`: optional OpenAI structured analysis helpers
- [x] `apps/api`: Fastify API; owns business mutations and orchestration
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
3. Pending decision replies are resolved before normal routing.
4. Guardrail/risk intent wins over action creation, check-ins, ingestion, and generic chat.
5. Explicit memory requests route to memory/message processing.
6. Natural daily check-ins route to check-in parsing when signal strength is sufficient.
7. Pasted job-search emails/text route through generic ingestion.
8. Conversational action control handles complete/reschedule/snooze/archive/priority updates.
9. Multi-intent orchestration can combine safe event logging, control actions, and read-only summaries.
10. Remaining messages route to message processing / response composition.

## Integrations

Current:
- [x] GitHub public repo sync
- [x] Gmail readonly OAuth source
- [x] Email rules/subscriptions
- [x] `job_search_email`
- [x] `work_action_email`

Partial/local MVP:
- [~] Gmail OAuth tokens are stored in DB JSON config and sanitized from output; encrypt before production
- [~] Scheduled integration sync is available but disabled by default through `INTEGRATION_SYNC_ENABLED=false`

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
- [x] scheduled integration sync when enabled

Duplicate proactive sends are controlled by `NotificationLog`, `ActionItemReminderLog`, integration dedupe keys, and per-job idempotency checks.

## Documentation Maintenance

Every implementation pass should finish by checking:
- `README.md` for user-visible commands, setup, env vars, API routes, and manual tests
- this architecture doc when data flow or ownership changes
- `docs/07-implementation-status.md` for implemented/partial/not-implemented status
- `docs/08-product-capability-audit.md` for capability grouping and command-surface changes
- `docs/06-mvp-roadmap.md` when roadmap state changes
