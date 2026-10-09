import type { Response } from 'express';

export function sendText(res: Response, status: number, text: string) {
  res.status(status).type('text/plain; charset=utf-8').send(text);
}

export function sendJson(res: Response, status: number, body: unknown) {
  res.status(status).json(body);
}
