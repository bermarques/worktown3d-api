import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import type { Provider, Viewer } from '../github/types.js';
import type { Session } from '../sessions/session.store.js';
import type { SettingsStore } from '../settings/settings.service.js';

/**
 * Everything an API request needs: who is asking (provider acting as them), which building, and where its
 * settings live. Cache keys are namespaced per viewer (`ns`) so one person's private data never reaches another.
 */
export interface ApiContext {
  session: Session | null;
  /** null: signed out (hosted mode). */
  provider: Provider | null;
  ns: string;
  owner: string | null;
  viewer: Viewer | null;
  settings: SettingsStore | null;
}

export interface ApiRequest extends Request {
  ctx?: ApiContext;
}

/** Builds the context of an API request; one implementation per mode. */
export abstract class ContextResolver {
  abstract resolve(req: Request): Promise<ApiContext>;
}

export const signedOutContext = (): ApiContext => ({ session: null, provider: null, ns: '', owner: null, viewer: null, settings: null });

/** The request's ApiContext, resolved by ApiGateMiddleware. */
export const Ctx = createParamDecorator((_: unknown, ec: ExecutionContext) => ec.switchToHttp().getRequest<ApiRequest>().ctx!);
