# Private-alpha smoke checklist

Manual, step-by-step verification for a real private-alpha deployment — run this once against the
actual deploy target after `rc/private-alpha-smoke`'s automated pass (deterministic tests + gated
LLM evals) is green. This is the human confirmation that the real environment, not just the test
database, actually works end to end.

See also: `docs/10-v3-readiness-audit.md` for the running architecture/readiness log, and
`tests/agent-runtime-llm-eval.test.ts` (scenarios 60-89, tag `private-alpha`) for the automated
equivalent of most of the flow below.

## 1. Environment setup

Set these before starting anything. See §5 of the RC report (or the table below) for what happens
if one is missing — nothing here crashes the whole app; each missing key fails only the one
feature that needs it, honestly, the first time it's used.

| Variable | Required for | If missing |
|---|---|---|
| `DATABASE_URL` | everything (Prisma) | every DB call fails immediately |
| `OPENAI_API_KEY` | goal/action planning (the real LLM planner) | the next planner call throws `OPENAI_API_KEY is not configured.`; deterministic shortcuts still work |
| `TELEGRAM_BOT_TOKEN` | the Telegram bot and worker | both processes refuse to start (`throw new Error("TELEGRAM_BOT_TOKEN is required.")`) |
| `API_BASE_URL` | worker and Telegram bot calling the API | defaults to `http://localhost:3000` — set explicitly for any non-local deploy |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Gmail OAuth | Gmail connect reports itself honestly unconfigured, nothing else breaks |
| `GMAIL_REDIRECT_URI` | Gmail OAuth callback | defaults to `http://localhost:3000/oauth/gmail/callback` — set explicitly for any non-local deploy |
| `ALECTO_SECRET_ENCRYPTION_KEY` | encrypting stored Gmail tokens | the first Gmail connect/sync attempt fails with `"Gmail token encryption key is missing. Set ALECTO_SECRET_ENCRYPTION_KEY and restart."` — never silently stores a token in plaintext |
| `INTEGRATION_SYNC_ENABLED` | worker's scheduled Gmail sync | unset/not `"true"` = scheduled sync never runs; manual sync via chat still works |
| `PROACTIVE_OPERATOR_DELIVERY_ENABLED` | morning brief / Gmail alert delivery | unset/not `"true"` = nothing is ever sent proactively, even for opted-in users |
| `PROACTIVE_OPERATOR_ALLOWLIST` | scoping proactive delivery during alpha | unset = every opted-in user is eligible (fine for a single-operator alpha, tighten before wider rollout) |

The API process (`apps/api/src/index.ts`) now logs a single `[startup] Missing environment
variables: ...` warning line if any of `DATABASE_URL` / `OPENAI_API_KEY` /
`ALECTO_SECRET_ENCRYPTION_KEY` / `GOOGLE_CLIENT_ID`+`GOOGLE_CLIENT_SECRET` are absent — check the
logs right after starting it.

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
`TELEGRAM_BOT_TOKEN` is missing; otherwise a bad/unreachable `API_BASE_URL` surfaces on the first
actual API call, not at startup.

## 4. Connect Gmail

1. In Telegram, say "connect Gmail" (or `/connect_gmail`).
2. Open the returned OAuth URL, approve `gmail.readonly` access only — no write/send scope is ever
   requested.
3. Confirm "Gmail status" reports connected.

If this fails with an "unconfigured" message, check `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`/
`GMAIL_REDIRECT_URI`. If it fails with an encryption-key message, check
`ALECTO_SECRET_ENCRYPTION_KEY` and restart the API process (the key is only read at boot).

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

## 8. Approve a review, verify evidence

Once a matching email produces a review item: "what emails need my attention?" then "approve the
Endesa one" (or the equivalent phrasing for whatever showed up). Expect:

- an honest reply — if a real amount/date was found in the email's own subject/snippet, it's named
  explicitly (e.g. "(€43.20)"); if the rule has no goal/signal mapping, the reply says plainly that
  nothing was logged
- if evidence WAS logged, confirm it via "how's my Endesa goal going" — the count must reflect the
  real approved review, not a guess

## 9. Action reminder

Create an action with a near-term due time (or wait for a real one), and confirm the worker's
bundled reminder message arrives — natural language, no UUIDs, no slash commands. Reply to it with
a natural follow-up ("complete 1") and confirm it resolves against the bundled list.

## 10. Morning brief / evening check-in

- Turn on morning briefs via chat ("turn on morning briefs"), confirm, and verify the worker
  actually sends one at the configured time (needs `PROACTIVE_OPERATOR_DELIVERY_ENABLED=true` and,
  if `PROACTIVE_OPERATOR_ALLOWLIST` is set, the user's Telegram id on it).
- **Evening check-in is preview-only as of this pass** — `evening_checkin` decisions are computed
  but never actually delivered by the worker (see `apps/worker/src/v3-proactive-delivery.ts`'s own
  doc comment). Do not expect a real evening message; this is a known, documented gap, not
  something this pass builds. Real delivery today covers `morning_brief` and `gmail_nudge` only.

## 11. Reconnect Gmail

Simulate an expired connection (Google's own OAuth Testing-mode policy expires unverified apps'
refresh tokens after ~7 days — this is expected, not a bug) and confirm "Gmail status" honestly
reports the expired state with a working reconnect link, never a silent failure.

## 12. Rollback plan

- **Application code**: redeploy the previous known-good commit/build. No migration rollback is
  required for that alone — every schema change through this pass has been additive (new nullable
  columns only), so older application code that doesn't know about them still runs correctly
  against the newer schema.
- **Database**: Prisma does not generate automatic down-migrations. If a schema rollback is ever
  genuinely needed, it must be written by hand (a `DROP COLUMN`/`DROP TABLE` migration) — there is
  none pre-written, because every migration so far has been additive and safe to leave in place.
- **Proactive delivery**: the fastest full stop for any in-progress incident is
  `PROACTIVE_OPERATOR_DELIVERY_ENABLED=false` (or an empty `PROACTIVE_OPERATOR_ALLOWLIST`) and a
  worker restart — this alone silences every proactive send without touching application code or
  the database.
