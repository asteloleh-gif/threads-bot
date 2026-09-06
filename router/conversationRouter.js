function normalizeUsername(value) {
  return String(value || "").trim().replace(/^@/, "").toLowerCase();
}

function hasExplicitMention(text, ownerUsername) {
  const owner = normalizeUsername(ownerUsername);
  if (!owner) return false;
  const escaped = owner.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9_.])@${escaped}(?=$|[^a-z0-9_.])`, "i").test(String(text || ""));
}

function routeComment({
  authorId,
  authorUsername,
  ownerUserId,
  ownerUsername,
  rootId,
  parentId,
  parentAuthorId,
  parentAuthorUsername,
  text,
}) {
  const ownerName = normalizeUsername(ownerUsername);
  const authorName = normalizeUsername(authorUsername);
  const parentName = normalizeUsername(parentAuthorUsername);
  const ownerId = ownerUserId ? String(ownerUserId) : null;
  const aId = authorId ? String(authorId) : null;
  const pId = parentAuthorId ? String(parentAuthorId) : null;

  if ((ownerId && aId === ownerId) || (ownerName && authorName === ownerName)) {
    return { allow: false, reason: "SELF_COMMENT" };
  }

  if (hasExplicitMention(text, ownerName)) {
    return { allow: true, reason: "EXPLICIT_OWNER_MENTION" };
  }

  if ((ownerId && pId === ownerId) || (ownerName && parentName === ownerName)) {
    return { allow: true, reason: "DIRECT_REPLY_TO_OWNER" };
  }

  // A direct comment on the owner's root post is addressed to the owner even when
  // webhook payload does not include parent-author metadata.
  if (parentId && rootId && String(parentId) === String(rootId)) {
    return { allow: true, reason: "OWNER_ROOT_COMMENT" };
  }

  if (parentId) {
    return { allow: false, reason: parentAuthorId || parentAuthorUsername ? "OTHER_USER_REPLY" : "UNKNOWN_PARENT" };
  }

  // Conservative fallback: if there is no relationship information, do not inject
  // the bot into a potentially unrelated discussion.
  return { allow: false, reason: "UNKNOWN_RELATIONSHIP" };
}

module.exports = { normalizeUsername, hasExplicitMention, routeComment };
