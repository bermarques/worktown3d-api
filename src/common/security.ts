// HTTP hardening shared by both modes: security headers, rate limits, CSRF and client address.
import crypto from 'node:crypto';
import type { Request } from 'express';
import type { AppConfig } from '../config/app-config.js';

export type RateLimiter = (key: string) => boolean;

/** Token-bucket rate limiter keyed by IP or session. */
export function rateLimiter({ capacity, perMinute }: { capacity: number; perMinute: number }): RateLimiter {
  const buckets = new Map<string, { tokens: number; at: number }>();
  const refill = perMinute / 60_000;
  setInterval(() => {
    const now = Date.now();
    for (const [k, b] of buckets) if (now - b.at > 10 * 60_000) buckets.delete(k);
  }, 60_000).unref();
  return (key) => {
    const now = Date.now();
    let b = buckets.get(key);
    if (!b) {
      if (buckets.size > 50_000) buckets.clear(); // memory guard under attack
      b = { tokens: capacity, at: now };
      buckets.set(key, b);
    }
    b.tokens = Math.min(capacity, b.tokens + (now - b.at) * refill);
    b.at = now;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };
}

/** Client IP; only trusts X-Forwarded-For when explicitly told the app sits behind a proxy. */
export function clientIp(req: Request, trustProxy: boolean) {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

export function baseSecurityHeaders({ https }: { https: boolean }): Record<string, string> {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    ...(https ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
  };
}

/** CSRF: writes need our custom header (can't be sent cross-site without CORS) and a matching Origin. */
export function sameOrigin(req: Request, config: AppConfig) {
  if (req.headers['x-worktown3d'] !== '1') return false;
  const origin = req.headers.origin;
  if (!origin) return true; // same-origin fetches may omit it; the custom header already proves it's our page
  if (config.hosted) return origin === config.origin;
  return config.allowedHosts.has(origin.replace(/^https?:\/\//, ''));
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
