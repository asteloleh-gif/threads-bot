const test = require("node:test");
const assert = require("node:assert/strict");

const { createAnalyticsRepository } = require("../app/analytics/analyticsRepository");

test("analytics repository stores normalized snapshots with deltas against previous capture", async () => {
  const writes = [];
  const store = {
    isReady: () => true,
    async query(text, params) {
      if (text.includes("FROM analytics_snapshots")) {
        return { rows: [{ metrics: { views: 100, likes: 5, interactions: 5, engagement_rate: 0.05 }, captured_at: "2026-09-13T10:00:00.000Z", metadata: {} }] };
      }
      return { rows: [] };
    },
  };
  const durable = {
    isReady: () => true,
    async recordAnalyticsSnapshot(value) { writes.push(value); return { stored: true }; },
    async upsertPost() { return { stored: true }; },
  };
  const repository = createAnalyticsRepository({ store, durable });
  const result = await repository.recordSnapshot({
    accountKey: "astel:threads",
    entityType: "post",
    entityId: "p1",
    metrics: { views: 140, likes: 8 },
  });
  assert.equal(writes.length, 1);
  assert.equal(writes[0].metrics.views, 140);
  assert.equal(writes[0].metrics.interactions, 8);
  assert.equal(writes[0].metadata.deltas.views, 40);
  assert.equal(writes[0].metadata.deltas.likes, 3);
  assert.equal(result.previousCapturedAt, "2026-09-13T10:00:00.000Z");
});
