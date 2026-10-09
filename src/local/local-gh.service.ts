import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ViewCache } from '../common/view-cache.js';
import { AppConfig } from '../config/app-config.js';
import { detectGh, type GhStatus } from '../github/gh.js';
import { cliClient } from '../github/github-client.js';
import { createGithubProvider } from '../github/github-provider.js';
import { createDemoProvider } from '../github/demo-provider.js';
import type { Provider } from '../github/types.js';
import { getConfig } from './local-config.js';

/** Local mode: the GitHub CLI state, and whether the building shows the real organization or the demo company. */
@Injectable()
export class LocalGh implements OnModuleInit {
  gh: GhStatus = { installed: false, authed: false };
  private readonly demo = createDemoProvider();
  provider: Provider = this.demo;

  constructor(
    private readonly config: AppConfig,
    private readonly cache: ViewCache,
  ) {}

  async onModuleInit() {
    if (!this.config.forceDemo) this.gh = await detectGh();
    this.selectProvider();
  }

  /** Re-detect the GitHub CLI after installing it or signing in. */
  async recheck() {
    this.gh = await detectGh();
    this.selectProvider();
  }

  /** A provider acting through `gh`, when it's signed in and the demo wasn't forced. */
  ghProvider() {
    return this.gh.authed && !this.config.forceDemo ? createGithubProvider({ client: cliClient, viewer: this.gh.user! }) : null;
  }

  selectProvider() {
    this.provider = (!getConfig().demo && this.ghProvider()) || this.demo;
    this.cache.clear();
  }

  owner() {
    return this.provider.mode === 'demo' ? 'demo-co' : getConfig().owner;
  }

  status() {
    const cfg = getConfig();
    const gh = this.gh;
    return {
      hosted: false,
      mode: this.provider.mode,
      forcedDemo: this.config.forceDemo,
      chosenDemo: !!cfg.demo,
      gh: { installed: gh.installed, authed: gh.authed, version: gh.version || null, user: gh.user || null, error: gh.error || null },
      viewer: this.provider.viewer,
      owner: this.owner(),
    };
  }
}
