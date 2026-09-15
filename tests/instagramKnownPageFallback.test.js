const test = require("node:test");
const assert = require("node:assert/strict");
const { createInstagramAdapter } = require("../adapters/instagramAdapter");
const { createInstagramProvider } = require("../app/providers/instagramProvider");
const { loadSocialAccounts, publicAccountView } = require("../app/accounts/accountConfig");

function response(status, data) {
  return {
    status,
    ok: status >= 200 && status < 300,
    async json() { return data; },
  };
}

test("Instagram Facebook Login resolves a known Page directly when me/accounts is empty", async () => {
  const calls = [];
  const adapter = createInstagramAdapter({
    accessToken: "fresh-user-token",
    userId: "instagram-login-id",
    username: "astel.us",
    linkedPageId: "known-page-id",
    linkedPageAccessToken: "stale-page-token",
    authMode: "facebook_login",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      const parsed = new URL(url);
      if (parsed.pathname === "/v26.0/me/accounts") {
        return response(200, { data: [] });
      }
      if (parsed.pathname === "/v26.0/known-page-id") {
        assert.equal(options.headers.Authorization, "Bearer fresh-user-token");
        return response(200, {
          id: "known-page-id",
          access_token: "fresh-page-token",
          instagram_business_account: { id: "facebook-linked-ig-id" },
        });
      }
      if (parsed.pathname === "/v26.0/facebook-linked-ig-id") {
        assert.equal(options.headers.Authorization, "Bearer fresh-page-token");
        const fields = parsed.searchParams.get("fields");
        if (fields === "id,username") {
          return response(200, { id: "facebook-linked-ig-id", username: "astel.us" });
        }
        return response(200, {
          id: "facebook-linked-ig-id",
          username: "astel.us",
          account_type: "BUSINESS",
          media_count: 23,
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  const identity = await adapter.getAccountIdentity();
  assert.equal(identity.status, "ok");
  assert.equal(identity.resolution, "known_page_id");
  assert.equal(identity.identity.username, "astel.us");
  assert.equal(identity.identity.mediaCount, 23);
  assert.deepEqual(identity.diagnostics, {
    pagesVisible: 0,
    pagesWithInstagram: 0,
    identityLookupAttempts: 1,
    identityLookupSuccesses: 1,
    knownPageConfigured: true,
    knownPageAttempted: true,
    knownPageHasInstagram: true,
    knownPageAccessTokenReturned: true,
    pageTokenFallbackConfigured: true,
    pageTokenFallbackAttempted: false,
    pageTokenFallbackHasInstagram: false,
  });
  assert.equal(calls.some(call => call.url.includes("fresh-user-token")), false);
  assert.equal(calls.some(call => call.url.includes("fresh-page-token")), false);
  assert.equal(calls.some(call => call.url.includes("stale-page-token")), false);
});

test("known Page failure is not masked by an expired configured Page token", async () => {
  const adapter = createInstagramAdapter({
    accessToken: "fresh-user-token",
    userId: "instagram-login-id",
    username: "astel.us",
    linkedPageId: "known-page-id",
    linkedPageAccessToken: "expired-page-token",
    authMode: "facebook_login",
    fetchImpl: async (url, options) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/v26.0/me/accounts") return response(200, { data: [] });
      if (parsed.pathname === "/v26.0/known-page-id") {
        assert.equal(options.headers.Authorization, "Bearer fresh-user-token");
        return response(403, { error: { code: 10, type: "OAuthException" } });
      }
      if (parsed.pathname === "/v26.0/me") {
        assert.equal(options.headers.Authorization, "Bearer expired-page-token");
        return response(400, { error: { code: 190, type: "OAuthException" } });
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  });

  const result = await adapter.getAccountIdentity();
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "META_REJECTED");
  assert.equal(result.code, 10);
  assert.equal(result.diagnostics.knownPageAttempted, true);
  assert.equal(result.diagnostics.pageTokenFallbackAttempted, true);
  assert.equal(result.diagnostics.knownPageHasInstagram, false);
});

test("Instagram account config keeps known Page id and Page token out of public view", () => {
  const accounts = loadSocialAccounts({
    THREADS_USERNAME: "astel.us",
    THREADS_USER_ID: "threads-id",
    INSTAGRAM_USERNAME: "astel.us",
    INSTAGRAM_USER_ID: "ig-id",
    INSTAGRAM_ACCESS_TOKEN: "ig-user-token",
    INSTAGRAM_AUTH_MODE: "facebook_login",
    FACEBOOK_USER_ID: "known-page-id",
    FACEBOOK_ACCESS_TOKEN: "page-token",
  });
  const account = accounts.find(item => item.platform === "instagram");
  assert.equal(account.linkedPageId, "known-page-id");
  assert.equal(account.linkedPageAccessToken, "page-token");
  const publicView = JSON.stringify(publicAccountView(account));
  assert.doesNotMatch(publicView, /known-page-id/);
  assert.doesNotMatch(publicView, /page-token/);

  let adapterOptions = null;
  createInstagramProvider({
    account,
    adapterFactory: options => {
      adapterOptions = options;
      return {
        config: { apiVersion: "v26.0", authMode: "facebook_login" },
        parseWebhook() { return []; },
        async reply() { return { status: "published", id: "r1" }; },
      };
    },
  });
  assert.equal(adapterOptions.linkedPageId, "known-page-id");
  assert.equal(adapterOptions.linkedPageAccessToken, "page-token");
});
