const { createClient } = require("redis");

function createSafetyPipeline({
  threadsUserId,
  selfUsername = "leoakastel",
  selfUserId = "27979923121676296",
  botEnabled = "false",
  botDryRun = "true",
  redisUrl = process.env.REDIS_URL,
  policy,
  namespace = "astel:v91",
}) {
  const p = policy || {
    normalReplyLimit: 3,
    cooldownSeconds: 20,
    conversationResetHours: 24,
    globalDailyLimit: 50,
    redisRequired: true,
  };
  const CONVERSATION_WINDOW_MS = p.conversationResetHours * 60 * 60 * 1000;
  const GLOBAL_WINDOW_MS = 24 * 60 * 60 * 1000;
  const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
  const COOLDOWN_MS = p.cooldownSeconds * 1000;
  const ttlSeconds = Math.ceil(IDEMPOTENCY_TTL_MS / 1000);
  const zsetTtlSeconds = Math.ceil(Math.max(CONVERSATION_WINDOW_MS, GLOBAL_WINDOW_MS, IDEMPOTENCY_TTL_MS) / 1000) + 3600;

  let client = null;
  let ready = false;
  let lastError = null;
  const normalizeUsername = v => String(v || "").trim().replace(/^@/, "").toLowerCase();
  const isEnabled = () => String(botEnabled).toLowerCase() === "true";
  const isDryRun = () => String(botDryRun).toLowerCase() === "true";
  const keySafe = v => encodeURIComponent(String(v || ""));
  const sourceKey = id => `${namespace}:source:${keySafe(id)}`;
  const botKey = id => `${namespace}:bot:${keySafe(id)}`;
  const convSuccessKey = ck => `${namespace}:conv:${keySafe(ck)}:success`;
  const convPendingKey = ck => `${namespace}:conv:${keySafe(ck)}:pending`;
  const cooldownKey = ck => `${namespace}:conv:${keySafe(ck)}:cooldown`;
  const globalSuccessKey = `${namespace}:global:success`;
  const globalPendingKey = `${namespace}:global:pending`;
  const ambiguousKey = `${namespace}:ambiguous`;

  async function init() {
    if (!redisUrl) {
      lastError = "REDIS_URL missing";
      if (p.redisRequired) throw new Error(lastError);
      return false;
    }
    client = createClient({ url: redisUrl });
    client.on("error", err => {
      ready = false;
      lastError = err?.message || String(err);
      console.error("Redis error:", lastError);
    });
    client.on("ready", () => { ready = true; lastError = null; });
    client.on("end", () => { ready = false; });
    await client.connect();
    await client.ping();
    ready = true;
    console.log("Redis safety connected", JSON.stringify({ namespace }));
    return true;
  }

  function assertReady() {
    if (!client || !ready) throw new Error(`Redis safety unavailable${lastError ? `: ${lastError}` : ""}`);
  }

  function isReady() { return ready; }
  function health() { return { connected: ready, required: !!p.redisRequired, lastError }; }
  function isSelfAuthored({ authorId, authorUsername }) {
    const u = normalizeUsername(authorUsername);
    return u === normalizeUsername(selfUsername) ||
      (authorId && String(authorId) === String(selfUserId)) ||
      (authorId && threadsUserId && String(authorId) === String(threadsUserId));
  }
  function getUserKey({ authorId, authorUsername }) {
    if (authorId) return `id:${String(authorId)}`;
    const u = normalizeUsername(authorUsername);
    return u ? `username:${u}` : null;
  }
  function getConversationKey({ userKey, rootId }) {
    return userKey && rootId ? `${userKey}|thread:${String(rootId)}` : null;
  }

  async function getSourceStatus(commentId) {
    assertReady();
    return commentId ? client.get(sourceKey(commentId)) : null;
  }
  async function isBotGeneratedId(id) {
    assertReady();
    return id ? (await client.exists(botKey(id))) === 1 : false;
  }
  async function markBotGeneratedId(id) {
    assertReady();
    if (id) await client.set(botKey(id), "1", { EX: ttlSeconds });
  }
  async function getConversationReplyCount(conversationKey) {
    assertReady();
    if (!conversationKey) return p.normalReplyLimit;
    const now = Date.now();
    const key = convSuccessKey(conversationKey);
    await client.zRemRangeByScore(key, 0, now - CONVERSATION_WINDOW_MS);
    return client.zCard(key);
  }
  async function ambiguousCount() {
    assertReady();
    const now = Date.now();
    await client.zRemRangeByScore(ambiguousKey, 0, now - IDEMPOTENCY_TTL_MS);
    return client.zCard(ambiguousKey);
  }

  const RESERVE_SCRIPT = `
local source = KEYS[1]
local cooldown = KEYS[2]
local convSuccess = KEYS[3]
local convPending = KEYS[4]
local globalSuccess = KEYS[5]
local globalPending = KEYS[6]
local now = tonumber(ARGV[1])
local convCutoff = tonumber(ARGV[2])
local globalCutoff = tonumber(ARGV[3])
local convLimit = tonumber(ARGV[4])
local globalLimit = tonumber(ARGV[5])
local cooldownMs = tonumber(ARGV[6])
local reservationId = ARGV[7]
local ttl = tonumber(ARGV[8])
local zttl = tonumber(ARGV[9])

if redis.call('EXISTS', source) == 1 then return {'DENY','DUPLICATE','0'} end
redis.call('ZREMRANGEBYSCORE', convSuccess, 0, convCutoff)
redis.call('ZREMRANGEBYSCORE', convPending, 0, convCutoff)
redis.call('ZREMRANGEBYSCORE', globalSuccess, 0, globalCutoff)
redis.call('ZREMRANGEBYSCORE', globalPending, 0, globalCutoff)
local convCount = redis.call('ZCARD', convSuccess) + redis.call('ZCARD', convPending)
if convCount >= convLimit then return {'DENY','NORMAL_LIMIT_REACHED',tostring(convCount)} end
local globalCount = redis.call('ZCARD', globalSuccess) + redis.call('ZCARD', globalPending)
if globalCount >= globalLimit then return {'DENY','GLOBAL_LIMIT_REACHED',tostring(globalCount)} end
if cooldownMs > 0 and redis.call('EXISTS', cooldown) == 1 then return {'DENY','COOLDOWN_ACTIVE',tostring(convCount)} end
redis.call('SET', source, 'RESERVED:' .. reservationId, 'EX', ttl)
if cooldownMs > 0 then redis.call('SET', cooldown, reservationId, 'PX', cooldownMs) end
redis.call('ZADD', convPending, now, reservationId)
redis.call('ZADD', globalPending, now, reservationId)
redis.call('EXPIRE', convSuccess, zttl)
redis.call('EXPIRE', convPending, zttl)
redis.call('EXPIRE', globalSuccess, zttl)
redis.call('EXPIRE', globalPending, zttl)
return {'ALLOW','RESERVED',tostring(convCount + 1)}
`;

  async function reserve({ commentId, conversationKey }) {
    assertReady();
    if (!commentId || !conversationKey) return { allowed: false, reason: "INVALID_RESERVATION" };
    const now = Date.now();
    const reservationId = `${now}-${Math.random().toString(36).slice(2, 12)}`;
    const result = await client.eval(RESERVE_SCRIPT, {
      keys: [
        sourceKey(commentId), cooldownKey(conversationKey),
        convSuccessKey(conversationKey), convPendingKey(conversationKey),
        globalSuccessKey, globalPendingKey,
      ],
      arguments: [
        String(now), String(now - CONVERSATION_WINDOW_MS), String(now - GLOBAL_WINDOW_MS),
        String(p.normalReplyLimit), String(p.globalDailyLimit), String(COOLDOWN_MS),
        reservationId, String(ttlSeconds), String(zsetTtlSeconds),
      ],
    });
    const [decision, reason, replyNumber] = result || [];
    if (decision !== "ALLOW") return { allowed: false, reason: reason || "RESERVATION_DENIED", replyNumber: Number(replyNumber || 0) };
    return { allowed: true, reason: "RESERVED", replyNumber: Number(replyNumber || 1), reservationId, commentId: String(commentId), conversationKey };
  }

  const COMMIT_SCRIPT = `
local source = KEYS[1]
local convPending = KEYS[2]
local convSuccess = KEYS[3]
local globalPending = KEYS[4]
local globalSuccess = KEYS[5]
local bot = KEYS[6]
local ambiguous = KEYS[7]
local expected = 'RESERVED:' .. ARGV[1]
local current = redis.call('GET', source)
if current ~= expected then return 0 end
redis.call('ZREM', convPending, ARGV[1])
redis.call('ZREM', globalPending, ARGV[1])
redis.call('ZADD', convSuccess, ARGV[2], ARGV[1])
redis.call('ZADD', globalSuccess, ARGV[2], ARGV[1])
redis.call('SET', source, 'PUBLISHED:' .. ARGV[3], 'EX', ARGV[4])
if ARGV[3] ~= '' then redis.call('SET', bot, '1', 'EX', ARGV[4]) end
redis.call('ZREM', ambiguous, ARGV[1])
return 1
`;

  async function commitSuccess(reservation, publishedReplyId) {
    assertReady();
    if (!reservation?.reservationId) return false;
    const now = Date.now();
    const result = await client.eval(COMMIT_SCRIPT, {
      keys: [
        sourceKey(reservation.commentId), convPendingKey(reservation.conversationKey), convSuccessKey(reservation.conversationKey),
        globalPendingKey, globalSuccessKey, botKey(publishedReplyId || "none"), ambiguousKey,
      ],
      arguments: [reservation.reservationId, String(now), String(publishedReplyId || ""), String(ttlSeconds)],
    });
    return Number(result) === 1;
  }

  const ROLLBACK_SCRIPT = `
local source = KEYS[1]
local cooldown = KEYS[2]
local convPending = KEYS[3]
local globalPending = KEYS[4]
local expected = 'RESERVED:' .. ARGV[1]
if redis.call('GET', source) ~= expected then return 0 end
redis.call('ZREM', convPending, ARGV[1])
redis.call('ZREM', globalPending, ARGV[1])
if redis.call('GET', cooldown) == ARGV[1] then redis.call('DEL', cooldown) end
redis.call('DEL', source)
return 1
`;

  async function rollback(reservation) {
    assertReady();
    if (!reservation?.reservationId) return false;
    const result = await client.eval(ROLLBACK_SCRIPT, {
      keys: [sourceKey(reservation.commentId), cooldownKey(reservation.conversationKey), convPendingKey(reservation.conversationKey), globalPendingKey],
      arguments: [reservation.reservationId],
    });
    return Number(result) === 1;
  }

  const AMBIGUOUS_SCRIPT = `
local source = KEYS[1]
local ambiguous = KEYS[2]
local expected = 'RESERVED:' .. ARGV[1]
if redis.call('GET', source) ~= expected then return 0 end
redis.call('SET', source, 'AMBIGUOUS:' .. ARGV[1], 'EX', ARGV[3])
redis.call('ZADD', ambiguous, ARGV[2], ARGV[1])
redis.call('EXPIRE', ambiguous, ARGV[3])
return 1
`;

  async function markAmbiguous(reservation) {
    assertReady();
    if (!reservation?.reservationId) return false;
    const result = await client.eval(AMBIGUOUS_SCRIPT, {
      keys: [sourceKey(reservation.commentId), ambiguousKey],
      arguments: [reservation.reservationId, String(Date.now()), String(ttlSeconds)],
    });
    return Number(result) === 1;
  }

  async function quit() {
    if (client?.isOpen) await client.quit();
    ready = false;
  }

  return {
    init, quit, health, isReady, isEnabled, isDryRun, isSelfAuthored,
    getUserKey, getConversationKey, getSourceStatus, isBotGeneratedId, markBotGeneratedId,
    getConversationReplyCount, reserve, commitSuccess, rollback, markAmbiguous, ambiguousCount,
    limits: {
      USER_COOLDOWN_MS: COOLDOWN_MS,
      CONVERSATION_WINDOW_MS,
      CONVERSATION_MAX_REPLIES: p.normalReplyLimit,
      GLOBAL_WINDOW_MS,
      GLOBAL_MAX_REPLIES: p.globalDailyLimit,
    },
  };
}

module.exports = { createSafetyPipeline };
