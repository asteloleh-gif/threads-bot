const { normalizeMetrics, computeMetricDeltas } = require("./metrics");

function createAnalyticsRepository({ store, durable } = {}) {
  if (!store) throw new Error("Analytics repository requires Postgres store");
  if (!durable) throw new Error("Analytics repository requires durable repository");

  async function latestSnapshot({ accountKey, entityType, entityId } = {}) {
    if (!accountKey || !entityType || !entityId || !store.isReady()) return null;
    const result = await store.query(
      `SELECT metrics, captured_at, metadata
       FROM analytics_snapshots
       WHERE account_key = $1 AND entity_type = $2 AND entity_id = $3
       ORDER BY captured_at DESC
       LIMIT 1`,
      [String(accountKey), String(entityType), String(entityId)],
    );
    return result?.rows?.[0] || null;
  }

  async function recordSnapshot({ accountKey, entityType, entityId, metrics, capturedAt = new Date(), metadata = {} } = {}) {
    const normalized = normalizeMetrics(metrics);
    const previous = await latestSnapshot({ accountKey, entityType, entityId });
    const comparison = computeMetricDeltas(normalized, previous?.metrics || {});
    await durable.recordAnalyticsSnapshot({
      accountKey,
      entityType,
      entityId,
      metrics: normalized,
      capturedAt,
      metadata: {
        ...metadata,
        previousCapturedAt: previous?.captured_at || null,
        deltas: comparison.deltas,
        rates: comparison.rates,
      },
    });
    return { metrics: normalized, ...comparison, previousCapturedAt: previous?.captured_at || null };
  }

  async function upsertDiscoveredPost({ accountKey, post } = {}) {
    if (!accountKey || !post?.id) throw new Error("Discovered post requires accountKey and id");
    await durable.upsertPost({
      accountKey,
      platformPostId: String(post.id),
      contentType: post.contentType || "unknown",
      text: post.text ?? null,
      status: "PUBLISHED",
      permalink: post.permalink || null,
      publishedAt: post.publishedAt || null,
      metadata: post.metadata || {},
    });
    return { stored: true };
  }

  async function listSnapshots({ accountKey, entityType, entityId = null, limit = 50 } = {}) {
    if (!accountKey || !entityType || !store.isReady()) return [];
    const safeLimit = Math.max(1, Math.min(500, Number(limit) || 50));
    const params = [String(accountKey), String(entityType)];
    let where = "account_key = $1 AND entity_type = $2";
    if (entityId) {
      params.push(String(entityId));
      where += ` AND entity_id = $${params.length}`;
    }
    params.push(safeLimit);
    const result = await store.query(
      `SELECT entity_id, metrics, captured_at, metadata
       FROM analytics_snapshots
       WHERE ${where}
       ORDER BY captured_at DESC
       LIMIT $${params.length}`,
      params,
    );
    return result?.rows || [];
  }

  return {
    latestSnapshot,
    recordSnapshot,
    upsertDiscoveredPost,
    listSnapshots,
    isReady: () => store.isReady() && durable.isReady(),
    health: () => ({ connected: store.isReady() && durable.isReady() }),
  };
}

module.exports = { createAnalyticsRepository };
