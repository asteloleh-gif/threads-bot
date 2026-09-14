const { createThreadsPollingStore } = require("./threadsPollingStore");
const { createThreadsPollingReader } = require("./threadsPollingReader");

const TRANSIENT_REASONS = new Set([
  "BOT_DISABLED",
  "SAFETY_STORE_UNAVAILABLE",
  "DURABLE_STORE_UNAVAILABLE",
]);

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function createThreadsCommentPoller({
  provider,
  handler,
  redisUrl,
  enabled = false,
  intervalMs = 60000,
  postsLimit = 10,
  repliesLimit = 50,
  store,
  reader,
  logger = console,
} = {}) {
  if (!provider || provider.platform !== "threads") throw new Error("Threads comment poller requires a Threads provider");
  if (typeof handler !== "function") throw new Error("Threads comment poller requires a handler");

  const accountKey = provider.accountKey;
  const pollStore = store || createThreadsPollingStore({ redisUrl });
  const pollReader = reader || createThreadsPollingReader({
    tokenManager: provider.tokenManager,
    fallbackAccessToken: provider.account?.accessToken,
  });
  const pollEveryMs = clamp(intervalMs, 15000, 3600000, 60000);
  const recentPostsLimit = clamp(postsLimit, 1, 25, 10);
  const perPostRepliesLimit = clamp(repliesLimit, 1, 100, 50);

  let timer = null;
  let running = false;
  let initialized = false;
  let primed = false;
  let lastCycleAt = null;
  let lastError = null;
  let lastStats = null;

  function health() {
    return {
      platform: "threads",
      accountKey,
      enabled: Boolean(enabled),
      running: Boolean(timer),
      initialized,
      primed,
      intervalMs: pollEveryMs,
      postsLimit: recentPostsLimit,
      repliesLimit: perPostRepliesLimit,
      lastCycleAt,
      lastError,
      lastStats,
      store: pollStore.health?.() || null,
    };
  }

  async function readConversation(postId) {
    return pollReader.listConversation(postId, { limit: perPostRepliesLimit, reverse: false });
  }

  async function prime(posts) {
    if (!posts.length) return { status: "waiting", reason: "NO_POSTS_VISIBLE", discovered: 0 };
    const replyIds = [];
    const postIds = [];
    let readFailures = 0;

    for (const post of posts) {
      if (!post?.id) continue;
      postIds.push(String(post.id));
      if (!post?.metadata?.hasReplies) continue;
      const result = await readConversation(post.id);
      if (result.status !== "ok") {
        readFailures += 1;
        continue;
      }
      for (const reply of result.items || []) {
        if (reply?.id) replyIds.push(String(reply.id));
      }
    }

    if (readFailures) return { status: "failed", reason: "PRIME_READ_FAILED", readFailures, discovered: replyIds.length };
    await pollStore.markSeen(accountKey, replyIds);
    await pollStore.markKnownPosts(accountKey, postIds);
    await pollStore.markPrimed(accountKey);
    primed = true;
    return { status: "ok", discovered: replyIds.length };
  }

  async function runOnce() {
    if (!enabled) return { status: "skipped", reason: "THREADS_POLLING_DISABLED" };
    if (running) return { status: "skipped", reason: "CYCLE_ALREADY_RUNNING" };
    running = true;
    try {
      const postsResult = await provider.listRecentPosts({ limit: recentPostsLimit });
      if (postsResult.status !== "ok") {
        lastError = `${postsResult.reason || "POST_READ_FAILED"}${postsResult.code ? `:${postsResult.code}` : ""}`;
        lastStats = { status: "failed", stage: "posts", reason: postsResult.reason || null, code: postsResult.code || null };
        return lastStats;
      }

      const posts = Array.isArray(postsResult.posts) ? postsResult.posts.filter(post => post?.id) : [];
      primed = await pollStore.isPrimed(accountKey);
      if (!primed) {
        const result = await prime(posts);
        lastCycleAt = new Date().toISOString();
        lastError = result.status === "failed" ? result.reason : null;
        lastStats = {
          status: result.status,
          stage: "prime",
          posts: posts.length,
          discovered: result.discovered || 0,
          reason: result.reason || null,
        };
        logger.log("Threads polling primed", JSON.stringify({ accountKey, ...lastStats }));
        return lastStats;
      }

      const seen = await pollStore.getSeen(accountKey);
      const knownPosts = await pollStore.getKnownPosts(accountKey);
      const currentPostIds = posts.map(post => String(post.id));
      const discovered = [];
      let reads = 0;
      let readFailures = 0;

      for (const post of posts) {
        const postId = String(post.id);
        const isNewPost = !knownPosts.has(postId);
        if (!post?.metadata?.hasReplies && !isNewPost) continue;

        const result = await readConversation(postId);
        reads += 1;
        if (result.status !== "ok") {
          readFailures += 1;
          continue;
        }

        for (const reply of result.items || []) {
          const replyId = String(reply?.id || "").trim();
          if (!replyId || seen.has(replyId)) continue;
          const event = provider.normalizeWebhookEvent(reply);
          if (!event) continue;
          discovered.push({ replyId, native: reply, event });
        }
      }

      discovered.sort((a, b) => {
        const at = Date.parse(a.event?.timestamp || "") || 0;
        const bt = Date.parse(b.event?.timestamp || "") || 0;
        return at - bt;
      });

      let processed = 0;
      let deferred = 0;
      let failed = 0;
      const marked = [];

      for (const item of discovered) {
        try {
          const result = await handler({ platform: "threads", provider, event: item.event, native: item.native });
          if (result?.status === "ignored" && TRANSIENT_REASONS.has(result?.reason)) {
            deferred += 1;
            continue;
          }
          marked.push(item.replyId);
          seen.add(item.replyId);
          processed += 1;
        } catch (error) {
          failed += 1;
          lastError = error?.message || String(error);
        }
      }

      await pollStore.markSeen(accountKey, marked);
      await pollStore.markKnownPosts(accountKey, currentPostIds);
      lastCycleAt = new Date().toISOString();
      if (!failed && !readFailures) lastError = null;
      lastStats = {
        status: failed || readFailures ? "partial" : "ok",
        posts: posts.length,
        reads,
        readFailures,
        discovered: discovered.length,
        processed,
        deferred,
        failed,
      };

      if (discovered.length || readFailures || failed) logger.log("Threads polling cycle", JSON.stringify({ accountKey, ...lastStats }));
      return lastStats;
    } finally {
      running = false;
    }
  }

  async function init() {
    initialized = true;
    if (!enabled) return { status: "skipped", reason: "THREADS_POLLING_DISABLED" };
    if (!provider.account?.enabled) return { status: "skipped", reason: "THREADS_PROVIDER_DISABLED" };
    if (!provider.account?.accessToken || !provider.account?.userId) return { status: "failed", reason: "THREADS_CONFIG_MISSING" };

    const storeStart = await pollStore.init();
    if (storeStart.status !== "ok") {
      lastError = storeStart.reason;
      return storeStart;
    }

    const first = await runOnce();
    timer = setInterval(() => {
      runOnce().catch(error => {
        lastError = error?.message || String(error);
        logger.error("Threads polling error", JSON.stringify({ accountKey, error: lastError }));
      });
    }, pollEveryMs);
    timer.unref?.();
    return { status: "ok", reason: "STARTED", first };
  }

  async function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    await pollStore.close?.();
  }

  return { init, runOnce, stop, health };
}

module.exports = { createThreadsCommentPoller };
