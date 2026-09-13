const crypto = require("crypto");
const { createContentRepository } = require("./contentRepository");
const { createContentPipeline } = require("./contentPipeline");
const { createModelRouter } = require("../ai/modelRouter");
const { createBudgetManager } = require("../ai/budgetManager");
const { createOpenAiJsonClient } = require("../ai/openAiJsonClient");
const { createAiGateway } = require("../ai/aiGateway");
const { createRedisQuotaStore } = require("../ai/redisQuotaStore");

function envNumber(env, name, fallback = null) {
  const raw = env[name];
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function createContentRuntime({
  enabled = false,
  allowLiveScheduling = false,
  redisUrl,
  postgresStore,
  durable,
  publishEngine,
  providerRegistry,
  env = process.env,
  quotaStore = null,
  aiClient = null,
  uuid = () => crypto.randomUUID(),
} = {}) {
  if (!postgresStore) throw new Error("Content runtime requires Postgres store");
  if (!durable || typeof durable.recordAgentRun !== "function") throw new Error("Content runtime requires durable repository");
  if (!publishEngine || typeof publishEngine.enqueue !== "function") throw new Error("Content runtime requires Publish Engine");
  if (!providerRegistry || typeof providerRegistry.findForAccount !== "function") throw new Error("Content runtime requires provider registry");

  const repository = createContentRepository({ store: postgresStore });
  const quotas = quotaStore || createRedisQuotaStore({
    redisUrl,
    namespace: String(env.CONTENT_AI_REDIS_NAMESPACE || "astel:content-ai:v1"),
  });
  const modelRouter = createModelRouter({ env });
  const inputUsdPer1M = envNumber(env, "OPENAI_INPUT_USD_PER_1M", null);
  const outputUsdPer1M = envNumber(env, "OPENAI_OUTPUT_USD_PER_1M", null);
  const budgetManager = createBudgetManager({
    quotaStore: quotas,
    dailyTokenLimit: envNumber(env, "CONTENT_AI_DAILY_TOKEN_LIMIT", 50_000),
    monthlyCostMicrousdLimit: envNumber(env, "CONTENT_AI_MONTHLY_COST_MICROUSD_LIMIT", 1_000_000),
    inputUsdPer1M,
    outputUsdPer1M,
    maxInputTokensPerCall: envNumber(env, "CONTENT_AI_MAX_INPUT_TOKENS", 20_000),
    maxOutputTokensPerCall: envNumber(env, "CONTENT_AI_MAX_OUTPUT_TOKENS", 2_000),
  });
  const client = aiClient || createOpenAiJsonClient({ apiKey: env.OPENAI_API_KEY || "" });
  const ai = createAiGateway({
    client,
    modelRouter,
    budgetManager,
    telemetry: durable,
    pricing: { inputUsdPer1M, outputUsdPer1M },
    uuid,
  });
  const pipeline = createContentPipeline({ repository, publishEngine, uuid });

  let ready = false;
  let lastError = null;

  function requireEnabled() {
    if (!enabled) throw new Error("Content runtime is disabled");
    if (!ready) throw new Error("Content runtime is not ready");
  }

  function providerFor(accountKey) {
    const normalized = String(accountKey || "").trim().toLowerCase();
    if (!normalized) throw new Error("accountKey is required");
    const provider = providerRegistry.findForAccount(normalized);
    if (!provider) throw new Error(`Unknown social account: ${normalized}`);
    return provider;
  }

  async function init() {
    if (!enabled) return { status: "skipped", reason: "CONTENT_PIPELINE_DISABLED" };
    if (!postgresStore.isReady?.()) {
      lastError = "DATABASE_UNAVAILABLE";
      throw new Error(lastError);
    }
    const quotaStart = await quotas.init();
    if (!quotaStart?.ready || !quotas.isReady?.()) {
      lastError = quotaStart?.reason || "AI_QUOTA_STORE_UNAVAILABLE";
      throw new Error(lastError);
    }
    const aiHealth = ai.health();
    if (aiHealth.client?.configured === false) {
      lastError = "OPENAI_KEY_MISSING";
      throw new Error(lastError);
    }
    if (aiHealth.budget?.pricingConfigured === false) {
      lastError = "AI_PRICING_NOT_CONFIGURED";
      throw new Error(lastError);
    }
    ready = true;
    lastError = null;
    return { status: "ok", reason: "READY" };
  }

  async function generateBrief({ accountKey, objective, research = [], analytics = null, brand = null, language = "auto", metadata = {} } = {}) {
    requireEnabled();
    providerFor(accountKey);
    const workflowId = uuid();
    const generated = await ai.createBrief({ accountKey, workflowId, objective, research, analytics, brand, language });
    if (generated.status !== "ok") return generated;
    const stored = await pipeline.createBrief({
      accountKey,
      objective,
      research,
      brief: generated.value,
      metadata: { ...metadata, workflowId, aiRunId: generated.runId },
    });
    return { status: "ok", workflowId, aiRunId: generated.runId, ...stored };
  }

  async function generateDraft({ briefId, constraints = {}, language = "auto", metadata = {} } = {}) {
    requireEnabled();
    const brief = await repository.getBrief(briefId);
    if (!brief) throw new Error("Content brief not found");
    const provider = providerFor(brief.account_key);
    const workflowId = brief.metadata?.workflowId || String(briefId);
    const generated = await ai.generatePost({
      accountKey: brief.account_key,
      workflowId,
      brief: brief.brief,
      platform: provider.platform,
      constraints,
      language,
    });
    if (generated.status !== "ok") return generated;
    const stored = await pipeline.createDraft({
      briefId,
      content: { type: "text", text: generated.value.text },
      source: "ai-content-gateway",
      metadata: { ...metadata, aiRunId: generated.runId, language: generated.value.language },
    });
    return { status: "ok", aiRunId: generated.runId, ...stored };
  }

  async function reviewDraft({ draftId, policy = null, metadata = {} } = {}) {
    requireEnabled();
    const draft = await repository.getDraft(draftId);
    if (!draft) throw new Error("Draft not found");
    providerFor(draft.account_key);
    const briefId = draft.metadata?.briefId;
    const brief = briefId ? await repository.getBrief(briefId) : null;
    const workflowId = brief?.metadata?.workflowId || String(briefId || draftId);
    const reviewed = await ai.reviewContent({
      accountKey: draft.account_key,
      workflowId,
      content: draft.content,
      brief: brief?.brief || null,
      policy,
    });
    if (reviewed.status !== "ok") return reviewed;
    const stored = await pipeline.reviewDraft({
      draftId,
      decision: reviewed.value.decision,
      notes: reviewed.value.notes,
      metadata: { ...metadata, aiRunId: reviewed.runId, risks: reviewed.value.risks },
    });
    return { status: "ok", aiRunId: reviewed.runId, review: reviewed.value, ...stored };
  }

  async function decideApproval(input = {}) {
    requireEnabled();
    return pipeline.decideApproval(input);
  }

  async function scheduleApprovedDraft(input = {}) {
    requireEnabled();
    const publishing = publishEngine.health?.() || {};
    if (!publishing.enabled) throw new Error("Publish Engine must be enabled before content scheduling");
    if (!publishing.dryRun && !allowLiveScheduling) {
      throw new Error("Live content scheduling is not approved");
    }
    return pipeline.scheduleApprovedDraft(input);
  }

  async function close() {
    ready = false;
    await quotas.close?.();
  }

  function health() {
    return {
      enabled: Boolean(enabled),
      ready: Boolean(ready),
      allowLiveScheduling: Boolean(allowLiveScheduling),
      lastError,
      repository: repository.health(),
      quota: quotas.health?.() || null,
      ai: ai.health(),
      pipeline: pipeline.health(),
    };
  }

  return {
    init,
    close,
    generateBrief,
    generateDraft,
    reviewDraft,
    decideApproval,
    scheduleApprovedDraft,
    health,
    repository,
    pipeline,
    ai,
  };
}

module.exports = { createContentRuntime, envNumber };
