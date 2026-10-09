import { Injectable, Optional } from '@nestjs/common';
import { BillingService } from '../billing/billing.service.js';
import { HttpError } from '../common/http-error.js';
import { ViewCache } from '../common/view-cache.js';
import { AppConfig } from '../config/app-config.js';
import type { Access, Provider, World } from '../github/types.js';
import { SessionStore } from '../sessions/session.store.js';
import type { ApiContext } from './context.js';

const DEFAULT_FLOOR_COUNT = 15;

export type SignedInContext = ApiContext & { provider: Provider };
export type BuildingContext = SignedInContext & { owner: string; settings: NonNullable<ApiContext['settings']> };

export interface BuildingAccess extends Access {
  billing?: { pastDue: boolean; bonus: boolean; via: string | null; complimentary: boolean };
}

/** Who may enter which building, and the building's data (cached per viewer). */
@Injectable()
export class BuildingService {
  constructor(
    private readonly config: AppConfig,
    private readonly cache: ViewCache,
    @Optional() private readonly billing?: BillingService,
    @Optional() private readonly sessions?: SessionStore,
  ) {}

  requireSession(ctx: ApiContext): asserts ctx is SignedInContext {
    if (!ctx.provider) throw new HttpError(401, 'Please sign in with GitHub', { signedOut: true });
  }

  /** Is the viewer allowed into this building, and as what? Re-checked every few minutes so people who leave lose access. */
  async accessFor(ctx: SignedInContext, owner: string, fresh = false) {
    if (!this.config.orgAllowed(owner) && !(ctx.session && ctx.session.kind === 'demo')) {
      throw new HttpError(403, `This Worktown3D server isn't set up for ${owner}`);
    }
    return this.cache.cached(`${ctx.ns}:${owner}:access`, 5 * 60_000, () => ctx.provider.access(owner), fresh);
  }

  private async requireOrg(ctx: ApiContext): Promise<BuildingAccess> {
    this.requireSession(ctx);
    if (!ctx.owner) throw new HttpError(409, 'No GitHub organization selected yet', { noOrg: true });
    const access: BuildingAccess = await this.accessFor(ctx, ctx.owner);
    if (access.role === 'none') {
      if (ctx.session) await this.sessions!.setOrg(ctx.session, null);
      throw new HttpError(403, `You're not a member of ${ctx.owner} on GitHub`, { noOrg: true });
    }
    if (this.billing && ctx.session && ctx.session.kind === 'user') {
      const personal = access.role === 'owner' ? { memberOf: await this.memberOrgs(ctx) } : undefined;
      const ent = await this.billing.entitlement(ctx.owner, personal);
      if (!ent.ok) {
        const message =
          ent.reason === 'inactive'
            ? `${ctx.owner}'s Worktown3D subscription isn't active. Ask @${ent.ownerLogin} to renew it.`
            : access.canManage
              ? `${ctx.owner} isn't on Worktown3D yet. Subscribe and connect it to open the building.`
              : `${ctx.owner} isn't on Worktown3D yet. Ask one of its owners to subscribe.`;
        throw new HttpError(402, message, { needsSubscription: true });
      }
      return { ...access, billing: { pastDue: !!ent.pastDue, bonus: !!ent.bonus, via: ent.via || null, complimentary: !!ent.complimentary } };
    }
    return access;
  }

  /** The viewer must be signed in, with a building they may enter. Returns the narrowed context and their access. */
  async requireBuilding(ctx: ApiContext): Promise<{ ctx: BuildingContext; access: BuildingAccess }> {
    const access = await this.requireOrg(ctx);
    return { ctx: ctx as BuildingContext, access };
  }

  /** Organizations the viewer belongs to (cached). */
  async memberOrgs(ctx: SignedInContext) {
    const owners = await this.listOwners(ctx);
    return owners.filter((o) => o.type === 'Organization').map((o) => o.login);
  }

  listOwners(ctx: SignedInContext) {
    return this.cache.cached(`${ctx.ns}:owners`, 60_000, () => ctx.provider.listOwners());
  }

  requireSubscriber(ctx: ApiContext) {
    if (!this.billing) throw new HttpError(404, 'Subscriptions are not enabled on this server');
    this.requireSession(ctx);
    if (!ctx.session || ctx.session.kind !== 'user') throw new HttpError(403, 'Sign in with GitHub to manage a subscription');
    return { billing: this.billing, user: ctx.session.user, ctx };
  }

  getWorld(ctx: BuildingContext, fresh = false) {
    return this.cache.cached(`${ctx.ns}:${ctx.owner}:world`, 120_000, () => ctx.provider.getWorld(ctx.owner), fresh);
  }

  async floorsFor(ctx: BuildingContext, world: World) {
    const settings = await ctx.settings.get();
    const names = new Set(world.repos.map((r) => r.name));
    if (settings.floors) return settings.floors.filter((n) => names.has(n));
    return world.repos
      .filter((r) => !r.isArchived)
      .slice(0, DEFAULT_FLOOR_COUNT)
      .map((r) => r.name);
  }
}
