const crypto = require("crypto");

const PUBLISH_STATUS = Object.freeze({
  CREATED: "CREATED",
  PENDING: "PENDING",
  PROCESSING: "PROCESSING",
  SIMULATED: "SIMULATED",
  PUBLISHED: "PUBLISHED",
  FAILED: "FAILED",
  AMBIGUOUS_HOLD: "AMBIGUOUS_HOLD",
  CANCELLED: "CANCELLED",
});

const TERMINAL_PUBLISH_STATUSES = Object.freeze([
  PUBLISH_STATUS.SIMULATED,
  PUBLISH_STATUS.PUBLISHED,
  PUBLISH_STATUS.FAILED,
  PUBLISH_STATUS.AMBIGUOUS_HOLD,
  PUBLISH_STATUS.CANCELLED,
]);

function normalizeIso(value, fallback = new Date()) {
  const date = value instanceof Date ? value : new Date(value || fallback);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid publish timestamp");
  return date.toISOString();
}

function normalizeContent(input = {}) {
  const type = String(input.type || "text").trim().toLowerCase();
  if (type !== "text") throw new Error(`Unsupported publish content type: ${type}`);
  const text = String(input.text || "").trim();
  if (!text) throw new Error("Publish content text is required");
  return Object.freeze({ type, text });
}

function createPublishJob({
  id = crypto.randomUUID(),
  accountKey,
  content,
  scheduledAt = new Date(),
  dedupeKey = null,
  metadata = {},
  createdAt = new Date(),
} = {}) {
  const normalizedAccountKey = String(accountKey || "").trim().toLowerCase();
  if (!normalizedAccountKey) throw new Error("Publish job accountKey is required");
  const created = normalizeIso(createdAt);
  const scheduled = normalizeIso(scheduledAt);
  return Object.freeze({
    id: String(id),
    accountKey: normalizedAccountKey,
    status: PUBLISH_STATUS.PENDING,
    content: normalizeContent(content),
    scheduledAt: scheduled,
    dedupeKey: dedupeKey == null ? null : String(dedupeKey),
    metadata: Object.freeze({ ...(metadata || {}) }),
    createdAt: created,
    updatedAt: created,
  });
}

function isTerminalPublishStatus(status) {
  return TERMINAL_PUBLISH_STATUSES.includes(String(status || ""));
}

module.exports = {
  PUBLISH_STATUS,
  TERMINAL_PUBLISH_STATUSES,
  createPublishJob,
  normalizeContent,
  isTerminalPublishStatus,
};
