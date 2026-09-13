const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { createPostgresStore } = require("../app/db/postgresStore");
const { createDurableRepository } = require("../app/db/durableRepository");
const { createDurablePublishRepository } = require("../app/publishing/durablePublishRepository");

test("Block 3 migration defines every durable core table", () => {
  const sql = fs.readFileSync(path.join(__dirname, "../db/migrations/001_core.sql"), "utf8");
  for (const table of [
    "brands", "social_accounts", "posts", "drafts", "publish_runs", "comments", "replies",
    "analytics_snapshots", "content_briefs", "agent_runs", "experiments", "approvals",
  ]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  }
});

test("Postgres store exposes fail-safe health without leaking connection string", async () => {
  const queries = [];
  const fakePool = {
    on() {},
    async query(text) { queries.push(text); return { rows: [{ ok: 1 }] }; },
    async end() {},
  };
  const store = createPostgresStore({
    connectionString: "postgresql://secret:secret@example/db",
    required: true,
    migrate: false,
    poolFactory: () => fakePool,
  });
  assert.equal(store.health().connected, false);
  await store.init();
  const health = store.health();
  assert.equal(health.connected, true);
  assert.equal(health.required, true);
  assert.equal(JSON.stringify(health).includes("secret"), false);
  assert.equal(queries.includes("SELECT 1 AS ok"), true);
  await store.close();
});

test("Postgres store skips cleanly when optional database is not configured", async () => {
  const store = createPostgresStore({ connectionString: "", required: false, migrate: false });
  const result = await store.init();
  assert.deepEqual(result, { status: "skipped", reason: "DATABASE_URL_MISSING" });
  assert.equal(store.health().connected, false);
  assert.equal(store.health().lastError, null);
});

test("durable repository syncs account identity without credentials and upserts webhook comments", async () => {
  const calls = [];
  const client = { async query(text, params) { calls.push({ text, params }); return { rows: [] }; } };
  const store = {
    isReady: () => true,
    health: () => ({ connected: true }),
    async transaction(fn) { return fn(client); },
    async query(text, params) { calls.push({ text, params }); return { rows: [] }; },
  };
  const durable = createDurableRepository({ store });
  const account = {
    key: "astel:threads",
    brand: "astel",
    platform: "threads",
    username: "leoakastel",
    userId: "123",
    language: "en",
    enabled: true,
    dryRun: false,
    accessToken: "must-never-be-written",
  };
  const synced = await durable.syncAccounts([account]);
  assert.equal(synced.synced, 1);
  await durable.recordSocialEvent({
    accountKey: account.key,
    sourceId: "c1",
    rootId: "p1",
    parentId: null,
    text: "hello",
    author: { id: "u1", username: "buyer" },
    surface: "THREADS",
    metadata: { route: "comment" },
  });
  const serialized = JSON.stringify(calls);
  assert.equal(serialized.includes("must-never-be-written"), false);
  assert.equal(calls.some(call => call.text.includes("INSERT INTO social_accounts")), true);
  assert.equal(calls.some(call => call.text.includes("INSERT INTO comments")), true);
});

test("durable publish wrapper mirrors confirmed publish and never performs external retry logic", async () => {
  const job = {
    id: "job-1",
    accountKey: "astel:threads",
    status: "PENDING",
    content: { type: "text", text: "hello" },
    scheduledAt: "2026-09-13T12:00:00.000Z",
    metadata: {},
  };
  const states = [];
  const posts = [];
  const hot = {
    async init() { return true; },
    async quit() {},
    async enqueue() { return { created: true, duplicate: false, id: job.id }; },
    async due() { return []; },
    async claim() { return true; },
    async finish() { return true; },
    async recoverExpired() { return 0; },
    async cancel() { return true; },
    async get() { return { ...job, result: { id: "post-1" } }; },
    isReady: () => true,
    health: () => ({ connected: true }),
  };
  const durable = {
    isReady: () => true,
    health: () => ({ connected: true }),
    async recordPublishEnqueued(value) { states.push(["enqueue", value.id]); },
    async recordPublishState(value) { states.push([value.status, value.jobId]); },
    async upsertPost(value) { posts.push(value); },
  };
  const repo = createDurablePublishRepository({ hotRepository: hot, durable });
  await repo.enqueue(job);
  await repo.claim(job.id, "claim", { now: new Date("2026-09-13T12:00:00Z") });
  const finished = await repo.finish(job.id, "claim", "PUBLISHED", {
    result: { id: "post-1" },
    now: new Date("2026-09-13T12:00:01Z"),
  });
  assert.equal(finished, true);
  assert.deepEqual(states.map(item => item[0]), ["enqueue", "PROCESSING", "PUBLISHED"]);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].platformPostId, "post-1");
  assert.equal(posts[0].accountKey, job.accountKey);
});
