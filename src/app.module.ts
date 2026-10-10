import { Module, RequestMethod, type DynamicModule, type MiddlewareConsumer, type NestModule, type Provider } from '@nestjs/common';
import { APP_FILTER, APP_PIPE } from '@nestjs/core';
import { ApiGateMiddleware } from './api/api-gate.middleware.js';
import { BuildingController } from './api/building.controller.js';
import { BuildingService } from './api/building.service.js';
import { ContextResolver } from './api/context.js';
import { DemoSandboxes } from './api/demo-sandboxes.js';
import { HostedContextResolver } from './api/hosted-context.resolver.js';
import { HostedController } from './api/hosted.controller.js';
import { AuthGateMiddleware } from './auth/auth-gate.middleware.js';
import { AuthController } from './auth/auth.controller.js';
import { AuthService } from './auth/auth.service.js';
import { BillingController } from './billing/billing.controller.js';
import { BillingRepository } from './billing/billing.repository.js';
import { BillingService } from './billing/billing.service.js';
import { StripeWebhookController } from './billing/stripe-webhook.controller.js';
import { StripeClient } from './billing/stripe.client.js';
import { ApiExceptionFilter } from './common/api-exception.filter.js';
import { jsonBody, rawBody } from './common/body-parsers.js';
import { RateLimits } from './common/rate-limits.js';
import { validationPipe } from './common/validation.js';
import { ViewCache } from './common/view-cache.js';
import { AppConfig } from './config/app-config.js';
import { LocalContextResolver } from './local/local-context.resolver.js';
import { LocalGh } from './local/local-gh.service.js';
import { LiveGateway } from './live/live.gateway.js';
import { PresenceBus } from './live/presence.bus.js';
import { PresenceService } from './live/presence.service.js';
import { LocalController } from './local/local.controller.js';
import { PrismaService } from './prisma/prisma.service.js';
import { CharacterController } from './profiles/character.controller.js';
import { CharacterStore, LocalCharacterStore, PrismaCharacterStore } from './profiles/character.store.js';
import { SecretBox } from './sessions/secret-box.js';
import { SessionStore } from './sessions/session.store.js';
import { OrgSettingsService } from './settings/settings.service.js';
import { GithubWebhookController } from './webhooks/github-webhook.controller.js';
import { GithubWebhookService } from './webhooks/github-webhook.service.js';

/** The application, wired for its mode: only what the configuration turns on is registered. */
@Module({})
export class AppModule implements NestModule {
  constructor(private readonly config: AppConfig) {}

  static forRoot(config: AppConfig): DynamicModule {
    const controllers: DynamicModule['controllers'] = [BuildingController, CharacterController];
    const providers: Provider[] = [{ provide: AppConfig, useValue: config }, ViewCache, RateLimits, BuildingService, { provide: APP_FILTER, useClass: ApiExceptionFilter }, { provide: APP_PIPE, useFactory: validationPipe }];

    if (config.hosted) {
      // Everyone signs in with GitHub; sessions, settings and subscriptions live in PostgreSQL.
      controllers.push(HostedController, AuthController, BillingController);
      providers.push(PrismaService, SecretBox, SessionStore, AuthService, OrgSettingsService, DemoSandboxes, {
        provide: ContextResolver,
        useClass: HostedContextResolver,
      });
      // Characters (one profile per GitHub user), and multiplayer: who else is in a shared building, over /api/live.
      providers.push(PrismaCharacterStore, { provide: CharacterStore, useExisting: PrismaCharacterStore });
      providers.push(PresenceBus, PresenceService, LiveGateway);
      if (config.github!.webhookSecret) {
        controllers.push(GithubWebhookController);
        providers.push(GithubWebhookService);
      }
      if (config.stripe) {
        controllers.push(StripeWebhookController);
        providers.push(StripeClient, BillingRepository, BillingService);
      }
    } else {
      // One person on this machine, through the GitHub CLI (or the demo company); settings in data/config.json.
      controllers.push(LocalController);
      providers.push(LocalGh, { provide: ContextResolver, useClass: LocalContextResolver }, { provide: CharacterStore, useClass: LocalCharacterStore });
    }

    return { module: AppModule, controllers, providers };
  }

  configure(consumer: MiddlewareConsumer) {
    const githubWebhook = { path: 'api/github/webhook', method: RequestMethod.POST };
    const api = consumer.apply(ApiGateMiddleware, jsonBody);
    // GitHub's deliveries skip the API gate (CSRF, session, rate limits): their signature authenticates them.
    if (this.config.github?.webhookSecret) {
      api.exclude(githubWebhook);
      consumer.apply(rawBody(5_000_000)).forRoutes(githubWebhook);
    }
    api.forRoutes({ path: 'api/*path', method: RequestMethod.ALL });
    if (this.config.hosted) consumer.apply(AuthGateMiddleware).forRoutes({ path: 'auth/*path', method: RequestMethod.ALL });
    if (this.config.stripe) consumer.apply(rawBody(1_000_000)).forRoutes({ path: 'stripe/webhook', method: RequestMethod.ALL });
  }
}
