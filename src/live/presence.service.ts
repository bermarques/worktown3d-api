import { Injectable, Logger, type BeforeApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import { WebSocket } from 'ws';
import { CharactersService, MAX_CHARACTER_BYTES, type Character } from './characters.service.js';
import { CLOSE, type MoveTuple, type Player, type ServerMessage, type Spot } from './live.protocol.js';
import { PresenceBus, type BusMessage, type KickFilter, type Received } from './presence.bus.js';

const logger = new Logger('Presence');

/** Moves are batched and sent this often. */
const TICK_MS = 100;
/** Each instance confirms its players this often; players of an instance that stops confirming are dropped. */
const ALIVE_MS = 10_000;
const STALE_MS = 35_000;
const MAX_PLAYERS = 100;
/** Entries per bus message, to stay under the NOTIFY size limit. */
const MOVES_PER_MESSAGE = 40;
const ALIVE_PER_MESSAGE = 100;
/** Skip sending moves to a client this far behind (they'll get the next ones). */
const MAX_BUFFERED = 512 * 1024;

const buildingKey = (owner: string) => owner.toLowerCase();

/** Someone in a building, connected here or on another instance. */
interface Entry {
  player: Player;
  instance: string;
  /** When their connection opened: if the same person connects twice, the newer connection wins. */
  since: number;
  /** Last word from their instance (players of instances that go quiet are dropped). */
  seen: number;
}

/** A player connected to this instance. */
export interface Connection {
  socket: WebSocket;
  building: string;
  owner: string;
  sessionId: string;
  player: Player;
  since: number;
  moved: boolean;
  /** Closed because the same person connected again (no leave is announced: the new connection takes over). */
  replaced: boolean;
}

function chunks<T>(list: T[], size: number) {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * Who is in each shared building and where, kept in step across instances through PresenceBus. Each instance
 * holds its own players' connections and a copy of everyone else's (refreshed by their moves and heartbeats).
 */
@Injectable()
export class PresenceService implements OnModuleInit, BeforeApplicationShutdown {
  /** Everyone, by building then GitHub user id. */
  private readonly rosters = new Map<string, Map<number, Entry>>();
  /** Players connected to this instance, by building then GitHub user id. */
  private readonly local = new Map<string, Map<number, Connection>>();
  private timers: NodeJS.Timeout[] = [];
  private closing = false;

  constructor(
    private readonly bus: PresenceBus,
    private readonly characters: CharactersService,
  ) {
    bus.onMessage((m) => this.received(m));
    // After (re)connecting we may have missed messages: everyone re-announces their players.
    bus.onConnected(() => void this.bus.publish({ k: 'hello' }));
  }

  onModuleInit() {
    this.timers = [setInterval(() => this.tick(), TICK_MS).unref(), setInterval(() => this.heartbeat(), ALIVE_MS).unref()];
  }

  /** On shutdown (a deploy): announce that this instance's players left, then close their connections. */
  async beforeApplicationShutdown() {
    this.closing = true;
    this.timers.forEach(clearInterval);
    const leaves: Promise<void>[] = [];
    for (const [building, connections] of this.local) {
      for (const conn of connections.values()) {
        this.rosters.get(building)?.delete(conn.player.id);
        leaves.push(this.bus.publish({ k: 'leave', b: building, id: conn.player.id }));
        conn.socket.close(CLOSE.goingAway, 'Server restarting');
      }
    }
    await Promise.all(leaves);
  }

  /** A signed-in member opened a shared building: they get everyone there, and everyone gets them. */
  async join(socket: WebSocket, { owner, sessionId, user }: { owner: string; sessionId: string; user: { id: number; login: string; name: string | null } }) {
    const building = buildingKey(owner);
    const roster = this.roster(building);
    if (!roster.has(user.id) && roster.size >= MAX_PLAYERS) {
      socket.close(CLOSE.full, 'This building is full');
      return null;
    }
    const character = await this.characters.characterOf(user.id);
    if (socket.readyState !== WebSocket.OPEN || this.closing) return null;

    const previous = this.local.get(building)?.get(user.id);
    if (previous) this.replace(previous);
    const player: Player = { id: user.id, login: user.login, name: user.name, character, at: null };
    const conn: Connection = { socket, building, owner, sessionId, player, since: Date.now(), moved: false, replaced: false };
    this.connections(building).set(user.id, conn);
    roster.set(user.id, { player, instance: this.bus.instance, since: conn.since, seen: Date.now() });

    const others = [...roster.values()].filter((e) => e.player.id !== user.id).map((e) => e.player);
    this.send(socket, { t: 'welcome', you: user.id, building: owner, players: others });
    this.broadcast(building, { t: 'join', player }, socket);
    void this.bus.publish({ k: 'join', b: building, p: player, since: conn.since });
    return conn;
  }

  /** Where a player is now; sent to everyone with the next batch. */
  move(conn: Connection, at: Spot) {
    if (conn.replaced) return;
    conn.player.at = at;
    conn.moved = true;
  }

  /** A connection closed. */
  left(conn: Connection) {
    const connections = this.local.get(conn.building);
    if (connections?.get(conn.player.id) === conn) connections.delete(conn.player.id);
    if (connections && !connections.size) this.local.delete(conn.building);
    if (conn.replaced || this.closing) return;
    const roster = this.rosters.get(conn.building);
    const entry = roster?.get(conn.player.id);
    if (roster && entry && entry.player === conn.player) {
      roster.delete(conn.player.id);
      if (!roster.size) this.rosters.delete(conn.building);
      this.broadcast(conn.building, { t: 'leave', id: conn.player.id });
      void this.bus.publish({ k: 'leave', b: conn.building, id: conn.player.id });
    }
  }

  /**
   * Someone changed how their character looks: everyone in a building with them gets it at once, on every instance.
   * Character customization calls this when a profile is saved.
   */
  updateCharacter(userId: number, character: Character | null) {
    if (character && Buffer.byteLength(JSON.stringify(character)) > MAX_CHARACTER_BYTES) {
      throw new Error(`A character can't be larger than ${MAX_CHARACTER_BYTES} bytes`);
    }
    this.applyCharacter(userId, character);
    void this.bus.publish({ k: 'character', id: userId, c: character });
  }

  /** Close matching connections on every instance (sign-out, lost access, switched buildings). */
  kick(filter: KickFilter, code: number, reason: string) {
    this.kickHere(filter, code, reason);
    void this.bus.publish({ k: 'kick', f: filter, code, reason });
  }

  /** How many players are connected to this instance (for logs and tests). */
  get connectedHere() {
    let n = 0;
    for (const connections of this.local.values()) n += connections.size;
    return n;
  }

  // ---------------------------------------------------------------- internals

  private roster(building: string) {
    let roster = this.rosters.get(building);
    if (!roster) this.rosters.set(building, (roster = new Map()));
    return roster;
  }

  private connections(building: string) {
    let connections = this.local.get(building);
    if (!connections) this.local.set(building, (connections = new Map()));
    return connections;
  }

  private replace(conn: Connection) {
    conn.replaced = true;
    this.local.get(conn.building)?.delete(conn.player.id);
    conn.socket.close(CLOSE.replaced, 'Opened somewhere else');
  }

  private send(socket: WebSocket, message: ServerMessage) {
    if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }

  /** To this instance's players in a building (except `skip`). */
  private broadcast(building: string, message: ServerMessage, skip?: WebSocket) {
    const connections = this.local.get(building);
    if (!connections) return;
    const data = JSON.stringify(message);
    for (const { socket } of connections.values()) {
      if (socket === skip || socket.readyState !== WebSocket.OPEN) continue;
      if (message.t === 'moves' && socket.bufferedAmount > MAX_BUFFERED) continue;
      socket.send(data);
    }
  }

  /** Every TICK_MS: the moves of this instance's players, to everyone in their buildings. */
  private tick() {
    for (const [building, connections] of this.local) {
      const moves: MoveTuple[] = [];
      for (const conn of connections.values()) {
        if (!conn.moved || !conn.player.at) continue;
        conn.moved = false;
        const { floor, x, z, yaw } = conn.player.at;
        moves.push([conn.player.id, floor, x, z, yaw]);
      }
      if (!moves.length) continue;
      this.broadcast(building, { t: 'moves', m: moves });
      for (const m of chunks(moves, MOVES_PER_MESSAGE)) void this.bus.publish({ k: 'moves', b: building, m });
    }
  }

  /** Every ALIVE_MS: confirm this instance's players, and drop the players of instances that went quiet. */
  private heartbeat() {
    const mine: [string, number][] = [];
    for (const [building, connections] of this.local) for (const id of connections.keys()) mine.push([building, id]);
    for (const l of chunks(mine, ALIVE_PER_MESSAGE)) void this.bus.publish({ k: 'alive', l });

    const now = Date.now();
    for (const [building, roster] of this.rosters) {
      for (const [id, entry] of roster) {
        if (entry.instance === this.bus.instance || now - entry.seen < STALE_MS) continue;
        roster.delete(id);
        this.broadcast(building, { t: 'leave', id });
      }
      if (!roster.size) this.rosters.delete(building);
    }
  }

  private applyCharacter(userId: number, character: Character | null) {
    for (const [building, roster] of this.rosters) {
      const entry = roster.get(userId);
      if (!entry) continue;
      entry.player.character = character;
      this.broadcast(building, { t: 'character', id: userId, character });
    }
  }

  private kickHere(filter: KickFilter, code: number, reason: string) {
    const building = filter.building && buildingKey(filter.building);
    for (const connections of this.local.values()) {
      for (const conn of connections.values()) {
        if (building && conn.building !== building) continue;
        if (filter.userId !== undefined && conn.player.id !== filter.userId) continue;
        if (filter.sessionId !== undefined && conn.sessionId !== filter.sessionId) continue;
        conn.socket.close(code, reason);
      }
    }
  }

  /** Re-announce this instance's players (another instance started, reconnected or missed some of them). */
  private announce() {
    for (const [building, connections] of this.local) {
      for (const conn of connections.values()) void this.bus.publish({ k: 'join', b: building, p: conn.player, since: conn.since });
    }
  }

  private received(m: Received) {
    if (this.closing) return;
    const now = Date.now();
    switch (m.k) {
      case 'join': {
        const roster = this.roster(m.b);
        const known = roster.get(m.p.id);
        if (known && known.since > m.since) return; // an older connection than the one we know
        const mine = this.local.get(m.b)?.get(m.p.id);
        if (mine) {
          // The same person is connected here too: the newer connection wins (ties: the higher instance id).
          if (mine.since > m.since || (mine.since === m.since && this.bus.instance > m.i)) return;
          this.replace(mine);
        }
        roster.set(m.p.id, { player: m.p, instance: m.i, since: m.since, seen: now });
        this.broadcast(m.b, { t: 'join', player: m.p });
        return;
      }
      case 'leave': {
        const roster = this.rosters.get(m.b);
        if (roster?.get(m.id)?.instance !== m.i) return;
        roster.delete(m.id);
        if (!roster.size) this.rosters.delete(m.b);
        this.broadcast(m.b, { t: 'leave', id: m.id });
        return;
      }
      case 'moves': {
        const roster = this.rosters.get(m.b);
        if (!roster) return;
        const accepted = m.m.filter(([id, floor, x, z, yaw]) => {
          const entry = roster.get(id);
          if (entry?.instance !== m.i) return false;
          entry.player.at = { floor, x, z, yaw };
          entry.seen = now;
          return true;
        });
        if (accepted.length) this.broadcast(m.b, { t: 'moves', m: accepted });
        return;
      }
      case 'character':
        this.applyCharacter(m.id, m.c);
        return;
      case 'alive': {
        let unknown = false;
        for (const [building, id] of m.l) {
          const entry = this.rosters.get(building)?.get(id);
          if (entry && entry.instance === m.i) entry.seen = now;
          else unknown = true;
        }
        if (unknown) void this.bus.publish({ k: 'hello', to: m.i });
        return;
      }
      case 'hello':
        if (!m.to || m.to === this.bus.instance) this.announce();
        return;
      case 'kick':
        this.kickHere(m.f, m.code, m.reason);
        return;
      default:
        logger.warn(`unknown presence message: ${(m as BusMessage).k}`);
    }
  }
}
