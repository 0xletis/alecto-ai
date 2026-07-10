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

## Telegram Bot

Create a Telegram bot with BotFather, then add the token to your environment:

```bash
TELEGRAM_BOT_TOKEN=123456:your-token
API_BASE_URL=http://localhost:3000
```

Optionally restrict access to specific Telegram users. Entries can be raw numeric IDs or `telegram:<id>` values:

```bash
TELEGRAM_ALLOWED_USER_IDS=123456789,telegram:987654321
```

Replace placeholder IDs with your real Telegram user ID. Do not paste `telegram:YOUR_ID` literally. Run `/whoami` in the bot to get your ID.

If `TELEGRAM_ALLOWED_USER_IDS` is empty or missing, everyone is allowed. `/whoami` always works, even before a user is allowlisted, so people can send their Telegram ID to the owner.

Run the API and the Telegram bot in separate terminals:

```bash
pnpm dev:api
```

```bash
pnpm dev:telegram
```

Run the reminder worker in a third terminal when you want proactive daily check-ins:

```bash
pnpm dev:worker
```

Both the Telegram bot and worker need `TELEGRAM_BOT_TOKEN`. For local dev, reminder times use `Europe/Madrid` by default.

Telegram users are mapped to API users as `telegram:<telegramUserId>`, so each Telegram account has separate goals, events, and profile.

Telegram commands:

- `/start`: short intro
- `/whoami`: show Telegram ID and derived agent userId
- `/setup`: setup checklist
- `/profile`: show operating profile
- `/notifications`: show notification settings
- `/enable_checkin 09:00`: enable daily check-in reminders at local time
- `/disable_checkin`: disable daily check-in reminders
- `/send_checkin_now`: send the daily check-in reminder text immediately for testing
- `/set_style hard_guardian`: apply hard guardian profile defaults
- `/set_style balanced`: apply balanced profile defaults
- `/templates`: show available goal templates
- `/create_goal category | title | why`: create a goal
- `/create_goal_from_template templateId | title | why`: create a structured goal from a template
- `/archive_goal <goalId>`: archive a goal
- `/checkin energy=6 anxiety=4 focus=7 gambling=2 applications=2 workout=45 reading=30 sleep=7 notes=Felt okay today`: save a manual daily check-in
- `/checkin_natural`: show natural-language daily check-in examples
- `/review`: daily review
- `/goals`: active goals
- `/events`: recent events
- `/pending`: show pending profile/goal changes
- `/confirm`: confirm the latest pending change
- `/cancel`: cancel the latest pending change

Normal messages can also confirm or reject pending changes. Send `yes`, `confirm`, `si`, or `dale` to confirm. Send `no`, `cancel`, or `cancelar` to reject.

Verify the routes from another terminal:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/events/types
curl http://localhost:3000/goal-templates
curl http://localhost:3000/goal-templates/career.job_search

curl -X POST http://localhost:3000/users/local-user/goals \
  -H "Content-Type: application/json" \
  -d '{"title":"Apply to better jobs","category":"career","why":"Build a stronger career path"}'

curl -X POST http://localhost:3000/users/local-user/goals/from-template \
  -H "Content-Type: application/json" \
  -d '{"templateId":"career.job_search","title":"Find a new Web3 developer job","why":"Build stable career capital"}'

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

curl -X POST http://localhost:3000/messages/process \
  -H "Content-Type: application/json" \
  -d '{"userId":"local-user","message":"be stricter with me and do not let me justify bets"}'

curl http://localhost:3000/users/local-user/pending-actions

curl -X POST http://localhost:3000/messages/process \
  -H "Content-Type: application/json" \
  -d '{"userId":"local-user","message":"yes"}'

curl -X POST http://localhost:3000/messages/process \
  -H "Content-Type: application/json" \
  -d '{"userId":"local-user","message":"I want to focus on gym"}'

curl -X POST http://localhost:3000/messages/process \
  -H "Content-Type: application/json" \
  -d '{"userId":"local-user","message":"I want to find a new job"}'

curl -X POST http://localhost:3000/messages/process \
  -H "Content-Type: application/json" \
  -d '{"userId":"local-user","message":"no"}'

curl -X POST http://localhost:3000/users/local-user/checkins/daily \
  -H "Content-Type: application/json" \
  -d '{
    "answers": [
      { "key": "energy", "value": 6 },
      { "key": "anxiety", "value": 4 },
      { "key": "focus", "value": 7 },
      { "key": "gambling_impulse", "value": 2 },
      { "key": "applications", "value": 2 },
      { "key": "workout", "value": 45 },
      { "key": "reading", "value": 30 },
      { "key": "sleep", "value": 7 },
      { "key": "notes", "value": "Felt okay, applied to jobs." }
    ]
  }'

curl -X POST http://localhost:3000/users/local-user/checkins/daily/text \
  -H "Content-Type: application/json" \
  -d '{"text":"slept 6h, energy 5, anxiety 7, sent 2 cvs, trained 40 min, read 20 min, no gambling impulse"}'

