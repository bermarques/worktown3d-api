import { ConsoleLogger } from '@nestjs/common';

/** Framework startup chatter (modules loaded, routes mapped); the API prints its own startup banner instead. */
const QUIET = new Set(['NestFactory', 'InstanceLoader', 'RoutesResolver', 'RouterExplorer', 'NestApplication']);

export class AppLogger extends ConsoleLogger {
  override log(message: unknown, ...rest: unknown[]) {
    const context = rest.length ? rest[rest.length - 1] : this.context;
    if (typeof context === 'string' && QUIET.has(context)) return;
    super.log(message, ...rest);
  }
}
