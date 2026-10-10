import { Controller, Get, Logger, Post, Query, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { describeError } from '../common/http-error.js';
import { sendJson } from '../common/respond.js';
import { safeEqual, sameOrigin } from '../common/security.js';
import { AppConfig } from '../config/app-config.js';
import { cookie, parseCookies, randomId } from '../sessions/cookies.js';
import { SecretBox } from '../sessions/secret-box.js';
import { CLOSE } from '../live/live.protocol.js';
import { PresenceService } from '../live/presence.service.js';
import { PrismaCharacterStore } from '../profiles/character.store.js';
import { SessionStore } from '../sessions/session.store.js';
import { AuthService, safeNext } from './auth.service.js';

const PENDING_TTL = 10 * 60_000;
const PENDING_CONTEXT = 'oauth-state';
const logger = new Logger('Auth');

/** A sign-in attempt between /auth/login and /auth/callback. */
interface PendingSignIn {
  state: string;
  verifier: string;
  next: string;
  at: number;
}

const firstString = (v: unknown) => (typeof v === 'string' ? v : Array.isArray(v) && typeof v[0] === 'string' ? v[0] : '');

function redirect(res: Response, location: string, cookies: string[]) {
  res.status(302).set({ Location: location, 'Set-Cookie': cookies }).end();
}

/** Sign-in routes (hosted mode). */
@Controller('auth')
export class AuthController {
  private readonly stateCookie: string;

  constructor(
    private readonly config: AppConfig,
    private readonly auth: AuthService,
    private readonly sessions: SessionStore,
    private readonly box: SecretBox,
    private readonly presence: PresenceService,
    private readonly characters: PrismaCharacterStore,
  ) {
    this.stateCookie = config.secure ? '__Host-wt3d_oauth' : 'wt3d_oauth';
  }

  /** GET /auth/login?next=/o/org */
  @Get('login')
  login(@Query('next') next: unknown, @Res() res: Response) {
    const pending: PendingSignIn = { state: randomId(24), verifier: randomId(48), next: safeNext(firstString(next)), at: Date.now() };
    // The attempt (with its PKCE verifier) travels in an encrypted cookie. That pins it to this browser, so a login
    // link can't be replayed in someone else's, and lets the callback land on any instance, even after a restart.
    const sealed = this.box.seal(pending, PENDING_CONTEXT);
    redirect(res, this.auth.authorizeUrl(pending.state, pending.verifier), [cookie(this.stateCookie, sealed, { maxAgeSec: PENDING_TTL / 1000, secure: this.config.secure })]);
  }

  /** GET /auth/callback?code&state */
  @Get('callback')
  async callback(@Req() req: Request, @Res() res: Response) {
    const clear = cookie(this.stateCookie, '', { maxAgeSec: 0, secure: this.config.secure });
    const fail = (reason: string) => redirect(res, `/?login_error=${reason}`, [clear]);
    if (req.query.error) return fail('denied');
    const state = firstString(req.query.state);
    const code = firstString(req.query.code);
    const sealed = parseCookies(req.headers.cookie)[this.stateCookie];
    const p = sealed ? this.box.open<PendingSignIn>(sealed, PENDING_CONTEXT) : null;
    if (!state || !code || !p || !safeEqual(state, p.state) || Date.now() - p.at > PENDING_TTL) return fail('expired');

    let token;
    let user;
    try {
      token = await this.auth.exchangeCode(code, p.verifier);
      user = await this.auth.fetchUser(token.access);
    } catch (e) {
      logger.warn(`sign-in failed: ${describeError(e)}`);
      return fail('github');
    }

    // New session id on every sign-in (no session fixation); drop any previous session in this browser.
    await this.sessions.destroy(await this.sessions.get(req));
    const { cookie: sessionCookie } = await this.sessions.createUser(user, token);
    await this.characters.syncLogin(user);
    logger.log(`@${user.login} signed in`);
    redirect(res, safeNext(p.next), [sessionCookie, clear]);
  }

  /** POST /auth/logout — also revokes the GitHub token so it's useless if it ever leaked. */
  @Post('logout')
  async logout(@Req() req: Request, @Res() res: Response) {
    if (!sameOrigin(req, this.config)) return sendJson(res, 403, { error: 'Cross-site request blocked' });
    const s = await this.sessions.get(req);
    if (s && s.kind === 'user') this.auth.revoke(s.token.access);
    await this.sessions.destroy(s);
    if (s) this.presence.kick({ sessionId: s.id }, CLOSE.signedOut, 'Signed out');
    res.set('Set-Cookie', this.sessions.clearCookie());
    sendJson(res, 200, { ok: true });
  }
}