curl -X POST http://localhost:3000/users/local-user/checkins/daily/text \
  -H "Content-Type: application/json" \
  -d '{"text":"dormi 7 horas, energia 6, ansiedad 4, foco 7, mande 3 cvs y entrené 45 min"}'

curl -X POST http://localhost:3000/users/local-user/checkins/daily/text \
  -H "Content-Type: application/json" \
  -d '{"text":"energy 6 anxiety 3 focus 8, no bets, read for half an hour"}'

curl -X POST http://localhost:3000/users/local-user/checkins/daily/text \
  -H "Content-Type: application/json" \
  -d '{"text":"hoy fatal, dormí 5h, ansiedad 8, ganas de apostar 7"}'

curl http://localhost:3000/users/local-user/events
curl http://localhost:3000/users/local-user/events/recent
curl http://localhost:3000/users/local-user/goals
curl http://localhost:3000/users/local-user/review/daily
```

Expected:

- `/health` returns `{ "ok": true, "service": "operator-agent-api" }`
- `/events/types` returns the initial core event registry from `docs/02-event-ontology.md`
- `/goal-templates` returns structured goal templates such as `career.job_search`, `health.strength_energy`, `health.sleep_better`, `learning.reading_more`, and `finance.control_betting_trading`.
- `/messages/process` returns a rule-based intent, mode, risk state, extracted events, and reply. Extracted events are saved in Postgres through Prisma.
- Events auto-log when detected. Profile changes, goal creation, and goal archiving proposed from natural language are stored as pending actions first and require confirmation.
- Natural-language goal creation uses a matching template when obvious, but still asks for confirmation before creating the goal.
- Duplicate active goals are blocked by default when the title, template, or similar category/title already exists. Use `/goals` to review similar goals or archive the older one first.
- `/users/:userId/checkins/daily` saves a manual check-in as reflection events and daily review includes check-in values.
- `/users/:userId/checkins/daily/text` parses natural-language check-ins and creates the same structured events as `/checkins/daily`.
- Check-in fields `applications`, `workout`, `reading`, and `sleep` create structured progress events. Notes are journal context unless they contain clear numeric phrases like `sent 2 CVs`, `trained 45 minutes`, or `read 30 minutes`.
- Telegram normal messages that look like daily check-ins are sent to `/checkins/daily/text`. Structured `/checkin key=value` still works.
- Natural check-in warnings include high anxiety plus gambling impulse and low sleep.
- Daily reminders send once per user per day because of `NotificationLog`. Use `/send_checkin_now` to test the reminder text repeatedly without creating a log.
- Daily review sums progress metrics like applications, workout minutes, and reading minutes, but uses the latest state metrics for sleep, energy, anxiety, focus, and impulse.
- When `USE_OPENAI_ANALYSIS=true` and `OPENAI_API_KEY` is set, `/messages/process` uses OpenAI structured output for intent/mode/event analysis, validates the JSON, then still runs deterministic risk policy.
- `/messages/process` fetches the user's operating profile and adapts guardian/vulnerable reply tone without overriding deterministic risk policy.
- RED betting/trading messages save a `finance.betting.cooldown_triggered` event and use recent stored events as risk context.
- `/users/:userId/review/daily` summarizes today's stored events against active goals.

## API Routes

- `GET /health`
- `GET /events/types`
- `GET /goal-templates`
- `GET /goal-templates/:templateId`
- `POST /messages/process`
- `GET /users/:userId/events`
- `GET /users/:userId/events/recent`
- `GET /users/:userId/goals`
- `GET /users/:userId/profile`
- `PATCH /users/:userId/profile`
- `GET /users/:userId/notification-settings`
- `PATCH /users/:userId/notification-settings`
- `GET /users/:userId/pending-actions`
- `POST /users/:userId/pending-actions/:pendingActionId/confirm`
- `POST /users/:userId/pending-actions/:pendingActionId/reject`
- `POST /users/:userId/goals`
- `POST /users/:userId/goals/from-template`
- `PATCH /users/:userId/goals/:goalId/archive`
- `POST /users/:userId/checkins/daily`
- `POST /users/:userId/checkins/daily/text`
- `GET /users/:userId/review/daily`

## Packages

- `packages/core`: shared domain types, Zod schemas, risk states, user operating profile, and the initial event registry.
- `packages/llm`: optional OpenAI structured message analyzer plus analysis result schemas.
- `packages/db`: Prisma schema, client export, and repository functions for users, goals, and events.
- `apps/api`: Fastify API exposing health, event type, message processing, persisted event, and persisted goal routes.
- `apps/telegram-bot`: Telegram channel adapter that forwards messages to the API.

## Current Scope

This skeleton intentionally does not include UI, OpenClaw integration, OAuth/auth, WhatsApp, or wallet/private-key functionality.
