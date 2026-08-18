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

Current line count after this audit pass: 17,172 lines. History: 17,903 (start) → 17,440 (type-extraction pass) → 17,380 (phase 1: memory + notification-settings routes) → 17,293 (phase 2: checkins-prompt/ingest routes + isRecord de-duplication) → 17,172 (phase 3: insights routes + shouldUseOpenAIAnalysis de-duplication — see below).

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
- `apps/api/src/routes/insights.ts` (new, server cleanup phase 3): `GET /users/:userId/insights/daily`, `GET /users/:userId/insights/weekly`, moved verbatim along with their exclusively-used private helpers (`maybePolishInsight`, `isDirectInsightProfile`, `startOfToday`, `startOfLastSevenDays`, `parseDateStart`, `addDays` — each confirmed via grep to have no other call sites in server.ts before moving). Registered via `registerInsightRoutes(server)`.
- `apps/api/src/utils/env.ts` (new, server cleanup phase 3): `shouldUseOpenAIAnalysis`, a dependency-free env-var check that was defined once privately in server.ts and called from 3 places — the two insights routes (via `maybePolishInsight`) plus two unrelated legacy semantic-analysis call sites that stay in server.ts. Moved for the same reason `isRecord` moved in phase 2: `routes/insights.ts` needs it, and giving it a shared home avoids a circular import back into server.ts. The 2 remaining call sites in server.ts needed no changes, only the import source changed.
- `pending-actions` (`GET /users/:userId/pending-actions`, `POST .../confirm`, `POST .../reject`) was inspected and **not extracted this pass** — see "Why pending-actions was skipped" below.
- −121 net lines in server.ts from phase 3.

Why pending-actions was skipped in phase 3: `GET /pending-actions` and `POST .../reject` are themselves trivial (only call already-imported `@operator-agent/db` functions), and `POST .../confirm`'s own lookup helper `findPendingAction` is small and exclusively used by that one route. But `POST .../confirm` also calls `applyPendingAction`, a ~345-line function (`server.ts` around line 16572 pre-phase-3) that switches on every pending-action type and reaches directly into Gmail rule management (`archiveEmailSignalRule`, `createEmailSignalRule`, `writeGmailAutonomyPreferences`, `buildGmailAutonomyState`) and action-hygiene batch operations (`applyActionHygieneBatchOperations`) — both of which are the two next items already flagged below as high-risk, dedicated-pass-only extractions. `applyPendingAction` is also called from deep inside the legacy `/messages/process` conversational confirmation flow (the "say yes to confirm" path), not just from this HTTP route, so it is not exclusively used by the pending-actions route group. Moving it would mean either extracting the Gmail-rules and action-hygiene tangles at the same time (a materially bigger, higher-risk change than this pass's scope) or leaving it in server.ts and importing it into the new route module, which is exactly the circular import this whole effort exists to avoid. Per this task's explicit "do not force extraction if risk is high" instruction, the pending-actions route group was left in place untouched.

High-density areas that still live in `server.ts`:

- Route registration for domain APIs (actions, goals, events, Gmail OAuth/sync/rules/reviews, daily loop, weekly review, planning, insights, conversation-control — everything except memory and notification-settings now).
- Telegram-facing text formatting.
- Gmail OAuth/sync/rule/review orchestration.
- Daily loop, action hygiene, planning, and weekly review composition.
- Legacy semantic routing and deterministic phrase routing.
- Callback glue for Conversation Orchestrator v2.
- The inline `/messages/process`/`/messages/process_v2` handler bodies passed into `registerMessageRoutes(...)` (route registration itself is in `routes/messages.ts`, but the callbacks still live in server.ts and depend on 10+ private helpers plus the legacy semantic/deterministic-surface routers directly — confirmed high risk to extract without a circular import back into server.ts; left in place).

Recommended next extraction target (in safety order, re-verified during the phase-3 pass):

1. `pending-actions` route group is only safe to extract as part of the same dedicated pass as items 2 and 3 below: its `confirm` route's only risky dependency, `applyPendingAction`, is itself the Gmail-rules/action-hygiene tangle described in "Why pending-actions was skipped" above. Doing items 2+3 first (moving Gmail rule handling and action-hygiene batch operations out of server.ts) would leave `applyPendingAction` with a clean, already-extracted set of dependencies to call into, at which point `pending-actions` becomes a safe, low-risk follow-up.
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

