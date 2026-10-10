# Security

## Reporting a vulnerability

Please don't open a public issue for security problems. Use GitHub's
[private vulnerability reporting](https://docs.github.com/code-security/security-advisories/guidance-on-reporting-and-writing-information-about-vulnerabilities/privately-reporting-a-security-vulnerability)
on this repository instead.

## Security model

The API is reached through the Worktown3D web app, which forwards `/api`, `/auth` and `/stripe` with the original
`Host` header. It only answers for the web app's host name (`PUBLIC_URL`), so give it no public address of its own.

**Local mode** (no `GITHUB_CLIENT_ID`): the server acts as whoever is signed in to the GitHub CLI on that machine.
It listens on `127.0.0.1` only, refuses to start unless `PUBLIC_URL` is a localhost address, refuses requests whose
`Host` isn't localhost (DNS-rebinding protection) and requires a custom header plus same origin on every write (CSRF
protection). Don't expose local mode to a network.

**Hosted mode** (`GITHUB_CLIENT_ID` + `GITHUB_CLIENT_SECRET` + `PUBLIC_URL`):

- Everyone signs in with GitHub (OAuth web flow with PKCE and a `state` bound to the browser). The pending sign-in
  (state and PKCE verifier) travels in a short-lived, encrypted `HttpOnly` cookie. Every GitHub call is made with
  that person's own token, so GitHub enforces repository and organization permissions. The server never uses the
  GitHub CLI in this mode.
- Sessions live in PostgreSQL. The browser only holds a random 256-bit session id in an `HttpOnly`, `SameSite=Lax`,
  `Secure` (`__Host-` prefixed) cookie, with idle and absolute expiry; the database stores its SHA-256, never the id
  itself. GitHub tokens are never sent to the browser. They're stored encrypted (AES-256-GCM, key derived from
  `GITHUB_CLIENT_SECRET` and bound to their session row), refreshed when they expire (GitHub Apps; one instance at a
  time, under a row lock) and revoked on sign-out. A copy of the sessions table alone can't be used to act as anyone,
  and rotating `GITHUB_CLIENT_SECRET` signs everyone out.
- Access to a building requires active membership of that organization, re-checked every few minutes, so people
  who leave lose access. With the GitHub App webhook (`GITHUB_WEBHOOK_SECRET`) it's immediate: uninstalling the app or
  removing someone from the organization sends the affected sessions back to the building picker (where access is
  checked again with GitHub), and revoking the app's authorization ends that person's sessions. Deliveries
  (`/api/github/webhook`) are only accepted with a valid `X-Hub-Signature-256` (HMAC-SHA256, constant-time compare). Worktown3D's own settings (floor layout, repo connections) can only be changed by org owners.
- Cached GitHub data is namespaced per user, so one person's private data never reaches another.
- Writes need the `X-Worktown3D` header and a matching `Origin`. Security headers on every response, rate limits on
  sign-in, API and writes (keyed by the client address the web app forwards when `TRUST_PROXY=1`), request size and
  time limits. Request bodies are checked against a schema per route, and unknown fields are dropped.
- Internal error details stay in the server log. Logs never include query strings (which can carry sign-in codes),
  and fields named like tokens, cookies, secrets or passwords are masked.
- Multiplayer (`/api/live` WebSocket): the handshake gets the same host check as every request, and must come from
  a page of `PUBLIC_URL` (`Origin`), so other sites can't open it with someone's cookie. Only signed-in members of an
  organization's building get in, with the same membership and subscription checks as HTTP requests, re-checked every
  minute; signing out, switching buildings, an expired GitHub sign-in or a webhook (uninstall, removal) closes the
  connection at once, on every instance. People only ever send their own position (small, validated, rate-limited
  messages), and only people in the same building see it.
- The unauthenticated demo runs in a private in-memory sandbox per visitor with size limits (its session is in
  PostgreSQL like any other, its sandbox in the memory of each instance).

**Subscriptions (Stripe):**

- Card details never touch this server: people pay on Stripe Checkout and manage billing in Stripe's customer portal.
  The Stripe secret key stays server-side.
- The webhook (`/stripe/webhook`) only accepts requests with a valid `Stripe-Signature` (HMAC-SHA256, constant-time
  compare, 5-minute replay window). Events are de-duplicated, and subscription changes are re-read from Stripe rather
  than trusted from the event body, so out-of-order or forged payloads can't open a building.
- Returning from Checkout, the payment is confirmed with Stripe directly, and only for the signed-in person who
  started that checkout.
- Only organization owners can connect an organization to a subscription; plan limits are enforced on the server.

Known limits: rate limits are counted per instance (with several instances, each allows the full rate), and there's
no audit log yet.
