import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client.js';
import { charactersFor, getCharacter, setCharacter } from '../local/local-config.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { readCharacter, toCharacter, type Character } from './character.js';

/** Whose character: their GitHub user id (hosted mode; null in local mode, where the login is enough) and login. */
export interface Owner {
  id: number | null;
  login: string;
}

/** Where characters are kept: PostgreSQL in hosted mode, data/config.json in local mode. */
export abstract class CharacterStore {
  /** Their character, or null for the look drawn from their login. */
  abstract get(owner: Owner): Promise<Character | null>;
  /** Save it; null goes back to the look drawn from the login. */
  abstract save(owner: Owner, character: Character | null): Promise<void>;
  /** The characters of these people, by lower-cased login (only those who have one). */
  abstract forLogins(logins: string[]): Promise<Map<string, Character>>;
}

const asJson = (character: Character) => ({ ...toCharacter(character) }) as Prisma.InputJsonObject;

/** Hosted mode: one profile per GitHub user id. */
@Injectable()
export class PrismaCharacterStore extends CharacterStore {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async get({ id }: Owner) {
    const row = await this.prisma.profile.findUnique({ where: { userId: String(id) }, select: { character: true } });
    return row ? readCharacter(row.character) : null;
  }

  async save(owner: Owner, character: Character | null) {
    const userId = String(owner.id);
    if (!character) {
      await this.prisma.profile.deleteMany({ where: { userId } });
      return;
    }
    const loginKey = owner.login.toLowerCase();
    await this.prisma.$transaction([
      this.releaseLogin(loginKey, userId),
      this.prisma.profile.upsert({ where: { userId }, create: { userId, loginKey, character: asJson(character) }, update: { loginKey, character: asJson(character) } }),
    ]);
  }

  /** On sign-in: GitHub logins can be renamed, so keep the one on their profile current. */
  async syncLogin(owner: Owner) {
    const userId = String(owner.id);
    const loginKey = owner.login.toLowerCase();
    const row = await this.prisma.profile.findUnique({ where: { userId }, select: { loginKey: true } });
    if (!row || row.loginKey === loginKey) return;
    await this.prisma.$transaction([this.releaseLogin(loginKey, userId), this.prisma.profile.update({ where: { userId }, data: { loginKey } })]);
  }

  async forLogins(logins: string[]) {
    const out = new Map<string, Character>();
    const keys = [...new Set(logins.map((l) => l.toLowerCase()))];
    if (!keys.length) return out;
    const rows = await this.prisma.profile.findMany({ where: { loginKey: { in: keys } }, select: { loginKey: true, character: true } });
    for (const row of rows) {
      const character = readCharacter(row.character);
      if (character && row.loginKey) out.set(row.loginKey, character);
    }
    return out;
  }

  /** A login belongs to one account at a time: whoever renamed away from it doesn't keep it. */
  private releaseLogin(loginKey: string, userId: string) {
    return this.prisma.profile.updateMany({ where: { loginKey, NOT: { userId } }, data: { loginKey: null } });
  }
}

/** Local mode: in data/config.json, by login. */
@Injectable()
export class LocalCharacterStore extends CharacterStore {
  async get({ login }: Owner) {
    return getCharacter(login);
  }

  async save({ login }: Owner, character: Character | null) {
    setCharacter(login, character);
  }

  async forLogins(logins: string[]) {
    return charactersFor(logins);
  }
}
