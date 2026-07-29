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
After intent, event extraction, and risk are finalized, `/messages/process` runs ResponseComposer v1.
The composer uses mode, risk state, profile, active goals, recent events, memories, and today's summary to produce the final reply.
If OpenAI is enabled, it may rewrite the deterministic fallback for tone, but it cannot create DB changes, invent facts, or override RED risk policy.

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
- `/memory`: show active user-visible memories
- `/remember <text>`: save a visible memory immediately
- `/forget_memory <memoryId>`: archive a memory
- `/notifications`: show notification settings
- `/enable_checkin 09:00`: enable daily check-in reminders at local time
- `/disable_checkin`: disable daily check-in reminders
- `/send_checkin_now`: preview the same goal-aware daily check-in prompt the worker sends
- `/enable_daily_insight 21:30`: enable scheduled daily insight delivery
- `/disable_daily_insight`: disable scheduled daily insight delivery
- `/enable_weekly_insight sunday 20:00`: enable scheduled weekly insight delivery
- `/disable_weekly_insight`: disable scheduled weekly insight delivery
- `/send_daily_insight_now`: send the current daily insight immediately without creating a notification log
- `/send_weekly_insight_now`: send the current weekly insight immediately without creating a notification log
- `/set_style hard_guardian`: apply hard guardian profile defaults
- `/set_style balanced`: apply balanced profile defaults
- `/templates`: show available goal templates
- `/integrations`: show available and planned integrations
- `/my_integrations`: show your connected integrations
- `/connect_github OWNER/REPO`: watch public repo activity as external context
- `/connect_github OWNER/REPO author=LOGIN`: connect a public repo and only log matching commits
- `/pause_integration CONNECTION_ID`: pause an integration
- `/resume_integration CONNECTION_ID`: resume a paused integration
- `/delete_integration CONNECTION_ID`: archive an integration while keeping historical events
- `/sync_integrations`: sync all active integrations
- `/sync_integration CONNECTION_ID`: sync one integration
- `/connect_gmail`: get the Gmail readonly OAuth URL
- `/my_email_rules`: show Gmail email signal rules
- `/enable_email_rule job_search`: enable job-search email scanning after Gmail is connected
- `/enable_email_rule work_action`: enable review-first work/action email scanning after Gmail is connected
- `/enable_email_rule job_search goal=GOAL_ID`: attach the job-search email rule to a goal
- `/pause_email_rule RULE_ID`: pause an email rule
- `/resume_email_rule RULE_ID`: resume a paused email rule
- `/set_email_rule_config RULE_ID key=value`: tune a rule, for example `maxMessagesPerSync=10 maxEventsPerSync=3 classifierMode=rules`
- `/delete_email_rule RULE_ID`: archive an email rule
- `/cleanup_gmail_rule_events RULE_ID`: archive active Gmail events created by one email rule
- `/email_reviews`: show pending Gmail email review items
- `/email_reviews all`: show recent pending/approved/rejected email review items
- `/approve_email_review REVIEW_ID`: approve a pending email review item
- `/reject_email_review REVIEW_ID`: reject a pending email review item
- `/sync_gmail`: manually sync active Gmail rules
- `/sync_gmail_debug`: manually sync Gmail and show safe per-rule counters
- `/create_goal category | title | why`: create a goal
- `/create_goal_from_template templateId | title | why`: create a structured goal from a template
- `/archive_goal <goalId>`: archive a goal
- `/checkin energy=6 anxiety=4 focus=7 gambling=2 applications=2 workout=45 reading=30 sleep=7 notes=Felt okay today`: save a manual daily check-in
- `/checkin_natural`: show natural-language daily check-in examples
- `/review`: daily review
- `/insight`: daily interpretive coaching insight
- `/daily_insight`: alias of `/insight`
- `/weekly`: weekly interpretive coaching insight
- `/weekly_insight`: alias of `/weekly`
- `/goals`: active goals
- `/events [limit]`: recent active events with ids, defaults to 5 and caps at 20
- `/events_archived [limit]`: recent events including archived/corrected status, defaults to 5 and caps at 20
- `/undo_last_event`: archive the latest logged event group
- `/delete_event <eventId>`: archive one event
- `/correct_event EVENT_ID | {"duration_minutes":30}`: correct one event while preserving history
- `/ingest <text>`: route pasted text through the generic ingestion framework
- `/ingest_job <text>`: ingest pasted job-search/recruiter text with a career domain hint
- `/pending`: show pending profile/goal changes
- `/confirm`: confirm the latest pending change
- `/cancel`: cancel the latest pending change

