const test = require("node:test");
const assert = require("node:assert/strict");
const { createPublishJob, PUBLISH_STATUS } = require("../app/publishing/publishState");
const { createPublishRepository } = require("../app/publishing/publishRepository");
const { createPublishEngine } = require("../app/publishing/publishEngine");
const { createThreadsPostPublisher } = require("../adapters/threadsPostPublisher");
const { createThreadsProvider } = require("../app/providers/threadsProvider");
const { createAccountConfig } = require("../app/accounts/accountConfig");

function response(status, data) {
  return { status, ok: status >= 200 && status < 300, async json() { return data; } };
}

function fakeRegistry(provider) {
  return { findForAccount: key => key === provider.accountKey ? provider : null };
}

function fakeRepository(job) {
  const finishes = [];
  return {
    finishes,
    isReady: () => true,
    health: () => ({ connected: true }),
    async init() {},
    async enqueue(value) { return { created: true, duplicate: false, id: value.id }; },
    async claim() { return true; },
    async get() { return job; },
    async finish(id, token, status, detail) { finishes.push({ id, token, status, detail }); return true; },
    async recoverExpired() { return 0; },
    async due() { return job ? [job.id] : []; },
  };
}

function publishProvider({ publishPost, enabled = true, configured = true } = {}) {
  return {
    platform: "threads",
    accountKey: "leo:threads",
    account: { key: "leo:threads", enabled },
    capabilities: { publishPosts: true },
    health: () => ({ configured }),
    publishPost: publishPost || (async () => ({ status: "published", id: "post-1" })),
  };
}

test("publish job normalizes account/content and starts PENDING", () => {
  const job = createPublishJob({
    id: "j1",
    accountKey: "LEO:THREADS",
    content: { type: "text", text: "  hello world  " },
    scheduledAt: "2026-09-13T12:00:00.000Z",
  });
  assert.equal(job.accountKey, "leo:threads");
  assert.equal(job.status, PUBLISH_STATUS.PENDING);
  assert.deepEqual(job.content, { type: "text", text: "hello world" });
  assert.equal(Object.isFrozen(job), true);
  assert.equal(Object.isFrozen(job.content), true);
  assert.throws(() => createPublishJob({ accountKey: "a", content: { type: "image", text: "x" } }), /Unsupported publish content type/);
});

test("publish repository exposes fail-closed API before Redis init", async () => {
  const repository = createPublishRepository({ redisUrl: "redis://example.invalid:6379" });
  assert.equal(repository.isReady(), false);
  assert.equal(repository.health().connected, false);
  await assert.rejects(() => repository.due(), /Publish repository unavailable/);
});

test("Threads text publisher uses official two-step flow and bearer auth", async () => {
  const calls = [];
  const publisher = createThreadsPostPublisher({
    fallbackAccessToken: "secret-token",
    sleep: async () => {},
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.includes("/me/threads?")) return response(200, { id: "container-1" });
      return response(200, { id: "thread-1" });
    },
  });
  assert.deepEqual(await publisher.publishPost({ type: "text", text: "hello" }), { status: "published", id: "thread-1" });
  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/v1\.0\/me\/threads\?/);
  assert.match(calls[1].url, /\/v1\.0\/me\/threads_publish\?/);
  assert.equal(calls[0].options.headers.Authorization, "Bearer secret-token");
  assert.equal(calls[1].options.headers.Authorization, "Bearer secret-token");
  assert.doesNotMatch(calls[0].url + calls[1].url, /secret-token/);
});

test("Threads publisher may retry container creation but never retries ambiguous publish", async () => {
  let createCalls = 0;
  let publishCalls = 0;
  const publisher = createThreadsPostPublisher({
    fallbackAccessToken: "token",
    sleep: async () => {},
    fetchImpl: async url => {
      if (url.includes("/me/threads?")) {
        createCalls += 1;
        if (createCalls === 1) return response(503, { error: { code: 2 } });
        return response(200, { id: "container-1" });
      }
      publishCalls += 1;
      return response(503, { error: { code: 2 } });
    },
  });
  assert.deepEqual(await publisher.publishPost({ type: "text", text: "hello" }), { status: "ambiguous", reason: "SERVER_OUTCOME_UNKNOWN" });
  assert.equal(createCalls, 2);
  assert.equal(publishCalls, 1);
});

