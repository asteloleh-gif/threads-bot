const SUPPORTED_PLATFORMS = Object.freeze(["threads", "instagram", "facebook"]);

function normalize(value) {
  return String(value || "").trim();
}

function normalizePlatform(value) {
  const platform = normalize(value).toLowerCase();
  if (!SUPPORTED_PLATFORMS.includes(platform)) {
    throw new Error(`Unsupported social platform: ${platform || "missing"}`);
  }
  return platform;
}

function createAccountConfig(input = {}) {
  const platform = normalizePlatform(input.platform || "threads");
  const username = normalize(input.username).replace(/^@/, "");
  const brand = normalize(input.brand || username || "default").toLowerCase();
  const key = normalize(input.key || `${brand}:${platform}`).toLowerCase();

  if (!key) throw new Error("Social account key is required");
  if (!username) throw new Error(`Social account username is required for ${key}`);

  return Object.freeze({
    key,
    brand,
    platform,
    language: normalize(input.language || "auto").toLowerCase(),
    userId: normalize(input.userId) || null,
    username,
    accessToken: normalize(input.accessToken) || null,
    verifyToken: normalize(input.verifyToken) || null,
    enabled: input.enabled !== false,
  });
}

function loadPrimaryAccount(env = process.env) {
  return createAccountConfig({
    key: env.SOCIAL_ACCOUNT_KEY || undefined,
    brand: env.SOCIAL_BRAND || env.THREADS_USERNAME || "leoakastel",
    platform: "threads",
    language: env.SOCIAL_LANGUAGE || env.PROACTIVE_ACCOUNT || "auto",
    userId: env.THREADS_USER_ID,
    username: env.THREADS_USERNAME || "leoakastel",
    accessToken: env.THREADS_ACCESS_TOKEN || env.THREDS_ACCESS_TOKEN,
    verifyToken: env.THREADS_VERIFY_TOKEN,
    enabled: String(env.BOT_ENABLED || "false").toLowerCase() === "true",
  });
}

function publicAccountView(account) {
  if (!account) return null;
  return {
    key: account.key,
    brand: account.brand,
    platform: account.platform,
    language: account.language,
    userId: account.userId,
    username: account.username,
    enabled: account.enabled,
  };
}

module.exports = {
  SUPPORTED_PLATFORMS,
  createAccountConfig,
  loadPrimaryAccount,
  publicAccountView,
};
