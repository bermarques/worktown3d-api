import { verifyWebhook } from "./stripe.js";

export const PLAN = { id: "basic", name: "Worktown3D Basic", orgLimit: 1 };

const OPEN_STATUSES = new Set(["active", "trialing", "past_due"]);
const SESSION_RE = /^cs_[A-Za-z0-9_]{10,200}$/;

const lower = (s) => String(s).toLowerCase();
const isOpen = (acc) => !!acc && OPEN_STATUSES.has(acc.status);

function httpError(status, message, extra = {}) {
  const e = new Error(message);
  e.status = status;
  Object.assign(e, extra);
  return e;
}

function periodEnd(sub) {
  const end =
    sub.current_period_end ??
    (sub.items &&
      sub.items.data &&
      sub.items.data[0] &&
      sub.items.data[0].current_period_end);
  return end ? end * 1000 : null;
}

export function createBilling({
  repo,
  stripe,
  priceId,
  webhookSecret,
  publicUrl,
  complimentary = [],
}) {
  const free = new Set(complimentary.map(lower));
  let price = null;

  async function priceInfo() {
    if (!price || Date.now() - price.at > 3600_000) {
      const p = await stripe.get(`prices/${priceId}`);
      const currency = String(p.currency || "brl").toUpperCase();
      const amount = new Intl.NumberFormat(
        currency === "BRL" ? "pt-BR" : "en-US",
        { style: "currency", currency },
      ).format((p.unit_amount || 0) / 100);
      const interval = p.recurring ? p.recurring.interval : null;
      price = {
        at: Date.now(),
        amount,
        interval,
        label: interval ? `${amount} / ${interval}` : amount,
      };
    }
    return price;
  }

  async function applySubscription(sub, hint = {}) {
    const customerId =
      typeof sub.customer === "string"
        ? sub.customer
        : sub.customer && sub.customer.id;
    let userId = hint.userId || (sub.metadata && sub.metadata.github_user_id);
    if (!userId && customerId) {
      const owner = await repo.accountByCustomer(customerId);
      userId = owner && owner.userId;
    }
    if (!userId) return;
    userId = String(userId);
    await repo.transaction(async (r) => {
      const acc = await r.getAccount(userId, { forUpdate: true });
      if (
        acc &&
        acc.subscriptionId &&
        acc.subscriptionId !== sub.id &&
        isOpen(acc) &&
        !OPEN_STATUSES.has(sub.status)
      )
        return;
      await r.putAccount({
        userId,
        login:
          hint.login ||
          (acc && acc.login) ||
          (sub.metadata && sub.metadata.github_login) ||
          null,
        customerId:
          customerId || hint.customerId || (acc && acc.customerId) || null,
        subscriptionId: sub.id,
        status: sub.status,
        renewsAt: periodEnd(sub),
        cancelAtPeriodEnd: !!sub.cancel_at_period_end,
      });
    });
  }

  return {
    enabled: true,

    async workspace(org) {
      return repo.getWorkspace(org);
    },

    async entitlement(owner, personal) {
      if (free.has(lower(owner))) return { ok: true, complimentary: true };
      const ws = await repo.getWorkspace(owner);
      const acc = ws ? await repo.getAccount(ws.ownerId) : null;
      if (ws && isOpen(acc))
        return {
          ok: true,
          pastDue: acc.status === "past_due",
          ownerLogin: ws.ownerLogin,
        };
      if (personal && personal.memberOf) {
        for (const org of personal.memberOf) {
          if (lower(org) !== lower(owner) && (await this.entitlement(org)).ok)
            return { ok: true, bonus: true, via: org };
        }
      }
      if (!ws) return { ok: false, reason: "none" };
      return { ok: false, reason: "inactive", ownerLogin: ws.ownerLogin };
    },

    async summary(user) {
      const [acc, mine, planPrice] = await Promise.all([
        repo.getAccount(user.id),
        repo.workspacesOf(user.id),
        priceInfo().catch(() => null),
      ]);
      return {
        enabled: true,
        plan: { ...PLAN, price: planPrice },
        subscription: acc
          ? {
              status: acc.status,
              active: isOpen(acc),
              pastDue: acc.status === "past_due",
              renewsAt: acc.renewsAt,
              cancelAtPeriodEnd: !!acc.cancelAtPeriodEnd,
              canManage: !!acc.customerId,
            }
          : null,
        workspaces: mine.map((w) => w.org),
        slotsLeft: Math.max(0, PLAN.orgLimit - mine.length),
      };
    },

    async checkout(user) {
      const acc = await repo.getAccount(user.id);
      if (isOpen(acc))
        throw httpError(409, "You already have an active subscription");
      const meta = {
        github_user_id: String(user.id),
        github_login: user.login,
      };
      const session = await stripe.post("checkout/sessions", {
        mode: "subscription",
        line_items: [{ price: priceId, quantity: 1 }],
        client_reference_id: String(user.id),
        customer: acc && acc.customerId ? acc.customerId : undefined,
        success_url: `${publicUrl}/?billing=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${publicUrl}/?billing=cancelled`,
        allow_promotion_codes: true,
        metadata: meta,
        subscription_data: { metadata: meta },
      });
      return { url: session.url };
    },

    async confirm(user, sessionId) {
      if (!SESSION_RE.test(String(sessionId)))
        throw httpError(400, "Invalid checkout session");
      const s = await stripe.get(`checkout/sessions/${sessionId}`, {
        expand: ["subscription"],
      });
      if (s.client_reference_id !== String(user.id))
        throw httpError(403, "This checkout belongs to someone else");
      if (s.subscription) {
        const sub =
          typeof s.subscription === "object"
            ? s.subscription
            : await stripe.get(`subscriptions/${s.subscription}`);
        await applySubscription(sub, {
          userId: user.id,
          login: user.login,
          customerId: s.customer,
        });
      }
      return this.summary(user);
    },

    async portal(user) {
      const acc = await repo.getAccount(user.id);
      if (!acc || !acc.customerId)
        throw httpError(409, "You don't have a subscription yet");
      const s = await stripe.post("billing_portal/sessions", {
        customer: acc.customerId,
        return_url: `${publicUrl}/`,
      });
      return { url: s.url };
    },

    async connect(user, org, provider) {
      const needsPlan = () =>
        httpError(402, "Subscribe first, then connect your organization", {
          needsSubscription: true,
        });
      if (!isOpen(await repo.getAccount(user.id))) throw needsPlan();
      const access = await provider.access(org);
      if (access.role !== "admin" && access.role !== "owner")
        throw httpError(403, `Only owners of ${org} can connect it`);
      return repo.transaction(async (r) => {
        if (!isOpen(await r.getAccount(user.id, { forUpdate: true })))
          throw needsPlan();
        const existing = await r.getWorkspace(org);
        if (existing && existing.ownerId === String(user.id))
          return { org: existing.org };
        if (existing && isOpen(await r.getAccount(existing.ownerId)))
          throw httpError(
            409,
            `${org} is already connected by @${existing.ownerLogin}`,
          );
        const mine = await r.workspacesOf(user.id);
        if (mine.length >= PLAN.orgLimit)
          throw httpError(
            409,
            `Your plan includes ${PLAN.orgLimit} organization. Disconnect ${mine[0].org} first to connect ${org}.`,
          );
        await r.putWorkspace({
          org,
          ownerId: String(user.id),
          ownerLogin: user.login,
        });
        return { org };
      });
    },

    async disconnect(user, org) {
      return repo.transaction(async (r) => {
        const ws = await r.getWorkspace(org);
        if (!ws || ws.ownerId !== String(user.id))
          throw httpError(403, `${org} isn't connected to your subscription`);
        await r.deleteWorkspace(org);
        return { ok: true };
      });
    },

    async webhook(rawBody, signature) {
      const event = verifyWebhook(rawBody, signature, webhookSecret);
      if (!(await repo.claimEvent(event.id))) return { duplicate: true };
      try {
        const obj = event.data && event.data.object;
        switch (event.type) {
          case "checkout.session.completed":
            if (obj.mode === "subscription" && obj.subscription) {
              const sub = await stripe.get(`subscriptions/${obj.subscription}`);
              await applySubscription(sub, {
                userId: obj.client_reference_id,
                login: obj.metadata && obj.metadata.github_login,
                customerId: obj.customer,
              });
            }
            break;
          case "customer.subscription.created":
          case "customer.subscription.updated":
          case "customer.subscription.deleted":
          case "customer.subscription.paused":
          case "customer.subscription.resumed":
            await applySubscription(await stripe.get(`subscriptions/${obj.id}`));
            break;
          default:
            break;
        }
      } catch (e) {
        await repo.releaseEvent(event.id).catch(() => {});
        throw e;
      }
      return { received: true };
    },
  };
}
