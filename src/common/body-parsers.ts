import express, { type NextFunction, type Request, type Response } from 'express';
import { sendJson } from './respond.js';

const tooLarge = (err: { type?: string }) => err.type === 'entity.too.large';

const json = express.json({ limit: 200_000, strict: false, type: () => true });
const raw = express.raw({ limit: 1_000_000, type: () => true });

/** API bodies: a JSON object (anything else, or nothing, reads as {}). */
export function jsonBody(req: Request, res: Response, next: NextFunction) {
  json(req, res, (err?: { type?: string }) => {
    if (err) return sendJson(res, tooLarge(err) ? 413 : 400, { error: tooLarge(err) ? 'Request body too large' : 'Invalid JSON body' });
    const body = req.body;
    req.body = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    next();
  });
}

/** Webhook bodies: the raw bytes, as signed by the sender. */
export function rawBody(req: Request, res: Response, next: NextFunction) {
  raw(req, res, (err?: { type?: string }) => {
    if (err) return sendJson(res, tooLarge(err) ? 413 : 400, { error: tooLarge(err) ? 'Request body too large' : 'Invalid request body' });
    if (!Buffer.isBuffer(req.body)) req.body = Buffer.alloc(0);
    next();
  });
}
