/**
 * Leo Akastel | Business & Tech — Threads Auto-Reply Bot
 */
const express = require("express");
const bodyParser = require("body-parser");
const fetch = require("node-fetch");
require("dotenv").config();

const app = express();
app.use(bodyParser.json());

const {
  THREADS_ACCESS_TOKEN,
  THREADS_USER_ID,
  THREADS_VERIFY_TOKEN,
  AIRTABLE_API_KEY,
  AIRTABLE_BASE_ID,
  OPENAI_API_KEY,
  OPENAI_MODEL = "gpt-5.6-luna",
  BOT_ENABLED = "false",
  BOT_DRY_RUN = "true",
  PORT = 3000,
} = process.env;

const AIRTABLE_URL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}`;
const SELF_USERNAME = "leoakastel";
const SELF_USER_ID = "27979923121676296";
const USER_COOLDOWN_MS = 10 * 60 * 1000;
const THREAD_WINDOW_MS = 10 * 60 * 1000;
const THREAD_MAX_REPLIES = 5;
const GLOBAL_WINDOW_MS = 60 * 60 * 1000;
const GLOBAL_MAX_REPLIES = 15;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

// TEMPORARY: in-memory safety state resets on Railway restart/redeploy.
// Production should move this state to persistent storage (e.g. Redis/DB) before scaling.
const processingComments = new Map();
const publishedBySource = new Map();
const botGeneratedIds = new Map();
const userLastReplyAt = new Map();
const threadReplyTimes = new Map();
const globalReplyTimes = [];

function now() {
  return Date.now();
}

function pruneMapByTimestamp(map, ttlMs) {
  const t = now();
  for (const [key, value] of map) {
    const ts = typeof value === "number" ? value : value?.timestamp;
    if (typeof ts === "number" && t - ts > ttlMs) map.delete(key);
  }
}

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

function isEnabled() {
  return String(BOT_ENABLED).toLowerCase() === "true";
}

function isDryRun() {
  return String(BOT_DRY_RUN).toLowerCase() === "true";
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

function isSelfAuthored(c) {
  const username = normalizeUsername(getAuthorUsername(c));
  const authorId = getAuthorId(c);
  return username === SELF_USERNAME ||
    (authorId && String(authorId) === SELF_USER_ID) ||
    (authorId && THREADS_USER_ID && String(authorId) === String(THREADS_USER_ID));
}

function isBotGeneratedId(id) {
  pruneMapByTimestamp(botGeneratedIds, IDEMPOTENCY_TTL_MS);
  return id ? botGeneratedIds.has(String(id)) : false;
}

function reserveComment(commentId) {
  pruneMapByTimestamp(processingComments, IDEMPOTENCY_TTL_MS);
  pruneMapByTimestamp(publishedBySource, IDEMPOTENCY_TTL_MS);
  const key = String(commentId);
  if (processingComments.has(key) || publishedBySource.has(key)) return false;
  processingComments.set(key, now());
  return true;
}

function releaseComment(commentId) {
  processingComments.delete(String(commentId));
}

function getUserKey(c) {
  const authorId = getAuthorId(c);
  if (authorId) return `id:${String(authorId)}`;
  const username = normalizeUsername(getAuthorUsername(c));
  return username ? `username:${username}` : null;
}

function userOnCooldown(userKey) {
  if (!userKey) return true;
  const t = now();
  const last = userLastReplyAt.get(userKey);
  if (!last) return false;
  return t - last < USER_COOLDOWN_MS;
}

function threadOnCooldown(rootId) {
  if (!rootId) return true;
  const t = now();
  const key = String(rootId);
  const recent = (threadReplyTimes.get(key) || []).filter(ts => t - ts < THREAD_WINDOW_MS);
  threadReplyTimes.set(key, recent);
  return recent.length >= THREAD_MAX_REPLIES;
}

function globalLimitReached() {
  const t = now();
  while (globalReplyTimes.length && t - globalReplyTimes[0] >= GLOBAL_WINDOW_MS) globalReplyTimes.shift();
  return globalReplyTimes.length >= GLOBAL_MAX_REPLIES;
}

function recordSuccessfulReply({ sourceCommentId, publishedReplyId, userKey, rootId }) {
  const t = now();
  if (sourceCommentId) publishedBySource.set(String(sourceCommentId), { publishedReplyId: publishedReplyId || null, timestamp: t });
  if (publishedReplyId) botGeneratedIds.set(String(publishedReplyId), t);
  if (userKey) userLastReplyAt.set(userKey, t);
  if (rootId) {
    const key = String(rootId);
    const list = (threadReplyTimes.get(key) || []).filter(ts => t - ts < THREAD_WINDOW_MS);
    list.push(t);
    threadReplyTimes.set(key, list);
  }
  globalReplyTimes.push(t);
}

app.get("/", (_q, r) => r.status(200).send("Leo Akastel Threads bot is running"));
app.get("/health", (_q, r) => r.status(200).json({ ok: true, enabled: isEnabled(), dryRun: isDryRun() }));

app.get("/webhook", (q, r) => {
  const m = q.query["hub.mode"], t = q.query["hub.verify_token"], c = q.query["hub.challenge"];
  if (m === "subscribe" && t === THREADS_VERIFY_TOKEN) {
    console.log("Webhook verified");
    return r.status(200).send(c);
  }
  return r.sendStatus(403);
});

app.post("/webhook", async (q, r) => {
  r.sendStatus(200);
  console.log("Webhook received");

  if (!isEnabled()) {
    console.log("Bot disabled: webhook acknowledged only");
    return;
  }

  try {
    const values = Array.isArray(q.body?.values) ? q.body.values : [];
    for (const item of values) {
      if (!["replies", "comments"].includes(item?.field)) continue;
      const v = item?.value;
      if (v) await handleComment(v);
    }
    for (const e of q.body?.entry || []) {
      for (const ch of e?.changes || []) {
        if (!["replies", "comments"].includes(ch?.field)) continue;
        const v = ch?.value;
        if (v) await handleComment(v);
      }
    }
  } catch (e) {
    console.error("Webhook processing error:", e?.message || String(e));
  }
});

async function handleComment(c) {
  const commentId = getCommentId(c);
  const text = getCommentText(c);
  const author = getAuthorUsername(c);
  const authorId = getAuthorId(c);
  const rootId = getRootPostId(c);

  if (!commentId || !text || !author || !rootId) {
    console.log("Reply skipped: invalid payload");
    return;
  }

  if (isSelfAuthored(c)) {
    console.log("Reply skipped: self-authored");
    return;
  }

  if (isBotGeneratedId(commentId)) {
    console.log("Reply skipped: bot-generated object");
    return;
  }

  if (!reserveComment(commentId)) {
    console.log("Reply skipped: duplicate", String(commentId));
    return;
  }

  const userKey = getUserKey(c);
  if (!userKey) {
    console.log("Reply skipped: invalid payload");
    releaseComment(commentId);
    return;
  }

  if (userOnCooldown(userKey)) {
    console.log("Reply skipped: user cooldown");
    releaseComment(commentId);
    return;
  }

  if (threadOnCooldown(rootId)) {
    console.log("Reply skipped: thread cooldown");
    releaseComment(commentId);
    return;
  }

  if (globalLimitReached()) {
    console.log("Reply skipped: global rate limit");
    releaseComment(commentId);
    return;
  }

  try {
    const context = await getContext();
    const replyText = await generateReply(text, context);
    if (!replyText) {
      releaseComment(commentId);
      return;
    }

    console.log("AI reply generated", JSON.stringify({ length: replyText.length }));

    if (isDryRun()) {
      console.log("DRY RUN: would reply", JSON.stringify({ sourceCommentId: String(commentId), length: replyText.length }));
      releaseComment(commentId);
      return;
    }

    const replyId = await postReply(commentId, replyText);
    if (!replyId) {
      releaseComment(commentId);
      return;
    }

    recordSuccessfulReply({ sourceCommentId: commentId, publishedReplyId: replyId, userKey, rootId });
    releaseComment(commentId);
    await logInteraction({ commentId, author: author || authorId || "unknown", commentText: text, replyText, replyId, mediaId: rootId });
  } catch (e) {
    releaseComment(commentId);
    console.error("Comment handling error:", e?.message || String(e));
  }
}

async function getContext() {
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) return "";
  for (const table of ["KnowledgeBase", "Knowledge Base"]) {
    try {
      const res = await fetch(`${AIRTABLE_URL}/${encodeURIComponent(table)}?maxRecords=20`, { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` } });
      if (res.ok) {
        const d = await res.json();
        return (d.records || []).map(r => {
          const f = r.fields || {}, q = f.Question || f.Title || f.Topic || "", a = f.Answer || f.Content || f.Context || "";
          return q || a ? `- ${q}${q && a ? ": " : ""}${a}` : "";
        }).filter(Boolean).join("\n");
      }
      if (res.status !== 404) console.error("Airtable KnowledgeBase error:", res.status);
    } catch (e) {
      console.error("Airtable KnowledgeBase error:", e?.message || String(e));
    }
  }
  console.log("Airtable KB unavailable; continuing without context");
  return "";
}

