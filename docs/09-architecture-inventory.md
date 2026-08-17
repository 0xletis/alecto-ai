# Architecture Inventory

Last updated: 2026-08-18

This file is the current architecture handoff for humans and orchestrator agents. It is descriptive, not aspirational. If a capability is not marked as owned by Conversation Orchestrator v2 below, assume legacy routing still owns it until tests prove otherwise.

## Entry Points

- `apps/telegram-bot`: Telegram adapter. It converts Telegram updates into API calls and should stay thin. Core business logic must not depend on Telegram `ctx`, inline buttons, command menus, or hardcoded chat IDs.
- `POST /messages/process`: production natural-message entry point. It is v2-first when `CONVERSATION_ORCHESTRATOR_V2_ENABLED=true`; legacy routing remains the fallback for unmigrated scopes.
- `POST /messages/process_v2`: debug/audit entry point for Conversation Orchestrator v2 only. It does not fall through to legacy. If v2 cannot handle a message, it returns an explicit `not_migrated` reply and route debug.
- Domain API routes under `/users/:userId/...`: canonical mutation/read surfaces for goals, events, actions, email rules, reviews, integrations, daily loop, weekly review, planning, and debug views.
- `apps/worker`: proactive jobs for daily loop, reminders, integration sync, and Gmail background sync. It should call API/core services, not duplicate domain rules.

## Conversation Routing Order

Current production `/messages/process` order:

1. Parse request body and ensure user.
2. Expire stale pending decisions.
3. If v2 is enabled, ask Conversation Orchestrator v2 to handle migrated scopes.
4. Handle standalone `now` safely.
5. Run deterministic policy/guardrail precheck.
6. Resolve pending decisions before ordinary routing when the reply fits the pending scope.
7. Handle focused pending Gmail rule creation/editing.
8. Reject unresolved hygiene follow-ups without a visible context.
9. Route planning requests.
10. Route explicit memory requests.
11. Re-run guardrail check before surface routing.
12. Route deterministic conversation surfaces.
13. Route optional legacy LLM semantic router.
14. Try manual action creation.
15. Block unhandled mutation/control verbs from generic chat.
16. Route custom goal progress and structural proposals.
17. Optionally analyze with OpenAI and create extracted events.
18. Compose final response.

Current `/messages/process_v2` order:

1. Parse request body and ensure user.
2. Expire stale pending decisions.
3. Segment reference/log/example text and stop without side effects.
4. Run deterministic policy/guardrail precheck.
5. Build `ConversationContext`.
6. Build `AvailableOperations`.
7. Plan operations deterministically or with the optional LLM operation planner.
8. Validate operation plan deterministically.
9. Execute through deterministic API callbacks/services.
10. Compose response from actual execution results.
11. Return route debug.

## Route Ownership Map

Owned by Conversation Orchestrator v2 when enabled:

- Action hygiene list creation and visible-list replies.
- Single visible-item pronouns such as `it`.
- Multi-operation hygiene replies such as `archive all except the read one`.
- Recent mutation status questions.
- Explicit memory creation through operation plans.
- Selected read surfaces: today, operator attention, Gmail status, and email reviews.
- Conservative progress logging for CV/application and workout reports in English, Spanish, and Catalan.
- Reference-text safety and cross-domain visible-context safety.
- Policy/guardrail precedence for migrated scopes.

Still owned by legacy `/messages/process` routing:

- Most slash command behavior and command batching.
- Most Gmail rule creation/editing/removal conversations outside the migrated read/status surfaces.
- Planning sessions, weekly planning edits, and plan creation replies.
- Daily loop settings mutations.
- Most conversational action control outside hygiene-context replies.
- Generic chat/coaching fallback.
- Legacy LLM semantic routing for unmigrated natural-language surfaces.
- Event extraction and final response composition after legacy OpenAI analysis.

Route debug contract:

- `v2Enabled`
- `llmOperationPlannerEnabled`
- `plannerUsed`
- `llmPlannerAttempted`
- `llmPlannerUsed`
- `legacySemanticAttempted`
- `legacySemanticUsed`
- `v2SkippedReason`
- `handledBy`
- `mutationExecuted`
- `operationPlanValidated`
- `policyPrecheckResult`

`policyPrecheckResult` is safe and compact. Expected values include `passed`, `reference_text_blocked`, and `blocked_by_guardrail`.

## Server.ts Map

`apps/api/src/server.ts` remains oversized.

Current line count after this audit pass: 17,900 lines.

Known extracted modules:

- `apps/api/src/routes/messages.ts`: Fastify registration and validation for `/messages/process` and `/messages/process_v2`.
- `apps/api/src/conversation/context.ts`: short-lived context projection from pending decisions and visible lists.
- `apps/api/src/conversation/operation-catalog.ts`: allowed operation catalog for v2.
- `apps/api/src/conversation/operation-planner.ts`: deterministic planner and LLM planner bridge.
- `apps/api/src/conversation/operation-validator.ts`: deterministic validation before execution.
- `apps/api/src/conversation/operation-executor.ts`: deterministic operation executors using existing services/callbacks.
- `apps/api/src/conversation/response-composer.ts`: execution-result response composition.
- `apps/api/src/conversation/gmail-autonomy.ts`: Gmail setup/autonomy state formatting.
- `apps/api/src/conversation/email-rule-selection.ts`: Gmail rule target selection helpers.

