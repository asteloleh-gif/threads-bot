'use strict';

async function main() {
  const userId = String(process.env.INSTAGRAM_USER_ID || '').trim();
  const accessToken = String(process.env.INSTAGRAM_ACCESS_TOKEN || '').trim();

  if (!userId || !accessToken) {
    console.error('Instagram webhook subscribe: IG_CONFIG_MISSING');
    process.exit(1);
  }

  const url = `https://graph.instagram.com/v26.0/${encodeURIComponent(userId)}/subscribed_apps?subscribed_fields=comments`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  let body = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }

  const safeError = body?.error
    ? {
        code: body.error.code,
        type: body.error.type,
        message: body.error.message,
      }
    : null;

  console.log('Instagram webhook subscribe', {
    status: response.status,
    success: body?.success === true,
    error: safeError,
  });

  if (!response.ok || body?.success !== true) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Instagram webhook subscribe failed', error?.message || String(error));
  process.exit(1);
});
