const test = require("node:test");
const assert = require("node:assert/strict");

const { createThreadsDiscoveryAdapter, parseRetryAfter } = require("../adapters/threadsDiscoveryAdapter");
const { loadProactiveConfig } = require("../config/proactive");
const { createCandidateRepository } = require("../proactive/candidateRepository");
const { createMonitorService } = require("../proactive/monitorService");

function response(status, body, headers = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: name => headers[String(name).toLowerCase()] || null },
    async json() { return body; },
  };
}

function createFakeRedis() {
  const values = new Map();
  return {
    isReady: false,
    isOpen: false,
    on() {},
    async connect() { this.isReady = true; this.isOpen = true; },
    async ping() { return "PONG"; },
    async set(key, value, options) {
      if (options?.NX && values.has(key)) return null;
      values.set(key, { value, options });
      return "OK";
    },
    async quit() { this.isReady = false; this.isOpen = false; },
    values,
  };
}

test("proactive feature and all publishing permissions are off by default", () => {
  const config = loadProactiveConfig({});
  assert.equal(config.enabled, false);
  assert.equal(config.mode, "OFF");
  assert.equal(config.languageProfiles.ru.autoPublishAllowed, false);
  assert.equal(config.languageProfiles.en.autoPublishAllowed, false);
  assert.equal(config.languageProfiles["zh-CN"].enabled, false);
});

test("global feature flag overrides a requested active mode", () => {
  assert.equal(loadProactiveConfig({ PROACTIVE_MODE: "AUTOPILOT" }).mode, "OFF");
  assert.equal(loadProactiveConfig({ PROACTIVE_ENABLED: "true", PROACTIVE_MODE: "copilot" }).mode, "COPILOT");
});

test("Threads discovery uses official keyword search and returns token-free normalized posts", async () => {
  const calls = [];
  const adapter = createThreadsDiscoveryAdapter({
    tokenManager: { getToken: () => "rotated-secret" },
    accessToken: "stale-secret",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response(200, {
        data: [{ id: 123, text: "Привет", timestamp: "2026-09-11T10:00:00Z", username: "maker", permalink: "https://www.threads.com/@maker/post/123", media_type: "TEXT" }],
        paging: { cursors: { before: "b", after: "a" }, next: "https://example.test/?access_token=rotated-secret" },
      });
    },
  });

  const result = await adapter.searchPosts({ query: "поставщики", searchType: "recent", limit: 10 });
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/v1.0/keyword_search");
  assert.equal(url.searchParams.get("q"), "поставщики");
  assert.equal(url.searchParams.get("search_type"), "RECENT");
  assert.equal(url.searchParams.get("search_mode"), "KEYWORD");
  assert.equal(url.searchParams.get("access_token"), "rotated-secret");
  assert.equal(calls[0].options.method, "GET");
  assert.equal(result.status, "ok");
  assert.deepEqual(result.paging, { before: "b", after: "a" });
  assert.equal(result.posts[0].sourcePostId, "123");
  assert.equal(result.posts[0].authorUsername, "maker");
  assert.doesNotMatch(JSON.stringify(result), /secret/);
});

test("Threads discovery reports rate limits without retrying", async () => {
  let calls = 0;
  const adapter = createThreadsDiscoveryAdapter({
    accessToken: "secret",
    fetchImpl: async () => {
      calls += 1;
      return response(429, { error: { code: 4 } }, { "retry-after": "37" });
    },
  });
  const result = await adapter.searchPosts({ query: "sourcing" });
  assert.equal(calls, 1);
  assert.deepEqual(result, { status: "rate_limited", reason: "RATE_LIMITED", posts: [], retryAfterSeconds: 37 });
});

test("Threads discovery validates inputs and fails closed on network errors", async () => {
  let calls = 0;
  const adapter = createThreadsDiscoveryAdapter({
    accessToken: "secret",
    fetchImpl: async () => { calls += 1; throw new Error("boom"); },
  });
  assert.equal((await adapter.searchPosts({ query: "" })).reason, "INVALID_QUERY");
  assert.equal((await adapter.searchPosts({ query: "x", limit: 101 })).reason, "INVALID_LIMIT");
  assert.equal((await adapter.searchPosts({ query: "x" })).reason, "NETWORK_ERROR");
  assert.equal(calls, 1);
});

