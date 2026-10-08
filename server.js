// Worktown3D API: a JSON API backed by GitHub, reached through the Worktown3D web app (which proxies
// /api, /auth and /stripe to it), so the browser only ever talks to one origin: PUBLIC_URL.
//
// Two modes:
//  - Local (default): acts as you through the GitHub CLI (`gh`). Listens on localhost only.
//  - Hosted (GITHUB_CLIENT_ID + GITHUB_CLIENT_SECRET + PUBLIC_URL set): everyone signs in with GitHub and every
//    GitHub call uses *their own* token, so GitHub enforces what each person can see and do. `gh` is never used.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  /* no .env file: use the real environment */
}

const { detectGh } = await import('./src/gh.js');
const { cliClient, createTokenClient, GhError } = await import('./src/github-client.js');
const { createGithubProvider, fetchAvatar } = await import('./src/github-provider.js');
const { createDemoProvider } = await import('./src/demo-provider.js');
const { getConfig, setConnection, localSettings } = await import('./src/config.js');
const { createSettings, memorySettings } = await import('./src/settings.js');
const { connectDatabase } = await import('./src/db.js');
const { createPgRepo } = await import('./src/repo.js');
const { createSessionStore } = await import('./src/sessions.js');
const { createAuth } = await import('./src/auth.js');
const { rateLimiter, clientIp, baseSecurityHeaders } = await import('./src/security.js');
const { createStripe } = await import('./src/stripe.js');
const { createBilling, PLAN } = await import('./src/billing.js');

const PORT = Number(process.env.PORT) || 3001;
const FORCE_DEMO = process.argv.includes('--demo');
const DEFAULT_FLOOR_COUNT = 15;

const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO_RE = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

// ---------------------------------------------------------------- mode
const env = process.env;
const hostedVars = ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'];
const hostedSet = hostedVars.filter((k) => env[k]);
if (hostedSet.length && hostedSet.length < hostedVars.length) {
  console.error(`\n  Hosted mode needs all of ${hostedVars.join(', ')} (missing: ${hostedVars.filter((k) => !env[k]).join(', ')}).\n`);
  process.exit(1);
}
const HOSTED = hostedSet.length === hostedVars.length;
if (HOSTED && !env.PUBLIC_URL) {
  console.error('\n  Hosted mode needs PUBLIC_URL (the address people open the web app at).\n');
  process.exit(1);
}
let PUBLIC_URL;
try {
  PUBLIC_URL = new URL(env.PUBLIC_URL || 'http://localhost:3000');
} catch {
  PUBLIC_URL = null;
}
if (!PUBLIC_URL || !/^https?:$/.test(PUBLIC_URL.protocol) || PUBLIC_URL.pathname !== '/' || PUBLIC_URL.search || PUBLIC_URL.hash) {
  console.error('\n  PUBLIC_URL must be just an origin, like https://worktown3d.example.com\n');
  process.exit(1);
}
const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];
if (!HOSTED && !LOOPBACK.includes(PUBLIC_URL.hostname)) {
  console.error('\n  Local mode only runs on this machine: PUBLIC_URL must be a localhost address (or set up hosted mode).\n');
  process.exit(1);
}
const SECURE = HOSTED && PUBLIC_URL.protocol === 'https:';
const HOST = env.HOST || (HOSTED ? undefined : '127.0.0.1');
const TRUST_PROXY = env.TRUST_PROXY === '1' || env.TRUST_PROXY === 'true';
const ALLOWED_ORGS = (env.ALLOWED_ORGS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

const ORIGIN = PUBLIC_URL.origin;
const webPort = PUBLIC_URL.port ? `:${PUBLIC_URL.port}` : '';
const ALLOWED_HOSTS = new Set(HOSTED ? [PUBLIC_URL.host] : LOOPBACK.map((h) => h + webPort));

const sessions = HOSTED ? createSessionStore({ secure: SECURE }) : null;
const auth = HOSTED
  ? createAuth({
      publicUrl: ORIGIN,
      clientId: env.GITHUB_CLIENT_ID,
      clientSecret: env.GITHUB_CLIENT_SECRET,
      scopes: env.GITHUB_OAUTH_SCOPES ?? 'read:org repo',
      sessions,
      secure: SECURE,
    })
  : null;

// ---------------------------------------------------------------- database (hosted mode)
if (HOSTED && !env.DATABASE_URL) {
  console.error('\n  Hosted mode needs DATABASE_URL (a PostgreSQL connection string).\n');
  process.exit(1);
}
let pool = null;
if (HOSTED) {
  try {
    pool = await connectDatabase(env.DATABASE_URL);
  } catch (e) {
    console.error(`\n  Could not connect to the database: ${e.message}\n`);
    process.exit(1);
  }
}
const settingsFor = HOSTED ? createSettings(pool) : localSettings;

// ---------------------------------------------------------------- subscriptions (hosted mode, optional)
const billingVars = ['STRIPE_SECRET_KEY', 'STRIPE_PRICE_ID', 'STRIPE_WEBHOOK_SECRET'];
const billingSet = billingVars.filter((k) => env[k]);
if (billingSet.length && billingSet.length < billingVars.length) {
  console.error(`\n  Subscriptions need all of ${billingVars.join(', ')} (missing: ${billingVars.filter((k) => !env[k]).join(', ')}).\n`);
  process.exit(1);
}
if (billingSet.length && !/^price_[A-Za-z0-9]+$/.test(env.STRIPE_PRICE_ID)) {
  console.error('\n  STRIPE_PRICE_ID should look like price_123... (the Price ID of your plan in Stripe, not the product ID).\n');
  process.exit(1);
}
const COMPLIMENTARY_ORGS = (env.COMPLIMENTARY_ORGS || '')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);
const billing =
  HOSTED && billingSet.length
    ? createBilling({
        repo: createPgRepo(pool),
        stripe: createStripe(env.STRIPE_SECRET_KEY),
        priceId: env.STRIPE_PRICE_ID,
        webhookSecret: env.STRIPE_WEBHOOK_SECRET,
        publicUrl: ORIGIN,
        complimentary: COMPLIMENTARY_ORGS,
      })
    : null;

