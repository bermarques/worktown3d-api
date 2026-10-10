// Small JSON settings file: which owner (org) is connected in local mode, per-org building settings (which repos get
// floors, in what order, and the repo-to-repo links shown on the maps), and characters designed on this machine.
import fs from 'node:fs';
import path from 'node:path';
import { readCharacter, toCharacter, type Character } from '../profiles/character.js';
import type { BuildingSettings, SettingsStore } from '../settings/settings.service.js';

const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
const FILE = path.join(DATA_DIR, 'config.json');

interface LocalConfig {
  owner: string | null;
  demo: boolean;
  owners: Record<string, Partial<BuildingSettings>>;
  /** By lower-cased GitHub login. */
  characters: Record<string, Character>;
}

let config = load();

/** Only plain object entries, as a prototype-free map. */
function entries<T>(value: unknown, read: (v: unknown) => T | null): Record<string, T> {
  const out = Object.create(null);
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      const item = read(v);
      if (item) out[k] = item;
    }
  }
  return out;
}

function load(): LocalConfig {
  const empty: LocalConfig = { owner: null, demo: false, owners: Object.create(null), characters: Object.create(null) };
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return {
      owner: typeof raw.owner === 'string' ? raw.owner : null,
      demo: !!raw.demo,
      owners: entries(raw.owners, (v) => (v && typeof v === 'object' ? (v as Partial<BuildingSettings>) : null)),
      characters: entries(raw.characters, readCharacter),
    };
  } catch {
    return empty;
  }
}

function save() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  // write-then-rename so a crash mid-write can't leave a corrupt file
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2));
  fs.renameSync(tmp, FILE);
}

export function getConfig() {
  return config;
}

/** Local mode only: the org shown when the app opens. */
export function setConnection({ owner, demo }: { owner: string | null; demo: boolean }) {
  config.owner = owner || null;
  config.demo = !!demo;
  save();
}

const key = (owner: string) => owner.toLowerCase();

/** Per-owner settings: { floors: string[] | null, links: [{from,to,kind}] } */
export function ownerSettings(owner: string): BuildingSettings {
  const s = Object.hasOwn(config.owners, key(owner)) ? config.owners[key(owner)] : {};
  return { floors: Array.isArray(s.floors) ? s.floors : null, links: Array.isArray(s.links) ? s.links : [] };
}

export function updateOwnerSettings(owner: string, patch: Partial<BuildingSettings>) {
  const current = ownerSettings(owner);
  config.owners[key(owner)] = { ...current, ...patch };
  save();
  return ownerSettings(owner);
}

export const localSettings = (owner: string): SettingsStore => ({
  get: async () => ownerSettings(owner),
  update: async (patch) => updateOwnerSettings(owner, patch),
});

export function getCharacter(login: string): Character | null {
  return Object.hasOwn(config.characters, key(login)) ? config.characters[key(login)] : null;
}

export function setCharacter(login: string, character: Character | null) {
  if (character) config.characters[key(login)] = toCharacter(character);
  else delete config.characters[key(login)];
  save();
}

export function charactersFor(logins: string[]) {
  const out = new Map<string, Character>();
  for (const login of logins) {
    const character = getCharacter(login);
    if (character) out.set(key(login), character);
  }
  return out;
}
