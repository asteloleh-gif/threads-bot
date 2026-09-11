const PROACTIVE_MODES = Object.freeze(["OFF", "DRY_RUN", "COPILOT", "AUTOPILOT", "REVIEW_ONLY"]);
const PROACTIVE_MODE_SET = new Set(PROACTIVE_MODES);

function readBool(env, name, fallback) {
  const raw = env[name];
  if (raw == null || raw === "") return fallback;
  return String(raw).toLowerCase() === "true";
}

function readInt(env, name, fallback, min, max) {
  const raw = env[name];
  if (raw == null || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < min || value > max) return fallback;
  return value;
}

function readMode(env, name, fallback) {
  const value = String(env[name] || fallback).toUpperCase();
  return PROACTIVE_MODE_SET.has(value) ? value : fallback;
}

function loadProactiveConfig(env = process.env) {
  const enabled = readBool(env, "PROACTIVE_ENABLED", false);
  const requestedMode = readMode(env, "PROACTIVE_MODE", "OFF");
  const account = String(env.PROACTIVE_ACCOUNT || "").trim();

  return Object.freeze({
    enabled,
    mode: enabled ? requestedMode : "OFF",
    account,
    pollIntervalSeconds: readInt(env, "PROACTIVE_POLL_INTERVAL_SECONDS", 14400, 300, 86400),
    approvalPollSeconds: readInt(env, "PROACTIVE_APPROVAL_POLL_SECONDS", 60, 30, 3600),
    candidateTtlHours: readInt(env, "PROACTIVE_CANDIDATE_TTL_HOURS", 72, 1, 720),
    maxPostAgeMinutes: readInt(env, "PROACTIVE_MAX_POST_AGE_MINUTES", 720, 1, 10080),
    defaultLimit: readInt(env, "PROACTIVE_DEFAULT_LIMIT", 25, 1, 100),
    dailyEvaluationLimit: readInt(env, "PROACTIVE_DAILY_EVALUATION_LIMIT", 150, 1, 1000),
    dailyDraftLimit: readInt(env, "PROACTIVE_DAILY_DRAFT_LIMIT", 10, 1, 100),
    dailyAiTokenLimit: readInt(env, "PROACTIVE_DAILY_AI_TOKEN_LIMIT", 50000, 1000, 1000000),
    monthlyAiCostMicrousdLimit: readInt(env, "PROACTIVE_MONTHLY_AI_COST_MICROUSD_LIMIT", 1000000, 10000, 100000000),
    approvalBaseUrl: String(env.PROACTIVE_APPROVAL_BASE_URL || "").replace(/\/+$/, ""),
    approvalSecret: String(env.PROACTIVE_APPROVAL_SECRET || ""),
    openaiModel: String(env.PROACTIVE_OPENAI_MODEL || env.OPENAI_MODEL || "gpt-5.6-luna"),
    namespace: String(env.PROACTIVE_REDIS_NAMESPACE || "astel:proactive:v1"),
    languageProfiles: Object.freeze({
      ru: Object.freeze({ language: "ru", enabled: true, mode: "COPILOT", autoPublishAllowed: false }),
      en: Object.freeze({ language: "en", enabled: true, mode: "COPILOT", autoPublishAllowed: false }),
      "zh-CN": Object.freeze({ language: "zh-CN", enabled: false, mode: "OFF", autoPublishAllowed: false }),
    }),
  });
}

function defaultMonitors(account, limit = 25) {
  const querySets = {
    ru: ["малый бизнес", "e-commerce", "маркетплейсы", "Amazon Shopify", "поставщики Китай", "1688", "AI автоматизация", "автозапчасти импорт"],
    en: ["small business", "ecommerce", "marketplaces", "Amazon seller Shopify", "China sourcing", "suppliers", "AI automation", "auto parts importing"],
  };
  return (querySets[account] || []).map((query, index) => Object.freeze({
    id: `${account}-${index + 1}`,
    enabled: true,
    query,
    language: account,
    searchType: "RECENT",
    searchMode: "KEYWORD",
    limit,
  }));
}

function loadMonitors(env = process.env, config = loadProactiveConfig(env)) {
  if (env.PROACTIVE_MONITORS_JSON) {
    try {
      const parsed = JSON.parse(env.PROACTIVE_MONITORS_JSON);
      if (Array.isArray(parsed)) return Object.freeze(parsed.slice(0, 20).map(item => Object.freeze({ ...item })));
    } catch (_) {}
  }
  return Object.freeze(defaultMonitors(config.account, config.defaultLimit));
}

module.exports = { loadProactiveConfig, loadMonitors, defaultMonitors, PROACTIVE_MODES };
