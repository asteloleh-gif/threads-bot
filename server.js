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
const { THREADS_ACCESS_TOKEN, THREADS_USER_ID, THREADS_VERIFY_TOKEN, AIRTABLE_API_KEY, AIRTABLE_BASE_ID, OPENAI_API_KEY, OPENAI_MODEL = "gpt-5.6-luna", PORT = 3000 } = process.env;
const AIRTABLE_URL = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}`;
const seenReplies = new Map();
const DEDUPE_TTL_MS = 10 * 60 * 1000;
function isDuplicate(id){
  const now=Date.now();
  for(const [key,ts] of seenReplies){ if(now-ts>DEDUPE_TTL_MS) seenReplies.delete(key); }
  if(seenReplies.has(String(id))) return true;
  seenReplies.set(String(id),now);
  return false;
}
app.get("/", (_req,res)=>res.status(200).send("Leo Akastel Threads bot is running"));
app.get("/health", (_req,res)=>res.status(200).json({ok:true}));
app.get("/webhook", (req,res)=>{ const mode=req.query["hub.mode"], token=req.query["hub.verify_token"], challenge=req.query["hub.challenge"]; if(mode==="subscribe"&&token===THREADS_VERIFY_TOKEN){ console.log("Webhook verified"); return res.status(200).send(challenge); } return res.sendStatus(403); });
app.post("/webhook", async (req,res)=>{
  res.sendStatus(200);
  try {
    const values=Array.isArray(req.body?.values)?req.body.values:[];
    console.log("Webhook POST",JSON.stringify({topic:req.body?.topic||null,target_id:req.body?.target_id||null,valueCount:values.length}));
    for(const item of values){
      if(item?.field!=="replies"&&item?.field!=="comments") continue;
      const value=item?.value;
      if(!value) continue;
      if(value.id&&isDuplicate(value.id)){ console.log("Reply skipped: duplicate",String(value.id)); continue; }
      await handleComment(value);
    }
    // Compatibility with Graph-style payloads if Meta sends them for other webhook modes.
    for(const entry of req.body?.entry||[]){
      for(const change of entry?.changes||[]){
        if(change?.field!=="replies"&&change?.field!=="comments") continue;
        const value=change?.value;
        if(!value) continue;
        if(value.id&&isDuplicate(value.id)){ console.log("Reply skipped: duplicate",String(value.id)); continue; }
        await handleComment(value);
      }
    }
  } catch(err){ console.error("Webhook processing error:",err); }
});
async function handleComment(comment){
  const commentId=comment?.id||comment?.reply_id||comment?.media?.id;
  const text=comment?.text||comment?.reply_text||comment?.media?.text;
  const author=comment?.username||comment?.from?.username||comment?.user?.username||"unknown";
  const authorId=comment?.user_id||comment?.from?.id||comment?.user?.id||null;
  const mediaId=comment?.replied_to?.id||comment?.root_post?.id||comment?.media_id||comment?.media?.id||null;
  console.log("Parsed reply",JSON.stringify({hasId:!!commentId,hasText:!!text,author}));
  if(!commentId||!text){ console.log("Reply skipped: missing id/text"); return; }
  if(authorId&&THREADS_USER_ID&&String(authorId)===String(THREADS_USER_ID)){ console.log("Reply skipped: own account"); return; }
  const context=await getContext();
  const replyText=await generateReply(text,context);
  if(!replyText) return;
  console.log("AI reply generated",JSON.stringify({length:replyText.length}));
  const replyId=await postReply(commentId,replyText);
  await logInteraction({commentId,author,commentText:text,replyText,replyId,mediaId});
}
async function getContext(){ const url=`${AIRTABLE_URL}/KnowledgeBase?maxRecords=20`; const res=await fetch(url,{headers:{Authorization:`Bearer ${AIRTABLE_API_KEY}`}}); if(!res.ok){console.error("Airtable KnowledgeBase error:",res.status,await res.text());return "";} const data=await res.json(); return (data.records||[]).map(r=>{const q=r.fields.Question||r.fields.Title||"",a=r.fields.Answer||r.fields.Content||"";return q||a?`- ${q}${q&&a?": ":""}${a}`:"";}).filter(Boolean).join("\n"); }
async function logInteraction(row){ const url=`${AIRTABLE_URL}/Comments`; const res=await fetch(url,{method:"POST",headers:{Authorization:`Bearer ${AIRTABLE_API_KEY}`,"Content-Type":"application/json"},body:JSON.stringify({fields:{"Comment ID":row.commentId,Author:row.author,"Comment Text":row.commentText,"Reply Text":row.replyText,"Reply ID":row.replyId||"","Media ID":row.mediaId||""}})}); if(!res.ok)console.error("Airtable log error:",res.status,await res.text()); }
async function generateReply(commentText,knowledgeBase){ const systemPrompt=`Ты — ассистент, который отвечает на комментарии под постами в Threads от имени бренда/аккаунта Leo Akastel | Business & Tech.\n\nТОН И СТИЛЬ:\n- Дружелюбно, живо, без канцелярита\n- Коротко: 1-2 предложения максимум\n- Без эмодзи через каждое слово — максимум 1 emoji, если уместно\n- Пиши на языке, на котором написан комментарий (русский/украинский/английский — определяй автоматически)\n- Обращайся на \"ты\", если комментарий неформальный; на \"вы\" — если формальный\n\nПРАВИЛА:\n1. Если вопрос закрывается базой знаний ниже — используй её, не выдумывай факты\n2. Если комментарий — просто эмоция/благодарность/поддержка — ответь коротко и тепло, без лишней информации\n3. Если комментарий агрессивный, токсичный, провокационный — не вступай в конфликт, ответь нейтрально-вежливо или вообще без сарказма\n4. Если вопрос выходит за рамки твоей компетенции или базы знаний — предложи написать в личные сообщения для детального ответа\n5. Никогда не выдумывай цифры, даты, обещания от лица бренда, если их нет в базе знаний\n6. Не используй кэпс, не кричи, не используй множество восклицательных знаков подряд\n\nБАЗА ЗНАНИЙ:\n${knowledgeBase||"База знаний пока не содержит релевантной информации."}\n\nОтветь только текстом реплая, без пояснений и без кавычек.`; const response=await fetch("https://api.openai.com/v1/chat/completions",{method:"POST",headers:{Authorization:`Bearer ${OPENAI_API_KEY}`,"Content-Type":"application/json"},body:JSON.stringify({model:OPENAI_MODEL,messages:[{role:"system",content:systemPrompt},{role:"user",content:`Комментарий пользователя:\n${commentText}`}],max_tokens:150,temperature:0.7})}); const data=await response.json(); if(!response.ok){console.error("OpenAI API error:",response.status,JSON.stringify(data));return null;} return data.choices?.[0]?.message?.content?.trim()||null; }
async function postReply(parentCommentId,message){ const url=`https://graph.threads.net/v1.0/${parentCommentId}/replies`; const params=new URLSearchParams({message,access_token:THREADS_ACCESS_TOKEN}); const res=await fetch(`${url}?${params.toString()}`,{method:"POST"}); const data=await res.json(); if(!res.ok||data.error){console.error("Threads API error:",JSON.stringify(data.error||data));return null;} console.log("Threads reply posted",JSON.stringify({id:data.id||null})); return data.id; }
app.listen(PORT,()=>console.log(`Bot listening on port ${PORT}; model=${OPENAI_MODEL}; diagnostics=v3`));
