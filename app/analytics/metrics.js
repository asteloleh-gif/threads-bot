function finite(value) {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeMetrics(input = {}) {
  const output = {};
  for (const [key, value] of Object.entries(input || {})) {
    const n = finite(value);
    if (n == null) continue;
    output[String(key)] = n;
  }

  const interactions = ["likes", "replies", "comments", "reposts", "quotes", "shares", "saves"]
    .reduce((sum, key) => sum + (finite(output[key]) || 0), 0);
  if (interactions > 0 || Object.keys(output).some(key => ["likes", "replies", "comments", "reposts", "quotes", "shares", "saves"].includes(key))) {
    output.interactions = interactions;
  }
  const views = finite(output.views ?? output.impressions ?? output.reach);
  if (views != null && views > 0 && output.interactions != null) {
    output.engagement_rate = output.interactions / views;
  }
  return output;
}

function computeMetricDeltas(current = {}, previous = {}) {
  const deltas = {};
  const rates = {};
  for (const [key, currentValue] of Object.entries(normalizeMetrics(current))) {
    const prev = finite(previous?.[key]);
    if (prev == null) continue;
    const delta = currentValue - prev;
    deltas[key] = delta;
    if (prev !== 0) rates[key] = delta / Math.abs(prev);
  }
  return { deltas, rates };
}

module.exports = { normalizeMetrics, computeMetricDeltas };
