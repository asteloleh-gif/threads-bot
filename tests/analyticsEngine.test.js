const test = require("node:test");
const assert = require("node:assert/strict");

const { createThreadsInsightsAdapter, normalizeInsightData } = require("../adapters/threadsInsightsAdapter");
const { normalizeMetrics, computeMetricDeltas } = require("../app/analytics/metrics");
const { createAnalyticsEngine } = require("../app/analytics/analyticsEngine");

test("Threads insights normalizer supports total_value and lifetime values", () => {
  const result = normalizeInsightData([
    { name: "views", period: "lifetime", values: [{ value: 12 }] },
    { name: "followers_count", period: "day", total_value: { value: 99 } },
    { name: "invalid", values: [{ value: "nope" }] },
  ]);
  assert.deepEqual(result.metrics, { views: 12, followers_count: 99 });
  assert.deepEqual(result.periods, { views: "lifetime", followers_count: "day" });
});

test("Threads insights adapter reads post/account metrics and recent posts without leaking token into URL", async () => {
  const calls = [];
  const token = "secret-token";
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes("/me/threads_insights")) {
      return { ok: true, status: 200, async json() { return { data: [{ name: "followers_count", period: "day", total_value: { value: 41 } }] }; } };
    }
    if (String(url).includes("/me/threads?")) {
      return { ok: true, status: 200, async json() { return { data: [{ id: "p1", media_type: "TEXT_POST", text: "hello", permalink: "https://example.test/p1", timestamp: "2026-09-13T10:00:00+0000" }] }; } };
    }
    return { ok: true, status: 200, async json() { return { data: [{ name: "views", period: "lifetime", values: [{ value: 100 }] }, { name: "likes", period: "lifetime", values: [{ value: 7 }] }] }; } };
  };
  const adapter = createThreadsInsightsAdapter({ fallbackAccessToken: token, fetchImpl });
  const account = await adapter.getAccountInsights();
  const posts = await adapter.listRecentPosts({ limit: 5 });
  const post = await adapter.getPostInsights("p1");

  assert.equal(account.metrics.followers_count, 41);
  assert.equal(posts.posts[0].id, "p1");
  assert.equal(post.metrics.views, 100);
  assert.equal(post.metrics.likes, 7);
  assert.equal(calls.every(call => !call.url.includes(token)), true);
  assert.equal(calls.every(call => call.options.headers.Authorization === `Bearer ${token}`), true);
});

test("normalized metrics derive interactions and stable deltas", () => {
  const current = normalizeMetrics({ views: 200, likes: 10, replies: 4, junk: "x" });
  assert.equal(current.interactions, 14);
  assert.equal(current.engagement_rate, 0.07);
  const comparison = computeMetricDeltas(current, { views: 150, likes: 8, replies: 2, interactions: 10, engagement_rate: 0.066 });
  assert.equal(comparison.deltas.views, 50);
  assert.equal(comparison.deltas.interactions, 4);
  assert.equal(Math.round(comparison.rates.views * 1000) / 1000, 0.333);
});

test("analytics engine snapshots account and recent posts while isolating per-post failures", async () => {
  const snapshots = [];
  const discovered = [];
  const provider = {
    platform: "threads",
    accountKey: "astel:threads",
    account: { enabled: true, userId: "u1" },
    capabilities: { insights: true },
    async getAccountInsights() { return { status: "ok", metrics: { followers_count: 100 }, periods: { followers_count: "day" } }; },
    async listRecentPosts() { return { status: "ok", posts: [{ id: "p1", text: "one" }, { id: "p2", text: "two" }] }; },
    async getPostInsights(id) {
      if (id === "p2") return { status: "failed", reason: "META_REJECTED", code: 10 };
      return { status: "ok", metrics: { views: 50, likes: 5 }, periods: { views: "lifetime" } };
    },
  };
  const repository = {
    isReady: () => true,
    health: () => ({ connected: true }),
    async recordSnapshot(value) { snapshots.push(value); return { metrics: value.metrics, deltas: {}, rates: {} }; },
    async upsertDiscoveredPost(value) { discovered.push(value); return { stored: true }; },
  };
  const engine = createAnalyticsEngine({
    providerRegistry: { list: () => [provider] },
    repository,
    enabled: true,
    maxPostsPerAccount: 10,
    lookbackDays: 30,
  });
  const result = await engine.runOnce();
  assert.equal(result.status, "ok");
  assert.equal(result.accountSnapshots, 1);
  assert.equal(result.postsDiscovered, 2);
  assert.equal(result.postSnapshots, 1);
  assert.equal(result.failures, 1);
  assert.equal(discovered.length, 2);
  assert.deepEqual(snapshots.map(item => item.entityType), ["account", "post"]);
});

test("analytics engine is read-only disabled by default gate", async () => {
  let called = false;
  const engine = createAnalyticsEngine({
    providerRegistry: { list: () => [{ capabilities: { insights: true }, account: { enabled: true }, getAccountInsights: async () => { called = true; } }] },
    repository: { isReady: () => true, health: () => ({ connected: true }) },
    enabled: false,
  });
  assert.deepEqual(await engine.runOnce(), { status: "skipped", reason: "ANALYTICS_DISABLED" });
  assert.equal(called, false);
});
