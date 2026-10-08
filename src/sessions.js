// Server-side sessions for hosted mode. The browser only ever holds a random session id in an
// HttpOnly cookie; GitHub tokens never leave the server.
import crypto from 'node:crypto';

const IDLE_MS = 7 * 24 * 3600_000;
const ABSOLUTE_MS = 30 * 24 * 3600_000;
const MAX_SESSIONS = 20_000;
const MAX_DEMO_SESSIONS = 1_000;
const DEMO_IDLE_MS = 2 * 3600_000;

export function parseCookies(header) {
  const out = Object.create(null);
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const name = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (name && !(name in out)) out[name] = value;
  }
  return out;
}

export function cookie(name, value, { maxAgeSec, secure }) {
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export const randomId = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

export function createSessionStore({ secure }) {
  // __Host- prefix: the browser refuses to set it without Secure, Path=/ and no Domain.
  const name = secure ? '__Host-wt3d_sid' : 'wt3d_sid';
  const sessions = new Map();

  setInterval(() => {
    const now = Date.now();
    for (const [id, s] of sessions) if (expired(s, now)) sessions.delete(id);
  }, 10 * 60_000).unref();

  function expired(s, now = Date.now()) {
    const idle = s.kind === 'demo' ? DEMO_IDLE_MS : IDLE_MS;
    return now - s.lastSeen > idle || now - s.createdAt > ABSOLUTE_MS;
  }

  const countDemo = () => {
    let n = 0;
    for (const s of sessions.values()) if (s.kind === 'demo') n++;
    return n;
  };

  /** Drop the oldest session matching `pick` (Map keeps insertion order). */
  function evict(pick) {
    for (const [id, s] of sessions) {
      if (pick(s)) {
        sessions.delete(id);
        return true;
      }
    }
    return false;
  }

  return {
    cookieName: name,

    create(data) {
      // Anonymous demo sessions are cheap to create, so they get their own cap and are evicted first;
      // a flood of them can never push signed-in people out.
      if (data.kind === 'demo' && countDemo() >= MAX_DEMO_SESSIONS) evict((s) => s.kind === 'demo');
      if (sessions.size >= MAX_SESSIONS) evict((s) => s.kind === 'demo') || evict(() => true);
      const now = Date.now();
      const s = { ...data, id: randomId(), createdAt: now, lastSeen: now };
      sessions.set(s.id, s);
      return s;
    },

    get(req) {
      const id = parseCookies(req.headers.cookie)[name];
      if (!id || id.length > 100) return null;
      const s = sessions.get(id);
      if (!s) return null;
      if (expired(s)) {
        sessions.delete(id);
        return null;
      }
      s.lastSeen = Date.now();
      return s;
    },

    destroy(s) {
      if (s) sessions.delete(s.id);
    },

    setCookie: (s) => cookie(name, s.id, { maxAgeSec: Math.floor(ABSOLUTE_MS / 1000), secure }),
    clearCookie: () => cookie(name, '', { maxAgeSec: 0, secure }),
  };
}
