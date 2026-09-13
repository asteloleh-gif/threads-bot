const REQUIRED_PROVIDER_METHODS = Object.freeze([
  "parseWebhook",
  "publishReply",
  "health",
]);

function assertSocialProvider(provider) {
  if (!provider || typeof provider !== "object") throw new Error("Social provider is required");
  if (!provider.platform) throw new Error("Social provider platform is required");
  if (!provider.accountKey) throw new Error("Social provider accountKey is required");
  for (const method of REQUIRED_PROVIDER_METHODS) {
    if (typeof provider[method] !== "function") {
      throw new Error(`Social provider ${provider.platform} is missing ${method}()`);
    }
  }
  return provider;
}

function providerCapabilities(values = {}) {
  return Object.freeze({
    webhooks: Boolean(values.webhooks),
    publishPosts: Boolean(values.publishPosts),
    publishReplies: Boolean(values.publishReplies),
    discovery: Boolean(values.discovery),
    insights: Boolean(values.insights),
    images: Boolean(values.images),
    video: Boolean(values.video),
    carousel: Boolean(values.carousel),
  });
}

module.exports = {
  REQUIRED_PROVIDER_METHODS,
  assertSocialProvider,
  providerCapabilities,
};
