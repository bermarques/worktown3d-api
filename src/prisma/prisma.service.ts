import fs from 'node:fs';
import path from 'node:path';
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { databaseReason } from '../common/http-error.js';
import { AppConfig, ConfigError } from '../config/app-config.js';
import { PrismaClient } from '../generated/prisma/client.js';

const logger = new Logger('Database');
const MIGRATIONS_DIR = path.join(import.meta.dirname, '..', '..', 'prisma', 'migrations');

/** The PostgreSQL connection (hosted mode). Migrations are applied by `npm run db:migrate`, not at startup. */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(config: AppConfig) {
    super({
      adapter: new PrismaPg(
        { connectionString: config.databaseUrl!, max: 5, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 10_000 },
        { onPoolError: (e) => logger.error(e.message) },
      ),
    });
  }

  async onModuleInit() {
    try {
      await this.$connect();
      await this.$queryRaw`SELECT 1`;
    } catch (e) {
      throw new ConfigError(`Could not connect to the database: ${e instanceof Error ? databaseReason(e) : e}`);
    }
    await this.checkMigrations();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  /** Refuse to start against a database that's missing migrations, rather than failing on the first query. */
  private async checkMigrations() {
    const expected = fs.readdirSync(MIGRATIONS_DIR).filter((name) => fs.existsSync(path.join(MIGRATIONS_DIR, name, 'migration.sql')));
    let applied: string[] = [];
    try {
      const rows = await this.$queryRaw<{ migration_name: string }[]>`
        SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
      applied = rows.map((r) => r.migration_name);
    } catch {
      /* no _prisma_migrations table: nothing applied yet */
    }
    const missing = expected.filter((name) => !applied.includes(name));
    if (missing.length) {
      throw new ConfigError(`The database schema is out of date (missing: ${missing.join(', ')}). Run \`npm run db:migrate\` first.`);
    }
  }
}
