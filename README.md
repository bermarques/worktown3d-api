# Worktown3D API

The API behind [Worktown3D](https://github.com/bermarques/company3d), a cartoon first-person 3D office for your
GitHub organization. It reads and changes GitHub data for the building (repos, people, issues, pull requests),
handles "Sign in with GitHub", stores building settings, runs subscriptions with Stripe and shows who else is in a
building (multiplayer).

The browser never calls it directly. The Worktown3D web app forwards `/api` (including the `/api/live` WebSocket),
`/auth` and `/stripe` to it, so everything happens on the web app's address (`PUBLIC_URL`).

It runs in two modes:

- **Local mode**: just you, on your machine, through the GitHub CLI (`gh`). Listens on `127.0.0.1:3001`.
- **Hosted mode** (`GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET` + `PUBLIC_URL` + `DATABASE_URL`): everyone signs in
  with GitHub and every GitHub call uses **their own** token, so GitHub enforces what each person can see and do.

## Quick start (local mode)

Needs Node.js 20.19+ (or 22.12+).

```bash
npm install
npm run dev          # build, run and rebuild on changes: API on http://127.0.0.1:3001
```

Or build once and run it: `npm run build`, then `npm start`. Then start the web app (`npm start` in the worktown3d
repository) and open http://localhost:3000.

Without the GitHub CLI you get a fictional **demo company** (`npm run demo` forces demo mode even when `gh` is set
up). To use your real organization, install the GitHub CLI (`winget install --id GitHub.cli` or
https://cli.github.com), run `gh auth login` and press **Check again** on the title screen. Local settings (connected
org, floor order, repo connections) are saved in `data/config.json`.

## Hosted mode

### 1. Create a GitHub App

GitHub → Settings → Developer settings → **GitHub Apps** → New GitHub App (create it under your organization if
only your company will use it).

| Setting | Value |
| --- | --- |
| Homepage URL | your `PUBLIC_URL` |
| Callback URL | `PUBLIC_URL/auth/callback` (for example `https://worktown3d.example.com/auth/callback`) |
| Expire user authorization tokens | ✅ on |
| Setup URL (optional) | `PUBLIC_URL/`, so people land back in Worktown3D after installing the app |
| Webhook | on: URL `PUBLIC_URL/api/github/webhook`, and a random secret (the same value goes in `GITHUB_WEBHOOK_SECRET`) |
| Where can it be installed | "Only on this account" for one company, "Any account" for a public product |

**Repository permissions:** Metadata *read*, Issues *read & write*, Pull requests *read & write*,
Contents *read & write* (needed to merge PRs), Commit statuses *read*, Checks *read*, and Administration *read & write*
only if you want "New project" to create repositories. **Organization permissions:** Members *read*.

**Subscribe to events:** Organization (installation and authorization events are always sent). With the webhook,
uninstalling the app, removing someone from the organization or revoking the app's authorization takes effect at once;
without it (`GITHUB_WEBHOOK_SECRET` unset), within a few minutes.

Then generate a **client secret** and **install the app** on your organization.

> A classic OAuth App also works (set the same callback URL). It's simpler but coarser: it asks for the `repo` scope,
> which covers all of a person's repositories.

### 2. Configure and run

```bash
cp .env.example .env       # then fill in PUBLIC_URL, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, DATABASE_URL (and GITHUB_APP_SLUG)
npm ci
npm run build
npm run db:migrate         # create or update the database tables
npm start
```

`PUBLIC_URL` is the web app's address, the same value the web app has. Set `TRUST_PROXY=1`: requests arrive through
the web app, which passes the client address on in `X-Forwarded-For`. Keep the API on a private network that only the
web app can reach.

Hosted mode needs **PostgreSQL** (`DATABASE_URL`): sign-in sessions, subscriptions and building settings live there.
Run `npm run db:migrate` before starting a new version; the API refuses to start while migrations are pending.
Because sessions are in the database, deploys don't sign people out and you can run more than one instance (rate
limits and demo sandboxes are kept per instance, though).

The schema is in [prisma/schema.prisma](prisma/schema.prisma). To change it, edit the schema and create a migration
with `npm run db:migrate:dev -- --name <change>` against a development database.

