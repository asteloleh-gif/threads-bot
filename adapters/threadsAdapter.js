const fetch = require("node-fetch");

function createThreadsAdapter({ accessToken, userId, onPublishedReplyId }) {
  async function fetchWithRetry(url, options, maxAttempts = 3) {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const res = await fetch(url, options);
      if (res.status !== 429 && res.status < 500) return res;
      if (attempt === maxAttempts) return res;
      const backoff = 500 * (2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
      await new Promise(resolve => setTimeout(resolve, backoff));
    }
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
    const createRes = await fetchWithRetry(
      `https://graph.threads.net/v1.0/me/threads?${createParams}`,
      { method: "POST" }
    );
    const createData = await createRes.json();
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

  async function publishReply(creationId) {
    await new Promise(r => setTimeout(r, 5000));
    const publishParams = new URLSearchParams({ creation_id: String(creationId), access_token: accessToken });
    const publishRes = await fetchWithRetry(
      `https://graph.threads.net/v1.0/${encodeURIComponent(userId)}/threads_publish?${publishParams}`,
      { method: "POST" }
    );
    const publishData = await publishRes.json();
    if (!publishRes.ok || publishData.error) {
      console.error("Threads publish error:", publishRes.status, publishData?.error?.code || "unknown_error");
      return null;
    }
    const publishedId = publishData.id || null;
    if (publishedId && onPublishedReplyId) onPublishedReplyId(publishedId);
    console.log("Threads reply posted", JSON.stringify({ id: publishedId }));
    return publishedId;
  }

  async function reply(parentCommentId, message) {
    const creationId = await createReply(parentCommentId, message);
    if (!creationId) return null;
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
