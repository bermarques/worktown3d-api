import { Injectable } from '@nestjs/common';
import { ContextResolver, type ApiContext } from '../api/context.js';
import { localSettings } from './local-config.js';
import { LocalGh } from './local-gh.service.js';

/** Local mode: whoever is signed in to the GitHub CLI on this machine (or the demo company). */
@Injectable()
export class LocalContextResolver extends ContextResolver {
  constructor(private readonly local: LocalGh) {
    super();
  }

  async resolve(): Promise<ApiContext> {
    const provider = this.local.provider;
    const owner = this.local.owner();
    return { session: null, provider, ns: provider.mode, owner, viewer: provider.viewer, settings: owner ? localSettings(owner) : null };
  }
}
