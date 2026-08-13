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
- [x] Natural phrases such as `what can you do`, `help me set up`, `what should I do today`, `review my week`, `plan this week`, `plan next week`, `clean up my tasks`, `show my goals`, `connect Gmail`, `what email rules are on`, `que reglas de email tenemos activas`, `email reviews`, `correos pendientes`, `enable job search rule for Gmail`, `create a rule for Endesa bills`, `track Endesa bills from Gmail`, `crea una regla de Gmail para facturas de Aigues de Barcelona`, `looks for only Aigues de Barcelona instead of Endesa`, `busca solo Aigues de Barcelona, no Endesa`, `make that rule look for only Aigues de Barcelona instead of Endesa`, `pause it`, `quan m'avisareu dels correus d'Endesa?`, `when will you let me know about new emails?`, and `sync Gmail` use the same underlying services as command shortcuts.
- [x] Custom Gmail sender/keyword tracking is confirmation-first and review-only. The agent may propose a rule, but it must not scan Gmail before confirmation and must not auto-create Events or ActionItems from custom matches.
- [x] Email Review Inbox v1 is review-first and user-controlled. `email reviews`, `show Gmail reviews`, `what emails need review`, Spanish/Catalan pending-email phrases, and `/email_reviews` show grouped pending items with short-lived visible numbers in display order. Follow-ups such as `show 1`, `approve 1`, `reject 2`, `reject all the rest reviews from Endesa`, and `turn 3 into an action tomorrow` resolve only against that visible context and only mutate reviews that are still pending.
- [x] Gmail sync replies and scheduled sync notifications surface pending review work without dumping emails. Manual sync replies in-band; scheduled sync can send one bundled "Gmail reviews are waiting" notification when new review items are created.
- [x] Optional LLM semantic routing can catch normal user phrasing that deterministic rules miss across operator surfaces and Gmail rule conversations, especially English/Spanish/Catalan wording. It only returns structured intent; deterministic executors still apply or reject changes.
- [x] Pending and active Gmail custom-rule conversations keep short-lived state: the user can edit keywords, use replacement language such as `instead of`, `en vez de`, `en lloc de`, ask where matches go, ask when sync/notification happens, correct/remove a goal link, pause/resume the focused rule, cancel, or confirm without falling into generic coaching.
- [x] Ambiguous Gmail rule management asks and remembers a clarification. Example: `elimina Endesa` with `Endesa emails` and `Endesa bills` stores a pending rule-selection decision; `1`, `Endesa emails`, or `cancel` resolves it before generic routing, and removal still requires yes/no confirmation.
- [x] Multi-rule custom Gmail cleanup asks for confirmation instead of guessing. Example: `elimina Aigues de Barcelona y Endesa` resolves matched active custom rules and archives them only after `yes`.
- [x] Gmail rule list/reset phrasing is protected from action-control fallback. Examples: `what email rules do we have`, `delete all email rules`, and contextual `can u delete all of em?` after an email-rule list route to Gmail rule status/cleanup, not task archive matching.
- [x] Gmail timing/status questions are protected from broad custom-rule creation. Examples: `when do u check my gmail?`, `when do you check my mail`, `do you check Gmail automatically?`, and `will you notify me about emails?` explain manual sync, scheduled sync status, review-notification preference, review handling, and no Gmail webhooks.
- [x] Gmail Setup + Autonomy Preferences v1 keeps a structured Gmail setup state for conversation surfaces. Natural setup/status replies include connection status, account email when available, active/paused tracking, pending review count, manual-only vs scheduled mode, review notification preference, goal-linked recommendations, and the next safe step without exposing adapter IDs, tokens, encrypted envelopes, provider JSON, or raw email bodies.
- [x] Natural Gmail autonomy preference changes such as `check Gmail manually only`, `make Gmail manual only`, `check Gmail every hour`, `check Gmail every 2 hours`, `check Gmail daily`, `notify me when Gmail reviews are waiting`, `don't notify me about Gmail reviews`, and `turn off Gmail review notifications` require yes/no confirmation before the Gmail connection config is updated. Unrelated Gmail read-only questions release stale Gmail preference focus so a later generic `yes` does not mutate old settings. Daily digest and work-hours Gmail checks are recognized but answered as not implemented.
- [x] Gmail security/auth/account emails are hard-filtered before job-search classification or custom review creation. Security-code, verification-code, OTP, login, password-reset, 2FA, authentication, suspicious-login, device-login, and account-recovery emails do not become EmailReviewItems in v1.
- [x] Utility/bill Gmail tracking must not attach to unrelated active goals just because of a shared word. Example: Endesa electricity bills should not link to `Improve strength and energy` unless a real utility/expense goal exists.
- [x] First 5 Minutes Onboarding v1 replies act like a guide: `/start` gives short natural examples, setup output separates Ready/Needs attention/Optional/Best next step, and goal/action/daily-loop/integration setup suggests one safe next step without command memorization.
- [x] `/debug_route`, `/debug_conversation_intent`, `/debug_daily_priorities`, `/debug_daily_coach`, `/debug_action_hygiene`, and `/debug_weekly_context` expose safe debugging views.

## Side-Effect Rule

The agent must not claim a mutation happened unless the service mutation succeeded.

Examples:
- Do not say an action was moved unless the ActionItem was updated in the database.
- Do not say an event was logged unless the Event exists.
- Do not say a memory was saved unless the MemoryEntry or pending confirmation exists.
- Do not create ActionItems for betting/trading requests; use guardian responses instead.
- Do not answer Gmail setup questions as if a mutation happened. Questions about a rule should explain status, filters, goal link, review behavior, and sync behavior.
- Do not claim Gmail background checks are active unless both the user preference and worker runtime allow scheduled sync. If the preference is saved but local worker sync is disabled, say so plainly and keep manual `sync Gmail` available.
- Do not keep a Gmail preference confirmation alive after the user moves on to another Gmail question. Let the question answer normally and require the user to ask for the preference change again.
- Do not treat Gmail rule context as permission to scan or auto-log. It only helps resolve references like `it` or `that rule`; normal Gmail rules still require explicit creation/confirmation and manual or scheduled sync.
- Do not treat email review visible numbers as permanent IDs. They are short-lived context from the last inbox display, and expired context must ask the user to run `email reviews` again.
- Do not bulk-approve or bulk-reject email review items from stale visible context without checking current DB status. Already approved, rejected, or action-converted reviews must be reported as already handled, not mutated again.
- Do not create Events or ActionItems from custom Gmail reviews unless the user explicitly approves a supported outcome or asks to turn a specific visible review into an action.

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
