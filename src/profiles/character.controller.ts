import { Body, Controller, Delete, Get, Optional, Put } from '@nestjs/common';
import { BuildingService } from '../api/building.service.js';
import { Ctx, type ApiContext } from '../api/context.js';
import { HttpError } from '../common/http-error.js';
import { AppConfig } from '../config/app-config.js';
import { PresenceService } from '../live/presence.service.js';
import { CharacterDto, toCharacter, type Character } from './character.js';
import { CharacterStore, type Owner } from './character.store.js';

/**
 * Your character (the phone's "Me" app): how you look on floors, at your desk and when you walk around live. It's
 * yours alone, kept between sessions, and shown to everyone who sees you in a building.
 */
@Controller('api/me')
export class CharacterController {
  constructor(
    private readonly config: AppConfig,
    private readonly building: BuildingService,
    private readonly store: CharacterStore,
    @Optional() private readonly presence?: PresenceService,
  ) {}

  /** `{ character }`; null means the look drawn from your login. */
  @Get('character')
  async get(@Ctx() ctx: ApiContext) {
    return { character: await this.store.get(this.owner(ctx)) };
  }

  @Put('character')
  async save(@Ctx() ctx: ApiContext, @Body() body: CharacterDto) {
    return { character: await this.apply(this.owner(ctx), toCharacter(body)) };
  }

  /** Back to the look drawn from your login. */
  @Delete('character')
  async reset(@Ctx() ctx: ApiContext) {
    return { character: await this.apply(this.owner(ctx), null) };
  }

  private async apply(owner: Owner, character: Character | null) {
    await this.store.save(owner, character);
    // People in a building with you see the new look right away; desk characters pick it up with the floor data.
    if (owner.id !== null) this.presence?.updateCharacter(owner.id, character);
    return character;
  }

  /** Whose character: someone signed in with GitHub (hosted mode), or the GitHub CLI's account (local mode). */
  private owner(ctx: ApiContext): Owner {
    this.building.requireSession(ctx);
    if (this.config.hosted) {
      const s = ctx.session;
      if (!s || s.kind !== 'user') throw new HttpError(403, 'Sign in with GitHub to design your character');
      return { id: s.user.id, login: s.user.login };
    }
    if (ctx.provider.mode !== 'github' || !ctx.viewer) throw new HttpError(403, 'Connect the GitHub CLI to design your character');
    return { id: null, login: ctx.viewer.login };
  }
}