// ---------------------------------------------------------------- local-mode state (gh CLI)
let gh = { installed: false, authed: false };
const localDemo = createDemoProvider();
let localProvider = localDemo;

function selectLocalProvider() {
  const cfg = getConfig();
  localProvider = !FORCE_DEMO && !cfg.demo && gh.authed ? createGithubProvider({ client: cliClient, viewer: gh.user }) : localDemo;
  cache.clear();
}

// ---------------------------------------------------------------- cache (namespaced per viewer)
const cache = new Map();
const MAX_CACHE = 5000;
function cached(key, ttlMs, fn, fresh = false) {
  const hit = cache.get(key);
  if (!fresh && hit && Date.now() - hit.at < ttlMs) return hit.promise;
  if (cache.size > MAX_CACHE) for (const k of [...cache.keys()].slice(0, 1000)) cache.delete(k);
  const promise = fn();
  cache.set(key, { at: Date.now(), promise });
  promise.catch(() => cache.delete(key));
  return promise;
}
function invalidate(prefix) {
  for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k);
}

// ---------------------------------------------------------------- helpers
class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    Object.assign(this, extra);
  }
}

const securityHeaders = baseSecurityHeaders({ https: SECURE });

function send(res, status, body, headers = {}) {
  const isJson = typeof body === 'object' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 200_000) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {});
      } catch {
        reject(new HttpError(400, 'Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function need(value, re, what) {
  if (typeof value !== 'string' || !re.test(value)) throw new HttpError(400, `Invalid ${what}`);
  return value;
}

const list = (v, max = 20) => (Array.isArray(v) ? v.slice(0, max) : []);
const orgAllowed = (owner) => !ALLOWED_ORGS.length || ALLOWED_ORGS.includes(owner.toLowerCase());

// ---------------------------------------------------------------- request context
/**
 * Everything a request needs: who is asking (provider acting as them), which building, and where its
 * settings live. Cache keys are namespaced per viewer so one person's private data never reaches another.
 */
function contextFor(req) {
  if (!HOSTED) {
    const owner = localProvider.mode === 'demo' ? 'demo-co' : getConfig().owner;
    return {
      session: null,
      provider: localProvider,
      ns: localProvider.mode,
      owner,
      viewer: localProvider.viewer,
      settings: owner ? settingsFor(owner) : null,
    };
  }
  const s = sessions.get(req);
  if (!s) return { session: null, provider: null };
  if (s.kind === 'demo') {
    s.provider = s.provider || createDemoProvider();
    s.demoSettings = s.demoSettings || memorySettings();
    return { session: s, provider: s.provider, ns: `d:${s.id}`, owner: 'demo-co', viewer: s.provider.viewer, settings: s.demoSettings };
  }
  s.provider = s.provider || createGithubProvider({ client: createTokenClient(() => auth.validToken(s)), viewer: s.user });
  return { session: s, provider: s.provider, ns: `u:${s.user.id}`, owner: s.org, viewer: s.user, settings: s.org ? settingsFor(s.org) : null };
}

function requireSession(ctx) {
  if (!ctx.provider) throw new HttpError(401, 'Please sign in with GitHub', { signedOut: true });
}

/** Is the viewer allowed into this building, and as what? Re-checked every few minutes so people who leave lose access. */
async function accessFor(ctx, owner, fresh = false) {
  if (!orgAllowed(owner) && !(ctx.session && ctx.session.kind === 'demo')) {
    throw new HttpError(403, `This Worktown3D server isn't set up for ${owner}`);
  }
  return cached(`${ctx.ns}:${owner}:access`, 5 * 60_000, () => ctx.provider.access(owner), fresh);
}

async function requireOrg(ctx) {
  requireSession(ctx);
  if (!ctx.owner) throw new HttpError(409, 'No GitHub organization selected yet', { noOrg: true });
  let access = await accessFor(ctx, ctx.owner);
  if (access.role === 'none') {
    if (ctx.session) ctx.session.org = null;
    throw new HttpError(403, `You're not a member of ${ctx.owner} on GitHub`, { noOrg: true });
  }
  if (billing && ctx.session && ctx.session.kind === 'user') {
    const personal = access.role === 'owner' ? { memberOf: await memberOrgs(ctx) } : undefined;
    const ent = await billing.entitlement(ctx.owner, personal);
    if (!ent.ok) {
      const message =
        ent.reason === 'inactive'
          ? `${ctx.owner}'s Worktown3D subscription isn't active. Ask @${ent.ownerLogin} to renew it.`
          : access.canManage
            ? `${ctx.owner} isn't on Worktown3D yet. Subscribe and connect it to open the building.`
            : `${ctx.owner} isn't on Worktown3D yet. Ask one of its owners to subscribe.`;
      throw new HttpError(402, message, { needsSubscription: true });
    }
    access = { ...access, billing: { pastDue: !!ent.pastDue, bonus: !!ent.bonus, via: ent.via || null, complimentary: !!ent.complimentary } };
  }
  return access;
}

/** Organizations the viewer belongs to (cached). */
async function memberOrgs(ctx) {
  const owners = await cached(`${ctx.ns}:owners`, 60_000, () => ctx.provider.listOwners());
  return owners.filter((o) => o.type === 'Organization').map((o) => o.login);
}

function requireSubscriber(ctx) {
  if (!billing) throw new HttpError(404, 'Subscriptions are not enabled on this server');
  requireSession(ctx);
  if (ctx.session.kind !== 'user') throw new HttpError(403, 'Sign in with GitHub to manage a subscription');
  return ctx.session.user;
}

async function getWorld(ctx, fresh = false) {
  return cached(`${ctx.ns}:${ctx.owner}:world`, 120_000, () => ctx.provider.getWorld(ctx.owner), fresh);
}

async function floorsFor(ctx, world) {
  const settings = await ctx.settings.get();
  const names = new Set(world.repos.map((r) => r.name));
  if (settings.floors) return settings.floors.filter((n) => names.has(n));
  return world.repos.filter((r) => !r.isArchived).slice(0, DEFAULT_FLOOR_COUNT).map((r) => r.name);
}

function statusPayload(ctx) {
  if (HOSTED) {
    const s = ctx.session;
    return {
      hosted: true,
      mode: s ? (s.kind === 'demo' ? 'demo' : 'github') : null,
      user: s && s.kind === 'user' ? s.user : null,
      viewer: ctx.viewer || null,
      owner: ctx.owner || null,
      installUrl: env.GITHUB_APP_SLUG ? `https://github.com/apps/${encodeURIComponent(env.GITHUB_APP_SLUG)}/installations/new` : null,
      billing: !!billing,
    };
  }
  const cfg = getConfig();
  return {
    hosted: false,
    mode: localProvider.mode,
    forcedDemo: FORCE_DEMO,
    chosenDemo: !!cfg.demo,
    gh: { installed: gh.installed, authed: gh.authed, version: gh.version || null, user: gh.user || null, error: gh.error || null },
    viewer: localProvider.viewer,
    owner: ctx.owner,
  };
}

// ---------------------------------------------------------------- API routes
const routes = [];
const route = (method, pattern, handler, { local = true, hosted = true } = {}) => {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, re, keys, handler, local, hosted });
};

