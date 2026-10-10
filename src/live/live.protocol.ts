// Messages of the live presence WebSocket (/api/live). JSON text frames; documented in the README.
import { REPO_RE } from '../common/match.pipe.js';
import type { Character } from './characters.service.js';

/** Where a player stands: a repo's floor (null: the lobby), position on it (meters) and facing (radians). */
export interface Spot {
  floor: string | null;
  x: number;
  z: number;
  yaw: number;
}

export interface Player {
  /** GitHub user id. */
  id: number;
  login: string;
  name: string | null;
  /** null: no custom character yet (draw the look derived from the login). */
  character: Character | null;
  /** null until their first move. */
  at: Spot | null;
}

/** A move in a `moves` batch: [id, floor, x, z, yaw]. */
export type MoveTuple = [number, string | null, number, number, number];

export type ServerMessage =
  | { t: 'welcome'; you: number; building: string; players: Player[] }
  | { t: 'join'; player: Player }
  | { t: 'leave'; id: number }
  | { t: 'moves'; m: MoveTuple[] }
  | { t: 'character'; id: number; character: Character | null };

/** Close codes the client can act on (4000–4999 are for applications). */
export const CLOSE = {
  /** Personal and demo buildings are single-player: don't reconnect. */
  singlePlayer: 4000,
  /** The same person opened this building somewhere else (another tab): don't reconnect. */
  replaced: 4001,
  /** Not signed in (or signed out meanwhile): show the sign-in screen. */
  signedOut: 4401,
  /** No access to this building (not a member, no subscription, app uninstalled). */
  forbidden: 4403,
  /** No building selected, or the session switched buildings: reload the building. */
  noBuilding: 4409,
  /** The building is full. */
  full: 4429,
  /** Server shutting down (deploy): reconnect after a moment. */
  goingAway: 1001,
  /** Something broke on our side: reconnect after a moment. */
  internalError: 1011,
} as const;

const MAX_COORD = 1000;
const round = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits;
const coord = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= MAX_COORD ? round(v, 2) : null);

/** A client's `{"t":"move","floor":"repo"|null,"x":1.5,"z":-3,"yaw":0.7}`, or null if it isn't one. */
export function parseMove(data: string): Spot | null {
  let m;
  try {
    m = JSON.parse(data);
  } catch {
    return null;
  }
  if (!m || m.t !== 'move') return null;
  const floor = m.floor === null ? null : typeof m.floor === 'string' && REPO_RE.test(m.floor) ? m.floor : undefined;
  const x = coord(m.x);
  const z = coord(m.z);
  const yaw = typeof m.yaw === 'number' && Number.isFinite(m.yaw) ? round(Math.atan2(Math.sin(m.yaw), Math.cos(m.yaw)), 3) : null;
  if (floor === undefined || x === null || z === null || yaw === null) return null;
  return { floor, x, z, yaw };
}
