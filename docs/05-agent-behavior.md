# Agent Behavior

The user can talk to the agent about anything.

Status: implemented through channel-agnostic inbound routing, deterministic domain services, and a Telegram adapter. See `docs/07-implementation-status.md` for full status.

The agent should differentiate between:
- normal conversation
- emotional reflection
- event logging
- goal creation/update
- integration setup
- risk/guardian situations
- research requests
- coding/building help
- reviews

## Modes

- mirror: life reflection and thinking
- support: vulnerable moments
- guardian: betting/trading/impulse/risk
- builder: coding, projects, execution
- research: external/internal research
- fiscal: accountability and progress audit
- review: daily/weekly/monthly reviews

Modes can be selected manually but should usually be automatic.

Guardian mode has priority when high-risk financial or impulsive behavior is detected.

## Message handling rule

Not every message creates an event.
Not every event creates a memory.
Not every memory is a fact.

The agent must label inferred patterns as inferences, not facts.

## Current Routing Behavior

- [x] Slash commands are parsed as generic text commands, not Telegram-only core behavior.
- [x] Multi-line command batches execute supported commands line by line.
- [x] Pasted logs, code fences, Codex prompts, and debug output are treated as reference text and have no side effects.
- [x] Pending decision replies such as `yes`, `no`, `1`, or `second one` resolve before normal routing.
- [x] Guardrail/risk intent wins before action creation or generic chat.
- [x] Conversation-first surface routing maps natural operator requests to existing services: help/capabilities, setup state, daily operator brief, daily review, weekly review, this-week/next-week planning, action hygiene, goals, actions, memories, and integration guidance.
- [x] Onboarding/setup routing is conversation-first: `/start`, `/setup`, `help me set up`, `how do I start`, `what should I configure`, `what is missing`, `set up goals`, `how do reminders work`, `set up daily loop`, and `set up integrations` use shared API onboarding composers.
- [x] Explicit memory phrases create memory through the message processor.
- [x] Natural daily check-ins require state/progress signals.
- [x] Pasted job-search emails route through generic ingestion.
- [x] Conversational action control handles natural complete/reschedule/snooze/archive/priority requests.
- [x] Multi-intent orchestration can combine event logging, safe control actions, and read-only summaries.

## Current Operator Behaviors

- [x] `/today` gives a concise daily operator brief using actions, goals, events, risks, hygiene, weekly-review status, and optional validated LLM coach text.
- [x] `/start_day`, `/end_day`, and `/tomorrow` support the daily operating loop.
- [x] `/weekly` creates a saved weekly operator review memory.
- [x] `/plan_next_week` turns weekly review context into proposed next-week actions and waits for explicit create/skip/edit replies.
- [x] Natural planning phrases distinguish current-week requests (`plan this week`, `plan my week`) from next-week requests (`plan next week`) and ask clarification for ambiguous `make a plan` when there is no active plan/recent review context.
- [x] `/insight` and `/weekly_insight` provide interpretive coaching reports.
- [x] `/action_hygiene` asks the user to decide on stale/overdue tasks; it never archives automatically.
- [x] Natural phrases such as `what can you do`, `help me set up`, `what should I do today`, `review my week`, `plan this week`, `plan next week`, `clean up my tasks`, `show my goals`, and `connect Gmail` use the same underlying services as command shortcuts.
- [x] First 5 Minutes Onboarding v1 replies act like a guide: `/start` gives short natural examples, setup output separates Ready/Needs attention/Optional/Best next step, and goal/action/daily-loop/integration setup suggests one safe next step without command memorization.
- [x] `/debug_route`, `/debug_conversation_intent`, `/debug_daily_priorities`, `/debug_daily_coach`, `/debug_action_hygiene`, and `/debug_weekly_context` expose safe debugging views.

## Side-Effect Rule

The agent must not claim a mutation happened unless the service mutation succeeded.

Examples:
- Do not say an action was moved unless the ActionItem was updated in the database.
- Do not say an event was logged unless the Event exists.
- Do not say a memory was saved unless the MemoryEntry or pending confirmation exists.
- Do not create ActionItems for betting/trading requests; use guardian responses instead.

## Evidence rule

When making a strong claim, cite evidence from events, goals, memory or recent conversation.

Bad:
"You are avoiding work."

Good:
"I think you are avoiding work. Evidence: 0 applications in 8 days, 12h crypto Twitter, and you said applying feels boring."

## Deferred

- [ ] Monthly reviews
- [ ] Cross-channel UX beyond Telegram
- [ ] Rich dashboard/UI
- [ ] Vector-memory retrieval
