const { createClient } = require("redis");

function safeKeyPart(value) {
  return encodeURIComponent(String(value));
}

function createRedisQuotaStore({
  redisUrl,
  namespace = "astel:ai-budget:v1",
  clientFactory = createClient,
  clock = () => Date.now(),
} = {}) {
  let client = null;
  let lastError = null;

  async function init() {
    if (!redisUrl) return { ready: false, reason: "REDIS_URL_MISSING" };
    client = clientFactory({ url: redisUrl });
    client.on?.("error", error => {
      lastError = error?.message || String(error);
      console.error("AI quota Redis error", lastError);
    });
    await client.connect();
    await client.ping();
    lastError = null;
    return { ready: true };
  }

  function isReady() {
    return Boolean(client?.isReady);
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

    const key = `${namespace}:quota:${scope}:${period(scope)}:${safeKeyPart(kind)}`;
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
      const result = await client.eval(script, {
        keys: [key],
        arguments: [String(amount), String(maximum), String(ttl)],
      });
      return { granted: Number(result?.[0] || 0), remaining: Number(result?.[1] || 0) };
    } catch (error) {
      lastError = error?.message || String(error);
      return { granted: 0, reason: "STORE_ERROR" };
    }
  }

  async function close() {
    if (client?.isOpen) await client.quit();
    client = null;
  }

  function health() {
    return { connected: isReady(), configured: Boolean(redisUrl), namespace, lastError };
  }

  return { init, isReady, takeQuota, close, health };
}

module.exports = { createRedisQuotaStore };
