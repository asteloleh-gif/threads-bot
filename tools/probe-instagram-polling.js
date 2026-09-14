'use strict';

async function requestJson(url) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${process.env.INSTAGRAM_ACCESS_TOKEN || ''}` },
  });
  let body = {};
  try { body = await response.json(); } catch (_) {}
  return { response, body };
}

async function main() {
  const userId = String(process.env.INSTAGRAM_USER_ID || '').trim();
  const token = String(process.env.INSTAGRAM_ACCESS_TOKEN || '').trim();
  if (!userId || !token) throw new Error('IG_CONFIG_MISSING');

  const mediaUrl = `https://graph.instagram.com/v26.0/${encodeURIComponent(userId)}/media?fields=id,timestamp,media_product_type&limit=3`;
  const media = await requestJson(mediaUrl);
  console.log('IG polling probe media', {
    status: media.response.status,
    count: Array.isArray(media.body?.data) ? media.body.data.length : 0,
    error: media.body?.error ? { code: media.body.error.code, type: media.body.error.type } : null,
  });
  if (!media.response.ok) process.exit(1);

  const first = Array.isArray(media.body?.data) ? media.body.data[0] : null;
  if (!first?.id) return;

  const commentsUrl = `https://graph.instagram.com/v26.0/${encodeURIComponent(first.id)}/comments?fields=id,text,username,from,parent_id,timestamp&limit=10`;
  const comments = await requestJson(commentsUrl);
  console.log('IG polling probe comments', {
    status: comments.response.status,
    count: Array.isArray(comments.body?.data) ? comments.body.data.length : 0,
    error: comments.body?.error ? { code: comments.body.error.code, type: comments.body.error.type } : null,
  });
  if (!comments.response.ok) process.exit(1);
}

main().catch(error => {
  console.error('IG polling probe failed', error?.message || String(error));
  process.exit(1);
});
