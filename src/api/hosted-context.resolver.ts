import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { AuthService } from '../auth/auth.service.js';
import { createTokenClient } from '../github/github-client.js';
import { createGithubProvider } from '../github/github-provider.js';
import { SessionStore } from '../sessions/session.store.js';
import { OrgSettingsService } from '../settings/settings.service.js';
import { ContextResolver, signedOutContext, type ApiContext } from './context.js';
import { DemoSandboxes } from './demo-sandboxes.js';

/** Hosted mode: the person behind the session cookie, acting on GitHub with their own token. */
@Injectable()
export class HostedContextResolver extends ContextResolver {
  constructor(
    private readonly sessions: SessionStore,
    private readonly auth: AuthService,
    private readonly settings: OrgSettingsService,
    private readonly demos: DemoSandboxes,
  ) {
    super();
  }

  async resolve(req: Request): Promise<ApiContext> {
    const s = await this.sessions.get(req);
    if (!s) return signedOutContext();
    if (s.kind === 'demo') {
      const sandbox = this.demos.for(s.id);
      return { session: s, provider: sandbox.provider, ns: `d:${s.id}`, owner: 'demo-co', viewer: sandbox.provider.viewer, settings: sandbox.settings };
    }
    const provider = createGithubProvider({ client: createTokenClient(() => this.auth.validToken(s)), viewer: s.user });
    return { session: s, provider, ns: `u:${s.user.id}`, owner: s.org, viewer: s.user, settings: s.org ? this.settings.for(s.org) : null };
  }
}
