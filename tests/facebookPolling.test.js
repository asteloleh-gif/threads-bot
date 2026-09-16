const test = require("node:test");
const assert = require("node:assert/strict");
const { createFacebookCommentPoller } = require("../app/polling/facebookCommentPoller");

function memoryStore() {
  let primed = false;
  const seen = new Set();
  let counts = {};
  return {
    async init() { return { status: "ok" }; },
    async isPrimed() { return primed; },
    async markPrimed() { primed = true; },
    async getSeen() { return new Set(seen); },
    async markSeen(_accountKey, ids) { for (const id of ids) seen.add(String(id)); },
    async getPostCounts() { return { ...counts }; },
    async setPostCounts(_accountKey, next) { counts = { ...counts, ...next }; },
    health() { return { connected: true }; },
    async close() {},
    state() { return { primed, seen: new Set(seen), counts: { ...counts } }; },
  };
}

function providerFixture() {
  let posts = [{ id: "p1", comments_count: 1 }];
  let comments = [{ id: "c-old", message: "old", from: { id: "u-old", name: "Old" }, parent_id: "p1", created_time: "2026-09-16T12:00:00Z" }];
  const commentDetails = new Map();
  return {
    platform: "facebook",
    accountKey: "astel.us:facebook",
    account: { enabled: true, accessToken: "token", userId: "page-1" },
    async listRecentPosts() { return { status: "ok", items: posts }; },
    async listComments() { return { status: "ok", items: comments }; },
    async getComment(commentId) { return commentDetails.get(String(commentId)) || null; },
    normalizePolledComment(comment, postId) {
      return {
        platform: "facebook",
        accountKey: "astel.us:facebook",
        type: "comment.created",
        sourceId: String(comment.id),
        rootId: postId,
        parentId: comment.parent_id && comment.parent_id !== postId ? comment.parent_id : null,
        text: comment.message || "",
        author: { id: comment.from?.id || null, username: comment.from?.name || null },
        surface: "PAGE_FEED",
        timestamp: comment.created_time || null,
        metadata: { ingress: "polling", targetPageId: "page-1" },
      };
    },
    setPosts(next) { posts = next; },
    setComments(next) { comments = next; },
    setCommentDetail(id, detail) { commentDetails.set(String(id), detail); },
  };
}

test("Facebook polling primes existing comments without dispatching them", async () => {
  const store = memoryStore();
  const provider = providerFixture();
  const handled = [];
  const poller = createFacebookCommentPoller({
    provider,
    handler: async payload => { handled.push(payload); return { status: "dry-run" }; },
    store,
    enabled: true,
    logger: { log() {}, error() {} },
  });

  const result = await poller.runOnce();
  assert.equal(result.status, "ok");
  assert.equal(result.stage, "prime");
  assert.equal(result.discovered, 1);
  assert.equal(handled.length, 0);
  assert.equal(store.state().seen.has("c-old"), true);
  assert.equal(store.state().counts.p1, 1);
});

test("Facebook polling dispatches only unseen comments after count changes", async () => {
  const store = memoryStore();
  const provider = providerFixture();
  const handled = [];
  const poller = createFacebookCommentPoller({
    provider,
    handler: async payload => { handled.push(payload.event.sourceId); return { status: "dry-run" }; },
    store,
    enabled: true,
    fullScanEvery: 10,
    logger: { log() {}, error() {} },
  });

  await poller.runOnce();
  provider.setPosts([{ id: "p1", comments_count: 2 }]);
  provider.setComments([
    { id: "c-old", parent_id: "p1", created_time: "2026-09-16T12:00:00Z" },
    { id: "c-new", parent_id: "p1", from: { id: "u1", name: "Buyer" }, created_time: "2026-09-16T12:01:00Z" },
  ]);

  const result = await poller.runOnce();
  assert.equal(result.status, "ok");
  assert.equal(result.discovered, 1);
  assert.equal(result.processed, 1);
  assert.deepEqual(handled, ["c-new"]);
  assert.equal(store.state().seen.has("c-new"), true);
  assert.equal(store.state().counts.p1, 2);
});

test("Facebook polling hydrates a missing author with direct comment lookup before dispatch", async () => {
  const store = memoryStore();
  const provider = providerFixture();
  const handled = [];
  const poller = createFacebookCommentPoller({
    provider,
    handler: async payload => {
      handled.push(payload.event.author);
      return { status: "dry-run" };
    },
    store,
    enabled: true,
    logger: { log() {}, error() {} },
  });

  await poller.runOnce();
  provider.setPosts([{ id: "p1", comments_count: 2 }]);
  provider.setComments([
    { id: "c-old", parent_id: "p1", created_time: "2026-09-16T12:00:00Z" },
    { id: "c-new", message: "hello", parent_id: "p1", created_time: "2026-09-16T12:01:00Z" },
  ]);
  provider.setCommentDetail("c-new", {
    id: "c-new",
    message: "hello",
    from: { id: "u1", name: "Buyer" },
    parent: { id: "p1" },
    created_time: "2026-09-16T12:01:00Z",
  });

  const result = await poller.runOnce();
  assert.equal(result.authorHydrationAttempts, 1);
  assert.equal(result.authorHydrated, 1);
  assert.equal(result.authorUnavailable, 0);
  assert.equal(result.processed, 1);
  assert.deepEqual(handled, [{ id: "u1", username: "Buyer" }]);
  assert.equal(store.state().seen.has("c-new"), true);
});

