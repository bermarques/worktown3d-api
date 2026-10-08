// Fictional sample company used when the GitHub CLI isn't available (or with `npm run demo`).
// Mutations (new issues, repos, merges, assignments) work in memory so the whole game loop can be tried out.
import { composeFloor } from './compose.js';

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const OWNER = {
  login: 'demo-co',
  type: 'Organization',
  name: 'Demo Co. (sample data)',
  description: 'A fictional company so you can explore before connecting GitHub',
  avatarUrl: null,
};

const VIEWER = { login: 'you-the-manager', name: 'You (Manager)', avatarUrl: null };

const MEMBERS = [
  ['ana-souza', 'Ana Souza'],
  ['ben-okafor', 'Ben Okafor'],
  ['chloe-martin', 'Chloé Martin'],
  ['devi-rao', 'Devi Rao'],
  ['emma-larsen', 'Emma Larsen'],
  ['felix-wagner', 'Felix Wagner'],
  ['grace-kim', 'Grace Kim'],
  ['hiro-tanaka', 'Hiro Tanaka'],
  ['isabel-ruiz', 'Isabel Ruiz'],
  ['jamal-reed', 'Jamal Reed'],
  ['kara-novak', 'Kara Novak'],
  ['liam-obrien', "Liam O'Brien"],
  ['maya-chen', 'Maya Chen'],
  ['noah-fischer', 'Noah Fischer'],
  ['olivia-silva', 'Olivia Silva'],
  ['priya-nair', 'Priya Nair'],
].map(([login, name]) => ({ login, name, avatarUrl: null }));

// People who contributed in the past but are no longer in the org — they must NOT appear in the building.
const FORMER = ['old-timer-oscar', 'quinn-moved-on'];

const LABELS = {
  bug: 'd73a4a',
  enhancement: 'a2eeef',
  'good first issue': '7057ff',
  performance: 'fbca04',
  docs: '0075ca',
  security: 'b60205',
  'tech debt': 'c5def5',
  ux: 'f9d0c4',
};

