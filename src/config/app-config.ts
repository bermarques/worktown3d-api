// Startup configuration, read once from the environment. Two modes:
//  - Local (default): acts as you through the GitHub CLI (`gh`). Listens on localhost only.
//  - Hosted (GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET + PUBLIC_URL + DATABASE_URL set): everyone signs in with GitHub and
//    every GitHub call uses *their own* token, so GitHub enforces what each person can see and do. `gh` is never used.

/** A setting is missing or wrong. The server prints the message and stops. */
export class ConfigError extends Error {}

const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

const list = (value: string | undefined) =>
  (value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

function requireAll(env: NodeJS.ProcessEnv, vars: string[], needs: string) {
  const set = vars.filter((k) => env[k]);
  if (set.length && set.length < vars.length) {
    throw new ConfigError(`${needs} all of ${vars.join(', ')} (missing: ${vars.filter((k) => !env[k]).join(', ')}).`);
  }
  return set.length === vars.length;
}

export class AppConfig {
  readonly port: number;
  /** Interface to listen on; undefined means all of them (IPv6 and IPv4). */
  readonly host: string | undefined;
  /** `--demo`: local mode with the fictional company, even when `gh` is set up. */
  readonly forceDemo: boolean;
  readonly hosted: boolean;
  /** The web app's address; the browser only ever talks to this origin. */
  readonly origin: string;
  readonly publicUrl: URL;
  /** Cookies get Secure (and the __Host- prefix), and responses HSTS. */
  readonly secure: boolean;
  readonly trustProxy: boolean;
  /** Host headers we answer for (DNS-rebinding protection). */
  readonly allowedHosts: Set<string>;
  /** Lower-cased organizations this server opens buildings for; empty means any. */
  readonly allowedOrgs: string[];
  readonly github: { clientId: string; clientSecret: string; scopes: string; appSlug: string | null } | null;
  readonly databaseUrl: string | null;
  readonly stripe: { secretKey: string; priceId: string; webhookSecret: string; complimentaryOrgs: string[] } | null;

  constructor(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv) {
    this.port = Number(env.PORT) || 3001;
    this.forceDemo = argv.includes('--demo');

    this.hosted = requireAll(env, ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'], 'Hosted mode needs');
    if (this.hosted && !env.PUBLIC_URL) throw new ConfigError('Hosted mode needs PUBLIC_URL (the address people open the web app at).');
    let publicUrl: URL | null;
    try {
      publicUrl = new URL(env.PUBLIC_URL || 'http://localhost:3000');
    } catch {
      publicUrl = null;
    }
    if (!publicUrl || !/^https?:$/.test(publicUrl.protocol) || publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash) {
      throw new ConfigError('PUBLIC_URL must be just an origin, like https://worktown3d.example.com');
    }
    if (!this.hosted && !LOOPBACK.includes(publicUrl.hostname)) {
      throw new ConfigError('Local mode only runs on this machine: PUBLIC_URL must be a localhost address (or set up hosted mode).');
    }
    this.publicUrl = publicUrl;
    this.origin = publicUrl.origin;
    this.secure = this.hosted && publicUrl.protocol === 'https:';
    this.host = env.HOST || (this.hosted ? undefined : '127.0.0.1');
    this.trustProxy = env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true';
    this.allowedOrgs = list(env.ALLOWED_ORGS).map((s) => s.toLowerCase());
    const webPort = publicUrl.port ? `:${publicUrl.port}` : '';
    this.allowedHosts = new Set(this.hosted ? [publicUrl.host] : LOOPBACK.map((h) => h + webPort));

    this.github = this.hosted
      ? {
          clientId: env.GITHUB_CLIENT_ID!,
          clientSecret: env.GITHUB_CLIENT_SECRET!,
          scopes: env.GITHUB_OAUTH_SCOPES ?? 'read:org repo',
          appSlug: env.GITHUB_APP_SLUG || null,
        }
      : null;

    if (this.hosted && !env.DATABASE_URL) throw new ConfigError('Hosted mode needs DATABASE_URL (a PostgreSQL connection string).');
    this.databaseUrl = this.hosted ? env.DATABASE_URL! : null;

    const billing = requireAll(env, ['STRIPE_SECRET_KEY', 'STRIPE_PRICE_ID', 'STRIPE_WEBHOOK_SECRET'], 'Subscriptions need');
    if (billing && !/^price_[A-Za-z0-9]+$/.test(env.STRIPE_PRICE_ID!)) {
      throw new ConfigError('STRIPE_PRICE_ID should look like price_123... (the Price ID of your plan in Stripe, not the product ID).');
    }
    this.stripe =
      this.hosted && billing
        ? {
            secretKey: env.STRIPE_SECRET_KEY!,
            priceId: env.STRIPE_PRICE_ID!,
            webhookSecret: env.STRIPE_WEBHOOK_SECRET!,
            complimentaryOrgs: list(env.COMPLIMENTARY_ORGS),
          }
        : null;
  }

  orgAllowed(owner: string) {
    return !this.allowedOrgs.length || this.allowedOrgs.includes(owner.toLowerCase());
  }

  /** Where people install the GitHub App on their organization, when GITHUB_APP_SLUG is set. */
  get installUrl() {
    return this.github?.appSlug ? `https://github.com/apps/${encodeURIComponent(this.github.appSlug)}/installations/new` : null;
  }
}
