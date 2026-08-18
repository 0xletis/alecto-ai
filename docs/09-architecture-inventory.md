# Architecture Inventory

Last updated: 2026-08-18

This file is the current architecture handoff for humans and orchestrator agents. It is descriptive, not aspirational. If a capability is not marked as owned by Conversation Orchestrator v2 below, assume legacy routing still owns it until tests prove otherwise.

## Entry Points

- `apps/telegram-bot`: Telegram adapter. It converts Telegram updates into API calls and should stay thin. Core business logic must not depend on Telegram `ctx`, inline buttons, command menus, or hardcoded chat IDs.
- `POST /agent/message`: **the default runtime for normal Telegram chat** (`apps/api/src/agent-runtime/`), isolated from the `/messages/process` routing order below. `apps/telegram-bot` routes all normal (non-command) text here unless `TELEGRAM_AGENT_RUNTIME_V3_ENABLED=false` explicitly opts back into legacy (`routeToLegacyMessageProcessor` in `apps/telegram-bot/src/index.ts`); slash commands and Gmail OAuth/setup/sync flows are unaffected either way. Session state (topic, pending confirmation, visible entities, recent mutations, bounded message history) is persisted per `userId`+`channel` in the `AgentConversationSession` table with a sliding 24h TTL — it survives an API restart; an expired session is treated as missing. **New conversation/product work goes here, not into the legacy pipeline below.** See `apps/api/src/agent-runtime/session-store.ts`, `apps/telegram-bot/src/agent-runtime-routing.ts`, the README's "Agent Runtime v3" section, and "Legacy conversation stack to remove or isolate" below.
- `POST /messages/process`: **legacy** natural-message entry point for normal conversation. Still the production path for the explicit `TELEGRAM_AGENT_RUNTIME_V3_ENABLED=false` opt-out and for direct API callers. It is v2-first when `CONVERSATION_ORCHESTRATOR_V2_ENABLED=true`; legacy routing remains the fallback for unmigrated scopes. Not removed yet — see the legacy inventory below for what's still needed and what isn't.
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

Current line count after this audit pass: 17,293 lines. History: 17,903 (start) → 17,440 (type-extraction pass) → 17,380 (phase 1: memory + notification-settings routes) → 17,293 (phase 2: checkins-prompt/ingest routes + isRecord de-duplication — see below).

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
- `apps/api/src/server-types.ts`: 39 pure type/interface declarations extracted from server.ts's private helper zone — daily-brief/operator-attention, weekly review, action hygiene, next-week planning, daily coach, and Gmail/GitHub sync shapes. Zero behavior change (types are erased at compile time); `sanitizeActionItem`, `buildConversationControlDebugForUser`, and `PlanWindowKind` were exported from server.ts (previously private) purely so this file can reference them in `typeof`/`ReturnType` positions. −463 net lines in server.ts.
- `apps/api/src/routes/memory.ts` (new, server cleanup phase 1): the three `/users/:userId/memory*` routes (list/create/archive), moved verbatim. Zero server.ts-private helper dependencies, so zero circular-import risk. Registered via `registerMemoryRoutes(server)`.
- `apps/api/src/routes/notification-settings.ts` (server cleanup phase 1): the two `/users/:userId/notification-settings` routes (get-or-create/update), moved verbatim. Same zero-dependency, zero-circular-import profile. Registered via `registerNotificationSettingsRoutes(server)`.
- −60 net lines in server.ts from phase 1 (43 + 19 lines of route code removed, 2 lines of unused schema imports removed, 4 lines of import/register calls added).
- `apps/api/src/routes/checkins-ingest.ts` (new, server cleanup phase 2): `GET /users/:userId/checkins/daily/prompt`, `POST /users/:userId/ingest/text`, `POST /users/:userId/ingest/job-search-text`, moved verbatim along with their two exclusively-used private helpers (`ingestText`, `composeIngestionReply`, confirmed to have no other call sites in server.ts before moving). Registered via `registerCheckinsIngestRoutes(server)`.
- `apps/api/src/utils/records.ts` (new, server cleanup phase 2): `isRecord`, a dependency-free type guard that was defined once privately in server.ts and called 53 times there. Moved so `routes/checkins-ingest.ts` (which also needs it) doesn't have to import it back from server.ts — that would have been the circular import this whole extraction pass exists to avoid. All 53 existing call sites in server.ts needed no changes (same `isRecord(...)` call syntax, now resolved via import instead of local definition). Note: four other files (`apps/api/src/conversation/*.ts`, `apps/api/src/agent-runtime/session-store.ts`) have their own independent, identical private copy of this same check — left alone, out of scope for this pass since touching them isn't needed for safety here and would mean editing Agent Runtime v3 source.
- −87 net lines in server.ts from phase 2.

