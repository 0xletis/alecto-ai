# Operator Agent

Adaptive personal AI agent with goals, structured events, user operating profiles, risk states, intent routing, event extraction, and a Telegram-first MVP path.

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

Start the Fastify API:

```bash
docker compose up -d
pnpm db:generate
pnpm db:migrate
pnpm dev:api
```

The API defaults to `http://localhost:3000`.

Verify the routes from another terminal:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/events/types

curl -X POST http://localhost:3000/users/local-user/goals \
  -H "Content-Type: application/json" \
  -d '{"title":"Apply to better jobs","category":"career","why":"Build a stronger career path"}'

curl -X POST http://localhost:3000/messages/process \
  -H "Content-Type: application/json" \
  -d '{"userId":"local-user","message":"I sent 2 CVs and trained 45 minutes"}'

curl -X POST http://localhost:3000/messages/process \
  -H "Content-Type: application/json" \
  -d '{"userId":"local-user","message":"This Polymarket bet is safe free money"}'

curl http://localhost:3000/users/local-user/events
curl http://localhost:3000/users/local-user/events/recent
curl http://localhost:3000/users/local-user/goals
curl http://localhost:3000/users/local-user/review/daily
```

Expected:

- `/health` returns `{ "ok": true, "service": "operator-agent-api" }`
- `/events/types` returns the initial core event registry from `docs/02-event-ontology.md`
- `/messages/process` returns a rule-based intent, mode, risk state, extracted events, and reply. Extracted events are saved in Postgres through Prisma.
- RED betting/trading messages save a `finance.betting.cooldown_triggered` event and use recent stored events as risk context.
- `/users/:userId/review/daily` summarizes today's stored events against active goals.

## API Routes

- `GET /health`
- `GET /events/types`
- `POST /messages/process`
- `GET /users/:userId/events`
- `GET /users/:userId/events/recent`
- `GET /users/:userId/goals`
- `POST /users/:userId/goals`
- `PATCH /users/:userId/goals/:goalId/archive`
- `GET /users/:userId/review/daily`

## Packages

- `packages/core`: shared domain types, Zod schemas, risk states, user operating profile, and the initial event registry.
- `packages/llm`: placeholder OpenAI wrapper plus intent routing and event extraction result types.
- `packages/db`: Prisma schema, client export, and repository functions for users, goals, and events.
- `apps/api`: Fastify API exposing health, event type, message processing, persisted event, and persisted goal routes.

## Current Scope

This skeleton intentionally does not include UI, OpenClaw integration, OAuth/auth, OpenAI calls, Telegram, or wallet/private-key functionality.
