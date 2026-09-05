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
  let reservationSeq = 0;

  function now() { return Date.now(); }
  function nextReservationId() { reservationSeq += 1; return `r${reservationSeq}`; }

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
    const ts = typeof last === "number" ? last : last.timestamp;
    return t - ts < USER_COOLDOWN_MS;
  }

  function threadOnCooldown(rootId) {
    if (!rootId) return true;
    const t = now();
    const key = String(rootId);
    const recent = (threadReplyTimes.get(key) || []).filter(entry => t - (typeof entry === "number" ? entry : entry.timestamp) < THREAD_WINDOW_MS);
    threadReplyTimes.set(key, recent);
    return recent.length >= THREAD_MAX_REPLIES;
  }

  function globalLimitReached() {
    const t = now();
    while (globalReplyTimes.length && t - (typeof globalReplyTimes[0] === "number" ? globalReplyTimes[0] : globalReplyTimes[0].timestamp) >= GLOBAL_WINDOW_MS) globalReplyTimes.shift();
    return globalReplyTimes.length >= GLOBAL_MAX_REPLIES;
  }

  function recordSuccessfulReply({ sourceCommentId, publishedReplyId, userKey, rootId }) {
    // Rate-limit counters (userLastReplyAt/threadReplyTimes/globalReplyTimes) are handled
    // by reserveRateLimitSlot/releaseRateLimitSlot below, reserved *before* the AI/Meta
    // calls to avoid a check-then-act race under concurrent delivery. This function only
    // records the dedupe/idempotency bookkeeping now.
    const t = now();
    if (sourceCommentId) publishedBySource.set(String(sourceCommentId), { publishedReplyId: publishedReplyId || null, timestamp: t });
    if (publishedReplyId) botGeneratedIds.set(String(publishedReplyId), t);
  }

  // Reserves a rate-limit "slot" synchronously (no I/O in between check and reserve),
  // right after the cooldown/limit checks pass and before any AI/Meta network call.
  // This closes the race where multiple concurrent *different* comments could all pass
  // the limit checks before any of them finishes and increments the counters.
  function reserveRateLimitSlot({ userKey, rootId }) {
    const t = now();
    const reservationId = nextReservationId();
    const entry = { reservationId, timestamp: t };
    if (userKey) userLastReplyAt.set(userKey, entry);
    if (rootId) {
      const key = String(rootId);
      const list = (threadReplyTimes.get(key) || []).filter(item => t - (typeof item === "number" ? item : item.timestamp) < THREAD_WINDOW_MS);
      list.push(entry);
      threadReplyTimes.set(key, list);
    }
    globalReplyTimes.push(entry);
    return { userKey, rootId, reservedAt: t, reservationId };
  }

  // Rolls back a slot reserved above, used when the reply attempt turns out not to have
  // happened (validation failure, definitive publish failure, unexpected error). Not
  // called for successful replies, dry-run "would reply", or ambiguous outcomes (those
  // are conservatively kept counted against the limits).
  function releaseRateLimitSlot(reservation) {
    if (!reservation) return;
    const { userKey, rootId, reservationId } = reservation;
    const userEntry = userKey ? userLastReplyAt.get(userKey) : null;
    if (userKey && userEntry && userEntry.reservationId === reservationId) userLastReplyAt.delete(userKey);
    if (rootId) {
      const key = String(rootId);
      const list = (threadReplyTimes.get(key) || []).filter(entry => entry.reservationId !== reservationId);
      threadReplyTimes.set(key, list);
    }
    const idx = globalReplyTimes.findIndex(entry => entry.reservationId === reservationId);
    if (idx !== -1) globalReplyTimes.splice(idx, 1);
  }

  // Marks a comment as having an ambiguous publish outcome (Meta request was sent but the
  // result is unknown - e.g. network error/timeout after dispatch). The comment stays
  // reserved (blocking automatic duplicate processing on webhook redelivery) instead of
  // being released for retry, because retrying could produce a second published reply to
  // the same source comment. Self-heals after IDEMPOTENCY_TTL_MS via the existing prune
  // logic, or can be cleared by a process restart - see audit notes for the residual risk.
  function markAmbiguous(commentId) {
    if (!commentId) return;
    processingComments.set(String(commentId), { timestamp: now(), ambiguous: true });
  }

  function ambiguousCount() {
    let n = 0;
    for (const v of processingComments.values()) {
      if (v && typeof v === "object" && v.ambiguous) n++;
    }
    return n;
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
    reserveRateLimitSlot,
    releaseRateLimitSlot,
    markAmbiguous,
    ambiguousCount,
    recordSuccessfulReply,
  };
}

module.exports = { createSafetyPipeline };
