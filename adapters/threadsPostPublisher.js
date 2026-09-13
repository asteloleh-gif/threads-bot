const fetch = require("node-fetch");

const DEFAULT_TIMEOUT_MS = 20_000;

function createThreadsPostPublisher({
  tokenManager,
  fallbackAccessToken = "",
  apiVersion = "v1.0",
  baseUrl = "https://graph.threads.net",
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  const getToken = () => tokenManager?.getToken?.() || fallbackAccessToken || "";

  async function createTextContainer(text) {
    const token = getToken();
    const normalized = String(text || "").trim();
    if (!token) return { status: "failed", reason: "ACCESS_TOKEN_MISSING" };
    if (!normalized) return { status: "failed", reason: "TEXT_REQUIRED" };

    const params = new URLSearchParams({ media_type: "TEXT", text: normalized });
    const url = `${baseUrl}/${apiVersion}/me/threads?${params}`;
    let lastReason = "CONTAINER_CREATE_FAILED";

    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const response = await fetchImpl(url, {
          method: "POST",
          timeout: timeoutMs,
          headers: { Authorization: `Bearer ${token}` },
        });
        let data = null;
        try { data = await response.json(); } catch (_) {}
        if (response.ok && data?.id) return { status: "created", id: String(data.id) };
        lastReason = data?.error?.code ? `META_${data.error.code}` : `HTTP_${response.status}`;
        if (response.status !== 429 && response.status < 500) break;
      } catch (_) {
        lastReason = "CONTAINER_CREATE_NETWORK_ERROR";
      }
      if (attempt < 2) await sleep(250);
    }
    return { status: "failed", reason: lastReason };
  }

  async function publishContainer(creationId) {
    const token = getToken();
    if (!token) return { status: "failed", reason: "ACCESS_TOKEN_MISSING" };
    if (!creationId) return { status: "failed", reason: "CREATION_ID_REQUIRED" };

    const params = new URLSearchParams({ creation_id: String(creationId) });
    const url = `${baseUrl}/${apiVersion}/me/threads_publish?${params}`;
    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        timeout: timeoutMs,
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (_) {
      return { status: "ambiguous", reason: "NETWORK_OUTCOME_UNKNOWN" };
    }

    let data = null;
    try { data = await response.json(); } catch (_) {}
    if (response.ok && data?.id) return { status: "published", id: String(data.id) };

    // Never retry the externally visible mutation when the server/rate-limit
    // response leaves the outcome uncertain. A duplicate post is worse than a hold.
    if (response.status === 429 || response.status >= 500 || (response.ok && !data?.id)) {
      return { status: "ambiguous", reason: "SERVER_OUTCOME_UNKNOWN" };
    }
    return {
      status: "failed",
      reason: "META_REJECTED",
      code: data?.error?.code || null,
      httpStatus: response.status,
    };
  }

  async function publishPost(content = {}) {
    const type = String(content.type || "text").toLowerCase();
    if (type !== "text") return { status: "failed", reason: "UNSUPPORTED_CONTENT_TYPE" };
    const container = await createTextContainer(content.text);
    if (container.status !== "created") return container;
    return publishContainer(container.id);
  }

  return { createTextContainer, publishContainer, publishPost };
}

module.exports = { createThreadsPostPublisher };
