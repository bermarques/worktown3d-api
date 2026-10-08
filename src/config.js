// Small JSON settings file: which owner (org) is connected in local mode, plus per-org building settings
// (which repos get floors, in what order, and the repo-to-repo links shown on the maps).
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');
const FILE = path.join(DATA_DIR, 'config.json');

let config = load();

function load() {
  const empty = { owner: null, demo: false, owners: Object.create(null) };
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const owners = Object.create(null);
    if (raw.owners && typeof raw.owners === 'object') {
      for (const [k, v] of Object.entries(raw.owners)) if (v && typeof v === 'object') owners[k] = v;
    }
    return { owner: typeof raw.owner === 'string' ? raw.owner : null, demo: !!raw.demo, owners };
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
export function setConnection({ owner, demo }) {
  config.owner = owner || null;
  config.demo = !!demo;
  save();
}

const key = (owner) => owner.toLowerCase();

/** Per-owner settings: { floors: string[] | null, links: [{from,to,kind}] } */
export function ownerSettings(owner) {
  const s = Object.hasOwn(config.owners, key(owner)) ? config.owners[key(owner)] : {};
  return { floors: Array.isArray(s.floors) ? s.floors : null, links: Array.isArray(s.links) ? s.links : [] };
}

export function updateOwnerSettings(owner, patch) {
  const current = ownerSettings(owner);
  config.owners[key(owner)] = { ...current, ...patch };
  save();
  return ownerSettings(owner);
}

export const localSettings = (owner) => ({
  get: async () => ownerSettings(owner),
  update: async (patch) => updateOwnerSettings(owner, patch),
});
