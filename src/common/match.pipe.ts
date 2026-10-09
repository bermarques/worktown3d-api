import type { PipeTransform } from '@nestjs/common';
import { HttpError } from './http-error.js';

export const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
export const REPO_RE = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;
export const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** `value` if it's a string matching `re`, otherwise a 400 naming `what` was invalid. */
export function need(value: unknown, re: RegExp, what: string): string {
  if (typeof value !== 'string' || !re.test(value)) throw new HttpError(400, `Invalid ${what}`);
  return value;
}

/** Route parameter validation: `@Param('repo', new Match(REPO_RE, 'repository name'))`. */
export class Match implements PipeTransform<unknown, string> {
  constructor(
    private readonly re: RegExp,
    private readonly what: string,
  ) {}

  transform(value: unknown) {
    return need(value, this.re, this.what);
  }
}

/** A positive integer route parameter (issue or pull request number). */
export class PositiveInt implements PipeTransform<unknown, number> {
  constructor(private readonly what: string) {}

  transform(value: unknown) {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) throw new HttpError(400, `Invalid ${this.what}`);
    return n;
  }
}
