/**
 * Threads Auto-Reply Bot — skeleton
 * Flow: Threads webhook -> Airtable (context/rules/log) -> GPT-4o-mini -> Threads reply
 *
 * ENV VARS needed (see .env.example):
 *   THREADS_ACCESS_TOKEN
 *   THREADS_USER_ID
 *   THREADS_VERIFY_TOKEN      (for webhook verification handshake)
 *   AIRTABLE_API_KEY
 *   AIRTABLE_BASE_ID
 *   OPENAI_API_KEY
 *   PORT (optional, default 3000)
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
  PORT = 3000,
} = process.env;

const AIRTABLE_URL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}`;

// ---------- 1. Webhook verification (Meta requires this handshake) ----------
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

// ---------- 2. Incoming webhook events (new comments/replies) ----------
app.post("/webhook", async (req, res) => {
  // Respond fast, process async — Meta expects a quick 200
  res.sendStatus(200);

  try {
    const entries = req.body.entry || [];
    for (const entry of entries) {
      const changes = entry.changes || [];
      for (const change of changes) {
        if (change.field === "replies" || change.field === "comments") {
          await handleComment(change.value);
        }
      }
    }
  } catch (err) {
    console.error("Webhook processing error:", err);
  }
});

// ---------- 3. Core handler ----------
async function handleComment(comment) {
  const { id: commentId, text, from, media_id } = comment;

  if (!text) return;

  // 3a. Check ignore list / moderation rules in Airtable
  const shouldSkip = await isIgnored(from?.username);
  if (shouldSkip) {
    console.log(`Skipping comment from ignored user: ${from?.username}`);
    return;
  }

  // 3b. Pull relevant context (FAQ / tone rules) from Airtable
  const context = await getContext();

  // 3c. Generate reply via GPT-4o-mini
  const replyText = await generateReply(text, context);

  // 3d. Post reply back to Threads
  const replyId = await postReply(commentId, replyText);

  // 3e. Log everything to Airtable
  await logInteraction({
    commentId,
    author: from?.username || "unknown",
    commentText: text,
    replyText,
    replyId,
    mediaId: media_id,
  });
}

// ---------- Airtable helpers ----------
async function isIgnored(username) {
  if (!username) return false;
  const url = `${AIRTABLE_URL}/IgnoreList?filterByFormula={Username}="${username}"`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` },
  });
  const data = await res.json();
  return (data.records || []).length > 0;
}

async function getContext() {
  // Pulls short FAQ/tone snippets to feed the model as context (basic RAG)
  const url = `${AIRTABLE_URL}/KnowledgeBase?maxRecords=20`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` },
  });
  const data = await res.json();
  return (data.records || [])
    .map((r) => `- ${r.fields.Question}: ${r.fields.Answer}`)
    .join("\n");
}

async function logInteraction(row) {
  const url = `${AIRTABLE_URL}/Log`;
  await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${AIRTABLE_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      fields: {
        "Comment ID": row.commentId,
        Author: row.author,
        "Comment Text": row.commentText,
        "Reply Text": row.replyText,
        "Reply ID": row.replyId,
        "Media ID": row.mediaId,
        Timestamp: new Date().toISOString(),
      },
    }),
  });
}

// ---------- GPT-4o-mini ----------
async function generateReply(commentText, context) {
  const systemPrompt = `You are replying to comments on a Threads post.
Keep replies short (1-2 sentences), friendly, on-brand.
Use this knowledge base if relevant:\n${context}`;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: commentText },
      ],
      max_tokens: 150,
      temperature: 0.7,
    }),
  });

  const data = await response.json();
  return data.choices?.[0]?.message?.content?.trim() || "Спасибо за комментарий!";
}

// ---------- Threads API ----------
async function postReply(parentCommentId, message) {
  // Threads reply-to-comment endpoint (Graph API style)
  const url = `https://graph.threads.net/v1.0/${parentCommentId}/replies`;
  const params = new URLSearchParams({
    message,
    access_token: THREADS_ACCESS_TOKEN,
  });

  const res = await fetch(`${url}?${params.toString()}`, { method: "POST" });
  const data = await res.json();

  if (data.error) {
    console.error("Threads API error:", data.error);
    return null;
  }
  return data.id;
}

app.listen(PORT, () => console.log(`Bot listening on port ${PORT}`));
