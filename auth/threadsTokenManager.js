const fetch = require("node-fetch");
const { createClient } = require("redis");
const { createHash } = require("node:crypto");

const DEFAULT_CHECK_MS = 24 * 60 * 60 * 1000;
const DEFAULT_REFRESH_AFTER_DAYS = 50;
const TOKEN_KEY = "astel:v91:auth:threads:token";
const REFRESHED_AT_KEY = "astel:v91:auth:threads:refreshed-at";
const CONFIG_TOKEN_HASH_KEY = "astel:v91:auth:threads:config-token-hash";

function createThreadsTokenManager({ initialToken, redisUrl, checkIntervalMs = DEFAULT_CHECK_MS, refreshAfterDays = DEFAULT_REFRESH_AFTER_DAYS, clientFactory = createClient } = {}) {
  let currentToken = initialToken || "";
  let client = null, timer = null, running = false;
  function getToken() { return currentToken; }

  async function init() {
    if (!redisUrl) { console.warn("Threads token manager disabled: REDIS_URL missing"); return; }
    client = clientFactory({ url: redisUrl });
    client.on("error", e => console.error("Threads token manager Redis error", e?.message || String(e)));
    await client.connect();
    const stored = await client.get(TOKEN_KEY);
    const fingerprint = initialToken ? createHash("sha256").update(initialToken).digest("hex") : null;
    const previousFingerprint = await client.get(CONFIG_TOKEN_HASH_KEY);
    if (fingerprint && fingerprint !== previousFingerprint) {
      // An explicit configuration replacement wins once. Subsequent restarts retain
      // the refreshed Redis token while the configured token remains unchanged.
      await client.multi()
        .set(TOKEN_KEY, initialToken)
        .set(CONFIG_TOKEN_HASH_KEY, fingerprint)
        .set(REFRESHED_AT_KEY, String(Date.now()))
        .exec();
      currentToken = initialToken;
    } else if (stored) currentToken = stored;
    else if (currentToken) await client.set(TOKEN_KEY, currentToken);
    if (!(await client.get(REFRESHED_AT_KEY))) await client.set(REFRESHED_AT_KEY, String(Date.now()));
    console.log("Threads token manager connected", JSON.stringify({ refreshAfterDays, checkHours: Math.round(checkIntervalMs / 3600000) }));
    timer = setInterval(() => { maybeRefresh().catch(e => console.error("Threads token refresh check failed", e?.message || String(e))); }, checkIntervalMs);
    if (timer.unref) timer.unref();
  }

  async function maybeRefresh({ force = false } = {}) {
    if (running || !client || !currentToken) return { refreshed: false, reason: running ? "BUSY" : "NOT_READY" };
    running = true;
    try {
      const last = Number((await client.get(REFRESHED_AT_KEY)) || 0);
      const thresholdMs = refreshAfterDays * 86400000;
      if (!force && last > 0 && Date.now() - last < thresholdMs) return { refreshed: false, reason: "NOT_DUE" };
      const oldToken = currentToken;
      const params = new URLSearchParams({ grant_type: "th_refresh_token", access_token: oldToken });
      const res = await fetch(`https://graph.threads.net/refresh_access_token?${params}`, { method: "GET", timeout: 20000 });
      let data = null; const raw = await res.text();
      if (raw) { try { data = JSON.parse(raw); } catch (_) {} }
      if (!res.ok || data?.error) {
        console.error("Threads token refresh failed", JSON.stringify({ status: res.status, code: data?.error?.code || null }));
        return { refreshed: false, reason: "REFRESH_FAILED", status: res.status };
      }
      const nextToken = data?.access_token || oldToken;
      const rotated = nextToken !== oldToken;
      await client.set(TOKEN_KEY, nextToken);
      await client.set(REFRESHED_AT_KEY, String(Date.now()));
      currentToken = nextToken;
      console.log("Threads token refreshed", JSON.stringify({ ok: true, rotated, expiresIn: data?.expires_in || null }));
      return { refreshed: true, rotated, expiresIn: data?.expires_in || null };
    } finally { running = false; }
  }

  async function close() {
    if (timer) clearInterval(timer);
    timer = null;
    if (client?.isOpen) await client.quit();
    client = null;
  }
  return { init, getToken, maybeRefresh, close };
}

module.exports = { createThreadsTokenManager, TOKEN_KEY, REFRESHED_AT_KEY, CONFIG_TOKEN_HASH_KEY };
