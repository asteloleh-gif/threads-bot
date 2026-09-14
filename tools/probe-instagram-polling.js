'use strict';

async function requestJson(url) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.INSTAGRAM_ACCESS_TOKEN || ''}` },
  });
  let body = {};
  try { body = await response.json(); } catch (_) {}
  return { response, body };
}

function safeError(body) {
  return body?.error ? { code: body.error.code, type: body.error.type } : null;
}

async function mediaProbe(label, path) {
  const url = `https://graph.instagram.com/v26.0/${path}/media?fields=id,timestamp,media_product_type,comments_count&limit=5`;
  const result = await requestJson(url);
  console.log(`IG polling probe ${label}`, {
    status: result.response.status,
    count: Array.isArray(result.body?.data) ? result.body.data.length : 0,
    commentsCounts: Array.isArray(result.body?.data) ? result.body.data.map(item => Number(item.comments_count) || 0) : [],
    error: safeError(result.body),
  });
  return result;
}

async function main() {
  const configuredUserId = String(process.env.INSTAGRAM_USER_ID || '').trim();
  const token = String(process.env.INSTAGRAM_ACCESS_TOKEN || '').trim();
  if (!configuredUserId || !token) throw new Error('IG_CONFIG_MISSING');

  const me = await requestJson('https://graph.instagram.com/v26.0/me?fields=id,user_id,username');
  console.log('IG polling probe identity', {
    status: me.response.status,
    id: me.body?.id || null,
    user_id: me.body?.user_id || null,
    username: me.body?.username || null,
    configuredMatchesUserId: String(me.body?.user_id || '') === configuredUserId,
    error: safeError(me.body),
  });
  if (!me.response.ok) process.exit(1);

  const explicit = await mediaProbe('media-explicit-user-id', encodeURIComponent(configuredUserId));
  const meMedia = await mediaProbe('media-me', 'me');
  const appScoped = me.body?.id ? await mediaProbe('media-app-scoped-id', encodeURIComponent(me.body.id)) : null;

  const candidates = [explicit, meMedia, appScoped].filter(Boolean);
  const mediaResult = candidates.find(item => item.response.ok && Array.isArray(item.body?.data) && item.body.data.length > 0);
  if (!mediaResult) return;

  const first = mediaResult.body.data[0];
  const commentsUrl = `https://graph.instagram.com/v26.0/${encodeURIComponent(first.id)}/comments?fields=id,text,username,from,parent_id,timestamp,replies{id,text,username,from,parent_id,timestamp}&limit=10`;
  const comments = await requestJson(commentsUrl);
  console.log('IG polling probe comments', {
    status: comments.response.status,
    count: Array.isArray(comments.body?.data) ? comments.body.data.length : 0,
    replyCounts: Array.isArray(comments.body?.data) ? comments.body.data.map(item => Array.isArray(item?.replies?.data) ? item.replies.data.length : 0) : [],
    error: safeError(comments.body),
  });
  if (!comments.response.ok) process.exit(1);
}

main().catch(error => {
  console.error('IG polling probe failed', error?.message || String(error));
  process.exit(1);
});