const REPOS = [
  {
    name: 'api-gateway',
    description: 'Edge API gateway, auth and rate limiting',
    language: 'Go',
    languageColor: '#00ADD8',
    team: ['ana-souza', 'devi-rao', 'hiro-tanaka', 'kara-novak', 'noah-fischer', 'old-timer-oscar'],
    issues: [
      'Rate limiter leaks buckets for idle API keys',
      'Add OpenTelemetry tracing to auth middleware',
      'Support JWT key rotation without restart',
      'Return 429 with Retry-After header',
      'Gateway crashes when upstream sends empty body',
      'Document the plugin interface',
      'Move config loading to Viper',
      'Add circuit breaker for billing service',
      'p99 latency regression after Go 1.24 upgrade',
      'Cache OIDC discovery document',
    ],
    prs: ['Add Retry-After header on throttled requests', 'Refactor middleware chain into composable handlers', 'Upgrade grpc-go to v1.70', 'Tracing: propagate W3C traceparent'],
    merged: ['Fix nil pointer in health check', 'Add request ID to all log lines', 'Bump alpine base image', 'Graceful shutdown on SIGTERM', 'Add /readyz endpoint'],
  },
  {
    name: 'web-app',
    description: 'Customer-facing React dashboard',
    language: 'TypeScript',
    languageColor: '#3178c6',
    team: ['ben-okafor', 'chloe-martin', 'emma-larsen', 'grace-kim', 'isabel-ruiz', 'maya-chen', 'olivia-silva', 'quinn-moved-on'],
    issues: [
      'Dark mode toggle forgets preference after reload',
      'Dashboard chart flickers on resize',
      'Add CSV export to invoices table',
      'Onboarding checklist for new workspaces',
      'Keyboard shortcuts cheat sheet',
      'Migrate date handling to Temporal',
      'Empty state illustrations for projects page',
      'Settings page is slow with 500+ members',
      'Accessibility: focus ring missing on menu items',
      'Show billing usage in real time',
      'Replace moment.js',
      'Search results should highlight matches',
    ],
    prs: ['Invoices: CSV export', 'Fix chart flicker by debouncing ResizeObserver', 'Onboarding checklist v1', 'Persist theme in localStorage', 'Virtualize members table'],
    merged: ['Upgrade to React 19', 'New sidebar navigation', 'Fix login redirect loop', 'Add skeleton loaders', 'Improve error toasts', 'Lazy-load settings routes'],
  },
  {
    name: 'mobile-app',
    description: 'iOS & Android app (Kotlin Multiplatform)',
    language: 'Kotlin',
    languageColor: '#A97BFF',
    team: ['felix-wagner', 'jamal-reed', 'liam-obrien', 'priya-nair', 'grace-kim'],
    issues: [
      'Push notifications not delivered on Android 15',
      'Offline mode for task list',
      'App crashes when rotating on camera screen',
      'Biometric login',
      'Reduce cold start time below 1s',
      'Haptic feedback on swipe actions',
      'Deep links to specific projects',
    ],
    prs: ['Biometric login (Face ID / fingerprint)', 'Fix camera rotation crash', 'Offline cache with SQLDelight'],
    merged: ['Upgrade Compose to 1.8', 'Fix dark mode status bar', 'Add pull-to-refresh', 'Crashlytics breadcrumbs'],
  },
  {
    name: 'data-pipeline',
    description: 'Nightly ETL jobs and analytics warehouse',
    language: 'Python',
    languageColor: '#3572A5',
    team: ['maya-chen', 'noah-fischer', 'kara-novak', 'old-timer-oscar'],
    issues: [
      'Nightly job exceeds 2h window',
      'Backfill events table for March',
      'Add data quality checks to orders model',
      'Switch to incremental models in dbt',
      'Alert when a source goes stale',
      'Partition events by day',
    ],
    prs: ['Incremental orders model', 'Great Expectations suite for orders'],
    merged: ['Pin pandas to 2.2', 'Retry flaky S3 reads', 'Add Airflow SLA miss alerts'],
  },
  {
    name: 'design-system',
    description: 'Shared UI components, tokens and icons',
    language: 'TypeScript',
    languageColor: '#3178c6',
    team: ['chloe-martin', 'olivia-silva', 'emma-larsen'],
    issues: ['Button: add loading state', 'Publish tokens as CSS variables', 'Tooltip positioning breaks in modals', 'Add Storybook interaction tests', 'New icon set (24px grid)'],
    prs: ['Tokens as CSS custom properties', 'Button loading state'],
    merged: ['Add Badge component', 'Fix focus trap in Dialog', 'Bump Storybook to 9'],
  },
  {
    name: 'infra',
    description: 'Terraform for all the things',
    language: 'HCL',
    languageColor: '#844FBA',
    team: ['devi-rao', 'hiro-tanaka', 'jamal-reed'],
    issues: ['Move staging to its own AWS account', 'Rotate RDS credentials automatically', 'Add budget alarms', 'Upgrade EKS to 1.32'],
    prs: ['EKS 1.32 upgrade', 'Budget alarms per team'],
    merged: ['Enable GuardDuty', 'Tag all resources with cost center'],
  },
];

const BODIES = [
  'Steps to reproduce are in the linked thread. We should fix this before the next release.',
  'Customers have asked for this a few times. Keep the first version small.',
  'Context: this came up in the last retro. Happy to pair on it.',
  'Acceptance criteria:\n- works on all supported browsers\n- has tests\n- documented in the changelog',
];

const LANG_TO_EXT = { Go: 'go', TypeScript: 'ts', Kotlin: 'kt', Python: 'py', HCL: 'tf' };

function iso(minutesAgo) {
  return new Date(Date.now() - minutesAgo * 60000).toISOString();
}

