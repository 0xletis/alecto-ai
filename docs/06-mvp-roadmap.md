# MVP Roadmap

Status labels:
- `[x]` implemented
- `[~]` partial/local-MVP
- `[ ]` not implemented

For a full current inventory, read `docs/07-implementation-status.md`.
For the product capability audit and command-surface map, read `docs/08-product-capability-audit.md`.

## MVP 0 - Personal Prototype

Goal:
Build a working personal agent over Telegram with structured goals/events and basic guardian mode.

Status:
- [x] Telegram bot
- [x] Fastify API
- [x] Postgres DB
- [x] Prisma schema
- [x] user operating profile
- [x] goal CRUD and archive
- [x] goal templates
- [x] event registry
- [x] event extraction from chat
- [x] structured and natural manual check-ins
- [x] basic risk engine
- [x] factual daily review
- [x] daily insight
- [x] weekly insight
- [x] weekly operator review
- [x] action items and reminders
- [x] daily operator brief and daily operating loop
- [x] inbound routing hardening and command batching
- [x] conversation-first UX parity for core operator surfaces
- [x] conversation-first onboarding/setup v1 for `/start`, `/setup`, natural quickstart, goals, daily loop, and integration guidance
- [x] First 5 Minutes Onboarding v1 with guide-style `/start`, setup overview, goals/actions/reminders/daily-loop guidance, and explicit Gmail/GitHub setup boundaries
- [x] Planning UX Consolidation v1 with `/weekly` -> `plan next week` bridge, natural current-week/next-week planning, grouped plan output, and confirmation-only action creation

Explicitly out of MVP 0:
- [ ] WhatsApp
- [ ] OpenClaw integration
- [ ] mobile app
- [ ] full dashboard
- [ ] private keys
- [ ] withdrawals
- [ ] trading execution

## MVP 1 - Technical Alpha

Goal:
Add practical external signals and make the operator loop usable day to day.

Status:
- [x] integration registry
- [x] public GitHub fetcher
- [x] GitHub lifecycle controls
- [x] scheduled integration sync
- [x] Gmail readonly fetcher
- [x] Gmail OAuth local MVP
- [x] email signal rules
- [x] email review queue
- [x] Email Review Inbox + Proactive Review Notifications v1: natural inbox phrases, grouped short-lived visible numbers, approval/rejection/action conversion against visible context, sync replies with pending review counts, and bundled scheduled review-waiting notifications
- [x] `job_search_email` adapter
- [x] `work_action_email` adapter
- [x] memory viewer through Telegram/API
- [x] templates for goals
- [~] OpenAI analysis/composition is optional and has deterministic fallback
- [x] Gmail token encryption at rest for the local MVP when `ALECTO_SECRET_ENCRYPTION_KEY` is configured, with legacy plaintext migration on read/sync
- [x] Custom Gmail sender/keyword tracking v1 with confirmation-first setup and review-only output
- [x] Gmail Setup + Autonomy Preferences v1 with state-aware Gmail setup/status/timing replies, goal-linked recommendations, manual-only vs scheduled preference, review-waiting notification preference, and honest no-op answers for digest/work-hours/webhook requests
- [x] Optional LLM semantic router v4 for English/Spanish/Catalan Gmail custom-rule create/edit/question/management flows, broader operator surface routing, email-rule list/timing questions, short-lived active-rule context, replacement corrections such as `instead of` / `en vez de` / `en lloc de`, routeDebug language/confidence/side-effect-risk observability, and conversation repair without direct DB mutation
- [ ] wallet public-address fetcher
- [ ] basic web settings page
- [ ] production OAuth/account management
- [ ] custom event type approval workflow

## MVP 2 - Product Alpha

Goal:
Make the system product-ready beyond the Telegram personal prototype.

Status:
- [ ] WhatsApp channel adapter
- [ ] OpenClaw gateway adapter
- [ ] web app/dashboard
- [ ] mobile app
- [ ] production OAuth flows
- [ ] health integrations
- [ ] calendar integrations
- [ ] billing
- [ ] hardened multi-user auth/isolation beyond Telegram user mapping
- [ ] enterprise/fund version
- [ ] vector DB/embeddings

## Current Next Useful Work

Likely high-leverage next items:
- refine first-run onboarding into a fuller guided setup session only after more real alpha usage
- keep weekly planning regression-tested as the bridge from weekly review into confirmed current-week/next-week ActionItems
- polish the planning loop from real Telegram usage now that Planning UX Consolidation v1 is implemented
- keep polishing Gmail setup, custom-rule management, and Email Review Inbox from real Telegram usage; v1 supports grouped review handling, manual/scheduled Gmail preference, review-notification preference, and bundled worker notifications, but Gmail webhooks, full-inbox monitoring, per-rule schedules, digest/work-hours preferences, and broader multilingual evals are still later work
- expand the semantic-router eval set from real Telegram logs across English, Spanish, and Catalan, keeping guardrails and executors deterministic
- harden tests around the daily operating loop and multi-intent routing as new behavior is added
- keep Gmail token storage clearly marked as local-MVP until production OAuth/account management, key management, and secret rotation are implemented
- defer new integrations until the operator loop and onboarding are easier to use
