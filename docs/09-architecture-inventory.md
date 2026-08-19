# Architecture Inventory

Last updated: 2026-08-19

This file is the current architecture handoff for humans and orchestrator agents. It is descriptive, not aspirational. Conversation Orchestrator v2 has been fully retired (see "Conversation Orchestrator v2 — Full Retirement" below) — assume legacy `/messages/process` routing owns anything not explicitly owned by Agent Runtime v3, until tests prove otherwise.

## Entry Points

- `apps/telegram-bot`: Telegram adapter. It converts Telegram updates into API calls and should stay thin. Core business logic must not depend on Telegram `ctx`, inline buttons, command menus, or hardcoded chat IDs.
- `POST /agent/message`: **the default runtime for normal Telegram chat** (`apps/api/src/agent-runtime/`), isolated from the `/messages/process` routing order below. `apps/telegram-bot` routes all normal (non-command) text here unless `TELEGRAM_AGENT_RUNTIME_V3_ENABLED=false` explicitly opts back into legacy (`routeToLegacyMessageProcessor` in `apps/telegram-bot/src/index.ts`); slash commands and Gmail OAuth/setup/sync flows are unaffected either way. Session state (topic, pending confirmation, visible entities, recent mutations, bounded message history) is persisted per `userId`+`channel` in the `AgentConversationSession` table with a sliding 24h TTL — it survives an API restart; an expired session is treated as missing. **New conversation/product work goes here, not into the legacy pipeline below.** See `apps/api/src/agent-runtime/session-store.ts`, `apps/telegram-bot/src/agent-runtime-routing.ts`, the README's "Agent Runtime v3" section, and "Legacy conversation stack to remove or isolate" below.
- `POST /messages/process`: **legacy** natural-message entry point for normal conversation. Still the production path for the explicit `TELEGRAM_AGENT_RUNTIME_V3_ENABLED=false` opt-out and for direct API callers. Purely legacy deterministic/semantic routing now — the Conversation Orchestrator v2 branch that used to run first has been retired (see "Conversation Orchestrator v2 — Full Retirement" below). Not removed yet — see the legacy inventory below for what's still needed and what isn't.
- `POST /messages/process_v2`: **retired.** This debug/audit-only endpoint (unconditional Conversation Orchestrator v2 invocation) was deleted after confirming zero production callers — see "`/messages/process_v2` Retirement" below. Conversation Orchestrator v2's own logic has since been retired too, in a later pass — see "Conversation Orchestrator v2 — Full Retirement" below.
- Domain API routes under `/users/:userId/...`: canonical mutation/read surfaces for goals, events, actions, email rules, reviews, integrations, daily loop, weekly review, planning, and debug views.
- `apps/worker`: proactive jobs for daily loop, reminders, integration sync, and Gmail background sync. It should call API/core services, not duplicate domain rules.

## Conversation Routing Order

