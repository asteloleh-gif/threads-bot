const test = require("node:test");
const assert = require("node:assert/strict");
const { createModelRouter } = require("../app/ai/modelRouter");
const { createBudgetManager, estimateCostMicrousd } = require("../app/ai/budgetManager");
const { createOpenAiJsonClient } = require("../app/ai/openAiJsonClient");
const { createAiGateway } = require("../app/ai/aiGateway");

function response(status, data) {
  return { ok: status >= 200 && status < 300, status, async json() { return data; } };
}

function quotaStore({ denyKind = null } = {}) {
  const calls = [];
  return {
    calls,
    isReady: () => true,
    async takeQuota(kind, requested, limit, options) {
      calls.push({ kind, requested, limit, options });
      if (kind.includes(denyKind || "__never__")) return { granted: 0 };
      return { granted: requested, remaining: Math.max(0, limit - requested) };
    },
  };
}

function telemetry({ fail = false } = {}) {
  const runs = [];
  return {
    runs,
    async recordAgentRun(run) {
      if (fail) throw new Error("db down");
      runs.push(run);
      return { runId: run.runId };
    },
  };
}

function router() {
  return createModelRouter({
    env: {
      OPENAI_MODEL: "fallback-model",
      AI_MODEL_CHEAP: "cheap-model",
      AI_MODEL_STANDARD: "standard-model",
      AI_MODEL_REASONING: "reasoning-model",
    },
  });
}

function budget(store = quotaStore()) {
  return createBudgetManager({
    quotaStore: store,
    dailyTokenLimit: 10000,
    monthlyCostMicrousdLimit: 100000,
    inputUsdPer1M: 1,
    outputUsdPer1M: 2,
    maxInputTokensPerCall: 5000,
    maxOutputTokensPerCall: 2000,
  });
}

test("model router maps async tasks to configured tiers without hardcoding a second provider", () => {
  const modelRouter = router();
  assert.deepEqual(modelRouter.route({ task: "reviewContent" }), { tier: "cheap", model: "cheap-model" });
  assert.deepEqual(modelRouter.route({ task: "createBrief" }), { tier: "standard", model: "standard-model" });
  assert.deepEqual(modelRouter.route({ task: "analyzePerformance" }), { tier: "reasoning", model: "reasoning-model" });
});

test("budget manager fails closed without quota state or pricing and enforces per-call caps", async () => {
  const missingStore = createBudgetManager({ inputUsdPer1M: 1, outputUsdPer1M: 2 });
  assert.equal((await missingStore.reserve({ accountKey: "a", input: "x", maxOutputTokens: 5 })).reason, "BUDGET_STORE_UNAVAILABLE");

  const noPricing = createBudgetManager({ quotaStore: quotaStore(), maxOutputTokensPerCall: 100 });
  assert.equal((await noPricing.reserve({ accountKey: "a", input: "x", maxOutputTokens: 5 })).reason, "PRICING_NOT_CONFIGURED");

  const capped = budget();
  assert.equal((await capped.reserve({ accountKey: "a", input: "x", maxOutputTokens: 3000 })).reason, "OUTPUT_TOKEN_LIMIT");
});

test("budget reservations are account scoped and include daily tokens plus monthly estimated cost", async () => {
  const store = quotaStore();
  const manager = budget(store);
  const result = await manager.reserve({ accountKey: "LEO:THREADS", input: "abcd", maxOutputTokens: 10 });
  assert.equal(result.allowed, true);
  assert.equal(store.calls.length, 2);
  assert.equal(store.calls[0].kind, "ai:leo:threads:tokens");
  assert.equal(store.calls[0].options.scope, "day");
  assert.equal(store.calls[1].kind, "ai:leo:threads:cost-microusd");
  assert.equal(store.calls[1].options.scope, "month");
  assert.equal(estimateCostMicrousd({ inputTokens: 10, outputTokens: 20, inputUsdPer1M: 1, outputUsdPer1M: 2 }), 50);
});