async function logInteraction(row) {
  if (!AIRTABLE_API_KEY || !AIRTABLE_BASE_ID) return;
  try {
    const res = await fetch(`${AIRTABLE_URL}/Comments`, {
      method: "POST",
      headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ fields: { "Comment ID": row.commentId, Author: row.author, "Comment Text": row.commentText, "Reply Text": row.replyText, "Reply ID": row.replyId || "", "Media ID": row.mediaId || "" } }),
    });
    if (!res.ok) console.error("Airtable log error:", res.status);
  } catch (e) {
    console.error("Airtable log error:", e?.message || String(e));
  }
}

async function generateReply(commentText, knowledgeBase) {
  const systemPrompt = `Ты — ассистент, который отвечает на комментарии под постами в Threads от имени бренда/аккаунта Leo Akastel | Business & Tech.\n\nТОН И СТИЛЬ:\n- Дружелюбно, живо, без канцелярита\n- Коротко: 1-2 предложения максимум\n- Максимум 1 emoji, если уместно\n- Пиши на языке комментария\n- Обращайся на \"ты\" для неформального комментария, на \"вы\" для формального\n\nПРАВИЛА:\n1. Используй базу знаний, если она отвечает на вопрос; не выдумывай факты.\n2. На эмоцию/благодарность отвечай коротко и тепло.\n3. На токсичный комментарий отвечай нейтрально, без конфликта.\n4. Если данных недостаточно — предложи написать в личные сообщения.\n5. Не выдумывай цифры, даты и обещания.\n\nБАЗА ЗНАНИЙ:\n${knowledgeBase || "Релевантная база знаний недоступна."}\n\nОтветь только текстом реплая.`;
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: OPENAI_MODEL, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: `Комментарий пользователя:\n${commentText}` }], max_completion_tokens: 150 }),
  });
  const d = await res.json();
  if (!res.ok) {
    console.error("OpenAI API error:", res.status, d?.error?.type || "unknown_error");
    return null;
  }
  return d.choices?.[0]?.message?.content?.trim() || null;
}

