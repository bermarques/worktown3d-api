import { Injectable, Logger, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Response } from 'express';
import { describeError } from '../common/http-error.js';
import { RateLimits } from '../common/rate-limits.js';
import { sendJson } from '../common/respond.js';
import { clientIp, sameOrigin } from '../common/security.js';
import { AppConfig } from '../config/app-config.js';
import { ContextResolver, type ApiRequest } from './context.js';

const logger = new Logger('Api');

/** Every /api request: CSRF check on writes, then who's asking (req.ctx), then rate limits per session or address. */
@Injectable()
export class ApiGateMiddleware implements NestMiddleware {
  constructor(
    private readonly config: AppConfig,
    private readonly resolver: ContextResolver,
    private readonly limits: RateLimits,
  ) {}

  async use(req: ApiRequest, res: Response, next: NextFunction) {
    const write = req.method !== 'GET';
    if (write && !sameOrigin(req, this.config)) return sendJson(res, 403, { error: 'Cross-site request blocked' });
    try {
      req.ctx = await this.resolver.resolve(req);
    } catch (e) {
      logger.error(`${req.method} ${req.path}: ${describeError(e)}`, { method: req.method, path: req.path, status: 500 }, e instanceof Error ? e.stack : undefined);
      return sendJson(res, 500, { error: 'Something went wrong on our side' });
    }
    const who = req.ctx.session ? req.ctx.session.id : clientIp(req, this.config.trustProxy);
    if (!this.limits.api(who) || (write && !this.limits.write(who))) return sendJson(res, 429, { error: 'Slow down a little — too many requests' });
    next();
  }
}
