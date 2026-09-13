const test = require("node:test");
const assert = require("node:assert/strict");
const { createContentRuntime } = require("../app/content/contentRuntime");
const { createRedisQuotaStore } = require("../app/ai/redisQuotaStore");

function ids(values) {
  const queue = [...values];
  return () => queue.shift() || `id-${Math.random()}`;
}

function quotaStore() {
  const calls = [];
  let ready = false;
  return {
    calls,
    async init() { ready = true; return { ready: true }; },
    isReady: () => ready,
    async takeQuota(kind, requested, limit, options) {
      calls.push({ kind, requested, limit, options });
      return { granted: requested, remaining: Math.max(0, limit - requested) };
    },
    async close() { ready = false; },
    health: () => ({ connected: ready }),
  };
}

function postgres({ ready = true } = {}) {
  const calls = [];
  return {
    calls,
    isReady: () => ready,
    health: () => ({ connected: ready, required: true }),
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [] };
    },
  };
}

function durable() {
  const runs = [];
  return {
    runs,
    async recordAgentRun(run) { runs.push(run); return { runId: run.runId }; },
  };
}

function registry({ known = true } = {}) {
  return {
    findForAccount(accountKey) {
      return known ? { accountKey, platform: "threads", capabilities: { publishPosts: true } } : null;
    },
  };
}

function publisher({ enabled = false, dryRun = true } = {}) {
  return {
    async enqueue() { throw new Error("enqueue should not be reached in gate tests"); },
    health: () => ({ enabled, dryRun, repository: { connected: true } }),
  };
}

function aiClient(value = { objective: "x", audience: "builders", angle: "useful", keyPoints: ["one"], evidenceNotes: [], language: "en" }) {
  let calls = 0;
  return {
    get calls() { return calls; },
    health: () => ({ configured: true, endpointHost: "api.openai.com" }),
    async completeJson() {
      calls += 1;
      return { status: "ok", value, usage: { prompt_tokens: 20, completion_tokens: 10 }, responseId: "resp-1" };
    },
  };
}

function enabledEnv(extra = {}) {
  return {
    OPENAI_API_KEY: "not-used-by-injected-client",
    OPENAI_MODEL: "test-model",
    OPENAI_INPUT_USD_PER_1M: "1",
    OPENAI_OUTPUT_USD_PER_1M: "2",
    ...extra,
  };
}

test("disabled content runtime performs no Redis initialization and exposes a closed health gate", async () => {
  const quotas = quotaStore();
  const runtime = createContentRuntime({
    enabled: false,
    postgresStore: postgres(),
    durable: durable(),
    publishEngine: publisher(),
    providerRegistry: registry(),
    quotaStore: quotas,
    aiClient: aiClient(),
    env: enabledEnv(),
  });
  const result = await runtime.init();
  assert.deepEqual(result, { status: "skipped", reason: "CONTENT_PIPELINE_DISABLED" });
  assert.equal(runtime.health().enabled, false);
  assert.equal(runtime.health().ready, false);
  assert.equal(quotas.calls.length, 0);
});

test("enabled content runtime fails startup when durable Postgres is unavailable", async () => {
  const runtime = createContentRuntime({
    enabled: true,
    postgresStore: postgres({ ready: false }),
    durable: durable(),
    publishEngine: publisher(),
    providerRegistry: registry(),
    quotaStore: quotaStore(),
    aiClient: aiClient(),
    env: enabledEnv(),
  });
  await assert.rejects(() => runtime.init(), /DATABASE_UNAVAILABLE/);
  assert.equal(runtime.health().ready, false);
});

test("enabled content runtime requires explicit AI pricing before becoming ready", async () => {
  const runtime = createContentRuntime({
    enabled: true,
    postgresStore: postgres(),
    durable: durable(),
    publishEngine: publisher(),
    providerRegistry: registry(),
    quotaStore: quotaStore(),
    aiClient: aiClient(),
    env: { OPENAI_API_KEY: "x", OPENAI_MODEL: "test-model" },
  });
  await assert.rejects(() => runtime.init(), /AI_PRICING_NOT_CONFIGURED/);
  assert.equal(runtime.health().ready, false);
});

test("ready content runtime generates and durably stores an AI brief for a known account", async () => {
  const store = postgres();
  const runs = durable();
  const client = aiClient();
  const quotas = quotaStore();
  const runtime = createContentRuntime({
    enabled: true,
    postgresStore: store,
    durable: runs,
    publishEngine: publisher(),
    providerRegistry: registry(),
    quotaStore: quotas,
    aiClient: client,
    env: enabledEnv(),
    uuid: ids(["workflow-1", "run-1", "brief-1"]),
  });
  assert.deepEqual(await runtime.init(), { status: "ok", reason: "READY" });
  const result = await runtime.generateBrief({
    accountKey: "leo:threads",
    objective: "teach one useful idea",
    research: [{ fact: "supported" }],
    language: "en",
  });
  assert.equal(result.status, "ok");
  assert.equal(result.workflowId, "workflow-1");
  assert.equal(result.aiRunId, "run-1");
  assert.equal(result.briefId, "brief-1");
  assert.equal(client.calls, 1);
  assert.equal(runs.runs.length, 1);
  assert.ok(store.calls.some(call => call.sql.includes("INSERT INTO content_briefs")));
  assert.equal(quotas.calls.length, 2);
});

test("content generation refuses unknown account identity before model execution", async () => {
  const client = aiClient();
  const runtime = createContentRuntime({
    enabled: true,
    postgresStore: postgres(),
    durable: durable(),
    publishEngine: publisher(),
    providerRegistry: registry({ known: false }),
    quotaStore: quotaStore(),
    aiClient: client,
    env: enabledEnv(),
  });
  await runtime.init();
  await assert.rejects(() => runtime.generateBrief({ accountKey: "wrong:threads", objective: "x" }), /Unknown social account/);
  assert.equal(client.calls, 0);
});

test("content scheduling cannot create latent jobs while Publish Engine is disabled", async () => {
  const runtime = createContentRuntime({
    enabled: true,
    postgresStore: postgres(),
    durable: durable(),
    publishEngine: publisher({ enabled: false, dryRun: true }),
    providerRegistry: registry(),
    quotaStore: quotaStore(),
    aiClient: aiClient(),
    env: enabledEnv(),
  });
  await runtime.init();
  await assert.rejects(() => runtime.scheduleApprovedDraft({ draftId: "draft-1" }), /Publish Engine must be enabled/);
});

test("live content scheduling remains separately blocked even when Publish Engine is enabled", async () => {
  const runtime = createContentRuntime({
    enabled: true,
    allowLiveScheduling: false,
    postgresStore: postgres(),
    durable: durable(),
    publishEngine: publisher({ enabled: true, dryRun: false }),
    providerRegistry: registry(),
    quotaStore: quotaStore(),
    aiClient: aiClient(),
    env: enabledEnv(),
  });
  await runtime.init();
  await assert.rejects(() => runtime.scheduleApprovedDraft({ draftId: "draft-1" }), /Live content scheduling is not approved/);
});

test("dedicated AI quota store fails closed before Redis initialization", async () => {
  const store = createRedisQuotaStore({ redisUrl: null });
  assert.deepEqual(await store.init(), { ready: false, reason: "REDIS_URL_MISSING" });
  assert.equal((await store.takeQuota("x", 1, 10)).reason, "STORE_UNAVAILABLE");
  assert.equal(store.health().connected, false);
});