function buildRepoState(def, index) {
  const r = rng(1000 + index * 7919);
  const pick = (arr) => arr[Math.floor(r() * arr.length)];
  const current = def.team.filter((l) => !FORMER.includes(l));
  let n = 1;
  const labelNames = Object.keys(LABELS);
  const issues = def.issues.map((title, i) => {
    // About half the issues are being worked on; some are assigned to people who have left (they fall back to the backlog).
    const roll = r();
    let assignees = [];
    if (roll < 0.5) assignees = [pick(current)];
    else if (roll < 0.58) assignees = [pick(def.team)];
    const labels = [pick(labelNames)];
    if (r() < 0.3) labels.push(pick(labelNames));
    return {
      number: n++,
      title,
      url: null,
      body: pick(BODIES),
      createdAt: iso(60 * 24 * (3 + i * 2)),
      updatedAt: iso(30 + i * 97 + Math.floor(r() * 300)),
      author: pick(current),
      assignees,
      labels: [...new Set(labels)].map((name) => ({ name, color: LABELS[name] })),
      comments: Math.floor(r() * 9),
    };
  });
  const prs = def.prs.map((title, i) => {
    const author = pick(current);
    const state = r();
    const approved = state > 0.45;
    const linked = issues.find((iss) => iss.assignees.includes(author) && !iss._linked);
    if (linked) linked._linked = true;
    return {
      number: n++,
      title,
      url: null,
      body: linked ? `Closes #${linked.number}\n\n${pick(BODIES)}` : pick(BODIES),
      createdAt: iso(60 * 24 * (1 + i)),
      updatedAt: iso(15 + i * 53),
      author,
      assignees: [],
      labels: [],
      isDraft: state < 0.15,
      reviewDecision: approved ? 'APPROVED' : state < 0.3 ? 'CHANGES_REQUESTED' : 'REVIEW_REQUIRED',
      mergeable: state > 0.9 ? 'CONFLICTING' : 'MERGEABLE',
      checks: state > 0.35 && state < 0.42 ? 'FAILURE' : state < 0.2 ? 'PENDING' : 'SUCCESS',
      approvals: approved ? 1 + Math.floor(r() * 2) : 0,
      reviewers: approved ? [{ login: pick(current.filter((c) => c !== author)) || author, state: 'APPROVED' }] : [],
      closingIssues: linked ? [linked.number] : [],
      headRefName: title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30),
      baseRefName: 'main',
      additions: 10 + Math.floor(r() * 600),
      deletions: Math.floor(r() * 200),
      changedFiles: 1 + Math.floor(r() * 18),
    };
  });
  const merged = def.merged.map((title, i) => ({
    number: n++,
    title,
    url: null,
    mergedAt: iso(60 * (5 + i * 19)),
    author: pick(def.team),
    additions: 5 + Math.floor(r() * 300),
    deletions: Math.floor(r() * 120),
  }));
  issues.forEach((i) => delete i._linked);
  const contributors = def.team.map((login) => ({ login, type: 'User', contributions: 5 + Math.floor(r() * 400) }));
  contributors.push({ login: 'dependabot[bot]', type: 'Bot', contributions: 80 });
  return {
    summary: {
      name: def.name,
      description: def.description,
      url: null,
      isPrivate: index % 2 === 0,
      isArchived: false,
      isFork: false,
      pushedAt: iso(20 + index * 240),
      language: def.language,
      languageColor: def.languageColor,
      ext: LANG_TO_EXT[def.language] || 'txt',
    },
    issues,
    prs,
    merged,
    contributors,
    nextNumber: n,
    labels: Object.entries(LABELS).map(([name, color]) => ({ name, color, description: '' })),
  };
}

// Each hosted visitor gets their own demo sandbox; keep it small.
const DEMO_LIMITS = { repos: 20, issuesPerRepo: 200 };
function limitError(message) {
  const e = new Error(message);
  e.status = 429;
  return e;
}

