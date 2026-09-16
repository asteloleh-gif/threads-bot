const fetch = require("node-fetch");

const ALWAYS_TYPES = new Set(["style", "context_rule"]);
const DEFAULT_MAX_SELECTED = 8;
const DEFAULT_CACHE_TTL_MS = 60000;

const ALIAS_GROUPS = [
  ["audi", "ауди"],
  ["turo", "туро"],
  ["car", "cars", "vehicle", "auto", "авто", "машина", "машины", "тачка", "тачки"],
  ["coffee", "latte", "кофе", "латте"],
  ["texas", "tx", "техас"],
  ["business", "бизнес", "бізнес"],
  ["ecommerce", "e-commerce", "commerce", "еком", "еcom"],
];

function tokensFor(text) {
  return new Set((String(text || "").toLowerCase().match(/[\p{L}\p{N}]+/gu) || [])
    .filter(token => token.length >= 2));
}

function expandAliases(tokens) {
  const expanded = new Set(tokens);
  for (const group of ALIAS_GROUPS) {
    if (group.some(token => expanded.has(token))) {
      for (const token of group) expanded.add(token);
    }
  }
  return expanded;
}

function isExpired(value, nowMs) {
  if (!value) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed <= nowMs;
}

function normalizeRecord(record) {
  const fields = record?.fields || record || {};
  return {
    id: record?.id || null,
    key: String(fields.Key || "").trim(),
    value: String(fields.Value || "").trim(),
    type: String(fields.Type || "").trim().toLowerCase(),
    confidence: String(fields.Confidence || "").trim().toLowerCase(),
    publicSafe: fields["Public Safe"] === true,
    active: fields.Active === true,
    tags: Array.isArray(fields.Tags) ? fields.Tags.map(String) : [],
    expiresAt: fields["Expires At"] || null,
  };
}

function relevanceScore(item, commentTokens) {
  const haystack = expandAliases(tokensFor(`${item.key} ${item.value} ${item.tags.join(" ")}`));
  let overlap = 0;
  for (const token of commentTokens) if (haystack.has(token)) overlap += 1;

  let score = overlap * 10;
  if (item.type === "style") score += 5;
  if (item.type === "context_rule") score += 4;
  if (item.confidence === "high") score += 1;
  return { score, overlap };
}

function selectPersonaRecords(records, commentText, { maxSelected = DEFAULT_MAX_SELECTED, now = Date.now() } = {}) {
  const commentTokens = expandAliases(tokensFor(commentText));
  const eligible = (records || [])
    .map(normalizeRecord)
    .filter(item => item.active && item.publicSafe && item.key && item.value && !isExpired(item.expiresAt, now));

  return eligible
    .map(item => ({ ...item, ...relevanceScore(item, commentTokens) }))
    .filter(item => ALWAYS_TYPES.has(item.type) || item.overlap > 0)
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
    .slice(0, Math.max(1, Number(maxSelected) || DEFAULT_MAX_SELECTED));
}

function formatPersonaContext(selected) {
  if (!selected?.length) return "";
  const lines = selected.map(item => `- [${item.type}:${item.key}] ${item.value}`);
  return [
    "RELEVANT PERSONA MEMORY:",
    "Use these public-safe memories only when directly relevant. Do not force them into unrelated replies and do not treat examples as verified facts.",
    ...lines,
  ].join("\n");
}

function createPersonaMemoryContextProvider({
  env = process.env,
  fetchImpl = fetch,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  maxSelected = DEFAULT_MAX_SELECTED,
  logger = console,
} = {}) {
  const apiKey = env.AIRTABLE_API_KEY;
  const baseId = env.AIRTABLE_BASE_ID;
  let cache = null;
  let cacheUntil = 0;

  async function loadRecords() {
    if (!apiKey || !baseId) return [];
    const now = Date.now();
    if (cache && now < cacheUntil) return cache;

    const params = new URLSearchParams({
      maxRecords: "100",
      filterByFormula: "AND({Active}=TRUE(),{Public Safe}=TRUE())",
    });
    const url = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent("PersonaMemory")}?${params}`;
    const response = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!response.ok) throw new Error(`Airtable PersonaMemory HTTP ${response.status}`);
    const data = await response.json();
    cache = Array.isArray(data.records) ? data.records : [];
    cacheUntil = now + Math.max(0, Number(cacheTtlMs) || 0);
    return cache;
  }

  return async function getPersonaContext(commentText) {
    if (!apiKey || !baseId) return "";
    try {
      const records = await loadRecords();
      const selected = selectPersonaRecords(records, commentText, { maxSelected });
      logger.log("Airtable PersonaMemory loaded", JSON.stringify({ available: records.length, selected: selected.length }));
      return formatPersonaContext(selected);
    } catch (error) {
      logger.error("Airtable PersonaMemory error:", error?.message || String(error));
      return "";
    }
  };
}

module.exports = {
  createPersonaMemoryContextProvider,
  selectPersonaRecords,
  formatPersonaContext,
  tokensFor,
  expandAliases,
};
