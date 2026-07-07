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

Start the Fastify API without OpenAI analysis:

```bash
docker compose up -d
pnpm db:generate
pnpm db:migrate
USE_OPENAI_ANALYSIS=false pnpm dev:api
```

Start with optional OpenAI structured analysis:

```bash
docker compose up -d
pnpm db:generate
pnpm db:migrate
OPENAI_API_KEY=sk-... USE_OPENAI_ANALYSIS=true OPENAI_MODEL=gpt-4o-mini pnpm dev:api
```

You can also put these values in `.env` or your shell:

```bash
USE_OPENAI_ANALYSIS=true
OPENAI_MODEL=gpt-4o-mini
OPENAI_API_KEY=sk-...
```

When OpenAI analysis is disabled, missing, or fails validation, the API falls back to the rule-based pipeline.
The deterministic risk engine always runs after analysis and has final authority over RED betting/trading behavior.

Start with your current environment:

```bash
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

curl http://localhost:3000/users/local-user/profile

curl -X PATCH http://localhost:3000/users/dev-user/profile \
  -H "Content-Type: application/json" \
  -d '{
    "directness": 5,
    "warmth": 3,
    "confrontation": 5,
    "profanityAllowed": true,
    "motivationalStyle": "tough_love",
    "accountabilityStrictness": 5,
    "escalationStyle": "brutal_when_needed",
    "gamblingGuardrails": "hard_guardian",
    "selfDeceptionSensitivity": 5,
    "cooldownPreference": "hard_no",
    "vulnerableMode": "soften",
    "avoidingMode": "confront",
    "impulsiveMode": "guardian_mode"
  }'

curl -X POST http://localhost:3000/messages/process \
  -H "Content-Type: application/json" \
  -d '{"userId":"local-user","message":"I sent 2 CVs and trained 45 minutes"}'

curl -X POST http://localhost:3000/messages/process \
  -H "Content-Type: application/json" \
  -d '{"userId":"local-user","message":"This Polymarket bet is safe free money"}'

curl -X POST http://localhost:3000/messages/process \
  -H "Content-Type: application/json" \
  -d '{"userId":"local-user","message":"he mandado un par de cvs y luego he ido al gym casi una hora"}'

curl -X POST http://localhost:3000/messages/process \
  -H "Content-Type: application/json" \
  -d '{"userId":"local-user","message":"me siento raro y no se que hacer hoy"}'

curl -X POST http://localhost:3000/messages/process \
  -H "Content-Type: application/json" \
  -d '{"userId":"local-user","message":"quiero apostar 1000 porque esto es seguro"}'

curl http://localhost:3000/users/local-user/events
curl http://localhost:3000/users/local-user/events/recent
curl http://localhost:3000/users/local-user/goals
curl http://localhost:3000/users/local-user/review/daily
```

Expected:

- `/health` returns `{ "ok": true, "service": "operator-agent-api" }`
- `/events/types` returns the initial core event registry from `docs/02-event-ontology.md`
- `/messages/process` returns a rule-based intent, mode, risk state, extracted events, and reply. Extracted events are saved in Postgres through Prisma.
- When `USE_OPENAI_ANALYSIS=true` and `OPENAI_API_KEY` is set, `/messages/process` uses OpenAI structured output for intent/mode/event analysis, validates the JSON, then still runs deterministic risk policy.
- `/messages/process` fetches the user's operating profile and adapts guardian/vulnerable reply tone without overriding deterministic risk policy.
- RED betting/trading messages save a `finance.betting.cooldown_triggered` event and use recent stored events as risk context.
- `/users/:userId/review/daily` summarizes today's stored events against active goals.

## API Routes

- `GET /health`
- `GET /events/types`
- `POST /messages/process`
- `GET /users/:userId/events`
- `GET /users/:userId/events/recent`
- `GET /users/:userId/goals`
- `GET /users/:userId/profile`
- `PATCH /users/:userId/profile`
- `POST /users/:userId/goals`
- `PATCH /users/:userId/goals/:goalId/archive`
- `GET /users/:userId/review/daily`

## Packages

- `packages/core`: shared domain types, Zod schemas, risk states, user operating profile, and the initial event registry.
- `packages/llm`: optional OpenAI structured message analyzer plus analysis result schemas.
- `packages/db`: Prisma schema, client export, and repository functions for users, goals, and events.
- `apps/api`: Fastify API exposing health, event type, message processing, persisted event, and persisted goal routes.

## Current Scope

This skeleton intentionally does not include UI, OpenClaw integration, OAuth/auth, OpenAI calls, Telegram, or wallet/private-key functionality.
