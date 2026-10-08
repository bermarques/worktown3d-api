# Worktown3D API

The API behind [Worktown3D](https://github.com/bermarques/company3d), a cartoon first-person 3D office for your
GitHub organization. It reads and changes GitHub data for the building (repos, people, issues, pull requests),
handles "Sign in with GitHub", stores building settings and runs subscriptions with Stripe.

The browser never calls it directly. The Worktown3D web app forwards `/api`, `/auth` and `/stripe` to it, so
everything happens on the web app's address (`PUBLIC_URL`).

It runs in two modes:

- **Local mode**: just you, on your machine, through the GitHub CLI (`gh`). Listens on `127.0.0.1:3001`.
- **Hosted mode** (`GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET` + `PUBLIC_URL` + `DATABASE_URL`): everyone signs in
  with GitHub and every GitHub call uses **their own** token, so GitHub enforces what each person can see and do.

## Quick start (local mode)

```bash
npm install
npm start            # API on http://127.0.0.1:3001
```

Then start the web app (`npm start` in the worktown3d repository) and open http://localhost:3000.

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
| Webhook | off (not used yet) |
| Where can it be installed | "Only on this account" for one company, "Any account" for a public product |

**Repository permissions:** Metadata *read*, Issues *read & write*, Pull requests *read & write*,
Contents *read & write* (needed to merge PRs), Commit statuses *read*, Checks *read*, and Administration *read & write*
only if you want "New project" to create repositories. **Organization permissions:** Members *read*.

Then generate a **client secret** and **install the app** on your organization.

> A classic OAuth App also works (set the same callback URL). It's simpler but coarser: it asks for the `repo` scope,
> which covers all of a person's repositories.

### 2. Configure and run

```bash
cp .env.example .env       # then fill in PUBLIC_URL, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, DATABASE_URL (and GITHUB_APP_SLUG)
npm ci --omit=dev
npm start
```

`PUBLIC_URL` is the web app's address, the same value the web app has. Set `TRUST_PROXY=1`: requests arrive through
the web app, which passes the client address on in `X-Forwarded-For`. Keep the API on a private network that only the
web app can reach. Sign-in sessions live in memory, so run a single instance.

Hosted mode needs **PostgreSQL** (`DATABASE_URL`): subscriptions and building settings live there, and the tables are
created automatically on startup.

### 3. Railway

Add this repository as a service next to the web app and a PostgreSQL service, with these variables:

| Variable | Value |
| --- | --- |
| `PORT` | `8080` (the web app's `API_URL` points at it) |
| `TRUST_PROXY` | `1` |
| `PUBLIC_URL` | the web app's public URL |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_APP_SLUG` | from the GitHub App |
| `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET`, `COMPLIMENTARY_ORGS` | optional, see below |

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

## How it works

```
server.js                HTTP server: routes, mode selection (local vs hosted), host and CSRF checks
src/github-client.js     GitHub access: local `gh` CLI, or a signed-in user's token (hosted)
src/github-provider.js   org/repo/member queries, permissions and mutations
src/gh.js                GitHub CLI wrapper
src/auth.js              "Sign in with GitHub" (OAuth web flow + PKCE, refresh, revoke)
src/sessions.js          server-side sessions and cookies
src/security.js          security headers, rate limits
src/demo-provider.js     fictional company with in-memory mutations
src/compose.js           turns issues/PRs/contributors/members into the floor model
src/config.js            local mode settings (data/config.json)
src/db.js                PostgreSQL pool and schema migrations
src/settings.js          per-org building settings (PostgreSQL)
src/billing.js           subscriptions: plans, connected orgs, who may enter, Stripe webhooks
src/stripe.js            minimal Stripe client and webhook signature check
src/repo.js              subscription records (PostgreSQL)
```

Security details are in [SECURITY.md](SECURITY.md).

## Roadmap

- **Prisma and proper handling.** Prisma for the database schema, migrations and queries (run migrations from
  Railway's pre-deploy command), and proper handling of errors, validation and logging.
- **Sessions in PostgreSQL**, so deploys don't sign people out and more than one instance can run.
- **GitHub App webhooks**, so uninstalls and membership removals take effect instantly.
