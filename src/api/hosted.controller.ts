import { Body, Controller, Get, HttpCode, Optional, Post, Req, Res } from '@nestjs/common';
import type { Response } from 'express';
import { BillingService } from '../billing/billing.service.js';
import { HttpError } from '../common/http-error.js';
import { RateLimits } from '../common/rate-limits.js';
import { clientIp } from '../common/security.js';
import { AppConfig } from '../config/app-config.js';
import { SessionStore } from '../sessions/session.store.js';
import { BuildingService } from './building.service.js';
import { ConnectDto } from './connect.dto.js';
import { Ctx, type ApiContext, type ApiRequest } from './context.js';

/** Status, sign-in state and organization choice in hosted mode. */
@Controller('api')
export class HostedController {
  constructor(
    private readonly config: AppConfig,
    private readonly building: BuildingService,
    private readonly sessions: SessionStore,
    private readonly limits: RateLimits,
    @Optional() private readonly billing?: BillingService,
  ) {}

  @Get('status')
  status(@Ctx() ctx: ApiContext) {
    const s = ctx.session;
    return {
      hosted: true,
      mode: s ? (s.kind === 'demo' ? 'demo' : 'github') : null,
      user: s && s.kind === 'user' ? s.user : null,
      viewer: ctx.viewer || null,
      owner: ctx.owner || null,
      installUrl: this.config.installUrl,
      billing: !!this.billing,
    };
  }

  /** A private demo sandbox for visitors who haven't signed in (great for a landing page). */
  @Post('demo')
  @HttpCode(200)
  async demo(@Ctx() ctx: ApiContext, @Req() req: ApiRequest, @Res({ passthrough: true }) res: Response) {
    if (ctx.session && ctx.session.kind === 'user') throw new HttpError(409, "You're signed in — sign out to try the demo");
    if (!this.limits.demo(clientIp(req, this.config.trustProxy))) throw new HttpError(429, 'Too many demo sessions from this network, try again later');
    if (!ctx.session) {
      const { cookie } = await this.sessions.createDemo();
      res.setHeader('Set-Cookie', cookie);
    }
    return { ok: true };
  }

  @Get('owners')
  async owners(@Ctx() ctx: ApiContext) {
    this.building.requireSession(ctx);
    const session = ctx.session!;
    const owners = await this.building.listOwners(ctx);
    const visible = owners.filter((o) => this.config.orgAllowed(o.login) || session.kind === 'demo');
    if (!this.billing || session.kind !== 'user') return visible;
    const billing = this.billing;
    const me = session.user;
    const orgs = visible.filter((o) => o.type === 'Organization').map((o) => o.login);
    return Promise.all(
      visible.map(async (o) => {
        const personal = o.type === 'User' && o.login.toLowerCase() === me.login.toLowerCase() ? { memberOf: orgs } : undefined;
        const [ent, ws] = await Promise.all([billing.entitlement(o.login, personal), billing.workspace(o.login)]);
        return {
          ...o,
          building: {
            open: ent.ok,
            bonus: !!ent.bonus,
            via: ent.via || null,
            reason: ent.reason || null,
            connectedByMe: !!ws && ws.ownerId === String(me.id),
            connectedBy: ws ? ws.ownerLogin : null,
          },
        };
      }),
    );
  }

  @Post('connect')
  @HttpCode(200)
  async connect(@Ctx() ctx: ApiContext, @Body() body: ConnectDto) {
    this.building.requireSession(ctx);
    const session = ctx.session!;
    if (session.kind === 'demo') return this.status(ctx);
    const owner = body.owner;
    const access = await this.building.accessFor(ctx, owner, true);
    if (access.role === 'none') throw new HttpError(403, `You're not a member of ${owner} on GitHub`);
    await this.sessions.setOrg(session, owner);
    return this.status({ ...ctx, owner });
  }
}
