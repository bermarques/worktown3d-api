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
