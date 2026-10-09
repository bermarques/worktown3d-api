// Prisma CLI configuration (generate, migrate). The app itself connects in src/prisma/prisma.service.ts.
import { defineConfig } from 'prisma/config';

try {
  process.loadEnvFile();
} catch {
  /* no .env file: use the real environment */
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  // Not env('DATABASE_URL'): that throws when it's unset, and `prisma generate` (run on install) needs no database.
  datasource: { url: process.env.DATABASE_URL ?? '' },
});
