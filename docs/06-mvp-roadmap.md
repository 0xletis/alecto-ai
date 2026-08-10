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
- [x] `job_search_email` adapter
- [x] `work_action_email` adapter
- [x] memory viewer through Telegram/API
- [x] templates for goals
- [~] OpenAI analysis/composition is optional and has deterministic fallback
- [~] Gmail token storage is local-MVP only; encrypt before production
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
- harden tests around the daily operating loop and multi-intent routing as new behavior is added
- keep Gmail token storage clearly marked as local-MVP until encryption is implemented
- defer new integrations until the operator loop and onboarding are easier to use
