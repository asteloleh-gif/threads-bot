const fetch = require("node-fetch");

const DEFAULT_BASE_URL = "https://graph.threads.net";
const DEFAULT_API_VERSION = "v1.0";
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_REPLY_FIELDS = Object.freeze([
  "id",
  "text",
  "timestamp",
  "media_product_type",
  "media_type",
  "permalink",
  "shortcode",
  "username",
  "is_quote_post",
  "has_replies",
  "is_reply",
  "is_reply_owned_by_me",
  "root_post",
  "replied_to",
]);

function createThreadsPollingReader({
  tokenManager,
  fallbackAccessToken = "",
  fetchImpl = fetch,
  baseUrl = DEFAULT_BASE_URL,
  apiVersion = DEFAULT_API_VERSION,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  baseUrl = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  apiVersion = String(apiVersion || DEFAULT_API_VERSION).replace(/^\/+|\/+$/g, "");
  const endpoint = path => `${baseUrl}/${apiVersion}/${String(path || "").replace(/^\/+/, "")}`;
  const getToken = () => tokenManager?.getToken?.() || String(fallbackAccessToken || "").trim();

  async function listConversation(threadId, { limit = 50, reverse = false } = {}) {
    const token = getToken();
    if (!token || !threadId) return { status: "failed", reason: "TOKEN_OR_THREAD_MISSING", code: null, items: [] };
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 50));
    const query = new URLSearchParams({
      fields: DEFAULT_REPLY_FIELDS.join(","),
      limit: String(safeLimit),
      reverse: reverse ? "true" : "false",
    });
    const url = `${endpoint(`${encodeURIComponent(threadId)}/conversation`)}?${query}`;

    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        timeout: timeoutMs,
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (error) {
      return { status: "failed", reason: "NETWORK_ERROR", code: null, items: [] };
    }

    let data = null;
    try { data = await response.json(); } catch (_) {}
    if (!response.ok || data?.error) {
      return {
        status: "failed",
        reason: "META_REJECTED",
        code: data?.error?.code || null,
        httpStatus: response.status,
        items: [],
      };
    }

    return { status: "ok", reason: null, code: null, items: Array.isArray(data?.data) ? data.data : [] };
  }

  return {
    listConversation,
    config: Object.freeze({ baseUrl, apiVersion }),
  };
}

module.exports = { DEFAULT_REPLY_FIELDS, createThreadsPollingReader };
