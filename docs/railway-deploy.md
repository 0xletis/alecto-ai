# Deploying Alecto to Railway (private alpha)

Deployment packaging and documentation only — no product code changes. Three Railway services from
this one repo (API, Telegram bot, worker) plus a Railway Postgres database, one public domain (the
API), and everything else private.

See also: `docs/private-alpha-smoke-checklist.md` (manual verification after this deploy, now with
a Railway-specific section) and `.env.railway.example` (the exact variables below, as a template).

## 0. Why one shared build command for all three services

This repo is a pnpm workspace monorepo. `packages/core` and `packages/db` are consumed by the
other packages through their **built** `dist/` output, not their TypeScript source — every service
must run the workspace's own root `pnpm build` (which builds every package in dependency order:
`core` → `db`/`llm` → `api`/`worker`/`telegram-bot`), never just `tsc` inside one app's folder.
Building the whole workspace for all three services is simple and safe for a repo this size —
there is no need for per-service partial builds or a Dockerfile; Railway's own Nixpacks builder
(auto-detected for a Node/pnpm project) handles this natively.

Each Railway service therefore shares:

- **Root Directory**: the repo root (`/`) — not `apps/api`, not any subfolder. A workspace build
  needs the whole monorepo in context; scoping a service's root directory to one app's subfolder
  would break the build.
- **Build command**: `pnpm install --frozen-lockfile && pnpm build`

...and differs only in its **Start command** (§4) and which env vars it actually needs (§1/§4).

## 1. Audit: exact commands (task 1)