route('GET', '/api/status', async ({ ctx }) => statusPayload(ctx));

// Local mode only: re-detect the GitHub CLI after installing/signing in.
route(
  'POST',
  '/api/recheck',
  async ({ ctx }) => {
    gh = await detectGh();
    selectLocalProvider();
    return statusPayload(contextFor(ctx.req));
  },
  { hosted: false },
);

// Hosted only: a private demo sandbox for visitors who haven't signed in (great for a landing page).
route(
  'POST',
  '/api/demo',
  async ({ ctx, res, ip }) => {
    if (ctx.session && ctx.session.kind === 'user') throw new HttpError(409, "You're signed in — sign out to try the demo");
    if (!demoLimiter(ip)) throw new HttpError(429, 'Too many demo sessions from this network, try again later');
    if (!ctx.session) {
      const s = sessions.create({ kind: 'demo' });
      res.setHeader('Set-Cookie', sessions.setCookie(s));
    }
    return { ok: true };
  },
  { local: false },
);

route('GET', '/api/owners', async ({ ctx }) => {
  if (!HOSTED) {
    return gh.authed && !FORCE_DEMO ? createGithubProvider({ client: cliClient, viewer: gh.user }).listOwners() : localProvider.listOwners();
  }
  requireSession(ctx);
  const owners = await cached(`${ctx.ns}:owners`, 60_000, () => ctx.provider.listOwners());
  const visible = owners.filter((o) => orgAllowed(o.login) || ctx.session.kind === 'demo');
  if (!billing || ctx.session.kind !== 'user') return visible;
  const me = ctx.session.user;
  const orgs = visible.filter((o) => o.type === 'Organization').map((o) => o.login);
  return Promise.all(visible.map(async (o) => {
    const personal = o.type === 'User' && o.login.toLowerCase() === me.login.toLowerCase() ? { memberOf: orgs } : undefined;
    const [ent, ws] = await Promise.all([billing.entitlement(o.login, personal), billing.workspace(o.login)]);
    return { ...o, building: { open: ent.ok, bonus: !!ent.bonus, via: ent.via || null, reason: ent.reason || null, connectedByMe: !!ws && ws.ownerId === String(me.id), connectedBy: ws ? ws.ownerLogin : null } };
  }));
});

