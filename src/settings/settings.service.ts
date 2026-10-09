// Building settings: which repos get floors (in what order) and the repo-to-repo links shown on the maps.
// Stored in PostgreSQL in hosted mode, in data/config.json in local mode, and in memory for demo visitors.
import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

export interface RepoLink {
  from: string;
  to: string;
  kind: string;
}

export interface BuildingSettings {
  /** Repos with a floor, bottom to top; null until someone arranges them (then the most recent repos get floors). */
  floors: string[] | null;
  links: RepoLink[];
}

export interface SettingsStore {
  get(): Promise<BuildingSettings>;
  update(patch: Partial<BuildingSettings>): Promise<BuildingSettings>;
}

const lower = (s: string) => String(s).toLowerCase();

export const normalize = (s: { floors?: unknown; links?: unknown } | null | undefined): BuildingSettings => ({
  floors: s && Array.isArray(s.floors) ? s.floors : null,
  links: s && Array.isArray(s.links) ? s.links : [],
});

/** Per-organization settings in PostgreSQL (hosted mode). */
@Injectable()
export class OrgSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  for(owner: string): SettingsStore {
    const orgKey = lower(owner);
    const prisma = this.prisma;
    return {
      async get() {
        return normalize(await prisma.orgSettings.findUnique({ where: { orgKey }, select: { floors: true, links: true } }));
      },
      async update(patch) {
        const next = normalize({ ...(await this.get()), ...patch });
        const data = { floors: next.floors === null ? Prisma.DbNull : next.floors, links: next.links as unknown as Prisma.InputJsonArray };
        await prisma.orgSettings.upsert({ where: { orgKey }, create: { orgKey, ...data }, update: data });
        return next;
      },
    };
  }
}

/** A demo visitor's settings, which live as long as their sandbox. */
export function memorySettings(): SettingsStore {
  let s = normalize(null);
  return {
    get: async () => ({ ...s }),
    async update(patch) {
      s = normalize({ ...s, ...patch });
      return { ...s };
    },
  };
}
