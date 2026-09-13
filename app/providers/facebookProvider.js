const { createFacebookAdapter } = require("../../adapters/facebookAdapter");
const { providerCapabilities } = require("./socialProvider");

function createFacebookProvider({
  account,
  adapterFactory = createFacebookAdapter,
  apiVersion,
  baseUrl,
  fetchImpl,
} = {}) {
  if (!account) throw new Error("Facebook account config is required");
  if (account.platform !== "facebook") throw new Error(`Facebook provider cannot serve ${account.platform}`);

  const adapter = adapterFactory({
    accessToken: account.accessToken,
    userId: account.userId,
    accountKey: account.key,
    apiVersion,
    baseUrl,
    fetchImpl,
  });

  const provider = {
    platform: "facebook",
    accountKey: account.key,
    account,
    capabilities: providerCapabilities({
      webhooks: true,
      publishPosts: false,
      publishReplies: true,
      discovery: false,
      insights: false,
      images: false,
      video: false,
      carousel: false,
    }),

    parseWebhook: body => adapter.parseWebhook(body),
    publishReply: (parentId, text) => adapter.reply(parentId, text),
    health() {
      return {
        platform: "facebook",
        accountKey: account.key,
        configured: Boolean(account.userId && account.accessToken),
        apiVersion: adapter.config?.apiVersion || null,
      };
    },
  };

  return Object.assign(provider, adapter, {
    reply: (parentId, text) => provider.publishReply(parentId, text),
  });
}

module.exports = { createFacebookProvider };