Normal messages can also confirm or reject pending changes. Send `yes`, `confirm`, `si`, or `dale` to confirm. Send `no`, `cancel`, or `cancelar` to reject.

Events are factual logs. Memories are durable preferences, context, and patterns. Memories are user-visible, and inferred memories are created as pending actions that require confirmation.

Verify the routes from another terminal:

```bash
curl http://localhost:3000/health
curl http://localhost:3000/events/types
curl http://localhost:3000/goal-templates
curl http://localhost:3000/integrations
curl http://localhost:3000/goal-templates/career.job_search

curl -X POST http://localhost:3000/users/local-user/goals \
  -H "Content-Type: application/json" \
  -d '{"title":"Apply to better jobs","category":"career","why":"Build a stronger career path"}'

curl -X POST http://localhost:3000/users/local-user/goals/from-template \
  -H "Content-Type: application/json" \
  -d '{"templateId":"career.job_search","title":"Find a new Web3 developer job","why":"Build stable career capital"}'

curl http://localhost:3000/users/local-user/profile

curl http://localhost:3000/users/local-user/memory

curl -X POST http://localhost:3000/users/local-user/memory \
  -H "Content-Type: application/json" \
  -d '{"type":"preference","summary":"User prefers direct, evidence-based feedback."}'

curl -X POST http://localhost:3000/messages/process \
  -H "Content-Type: application/json" \
  -d '{"userId":"local-user","message":"remember that I hate generic motivation"}'

curl -X POST http://localhost:3000/messages/process \
  -H "Content-Type: application/json" \
  -d '{"userId":"local-user","message":"remember that when I talk about gambling I want you to be stricter, not balanced"}'

curl -X POST http://localhost:3000/messages/process \
  -H "Content-Type: application/json" \
  -d '{"userId":"local-user","message":"recuerda que prefiero que me hables directo"}'

curl http://localhost:3000/users/local-user/memory

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
  -d '{"userId":"local-user","message":"This bet is guaranteed safe free money"}'

curl http://localhost:3000/users/local-user/pending-actions

curl -X POST http://localhost:3000/messages/process \
  -H "Content-Type: application/json" \
  -d '{"userId":"local-user","message":"yes"}'

curl -X POST http://localhost:3000/messages/process \
  -H "Content-Type: application/json" \
  -d '{"userId":"local-user","message":"he mandado un par de cvs y luego he ido al gym casi una hora"}'

curl -X POST http://localhost:3000/messages/process \
  -H "Content-Type: application/json" \
  -d '{"userId":"local-user","message":"me siento raro y no se que hacer hoy"}'

curl -X POST http://localhost:3000/messages/process \
  -H "Content-Type: application/json" \
  -d '{"userId":"local-user","message":"I feel stuck"}'

curl -X POST http://localhost:3000/messages/process \
  -H "Content-Type: application/json" \
  -d '{"userId":"local-user","message":"I feel like shit today"}'

curl -X POST http://localhost:3000/messages/process \
  -H "Content-Type: application/json" \
  -d '{"userId":"local-user","message":"what next on the repo?"}'

curl -X POST http://localhost:3000/messages/process \
  -H "Content-Type: application/json" \
  -d '{"userId":"local-user","message":"quiero apostar 1000 porque esto es seguro"}'

curl -X POST http://localhost:3000/messages/process \
  -H "Content-Type: application/json" \
  -d '{"userId":"local-user","message":"quiero apostar otra vez porque es casi seguro"}'

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

curl -X POST http://localhost:3000/users/local-user/ingest/text \
  -H "Content-Type: application/json" \
  -d '{"source":"manual_paste","domainHint":"career","text":"Hi Miquel, we would like to schedule an interview for the Backend Engineer role at Example Labs. Are you available this week?"}'

curl -X POST http://localhost:3000/users/local-user/ingest/text \
  -H "Content-Type: application/json" \
  -d '{"source":"manual_paste","domainHint":"career","text":"Unfortunately, we decided to move forward with other candidates for the Product Engineer role."}'

curl -X POST http://localhost:3000/messages/process \
  -H "Content-Type: application/json" \
  -d '{"userId":"local-user","message":"quiero apostar, no tengo gambling impulse"}'

curl -X POST http://localhost:3000/users/local-user/checkins/daily/text \
  -H "Content-Type: application/json" \
  -d '{"text":"dormí 5h, ansiedad 7, ganas de apostar 8"}'

curl http://localhost:3000/users/local-user/events
curl http://localhost:3000/users/local-user/events/recent
curl "http://localhost:3000/users/local-user/events/recent?includeArchived=true"

curl -X POST http://localhost:3000/users/local-user/events/undo-last \
  -H "Content-Type: application/json" \
  -d '{"scope":"group","reason":"undo last"}'

curl -X PATCH http://localhost:3000/users/local-user/events/<eventId>/archive \
  -H "Content-Type: application/json" \
  -d '{"reason":"wrongly logged"}'

curl -X POST http://localhost:3000/users/local-user/events/<eventId>/correct \
  -H "Content-Type: application/json" \
  -d '{"data":{"duration_minutes":30},"reason":"corrected by user"}'

curl -X POST http://localhost:3000/users/local-user/events/<journalEventId>/correct \
  -H "Content-Type: application/json" \
  -d '{"data":{"duration_minutes":30},"reason":"wrong event id test"}'

# Telegram manual test:
# /correct_event <journalEventId> | {"duration_minutes":30}
# should show the journal/workout-readable validation error.
# /correct_event <eventId> | {bad json}
# should show: Invalid JSON. Example: /correct_event EVENT_ID | {"duration_minutes":30}

curl http://localhost:3000/users/local-user/goals
curl http://localhost:3000/users/local-user/checkins/daily/prompt
curl http://localhost:3000/users/local-user/review/daily
curl http://localhost:3000/users/local-user/insights/daily
curl 'http://localhost:3000/users/local-user/insights/daily?date=2026-07-11'
curl http://localhost:3000/users/local-user/insights/weekly
curl 'http://localhost:3000/users/local-user/insights/weekly?weekStart=2026-07-05'

curl -X POST http://localhost:3000/users/local-user/goals/custom-config \
  -H "Content-Type: application/json" \
  -d '{"title":"Build a YouTube channel","category":"creative"}'

curl -X POST http://localhost:3000/users/local-user/goals/<goalId>/progress \
  -H "Content-Type: application/json" \
  -d '{"metricKey":"focused_minutes","value":45,"unit":"minutes","note":"script draft"}'

curl -X PATCH http://localhost:3000/users/local-user/memory/<memoryId>/archive \
  -H "Content-Type: application/json" \
  -d '{}'
```

