const GRAPH_STATUS = Object.freeze({
  RESOLVED: "RESOLVED",
  PENDING_RELATIONSHIP: "PENDING_RELATIONSHIP",
});

function s(v) { return v == null ? null : String(v); }
function same(a, b) { return a != null && b != null && String(a) === String(b); }

function makeBranchKey(rootId, headId) {
  if (!rootId || !headId) return null;
  return `root:${String(rootId)}|branch:${String(headId)}`;
}

function deriveGraphNode({
  commentId,
  parentId,
  rootId,
  authorId,
  username,
  text,
  isOwner = false,
  isBotGenerated = false,
  parentAuthorId = null,
  parentAuthorUsername = null,
  parentNode = null,
  ownerUserId = null,
  ownerUsername = null,
  createdAt = null,
  publishStatus = null,
  publishConfirmedAt = null,
} = {}) {
  const id = s(commentId);
  const parent = s(parentId);
  const root = s(rootId);
  if (!id || !root) throw new Error("graph node requires commentId and rootId");

  const normalizedOwner = String(ownerUsername || "").replace(/^@/, "").toLowerCase();
  const normalizedParentUsername = String(parentAuthorUsername || "").replace(/^@/, "").toLowerCase();
  const parentIsOwner =
    same(parentAuthorId, ownerUserId) ||
    (!!normalizedOwner && normalizedParentUsername === normalizedOwner);

  let branchKey = parentNode?.branchKey || null;
  let relationshipStatus = GRAPH_STATUS.RESOLVED;

  if (!branchKey) {
    const directRoot = !parent || same(parent, root);
    if (directRoot || parentIsOwner) {
      branchKey = makeBranchKey(root, id);
    } else {
      relationshipStatus = GRAPH_STATUS.PENDING_RELATIONSHIP;
    }
  }

  return {
    commentId: id,
    parentId: parent,
    rootId: root,
    authorId: s(authorId),
    username: username || null,
    text: text == null ? null : String(text),
    createdAt: createdAt || new Date().toISOString(),
    isOwner: !!isOwner,
    isBotGenerated: !!isBotGenerated,
    parentAuthorId: s(parentAuthorId),
    parentAuthorUsername: parentAuthorUsername || null,
    branchKey,
    relationshipStatus,
    publishStatus: publishStatus || null,
    publishConfirmedAt: publishConfirmedAt || null,
  };
}

module.exports = { GRAPH_STATUS, makeBranchKey, deriveGraphNode };
