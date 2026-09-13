function createCommentCompatibility({ adapter, account, platform } = {}) {
  if (!adapter || !account) throw new Error("Comment compatibility requires adapter and account");

  const getCommentId = event => event?.sourceId || event?.id || null;
  const getCommentText = event => event?.text || event?.message || "";
  const getAuthorId = event => event?.author?.id || event?.from?.id || null;
  const getAuthorUsername = event => event?.author?.username || event?.from?.username || event?.from?.name || null;
  const getRootPostId = event => event?.rootId || event?.media?.id || event?.post_id || null;
  const getParentId = event => event?.parentId || event?.parent_id || getRootPostId(event) || null;
  const getParentAuthorId = event => event?.metadata?.parentAuthorId || event?.parentAuthorId || null;
  const getParentAuthorUsername = event => event?.metadata?.parentAuthorUsername || event?.parentAuthorUsername || null;
  const getWebhookTargetId = event => event?.metadata?.targetUserId || event?.metadata?.targetPageId || null;

  async function resolveParentAuthor(event, { ownerUsername, ownerUserId, lookupEnabled = true } = {}) {
    const parentId = getParentId(event);
    const rootId = getRootPostId(event);
    if (!parentId) return { parentId: null, parentAuthorId: null, parentAuthorUsername: null, source: "none" };

    const payloadAuthorId = getParentAuthorId(event);
    const payloadUsername = getParentAuthorUsername(event);
    if (payloadAuthorId || payloadUsername) {
      return { parentId, parentAuthorId: payloadAuthorId, parentAuthorUsername: payloadUsername, source: "webhook" };
    }

    if (rootId && String(parentId) === String(rootId)) {
      return {
        parentId,
        parentAuthorId: ownerUserId || account.userId || null,
        parentAuthorUsername: ownerUsername || account.username || null,
        source: "root-owner",
      };
    }

    if (!lookupEnabled || typeof adapter.getComment !== "function") {
      return { parentId, parentAuthorId: null, parentAuthorUsername: null, source: "unknown" };
    }

    const parent = await adapter.getComment(parentId);
    if (!parent) return { parentId, parentAuthorId: null, parentAuthorUsername: null, source: "lookup-failed" };

    const parentAuthorId = parent?.from?.id || parent?.user?.id || null;
    const parentAuthorUsername =
      parent?.from?.username || parent?.username || parent?.from?.name || null;

    return {
      parentId,
      parentAuthorId,
      parentAuthorUsername,
      source: "api",
    };
  }

  return {
    getCommentId,
    getCommentText,
    getAuthorId,
    getAuthorUsername,
    getRootPostId,
    getParentId,
    getParentAuthorId,
    getParentAuthorUsername,
    getWebhookTargetId,
    resolveParentAuthor,
    compatibilityPlatform: platform || account.platform,
  };
}

module.exports = { createCommentCompatibility };
