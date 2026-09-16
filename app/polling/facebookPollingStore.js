const { createClient } = require("redis");

function safeKey(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, "-");
}

function createFacebookPollingStore({
  redisUrl,
  namespace = "astel:facebook-poll:v1",
  ttlSeconds = 1209600,
  clientFactory = createClient,
} = {}) {
  let client = null;
  let connected = false;
  let lastError = null;

  function accountPrefix(accountKey) {
    return `${namespace}:${safeKey(accountKey)}`;
  }

  function seenKey(accountKey) {
    return `${accountPrefix(accountKey)}:seen`;
  }

  function primedKey(accountKey) {
    return `${accountPrefix(accountKey)}:primed`;
  }

  function postCountsKey(accountKey) {
    return `${accountPrefix(accountKey)}:post-counts`;
  }

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
    if (!connected || !client) throw new Error("FACEBOOK_POLL_STORE_UNAVAILABLE");
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

  async function getPostCounts(accountKey) {
    requireReady();
    const values = await client.hGetAll(postCountsKey(accountKey));
    return Object.fromEntries(Object.entries(values || {}).map(([key, value]) => [key, Number(value) || 0]));
  }

  async function setPostCounts(accountKey, counts = {}) {
    requireReady();
    const entries = Object.entries(counts).filter(([key]) => key);
    if (!entries.length) return;
    const payload = Object.fromEntries(entries.map(([key, value]) => [String(key), String(Math.max(0, Number(value) || 0))]));
    await client.hSet(postCountsKey(accountKey), payload);
    await client.expire(postCountsKey(accountKey), ttlSeconds);
  }

  function health() {
    return {
      connected,
      namespace,
      ttlSeconds,
      lastError,
    };
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
    getPostCounts,
    setPostCounts,
    health,
    close,
  };
}

module.exports = { createFacebookPollingStore };
