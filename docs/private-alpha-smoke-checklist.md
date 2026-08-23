# Private-alpha smoke checklist

Manual, step-by-step verification for a real private-alpha deployment — run this once against the
actual deploy target after `rc/private-alpha-smoke` and `fix/private-alpha-known-gaps`'s automated
passes (deterministic tests + gated LLM evals) are green. This is the human confirmation that the
real environment, not just the test database, actually works end to end.

See also: `docs/10-v3-readiness-audit.md` for the running architecture/readiness log, and
`tests/agent-runtime-llm-eval.test.ts` (tags `private-alpha`, `private-alpha-gap`,
`signal-mapping`) for the automated equivalent of most of the flow below.

## Status after fix/private-alpha-known-gaps

- **Evening check-in is now live**, not preview-only — `apps/worker/src/v3-proactive-delivery.ts`'s
  `runV3ProactiveEveningCheckins` sends real Telegram messages the same way morning brief and Gmail
  nudges already do (same env gates, same allowlist, same per-user opt-in, same dedupe, same
  per-user send isolation). A parallel legacy-vs-V3 ownership check
  (`apps/worker/src/legacy-daily-loop-evening.ts`) prevents a double-send for a user who has both
  the legacy daily loop and the new V3 evening check-in enabled.
- **Known, real, non-blocking gap**: turning evening check-in on/off through a plain chat message
  ("turn on evening check-ins", "stop evening check-ins") is unreliable with gpt-4o-mini — the
  model sometimes names the right tool but fills its arguments with a different tool's shape.
  `validator.ts` safely discards the malformed arguments (Zod strips unrecognized fields), so this
  **never mutates the wrong setting** — worst case, Alecto asks "What would you like to change?"
  instead of completing the request the first time. If that happens, just answer the clarifying
  question directly (e.g. "the evening check-in") rather than repeating the original phrasing.
  Root-caused to a pre-existing planner architecture gap (see
  `tests/agent-runtime-llm-eval.test.ts` scenario 98's own doc comment) — not fixed this pass,
  tracked informationally.
- **"Does this count?" questions no longer log evidence.** A bare question about whether something
  counts toward a goal (English/Spanish/Catalan) is blocked deterministically before it can ever
  become a spurious evidence entry — see the dedicated section below.

## 1. Environment setup

Set these before starting anything. Nothing here crashes the whole app; each missing/misconfigured
key fails only the one feature that needs it, honestly, the first time it's used — but a
misconfigured `API_BASE_URL` or `GMAIL_REDIRECT_URI` fails *silently* (both have working localhost
defaults) unless you read the new startup warning lines described below.

| Variable | Required for | If missing/misconfigured |
|---|---|---|
| `DATABASE_URL` | everything (Prisma) | every DB call fails immediately |
| `OPENAI_API_KEY` | goal/action planning (the real LLM planner) | the next planner call throws `OPENAI_API_KEY is not configured.`; deterministic shortcuts still work |
| `TELEGRAM_BOT_TOKEN` | the Telegram bot and worker | both processes refuse to start (`throw new Error("TELEGRAM_BOT_TOKEN is required.")`) |
| `API_BASE_URL` | worker and Telegram bot calling the API | defaults to `http://localhost:3000` — **do not deploy with this pointing at localhost** unless the worker/bot process truly runs on the same host as the API; both processes now log a `[startup]` warning if it looks like localhost |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Gmail OAuth | Gmail connect reports itself honestly unconfigured, nothing else breaks |
| `GMAIL_REDIRECT_URI` | Gmail OAuth callback | defaults to `http://localhost:3000/oauth/gmail/callback` — **do not deploy with this pointing at localhost**; the API process now logs a `[startup]` warning if it looks like localhost, plus always logs the effective callback URL so it's never a guess |
| `ALECTO_SECRET_ENCRYPTION_KEY` | encrypting stored Gmail tokens | the first Gmail connect/sync attempt fails with `"Gmail token encryption key is missing. Set ALECTO_SECRET_ENCRYPTION_KEY and restart."` — never silently stores a token in plaintext |
| `INTEGRATION_SYNC_ENABLED` | worker's scheduled Gmail sync | unset/not `"true"` = scheduled sync never runs; manual sync via chat still works. The worker now logs `INTEGRATION_SYNC_ENABLED=<true|false>` at startup. |
| `PROACTIVE_OPERATOR_DELIVERY_ENABLED` | morning brief / evening check-in / Gmail alert delivery | unset/not `"true"` = nothing is ever sent proactively, even for opted-in users. Both the API and worker log the effective value at startup. |
| `PROACTIVE_OPERATOR_ALLOWLIST` | scoping proactive delivery during alpha | unset = every opted-in user is eligible (fine for a single-operator alpha, tighten before wider rollout) |

**Startup warnings, exactly as printed** — check the logs right after starting each process:

- API process: `[startup] DATABASE_URL is not set...`, `[startup] OPENAI_API_KEY is not set...`,
  `[startup] GMAIL_REDIRECT_URI (...) looks like localhost...`,
  `[startup] ALECTO_SECRET_ENCRYPTION_KEY is not set...`,
  `[startup] GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET are not set...` (only the ones that actually
  apply), followed unconditionally by `[startup] Gmail OAuth callback URL: <the real value>` and
  `[startup] PROACTIVE_OPERATOR_DELIVERY_ENABLED=<true|false>`.
- Worker process: `Worker started. API base URL: <value>`, then
  `[startup] API_BASE_URL (...) looks like localhost...` (only if it does), then
  `V3 proactive delivery config: PROACTIVE_OPERATOR_DELIVERY_ENABLED=..., PROACTIVE_OPERATOR_ALLOWLIST=...`,
  then `INTEGRATION_SYNC_ENABLED=<true|false>`.
- Telegram bot process: `Telegram bot starting. API base URL: <value>`, then
  `[startup] API_BASE_URL (...) looks like localhost...` (only if it does).

None of these ever print a secret value (`DATABASE_URL`, `OPENAI_API_KEY`,
`ALECTO_SECRET_ENCRYPTION_KEY`, `GOOGLE_CLIENT_SECRET` are only ever checked for *presence*) —
verified by `tests/deploy-config-check.test.ts`.

## 2. Database migration

```
pnpm db:generate
DATABASE_URL=<real deploy URL> pnpm --filter @operator-agent/db exec prisma migrate deploy --schema prisma/schema.prisma
```

Use `prisma migrate deploy`, **not** the repo's own `db:migrate` script — that script runs `prisma
migrate dev`, which is dev-only (can prompt interactively, assumes a shadow database) and is not
meant for a real deploy target.

## 3. Build and start, in order

```
pnpm build                    # builds packages/core, packages/db, packages/llm, then both apps
pnpm --filter @operator-agent/api start       # apps/api — must be reachable at API_BASE_URL
pnpm --filter @operator-agent/worker start    # apps/worker — polls every 60s, needs the API up
pnpm --filter @operator-agent/telegram-bot start
```

`packages/core` and `packages/db` are consumed by the other packages through their **built**
`dist/` output, not their TypeScript source — `pnpm build` (or each package's own `build` script)
must be re-run after any change to either before those changes are visible anywhere else,
regardless of what `tsc --noEmit`/typecheck reports.

Start order matters: API before worker (the worker calls the API over HTTP) and before the
Telegram bot (same reason). The worker and bot fail loudly and immediately if
`TELEGRAM_BOT_TOKEN` is missing; check each process's own startup log block (§1 above) before
moving on to the next.

## 4. Connect Gmail

1. In Telegram, say "connect Gmail" (or `/connect_gmail`).
2. Open the returned OAuth URL, approve `gmail.readonly` access only — no write/send scope is ever
   requested.
3. Confirm "Gmail status" reports connected.

If this fails with an "unconfigured" message, check `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/
`GMAIL_REDIRECT_URI` (and the API's own `[startup]` log for the exact effective callback URL it's
using). If it fails with an encryption-key message, check `ALECTO_SECRET_ENCRYPTION_KEY` and
restart the API process (the key is only read at boot).

## 5. Create your first goal

Say something concrete and specific, e.g. "I want to keep Endesa bills under 50 euros" — expect:

- a confirmation prompt (never created immediately)
- a real, non-empty signal declared once confirmed
- no slash command suggested anywhere in the reply

## 6. Create a Gmail signal rule linked to that goal

Say "track Endesa bill emails from Gmail for my Endesa goal" — expect a confirmation prompt, and
after confirming, an active rule linked to the goal with a real `signalKey`/`eventType` copied from
one of the goal's own declared signals (verify via "what email rules are active?").

## 7. Manual sync

Say "sync Gmail" (or `/sync_gmail`). Confirm the sync completes and reports honestly whether any
new reviews were created — never claims a match that didn't happen.

## 8. Approve a Gmail review, verify evidence

Once a matching email produces a review item: "what emails need my attention?" then "approve the
Endesa one" (or the equivalent phrasing for whatever showed up). Expect:

- an honest reply — if a real amount/date was found in the email's own subject/snippet, it's named
  explicitly (e.g. "(€43.20)"); if the rule has no goal/signal mapping, the reply says plainly that
  nothing was logged
- if evidence WAS logged, confirm it via "how's my Endesa goal going" — the count must reflect the
  real approved review, not a guess

## 9. Ambiguous evidence question should NOT log anything

With the same (or any) tracked goal, ask a bare question rather than reporting real progress —
e.g. "does this count toward my goal?", "esto cuenta para mi objetivo?", "això compta pel meu
objectiu?", "I only did 20 minutes, should I log it?". Expect:

- an honest clarifying reply ("I don't want to guess — tell me plainly what you did...")
- zero new events — check "how's my [goal] going" shows the same count as before asking
- no pending confirmation was opened or cleared by the question

Then confirm a REAL progress statement still logs normally: "I read 20 minutes today" (no question
mark, no hedging) should log real evidence immediately, no confirmation needed.

## 10. Action reminder

Create an action with a near-term due time (or wait for a real one), and confirm the worker's
bundled reminder message arrives — natural language, no UUIDs, no slash commands. Reply to it with
a natural follow-up ("complete 1") and confirm it resolves against the bundled list.

## 11. Morning brief

Turn on morning briefs via chat ("turn on morning briefs"), confirm, and verify the worker actually
sends one at the configured time (needs `PROACTIVE_OPERATOR_DELIVERY_ENABLED=true` and, if
`PROACTIVE_OPERATOR_ALLOWLIST` is set, the user's Telegram id on it).

## 12. Evening check-in (now live)

Turn on evening check-in via chat ("turn on evening check-ins") — if the reply asks "What would
you like to change?" instead of confirming, that's the known gap above; answer with just "the
evening check-in" and confirm as usual. Once on, verify the worker actually sends a real evening
check-in message at the configured time, naming any goal with no signal logged yet today. Ask "why
didn't you check in last night?" to confirm the new `proactive.diagnose_evening_checkin` diagnostic
gives a real, grounded answer (not a generic settings summary).

## 13. Gmail nudge

With a pending, goal-linked Gmail review and Gmail alerts turned on, confirm a proactive nudge
message arrives naming the real review, and that replying to it ("turn it into a task") resolves
correctly against the nudge's own stored context.

## 14. Reconnect Gmail

Simulate an expired connection (Google's own OAuth Testing-mode policy expires unverified apps'
refresh tokens after ~7 days — this is expected, not a bug) and confirm "Gmail status" honestly
reports the expired state with a working reconnect link, never a silent failure.

## 15. Rollback plan

- **Application code**: redeploy the previous known-good commit/build. No migration rollback is
  required for that alone — every schema change through this pass has been additive (new nullable
  columns only), so older application code that doesn't know about them still runs correctly
  against the newer schema.
- **Database**: Prisma does not generate automatic down-migrations. If a schema rollback is ever
  genuinely needed, it must be written by hand (a `DROP COLUMN`/`DROP TABLE` migration) — there is
  none pre-written, because every migration so far has been additive and safe to leave in place.
- **Proactive delivery (morning brief, evening check-in, Gmail nudges)**: the fastest full stop for
  any in-progress incident is `PROACTIVE_OPERATOR_DELIVERY_ENABLED=false` (or an empty
  `PROACTIVE_OPERATOR_ALLOWLIST`) and a worker restart — this alone silences every proactive send
  without touching application code or the database.
