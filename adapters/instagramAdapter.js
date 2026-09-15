const fetch = require("node-fetch");
const { SOCIAL_EVENT_TYPES, createSocialEvent } = require("../app/events/socialEvent");

const DEFAULT_API_VERSION = "v26.0";
const DEFAULT_BASE_URL = "https://graph.instagram.com";
const DEFAULT_FETCH_TIMEOUT_MS = 20000;

function normalizeBaseUrl(value) {
  return String(value || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

function safeMetaFailure(result) {
  if (result.transportError) {
    return { status: "failed", reason: "NETWORK_ERROR", code: null, items: [] };
  }
  if (!result.response?.ok || result.data?.error) {
    return {
      status: "failed",
      reason: "META_REJECTED",
      code: result.data?.error?.code || null,
      type: result.data?.error?.type || null,
      items: [],
    };
  }
  return null;
}

function createInstagramAdapter({
  accessToken,
  userId,
  accountKey,
  apiVersion = DEFAULT_API_VERSION,
  baseUrl = DEFAULT_BASE_URL,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
} = {}) {
  accessToken = String(accessToken || "").trim();
  userId = String(userId || "").trim();
  accountKey = String(accountKey || "instagram:default").trim().toLowerCase();
  apiVersion = String(apiVersion || DEFAULT_API_VERSION).replace(/^\/+|\/+$/g, "");
  baseUrl = normalizeBaseUrl(baseUrl);

  function endpoint(path) {
    return `${baseUrl}/${apiVersion}/${String(path || "").replace(/^\/+/, "")}`;
  }

  function createCommentEvent(value = {}, { rootId = null, ingress = "webhook", webhookField = null } = {}) {
    const sourceId = value?.comment_id || value?.id;
    if (!sourceId) return null;
    const metadata = ingress === "webhook"
      ? { webhookField, targetUserId: userId || null }
      : { ingress: "polling", targetUserId: userId || null };
    return createSocialEvent({
      platform: "instagram",
      accountKey,
      type: SOCIAL_EVENT_TYPES.COMMENT_CREATED,
      sourceId,
      rootId: value?.media?.id || value?.media_id || rootId || null,
      parentId: value?.parent_id || null,
      text: value?.text || "",
      author: {
        id: value?.from?.id || value?.user?.id || null,
        username: value?.from?.username || value?.username || null,
      },
      surface: value?.media?.media_product_type || null,
      timestamp: value?.timestamp || null,
      metadata,
    });
  }

  function parseWebhook(body) {
    const events = [];
    if (body?.object && body.object !== "instagram") return events;

    for (const entry of Array.isArray(body?.entry) ? body.entry : []) {
      const targetUserId = entry?.id ? String(entry.id) : null;
      if (!userId || targetUserId !== userId) continue;

      const changes = Array.isArray(entry?.changes)
        ? entry.changes
        : entry?.field
          ? [{ field: entry.field, value: entry.value }]
          : [];

      for (const change of changes) {
        if (!["comments", "live_comments"].includes(change?.field)) continue;
        const event = createCommentEvent(change?.value, {
          ingress: "webhook",
          webhookField: change.field,
        });
        if (event) events.push(event);
      }
    }
    return events;
  }

  async function requestJson(url, options = {}) {
    let response;
    try {
      response = await fetchImpl(url, {
        timeout: timeoutMs,
        ...options,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(options.headers || {}),
        },
      });
    } catch (error) {
      return { transportError: error, response: null, data: null };
    }

    let data = null;
    try { data = await response.json(); } catch (_) {}
    return { transportError: null, response, data };
  }

  async function getAccountIdentity() {
    if (!accessToken) return { status: "failed", reason: "INVALID_CONFIG", code: null };
    const fields = "id,user_id,username,account_type,media_count";
    const result = await requestJson(`${endpoint("me")}?fields=${encodeURIComponent(fields)}`, { method: "GET" });
    const failure = safeMetaFailure(result);
    if (failure) {
      return {
        status: "failed",
        reason: failure.reason,
        code: failure.code || null,
        type: failure.type || null,
      };
    }

    const mediaCount = Number(result.data?.media_count);
    return {
      status: "ok",
      identity: {
        id: result.data?.id ? String(result.data.id) : null,
        userId: result.data?.user_id ? String(result.data.user_id) : null,
        username: result.data?.username ? String(result.data.username) : null,
        accountType: result.data?.account_type ? String(result.data.account_type) : null,
        mediaCount: Number.isFinite(mediaCount) ? mediaCount : null,
      },
    };
  }

  async function listRecentMedia({ limit = 10 } = {}) {
    if (!accessToken || !userId) return { status: "failed", reason: "INVALID_CONFIG", code: null, items: [] };
    const boundedLimit = Math.max(1, Math.min(25, Number(limit) || 10));
    const fields = "id,timestamp,media_product_type,comments_count";
    const url = `${endpoint(`${encodeURIComponent(userId)}/media`)}?fields=${encodeURIComponent(fields)}&limit=${boundedLimit}`;
    const result = await requestJson(url, { method: "GET" });
    const failure = safeMetaFailure(result);
    if (failure) return failure;
    return {
      status: "ok",
      items: Array.isArray(result.data?.data) ? result.data.data : [],
    };
  }

  async function listComments(mediaId, { limit = 50 } = {}) {
    if (!accessToken || !mediaId) return { status: "failed", reason: "INVALID_CONFIG_OR_INPUT", code: null, items: [] };
    const boundedLimit = Math.max(1, Math.min(50, Number(limit) || 50));
    const fields = "id,text,username,from,parent_id,timestamp,replies{id,text,username,from,parent_id,timestamp}";
    const url = `${endpoint(`${encodeURIComponent(mediaId)}/comments`)}?fields=${encodeURIComponent(fields)}&limit=${boundedLimit}`;
    const result = await requestJson(url, { method: "GET" });
    const failure = safeMetaFailure(result);
    if (failure) return failure;

    const items = [];
    for (const comment of Array.isArray(result.data?.data) ? result.data.data : []) {
      items.push({ ...comment, media: comment?.media || { id: String(mediaId) } });
      for (const reply of Array.isArray(comment?.replies?.data) ? comment.replies.data : []) {
        items.push({
          ...reply,
          parent_id: reply?.parent_id || comment?.id || null,
          media: reply?.media || { id: String(mediaId) },
        });
      }
    }
    return { status: "ok", items };
  }

  function normalizePolledComment(comment, mediaId) {
    return createCommentEvent(comment, {
      rootId: mediaId,
      ingress: "polling",
      webhookField: null,
    });
  }

  async function getComment(commentId) {
    if (!accessToken || !commentId) return null;
    const fields = "id,text,username,from,parent_id,media,timestamp";
    const url = `${endpoint(encodeURIComponent(commentId))}?fields=${encodeURIComponent(fields)}`;
    const result = await requestJson(url, { method: "GET" });
    if (result.transportError || !result.response?.ok || result.data?.error) return null;
    return result.data || null;
  }

  async function reply(parentCommentId, message) {
    if (!accessToken || !userId || !parentCommentId || !String(message || "").trim()) {
      return { status: "failed", reason: "INVALID_CONFIG_OR_INPUT" };
    }

    const body = new URLSearchParams({ message: String(message) });
    const result = await requestJson(endpoint(`${encodeURIComponent(parentCommentId)}/replies`), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    // A direct comment-reply POST is not safely retryable: a timeout or 5xx can
    // happen after Meta committed the mutation. Hold instead of risking a duplicate.
    if (result.transportError) return { status: "ambiguous", reason: "NETWORK_OUTCOME_UNKNOWN" };
    if (result.response.status >= 500) return { status: "ambiguous", reason: "SERVER_OUTCOME_UNKNOWN" };
    if (!result.response.ok || result.data?.error) {
      return {
        status: "failed",
        reason: "META_REJECTED",
        code: result.data?.error?.code || null,
      };
    }

    const id = result.data?.id || null;
    if (!id) return { status: "ambiguous", reason: "MISSING_PUBLISHED_ID" };
    return { status: "published", id: String(id) };
  }

  return {
    parseWebhook,
    getAccountIdentity,
    listRecentMedia,
    listComments,
    normalizePolledComment,
    getComment,
    reply,
    config: Object.freeze({ apiVersion, baseUrl }),
  };
}

module.exports = {
  DEFAULT_API_VERSION,
  DEFAULT_BASE_URL,
  createInstagramAdapter,
};
