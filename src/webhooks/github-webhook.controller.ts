import { Controller, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { sendJson } from '../common/respond.js';
import { GithubWebhookService } from './github-webhook.service.js';

/**
 * POST /api/github/webhook: deliveries from the GitHub App (hosted mode, with GITHUB_WEBHOOK_SECRET). It sits under
 * /api because the web app only forwards /api, /auth and /stripe, but skips the API's CSRF check and session lookup:
 * GitHub proves who it is with the signature instead (the raw body is kept to check it).
 */
@Controller('api/github')
export class GithubWebhookController {
  constructor(private readonly webhooks: GithubWebhookService) {}

  @Post('webhook')
  async receive(@Req() req: Request, @Res() res: Response) {
    const rawBody = req.body as Buffer;
    if (!this.webhooks.verify(rawBody, req.headers['x-hub-signature-256'])) return sendJson(res, 401, { error: 'Invalid signature' });
    let payload;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      return sendJson(res, 400, { error: 'Invalid JSON body' });
    }
    const handled = await this.webhooks.handle(String(req.headers['x-github-event'] || ''), payload);
    sendJson(res, 200, { received: true, handled: !!handled });
  }
}