| Concern | Command | Notes |
|---|---|---|
| Install | `pnpm install --frozen-lockfile` | Installs the whole workspace; `packageManager: "pnpm@9.15.0"` in the root `package.json` pins the version Railway's Nixpacks builder will use automatically. |
| Build (all services) | `pnpm build` (= `pnpm -r build`) | Builds `packages/core`, `packages/db` (also runs `prisma generate`), `packages/llm`, then `apps/api`, `apps/worker`, `apps/telegram-bot` — pnpm's `-r` respects the workspace dependency graph, so build order is handled automatically. |
| Prisma generate (standalone) | `pnpm --filter @operator-agent/db exec prisma generate --schema prisma/schema.prisma` | Already run as part of `packages/db`'s own `build` script — you don't need to run this separately unless debugging. Does **not** need a reachable database, only a syntactically valid `DATABASE_URL` (it only reads the schema file). |
| Migration (production) | `pnpm --filter @operator-agent/db exec prisma migrate deploy --schema prisma/schema.prisma` | **Use this exact command, not `pnpm db:migrate`.** See the ambiguity note below. |
| Start — API | `pnpm --filter @operator-agent/api start` (or `node apps/api/dist/index.js`) | Fastify server; binds `API_HOST`/`API_PORT` (see §4's port note). |
| Start — Telegram bot | `pnpm --filter @operator-agent/telegram-bot start` (or `node apps/telegram-bot/dist/index.js`) | Long-running polling process; throws immediately at boot if `TELEGRAM_BOT_TOKEN` is missing. |
| Start — Worker | `pnpm --filter @operator-agent/worker start` (or `node apps/worker/dist/index.js`) | Long-running tick loop (every 60s); throws immediately at boot if `TELEGRAM_BOT_TOKEN` is missing. |
| Tests (CI, not part of deploy) | `pnpm test` | Needs a reachable Postgres — not something Railway's build/deploy needs to run. |

### Ambiguities found during this audit

- **`pnpm db:migrate` (root) and `packages/db`'s own `db:migrate` script both run `prisma migrate
  dev`, not `prisma migrate deploy`.** `migrate dev` is dev-only — it can prompt interactively and
  assumes a shadow database — and must never be run against the production database. Railway's
  migration step (§5) uses the raw `prisma migrate deploy` invocation above instead of either
  npm script.
- **Port variable name mismatch.** Railway's convention is to inject a `PORT` env var and route
  public traffic to whatever port the app listens on; this app reads `API_PORT` (default `3000`),
  never `PORT`. Resolved in §4 by setting `API_PORT` explicitly and pointing Railway's networking
  target port at the same value, rather than relying on Railway's auto-injected `PORT`.
- **No pinned Node version** (no `engines` field, no `.node-version`) before this pass — Nixpacks
  would pick a default Node version that could silently drift from what's tested locally. A
  `.node-version` file (Node 22, matching this repo's `@types/node@^22`) is added alongside this
  doc so Railway's build is reproducible; this is a one-line config file, not a product change.
- **`NODE_ENV` is never read anywhere in this codebase.** Setting it on Railway (see `.env.railway.
  example`) is harmless (Railway/most tooling sets it by default) but has no actual effect on
  Alecto's own behavior — noted so it's not mistaken for a real feature switch.
- **`DATABASE_URL` is needed at build time**, not just runtime — `packages/db`'s own `build` script
  runs `prisma generate`, which needs `DATABASE_URL` set (a valid-looking connection string; no
  live connection required) even for the Telegram bot service, which never talks to the database at
  runtime — because the shared build command (§0) builds the whole workspace regardless of which
  service will actually use it. Resolved by attaching the same Postgres reference (§2) to all three
  services, even though only the API and worker use it at runtime.

## 2. Create the Railway project and Postgres database

1. Create a Railway account, then **New Project** → **Empty Project** (or "Deploy from GitHub repo"
   if you want the first service created automatically — either works, the steps below cover both).
2. **New** → **Database** → **Add PostgreSQL**. Railway provisions a Postgres instance and exposes
   its own `DATABASE_URL` (and the individual `PGHOST`/`PGPORT`/etc.) as variables on that plugin
   service.
3. You will reference this plugin's `DATABASE_URL` from the API and worker services (and the build
   step for all three — see the ambiguity note above) using Railway's variable reference syntax:
   `${{Postgres.DATABASE_URL}}` — set this as each service's own `DATABASE_URL` variable rather than
   copy-pasting the raw value, so it never falls out of sync if Railway ever rotates it.

## 3. Create the three services from this one repo

For each of the three services below: **New** → **GitHub Repo** → select this repo (do this three
times — once per service; Railway does not automatically split one repo into multiple services for
a monorepo, each is its own service pointing at the same repo/branch).

For **every** service, in **Settings → Source**:

- **Root Directory**: leave as `/` (the repo root) — see §0.
- **Branch**: `deploy/railway-private-alpha` for the first deploy, then whatever branch you deploy
  from going forward (typically `main` once this is merged).

In **Settings → Build**:

- **Builder**: Nixpacks (default/auto-detected — no Dockerfile needed).
- **Build Command**: `pnpm install --frozen-lockfile && pnpm build`

In **Settings → Deploy**, set the **Start Command** per service (§4) and, for the API service only,
enable a public domain (§4).

A root-level `railway.json` in this repo pre-fills the build command and a sane restart policy
(`ON_FAILURE`, up to 10 retries) — it deliberately does **not** set a `startCommand` or
`healthcheckPath`, since those differ per service (§4). Treat the dashboard as the source of truth
for anything this file doesn't cover, and if a service's dashboard settings and `railway.json` ever
seem to disagree, trust whatever the dashboard shows for that specific service — config-as-code
precedence has shifted across Railway's own rollouts, so don't assume either direction without
checking your own project.

## 4. Per-service configuration

### API service

- **Start command**: `pnpm --filter @operator-agent/api start`
- **Networking**: **Settings → Networking → Generate Domain** (or attach a custom domain) — this is
  the ONE public URL for the whole deployment, used for both normal API traffic and the Gmail OAuth
  callback (§6).
- **Port**: this app reads `API_PORT`, not Railway's `PORT` — set `API_PORT=3000` as an explicit
  variable (not left to Railway's default injection), and in **Settings → Networking**, set the
  service's target port to `3000` to match.
- **Healthcheck path** (optional but recommended): `/health` — returns
  `{"ok": true, "service": "operator-agent-api"}`. Set this under **Settings → Deploy → Healthcheck
  Path** so Railway can tell the deploy actually came up before routing traffic to it.
- **Required env vars**: `DATABASE_URL`, `OPENAI_API_KEY`, `ALECTO_SECRET_ENCRYPTION_KEY`,
  `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GMAIL_REDIRECT_URI`, `API_PORT`,
  `PROACTIVE_OPERATOR_DELIVERY_ENABLED`, `PROACTIVE_OPERATOR_ALLOWLIST`. See
  `.env.railway.example` for the full list including optional tuning vars.

### Telegram bot service

- **Start command**: `pnpm --filter @operator-agent/telegram-bot start`
- **Networking**: none — do not generate a domain. This service only makes outbound calls (to
  Telegram's API and to the API service over `API_BASE_URL`); it never receives inbound traffic.
- **Required env vars**: `TELEGRAM_BOT_TOKEN`, `API_BASE_URL` (the API service's own public URL from
  above — see §6 for exactly how to get it), `DATABASE_URL` (build-time only, see the ambiguity
  note in §1). Optional: `TELEGRAM_ALLOWED_USER_IDS` to restrict who can use the bot during alpha.

### Worker service

- **Start command**: `pnpm --filter @operator-agent/worker start`
- **Networking**: none — same reasoning as the Telegram bot.
- **Required env vars**: `DATABASE_URL`, `TELEGRAM_BOT_TOKEN`, `API_BASE_URL`,
  `INTEGRATION_SYNC_ENABLED`, `INTEGRATION_SYNC_INTERVAL_MINUTES`,
  `PROACTIVE_OPERATOR_DELIVERY_ENABLED`, `PROACTIVE_OPERATOR_ALLOWLIST`.

## 5. Migration — run once, before any service handles real traffic

The safest first-deploy order:

1. Add Postgres (§2) and set every service's env vars (§4) — do this **before** the first deploy of
   any service, so the very first build/start already has everything it needs.
2. Deploy all three services once (Railway builds and starts them automatically on push/connect).
   The API and worker will actually **fail to do anything useful yet** — the database has no tables.
   That's expected and fine; that's exactly what step 3 fixes.
3. Run the migration **once**, via the Railway CLI, before relying on the API for real traffic:

   ```
   railway login
   railway link   # select this project
   railway run --service <api-service-name> pnpm --filter @operator-agent/db exec prisma migrate deploy --schema prisma/schema.prisma
   ```

   `railway run` executes the command in an environment with that service's real variables
   (including the real `DATABASE_URL`) already injected — no need to paste the connection string
   by hand. Any of the three services works for this (they all share the same `DATABASE_URL`); the
   API service is the natural choice since it's already selected for other checks.

   If you don't have the Railway CLI installed: `npm install -g @railway/cli`, then `railway login`
   opens a browser to authenticate.

4. Restart the API and worker services (**Deployments → ⋯ → Restart**) so they pick up the now-real
   schema cleanly, even though nothing in this app's own boot sequence actually caches schema state
   — this step is about confidence, not a real requirement.
5. Check logs (§7) on all three services for a clean startup with no `[startup]` warnings and no
   Prisma errors.

**Every future deploy** (after this first one) that includes a new migration follows the same
pattern: deploy the code, then run step 3's `railway run ... prisma migrate deploy` once, before
the new code path that depends on the new columns/tables sees real traffic. Every migration in this
repo so far has been additive (new nullable columns only — see `docs/private-alpha-smoke-checklist.
md`'s rollback section), so this is a low-risk step, not a delicate one.

If your Railway plan/UI exposes a **Pre-Deploy Command** field (Settings → Deploy, on newer Railway
accounts) instead of or in addition to `railway run`, you can set it to the same `prisma migrate
deploy` command on the API service so it runs automatically before each deploy goes live — check
your own dashboard for this field, since availability has varied by plan/rollout; the manual
`railway run` command above always works regardless.

## 6. Gmail OAuth callback

1. Get the API service's public URL: **API service → Settings → Networking** (or the domain you
   generated in §4) — it looks like `https://<something>.up.railway.app`, or your own custom domain
   if you attached one.
2. Set on the **API service only**:
   - `API_BASE_URL=https://<api-domain>` (also copy this exact value into the Telegram bot and
     worker services' own `API_BASE_URL` — those two processes call the API over HTTP)
   - `GMAIL_REDIRECT_URI=https://<api-domain>/oauth/gmail/callback`
3. In [Google Cloud Console](https://console.cloud.google.com/) → your OAuth client → **Authorized
   redirect URIs**, add the **exact same URI**: `https://<api-domain>/oauth/gmail/callback` (must
   match byte-for-byte, including `https://`, no trailing slash).
4. Redeploy/restart the API service so it picks up the new `GMAIL_REDIRECT_URI` (only read at
   boot).
5. In Telegram, say "connect Gmail" and complete the OAuth flow against the real Railway URL.
6. **Testing-mode reminder**: if your Google Cloud OAuth consent screen is still in "Testing" mode
   (the default for a new project, and the normal state for a private alpha with a handful of
   users), Google expires the refresh token after **7 days** regardless of how Alecto itself behaves
   — this is a Google policy, not an Alecto bug (see `docs/private-alpha-smoke-checklist.md`'s
   reconnect section). Reconnecting is the same "connect Gmail" flow above.

## 7. Verify proactivity and the worker (task 7)

- **Worker is running**: worker service **Deployments** tab shows a healthy running deployment (no
  crash loop); its **Logs** show a new `Worker started. API base URL: ...` line, then a tick roughly
  once a minute.
- **`INTEGRATION_SYNC_ENABLED` is true**: the worker now logs this explicitly at startup —
  `INTEGRATION_SYNC_ENABLED=true` should appear in the worker's logs right after boot.
- **`PROACTIVE_OPERATOR_DELIVERY_ENABLED` is true**: both the API and worker log this at startup —
  API: `[startup] PROACTIVE_OPERATOR_DELIVERY_ENABLED=true`; worker:
  `V3 proactive delivery config: PROACTIVE_OPERATOR_DELIVERY_ENABLED=true, PROACTIVE_OPERATOR_ALLOWLIST=...`.
- **`PROACTIVE_OPERATOR_ALLOWLIST` is set to your own user id**: the same worker log line above
  names the allowlist as `active (telegram:<your id>)` — get your own id from Telegram by messaging
  the bot `/whoami`. An allowlist that's still empty/unset means "everyone opted-in is eligible,"
  which is fine for a single-operator alpha but worth setting explicitly once you know your id.
- **No localhost warning in the logs**: neither the API's `[startup]` block nor the worker's should
  print a `looks like localhost` warning (see `packages/core/src/deploy-config-check.ts`) — if one
  appears, `API_BASE_URL` or `GMAIL_REDIRECT_URI` is still pointing at `localhost` somewhere.
- **Morning brief / evening check-in / Gmail nudges / action reminders are eligible**: ask the bot
  "what proactive messages are on?" to see real current settings, or "why didn't I get my morning
  brief?" / "why didn't you check in last night?" for a grounded, specific diagnosis rather than a
  guess.

## 8. Update the smoke checklist

`docs/private-alpha-smoke-checklist.md` now has a Railway-specific section (checking service logs,
confirming the public URL, and the same connect/goal/rule/sync/approve/reminder/reconnect flow as
local dev, adapted for a real deployed target) — run through it once after this first deploy.

## 9. Cost and control, for a small private alpha

- **Expected cost**: Railway's usage-based pricing means three small, mostly-idle Node services
  (the worker ticks once a minute; the API and bot only do real work when someone actually messages
  it) plus a small Postgres instance typically lands well within Railway's lowest paid tier for a
  single-operator alpha — check Railway's own current pricing page for exact numbers, since this
  changes over time and isn't something to hardcode into a doc.
- **Watch usage**: Railway's project dashboard has a **Usage** tab showing real compute/network
  spend per service, updated continuously — check it periodically, especially in the first week.
- **Stop/delete unused services**: any service you're not actively using can be paused
  (**Settings → paused**) or removed entirely without affecting the others — Postgres data persists
  independently of the app services, so pausing the bot/worker while debugging the API doesn't risk
  data loss.
- **Migration path if Railway cost grows**: nothing about this deploy is Railway-specific at the
  application level (no Railway-only APIs are used anywhere in the app code) — the same three
  `pnpm --filter ... start` commands and the same env vars work unchanged on a plain VPS (e.g.
  Hetzner) behind a reverse proxy for the API's public domain, with a self-managed Postgres instance
  providing `DATABASE_URL`. That move is future work, not something this pass builds — noted here
  only so it's clear the door stays open.

## 10. Rollback

Same as `docs/private-alpha-smoke-checklist.md`'s own rollback section: every migration so far is
additive, so redeploying an older commit needs no schema rollback. On Railway specifically:
**Deployments** tab → pick an earlier successful deployment → **Redeploy**, per service. The fastest
full stop for an in-progress proactive-delivery incident is still setting
`PROACTIVE_OPERATOR_DELIVERY_ENABLED=false` (or clearing `PROACTIVE_OPERATOR_ALLOWLIST`) on the
worker service and restarting it — no redeploy needed for that.
