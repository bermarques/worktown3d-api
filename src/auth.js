// "Sign in with GitHub" for hosted mode (OAuth web flow). Works with a GitHub App (recommended: fine-grained
// permissions, expiring tokens, installed per organization) or a classic OAuth App.
import crypto from 'node:crypto';
import { parseCookies, cookie, randomId } from './sessions.js';
import { safeEqual } from './security.js';

const GITHUB = 'https://github.com';
const API = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
const PENDING_TTL = 10 * 60_000;

/** Only same-site paths like "/" or "/o/my-org" may be used as a post-login destination. */
export function safeNext(next) {
  return typeof next === 'string' && /^\/(?:o\/[A-Za-z0-9-]{1,39}\/?)?$/.test(next) ? next : '/';
}

export function createAuth({ publicUrl, clientId, clientSecret, scopes, sessions, secure }) {
  const redirectUri = `${publicUrl}/auth/callback`;
  const stateCookie = secure ? '__Host-wt3d_oauth' : 'wt3d_oauth';
  const pending = new Map(); // state -> { verifier, next, at }

  setInterval(() => {
    const now = Date.now();
    for (const [k, p] of pending) if (now - p.at > PENDING_TTL) pending.delete(k);
  }, 60_000).unref();

  async function tokenRequest(params) {
    const res = await fetch(`${GITHUB}/login/oauth/access_token`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'Worktown3D' },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, ...params }),
      signal: AbortSignal.timeout(15_000),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error || !json.access_token) {
      const err = new Error(json.error_description || json.error || 'GitHub sign-in failed');
      err.status = 401;
      throw err;
    }
    const now = Date.now();
    return {
      access: json.access_token,
      refresh: json.refresh_token || null,
      // GitHub App tokens expire (8h) and come with a refresh token; OAuth App tokens don't expire.
      expiresAt: json.expires_in ? now + Number(json.expires_in) * 1000 : null,
      refreshExpiresAt: json.refresh_token_expires_in ? now + Number(json.refresh_token_expires_in) * 1000 : null,
    };
  }

  function redirect(res, location, cookies = []) {
    res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', 'Set-Cookie': cookies });
    res.end();
  }

  return {
    /** GET /auth/login?next=/o/org */
    login(req, res, url) {
      if (pending.size > 10_000) pending.clear(); // flood guard
      const state = randomId(24);
      const verifier = randomId(48);
      const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
      pending.set(state, { verifier, next: safeNext(url.searchParams.get('next')), at: Date.now() });
      const authorize = new URL(`${GITHUB}/login/oauth/authorize`);
      authorize.searchParams.set('client_id', clientId);
      authorize.searchParams.set('redirect_uri', redirectUri);
      authorize.searchParams.set('state', state);
      authorize.searchParams.set('code_challenge', challenge);
      authorize.searchParams.set('code_challenge_method', 'S256');
      authorize.searchParams.set('allow_signup', 'false');
      if (scopes) authorize.searchParams.set('scope', scopes); // ignored by GitHub Apps
      // The state is also pinned to this browser, so a login link can't be replayed in someone else's.
      redirect(res, authorize.toString(), [cookie(stateCookie, state, { maxAgeSec: PENDING_TTL / 1000, secure })]);
    },

    /** GET /auth/callback?code&state */
    async callback(req, res, url) {
      const clear = cookie(stateCookie, '', { maxAgeSec: 0, secure });
      const fail = (reason) => redirect(res, `/?login_error=${reason}`, [clear]);
      if (url.searchParams.get('error')) return fail('denied');
      const state = url.searchParams.get('state') || '';
      const code = url.searchParams.get('code') || '';
      const browserState = parseCookies(req.headers.cookie)[stateCookie] || '';
      const p = pending.get(state);
      if (!state || !code || !p || !browserState || !safeEqual(state, browserState) || Date.now() - p.at > PENDING_TTL) return fail('expired');
      pending.delete(state);

      let token;
      let user;
      try {
        token = await tokenRequest({ code, redirect_uri: redirectUri, code_verifier: p.verifier });
        const res2 = await fetch(`${API}/user`, {
          headers: { Authorization: `Bearer ${token.access}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Worktown3D' },
          signal: AbortSignal.timeout(15_000),
        });
        if (!res2.ok) throw new Error(`GitHub /user returned ${res2.status}`);
        const u = await res2.json();
        user = { id: u.id, login: u.login, name: u.name || null, avatarUrl: u.avatar_url };
      } catch (e) {
        console.warn('[auth] sign-in failed:', e.message);
        return fail('github');
      }

      // New session id on every sign-in (no session fixation); drop any previous session in this browser.
      sessions.destroy(sessions.get(req));
      const s = sessions.create({ kind: 'user', user, token, org: null });
      console.log(`[auth] @${user.login} signed in`);
      redirect(res, p.next, [sessions.setCookie(s), clear]);
    },

    /** POST /auth/logout — also revokes the GitHub token so it's useless if it ever leaked. */
    async logout(req, res) {
      const s = sessions.get(req);
      if (s && s.token) {
        fetch(`${API}/applications/${clientId}/token`, {
          method: 'DELETE',
          headers: {
            Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
            Accept: 'application/vnd.github+json',
            'Content-Type': 'application/json',
            'User-Agent': 'Worktown3D',
          },
          body: JSON.stringify({ access_token: s.token.access }),
          signal: AbortSignal.timeout(10_000),
        }).catch(() => {});
      }
      sessions.destroy(s);
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Set-Cookie': sessions.clearCookie() });
      res.end('{"ok":true}');
    },

    /** A usable access token for this session, refreshing GitHub App tokens shortly before they expire. */
    async validToken(s) {
      const t = s.token;
      if (!t.expiresAt || t.expiresAt - Date.now() > 5 * 60_000) return t.access;
      if (!t.refresh || (t.refreshExpiresAt && t.refreshExpiresAt < Date.now())) {
        const err = new Error('Your GitHub sign-in expired. Please sign in again.');
        err.status = 401;
        throw err;
      }
      // one refresh at a time per session
      s.refreshing = s.refreshing || tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh }).finally(() => (s.refreshing = null));
      s.token = await s.refreshing;
      return s.token.access;
    },
  };
}
