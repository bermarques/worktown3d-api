// `npm run db:migrate`: apply pending migrations (Railway's pre-deploy command runs this).
//
// Databases created before the API used Prisma already have the tables of the baseline migration (0_init), and
// `prisma migrate deploy` refuses to touch a non-empty database it has no history for (error P3005). For those, run
// the baseline SQL (idempotent: it only creates what's missing), record it as applied, then deploy the rest.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const cli = createRequire(import.meta.url).resolve('prisma/build/index.js');
const BASELINE = '0_init';

function prisma(...args) {
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  return r;
}

let result = prisma('migrate', 'deploy');
if (result.status !== 0 && /P3005/.test(result.stdout + result.stderr)) {
  console.log(`\nAdopting a database created before Prisma: applying the baseline (${BASELINE}) and recording it.\n`);
  for (const step of [
    ['db', 'execute', '--file', `prisma/migrations/${BASELINE}/migration.sql`],
    ['migrate', 'resolve', '--applied', BASELINE],
  ]) {
    const r = prisma(...step);
    if (r.status !== 0) process.exit(r.status ?? 1);
  }
  result = prisma('migrate', 'deploy');
}
process.exit(result.status ?? 1);