Expected:

- `/health` returns `{ "ok": true, "service": "operator-agent-api" }`
- `/events/types` returns the initial core event registry from `docs/02-event-ontology.md`
- `/goal-templates` returns structured goal templates such as `career.job_search`, `health.strength_energy`, `health.sleep_better`, `learning.reading_more`, and `finance.control_betting_trading`.
- `/integrations` returns Integration Registry v1. `github_public` and `gmail` are available; `wallet_public` is planned.
- Gmail is a generic readonly email source. It does not scan anything until the user connects Gmail and explicitly enables an email rule.
- `job_search_email` searches user-approved Gmail results for recruiter replies, interview scheduling, application confirmations, rejections, and offers, then feeds the existing `job_search_text` ingestion adapter.
- `work_action_email` is a review-first adapter for action requests, deadlines, follow-ups, feedback, blockers, and project updates. It uses the existing Gmail source and readonly scope.
- Planned email adapters include finance receipts, learning deadlines, and custom goal email signals.
- Email rules control the fetch strategy, lookback window, classifier mode, message cap, event cap, and confidence thresholds. Supported fetch strategies are `query` and `all_recent`; `sender_allowlist` and `label` are reserved for later and fail safely.
- Classifier modes are `rules`, `hybrid`, and `llm`. `rules` uses the deterministic classifier and never calls OpenAI. `hybrid` keeps hard deterministic filters first, uses rules for obvious high-confidence classifications, and can use OpenAI only for ambiguous cases when `OPENAI_API_KEY` is available. `llm` still applies hard filters before OpenAI and does not crash without a key; it marks the email for review instead of auto-logging.
- Rule sync is capped by `maxMessagesPerSync` and `maxEventsPerSync`, creates at most one event per email, and only logs approved event types from the ontology.
- Gmail OAuth tokens are stored in local Postgres JSON config for the MVP. They are never returned by the OAuth callback, `/my_integrations`, sync responses, or Telegram replies. Encrypt tokens before production.
- Never commit `.env`. If OAuth tokens are leaked during local testing, revoke the Google app/session and reconnect Gmail.
- `/sync_gmail` reports safe counters: messages found, processed, ignored, deduped, and events created. `/sync_gmail_debug` adds per-rule IDs, LLM counters, and last errors without email bodies or tokens.
- Gmail dedupe skips active duplicates. Events archived by `/cleanup_gmail_rule_events` can be reprocessed after classifier fixes; normal manual archives still block recreation.
- Gmail `job_search_email` is conservative. It requires strong recruiting/job context, ignores obvious marketing/newsletter/promotional emails, and never treats the word `offer` alone as a career offer.
- Gmail emails below auto-log confidence are not logged automatically. Uncertain messages count as `needs review`; weak matches count as low-confidence ignored or unknown.
- Gmail `needs_review` classifications create pending email review items. Approving only creates an event when the proposed event type is already in the core ontology.
- Use `/cleanup_gmail_rule_events RULE_ID` to archive test Gmail events from one rule without deleting historical data.
- `/messages/process` returns a rule-based intent, mode, risk state, extracted events, and reply. Extracted events are saved in Postgres through Prisma.
- Explicit memory phrases like `remember that`, `recuerda que`, or `guarda que` create visible memories immediately and reply `Saved to memory.`
- `/users/:userId/memory` returns active memories by default. Use `?includeArchived=true` to include archived/rejected memories.
- Telegram routes explicit memory and direct betting/trading intent to `/messages/process` before considering natural check-ins.
- Natural check-ins need state context like sleep/anxiety/energy/focus, at least two progress signals, or a recent daily reminder plus a state/progress signal. Gambling words alone do not make a check-in.
- Events auto-log when detected. Profile changes, goal creation, and goal archiving proposed from natural language are stored as pending actions first and require confirmation.
- Inferred risk memories, such as repeated betting cooldowns or repeated low sleep plus high gambling impulse, are stored as `memory_create` pending actions. Reply `yes` to save the memory or `no` to ignore it.
- Repeated guardian messages should not spam duplicate `memory_create` suggestions when a similar active memory or pending memory already exists.
- Natural-language goal creation uses a matching template when obvious, but still asks for confirmation before creating the goal.
- Natural-language custom goal creation generates target metrics and check-in questions before confirmation.
- Custom goals can log progress with `custom.goal_progress_logged`, either through `POST /users/:userId/goals/:goalId/progress` or Telegram `/log_progress`.
- Telegram `/goal_plan <goalId>` shows the saved template/custom metrics, check-in questions, and progress logging examples.
- Telegram `/log_progress <goalId> | metric=focused_minutes value=45 unit=minutes note=focused block` logs structured custom progress immediately.
- Telegram `/log_progress <goalId> | worked for 45 minutes on the first draft` parses free text into a simple custom progress event.
- Natural messages like `log progress for Build a YouTube channel: worked for 45 minutes` create a pending confirmation before writing the progress event.
- Duplicate active goals are blocked by default when the title, template, or similar category/title already exists. Use `/goals` to review similar goals or archive the older one first.
- `/users/:userId/checkins/daily` saves a manual check-in as reflection events and daily review includes check-in values.
- `/users/:userId/checkins/daily/text` parses natural-language check-ins and creates the same structured events as `/checkins/daily`.
- Event reads ignore archived/corrected events by default. Add `includeArchived=true` to inspect archived/corrected audit history.
- Event corrections archive the original event as `corrected` and create a replacement event; undo/archive operations do not hard-delete events.
- Correction data is validated against the event type. For example, correcting a journal event with `duration_minutes` is rejected; correct the derived workout or reading event instead.
- Correcting a derived check-in event, such as workout duration, also updates the parent `reflection.daily_checkin_completed.data.answers` for that group.
- Check-in fields `applications`, `workout`, `reading`, and `sleep` create structured progress events. Notes are journal context unless they contain clear numeric phrases like `sent 2 CVs`, `trained 45 minutes`, or `read 30 minutes`.
- Telegram normal messages that look like daily check-ins are sent to `/checkins/daily/text`. Structured `/checkin key=value` still works.
- Generic ingestion uses the flow raw input -> ingestion router -> adapter registry -> adapter parse result -> normalized events. Future adapters should register with the ingestion registry instead of adding one-off pipelines.
- `job_search_text` is the first ingestion adapter. It classifies pasted recruiter/job-search text as application confirmation, recruiter reply, interview scheduled, rejection, offer, or unknown.
- `/ingest` and `/ingest_job` call `POST /users/:userId/ingest/text`. Telegram also routes obvious pasted job-search emails, such as recruiter interview scheduling or rejection emails, to ingestion. Casual logs like `i sent 2 cvs today` stay on the normal message/check-in path.
- `/events` and `/events_archived` truncate long data/evidence fields to avoid Telegram message length failures. Use `/events 10` or `/events_archived 10` for more, up to 20.
- Natural check-in warnings include high anxiety plus gambling impulse and low sleep.
- Daily check-in reminders, daily insights, and weekly insights are sent by `pnpm dev:worker`.
- Daily reminders send once per user per day because of `NotificationLog`. Daily insights use `daily_insight` logs, and weekly insights use `weekly_insight` logs.
- Use `/send_checkin_now`, `/send_daily_insight_now`, and `/send_weekly_insight_now` to test message text repeatedly without creating notification logs.
- Daily check-in prompts are goal-aware. Active goal templates influence the prompt, for example career goals ask about applications and interviews, health goals ask about workout/sleep, finance goals ask about impulse and thesis-before-risk.
- Custom goals with check-in config add up to two goal-specific lines to the daily check-in prompt.
- `/send_checkin_now` previews the same goal-aware prompt the worker sends.
- `/enable_daily_insight 21:30` sends `/insight` output once per day at the configured local time.
- `/enable_weekly_insight sunday 20:00` sends `/weekly` output once for that week at the configured local weekday/time.
- Daily review sums progress metrics like applications, workout minutes, and reading minutes, but uses the latest state metrics for sleep, energy, anxiety, focus, and impulse.
- `/review` is factual. `/insight` and `/weekly` are interpretive coaching reports built from active events, goals, memories, profile, and risk signals.
- Daily insight identifies meaningful progress, gaps, risk state, relevant memory signals, and 1-3 recommended next actions.
- Weekly insight aggregates the last 7 days by default and looks for repeated patterns such as cooldowns, low sleep, high anxiety, and clustered progress.
- When `USE_OPENAI_ANALYSIS=true` and `OPENAI_API_KEY` is set, `/messages/process` uses OpenAI structured output for intent/mode/event analysis, validates the JSON, then still runs deterministic risk policy.
- ResponseComposer v1 is the final normal-chat reply layer. It supports `fiscal`, `guardian`, `support`, `mirror`, `builder`, and `review` style replies from the same structured context pack.
- Composer context includes active goals, last 10 active events, up to 5 relevant memories, the user operating profile, and today's factual summary.
- Deterministic composer fallback always works without OpenAI. If OpenAI composition fails, the fallback reply is returned.
- Guardian RED replies remain deterministic and do not validate betting/trading behavior.
- When OpenAI is enabled, insight wording may be lightly polished from the deterministic report. The LLM should not invent facts, metrics, risks, memories, or actions; if polish fails, the deterministic insight is returned.
- `/messages/process` fetches the user's operating profile and adapts guardian/vulnerable reply tone without overriding deterministic risk policy.
- RED betting/trading messages save a `finance.betting.cooldown_triggered` event and use recent stored events as risk context.
- `/users/:userId/review/daily` summarizes today's stored events against active goals.
- Daily review includes a concise `Memory signals` section when active risk-pattern memories are relevant to today's events.
- Daily review and insights treat `custom.goal_progress_logged` as real progress for custom goals, including summed minutes when the unit is `minutes`.
- GitHub public repo sync creates `coding.repo_activity_detected` when no `author=LOGIN` filter is set. That is external context, not personal progress.
- GitHub public repo sync creates `coding.commit_created` only when `author=LOGIN` is configured and the commit matches that user. Those personal commits can count as wins/progress.
- The public GitHub integration does not support private repos. A private or nonexistent repo returns a clean sync error and updates the connection `lastError`.
- Older GitHub `coding.commit_created` events without `data.isPersonal=true` are treated as unverified activity, not personal progress.
- GitHub events use `source=github`, provider metadata, and external IDs for dedupe. Running the same sync twice should not create duplicate events.
- Duplicate GitHub connections are prevented for the same normalized repo list and same `author=LOGIN`. Same repo with a different author is allowed.
- Manual sync uses `/sync_integrations` or `/sync_integration CONNECTION_ID`.
- Automatic integration sync is disabled by default. Set `INTEGRATION_SYNC_ENABLED=true` on the worker to sync active integrations in the background.
- Automatic sync interval defaults to 15 minutes. Override with `INTEGRATION_SYNC_INTERVAL_MINUTES=15`.
- Scheduled sync skips paused, archived, and error integrations, and skips active integrations synced less than the configured interval ago.
- Scheduled sync supports active GitHub and Gmail integrations. Gmail sync skips connections with no active email rules.
- Scheduled sync sends Telegram only when new events are created or when a connection first enters an error state.

