const SOCIAL_EVENT_TYPES = Object.freeze({
  COMMENT_CREATED: "comment.created",
});

function text(value) {
  return value == null ? null : String(value);
}

function createSocialEvent(input = {}) {
  const platform = text(input.platform)?.trim().toLowerCase();
  const accountKey = text(input.accountKey)?.trim().toLowerCase();
  const type = text(input.type)?.trim();
  const sourceId = text(input.sourceId)?.trim();

  if (!platform) throw new Error("Social event platform is required");
  if (!accountKey) throw new Error("Social event accountKey is required");
  if (!type) throw new Error("Social event type is required");
  if (!sourceId) throw new Error("Social event sourceId is required");

  const author = Object.freeze({
    id: text(input.author?.id),
    username: text(input.author?.username),
  });

  const metadata = Object.freeze({ ...(input.metadata || {}) });

  return Object.freeze({
    platform,
    accountKey,
    type,
    sourceId,
    rootId: text(input.rootId),
    parentId: text(input.parentId),
    text: text(input.text) || "",
    author,
    surface: text(input.surface),
    timestamp: text(input.timestamp),
    metadata,
  });
}

module.exports = {
  SOCIAL_EVENT_TYPES,
  createSocialEvent,
};
