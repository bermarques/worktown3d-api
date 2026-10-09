// "Sign in with GitHub" for hosted mode (OAuth web flow). Works with a GitHub App (recommended: fine-grained
// permissions, expiring tokens, installed per organization) or a classic OAuth App.
import crypto from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { HttpError } from '../common/http-error.js';
import { AppConfig } from '../config/app-config.js';
import { SessionStore, type GithubToken, type SessionUser, type UserSession } from '../sessions/session.store.js';

const GITHUB = 'https://github.com';
const API = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');
/** Refresh GitHub App tokens this long before they expire. */
const REFRESH_EARLY_MS = 5 * 60_000;

/** Only same-site paths like "/" or "/o/my-org" may be used as a post-login destination. */
export function safeNext(next: unknown) {
  return typeof next === 'string' && /^\/(?:o\/[A-Za-z0-9-]{1,39}\/?)?$/.test(next) ? next : '/';
}

/** GitHub's answer to a code exchange or refresh. */
interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
}

const signedOut = () => new HttpError(401, 'Your GitHub sign-in expired. Please sign in again.');
const expiresSoon = (t: GithubToken) => !!t.expiresAt && t.expiresAt - Date.now() <= REFRESH_EARLY_MS;

@Injectable()
export class AuthService {
  private readonly redirectUri: string;
  /** In-flight refreshes, so concurrent requests of one session share a single refresh. */
  private readonly refreshing = new Map<string, Promise<GithubToken>>();

  constructor(
    private readonly config: AppConfig,
    private readonly sessions: SessionStore,
  ) {
    this.redirectUri = `${config.origin}/auth/callback`;
  }

  private get app() {
    return this.config.github!;
  }

  /** GitHub's authorize page for this sign-in attempt (PKCE with the S256 challenge of `verifier`). */
  authorizeUrl(state: string, verifier: string) {
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const authorize = new URL(`${GITHUB}/login/oauth/authorize`);
    authorize.searchParams.set('client_id', this.app.clientId);
    authorize.searchParams.set('redirect_uri', this.redirectUri);
    authorize.searchParams.set('state', state);
    authorize.searchParams.set('code_challenge', challenge);
    authorize.searchParams.set('code_challenge_method', 'S256');
    authorize.searchParams.set('allow_signup', 'false');
    if (this.app.scopes) authorize.searchParams.set('scope', this.app.scopes); // ignored by GitHub Apps
    return authorize.toString();
  }

  exchangeCode(code: string, verifier: string) {
    return this.tokenRequest({ code, redirect_uri: this.redirectUri, code_verifier: verifier });
  }

  async fetchUser(access: string): Promise<SessionUser> {
    const res = await fetch(`${API}/user`, {
      headers: { Authorization: `Bearer ${access}`, Accept: 'application/vnd.github+json', 'User-Agent': 'Worktown3D' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`GitHub /user returned ${res.status}`);
    const u = (await res.json()) as { id: number; login: string; name: string | null; avatar_url: string };
    return { id: u.id, login: u.login, name: u.name || null, avatarUrl: u.avatar_url };
  }

  /** Revoke a token at GitHub (on sign-out), so it's useless if it ever leaked. Best effort, in the background. */
  revoke(access: string) {
    const { clientId, clientSecret } = this.app;
    fetch(`${API}/applications/${clientId}/token`, {
      method: 'DELETE',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'Worktown3D',
      },
      body: JSON.stringify({ access_token: access }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => {});
  }

  /** A usable access token for this session, refreshing GitHub App tokens shortly before they expire. */
  async validToken(s: UserSession) {
    if (!expiresSoon(s.token)) return s.token.access;
    let refresh = this.refreshing.get(s.id);
    if (!refresh) {
      refresh = this.sessions
        .updateToken(s, async (current) => {
          if (!expiresSoon(current)) return current; // another instance refreshed it while we waited for the lock
          if (!current.refresh || (current.refreshExpiresAt && current.refreshExpiresAt < Date.now())) throw signedOut();
          return this.tokenRequest({ grant_type: 'refresh_token', refresh_token: current.refresh });
        })
        .finally(() => this.refreshing.delete(s.id));
      this.refreshing.set(s.id, refresh);
    }
    s.token = await refresh;
    return s.token.access;
  }

  private async tokenRequest(params: Record<string, string>): Promise<GithubToken> {
    const res = await fetch(`${GITHUB}/login/oauth/access_token`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'Worktown3D' },
      body: JSON.stringify({ client_id: this.app.clientId, client_secret: this.app.clientSecret, ...params }),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({}))) as TokenResponse;
    if (!res.ok || json.error || !json.access_token) throw new HttpError(401, json.error_description || json.error || 'GitHub sign-in failed');
    const now = Date.now();
    return {
      access: json.access_token,
      refresh: json.refresh_token || null,
      // GitHub App tokens expire (8h) and come with a refresh token; OAuth App tokens don't expire.
      expiresAt: json.expires_in ? now + Number(json.expires_in) * 1000 : null,
      refreshExpiresAt: json.refresh_token_expires_in ? now + Number(json.refresh_token_expires_in) * 1000 : null,
    };
  }
}
