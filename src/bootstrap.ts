import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { printBanner } from './banner.js';
import { AppLogger } from './common/app-logger.js';
import { edgeMiddleware } from './common/edge.middleware.js';
import { requestLog } from './common/request-log.middleware.js';
import { AppConfig, ConfigError } from './config/app-config.js';

/** Stop with a readable message for configuration problems; anything else is a bug and keeps its stack trace. */
function exitOn(e: unknown): never {
  if (e instanceof ConfigError) {
    console.error(`\n  ${e.message}\n`);
    process.exit(1);
  }
  throw e;
}

let config: AppConfig;
try {
  config = new AppConfig();
} catch (e) {
  exitOn(e);
}

const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), { bodyParser: false, logger: new AppLogger(config.logFormat) });
app.disable('x-powered-by');
app.set('etag', false);
if (config.hosted) app.use(requestLog(config));
app.use(edgeMiddleware(config));
app.enableShutdownHooks(['SIGTERM', 'SIGINT']);
process.once('SIGTERM', () => setTimeout(() => process.exit(0), 5000).unref());

// slow-client protection
const server = app.getHttpServer();
server.headersTimeout = 20_000;
server.requestTimeout = 30_000;

try {
  await (config.host ? app.listen(config.port, config.host) : app.listen(config.port));
} catch (e) {
  exitOn(e);
}
printBanner(app, config);
