const test = require("node:test");
const assert = require("node:assert/strict");
const { loadSocialAccounts, createAccountConfig } = require("../app/accounts/accountConfig");
const { createApplicationContext } = require("../app/composition/createApplicationContext");
const { createCommentCompatibility } = require("../app/providers/commentCompatibility");
const { createCommunityRuntime } = require("../app/community/createCommunityRuntime");

test("social account loader keeps Threads primary and adds configured Instagram/Facebook safely disabled by default", () => {
  const accounts = loadSocialAccounts({
    THREADS_USERNAME: "leo",
    THREADS_USER_ID: "t1",
    THREADS_ACCESS_TOKEN: "tt",
    THREADS_VERIFY_TOKEN: "verify",
    BOT_ENABLED: "true",
    BOT_DRY_RUN: "false",
    INSTAGRAM_USERNAME: "leo",
    INSTAGRAM_USER_ID: "i1",
    INSTAGRAM_ACCESS_TOKEN: "it",
    FACEBOOK_USERNAME: "Leo Page",
    FACEBOOK_USER_ID: "f1",
    FACEBOOK_ACCESS_TOKEN: "ft",
  });

  assert.deepEqual(accounts.map(a => a.platform), ["threads", "instagram", "facebook"]);
  assert.equal(accounts[0].enabled, true);
  assert.equal(accounts[0].dryRun, false);
  assert.equal(accounts[1].enabled, false);
  assert.equal(accounts[1].dryRun, true);
  assert.equal(accounts[1].verifyToken, "verify");
  assert.equal(accounts[2].enabled, false);
  assert.equal(accounts[2].dryRun, true);
});

test("explicit platform flags enable Instagram/Facebook without changing Threads settings", () => {
  const accounts = loadSocialAccounts({
    THREADS_USERNAME: "leo",
    THREADS_USER_ID: "t1",
    BOT_ENABLED: "false",
    INSTAGRAM_USERNAME: "leo",
    INSTAGRAM_USER_ID: "i1",
    INSTAGRAM_ACCESS_TOKEN: "it",
    INSTAGRAM_ENABLED: "true",
    INSTAGRAM_DRY_RUN: "false",
    FACEBOOK_USERNAME: "Leo Page",
    FACEBOOK_USER_ID: "f1",
    FACEBOOK_ACCESS_TOKEN: "ft",
    FACEBOOK_ENABLED: "true",
    FACEBOOK_DRY_RUN: "false",
  });
  assert.equal(accounts[0].enabled, false);
  assert.equal(accounts[1].enabled, true);
  assert.equal(accounts[1].dryRun, false);
  assert.equal(accounts[2].enabled, true);
  assert.equal(accounts[2].dryRun, false);
});

test("application context registers all configured platform providers in one account-scoped registry", () => {
  const fake = platform => ({ account }) => ({
    platform,
    accountKey: account.key,
    account,
    parseWebhook() { return []; },
    publishReply() {},
    health() { return { platform, accountKey: account.key, configured: true }; },
  });

  const context = createApplicationContext({
    env: {
      THREADS_USERNAME: "leo",
      THREADS_USER_ID: "t1",
      THREADS_ACCESS_TOKEN: "tt",
      INSTAGRAM_USERNAME: "leo",
      INSTAGRAM_USER_ID: "i1",
      INSTAGRAM_ACCESS_TOKEN: "it",
      FACEBOOK_USERNAME: "Leo Page",
      FACEBOOK_USER_ID: "f1",
      FACEBOOK_ACCESS_TOKEN: "ft",
    },
    providerFactories: {
      threads: fake("threads"),
      instagram: fake("instagram"),
      facebook: fake("facebook"),
    },
  });

  assert.equal(context.accounts.length, 3);
  assert.equal(context.primaryProvider.platform, "threads");
  assert.equal(context.providers.list().length, 3);
  assert.deepEqual(context.health().accounts.map(a => a.platform), ["threads", "instagram", "facebook"]);
});

test("normalized comment compatibility treats a top-level comment as addressed to the owner root", async () => {
  const account = createAccountConfig({
    brand: "leo",
    platform: "instagram",
    username: "leo",
    userId: "owner-1",
    accessToken: "token",
  });
  const compatibility = createCommentCompatibility({ adapter: { getComment: async () => null }, account });
  const event = {
    sourceId: "c1",
    rootId: "post-1",
    parentId: null,
    text: "hello",
    author: { id: "u1", username: "buyer" },
    metadata: {},
  };
  assert.equal(compatibility.getParentId(event), "post-1");
  assert.deepEqual(await compatibility.resolveParentAuthor(event, { ownerUsername: "leo", ownerUserId: "owner-1" }), {
    parentId: "post-1",
    parentAuthorId: "owner-1",
    parentAuthorUsername: "leo",
    source: "root-owner",
  });
});

test("normalized comment compatibility resolves nested parent author through provider lookup", async () => {
  const account = createAccountConfig({
    brand: "leo",
    platform: "facebook",
    username: "Leo Page",
    userId: "page-1",
    accessToken: "token",
  });
  const calls = [];
  const compatibility = createCommentCompatibility({
    account,
    adapter: {
      async getComment(id) {
        calls.push(id);
        return { id, from: { id: "u2", name: "Other User" } };
      },
    },
  });
  const event = {
    sourceId: "c2",
    rootId: "post-1",
    parentId: "c1",
    text: "reply",
    author: { id: "u3", username: null },
    metadata: {},
  };
  assert.deepEqual(await compatibility.resolveParentAuthor(event, { ownerUsername: "Leo Page", ownerUserId: "page-1" }), {
    parentId: "c1",
    parentAuthorId: "u2",
    parentAuthorUsername: "Other User",
    source: "api",
  });
  assert.deepEqual(calls, ["c1"]);
});

test("secondary community runtime is account-scoped and remains fail-closed before Redis init", async () => {
  const account = createAccountConfig({
    brand: "leo",
    platform: "instagram",
    username: "leo",
    userId: "i1",
    accessToken: "token",
    enabled: true,
    dryRun: true,
  });
  const provider = {
    platform: "instagram",
    accountKey: account.key,
    account,
    getCommentId: e => e.sourceId,
    getCommentText: e => e.text,
    getAuthorId: e => e.author?.id,
    getAuthorUsername: e => e.author?.username,
    getRootPostId: e => e.rootId,
    getParentId: e => e.parentId || e.rootId,
    getParentAuthorId: () => null,
    getParentAuthorUsername: () => null,
    getWebhookTargetId: () => null,
    resolveParentAuthor: async e => ({ parentId: e.rootId, parentAuthorId: account.userId, parentAuthorUsername: account.username, source: "root-owner" }),
    reply: async () => ({ status: "published", id: "r1" }),
  };
  const runtime = createCommunityRuntime({
    provider,
    redisUrl: "redis://example.invalid:6379",
    policy: { normalReplyLimit: 3, cooldownSeconds: 20, conversationResetHours: 24, globalDailyLimit: 50, redisRequired: true, parentLookupEnabled: true, closingEnabled: false },
    getContext: async () => "",
    generateReply: async () => ({ text: "hi" }),
  });
  assert.equal(runtime.health().accountKey, "leo:instagram");
  assert.equal(runtime.health().redis.connected, false);
  assert.deepEqual(await runtime.handleComment({ sourceId: "c1", rootId: "p1", text: "hello", author: { id: "u1", username: "u" } }), {
    status: "ignored",
    reason: "SAFETY_STORE_UNAVAILABLE",
  });
});