High-density areas that still live in `server.ts`:

- Route registration for domain APIs (actions, goals, events, Gmail OAuth/sync/rules/reviews, daily loop, weekly review, planning, insights, conversation-control — everything except memory and notification-settings now).
- Telegram-facing text formatting.
- Gmail OAuth/sync/rule/review orchestration.
- Daily loop, action hygiene, planning, and weekly review composition.
- Legacy semantic routing and deterministic phrase routing.
- Callback glue for Conversation Orchestrator v2.
- The inline `/messages/process`/`/messages/process_v2` handler bodies passed into `registerMessageRoutes(...)` (route registration itself is in `routes/messages.ts`, but the callbacks still live in server.ts and depend on 10+ private helpers plus the legacy semantic/deterministic-surface routers directly — confirmed high risk to extract without a circular import back into server.ts; left in place).

Recommended next extraction target (in safety order, re-verified during the phase-2 pass):

1. `insights` (5 local deps: `addDays`, `maybePolishInsight`, `parseDateStart`, `startOfLastSevenDays`, `startOfToday`) and `pending-actions` (2 deps: `applyPendingAction`, `findPendingAction`) route groups — low dependency count, no Gmail/legacy-routing entanglement confirmed. Verify each helper's other call sites the same way this pass did for `ingestText`/`composeIngestionReply`/`isRecord` before moving.
2. Move conversation-facing Gmail rule and Gmail status handlers into `apps/api/src/conversation/gmail-rules.ts` — confirmed Gmail-tangled (OAuth token exchange, Gmail API calls), higher risk, do only with dedicated time.
3. Move action hygiene session creation/formatting into `apps/api/src/actions/hygiene.ts` — 14+ local helper deps including Telegram-facing reply formatters; do only with dedicated time and by moving the formatters too (not leaving them behind, which would force a circular import).
4. Move planning session handlers into `apps/api/src/planning/`.
5. The `/messages/process` inline handler bodies are the least safe candidate in the file (10+ deps, direct calls into the legacy semantic/deterministic-surface routers) — do not attempt without a dedicated, carefully-scoped pass.

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

## Legacy Conversation Stack To Remove Or Isolate

Now that Agent Runtime v3 is the default Telegram normal-chat runtime, this is the working inventory of what the old stack still owns. Do not delete any of these without targeted tests proving the replacement has parity — "no test currently fails" is not proof a path is dead, only that nothing exercises it yet.

**`/messages/process` (legacy normal-message path)**
- Still needed: yes.
- Reason: it's the live target of the explicit `TELEGRAM_AGENT_RUNTIME_V3_ENABLED=false` opt-out, and the only path for direct API callers who haven't moved to `/agent/message`. It also still owns scopes v3 doesn't have tools for yet (planning sessions, daily loop settings, full Gmail rule management — see "Not yet migrated" above).
- Safe deletion conditions: v3 has a tool/flow for every scope in "Still owned by legacy `/messages/process` routing" above, with tests proving parity; the Telegram legacy opt-out is itself deprecated; no direct API callers remain.
- Replacement in v3: `POST /agent/message` (already the default).

**Deterministic surface router** (`handleConversationSurfaceIntent`/`detectConversationSurfaceIntent`, inline in `server.ts`)
- Still needed: yes.
- Reason: still runs as step 12 of `/messages/process`'s routing order for every legacy-path message; not migrated to v3's tool catalog.
- Safe deletion conditions: only reachable once `/messages/process` itself is safe to delete (see above), or once every surface it currently routes is independently ported into v3's tool catalog with test parity.
- Replacement in v3: conceptually, the validator+executor pattern (`apps/api/src/agent-runtime/{validator,executor}.ts`) — but coverage isn't 1:1 yet.

