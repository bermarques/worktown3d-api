import type { IncomingHttpHeaders, IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { Injectable, Logger, type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { Request } from 'express';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import { BuildingService } from '../api/building.service.js';
import { ContextResolver } from '../api/context.js';
import { describeError, statusOf } from '../common/http-error.js';
import { RateLimits } from '../common/rate-limits.js';
import { clientIp } from '../common/security.js';
import { AppConfig } from '../config/app-config.js';
import type { UserSession } from '../sessions/session.store.js';
import { CLOSE, parseMove } from './live.protocol.js';
import { PresenceService, type Connection } from './presence.service.js';

const PATH = '/api/live';
/** Clients only send moves (about 70 bytes each). */
const MAX_MESSAGE = 1024;
const PING_MS = 25_000;
const RECHECK_MS = 60_000;
/** Moves a client may send: bursts of 20, then 15 a second (clients send about 10). */
const MOVE_BURST = 20;
const MOVES_PER_SECOND = 15;

const logger = new Logger('Live');

type Admission = { ok: true; session: UserSession; owner: string } | { ok: false; code: number; reason: string };
const deny = (code: number, reason: string): Admission => ({ ok: false, code, reason });

interface Client {
  conn: Connection;
  headers: IncomingHttpHeaders;
  openedAt: number;
  /** Answered the last ping. */
  alive: boolean;
  tokens: number;
  refilledAt: number;
}

/** WebSocket close reasons are limited to 123 bytes. */
const closeReason = (message: string) => (Buffer.byteLength(message) <= 123 ? message : `${Buffer.from(message).subarray(0, 119).toString()}…`);

const textOf = (data: RawData) => (Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(new Uint8Array(data))).toString('utf8');

/**
 * The live presence WebSocket, `/api/live` (hosted mode). Signed-in members of an organization's building see who
 * else is there and where they walk; personal and demo buildings stay single-player. The connection belongs to the
 * session's current building, and access is checked when it opens and again every minute, like HTTP requests.
 *
 * It sits under /api because that's what the web app forwards to the API (its proxy has to pass WebSocket upgrades
 * through as well).
 */
@Injectable()
export class LiveGateway implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE, perMessageDeflate: false });
  private readonly clients = new Map<WebSocket, Client>();
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly config: AppConfig,
    private readonly resolver: ContextResolver,
    private readonly building: BuildingService,
    private readonly presence: PresenceService,
    private readonly limits: RateLimits,
  ) {}

  onApplicationBootstrap() {
    const server: Server = this.adapterHost.httpAdapter.getHttpServer();
    server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => this.upgrade(req, socket, head));
    this.timers = [setInterval(() => this.ping(), PING_MS).unref(), setInterval(() => void this.recheck(), RECHECK_MS).unref()];
  }

  beforeApplicationShutdown() {
    // PresenceService closes the connections themselves.
    this.timers.forEach(clearInterval);
    this.wss.close();
  }

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    socket.on('error', () => {});
    const refuse = (status: number, text: string) => socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    let pathname;
    try {
      pathname = new URL(req.url ?? '', 'http://placeholder').pathname;
    } catch {
      return refuse(400, 'Bad Request');
    }
    if (pathname !== PATH) return refuse(404, 'Not Found');
    // Like every HTTP request: only our host name (DNS rebinding), and only pages of our own origin (no cross-site
    // WebSocket hijacking: browsers always send Origin on WebSocket handshakes, and cookies go along).
    if (!this.config.allowedHosts.has(req.headers.host ?? '')) return refuse(421, 'Misdirected Request');
    if (req.headers.origin !== this.config.origin) return refuse(403, 'Forbidden');
    if (!this.limits.api(clientIp(req, this.config.trustProxy))) return refuse(429, 'Too Many Requests');
    this.wss.handleUpgrade(req, socket, head, (ws) => void this.open(ws, req.headers));
  }

  private async open(socket: WebSocket, headers: IncomingHttpHeaders) {
    socket.on('error', () => {});
    let admission: Admission;
    try {
      admission = await this.admit(headers);
    } catch (e) {
      logger.error(`could not admit a connection: ${describeError(e)}`, e instanceof Error ? e.stack : undefined);
      return socket.close(CLOSE.internalError, 'Something went wrong on our side');
    }
    if (!admission.ok) return socket.close(admission.code, closeReason(admission.reason));

    const { session, owner } = admission;
    const conn = await this.presence.join(socket, { owner, sessionId: session.id, user: session.user });
    if (!conn) return; // the building is full, or the client went away meanwhile
    const client: Client = { conn, headers, openedAt: Date.now(), alive: true, tokens: MOVE_BURST, refilledAt: Date.now() };
    this.clients.set(socket, client);
    const who = { user: session.user.login, building: owner };
    logger.log(`@${who.user} joined ${owner}`, who);

    socket.on('pong', () => (client.alive = true));
    socket.on('message', (data, isBinary) => {
      if (isBinary || !this.take(client)) return;
      const at = parseMove(textOf(data));
      if (at) this.presence.move(conn, at);
    });
    socket.on('close', (code) => {
      this.clients.delete(socket);
      this.presence.left(conn);
      logger.log(`@${who.user} left ${owner} (${code})`, { ...who, code, durationMs: Date.now() - client.openedAt });
    });
  }

  /** May this session be in a shared building right now, and which one? */
  private async admit(headers: IncomingHttpHeaders): Promise<Admission> {
    const ctx = await this.resolver.resolve({ headers } as Request);
    const session = ctx.session;
    if (!session) return deny(CLOSE.signedOut, 'Please sign in with GitHub');
    if (session.kind !== 'user') return deny(CLOSE.singlePlayer, 'The demo building is single-player');
    try {
      const { ctx: building, access } = await this.building.requireBuilding(ctx);
      if (access.role === 'owner') return deny(CLOSE.singlePlayer, 'Personal buildings are single-player');
      return { ok: true, session, owner: building.owner };
    } catch (e) {
      const status = statusOf(e);
      if (status >= 500) throw e;
      const code = status === 401 ? CLOSE.signedOut : status === 409 ? CLOSE.noBuilding : CLOSE.forbidden;
      return deny(code, e instanceof Error ? e.message : 'No access to this building');
    }
  }

  /** Every minute: still signed in, still in the same building, still allowed in? */
  private async recheck() {
    for (const [socket, client] of this.clients) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      try {
        const admission = await this.admit(client.headers);
        if (!admission.ok) socket.close(admission.code, closeReason(admission.reason));
        else if (admission.owner.toLowerCase() !== client.conn.building) socket.close(CLOSE.noBuilding, 'Switched buildings');
      } catch (e) {
        logger.warn(`could not recheck a connection: ${describeError(e)}`); // keep it, and try again next time
      }
    }
  }

  /** Every PING_MS: drop connections that didn't answer the last ping (and keep proxies from idling the rest out). */
  private ping() {
    for (const [socket, client] of this.clients) {
      if (!client.alive) {
        socket.terminate();
        continue;
      }
      client.alive = false;
      socket.ping();
    }
  }

  private take(client: Client) {
    const now = Date.now();
    client.tokens = Math.min(MOVE_BURST, client.tokens + ((now - client.refilledAt) / 1000) * MOVES_PER_SECOND);
    client.refilledAt = now;
    if (client.tokens < 1) return false;
    client.tokens -= 1;
    return true;
  }
}
