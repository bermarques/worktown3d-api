import { Catch, Logger, NotFoundException, Optional, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Response } from 'express';
import type { ApiRequest } from '../api/context.js';
import { AppConfig } from '../config/app-config.js';
import { GhError } from '../github/gh.js';
import { SessionStore } from '../sessions/session.store.js';
import { HttpError, statusOf } from './http-error.js';
import { sendJson, sendText } from './respond.js';

const logger = new Logger('Api');
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The path only: query strings can carry secrets (an OAuth code on /auth/callback). */
function logFailure(req: ApiRequest, e: unknown, status = 500) {
  logger.error(`${req.method} ${req.path}: ${messageOf(e)}`, { method: req.method, path: req.path, status }, e instanceof Error ? e.stack : undefined);
}

/**
 * Turns errors into responses: `{ error, signedOut?, noOrg?, needsSubscription? }` for the API, plain text elsewhere.
 * Internal details stay in the server log when the app is exposed to other people.
 */
@Catch()
export class ApiExceptionFilter implements ExceptionFilter {
  constructor(
    private readonly config: AppConfig,
    @Optional() private readonly sessions?: SessionStore,
  ) {}

  catch(e: unknown, host: ArgumentsHost) {
    const req = host.switchToHttp().getRequest<ApiRequest>();
    const res = host.switchToHttp().getResponse<Response>();
    this.respond(e, req, res).catch((err) => {
      logFailure(req, err);
      if (!res.headersSent) sendText(res, 500, 'internal error');
    });
  }

  private async respond(e: unknown, req: ApiRequest, res: Response) {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const api = req.originalUrl.startsWith('/api/');
    // Nest's own 404: no route matched.
    if (e instanceof NotFoundException) return api ? sendJson(res, 404, { error: 'Unknown API route' }) : sendText(res, 404, 'not found');
    if (!api) {
      logFailure(req, e);
      return sendText(res, 500, 'internal error');
    }

    const status = statusOf(e);
    const session = req.ctx?.session;
    // GitHub said the token is no good (revoked, expired): end this session cleanly.
    if (this.sessions && status === 401 && session && session.kind === 'user') {
      await this.sessions.destroy(session);
      res.set('Set-Cookie', this.sessions.clearCookie());
      return sendJson(res, 401, { error: 'Your GitHub sign-in expired. Please sign in again.', signedOut: true });
    }
    if (status >= 500) logFailure(req, e, status);
    const hidden = this.config.hosted && status >= 500 && !(e instanceof GhError);
    const message = hidden ? 'Something went wrong on our side' : (e instanceof Error && e.message) || 'Something went wrong';
    sendJson(res, status, { error: message, ...(e instanceof HttpError ? e.flags : {}) });
  }
}
