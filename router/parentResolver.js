async function resolveParentForRouting(c, {
  safety,
  threads,
  ownerUsername,
  ownerUserId,
  lookupEnabled = true,
} = {}) {
  if (!safety || !threads) throw new Error("parent resolver requires safety and threads dependencies");

  const parentId = threads.getParentId(c);

  // v9.1.1a hotfix: our own successfully published reply IDs are already
  // authoritative owner relationship data. Resolve them locally before any
  // external Meta parent-author lookup.
  if (parentId && await safety.isBotGeneratedId(parentId)) {
    return {
      parentId,
      parentAuthorId: ownerUserId || null,
      parentAuthorUsername: ownerUsername || null,
      source: "redis-bot-id",
    };
  }

  return threads.resolveParentAuthor(c, {
    ownerUsername,
    ownerUserId,
    lookupEnabled,
  });
}

module.exports = { resolveParentForRouting };
