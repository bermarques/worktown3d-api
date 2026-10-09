import { ConsoleLogger } from '@nestjs/common';

/** Framework startup chatter (modules loaded, routes mapped); the API prints its own startup summary instead. */
const QUIET = new Set(['NestFactory', 'InstanceLoader', 'RoutesResolver', 'RouterExplorer', 'NestApplication']);

/** Never written to the logs, whatever gets logged by mistake. */
const REDACT = ['authorization', 'cookie', 'token', 'secret', 'password'];

/**
 * Nest's console logger, as JSON lines (one object per entry, structured fields at the top level) or readable text.
 * Levels can be narrowed with NEST_LOG_LEVEL (e.g. `>=warn`).
 */
export class AppLogger extends ConsoleLogger {
  constructor(format: 'json' | 'text') {
    // Colors only in a terminal: escape codes would clutter log files and log platforms.
    super({ json: format === 'json', colors: format === 'text' && !!process.stdout.isTTY, flattenParams: true, redact: REDACT });
  }

  override log(message: unknown, ...rest: unknown[]) {
    const context = rest.length ? rest[rest.length - 1] : this.context;
    if (typeof context === 'string' && QUIET.has(context)) return;
    super.log(message, ...rest);
  }
}
