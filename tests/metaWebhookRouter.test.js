const test = require("node:test");
const assert = require("node:assert/strict");
const { createAccountConfig } = require("../app/accounts/accountConfig");
const { createProviderRegistry } = require("../app/providers/providerRegistry");
const { createThreadsProvider } = require("../app/providers/threadsProvider");
const { detectMetaPlatform, createMetaWebhookRouter } = require("../app/webhooks/metaWebhookRouter");

function fakeProvider({ platform, accountKey, verifyToken = null, enabled = true, events = [], normalizeWebhookEvent } = {}) {
  const account = createAccountConfig({
    key: accountKey || `brand:${platform}`,
    brand: "brand",
    platform,
    username: `${platform}.account`,
    userId: `${platform}-1`,
    accessToken: "token",
    verifyToken,
    enabled,
  });
  return {
    platform,
    accountKey: account.key,
    account,
    parseWebhook() { return events; },
    publishReply() {},
    health() { return { configured: true }; },
    ...(normalizeWebhookEvent ? { normalizeWebhookEvent } : {}),
  };
}

test("Meta webhook detector recognizes explicit Instagram, Facebook and Threads objects", () => {
  assert.equal(detectMetaPlatform({ object: "instagram" }), "instagram");
  assert.equal(detectMetaPlatform({ object: "page" }), "facebook");
  assert.equal(detectMetaPlatform({ object: "threads" }), "threads");
});

test("Meta webhook detector preserves legacy Threads envelopes but rejects unknown explicit objects", () => {
  assert.equal(detectMetaPlatform({ values: [{ field: "replies" }] }), "threads");
  assert.equal(detectMetaPlatform({ entry: [{ changes: [{ field: "comments" }] }] }), "threads");
  assert.equal(detectMetaPlatform({ object: "unknown", entry: [{ changes: [{ field: "comments" }] }] }), null);
  assert.equal(detectMetaPlatform({ entry: [{ changes: [{ field: "feed" }] }] }), null);
});

test("Meta webhook verification accepts configured provider tokens and rejects others", () => {
  const registry = createProviderRegistry([
    fakeProvider({ platform: "threads", verifyToken: "threads-verify" }),
    fakeProvider({ platform: "instagram", verifyToken: "instagram-verify" }),
  ]);
  const router = createMetaWebhookRouter({ providerRegistry: registry });
  assert.deepEqual(router.verify({ "hub.mode": "subscribe", "hub.verify_token": "threads-verify", "hub.challenge": "123" }), { ok: true, challenge: "123" });
  assert.deepEqual(router.verify({ "hub.mode": "subscribe", "hub.verify_token": "instagram-verify", "hub.challenge": "456" }), { ok: true, challenge: "456" });
  assert.deepEqual(router.verify({ "hub.mode": "subscribe", "hub.verify_token": "wrong", "hub.challenge": "789" }), { ok: false });
});

test("Meta webhook router ignores a platform with no enabled provider", async () => {
  const registry = createProviderRegistry([
    fakeProvider({ platform: "instagram", enabled: false }),
  ]);
  const router = createMetaWebhookRouter({ providerRegistry: registry });
  assert.deepEqual(await router.dispatch({ object: "instagram" }), {
    status: "ignored", reason: "NO_ENABLED_PROVIDER", platform: "instagram", parsed: 0, dispatched: 0, unhandled: 0,
  });
  assert.deepEqual(await router.dispatch({ object: "page" }), {
    status: "ignored", reason: "NO_ENABLED_PROVIDER", platform: "facebook", parsed: 0, dispatched: 0, unhandled: 0,
  });
});

