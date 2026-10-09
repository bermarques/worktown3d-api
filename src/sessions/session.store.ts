import crypto from 'node:crypto';
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Request } from 'express';
import { HttpError } from '../common/http-error.js';
import { AppConfig } from '../config/app-config.js';
import type { Session as SessionRow } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { cookie, parseCookies, randomId } from './cookies.js';
import { SecretBox } from './secret-box.js';

const IDLE_MS = 7 * 24 * 3600_000;
const ABSOLUTE_MS = 30 * 24 * 3600_000;
const DEMO_IDLE_MS = 2 * 3600_000;
/** How stale "last seen" may get before it's written back, so busy sessions don't write on every request. */
const TOUCH_MS = 60_000;
const SWEEP_MS = 10 * 60_000;

const logger = new Logger('Sessions');

export interface SessionUser {
  id: number;
  login: string;
  name: string | null;
  avatarUrl: string;
}

/** GitHub App tokens expire (8h) and come with a refresh token; OAuth App tokens don't expire. */
export interface GithubToken {
  access: string;
  refresh: string | null;
  expiresAt: number | null;
  refreshExpiresAt: number | null;
}

interface BaseSession {
  /** SHA-256 of the cookie value: safe to log, use as a cache namespace or a rate-limit key. */
  id: string;
  org: string | null;
  createdAt: number;
  lastSeen: number;
}
export interface UserSession extends BaseSession {
  kind: 'user';
  user: SessionUser;
  token: GithubToken;
}
export interface DemoSession extends BaseSession {
  kind: 'demo';
}
export type Session = UserSession | DemoSession;

const hashId = (secret: string) => crypto.createHash('sha256').update(secret).digest('base64url');
const tokenContext = (id: string) => `session-token:${id}`;

function expiry(kind: Session['kind'], createdAt: number, lastSeen: number) {
  return new Date(Math.min(lastSeen + (kind === 'demo' ? DEMO_IDLE_MS : IDLE_MS), createdAt + ABSOLUTE_MS));
}

/**
 * Server-side sessions in PostgreSQL (hosted mode), so deploys don't sign people out and any instance can serve any
 * request. The browser only holds a random 256-bit id in an HttpOnly cookie. The table stores a hash of it and the
 * GitHub tokens encrypted, so a copy of the table alone can't be used to act as anyone.
 */
@Injectable()
export class SessionStore implements OnModuleInit, OnModuleDestroy {
  /** __Host- prefix: the browser refuses to set it without Secure, Path=/ and no Domain. */
  readonly cookieName: string;
  private sweeper?: NodeJS.Timeout;

  constructor(
    private readonly prisma: PrismaService,
    private readonly box: SecretBox,
    private readonly config: AppConfig,
  ) {
    this.cookieName = config.secure ? '__Host-wt3d_sid' : 'wt3d_sid';
  }

  onModuleInit() {
    this.sweeper = setInterval(() => void this.sweep(), SWEEP_MS).unref();
    void this.sweep();
  }

  onModuleDestroy() {
    clearInterval(this.sweeper);
  }

  /** The request's session, or null when there's none or it expired. */
  async get(req: Request): Promise<Session | null> {
    const secret = parseCookies(req.headers.cookie)[this.cookieName];
    if (!secret || secret.length > 100) return null;
    const id = hashId(secret);
    const row = await this.prisma.session.findUnique({ where: { id } });
    if (!row) return null;
    const now = Date.now();
    const session = row.expiresAt.getTime() > now ? this.fromRow(row) : null;
    if (!session) {
      await this.prisma.session.deleteMany({ where: { id } });
      return null;
    }
    if (now - session.lastSeen > TOUCH_MS) {
      session.lastSeen = now;
      await this.prisma.session.updateMany({
        where: { id },
        data: { lastSeenAt: new Date(now), expiresAt: expiry(session.kind, session.createdAt, now) },
      });
    }
    return session;
  }

