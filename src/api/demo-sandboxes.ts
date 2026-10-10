import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { createDemoProvider } from '../github/demo-provider.js';
import type { Provider } from '../github/types.js';
import { memorySettings, type SettingsStore } from '../settings/settings.service.js';

const MAX_SANDBOXES = 1_000;
const IDLE_MS = 2 * 3600_000;

interface Sandbox {
  provider: Provider;
  settings: SettingsStore;
  at: number;
}

/**
 * Each demo visitor's private fictional company (hosted mode), by session id. Sandboxes live in this instance's
 * memory: after a restart, or on another instance, the visitor keeps their demo session and gets a fresh sandbox.
 */
@Injectable()
export class DemoSandboxes implements OnModuleDestroy {
  private readonly sandboxes = new Map<string, Sandbox>();
  private readonly sweeper = setInterval(() => {
    const now = Date.now();
    for (const [id, s] of this.sandboxes) if (now - s.at > IDLE_MS) this.sandboxes.delete(id);
  }, 10 * 60_000).unref();

  for(sessionId: string) {
    let sandbox = this.sandboxes.get(sessionId);
    if (sandbox) this.sandboxes.delete(sessionId); // re-inserted below, so the Map stays in least-recently-used order
    else {
      if (this.sandboxes.size >= MAX_SANDBOXES) this.sandboxes.delete(this.sandboxes.keys().next().value!);
      sandbox = { provider: createDemoProvider(), settings: memorySettings(), at: 0 };
    }
    sandbox.at = Date.now();
    this.sandboxes.set(sessionId, sandbox);
    return sandbox;
  }

  onModuleDestroy() {
    clearInterval(this.sweeper);
  }
}
