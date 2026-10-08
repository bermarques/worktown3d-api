const lower = (s) => String(s).toLowerCase();

const normalize = (s) => ({
  floors: s && Array.isArray(s.floors) ? s.floors : null,
  links: s && Array.isArray(s.links) ? s.links : [],
});

export function createSettings(pool) {
  return (owner) => ({
    async get() {
      const { rows } = await pool.query(
        "SELECT floors, links FROM org_settings WHERE org_key = $1",
        [lower(owner)],
      );
      return normalize(rows[0]);
    },
    async update(patch) {
      const next = normalize({ ...(await this.get()), ...patch });
      await pool.query(
        `INSERT INTO org_settings (org_key, floors, links, updated_at)
         VALUES ($1, $2::jsonb, $3::jsonb, now())
         ON CONFLICT (org_key) DO UPDATE SET
           floors = EXCLUDED.floors,
           links = EXCLUDED.links,
           updated_at = now()`,
        [
          lower(owner),
          next.floors === null ? null : JSON.stringify(next.floors),
          JSON.stringify(next.links),
        ],
      );
      return next;
    },
  });
}

export function memorySettings() {
  let s = normalize(null);
  return {
    get: async () => ({ ...s }),
    async update(patch) {
      s = normalize({ ...s, ...patch });
      return { ...s };
    },
  };
}
