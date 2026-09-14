const test = require("node:test");
const assert = require("node:assert/strict");
const { createThreadsPollingReader } = require("../app/polling/threadsPollingReader");
const { createThreadsCommentPoller } = require("../app/polling/threadsCommentPoller");

function response(status, data) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() { return data; },
  };
}

function memoryStore() {
  let primed = false;
  const seen = new Set();
  const posts = new Set();
  return {
    async init() { return { status: "ok" }; },
    async isPrimed() { return primed; },
    async markPrimed() { primed = true; },
    async getSeen() { return new Set(seen); },
    async markSeen(_accountKey, ids) { for (const id of ids) seen.add(String(id)); },
    async getKnownPosts() { return new Set(posts); },
    async markKnownPosts(_accountKey, ids) { for (const id of ids) posts.add(String(id)); },
    health() { return { connected: true }; },
    async close() {},
    inspect() { return { primed, seen: new Set(seen), posts: new Set(posts) }; },
  };
}

function providerWithPosts(getPosts) {
  return {
    platform: "threads",
    accountKey: "astel.us:threads",
    account: { enabled: true, accessToken: "token", userId: "owner-1" },
    tokenManager: { getToken: () => "token" },
    async listRecentPosts() { return { status: "ok", posts: getPosts() }; },
    normalizeWebhookEvent(native) {
      if (!native?.id) return null;
      return {
        platform: "threads",
        accountKey: "astel.us:threads",
        type: "comment.created",
        sourceId: String(native.id),
        rootId: native?.root_post?.id || null,
        parentId: native?.replied_to?.id || null,
        text: native.text || "",
        author: { id: null, username: native.username || null },
        surface: "THREADS",
        timestamp: native.timestamp || null,
        metadata: {},
      };
    },
  };
}

test("Threads polling reader uses official conversation endpoint and Bearer auth without token in URL", async () => {
  const calls = [];
  const reader = createThreadsPollingReader({
    fallbackAccessToken: "secret-token",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response(200, { data: [{ id: "r1", text: "hello" }] });
    },
  });

  const result = await reader.listConversation("post-1", { limit: 20 });
  assert.equal(result.status, "ok");
  assert.equal(result.items.length, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/v1\.0\/post-1\/conversation\?/);
  assert.doesNotMatch(calls[0].url, /secret-token/);
  assert.equal(calls[0].options.headers.Authorization, "Bearer secret-token");
});

test("Threads polling primes existing replies and never dispatches history", async () => {
  const store = memoryStore();
  const provider = providerWithPosts(() => [{ id: "post-1", metadata: { hasReplies: true } }]);
  const reader = { async listConversation() { return { status: "ok", items: [{ id: "old-1" }, { id: "old-2" }] }; } };
  let handled = 0;
  const poller = createThreadsCommentPoller({ provider, reader, store, enabled: true, handler: async () => { handled += 1; } });

  const result = await poller.runOnce();
  assert.equal(result.stage, "prime");
  assert.equal(result.discovered, 2);
  assert.equal(handled, 0);
  assert.equal(store.inspect().primed, true);
  assert.deepEqual([...store.inspect().seen].sort(), ["old-1", "old-2"]);
});

test("Threads polling dispatches only unseen replies after priming", async () => {
  const store = memoryStore();
  const provider = providerWithPosts(() => [{ id: "post-1", metadata: { hasReplies: true } }]);
  let items = [{ id: "old-1", username: "buyer", root_post: { id: "post-1" }, replied_to: { id: "post-1" } }];
  const reader = { async listConversation() { return { status: "ok", items }; } };
  const handled = [];
  const poller = createThreadsCommentPoller({
    provider,
    reader,
    store,
    enabled: true,
    handler: async payload => { handled.push(payload.event.sourceId); return { status: "ok" }; },
  });

  await poller.runOnce();
  items = [
    items[0],
    { id: "new-1", text: "price?", username: "buyer2", timestamp: "2026-09-14T23:00:00Z", root_post: { id: "post-1" }, replied_to: { id: "post-1" } },
  ];
  const result = await poller.runOnce();
  assert.equal(result.discovered, 1);
  assert.equal(result.processed, 1);
  assert.deepEqual(handled, ["new-1"]);
  assert.equal(store.inspect().seen.has("new-1"), true);
});

test("Threads polling does not mark transient BOT_DISABLED reply as seen", async () => {
  const store = memoryStore();
  const provider = providerWithPosts(() => [{ id: "post-1", metadata: { hasReplies: true } }]);
  let items = [];
  const reader = { async listConversation() { return { status: "ok", items }; } };
  let enabled = false;
  let calls = 0;
  const poller = createThreadsCommentPoller({
    provider,
    reader,
    store,
    enabled: true,
    handler: async () => {
      calls += 1;
      return enabled ? { status: "ok" } : { status: "ignored", reason: "BOT_DISABLED" };
    },
  });

  await poller.runOnce();
  items = [{ id: "r1", username: "buyer", root_post: { id: "post-1" }, replied_to: { id: "post-1" } }];
  const deferred = await poller.runOnce();
  assert.equal(deferred.deferred, 1);
  assert.equal(store.inspect().seen.has("r1"), false);

  enabled = true;
  const retried = await poller.runOnce();
  assert.equal(retried.processed, 1);
  assert.equal(calls, 2);
  assert.equal(store.inspect().seen.has("r1"), true);
});

test("Threads polling waits unprimed when no posts are visible", async () => {
  const store = memoryStore();
  const provider = providerWithPosts(() => []);
  const poller = createThreadsCommentPoller({
    provider,
    reader: { async listConversation() { throw new Error("should not read"); } },
    store,
    enabled: true,
    handler: async () => ({ status: "ok" }),
  });
  const result = await poller.runOnce();
  assert.equal(result.status, "waiting");
  assert.equal(result.reason, "NO_POSTS_VISIBLE");
  assert.equal(store.inspect().primed, false);
});

test("composed Meta runtime loads Threads polling without starting listeners", () => {
  const runtime = require("../server-meta-runtime");
  assert.ok(Array.isArray(runtime.threadsPollers));
  assert.equal(runtime.threadsPollers.length, 1);
  assert.equal(runtime.threadsPollers[0].health().platform, "threads");
});
