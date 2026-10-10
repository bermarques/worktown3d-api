import { Logger, type INestApplication } from '@nestjs/common';
import { PLAN } from './billing/billing.service.js';
import type { AppConfig } from './config/app-config.js';
import { LocalGh } from './local/local-gh.service.js';

/** What's running and how it's set up, once the server is listening: a banner, or one entry in JSON logs. */
export function printBanner(app: INestApplication, config: AppConfig) {
  const local = config.hosted ? null : app.get(LocalGh);
  if (config.logFormat === 'json') {
    const logger = new Logger('Startup');
    const stripeMode = config.stripe && (config.stripe.secretKey.startsWith('sk_live_') ? 'live' : 'test');
    logger.log('Worktown3D API started', {
      mode: config.hosted ? 'hosted' : 'local',
      origin: config.origin,
      host: config.host || '*',
      port: config.port,
      ...(config.hosted
        ? { subscriptions: stripeMode || 'off', githubWebhooks: config.github!.webhookSecret ? 'on' : 'off', allowedOrgs: config.allowedOrgs }
        : { building: local!.status().mode, owner: local!.owner() }),
    });
    if (config.hosted && !config.secure) logger.warn('PUBLIC_URL is not https: fine for local testing, never for production');
    return;
  }

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
    console.log(
      config.github!.webhookSecret
        ? `  GitHub webhooks: on (${config.origin}/api/github/webhook)`
        : '  GitHub webhooks: off (uninstalls and membership removals apply within minutes).',
    );
    if (!config.secure) console.log('  ⚠️  PUBLIC_URL is not https — fine for local testing, never for production.');
    console.log('');
    return;
  }
  const s = local!.status();
  console.log(`\n  🏢  Worktown3D API on http://${config.host}:${config.port}, for the web app at ${config.origin}\n`);
  if (s.mode === 'github') {
    console.log(`  GitHub CLI ${s.gh.version} — signed in as @${s.gh.user!.login}`);
    console.log(s.owner ? `  Connected organization: ${s.owner}` : '  Pick an organization in the browser to get started.');
  } else if (config.forceDemo) {
    console.log('  Running in demo mode (--demo) with a fictional company.');
  } else {
    console.log(`  Demo mode: ${local!.gh.error || 'demo selected in the manager office'}`);
    if (!local!.gh.installed) console.log('  Install the GitHub CLI (https://cli.github.com) and run `gh auth login` to use your real org.');
  }
  console.log('');
}
