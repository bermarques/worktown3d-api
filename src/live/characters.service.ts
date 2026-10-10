import { Injectable } from '@nestjs/common';

/**
 * How a player looks (hair, colors, accessories…). Its shape belongs to character customization (on the roadmap);
 * presence passes it along untouched. While nobody has one, clients draw the look they derive from the login.
 */
export type Character = Record<string, unknown>;

/** Largest character presence will relay (it travels inside presence messages between instances). */
export const MAX_CHARACTER_BYTES = 2048;

/**
 * Where players' characters come from when they join a building. Character customization will keep profiles in
 * PostgreSQL, keyed by GitHub user id and editable only by that person: `characterOf` reads them, and saving one
 * calls PresenceService.updateCharacter, so everyone in a building with that person sees the new look straight away.
 */
@Injectable()
export class CharactersService {
  async characterOf(_userId: number): Promise<Character | null> {
    return null;
  }
}
