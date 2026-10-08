import pg from "pg";

const MIGRATIONS = [
  `
  CREATE TABLE accounts (
    user_id text PRIMARY KEY,
    login text,
    customer_id text,
    subscription_id text,
    status text,
    renews_at bigint,
    cancel_at_period_end boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX accounts_customer_idx ON accounts (customer_id);
  CREATE TABLE workspaces (
    org_key text PRIMARY KEY,
    org text NOT NULL,
    owner_id text NOT NULL,
    owner_login text,
    created_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX workspaces_owner_idx ON workspaces (owner_id);
  CREATE TABLE stripe_events (
    id text PRIMARY KEY,
    received_at timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE org_settings (
    org_key text PRIMARY KEY,
    floors jsonb,
    links jsonb NOT NULL DEFAULT '[]',
    updated_at timestamptz NOT NULL DEFAULT now()
  );
  `,
];

export async function migrate(pool) {
  await pool.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  const { rows } = await pool.query("SELECT version FROM schema_migrations");
  const applied = new Set(rows.map((r) => Number(r.version)));
  for (let i = 0; i < MIGRATIONS.length; i++) {
    const version = i + 1;
    if (applied.has(version)) continue;
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(MIGRATIONS[i]);
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [
        version,
      ]);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  }
}

export async function connectDatabase(url) {
  const pool = new pg.Pool({
    connectionString: url,
    max: 5,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  pool.on("error", (e) => console.error("[db]", e.message));
  await migrate(pool);
  return pool;
}

export async function transaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
