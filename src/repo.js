import { transaction } from "./db.js";

const lower = (s) => String(s).toLowerCase();

const ACCOUNT_COLUMNS =
  "user_id, login, customer_id, subscription_id, status, renews_at, cancel_at_period_end";

function toAccount(r) {
  return {
    userId: r.user_id,
    login: r.login,
    customerId: r.customer_id,
    subscriptionId: r.subscription_id,
    status: r.status,
    renewsAt: r.renews_at === null ? null : Number(r.renews_at),
    cancelAtPeriodEnd: !!r.cancel_at_period_end,
  };
}

function toWorkspace(r) {
  return { org: r.org, ownerId: r.owner_id, ownerLogin: r.owner_login };
}

export function createPgRepo(pool) {
  const ops = (q) => ({
    async getAccount(userId, { forUpdate = false } = {}) {
      const { rows } = await q.query(
        `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE user_id = $1${forUpdate ? " FOR UPDATE" : ""}`,
        [String(userId)],
      );
      return rows[0] ? toAccount(rows[0]) : null;
    },
    async accountByCustomer(customerId) {
      const { rows } = await q.query(
        `SELECT ${ACCOUNT_COLUMNS} FROM accounts WHERE customer_id = $1 LIMIT 1`,
        [customerId],
      );
      return rows[0] ? toAccount(rows[0]) : null;
    },
    async putAccount(a) {
      await q.query(
        `INSERT INTO accounts (${ACCOUNT_COLUMNS}, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())
         ON CONFLICT (user_id) DO UPDATE SET
           login = EXCLUDED.login,
           customer_id = EXCLUDED.customer_id,
           subscription_id = EXCLUDED.subscription_id,
           status = EXCLUDED.status,
           renews_at = EXCLUDED.renews_at,
           cancel_at_period_end = EXCLUDED.cancel_at_period_end,
           updated_at = now()`,
        [
          String(a.userId),
          a.login,
          a.customerId,
          a.subscriptionId,
          a.status,
          a.renewsAt,
          !!a.cancelAtPeriodEnd,
        ],
      );
    },
    async getWorkspace(org) {
      const { rows } = await q.query(
        "SELECT org, owner_id, owner_login FROM workspaces WHERE org_key = $1",
        [lower(org)],
      );
      return rows[0] ? toWorkspace(rows[0]) : null;
    },
    async workspacesOf(userId) {
      const { rows } = await q.query(
        "SELECT org, owner_id, owner_login FROM workspaces WHERE owner_id = $1 ORDER BY created_at",
        [String(userId)],
      );
      return rows.map(toWorkspace);
    },
    async putWorkspace(ws) {
      await q.query(
        `INSERT INTO workspaces (org_key, org, owner_id, owner_login)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (org_key) DO UPDATE SET
           org = EXCLUDED.org,
           owner_id = EXCLUDED.owner_id,
           owner_login = EXCLUDED.owner_login,
           created_at = now()`,
        [lower(ws.org), ws.org, String(ws.ownerId), ws.ownerLogin],
      );
    },
    async deleteWorkspace(org) {
      await q.query("DELETE FROM workspaces WHERE org_key = $1", [lower(org)]);
    },
    async claimEvent(id) {
      try {
        await q.query("INSERT INTO stripe_events (id) VALUES ($1)", [id]);
        return true;
      } catch (e) {
        if (e.code === "23505") return false;
        throw e;
      }
    },
    async releaseEvent(id) {
      await q.query("DELETE FROM stripe_events WHERE id = $1", [id]);
    },
  });

  pool
    .query("DELETE FROM stripe_events WHERE received_at < now() - interval '30 days'")
    .catch(() => {});

  return {
    ...ops(pool),
    transaction: (fn) => transaction(pool, (client) => fn(ops(client))),
  };
}
