function createDurablePublishRepository({ hotRepository, durable } = {}) {
  if (!hotRepository) throw new Error("Hot publish repository is required");
  if (!durable) throw new Error("Durable repository is required");

  let lastDurableError = null;

  async function persist(fn) {
    if (!durable.isReady?.()) return false;
    try {
      await fn();
      lastDurableError = null;
      return true;
    } catch (error) {
      lastDurableError = error?.message || String(error);
      console.error("Durable publish persistence error", JSON.stringify({ error: lastDurableError }));
      return false;
    }
  }

  async function enqueue(job) {
    if (durable.isReady?.()) {
      await durable.recordPublishEnqueued(job);
    }
    try {
      const result = await hotRepository.enqueue(job);
      if (result?.duplicate && durable.isReady?.()) {
        await persist(() => durable.recordPublishState({
          jobId: job.id,
          status: "CANCELLED",
          errorCode: "HOT_QUEUE_DUPLICATE",
          finishedAt: new Date(),
          result,
        }));
      }
      return result;
    } catch (error) {
      await persist(() => durable.recordPublishState({
        jobId: job.id,
        status: "FAILED",
        errorCode: "HOT_QUEUE_ENQUEUE_FAILED",
        finishedAt: new Date(),
        result: { message: error?.message || String(error) },
      }));
      throw error;
    }
  }

  async function claim(id, claimToken, options = {}) {
    const changed = await hotRepository.claim(id, claimToken, options);
    if (changed) {
      await persist(() => durable.recordPublishState({
        jobId: id,
        status: "PROCESSING",
        startedAt: options.now || new Date(),
      }));
    }
    return changed;
  }

  async function finish(id, claimToken, status, options = {}) {
    const changed = await hotRepository.finish(id, claimToken, status, options);
    if (!changed) return false;
    const job = await hotRepository.get(id);
    await persist(async () => {
      await durable.recordPublishState({
        jobId: id,
        status,
        result: options.result || {},
        errorCode: options.errorCode || null,
        finishedAt: options.now || new Date(),
      });
      if (status === "PUBLISHED" && (options.result?.id || job?.result?.id)) {
        const platformPostId = options.result?.id || job.result.id;
        await durable.upsertPost({
          accountKey: job.accountKey,
          platformPostId,
          contentType: job.content?.type || "text",
          text: job.content?.text || null,
          status: "PUBLISHED",
          publishedAt: options.now || new Date(),
          metadata: { publishJobId: id, ...(job.metadata || {}) },
        });
      }
    });
    return true;
  }

  async function recoverExpired(now = new Date(), limit = 100) {
    const held = await hotRepository.recoverExpired(now, limit);
    return held;
  }

  async function cancel(id, now = new Date()) {
    const changed = await hotRepository.cancel(id, now);
    if (changed) {
      await persist(() => durable.recordPublishState({
        jobId: id,
        status: "CANCELLED",
        finishedAt: now,
      }));
    }
    return changed;
  }

  function health() {
    return {
      ...(hotRepository.health?.() || {}),
      durable: durable.health?.() || null,
      lastDurableError,
    };
  }

  return {
    init: () => hotRepository.init(),
    quit: () => hotRepository.quit(),
    enqueue,
    due: (...args) => hotRepository.due(...args),
    claim,
    finish,
    recoverExpired,
    cancel,
    get: (...args) => hotRepository.get(...args),
    isReady: () => hotRepository.isReady(),
    health,
  };
}

module.exports = { createDurablePublishRepository };
