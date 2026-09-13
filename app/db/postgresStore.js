const { Pool } = require("pg");
const { runMigrations } = require("./migrator");

function bool(value, fallback = false) {
  if (value == null || value === "") return fallback;
  return String(value).trim().toLowerCase() === "true";
}

function createPostgresStore({
  connectionString = process.env.DATABASE_URL || "",
  required = bool(process.env.DATABASE_REQUIRED, false),
  max = Number(process.env.DATABASE_POOL_MAX || 5),
  idleTimeoutMillis = Number(process.env.DATABASE_IDLE_TIMEOUT_MS || 30_000),
  connectionTimeoutMillis = Number(process.env.DATABASE_CONNECT_TIMEOUT_MS || 10_000),
  poolFactory,
  migrate = true,
} = {}) {
  let pool = null;
  let ready = false;
  let lastError = null;
  let migrationState = { applied: [], total: 0 };

  const configured = Boolean(String(connectionString || "").trim());

  function createPool() {
    if (poolFactory) return poolFactory({ connectionString, max, idleTimeoutMillis, connectionTimeoutMillis });
    return new Pool({
      connectionString,
      max: Math.max(1, max || 5),
      idleTimeoutMillis: Math.max(1_000, idleTimeoutMillis || 30_000),
      connectionTimeoutMillis: Math.max(1_000, connectionTimeoutMillis || 10_000),
    });
  }

  async function init() {
    if (!configured) {
      const reason = "DATABASE_URL_MISSING";
      lastError = required ? reason : null;
      if (required) throw new Error(reason);
      return { status: "skipped", reason };
    }
    if (ready && pool) return { status: "ok", reason: "ALREADY_CONNECTED", migrations: migrationState };

    pool = createPool();
    if (typeof pool.on === "function") {
      pool.on("error", error => {
        ready = false;
        lastError = error?.message || String(error);
      });
    }

    try {
      await pool.query("SELECT 1 AS ok");
      if (migrate) migrationState = await runMigrations({ pool });
      ready = true;
      lastError = null;
      console.log("Postgres durable store connected", JSON.stringify({ migrationsApplied: migrationState.applied.length, migrationsTotal: migrationState.total }));
      return { status: "ok", reason: "CONNECTED", migrations: migrationState };
    } catch (error) {
      ready = false;
      lastError = error?.message || String(error);
      try { await pool.end(); } catch (_) {}
      pool = null;
      if (required) throw error;
      console.error("Postgres durable store unavailable", JSON.stringify({ error: lastError }));
      return { status: "error", reason: "DATABASE_INIT_FAILED", error: lastError };
    }
  }

  function assertReady() {
    if (!pool || !ready) throw new Error(`Postgres durable store unavailable${lastError ? `: ${lastError}` : ""}`);
  }

  async function query(text, params = []) {
    assertReady();
    return pool.query(text, params);
  }

  async function transaction(fn) {
    assertReady();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const value = await fn(client);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch (_) {}
      throw error;
    } finally {
      client.release();
    }
  }

  async function close() {
    if (pool) await pool.end();
    pool = null;
    ready = false;
  }

  function health() {
    return {
      configured,
      required: Boolean(required),
      connected: ready,
      migrationsApplied: migrationState.applied.length,
      migrationsTotal: migrationState.total,
      lastError,
    };
  }

  return {
    init,
    query,
    transaction,
    close,
    isReady: () => ready,
    isConfigured: () => configured,
    isRequired: () => Boolean(required),
    health,
  };
}

module.exports = { createPostgresStore };
