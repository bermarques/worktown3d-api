// Real data source. Every read and write goes through a GitHub client (the local CLI, or the signed-in
// user's own token in hosted mode), so GitHub itself enforces what each person may see and do.
import { GhError } from './github-client.js';
import { composeFloor } from './compose.js';

const OWNER_QUERY = `
query($owner: String!, $cursor: String) {
  repositoryOwner(login: $owner) {
    __typename
    login
    avatarUrl
    ... on Organization { name description }
    ... on User { name }
    repositories(first: 100, after: $cursor, ownerAffiliations: [OWNER], orderBy: { field: PUSHED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes {
        name description url isPrivate isArchived isFork pushedAt viewerPermission hasIssuesEnabled
        primaryLanguage { name color }
        issues(states: OPEN) { totalCount }
        pullRequests(states: OPEN) { totalCount }
      }
    }
  }
}`;

const MEMBERS_QUERY = `
query($owner: String!, $cursor: String) {
  organization(login: $owner) {
    membersWithRole(first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { login name avatarUrl }
    }
  }
}`;

const REPO_QUERY = `
query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    name description url isPrivate isArchived pushedAt viewerPermission hasIssuesEnabled
    primaryLanguage { name color }
    issues(states: OPEN, first: 100, orderBy: { field: UPDATED_AT, direction: DESC }) {
      totalCount
      nodes {
        number title url body createdAt updatedAt
        author { login }
        assignees(first: 6) { nodes { login } }
        labels(first: 6) { nodes { name color } }
        comments { totalCount }
      }
    }
    openPRs: pullRequests(states: OPEN, first: 50, orderBy: { field: UPDATED_AT, direction: DESC }) {
      totalCount
      nodes {
        number title url body createdAt updatedAt isDraft reviewDecision mergeable
        headRefName baseRefName additions deletions changedFiles
        author { login }
        assignees(first: 6) { nodes { login } }
        labels(first: 6) { nodes { name color } }
        approvals: reviews(states: APPROVED) { totalCount }
        latestReviews(first: 6) { nodes { state author { login } } }
        closingIssuesReferences(first: 5) { nodes { number } }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
    mergedPRs: pullRequests(states: MERGED, first: 40, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes { number title url mergedAt additions deletions author { login } }
    }
    defaultBranchRef {
      target {
        ... on Commit {
          history(first: 100) { nodes { author { user { login } } } }
        }
      }
    }
  }
}`;

const nodes = (conn) => (conn && conn.nodes ? conn.nodes.filter(Boolean) : []);
const login = (actor) => (actor ? actor.login : null);
const trimBody = (b) => (b ? (b.length > 4000 ? b.slice(0, 4000) + '\n…' : b) : '');

function mapRepoSummary(r) {
  return {
    name: r.name,
    description: r.description || '',
    url: r.url,
    isPrivate: r.isPrivate,
    isArchived: r.isArchived,
    isFork: !!r.isFork,
    pushedAt: r.pushedAt,
    language: r.primaryLanguage ? r.primaryLanguage.name : null,
    languageColor: r.primaryLanguage ? r.primaryLanguage.color : null,
    openIssues: r.issues ? r.issues.totalCount : 0,
    openPRs: r.pullRequests ? r.pullRequests.totalCount : r.openPRs ? r.openPRs.totalCount : 0,
    // READ | TRIAGE | WRITE | MAINTAIN | ADMIN for the person looking — drives which buttons they get.
    permission: r.viewerPermission || 'READ',
    hasIssues: r.hasIssuesEnabled !== false,
  };
}

async function paginate(client, query, variables, pick, maxPages = 10) {
  const all = [];
  let cursor = null;
  let first = null;
  for (let page = 0; page < maxPages; page++) {
    const data = await client.graphql(query, { ...variables, cursor });
    if (!first) first = data;
    const conn = pick(data);
    if (!conn) break;
    all.push(...nodes(conn));
    if (!conn.pageInfo || !conn.pageInfo.hasNextPage) break;
    cursor = conn.pageInfo.endCursor;
  }
  return { first, all };
}

async function restPages(client, endpoint, maxPages = 5) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const sep = endpoint.includes('?') ? '&' : '?';
    const res = await client.rest(`${endpoint}${sep}per_page=100&page=${page}`);
    if (!Array.isArray(res) || res.length === 0) break; // 204 No Content (empty repo) yields null
    all.push(...res);
    if (res.length < 100) break;
  }
  return all;
}

/**
 * @param {{ client: object, viewer: { login: string, name?: string, avatarUrl?: string } }} opts
 */
