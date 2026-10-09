import type { NextFunction, Request, Response } from 'express';
import type { AppConfig } from '../config/app-config.js';
import { sendText } from './respond.js';
import { baseSecurityHeaders } from './security.js';

/**
 * First stop for every request, before routing: security headers, no caching by default, the health check, and
 * DNS-rebinding / host-header protection (only answer for the web app's host name, which its proxy keeps).
 */
export function edgeMiddleware(config: AppConfig) {
  const securityHeaders = baseSecurityHeaders({ https: config.secure });
  return (req: Request, res: Response, next: NextFunction) => {
    for (const [k, v] of Object.entries(securityHeaders)) res.setHeader(k, v);
    res.setHeader('Cache-Control', 'no-store');
    if (req.url === '/healthz') return sendText(res, 200, 'ok');
    if (!config.allowedHosts.has(req.headers.host ?? '')) return sendText(res, 421, 'unknown host');
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://placeholder').pathname);
    } catch {
      return sendText(res, 400, 'bad url');
    }
    if (pathname.includes('\0')) return sendText(res, 400, 'bad url');
    next();
  };
}
