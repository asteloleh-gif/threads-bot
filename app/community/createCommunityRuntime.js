const { createSafetyPipeline } = require("../../safety/pipeline");
const { createHumanLockStore } = require("../../safety/humanLockStore");
const { isHumanLockMarker } = require("../../policy/replyBehavior");
const { routeComment } = require("../../router/conversationRouter");
const { resolveParentForRouting } = require("../../router/parentResolver");
const { GRAPH_STATUS } = require("../../graph/conversationGraph");

function createCommunityRuntime({
  provider,
  redisUrl,
  policy,
  getContext,
  generateReply,
  logInteraction,
  maxMemoryMessages = 8,
  maxMemoryTokens = 1000,
  namespace,
} = {}) {
  if (!provider?.account) throw new Error("Community runtime requires provider account");
  if (!policy) throw new Error("Community runtime requires policy");
  if (typeof getContext !== "function" || typeof generateReply !== "function") {
    throw new Error("Community runtime requires AI dependencies");
  }

  const account = provider.account;
  const ns = namespace || `astel:v91:${account.key}`;
  const safety = createSafetyPipeline({
    threadsUserId: account.userId,
    selfUserId: account.userId,
    selfUsername: account.username,
    botEnabled: String(account.enabled),
    botDryRun: String(account.dryRun),
    redisUrl,
    policy,
    namespace: ns,
  });
  const humanLocks = createHumanLockStore({
    redisUrl,
    namespace: ns,
    ttlSeconds: policy.conversationResetHours * 60 * 60,
  });

  async function init() {
    await safety.init();
    await humanLocks.init();
    return true;
  }

  async function quit() {
    await Promise.allSettled([safety.quit?.(), humanLocks.quit?.()]);
  }

  async function handleComment(c) {
    if (!safety.isEnabled()) return { status: "ignored", reason: "BOT_DISABLED" };
    if (provider.health?.().configured === false) return { status: "ignored", reason: "PROVIDER_NOT_CONFIGURED" };
    if (!safety.isReady() || !humanLocks.isReady()) return { status: "ignored", reason: "SAFETY_STORE_UNAVAILABLE" };

    const commentId = provider.getCommentId(c);
    const author = provider.getAuthorUsername(c);
    const authorId = provider.getAuthorId(c);
    const rootId = provider.getRootPostId(c);
    let text = provider.getCommentText(c) || "";
    if (!commentId || (!author && !authorId) || !rootId) return { status: "ignored", reason: "INVALID_PAYLOAD" };

    const selfAuthored = safety.isSelfAuthored({ authorId, authorUsername: author });
    if (selfAuthored) {
      if (isHumanLockMarker(text)) {
        try {
          const parentId = provider.getParentId(c);
          const parentNode = parentId ? await safety.getGraphNode(parentId) : null;
          const branchKey = parentNode?.branchKey || null;
          if (!branchKey) return { status: "ignored", reason: "HUMAN_LOCK_TARGET_UNRESOLVED" };
          await humanLocks.lock(branchKey);
          return { status: "ok", reason: "HUMAN_LOCKED" };
        } catch (_) {
          return { status: "ignored", reason: "HUMAN_LOCK_STORE_UNAVAILABLE" };
        }
      }
      return { status: "ignored", reason: "SELF_COMMENT" };
    }

    try {
      if (await safety.isBotGeneratedId(commentId)) return { status: "ignored", reason: "BOT_GENERATED_OBJECT" };
      const existing = await safety.getSourceStatus(commentId);
      if (existing) return { status: "ignored", reason: "DUPLICATE" };
    } catch (_) {
      return { status: "ignored", reason: "SAFETY_STORE_UNAVAILABLE" };
    }

    let parent;
    try {
      parent = await resolveParentForRouting(c, {
        safety,
        threads: provider,
        ownerUsername: account.username,
        ownerUserId: account.userId,
        lookupEnabled: policy.parentLookupEnabled,
      });
    } catch (_) {
      return { status: "ignored", reason: "SAFETY_STORE_UNAVAILABLE" };
    }

    const route = routeComment({
      authorId,
      authorUsername: author,
      ownerUserId: account.userId,
      ownerUsername: account.username,
      rootId,
      parentId: parent.parentId,
      parentAuthorId: parent.parentAuthorId,
      parentAuthorUsername: parent.parentAuthorUsername,
      text,
    });
    if (!route.allow) return { status: "ignored", reason: route.reason };

    let graphNode;
    try { graphNode = await safety.getGraphNode(commentId); }
    catch (_) { return { status: "ignored", reason: "GRAPH_UNAVAILABLE" }; }
    if (!graphNode || graphNode.relationshipStatus !== GRAPH_STATUS.RESOLVED || !graphNode.branchKey) {
      return { status: "ignored", reason: "PENDING_RELATIONSHIP" };
    }

    const branchKey = graphNode.branchKey;
    try {
      if (await humanLocks.isLocked(branchKey)) return { status: "ignored", reason: "HUMAN_LOCKED" };
    } catch (_) { return { status: "ignored", reason: "HUMAN_LOCK_STORE_UNAVAILABLE" }; }

    const userKey = safety.getUserKey({ authorId, authorUsername: author });
    const conversationKey = safety.getConversationKey({ userKey, rootId });
    if (!conversationKey) return { status: "ignored", reason: "INVALID_CONVERSATION" };

    let reservation;
    try { reservation = await safety.reserve({ commentId, conversationKey }); }
    catch (_) { return { status: "ignored", reason: "SAFETY_STORE_UNAVAILABLE" }; }
    if (!reservation.allowed) return { status: "ignored", reason: reservation.reason };

    const leaseToken = reservation.reservationId;
    let leaseHeld = false;
    try { leaseHeld = await safety.acquireBranchLease(branchKey, leaseToken); }
    catch (_) {
      try { await safety.rollback(reservation); } catch (_) {}
      return { status: "ignored", reason: "BRANCH_LEASE_ERROR" };
    }
    if (!leaseHeld) {
      try { await safety.rollback(reservation); } catch (_) {}
      return { status: "ignored", reason: "BRANCH_BUSY" };
    }

    const replyNumber = reservation.replyNumber;
    const closeConversation = policy.closingEnabled && replyNumber === policy.closingAtReply;
    let replyText = null;
    try {
      if (await humanLocks.isLocked(branchKey)) {
        await safety.rollback(reservation);
        return { status: "ignored", reason: "HUMAN_LOCKED" };
      }

      if (!String(text).trim()) {
        await safety.rollback(reservation);
        return { status: "ignored", reason: "EMPTY_COMMENT_NO_SUPPORTED_MEDIA" };
      }

      const memory = await safety.getBranchMemory(commentId, {
        maxMessages: Number(maxMemoryMessages),
        maxTokens: Number(maxMemoryTokens),
      });
      if (memory.reason !== "OK") throw new Error(`MEMORY_${memory.reason}`);

      const context = await getContext();
      const generated = await generateReply(text, context, {
        closeConversation,
        memory: memory.messages,
        media: null,
        platform: provider.platform,
        trace: {
          traceId: reservation.reservationId,
          sourceCommentId: String(commentId),
          conversationKey,
          branchKey,
          accountKey: account.key,
          platform: provider.platform,
          hasImage: false,
        },
      });
      replyText = generated?.text || null;
      if (!replyText) {
        await safety.rollback(reservation);
        return { status: "ignored", reason: "AI_EMPTY_OR_FAILED" };
      }

      if (safety.isDryRun()) {
        await safety.commitSuccess(reservation, null, null);
        return { status: "dry-run", reason: "WOULD_REPLY" };
      }

      if (!(await safety.verifyBranchLease(branchKey, leaseToken))) {
        await safety.rollback(reservation);
        return { status: "ignored", reason: "BRANCH_LEASE_LOST" };
      }
      if (await humanLocks.isLocked(branchKey)) {
        await safety.rollback(reservation);
        return { status: "ignored", reason: "HUMAN_LOCKED" };
      }

      let result;
      try { result = await provider.reply(commentId, replyText); }
      catch (_) {
        try { await safety.markAmbiguous(reservation); } catch (_) {}
        return { status: "ambiguous", reason: "UNEXPECTED_PUBLISH_EXCEPTION" };
      }

      if (result.status === "published") {
        const committed = await safety.commitSuccess(reservation, result.id, replyText);
        if (!committed) return { status: "ambiguous", reason: "PUBLISH_STATE_COMMIT_REJECTED" };
        if (typeof logInteraction === "function") {
          await logInteraction({
            platform: provider.platform,
            accountKey: account.key,
            commentId,
            author: author || authorId || "unknown",
            commentText: text,
            replyText,
          });
        }
        return { status: "published", replyId: result.id };
      }

      if (result.status === "ambiguous") {
        try { await safety.markAmbiguous(reservation); } catch (_) {}
        return { status: "ambiguous", reason: "AMBIGUOUS_PUBLISH" };
      }

      await safety.rollback(reservation);
      return { status: "ignored", reason: "DEFINITIVE_PUBLISH_FAILURE" };
    } catch (error) {
      try { await safety.rollback(reservation); } catch (_) {}
      return { status: "ignored", reason: "COMMENT_PREPARATION_ERROR", error: error?.message || String(error) };
    } finally {
      try { await safety.releaseBranchLease(branchKey, leaseToken); } catch (_) {}
    }
  }

  function health() {
    return {
      accountKey: account.key,
      platform: provider.platform,
      configured: provider.health?.().configured !== false,
      enabled: safety.isEnabled(),
      dryRun: safety.isDryRun(),
      redis: safety.health(),
      humanLock: humanLocks.health(),
      limits: safety.limits,
    };
  }

  return { account, provider, safety, humanLocks, init, quit, handleComment, health };
}

module.exports = { createCommunityRuntime };