High-density areas that still live in `server.ts`:

- Route registration for domain APIs.
- Telegram-facing text formatting.
- Gmail OAuth/sync/rule/review orchestration.
- Daily loop, action hygiene, planning, and weekly review composition.
- Legacy semantic routing and deterministic phrase routing.
- Callback glue for Conversation Orchestrator v2.

Recommended next extraction target:

1. Move conversation-facing Gmail rule and Gmail status handlers into `apps/api/src/conversation/gmail-rules.ts`.
2. Move action hygiene session creation/formatting into `apps/api/src/actions/hygiene.ts`.
3. Move planning session handlers into `apps/api/src/planning/`.
4. Move route registration for actions/goals/events/integrations into `apps/api/src/routes/` one surface at a time.

## Legacy And Split-Brain Risks

- V2 and legacy both understand some action/hygiene language. Tests currently protect visible-list hygiene ownership, but broader action control remains split.
- Gmail rule conversation state exists in legacy pending-action handlers while v2 can answer Gmail status/read surfaces. This can confuse follow-up pronouns unless the target surface is migrated deliberately.
- Legacy LLM semantic routing and v2 LLM operation planning are separate layers. The semantic router classifies intent; v2 planner proposes operation plans. Do not let both mutate the same message.
- Some worker and API surfaces share summaries but not always a single composer. Keep proactive messages concise and tested.
- Route debug is the guardrail against accidental silent fallback. New migrated scopes must prove `legacySemanticUsed=false` in tests.

## Potentially Obsolete Logic To Audit Later

Do not delete these without targeted tests:

- Legacy multi-intent orchestration for messages that v2 could eventually own.
- Legacy conversational action control for complete/reschedule/archive flows.
- Legacy Gmail semantic-router patches for custom rule follow-ups.
- Duplicate natural setup/help surfaces that overlap with v2 read operations.
- Old phrase-specific fixes for Spanish/Catalan Gmail rule edits once the v2 planner owns those operations.

## ConversationContext Audit

Current behavior:

- Uses existing `PendingAction` rows as short-lived context storage.
- Stores visible entities for action hygiene, email reviews, Gmail rule selection, recent mutation status, and other pending flows.
- V2 tests now enforce the invariant: if v2 renders a numbered visible list, the stored context must contain the same visible entities.
- Context is advisory only. It does not authorize Gmail scanning, event creation, action creation, or destructive changes without deterministic validation.

Known gaps:

- Context types are multiplexed through `PendingAction.payload`; there is no dedicated `ConversationContext` table.
- One pending context per user keeps v1 simple but can replace unrelated focus.
- Some legacy surfaces still create context with legacy labels. Route debug should expose `contextCreatedBy` only when context is actually loaded.

## LLM OperationPlanner Audit

Current behavior:

- Disabled by default.
- Enabled with `LLM_OPERATION_PLANNER_ENABLED=true`.
- Uses safe summarized context and an allowed operation catalog.
- LLM output is a proposal, not authority.
- Deterministic validation rejects unsupported operations, unsafe targets, low confidence, stale context, missing confirmation, and invalid fields.
- Deterministic executors perform all mutations.
- Failures, invalid JSON, timeouts, provider errors, and low confidence fall back to deterministic planning.

Current migrated operation families:

- `show_action_hygiene`
- hygiene replies and visible-list operations
- recent mutation status
- explicit memory
- selected read surfaces
- conservative progress logging

Not yet migrated:

- Full Gmail rule management.
- Planning-session edits/creation.
- Full action reschedule/complete/archive outside visible hygiene context.
- Daily loop settings.
- Generic chat/coaching.

## Risk And Guardrail Generalization Plan

Current implementation is betting/trading-heavy because that was the first real hard-stop domain. Keep the behavior, but generalize the architecture language:

- Rename product-facing concepts toward `policy guardrail`, `risk-control goal`, and `blocked action` where possible.
- Keep betting/trading as one policy domain, not the entire risk engine.
- Future domains can include health, spending, sleep, social media, or custom user-defined no-go rules.
- Do not create actions, plans, or Gmail rules that help bypass a hard guardrail.
- Do not let LLM advice optimize restricted behavior. It may support safe refusal or cooldown language only.

## Migration Rule

When moving a legacy surface into v2:

1. Add operation catalog entries.
2. Add deterministic validation.
3. Add deterministic executor callbacks.
4. Add routeDebug assertions proving `plannerUsed`, `mutationExecuted`, `operationPlanValidated`, and `legacySemanticUsed`.
5. Keep legacy fallback until tests prove parity.
6. Update `README.md`, `docs/01-system-architecture.md`, `docs/05-agent-behavior.md`, `docs/07-implementation-status.md`, and `docs/08-product-capability-audit.md`.
