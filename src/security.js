// HTTP hardening shared by both modes: security headers and rate limits.
import crypto from 'node:crypto';

/** Token-bucket rate limiter keyed by IP or session. */
export function rateLimiter({ capacity, perMinute }) {
  const buckets = new Map();
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
export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff) return xff.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

export function baseSecurityHeaders({ https }) {
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

/** Constant-time string comparison. */
export function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
