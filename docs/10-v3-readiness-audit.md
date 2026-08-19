# Agent Runtime v3 — Global Readiness Audit

Audit date: 2026-08-19. Scope: everything Agent Runtime v3 can and cannot do end-to-end through normal Telegram chat, as of the Daily-Loop Settings V3 Migration (the sixth capability-migration pass — see `docs/09-architecture-inventory.md`'s per-capability migration sections). This is an audit + test-expansion pass only: no product behavior changed, no legacy code deleted. Sources: `apps/api/src/agent-runtime/{tool-catalog,validator,executor,planner,runtime,response-composer}.ts`, `apps/telegram-bot/src/{index,agent-runtime-routing}.ts`, `apps/api/src/server.ts`, `apps/api/src/legacy/*`, `docs/09-architecture-inventory.md`, and every `tests/agent-runtime-*.test.ts` file.

## 1. Capability matrix

"Tests" values: **unit** = a dedicated `tests/agent-runtime-*.test.ts` file, **scripted** = covered by a `tests/agent-runtime-scripted-smoke.test.ts` scenario, **none** = no Agent Runtime v3 test exists. No capability in this table has been smoke-tested against a real, live Telegram bot — every test listed runs through `server.inject("/agent/message")`, the same HTTP surface Telegram calls, but not an actual Telegram conversation.

| Capability | V3 chat | Legacy | Slash cmd | Tests | Mutates | Confirmation | User-ready | Notes/gaps |
|---|---|---|---|---|---|---|---|---|
| Memory save/recall | Yes | Yes | Yes (`/memory`, `/remember`, `/forget_memory`) | scripted (5, 9) | `memory.create` yes / `memory.search` no | No | **Yes** | Recall is grounded — verified a saved memory is retrievable by a later, differently-worded question. |
| Goals list (read-only) | **Yes** (closed — see §11) | Yes | Yes (`/goals`) | unit (7) + scripted (10) | No | No | **Yes** | `goal.list` shows real active goal titles/category/priority/why. See §11. |
| Goals create/update/delete | **No** (by design) | Yes | Yes (`/create_goal`, `/goal_priorities`, ...) | unit (7) + scripted (10) | n/a | n/a | **N/A — honestly declined** | Deliberately still not built (this task explicitly scoped to listing only). The planner now explains this honestly instead of silently substituting `memory.create` — see §11. Progress logging (CVs sent, workouts) still works via `event.log_*`, still not tied to a specific goal record. |
| Actions create/list/complete/snooze/archive | Yes | Yes | Yes (`/action`, `/actions`, `/complete_action`, ...) | scripted (4, 11) | Yes (except list) | No | **Yes** | Full CRUD works; unresolved references ("mark it done" with no id) resolve against the single visible action entity, or ask for clarification if 0 or 2+ match. |
| Reminders (distinct from actions) | n/a | n/a | n/a | n/a | n/a | n/a | n/a | No distinct Reminder concept exists anywhere in the system — "reminder" is UI copy for action due dates and daily-loop nudges. `ActionItemReminderLog` is an internal notification-dedup log, not a user-facing object. Not a gap; there is nothing to migrate. |
| Event logging/progress logging | Yes | Yes | Yes (`/log_progress`, `/events`) | scripted (10) | Yes | No | **Yes** | `event.log_job_applications`/`log_workout`/`log_custom_progress`. |
| Today/operator summary | Yes | Yes | Yes (`/today`, `/review`) | scripted (1, 5, 6, 11) | No | No | **Yes** | Reports open-task count, due-today count, active-goal count, pending-Gmail-review count — all real, no invented figures. |
| Action hygiene | Yes | Yes (still, unmigrated free-text parser) | Yes (`/action_hygiene`) | unit (11) + scripted (4) | Yes (apply) | No (numbered-list resolution instead) | **Yes** | Migrated in an earlier pass; legacy's own free-text parser still backs the slash command. |
| Next-week planning | Yes | Yes | Yes (`/plan_next_week`) | unit (35) + scripted (1, 2, 3) | Yes (apply) | Yes (propose → edit → confirm loop) | **Yes** | Largest and most-tested capability. |
| Weekly review | Yes | Yes | Yes (`/weekly`, `/weekly_last`) | unit (9) + scripted (6) | Yes (save) | Yes | **Yes** | |
| Gmail status/rule listing | Yes | Yes | Yes (`/my_email_rules`) | scripted (5, 7) | `rule.create` yes | `rule.create` yes | **Yes** | |
| Gmail rule pause/resume/archive | Yes | Yes (immediate, no confirm) | Yes (`/pause_email_rule`, ...) | unit (11) + scripted (7) | Yes | Yes | **Yes** | V3 deliberately requires confirmation where legacy doesn't — a safety tightening, not a gap. |
| Gmail reviews/inbox listing | **Yes** (closed — see §10) | Yes | Yes (`/email_reviews`) | unit (11) + scripted (12) | No | No | **Yes** | Originally partial (historical record above superseded). Closed in a follow-up pass: `planner.ts` now has explicit guidance, and the summary is itemized with real subject/sender/snippet, not a bare count. See §10. |
| Email-review → action conversion | **Yes** (closed — see §10) | Yes (`/approve_email_review`) | Yes | unit (11) + scripted (12) | Yes | No | **Yes** | Originally partial. Closed via deterministic index/ref resolution against visible `gmail_review` entities — see §10. |
| Daily-loop settings | Yes | Yes (immediate, no "off" support) | Yes (`/daily_loop_settings`, `/set_daily_loop`) | unit (10) + scripted (8) | Yes | Yes | **Yes** | Most recently migrated capability (this session, prior pass). |
| Guardrails/risk responses | **Yes** (generic, goal-aligned — see §9) | Yes (hard-coded, gambling/trading-only, LLM-classified) | n/a | unit (10) + scripted (13, 14, 15) | `memory.create` (risk log) only | n/a | **Yes** | Originally the headline gap in this audit (§5, preserved below as historical record). Closed in a follow-up pass by a generic goal/guardrail conflict engine (`apps/api/src/agent-runtime/goal-guardrails.ts`) — not a port of legacy's gambling-specific classifier. See §9. |
| Onboarding/help/setup | **No** | Yes | Yes (`/start`, `/setup`, `/help`) | none via `/agent/message` | n/a | n/a | n/a (covered elsewhere) | Not reachable via V3 chat at all; fully served by dedicated onboarding routes and `/help` (which itself calls `/messages/process`, not V3). Not a blocker — slash commands and first-run onboarding already cover this need without V3's involvement. |
| Proactive behavior | **No** | No | n/a | n/a | n/a | n/a | n/a | Does not exist anywhere in the system yet — confirmed by this audit's own tool-catalog/routing sweep finding zero push-initiated code paths. This is the explicitly-planned next phase this audit exists to gate. |

## 2. Routing reality

**Default Telegram normal-text path (no env vars set):** `bot.on("message:text", ...)` (`apps/telegram-bot/src/index.ts:2065-2093`) calls `isLegacyTelegramChatEnabled()` (`agent-runtime-routing.ts:41-43`), which is `true` only when `TELEGRAM_AGENT_RUNTIME_V3_ENABLED === "false"` exactly. Unset, or set to anything else (including `"true"`), routes to `routeToAgentRuntimeV3(...)` (`index.ts:2077-2092`), which POSTs to `/agent/message`.

**`TELEGRAM_AGENT_RUNTIME_V3_ENABLED=true`:** identical to unset — no behavioral difference.

**`TELEGRAM_AGENT_RUNTIME_V3_ENABLED=false`:** `routeToLegacyMessageProcessor(ctx)` (`index.ts:1997-2063`) runs multi-intent → daily-checkin → ingest-text → `conversation/control` first, falling through to `POST /messages/process` (`index.ts:2054-2057`) only if nothing else claims the message.

**Is `/messages/process` still used by default Telegram traffic?** Yes, in three narrow places even with v3 enabled: the `/help` command calls it directly (`index.ts:136`); a pending-decision-with-trailing-command middleware calls it unconditionally regardless of the v3/legacy flag (`index.ts:55`); and `createManualActionFromCommand` (backing `/action`, `/todo`, `/add_action`) routes risky/gambling-sounding text through it specifically to reuse legacy's risk classifier (`index.ts:3818`) before creating a manual action from a slash command.

**Every slash command (105 registered, `index.ts:96-1965`)** calls a dedicated `/users/:id/...` API route, not `/agent/message` and (with the three exceptions above) not `/messages/process` either. Full one-line-per-command list is in the raw audit research; the pattern is consistent: memory/reflections/notifications/goals/integrations/actions/events/checkins/pending-actions each have their own route, several of which (`/actions/hygiene`, `/weekly-review*`, next-week-plan, Gmail email-rules) still call into `apps/api/src/legacy/*` server-side.

**Remaining live imports of `apps/api/src/legacy/*`** (all from `apps/api/src/server.ts` unless noted): `daily-conversation.ts` (onboarding routes + `messages-process.ts`), `messages-process.ts` (the `/messages/process` handler itself), `action-hygiene-conversation.ts` (`/actions/hygiene` route + `messages-process.ts`), `planning-conversation.ts` (next-week-plan route + `messages-process.ts`), `weekly-review-conversation.ts` (`/weekly-review*` route, `planning/next-week.ts`, `operator/attention.ts`, `messages-process.ts` — already a thin re-export shim from an earlier migration pass), `email-review-conversation.ts` (**only** `messages-process.ts` — the dedicated `/email-reviews*` routes use the separate, non-legacy `email-review-service.ts` instead), `gmail-conversation.ts` (Gmail email-rule slash routes + `messages-process.ts`). No legacy module is currently unreferenced by any live route.

## 3. Scripted smoke suite (expanded)

13 scenarios total in `tests/agent-runtime-scripted-smoke.test.ts` (8 existing + 5 new this pass), covering all ten lettered flows (A–J) from the audit brief:

| Letter | Flow | Scenario(s) |
|---|---|---|
| A | Memory save + recall | 9 (new) |
| B | Goals/progress | 10 (new — documents the goal-listing gap) |
| C | Action CRUD | 11 (new) |
| D | Action hygiene | 4 (existing) |
| E | Next-week planning | 1, 2, 3 (existing) |
| F | Weekly review | 6 (existing) |
| G | Gmail rule management | 7 (existing) |
| H | Gmail reviews / email-to-action | 12 (new — proves the tool mechanics work via a direct mocked plan, documents the missing planner guidance) |
| I | Daily-loop settings | 8 (existing) |
| J | Guardrails | 13 (new — proves both the no-trigger gap and the configured-trigger hard-block) |

All scenarios assert (via the shared `tests/helpers/agent-runtime-scripted-eval.ts` harness): no generic Agent v3 error, no false pre-execution success claims, no mutation before an explicit "yes" where confirmation is required, `pendingOperation`/`visibleEntities` staying in sync turn-to-turn, and final DB state matching the reply's claim. Full suite: **313/313 passing** (297 before this pass + 5 daily-loop-settings scripted/unit tests already landed + 5 new scenarios × ~1 test each — see validation section for the exact breakdown).

## 4. Real-LLM local eval mode

CI stays fully deterministic — every scripted turn above sets an explicit `plan` field, which `mockPlan()` (`tests/helpers/agent-runtime-test-helpers.ts:34`) writes to `AGENT_RUNTIME_PLANNER_MOCK_RESPONSE`, so no network call happens and nothing depends on `OPENAI_API_KEY` in CI.

To run the same conversational shapes against the **real** LLM locally: write (or temporarily edit) a `ScriptedTurn` with **no `plan` field**. `runScriptedScenario` (`tests/helpers/agent-runtime-scripted-eval.ts:97-100`) only calls `mockPlan()` `if (turn.plan)` — omit it, and `planner.ts`'s real `planMessage` runs, which calls the OpenAI API when `OPENAI_API_KEY` is set in your shell, or falls back to the deterministic heuristic planner otherwise (`planner.ts:39-40`, `heuristicPlan`). Concretely:

```bash
export OPENAI_API_KEY=sk-...
export DATABASE_URL=postgresql://postgres:postgres@localhost:5432/alecto_ai?schema=public
pnpm exec tsx --test tests/agent-runtime-scripted-smoke.test.ts
```

Do this on a **copy** of a scenario (e.g. duplicate scenario 9's turns without their `plan` fields) rather than editing the checked-in file permanently — the checked-in scenarios must keep their `plan` fields so CI stays deterministic. No test file changes were needed to enable this; the hook already existed before this pass, just undocumented and unused.

## 5. Guardrails — the headline finding (historical — see §9 for the closed-gap follow-up)

`checkPolicyGuardrail` (`apps/api/src/agent-runtime/validator.ts:22-37`) is deliberately generic and data-driven: it only matches the user's own `UserOperatingProfile.knownTriggers`/`knownFailureModes` (both empty by default), and is checked in `runtime.ts:215-227` **before** the planner runs — if triggered, it returns a fixed "let's slow down and talk it through first" reply, plans and executes nothing.

Legacy has a **separate, more sophisticated, hard-coded mechanism** that V3 does not share at all: `packages/core/src/message-processing.ts:411-422` classifies `betting_intent`/`trading_intent` with an LLM-derived `riskState` (RED/ORANGE/GREEN) and, on RED, returns a hard "No. Hard stop." refusal — escalated further when the profile's distinct `gamblingGuardrails` field (default `"strict"`, escalatable to `"hard_guardian"`) is set. This is real, currently-live behavior — it's why `/action`/`/todo`/`/add_action` still route risky-sounding text through `/messages/process` even with v3 chat otherwise enabled (`apps/telegram-bot/src/index.ts:3818`).

**Net effect (at the time of the original audit):** a user typing "I want to bet €1000 because it feels safe" into normal V3 chat got **no special handling at all** unless they had already, separately, configured "bet"/"gambling" as a `knownTrigger` — something no default user would have done. **This is now closed — see §9.** The product decision was explicitly *not* to port legacy's `betting_intent`/`trading_intent` classifier; instead V3 gained a generic goal-conflict engine that treats "stop gambling" as just one instance of a user-authored goal, no different from "quit smoking" or "train 3x/week."

## 6. Deletion/migration candidates

No legacy module is currently orphaned — every file under `apps/api/src/legacy/` is imported by at least one live route (§2). Nothing was deleted in this pass, per the task's explicit instruction.

**Legacy capabilities fully replaced by V3 (conversationally), but files still load-bearing for other reasons:**
- `action-hygiene-conversation.ts`'s free-text parser — superseded conversationally by `action.hygiene_apply`, but its file/route still backs `/action_hygiene`.
- `planning-conversation.ts`'s opt-in-create parser — superseded conversationally, still backs `/plan_next_week`.
- `weekly-review-conversation.ts` — already a thin re-export shim from an earlier pass; its real logic lives in non-legacy `weekly-review/{context,review}.ts`. This file itself (not its logic) is close to deletable — the remaining callers (`server.ts`'s `/weekly-review*` route, `planning/next-week.ts`, `operator/attention.ts`, `messages-process.ts`) could plausibly import the non-legacy modules directly instead of through this shim.

**Legacy capabilities still genuinely needed by slash commands (not just interop):**
- `gmail-conversation.ts` (Gmail email-rule slash routes have real, non-duplicated logic there).
- `daily-conversation.ts`'s onboarding pieces (no V3 or other non-legacy equivalent exists for first-run onboarding).

**Legacy capabilities only reachable via `TELEGRAM_AGENT_RUNTIME_V3_ENABLED=false` or `/messages/process`'s narrow remaining callers:**
- `email-review-conversation.ts` — its only live caller is `messages-process.ts` itself; the dedicated `/email-reviews*` routes already use the separate `email-review-service.ts`. V3's Gmail-review capability has now moved from "partial" to "yes" (§1, §10), so the remaining blocker for deleting this file is purely the legacy-fallback flag/`/messages/process`'s other callers, not a V3 capability gap anymore.
- `messages-process.ts` itself — cannot be deleted while `TELEGRAM_AGENT_RUNTIME_V3_ENABLED=false` remains a supported escape hatch, and `/help` depends on it. Its gambling/trading-specific risk classifier (`packages/core/src/message-processing.ts`) is now **product-superseded**, not just technically-superseded, by V3's generic goal/guardrail engine (§9) — the plan is not to port it, so this is no longer a reason to keep the file, though the flag/`/help` dependencies still are.

**Candidates to keep as admin/fallback indefinitely:** `messages-process.ts` (as the `TELEGRAM_AGENT_RUNTIME_V3_ENABLED=false` escape hatch) and `gmail-conversation.ts`/`daily-conversation.ts`'s slash-command-serving pieces (no reason to touch working, still-used code paths).

## 7. Early-user readiness verdict

**What Alecto can safely do now, in normal V3 chat:** save/recall memories; log progress and events; full action CRUD plus action-hygiene cleanup; the complete next-week planning propose → edit → confirm loop; weekly review show/save; Gmail connection status, rule listing/creation/pause/resume/archive; daily-loop settings show/change; itemized Gmail review triage (list → convert to action / reject by natural reference, as of §10); real, grounded active-goal listing (as of §11); and, as of the §9 follow-up, intervene when a message conflicts with a goal or configured trigger the user has actually set. All of the above are tested (unit and/or scripted), require confirmation where they mutate meaningfully, and never fabricate facts in their grounded replies.

**What it should not promise yet:** creating/editing/deleting goals via chat (deliberately still unbuilt — §11 closes only the listing/honesty half, and the planner now says so explicitly rather than silently substituting a memory); onboarding/help guidance through normal chat (still slash/legacy-route only, which is fine, just don't imply chat covers it); any proactive/unprompted behavior (doesn't exist yet, by design); any Gmail send/reply/label/mailbox mutation of any kind (still, deliberately, entirely unsupported); and — important nuance from §9 — any protection at all for a risk the user has never named as a goal or trigger. Alecto does not, and by design should not, guess at unstated risks.

**Biggest risks for user testing:**
1. **Guardrail coverage depends entirely on the user having a relevant goal or trigger already set.** A brand-new user with no goals configured gets zero intervention for anything, by design (§9) — this is a deliberate product stance ("Alecto should not pretend to enforce a goal the user never set"), but it means the guardrail engine provides no baseline safety net for a user who hasn't yet told Alecto what to watch for. Worth deciding explicitly whether onboarding should prompt new users to set at least one guardrail-relevant goal.
2. **Ambiguous Gmail-review references collapse to one generic clarification message.** `resolveGmailReviewRef` (§10) can't distinguish "zero matches" from "multiple matches" the way `gmail.rule.propose_update` does — both are safe (never mutate), but the wording is less specific than users may expect.
3. **No goal creation via chat at all, only an honest decline.** A user who says "create a goal to run a marathon" gets a clear, correct "not wired yet, use /create_goal" — this is the intended, safe behavior, not a bug, but it's worth confirming product is fine shipping this level of friction rather than wiring minimal creation next.

**Top 3 blockers before external users:**
1. Decide and, if needed, build an onboarding nudge toward setting at least one guardrail-relevant goal/trigger, given §9's guardrail engine only ever protects against risks the user has explicitly named — this is now the single biggest lever for closing the "zero protection for a fresh user" gap.
2. Consider whether Gmail-review ambiguous/unknown-reference clarification wording (§10) is worth sharpening before wide release — currently safe but generic.
3. Decide whether minimal goal creation (reusing the already-clean `createGoal` service — see §11) is worth adding before external users, given how often "create a goal to X" is likely to come up once goal.list makes goals a visible, discussed part of the conversation.

**Top 3 product improvements after baseline:** proactive operator behavior (the next planned phase, which this audit exists to gate); the onboarding guardrail-goal nudge from blocker #1; minimal goal creation via chat, once product decides the honest-decline friction from §11 is worth removing.

## 8. Validation

`pnpm typecheck` ✅ · `pnpm build` ✅ · `pnpm test` — **313/313** ✅ (308 before this pass + 5 new scripted scenarios) · `git diff --check` ✅. No product code changed in this pass — only test files and documentation. (Superseded by §9 and §10's own validation for their respective follow-up passes.)

## 9. Follow-up: generic goal/guardrail engine (implemented)

A separate follow-up task closed §5's headline gap — deliberately **not** by porting legacy's hardcoded `betting_intent`/`trading_intent` classifier, but by building a domain-agnostic goal-conflict engine: `apps/api/src/agent-runtime/goal-guardrails.ts`. Product direction: Alecto should have no special-cased "gambling" or "financial" logic anywhere — a "stop gambling" goal, a "quit smoking" goal, and a "train 3x/week" goal are all just user-authored `Goal` rows, and the exact same code classifies conflicts against any of them.

**Design — two tiers, run before the planner (`runtime.ts`), replacing the old `checkPolicyGuardrail`:**
- **Tier 1 (deterministic, no LLM):** literal `UserOperatingProfile.knownTriggers`/`knownFailureModes` substring matching — the exact backward-compatible mechanism from before this pass, now living in `goal-guardrails.ts` instead of `validator.ts`. If a matching active goal shares vocabulary with the trigger phrase, the reply names that goal; otherwise it falls back to the same generic phrasing as before.
- **Tier 2 (LLM, optional/mockable, only runs when Tier 1 found nothing and the user has ≥1 active goal):** classifies the message against the user's own active goals **only** (id/title/why — nothing else, and the prompt explicitly forbids inventing a goal not in that list) into `none` / `soft_warn` / `hard_block` / `ask_clarification`, plus a `pattern` (`active_violation`, `avoidance`, `lapse_admission`). Mocked in tests via `AGENT_RUNTIME_GUARDRAIL_MOCK_RESPONSE` (mirrors the existing `AGENT_RUNTIME_PLANNER_MOCK_RESPONSE` pattern), so CI has zero `OPENAI_API_KEY` dependency — with neither a key nor a mock set, Tier 2 is skipped entirely and the turn defaults to `allow`, which is also why every pre-existing test that happens to seed goals (e.g. next-week-planning's tests) was completely unaffected by this change.
- A returned `goalId` is **never trusted blindly** — it's checked against the actual list of goals passed to the classifier; an invented or mismatched id collapses back to `allow` rather than blocking on a goal that doesn't exist (unit-tested explicitly).
- Reply text is a small set of deterministic templates parameterized by goal title + pattern + the user's own `directness` profile field (blunter phrasing at `directness >= 4`, softer otherwise) — never raw LLM prose, consistent with this codebase's established "LLM proposes, deterministic code composes the grounded reply" rule.
- On `hard_block`/`soft_warn`, the conflict is logged as a `risk_pattern` memory via the existing `createMemory`/`memory.create` mechanism (already read by `insights.ts`/`daily-review.ts`) — no new schema, and the LLM never touches the DB itself; the deterministic runtime code decides whether/what to log after classification.

**Examples now supported, all via the same code path:** "Stop gambling" + "I want to bet 1000 because it's safe" → hard block naming the goal. "Improve financial discipline" + an impulsive-purchase message → hard block naming that goal. "Find a new developer job" + browsing cars instead of applying → soft-warn accountability nudge. "Train 3x/week" + "I skipped gym again" → supportive lapse acknowledgment, not a hard stop. "I want to control my gambling impulses" against the same "Stop gambling" goal → correctly let through as supportive, not treated as the violation. No goal/trigger relevant → normal chat, untouched.

**Tests:** `tests/agent-runtime-goal-guardrails.test.ts` (new, 10 tests, covering exactly the A–H scenarios this follow-up task specified, plus invented-goalId and ask_clarification edge cases) + 3 rewritten/added scripted-smoke scenarios (13: cessation-goal hard-block + supportive follow-up + risk-memory logging; 14: pursuit-goal avoidance; 15: trigger-only path with no goal, confirming Tier 1 still works standalone) + one pre-existing test in `tests/agent-message.test.ts` updated in place, since it asserted the *old* "no mutation" guardrail behavior, which the new risk-logging behavior intentionally changes. Full suite: **325/325** (313 before this follow-up + 10 unit + 2 net-new scripted scenarios).

**Validation:** `pnpm typecheck` ✅ · `pnpm build` ✅ · `pnpm test` (325/325) ✅ · `git diff --check` ✅.

**Remaining, intentional gap:** if the user has no relevant goal or configured trigger, Alecto does not intervene — by design, per explicit product direction ("Alecto should not pretend to enforce a goal the user never set"). This means guardrail coverage is only as good as the goals/triggers a user has actually set, which is a meaningfully different (and more honest) safety posture than legacy's blanket gambling/trading detection, but is not a substitute for it for a user who hasn't configured anything yet — see the updated readiness verdict (§7) for the resulting risk and blocker.

## 10. Follow-up: Gmail review triage reachable via normal chat (implemented)

Closes §1's other originally-partial capability: `gmail.review.list`/`reject`/`to_action` were already fully wired mechanically but unreachable by a real LLM turn. No Gmail OAuth/callback/sync/provider code was touched, and no send/reply/label capability was added — this pass only makes the existing, already-DB-only mutations (reject/to_action) actually reachable through normal chat.

**Planner guidance:** `planner.ts`'s system prompt now has an explicit bullet (previously zero) teaching when to plan all three tools, covering "what emails need my attention?", "what Gmail reviews are waiting?", "show pending email reviews", "anything important in Gmail?" (→ `gmail.review.list`), "turn the recruiter one into a task"/"make the recruiter email an action"/"create an action from the email about X" (→ `gmail.review.to_action`), and "reject/ignore the Endesa one" (→ `gmail.review.reject`) — explicit that both mutating tools reference the most recently shown list by `index` or `ref`, never inventing a `reviewId`.

**Itemized list:** `gmail.review.list`'s summary changed from a bare count ("N email review(s).") to a numbered, grounded list (`apps/api/src/email-reviews/email-review-service.ts`'s new `formatGmailReviewListForChat`/`gmailReviewChatLabel`/`gmailReviewChatDescription`) — each line is the review's own real subject (or sanitized sender, or tracking-rule name as a last resort) plus a safely truncated snippet/evidence excerpt, never an invented summary. Reuses the same non-legacy service module the dedicated `/email-reviews` HTTP route already depends on (`extractSafeSenderLabel`/`truncatePlainText` for PII-safety and length limits), rather than duplicating formatting logic. Each listed item is stored as a `gmail_review`-type visible entity with a 1-based `index`, matching the pattern established for action-hygiene lists.

**Follow-up resolution:** `gmail.review.reject`/`gmail.review.to_action` gained optional `index`/`ref` args (alongside the pre-existing `reviewId`, now optional). A new `resolveGmailReviewRef` in `validator.ts` resolves these **synchronously against `context.session.visibleEntities`** — never a fresh DB lookup (unlike `gmail.rule.propose_update`, since a review's identity here is only meaningful in the context of "the list you just showed me") and never hidden LLM memory. An explicit numeric `index` always wins; free-text `ref` is resolved via `selectEmailRuleCandidate` (`apps/api/src/conversation/email-rule-selection.ts`) — the exact same exact-name/token-overlap/ordinal matcher legacy's own numbered Gmail-rule-selection flow already relies on, reused as-is rather than writing a third near-duplicate fuzzy matcher. Zero or multiple matches both resolve to `needs_clarification` with no mutation; a returned candidate id is always a real visible entity's id, never invented. No review list shown yet in the conversation also asks for clarification rather than guessing.

**A real bug found and fixed during this pass:** `runtime.ts`'s `applyExecutionSideEffects` replaces the *entire* `visibleEntities` list with whatever the current turn's own executed op returns. `gmail.review.to_action`/`gmail.review.reject`'s first draft only returned the entity for the thing that turn changed (the new action, or nothing), which silently wiped visibility of any *other* still-pending review — breaking a very next "reject the other one" that doesn't re-list first. Fixed by having both tools re-fetch and re-include the remaining pending reviews (re-numbered) in their own `entities` array. Caught by the scripted scenario below, which chains exactly that sequence.

**Action conversion (`gmail.review.to_action`):** now calls the existing `createActionItemFromEmailReview` service function (same one the dedicated `/email-reviews` route uses) instead of a bespoke inline action-input construction — this adds real title generation (`buildActionTitle`, extracting an action phrase from the subject/body rather than just reusing the raw subject) and goal-linking, matching "preserve existing service behavior" rather than diverging from it. Still approves the review and links `actionItemId` afterward, unchanged.

**Reject (`gmail.review.reject`):** now calls the existing `rejectEmailReviewForUser` service function, which reports an honest "already X" message if the review was already decided rather than falsely claiming a fresh rejection. Confirmed no mailbox mutation of any kind — both functions only ever write to `EmailReviewItem`/`ActionItem` rows.

**Response grounding:** both mutating tools were added to `response-composer.ts`'s `GROUND_TRUTH_ONLY_TOOLS`, so the reply always states exactly what was created/rejected from the executor's own deterministic summary — never the planner's pre-execution `replyDraft` — matching every other confirm-whitelist/ground-truth-bearing mutating tool in the codebase.

**Tests:** `tests/agent-runtime-gmail-review-triage.test.ts` (new, 11 tests — itemized listing, visible-entity storage with indexes, ref-based resolution for both to_action and reject, index-based resolution, ambiguous and unknown references both asking clarification with zero mutation, no-list-shown-yet clarification, honest empty state, and direct-reviewId passthrough) + scripted-smoke scenario 12 rewritten to the exact triage flow this task specified (seed two reviews → list → convert one by ref → reject the other by ref → list again, asserting the final list reflects real DB state and no legacy Gmail setup wall ever appears). All existing tests, including Gmail rule management, planning, action hygiene, weekly review, daily-loop settings, and the goal-guardrail engine, pass unchanged. Full suite: **336/336** (325 before this follow-up + 11 new unit tests, scenario 12 rewritten in place).

**Validation:** `pnpm typecheck` ✅ · `pnpm build` ✅ · `pnpm test` (336/336) ✅ · `git diff --check` ✅.

**What remains unsupported, unchanged:** Gmail send/reply/label/archive/delete or any other mailbox mutation — no tool, no code path, anywhere in V3 does this, and this pass added none. Ambiguous/unknown Gmail-review references still collapse to one generic clarification message (§7's blocker #3) since `selectEmailRuleCandidate` doesn't distinguish "zero matches" from "multiple matches" in its return type — safe, but less specific than `gmail.rule.propose_update`'s richer wording.

## 11. Follow-up: goal-listing honesty (implemented)

Closes the last pre-proactive-operator baseline gap: V3 had no `goal.*` tool at all, so "what are my goals?" either fell through to `operator.today`'s bare active-goal **count** or, worse, risked silently becoming a `memory.create` that let the user believe a real goal was now tracked. Deliberately minimal per this task's explicit scope — **no goal creation/update/delete was added**, only read-only listing plus an honesty rule for creation requests.

**What already existed and was reused as-is:** `getActiveGoals`/`context.activeGoals` (already loaded into every turn's `ContextBundle` by `context-loader.ts`, unchanged); the `Goal` record shape (`title`, `category`, `priority`, `why`, `status`, `createdAt` — no built-in progress/metric aggregation, so none was invented); and `createGoal` (`@operator-agent/db`), which **is** already a clean, well-typed service (confirmed while mapping this task) — deliberately not wired into a `goal.create` V3 tool this pass, per the task's explicit "do NOT build full goal management yet" and its own example response, which prefers an honest decline.

**New tool:** `goal.list` (`apps/api/src/agent-runtime/tool-catalog.ts`) — `mutates: false`, no args, read-only. Executor reads `context.activeGoals` directly (zero extra DB calls — it was already loaded every turn) and formats it with a new `formatGoalListForChat` helper in `executor.ts` (same "small pure helper, no new file" pattern as the daily-loop-settings pass, since — unlike Gmail reviews — there was no existing non-legacy goal-formatting service to extend). Output: a numbered list of `title — category — priority`, with an indented `Why: ...` line when the goal has one, always closing with the same honest boundary line ("Goal editing through chat is not wired yet. Use /create_goal or tell me if you want me to remember context."). Empty state: "You don't have active goals set yet. Use /create_goal for now, or tell me what you want to work on and I can remember the context." — never a false zero-count claim dressed up as something else.

**Planner guidance — two halves:** (1) `goal.list` is taught for "what are my goals?", "show my active goals", "what am I working on?", "which goals are active?", "why did I set the X goal?". (2) An explicit creation/edit request ("create a goal to X", "update my X goal", "delete the X goal") must plan **zero operations** with an honest `replyDraft` pointing to `/create_goal` — explicitly forbidden from using `memory.create` as a silent substitute, since that would let the user believe a goal now exists when it doesn't. A third, narrower case handles genuinely ambiguous statements of intent that are NOT an explicit creation request (e.g. "I want to find a developer job") — `memory.create(type: "goal_context")` is still allowed there (unchanged from the prior pass), but the `replyDraft` is now required to be explicit that this is only being remembered, never framed as if a goal was created or is being tracked.

**Response grounding:** `goal.list` is `mutates: false`, so it already flows through `response-composer.ts`'s existing informational-tools branch — its own grounded summary always wins over `replyDraft`, no composer changes needed.

**Tests:** `tests/agent-runtime-goal-listing.test.ts` (new, 7 tests — real goal titles returned, priority/category/why included, honest empty state, explicit creation request creates neither a Goal row nor a substitute memory, ambiguous intent never lets the reply claim a real goal exists, progress logging (`event.log_job_applications`) still works unaffected, and the goal-aligned guardrail engine — §9 — still sees `context.activeGoals` correctly after this change) + scripted-smoke scenario 10 rewritten to chain exactly what this task specified: two seeded goals → "what are my goals?" (titles appear) → "I sent 3 CVs today" (event logged) → "create a goal to run a marathon" (zero fake goal, zero fake memory). All existing tests, including Gmail review triage, the goal-guardrail engine, planning, action hygiene, weekly review, and daily-loop settings, pass unchanged. Full suite: **343/343** (336 before this follow-up + 7 new unit tests, scenario 10 rewritten in place).

**Validation:** `pnpm typecheck` ✅ · `pnpm build` ✅ · `pnpm test` (343/343) ✅ · `git diff --check` ✅.

**Remaining, intentional gap:** goal creation/update/delete through chat is still entirely unsupported — by explicit task scope, not an oversight. `createGoal` is confirmed clean and ready to wire up if/when product decides the honest-decline friction is worth removing (§7's blocker #3). The other pre-proactive-operator decision point — an onboarding nudge toward setting at least one guardrail-relevant goal, since §9's guardrail engine protects nothing for a user with none configured — remains open and is now the single largest lever for improving early-user safety coverage.
