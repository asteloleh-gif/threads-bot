const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { createInternalAnalyticsRouter, clampDays, safeEqual } = require("../app/analytics/internalAnalyticsRouter");

function fakeStore() {
  return {
    isReady: () => true,
    async query(sql) {
      if (sql.includes("FROM analytics_snapshots")) {
        return { rows: [{
          account_key: "astel-us:threads",
          platform: "threads",
          entity_type: "post",
          entity_id: "p1",
          metrics: { views: 100, likes: 7 },
          metadata: { permalink: "https://example.test/p1" },
          captured_at: new Date("2026-09-23T12:00:00Z"),
        }] };
      }
      if (sql.includes("FROM social_accounts") && sql.includes("enabled = TRUE")) {
        return { rows: [{ account_key: "astel-us:threads", platform: "threads", username: "astel.us" }] };
      }
      if (sql.includes("FROM comments")) return { rows: [{ account_key: "astel-us:threads", platform: "threads", count: "4" }] };
      if (sql.includes("FROM replies")) return { rows: [{ account_key: "astel-us:threads", platform: "threads", total: "3", published: "3" }] };
      if (sql.includes("FROM posts")) return { rows: [{ account_key: "astel-us:threads", platform: "threads", count: "2" }] };
      if (sql.includes("FROM agent_runs")) {
        return { rows: [{
          run_id: "run-1",
          account_key: "astel-us:threads",
          workflow_id: "wf-1",
          node: "copywriter",
          model: "gpt-5.4-mini",
          status: "COMPLETED",
          input_tokens: "1000",
          output_tokens: "200",
          cached_input_tokens: "100",
          cost_microusd: "1500",
          latency_ms: "500",
          metadata: {},
          created_at: new Date("2026-09-23T12:00:00Z"),
        }] };
      }
      throw new Error("unexpected SQL");
    },
  };
}

async function withServer(app, fn) {
  const server = await new Promise(resolve => {
    const value = app.listen(0, "127.0.0.1", () => resolve(value));
  });
  try {
    const address = server.address();
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test("analytics export is bearer protected and returns normalized Edie payload", async () => {
  const app = express();
  app.use("/internal/analytics", createInternalAnalyticsRouter({ store: fakeStore(), token: "test-secret" }));

  await withServer(app, async base => {
    const denied = await fetch(`${base}/internal/analytics/export?days=7`);
    assert.equal(denied.status, 401);

    const response = await fetch(`${base}/internal/analytics/export?days=7`, {
      headers: { authorization: "Bearer test-secret" },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.days, 7);
    assert.equal(body.accounts, 1);
    assert.equal(body.metrics.length, 2);
    assert.equal(body.metrics[0].source, "threads");
    assert.equal(body.metrics[1].metrics.comments_received, 4);
    assert.equal(body.metrics[1].metrics.replies_published, 3);
    assert.equal(body.costs.length, 1);
    assert.equal(body.costs[0].amountMicrousd, 1500);
  });
});

test("analytics export helpers clamp windows and compare secrets safely", () => {
  assert.equal(clampDays(9999), 365);
  assert.equal(clampDays("nope"), 30);
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("", ""), false);
});