route('POST', '/api/connect', async ({ ctx, body }) => {
  if (!HOSTED) {
    if (body.demo) setConnection({ owner: getConfig().owner, demo: true });
    else {
      if (!gh.authed) throw new HttpError(409, 'GitHub CLI is not logged in. Run `gh auth login` first.');
      setConnection({ owner: need(body.owner, OWNER_RE, 'organization'), demo: false });
    }
    selectLocalProvider();
    return statusPayload(contextFor(ctx.req));
  }
  requireSession(ctx);
  if (ctx.session.kind === 'demo') return statusPayload(ctx);
  const owner = need(body.owner, OWNER_RE, 'organization');
  const access = await accessFor(ctx, owner, true);
  if (access.role === 'none') throw new HttpError(403, `You're not a member of ${owner} on GitHub`);
  ctx.session.org = owner;
  return statusPayload(contextFor(ctx.req));
});

// ---- subscriptions
route('GET', '/api/billing', async ({ ctx }) => {
  const user = requireSubscriber(ctx);
  return billing.summary(user);
}, { local: false });
route('POST', '/api/billing/checkout', async ({ ctx }) => {
  const user = requireSubscriber(ctx);
  return billing.checkout(user);
}, { local: false });
route('POST', '/api/billing/confirm', async ({ ctx, body }) => {
  const user = requireSubscriber(ctx);
  return billing.confirm(user, body.sessionId);
}, { local: false });
route('POST', '/api/billing/portal', async ({ ctx }) => {
  const user = requireSubscriber(ctx);
  return billing.portal(user);
}, { local: false });
route(
  'POST',
  '/api/workspaces',
  async ({ ctx, body }) => {
    const user = requireSubscriber(ctx);
    const org = need(body.org, OWNER_RE, 'organization');
    if (!orgAllowed(org)) throw new HttpError(403, `This Worktown3D server isn't set up for ${org}`);
    const result = await billing.connect(user, org, ctx.provider);
    invalidate(`${ctx.ns}:${org}:access`);
    return result;
  },
  { local: false },
);
route(
  'DELETE',
  '/api/workspaces/:org',
  async ({ ctx, params }) => {
    const user = requireSubscriber(ctx);
    return billing.disconnect(user, need(params.org, OWNER_RE, 'organization'));
  },
  { local: false },
);

