const test = require("node:test");
const assert = require("node:assert/strict");
const { createInstagramAdapter } = require("../adapters/instagramAdapter");
const { createInstagramProvider } = require("../app/providers/instagramProvider");
const { loadSocialAccounts } = require("../app/accounts/accountConfig");

function response(status, data) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() { return data; },
  };
}

test("Instagram Facebook Login resolves linked Page token and probes IG identity safely", async () => {
  const calls = [];
  const adapter = createInstagramAdapter({
    accessToken: "secret-user-token",
    userId: "ig-123",
    accountKey: "astel.us:instagram",
    authMode: "facebook_login",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const parsed = new URL(url);
      if (parsed.pathname === "/v26.0/me/accounts") {
        return response(200, {
          data: [
            {
              id: "page-1",
              name: "Astel Page",
              access_token: "secret-page-token",
              instagram_business_account: { id: "ig-123" },
            },
          ],
        });
      }
      if (parsed.pathname === "/v26.0/ig-123") {
        return response(200, {
          id: "ig-123",
          username: "astel.us",
          account_type: "BUSINESS",
          media_count: 42,
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  const result = await adapter.getAccountIdentity();
  assert.deepEqual(result, {
    status: "ok",
    identity: {
      id: "ig-123",
      userId: "ig-123",
      username: "astel.us",
      accountType: "BUSINESS",
      mediaCount: 42,
    },
  });
  assert.equal(adapter.config.authMode, "facebook_login");
  assert.equal(adapter.config.baseUrl, "https://graph.facebook.com");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.headers.Authorization, "Bearer secret-user-token");
  assert.equal(calls[1].options.headers.Authorization, "Bearer secret-page-token");
  assert.equal(calls.some(call => call.url.includes("secret-user-token")), false);
  assert.equal(calls.some(call => call.url.includes("secret-page-token")), false);
});

test("Instagram Facebook Login caches Page token and uses it for media reads", async () => {
  const calls = [];
  const adapter = createInstagramAdapter({
    accessToken: "user-token",
    userId: "ig-123",
    authMode: "facebook_login",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const parsed = new URL(url);
      if (parsed.pathname === "/v26.0/me/accounts") {
        return response(200, {
          data: [{
            id: "page-1",
            access_token: "page-token",
            instagram_business_account: { id: "ig-123" },
          }],
        });
      }
      if (parsed.pathname === "/v26.0/ig-123/media") {
        return response(200, { data: [{ id: "media-1", comments_count: 2 }] });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  const first = await adapter.listRecentMedia({ limit: 5 });
  const second = await adapter.listRecentMedia({ limit: 5 });
  assert.equal(first.status, "ok");
  assert.equal(second.status, "ok");
  assert.equal(calls.filter(call => new URL(call.url).pathname === "/v26.0/me/accounts").length, 1);
  const mediaCalls = calls.filter(call => new URL(call.url).pathname === "/v26.0/ig-123/media");
  assert.equal(mediaCalls.length, 2);
  assert.equal(mediaCalls.every(call => call.options.headers.Authorization === "Bearer page-token"), true);
});

test("Instagram Facebook Login fails closed when no Page is linked to configured IG account", async () => {
  const adapter = createInstagramAdapter({
    accessToken: "user-token",
    userId: "ig-expected",
    authMode: "facebook_login",
    fetchImpl: async () => response(200, {
      data: [{
        id: "page-1",
        access_token: "page-token",
        instagram_business_account: { id: "ig-other" },
      }],
    }),
  });

  assert.deepEqual(await adapter.getAccountIdentity(), {
    status: "failed",
    reason: "LINKED_PAGE_NOT_FOUND",
    code: null,
  });
  const media = await adapter.listRecentMedia();
  assert.equal(media.status, "failed");
  assert.equal(media.reason, "LINKED_PAGE_NOT_FOUND");
  assert.deepEqual(media.items, []);
});

test("Instagram auth mode loads from env and provider exposes only safe mode metadata", () => {
  const accounts = loadSocialAccounts({
    THREADS_USERNAME: "astel.us",
    THREADS_USER_ID: "threads-1",
    INSTAGRAM_USERNAME: "astel.us",
    INSTAGRAM_USER_ID: "ig-123",
    INSTAGRAM_ACCESS_TOKEN: "secret-user-token",
    INSTAGRAM_AUTH_MODE: "facebook_login",
  });
  const account = accounts.find(item => item.platform === "instagram");
  assert.equal(account.authMode, "facebook_login");

  const provider = createInstagramProvider({
    account,
    adapterFactory: options => ({
      config: { apiVersion: "v26.0", authMode: options.authMode, baseUrl: "https://graph.facebook.com" },
      parseWebhook() { return []; },
      async reply() { return { status: "published", id: "r1" }; },
    }),
  });
  assert.equal(provider.health().authMode, "facebook_login");
  assert.doesNotMatch(JSON.stringify(provider.health()), /secret-user-token/);
});
