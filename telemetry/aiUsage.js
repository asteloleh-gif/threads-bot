const { estimateTokens } = require("../memory/reconstructBranchMemory");

const PRICING_VERSION = "2026-09-configurable";

function envNumber(name) {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function estimateCostUsd({ inputTokens = 0, outputTokens = 0, cachedInputTokens = 0 } = {}) {
  const inputPerMillion = envNumber("OPENAI_INPUT_USD_PER_1M");
  const cachedPerMillion = envNumber("OPENAI_CACHED_INPUT_USD_PER_1M");
  const outputPerMillion = envNumber("OPENAI_OUTPUT_USD_PER_1M");
  if (inputPerMillion == null || outputPerMillion == null) return null;
  const cached = Math.min(Number(cachedInputTokens || 0), Number(inputTokens || 0));
  const uncached = Math.max(0, Number(inputTokens || 0) - cached);
  const cachedRate = cachedPerMillion == null ? inputPerMillion : cachedPerMillion;
  return (uncached * inputPerMillion + cached * cachedRate + Number(outputTokens || 0) * outputPerMillion) / 1_000_000;
}

function componentEstimates({ systemPrompt = "", knowledgeBase = "", memory = [], currentComment = "" } = {}) {
  return {
    systemTokensEstimated: estimateTokens(systemPrompt),
    kbTokensEstimated: estimateTokens(knowledgeBase),
    memoryTokensEstimated: memory.reduce((sum, m) => sum + estimateTokens(m?.text || m?.content || ""), 0),
    currentCommentTokensEstimated: estimateTokens(currentComment),
  };
}

function usageFromResponse(data = {}) {
  const usage = data.usage || {};
  return {
    inputTokensActual: usage.prompt_tokens ?? usage.input_tokens ?? null,
    outputTokensActual: usage.completion_tokens ?? usage.output_tokens ?? null,
    cachedInputTokensActual: usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens ?? 0,
  };
}

function logAiUsage(event) {
  console.log("AI_USAGE", JSON.stringify({ event: "AI_USAGE", pricingVersion: PRICING_VERSION, ...event }));
}

module.exports = { PRICING_VERSION, estimateCostUsd, componentEstimates, usageFromResponse, logAiUsage };
