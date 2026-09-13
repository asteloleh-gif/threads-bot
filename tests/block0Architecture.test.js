const test = require("node:test");
const assert = require("node:assert/strict");
const { createAccountConfig, loadPrimaryAccount, publicAccountView } = require("../app/accounts/accountConfig");
const { assertSocialProvider, providerCapabilities } = require("../app/providers/socialProvider");
const { createProviderRegistry } = require("../app/providers/providerRegistry");
const { createThreadsProvider } = require("../app/providers/threadsProvider");
const { createApplicationContext } = require("../app/composition/createApplicationContext");

test("account config normalizes identity without exposing credentials in public view", () => {
  const account = createAccountConfig({
    brand: "LeoAkastel",
    platform: "threads",
    username: "@LeoAkastel",
    userId: "123",
    accessToken: "secret-token",
    verifyToken: "verify-secret",
    language: "EN",
  });
  assert.equal(account.key, "leoakastel:threads");
  assert.equal(account.username, "LeoAkastel");
  assert.equal(account.language, "en");
  assert.equal(publicAccountView(account).accessToken, undefined);
  assert.equal(publicAccountView(account).verifyToken, undefined);
});

test("primary account preserves the legacy Threads env contract", () => {
  const account = loadPrimaryAccount({
    THREADS_USERNAME: "leoakastel",
    THREADS_USER_ID: "279",
    THREADS_ACCESS_TOKEN: "token",
    THREADS_VERIFY_TOKEN: "verify",
    BOT_ENABLED: "true",
    PROACTIVE_ACCOUNT: "en",
  });
  assert.equal(account.platform, "threads");
  assert.equal(account.userId, "279");
  assert.equal(account.accessToken, "token");
  assert.equal(account.enabled, true);
  assert.equal(account.language, "en");
});

test("provider registry is account-scoped and rejects duplicate registrations", () => {
  const registry = createProviderRegistry();
  const provider = {
    platform: "threads",
    accountKey: "leo:threads",
    parseWebhook() { return []; },
    publishReply() {},
    health() { return { configured: true }; },
  };
  registry.register(provider);
  assert.equal(registry.getForAccount("leo:threads"), provider);
  assert.throws(() => registry.register(provider), /already registered/);
  assert.equal(registry.findForAccount("missing"), null);
});

test("social provider contract fails fast when a required boundary is missing", () => {
  assert.throws(() => assertSocialProvider({ platform: "threads", accountKey: "a" }), /parseWebhook/);
  const capabilities = providerCapabilities({ webhooks: true, publishReplies: true });
  assert.equal(capabilities.webhooks, true);
  assert.equal(capabilities.publishReplies, true);
  assert.equal(capabilities.insights, false);
  assert.equal(Object.isFrozen(capabilities), true);
});

test("Threads provider delegates legacy adapter behavior through the new boundary", async () => {
  const calls = [];
  const adapter = {
    tokenManager: { getToken() { return "token"; } },
    parseWebhook(body) { calls.push(["parse", body]); return [body]; },
    reply(parentId, text) { calls.push(["reply", parentId, text]); return Promise.resolve({ status: "published", id: "r1" }); },
    getCommentId(value) { return value.id; },
  };
  const account = createAccountConfig({ brand: "leo", platform: "threads", username: "leo", userId: "1", accessToken: "token" });
  const provider = createThreadsProvider({ account, adapterFactory: () => adapter });
  assert.deepEqual(provider.parseWebhook({ x: 1 }), [{ x: 1 }]);
  assert.equal(provider.getCommentId({ id: "c1" }), "c1");
  assert.deepEqual(await provider.reply("c1", "hello"), { status: "published", id: "r1" });
  assert.deepEqual(calls, [["parse", { x: 1 }], ["reply", "c1", "hello"]]);
  assert.equal(provider.capabilities.publishReplies, true);
});

test("application context composes an account-scoped provider without platform-specific callers", () => {
  const fakeProvider = account => ({
    platform: account.platform,
    accountKey: account.key,
    parseWebhook() { return []; },
    publishReply() {},
    health() { return { platform: account.platform, accountKey: account.key, configured: true }; },
  });
  const context = createApplicationContext({
    env: { THREADS_USERNAME: "leo", THREADS_USER_ID: "1", THREADS_ACCESS_TOKEN: "token" },
    providerFactories: { threads: ({ account }) => fakeProvider(account) },
  });
  assert.equal(context.primaryAccount.key, "leo:threads");
  assert.equal(context.primaryProvider, context.providers.getForAccount("leo:threads"));
  assert.deepEqual(context.health().providers[0], { platform: "threads", accountKey: "leo:threads", configured: true });
});
