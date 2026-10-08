// Two interchangeable ways to talk to GitHub:
//  - cliClient: the local GitHub CLI (`gh`), for running Worktown3D on your own machine.
//  - createTokenClient: a signed-in user's OAuth token, for the hosted multi-user mode.
// Both expose rest(endpoint, { method, body }) and graphql(query, variables).
import { ghApi, graphql as ghGraphql, GhError } from './gh.js';

export { GhError };

export const cliClient = {
  kind: 'cli',
  rest: (endpoint, opts) => ghApi(endpoint, opts),
  graphql: (query, variables) => ghGraphql(query, variables),
};

const API = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/+$/, '');

// GraphQL field -> the GitHub App permission that unlocks it
const FIELD_PERMISSION = {
  issues: 'Issues',
  pullRequests: 'Pull requests',
  openPRs: 'Pull requests',
  mergedPRs: 'Pull requests',
  latestReviews: 'Pull requests',
  approvals: 'Pull requests',
  closingIssuesReferences: 'Pull requests',
  membersWithRole: 'Members (organization permission)',
  statusCheckRollup: 'Commit statuses and Checks',
  defaultBranchRef: 'Contents',
  history: 'Contents',
};

function missingPermissionMessage(path = []) {
  const field = [...path].reverse().find((p) => typeof p === 'string' && FIELD_PERMISSION[p]);
  const perm = field ? `the "${FIELD_PERMISSION[field]}"` : 'a required';
  return (
    `The Worktown3D GitHub App is missing ${perm} permission here. In the app's settings on GitHub (Permissions & events), ` +
    `add it with the access listed in the README, then have an organization owner accept the update under ` +
    `the organization's Settings → GitHub Apps.`
  );
}
const ENDPOINT_RE = /^[A-Za-z0-9/_.\-?=&%,]+$/;

/**
 * @param {() => Promise<string>} getToken  returns a valid access token (refreshing it if needed)
 */
export function createTokenClient(getToken) {
  async function request(endpoint, { method = 'GET', body } = {}) {
    // Endpoints are built from validated owner/repo names; refuse anything that could escape the API host.
    if (!ENDPOINT_RE.test(endpoint) || endpoint.includes('..') || endpoint.startsWith('/')) {
      throw new GhError('Invalid GitHub API path', { status: 400 });
    }
    const token = await getToken();
    let res;
    try {
      res = await fetch(`${API}/${endpoint}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'Worktown3D',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      throw new GhError(e.name === 'TimeoutError' ? 'GitHub took too long to answer' : 'Could not reach GitHub', { status: 504 });
    }
    if (res.status === 204) return null;
    const text = await res.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    if (!res.ok) {
      const msg = (parsed && parsed.message) || `GitHub API error (HTTP ${res.status})`;
      throw new GhError(msg, { status: res.status === 401 ? 401 : res.status });
    }
    return parsed;
  }

  return {
    kind: 'token',
    rest: request,
    async graphql(query, variables = {}) {
      const res = await request('graphql', { method: 'POST', body: { query, variables } });
      if (res && res.errors) {
        // A GitHub App without a needed permission gets partial "FORBIDDEN" errors, and GitHub nulls out the
        // whole repository entry. Say so instead of quietly showing an empty building.
        const denied = res.errors.find((e) => e.type === 'FORBIDDEN' || /not accessible by integration/i.test(e.message || ''));
        if (denied) throw new GhError(missingPermissionMessage(denied.path), { status: 403 });
        if (!res.data) throw new GhError(res.errors.map((e) => e.message).join('; '), { status: 502 });
      }
      return res ? res.data : null;
    },
  };
}
