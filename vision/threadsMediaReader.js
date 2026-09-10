const fetch = require("node-fetch");

const DEFAULT_TIMEOUT_MS = 12000;
// Use fields documented for reply media objects. `user_id` is intentionally omitted:
// it is not part of the Threads reply-media field set and caused Meta to return 500
// for real reply IDs in production.
const DETAILS_FIELDS = [
  "id",
  "text",
  "username",
  "media_type",
  "media_url",
  "thumbnail_url",
  "alt_text",
  "root_post",
  "replied_to",
].join(",");

function createThreadsMediaReader({ tokenManager, fallbackToken, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const getAccessToken = () => tokenManager?.getToken?.() || fallbackToken || null;

  async function getPostDetails(threadId) {
    const token = getAccessToken();
    if (!threadId) return { ok: false, reason: "THREAD_ID_MISSING" };
    if (!token) return { ok: false, reason: "THREADS_TOKEN_MISSING" };

    const params = new URLSearchParams({ fields: DETAILS_FIELDS, access_token: token });
    const url = `https://graph.threads.net/v1.0/${encodeURIComponent(String(threadId))}?${params}`;

    let lastStatus = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetch(url, { method: "GET", timeout: Number(timeoutMs) || DEFAULT_TIMEOUT_MS });
        lastStatus = res.status;
        let data = null;
        try { data = await res.json(); } catch (_) {}
        if (res.ok && !data?.error) return { ok: true, data };
        if (res.status !== 429 && res.status < 500) {
          return { ok: false, reason: "THREADS_DETAILS_API_ERROR", status: res.status, code: data?.error?.code || null };
        }
      } catch (_) {
        if (attempt === 2) return { ok: false, reason: "THREADS_DETAILS_TRANSPORT_ERROR" };
      }
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 400 + Math.floor(Math.random() * 150)));
    }
    return { ok: false, reason: "THREADS_DETAILS_API_ERROR", status: lastStatus };
  }

  return { getPostDetails };
}

module.exports = { createThreadsMediaReader, DETAILS_FIELDS };
