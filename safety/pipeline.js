function createSafetyPipeline({ threadsUserId, selfUsername = "leoakastel", selfUserId = "27979923121676296", botEnabled = "false", botDryRun = "true" }) {
  const USER_COOLDOWN_MS = 20 * 1000;
  const CONVERSATION_WINDOW_MS = 24 * 60 * 60 * 1000;
  const CONVERSATION_MAX_REPLIES = 10;
  const GLOBAL_WINDOW_MS = 24 * 60 * 60 * 1000;
  const GLOBAL_MAX_REPLIES = 50;
  const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
  const processingComments = new Map(), publishedBySource = new Map(), botGeneratedIds = new Map();
  const conversationLastReplyAt = new Map(), conversationReplyTimes = new Map(), globalReplyTimes = [];
  let reservationSeq = 0;
  const now = () => Date.now();
  const nextReservationId = () => `r${++reservationSeq}`;
  const normalizeUsername = v => String(v || "").trim().toLowerCase();
  const isEnabled = () => String(botEnabled).toLowerCase() === "true";
  const isDryRun = () => String(botDryRun).toLowerCase() === "true";
  function pruneMapByTimestamp(map, ttl) { const t=now(); for (const [k,v] of map) { const ts=typeof v==="number"?v:v?.timestamp; if(typeof ts==="number"&&t-ts>ttl) map.delete(k); } }
  function isSelfAuthored({authorId,authorUsername}) { const u=normalizeUsername(authorUsername); return u===selfUsername||(authorId&&String(authorId)===selfUserId)||(authorId&&threadsUserId&&String(authorId)===String(threadsUserId)); }
  function isBotGeneratedId(id) { pruneMapByTimestamp(botGeneratedIds,IDEMPOTENCY_TTL_MS); return id?botGeneratedIds.has(String(id)):false; }
  function markBotGeneratedId(id) { if(id) botGeneratedIds.set(String(id),now()); }
  function reserveComment(commentId) { pruneMapByTimestamp(processingComments,IDEMPOTENCY_TTL_MS); pruneMapByTimestamp(publishedBySource,IDEMPOTENCY_TTL_MS); const k=String(commentId); if(processingComments.has(k)||publishedBySource.has(k)) return false; processingComments.set(k,now()); return true; }
  function releaseComment(id) { processingComments.delete(String(id)); }
  function getUserKey({authorId,authorUsername}) { if(authorId) return `id:${String(authorId)}`; const u=normalizeUsername(authorUsername); return u?`username:${u}`:null; }
  function getConversationKey({userKey,rootId}) { return userKey&&rootId?`${userKey}|thread:${String(rootId)}`:null; }
  function cooldownRemainingMs(key) { if(!key) return USER_COOLDOWN_MS; const e=conversationLastReplyAt.get(key); if(!e) return 0; const ts=typeof e==="number"?e:e.timestamp; return Math.max(0,USER_COOLDOWN_MS-(now()-ts)); }
  function userOnCooldown(key) { return cooldownRemainingMs(key)>0; }
  function getConversationReplyCount(key) { if(!key) return CONVERSATION_MAX_REPLIES; const t=now(); const recent=(conversationReplyTimes.get(key)||[]).filter(e=>t-(typeof e==="number"?e:e.timestamp)<CONVERSATION_WINDOW_MS); conversationReplyTimes.set(key,recent); return recent.length; }
  function conversationLimitReached(key) { return getConversationReplyCount(key)>=CONVERSATION_MAX_REPLIES; }
  function threadOnCooldown() { return false; }
  function globalLimitReached() { const t=now(); while(globalReplyTimes.length&&t-(typeof globalReplyTimes[0]==="number"?globalReplyTimes[0]:globalReplyTimes[0].timestamp)>=GLOBAL_WINDOW_MS) globalReplyTimes.shift(); return globalReplyTimes.length>=GLOBAL_MAX_REPLIES; }
  function reserveRateLimitSlot({conversationKey,userKey,rootId}) { const ck=conversationKey||getConversationKey({userKey,rootId}); const t=now(), reservationId=nextReservationId(), entry={reservationId,timestamp:t}; if(userKey) conversationLastReplyAt.set(userKey,entry); if(ck){ conversationLastReplyAt.set(ck,entry); const list=(conversationReplyTimes.get(ck)||[]).filter(e=>t-(typeof e==="number"?e:e.timestamp)<CONVERSATION_WINDOW_MS); list.push(entry); conversationReplyTimes.set(ck,list); } globalReplyTimes.push(entry); return {conversationKey:ck,userKey,reservedAt:t,reservationId}; }
  function releaseRateLimitSlot(r) { if(!r)return; const {conversationKey,userKey,reservationId}=r; for(const key of [userKey,conversationKey].filter(Boolean)){ const last=conversationLastReplyAt.get(key); if(last&&last.reservationId===reservationId) conversationLastReplyAt.delete(key); } if(conversationKey) conversationReplyTimes.set(conversationKey,(conversationReplyTimes.get(conversationKey)||[]).filter(e=>e.reservationId!==reservationId)); const i=globalReplyTimes.findIndex(e=>e.reservationId===reservationId); if(i!==-1)globalReplyTimes.splice(i,1); }
  function recordSuccessfulReply({sourceCommentId,publishedReplyId}) { const t=now(); if(sourceCommentId) publishedBySource.set(String(sourceCommentId),{publishedReplyId:publishedReplyId||null,timestamp:t}); if(publishedReplyId) botGeneratedIds.set(String(publishedReplyId),t); }
  function markAmbiguous(id){ if(id) processingComments.set(String(id),{timestamp:now(),ambiguous:true}); }
  function ambiguousCount(){ let n=0; for(const v of processingComments.values()) if(v&&typeof v==="object"&&v.ambiguous)n++; return n; }
  return {isEnabled,isDryRun,isSelfAuthored,isBotGeneratedId,markBotGeneratedId,reserveComment,releaseComment,getUserKey,getConversationKey,userOnCooldown,cooldownRemainingMs,getConversationReplyCount,conversationLimitReached,threadOnCooldown,globalLimitReached,reserveRateLimitSlot,releaseRateLimitSlot,markAmbiguous,ambiguousCount,recordSuccessfulReply,limits:{USER_COOLDOWN_MS,CONVERSATION_WINDOW_MS,CONVERSATION_MAX_REPLIES,GLOBAL_WINDOW_MS,GLOBAL_MAX_REPLIES}};
}
module.exports={createSafetyPipeline};
