// Shapes shared by the GitHub and demo providers, and the provider contract the API is built on.
import type { Floor } from './compose.js';

export interface Viewer {
  login: string;
  name?: string | null;
  avatarUrl?: string | null;
}

/** role: 'owner' (their own account) | 'admin' | 'member' | 'none' */
export interface Access {
  role: 'owner' | 'admin' | 'member' | 'none';
  canManage: boolean;
  canCreateRepo: boolean;
}

export interface OwnerEntry {
  login: string;
  type: 'Organization' | 'User';
  description: string;
  avatarUrl: string | null;
}

export interface RepoSummary {
  name: string;
  description: string;
  url: string | null;
  isPrivate: boolean;
  isArchived: boolean;
  isFork: boolean;
  pushedAt: string;
  language: string | null;
  languageColor: string | null;
  openIssues: number;
  openPRs: number;
  /** READ | TRIAGE | WRITE | MAINTAIN | ADMIN for the person looking — drives which buttons they get. */
  permission: string;
  hasIssues: boolean;
  ext?: string;
}

export interface Member {
  login: string;
  name: string | null;
  avatarUrl?: string | null;
}

export interface World {
  owner: { login: string; type: string; name: string; description: string; avatarUrl: string | null };
  repos: RepoSummary[];
  members: Member[] | null;
}

export interface Label {
  name: string;
  color: string;
  description?: string;
}

export interface Issue {
  number: number;
  title: string;
  url: string | null;
  body: string;
  createdAt: string;
  updatedAt: string;
  author: string | null;
  assignees: string[];
  labels: Label[];
  comments: number;
}

export interface PullRequest {
  number: number;
  title: string;
  url: string | null;
  body: string;
  createdAt: string;
  updatedAt: string;
  author: string | null;
  assignees: string[];
  labels: Label[];
  isDraft: boolean;
  reviewDecision: string | null;
  mergeable: string;
  checks: string | null;
  approvals: number;
  reviewers: { login: string | null; state: string }[];
  closingIssues: number[];
  headRefName: string;
  baseRefName: string;
  additions: number;
  deletions: number;
  changedFiles: number;
}

export interface MergedPR {
  number: number;
  title: string;
  url: string | null;
  mergedAt: string;
  author: string | null;
  additions: number;
  deletions: number;
}

export interface Contributor {
  login: string;
  type: string;
  contributions: number;
}

export interface NewRepo {
  name: string;
  description: string;
  isPrivate: boolean;
  autoInit: boolean;
}

export interface NewIssue {
  title: string;
  body: string;
  assignees: string[];
  labels: string[];
}

export interface IssuePatch {
  assignees?: string[];
  state?: 'open' | 'closed';
}

export type MergeMethod = 'merge' | 'squash' | 'rebase';

/** A source of building data: real GitHub (acting as the viewer) or the fictional demo company. */
export interface Provider {
  mode: 'github' | 'demo';
  viewer: Viewer;
  listOwners(): Promise<OwnerEntry[]>;
  access(owner: string): Promise<Access>;
  getWorld(owner: string): Promise<World>;
  getFloor(world: World, repo: string): Promise<Floor>;
  listLabels(owner: string, repo: string): Promise<Label[]>;
  createRepo(world: World, repo: NewRepo): Promise<{ name: string; url: string | null }>;
  createIssue(owner: string, repo: string, issue: NewIssue): Promise<{ number: number; url: string | null; title: string }>;
  updateIssue(owner: string, repo: string, number: number, patch: IssuePatch): Promise<{ number: number; url: string | null; state: string }>;
  mergePR(owner: string, repo: string, number: number, method?: MergeMethod): Promise<{ merged: boolean; message: string; sha?: string }>;
}