test("Facebook polling keeps INVALID_PAYLOAD unseen when author cannot be hydrated", async () => {
  const store = memoryStore();
  const provider = providerFixture();
  const logs = [];
  const poller = createFacebookCommentPoller({
    provider,
    handler: async payload => {
      assert.equal(payload.event.author.id, null);
      assert.equal(payload.event.author.username, null);
      return { status: "ignored", reason: "INVALID_PAYLOAD" };
    },
    store,
    enabled: true,
    logger: { log(...args) { logs.push(args.join(" ")); }, error() {} },
  });

  await poller.runOnce();
  provider.setPosts([{ id: "p1", comments_count: 2 }]);
  provider.setComments([
    { id: "c-old", parent_id: "p1", created_time: "2026-09-16T12:00:00Z" },
    { id: "c-new", message: "hello", parent_id: "p1", created_time: "2026-09-16T12:01:00Z" },
  ]);

  const result = await poller.runOnce();
  assert.equal(result.authorHydrationAttempts, 1);
  assert.equal(result.authorHydrated, 0);
  assert.equal(result.authorUnavailable, 1);
  assert.equal(result.deferred, 1);
  assert.equal(result.processed, 0);
  assert.equal(store.state().seen.has("c-new"), false);
  assert.match(logs.join("\n"), /Facebook polling author unavailable/);
  assert.doesNotMatch(logs.join("\n"), /token/);
});

test("Facebook polling periodic full scan catches comments when summary count is unchanged", async () => {
  const store = memoryStore();
  const provider = providerFixture();
  const handled = [];
  const poller = createFacebookCommentPoller({
    provider,
    handler: async payload => { handled.push(payload.event.sourceId); return { status: "dry-run" }; },
    store,
    enabled: true,
    fullScanEvery: 2,
    logger: { log() {}, error() {} },
  });

  await poller.runOnce();
  provider.setComments([
    { id: "c-old", parent_id: "p1", created_time: "2026-09-16T12:00:00Z" },
    { id: "c-new", parent_id: "p1", created_time: "2026-09-16T12:01:00Z" },
  ]);
  const result = await poller.runOnce();
  assert.equal(result.forceFullScan, true);
  assert.equal(result.discovered, 1);
  assert.deepEqual(handled, ["c-new"]);
});

test("Facebook polling does not mark transiently deferred comments as seen", async () => {
  const store = memoryStore();
  const provider = providerFixture();
  const poller = createFacebookCommentPoller({
    provider,
    handler: async () => ({ status: "ignored", reason: "DURABLE_STORE_UNAVAILABLE" }),
    store,
    enabled: true,
    logger: { log() {}, error() {} },
  });

  await poller.runOnce();
  provider.setPosts([{ id: "p1", comments_count: 2 }]);
  provider.setComments([
    { id: "c-old", parent_id: "p1", created_time: "2026-09-16T12:00:00Z" },
    { id: "c-new", parent_id: "p1", created_time: "2026-09-16T12:01:00Z" },
  ]);

  const result = await poller.runOnce();
  assert.equal(result.deferred, 1);
  assert.equal(store.state().seen.has("c-new"), false);
});

test("Facebook polling retries unresolved authorless branches and branch contention", async () => {
  for (const reason of ["AUTHORLESS_UNTRUSTED", "BRANCH_BUSY"]) {
    const store = memoryStore();
    const provider = providerFixture();
    const poller = createFacebookCommentPoller({
      provider,
      handler: async () => ({ status: "ignored", reason }),
      store,
      enabled: true,
      logger: { log() {}, error() {} },
    });
    await poller.runOnce();
    provider.setPosts([{ id: "p1", comments_count: 2 }]);
    provider.setComments([
      { id: "c-old", parent_id: "p1" },
      { id: "c-new", message: "hello", parent_id: "p1" },
    ]);
    const result = await poller.runOnce();
    assert.equal(result.deferred, 1, reason);
    assert.equal(store.state().seen.has("c-new"), false, reason);
  }
});

test("Facebook polling startup records safe Page identity diagnostics", async () => {
  const store = memoryStore();
  const provider = providerFixture();
  provider.getPageIdentity = async () => ({ status: "ok", identity: { id: "page-1", name: "Astel US" } });

  const logs = [];
  const poller = createFacebookCommentPoller({
    provider,
    handler: async () => ({ status: "dry-run" }),
    store,
    enabled: true,
    intervalMs: 60000,
    logger: {
      log(...args) { logs.push(args.join(" ")); },
      error(...args) { logs.push(args.join(" ")); },
    },
  });

  const result = await poller.init();
  assert.equal(result.status, "ok");
  assert.deepEqual(result.identityProbe, { status: "ok", idMatch: true, namePresent: true });
  assert.deepEqual(poller.health().identityProbe, result.identityProbe);
  const joined = logs.join("\n");
  assert.match(joined, /Facebook identity probe/);
  assert.doesNotMatch(joined, /token/);
  assert.doesNotMatch(joined, /page-1/);
  await poller.stop();
});
