/**
 * Leo Akastel | Business & Tech — Threads Auto-Reply Bot
 */
const express = require("express");
const bodyParser = require("body-parser");
const fetch = require("node-fetch");
const { createThreadsAdapter } = require("./adapters/threadsAdapter");
const { createSafetyPipeline } = require("./safety/pipeline");
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

const safety = createSafetyPipeline({
  threadsUserId: THREADS_USER_ID,
  botEnabled: BOT_ENABLED,
  botDryRun: BOT_DRY_RUN,
});

const threads = createThreadsAdapter({
  accessToken: THREADS_ACCESS_TOKEN,
  userId: THREADS_USER_ID,
  onPublishedReplyId: safety.markBotGeneratedId,
});

app.get("/", (_q, r) => r.status(200).send("Leo Akastel Threads bot is running"));
app.get("/health", (_q, r) => r.status(200).json({ ok: true, enabled: safety.isEnabled(), dryRun: safety.isDryRun() }));

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

  if (!safety.isEnabled()) {
    console.log("Bot disabled: webhook acknowledged only");
    return;
  }

  try {
    for (const event of threads.parseWebhook(q.body)) {
      await handleComment(event);
    }
  } catch (e) {
    console.error("Webhook processing error:", e?.message || String(e));
  }
});

async function handleComment(c) {
  const commentId = threads.getCommentId(c);
  const text = threads.getCommentText(c);
  const author = threads.getAuthorUsername(c);
  const authorId = threads.getAuthorId(c);
  const rootId = threads.getRootPostId(c);

  if (!commentId || !text || !author || !rootId) {
    console.log("Reply skipped: invalid payload");
    return;
  }

  if (safety.isSelfAuthored({ authorId, authorUsername: author })) {
    console.log("Reply skipped: self-authored");
    return;
  }

  if (safety.isBotGeneratedId(commentId)) {
    console.log("Reply skipped: bot-generated object");
    return;
  }

  if (!safety.reserveComment(commentId)) {
    console.log("Reply skipped: duplicate", String(commentId));
    return;
  }

  const userKey = safety.getUserKey({ authorId, authorUsername: author });
  if (!userKey) {
    console.log("Reply skipped: invalid payload");
    safety.releaseComment(commentId);
    return;
  }

  if (safety.userOnCooldown(userKey)) {
    console.log("Reply skipped: user cooldown");
    safety.releaseComment(commentId);
    return;
  }

  if (safety.threadOnCooldown(rootId)) {
    console.log("Reply skipped: thread cooldown");
    safety.releaseComment(commentId);
    return;
  }

  if (safety.globalLimitReached()) {
    console.log("Reply skipped: global rate limit");
    safety.releaseComment(commentId);
    return;
  }

  try {
    const context = await getContext();
    const replyText = await generateReply(text, context);
    if (!replyText) {
      safety.releaseComment(commentId);
      return;
    }

    console.log("AI reply generated", JSON.stringify({ length: replyText.length }));

    if (safety.isDryRun()) {
      console.log("DRY RUN: would reply", JSON.stringify({ sourceCommentId: String(commentId), length: replyText.length }));
      safety.releaseComment(commentId);
      return;
    }

    const replyId = await threads.reply(commentId, replyText);
    if (!replyId) {
      safety.releaseComment(commentId);
      return;
    }

    safety.recordSuccessfulReply({ sourceCommentId: commentId, publishedReplyId: replyId, userKey, rootId });
    safety.releaseComment(commentId);
    await logInteraction({ commentId, author: author || authorId || "unknown", commentText: text, replyText, replyId, mediaId: rootId });
  } catch (e) {
    safety.releaseComment(commentId);
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

app.listen(PORT, () => console.log(`Bot listening on port ${PORT}; model=${OPENAI_MODEL}; safety=v6; enabled=${safety.isEnabled()}; dryRun=${safety.isDryRun()}`));