route('GET', '/api/world', async ({ ctx, query }) => {
  const access = await requireOrg(ctx);
  const world = await getWorld(ctx, query.get('fresh') === '1');
  return {
    mode: ctx.provider.mode,
    viewer: ctx.viewer,
    access,
    owner: world.owner,
    repos: world.repos,
    memberCount: world.members ? world.members.length : null,
    members: world.members ? world.members.map((m) => ({ login: m.login, name: m.name })) : null,
    floors: await floorsFor(ctx, world),
    links: (await ctx.settings.get()).links,
  };
});

route('GET', '/api/floor/:repo', async ({ ctx, params, query }) => {
  const repo = need(params.repo, REPO_RE, 'repository name');
  await requireOrg(ctx);
  const world = await getWorld(ctx);
  return cached(`${ctx.ns}:${ctx.owner}:floor:${repo}`, 30_000, () => ctx.provider.getFloor(world, repo), query.get('fresh') === '1');
});

route('GET', '/api/labels/:repo', async ({ ctx, params }) => {
  const repo = need(params.repo, REPO_RE, 'repository name');
  await requireOrg(ctx);
  return cached(`${ctx.ns}:${ctx.owner}:labels:${repo}`, 300_000, () => ctx.provider.listLabels(ctx.owner, repo));
});

// Building layout (floors + links) is Worktown3D's own data, not GitHub's, so we enforce who may change it.
route('PUT', '/api/settings', async ({ ctx, body }) => {
  const access = await requireOrg(ctx);
  if (!access.canManage) throw new HttpError(403, 'Only organization owners can change the building layout');
  const world = await getWorld(ctx);
  const patch = {};
  if (body.floors !== undefined) {
    if (!Array.isArray(body.floors) || body.floors.length > 500) throw new HttpError(400, 'floors must be an array');
    patch.floors = [...new Set(body.floors.map((f) => need(f, REPO_RE, 'repository name')))];
  }
  if (body.links !== undefined) {
    if (!Array.isArray(body.links) || body.links.length > 200) throw new HttpError(400, 'links must be an array of at most 200');
    patch.links = body.links.map((l) => ({
      from: need(l && l.from, REPO_RE, 'repository name'),
      to: need(l && l.to, REPO_RE, 'repository name'),
      kind: String((l && l.kind) || 'depends on').slice(0, 40),
    }));
  }
  const settings = await ctx.settings.update(patch);
  invalidate(`${ctx.ns}:${ctx.owner}:world`);
  return { floors: await floorsFor(ctx, world), links: settings.links };
});

