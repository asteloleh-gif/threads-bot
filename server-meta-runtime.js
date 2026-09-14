const base = require("./server-meta");
const legacy = require("./server");
const { createInstagramCommentPoller } = require("./app/polling/instagramCommentPoller");
const { createPublicLegalRouter } = require("./app/legal/publicLegalRoutes");

function bool(value, fallback = false) {
  if (value == null || value === "") return fallback;
  return String(value).trim().toLowerCase() === "true";
}

const {
  REDIS_URL,
  INSTAGRAM_POLLING_ENABLED = "false",
  INSTAGRAM_POLLING_INTERVAL_MS = "60000",
  INSTAGRAM_POLLING_MEDIA_LIMIT = "10",
  INSTAGRAM_POLLING_COMMENTS_LIMIT = "50",
  INSTAGRAM_POLLING_FULL_SCAN_EVERY = "10",
} = process.env;

base.app.use(createPublicLegalRouter());

const instagramPollers = legacy.socialContext.providers.list()
  .filter(provider => provider.platform === "instagram")
  .map(provider => createInstagramCommentPoller({
    provider,
    handler: base.handleSecondaryWebhook,
    redisUrl: REDIS_URL,
    enabled: bool(INSTAGRAM_POLLING_ENABLED, false),
    intervalMs: Number(INSTAGRAM_POLLING_INTERVAL_MS),
    mediaLimit: Number(INSTAGRAM_POLLING_MEDIA_LIMIT),
    commentsLimit: Number(INSTAGRAM_POLLING_COMMENTS_LIMIT),
    fullScanEvery: Number(INSTAGRAM_POLLING_FULL_SCAN_EVERY),
  }));

base.app.get("/health/instagram-polling", (_req, res) => {
  const polling = instagramPollers.map(poller => poller.health());
  const ok = polling.every(item => !item.enabled || item.store?.connected);
  res.status(ok ? 200 : 503).json({ ok, polling });
});

async function start() {
  await base.start();

  const pollingStart = [];
  for (const poller of instagramPollers) {
    pollingStart.push(await poller.init());
  }
  console.log("Instagram polling startup", JSON.stringify(pollingStart));
}

if (require.main === module) {
  start().catch(error => {
    console.error("Fatal runtime startup error:", error?.message || String(error));
    process.exit(1);
  });
}

module.exports = {
  ...base,
  start,
  instagramPollers,
};