Gmail OAuth setup:

```bash
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret
GMAIL_REDIRECT_URI=http://localhost:3000/oauth/gmail/callback
```

Create a Google OAuth client with the redirect URI above and the readonly Gmail scope. Then run `/connect_gmail`, open the returned URL, complete consent, and enable scanning with `/enable_email_rule job_search`. The OAuth callback only displays `Gmail connected. You can return to Telegram.`

Integration Registry v1 manual test:

```bash
curl http://localhost:3000/integrations
curl http://localhost:3000/email-adapters

curl -X POST http://localhost:3000/users/dev-user/integrations/github-public \
  -H "Content-Type: application/json" \
  -d '{"repos":[{"owner":"vercel","repo":"next.js"}]}'

curl http://localhost:3000/users/dev-user/integrations

curl -X POST http://localhost:3000/users/dev-user/integrations/CONNECTION_ID/sync \
  -H "Content-Type: application/json" \
  -d '{}'

curl http://localhost:3000/users/dev-user/integrations/gmail/oauth-url

curl -X POST http://localhost:3000/users/dev-user/email-rules \
  -H "Content-Type: application/json" \
  -d '{"connectionId":"GMAIL_CONNECTION_ID","adapterId":"job_search_email","name":"Job search emails"}'
```

Telegram integration commands:

