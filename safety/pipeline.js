function createSafetyPipeline({ threadsUserId, selfUsername = "leoakastel", selfUserId = "27979923121676296", botEnabled = "false", botDryRun = "true" }) {
  const USER_COOLDOWN_MS = 10 * 60 * 1000;
  const THREAD_WINDOW_MS = 10 * 60 * 1000;
  const THREAD_MAX_REPLIES = 5;
  const GLOBAL_WINDOW_MS = 60 * 60 * 1000;
  const GLOBAL_MAX_REPLIES = 15;
  const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

  const processingComments = new Map();
  const publishedBySource = new Map();
  const botGeneratedIds = new Map();
  const userLastReplyAt = new Map();
  const threadReplyTimes = new Map();
  const globalReplyTimes = [];

  function now() { return Date.now(); }

  function pruneMapByTimestamp(map, ttlMs) {
    const t = now();
    for (const [key, value] of map) {
      const ts = typeof value === "number" ? value : value?.timestamp;
      if (typeof ts === "number" && t - ts > ttlMs) map.delete(key);
    }
  }

  function normalizeUsername(value) {
    return String(value || "").trim().toLowerCase();
  }

  function isEnabled() {
    return String(botEnabled).toLowerCase() === "true";
  }

  function isDryRun() {
    return String(botDryRun).toLowerCase() === "true";
  }

  function isSelfAuthored({ authorId, authorUsername }) {
    const username = normalizeUsername(authorUsername);
    return username === selfUsername ||
      (authorId && String(authorId) === selfUserId) ||
      (authorId && threadsUserId && String(authorId) === String(threadsUserId));
  }

  function isBotGeneratedId(id) {
    pruneMapByTimestamp(botGeneratedIds, IDEMPOTENCY_TTL_MS);
    return id ? botGeneratedIds.has(String(id)) : false;
  }

  function markBotGeneratedId(id) {
    if (id) botGeneratedIds.set(String(id), now());
  }

  function reserveComment(commentId) {
    pruneMapByTimestamp(processingComments, IDEMPOTENCY_TTL_MS);
    pruneMapByTimestamp(publishedBySource, IDEMPOTENCY_TTL_MS);
    const key = String(commentId);
    if (processingComments.has(key) || publishedBySource.has(key)) return false;
    processingComments.set(key, now());
    return true;
  }

  function releaseComment(commentId) {
    processingComments.delete(String(commentId));
  }

  function getUserKey({ authorId, authorUsername }) {
    if (authorId) return `id:${String(authorId)}`;
    const username = normalizeUsername(authorUsername);
    return username ? `username:${username}` : null;
  }

  function userOnCooldown(userKey) {
    if (!userKey) return true;
    const t = now();
    const last = userLastReplyAt.get(userKey);
    if (!last) return false;
    return t - last < USER_COOLDOWN_MS;
  }

  function threadOnCooldown(rootId) {
    if (!rootId) return true;
    const t = now();
    const key = String(rootId);
    const recent = (threadReplyTimes.get(key) || []).filter(ts => t - ts < THREAD_WINDOW_MS);
    threadReplyTimes.set(key, recent);
    return recent.length >= THREAD_MAX_REPLIES;
  }

  function globalLimitReached() {
    const t = now();
    while (globalReplyTimes.length && t - globalReplyTimes[0] >= GLOBAL_WINDOW_MS) globalReplyTimes.shift();
    return globalReplyTimes.length >= GLOBAL_MAX_REPLIES;
  }

  function recordSuccessfulReply({ sourceCommentId, publishedReplyId, userKey, rootId }) {
    const t = now();
    if (sourceCommentId) publishedBySource.set(String(sourceCommentId), { publishedReplyId: publishedReplyId || null, timestamp: t });
    if (publishedReplyId) botGeneratedIds.set(String(publishedReplyId), t);
    if (userKey) userLastReplyAt.set(userKey, t);
    if (rootId) {
      const key = String(rootId);
      const list = (threadReplyTimes.get(key) || []).filter(ts => t - ts < THREAD_WINDOW_MS);
      list.push(t);
      threadReplyTimes.set(key, list);
    }
    globalReplyTimes.push(t);
  }

  return {
    isEnabled,
    isDryRun,
    isSelfAuthored,
    isBotGeneratedId,
    markBotGeneratedId,
    reserveComment,
    releaseComment,
    getUserKey,
    userOnCooldown,
    threadOnCooldown,
    globalLimitReached,
    recordSuccessfulReply,
  };
}

module.exports = { createSafetyPipeline };