test("retry-after parser accepts seconds and HTTP dates", () => {
  assert.equal(parseRetryAfter("2.1"), 3);
  assert.equal(parseRetryAfter("Thu, 11 Sep 2026 10:00:10 GMT", Date.parse("2026-09-11T10:00:00Z")), 10);
  assert.equal(parseRetryAfter("invalid"), null);
});

test("candidate repository atomically deduplicates a post across monitors", async () => {
  const redis = createFakeRedis();
  const repository = createCandidateRepository({
    redisUrl: "redis://test",
    clientFactory: () => redis,
    ttlSeconds: 120,
    clock: () => Date.parse("2026-09-11T10:00:00Z"),
  });
  assert.deepEqual(await repository.init(), { ready: true });
  const candidate = { source: "threads", sourcePostId: "abc", text: "not persisted" };
  const [first, second] = await Promise.all([
    repository.claim(candidate, { monitorId: "ru-sourcing", language: "ru" }),
    repository.claim(candidate, { monitorId: "en-sourcing", language: "en" }),
  ]);
  assert.equal([first, second].filter(item => item.claimed).length, 1);
  assert.equal(redis.values.size, 1);
  const stored = [...redis.values.values()][0];
  assert.equal(stored.options.EX, 120);
  assert.equal(stored.options.NX, true);
  assert.doesNotMatch(stored.value, /not persisted/);
  await repository.close();
});

test("candidate repository fails closed when Redis is unavailable", async () => {
  const repository = createCandidateRepository();
  assert.deepEqual(await repository.init(), { ready: false, reason: "REDIS_URL_MISSING" });
  assert.deepEqual(await repository.claim({ source: "threads", sourcePostId: "1" }), { claimed: false, reason: "STORE_UNAVAILABLE" });
});

test("disabled monitor service performs no discovery or state writes", async () => {
  let discoveryCalls = 0;
  let claimCalls = 0;
  const service = createMonitorService({
    config: loadProactiveConfig({}),
    discovery: { async searchPosts() { discoveryCalls += 1; } },
    candidates: { isReady: () => true, async claim() { claimCalls += 1; } },
  });
  assert.deepEqual(await service.runOnce({ enabled: true }), { status: "skipped", reason: "FEATURE_DISABLED" });
  assert.equal(discoveryCalls, 0);
  assert.equal(claimCalls, 0);
});

test("monitor accepts fresh posts, drops stale posts, and reports duplicates", async () => {
  const now = Date.parse("2026-09-11T12:00:00Z");
  const claimed = new Set();
  const service = createMonitorService({
    config: loadProactiveConfig({ PROACTIVE_ENABLED: "true", PROACTIVE_MODE: "COPILOT" }),
    clock: () => now,
    discovery: {
      async searchPosts() {
        return {
          status: "ok",
          posts: [
            { source: "threads", sourcePostId: "fresh", createdAt: "2026-09-11T11:30:00Z" },
            { source: "threads", sourcePostId: "duplicate", createdAt: "2026-09-11T11:00:00Z" },
            { source: "threads", sourcePostId: "old", createdAt: "2026-09-10T00:00:00Z" },
            { source: "threads", sourcePostId: "unknown-age", createdAt: null },
          ],
          paging: { before: null, after: "next" },
        };
      },
    },
    candidates: {
      isReady: () => true,
      async claim(post) {
        if (post.sourcePostId === "duplicate" || claimed.has(post.sourcePostId)) return { claimed: false, reason: "DUPLICATE" };
        claimed.add(post.sourcePostId);
        return { claimed: true };
      },
    },
  });

  const result = await service.runOnce({ id: "ru-sourcing", enabled: true, query: "поставщики", language: "ru" }, { maxPostAgeMinutes: 180 });
  assert.equal(result.status, "ok");
  assert.equal(result.discovered, 4);
  assert.equal(result.accepted, 1);
  assert.equal(result.duplicates, 1);
  assert.equal(result.stale, 1);
  assert.equal(result.invalidTimestamp, 1);
  assert.equal(result.candidates[0].expectedLanguage, "ru");
});