```text
/integrations
/my_integrations
/connect_github vercel/next.js
/connect_github letisfarre/alecto-ai author=letisfarre
/connect_gmail
/my_email_rules
/enable_email_rule job_search
/enable_email_rule job_search goal=GOAL_ID
/enable_email_rule work_action
/pause_email_rule RULE_ID
/resume_email_rule RULE_ID
/set_email_rule_config RULE_ID maxMessagesPerSync=10 maxEventsPerSync=3 classifierMode=rules
/set_email_rule_config RULE_ID classifierMode=hybrid
/set_email_rule_config RULE_ID classifierMode=llm
/set_email_rule_config RULE_ID fetchStrategy=all_recent lookbackDays=7
/delete_email_rule RULE_ID
/cleanup_gmail_rule_events RULE_ID
/email_reviews
/email_reviews all
/approve_email_review REVIEW_ID
/reject_email_review REVIEW_ID
/pause_integration CONNECTION_ID
/resume_integration CONNECTION_ID
/delete_integration CONNECTION_ID
/sync_integrations
/sync_integration CONNECTION_ID
/sync_gmail
/sync_gmail_debug
```

Manual insight tests:

- Normal progress day: log applications, workout, reading, and a stable check-in. `/insight` should show real wins and simple next actions.
- High-risk day: log sleep below 6h, anxiety 7+, gambling impulse 6+, or trigger a betting cooldown. `/insight` should include risks and hard guardian wording for direct/hard profiles.
- Low activity day: run `/insight` before logging events. It should say the signal is low and recommend one concrete action.
- Weekly summary: log events across multiple days, then run `/weekly`. It should aggregate applications, workouts, reading, sleep/anxiety/focus averages, cooldown count, check-ins, and consistency patterns.

