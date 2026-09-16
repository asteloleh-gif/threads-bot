const { createFacebookPollingStore } = require("./facebookPollingStore");

const TRANSIENT_REASONS = new Set([
  "DURABLE_STORE_UNAVAILABLE",
  "COMMUNITY_RUNTIME_MISSING",
  "SAFETY_STORE_UNAVAILABLE",
]);

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function createFacebookCommentPoller({
  provider,
  handler,
  redisUrl,
  enabled = false,
  intervalMs = 60000,
  postsLimit = 10,
  commentsLimit = 50,
  fullScanEvery = 10,
  store,
  logger = console,
} = {}) {
  if (!provider || provider.platform !== "facebook") {
    throw new Error("Facebook comment poller requires a Facebook provider");
  }
  if (typeof handler !== "function") {
    throw new Error("Facebook comment poller requires a handler");
  }

  const accountKey = provider.accountKey;
  const pollStore = store || createFacebookPollingStore({ redisUrl });
  const pollEveryMs = clamp(intervalMs, 15000, 3600000, 60000);
  const recentPostsLimit = clamp(postsLimit, 1, 25, 10);
  const perPostCommentsLimit = clamp(commentsLimit, 1, 50, 50);
  const fullScanCycles = clamp(fullScanEvery, 1, 60, 10);

  let timer = null;
  let running = false;
  let initialized = false;
  let primed = false;
  let cycleNumber = 0;
  let lastCycleAt = null;
  let lastError = null;
  let lastStats = null;
  let lastIdentityProbe = null;

  function health() {
    return {
      platform: "facebook",
      accountKey,
      enabled: Boolean(enabled),
      running: Boolean(timer),
      initialized,
      primed,
      intervalMs: pollEveryMs,
      postsLimit: recentPostsLimit,
      commentsLimit: perPostCommentsLimit,
      fullScanEvery: fullScanCycles,
      lastCycleAt,
      lastError,
      lastStats,
      identityProbe: lastIdentityProbe,
      store: pollStore.health?.() || null,
    };
  }

  async function probeIdentity() {
    if (typeof provider.getPageIdentity !== "function") {
      lastIdentityProbe = { status: "skipped", reason: "IDENTITY_PROBE_UNSUPPORTED" };
      return lastIdentityProbe;
    }

    let result;
    try {
      result = await provider.getPageIdentity();
    } catch (_) {
      result = { status: "failed", reason: "IDENTITY_PROBE_EXCEPTION" };
    }

    if (result?.status !== "ok") {
      lastIdentityProbe = {
        status: "failed",
        reason: result?.reason || "IDENTITY_PROBE_FAILED",
        code: result?.code || null,
      };
      logger.log("Facebook identity probe", JSON.stringify({ accountKey, ...lastIdentityProbe }));
      return lastIdentityProbe;
    }

    const identity = result.identity || {};
    const configuredPageId = String(provider.account?.userId || "").trim();
    lastIdentityProbe = {
      status: "ok",
      idMatch: Boolean(configuredPageId && identity.id && String(identity.id) === configuredPageId),
      namePresent: Boolean(identity.name),
    };
    logger.log("Facebook identity probe", JSON.stringify({ accountKey, ...lastIdentityProbe }));
    return lastIdentityProbe;
  }

  async function readPostComments(post, { force = false } = {}) {
    if (!force && (Number(post?.comments_count) || 0) <= 0) return { status: "ok", items: [] };
    return provider.listComments(post.id, { limit: perPostCommentsLimit });
  }

  async function prime(postItems) {
    const allIds = [];
    const counts = {};
    let readFailures = 0;

    for (const post of postItems) {
      if (!post?.id) continue;
      counts[String(post.id)] = Number(post.comments_count) || 0;
      const result = await readPostComments(post, { force: true });
      if (result.status !== "ok") {
        readFailures += 1;
        continue;
      }
      for (const comment of result.items || []) {
        if (comment?.id) allIds.push(String(comment.id));
      }
    }

    if (readFailures) {
      return { status: "failed", reason: "PRIME_READ_FAILED", readFailures };
    }

    await pollStore.markSeen(accountKey, allIds);
    await pollStore.setPostCounts(accountKey, counts);
    await pollStore.markPrimed(accountKey);
    primed = true;
    return { status: "ok", discovered: allIds.length };
  }

  function recordPrimeResult(stage, postItems, result) {
    lastCycleAt = new Date().toISOString();
    lastError = result.status === "ok" ? null : result.reason;
    lastStats = {
      status: result.status,
      stage,
      posts: postItems.length,
      discovered: result.discovered || 0,
      reason: result.reason || null,
    };
    logger.log("Facebook polling primed", JSON.stringify({ accountKey, ...lastStats }));
    return lastStats;
  }

  async function runOnce() {
    if (!enabled) return { status: "skipped", reason: "FACEBOOK_POLLING_DISABLED" };
    if (running) return { status: "skipped", reason: "CYCLE_ALREADY_RUNNING" };
    running = true;
    cycleNumber += 1;

    try {
      const postsResult = await provider.listRecentPosts({ limit: recentPostsLimit });
      if (postsResult.status !== "ok") {
        lastError = `${postsResult.reason || "POST_READ_FAILED"}${postsResult.code ? `:${postsResult.code}` : ""}`;
        lastStats = {
          status: "failed",
          stage: "posts",
          reason: postsResult.reason || null,
          code: postsResult.code || null,
        };
        return lastStats;
      }

      const postItems = Array.isArray(postsResult.items) ? postsResult.items.filter(item => item?.id) : [];
      primed = await pollStore.isPrimed(accountKey);
      if (!primed) {
        return recordPrimeResult("prime", postItems, await prime(postItems));
      }

      const previousCounts = await pollStore.getPostCounts(accountKey);
      if (postItems.length > 0 && Object.keys(previousCounts).length === 0) {
        return recordPrimeResult("re-prime", postItems, await prime(postItems));
      }

      const seen = await pollStore.getSeen(accountKey);
      const nextCounts = {};
      const discovered = [];
      let reads = 0;
      let readFailures = 0;
      const forceFullScan = cycleNumber % fullScanCycles === 0;

      for (const post of postItems) {
        const postId = String(post.id);
        const currentCount = Number(post.comments_count) || 0;
        nextCounts[postId] = currentCount;
        const previousCount = Object.prototype.hasOwnProperty.call(previousCounts, postId)
          ? Number(previousCounts[postId]) || 0
          : null;

        if (!forceFullScan && previousCount !== null && currentCount === previousCount) continue;
        if (!forceFullScan && currentCount <= 0) continue;

        const commentsResult = await readPostComments(post, { force: forceFullScan });
        reads += 1;
        if (commentsResult.status !== "ok") {
          readFailures += 1;
          continue;
        }

        for (const comment of commentsResult.items || []) {
          const commentId = String(comment?.id || "").trim();
          if (!commentId || seen.has(commentId)) continue;
          const event = provider.normalizePolledComment(comment, postId);
          if (!event) continue;
          discovered.push({ commentId, event, native: comment });
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
          const result = await handler({
            platform: "facebook",
            provider,
            event: item.event,
            native: item.native,
          });
          if (result?.status === "ignored" && TRANSIENT_REASONS.has(result?.reason)) {
            deferred += 1;
            continue;
          }
          marked.push(item.commentId);
          seen.add(item.commentId);
          processed += 1;
        } catch (error) {
          failed += 1;
          lastError = error?.message || String(error);
        }
      }

      await pollStore.markSeen(accountKey, marked);
      await pollStore.setPostCounts(accountKey, nextCounts);
      lastCycleAt = new Date().toISOString();
      if (!failed && !readFailures) lastError = null;
      lastStats = {
        status: failed || readFailures ? "partial" : "ok",
        posts: postItems.length,
        reads,
        readFailures,
        forceFullScan,
        discovered: discovered.length,
        processed,
        deferred,
        failed,
      };

      if (discovered.length || readFailures || failed || forceFullScan) {
        logger.log("Facebook polling cycle", JSON.stringify({ accountKey, ...lastStats }));
      }
      return lastStats;
    } finally {
      running = false;
    }
  }

  async function init() {
    initialized = true;
    if (!enabled) return { status: "skipped", reason: "FACEBOOK_POLLING_DISABLED" };
    if (!provider.account?.enabled) return { status: "skipped", reason: "FACEBOOK_PROVIDER_DISABLED" };
    if (!provider.account?.accessToken || !provider.account?.userId) {
      return { status: "failed", reason: "FACEBOOK_CONFIG_MISSING" };
    }
    if (typeof provider.listRecentPosts !== "function" || typeof provider.listComments !== "function") {
      return { status: "failed", reason: "FACEBOOK_POLLING_UNSUPPORTED" };
    }

    const storeStart = await pollStore.init();
    if (storeStart.status !== "ok") {
      lastError = storeStart.reason;
      return storeStart;
    }

    await probeIdentity();
    const first = await runOnce();
    timer = setInterval(() => {
      runOnce().catch(error => {
        lastError = error?.message || String(error);
        logger.error("Facebook polling error", JSON.stringify({ accountKey, error: lastError }));
      });
    }, pollEveryMs);
    timer.unref?.();
    return { status: "ok", reason: "STARTED", identityProbe: lastIdentityProbe, first };
  }

  async function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    await pollStore.close?.();
  }

  return { init, runOnce, stop, health };
}

module.exports = { createFacebookCommentPoller };
