/** Hints the web app acts on, sent next to the error message. */
export interface ErrorFlags {
  /** The session ended: show the sign-in screen. */
  signedOut?: boolean;
  /** No usable organization is selected: show the organization picker. */
  noOrg?: boolean;
  /** The building needs an active subscription. */
  needsSubscription?: boolean;
}

/** An error with the HTTP status (and message) the client should get. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly flags: ErrorFlags = {},
  ) {
    super(message);
  }
}

/** The HTTP status carried by an error from anywhere (HttpError, GhError, StripeError), or 500. */
export function statusOf(e: unknown) {
  const status = (e as { status?: unknown } | null)?.status;
  return typeof status === 'number' && status >= 400 && status < 600 ? status : 500;
}

interface DatabaseError extends Error {
  code?: string;
  meta?: { driverAdapterError?: { cause?: { originalMessage?: string; kind?: string; host?: string } } };
}

/** Prisma's first line, which only names the call that failed. */
const INVOCATION = /^Invalid `.*` invocation:?$/;

/** Why a database call failed, in one line: Prisma's own message names the call but may not say why. */
export function databaseReason(e: Error) {
  const { code, meta } = e as DatabaseError;
  const cause = meta?.driverAdapterError?.cause;
  const detail =
    cause?.originalMessage ||
    [cause?.kind, cause?.host].filter(Boolean).join(' ') ||
    e.message
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !INVOCATION.test(line))
      .pop();
  return detail || code || 'unknown error';
}

/** One line on what went wrong, for the logs. */
export function describeError(e: unknown) {
  if (!(e instanceof Error)) return String(e);
  return e.name.startsWith('PrismaClient') ? `Database error: ${databaseReason(e)}` : e.message;
}
