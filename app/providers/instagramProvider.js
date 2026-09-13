const { createInstagramAdapter } = require("../../adapters/instagramAdapter");
const { providerCapabilities } = require("./socialProvider");

function createInstagramProvider({
  account,
  adapterFactory = createInstagramAdapter,
  apiVersion,
  baseUrl,
  fetchImpl,
} = {}) {
  if (!account) throw new Error("Instagram account config is required");
  if (account.platform !== "instagram") throw new Error(`Instagram provider cannot serve ${account.platform}`);

  const adapter = adapterFactory({
    accessToken: account.accessToken,
    userId: account.userId,
    accountKey: account.key,
    apiVersion,
    baseUrl,
    fetchImpl,
  });

  const provider = {
    platform: "instagram",
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
        platform: "instagram",
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

module.exports = { createInstagramProvider };