test("Threads provider advertises post publishing and delegates to publisher boundary", async () => {
  const account = createAccountConfig({ brand: "leo", platform: "threads", username: "leo", userId: "1", accessToken: "token" });
  const provider = createThreadsProvider({
    account,
    adapterFactory: () => ({
      tokenManager: { getToken: () => "token" },
      parseWebhook: () => [],
      reply: async () => ({ status: "published", id: "reply" }),
      getCommentId: () => null,
    }),
    postPublisherFactory: () => ({ publishPost: async content => ({ status: "published", id: `post:${content.text}` }) }),
  });
  assert.equal(provider.capabilities.publishPosts, true);
  assert.deepEqual(await provider.publishPost({ type: "text", text: "hi" }), { status: "published", id: "post:hi" });
});

test("publish engine dry-run simulates without external mutation", async () => {
  const job = createPublishJob({ id: "j1", accountKey: "leo:threads", content: { type: "text", text: "hello" } });
  let calls = 0;
  const provider = publishProvider({ publishPost: async () => { calls += 1; return { status: "published", id: "p1" }; } });
  const repository = fakeRepository(job);
  const engine = createPublishEngine({ providerRegistry: fakeRegistry(provider), repository, enabled: true, dryRun: true });
  const result = await engine.processJob(job.id);
  assert.equal(result.status, "simulated");
  assert.equal(calls, 0);
  assert.equal(repository.finishes.at(-1).status, PUBLISH_STATUS.SIMULATED);
});

test("publish engine commits a confirmed published id exactly once", async () => {
  const job = createPublishJob({ id: "j2", accountKey: "leo:threads", content: { type: "text", text: "hello" } });
  let calls = 0;
  const provider = publishProvider({ publishPost: async () => { calls += 1; return { status: "published", id: "p2" }; } });
  const repository = fakeRepository(job);
  const engine = createPublishEngine({ providerRegistry: fakeRegistry(provider), repository, enabled: true, dryRun: false });
  assert.deepEqual(await engine.processJob(job.id), { id: "j2", status: "published", publishedId: "p2" });
  assert.equal(calls, 1);
  assert.equal(repository.finishes.length, 1);
  assert.equal(repository.finishes[0].status, PUBLISH_STATUS.PUBLISHED);
});

test("publish engine holds ambiguous provider outcomes and exceptions without retry", async () => {
  const job = createPublishJob({ id: "j3", accountKey: "leo:threads", content: { type: "text", text: "hello" } });
  const repository1 = fakeRepository(job);
  const ambiguousProvider = publishProvider({ publishPost: async () => ({ status: "ambiguous", reason: "NETWORK_OUTCOME_UNKNOWN" }) });
  const engine1 = createPublishEngine({ providerRegistry: fakeRegistry(ambiguousProvider), repository: repository1, enabled: true, dryRun: false });
  assert.equal((await engine1.processJob(job.id)).status, "ambiguous");
  assert.equal(repository1.finishes.at(-1).status, PUBLISH_STATUS.AMBIGUOUS_HOLD);

  const repository2 = fakeRepository(job);
  let calls = 0;
  const throwingProvider = publishProvider({ publishPost: async () => { calls += 1; throw new Error("timeout"); } });
  const engine2 = createPublishEngine({ providerRegistry: fakeRegistry(throwingProvider), repository: repository2, enabled: true, dryRun: false });
  assert.equal((await engine2.processJob(job.id)).status, "ambiguous");
  assert.equal(calls, 1);
  assert.equal(repository2.finishes.at(-1).status, PUBLISH_STATUS.AMBIGUOUS_HOLD);
});

test("disabled publish scheduler performs no queue work", async () => {
  let dueCalls = 0;
  const repository = fakeRepository(null);
  repository.due = async () => { dueCalls += 1; return []; };
  const provider = publishProvider();
  const engine = createPublishEngine({ providerRegistry: fakeRegistry(provider), repository, enabled: false });
  assert.deepEqual(await engine.tick(), { status: "skipped", reason: "PUBLISH_ENGINE_DISABLED", processed: 0 });
  assert.equal(dueCalls, 0);
  assert.equal(engine.health().enabled, false);
});
