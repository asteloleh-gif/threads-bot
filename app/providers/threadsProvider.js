const { createThreadsAdapter } = require("../../adapters/threadsAdapter");
const { providerCapabilities } = require("./socialProvider");

function createThreadsProvider({ account, adapterFactory = createThreadsAdapter } = {}) {
  if (!account) throw new Error("Threads account config is required");
  if (account.platform !== "threads") throw new Error(`Threads provider cannot serve ${account.platform}`);

  const adapter = adapterFactory({
    accessToken: account.accessToken,
    userId: account.userId,
  });

  const provider = {
    platform: "threads",
    accountKey: account.key,
    account,
    capabilities: providerCapabilities({
      webhooks: true,
      publishPosts: false,
      publishReplies: true,
      discovery: true,
      insights: false,
      images: false,
      video: false,
      carousel: false,
    }),

    parseWebhook: body => adapter.parseWebhook(body),
    publishReply: (parentId, text) => adapter.reply(parentId, text),
    health() {
      return {
        platform: "threads",
        accountKey: account.key,
        configured: Boolean(account.userId && (account.accessToken || adapter.tokenManager?.getToken?.())),
      };
    },
  };

  // Compatibility surface for the existing real-time Reply Engine. Block 0
  // introduces the provider boundary without changing runtime semantics.
  return Object.assign(provider, adapter, {
    reply: (parentId, text) => provider.publishReply(parentId, text),
  });
}

module.exports = { createThreadsProvider };