**Legacy semantic router** (LLM-based intent classification, inline in `server.ts`)
- Still needed: yes.
- Reason: still owns "Legacy LLM semantic routing for unmigrated natural-language surfaces" (generic chat/coaching fallback and anything outside v3's ~22-tool catalog).
- Safe deletion conditions: v3's planner + tool catalog covers generic chat/coaching and every surface this router currently classifies, with tests proving `legacySemanticUsed=false` for those scopes.
- Replacement in v3: `apps/api/src/agent-runtime/planner.ts` (the LLM operation planner) is the architectural replacement, but its tool catalog is narrower today.

**`/conversation/control`**
- Still needed: yes.
- Reason: called directly by the legacy Telegram pipeline (`routeToLegacyMessageProcessor` in `apps/telegram-bot/src/index.ts`), not just internally by `/messages/process`.
- Safe deletion conditions: once the legacy Telegram pipeline is itself removed and no other direct callers remain.
- Replacement in v3: the pending-operation confirm/cancel firewall (`runtime.ts`) plus the tool catalog cover the same "resolve a pending decision" concept generically.

**Old action hygiene parser**
- Still needed: yes.
- Reason: owns bulk/multi-item hygiene language ("archive all except the read one", numbered visible-list batches) that v3 has no equivalent for — v3's `action.*` tools are single-item only (list/create/snooze/complete/archive, with "it" resolved only when exactly one action is visible).
- Safe deletion conditions: v3 gains bulk/multi-item action operations with the same safety guarantees (visible-list numbering, all-except selection), proven by tests equivalent to the current hygiene test coverage.
- Replacement in v3: partial only — `action.list` + single-entity "it" resolution in `validator.ts`, not a full replacement.

**Old Gmail natural conversation handlers**
- Still needed: yes.
- Reason: legacy still owns rule editing, rule removal, built-in rule (job-search/work-action) toggling, and Gmail autonomy-preference conversations. v3 only has `gmail.rule.create` (custom, review-first), `gmail.rule.list`, `gmail.rule.explain`, and `gmail.review.{list,reject,to_action}`.
- Safe deletion conditions: v3's tool catalog gains rule editing/removal/toggle/autonomy-preference tools with test parity against the current natural-language Gmail conversation tests.
- Replacement in v3: partial — creation and read-only status/review flows only.

**Old Conversation Orchestrator v2 paths**
- Still needed: unknown.
- Reason: v2 (`apps/api/src/conversation/*`) still owns several scopes on paper (hygiene lists, single-item pronouns, recent mutation status, explicit memory, selected read surfaces, conservative progress logging) — but v3 now independently re-implements memory, progress logging, and read surfaces for Telegram's default path. Since v2 is only reached via `/messages/process` (when `CONVERSATION_ORCHESTRATOR_V2_ENABLED=true`), which itself is now only hit by the legacy opt-out or direct API callers, v2's real-world traffic share for the primary product experience is unclear without a dedicated usage audit.
- Safe deletion conditions: confirm (via logs/telemetry, not just "no test fails") that production traffic no longer reaches v2; or explicitly deprecate `/messages/process_v2` and the v2-first branch of `/messages/process` first, then remove once every migrated scope has v3 (or legacy) coverage with equal or better tests.
- Replacement in v3: overlapping already, for the scopes v3 independently reimplemented (memory, progress logging, read surfaces).

**Old tests that only protect deprecated behavior**
- Still needed: unknown, depends per-file.
- Reason: e.g. `tests/conversation-orchestrator-v2.test.ts` protects v2 behavior that may become effectively unreachable once v3 is the Telegram default — but keeping it is cheap insurance if v2 is still reachable (legacy flag / API), and expensive maintenance if v2 is truly dead.
- Safe deletion conditions: only once the underlying production code path is itself confirmed unreachable and removed. A passing test suite with no failures is not evidence a path is dead — it only means nothing currently exercises the risk.
- Replacement in v3: `tests/agent-message.test.ts`, `tests/agent-runtime-*.test.ts`, and `tests/telegram-agent-runtime-routing.test.ts` already cover the v3-equivalent behavior for scopes v3 owns.

## Migration Rule

When moving a legacy surface into v2:

1. Add operation catalog entries.
2. Add deterministic validation.
3. Add deterministic executor callbacks.
4. Add routeDebug assertions proving `plannerUsed`, `mutationExecuted`, `operationPlanValidated`, and `legacySemanticUsed`.
5. Keep legacy fallback until tests prove parity.
6. Update `README.md`, `docs/01-system-architecture.md`, `docs/05-agent-behavior.md`, `docs/07-implementation-status.md`, and `docs/08-product-capability-audit.md`.
