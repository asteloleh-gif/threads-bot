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

  async function close() {
    if (client?.isOpen) await client.quit();
    client = null;
  }

  return { init, isReady, claim, close };
}

module.exports = { createCandidateRepository };