export function createDemoProvider() {
  const repos = new Map(REPOS.map((def, i) => [def.name, buildRepoState(def, i)]));

  // The demo is a private sandbox, so the visitor gets full permissions everywhere.
  const summary = (state) => ({ ...state.summary, openIssues: state.issues.length, openPRs: state.prs.length, permission: 'ADMIN', hasIssues: true });
  const need = (name) => {
    const s = repos.get(name);
    if (!s) {
      const e = new Error(`Repository ${OWNER.login}/${name} not found`);
      e.status = 404;
      throw e;
    }
    return s;
  };

  return {
    mode: 'demo',
    viewer: VIEWER,

    async listOwners() {
      return [{ login: OWNER.login, type: 'Organization', description: OWNER.description, avatarUrl: null }];
    },

    async access() {
      return { role: 'admin', canManage: true, canCreateRepo: true };
    },

    async getWorld() {
      return {
        owner: OWNER,
        repos: [...repos.values()].map(summary).sort((a, b) => new Date(b.pushedAt) - new Date(a.pushedAt)),
        members: [...MEMBERS, VIEWER],
      };
    },

    async getFloor(world, name) {
      const s = need(name);
      return composeFloor({
        owner: OWNER,
        repo: summary(s),
        members: world.members,
        contributors: s.contributors,
        issues: s.issues,
        prs: s.prs,
        merged: s.merged,
      });
    },

    async listLabels(_owner, name) {
      return need(name).labels;
    },

    async createRepo(_world, { name, description, isPrivate }) {
      if (repos.size >= DEMO_LIMITS.repos) throw limitError('The demo company has reached its repository limit');
      if (repos.has(name)) {
        const e = new Error(`A repository named ${name} already exists`);
        e.status = 422;
        throw e;
      }
      const state = {
        summary: {
          name,
          description: description || '',
          url: null,
          isPrivate: !!isPrivate,
          isArchived: false,
          isFork: false,
          pushedAt: new Date().toISOString(),
          language: null,
          languageColor: null,
        },
        issues: [],
        prs: [],
        merged: [],
        contributors: [],
        nextNumber: 1,
        labels: Object.entries(LABELS).map(([n, color]) => ({ name: n, color, description: '' })),
      };
      repos.set(name, state);
      return { name, url: state.summary.url };
    },

    async createIssue(_owner, name, { title, body, assignees, labels }) {
      const s = need(name);
      if (s.issues.length >= DEMO_LIMITS.issuesPerRepo) throw limitError('This demo repository has reached its issue limit');
      const number = s.nextNumber++;
      const now = new Date().toISOString();
      s.issues.unshift({
        number,
        title,
        url: null,
        body: body || '',
        createdAt: now,
        updatedAt: now,
        author: VIEWER.login,
        assignees: assignees || [],
        labels: (labels || []).map((l) => ({ name: l, color: LABELS[l] || 'cccccc' })),
        comments: 0,
      });
      s.summary.pushedAt = now;
      return { number, url: null, title };
    },

    async updateIssue(_owner, name, number, { assignees, state }) {
      const s = need(name);
      const issue = s.issues.find((i) => i.number === number);
      if (!issue) {
        const e = new Error(`Issue #${number} not found`);
        e.status = 404;
        throw e;
      }
      if (assignees) issue.assignees = assignees;
      issue.updatedAt = new Date().toISOString();
      if (state === 'closed') s.issues = s.issues.filter((i) => i !== issue);
      return { number, url: issue.url, state: state || 'open' };
    },

    async mergePR(_owner, name, number) {
      const s = need(name);
      const pr = s.prs.find((p) => p.number === number);
      if (!pr) {
        const e = new Error(`Pull request #${number} not found`);
        e.status = 404;
        throw e;
      }
      s.prs = s.prs.filter((p) => p !== pr);
      s.merged.unshift({ number, title: pr.title, url: pr.url, mergedAt: new Date().toISOString(), author: pr.author, additions: pr.additions, deletions: pr.deletions });
      s.issues = s.issues.filter((i) => !pr.closingIssues.includes(i.number));
      return { merged: true, message: 'Pull Request successfully merged' };
    },

    async avatar() {
      return null; // client draws initials
    },
  };
}