route('POST', '/api/repos', async ({ ctx, body }) => {
  const access = await requireOrg(ctx);
  if (!access.canCreateRepo) throw new HttpError(403, `You don't have permission to create repositories in ${ctx.owner}`);
  const world = await getWorld(ctx);
  const name = need(body.name, REPO_RE, 'repository name');
  const created = await ctx.provider.createRepo(world, {
    name,
    description: String(body.description || '').slice(0, 350),
    isPrivate: body.isPrivate !== false,
    autoInit: body.autoInit !== false,
  });
  // Give the new project a floor right away (if this person may change the layout).
  if (access.canManage) {
    const floors = await floorsFor(ctx, world);
    await ctx.settings.update({ floors: [...floors.filter((f) => f !== created.name), created.name] });
  }
  invalidate(`${ctx.ns}:${ctx.owner}:world`);
  return created;
});

route('POST', '/api/issues/:repo', async ({ ctx, params, body }) => {
  await requireOrg(ctx);
  const repo = need(params.repo, REPO_RE, 'repository name');
  const title = String(body.title || '').trim();
  if (!title) throw new HttpError(400, 'An issue needs a title');
  const assignees = list(body.assignees, 10).map((a) => need(a, LOGIN_RE, 'assignee'));
  const labels = list(body.labels, 20).map((l) => String(l).slice(0, 50));
  const created = await ctx.provider.createIssue(ctx.owner, repo, { title: title.slice(0, 256), body: String(body.body || '').slice(0, 60_000), assignees, labels });
  invalidate(`${ctx.ns}:${ctx.owner}:floor:${repo}`);
  invalidate(`${ctx.ns}:${ctx.owner}:world`);
  return created;
});

route('PATCH', '/api/issues/:repo/:number', async ({ ctx, params, body }) => {
  await requireOrg(ctx);
  const repo = need(params.repo, REPO_RE, 'repository name');
  const number = Number(params.number);
  if (!Number.isInteger(number) || number < 1) throw new HttpError(400, 'Invalid issue number');
  const patch = {};
  if (body.assignees) patch.assignees = list(body.assignees, 10).map((a) => need(a, LOGIN_RE, 'assignee'));
  if (body.state) {
    if (!['open', 'closed'].includes(body.state)) throw new HttpError(400, 'Invalid state');
    patch.state = body.state;
  }
  const result = await ctx.provider.updateIssue(ctx.owner, repo, number, patch);
  invalidate(`${ctx.ns}:${ctx.owner}:floor:${repo}`);
  invalidate(`${ctx.ns}:${ctx.owner}:world`);
  return result;
});

route('POST', '/api/prs/:repo/:number/merge', async ({ ctx, params, body }) => {
  await requireOrg(ctx);
  const repo = need(params.repo, REPO_RE, 'repository name');
  const number = Number(params.number);
  if (!Number.isInteger(number) || number < 1) throw new HttpError(400, 'Invalid pull request number');
  const method = ['merge', 'squash', 'rebase'].includes(body.method) ? body.method : 'squash';
  const result = await ctx.provider.mergePR(ctx.owner, repo, number, method);
  invalidate(`${ctx.ns}:${ctx.owner}:floor:${repo}`);
  invalidate(`${ctx.ns}:${ctx.owner}:world`);
  return result;
});

// ---------------------------------------------------------------- avatars (same-origin proxy so canvases stay untainted)
const avatarCache = new Map();
async function avatarRoute(res, ctx, login) {
  need(login, LOGIN_RE, 'login');
  if (HOSTED) requireSession(ctx);
  if (ctx.provider && ctx.provider.mode === 'demo') return send(res, 404, 'no avatar');
  let entry = avatarCache.get(login);
  if (!entry || Date.now() - entry.at > 6 * 3600_000) {
    let img = null;
    try {
      img = await fetchAvatar(login);
    } catch {
      img = null;
    }
    entry = { at: Date.now(), img };
    if (avatarCache.size > 2000) avatarCache.clear();
    avatarCache.set(login, entry);
  }
  if (!entry.img) return send(res, 404, 'no avatar');
  res.writeHead(200, { 'Content-Type': entry.img.type, 'Cache-Control': 'private, max-age=3600' });
  res.end(entry.img.buffer);
}

