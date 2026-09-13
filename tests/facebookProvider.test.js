const test = require("node:test");
const assert = require("node:assert/strict");
const { createAccountConfig } = require("../app/accounts/accountConfig");
const { createFacebookAdapter } = require("../adapters/facebookAdapter");
const { createFacebookProvider } = require("../app/providers/facebookProvider");

function response(status, data) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() { return data; },
  };
}

function facebookAccount() {
  return createAccountConfig({
    key: "astel-u:facebook",
    brand: "astel-u",
    platform: "facebook",
    username: "astel.u",
    userId: "page-1",
    accessToken: "secret-page-token",
    language: "ru",
  });
}

test("Facebook feed parser normalizes a top-level Page comment", () => {
  const adapter = createFacebookAdapter({ accessToken: "token", userId: "page-1", accountKey: "astel-u:facebook" });
  const [event] = adapter.parseWebhook({
    object: "page",
    entry: [{ id: "page-1", changes: [{ field: "feed", value: {
      item: "comment",
      verb: "add",
      comment_id: "comment-1",
      post_id: "page-1_post-1",
      parent_id: "page-1_post-1",
      sender_id: "user-1",
      sender_name: "Buyer Name",
      message: "Price?",
      created_time: 1789276000,
    } }] }],
  });
  assert.deepEqual(event, {
    platform: "facebook",
    accountKey: "astel-u:facebook",
    type: "comment.created",
    sourceId: "comment-1",
    rootId: "page-1_post-1",
    parentId: null,
    text: "Price?",
    author: { id: "user-1", username: null },
    surface: "PAGE_FEED",
    timestamp: "1789276000",
    metadata: {
      webhookField: "feed",
      item: "comment",
      verb: "add",
      targetPageId: "page-1",
      senderName: "Buyer Name",
      rawParentId: "page-1_post-1",
    },
  });
});

test("Facebook feed parser preserves a nested parent comment", () => {
  const adapter = createFacebookAdapter({ accessToken: "token", userId: "page-1", accountKey: "a:facebook" });
  const [event] = adapter.parseWebhook({
    object: "page",
    entry: [{ id: "page-1", changes: [{ field: "feed", value: {
      item: "comment", verb: "add", comment_id: "reply-1", post_id: "post-1", parent_id: "comment-1",
      from: { id: "user-2", name: "Viewer" }, message: "nested",
    } }] }],
  });
  assert.equal(event.parentId, "comment-1");
  assert.equal(event.author.id, "user-2");
  assert.equal(event.metadata.senderName, "Viewer");
});

test("Facebook feed parser ignores wrong Page, unrelated items and non-add verbs", () => {
  const adapter = createFacebookAdapter({ accessToken: "token", userId: "page-1", accountKey: "a:facebook" });
  assert.deepEqual(adapter.parseWebhook({ object: "page", entry: [{ id: "page-2", changes: [{ field: "feed", value: { item: "comment", verb: "add", comment_id: "c" } }] }] }), []);
  assert.deepEqual(adapter.parseWebhook({ object: "page", entry: [{ id: "page-1", changes: [{ field: "feed", value: { item: "post", verb: "add", post_id: "p" } }] }] }), []);
  assert.deepEqual(adapter.parseWebhook({ object: "page", entry: [{ id: "page-1", changes: [{ field: "feed", value: { item: "comment", verb: "edited", comment_id: "c" } }] }] }), []);
  assert.deepEqual(adapter.parseWebhook({ object: "instagram", entry: [{ id: "page-1", changes: [{ field: "feed", value: { item: "comment", verb: "add", comment_id: "c" } }] }] }), []);
});

test("Facebook reply publishes once with Page bearer token and no token in URL", async () => {
  const calls = [];
  const adapter = createFacebookAdapter({
    accessToken: "secret-page-token",
    userId: "page-1",
    accountKey: "a:facebook",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response(200, { id: "published-comment-1" });
    },
  });
  const result = await adapter.reply("comment-1", "hello");
  assert.deepEqual(result, { status: "published", id: "published-comment-1" });
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/v26\.0\/comment-1\/comments$/);
  assert.doesNotMatch(calls[0].url, /secret-page-token/);
  assert.equal(calls[0].options.headers.Authorization, "Bearer secret-page-token");
  assert.equal(calls[0].options.body.get("message"), "hello");
});

test("Facebook reply fails closed on deterministic Meta rejection", async () => {
  const adapter = createFacebookAdapter({
    accessToken: "token", userId: "page-1", accountKey: "a:facebook",
    fetchImpl: async () => response(400, { error: { code: 10, message: "permission denied" } }),
  });
  assert.deepEqual(await adapter.reply("comment-1", "hello"), { status: "failed", reason: "META_REJECTED", code: 10 });
});

test("Facebook reply never retries an ambiguous mutation outcome", async () => {
  let networkCalls = 0;
  const networkAdapter = createFacebookAdapter({
    accessToken: "token", userId: "page-1", accountKey: "a:facebook",
    fetchImpl: async () => { networkCalls += 1; throw new Error("timeout"); },
  });
  assert.deepEqual(await networkAdapter.reply("comment-1", "hello"), { status: "ambiguous", reason: "NETWORK_OUTCOME_UNKNOWN" });
  assert.equal(networkCalls, 1);

  let serverCalls = 0;
  const serverAdapter = createFacebookAdapter({
    accessToken: "token", userId: "page-1", accountKey: "a:facebook",
    fetchImpl: async () => { serverCalls += 1; return response(503, { error: { code: 2 } }); },
  });
  assert.deepEqual(await serverAdapter.reply("comment-1", "hello"), { status: "ambiguous", reason: "SERVER_OUTCOME_UNKNOWN" });
  assert.equal(serverCalls, 1);
});

test("Facebook provider satisfies common boundary without exposing credentials", async () => {
  const account = facebookAccount();
  const provider = createFacebookProvider({
    account,
    adapterFactory: ({ accountKey }) => ({
      config: { apiVersion: "v26.0" },
      parseWebhook() { return []; },
      async reply(parentId, text) { return { status: "published", id: `${parentId}:${text}` }; },
    }),
  });
  assert.equal(provider.platform, "facebook");
  assert.equal(provider.accountKey, "astel-u:facebook");
  assert.equal(provider.capabilities.webhooks, true);
  assert.equal(provider.capabilities.publishReplies, true);
  assert.equal(provider.capabilities.publishPosts, false);
  assert.deepEqual(await provider.publishReply("c1", "ok"), { status: "published", id: "c1:ok" });
  assert.equal(provider.health().configured, true);
  assert.doesNotMatch(JSON.stringify(provider.health()), /secret-page-token/);
});
