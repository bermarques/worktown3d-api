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

- Everyone signs in with GitHub (OAuth web flow with `state` bound to the browser and PKCE). Every GitHub call is
  made with that person's own token, so GitHub enforces repository and organization permissions. The server never
  uses the GitHub CLI in this mode.
- Tokens live only in server memory, are never sent to the browser, are refreshed when they expire (GitHub Apps)
  and are revoked on sign-out. Sessions are random 256-bit ids in `HttpOnly`, `SameSite=Lax`, `Secure`
  (`__Host-` prefixed) cookies with idle and absolute expiry.
- Access to a building requires active membership of that organization, re-checked every few minutes, so people
  who leave lose access. Worktown3D's own settings (floor layout, repo connections) can only be changed by org owners.
- Cached GitHub data is namespaced per user, so one person's private data never reaches another.
- Writes need the `X-Worktown3D` header and a matching `Origin`. Security headers on every response, rate limits on
  sign-in, API and writes (keyed by the client address the web app forwards when `TRUST_PROXY=1`), request size and
  time limits. Internal error details stay in the server log.
- The unauthenticated demo runs in a private in-memory sandbox per visitor with size limits.

**Subscriptions (Stripe):**

- Card details never touch this server: people pay on Stripe Checkout and manage billing in Stripe's customer portal.
  The Stripe secret key stays server-side.
- The webhook (`/stripe/webhook`) only accepts requests with a valid `Stripe-Signature` (HMAC-SHA256, constant-time
  compare, 5-minute replay window). Events are de-duplicated, and subscription changes are re-read from Stripe rather
  than trusted from the event body, so out-of-order or forged payloads can't open a building.
- Returning from Checkout, the payment is confirmed with Stripe directly, and only for the signed-in person who
  started that checkout.
- Only organization owners can connect an organization to a subscription; plan limits are enforced on the server.

Known limits: sessions are in memory (one instance; everyone signs in again after a restart), and there's no
audit log yet.