**`/conversation/control`** (and its sibling `/conversation/multi-intent`)
- Still needed: yes.
- Reason: called directly by the legacy Telegram pipeline (`routeToLegacyMessageProcessor` in `apps/telegram-bot/src/index.ts`, opt-out only) — but also, independent of the v3/legacy flag, by two debug slash commands: `/debug_conversation_intent` (`apps/telegram-bot/src/index.ts:172`, `dryRun: true`) and `/debug_intent_plan` (`apps/telegram-bot/src/index.ts:196`, `dryRun: true`, hits `/conversation/multi-intent`). Both are gated by `guardDebugAllowedUser`, not `guardAllowedUser`, and never mutate (dry-run only), but they mean these two routes are reachable in v3-default production today, just not from ordinary chat.
- Safe deletion conditions: once the legacy Telegram pipeline is itself removed, no other direct callers remain, and the two debug slash commands are either removed or repointed at a v3-native debug surface.
- Replacement in v3: the pending-operation confirm/cancel firewall (`runtime.ts`) plus the tool catalog cover the same "resolve a pending decision" concept generically; there's no v3-native equivalent to the dry-run intent-plan debug commands yet.

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

**Pending-actions confirmation flow** (`GET/POST /users/:userId/pending-actions*`, `applyPendingAction`, `findPendingAction`)
- Still needed: yes — this is the least "legacy" item in this list.
- Reason: unlike everything else above, this is reached **directly and unconditionally** by three Telegram slash commands regardless of the v3/legacy flag: `/pending` (`apps/telegram-bot/src/index.ts:1929`), `/confirm` (`:1942`, calls `POST .../confirm` → `applyPendingAction`), and `/cancel` (`:1965`, calls `POST .../reject`). It's also called internally from `/messages/process`'s confirmation-message branch (`resolvePendingDecisionReply`). `applyPendingAction` itself (~345 lines, `server.ts`) is the function server cleanup phase 3 declined to extract because it reaches into Gmail rule management and action-hygiene batch operations — see that phase's entry above.
- Safe deletion conditions: none apply — this is core product surface, not a deletion candidate. It only becomes lower-risk to refactor once the Gmail-rules and action-hygiene extractions it depends on are done first (same ordering already recommended in the Server.ts Map section).
- Replacement in v3: v3 has its own independent `confirmation.confirm`/`confirmation.cancel` tools and session-based pending-plan state (`agent-runtime/session-store.ts`) — a parallel mechanism, not built on the legacy `PendingAction` table. **Cross-system risk, not yet resolved:** v3's context loader and planner never read the legacy `PendingAction` table (confirmed: zero references to `PendingAction`/`pendingAction` anywhere under `apps/api/src/agent-runtime/`). So if a user starts a legacy-session flow that leaves a `PendingAction` row — e.g. running `/action_hygiene`, which still hits `GET /users/:userId/actions/hygiene` directly — and then replies in plain natural language (no slash command) instead of running `/confirm`, that reply now goes to `routeToAgentRuntimeV3` (v3 is the Telegram default), which has no awareness of the pending hygiene session and will not resolve it. The row sits until `expireOldPendingActions` clears it. This is a real product-behavior gap worth a deliberate decision (teach v3 about legacy `PendingAction` rows, or make `/action_hygiene` itself v3-native), not something to silently patch inside an audit-only pass.

**Old tests that only protect deprecated behavior**
- Still needed: unknown, depends per-file.
- Reason: e.g. `tests/conversation-orchestrator-v2.test.ts` protects v2 behavior that may become effectively unreachable once v3 is the Telegram default — but keeping it is cheap insurance if v2 is still reachable (legacy flag / API), and expensive maintenance if v2 is truly dead.
- Safe deletion conditions: only once the underlying production code path is itself confirmed unreachable and removed. A passing test suite with no failures is not evidence a path is dead — it only means nothing currently exercises the risk.
- Replacement in v3: `tests/agent-message.test.ts`, `tests/agent-runtime-*.test.ts`, and `tests/telegram-agent-runtime-routing.test.ts` already cover the v3-equivalent behavior for scopes v3 owns.

