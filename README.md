# Operator Agent

Adaptive personal AI agent with goals, structured events, user operating profiles, risk states, intent routing, event extraction, and a Telegram-first MVP path.

## Setup

```bash
pnpm install
pnpm typecheck
pnpm build
```

## Local API Dev

Start the Fastify API:

```bash
pnpm dev:api
```

The API defaults to `http://localhost:3000`.

Verify the routes from another terminal:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/events/types
curl -X POST http://localhost:3000/messages/process \
  -H "Content-Type: application/json" \
  -d '{"userId":"local-user","message":"I sent 2 CVs and trained 45 minutes"}'
curl -X POST http://localhost:3000/messages/process \
  -H "Content-Type: application/json" \
  -d '{"userId":"local-user","message":"This Polymarket bet is safe free money"}'
```

Expected:

- `/health` returns `{ "ok": true, "service": "operator-agent-api" }`
- `/events/types` returns the initial core event registry from `docs/02-event-ontology.md`
- `/messages/process` returns a rule-based intent, mode, risk state, extracted events, and reply. It does not call OpenAI or write to a database.

## API Routes

- `GET /health`
- `GET /events/types`
- `POST /messages/process`

## Packages

- `packages/core`: shared domain types, Zod schemas, risk states, user operating profile, and the initial event registry.
- `packages/llm`: placeholder OpenAI wrapper plus intent routing and event extraction result types.
- `apps/api`: Fastify API exposing health and event type routes.

## Current Scope

This skeleton intentionally does not include UI, OpenClaw integration, OAuth, or wallet/private-key functionality.
