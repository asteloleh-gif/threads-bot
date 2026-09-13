/**
 * Astel Social Engine — unified Meta webhook entrypoint.
 *
 * This entrypoint deliberately reuses the proven Threads Community Engine from
 * server.js and adds account-scoped Instagram/Facebook runtimes around it. The
 * legacy server remains intact as a one-line rollback target.
 */
const express = require("express");
const bodyParser = require("body-parser");
require("dotenv").config();

const legacy = require("./server");
const { createMetaWebhookRouter } = require("./app/webhooks/metaWebhookRouter");
const { createCommunityRuntime } = require("./app/community/createCommunityRuntime");
const { createPlatformReplyGenerator } = require("./app/community/createPlatformReplyGenerator");
const { loadProactiveConfig } = require("./config/proactive");

const app = express();
app.use(bodyParser.json());

const {
  REDIS_URL,
  PORT = 3000,
  MAX_MEMORY_MESSAGES = "8",
  MAX_MEMORY_TOKENS = "1000",
  PROACTIVE_PERMISSION_PROBE = "false",
  OPENAI_MODEL = "gpt-5.6-luna",
} = process.env;

const platformReplyGenerator = createPlatformReplyGenerator({ env: process.env });
const proactiveConfig = loadProactiveConfig();
const secondaryCommunity = new Map();

for (const provider of legacy.socialContext.providers.list()) {
  if (provider.platform === "threads") continue;
  const runtime = createCommunityRuntime({
    provider,
    redisUrl: REDIS_URL,
    policy: legacy.policy,
    getContext: legacy.getContext,
    generateReply: platformReplyGenerator,
    maxMemoryMessages: Number(MAX_MEMORY_MESSAGES),
    maxMemoryTokens: Number(MAX_MEMORY_TOKENS),
  });
  secondaryCommunity.set(provider.accountKey, runtime);
}

async function handleThreadsWebhook({ native }) {
  if (!legacy.safety.isEnabled()) {
    console.log("Bot disabled: Threads webhook acknowledged only");
    return { status: "ignored", reason: "BOT_DISABLED" };
  }
  if (!legacy.safety.isReady() || !legacy.humanLocks.isReady()) {
    console.error("Reply skipped", JSON.stringify({ platform: "threads", reason: "SAFETY_STORE_UNAVAILABLE" }));
    return { status: "ignored", reason: "SAFETY_STORE_UNAVAILABLE" };
  }
  await legacy.handleComment(native);
  return { status: "ok" };
}

async function handleSecondaryWebhook({ platform, provider, event }) {
  const runtime = secondaryCommunity.get(provider.accountKey);
  if (!runtime) {
    console.error("Reply skipped", JSON.stringify({ platform, accountKey: provider.accountKey, reason: "COMMUNITY_RUNTIME_MISSING" }));
    return { status: "ignored", reason: "COMMUNITY_RUNTIME_MISSING" };
  }
  const result = await runtime.handleComment(event);
  console.log("Community event processed", JSON.stringify({
    platform,
    accountKey: provider.accountKey,
    sourceId: event?.sourceId || null,
    status: result?.status || null,
    reason: result?.reason || null,
    replyId: result?.replyId || null,
  }));
  return result;
}

const metaWebhookRouter = createMetaWebhookRouter({
  providerRegistry: legacy.socialContext.providers,
  handlers: {
    threads: handleThreadsWebhook,
    instagram: handleSecondaryWebhook,
    facebook: handleSecondaryWebhook,
  },
});

app.get("/", (_req, res) => {
  res.status(200).send("Astel Social Engine is running — Meta multi-platform v1");
});

app.get("/health", async (_req, res) => {
  let ambiguousPending = null;
  try {
    if (legacy.safety.isReady()) ambiguousPending = await legacy.safety.ambiguousCount();
  } catch (_) {}

  const redis = legacy.safety.health();
  const humanLock = legacy.humanLocks.health();
  const secondary = Array.from(secondaryCommunity.values()).map(runtime => runtime.health());
  const secondaryOk = secondary.every(item =>
    !item.enabled || (item.redis?.connected && item.humanLock?.connected)
  );
  const ok = (!legacy.policy.redisRequired || redis.connected) && humanLock.connected && secondaryOk;

  res.status(ok ? 200 : 503).json({
    ok,
    version: "meta-v1",
    enabled: legacy.safety.isEnabled(),
    dryRun: legacy.safety.isDryRun(),
    redis,
    humanLock,
    ambiguousPending,
    policy: legacy.policy,
    limits: legacy.safety.limits,
    memory: { maxMessages: Number(MAX_MEMORY_MESSAGES), maxTokens: Number(MAX_MEMORY_TOKENS) },
    vision: {
      enabled: legacy.vision.isEnabled(),
      detail: legacy.vision.detail,
      maxImages: 1,
      moderation: "omni-moderation-latest",
      failClosedOnImageError: true,
      platforms: ["threads"],
    },
    social: legacy.socialContext.health(),
    community: {
      threads: {
        accountKey: legacy.threads.accountKey,
        platform: "threads",
        enabled: legacy.safety.isEnabled(),
        dryRun: legacy.safety.isDryRun(),
        redis,
        humanLock,
      },
      secondary,
    },
    proactive: {
      enabled: proactiveConfig.enabled,
      mode: proactiveConfig.mode,
      account: proactiveConfig.account || null,
      dailyDraftLimit: proactiveConfig.dailyDraftLimit,
      dailyAiTokenLimit: proactiveConfig.dailyAiTokenLimit,
    },
  });
});

app.get("/webhook", (req, res) => {
  const verification = metaWebhookRouter.verify(req.query);
  if (verification.ok) return res.status(200).send(verification.challenge);
  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  try {
    const result = await metaWebhookRouter.dispatch(req.body);
    console.log("Meta webhook routed", JSON.stringify(result));
  } catch (error) {
    console.error("Webhook processing error:", error?.message || String(error));
  }
});

async function start() {
  if (legacy.threads.tokenManager?.init) await legacy.threads.tokenManager.init();
  await legacy.safety.init();
  await legacy.humanLocks.init();
  for (const runtime of secondaryCommunity.values()) await runtime.init();

  app.listen(PORT, () => {
    console.log(`Astel Social Engine listening on port ${PORT}; model=${OPENAI_MODEL}; providers=${legacy.socialContext.providers.list().length}; threadsEnabled=${legacy.safety.isEnabled()}; threadsDryRun=${legacy.safety.isDryRun()}; secondary=${secondaryCommunity.size}`);
  });

  if (PROACTIVE_PERMISSION_PROBE === "true") {
    const result = await legacy.threadsDiscovery.searchPosts({ query: "business", searchType: "RECENT", limit: 1 });
    console.log("Threads keyword permission probe", JSON.stringify({
      status: result.status,
      reason: result.reason || null,
      httpStatus: result.httpStatus || null,
      apiErrorCode: result.apiErrorCode || null,
      postCount: Array.isArray(result.posts) ? result.posts.length : 0,
    }));
  }

  const proactiveStart = await legacy.proactiveRunner.start();
  console.log("Proactive copilot startup", JSON.stringify(proactiveStart));
}

if (require.main === module) {
  start().catch(error => {
    console.error("Fatal startup error:", error?.message || String(error));
    process.exit(1);
  });
}

module.exports = {
  app,
  start,
  metaWebhookRouter,
  secondaryCommunity,
  handleThreadsWebhook,
  handleSecondaryWebhook,
};
