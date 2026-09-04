/**
 * Leo Akastel | Business & Tech — Threads Auto-Reply Bot
 * Flow: Threads webhook -> Airtable knowledge base -> OpenAI -> Threads reply -> Airtable log
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
  PORT = 3000,
} = process.env;

const AIRTABLE_URL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}`;

app.get("/", (_req, res) => res.status(200).send("Leo Akastel Threads bot is running"));
app.get("/health", (_req, res) => res.status(200).json({ ok: true }));

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === THREADS_VERIFY_TOKEN) {
    console.log("Webhook verified");
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    for (const entry of req.body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field === "replies" || change.field === "comments") await handleComment(change.value);
      }
    }
  } catch (err) {
    console.error("Webhook processing error:", err);
  }
});

async function handleComment(comment) {
  const { id: commentId, text, from, media_id } = comment || {};
  if (!commentId || !text) return;
  if (from?.id && THREADS_USER_ID && String(from.id) === String(THREADS_USER_ID)) return;

  const context = await getContext();
  const replyText = await generateReply(text, context);
  if (!replyText) return;

  const replyId = await postReply(commentId, replyText);
  await logInteraction({ commentId, author: from?.username || "unknown", commentText: text, replyText, replyId, mediaId: media_id });
}

async function getContext() {
  const url = `${AIRTABLE_URL}/KnowledgeBase?maxRecords=20`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` } });
  if (!res.ok) {
    console.error("Airtable KnowledgeBase error:", res.status, await res.text());
    return "";
  }
  const data = await res.json();
  return (data.records || []).map((r) => {
    const q = r.fields.Question || r.fields.Title || "";
    const a = r.fields.Answer || r.fields.Content || "";
    return q || a ? `- ${q}${q && a ? ": " : ""}${a}` : "";
  }).filter(Boolean).join("\n");
}

async function logInteraction(row) {
  const url = `${AIRTABLE_URL}/Comments`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: {
      "Comment ID": row.commentId,
      Author: row.author,
      "Comment Text": row.commentText,
      "Reply Text": row.replyText,
      "Reply ID": row.replyId || "",
      "Media ID": row.mediaId || ""
    } }),
  });
  if (!res.ok) console.error("Airtable log error:", res.status, await res.text());
}

async function generateReply(commentText, knowledgeBase) {
  const systemPrompt = `Ты — ассистент, который отвечает на комментарии под постами в Threads от имени бренда/аккаунта Leo Akastel | Business & Tech.

ТОН И СТИЛЬ:
- Дружелюбно, живо, без канцелярита
- Коротко: 1-2 предложения максимум
- Без эмодзи через каждое слово — максимум 1 emoji, если уместно
- Пиши на языке, на котором написан комментарий (русский/украинский/английский — определяй автоматически)
- Обращайся на "ты", если комментарий неформальный; на "вы" — если формальный

ПРАВИЛА:
1. Если вопрос закрывается базой знаний ниже — используй её, не выдумывай факты
2. Если комментарий — просто эмоция/благодарность/поддержка — ответь коротко и тепло, без лишней информации
3. Если комментарий агрессивный, токсичный, провокационный — не вступай в конфликт, ответь нейтрально-вежливо или вообще без сарказма
4. Если вопрос выходит за рамки твоей компетенции или базы знаний — предложи написать в личные сообщения для детального ответа
5. Никогда не выдумывай цифры, даты, обещания от лица бренда, если их нет в базе знаний
6. Не используй кэпс, не кричи, не используй множество восклицательных знаков подряд

БАЗА ЗНАНИЙ (используй как контекст, если релевантно):
${knowledgeBase || "База знаний пока не содержит релевантной информации."}

Ответь только текстом реплая, без пояснений и без кавычек.`;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Комментарий пользователя:\n${commentText}` },
      ],
      max_tokens: 150,
      temperature: 0.7,
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    console.error("OpenAI API error:", response.status, data);
    return null;
  }
  return data.choices?.[0]?.message?.content?.trim() || null;
}

async function postReply(parentCommentId, message) {
  const url = `https://graph.threads.net/v1.0/${parentCommentId}/replies`;
  const params = new URLSearchParams({ message, access_token: THREADS_ACCESS_TOKEN });
  const res = await fetch(`${url}?${params.toString()}`, { method: "POST" });
  const data = await res.json();
  if (!res.ok || data.error) {
    console.error("Threads API error:", data.error || data);
    return null;
  }
  return data.id;
}

app.listen(PORT, () => console.log(`Bot listening on port ${PORT}; model=${OPENAI_MODEL}`));
