import { Injectable } from '@nestjs/common';
import { HttpError } from '../common/http-error.js';
import { AppConfig } from '../config/app-config.js';
import type { Provider } from '../github/types.js';
import type { SessionUser } from '../sessions/session.store.js';
import { BillingRepository, type Account } from './billing.repository.js';
import { StripeClient, verifyWebhook } from './stripe.client.js';

export const PLAN = { id: 'basic', name: 'Worktown3D Basic', orgLimit: 1 };

const OPEN_STATUSES = new Set(['active', 'trialing', 'past_due']);

const lower = (s: string) => String(s).toLowerCase();
const isOpen = (acc: Account | null) => !!acc && OPEN_STATUSES.has(acc.status!);

export interface Entitlement {
  ok: boolean;
  complimentary?: boolean;
  pastDue?: boolean;
  bonus?: boolean;
  via?: string;
  reason?: 'none' | 'inactive';
  ownerLogin?: string | null;
}

// Stripe objects are read field by field, as they come.
type StripeObject = any;

function periodEnd(sub: StripeObject): number | null {
  const end = sub.current_period_end ?? (sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].current_period_end);
  return end ? end * 1000 : null;
}

/** Subscriptions: plans, connected organizations, who may enter which building, and Stripe webhooks. */
@Injectable()
export class BillingService {
  private readonly free: Set<string>;
  private readonly priceId: string;
  private readonly webhookSecret: string;
  private readonly publicUrl: string;
  private price: { at: number; amount: string; interval: string | null; label: string } | null = null;

  constructor(
    private readonly repo: BillingRepository,
    private readonly stripe: StripeClient,
    config: AppConfig,
  ) {
    const { priceId, webhookSecret, complimentaryOrgs } = config.stripe!;
    this.free = new Set(complimentaryOrgs.map(lower));
    this.priceId = priceId;
    this.webhookSecret = webhookSecret;
    this.publicUrl = config.origin;
  }

  private async priceInfo() {
    if (!this.price || Date.now() - this.price.at > 3600_000) {
      const p = await this.stripe.get(`prices/${this.priceId}`);
      const currency = String(p.currency || 'brl').toUpperCase();
      const amount = new Intl.NumberFormat(currency === 'BRL' ? 'pt-BR' : 'en-US', { style: 'currency', currency }).format((p.unit_amount || 0) / 100);
      const interval = p.recurring ? p.recurring.interval : null;
      this.price = { at: Date.now(), amount, interval, label: interval ? `${amount} / ${interval}` : amount };
    }
    return this.price;
  }

  private async applySubscription(sub: StripeObject, hint: { userId?: string | number | null; login?: string | null; customerId?: string | null } = {}) {
    const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer && sub.customer.id;
    let userId = hint.userId || (sub.metadata && sub.metadata.github_user_id);
    if (!userId && customerId) {
      const owner = await this.repo.accountByCustomer(customerId);
      userId = owner && owner.userId;
    }
    if (!userId) return;
    const id = String(userId);
    await this.repo.transaction(async (r) => {
      const acc = await r.getAccount(id, { forUpdate: true });
      if (acc && acc.subscriptionId && acc.subscriptionId !== sub.id && isOpen(acc) && !OPEN_STATUSES.has(sub.status)) return;
      await r.putAccount({
        userId: id,
        login: hint.login || (acc && acc.login) || (sub.metadata && sub.metadata.github_login) || null,
        customerId: customerId || hint.customerId || (acc && acc.customerId) || null,
        subscriptionId: sub.id,
        status: sub.status,
        renewsAt: periodEnd(sub),
        cancelAtPeriodEnd: !!sub.cancel_at_period_end,
      });
    });
  }

  workspace(org: string) {
    return this.repo.getWorkspace(org);
  }

  async entitlement(owner: string, personal?: { memberOf: string[] }): Promise<Entitlement> {
    if (this.free.has(lower(owner))) return { ok: true, complimentary: true };
    const ws = await this.repo.getWorkspace(owner);
    const acc = ws ? await this.repo.getAccount(ws.ownerId) : null;
    if (ws && acc && isOpen(acc)) return { ok: true, pastDue: acc.status === 'past_due', ownerLogin: ws.ownerLogin };
    if (personal && personal.memberOf) {
      for (const org of personal.memberOf) {
        if (lower(org) !== lower(owner) && (await this.entitlement(org)).ok) return { ok: true, bonus: true, via: org };
      }
    }
    if (!ws) return { ok: false, reason: 'none' };
    return { ok: false, reason: 'inactive', ownerLogin: ws.ownerLogin };
  }

