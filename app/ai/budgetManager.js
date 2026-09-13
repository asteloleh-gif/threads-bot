function estimateTokens(value) {
  return Math.max(1, Math.ceil(String(value || "").length / 4));
}

function validRate(value) {
  if (value == null || value === "") return null;
  const rate = Number(value);
  return Number.isFinite(rate) && rate >= 0 ? rate : null;
}

function estimateCostMicrousd({ inputTokens, outputTokens, inputUsdPer1M, outputUsdPer1M } = {}) {
  const inputRate = validRate(inputUsdPer1M);
  const outputRate = validRate(outputUsdPer1M);
  if (inputRate == null || outputRate == null) return null;
  return Math.ceil(Number(inputTokens || 0) * inputRate + Number(outputTokens || 0) * outputRate);
}

function createBudgetManager({
  quotaStore,
  dailyTokenLimit = 50_000,
  monthlyCostMicrousdLimit = 1_000_000,
  inputUsdPer1M = null,
  outputUsdPer1M = null,
  maxInputTokensPerCall = 20_000,
  maxOutputTokensPerCall = 2_000,
} = {}) {
  async function reserve({ accountKey, input, maxOutputTokens = 800 } = {}) {
    const normalizedAccountKey = String(accountKey || "").trim().toLowerCase();
    if (!normalizedAccountKey) return { allowed: false, reason: "ACCOUNT_KEY_REQUIRED" };
    if (!quotaStore || typeof quotaStore.takeQuota !== "function") {
      return { allowed: false, reason: "BUDGET_STORE_UNAVAILABLE" };
    }

    const inputTokens = estimateTokens(typeof input === "string" ? input : JSON.stringify(input || {}));
    const outputTokens = Math.max(1, Math.floor(Number(maxOutputTokens) || 0));
    if (inputTokens > maxInputTokensPerCall) return { allowed: false, reason: "INPUT_TOKEN_LIMIT", inputTokens };
    if (outputTokens > maxOutputTokensPerCall) return { allowed: false, reason: "OUTPUT_TOKEN_LIMIT", inputTokens, maxOutputTokens: outputTokens };

    const estimatedMicrousd = estimateCostMicrousd({
      inputTokens,
      outputTokens,
      inputUsdPer1M,
      outputUsdPer1M,
    });
    if (estimatedMicrousd == null) {
      return { allowed: false, reason: "PRICING_NOT_CONFIGURED", inputTokens, maxOutputTokens: outputTokens };
    }

    const totalTokens = inputTokens + outputTokens;
    const tokenKind = `ai:${normalizedAccountKey}:tokens`;
    const tokenReservation = await quotaStore.takeQuota(tokenKind, totalTokens, dailyTokenLimit, { scope: "day" });
    if (Number(tokenReservation?.granted || 0) !== totalTokens) {
      return { allowed: false, reason: tokenReservation?.reason || "DAILY_TOKEN_BUDGET", inputTokens, maxOutputTokens: outputTokens };
    }

    const costKind = `ai:${normalizedAccountKey}:cost-microusd`;
    const costReservation = await quotaStore.takeQuota(costKind, estimatedMicrousd, monthlyCostMicrousdLimit, { scope: "month" });
    if (Number(costReservation?.granted || 0) !== estimatedMicrousd) {
      return { allowed: false, reason: costReservation?.reason || "MONTHLY_COST_BUDGET", inputTokens, maxOutputTokens: outputTokens, estimatedMicrousd };
    }

    return {
      allowed: true,
      inputTokensEstimated: inputTokens,
      maxOutputTokens: outputTokens,
      reservedTokens: totalTokens,
      reservedMicrousd: estimatedMicrousd,
    };
  }

  return {
    reserve,
    estimateTokens,
    health: () => ({
      quotaStoreReady: Boolean(quotaStore?.isReady?.() ?? quotaStore),
      dailyTokenLimit,
      monthlyCostMicrousdLimit,
      maxInputTokensPerCall,
      maxOutputTokensPerCall,
      pricingConfigured: estimateCostMicrousd({ inputTokens: 1, outputTokens: 1, inputUsdPer1M, outputUsdPer1M }) != null,
    }),
  };
}

module.exports = { createBudgetManager, estimateTokens, estimateCostMicrousd };
