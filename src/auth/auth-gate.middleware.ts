import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { RateLimits } from '../common/rate-limits.js';
import { sendText } from '../common/respond.js';
import { clientIp } from '../common/security.js';
import { AppConfig } from '../config/app-config.js';

/** Rate limit for the sign-in routes, per client address. */
@Injectable()
export class AuthGateMiddleware implements NestMiddleware {
  constructor(
    private readonly config: AppConfig,
    private readonly limits: RateLimits,
  ) {}

  use(req: Request, res: Response, next: NextFunction) {
    if (!this.limits.auth(clientIp(req, this.config.trustProxy))) return sendText(res, 429, 'Too many sign-in attempts, try again in a minute');
    next();
  }
}
