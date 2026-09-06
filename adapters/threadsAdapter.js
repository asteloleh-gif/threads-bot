const fetch = require("node-fetch");

const DEFAULT_FETCH_TIMEOUT_MS = 20000;

function createThreadsAdapter({ accessToken, userId }) {
  async function fetchWithRetry(url, options, maxAttempts = 3) {
    const opts = { timeout: DEFAULT_FETCH_TIMEOUT_MS, ...options };
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await fetch(url, opts);
        if (res.status !== 429 && res.status < 500) return res;
        if (attempt === maxAttempts) return res;
      } catch (e) {
        lastErr = e;
        if (attempt === maxAttempts) throw e;
      }
      const backoff = 500 * (2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
      await new Promise(resolve => setTimeout(resolve, backoff));
    }
    throw lastErr;
  }

  function parseWebhook(body) {
    const events = [];
    const values = Array.isArray(body?.values) ? body.values : [];
    for (const item of values) {
      if (!["replies", "comments"].includes(item?.field)) continue;
      if (item?.value) events.push(item.value);
    }
    for (const entry of body?.entry || []) {
      for (const change of entry?.changes || []) {
        if (!["replies", "comments"].includes(change?.field)) continue;
        if (change?.value) events.push(change.value);
      }
    }
    return events;
  }

  function getAuthorId(c) { return c?.user_id || c?.from?.id || c?.user?.id || c?.owner_id || null; }
  function getAuthorUsername(c) { return c?.username || c?.from?.username || c?.user?.username || null; }
  function getCommentId(c) { return c?.id || c?.reply_id || c?.media?.id || null; }
  function getCommentText(c) { return c?.text || c?.reply_text || c?.media?.text || null; }
  function getParentId(c) { return c?.replied_to?.id || c?.parent?.id || c?.parent_id || null; }
  function getParentAuthorId(c) { return c?.replied_to?.user_id || c?.replied_to?.from?.id || c?.parent?.user_id || c?.parent?.from?.id || c?.parent_user_id || null; }
  function getParentAuthorUsername(c) { return c?.replied_to?.username || c?.replied_to?.from?.username || c?.parent?.username || c?.parent?.from?.username || c?.parent_username || null; }
  function getRootPostId(c) {
    return c?.root_post?.id || c?.root_post_id || c?.media_id || c?.media?.root_post?.id || getParentId(c) || null;
  }

  async function resolveParentAuthor(c, { ownerUsername, ownerUserId, lookupEnabled = true } = {}) {
    const parentId = getParentId(c);
    const rootId = getRootPostId(c);
    const payloadAuthorId = getParentAuthorId(c);
    const payloadUsername = getParentAuthorUsername(c);
    if (!parentId) return { parentId: null, parentAuthorId: null, parentAuthorUsername: null, source: "none" };
    if (payloadAuthorId || payloadUsername) {
      return { parentId, parentAuthorId: payloadAuthorId, parentAuthorUsername: payloadUsername, source: "webhook" };
    }
    if (rootId && String(parentId) === String(rootId)) {
      return { parentId, parentAuthorId: ownerUserId || userId || null, parentAuthorUsername: ownerUsername || null, source: "root-owner" };
    }
    if (!lookupEnabled || !accessToken) return { parentId, parentAuthorId: null, parentAuthorUsername: null, source: "unknown" };

    try {
      const fields = "id,username,user_id";
      const url = `https://graph.threads.net/v1.0/${encodeURIComponent(parentId)}?fields=${encodeURIComponent(fields)}&access_token=${encodeURIComponent(accessToken)}`;
      const res = await fetchWithRetry(url, { method: "GET" }, 2);
      let data = null;
      try { data = await res.json(); } catch (_) {}
      if (!res.ok || data?.error) {
        console.warn("Threads parent lookup failed", JSON.stringify({ parentId: String(parentId), status: res.status, code: data?.error?.code || null }));
        return { parentId, parentAuthorId: null, parentAuthorUsername: null, source: "lookup-failed" };
      }
      return {
        parentId,
        parentAuthorId: data?.user_id || null,
        parentAuthorUsername: data?.username || null,
        source: "api",
      };
    } catch (e) {
      console.warn("Threads parent lookup error", JSON.stringify({ parentId: String(parentId), error: e?.message || String(e) }));
      return { parentId, parentAuthorId: null, parentAuthorUsername: null, source: "lookup-error" };
    }
  }

  async function createReply(parentCommentId, message) {
    if (!accessToken || !userId) {
      console.error("Threads config error: access token or user id missing");
      return null;
    }
    const createParams = new URLSearchParams({ media_type: "TEXT", text: message, reply_to_id: String(parentCommentId), access_token: accessToken });
    let createRes;
    try {
      createRes = await fetchWithRetry(`https://graph.threads.net/v1.0/me/threads?${createParams}`, { method: "POST" });
    } catch (e) {
      console.error("Threads container creation network error:", e?.message || String(e));
      return null;
    }
    let createData;
    try { createData = await createRes.json(); }
    catch (_) { console.error("Threads container creation error: unparseable response", createRes.status); return null; }
    if (!createRes.ok || createData.error) {
      console.error("Threads container creation error:", createRes.status, createData?.error?.code || "unknown_error");
      return null;
    }
    const creationId = createData.id;
    if (!creationId) { console.error("Threads container creation error: missing creation id"); return null; }
    console.log("Threads reply container created", JSON.stringify({ id: creationId }));
    return creationId;
  }

  async function publishReply(creationId) {
    await new Promise(r => setTimeout(r, 5000));
    const publishParams = new URLSearchParams({ creation_id: String(creationId), access_token: accessToken });
    let publishRes;
    try {
      const url = `https://graph.threads.net/v1.0/${encodeURIComponent(userId)}/threads_publish?${publishParams}`;
      const opts = { method: "POST", timeout: DEFAULT_FETCH_TIMEOUT_MS };
      const maxAttempts = 3;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try { publishRes = await fetch(url, opts); }
        catch (e) {
          console.error("Threads publish network error (ambiguous outcome):", e?.message || String(e));
          return { status: "ambiguous" };
        }
        if (publishRes.status !== 429 && publishRes.status < 500) break;
        if (attempt === maxAttempts) break;
        const backoff = 500 * (2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
        await new Promise(resolve => setTimeout(resolve, backoff));
      }
    } catch (e) {
      console.error("Threads publish network error (ambiguous outcome):", e?.message || String(e));
      return { status: "ambiguous" };
    }

    let publishData;
    try { publishData = await publishRes.json(); }
    catch (_) {
      if (publishRes.ok) {
        console.error("Threads publish response unparseable after success status (ambiguous outcome)");
        return { status: "ambiguous" };
      }
      console.error("Threads publish error: unparseable error body", publishRes.status);
      return { status: "failed" };
    }
    if (!publishRes.ok || publishData.error) {
      console.error("Threads publish error:", publishRes.status, publishData?.error?.code || "unknown_error");
      return { status: "failed" };
    }
    const publishedId = publishData.id || null;
    if (!publishedId) {
      console.error("Threads publish error: missing published id despite success response (ambiguous outcome)");
      return { status: "ambiguous" };
    }
    console.log("Threads reply posted", JSON.stringify({ id: publishedId }));
    return { status: "published", id: publishedId };
  }

  async function reply(parentCommentId, message) {
    const creationId = await createReply(parentCommentId, message);
    if (!creationId) return { status: "failed" };
    return publishReply(creationId);
  }

  return {
    parseWebhook,
    getAuthorId,
    getAuthorUsername,
    getRootPostId,
    getCommentId,
    getCommentText,
    getParentId,
    getParentAuthorId,
    getParentAuthorUsername,
    resolveParentAuthor,
    createReply,
    publishReply,
    reply,
  };
}

module.exports = { createThreadsAdapter };
