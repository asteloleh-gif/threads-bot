const AI_TIERS = Object.freeze({
  CHEAP: "cheap",
  STANDARD: "standard",
  REASONING: "reasoning",
});

const DEFAULT_TASK_TIERS = Object.freeze({
  createBrief: AI_TIERS.STANDARD,
  generatePost: AI_TIERS.STANDARD,
  reviewContent: AI_TIERS.CHEAP,
  analyzePerformance: AI_TIERS.REASONING,
  generateVisualBrief: AI_TIERS.STANDARD,
  rankCandidates: AI_TIERS.CHEAP,
  generateReply: AI_TIERS.CHEAP,
});

function createModelRouter({ env = process.env, taskTiers = DEFAULT_TASK_TIERS } = {}) {
  const fallback = String(env.OPENAI_MODEL || "gpt-5.6-luna").trim();
  const models = Object.freeze({
    [AI_TIERS.CHEAP]: String(env.AI_MODEL_CHEAP || fallback).trim(),
    [AI_TIERS.STANDARD]: String(env.AI_MODEL_STANDARD || fallback).trim(),
    [AI_TIERS.REASONING]: String(env.AI_MODEL_REASONING || env.AI_MODEL_STANDARD || fallback).trim(),
  });

  function route({ task, tier = null } = {}) {
    const selectedTier = String(tier || taskTiers[String(task)] || AI_TIERS.STANDARD).toLowerCase();
    if (!Object.values(AI_TIERS).includes(selectedTier)) throw new Error(`Unknown AI tier: ${selectedTier}`);
    const model = models[selectedTier];
    if (!model) throw new Error(`AI model is not configured for tier ${selectedTier}`);
    return Object.freeze({ tier: selectedTier, model });
  }

  return { route, models, taskTiers: Object.freeze({ ...taskTiers }) };
}

module.exports = { createModelRouter, AI_TIERS, DEFAULT_TASK_TIERS };