test("OpenAI JSON client keeps bearer token out of URL/body and parses JSON output", async () => {
  const calls = [];
  const client = createOpenAiJsonClient({
    apiKey: "secret-token",
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return response(200, {
        id: "resp-1",
        choices: [{ message: { content: JSON.stringify({ text: "hello", language: "en" }) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      });
    },
  });
  const result = await client.completeJson({ model: "m", messages: [{ role: "user", content: "x" }], maxOutputTokens: 50 });
  assert.equal(result.status, "ok");
  assert.equal(result.value.text, "hello");
  assert.equal(calls[0].options.headers.authorization, "Bearer secret-token");
  assert.doesNotMatch(calls[0].url + calls[0].options.body, /secret-token/);
});

test("AI gateway records successful model/tokens/cost/latency in durable agent telemetry", async () => {
  const runs = telemetry();
  const client = {
    health: () => ({ configured: true }),
    async completeJson() {
      return {
        status: "ok",
        value: { text: "A useful post", language: "en" },
        responseId: "r1",
        usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 25 } },
      };
    },
  };
  let t = 1000;
  const gateway = createAiGateway({
    client,
    modelRouter: router(),
    budgetManager: budget(),
    telemetry: runs,
    pricing: { inputUsdPer1M: 1, outputUsdPer1M: 2 },
    clock: () => { t += 10; return t; },
    uuid: () => "run-1",
  });
  const result = await gateway.generatePost({ accountKey: "leo:threads", workflowId: "wf-1", brief: { angle: "x" }, language: "en" });
  assert.equal(result.status, "ok");
  assert.equal(result.model, "standard-model");
  assert.equal(runs.runs.length, 1);
  assert.equal(runs.runs[0].status, "SUCCEEDED");
  assert.equal(runs.runs[0].inputTokens, 100);
  assert.equal(runs.runs[0].outputTokens, 20);
  assert.equal(runs.runs[0].cachedInputTokens, 25);
  assert.equal(runs.runs[0].costMicrousd, 140);
  assert.equal(runs.runs[0].workflowId, "wf-1");
});

test("budget denial prevents the model call and is still recorded as an agent run", async () => {
  let modelCalls = 0;
  const runs = telemetry();
  const gateway = createAiGateway({
    client: { async completeJson() { modelCalls += 1; return { status: "ok", value: {} }; } },
    modelRouter: router(),
    budgetManager: { reserve: async () => ({ allowed: false, reason: "DAILY_TOKEN_BUDGET" }) },
    telemetry: runs,
    uuid: () => "run-budget",
  });
  const result = await gateway.createBrief({ accountKey: "leo:threads", objective: "x" });
  assert.equal(result.status, "budget_exhausted");
  assert.equal(modelCalls, 0);
  assert.equal(runs.runs[0].status, "BUDGET_BLOCKED");
});

test("invalid reviewer output fails closed and is marked INVALID_OUTPUT", async () => {
  const runs = telemetry();
  const gateway = createAiGateway({
    client: { async completeJson() { return { status: "ok", value: { decision: "MAYBE" }, usage: {} }; } },
    modelRouter: router(),
    budgetManager: budget(),
    telemetry: runs,
    uuid: () => "run-invalid",
  });
  const result = await gateway.reviewContent({ accountKey: "leo:threads", content: { text: "x" }, brief: {} });
  assert.equal(result.status, "failed");
  assert.equal(result.reason, "AI_INVALID_OUTPUT");
  assert.equal(runs.runs[0].status, "INVALID_OUTPUT");
});

test("AI gateway refuses to return generated content when durable telemetry cannot be written", async () => {
  const gateway = createAiGateway({
    client: {
      async completeJson() {
        return { status: "ok", value: { text: "x", language: "en" }, usage: { prompt_tokens: 1, completion_tokens: 1 } };
      },
    },
    modelRouter: router(),
    budgetManager: budget(),
    telemetry: telemetry({ fail: true }),
  });
  const result = await gateway.generatePost({ accountKey: "leo:threads", brief: {}, language: "en" });
  assert.deepEqual(result, { status: "failed", reason: "AI_TELEMETRY_ERROR" });
});