## API Routes

- `GET /health`
- `GET /events/types`
- `GET /integrations`
- `GET /email-adapters`
- `GET /goal-templates`
- `GET /goal-templates/:templateId`
- `POST /messages/process`
- `GET /users/:userId/events`
- `GET /users/:userId/events/recent`
- `PATCH /users/:userId/events/:eventId/archive`
- `PATCH /users/:userId/events/groups/:eventGroupId/archive`
- `POST /users/:userId/events/:eventId/correct`
- `POST /users/:userId/events/undo-last`
- `GET /users/:userId/goals`
- `GET /users/:userId/profile`
- `PATCH /users/:userId/profile`
- `GET /users/:userId/memory`
- `POST /users/:userId/memory`
- `PATCH /users/:userId/memory/:memoryId/archive`
- `GET /users/:userId/notification-settings`
- `PATCH /users/:userId/notification-settings`
- `GET /users/:userId/pending-actions`
- `POST /users/:userId/pending-actions/:pendingActionId/confirm`
- `POST /users/:userId/pending-actions/:pendingActionId/reject`
- `POST /users/:userId/goals`
- `POST /users/:userId/goals/from-template`
- `POST /users/:userId/goals/custom-config`
- `POST /users/:userId/goals/:goalId/progress`
- `PATCH /users/:userId/goals/:goalId/archive`
- `POST /users/:userId/checkins/daily`
- `POST /users/:userId/checkins/daily/text`
- `GET /users/:userId/checkins/daily/prompt`
- `POST /users/:userId/ingest/text`
- `POST /users/:userId/ingest/job-search-text`
- `GET /users/:userId/integrations`
- `GET /users/:userId/integrations/gmail/oauth-url`
- `GET /oauth/gmail/callback`
- `POST /users/:userId/integrations/github-public`
- `PATCH /users/:userId/integrations/:connectionId`
- `DELETE /users/:userId/integrations/:connectionId`
- `POST /users/:userId/integrations/:connectionId/sync`
- `GET /users/:userId/email-rules`
- `POST /users/:userId/email-rules`
- `PATCH /users/:userId/email-rules/:ruleId`
- `DELETE /users/:userId/email-rules/:ruleId`
- `POST /users/:userId/email-rules/:ruleId/cleanup-events`
- `GET /users/:userId/review/daily`
- `GET /users/:userId/insights/daily`
- `GET /users/:userId/insights/daily?date=YYYY-MM-DD`
- `GET /users/:userId/insights/weekly`
- `GET /users/:userId/insights/weekly?weekStart=YYYY-MM-DD`

## Packages

- `packages/core`: shared domain types, Zod schemas, risk states, user operating profile, ingestion registry/adapters, and the initial event registry.
- `packages/llm`: optional OpenAI structured message analyzer plus analysis result schemas.
- `packages/db`: Prisma schema, client export, and repository functions for users, goals, and events.
- `apps/api`: Fastify API exposing health, event type, message processing, persisted event, and persisted goal routes.
- `apps/telegram-bot`: Telegram channel adapter that forwards messages to the API.

## Current Scope

This skeleton intentionally does not include UI, OpenClaw integration, WhatsApp, wallet/private-key functionality, or general app auth. Gmail has a minimal readonly OAuth flow for local MVP email ingestion.
