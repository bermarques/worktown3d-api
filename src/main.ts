// Worktown3D API: a JSON API backed by GitHub, reached through the Worktown3D web app (which proxies
// /api, /auth and /stripe to it), so the browser only ever talks to one origin: PUBLIC_URL.
//
// Modules read their settings from the environment when they load, so .env is loaded before the app is imported.
import path from 'node:path';

try {
  process.loadEnvFile(path.join(import.meta.dirname, '..', '.env'));
} catch {
  /* no .env file: use the real environment */
}

await import('./bootstrap.js');
