const test = require("node:test");
const assert = require("node:assert/strict");
const { createFacebookAdapter } = require("../adapters/facebookAdapter");

function response(status, data) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() { return data; },
  };
}

test("Facebook polling reads Page identity and published posts with bearer auth", async () => {
  const calls = [];
  const adapter = createFacebookAdapter({
    accessToken: "secret-page-token",
    userId: "page-1",
    accountKey: "astel.us:facebook",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.includes("published_posts")) {
        return response(200, {
          data: [{ id: "page-1_post-1", created_time: "2026-09-16T12:00:00Z", comments: { summary: { total_count: 3 } } }],
        });
      }
      return response(200, { id: "page-1", name: "Astel US" });
    },
  });

  const identity = await adapter.getPageIdentity();
  assert.deepEqual(identity, { status: "ok", identity: { id: "page-1", name: "Astel US" } });

  const posts = await adapter.listRecentPosts({ limit: 10 });
  assert.equal(posts.status, "ok");
  assert.deepEqual(posts.items, [{
    id: "page-1_post-1",
    created_time: "2026-09-16T12:00:00Z",
    comments_count: 3,
  }]);
  assert.match(calls[1].url, /\/v26\.0\/page-1\/published_posts\?/);
  assert.match(decodeURIComponent(calls[1].url), /comments\.limit\(0\)\.summary\(true\)/);
  assert.doesNotMatch(calls[1].url, /secret-page-token/);
  assert.equal(calls[1].options.headers.Authorization, "Bearer secret-page-token");
});

test("Facebook polling comment read flattens replies and preserves Page post root", async () => {
  const adapter = createFacebookAdapter({
    accessToken: "token",
    userId: "page-1",
    accountKey: "astel.us:facebook",
    fetchImpl: async () => response(200, {
      data: [{
        id: "c1",
        message: "root",
        from: { id: "user-1", name: "Buyer" },
        parent: { id: "page-1_post-1" },
        created_time: "2026-09-16T12:00:00Z",
        comments: {
          data: [{
            id: "r1",
            message: "reply",
            from: { id: "user-2", name: "Buyer 2" },
            parent: { id: "c1" },
            created_time: "2026-09-16T12:01:00Z",
          }],
        },
      }],
    }),
  });

  const result = await adapter.listComments("page-1_post-1");
  assert.equal(result.status, "ok");
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].post_id, "page-1_post-1");
  assert.equal(result.items[0].parent_id, "page-1_post-1");
  assert.equal(result.items[1].parent_id, "c1");

  const rootEvent = adapter.normalizePolledComment(result.items[0], "page-1_post-1");
  assert.equal(rootEvent.sourceId, "c1");
  assert.equal(rootEvent.rootId, "page-1_post-1");
  assert.equal(rootEvent.parentId, null);
  assert.equal(rootEvent.author.id, "user-1");
  assert.equal(rootEvent.metadata.ingress, "polling");
  assert.equal(rootEvent.metadata.targetPageId, "page-1");

  const replyEvent = adapter.normalizePolledComment(result.items[1], "page-1_post-1");
  assert.equal(replyEvent.sourceId, "r1");
  assert.equal(replyEvent.rootId, "page-1_post-1");
  assert.equal(replyEvent.parentId, "c1");
});

test("Facebook polling read failures are safe and token-free", async () => {
  const adapter = createFacebookAdapter({
    accessToken: "secret-page-token",
    userId: "page-1",
    accountKey: "astel.us:facebook",
    fetchImpl: async () => response(403, { error: { code: 10, type: "OAuthException", message: "denied secret-page-token" } }),
  });

  const result = await adapter.listRecentPosts();
  assert.deepEqual(result, {
    status: "failed",
    reason: "META_REJECTED",
    code: 10,
    type: "OAuthException",
    items: [],
  });
  assert.doesNotMatch(JSON.stringify(result), /secret-page-token/);
});
