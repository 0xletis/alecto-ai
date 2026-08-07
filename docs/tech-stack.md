# Tech Stack

Status: current as of 2026-08-06.

- Language: TypeScript
- Package manager: pnpm
- Backend: Node.js + Fastify
- DB: Postgres
- ORM: Prisma
- LLM: OpenAI optional, deterministic fallback required
- Bot/channel: Telegram first
- Worker: Node/TypeScript interval worker, no queue platform

## Apps

- `apps/api`: Fastify API and main orchestration layer
- `apps/telegram-bot`: Telegram adapter over the API
- `apps/worker`: proactive jobs for reminders, insights, daily loop, and integration sync

## Packages

- `packages/core`: shared schemas and deterministic domain logic
- `packages/db`: Prisma schema/client and repositories
- `packages/llm`: optional OpenAI integration helpers

## Channel Direction

- [x] Telegram now
- [ ] WhatsApp later
- [ ] OpenClaw later as gateway adapter
- [ ] Web/mobile later

Core engine remains channel-agnostic through `NormalizedInboundMessage`.