Current production `/messages/process` order (Conversation Orchestrator v2 was the first step here until its retirement — see "Conversation Orchestrator v2 — Full Retirement" below; the order below is what's left, unchanged otherwise):

1. Parse request body and ensure user.
2. Expire stale pending decisions.
3. Handle standalone `now` safely.
4. Run deterministic policy/guardrail precheck.
5. Resolve pending decisions before ordinary routing when the reply fits the pending scope.
6. Handle focused pending Gmail rule creation/editing.
7. Reject unresolved hygiene follow-ups without a visible context.
8. Route planning requests.
9. Route explicit memory requests.
10. Re-run guardrail check before surface routing.
11. Route deterministic conversation surfaces.
12. Route optional legacy LLM semantic router.
13. Try manual action creation.
14. Block unhandled mutation/control verbs from generic chat.
15. Route custom goal progress and structural proposals.
16. Optionally analyze with OpenAI and create extracted events.
17. Compose final response.

## Route Ownership Map

Conversation Orchestrator v2 has been retired (see "Conversation Orchestrator v2 — Full Retirement" below) — there is no more split ownership between v2 and legacy. Everything below is owned by legacy `/messages/process` routing:

- All slash command behavior and command batching.
- All Gmail rule creation/editing/removal conversations (only `gmail.rule.create`/`.list`/`.explain` and `gmail.review.*` have a v3 equivalent — see "Legacy Conversation Stack To Remove Or Isolate" below for what v3 does and doesn't cover).
- Planning sessions, weekly planning edits, and plan creation replies.
- Daily loop settings mutations.
- Action hygiene list creation and bulk/multi-item hygiene replies (v3's `action.*` tools are single-item only).
- Recent mutation status questions.
- Explicit memory creation, conservative progress logging, and selected read surfaces — v3 independently reimplements these for its own default Telegram path, but the legacy versions inside `/messages/process` are unchanged and still what direct API callers and the legacy opt-out hit.
- Generic chat/coaching fallback.
- Legacy LLM semantic routing for natural-language surfaces v3's tool catalog doesn't cover.
- Event extraction and final response composition after legacy OpenAI analysis.

Route debug contract (fields still populated by the remaining legacy routers):

- `plannerUsed`
- `llmPlannerAttempted`
- `llmPlannerUsed`
- `legacySemanticAttempted`
- `legacySemanticUsed`
- `handledBy`
- `mutationExecuted`
- `policyPrecheckResult`

`v2Enabled`, `llmOperationPlannerEnabled`, `v2SkippedReason`, and `operationPlanValidated` were Conversation Orchestrator v2 debug fields. They remain defined (as optional fields) in the shared `ProcessMessageResult.routeDebug` zod schema in `packages/core/src/message-processing.ts` for backward compatibility with any external consumer of the API response shape, but no code populates them anymore — treat them as dead schema, not live contract.

`policyPrecheckResult` is safe and compact. Expected values include `passed`, `reference_text_blocked`, and `blocked_by_guardrail`.

## Server.ts Map

`apps/api/src/server.ts` remains oversized.

Current line count after this audit pass: 16,289 lines. History: 17,903 (start) → 17,440 (type-extraction pass) → 17,380 (phase 1: memory + notification-settings routes) → 17,293 (phase 2: checkins-prompt/ingest routes + isRecord de-duplication) → 17,172 (phase 3: insights routes + shouldUseOpenAIAnalysis de-duplication) → 17,122 (`/messages/process_v2` retirement) → 16,938 (Conversation Orchestrator v2 full retirement) → 16,875 (Gmail rule service extraction) → 16,727 (action hygiene service extraction) → 16,289 (pending-actions route extraction — see "Pending-Actions Route Extraction" below).

`apps/api/src/conversation/context.ts`, `operation-catalog.ts`, `operation-planner.ts`, `operation-validator.ts`, `operation-executor.ts`, and `response-composer.ts` — the six Conversation Orchestrator v2 modules previously listed here as "known extracted modules" — have been **deleted**, not extracted; see "Conversation Orchestrator v2 — Full Retirement" below.

Known extracted modules:

- `apps/api/src/routes/messages.ts`: Fastify registration and validation for `/messages/process`. (`/messages/process_v2` was registered here too until it was retired — see "`/messages/process_v2` Retirement" below.)
- `apps/api/src/conversation/gmail-autonomy.ts`: Gmail setup/autonomy state formatting.
- `apps/api/src/conversation/email-rule-selection.ts`: Gmail rule target selection helpers.
- `apps/api/src/gmail/gmail-rule-service.ts` (new, Gmail rule service extraction): pure Gmail rule listing/grouping/formatting — `isBuiltInEmailAdapter`, `EmailRuleHumanDisplayGroup`, `groupEmailRulesForHumanDisplay`, `formatGmailEmailRuleSelectionLines`, `getVisibleGmailEmailRules`. Zero OAuth/token/sync/provider-API dependencies. See "Gmail Rule Service Extraction" below.
- `apps/api/src/utils/text.ts` (new, Gmail rule service extraction): `normalizeForComparison`, a dependency-free string-normalization helper that was defined once privately in server.ts and called ~59 times for unrelated comparisons (goals, reflections, next-week plans, email rules). Moved here rather than into `gmail-rule-service.ts` so the Gmail module's exports stay focused on Gmail-rule concerns.
- `apps/api/src/actions/hygiene.ts` (new, action hygiene service extraction): `readActionHygieneBatchOperations`, `applyActionHygieneBatchOperations`, plus the `HygieneOperation`/`ActionHygieneBatchOperation` types. The one piece of action-hygiene code `applyPendingAction` actually depends on. See "Action Hygiene Service Extraction" below.
- `apps/api/src/actions/goal-progress.ts` (new, action hygiene service extraction): `createGoalProgressFromCompletedAction`, moved because `applyActionHygieneBatchOperations` needs it — not hygiene-specific (5 call sites across manual completion, conversational action control, and hygiene batches), so it's a sibling to `hygiene.ts`, not inside it.
- `apps/api/src/utils/datetime.ts` (new, action hygiene service extraction): `formatLocalDateTime`, a dependency-free local-datetime formatter with 17 call sites spanning actions, email reviews, and other unrelated surfaces — same de-duplication reasoning as `normalizeForComparison`.
- `apps/api/src/routes/pending-actions.ts` (new, pending-actions route extraction): `GET /users/:userId/pending-actions`, `POST .../confirm`, `POST .../reject`, moved verbatim along with `applyPendingAction` (exported — server.ts's legacy `/messages/process` confirmation branch still calls it) and `findPendingAction` (private, exclusively used by the confirm route). See "Pending-Actions Route Extraction" below.
- `apps/api/src/utils/arrays.ts` (new, pending-actions route extraction): `arrayOfStrings`, a dependency-free array-of-strings coercion with 20 call sites, not pending-actions-specific.
- `apps/api/src/utils/user-timezone.ts` (new, pending-actions route extraction): `getUserTimezone`, a DB-only user-timezone lookup with 43 call sites across nearly every domain in the file — the most widely-shared helper de-duplicated in this whole cleanup series.
- `apps/api/src/actions/goal-progress.ts` gained a second export in this pass: `createCustomGoalProgressEvent` (moved for the same reason `createGoalProgressFromCompletedAction` moved in the action hygiene pass — used by `applyPendingAction`'s `goal_progress_log` branch plus 2 other call sites, not specific to any one extracted module).
- `apps/api/src/server-types.ts`: 39 pure type/interface declarations extracted from server.ts's private helper zone — daily-brief/operator-attention, weekly review, action hygiene, next-week planning, daily coach, and Gmail/GitHub sync shapes. Zero behavior change (types are erased at compile time); `sanitizeActionItem`, `buildConversationControlDebugForUser`, and `PlanWindowKind` were exported from server.ts (previously private) purely so this file can reference them in `typeof`/`ReturnType` positions. −463 net lines in server.ts.
- `apps/api/src/routes/memory.ts` (new, server cleanup phase 1): the three `/users/:userId/memory*` routes (list/create/archive), moved verbatim. Zero server.ts-private helper dependencies, so zero circular-import risk. Registered via `registerMemoryRoutes(server)`.
- `apps/api/src/routes/notification-settings.ts` (server cleanup phase 1): the two `/users/:userId/notification-settings` routes (get-or-create/update), moved verbatim. Same zero-dependency, zero-circular-import profile. Registered via `registerNotificationSettingsRoutes(server)`.
- −60 net lines in server.ts from phase 1 (43 + 19 lines of route code removed, 2 lines of unused schema imports removed, 4 lines of import/register calls added).
- `apps/api/src/routes/checkins-ingest.ts` (new, server cleanup phase 2): `GET /users/:userId/checkins/daily/prompt`, `POST /users/:userId/ingest/text`, `POST /users/:userId/ingest/job-search-text`, moved verbatim along with their two exclusively-used private helpers (`ingestText`, `composeIngestionReply`, confirmed to have no other call sites in server.ts before moving). Registered via `registerCheckinsIngestRoutes(server)`.
- `apps/api/src/utils/records.ts` (new, server cleanup phase 2): `isRecord`, a dependency-free type guard that was defined once privately in server.ts and called 53 times there. Moved so `routes/checkins-ingest.ts` (which also needs it) doesn't have to import it back from server.ts — that would have been the circular import this whole extraction pass exists to avoid. All 53 existing call sites in server.ts needed no changes (same `isRecord(...)` call syntax, now resolved via import instead of local definition). Note: four other files (`apps/api/src/conversation/*.ts`, `apps/api/src/agent-runtime/session-store.ts`) have their own independent, identical private copy of this same check — left alone, out of scope for this pass since touching them isn't needed for safety here and would mean editing Agent Runtime v3 source.
- −87 net lines in server.ts from phase 2.
- `apps/api/src/routes/insights.ts` (new, server cleanup phase 3): `GET /users/:userId/insights/daily`, `GET /users/:userId/insights/weekly`, moved verbatim along with their exclusively-used private helpers (`maybePolishInsight`, `isDirectInsightProfile`, `startOfToday`, `startOfLastSevenDays`, `parseDateStart`, `addDays` — each confirmed via grep to have no other call sites in server.ts before moving). Registered via `registerInsightRoutes(server)`.
- `apps/api/src/utils/env.ts` (new, server cleanup phase 3): `shouldUseOpenAIAnalysis`, a dependency-free env-var check that was defined once privately in server.ts and called from 3 places — the two insights routes (via `maybePolishInsight`) plus two unrelated legacy semantic-analysis call sites that stay in server.ts. Moved for the same reason `isRecord` moved in phase 2: `routes/insights.ts` needs it, and giving it a shared home avoids a circular import back into server.ts. The 2 remaining call sites in server.ts needed no changes, only the import source changed.
- `pending-actions` (`GET /users/:userId/pending-actions`, `POST .../confirm`, `POST .../reject`) was inspected and **not extracted this pass** — see "Why pending-actions was skipped" below. ~~Extracted in a later pass~~ — see "Pending-Actions Route Extraction" below.
- −121 net lines in server.ts from phase 3.

Why pending-actions was skipped in phase 3: `GET /pending-actions` and `POST .../reject` are themselves trivial (only call already-imported `@operator-agent/db` functions), and `POST .../confirm`'s own lookup helper `findPendingAction` is small and exclusively used by that one route. But `POST .../confirm` also calls `applyPendingAction`, a ~345-line function (`server.ts` around line 16572 pre-phase-3) that switches on every pending-action type and reaches directly into Gmail rule management (`archiveEmailSignalRule`, `createEmailSignalRule`, `writeGmailAutonomyPreferences`, `buildGmailAutonomyState`) and action-hygiene batch operations (`applyActionHygieneBatchOperations`) — both of which are the two next items already flagged below as high-risk, dedicated-pass-only extractions. `applyPendingAction` is also called from deep inside the legacy `/messages/process` conversational confirmation flow (the "say yes to confirm" path), not just from this HTTP route, so it is not exclusively used by the pending-actions route group. Moving it would mean either extracting the Gmail-rules and action-hygiene tangles at the same time (a materially bigger, higher-risk change than this pass's scope) or leaving it in server.ts and importing it into the new route module, which is exactly the circular import this whole effort exists to avoid. Per this task's explicit "do not force extraction if risk is high" instruction, the pending-actions route group was left in place untouched.

**Update: done.** Both halves of the blocker were resolved (Gmail rule service extraction, action hygiene service extraction), and the `pending-actions` route group itself has now been extracted — see "Pending-Actions Route Extraction" below.

High-density areas that still live in `server.ts`:

- Route registration for domain APIs (actions, goals, events, Gmail OAuth/sync/rules/reviews, daily loop, weekly review, planning, insights, conversation-control — everything except memory and notification-settings now).
- Telegram-facing text formatting.
- Gmail OAuth/sync/rule/review orchestration.
- Daily loop, action hygiene, planning, and weekly review composition.
- Legacy semantic routing and deterministic phrase routing.
- The inline `/messages/process` handler body passed into `registerMessageRoutes(...)` (route registration itself is in `routes/messages.ts`, but the callback still lives in server.ts and depends on 10+ private helpers plus the legacy semantic/deterministic-surface routers directly — confirmed high risk to extract without a circular import back into server.ts; left in place). The sibling `/messages/process_v2` handler body was retired, not extracted — see "`/messages/process_v2` Retirement" below. (The Conversation Orchestrator v2 branch that used to run inside this same handler body has since been deleted entirely — see "Conversation Orchestrator v2 — Full Retirement" below.)

Recommended next extraction target (in safety order, re-verified during the pending-actions route extraction pass):

1. ~~`pending-actions` route group~~ — **done**, see "Pending-Actions Route Extraction" below.
2. Move conversation-facing Gmail rule NL parsing/editing handlers (`resolveCustomGmailRulesForConversation`, `editActiveCustomGmailRuleForConversation`, `manageCustomGmailRuleForConversation`, and the rest of the legacy semantic-router Gmail cluster) into `apps/api/src/conversation/gmail-rules.ts` if ever attempted — confirmed still tangled with free-text pronoun/target resolution and the legacy semantic router (not pure rule management), higher risk, do only with dedicated time. Deliberately NOT touched in the Gmail rule service pass.
3. Move the action-hygiene natural-language reply parser/session layer (`resolveActionHygieneReply`, `planActionHygieneBatchReply`, `parseActionHygieneReply`, `normalizeHygieneBatchText`, and the rest — still in server.ts) if ever attempted — deliberately NOT extracted in the action hygiene service pass; see "What was intentionally NOT extracted" in "Action Hygiene Service Extraction" below.
4. Move planning session handlers into `apps/api/src/planning/`.
5. The `/messages/process` inline handler bodies are the least safe candidate in the file (10+ deps, direct calls into the legacy semantic/deterministic-surface routers) — do not attempt without a dedicated, carefully-scoped pass. This is now the largest remaining monolithic surface in `server.ts` and the natural next candidate for a dedicated, carefully-scoped pass, once items 2–4 (or a subset) are done.

## Legacy And Split-Brain Risks

The v2-vs-legacy split-brain risk this section used to describe no longer applies — Conversation Orchestrator v2 is retired, so there is exactly one router (legacy `/messages/process`) for anything Agent Runtime v3 doesn't own. The risk that remains is v3-vs-legacy, already covered in "Legacy Conversation Stack To Remove Or Isolate" below.

- Route debug remains the guardrail against accidental silent fallback for any future migration work (now v3-targeted, not v2-targeted) — new migrated scopes must prove `legacySemanticUsed=false` in tests.
- Some worker and API surfaces share summaries but not always a single composer. Keep proactive messages concise and tested.

## Potentially Obsolete Logic To Audit Later

Do not delete these without targeted tests:

- Legacy multi-intent orchestration.
- Legacy conversational action control for complete/reschedule/archive flows.
- Legacy Gmail semantic-router patches for custom rule follow-ups.
- Duplicate natural setup/help surfaces.
- Old phrase-specific fixes for Spanish/Catalan Gmail rule edits.

## ConversationContext / LLM OperationPlanner Audits — Retired

These two sections used to document Conversation Orchestrator v2's internal `ConversationContext` projection and its LLM operation planner (`LLM_OPERATION_PLANNER_ENABLED`, deterministic validation, migrated operation families, etc.). Both mechanisms were deleted along with the rest of v2 — see "Conversation Orchestrator v2 — Full Retirement" below for exactly what was removed. Kept as a pointer here rather than reproducing now-inapplicable internals: if you're looking for how context or LLM-assisted operation planning works today, that's Agent Runtime v3's `agent-runtime/context-loader.ts` and `agent-runtime/planner.ts` — an independent, unrelated implementation, not a descendant of v2's.

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

**Conversation Orchestrator v2** — **RETIRED.**
- A product decision confirmed no live deployment relies on `CONVERSATION_ORCHESTRATOR_V2_ENABLED=true`; the branch, `apps/api/src/conversation/{orchestrator-v2,context,operation-catalog,operation-planner,operation-validator,operation-executor,response-composer}.ts`, and `tests/conversation-orchestrator-v2.test.ts` were all deleted. See "Conversation Orchestrator v2 — Full Retirement" below for the deletion record.
- Scopes it used to own (hygiene lists, single-item pronouns, recent mutation status, explicit memory, selected read surfaces, conservative progress logging) now fall through entirely to legacy `/messages/process` routing, exactly as they did whenever the flag was off — no behavior change for any scope, since the flag was confirmed off everywhere it mattered.
- Replacement in v3: v3 already independently reimplements memory, progress logging, and read surfaces for its own default path — unaffected by this deletion, since v3 never depended on v2's code.

**Pending-actions confirmation flow** (`apps/api/src/routes/pending-actions.ts` — extracted; `applyPendingAction`, `findPendingAction`)
- Still needed: yes — this is the least "legacy" item in this list, and now the least tangled with `server.ts` too.
- Reason: unlike everything else above, this is reached **directly and unconditionally** by three Telegram slash commands regardless of the v3/legacy flag: `/pending` (`apps/telegram-bot/src/index.ts:1929`), `/confirm` (`:1942`, calls `POST .../confirm` → `applyPendingAction`), and `/cancel` (`:1965`, calls `POST .../reject`). It's also called internally from `/messages/process`'s confirmation-message branch (`resolvePendingDecisionReply`), which is why `applyPendingAction` is exported from its new module rather than kept fully private. `applyPendingAction` (~345 lines) was the function server cleanup phase 3 declined to extract because it reached into Gmail rule management and action-hygiene batch operations — both are now clean, and the whole route group has been extracted; see "Pending-Actions Route Extraction" below.
- Safe deletion conditions: still none — this is core product surface, not a deletion candidate, extraction or not.
- Replacement in v3: v3 has its own independent `confirmation.confirm`/`confirmation.cancel` tools and session-based pending-plan state (`agent-runtime/session-store.ts`) — a parallel mechanism, not built on the legacy `PendingAction` table.
- **Cross-system risk: RESOLVED** (see "PendingAction / Agent Runtime v3 Interop" below). v3's context loader reads the legacy `PendingAction` table every turn and detects/defers/safely-cancels it before the planner runs. It still never executes `applyPendingAction`'s type-specific mutation logic itself — that stays legacy-only, reachable through `/confirm`, and this pass's extraction did not change that boundary at all.

**Old tests that only protect deprecated behavior**
- `tests/conversation-orchestrator-v2.test.ts` — **deleted**, along with the v2 code it protected. See "Conversation Orchestrator v2 — Full Retirement" below.
- Replacement in v3: `tests/messages-process-legacy.test.ts` (new), `tests/agent-message.test.ts`, `tests/agent-runtime-*.test.ts`, and `tests/telegram-agent-runtime-routing.test.ts` cover the remaining legacy path and v3-equivalent behavior.

### Legacy Usage Audit — Deletion-Readiness Pass (2026-08-18)

Grep/reference-verified pass answering: with v3 as the Telegram default, which old conversation systems are still reachable, and from where? Evidence commands used: `rg "messages/process"`, `rg "conversation_orchestrator"`, `rg "process_v2"`, `rg "conversation/control"`, `rg "action_hygiene"`, `rg "routeToLegacyMessageProcessor"`, `rg "handleSemanticRouterIntent\("`, plus direct reads of `apps/telegram-bot/src/index.ts` call sites and `apps/api/src/agent-runtime/{executor,tool-catalog,planner}.ts` for v3-side overlap.

**Legacy stack map**

| # | System | Files / functions | Direct callers (evidence) | Reachable from v3-default Telegram normal chat? | Reachable from slash commands? | Tests-only? | `/messages/process`-only? | v3 replacement | Verdict | Safe deletion conditions |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | `/messages/process` | `apps/api/src/routes/messages.ts` (registration); handler body `server.ts:308-608` | `apps/telegram-bot/src/index.ts:55` (pending-reply+command-batch middleware, unconditional), `:136` (`/help`), `:2054` (`routeToLegacyMessageProcessor`, opt-out only), `:3818` (`createManualActionFromCommand`, guardrail/risk-flagged manual-action commands) | No, not directly (`message:text` goes to v3 by default) | Yes — `/help` always; `/todo`, `/add_action`, `/action` etc. when the deterministic router flags the text as guardrail/risk; combined pending-reply+command text | No — live production callers exist | No | `POST /agent/message` | **KEEP** | v3 has tool/flow parity for every scope in "Not yet migrated," the legacy Telegram opt-out is itself deprecated, and no direct API callers remain |
| 2 | Deterministic surface router | `handleConversationSurfaceIntent` (`server.ts:5577-5756`), `detectConversationSurfaceIntent` (`:8564-8755`) | Both have exactly 1 call site, inside `/messages/process`'s `process` handler only (not `process_v2`) | Same as #1, transitively | Same as #1, transitively | No | Yes, effectively | `agent-runtime/{validator,executor}.ts` (not 1:1) | **KEEP** | Only becomes reachable to delete once #1 is safe to delete |
| 3 | Legacy semantic router | `handleSemanticRouterIntent` (`server.ts:6935`) + ~20-function cluster (`:6427-8560`, Gmail rule proposal/edit/create, autonomy-preference conversation) | 2 call sites, both inside `/messages/process`'s `process` handler (`:403` pending-Gmail focus, `:471` main dispatch) — confirmed via `rg "handleSemanticRouterIntent\("` repo-wide | Same as #1, transitively | Same as #1, transitively | No | Yes, effectively | `agent-runtime/planner.ts` (narrower tool catalog) | **KEEP / MIGRATE-FIRST** | v3's planner+catalog covers generic chat/coaching and every surface this router classifies, with tests proving `legacySemanticUsed=false` |
| 4a | Conversation Orchestrator v2 (logic) | **DELETED.** Was `apps/api/src/conversation/orchestrator-v2.ts` + `operation-{catalog,planner,validator,executor}.ts`, `response-composer.ts` | N/A — deleted | No | No | N/A — `tests/conversation-orchestrator-v2.test.ts` deleted | N/A | Overlaps v3 for memory/progress-logging/read-surfaces it independently reimplemented | **DELETED** | Done — product confirmed no live deployment set the flag; see "Conversation Orchestrator v2 — Full Retirement" below |
| 4b | `/messages/process_v2` route | **DELETED.** Was `routes/messages.ts:9-13,29-39`; unconditional call was `server.ts:308-314` | Zero matches in `apps/telegram-bot/` or `apps/worker/` — confirmed via `rg "process_v2"` across both dirs, both before and after deletion | No | No | Was **yes** — only `tests/conversation-orchestrator-v2.test.ts` called this route (43 call sites through a shared `processV2()` test helper, not 2 — the original count only found the literal route-string matches, not the helper's callers) | N/A (it was the alternative to `/messages/process`) | N/A — it was explicitly a debug/audit endpoint per its own `messageRouteOwnership` doc comment | **DELETED** | Done — see "`/messages/process_v2` Retirement" below for what was removed and how the test coverage was preserved |
| 5 | `/conversation/control`, `/conversation/multi-intent` | `server.ts:1206` (control), `:1232` (multi-intent) | `index.ts:2043`/`:2011` (`routeToLegacyMessageProcessor`, opt-out only); `index.ts:172` (`/debug_conversation_intent`, dry-run), `index.ts:196` (`/debug_intent_plan`, dry-run) — both debug-gated (`guardDebugAllowedUser`) | No (ordinary chat never hits these directly) | Yes — two debug-only, non-mutating slash commands | No | No | Pending-op confirm/cancel firewall in `runtime.ts` (conceptual, not 1:1) | **KEEP** | Legacy Telegram pipeline removed, no other callers, debug commands repointed or removed |
| 6 | Old action-hygiene NL parser | `parseActionHygieneReply` (`:16315`), `resolveActionHygieneReply` (`:15462`), `normalizeHygieneBatchText`, `applyActionHygieneBatchOperations`, ~25 functions total (`:2631-16800`ish) | `resolveActionHygieneReply` is called only from `resolvePendingDecisionReply`, itself only inside `/messages/process`'s `process` handler | Same as #1, transitively — a plain-text hygiene reply with v3 as default now reaches v3 first, not here (**see "PendingAction / Agent Runtime v3 Interop" below** — v3 no longer silently ignores it; it detects the row and defers to `/confirm`/`/cancel` instead of guessing) | Same as #1, transitively (pending-reply+command-batch text) | No | Yes, effectively | `action.list` + single-entity "it" resolution only (no bulk/multi-item, no numbered-list resolution) | **KEEP** | v3 gains bulk/multi-item action operations with equivalent safety guarantees, proven by tests matching current hygiene coverage |
| 7 | Old Gmail NL handlers | Same cluster as #3: `buildCustomGmailRuleProposal`, `editPendingCustomGmailRule`, `editActiveCustomGmailRuleForConversation`, `manageCustomGmailRuleForConversation`, `answerGmailRuleQuestionForConversation` (dispatch at `:7223-7257`) | Reached only via `handleSemanticRouterIntent` (see #3) | Same as #3 | Same as #3 | No | Yes, effectively | `gmail.rule.{create,list,explain}`, `gmail.review.{list,reject,to_action}` (creation + read-only only) | **KEEP / MIGRATE-FIRST** | v3 tool catalog gains rule editing/removal/toggle/autonomy-preference tools with test parity |
| 8 | Pending-actions confirmation flow | `apps/api/src/routes/pending-actions.ts` (routes, extracted), `applyPendingAction` (~345 lines, extracted with them), `findPendingAction` (extracted, private) | `index.ts:1929` (`/pending`), `:1942` (`/confirm`), `:1965` (`/cancel`) — **all three unconditional**, independent of the v3/legacy flag; `applyPendingAction` also called internally from `server.ts`'s `/messages/process` confirmation branch, one-directionally (not circular) | **Yes, now detected** — v3's context loader reads the legacy `PendingAction` table every turn (see "PendingAction / Agent Runtime v3 Interop" below); it still never executes `applyPendingAction` itself | **Yes, directly** — `/pending`, `/confirm`, `/cancel` always live | No | No | v3 detects/defers/safely-cancels; `/confirm`'s actual execution stays legacy-only | **KEEP (extracted)** | Not a deletion candidate; `applyPendingAction` execution moves to v3 only once the Gmail-rules NL/action-hygiene NL migrate-first work (rows 2/3) is done |
| 9 | `tests/conversation-orchestrator-v2.test.ts` | **DELETED.** All 32 tests removed along with the v2 code they protected | N/A | N/A | N/A | N/A | N/A | `tests/messages-process-legacy.test.ts` (new, 3 tests: legacy path still works, the retired flag is inert, v3 unaffected), plus `tests/agent-message.test.ts`, `tests/agent-runtime-*.test.ts`, `tests/telegram-agent-runtime-routing.test.ts` | **DELETED** | Done — see "Conversation Orchestrator v2 — Full Retirement" below |
| 10 | `tests/email-review-dedupe.test.ts` (11,492 lines, 128 tests) | Direct HTTP tests against `/messages/process`, `/conversation/control`, Gmail semantic-router flows, action-hygiene flows | Hits the API layer directly, bypassing the Telegram v3/legacy flag entirely | N/A (test file) | N/A | Mostly no — most of what it covers is still reachable per rows 1, 3, 6, 7, 8 above (via `/help`, guardrail-flagged commands, debug commands, `/confirm`) | Partially | Same as above per-scope | **KEEP AS-IS** | Do not touch; despite testing "legacy" code, it protects genuinely live production paths |

**Delete-now candidates**
- ~~`/messages/process_v2`~~ (row 4b) — **deleted.** See "`/messages/process_v2` Retirement" below.

**Migrate-first candidates** (build v3 parity before touching the legacy code)
- Legacy semantic router / old Gmail NL handlers (#3, #7): v3 needs rule editing/removal/toggle/autonomy-preference tools.
- Old action-hygiene NL parser (#6): v3 needs bulk/multi-item action operations with visible-list numbering and all-except selection.

**Keep-for-slash-command candidates** (still directly wired to live, non-debug slash commands — do not touch without also updating the bot)
- `/messages/process` (#1) — `/help`, guardrail-flagged action-creation commands, pending-reply+command-batch text.
- Pending-actions confirmation flow (#8) — `/pending`, `/confirm`, `/cancel`.
- `/conversation/control` + `/conversation/multi-intent` (#5) — kept alive by debug-only commands (`/debug_conversation_intent`, `/debug_intent_plan`), lower priority than the two above since they're read-only debug tooling, not core product flow.

**Tests that should be rewritten or removed later**
- ~~`tests/conversation-orchestrator-v2.test.ts`~~ — **deleted.** See "Conversation Orchestrator v2 — Full Retirement" below.
- No other test file in `tests/*.test.ts` was found to protect exclusively-dead behavior; `tests/email-review-dedupe.test.ts` in particular should NOT be touched (row 10).

**Exact next safe cleanup PR/pass**
1. ~~Confirm whether `/messages/process_v2` debug tooling is still wanted; if not, delete it.~~ **Done** — see "`/messages/process_v2` Retirement" below.
2. ~~Close the cross-system gap under "Pending-actions confirmation flow."~~ **Done** — see "PendingAction / Agent Runtime v3 Interop" below.
3. ~~Confirm whether `CONVERSATION_ORCHESTRATOR_V2_ENABLED` and Conversation Orchestrator v2 itself can be deleted.~~ **Done** — see "Conversation Orchestrator v2 — Full Retirement" below.
4. Next: the Gmail-rules and action-hygiene "migrate-first" work already queued in the Server.ts Map section above, which is also the prerequisite for ever safely extracting `applyPendingAction`/`pending-actions` out of `server.ts` (and for eventually letting v3 execute legacy `PendingAction`s directly instead of just detecting them).

## PendingAction / Agent Runtime v3 Interop

**The bug:** making Agent Runtime v3 the Telegram default meant a legacy `PendingAction` row (created by a slash-command flow like `/action_hygiene`, or a Gmail rule proposal) could be silently ignored, misrouted, or reinterpreted as a fresh request the moment the user replied in plain natural language instead of running `/confirm`/`/cancel` — because v3's context loader never read the `PendingAction` table at all.

**Chosen fix: Option A** — v3 detects the legacy `PendingAction` itself, in-process, every turn. Option B (a Telegram-layer routing bridge back to the legacy resolver) was available but not needed: the only genuinely unsafe part of the legacy resolver is `applyPendingAction`'s type-specific mutation logic (Gmail rule archival/creation, action-hygiene batch operations, profile updates, etc.), and that function was never going to be called from v3 either way — bridging the whole message back to `/messages/process` would have re-introduced exactly the "v3 and legacy both handle the same message" risk the hard rules forbid, for no benefit. Detecting the row and using only the two safe, already-package-level DB functions (`getLatestPendingAction`, `rejectPendingAction` — both plain `@operator-agent/db` calls, zero server.ts dependency, zero circular-import risk) is strictly safer and simpler.

**Behavior, by message type, when a legacy `PendingAction` is active:**
- **v3's own `session.pendingOperation` is checked first, unconditionally.** If v3 itself has an open confirmation (e.g. a pending Gmail rule creation), an exact "yes"/"no" resolves *that* — the legacy row is left completely untouched. The two pending-state systems are never both consulted for the same message; v3's own state always wins when present. This is what keeps them from ever being confused with each other.
- **Exact confirm** (v3's existing whitelist: "yes", "confirm", "ok", "sí", etc.), only when v3 has no pending operation of its own: v3 does **not** execute the legacy `PendingAction`. `applyPendingAction`'s mutation logic is entangled with Gmail-rule and action-hygiene helpers that aren't safely importable into `agent-runtime/` without a circular import back into `server.ts` — and calling the DB-level `confirmPendingAction` without running that logic would mark the row "confirmed" while silently skipping the actual mutation, which is worse than doing nothing. Reply: *"I can't safely apply that kind of pending action from here yet. Reply with /confirm to complete it, or /cancel to drop it."* The row is left untouched, still `status: "pending"`.
- **Exact cancel** (v3's existing whitelist: "no", "cancel", "stop", etc.): v3 calls `rejectPendingAction` directly and marks the row rejected. This is safe to execute automatically because rejecting never runs any of `applyPendingAction`'s type-specific logic — it only flips a status column, identical in effect to what `/cancel` already does. Reply: *"Cancelled. I did not change anything."* (matching the existing legacy `/cancel` reply text exactly).
- **Anything else** (an ambiguous or unrelated normal message): the planner is never invoked. Reply: *"You have a pending action from the previous flow: `<summary>`. Confirm, cancel, or continue with a new request."* This mirrors the exact same "block until resolved" pattern v3 already uses for its own `pendingOperation` firewall (`"You still have a pending confirmation for X. Confirm, cancel, or tell me a new request."`), so it isn't a new UX pattern — it's the existing one, applied consistently to the legacy case too.
- **No `PendingAction` at all:** zero behavior change — the check is a no-op and the turn proceeds exactly as before.

**Where it lives:** `ContextBundle.legacyPendingAction` (`apps/api/src/agent-runtime/types.ts`), populated by `context-loader.ts` via `getLatestPendingAction(userId)` alongside the rest of the per-turn context fetch. The branching logic is in `runtime.ts`'s `processAgentMessage`, right after the existing exact-confirm/cancel checks for v3's own `pendingOperation` and before the planner is ever invoked. `AgentDebugInfo.legacyPendingActionDetected` exposes whether this path was taken, for tests and observability. Deliberately kept as a separate `ContextBundle` field rather than merged into `AgentSessionState`/`session.pendingOperation` — they are unrelated mechanisms (one is v3's own in-session state, the other is fresh-fetched legacy DB state) and conflating them was the whole failure mode being fixed.

**What remains legacy (not migrated by this change):**
- `applyPendingAction` itself, and everything it calls (Gmail rule archive/create, action-hygiene batch operations, profile/goal/memory mutations) — still `server.ts`-only, still only reachable through `/confirm` or the legacy `/messages/process` confirmation branch. This change does not migrate action hygiene, Gmail rule handling, or any `PendingAction` type's actual execution to v3 — it only stops v3 from *ignoring* the row's existence.
- The action-hygiene natural-language batch parser (row 6 in the audit table above) — still needed for anyone replying with hygiene-specific syntax ("archive 1, 2", "all except the read one") via `/confirm`-adjacent legacy paths; v3 does not understand that syntax and isn't expected to yet.
- `/pending`, `/confirm`, `/cancel` slash commands — completely unchanged; they still hit the same HTTP routes as before, unaffected by anything v3 does.

**Safe deletion/further-migration conditions:** v3 could take over *executing* legacy `PendingAction`s (not just detecting them) once `applyPendingAction`'s Gmail-rule and action-hygiene dependencies are themselves extracted into safely-importable modules — i.e. after the "migrate-first" work already queued for rows 3/6/7 in the audit table above. Until then, this detect-defer-or-safely-cancel design is the stopping point, and should not be treated as "done, no further work needed" — it closes the silent-ignore bug, not the broader migration.

## `/messages/process_v2` Retirement

*Historical record — accurate as of this pass. Everything below about Conversation Orchestrator v2's own logic "still being imported by a live production path" was true then; it no longer is — see "Conversation Orchestrator v2 — Full Retirement" further below for the later pass that deleted it entirely.*

**References found before deletion** (verified with `rg`, not just text search — see below for the import-level check):
- `rg "messages/process_v2"` across `apps/`: exactly 2 files — the route definition/registration in `apps/api/src/routes/messages.ts` (lines 10, 29 pre-deletion), and `tests/conversation-orchestrator-v2.test.ts` (the route string, plus a `processV2()` test helper function calling it).
- `rg "\bprocessV2\b"` (the handler identifier, not just the route string): also present in `apps/api/src/server.ts` (the `processV2` callback passed into `registerMessageRoutes`) — this is the piece the route-string-only search in the prior audit pass missed being able to quantify precisely.
- **Corrected finding vs. the prior audit pass:** the earlier "Legacy Usage Audit" (row 4b above) reported "only 2 references" in the test file, based on literal `/messages/process_v2` string matches. A deeper check — grepping for the `processV2(` *call site* pattern, not just the route string — found the test file's `processV2()` helper function was actually called from **43 separate test call sites** across ~40 tests, all funneling through that one helper. The lesson: route-string grep alone undercounts test dependency when a shared helper wraps the call. This pass re-verified via both the route string and the call-site pattern before touching anything.
- `rg "runConversationOrchestratorV2\b"`: still called from `apps/api/src/server.ts` (inside `runConversationOrchestratorV2ForMessage`, itself still called from `/messages/process`'s `process` handler when `CONVERSATION_ORCHESTRATOR_V2_ENABLED=true`) and defined/exported from `apps/api/src/conversation/orchestrator-v2.ts` — confirming Conversation Orchestrator v2's own logic is **still imported by a live production path** and must not be deleted (per this task's hard rule).
- `rg "conversation/orchestrator-v2"` and the sibling `conversation/operation-{catalog,planner,validator,executor}.ts`, `conversation/response-composer.ts`: all still imported by `apps/api/src/server.ts`, unrelated to and unaffected by this deletion.
- Docs: `docs/09-architecture-inventory.md` (multiple sections, corrected in this pass), `docs/07-implementation-status.md` (one bullet, corrected), `README.md` (one bullet, corrected).

**What was deleted:**
- The `/messages/process_v2` route registration and its `processV2` `server.post(...)` handler in `apps/api/src/routes/messages.ts`, along with the `processV2` entry in `messageRouteOwnership` and the `processV2` method on the `MessageRouteHandlers` interface.
- The `processV2` callback implementation passed into `registerMessageRoutes(...)` in `apps/api/src/server.ts` (the block that called `runConversationOrchestratorV2ForMessage(..., { returnUnhandled: true })` and returned the explicit "not migrated" stub reply).
- The now-unreachable `returnUnhandled` option on `runConversationOrchestratorV2ForMessage` itself and its dead branch — confirmed via `rg "returnUnhandled"` that no remaining caller passes it (the deleted `processV2` handler was the only one that ever did).
- `server.ts`: 17,172 → 17,122 lines (−50).

**What was NOT deleted (and why):**
- `apps/api/src/conversation/orchestrator-v2.ts` and its sibling modules (`operation-{catalog,planner,validator,executor}.ts`, `response-composer.ts`) — still imported by `server.ts`'s live `process` handler (the `CONVERSATION_ORCHESTRATOR_V2_ENABLED=true` branch of `/messages/process`). Deleting these would have violated the explicit hard rule against deleting v2 internals still imported by a remaining production path.
- `/messages/process` itself — untouched, still legacy, still the production fallback path and the explicit `TELEGRAM_AGENT_RUNTIME_V3_ENABLED=false` opt-out target.
- Agent Runtime v3 (`/agent/message`, Telegram routing, persisted sessions) — untouched.
- Slash commands, Gmail OAuth/sync, pending-actions routes — untouched.

**Tests: rewritten, not deleted.** `tests/conversation-orchestrator-v2.test.ts` went from 34 tests to 32 (1,406 → ~1,350 lines):
- 2 tests deleted outright: `"messages/process_v2 exposes explicit v2 ownership when a scope is unmigrated"` and `"conversation orchestrator v2 debug preserves LLM failure when no fallback plan exists"`. Both specifically asserted on the debug-route-only "not migrated" stub reply and its `handledBy: "none"`/`v2SkippedReason` debug fields — behavior that only existed because `/messages/process_v2` called `runConversationOrchestratorV2ForMessage` with `{ returnUnhandled: true }`. The equivalent call through `/messages/process` returns `undefined` in that same case and falls through to the full legacy pipeline instead, which is a genuinely different code path — there was no safe 1:1 rewrite for these two, so they were removed rather than repurposed into a test of legacy fallback behavior (which would have been new scope, not a safe rewrite).
- The remaining 32 tests (43 call sites through the file's `processV2()` helper) were preserved by changing only the helper's implementation — it now calls `/messages/process` with `CONVERSATION_ORCHESTRATOR_V2_ENABLED` forced on for the duration of the call, instead of hitting the deleted debug route. This is behavior-equivalent for every one of these 43 call sites because `runConversationOrchestratorV2ForMessage` returns identically whether or not `returnUnhandled` is set, in every case where `result.handled === true` — and grepping the file for the two "not handled" signal patterns (`"did not handle"` and `handledBy: "none"`/`v2SkippedReason`) before the rewrite confirmed exactly zero of the 41 remaining `processV2()` call sites relied on the unhandled/stub path. All 32 tests pass after the rewrite, and manual verification during this pass confirmed requests now hit `/messages/process`, not the (now-removed) `/messages/process_v2`.
- No other test file needed changes.

## Conversation Orchestrator v2 Branch Retirement Audit

**Question:** now that `/messages/process_v2` is gone, is `CONVERSATION_ORCHESTRATOR_V2_ENABLED` — and the v2-first branch it gates inside `/messages/process` — still needed anywhere, or can it (and the v2 internals it calls) be deleted?

**Decision at the time: KEEP. Not deleted.** This is a repeat of the same open question from the "Legacy Usage Audit" pass and the `/messages/process_v2` retirement pass above — both already flagged the identical blocker. This pass re-verified it from scratch rather than assuming the prior answer still held, and reached the same conclusion for the same reason: **the blocker is not a code question, it's a runtime-environment question this repository cannot answer from the outside.**

**Update — superseded by a product decision:** the exact external fact this audit said would unblock deletion (confirmed via the deployed environment, not this repo) came back negative — no live deployment relies on `CONVERSATION_ORCHESTRATOR_V2_ENABLED=true`. Conversation Orchestrator v2 has since been deleted. See "Conversation Orchestrator v2 — Full Retirement" below for the execution record. The rest of this section is kept as the historical evidence trail that justified waiting for that confirmation before deleting anything.

**References found:**
- `CONVERSATION_ORCHESTRATOR_V2_ENABLED`: read in exactly one place in non-test code — `apps/api/src/conversation/orchestrator-v2.ts:37`, inside `isConversationOrchestratorV2Enabled()`. That function is called from exactly one production gate: `server.ts:314`, the `if (isConversationOrchestratorV2Enabled())` branch inside `/messages/process`'s `process` handler (7 lines: check flag, call v2, return early if it handled the message). Two more read-only references at `server.ts:7166` and `:7169` just populate a `v2Enabled`/`v2SkippedReason` debug field inside the *legacy* semantic-router's own routeDebug output — cosmetic, not a second gate.
- `runConversationOrchestratorV2`/`runConversationOrchestratorV2ForMessage`: confirmed via `rg` across `apps/api`, `apps/worker`, `apps/telegram-bot` — exactly one call site in non-test code (`server.ts:315`, inside the branch above). No worker job, no other route, no Telegram-bot code calls it.
- `conversation/orchestrator-v2` and its sibling modules (`operation-{catalog,planner,validator,executor}.ts`, `response-composer.ts`): only imported by `server.ts` (for the branch above) and by `tests/conversation-orchestrator-v2.test.ts`.
- `plannerUsed`/`legacySemanticUsed`: exist only as fields inside `ProcessMessageResult.routeDebug` (schema in `packages/core/src/message-processing.ts`), populated by v2's own response builder and separately by the legacy semantic router's own builder (`server.ts:7170`/`:7174`, unrelated code path, same field names by convention). Consumed nowhere except being returned in the HTTP response and read by tests — no monitoring, alerting, or other business logic depends on their values.
- `/messages/process`: unchanged this pass — still legacy, still the target of the explicit `TELEGRAM_AGENT_RUNTIME_V3_ENABLED=false` opt-out, still reached by `/help`, guardrail-flagged manual-action slash commands, and the pending-reply+command-batch Telegram middleware (established in the prior "Legacy Usage Audit" pass, unchanged here).
- Docs mentioning the flag: `docs/09` (this file), `docs/07-implementation-status.md`, `README.md` (twice — an illustrative `.env` line and a routeDebug description), plus `docs/01/05/08` (historical phase-tracking snapshots, out of this task's explicit doc-update scope, left untouched as in the prior pass).

**Whether v2 is default anywhere:** no. `isConversationOrchestratorV2Enabled()` returns `true` only when the env var is the literal string `"true"`; unset (the default) evaluates to `false`. Confirmed no default flip anywhere in the call chain.

**Whether the flag is set in this repository's own tracked configuration:** no, anywhere. Checked `.env`, `.env.example`, `docker-compose.yml`, and searched for any `render.yaml`/`fly.toml`/`Procfile`/CI workflow (`.github/` doesn't exist in this repo) — `CONVERSATION_ORCHESTRATOR_V2_ENABLED` appears in none of them. The only places it's ever set to `"true"` in the entire repository are inside `tests/conversation-orchestrator-v2.test.ts`'s own test helpers (`withV2Enabled`, `withEnvOverrides`), which explicitly set-then-restore it around individual test calls — these prove nothing about default or production behavior, only that the tests deliberately force the flag on to exercise v2's code path in isolation.

**Tests relying on v2:** `tests/conversation-orchestrator-v2.test.ts` (32 tests) — all force the flag on via the helpers above.

**Slash commands relying on v2:** none set or depend on this flag directly — Telegram messages have no way to toggle a server-side environment variable. The slash commands that reach `/messages/process` at all (`/help`, guardrail-flagged manual-action commands) would pass through the v2-first branch *if and only if* the server's own deployed environment has the flag set to `true` — which is exactly the unresolved question.

**Why this still can't be deleted safely, despite the strong repo-level signal:** everything checkable from inside this git repository says the flag is off — no tracked config sets it, and it defaults to off. But `CONVERSATION_ORCHESTRATOR_V2_ENABLED` is an environment variable; the actual value on a running deployed instance lives in that instance's environment (a hosting platform's dashboard, a secrets manager, or an untracked `.env` on the ops machine) — none of which this repository or a code audit can see. Deleting `apps/api/src/conversation/orchestrator-v2.ts` and its siblings while a live deployment actually has the flag set to `true` would silently break v2 for any traffic still depending on it, with no test to catch it (since the deleted code's own tests would go with it). This is precisely the "no test currently fails is not proof a path is dead" principle this file has stated from the start, applied to infrastructure instead of code.

**Exact blocker, and how to actually resolve it:** check the real, deployed instance's environment — not this repository — for whether `CONVERSATION_ORCHESTRATOR_V2_ENABLED` is set. Concretely: run `echo $CONVERSATION_ORCHESTRATOR_V2_ENABLED` on the production/staging host, or check the hosting platform's (Render/Railway/Fly/etc.) environment-variables dashboard for the API service. If it's unset or `false` there too, the flag, the `server.ts:314-320` branch, `apps/api/src/conversation/orchestrator-v2.ts` and its sibling modules, and `tests/conversation-orchestrator-v2.test.ts` (32 tests) all become safe to delete in one pass — that deletion PR is fully scoped and ready to execute the moment that one external fact is confirmed. This document cannot confirm it, and should not guess.

**What replaces v2 if/when it's deleted:** Agent Runtime v3 already independently reimplements the memory, progress-logging, and read-surface scopes v2 owns. It does **not** yet cover v2's bulk/multi-item action-hygiene batch operations or full Gmail rule editing — those would fall back to the legacy deterministic/semantic pipeline inside `/messages/process` (not disappear), consistent with everything else already documented in "Legacy Conversation Stack To Remove Or Isolate" above.

## Conversation Orchestrator v2 — Full Retirement

Executes the deletion the "Conversation Orchestrator v2 Branch Retirement Audit" above said would become safe once the one external fact it identified was confirmed. Product confirmed it: no live deployment relies on `CONVERSATION_ORCHESTRATOR_V2_ENABLED=true`.

**References removed:**
- `CONVERSATION_ORCHESTRATOR_V2_ENABLED`: the one production gate (`server.ts:314`, `if (isConversationOrchestratorV2Enabled())`) and its `isConversationOrchestratorV2Enabled` import are deleted. No code anywhere reads this env var anymore — confirmed via `rg "CONVERSATION_ORCHESTRATOR_V2_ENABLED"` returning zero matches under `apps/` and `packages/` after the change.
- `runConversationOrchestratorV2`/`runConversationOrchestratorV2ForMessage`: both deleted (the latter was `server.ts`-local, the former was `orchestrator-v2.ts`'s export, deleted with the file).
- The `v2Enabled`, `llmOperationPlannerEnabled`, and `v2SkippedReason` fields inside the legacy semantic router's own `routeDebug` object (`server.ts`, inside `handleSemanticRouterIntent`) — these referenced the now-deleted flag-check functions and are removed from the object literal. The corresponding fields stay defined (as optional) in the shared `ProcessMessageResult.routeDebug` zod schema in `packages/core/src/message-processing.ts` for response-shape backward compatibility, but nothing populates them anymore.
- `shouldUseLLMOperationPlanner` import into `server.ts` — removed; it was only used to populate the now-removed `llmOperationPlannerEnabled` debug field.

**Files deleted:**
- `apps/api/src/conversation/orchestrator-v2.ts`
- `apps/api/src/conversation/context.ts`
- `apps/api/src/conversation/operation-catalog.ts`
- `apps/api/src/conversation/operation-executor.ts`
- `apps/api/src/conversation/operation-planner.ts`
- `apps/api/src/conversation/operation-validator.ts`
- `apps/api/src/conversation/response-composer.ts`
- `tests/conversation-orchestrator-v2.test.ts` (32 tests)

Reachability confirmed via precise import-path grep (`conversation/<name>.js`, not a loose basename match — an earlier loose check falsely flagged `apps/api/src/conversation/operation-planner.ts` as imported by `packages/llm/src/index.ts`, which turned out to be a same-named but entirely unrelated file in a different package) before deleting each file: all seven had zero importers outside this same cluster once `orchestrator-v2.ts` itself was confirmed to have exactly one importer (`server.ts`, the deleted branch).

**Files NOT deleted (still used elsewhere), and why:**
- `apps/api/src/conversation/gmail-autonomy.ts`, `apps/api/src/conversation/email-rule-selection.ts` — unrelated to v2, still imported by legacy Gmail conversation handling in `server.ts`.
- `packages/llm/src/operation-planner.ts` — a distinct file (same basename, different package) that only `orchestrator-v2.ts` imported from. Was unreachable, out of this pass's explicit scope — deleted in a dedicated follow-up pass; see "LLM Operation-Planner Package Cleanup" below.
- `packages/core/src/message-processing.ts`'s `ProcessMessageResult.routeDebug` schema — the v2-specific optional fields (`v2Enabled`, `llmOperationPlannerEnabled`, `v2SkippedReason`, `operationPlanValidated`) were left defined rather than removed from the schema, since they're optional and harmless, and touching a shared response schema is a larger blast radius than this pass needed.
- Also newly-orphaned and deleted from `server.ts` itself (not files, but functions that existed only to wire into v2's callback interface, confirmed via grep to have zero other callers): `buildOperationPlannerStateSummary`, `logProgressFromConversationMessage`, `createMemoryFromConversationMessage`, `formatMemorySummaryForUser`, `formatConversationProgressEventDone`, `formatConversationProgressEventStatus`, `rememberRecentMutationStatus`. Their own internal dependencies (`formatMultiIntentEventDone`, `getPendingEmailReviewCount`, etc.) were checked individually and confirmed to have independent live callers elsewhere in `server.ts`, so those stayed.

**`server.ts` line count:** 17,122 → **16,938** (−184).

**Tests: 32 deleted, 3 added.** `tests/conversation-orchestrator-v2.test.ts` is gone entirely — every one of its 32 tests exercised v2-specific behavior (its own deterministic operation planner, validator, and response composer) that no longer exists; there was no legacy-equivalent behavior to preserve by rewriting them, unlike the `/messages/process_v2` retirement pass where the underlying v2 logic survived and only the route changed. New: `tests/messages-process-legacy.test.ts` (3 tests) — `/messages/process` still responds through the remaining legacy deterministic-surface path; setting `CONVERSATION_ORCHESTRATOR_V2_ENABLED=true` is now provably inert (identical response with or without it); `/agent/message` (Agent Runtime v3) is unaffected by any of this.

**What's unchanged:** `/agent/message`, Telegram normal chat v3, Telegram slash commands, `/messages/process` (still legacy, still exists, now permanently running only the deterministic/semantic pipeline that was already its fallback), Gmail OAuth/sync, pending-actions routes, memory/checkin/insights routes.

**Next cleanup target:** ~~`packages/llm/src/operation-planner.ts`~~ — **deleted**, see "LLM Operation-Planner Package Cleanup" below. After that, the Gmail-rules and action-hygiene "migrate-first" work already queued in the Server.ts Map section is next in line, same as before this pass.

## LLM Operation-Planner Package Cleanup

Executes the deletion flagged at the end of "Conversation Orchestrator v2 — Full Retirement" above: `packages/llm/src/operation-planner.ts` was left in place during that pass since it's a different package (`packages/llm`, not `apps/api/src/conversation/`) and out of that pass's explicit scope. This pass verified and deleted it.

**References found:**
- `planConversationOperationsWithLLM` and its two interfaces (`PlanConversationOperationsWithLLMInput`, `PlanConversationOperationsWithLLMOptions`): defined only in this file, called/used nowhere else in `apps/`, `packages/`, or `tests/` — confirmed via `rg` across the whole repo.
- `packages/llm/src/index.ts` re-exported the file (`export * from "./operation-planner.js"`), but nothing consumed that export — no `apps/*` package, `packages/*` package, or test imported these symbols through `@operator-agent/llm`.
- `LLM_OPERATION_PLANNER_MOCK_DELAY_MS`, `LLM_OPERATION_PLANNER_MOCK_THROW`, `LLM_OPERATION_PLANNER_MOCK_RESPONSE`, `LLM_OPERATION_PLANNER_MODEL`, and the `CONVERSATION_ORCHESTRATOR_V2_MOCK_RESPONSE`/`CONVERSATION_ORCHESTRATOR_V2_MODEL` fallbacks: all read only inside this now-deleted file. Confirmed distinct from Agent Runtime v3's own planner env vars (`AGENT_RUNTIME_PLANNER_MOCK_*`, `AGENT_RUNTIME_PLANNER_MODEL` in `apps/api/src/agent-runtime/planner.ts`) — completely separate namespace, zero risk of confusing the two.
- Agent Runtime v3's planner (`apps/api/src/agent-runtime/planner.ts`) imports only `createOpenAIClient` from `@operator-agent/llm` — a different, unrelated file (`openai-client.ts`) that this deletion does not touch.
- No test file imported this file directly or via the package export.
- Docs mentioning it: this file (multiple sections, corrected in this pass).

**Files deleted:** `packages/llm/src/operation-planner.ts`.

**Package exports changed:** `export * from "./operation-planner.js";` removed from `packages/llm/src/index.ts`. No consumer broke — confirmed via a full `pnpm typecheck` across all 6 workspace packages after the change.

**Tests removed/updated:** none — no test ever covered this file.

**New unreachable code discovered, not deleted in this pass (out of scope at the time):** while tracing this file's imports, `ConversationOperationNameSchema`, `ConversationVisibleEntityTypeSchema`, `ConversationOperationPlan`, `normalizeConversationOperationPlan`, and the rest of `packages/core/src/conversation-orchestrator.ts` (171 lines, re-exported from `packages/core/src/index.ts`) turned out to have **zero remaining consumers anywhere** now that both `apps/api/src/conversation/orchestrator-v2.ts` and `packages/llm/src/operation-planner.ts` are gone — the only file that ever imported these symbols was the operation-planner file just deleted. This is a third package (`@operator-agent/core`, the most widely-depended-on package in the monorepo) and was never named in this task's scope, so it was left untouched rather than deleted opportunistically. **Since deleted** — see "Core Conversation-Orchestrator Types Cleanup" below.

**What's unchanged:** `/agent/message`, Telegram normal chat v3, slash commands, `/messages/process` legacy behavior, Gmail OAuth/sync, pending-actions routes.

**Next cleanup target:** ~~`packages/core/src/conversation-orchestrator.ts`~~ — **deleted**, see "Core Conversation-Orchestrator Types Cleanup" below.

## Core Conversation-Orchestrator Types Cleanup

Executes the deletion flagged at the end of "LLM Operation-Planner Package Cleanup" above: `packages/core/src/conversation-orchestrator.ts` was left in place during that pass since it's a third package (`@operator-agent/core`, the most widely-depended-on package in the monorepo) and out of that pass's explicit scope. This pass re-verified reachability from scratch, independently, before deleting anything — given the blast radius, no finding was carried over as an assumption.

**References found:** all 19 symbols the file exported — `ConversationOutputTypeSchema`, `ConversationVisibleEntityTypeSchema`, `ConversationOperationNameSchema`, `ConversationOperationTargetSchema`, `ConversationPlannedOperationSchema`, `ConversationOperationPlanSchema`, their 6 inferred types (`ConversationOutputType`, `ConversationVisibleEntityType`, `ConversationOperationName`, `ConversationOperationTarget`, `ConversationPlannedOperation`, `ConversationOperationPlan`), 6 interfaces (`ConversationVisibleEntity`, `ConversationFocusedEntity`, `ConversationPendingConfirmation`, `ConversationRecentMutation`, `ConversationContext`, `ConversationExecutionResult`), and `normalizeConversationOperationPlan` — were checked individually with word-boundary-anchored `rg` across every `.ts` file in the repo except the file itself. Every single one returned zero matches. (One near-miss during this check: a loose, single-sided-boundary grep for `ConversationContext` initially appeared to match `apps/api/src/server.ts`, but that was `maybeRememberGmailRuleConversationContext` — an unrelated, differently-scoped identifier that merely contains the substring. A proper `\bConversationContext\b` re-check confirmed zero real matches. This is the same class of false positive the `operation-planner.ts` pass caught earlier — worth continuing to check both boundaries, not just one, on every symbol in a search like this.)
- `packages/core/src/index.ts` re-exported the file (`export * from "./conversation-orchestrator.js"`), but nothing downstream consumed any symbol through that export.
- No file internal to `packages/core/src/` imported it via relative path either (only `index.ts` did).
- No test file (`tests/*.test.ts`) referenced it, directly or via `@operator-agent/core`.
- No docs/README referenced the file path directly, only this cleanup series' own "flagged as next target" pointers (`docs/09`, `docs/07`).

**Files deleted:** `packages/core/src/conversation-orchestrator.ts` (171 lines).

**Package exports changed:** `export * from "./conversation-orchestrator.js";` removed from `packages/core/src/index.ts`. Verified no consumer broke via `pnpm typecheck` across all 6 workspace packages (`packages/core`, `packages/db`, `packages/llm`, `apps/api`, `apps/worker`, `apps/telegram-bot`) — the widest-radius check in this entire cleanup series, since `@operator-agent/core` is a dependency of every one of them.

**Tests removed/updated:** none — no test ever covered this file.

**What replaces it:** Agent Runtime v3 owns current normal-chat planning and its own types now — `apps/api/src/agent-runtime/types.ts` (`ContextBundle`, `PlannedOperation`, `ValidatedOperation`, `ExecutedOperation`, `AgentSessionState`, etc.) and `apps/api/src/agent-runtime/planner.ts`. These are an independent implementation, not descendants of the deleted `ConversationContext`/`ConversationOperationPlan` types — v3 was built from scratch specifically to avoid depending on v2's code, which is exactly what made this whole three-pass cleanup series (`apps/api/src/conversation/*` → `packages/llm/src/operation-planner.ts` → `packages/core/src/conversation-orchestrator.ts`) possible without touching v3 at all.

**What's unchanged:** `/agent/message`, Telegram normal chat v3, slash commands, `/messages/process` legacy behavior, Gmail OAuth/sync, pending-actions routes, every other `@operator-agent/core` consumer.

**Next cleanup target:** ~~the Gmail-rules... work already queued~~ — see "Gmail Rule Service Extraction" below, the first part of that queued work.

## Gmail Rule Service Extraction

**Goal:** identify and extract the Gmail rule-management helpers blocking a clean `pending-actions` extraction (per the Server.ts Map's queued order: Gmail-rules → action-hygiene → pending-actions), without touching OAuth, sync, token handling, or email review flows.

**Gmail code map in server.ts (before this pass):** ~90 Gmail-related functions spanning roughly lines 1200–13800, falling into four groups:
1. **OAuth/token/provider API** (`gmailOAuthConfig`, `buildGmailOAuthUrl`, `exchangeGmailOAuthCode`, `getValidGmailAccessToken`, `readGmailToken`, `searchGmailMessages`, `getGmailMessage`, etc., roughly lines 13190–13800) — untouched, out of scope per the task's explicit exclusions.
2. **Sync worker logic** (`syncGmailConnection`, `recordGmailBackgroundSyncAttempt`, roughly lines 11025–11200) — untouched, out of scope.
3. **Legacy conversation/semantic-router Gmail handlers** (`proposeCustomGmailRuleForConversation`, `editActiveCustomGmailRuleForConversation`, `manageCustomGmailRuleForConversation`, `resolveCustomGmailRulesForConversation`, `answerGmailRuleQuestionForConversation`, and ~15 more, roughly lines 6600–8480) — inspected and **not extracted**; see "What was intentionally NOT extracted" below.
4. **Pure rule-management** (grouping/formatting/listing rules, zero OAuth/sync/network dependencies) — this pass's actual target.

**What `applyPendingAction`'s Gmail branches (`custom_email_rule`, `gmail_autonomy_preference`) actually depend on, verified by reading the function body directly:** `archiveEmailSignalRule`, `createEmailSignalRule`, `getEmailSignalRules`, `getIntegrationConnection`, `updateIntegrationConnectionConfig` (all `@operator-agent/db`), `writeGmailAutonomyPreferences`, `buildGmailAutonomyState`, `formatIntervalMinutes` (all already-extracted `apps/api/src/conversation/gmail-autonomy.ts`), `normalizeForComparison` (server.ts-local, but generic — 59 call sites across goals/reflections/plans, not Gmail-specific), and exactly **one** server.ts-local, Gmail-specific helper: `formatGmailEmailRuleSelectionLines`. Everything else was already clean before this pass started — the real blocker was smaller than expected.

**Extraction boundary chosen:** `formatGmailEmailRuleSelectionLines` and its own dependency chain — `groupEmailRulesForHumanDisplay` → `emailRuleHumanDisplayKey` → `isBuiltInEmailAdapter` (+ `normalizeForComparison`) — plus `getVisibleGmailEmailRules` (a clean, zero-local-dependency "list active Gmail rules" helper matching the task's example responsibilities, safe to include even though `applyPendingAction` doesn't call it directly).

**Files created:**
- `apps/api/src/gmail/gmail-rule-service.ts`: `isBuiltInEmailAdapter`, `EmailRuleHumanDisplayGroup` (interface), `groupEmailRulesForHumanDisplay`, `formatGmailEmailRuleSelectionLines`, `getVisibleGmailEmailRules`. Depends only on `@operator-agent/db` (`EmailSignalRule`, `getEmailSignalRules`, `getIntegrationConnections`), the already-extracted `../conversation/email-rule-selection.js` (`sortEmailRuleCandidates`), and the new `../utils/text.js`. Zero dependency on server.ts — zero circular-import risk.
- `apps/api/src/utils/text.ts`: `normalizeForComparison`, moved rather than left behind (needed by `emailRuleHumanDisplayKey`) and rather than folded into the Gmail module (it's genuinely generic, used 58 more times in server.ts for unrelated comparisons) — same de-duplication pattern as `isRecord`→`utils/records.ts` and `shouldUseOpenAIAnalysis`→`utils/env.ts` in earlier server-cleanup phases.

**Call sites updated:** none needed syntax changes — every call site (`applyPendingAction`'s `custom_email_rule` branch; `manageCustomGmailRuleForConversation`'s two `formatGmailEmailRuleSelectionLines` calls; `formatGmailSetupForConversation`'s two `groupEmailRulesForHumanDisplay` calls; the email-rule-list conversation formatter's two more; the Gmail sync worker's one `isBuiltInEmailAdapter` call at line ~11136; the email-adapters listing route's one `isBuiltInEmailAdapter` call) resolve via the new imports with identical call syntax, exactly like the `isRecord`/`shouldUseOpenAIAnalysis` precedent. `normalizeForComparison`'s 58 other call sites likewise needed no changes.

**What was intentionally NOT extracted, and why:** the legacy conversation/semantic-router Gmail cluster (`resolveCustomGmailRulesForConversation`, `editActiveCustomGmailRuleForConversation`, `manageCustomGmailRuleForConversation`, `answerGmailRuleQuestionForConversation`, and their ~15-function support cluster). Inspected via `resolveCustomGmailRulesForConversation`'s own dependency chain: it needs `SemanticRouterResult` (the legacy semantic router's own type), pronoun resolution (`hasRulePronoun`), free-text target extraction (`extractGmailRuleQuestionTarget`, `extractLikelyRuleTargetsFromMessage`), and pending-action context matching (`getCustomGmailRuleContextMatches`) — this is natural-language *interpretation* tightly coupled to the legacy conversation layer, not pure rule management. Forcing this into a "rule service" would either drag the semantic-router types along (scope creep well beyond "pure rule-management logic only") or require a circular import back into server.ts for the NL-parsing pieces left behind. Consistent with the task's explicit instruction not to do a giant Gmail rewrite, this was left in place.

**`server.ts` line count:** 16,938 → **16,875** (−63).

**Tests added:** `tests/gmail-rule-service.test.ts` (6 tests) — `isBuiltInEmailAdapter` classification; `groupEmailRulesForHumanDisplay` dedup behavior (same-connection built-in duplicates collapse, different-connection built-ins stay separate, custom rules never merge with built-ins); `formatGmailEmailRuleSelectionLines` duplicate-count and status-flag formatting; `getVisibleGmailEmailRules` active-connection detection, the same duplicate-detection condition `applyPendingAction`'s `create_rule` branch uses, paused-rules-stay-visible/archived-rules-disappear behavior, and rules on an archived connection being hidden. All existing tests — including `tests/email-review-dedupe.test.ts`'s "custom Gmail tracking rules are confirmation-first and review-only" test, which already exercises the `applyPendingAction` create-rule pending-action flow end-to-end — pass unchanged, confirming no behavior drift.

**Is pending-actions now easier to extract?** Yes, for the Gmail side specifically — `applyPendingAction`'s `custom_email_rule` and `gmail_autonomy_preference` branches are now fully clean (zero server.ts-local dependencies). The **action-hygiene** branch (`applyActionHygieneBatchOperations`) was the sole remaining tangle blocking a full `pending-actions` extraction — **now resolved**, see "Action Hygiene Service Extraction" below.

**Next cleanup target:** ~~action-hygiene session creation/formatting~~ — done, see below. `pending-actions` itself is now the recommended next pass.

## Action Hygiene Service Extraction

**Goal:** extract the action-hygiene helpers blocking a clean `pending-actions` extraction (the second and final blocker after "Gmail Rule Service Extraction" above), without touching the legacy natural-language hygiene-reply parser.

**Action-hygiene code map in server.ts (before this pass):** ~25 functions across two zones — roughly lines 2586–2853 (session creation: candidate analysis, session storage, list/report formatting) and roughly lines 15343–16700 (the legacy pending-decision resolver: natural-language batch-reply parsing, confirmation formatting, and batch-operation execution).

**What `applyPendingAction`'s `action_hygiene` branch actually depends on, verified by reading the function body directly:** `readActionHygieneBatchOperations` (parses the stored payload into typed operations) and `applyActionHygieneBatchOperations` (executes them) — that's it. It does **not** call `analyzeActionHygiene`, `createActionHygieneSession`, `formatActionHygieneReport`, or any of the session-creation/candidate-analysis cluster; those are only reached from the `/action_hygiene` slash-command route and the (now-deleted) Conversation Orchestrator v2 callback. This matches the Gmail pass's pattern exactly: the real blocker was smaller than the full "action hygiene" surface area suggested.

**Extraction boundary chosen:** `readActionHygieneBatchOperations` and `applyActionHygieneBatchOperations`, plus their two currently-server.ts-local (but not hygiene-specific) dependencies: `createGoalProgressFromCompletedAction` (5 call sites — manual action-completion route, conversational action control, hygiene batches) and `formatLocalDateTime` (17 call sites — actions, email reviews, and more).

**Files created:**
- `apps/api/src/actions/hygiene.ts`: `HygieneOperation`, `ActionHygieneBatchOperation` (types — also needed by server.ts's remaining NL parser, so exported), `readActionHygieneBatchOperations`, `applyActionHygieneBatchOperations`. Depends only on `@operator-agent/db` (`getActionItem`, `archiveActionItem`, `completeActionItem`, `snoozeActionItem`), `../utils/records.js` (`isRecord`, already extracted), `../utils/datetime.js` (new), and `./goal-progress.js` (new). Zero dependency on server.ts.
- `apps/api/src/actions/goal-progress.ts`: `createGoalProgressFromCompletedAction`, moved as a sibling to `hygiene.ts` rather than into it — it's a general action-completion helper, not hygiene-specific, matching what it does rather than only its newest caller. Depends only on `@operator-agent/db` (`getGoals`, `createExternalEventIfNotExists`).
- `apps/api/src/utils/datetime.ts`: `formatLocalDateTime`, moved for the same reason `normalizeForComparison` moved in the Gmail pass — generic, 17 call sites, would otherwise need re-exporting from a domain-specific module.

**Call sites updated:** none needed syntax changes. Every caller (`applyPendingAction`'s `action_hygiene` branch; `resolveActionHygieneReply`'s batch-apply path, still in server.ts; the 5 `createGoalProgressFromCompletedAction` call sites; the 17 `formatLocalDateTime` call sites) resolves via the new imports with identical call syntax — same pattern as every prior extraction in this series.

**What was intentionally NOT extracted, and why:** the session-creation/candidate-analysis/list-formatting cluster (`analyzeActionHygiene`, `createActionHygieneSession`, `storeActionHygieneSession`, `analyzeActionHygieneItem`, `formatActionHygieneReport`, and their local helpers) and the legacy natural-language hygiene-reply parser (`resolveActionHygieneReply`, `planActionHygieneBatchReply`, `parseActionHygieneReply`, `normalizeHygieneBatchText`, and ~15 more). Both were inspected and found to depend on a wide layer of generic-but-currently-server.ts-local helpers used far beyond action hygiene: `getUserTimezone` (43 call sites across nearly every domain in the file), `pendingDecisionExpiry` (21 call sites — used by every pending-action type, not just hygiene), `toPendingActionCandidate` (5 call sites), `formatDateInTimezone` (11), `isSnoozedDue` (6), `daysBetween`/`daysBetweenLocalDates` (3 each), `goalPriorityRank` (6), `cleanupDecisionGrammar` (6). Extracting the session-creation cluster would mean also extracting or duplicating all nine of these — a materially bigger, higher-risk change than what was needed to unblock `pending-actions` (which never calls this cluster at all), and explicitly the kind of scope creep the task's "do not force extraction if risk is high" instruction warns against. The legacy NL parser is additionally tangled with the legacy semantic router, matching the same category of risk already declined in the Gmail pass.

**`server.ts` line count:** 16,875 → **16,727** (−148).

**Tests added:** `tests/actions-hygiene.test.ts` (6 tests) — `readActionHygieneBatchOperations` valid/invalid/incomplete-entry parsing and non-array input; `applyActionHygieneBatchOperations` archive/complete-with-goal-progress/snooze/keep behavior, skip conditions (action not found, already archived/completed, missing snooze time), and no-op input; an end-to-end HTTP test confirming an `action_hygiene` `batch_update` pending action still applies correctly through `POST /pending-actions/:id/confirm`. All existing tests pass unchanged, confirming no behavior drift.

**Is pending-actions now safe to extract?** Yes. `applyPendingAction`'s three previously-tangled branches (`custom_email_rule`, `gmail_autonomy_preference`, `action_hygiene`) are all fully clean now — every dependency is either an `@operator-agent/db` function or an already-extracted module (`conversation/gmail-autonomy.ts`, `gmail/gmail-rule-service.ts`, `actions/hygiene.ts`, `actions/goal-progress.ts`, `utils/*`). The one remaining structural fact to account for when extracting `pending-actions`: `applyPendingAction` is also called from deep inside the legacy `/messages/process` conversational confirmation flow (`resolveActionHygieneReply`'s batch-apply path shares the same underlying function, not a separate call to `applyPendingAction` itself) — so `applyPendingAction` is not *exclusively* used by the pending-actions route group, meaning the route-group extraction will need to either export `applyPendingAction` for server.ts to keep using internally, or leave it in server.ts and have the new route module import it (both are one-directional, non-circular options now that its own dependencies are clean).

**Next cleanup target:** ~~`pending-actions` route group extraction~~ — done, see below.

## Pending-Actions Route Extraction

**Goal:** extract the `pending-actions` route group itself — the final step in the chain that started with "Gmail Rule Service Extraction" and continued through "Action Hygiene Service Extraction," both of which existed specifically to make this extraction safe.

**Routes extracted (paths, request/response shapes, and status codes unchanged):**
- `GET /users/:userId/pending-actions`
- `POST /users/:userId/pending-actions/:pendingActionId/confirm`
- `POST /users/:userId/pending-actions/:pendingActionId/reject`

**Helpers moved alongside the routes:** `applyPendingAction` (~345 lines, the full pending-action-type switch) and `findPendingAction` (small, exclusively used by the confirm route). Re-verified `applyPendingAction`'s complete dependency list by reading the function body fresh, not trusting the prior passes' summaries: every dependency was confirmed to be either an `@operator-agent/core`/`@operator-agent/db` import, or an already-extracted module (`conversation/gmail-autonomy.ts`, `gmail/gmail-rule-service.ts`, `actions/hygiene.ts`) — **except** three more generic-but-still-server.ts-local helpers found during this final pass: `arrayOfStrings` (20 call sites, not pending-actions-specific), `getUserTimezone` (43 call sites — the single most widely-shared helper de-duplicated in this entire cleanup series), and `createCustomGoalProgressEvent` (used by the `goal_progress_log` branch plus 2 other call sites). All three got the same treatment as every generic helper before them in this series — moved to small shared modules rather than duplicated or left blocking the extraction.

**Files created:**
- `apps/api/src/routes/pending-actions.ts`: `registerPendingActionRoutes(server)`, `applyPendingAction` (exported — see below), `findPendingAction` (private). Depends only on `@operator-agent/core`, `@operator-agent/db`, and already-extracted modules (`conversation/gmail-autonomy.ts`, `gmail/gmail-rule-service.ts`, `actions/hygiene.ts`, `actions/goal-progress.ts`, `utils/records.ts`, `utils/text.ts`, `utils/arrays.ts`, `utils/user-timezone.ts`). Zero dependency on server.ts.
- `apps/api/src/utils/arrays.ts`: `arrayOfStrings`.
- `apps/api/src/utils/user-timezone.ts`: `getUserTimezone`.
- `apps/api/src/actions/goal-progress.ts` gained a second export: `createCustomGoalProgressEvent`, alongside the existing `createGoalProgressFromCompletedAction` (same "create a goal progress event" domain, different trigger).

**Why `applyPendingAction` is exported (not fully private) — the one place this extraction differs from every prior one:** every previous extraction in this series moved code that was exclusively used by what was being extracted. `applyPendingAction` isn't — it's also called from `server.ts`'s legacy `/messages/process` pending-decision resolver (the "say yes to confirm" natural-language path, inside `resolvePendingDecisionReply`). That call site stays in `server.ts` and now imports `applyPendingAction` from `./routes/pending-actions.js`. This is one-directional (`server.ts` → the new route module) and therefore not circular — the route module itself has zero import from `server.ts`. This was flagged as the one open structural question in the "Action Hygiene Service Extraction" report above, and is resolved exactly as anticipated there.

**Call sites updated:** none needed syntax changes. `server.ts`'s `resolvePendingDecisionReply` calls `applyPendingAction(...)` exactly as before, now resolved via import. The three route handlers moved verbatim.

**Agent Runtime v3 legacy `PendingAction` interop — explicitly verified unchanged.** This extraction touches exactly the function (`applyPendingAction`) that v3's interop (`apps/api/src/agent-runtime/runtime.ts`, see "PendingAction / Agent Runtime v3 Interop" above) deliberately avoids calling — v3 detects a legacy `PendingAction`, defers exact-confirm messages to `/confirm`, and safely cancels via the plain `rejectPendingAction` DB call, but never executes `applyPendingAction` itself, regardless of where that function lives. Moving it doesn't change that boundary. All 6 tests in `tests/agent-runtime-legacy-pending-action.test.ts` pass unchanged, including the one that hits the pending-actions HTTP routes directly to confirm slash-command behavior is unaffected.

**`server.ts` line count:** 16,727 → **16,289** (−438 — the largest single-pass reduction in this cleanup series, since `applyPendingAction`'s ~345-line body made up most of it).

**Tests added:** `tests/routes-pending-actions.test.ts` (8 tests) — `GET` lists pending actions; `custom_email_rule` `create_rule` confirmation creates a Gmail rule; `gmail_autonomy_preference` confirmation updates connection config; `action_hygiene` `batch_update` confirmation applies the batch; `action_target_clarification` pending actions are refused with 400 and never executed; reject clears a pending action without applying its effect; missing-pending-action 404s for both confirm and reject; confirming an already-confirmed pending action 404s (since `findPendingAction` only matches `status: "pending"`). All 224 tests pass (216 existing + 8 new), including the full `tests/email-review-dedupe.test.ts` suite and `tests/agent-runtime-legacy-pending-action.test.ts`, confirming no behavior drift anywhere in the confirm/reject flow.

**What remains in `server.ts`:** the legacy conversation/semantic-router Gmail NL cluster, the action-hygiene NL reply parser/session-creation cluster, planning session handlers, Gmail OAuth/token/sync/provider-API code, and the inline `/messages/process` handler body — none of which were in scope for this three-pass chain (Gmail rule service → action hygiene service → pending-actions), and none of which this pass touched.

**Next cleanup target:** no single blocker remains from the pending-actions chain. The next candidates, in the order already recommended in the Server.ts Map above: the legacy Gmail rule NL cluster, then the action-hygiene NL parser/session cluster, then planning session handlers — each independently scoped, none required by anything else in this series. `/messages/process`'s own inline handler bodies remain the least safe candidate in the file.

## Migration Rule

When moving a legacy surface into v3 (Conversation Orchestrator v2 is retired — this rule now targets Agent Runtime v3's tool catalog, not v2's operation catalog):

1. Add a tool definition to `apps/api/src/agent-runtime/tool-catalog.ts`.
2. Add deterministic validation in `apps/api/src/agent-runtime/validator.ts`.
3. Add a deterministic executor case in `apps/api/src/agent-runtime/executor.ts`.
4. Add debug assertions proving `plannerUsed`, `mutationExecuted`, and `legacySemanticUsed` (still exposed by the legacy `/messages/process` routeDebug contract) so a migrated scope's parity with legacy is provable in tests, not assumed.
5. Keep the legacy fallback in `/messages/process` until tests prove v3 parity for that scope.
6. Update `README.md`, `docs/01-system-architecture.md`, `docs/05-agent-behavior.md`, `docs/07-implementation-status.md`, and `docs/08-product-capability-audit.md`.
