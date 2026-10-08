import crypto from "node:crypto";

const API = (process.env.STRIPE_API_BASE || "https://api.stripe.com").replace(
  /\/+$/,
  "",
);

export function encodeForm(params, prefix = "", out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) {
      v.forEach((item, i) =>
        item && typeof item === "object"
          ? encodeForm(item, `${key}[${i}]`, out)
          : out.append(`${key}[${i}]`, String(item)),
      );
    } else if (typeof v === "object") {
      encodeForm(v, key, out);
    } else {
      out.append(key, String(v));
    }
  }
  return out;
}

export class StripeError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export function createStripe(secretKey) {
  async function call(method, path, params) {
    if (!/^[a-z_]+(\/[A-Za-z0-9_]+)*$/.test(path))
      throw new StripeError("Invalid Stripe path", 400);
    const url = new URL(`${API}/v1/${path}`);
    let body;
    if (params && method === "GET") url.search = encodeForm(params).toString();
    else if (params) body = encodeForm(params).toString();
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${secretKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new StripeError("Could not reach Stripe", 502);
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.error(
        `[stripe] ${method} ${path} -> ${res.status}: ${json.error ? json.error.message : "no details"}`,
      );
      throw new StripeError(
        "Payments are temporarily unavailable. Please try again in a moment.",
        502,
      );
    }
    return json;
  }
  return {
    get: (path, query) => call("GET", path, query),
    post: (path, params) => call("POST", path, params),
  };
}

export function verifyWebhook(rawBody, header, secret, toleranceSec = 300) {
  const parts = String(header || "")
    .split(",")
    .map((p) => p.trim().split("="));
  const timestamp = Number((parts.find(([k]) => k === "t") || [])[1]);
  const signatures = parts.filter(([k]) => k === "v1").map(([, v]) => v);
  if (!timestamp || !signatures.length)
    throw new StripeError("Missing Stripe signature", 400);
  if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSec)
    throw new StripeError("Stripe signature is too old", 400);
  const expected = crypto
    .createHmac("sha256", secret)
    .update(Buffer.concat([Buffer.from(`${timestamp}.`), rawBody]))
    .digest("hex");
  const ok = signatures.some(
    (sig) =>
      sig.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)),
  );
  if (!ok) throw new StripeError("Invalid Stripe signature", 400);
  return JSON.parse(rawBody.toString("utf8"));
}
