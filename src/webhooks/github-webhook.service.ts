import crypto from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { OWNER_RE } from '../common/match.pipe.js';
import { safeEqual } from '../common/security.js';
import { ViewCache } from '../common/view-cache.js';
import { AppConfig } from '../config/app-config.js';
import { CLOSE } from '../live/live.protocol.js';
import { PresenceService } from '../live/presence.service.js';
import { SessionStore } from '../sessions/session.store.js';

const logger = new Logger('GitHubWebhook');

// Webhook payloads are read field by field, as GitHub sends them.
type Payload = any;

const login = (v: unknown) => (typeof v === 'string' && OWNER_RE.test(v) ? v : null);
const userId = (v: unknown) => (Number.isSafeInteger(v) && (v as number) > 0 ? String(v) : null);

/**
 * GitHub App webhooks (hosted mode), so losing access takes effect at once instead of when cached access checks
 * expire (a few minutes):
 *  - the app is uninstalled from (or suspended on) an account, or the organization is deleted: everyone in that
 *    building goes back to the building picker;
 *  - someone is removed from an organization: they go back to the building picker;
 *  - someone revokes their authorization of the app: they're signed out everywhere.
 * Choosing a building always re-checks access with GitHub, so going back to the picker is enough to lock people out.
 */
@Injectable()
export class GithubWebhookService {
  private readonly secret: string;

  constructor(
    config: AppConfig,
    private readonly sessions: SessionStore,
    private readonly cache: ViewCache,
    private readonly presence: PresenceService,
  ) {
    this.secret = config.github!.webhookSecret!;
  }

  /** X-Hub-Signature-256: the HMAC-SHA256 of the raw body with the webhook secret. */
  verify(rawBody: Buffer, signature: unknown) {
    if (typeof signature !== 'string') return false;
    const expected = `sha256=${crypto.createHmac('sha256', this.secret).update(rawBody).digest('hex')}`;
    return safeEqual(signature, expected);
  }

  /** Apply one delivery. Events we don't act on (including the ping sent when the webhook is set up) are ignored. */
  async handle(event: string, payload: Payload) {
    const action = payload && payload.action;
    switch (`${event}.${action}`) {
      case 'installation.deleted':
      case 'installation.suspend':
        return this.closeBuilding(login(payload.installation?.account?.login), `${event}.${action}`);
      case 'installation.created':
      case 'installation.unsuspend':
      case 'installation.new_permissions_accepted': {
        // Access can only grow: drop cached "no access" answers so the building shows up right away.
        const account = login(payload.installation?.account?.login);
        if (account) this.cache.forgetOwner(account);
        return this.done(`${event}.${action}`, { account });
      }
      case 'organization.deleted':
        return this.closeBuilding(login(payload.organization?.login), `${event}.${action}`);
      case 'organization.member_removed':
        return this.removeMember(login(payload.organization?.login), payload.membership?.user, `${event}.${action}`);
      case 'github_app_authorization.revoked':
        return this.signOut(payload.sender, `${event}.${action}`);
      default:
        return null;
    }
  }

  private async closeBuilding(account: string | null, what: string) {
    if (!account) return null;
    const sessions = await this.sessions.leaveBuilding(account);
    this.presence.kick({ building: account }, CLOSE.forbidden, 'You no longer have access to this building');
    this.cache.forgetOwner(account);
    return this.done(what, { account, sessions });
  }

  private async removeMember(org: string | null, user: Payload, what: string) {
    const id = userId(user?.id);
    if (!org || !id) return null;
    const sessions = await this.sessions.leaveBuilding(org, id);
    this.presence.kick({ building: org, userId: Number(id) }, CLOSE.forbidden, 'You no longer have access to this building');
    this.cache.forgetUser(id);
    return this.done(what, { account: org, user: login(user.login), sessions });
  }

  private async signOut(user: Payload, what: string) {
    const id = userId(user?.id);
    if (!id) return null;
    const sessions = await this.sessions.destroyUser(id);
    this.presence.kick({ userId: Number(id) }, CLOSE.signedOut, 'Signed out');
    this.cache.forgetUser(id);
    return this.done(what, { user: login(user.login), sessions });
  }

  private done(event: string, details: Record<string, unknown>) {
    logger.log(`${event}: ${Object.entries(details).map(([k, v]) => `${k}=${v}`).join(' ')}`, { event, ...details });
    return { event, ...details };
  }
}
