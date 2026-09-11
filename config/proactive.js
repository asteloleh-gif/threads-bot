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

  return Object.freeze({
    enabled,
    mode: enabled ? requestedMode : "OFF",
    pollIntervalSeconds: readInt(env, "PROACTIVE_POLL_INTERVAL_SECONDS", 900, 60, 86400),
    candidateTtlHours: readInt(env, "PROACTIVE_CANDIDATE_TTL_HOURS", 72, 1, 720),
    maxPostAgeMinutes: readInt(env, "PROACTIVE_MAX_POST_AGE_MINUTES", 720, 1, 10080),
    defaultLimit: readInt(env, "PROACTIVE_DEFAULT_LIMIT", 25, 1, 100),
    namespace: String(env.PROACTIVE_REDIS_NAMESPACE || "astel:proactive:v1"),
    languageProfiles: Object.freeze({
      ru: Object.freeze({ language: "ru", enabled: true, mode: "COPILOT", autoPublishAllowed: false }),
      en: Object.freeze({ language: "en", enabled: true, mode: "COPILOT", autoPublishAllowed: false }),
      "zh-CN": Object.freeze({ language: "zh-CN", enabled: false, mode: "OFF", autoPublishAllowed: false }),
    }),
  });
}

module.exports = { loadProactiveConfig, PROACTIVE_MODES };
