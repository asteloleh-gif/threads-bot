const fetch = require("node-fetch");

const DEFAULT_BASE_URL = "https://graph.threads.net/v1.0";
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_FIELDS = "id,text,timestamp,username,permalink,media_type";
const SEARCH_TYPES = new Set(["TOP", "RECENT"]);
const SEARCH_MODES = new Set(["KEYWORD", "TAG"]);

function parseRetryAfter(value, now = Date.now()) {
  if (value == null || value === "") return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return null;
  return Math.max(0, Math.ceil((date - now) / 1000));
}

function normalizePost(post) {
  if (!post?.id) return null;
  return Object.freeze({
    source: "threads",
    sourcePostId: String(post.id),
    authorId: post.user_id == null ? null : String(post.user_id),
    authorUsername: post.username || null,
    text: typeof post.text === "string" ? post.text : "",
    createdAt: post.timestamp || null,
    permalink: post.permalink || null,
    mediaType: post.media_type || null,
  });
}

async function readJson(response) {
  try {
    return await response.json();
  } catch (_) {
    return null;
  }
}

function createThreadsDiscoveryAdapter({
  tokenManager,
  accessToken,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  baseUrl = DEFAULT_BASE_URL,
} = {}) {
  const getAccessToken = () => tokenManager?.getToken?.() || accessToken || "";

  async function searchPosts({
    query,
    searchType = "RECENT",
    searchMode = "KEYWORD",
    limit = 25,
    since,
    until,
    after,
  } = {}) {
    const q = String(query || "").trim();
    const type = String(searchType || "").toUpperCase();
    const mode = String(searchMode || "").toUpperCase();
    const safeLimit = Number.parseInt(limit, 10);
    const token = getAccessToken();

    if (!q) return { status: "failed", reason: "INVALID_QUERY", posts: [] };
    if (!SEARCH_TYPES.has(type)) return { status: "failed", reason: "INVALID_SEARCH_TYPE", posts: [] };
    if (!SEARCH_MODES.has(mode)) return { status: "failed", reason: "INVALID_SEARCH_MODE", posts: [] };
    if (!Number.isFinite(safeLimit) || safeLimit < 1 || safeLimit > 100) {
      return { status: "failed", reason: "INVALID_LIMIT", posts: [] };
    }
    if (!token) return { status: "failed", reason: "ACCESS_TOKEN_MISSING", posts: [] };

    const params = new URLSearchParams({
      q,
      search_type: type,
      search_mode: mode,
      limit: String(safeLimit),
      fields: DEFAULT_FIELDS,
      access_token: token,
    });
    if (since) params.set("since", String(since));
    if (until) params.set("until", String(until));
    if (after) params.set("after", String(after));

    let response;
    try {
      response = await fetchImpl(`${baseUrl}/keyword_search?${params}`, { method: "GET", timeout: timeoutMs });
    } catch (_) {
      return { status: "failed", reason: "NETWORK_ERROR", posts: [] };
    }

    const data = await readJson(response);
    if (response.status === 429) {
      return {
        status: "rate_limited",
        reason: "RATE_LIMITED",
        posts: [],
        retryAfterSeconds: parseRetryAfter(response.headers?.get?.("retry-after")),
      };
    }
    if (!response.ok || data?.error) {
      return {
        status: "failed",
        reason: "API_ERROR",
        posts: [],
        httpStatus: response.status,
        apiErrorCode: data?.error?.code || null,
      };
    }

    const posts = (Array.isArray(data?.data) ? data.data : []).map(normalizePost).filter(Boolean);
    return {
      status: "ok",
      posts,
      paging: {
        before: data?.paging?.cursors?.before || null,
        after: data?.paging?.cursors?.after || null,
      },
    };
  }

  return { searchPosts };
}

module.exports = { createThreadsDiscoveryAdapter, normalizePost, parseRetryAfter };