// ---------------------------------------------------------------- server
const apiLimiter = rateLimiter({ capacity: 120, perMinute: 240 });
const writeLimiter = rateLimiter({ capacity: 20, perMinute: 30 });
const authLimiter = rateLimiter({ capacity: 10, perMinute: 20 });
const demoLimiter = rateLimiter({ capacity: 5, perMinute: 2 });

async function handle(req, res) {
  for (const [k, v] of Object.entries(securityHeaders)) res.setHeader(k, v);
  if (req.url === '/healthz') return send(res, 200, 'ok');

  // DNS-rebinding / host-header protection: only answer for the web app's host name (the proxy keeps it).
  if (!ALLOWED_HOSTS.has(req.headers.host)) return send(res, 421, 'unknown host');
  const url = new URL(req.url, 'http://placeholder');
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return send(res, 400, 'bad url');
  }
  if (pathname.includes('\0')) return send(res, 400, 'bad url');
  const ip = clientIp(req, TRUST_PROXY);

  // ---- sign-in (hosted only)
  if (pathname.startsWith('/auth/')) {
    if (!HOSTED) return send(res, 404, 'not found');
    if (!authLimiter(ip)) return send(res, 429, 'Too many sign-in attempts, try again in a minute');
    if (req.method === 'GET' && pathname === '/auth/login') return auth.login(req, res, url);
    if (req.method === 'GET' && pathname === '/auth/callback') return auth.callback(req, res, url);
    if (req.method === 'POST' && pathname === '/auth/logout') {
      if (!sameOrigin(req)) return send(res, 403, { error: 'Cross-site request blocked' });
      return auth.logout(req, res);
    }
    return send(res, 404, 'not found');
  }

  // ---- Stripe webhook
  if (pathname === '/stripe/webhook') {
    if (!billing || req.method !== 'POST') return send(res, 404, 'not found');
    let raw;
    try {
      raw = await readRaw(req, 1_000_000);
    } catch (e) {
      return send(res, e.status || 400, { error: e.message });
    }
    try {
      await billing.webhook(raw, req.headers['stripe-signature']);
      return send(res, 200, { received: true });
    } catch (e) {
      if (e.status === 400) return send(res, 400, { error: e.message });
      console.error('[stripe webhook]', e.message);
      return send(res, 500, { error: 'Webhook processing failed' }); // Stripe will retry
    }
  }

  // ---- API
  if (pathname.startsWith('/api/')) {
    const write = req.method !== 'GET';
    // CSRF: writes need our custom header (can't be sent cross-site without CORS) and a matching Origin.
    if (write && !sameOrigin(req)) return send(res, 403, { error: 'Cross-site request blocked' });
    const ctx = contextFor(req);
    ctx.req = req;
    const who = ctx.session ? ctx.session.id : ip;
    if (!apiLimiter(who) || (write && !writeLimiter(who))) return send(res, 429, { error: 'Slow down a little — too many requests' });

    if (req.method === 'GET' && pathname.startsWith('/api/avatar/')) {
      try {
        return await avatarRoute(res, ctx, pathname.slice('/api/avatar/'.length));
      } catch (e) {
        return send(res, e.status || 400, 'no avatar');
      }
    }
    for (const r of routes) {
      if (r.method !== req.method || (HOSTED ? !r.hosted : !r.local)) continue;
      const m = pathname.match(r.re);
      if (!m) continue;
      const params = Object.fromEntries(r.keys.map((k, i) => [k, m[i + 1]]));
      try {
        const body = write ? await readBody(req) : {};
        const result = await r.handler({ ctx, params, query: url.searchParams, body, res, ip });
        return send(res, 200, result ?? { ok: true });
      } catch (e) {
        return sendError(res, ctx, req, pathname, e);
      }
    }
    return send(res, 404, { error: 'Unknown API route' });
  }

  return send(res, 404, 'not found');
}

