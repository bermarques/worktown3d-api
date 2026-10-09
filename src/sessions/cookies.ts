// Cookie helpers for the session and sign-in cookies (hosted mode).
import crypto from 'node:crypto';

export function parseCookies(header: string | undefined) {
  const out: Record<string, string> = Object.create(null);
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

export function cookie(name: string, value: string, { maxAgeSec, secure }: { maxAgeSec: number; secure: boolean }) {
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSec}`];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export const randomId = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
