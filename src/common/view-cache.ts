import { Injectable } from '@nestjs/common';

const MAX_CACHE = 5000;

/**
 * Short-lived cache of GitHub reads. Keys are namespaced per viewer (see ApiContext.ns) so one person's private
 * data never reaches another. It lives in each instance's memory: writes invalidate it on the instance that made
 * them, and other instances catch up when their entries expire.
 */
@Injectable()
export class ViewCache {
  private readonly entries = new Map<string, { at: number; promise: Promise<unknown> }>();

  cached<T>(key: string, ttlMs: number, fn: () => Promise<T>, fresh = false): Promise<T> {
    const hit = this.entries.get(key);
    if (!fresh && hit && Date.now() - hit.at < ttlMs) return hit.promise as Promise<T>;
    if (this.entries.size > MAX_CACHE) for (const k of [...this.entries.keys()].slice(0, 1000)) this.entries.delete(k);
    const promise = fn();
    this.entries.set(key, { at: Date.now(), promise });
    promise.catch(() => this.entries.delete(key));
    return promise;
  }

  invalidate(prefix: string) {
    for (const k of this.entries.keys()) if (k.startsWith(prefix)) this.entries.delete(k);
  }

  clear() {
    this.entries.clear();
  }
}
