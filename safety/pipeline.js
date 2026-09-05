function createSafetyPipeline({ threadsUserId, selfUsername = "leoakastel", selfUserId = "27979923121676296", botEnabled = "false", botDryRun = "true" }) {
  const USER_COOLDOWN_MS = 20 * 1000;
  const CONVERSATION_WINDOW_MS = 24 * 60 * 60 * 1000;
  const CONVERSATION_MAX_REPLIES = 10;
  const GLOBAL_WINDOW_MS = 24 * 60 * 60 * 1000;
  const GLOBAL_MAX_REPLIES = 50;
  const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

  const processingComments = new Map();
  const publishedBySource = new Map();
  const botGeneratedIds = new Map();
  const conversationLastReplyAt = new Map();
  const conversationReplyTimes = new Map();
  const globalReplyTimes = [];
  let reservationSeq = 0;

  function now() { return Date.now(); }
  function nextReservationId() { reservationSeq += 1; return `r${reservationSeq}`; }
  function normalizeUsername(value) { return String(value || "").trim().toLowerCase(); }
  function isEnabled() { return String(botEnabled).toLowerCase() === "true"; }
  function isDryRun() { return String(botDryRun).toLowerCase() === "true"; }

  function pruneMapByTimestamp(map, ttlMs) {
    const t = now();
    for (const [key, value] of map) {
      const ts = typeof value === "number" ? value : value?.timestamp;
      if (typeof ts === "number" && t - ts > ttlMs) map.delete(key);
    }
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
  function markBotGeneratedId(id) { if (id) botGeneratedIds.set(String(id), now()); }

  function reserveComment(commentId) {
    pruneMapByTimestamp(processingComments, IDEMPOTENCY_TTL_MS);
    pruneMapByTimestamp(publishedBySource, IDEMPOTENCY_TTL_MS);
    const key = String(commentId);
    if (processingComments.has(key) || publishedBySource.has(key)) return false;
    processingComments.set(key, now());
    return true;
  }
  function releaseComment(commentId) { processingComments.delete(String(commentId)); }

  function getUserKey({ authorId, authorUsername }) {
    if (authorId) return `id:${String(authorId)}`;
    const username = normalizeUsername(authorUsername);
    return username ? `username:${username}` : null;
  }
  function getConversationKey({ userKey, rootId }) {
    return userKey && rootId ? `${userKey}|thread:${String(rootId)}` : null;
  }

  function cooldownRemainingMs(conversationKey) {
    if (!conversationKey) return USER_COOLDOWN_MS;
    const entry = conversationLastReplyAt.get(conversationKey);
    if (!entry) return 0;
    const ts = typeof entry === "number" ? entry : entry.timestamp;
    return Math.max(0, USER_COOLDOWN_MS - (now() - ts));
  }
  function userOnCooldown(conversationKey) { return cooldownRemainingMs(conversationKey) > 0; }

  function getConversationReplyCount(conversationKey) {
    if (!conversationKey) return CONVERSATION_MAX_REPLIES;
    const t = now();
    const recent = (conversationReplyTimes.get(conversationKey) || []).filter(entry => t - (typeof entry === "number" ? entry : entry.timestamp) < CONVERSATION_WINDOW_MS);
    conversationReplyTimes.set(conversationKey, recent);
    return recent.length;
  }
  function conversationLimitReached(conversationKey) { return getConversationReplyCount(conversationKey) >= CONVERSATION_MAX_REPLIES; }

  function globalLimitReached() {
    const t = now();
    while (globalReplyTimes.length && t - (typeof globalReplyTimes[0] === "number" ? globalReplyTimes[0] : globalReplyTimes[0].timestamp) >= GLOBAL_WINDOW_MS) globalReplyTimes.shift();
    return globalReplyTimes.length >= GLOBAL_MAX_REPLIES;
  }

  function reserveRateLimitSlot({ conversationKey }) {
    const t = now();
    const reservationId = nextReservationId();
    const entry = { reservationId, timestamp: t };
    if (conversationKey) {
      conversationLastReplyAt.set(conversationKey, entry);
      const list = (conversationReplyTimes.get(conversationKey) || []).filter(item => t - (typeof item === "number" ? item : item.timestamp) < CONVERSATION_WINDOW_MS);
      list.push(entry);
      conversationReplyTimes.set(conversationKey, list);
    }
    globalReplyTimes.push(entry);
    return { conversationKey, reservedAt: t, reservationId };
  }

  function releaseRateLimitSlot(reservation) {
    if (!reservation) return;
    const { conversationKey, reservationId } = reservation;
    const last = conversationKey ? conversationLastReplyAt.get(conversationKey) : null;
    if (conversationKey && last && last.reservationId === reservationId) conversationLastReplyAt.delete(conversationKey);
    if (conversationKey) {
      const list = (conversationReplyTimes.get(conversationKey) || []).filter(entry => entry.reservationId !== reservationId);
      conversationReplyTimes.set(conversationKey, list);
    }
    const idx = globalReplyTimes.findIndex(entry => entry.reservationId === reservationId);
    if (idx !== -1) globalReplyTimes.splice(idx, 1);
  }

  function recordSuccessfulReply({ sourceCommentId, publishedReplyId }) {
    const t = now();
    if (sourceCommentId) publishedBySource.set(String(sourceCommentId), { publishedReplyId: publishedReplyId || null, timestamp: t });
    if (publishedReplyId) botGeneratedIds.set(String(publishedReplyId), t);
  }

  function markAmbiguous(commentId) {
    if (commentId) processingComments.set(String(commentId), { timestamp: now(), ambiguous: true });
  }
  function ambiguousCount() {
    let n = 0;
    for (const v of processingComments.values()) if (v && typeof v === "object" && v.ambiguous) n++;
    return n;
  }

  return {
    isEnabled, isDryRun, isSelfAuthored, isBotGeneratedId, markBotGeneratedId,
    reserveComment, releaseComment, getUserKey, getConversationKey,
    userOnCooldown, cooldownRemainingMs, getConversationReplyCount, conversationLimitReached,
    globalLimitReached, reserveRateLimitSlot, releaseRateLimitSlot,
    markAmbiguous, ambiguousCount, recordSuccessfulReply,
    limits: { USER_COOLDOWN_MS, CONVERSATION_WINDOW_MS, CONVERSATION_MAX_REPLIES, GLOBAL_WINDOW_MS, GLOBAL_MAX_REPLIES }
  };
}

module.exports = { createSafetyPipeline };
