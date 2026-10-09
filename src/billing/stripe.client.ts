import crypto from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../config/app-config.js';

const API = (process.env.STRIPE_API_BASE || 'https://api.stripe.com').replace(/\/+$/, '');
const logger = new Logger('Stripe');

type FormValue = string | number | boolean | null | undefined | FormValue[] | { [key: string]: FormValue };

export function encodeForm(params: Record<string, FormValue>, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) =>
        item && typeof item === 'object' ? encodeForm(item as Record<string, FormValue>, `${key}[${i}]`, out) : out.append(`${key}[${i}]`, String(item)),
      );
    } else if (typeof v === 'object') {
      encodeForm(v, key, out);
    } else {
      out.append(key, String(v));
    }
  }
  return out;
}

export class StripeError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Minimal Stripe API client (form-encoded requests, JSON responses). */
@Injectable()
export class StripeClient {
  private readonly secretKey: string;

  constructor(config: AppConfig) {
    this.secretKey = config.stripe!.secretKey;
  }

  // Stripe objects are read field by field, as they come.
  get(path: string, query?: Record<string, FormValue>): Promise<any> {
    return this.call('GET', path, query);
  }

  post(path: string, params?: Record<string, FormValue>): Promise<any> {
    return this.call('POST', path, params);
  }

  private async call(method: string, path: string, params?: Record<string, FormValue>) {
    if (!/^[a-z_]+(\/[A-Za-z0-9_]+)*$/.test(path)) throw new StripeError('Invalid Stripe path', 400);
    const url = new URL(`${API}/v1/${path}`);
    let body;
    if (params && method === 'GET') url.search = encodeForm(params).toString();
    else if (params) body = encodeForm(params).toString();
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.secretKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new StripeError('Could not reach Stripe', 502);
    }
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      logger.error(`${method} ${path} -> ${res.status}: ${json.error ? json.error.message : 'no details'}`);
      throw new StripeError('Payments are temporarily unavailable. Please try again in a moment.', 502);
    }
    return json;
  }
}

export function verifyWebhook(rawBody: Buffer, header: string | undefined, secret: string, toleranceSec = 300) {
  const parts = String(header || '')
    .split(',')
    .map((p) => p.trim().split('='));
  const timestamp = Number((parts.find(([k]) => k === 't') || [])[1]);
  const signatures = parts.filter(([k]) => k === 'v1').map(([, v]) => v);
  if (!timestamp || !signatures.length) throw new StripeError('Missing Stripe signature', 400);
  if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSec) throw new StripeError('Stripe signature is too old', 400);
  const expected = crypto
    .createHmac('sha256', secret)
    .update(Buffer.concat([Buffer.from(`${timestamp}.`), rawBody]))
    .digest('hex');
  const ok = signatures.some((sig) => sig.length === expected.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)));
  if (!ok) throw new StripeError('Invalid Stripe signature', 400);
  return JSON.parse(rawBody.toString('utf8'));
}
