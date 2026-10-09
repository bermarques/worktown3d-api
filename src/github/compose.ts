// Turns raw repo data (issues, PRs, contributors, org members) into the floor model the 3D world renders.
// Shared by the GitHub and demo providers so both behave identically.
import type { Contributor, Issue, Member, MergedPR, PullRequest, RepoSummary } from './types.js';

export function isBot(login: string, type?: string) {
  return type === 'Bot' || /\[bot\]$/i.test(login) || /-bot$/i.test(login) || login === 'ghost';
}

const byUpdatedDesc = (a: { updatedAt: string }, b: { updatedAt: string }) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt);

export function prIsReady(pr: PullRequest) {
  if (pr.isDraft) return false;
  if (pr.mergeable === 'CONFLICTING') return false;
  if (pr.checks === 'FAILURE' || pr.checks === 'ERROR') return false;
  if (pr.reviewDecision === 'APPROVED') return true;
  // Repos without required reviews report reviewDecision = null; treat one approval as "ready".
  return pr.reviewDecision == null && pr.approvals > 0;
}

interface FloorInput {
  owner: { login: string };
  repo: RepoSummary;
  /** org members; null for personal accounts */
  members: Member[] | null;
  contributors: Contributor[];
  /** open issues */
  issues: Issue[];
  /** open PRs */
  prs: PullRequest[];
  /** recently merged PRs */
  merged: MergedPR[];
}

export type Floor = ReturnType<typeof composeFloor>;

export function composeFloor({ owner, repo, members, contributors, issues, prs, merged }: FloorInput) {
  // An empty member list means we could not read membership (e.g. missing read:org scope) — do not filter then.
  const memberMap = members && members.length ? new Map(members.map((m) => [m.login.toLowerCase(), m])) : null;
  const devs = new Map<string, { login: string; name: string | null; contributions: number }>();
  const departed = new Set<string>();

  const add = (login: string | null, type?: string, contributions = 0) => {
    if (!login || isBot(login, type)) return;
    const key = login.toLowerCase();
    if (memberMap && !memberMap.has(key)) {
      departed.add(login);
      return;
    }
    const member = memberMap ? memberMap.get(key) : null;
    if (!devs.has(key)) {
      devs.set(key, {
        login: member ? member.login : login,
        name: member ? member.name : null,
        contributions: 0,
      });
    }
    devs.get(key)!.contributions += contributions;
  };

  for (const c of contributors) add(c.login, c.type, c.contributions || 0);
  // Members who are actively assigned or have open PRs count as part of the team even before their first commit.
  for (const i of issues) for (const a of i.assignees) add(a);
  for (const p of prs) add(p.author);

  // Departed people who still appear in assignee lists should not be shown as "working".
  const sortedIssues = [...issues].sort(byUpdatedDesc);
  const sortedPRs = [...prs].sort(byUpdatedDesc).map((p) => ({ ...p, ready: prIsReady(p) }));
  const sortedMerged = [...merged].sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt));

  const lc = (s: string | null) => (s || '').toLowerCase();
  const devList = [...devs.values()].map((d) => {
    const me = lc(d.login);
    const assigned = sortedIssues.filter((i) => i.assignees.some((a) => lc(a) === me));
    const openPRs = sortedPRs.filter((p) => lc(p.author) === me);
    const shipped = sortedMerged.filter((m) => lc(m.author) === me);
    let current = null;
    if (assigned.length) {
      const issue = assigned[0];
      const linkedPR = sortedPRs.find((p) => p.closingIssues.includes(issue.number)) || null;
      current = { kind: 'issue', ...issue, linkedPR: linkedPR && { number: linkedPR.number, ready: linkedPR.ready, isDraft: linkedPR.isDraft } };
    } else if (openPRs.length) {
      current = { kind: 'pr', ...openPRs[0] };
    } else if (shipped.length) {
      current = { kind: 'merged', ...shipped[0] };
    }
    return {
      ...d,
      status: assigned.length || openPRs.length ? 'working' : 'idle',
      current,
      assigned: assigned.map((i) => i.number),
      openPRs: openPRs.map((p) => p.number),
      shipped: shipped.slice(0, 5).map((m) => m.number),
    };
  });

  // Busy people first, then by contributions, so the "core team" sits near the board.
  devList.sort((a, b) => (a.status === b.status ? b.contributions - a.contributions : a.status === 'working' ? -1 : 1));

  const memberSet = new Set(devList.map((d) => lc(d.login)));
  const board = {
    backlog: sortedIssues.filter((i) => !i.assignees.some((a) => memberSet.has(lc(a)) || !memberMap)),
    inProgress: sortedIssues.filter((i) => i.assignees.some((a) => memberSet.has(lc(a)) || !memberMap)),
    review: sortedPRs.filter((p) => !p.ready),
    ready: sortedPRs.filter((p) => p.ready),
    shipped: sortedMerged.slice(0, 12),
  };

  return {
    owner: owner.login,
    repo,
    devs: devList,
    departedCount: departed.size,
    issues: sortedIssues,
    prs: sortedPRs,
    merged: sortedMerged,
    board,
    fetchedAt: new Date().toISOString(),
  };
}