function sameOrigin(req) {
  if (req.headers['x-worktown3d'] !== '1') return false;
  const origin = req.headers.origin;
  if (!origin) return true; // same-origin fetches may omit it; the custom header already proves it's our page
  if (HOSTED) return origin === ORIGIN;
  return ALLOWED_HOSTS.has(origin.replace(/^https?:\/\//, ''));
}

function sendError(res, ctx, req, pathname, e) {
  let status = e.status && e.status >= 400 && e.status < 600 ? e.status : 500;
  // GitHub said the token is no good (revoked, expired): end this session cleanly.
  if (HOSTED && status === 401 && ctx.session && ctx.session.kind === 'user') {
    sessions.destroy(ctx.session);
    return send(res, 401, { error: 'Your GitHub sign-in expired. Please sign in again.', signedOut: true }, { 'Set-Cookie': sessions.clearCookie() });
  }
  if (status >= 500) console.error(`[api] ${req.method} ${pathname}: ${e.message}`);
  // Internal details stay in the server log when the app is exposed to other people.
  const message = HOSTED && status >= 500 && !(e instanceof GhError) ? 'Something went wrong on our side' : e.message || 'Something went wrong';
  const body = { error: message };
  if (e.signedOut) body.signedOut = true;
  if (e.noOrg) body.noOrg = true;
  if (e.needsSubscription) body.needsSubscription = true;
  return send(res, status, body);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error('[server]', e.message);
    if (!res.headersSent) send(res, 500, 'internal error');
    else res.destroy();
  });
});
// slow-client protection
server.headersTimeout = 20_000;
server.requestTimeout = 30_000;

if (!HOSTED) {
  gh = FORCE_DEMO ? gh : await detectGh();
  selectLocalProvider();
}

process.on('SIGTERM', () => {
  server.close();
  Promise.resolve(pool && pool.end()).finally(() => process.exit(0));
  setTimeout(() => process.exit(0), 5000).unref();
});

server.listen(PORT, HOST, () => {
  if (HOSTED) {
    console.log(`\n  🏢  Worktown3D API (hosted mode) for ${ORIGIN}  — listening on ${HOST || '*'}:${PORT}`);
    console.log(`  Sign-in callback URL: ${ORIGIN}/auth/callback`);
    if (ALLOWED_ORGS.length) console.log(`  Restricted to organizations: ${ALLOWED_ORGS.join(', ')}`);
    console.log('  Storage: PostgreSQL');
    if (billing) {
      console.log(`  Subscriptions: on (${PLAN.name}, ${env.STRIPE_SECRET_KEY.startsWith('sk_live_') ? 'LIVE' : 'test'} mode). Stripe webhook: ${ORIGIN}/stripe/webhook`);
      if (COMPLIMENTARY_ORGS.length) console.log(`  Free organizations: ${COMPLIMENTARY_ORGS.join(', ')}`);
    } else console.log('  Subscriptions: off (every organization member can open its building).');
    if (!SECURE) console.log('  ⚠️  PUBLIC_URL is not https — fine for local testing, never for production.');
    console.log('');
    return;
  }
  const s = statusPayload(contextFor({ headers: {} }));
  console.log(`\n  🏢  Worktown3D API on http://${HOST}:${PORT}, for the web app at ${ORIGIN}\n`);
  if (s.mode === 'github') {
    console.log(`  GitHub CLI ${s.gh.version} — signed in as @${s.gh.user.login}`);
    console.log(s.owner ? `  Connected organization: ${s.owner}` : '  Pick an organization in the browser to get started.');
  } else if (FORCE_DEMO) {
    console.log('  Running in demo mode (--demo) with a fictional company.');
  } else {
    console.log(`  Demo mode: ${gh.error || 'demo selected in the manager office'}`);
    if (!gh.installed) console.log('  Install the GitHub CLI (https://cli.github.com) and run `gh auth login` to use your real org.');
  }
  console.log('');
});
