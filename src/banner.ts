import type { INestApplication } from '@nestjs/common';
import { PLAN } from './billing/billing.service.js';
import type { AppConfig } from './config/app-config.js';
import { LocalGh } from './local/local-gh.service.js';

/** What's running and how it's set up, printed once the server is listening. */
export function printBanner(app: INestApplication, config: AppConfig) {
  if (config.hosted) {
    console.log(`\n  🏢  Worktown3D API (hosted mode) for ${config.origin}  — listening on ${config.host || '*'}:${config.port}`);
    console.log(`  Sign-in callback URL: ${config.origin}/auth/callback`);
    if (config.allowedOrgs.length) console.log(`  Restricted to organizations: ${config.allowedOrgs.join(', ')}`);
    console.log('  Storage: PostgreSQL');
    if (config.stripe) {
      const mode = config.stripe.secretKey.startsWith('sk_live_') ? 'LIVE' : 'test';
      console.log(`  Subscriptions: on (${PLAN.name}, ${mode} mode). Stripe webhook: ${config.origin}/stripe/webhook`);
      if (config.stripe.complimentaryOrgs.length) console.log(`  Free organizations: ${config.stripe.complimentaryOrgs.join(', ')}`);
    } else console.log('  Subscriptions: off (every organization member can open its building).');
    if (!config.secure) console.log('  ⚠️  PUBLIC_URL is not https — fine for local testing, never for production.');
    console.log('');
    return;
  }
  const local = app.get(LocalGh);
  const s = local.status();
  console.log(`\n  🏢  Worktown3D API on http://${config.host}:${config.port}, for the web app at ${config.origin}\n`);
  if (s.mode === 'github') {
    console.log(`  GitHub CLI ${s.gh.version} — signed in as @${s.gh.user!.login}`);
    console.log(s.owner ? `  Connected organization: ${s.owner}` : '  Pick an organization in the browser to get started.');
  } else if (config.forceDemo) {
    console.log('  Running in demo mode (--demo) with a fictional company.');
  } else {
    console.log(`  Demo mode: ${local.gh.error || 'demo selected in the manager office'}`);
    if (!local.gh.installed) console.log('  Install the GitHub CLI (https://cli.github.com) and run `gh auth login` to use your real org.');
  }
  console.log('');
}
