const fetch = require("node-fetch");
const { SOCIAL_EVENT_TYPES, createSocialEvent } = require("../app/events/socialEvent");

const DEFAULT_API_VERSION = "v26.0";
const DEFAULT_BASE_URL = "https://graph.facebook.com";
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

function createFacebookAdapter({
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
  accountKey = String(accountKey || "facebook:default").trim().toLowerCase();
  apiVersion = String(apiVersion || DEFAULT_API_VERSION).replace(/^\/+|\/+$/g, "");
  baseUrl = normalizeBaseUrl(baseUrl);

  function endpoint(path) {
    return `${baseUrl}/${apiVersion}/${String(path || "").replace(/^\/+/, "")}`;
  }

  function createCommentEvent(value = {}, { rootId = null, ingress = "webhook", webhookField = null } = {}) {
    const sourceId = value?.comment_id || value?.id;
    if (!sourceId) return null;

    const resolvedRootId = value?.post_id || rootId || null;
    const rawParentId = value?.parent_id || value?.parent?.id || null;
    const parentId = rawParentId && (!resolvedRootId || String(rawParentId) !== String(resolvedRootId))
      ? String(rawParentId)
      : null;
    const from = value?.from || {};
    const senderName = from?.name || value?.sender_name || null;

    const metadata = ingress === "webhook"
      ? {
          webhookField,
          item: value?.item || "comment",
          verb: value?.verb || "add",
          targetPageId: userId || null,
          senderName,
          rawParentId: rawParentId ? String(rawParentId) : null,
        }
      : {
          ingress: "polling",
          targetPageId: userId || null,
          senderName,
          rawParentId: rawParentId ? String(rawParentId) : null,
        };

    return createSocialEvent({
      platform: "facebook",
      accountKey,
      type: SOCIAL_EVENT_TYPES.COMMENT_CREATED,
      sourceId,
      rootId: resolvedRootId,
      parentId,
      text: value?.message || "",
      author: {
        id: from?.id || value?.sender_id || null,
        username: from?.username || from?.name || null,
      },
      surface: "PAGE_FEED",
      timestamp: value?.created_time == null ? null : String(value.created_time),
      metadata,
    });
  }

  function parseWebhook(body) {
    const events = [];
    if (body?.object && body.object !== "page") return events;

    for (const entry of Array.isArray(body?.entry) ? body.entry : []) {
      const targetPageId = entry?.id ? String(entry.id) : null;
      if (!userId || targetPageId !== userId) continue;

      for (const change of Array.isArray(entry?.changes) ? entry.changes : []) {
        if (change?.field !== "feed") continue;
        const value = change?.value;
        if (value?.item !== "comment" || value?.verb !== "add") continue;
        const event = createCommentEvent(value, {
          rootId: value?.post_id || null,
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

  async function getPageIdentity() {
    if (!accessToken || !userId) return { status: "failed", reason: "INVALID_CONFIG", code: null };
    const fields = "id,name";
    const url = `${endpoint(encodeURIComponent(userId))}?fields=${encodeURIComponent(fields)}`;
    const result = await requestJson(url, { method: "GET" });
    const failure = safeMetaFailure(result);
    if (failure) return failure;
    return {
      status: "ok",
      identity: {
        id: result.data?.id ? String(result.data.id) : null,
        name: result.data?.name ? String(result.data.name) : null,
      },
    };
  }

  async function listRecentPosts({ limit = 10 } = {}) {
    if (!accessToken || !userId) {
      return { status: "failed", reason: "INVALID_CONFIG", code: null, items: [] };
    }
    const boundedLimit = Math.max(1, Math.min(25, Number(limit) || 10));
    const fields = "id,created_time,comments.limit(0).summary(true)";
    const url = `${endpoint(`${encodeURIComponent(userId)}/published_posts`)}?fields=${encodeURIComponent(fields)}&limit=${boundedLimit}`;
    const result = await requestJson(url, { method: "GET" });
    const failure = safeMetaFailure(result);
    if (failure) return failure;

    const items = (Array.isArray(result.data?.data) ? result.data.data : []).map(post => ({
      id: post?.id ? String(post.id) : null,
      created_time: post?.created_time || null,
      comments_count: Number(post?.comments?.summary?.total_count) || 0,
    })).filter(post => post.id);

    return { status: "ok", items };
  }

  async function listComments(postId, { limit = 50 } = {}) {
    if (!accessToken || !postId) {
      return { status: "failed", reason: "INVALID_CONFIG_OR_INPUT", code: null, items: [] };
    }
    const boundedLimit = Math.max(1, Math.min(50, Number(limit) || 50));
    const fields = "id,message,from,parent,created_time,comments{id,message,from,parent,created_time}";
    const url = `${endpoint(`${encodeURIComponent(postId)}/comments`)}?fields=${encodeURIComponent(fields)}&limit=${boundedLimit}&order=chronological`;
    const result = await requestJson(url, { method: "GET" });
    const failure = safeMetaFailure(result);
    if (failure) return failure;

    const items = [];
    for (const comment of Array.isArray(result.data?.data) ? result.data.data : []) {
      items.push({
        ...comment,
        post_id: String(postId),
        parent_id: comment?.parent?.id || comment?.parent_id || String(postId),
      });
      for (const reply of Array.isArray(comment?.comments?.data) ? comment.comments.data : []) {
        items.push({
          ...reply,
          post_id: String(postId),
          parent_id: reply?.parent?.id || reply?.parent_id || comment?.id || null,
        });
      }
    }
    return { status: "ok", items };
  }

  function normalizePolledComment(comment, postId) {
    return createCommentEvent(comment, {
      rootId: postId,
      ingress: "polling",
      webhookField: null,
    });
  }

  async function getComment(commentId) {
    if (!accessToken || !commentId) return null;
    const fields = "id,message,from,parent,created_time,permalink_url";
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
    const result = await requestJson(endpoint(`${encodeURIComponent(parentCommentId)}/comments`), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });

    // A Facebook comment mutation is not safely retryable after an unknown
    // transport/server outcome. Hold instead of risking a duplicate reply.
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
    getPageIdentity,
    listRecentPosts,
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
  createFacebookAdapter,
};
