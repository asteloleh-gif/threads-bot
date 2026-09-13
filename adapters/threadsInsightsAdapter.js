const fetch = require("node-fetch");

const DEFAULT_BASE_URL = "https://graph.threads.net";
const DEFAULT_API_VERSION = "v1.0";
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_POST_METRICS = Object.freeze(["views", "likes", "replies", "reposts", "quotes", "shares"]);
const DEFAULT_ACCOUNT_METRICS = Object.freeze(["views", "likes", "replies", "reposts", "quotes", "followers_count"]);
const DEFAULT_POST_FIELDS = Object.freeze([
  "id", "media_product_type", "media_type", "permalink", "username", "text", "timestamp", "shortcode", "is_quote_post", "has_replies",
]);

function finiteNumber(value) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function extractInsightValue(item) {
  const total = finiteNumber(item?.total_value?.value);
  if (total != null) return total;
  const values = Array.isArray(item?.values) ? item.values : [];
  for (let i = values.length - 1; i >= 0; i -= 1) {
    const value = finiteNumber(values[i]?.value);
    if (value != null) return value;
  }
  return null;
}

function normalizeInsightData(data = []) {
  const metrics = {};
  const periods = {};
  for (const item of Array.isArray(data) ? data : []) {
    const name = String(item?.name || "").trim();
    if (!name) continue;
    const value = extractInsightValue(item);
    if (value == null) continue;
    metrics[name] = value;
    periods[name] = item?.period || null;
  }
  return { metrics, periods };
}

function createThreadsInsightsAdapter({
  tokenManager,
  fallbackAccessToken = "",
  fetchImpl = fetch,
  baseUrl = DEFAULT_BASE_URL,
  apiVersion = DEFAULT_API_VERSION,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  baseUrl = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  apiVersion = String(apiVersion || DEFAULT_API_VERSION).replace(/^\/+|\/+$/g, "");

  const getToken = () => tokenManager?.getToken?.() || String(fallbackAccessToken || "").trim();
  const endpoint = path => `${baseUrl}/${apiVersion}/${String(path || "").replace(/^\/+/, "")}`;

  async function requestJson(path, params = {}) {
    const token = getToken();
    if (!token) return { status: "failed", reason: "TOKEN_MISSING", httpStatus: null, data: null };
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value == null || value === "") continue;
      query.set(key, String(value));
    }
    const url = `${endpoint(path)}${query.size ? `?${query}` : ""}`;
    let response;
    try {
      response = await fetchImpl(url, {
        method: "GET",
        timeout: timeoutMs,
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (error) {
      return { status: "failed", reason: "NETWORK_ERROR", httpStatus: null, data: null, error: error?.message || String(error) };
    }
    let data = null;
    try { data = await response.json(); } catch (_) {}
    if (!response.ok || data?.error) {
      return {
        status: "failed",
        reason: "META_REJECTED",
        httpStatus: response.status,
        code: data?.error?.code || null,
        data: null,
      };
    }
    return { status: "ok", reason: null, httpStatus: response.status, data };
  }

  async function getPostInsights(postId, { metrics = DEFAULT_POST_METRICS } = {}) {
    if (!postId) return { status: "failed", reason: "POST_ID_MISSING", metrics: {} };
    const result = await requestJson(`${encodeURIComponent(postId)}/insights`, { metric: metrics.join(",") });
    if (result.status !== "ok") return { ...result, metrics: {} };
    const normalized = normalizeInsightData(result.data?.data);
    return { status: "ok", metrics: normalized.metrics, periods: normalized.periods };
  }

  async function getAccountInsights({ metrics = DEFAULT_ACCOUNT_METRICS } = {}) {
    const result = await requestJson("me/threads_insights", { metric: metrics.join(",") });
    if (result.status !== "ok") return { ...result, metrics: {} };
    const normalized = normalizeInsightData(result.data?.data);
    return { status: "ok", metrics: normalized.metrics, periods: normalized.periods };
  }

  async function listRecentPosts({ limit = 25, since = null } = {}) {
    const safeLimit = Math.max(1, Math.min(50, Number(limit) || 25));
    const result = await requestJson("me/threads", {
      fields: DEFAULT_POST_FIELDS.join(","),
      limit: safeLimit,
      since,
    });
    if (result.status !== "ok") return { ...result, posts: [] };
    const posts = (Array.isArray(result.data?.data) ? result.data.data : [])
      .filter(item => item?.id)
      .map(item => ({
        id: String(item.id),
        text: item.text == null ? null : String(item.text),
        contentType: item.media_type ? String(item.media_type).toLowerCase() : "unknown",
        permalink: item.permalink || null,
        publishedAt: item.timestamp || null,
        metadata: {
          mediaProductType: item.media_product_type || null,
          username: item.username || null,
          shortcode: item.shortcode || null,
          isQuotePost: Boolean(item.is_quote_post),
          hasReplies: Boolean(item.has_replies),
        },
      }));
    return { status: "ok", posts };
  }

  return {
    getPostInsights,
    getAccountInsights,
    listRecentPosts,
    config: Object.freeze({ baseUrl, apiVersion }),
  };
}

module.exports = {
  DEFAULT_POST_METRICS,
  DEFAULT_ACCOUNT_METRICS,
  normalizeInsightData,
  createThreadsInsightsAdapter,
};