### Legacy Usage Audit — Deletion-Readiness Pass (2026-08-18)

Grep/reference-verified pass answering: with v3 as the Telegram default, which old conversation systems are still reachable, and from where? Evidence commands used: `rg "messages/process"`, `rg "conversation_orchestrator"`, `rg "process_v2"`, `rg "conversation/control"`, `rg "action_hygiene"`, `rg "routeToLegacyMessageProcessor"`, `rg "handleSemanticRouterIntent\("`, plus direct reads of `apps/telegram-bot/src/index.ts` call sites and `apps/api/src/agent-runtime/{executor,tool-catalog,planner}.ts` for v3-side overlap.

**Legacy stack map**

| # | System | Files / functions | Direct callers (evidence) | Reachable from v3-default Telegram normal chat? | Reachable from slash commands? | Tests-only? | `/messages/process`-only? | v3 replacement | Verdict | Safe deletion conditions |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `/messages/process` | `apps/api/src/routes/messages.ts` (registration); handler body `server.ts:308-608` | `apps/telegram-bot/src/index.ts:55` (pending-reply+command-batch middleware, unconditional), `:136` (`/help`), `:2054` (`routeToLegacyMessageProcessor`, opt-out only), `:3818` (`createManualActionFromCommand`, guardrail/risk-flagged manual-action commands) | No, not directly (`message:text` goes to v3 by default) | Yes — `/help` always; `/todo`, `/add_action`, `/action` etc. when the deterministic router flags the text as guardrail/risk; combined pending-reply+command text | No — live production callers exist | No | `POST /agent/message` | **KEEP** | v3 has tool/flow parity for every scope in "Not yet migrated," the legacy Telegram opt-out is itself deprecated, and no direct API callers remain |
| 2 | Deterministic surface router | `handleConversationSurfaceIntent` (`server.ts:5577-5756`), `detectConversationSurfaceIntent` (`:8564-8755`) | Both have exactly 1 call site, inside `/messages/process`'s `process` handler only (not `process_v2`) | Same as #1, transitively | Same as #1, transitively | No | Yes, effectively | `agent-runtime/{validator,executor}.ts` (not 1:1) | **KEEP** | Only becomes reachable to delete once #1 is safe to delete |
| 3 | Legacy semantic router | `handleSemanticRouterIntent` (`server.ts:6935`) + ~20-function cluster (`:6427-8560`, Gmail rule proposal/edit/create, autonomy-preference conversation) | 2 call sites, both inside `/messages/process`'s `process` handler (`:403` pending-Gmail focus, `:471` main dispatch) — confirmed via `rg "handleSemanticRouterIntent\("` repo-wide | Same as #1, transitively | Same as #1, transitively | No | Yes, effectively | `agent-runtime/planner.ts` (narrower tool catalog) | **KEEP / MIGRATE-FIRST** | v3's planner+catalog covers generic chat/coaching and every surface this router classifies, with tests proving `legacySemanticUsed=false` |
| 4a | Conversation Orchestrator v2 (logic) | `apps/api/src/conversation/orchestrator-v2.ts` + `operation-{catalog,planner,validator,executor}.ts`, `response-composer.ts` | Called from `/messages/process`'s `process` handler only when `CONVERSATION_ORCHESTRATOR_V2_ENABLED=true` (default **off**) — `server.ts:354` | No | No (indirect only, behind an off-by-default flag) | Partially — `tests/conversation-orchestrator-v2.test.ts` is its main coverage | No (also called by `process_v2`) | Overlaps v3 for memory/progress-logging/read-surfaces it independently reimplemented | **UNKNOWN / MIGRATE-FIRST** | Confirm via logs/telemetry (not test results) that no production traffic sets the flag; then evaluate scope-by-scope |
| 4b | `/messages/process_v2` route | `routes/messages.ts:9-13,29-39`; unconditional call at `server.ts:308-314` | Zero matches in `apps/telegram-bot/` or `apps/worker/` — confirmed via `rg "process_v2"` across both dirs | No | No | **Yes** — only `tests/conversation-orchestrator-v2.test.ts` (2 references) calls this route | N/A (it's the alternative to `/messages/process`) | N/A — it's explicitly a debug/audit endpoint per its own `messageRouteOwnership` doc comment | **DELETE-NOW CANDIDATE** (pending product sign-off — it's *intentional* debug tooling, not accidental dead code) | Confirm with the team that the debug endpoint is no longer wanted, then delete the route + update `messageRouteOwnership` + retire/rewrite its test file |
| 5 | `/conversation/control`, `/conversation/multi-intent` | `server.ts:1206` (control), `:1232` (multi-intent) | `index.ts:2043`/`:2011` (`routeToLegacyMessageProcessor`, opt-out only); `index.ts:172` (`/debug_conversation_intent`, dry-run), `index.ts:196` (`/debug_intent_plan`, dry-run) — both debug-gated (`guardDebugAllowedUser`) | No (ordinary chat never hits these directly) | Yes — two debug-only, non-mutating slash commands | No | No | Pending-op confirm/cancel firewall in `runtime.ts` (conceptual, not 1:1) | **KEEP** | Legacy Telegram pipeline removed, no other callers, debug commands repointed or removed |
| 6 | Old action-hygiene NL parser | `parseActionHygieneReply` (`:16315`), `resolveActionHygieneReply` (`:15462`), `normalizeHygieneBatchText`, `applyActionHygieneBatchOperations`, ~25 functions total (`:2631-16800`ish) | `resolveActionHygieneReply` is called only from `resolvePendingDecisionReply`, itself only inside `/messages/process`'s `process` handler | Same as #1, transitively — **but see the cross-system risk noted under "Pending-actions confirmation flow" above**: a plain-text hygiene reply with v3 as default now goes to v3, not here | Same as #1, transitively (pending-reply+command-batch text) | No | Yes, effectively | `action.list` + single-entity "it" resolution only (no bulk/multi-item, no numbered-list resolution) | **KEEP** | v3 gains bulk/multi-item action operations with equivalent safety guarantees, proven by tests matching current hygiene coverage |
| 7 | Old Gmail NL handlers | Same cluster as #3: `buildCustomGmailRuleProposal`, `editPendingCustomGmailRule`, `editActiveCustomGmailRuleForConversation`, `manageCustomGmailRuleForConversation`, `answerGmailRuleQuestionForConversation` (dispatch at `:7223-7257`) | Reached only via `handleSemanticRouterIntent` (see #3) | Same as #3 | Same as #3 | No | Yes, effectively | `gmail.rule.{create,list,explain}`, `gmail.review.{list,reject,to_action}` (creation + read-only only) | **KEEP / MIGRATE-FIRST** | v3 tool catalog gains rule editing/removal/toggle/autonomy-preference tools with test parity |
| 8 | Pending-actions confirmation flow | `server.ts:994-1041` (routes), `applyPendingAction` (~345 lines), `findPendingAction` | `index.ts:1929` (`/pending`), `:1942` (`/confirm`), `:1965` (`/cancel`) — **all three unconditional**, independent of the v3/legacy flag; also called internally from `/messages/process` | Only indirectly, via the confirmation-message branch of `resolvePendingDecisionReply` | **Yes, directly** — `/pending`, `/confirm`, `/cancel` always live | No | No | v3's own `confirmation.confirm`/`confirmation.cancel` tools + session-store state — a parallel, non-integrated mechanism | **KEEP** | Not a deletion candidate; see cross-system risk note above for the actual open question here |
| 9 | Old tests protecting deprecated/opt-in-off behavior | `tests/conversation-orchestrator-v2.test.ts` (1,406 lines, ~40 tests) | Exercises `/messages/process_v2` and the `CONVERSATION_ORCHESTRATOR_V2_ENABLED=true` branch of `/messages/process` | N/A (test file) | N/A | **Yes** — protects a route with zero production callers and a flag that defaults off | N/A | `tests/agent-message.test.ts`, `tests/agent-runtime-*.test.ts`, `tests/telegram-agent-runtime-routing.test.ts` | **REWRITE/TRIM LATER** | Once #4a/#4b are resolved (deleted or formally kept), right-size this file to match |
| 10 | `tests/email-review-dedupe.test.ts` (11,492 lines, 128 tests) | Direct HTTP tests against `/messages/process`, `/conversation/control`, Gmail semantic-router flows, action-hygiene flows | Hits the API layer directly, bypassing the Telegram v3/legacy flag entirely | N/A (test file) | N/A | Mostly no — most of what it covers is still reachable per rows 1, 3, 6, 7, 8 above (via `/help`, guardrail-flagged commands, debug commands, `/confirm`) | Partially | Same as above per-scope | **KEEP AS-IS** | Do not touch; despite testing "legacy" code, it protects genuinely live production paths |

**Delete-now candidates**
- None recommended for actual deletion in this pass (per instructions: audit only). The one concrete, low-risk candidate is **`/messages/process_v2`** (row 4b): zero production callers anywhere in `apps/telegram-bot` or `apps/worker`, test-only, and already self-documented as "debug-only" in `messageRouteOwnership`. Recommend confirming with the team that the debug tooling is no longer wanted before removing the route, its `processV2` handler branch in `server.ts`, and rewriting/retiring the ~40 tests in `tests/conversation-orchestrator-v2.test.ts` that depend on it.

**Migrate-first candidates** (build v3 parity before touching the legacy code)
- Legacy semantic router / old Gmail NL handlers (#3, #7): v3 needs rule editing/removal/toggle/autonomy-preference tools.
- Old action-hygiene NL parser (#6): v3 needs bulk/multi-item action operations with visible-list numbering and all-except selection.
- Conversation Orchestrator v2 (#4a): needs a telemetry-based (not test-based) confirmation that the opt-in flag carries zero production traffic before any deletion decision.

**Keep-for-slash-command candidates** (still directly wired to live, non-debug slash commands — do not touch without also updating the bot)
- `/messages/process` (#1) — `/help`, guardrail-flagged action-creation commands, pending-reply+command-batch text.
- Pending-actions confirmation flow (#8) — `/pending`, `/confirm`, `/cancel`.
- `/conversation/control` + `/conversation/multi-intent` (#5) — kept alive by debug-only commands (`/debug_conversation_intent`, `/debug_intent_plan`), lower priority than the two above since they're read-only debug tooling, not core product flow.

**Tests that should be rewritten or removed later**
- `tests/conversation-orchestrator-v2.test.ts` — once `/messages/process_v2`'s fate (row 4b) is decided.
- No other test file in `tests/*.test.ts` was found to protect exclusively-dead behavior; `tests/email-review-dedupe.test.ts` in particular should NOT be touched (row 10).

**Exact next safe cleanup PR/pass**
1. Product decision (not a code change): confirm whether `/messages/process_v2` debug tooling is still wanted. If not, that's the single lowest-risk deletion in this entire audit — one route, one branch, one test file, zero production callers.
2. Separately from deletion: decide how to close the cross-system gap flagged under "Pending-actions confirmation flow" — a legacy `PendingAction` row (e.g. from `/action_hygiene`) left pending when a user replies in plain natural language now silently falls through to v3, which doesn't know about it. This is a correctness question, not a cleanup question, and should be scoped on its own.
3. Only after 1 and 2: the Gmail-rules and action-hygiene "migrate-first" work already queued in the Server.ts Map section above, which is also the prerequisite for ever safely extracting `applyPendingAction`/`pending-actions` out of `server.ts`.

## Migration Rule

When moving a legacy surface into v2:

1. Add operation catalog entries.
2. Add deterministic validation.
3. Add deterministic executor callbacks.
4. Add routeDebug assertions proving `plannerUsed`, `mutationExecuted`, `operationPlanValidated`, and `legacySemanticUsed`.
5. Keep legacy fallback until tests prove parity.
6. Update `README.md`, `docs/01-system-architecture.md`, `docs/05-agent-behavior.md`, `docs/07-implementation-status.md`, and `docs/08-product-capability-audit.md`.