  async summary(user: SessionUser) {
    const [acc, mine, planPrice] = await Promise.all([this.repo.getAccount(user.id), this.repo.workspacesOf(user.id), this.priceInfo().catch(() => null)]);
    return {
      enabled: true,
      plan: { ...PLAN, price: planPrice },
      subscription: acc
        ? {
            status: acc.status,
            active: isOpen(acc),
            pastDue: acc.status === 'past_due',
            renewsAt: acc.renewsAt,
            cancelAtPeriodEnd: !!acc.cancelAtPeriodEnd,
            canManage: !!acc.customerId,
          }
        : null,
      workspaces: mine.map((w) => w.org),
      slotsLeft: Math.max(0, PLAN.orgLimit - mine.length),
    };
  }

  async checkout(user: SessionUser) {
    const acc = await this.repo.getAccount(user.id);
    if (isOpen(acc)) throw new HttpError(409, 'You already have an active subscription');
    const meta = { github_user_id: String(user.id), github_login: user.login };
    const session = await this.stripe.post('checkout/sessions', {
      mode: 'subscription',
      line_items: [{ price: this.priceId, quantity: 1 }],
      client_reference_id: String(user.id),
      customer: acc && acc.customerId ? acc.customerId : undefined,
      success_url: `${this.publicUrl}/?billing=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${this.publicUrl}/?billing=cancelled`,
      allow_promotion_codes: true,
      metadata: meta,
      subscription_data: { metadata: meta },
    });
    return { url: session.url };
  }

  /** `sessionId` is checked by ConfirmCheckoutDto. */
  async confirm(user: SessionUser, sessionId: string) {
    const s = await this.stripe.get(`checkout/sessions/${sessionId}`, { expand: ['subscription'] });
    if (s.client_reference_id !== String(user.id)) throw new HttpError(403, 'This checkout belongs to someone else');
    if (s.subscription) {
      const sub = typeof s.subscription === 'object' ? s.subscription : await this.stripe.get(`subscriptions/${s.subscription}`);
      await this.applySubscription(sub, { userId: user.id, login: user.login, customerId: s.customer });
    }
    return this.summary(user);
  }

  async portal(user: SessionUser) {
    const acc = await this.repo.getAccount(user.id);
    if (!acc || !acc.customerId) throw new HttpError(409, "You don't have a subscription yet");
    const s = await this.stripe.post('billing_portal/sessions', { customer: acc.customerId, return_url: `${this.publicUrl}/` });
    return { url: s.url };
  }

  async connect(user: SessionUser, org: string, provider: Provider) {
    const needsPlan = () => new HttpError(402, 'Subscribe first, then connect your organization', { needsSubscription: true });
    if (!isOpen(await this.repo.getAccount(user.id))) throw needsPlan();
    const access = await provider.access(org);
    if (access.role !== 'admin' && access.role !== 'owner') throw new HttpError(403, `Only owners of ${org} can connect it`);
    return this.repo.transaction(async (r) => {
      if (!isOpen(await r.getAccount(user.id, { forUpdate: true }))) throw needsPlan();
      const existing = await r.getWorkspace(org);
      if (existing && existing.ownerId === String(user.id)) return { org: existing.org };
      if (existing && isOpen(await r.getAccount(existing.ownerId))) throw new HttpError(409, `${org} is already connected by @${existing.ownerLogin}`);
      const mine = await r.workspacesOf(user.id);
      if (mine.length >= PLAN.orgLimit) {
        throw new HttpError(409, `Your plan includes ${PLAN.orgLimit} organization. Disconnect ${mine[0].org} first to connect ${org}.`);
      }
      await r.putWorkspace({ org, ownerId: String(user.id), ownerLogin: user.login });
      return { org };
    });
  }

  async disconnect(user: SessionUser, org: string) {
    return this.repo.transaction(async (r) => {
      const ws = await r.getWorkspace(org);
      if (!ws || ws.ownerId !== String(user.id)) throw new HttpError(403, `${org} isn't connected to your subscription`);
      await r.deleteWorkspace(org);
      return { ok: true };
    });
  }

  async webhook(rawBody: Buffer, signature: string | undefined) {
    const event = verifyWebhook(rawBody, signature, this.webhookSecret);
    if (!(await this.repo.claimEvent(event.id))) return { duplicate: true };
    try {
      const obj = event.data && event.data.object;
      switch (event.type) {
        case 'checkout.session.completed':
          if (obj.mode === 'subscription' && obj.subscription) {
            const sub = await this.stripe.get(`subscriptions/${obj.subscription}`);
            await this.applySubscription(sub, {
              userId: obj.client_reference_id,
              login: obj.metadata && obj.metadata.github_login,
              customerId: obj.customer,
            });
          }
          break;
        case 'customer.subscription.created':
        case 'customer.subscription.updated':
        case 'customer.subscription.deleted':
        case 'customer.subscription.paused':
        case 'customer.subscription.resumed':
          await this.applySubscription(await this.stripe.get(`subscriptions/${obj.id}`));
          break;
        default:
          break;
      }
    } catch (e) {
      await this.repo.releaseEvent(event.id).catch(() => {});
      throw e;
    }
    return { received: true };
  }
}