  /** A new signed-in session, and the Set-Cookie header that hands it to the browser. */
  async createUser(user: SessionUser, token: GithubToken) {
    const { id, secret, now } = this.newId();
    await this.prisma.session.create({
      data: {
        id,
        kind: 'user',
        userId: String(user.id),
        user: { id: user.id, login: user.login, name: user.name, avatarUrl: user.avatarUrl },
        token: this.box.seal(token, tokenContext(id)),
        createdAt: new Date(now),
        lastSeenAt: new Date(now),
        expiresAt: expiry('user', now, now),
      },
    });
    const session: UserSession = { id, kind: 'user', user, token, org: null, createdAt: now, lastSeen: now };
    return { session, cookie: this.setCookie(secret) };
  }

  /** A new anonymous demo session, and the Set-Cookie header that hands it to the browser. */
  async createDemo() {
    const { id, secret, now } = this.newId();
    await this.prisma.session.create({
      data: { id, kind: 'demo', createdAt: new Date(now), lastSeenAt: new Date(now), expiresAt: expiry('demo', now, now) },
    });
    const session: DemoSession = { id, kind: 'demo', org: null, createdAt: now, lastSeen: now };
    return { session, cookie: this.setCookie(secret) };
  }

  async setOrg(session: Session, org: string | null) {
    session.org = org;
    await this.prisma.session.updateMany({ where: { id: session.id }, data: { org } });
  }

  /**
   * Replace a session's GitHub token, one instance at a time. GitHub refresh tokens are single-use, so two instances
   * refreshing at once would sign the person out. The row stays locked while `refresh` runs, and `refresh` gets the
   * latest stored token, so it can skip the call when another instance has just refreshed it.
   */
  async updateToken(session: UserSession, refresh: (current: GithubToken) => Promise<GithubToken>) {
    const context = tokenContext(session.id);
    const token = await this.prisma.$transaction(
      async (tx) => {
        const rows = await tx.$queryRaw<{ token: string | null }[]>`SELECT token FROM sessions WHERE id = ${session.id} FOR UPDATE`;
        const current = rows[0]?.token ? this.box.open<GithubToken>(rows[0].token, context) : null;
        if (!current) throw new HttpError(401, 'Your GitHub sign-in expired. Please sign in again.');
        const next = await refresh(current);
        if (next !== current) await tx.session.update({ where: { id: session.id }, data: { token: this.box.seal(next, context) } });
        return next;
      },
      { maxWait: 10_000, timeout: 30_000 },
    );
    session.token = token;
    return token;
  }

  async destroy(session: Session | null) {
    if (session) await this.prisma.session.deleteMany({ where: { id: session.id } });
  }

  /**
   * Send everyone in a building (or only `userId`) back to the building picker, on every instance: their next
   * request has no building, and choosing it again re-checks their access with GitHub. Returns how many sessions.
   */
  async leaveBuilding(org: string, userId?: string) {
    const { count } = await this.prisma.session.updateMany({
      where: { org: { equals: org, mode: 'insensitive' }, ...(userId ? { userId } : {}) },
      data: { org: null },
    });
    return count;
  }

  /** Sign a GitHub user out everywhere. Returns how many sessions ended. */
  async destroyUser(userId: string) {
    const { count } = await this.prisma.session.deleteMany({ where: { userId } });
    return count;
  }

  clearCookie() {
    return cookie(this.cookieName, '', { maxAgeSec: 0, secure: this.config.secure });
  }

  private setCookie(secret: string) {
    return cookie(this.cookieName, secret, { maxAgeSec: Math.floor(ABSOLUTE_MS / 1000), secure: this.config.secure });
  }

  private newId() {
    const secret = randomId();
    return { secret, id: hashId(secret), now: Date.now() };
  }

  private fromRow(row: SessionRow): Session | null {
    const base = { id: row.id, org: row.org, createdAt: row.createdAt.getTime(), lastSeen: row.lastSeenAt.getTime() };
    if (row.kind === 'demo') return { ...base, kind: 'demo' };
    // Unreadable tokens (GITHUB_CLIENT_SECRET was rotated, say) mean signing in again.
    const token = row.kind === 'user' && row.token ? this.box.open<GithubToken>(row.token, tokenContext(row.id)) : null;
    if (!token || !row.user) return null;
    return { ...base, kind: 'user', user: row.user as unknown as SessionUser, token };
  }

  private async sweep() {
    try {
      await this.prisma.session.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    } catch (e) {
      logger.warn(`Could not remove expired sessions: ${e instanceof Error ? e.message : e}`);
    }
  }
}
