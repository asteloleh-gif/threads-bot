const { createThreadsAdapter } = require("../../adapters/threadsAdapter");
const { SOCIAL_EVENT_TYPES, createSocialEvent } = require("../events/socialEvent");
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
    normalizeWebhookEvent(native) {
      const sourceId = adapter.getCommentId(native);
      if (!sourceId) return null;
      return createSocialEvent({
        platform: "threads",
        accountKey: account.key,
        type: SOCIAL_EVENT_TYPES.COMMENT_CREATED,
        sourceId,
        rootId: adapter.getRootPostId(native),
        parentId: adapter.getParentId(native),
        text: adapter.getCommentText(native) || "",
        author: {
          id: adapter.getAuthorId(native),
          username: adapter.getAuthorUsername(native),
        },
        surface: "THREADS",
        timestamp: native?.timestamp || null,
        metadata: {
          webhookTargetId: adapter.getWebhookTargetId(native),
          parentAuthorId: adapter.getParentAuthorId(native),
          parentAuthorUsername: adapter.getParentAuthorUsername(native),
        },
      });
    },
    publishReply: (parentId, text) => adapter.reply(parentId, text),
    health() {
      return {
        platform: "threads",
        accountKey: account.key,
        configured: Boolean(account.userId && (account.accessToken || adapter.tokenManager?.getToken?.())),
      };
    },
  };

  // Compatibility surface for the existing real-time Reply Engine. The native
  // adapter methods remain available while cross-platform routing uses the
  // normalized SocialEvent side channel above.
  return Object.assign(provider, adapter, {
    normalizeWebhookEvent: provider.normalizeWebhookEvent,
    reply: (parentId, text) => provider.publishReply(parentId, text),
  });
}

module.exports = { createThreadsProvider };