export function createGithubProvider({ client, viewer }) {
  const me = viewer;

  return {
    mode: 'github',
    viewer: me,

    async listOwners() {
      let orgs = null;
      if (client.kind === 'token') {
        // GitHub App tokens: only organizations where the app is installed are usable.
        try {
          const res = await client.rest('user/installations?per_page=100');
          orgs = (res && res.installations ? res.installations : [])
            .map((i) => i.account)
            .filter((a) => a && a.type === 'Organization')
            .map((a) => ({ login: a.login, description: a.description || '', avatar_url: a.avatar_url }));
        } catch {
          orgs = null; // classic OAuth App token: fall back to org memberships
        }
      }
      if (!orgs) {
        const res = await client.rest('user/orgs?per_page=100');
        orgs = Array.isArray(res) ? res : [];
      }
      return [
        ...orgs.map((o) => ({ login: o.login, type: 'Organization', description: o.description || '', avatarUrl: o.avatar_url })),
        { login: me.login, type: 'User', description: 'Your personal account', avatarUrl: me.avatarUrl },
      ];
    },

    /**
     * What the viewer may do in this owner's building.
     * role: 'owner' (their own account) | 'admin' | 'member' | 'none'
     */
    async access(ownerLogin) {
      if (ownerLogin.toLowerCase() === me.login.toLowerCase()) {
        return { role: 'owner', canManage: true, canCreateRepo: true };
      }
      let membership;
      try {
        membership = await client.rest(`user/memberships/orgs/${ownerLogin}`);
      } catch (e) {
        if ([401, 403, 404].includes(e.status)) return { role: 'none', canManage: false, canCreateRepo: false };
        throw e;
      }
      if (!membership || membership.state !== 'active') return { role: 'none', canManage: false, canCreateRepo: false };
      const admin = membership.role === 'admin';
      let membersCanCreate = false;
      if (!admin) {
        try {
          const org = await client.rest(`orgs/${ownerLogin}`);
          membersCanCreate = !!(org && org.members_can_create_repositories);
        } catch {
          membersCanCreate = false;
        }
      }
      return { role: admin ? 'admin' : 'member', canManage: admin, canCreateRepo: admin || membersCanCreate };
    },

    async getWorld(ownerLogin) {
      const { first, all } = await paginate(client, OWNER_QUERY, { owner: ownerLogin }, (d) => d && d.repositoryOwner && d.repositoryOwner.repositories);
      const ownerNode = first && first.repositoryOwner;
      if (!ownerNode) throw new GhError(`Could not find a GitHub organization or user named "${ownerLogin}"`, { status: 404 });
      const owner = {
        login: ownerNode.login,
        type: ownerNode.__typename,
        name: ownerNode.name || ownerNode.login,
        description: ownerNode.description || '',
        avatarUrl: ownerNode.avatarUrl,
      };
      let members = null;
      if (owner.type === 'Organization') {
        const res = await paginate(client, MEMBERS_QUERY, { owner: owner.login }, (d) => d && d.organization && d.organization.membersWithRole);
        members = res.all.map((m) => ({ login: m.login, name: m.name, avatarUrl: m.avatarUrl }));
      }
      return { owner, repos: all.map(mapRepoSummary), members };
    },

    async getFloor(world, repoName) {
      const owner = world.owner;
      const [data, contributors] = await Promise.all([
        client.graphql(REPO_QUERY, { owner: owner.login, name: repoName }),
        restPages(client, `repos/${owner.login}/${repoName}/contributors`, 2).catch((e) => {
          console.warn(`[gh] contributors for ${repoName}:`, e.message);
          return [];
        }),
      ]);
      const r = data && data.repository;
      if (!r) throw new GhError(`Repository ${owner.login}/${repoName} not found`, { status: 404 });

      const issues = nodes(r.issues).map((i) => ({
        number: i.number,
        title: i.title,
        url: i.url,
        body: trimBody(i.body),
        createdAt: i.createdAt,
        updatedAt: i.updatedAt,
        author: login(i.author),
        assignees: nodes(i.assignees).map((a) => a.login),
        labels: nodes(i.labels).map((l) => ({ name: l.name, color: l.color })),
        comments: i.comments ? i.comments.totalCount : 0,
      }));
      const prs = nodes(r.openPRs).map((p) => {
        const lastCommit = nodes(p.commits)[0];
        const rollup = lastCommit && lastCommit.commit && lastCommit.commit.statusCheckRollup;
        return {
          number: p.number,
          title: p.title,
          url: p.url,
          body: trimBody(p.body),
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
          author: login(p.author),
          assignees: nodes(p.assignees).map((a) => a.login),
          labels: nodes(p.labels).map((l) => ({ name: l.name, color: l.color })),
          isDraft: p.isDraft,
          reviewDecision: p.reviewDecision,
          mergeable: p.mergeable,
          checks: rollup ? rollup.state : null,
          approvals: p.approvals ? p.approvals.totalCount : 0,
          reviewers: nodes(p.latestReviews).map((rv) => ({ login: login(rv.author), state: rv.state })),
          closingIssues: nodes(p.closingIssuesReferences).map((n) => n.number),
          headRefName: p.headRefName,
          baseRefName: p.baseRefName,
          additions: p.additions,
          deletions: p.deletions,
          changedFiles: p.changedFiles,
        };
      });
      const merged = nodes(r.mergedPRs).map((m) => ({
        number: m.number,
        title: m.title,
        url: m.url,
        mergedAt: m.mergedAt,
        author: login(m.author),
        additions: m.additions,
        deletions: m.deletions,
      }));

      // GitHub's contributors list is computed in the background and can lag behind new commits by hours,
      // so also count authors from the latest default-branch history, which is always current.
      const team = new Map(contributors.map((c) => [c.login.toLowerCase(), { login: c.login, type: c.type, contributions: c.contributions }]));
      const history = r.defaultBranchRef && r.defaultBranchRef.target && r.defaultBranchRef.target.history;
      const recent = new Map();
      for (const commit of nodes(history)) {
        const user = commit.author && commit.author.user;
        if (user) recent.set(user.login, (recent.get(user.login) || 0) + 1);
      }
      for (const [authorLogin, count] of recent) {
        if (!team.has(authorLogin.toLowerCase())) team.set(authorLogin.toLowerCase(), { login: authorLogin, type: 'User', contributions: count });
      }

      return composeFloor({
        owner,
        repo: mapRepoSummary({ ...r, issues: r.issues, pullRequests: r.openPRs }),
        members: world.members,
        contributors: [...team.values()],
        issues,
        prs,
        merged,
      });
    },

    async listLabels(ownerLogin, repoName) {
      const labels = await restPages(client, `repos/${ownerLogin}/${repoName}/labels`, 2);
      return labels.map((l) => ({ name: l.name, color: l.color, description: l.description || '' }));
    },

    async createRepo(world, { name, description, isPrivate, autoInit }) {
      const body = { name, description: description || '', private: !!isPrivate, auto_init: !!autoInit };
      const endpoint = world.owner.type === 'Organization' ? `orgs/${world.owner.login}/repos` : 'user/repos';
      const r = await client.rest(endpoint, { method: 'POST', body });
      return { name: r.name, url: r.html_url };
    },

    async createIssue(ownerLogin, repoName, { title, body, assignees, labels }) {
      const payload = { title, body: body || '' };
      if (assignees && assignees.length) payload.assignees = assignees;
      if (labels && labels.length) payload.labels = labels;
      const r = await client.rest(`repos/${ownerLogin}/${repoName}/issues`, { method: 'POST', body: payload });
      return { number: r.number, url: r.html_url, title: r.title };
    },

    async updateIssue(ownerLogin, repoName, number, { assignees, state }) {
      const payload = {};
      if (assignees) payload.assignees = assignees;
      if (state) payload.state = state;
      const r = await client.rest(`repos/${ownerLogin}/${repoName}/issues/${number}`, { method: 'PATCH', body: payload });
      return { number: r.number, url: r.html_url, state: r.state };
    },

    async mergePR(ownerLogin, repoName, number, method = 'squash') {
      const r = await client.rest(`repos/${ownerLogin}/${repoName}/pulls/${number}/merge`, {
        method: 'PUT',
        body: { merge_method: method },
      });
      return { merged: !!r.merged, message: r.message, sha: r.sha };
    },

    avatar: fetchAvatar,
  };
}

const AVATAR_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** Public GitHub avatar, re-served same-origin so canvas textures can use it. */
export async function fetchAvatar(userLogin) {
  const res = await fetch(`https://github.com/${encodeURIComponent(userLogin)}.png?size=128`, { redirect: 'follow', signal: AbortSignal.timeout(10_000) });
  if (!res.ok) return null;
  const host = new URL(res.url).hostname;
  if (host !== 'github.com' && !host.endsWith('.githubusercontent.com')) return null;
  const type = (res.headers.get('content-type') || '').split(';')[0].trim();
  if (!AVATAR_TYPES.has(type)) return null;
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > 300_000) return null;
  return { buffer, type };
}
