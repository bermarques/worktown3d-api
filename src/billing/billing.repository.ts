import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Prisma, Account as AccountRow } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

const lower = (s: string) => String(s).toLowerCase();
const EVENT_RETENTION_MS = 30 * 24 * 3600_000;

export interface Account {
  userId: string;
  login: string | null;
  customerId: string | null;
  subscriptionId: string | null;
  status: string | null;
  /** End of the current billing period (ms since the epoch). */
  renewsAt: number | null;
  cancelAtPeriodEnd: boolean;
}

export interface Workspace {
  org: string;
  ownerId: string;
  ownerLogin: string | null;
}

function toAccount(r: AccountRow): Account {
  return {
    userId: r.userId,
    login: r.login,
    customerId: r.customerId,
    subscriptionId: r.subscriptionId,
    status: r.status,
    renewsAt: r.renewsAt === null ? null : Number(r.renewsAt),
    cancelAtPeriodEnd: r.cancelAtPeriodEnd,
  };
}

const toWorkspace = (r: Workspace): Workspace => ({ org: r.org, ownerId: r.ownerId, ownerLogin: r.ownerLogin });

/** Subscription records: subscriber accounts, the organizations they connected, and handled Stripe events. */
export class BillingRecords {
  constructor(protected readonly db: Prisma.TransactionClient) {}

  /** `forUpdate` locks the account row until the surrounding transaction ends. */
  async getAccount(userId: string | number, { forUpdate = false } = {}) {
    const id = String(userId);
    if (forUpdate) await this.db.$queryRaw`SELECT 1 FROM accounts WHERE user_id = ${id} FOR UPDATE`;
    const row = await this.db.account.findUnique({ where: { userId: id } });
    return row ? toAccount(row) : null;
  }

  async accountByCustomer(customerId: string) {
    const row = await this.db.account.findFirst({ where: { customerId } });
    return row ? toAccount(row) : null;
  }

  async putAccount(a: Account) {
    const data = {
      login: a.login,
      customerId: a.customerId,
      subscriptionId: a.subscriptionId,
      status: a.status,
      renewsAt: a.renewsAt === null ? null : BigInt(a.renewsAt),
      cancelAtPeriodEnd: !!a.cancelAtPeriodEnd,
    };
    const userId = String(a.userId);
    await this.db.account.upsert({ where: { userId }, create: { userId, ...data }, update: data });
  }

  async getWorkspace(org: string) {
    const row = await this.db.workspace.findUnique({ where: { orgKey: lower(org) } });
    return row ? toWorkspace(row) : null;
  }

  async workspacesOf(userId: string | number) {
    const rows = await this.db.workspace.findMany({ where: { ownerId: String(userId) }, orderBy: { createdAt: 'asc' } });
    return rows.map(toWorkspace);
  }

  async putWorkspace(ws: Workspace) {
    const orgKey = lower(ws.org);
    const data = { org: ws.org, ownerId: String(ws.ownerId), ownerLogin: ws.ownerLogin };
    await this.db.workspace.upsert({ where: { orgKey }, create: { orgKey, ...data }, update: { ...data, createdAt: new Date() } });
  }

  async deleteWorkspace(org: string) {
    await this.db.workspace.deleteMany({ where: { orgKey: lower(org) } });
  }

  /** Record a Stripe event as handled; false if it already was. */
  async claimEvent(id: string) {
    const { count } = await this.db.stripeEvent.createMany({ data: [{ id }], skipDuplicates: true });
    return count === 1;
  }

  async releaseEvent(id: string) {
    await this.db.stripeEvent.deleteMany({ where: { id } });
  }
}

@Injectable()
export class BillingRepository extends BillingRecords implements OnModuleInit {
  constructor(private readonly prisma: PrismaService) {
    super(prisma);
  }

  onModuleInit() {
    this.prisma.stripeEvent.deleteMany({ where: { receivedAt: { lt: new Date(Date.now() - EVENT_RETENTION_MS) } } }).catch(() => {});
  }

  transaction<T>(fn: (records: BillingRecords) => Promise<T>) {
    return this.prisma.$transaction((tx) => fn(new BillingRecords(tx)));
  }
}
