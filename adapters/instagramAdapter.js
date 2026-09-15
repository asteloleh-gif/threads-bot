const fetch = require("node-fetch");
const { SOCIAL_EVENT_TYPES, createSocialEvent } = require("../app/events/socialEvent");

const DEFAULT_API_VERSION = "v26.0";
const DEFAULT_AUTH_MODE = "instagram_login";
const DEFAULT_BASE_URL = "https://graph.instagram.com";
const FACEBOOK_BASE_URL = "https://graph.facebook.com";
const DEFAULT_FETCH_TIMEOUT_MS = 20000;

function normalizeAuthMode(value) {
  const mode = String(value || DEFAULT_AUTH_MODE).trim().toLowerCase();
  if (["facebook", "facebook_login", "fb"].includes(mode)) return "facebook_login";
  if (["instagram", "instagram_login", "ig"].includes(mode)) return "instagram_login";
  throw new Error(`Unsupported Instagram auth mode: ${mode}`);
}

function normalizeBaseUrl(value, authMode) {
  const fallback = authMode === "facebook_login" ? FACEBOOK_BASE_URL : DEFAULT_BASE_URL;
  return String(value || fallback).replace(/\/+$/, "");
}

function normalizeUsername(value) {
  return String(value || "").trim().replace(/^@/, "").toLowerCase();
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
  username,
  accountKey,
  authMode = DEFAULT_AUTH_MODE,
  apiVersion = DEFAULT_API_VERSION,
  baseUrl,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
} = {}) {
  accessToken = String(accessToken || "").trim();
  userId = String(userId || "").trim();
  username = normalizeUsername(username);
  accountKey = String(accountKey || "instagram:default").trim().toLowerCase();
  authMode = normalizeAuthMode(authMode);
  apiVersion = String(apiVersion || DEFAULT_API_VERSION).replace(/^\/+|\/+$/g, "");
  baseUrl = normalizeBaseUrl(baseUrl, authMode);

  let facebookPageAccessToken = null;
  let facebookInstagramUserId = null;
  let facebookResolution = null;

  function endpoint(path) {
    return `${baseUrl}/${apiVersion}/${String(path || "").replace(/^\/+/, "")}`;
  }

  function effectiveUserId() {
    return authMode === "facebook_login" && facebookInstagramUserId
      ? facebookInstagramUserId
      : userId;
  }

  function createCommentEvent(value = {}, { rootId = null, ingress = "webhook", webhookField = null } = {}) {
    const sourceId = value?.comment_id || value?.id;
    if (!sourceId) return null;
    const metadata = ingress === "webhook"
      ? { webhookField, targetUserId: effectiveUserId() || null }
      : { ingress: "polling", targetUserId: effectiveUserId() || null };
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

    const acceptedTargetIds = new Set([userId, facebookInstagramUserId].filter(Boolean));
    for (const entry of Array.isArray(body?.entry) ? body.entry : []) {
      const targetUserId = entry?.id ? String(entry.id) : null;
      if (!targetUserId || !acceptedTargetIds.has(targetUserId)) continue;

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

  async function requestJson(url, options = {}, token = accessToken) {
    let response;
    try {
      response = await fetchImpl(url, {
        timeout: timeoutMs,
        ...options,
        headers: {
          Authorization: `Bearer ${token}`,
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

  function cacheFacebookPage(page, resolution) {
    const linkedId = String(page?.instagram_business_account?.id || "").trim();
    const pageToken = String(page?.access_token || "").trim();
    if (!linkedId) return { status: "failed", reason: "LINKED_IG_ID_MISSING", code: null };
    if (!pageToken) return { status: "failed", reason: "PAGE_TOKEN_MISSING", code: null };
    facebookPageAccessToken = pageToken;
    facebookInstagramUserId = linkedId;
    facebookResolution = resolution;
    return {
      status: "ok",
      token: facebookPageAccessToken,
      userId: facebookInstagramUserId,
      resolution: facebookResolution,
    };
  }

  async function resolveFacebookPageToken() {
    if (authMode !== "facebook_login") {
      return { status: "ok", token: accessToken, userId, resolution: "instagram_login" };
    }
    if (facebookPageAccessToken && facebookInstagramUserId) {
      return {
        status: "ok",
        token: facebookPageAccessToken,
        userId: facebookInstagramUserId,
        resolution: facebookResolution,
      };
    }
    if (!accessToken || (!userId && !username)) {
      return { status: "failed", reason: "INVALID_CONFIG", code: null };
    }

    const fields = "id,name,access_token,instagram_business_account";
    const url = `${endpoint("me/accounts")}?fields=${encodeURIComponent(fields)}&limit=100`;
    const result = await requestJson(url, { method: "GET" }, accessToken);
    const failure = safeMetaFailure(result);
    if (failure) {
      return {
        status: "failed",
        reason: failure.reason,
        code: failure.code || null,
        type: failure.type || null,
      };
    }

    const pages = Array.isArray(result.data?.data) ? result.data.data : [];
    const exactIdPage = userId
      ? pages.find(item => String(item?.instagram_business_account?.id || "") === userId)
      : null;
    if (exactIdPage) return cacheFacebookPage(exactIdPage, "id_match");

    // Instagram Login and Facebook Login can expose different account-id contexts.
    // If the configured id does not match, safely resolve the linked professional
    // account by the configured username using each Page's own Page access token.
    if (username) {
      let lookupAttempts = 0;
      let lookupSuccesses = 0;
      let firstLookupFailure = null;

      for (const page of pages) {
        const linkedId = String(page?.instagram_business_account?.id || "").trim();
        const pageToken = String(page?.access_token || "").trim();
        if (!linkedId || !pageToken) continue;
        lookupAttempts += 1;

        const identityUrl = `${endpoint(encodeURIComponent(linkedId))}?fields=${encodeURIComponent("id,username")}`;
        const identityResult = await requestJson(identityUrl, { method: "GET" }, pageToken);
        const identityFailure = safeMetaFailure(identityResult);
        if (identityFailure) {
          if (!firstLookupFailure) firstLookupFailure = identityFailure;
          continue;
        }
        lookupSuccesses += 1;
        if (normalizeUsername(identityResult.data?.username) === username) {
          return cacheFacebookPage(page, "username_match");
        }
      }

      if (lookupAttempts > 0 && lookupSuccesses === 0 && firstLookupFailure) {
        return {
          status: "failed",
          reason: firstLookupFailure.reason,
          code: firstLookupFailure.code || null,
          type: firstLookupFailure.type || null,
        };
      }
    }

    return { status: "failed", reason: "LINKED_PAGE_NOT_FOUND", code: null };
  }

  async function getRuntimeAuth() {
    if (authMode === "facebook_login") return resolveFacebookPageToken();
    if (!accessToken || !userId) return { status: "failed", reason: "INVALID_CONFIG", code: null };
    return { status: "ok", token: accessToken, userId, resolution: "instagram_login" };
  }

  async function getAccountIdentity() {
    if (!accessToken || (authMode === "instagram_login" && !userId)) {
      return { status: "failed", reason: "INVALID_CONFIG", code: null };
    }

    const auth = await getRuntimeAuth();
    if (auth.status !== "ok") return auth;

    const instagramLogin = authMode === "instagram_login";
    const fields = instagramLogin
      ? "id,user_id,username,account_type,media_count"
      : "id,username,account_type,media_count";
    const path = instagramLogin ? "me" : encodeURIComponent(auth.userId);
    const result = await requestJson(`${endpoint(path)}?fields=${encodeURIComponent(fields)}`, { method: "GET" }, auth.token);
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
    const id = result.data?.id ? String(result.data.id) : null;
    const returnedUserId = result.data?.user_id ? String(result.data.user_id) : null;
    return {
      status: "ok",
      identity: {
        id,
        userId: returnedUserId || (authMode === "facebook_login" ? id : null),
        username: result.data?.username ? String(result.data.username) : null,
        accountType: result.data?.account_type ? String(result.data.account_type) : null,
        mediaCount: Number.isFinite(mediaCount) ? mediaCount : null,
      },
    };
  }

  async function listRecentMedia({ limit = 10 } = {}) {
    if (!accessToken || (authMode === "instagram_login" && !userId)) {
      return { status: "failed", reason: "INVALID_CONFIG", code: null, items: [] };
    }
    const auth = await getRuntimeAuth();
    if (auth.status !== "ok") return { ...auth, items: [] };

    const boundedLimit = Math.max(1, Math.min(25, Number(limit) || 10));
    const fields = "id,timestamp,media_product_type,comments_count";
    const url = `${endpoint(`${encodeURIComponent(auth.userId)}/media`)}?fields=${encodeURIComponent(fields)}&limit=${boundedLimit}`;
    const result = await requestJson(url, { method: "GET" }, auth.token);
    const failure = safeMetaFailure(result);
    if (failure) return failure;
    return {
      status: "ok",
      items: Array.isArray(result.data?.data) ? result.data.data : [],
    };
  }

  async function listComments(mediaId, { limit = 50 } = {}) {
    if (!accessToken || !mediaId) return { status: "failed", reason: "INVALID_CONFIG_OR_INPUT", code: null, items: [] };
    const auth = await getRuntimeAuth();
    if (auth.status !== "ok") return { ...auth, items: [] };

    const boundedLimit = Math.max(1, Math.min(50, Number(limit) || 50));
    const fields = "id,text,username,from,parent_id,timestamp,replies{id,text,username,from,parent_id,timestamp}";
    const url = `${endpoint(`${encodeURIComponent(mediaId)}/comments`)}?fields=${encodeURIComponent(fields)}&limit=${boundedLimit}`;
    const result = await requestJson(url, { method: "GET" }, auth.token);
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
    const auth = await getRuntimeAuth();
    if (auth.status !== "ok") return null;

    const fields = "id,text,username,from,parent_id,media,timestamp";
    const url = `${endpoint(encodeURIComponent(commentId))}?fields=${encodeURIComponent(fields)}`;
    const result = await requestJson(url, { method: "GET" }, auth.token);
    if (result.transportError || !result.response?.ok || result.data?.error) return null;
    return result.data || null;
  }

  async function reply(parentCommentId, message) {
    if (!accessToken || !parentCommentId || !String(message || "").trim()) {
      return { status: "failed", reason: "INVALID_CONFIG_OR_INPUT" };
    }

    const auth = await getRuntimeAuth();
    if (auth.status !== "ok") {
      return {
        status: "failed",
        reason: auth.reason || "AUTH_RESOLUTION_FAILED",
        code: auth.code || null,
      };
    }

    const body = new URLSearchParams({ message: String(message) });
    const result = await requestJson(endpoint(`${encodeURIComponent(parentCommentId)}/replies`), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    }, auth.token);

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
    config: Object.freeze({ apiVersion, baseUrl, authMode }),
  };
}

module.exports = {
  DEFAULT_API_VERSION,
  DEFAULT_AUTH_MODE,
  DEFAULT_BASE_URL,
  FACEBOOK_BASE_URL,
  createInstagramAdapter,
};
