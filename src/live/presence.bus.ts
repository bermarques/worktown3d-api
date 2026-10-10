import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import pg from 'pg';
import { describeError } from '../common/http-error.js';
import { AppConfig } from '../config/app-config.js';
import { randomId } from '../sessions/cookies.js';
import type { Character } from './characters.service.js';
import type { MoveTuple, Player } from './live.protocol.js';

const CHANNEL = 'wt3d_presence';
/** PostgreSQL refuses NOTIFY payloads of 8000 bytes or more. */
const MAX_PAYLOAD = 7900;
const logger = new Logger('PresenceBus');

/** Which connections to close: every field given must match. */
export interface KickFilter {
  building?: string;
  userId?: number;
  sessionId?: string;
}

/** What instances tell each other. `b` is a building key (lower-cased owner login). */
export type BusMessage =
  | { k: 'join'; b: string; p: Player; since: number }
  | { k: 'leave'; b: string; id: number }
  | { k: 'moves'; b: string; m: MoveTuple[] }
  | { k: 'character'; id: number; c: Character | null }
  | { k: 'alive'; l: [string, number][] }
  | { k: 'hello'; to?: string }
  | { k: 'kick'; f: KickFilter; code: number; reason: string };

/** A message from another instance (`i` is its id). */
export type Received = BusMessage & { i: string };

/**
 * Presence messages between API instances, over PostgreSQL LISTEN/NOTIFY on one dedicated connection, so players
 * connected to different instances see each other without any other infrastructure. Messages are fire-and-forget:
 * while the connection is down they're dropped, and presence resynchronizes once it's back (see PresenceService).
 */
@Injectable()
export class PresenceBus implements OnModuleInit, OnApplicationShutdown {
  readonly instance = randomId(9);
  private client: pg.Client | null = null;
  private handler: (m: Received) => void = () => {};
  private connected: () => void = () => {};
  private retryMs = 1000;
  private retryTimer?: NodeJS.Timeout;
  private stopped = false;

  constructor(private readonly config: AppConfig) {}

  /** Messages from other instances (our own are filtered out). */
  onMessage(handler: (m: Received) => void) {
    this.handler = handler;
  }

  /** Called each time listening starts, including after a reconnect (messages may have been missed meanwhile). */
  onConnected(handler: () => void) {
    this.connected = handler;
  }

  async onModuleInit() {
    await this.connect();
  }

  async onApplicationShutdown() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    const client = this.client;
    this.client = null;
    await client?.end().catch(() => {});
  }

  async publish(message: BusMessage) {
    const client = this.client;
    if (!client) return;
    const payload = JSON.stringify({ ...message, i: this.instance });
    if (Buffer.byteLength(payload) > MAX_PAYLOAD) {
      logger.warn(`dropped a ${message.k} message too large for NOTIFY`, { kind: message.k, bytes: Buffer.byteLength(payload) });
      return;
    }
    await client.query('SELECT pg_notify($1, $2)', [CHANNEL, payload]).catch((e) => logger.warn(`publish failed: ${describeError(e)}`));
  }

  private async connect() {
    if (this.stopped) return;
    const client = new pg.Client({ connectionString: this.config.databaseUrl!, connectionTimeoutMillis: 10_000 });
    client.on('notification', (n) => {
      if (n.channel !== CHANNEL || !n.payload) return;
      let message: Received;
      try {
        message = JSON.parse(n.payload);
      } catch {
        return;
      }
      if (message.i !== this.instance) this.handler(message);
    });
    const lost = (e?: Error) => {
      if (this.client !== client) return;
      this.client = null;
      if (!this.stopped) logger.warn(`connection lost${e ? `: ${describeError(e)}` : ''}; reconnecting`);
      client.end().catch(() => {});
      this.scheduleReconnect();
    };
    client.on('error', lost);
    client.on('end', () => lost());
    try {
      await client.connect();
      await client.query(`LISTEN ${CHANNEL}`);
    } catch (e) {
      logger.warn(`could not listen for presence messages: ${describeError(e)}; retrying`);
      client.end().catch(() => {});
      this.scheduleReconnect();
      return;
    }
    this.client = client;
    this.retryMs = 1000;
    this.connected();
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => void this.connect(), this.retryMs).unref();
    this.retryMs = Math.min(this.retryMs * 2, 30_000);
  }
}
