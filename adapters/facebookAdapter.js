const fetch = require("node-fetch");
const { SOCIAL_EVENT_TYPES, createSocialEvent } = require("../app/events/socialEvent");

const DEFAULT_API_VERSION = "v26.0";
const DEFAULT_BASE_URL = "https://graph.facebook.com";
const DEFAULT_FETCH_TIMEOUT_MS = 20000;

function normalizeBaseUrl(value) {
  return String(value || DEFAULT_BASE_URL).replace(/\/+$/, "");
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

  function parseWebhook(body) {
    const events = [];
    if (body?.object && body.object !== "page") return events;

    for (const entry of body?.entry || []) {
      const targetPageId = entry?.id ? String(entry.id) : null;
      if (userId && targetPageId && targetPageId !== userId) continue;

      for (const change of entry?.changes || []) {
        if (change?.field !== "feed") continue;
        const value = change?.value;
        if (value?.item !== "comment" || value?.verb !== "add") continue;
        const sourceId = value?.comment_id;
        if (!sourceId) continue;

        const rootId = value?.post_id || null;
        const rawParentId = value?.parent_id || null;
        const parentId = rawParentId && (!rootId || String(rawParentId) !== String(rootId))
          ? rawParentId
          : null;

        events.push(createSocialEvent({
          platform: "facebook",
          accountKey,
          type: SOCIAL_EVENT_TYPES.COMMENT_CREATED,
          sourceId,
          rootId,
          parentId,
          text: value?.message || "",
          author: {
            id: value?.from?.id || value?.sender_id || null,
            username: null,
          },
          surface: "PAGE_FEED",
          timestamp: value?.created_time == null ? null : String(value.created_time),
          metadata: {
            webhookField: change.field,
            item: value.item,
            verb: value.verb,
            targetPageId,
            senderName: value?.from?.name || value?.sender_name || null,
            rawParentId: rawParentId ? String(rawParentId) : null,
          },
        }));
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
