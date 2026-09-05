const fetch = require("node-fetch");

const DEFAULT_FETCH_TIMEOUT_MS = 20000;

function createThreadsAdapter({ accessToken, userId, onPublishedReplyId }) {
  // Retries on 429/5xx (as before) AND now also on thrown network errors/timeouts, so a
  // transient blip doesn't immediately surface as a failure with zero retries. Applies a
  // request timeout by default (node-fetch v2 supports `timeout` in ms) so a hung request
  // becomes a bounded, classifiable failure instead of hanging forever.
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

  function getAuthorId(c) {
    return c?.user_id || c?.from?.id || c?.user?.id || c?.owner_id || null;
  }

  function getAuthorUsername(c) {
    return c?.username || c?.from?.username || c?.user?.username || null;
  }

  function getRootPostId(c) {
    return c?.root_post?.id || c?.replied_to?.id || c?.parent_id || c?.media_id || null;
  }

  function getCommentId(c) {
    return c?.id || c?.reply_id || c?.media?.id || null;
  }

  function getCommentText(c) {
    return c?.text || c?.reply_text || c?.media?.text || null;
  }

  // Creation-step failures (including network errors) are always safe to treat as a plain
  // failure: if we never receive a creationId, we cannot call publish with it, so at worst
  // an orphaned unpublished container is left on Meta's side - never a duplicate reply.
  async function createReply(parentCommentId, message) {
    if (!accessToken || !userId) {
      console.error("Threads config error: access token or user id missing");
      return null;
    }

    const createParams = new URLSearchParams({
      media_type: "TEXT",
      text: message,
      reply_to_id: String(parentCommentId),
      access_token: accessToken,
    });

    let createRes;
    try {
      createRes = await fetchWithRetry(`https://graph.threads.net/v1.0/me/threads?${createParams}`, { method: "POST" });
    } catch (e) {
      console.error("Threads container creation network error:", e?.message || String(e));
      return null;
    }

    let createData;
    try {
      createData = await createRes.json();
    } catch (e) {
      console.error("Threads container creation error: unparseable response", createRes.status);
      return null;
    }

    if (!createRes.ok || createData.error) {
      console.error("Threads container creation error:", createRes.status, createData?.error?.code || "unknown_error");
      return null;
    }
    const creationId = createData.id;
    if (!creationId) {
      console.error("Threads container creation error: missing creation id");
      return null;
    }
    console.log("Threads reply container created", JSON.stringify({ id: creationId }));
    return creationId;
  }

  // Publish-step outcome is reported as a structured status instead of just an id/null,
  // because this is the step where "we don't know if it worked" is genuinely dangerous:
  // if the request reached Meta and was processed but our read of the response failed
  // (network error, timeout, unparseable body after a 2xx), a naive retry could publish a
  // second reply to the same source comment. Callers must NOT auto-retry on "ambiguous".
  async function publishReply(creationId) {
    await new Promise(r => setTimeout(r, 5000));
    const publishParams = new URLSearchParams({ creation_id: String(creationId), access_token: accessToken });

    let publishRes;
    // IMPORTANT: never retry a thrown network error on the publish step. Once this POST
    // has been dispatched, Meta may have completed the publish even if we never receive
    // the response. Retrying that ambiguous operation can itself create a duplicate reply.
    // Definitive HTTP 429/5xx responses remain bounded-retryable because we did receive
    // an explicit response from Meta.
    try {
      const url = `https://graph.threads.net/v1.0/${encodeURIComponent(userId)}/threads_publish?${publishParams}`;
      const opts = { method: "POST", timeout: DEFAULT_FETCH_TIMEOUT_MS };
      const maxAttempts = 3;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          publishRes = await fetch(url, opts);
        } catch (e) {
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
    try {
      publishData = await publishRes.json();
    } catch (e) {
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

    if (onPublishedReplyId) onPublishedReplyId(publishedId);
    console.log("Threads reply posted", JSON.stringify({ id: publishedId }));
    return { status: "published", id: publishedId };
  }

  // Returns { status: "published", id } | { status: "failed" } | { status: "ambiguous" }.
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
    createReply,
    publishReply,
    reply,
  };
}

module.exports = { createThreadsAdapter };
