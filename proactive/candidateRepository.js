const { createClient } = require("redis");

function safeKeyPart(value) {
  return encodeURIComponent(String(value));
}

function createCandidateRepository({
  redisUrl,
  namespace = "astel:proactive:v1",
  ttlSeconds = 72 * 60 * 60,
  clientFactory = createClient,
  clock = () => Date.now(),
} = {}) {
  let client = null;

  async function init() {
    if (!redisUrl) return { ready: false, reason: "REDIS_URL_MISSING" };
    client = clientFactory({ url: redisUrl });
    client.on?.("error", error => console.error("Proactive candidate Redis error", error?.message || String(error)));
    await client.connect();
    await client.ping();
    return { ready: true };
  }

  function isReady() {
    return Boolean(client?.isReady);
  }

  async function claim(candidate, { monitorId, language } = {}) {
    if (!isReady()) return { claimed: false, reason: "STORE_UNAVAILABLE" };
    if (!candidate?.source || !candidate?.sourcePostId) return { claimed: false, reason: "INVALID_CANDIDATE" };

    const key = `${namespace}:seen:${safeKeyPart(candidate.source)}:${safeKeyPart(candidate.sourcePostId)}`;
    const value = JSON.stringify({
      source: candidate.source,
      sourcePostId: String(candidate.sourcePostId),
      monitorId: monitorId || null,
      language: language || null,
      observedAt: new Date(clock()).toISOString(),
    });
    try {
      const result = await client.set(key, value, { NX: true, EX: ttlSeconds });
      return result === "OK" ? { claimed: true } : { claimed: false, reason: "DUPLICATE" };
    } catch (_) {
      return { claimed: false, reason: "STORE_ERROR" };
    }
  }

  function period(scope) {
    const date = new Date(clock());
    return scope === "month" ? date.toISOString().slice(0, 7) : date.toISOString().slice(0, 10);
  }

  async function takeQuota(kind, requested, limit, { scope = "day" } = {}) {
    if (!isReady()) return { granted: 0, reason: "STORE_UNAVAILABLE" };
    const amount = Math.max(0, Math.floor(Number(requested) || 0));
    const maximum = Math.max(0, Math.floor(Number(limit) || 0));
    if (!amount || !maximum) return { granted: 0, remaining: maximum };
    const quotaKey = `${namespace}:quota:${scope}:${period(scope)}:${safeKeyPart(kind)}`;
    const ttl = scope === "month" ? 40 * 86400 : 2 * 86400;
    const script = `
      local current = tonumber(redis.call('GET', KEYS[1]) or '0')
      local requested = tonumber(ARGV[1])
      local maximum = tonumber(ARGV[2])
      local granted = math.min(requested, math.max(0, maximum - current))
      if granted > 0 then
        redis.call('INCRBY', KEYS[1], granted)
        redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
      end
      return {granted, maximum - current - granted}
    `;
    try {
      const result = await client.eval(script, { keys: [quotaKey], arguments: [String(amount), String(maximum), String(ttl)] });
      return { granted: Number(result?.[0] || 0), remaining: Number(result?.[1] || 0) };
    } catch (_) {
      return { granted: 0, reason: "STORE_ERROR" };
    }
  }

  const pendingSetKey = `${namespace}:approval:pending`;
  const pendingKey = id => `${namespace}:approval:item:${safeKeyPart(id)}`;

  async function savePending(item) {
    if (!isReady() || !item?.draftId || !item?.postId || !item?.text) return false;
    const value = JSON.stringify({ ...item, savedAt: clock() });
    try {
      await client.multi().set(pendingKey(item.draftId), value, { EX: ttlSeconds }).sAdd(pendingSetKey, String(item.draftId)).exec();
      return true;
    } catch (_) { return false; }
  }

  async function listPending(limit = 50) {
    if (!isReady()) return [];
    try {
      const ids = (await client.sMembers(pendingSetKey)).slice(0, limit);
      if (!ids.length) return [];
      const values = await client.mGet(ids.map(pendingKey));
      const missing = [];
      const items = values.map((value, index) => {
        if (!value) { missing.push(ids[index]); return null; }
        try { return JSON.parse(value); } catch (_) { missing.push(ids[index]); return null; }
      }).filter(Boolean);
      if (missing.length) await client.sRem(pendingSetKey, missing);
      return items;
    } catch (_) { return []; }
  }

  async function finishPending(draftId, outcome) {
    if (!isReady()) return false;
    try {
      await client.multi()
        .sRem(pendingSetKey, String(draftId))
        .del(pendingKey(draftId))
        .set(`${namespace}:approval:outcome:${safeKeyPart(draftId)}`, JSON.stringify({ ...outcome, at: clock() }), { EX: 7 * 86400 })
        .exec();
      return true;
    } catch (_) { return false; }
  }

  async function claimPublish(draftId) {
    if (!isReady()) return false;
    try {
      return (await client.set(`${namespace}:publish:${safeKeyPart(draftId)}`, "1", { NX: true, EX: 7 * 86400 })) === "OK";
    } catch (_) { return false; }
  }

  async function close() {
    if (client?.isOpen) await client.quit();
    client = null;
  }

  return { init, isReady, claim, takeQuota, savePending, listPending, finishPending, claimPublish, close };
}

module.exports = { createCandidateRepository };