test("Meta webhook router dispatches normalized provider events to the platform handler", async () => {
  const event = Object.freeze({ platform: "instagram", accountKey: "brand:instagram", type: "comment.created", sourceId: "c1" });
  const provider = fakeProvider({ platform: "instagram", events: [event] });
  const registry = createProviderRegistry([provider]);
  const received = [];
  const router = createMetaWebhookRouter({
    providerRegistry: registry,
    handlers: { instagram: async payload => received.push(payload) },
  });
  const result = await router.dispatch({ object: "instagram" });
  assert.deepEqual(result, { status: "ok", platform: "instagram", parsed: 1, dispatched: 1, unhandled: 0 });
  assert.equal(received.length, 1);
  assert.equal(received[0].event, event);
  assert.equal(received[0].native, event);
  assert.equal(received[0].provider, provider);
});

test("Threads provider preserves native webhook payload while exposing normalized SocialEvent", async () => {
  const native = {
    id: "reply-1",
    text: "hello",
    username: "buyer",
    user_id: "user-1",
    root_post: { id: "root-1" },
    replied_to: { id: "parent-1", user_id: "parent-user", username: "leo" },
    __webhook_target_id: "target-1",
    timestamp: "2026-09-13T05:00:00+0000",
  };
  const adapter = {
    tokenManager: { getToken() { return "token"; } },
    parseWebhook() { return [native]; },
    getCommentId: value => value.id,
    getCommentText: value => value.text,
    getAuthorId: value => value.user_id,
    getAuthorUsername: value => value.username,
    getRootPostId: value => value.root_post?.id,
    getParentId: value => value.replied_to?.id,
    getParentAuthorId: value => value.replied_to?.user_id,
    getParentAuthorUsername: value => value.replied_to?.username,
    getWebhookTargetId: value => value.__webhook_target_id,
    reply: async () => ({ status: "published", id: "r" }),
  };
  const account = createAccountConfig({ brand: "leo", platform: "threads", username: "leo", userId: "owner-1", accessToken: "token", verifyToken: "verify", enabled: true });
  const provider = createThreadsProvider({ account, adapterFactory: () => adapter });
  const registry = createProviderRegistry([provider]);
  const received = [];
  const router = createMetaWebhookRouter({ providerRegistry: registry, handlers: { threads: async payload => received.push(payload) } });

  const result = await router.dispatch({ values: [{ field: "replies" }] });
  assert.deepEqual(result, { status: "ok", platform: "threads", parsed: 1, dispatched: 1, unhandled: 0 });
  assert.equal(received[0].native, native);
  assert.deepEqual(received[0].event, {
    platform: "threads",
    accountKey: "leo:threads",
    type: "comment.created",
    sourceId: "reply-1",
    rootId: "root-1",
    parentId: "parent-1",
    text: "hello",
    author: { id: "user-1", username: "buyer" },
    surface: "THREADS",
    timestamp: "2026-09-13T05:00:00+0000",
    metadata: { webhookTargetId: "target-1", parentAuthorId: "parent-user", parentAuthorUsername: "leo" },
  });
});

test("Meta webhook router records parsed events as unhandled instead of mutating when no handler is installed", async () => {
  let parsed = 0;
  const provider = fakeProvider({ platform: "facebook", events: [{ platform: "facebook", sourceId: "c1" }] });
  provider.parseWebhook = () => { parsed += 1; return [{ platform: "facebook", sourceId: "c1" }]; };
  const router = createMetaWebhookRouter({ providerRegistry: createProviderRegistry([provider]) });
  const result = await router.dispatch({ object: "page" });
  assert.equal(parsed, 1);
  assert.deepEqual(result, { status: "ok", platform: "facebook", parsed: 1, dispatched: 0, unhandled: 1 });
});

test("Meta webhook router ignores unrecognized payloads without calling providers", async () => {
  let called = false;
  const provider = fakeProvider({ platform: "threads" });
  provider.parseWebhook = () => { called = true; return []; };
  const router = createMetaWebhookRouter({ providerRegistry: createProviderRegistry([provider]) });
  assert.deepEqual(await router.dispatch({ hello: "world" }), {
    status: "ignored", reason: "UNRECOGNIZED_WEBHOOK", platform: null, parsed: 0, dispatched: 0, unhandled: 0,
  });
  assert.equal(called, false);
});
