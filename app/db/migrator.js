const fs = require("fs/promises");
const path = require("path");

const MIGRATION_LOCK_ID = 88421031;

async function listMigrationFiles(migrationsDir) {
  const names = await fs.readdir(migrationsDir);
  return names.filter(name => /^\d+.*\.sql$/i.test(name)).sort();
}

async function runMigrations({ pool, migrationsDir = path.join(__dirname, "../../db/migrations") } = {}) {
  if (!pool || typeof pool.connect !== "function") throw new Error("Migration pool is required");
  const client = await pool.connect();
  const applied = [];
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    const existing = await client.query("SELECT version FROM schema_migrations");
    const done = new Set((existing.rows || []).map(row => String(row.version)));
    const files = await listMigrationFiles(migrationsDir);

    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await fs.readFile(path.join(migrationsDir, file), "utf8");
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations(version) VALUES ($1)", [file]);
        await client.query("COMMIT");
        applied.push(file);
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch (_) {}
        throw error;
      }
    }

    return { applied, total: files.length };
  } finally {
    try { await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_ID]); } catch (_) {}
    client.release();
  }
}

module.exports = { MIGRATION_LOCK_ID, listMigrationFiles, runMigrations };
