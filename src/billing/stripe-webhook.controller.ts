import { Controller, Logger, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { describeError } from '../common/http-error.js';
import { sendJson } from '../common/respond.js';
import { BillingService } from './billing.service.js';
import { StripeError } from './stripe.client.js';

const logger = new Logger('Stripe');

/** POST /stripe/webhook: subscription changes from Stripe (the raw body is needed to check its signature). */
@Controller('stripe')
export class StripeWebhookController {
  constructor(private readonly billing: BillingService) {}

  @Post('webhook')
  async webhook(@Req() req: Request, @Res() res: Response) {
    try {
      await this.billing.webhook(req.body as Buffer, req.headers['stripe-signature'] as string | undefined);
      return sendJson(res, 200, { received: true });
    } catch (e) {
      if (e instanceof StripeError && e.status === 400) return sendJson(res, 400, { error: e.message });
      logger.error(`webhook failed: ${describeError(e)}`, e instanceof Error ? e.stack : undefined);
      return sendJson(res, 500, { error: 'Webhook processing failed' }); // Stripe will retry
    }
  }
}