async function fetchWithRetry(url, options, label, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url, options);
    if (res.status !== 429 && res.status < 500) return res;
    if (attempt === maxAttempts) return res;
    const backoff = 500 * (2 ** (attempt - 1)) + Math.floor(Math.random() * 250);
    await new Promise(resolve => setTimeout(resolve, backoff));
  }
}

async function postReply(parentCommentId, message) {
  if (!THREADS_ACCESS_TOKEN || !THREADS_USER_ID) {
    console.error("Threads config error: access token or user id missing");
    return null;
  }

  const createParams = new URLSearchParams({ media_type: "TEXT", text: message, reply_to_id: String(parentCommentId), access_token: THREADS_ACCESS_TOKEN });
  const createRes = await fetchWithRetry(`https://graph.threads.net/v1.0/me/threads?${createParams}`, { method: "POST" }, "create");
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

  await new Promise(r => setTimeout(r, 5000));

  const publishParams = new URLSearchParams({ creation_id: String(creationId), access_token: THREADS_ACCESS_TOKEN });
  const publishRes = await fetchWithRetry(`https://graph.threads.net/v1.0/${encodeURIComponent(THREADS_USER_ID)}/threads_publish?${publishParams}`, { method: "POST" }, "publish");
  const publishData = await publishRes.json();
  if (!publishRes.ok || publishData.error) {
    console.error("Threads publish error:", publishRes.status, publishData?.error?.code || "unknown_error");
    return null;
  }

  const publishedId = publishData.id || null;
  if (publishedId) botGeneratedIds.set(String(publishedId), now());
  console.log("Threads reply posted", JSON.stringify({ id: publishedId }));
  return publishedId;
}

app.listen(PORT, () => console.log(`Bot listening on port ${PORT}; model=${OPENAI_MODEL}; safety=v6; enabled=${isEnabled()}; dryRun=${isDryRun()}`));
