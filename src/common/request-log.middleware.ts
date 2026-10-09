import { Logger } from '@nestjs/common';
import type { NextFunction, Response } from 'express';
import type { ApiRequest } from '../api/context.js';
import type { AppConfig } from '../config/app-config.js';
import { clientIp } from './security.js';

const logger = new Logger('Http');

/**
 * One log entry per request once it's answered (hosted mode): method, path (never the query string, which can
 * carry sign-in codes), status, duration, client address and who was signed in.
 */
export function requestLog(config: AppConfig) {
  return (req: ApiRequest, res: Response, next: NextFunction) => {
    if (req.url === '/healthz') return next();
    const started = performance.now();
    res.on('finish', () => {
      const durationMs = Math.round(performance.now() - started);
      const session = req.ctx?.session;
      logger.log(`${req.method} ${req.path} ${res.statusCode} ${durationMs}ms`, {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs,
        ip: clientIp(req, config.trustProxy),
        ...(session ? { session: session.kind, user: session.kind === 'user' ? session.user.login : undefined } : {}),
      });
    });
    next();
  };
}
