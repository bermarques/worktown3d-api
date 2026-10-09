import { Body, Controller, Delete, Get, HttpCode, Param, Post } from '@nestjs/common';
import { BuildingService } from '../api/building.service.js';
import { Ctx, type ApiContext } from '../api/context.js';
import { HttpError } from '../common/http-error.js';
import { need, OWNER_RE } from '../common/match.pipe.js';
import { ViewCache } from '../common/view-cache.js';
import { AppConfig } from '../config/app-config.js';

/** The signed-in person's subscription and the organizations connected to it (hosted mode). */
@Controller('api')
export class BillingController {
  constructor(
    private readonly config: AppConfig,
    private readonly building: BuildingService,
    private readonly cache: ViewCache,
  ) {}

  @Get('billing')
  summary(@Ctx() ctx: ApiContext) {
    const { billing, user } = this.building.requireSubscriber(ctx);
    return billing.summary(user);
  }

  @Post('billing/checkout')
  @HttpCode(200)
  checkout(@Ctx() ctx: ApiContext) {
    const { billing, user } = this.building.requireSubscriber(ctx);
    return billing.checkout(user);
  }

  @Post('billing/confirm')
  @HttpCode(200)
  confirm(@Ctx() ctx: ApiContext, @Body() body: Record<string, unknown>) {
    const { billing, user } = this.building.requireSubscriber(ctx);
    return billing.confirm(user, body.sessionId);
  }

  @Post('billing/portal')
  @HttpCode(200)
  portal(@Ctx() ctx: ApiContext) {
    const { billing, user } = this.building.requireSubscriber(ctx);
    return billing.portal(user);
  }

  @Post('workspaces')
  @HttpCode(200)
  async connect(@Ctx() context: ApiContext, @Body() body: Record<string, unknown>) {
    const { billing, user, ctx } = this.building.requireSubscriber(context);
    const org = need(body.org, OWNER_RE, 'organization');
    if (!this.config.orgAllowed(org)) throw new HttpError(403, `This Worktown3D server isn't set up for ${org}`);
    const result = await billing.connect(user, org, ctx.provider);
    this.cache.invalidate(`${ctx.ns}:${org}:access`);
    return result;
  }

  @Delete('workspaces/:org')
  disconnect(@Ctx() ctx: ApiContext, @Param('org') org: string) {
    const { billing, user } = this.building.requireSubscriber(ctx);
    return billing.disconnect(user, need(org, OWNER_RE, 'organization'));
  }
}
