// Thin wrapper around the GitHub CLI. Everything talks to GitHub through `gh`,
// so auth, tokens, SSO and enterprise hosts are whatever the user set up with `gh auth login`.
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Logger } from '@nestjs/common';

const log = new Logger('gh');

const CANDIDATES = [
  process.env.GH_PATH,
  'gh',
  process.platform === 'win32' && 'C:\\Program Files\\GitHub CLI\\gh.exe',
  process.platform === 'win32' && process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'GitHub CLI', 'gh.exe'),
  '/opt/homebrew/bin/gh',
  '/usr/local/bin/gh',
  '/usr/bin/gh',
].filter((c): c is string => !!c);

let ghBin = 'gh';

export class GhError extends Error {
  readonly status: number;
  readonly stderr: string;

  constructor(message: string, { status = 500, stderr = '' }: { status?: number; stderr?: string } = {}) {
    super(message);
    this.status = status;
    this.stderr = stderr;
  }
}

export interface GhUser {
  login: string;
  name: string | null;
  avatarUrl: string | null;
}

export interface GhStatus {
  installed: boolean;
  authed: boolean;
  user?: GhUser | null;
  version?: string | null;
  bin?: string | null;
  error?: string | null;
}

function exec(bin: string, args: string[], { input, timeoutMs = 30000 }: { input?: string; timeoutMs?: number } = {}) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(bin, args, {
        windowsHide: true,
        env: { ...process.env, GH_PROMPT_DISABLED: '1', NO_COLOR: '1', GH_NO_UPDATE_NOTIFIER: '1', CLICOLOR: '0' },
      });
    } catch (err) {
      reject(err);
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new GhError(`gh ${args[0]} timed out`, { status: 504 }));
    }, timeoutMs);
    child.stdout!.on('data', (d: Buffer) => out.push(d));
    child.stderr!.on('data', (d: Buffer) => err.push(d));
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
    child.stdin!.on('error', () => {});
    child.stdin!.end(input ?? '');
  });
}

/** Find a working gh binary and report install/auth state. */
export async function detectGh(): Promise<GhStatus> {
  const result: GhStatus = { installed: false, authed: false, user: null, version: null, bin: null, error: null };
  for (const bin of CANDIDATES) {
    if (bin !== 'gh' && !fs.existsSync(bin)) continue;
    try {
      const { code, stdout } = await exec(bin, ['--version'], { timeoutMs: 10000 });
      if (code === 0) {
        ghBin = bin;
        result.installed = true;
        result.bin = bin;
        result.version = (stdout.match(/gh version (\S+)/) || [])[1] || stdout.split('\n')[0];
        break;
      }
    } catch {
      /* try the next candidate */
    }
  }
  if (!result.installed) {
    result.error = 'GitHub CLI (gh) was not found on this machine.';
    return result;
  }
  try {
    const user = await ghApi('user');
    result.authed = true;
    result.user = { login: user.login, name: user.name, avatarUrl: user.avatar_url };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    result.error = /auth login|not logged|authentication/i.test(message) ? 'gh is installed but not logged in. Run `gh auth login`.' : message;
  }
  return result;
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  timeoutMs?: number;
}

/** Call the GitHub REST/GraphQL API through `gh api`. Bodies go through stdin so nothing touches a shell. */
export async function ghApi(endpoint: string, { method = 'GET', body, timeoutMs }: RequestOptions = {}): Promise<any> {
  const args = ['api', endpoint, '-H', 'Accept: application/vnd.github+json'];
  if (method !== 'GET') args.push('-X', method);
  if (body !== undefined) args.push('--input', '-');
  const { code, stdout, stderr } = await exec(ghBin, args, {
    input: body !== undefined ? JSON.stringify(body) : undefined,
    timeoutMs,
  });
  let parsed = null;
  if (stdout.trim()) {
    try {
      parsed = JSON.parse(stdout);
    } catch {
      parsed = stdout;
    }
  }
  if (code !== 0) {
    // GraphQL partial results still come back with data; let the caller decide.
    if (endpoint === 'graphql' && parsed && parsed.data) return parsed;
    const httpStatus = Number((stderr.match(/HTTP (\d{3})/) || [])[1]) || 502;
    const msg = (parsed && parsed.message) || stderr.trim().replace(/^gh: /, '') || `gh api ${endpoint} failed`;
    throw new GhError(msg, { status: httpStatus, stderr });
  }
  return parsed;
}

export async function graphql(query: string, variables: Record<string, unknown> = {}) {
  const res = await ghApi('graphql', { method: 'POST', body: { query, variables } });
  if (res && res.errors && !res.data) {
    throw new GhError(res.errors.map((e: { message: string }) => e.message).join('; '), { status: 502 });
  }
  if (res && res.errors) log.warn(`GraphQL partial errors: ${res.errors.map((e: { message: string }) => e.message).join('; ')}`);
  return res ? res.data : null;
}
