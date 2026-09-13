const { createClient } = require("redis");

function safeKeyPart(value) {
  return encodeURIComponent(String(value));
}

function createContentControlStore({
  redisUrl,
  namespace = "astel:content-control:v1",
  ttlSeconds = 86400,
  clientFactory = createClient,
} = {}) {
  let client = null;
  let lastError = null;

  async function init() {
    if (!redisUrl) return { ready: false, reason: "REDIS_URL_MISSING" };
    client = clientFactory({ url: redisUrl });
    client.on?.("error", error => {
      lastError = error?.message || String(error);
      console.error("Content control Redis error", lastError);
    });
    await client.connect();
    await client.ping();
    lastError = null;
    return { ready: true };
  }

  function isReady() {
    return Boolean(client?.isReady);
  }

  function key(operation, idempotencyKey) {
    return `${namespace}:idem:${safeKeyPart(operation)}:${safeKeyPart(idempotencyKey)}`;
  }

  async function begin(operation, idempotencyKey) {
    if (!isReady()) return { claimed: false, reason: "STORE_UNAVAILABLE" };
    try {
      const redisKey = key(operation, idempotencyKey);
      const payload = JSON.stringify({ status: "PROCESSING", startedAt: new Date().toISOString() });
      const result = await client.set(redisKey, payload, { NX: true, EX: ttlSeconds });
      if (result === "OK") return { claimed: true };
      const existing = await get(operation, idempotencyKey);
      return { claimed: false, reason: "DUPLICATE", existing };
    } catch (error) {
      lastError = error?.message || String(error);
      return { claimed: false, reason: "STORE_ERROR" };
    }
  }

  async function get(operation, idempotencyKey) {
    if (!isReady()) return null;
    try {
      const raw = await client.get(key(operation, idempotencyKey));
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (error) {
      lastError = error?.message || String(error);
      return null;
    }
  }

  async function complete(operation, idempotencyKey, result) {
    if (!isReady()) return false;
    try {
      const payload = JSON.stringify({
        status: "COMPLETED",
        completedAt: new Date().toISOString(),
        result,
      });
      await client.set(key(operation, idempotencyKey), payload, { EX: ttlSeconds });
      return true;
    } catch (error) {
      lastError = error?.message || String(error);
      return false;
    }
  }

  async function fail(operation, idempotencyKey, reason = "OPERATION_FAILED") {
    if (!isReady()) return false;
    try {
      const payload = JSON.stringify({
        status: "FAILED",
        failedAt: new Date().toISOString(),
        reason: String(reason || "OPERATION_FAILED").slice(0, 160),
      });
      await client.set(key(operation, idempotencyKey), payload, { EX: ttlSeconds });
      return true;
    } catch (error) {
      lastError = error?.message || String(error);
      return false;
    }
  }

  async function close() {
    if (client?.isOpen) await client.quit();
    client = null;
  }

  function health() {
    return {
      connected: isReady(),
      configured: Boolean(redisUrl),
      namespace,
      ttlSeconds,
      lastError,
    };
  }

  return { init, isReady, begin, get, complete, fail, close, health };
}

module.exports = { createContentControlStore };
