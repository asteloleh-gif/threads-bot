function intEnv(name, fallback, min = 0) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= min ? n : fallback;
}

function boolEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  return String(raw).toLowerCase() === "true";
}

function loadPolicy(env = process.env) {
  const readInt = (name, fallback, min = 0) => {
    const raw = env[name];
    if (raw == null || raw === "") return fallback;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n >= min ? n : fallback;
  };
  const readBool = (name, fallback) => {
    const raw = env[name];
    if (raw == null || raw === "") return fallback;
    return String(raw).toLowerCase() === "true";
  };

  const normalReplyLimit = readInt("NORMAL_REPLY_LIMIT", 3, 1);
  const closingAtReply = Math.min(readInt("CLOSING_AT_REPLY", normalReplyLimit, 1), normalReplyLimit);
  return Object.freeze({
    normalReplyLimit,
    cooldownSeconds: readInt("COOLDOWN_SECONDS", 20, 0),
    conversationResetHours: readInt("CONVERSATION_RESET_HOURS", 24, 1),
    globalDailyLimit: readInt("GLOBAL_DAILY_LIMIT", 50, 1),
    closingEnabled: readBool("CLOSING_ENABLED", true),
    closingAtReply,
    redisRequired: readBool("REDIS_REQUIRED", true),
    parentLookupEnabled: readBool("PARENT_LOOKUP_ENABLED", true),
  });
}

module.exports = { loadPolicy, intEnv, boolEnv };
