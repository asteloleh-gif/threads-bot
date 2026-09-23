const express = require("express");
const crypto = require("node:crypto");

function clampDays(value, fallback = 30) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(1, Math.min(365, Math.floor(n))) : fallback;
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (!left.length || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

function createInternalAnalyticsRouter({
  store,
  token = process.env.ANALYTICS_API_TOKEN || "",
  projectId = process.env.ANALYTICS_EXPORT_PROJECT_ID || "astel-business",
} = {}) {
  if (!store) throw new Error("Internal analytics router requires Postgres store");
  const router = express.Router();

  router.use((req, res, next) => {
    if (!token) return res.status(503).json({ error: "ANALYTICS_API_TOKEN_NOT_CONFIGURED" });
    const auth = String(req.get("authorization") || "");
    const supplied = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!safeEqual(supplied, token)) return res.status(401).json({ error: "UNAUTHORIZED" });
    next();
  });

  router.get("/export", async (req, res, next) => {
    try {
      if (!store.isReady()) return res.status(503).json({ error: "DATABASE_UNAVAILABLE" });
      const days = clampDays(req.query.days, 30);
      const cutoff = new Date(Date.now() - days * 86_400_000);

      const [snapshotsResult, accountsResult, commentsResult, repliesResult, postsResult, agentRunsResult] = await Promise.all([
        store.query(
          `SELECT s.account_key, a.platform, s.entity_type, s.entity_id, s.metrics, s.metadata, s.captured_at
           FROM analytics_snapshots s
           JOIN social_accounts a ON a.account_key = s.account_key
           WHERE s.captured_at >= $1
           ORDER BY s.captured_at ASC`,
          [cutoff],
        ),
        store.query(
          `SELECT account_key, platform, username
           FROM social_accounts
           WHERE enabled = TRUE
           ORDER BY account_key`,
        ),
        store.query(
          `SELECT c.account_key, a.platform, COUNT(*)::bigint AS count
           FROM comments c
           JOIN social_accounts a ON a.account_key = c.account_key
           WHERE COALESCE(c.occurred_at, c.created_at) >= $1
           GROUP BY c.account_key, a.platform`,
          [cutoff],
        ),
        store.query(
          `SELECT r.account_key, a.platform,
                  COUNT(*)::bigint AS total,
                  COUNT(*) FILTER (WHERE r.platform_reply_id IS NOT NULL OR r.status ILIKE 'PUBLISHED%')::bigint AS published
           FROM replies r
           JOIN social_accounts a ON a.account_key = r.account_key
           WHERE COALESCE(r.published_at, r.created_at) >= $1
           GROUP BY r.account_key, a.platform`,
          [cutoff],
        ),
        store.query(
          `SELECT p.account_key, a.platform, COUNT(*)::bigint AS count
           FROM posts p
           JOIN social_accounts a ON a.account_key = p.account_key
           WHERE COALESCE(p.published_at, p.created_at) >= $1
           GROUP BY p.account_key, a.platform`,
          [cutoff],
        ),
        store.query(
          `SELECT run_id, account_key, workflow_id, node, model, status,
                  input_tokens, output_tokens, cached_input_tokens, cost_microusd,
                  latency_ms, metadata, created_at
           FROM agent_runs
           WHERE created_at >= $1
           ORDER BY created_at ASC`,
          [cutoff],
        ),
      ]);

      const metricRows = (snapshotsResult.rows || []).map(row => ({
        source: row.platform || "social",
        projectId,
        accountKey: row.account_key,
        entityType: row.entity_type,
        entityId: row.entity_id,
        metrics: row.metrics || {},
        dimensions: {},
        metadata: { ...(row.metadata || {}), origin: "social-engine" },
        capturedAt: row.captured_at,
        idempotencyKey: `social:snapshot:${row.account_key}:${row.entity_type}:${row.entity_id}:${new Date(row.captured_at).toISOString()}`,
      }));

      const commentMap = new Map((commentsResult.rows || []).map(row => [row.account_key, Number(row.count || 0)]));
      const replyMap = new Map((repliesResult.rows || []).map(row => [row.account_key, {
        total: Number(row.total || 0),
        published: Number(row.published || 0),
      }]));
      const postMap = new Map((postsResult.rows || []).map(row => [row.account_key, Number(row.count || 0)]));

      const capturedAt = new Date();
      for (const account of accountsResult.rows || []) {
        const comments = commentMap.get(account.account_key) || 0;
        const replies = replyMap.get(account.account_key) || { total: 0, published: 0 };
        metricRows.push({
          source: account.platform,
          projectId,
          accountKey: account.account_key,
          entityType: "community",
          entityId: account.account_key,
          metrics: {
            comments_received: comments,
            replies_recorded: replies.total,
            replies_published: replies.published,
            published_posts: postMap.get(account.account_key) || 0,
            reply_rate: comments > 0 ? replies.published / comments : 0,
          },
          dimensions: { windowDays: days },
          metadata: { username: account.username, origin: "social-engine" },
          capturedAt,
          idempotencyKey: `social:community:${account.account_key}:${capturedAt.toISOString().slice(0, 13)}`,
        });
      }

      const costs = (agentRunsResult.rows || []).map(row => ({
        runId: row.run_id,
        projectId,
        source: "social-engine",
        service: "astel-social-engine",
        agentId: row.node,
        provider: "openai",
        model: row.model,
        inputTokens: Number(row.input_tokens || 0),
        cachedInputTokens: Number(row.cached_input_tokens || 0),
        outputTokens: Number(row.output_tokens || 0),
        requests: 1,
        amountMicrousd: row.cost_microusd == null ? null : Number(row.cost_microusd),
        metadata: {
          accountKey: row.account_key,
          workflowId: row.workflow_id,
          status: row.status,
          latencyMs: row.latency_ms == null ? null : Number(row.latency_ms),
          ...(row.metadata || {}),
        },
        occurredAt: row.created_at,
        idempotencyKey: `social-agent-run:${row.run_id}`,
      }));

      return res.json({
        days,
        projectId,
        accounts: (accountsResult.rows || []).length,
        metrics: metricRows,
        costs,
        bindings: [],
        generatedAt: capturedAt.toISOString(),
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

module.exports = { createInternalAnalyticsRouter, clampDays, safeEqual };