**Logs:** hosted mode writes JSON lines (`LOG_FORMAT=json`, the default there): one entry per request (method, path,
status, duration, client address, who was signed in; never query strings), plus errors with their stack traces, so
Railway and most log platforms can filter by field. Tokens, cookies and secrets are masked. Set `LOG_FORMAT=text` for
readable lines, and `NEST_LOG_LEVEL=>=warn` to keep only warnings and errors.

> **Upgrading from 0.2 (before Prisma)?** `npm run db:migrate` adopts the existing tables on its first run and keeps
> your data. It leaves the old `schema_migrations` table alone, so the previous version can still start if you need to
> roll back; drop it once you're happy with the upgrade.

### 3. Railway

Add this repository as a service next to the web app and a PostgreSQL service, with these variables:

| Variable | Value |
| --- | --- |
| `PORT` | `8080` (the web app's `API_URL` points at it) |
| `TRUST_PROXY` | `1` |
| `PUBLIC_URL` | the web app's public URL |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_APP_SLUG`, `GITHUB_WEBHOOK_SECRET` | from the GitHub App |
| `LOG_FORMAT`, `NEST_LOG_LEVEL` | optional, see **Logs** above |
| `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET`, `COMPLIMENTARY_ORGS` | optional, see below |

Railway builds it with `npm run build` and starts it with `npm start`. Under **Settings → Deploy**, set the
**pre-deploy command** to `npm run db:migrate`, so each deploy applies its migrations before the new version starts.

Don't generate a public domain for it. The web app reaches it at
`http://${{worktown3d-api.RAILWAY_PRIVATE_DOMAIN}}:8080` over Railway's private network, and the API listens on IPv6
and IPv4 for that.

### 4. Subscriptions (optional, Stripe)

With Stripe configured, an organization's building only opens while it's connected to an active subscription.
Without it, every member of an organization can open its building (handy for self-hosting). The Basic plan connects
**one organization**, and the subscriber's **personal building is free** while one of their organizations is
subscribed. If a payment fails the building stays open while Stripe retries; once the subscription ends it closes.

**Set up Stripe (test mode first):**
1. **Product catalog → Add product**: "Worktown3D Basic", recurring price **R$25.00 BRL / month**. Copy the
   **Price ID** (`price_…`) into `STRIPE_PRICE_ID`.
2. **Developers → API keys**: copy the secret key (`sk_test_…`) into `STRIPE_SECRET_KEY`.
3. **Developers → Webhooks → Add endpoint**: `PUBLIC_URL/stripe/webhook`, with the events
   `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`,
   `customer.subscription.deleted`, `customer.subscription.paused`, `customer.subscription.resumed`.
   Copy its signing secret (`whsec_…`) into `STRIPE_WEBHOOK_SECRET`.
4. **Settings → Billing → Customer portal**: allow updating payment methods, viewing invoices and cancelling, then
   save (the portal won't open until it's been saved once in each mode).
5. Optional: list organizations that should never pay (yours) in `COMPLIMENTARY_ORGS`.

Test with Stripe's test card `4242 4242 4242 4242` (any future date, any CVC). When you go live, repeat steps 1–4 in
live mode and swap in the live keys.

## Multiplayer

In an organization's building, everyone signed in sees the other people who are there at the same time, walking
around the floors. Personal buildings and the demo stay single-player. It's part of hosted mode, over a WebSocket at
`PUBLIC_URL/api/live`, so the web app's proxy has to forward WebSocket upgrades on that path.

Several instances share presence through PostgreSQL `LISTEN`/`NOTIFY`, so nothing else is needed. That takes a
direct connection to the database (Railway's PostgreSQL is one): a pooler in transaction mode, like PgBouncer, drops
notifications.

### Live protocol

While a building is open, the page connects to `/api/live` (same origin, so the session cookie goes along). The
connection belongs to the session's current building, and access is checked like any request: when it opens and
every minute after. Messages are JSON text frames.

**From the page**, about 10 times a second while the player moves (up to 15 a second are taken, the rest dropped):

```json
{ "t": "move", "floor": "api-gateway", "x": 12.5, "z": -3.25, "yaw": 1.57 }
```

`floor` is the repository whose floor the player is on, or `null` in the lobby. `x` and `z` are in meters (rounded to
centimeters), `yaw` in radians.

**From the server:**

| Message | When |
| --- | --- |
| `{ "t": "welcome", "you": 123, "building": "acme", "players": [Player, …] }` | right after connecting: everyone already there |
| `{ "t": "join", "player": Player }` | someone arrived, or reconnected: add them, or replace what you have for that `id` |
| `{ "t": "leave", "id": 123 }` | someone left |
| `{ "t": "moves", "m": [[id, floor, x, z, yaw], …] }` | where people moved, in batches every 100 ms (ignore your own id) |
| `{ "t": "character", "id": 123, "character": {…} }` | someone changed how they look: redraw them |

A `Player` is `{ "id", "login", "name", "character", "at" }`: `id` is the GitHub user id, `at` is
`{ "floor", "x", "z", "yaw" }` or `null` until their first move, and `character` is how they look, `null` meaning the
look drawn from their login (always `null` until character customization exists). Keep `character` up to date from
`join` and `character` messages. While a player is on a floor, hide that floor's character for the same login, so
each person appears once.

The close code says what to do next:

| Code | Meaning | Reconnect? |
| --- | --- | --- |
| 4000 | a personal or demo building: single-player | no |
| 4001 | the same person opened this building somewhere else | no |
| 4401 | not signed in, or signed out | no: show the sign-in screen |
| 4403 | no access to this building (any more) | no |
| 4409 | no building selected, or the session switched buildings | after loading the building again |
| 4429 | the building is full (100 people) | later |
| 1001, 1006, 1011 | server restarting, connection dropped, server error | yes, with backoff |

## How it works

A [NestJS](https://nestjs.com) app in TypeScript, with [Prisma](https://www.prisma.io) for PostgreSQL.

```
src/main.ts                      loads .env, then starts the app (bootstrap.ts)
src/bootstrap.ts                 Nest app: security headers and host check for every request, timeouts, shutdown
src/app.module.ts                wires the app for its mode (local vs hosted, with or without Stripe)
src/config/app-config.ts         settings from the environment, checked at startup
src/common/                      errors and how they're answered, request validation, logs, CSRF and rate limits,
                                 body parsing, response cache
src/api/                         request context (who's asking, which building), building routes and access checks
src/local/                       local mode: `gh` CLI state, routes, settings file (data/config.json)
src/auth/                        "Sign in with GitHub" (OAuth web flow + PKCE, refresh, revoke)
src/sessions/                    server-side sessions (PostgreSQL), cookies, encryption of stored secrets
src/github/                      GitHub access (`gh` CLI or the user's token), queries and mutations, demo company,
                                 and the floor model built from issues/PRs/contributors/members
src/settings/                    per-org building settings (PostgreSQL)
src/billing/                     subscriptions: plans, who may enter, Stripe client and webhooks, records (PostgreSQL)
src/webhooks/                    GitHub App webhooks: uninstalls, membership removals, revoked authorizations
src/live/                        multiplayer: the /api/live WebSocket, and presence shared between instances
                                 (PostgreSQL LISTEN/NOTIFY)
src/prisma/prisma.service.ts     database connection; refuses to start with pending migrations
prisma/schema.prisma             database schema (migrations in prisma/migrations)
scripts/migrate.mjs              `npm run db:migrate`, which also adopts databases from before Prisma
```

Security details are in [SECURITY.md](SECURITY.md).

## Roadmap

- **Bigger plans.** More than one organization per subscription (plan limits per Stripe price), with upgrades and
  downgrades through the customer portal.
- **Character customization.** Profiles keyed by GitHub user id, editable only by that person (hair, colors,
  accessories), served to everyone who sees them in a building. The web app adds the "Me" app on the phone.
  Multiplayer is ready for it: players carry a `character` (read through `CharactersService` when they join), and
  saving a profile calls `PresenceService.updateCharacter`, which redraws that person for everyone in their building
  on every instance.
