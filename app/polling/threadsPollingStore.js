const { createClient } = require("redis");

function safeKey(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, "-");
}

function createThreadsPollingStore({
  redisUrl,
  namespace = "astel:threads-poll:v1",
  ttlSeconds = 1209600,
  clientFactory = createClient,
} = {}) {
  let client = null;
  let connected = false;
  let lastError = null;

  const prefix = accountKey => `${namespace}:${safeKey(accountKey)}`;
  const seenKey = accountKey => `${prefix(accountKey)}:seen`;
  const primedKey = accountKey => `${prefix(accountKey)}:primed`;
  const knownPostsKey = accountKey => `${prefix(accountKey)}:posts`;

  async function init() {
    if (connected) return { status: "ok", reason: "ALREADY_CONNECTED" };
    if (!redisUrl) return { status: "failed", reason: "REDIS_URL_MISSING" };
    try {
      client = clientFactory({ url: redisUrl });
      client.on?.("error", error => {
        lastError = error?.message || String(error);
        connected = false;
      });
      await client.connect();
      connected = true;
      lastError = null;
      return { status: "ok", reason: "CONNECTED" };
    } catch (error) {
      lastError = error?.message || String(error);
      connected = false;
      return { status: "failed", reason: "REDIS_CONNECT_FAILED" };
    }
  }

  function requireReady() {
    if (!connected || !client) throw new Error("THREADS_POLL_STORE_UNAVAILABLE");
  }

  async function isPrimed(accountKey) {
    requireReady();
    return (await client.get(primedKey(accountKey))) === "1";
  }

  async function markPrimed(accountKey) {
    requireReady();
    await client.set(primedKey(accountKey), "1", { EX: ttlSeconds });
  }

  async function getSeen(accountKey) {
    requireReady();
    return new Set(await client.sMembers(seenKey(accountKey)));
  }

  async function markSeen(accountKey, ids = []) {
    requireReady();
    const normalized = [...new Set(ids.map(id => String(id || "").trim()).filter(Boolean))];
    if (!normalized.length) return;
    await client.sAdd(seenKey(accountKey), normalized);
    await client.expire(seenKey(accountKey), ttlSeconds);
  }

  async function getKnownPosts(accountKey) {
    requireReady();
    return new Set(await client.sMembers(knownPostsKey(accountKey)));
  }

  async function markKnownPosts(accountKey, ids = []) {
    requireReady();
    const normalized = [...new Set(ids.map(id => String(id || "").trim()).filter(Boolean))];
    if (!normalized.length) return;
    await client.sAdd(knownPostsKey(accountKey), normalized);
    await client.expire(knownPostsKey(accountKey), ttlSeconds);
  }

  function health() {
    return { connected, namespace, ttlSeconds, lastError };
  }

  async function close() {
    if (!client) return;
    try { await client.quit(); } catch (_) {}
    connected = false;
  }

  return {
    init,
    isPrimed,
    markPrimed,
    getSeen,
    markSeen,
    getKnownPosts,
    markKnownPosts,
    health,
    close,
  };
}

module.exports = { createThreadsPollingStore };
