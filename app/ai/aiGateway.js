const crypto = require("crypto");
const { estimateCostMicrousd } = require("./budgetManager");

function actualUsage(usage = {}) {
  return {
    inputTokens: usage.prompt_tokens ?? usage.input_tokens ?? null,
    outputTokens: usage.completion_tokens ?? usage.output_tokens ?? null,
    cachedInputTokens: usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens ?? 0,
  };
}

function createAiGateway({
  client,
  modelRouter,
  budgetManager,
  telemetry,
  pricing = {},
  clock = () => Date.now(),
  uuid = () => crypto.randomUUID(),
} = {}) {
  if (!client || typeof client.completeJson !== "function") throw new Error("AI gateway requires client");
  if (!modelRouter || typeof modelRouter.route !== "function") throw new Error("AI gateway requires model router");
  if (!budgetManager || typeof budgetManager.reserve !== "function") throw new Error("AI gateway requires budget manager");
  if (!telemetry || typeof telemetry.recordAgentRun !== "function") throw new Error("AI gateway requires durable telemetry");

  async function record(input) {
    try {
      await telemetry.recordAgentRun(input);
      return true;
    } catch (_) {
      return false;
    }
  }

  async function execute({ accountKey, workflowId = null, task, messages, maxOutputTokens, validate } = {}) {
    const route = modelRouter.route({ task });
    const runId = uuid();
    const startedMs = clock();
    const startedAt = new Date(startedMs).toISOString();
    const budget = await budgetManager.reserve({ accountKey, input: messages, maxOutputTokens });

    if (!budget.allowed) {
      await record({
        runId,
        accountKey,
        workflowId,
        node: task,
        model: route.model,
        status: "BUDGET_BLOCKED",
        metadata: { tier: route.tier, reason: budget.reason },
        startedAt,
        finishedAt: new Date(clock()).toISOString(),
      });
      return { status: "budget_exhausted", reason: budget.reason, model: route.model, tier: route.tier };
    }

    const result = await client.completeJson({ model: route.model, messages, maxOutputTokens });
    const finishedMs = clock();
    const usage = actualUsage(result.usage || {});
    const costMicrousd = usage.inputTokens == null || usage.outputTokens == null ? null : estimateCostMicrousd({
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      inputUsdPer1M: pricing.inputUsdPer1M,
      outputUsdPer1M: pricing.outputUsdPer1M,
    });

    if (result.status !== "ok") {
      const stored = await record({
        runId,
        accountKey,
        workflowId,
        node: task,
        model: route.model,
        status: "FAILED",
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        costMicrousd,
        latencyMs: Math.max(0, finishedMs - startedMs),
        metadata: { tier: route.tier, reason: result.reason, httpStatus: result.httpStatus || null },
        startedAt,
        finishedAt: new Date(finishedMs).toISOString(),
      });
      if (!stored) return { status: "failed", reason: "AI_TELEMETRY_ERROR" };
      return { ...result, model: route.model, tier: route.tier, runId };
    }

    let value;
    try {
      value = validate(result.value);
    } catch (error) {
      const stored = await record({
        runId,
        accountKey,
        workflowId,
        node: task,
        model: route.model,
        status: "INVALID_OUTPUT",
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        costMicrousd,
        latencyMs: Math.max(0, finishedMs - startedMs),
        metadata: { tier: route.tier, reason: error?.message || "INVALID_OUTPUT" },
        startedAt,
        finishedAt: new Date(finishedMs).toISOString(),
      });
      if (!stored) return { status: "failed", reason: "AI_TELEMETRY_ERROR" };
      return { status: "failed", reason: "AI_INVALID_OUTPUT", model: route.model, tier: route.tier, runId };
    }

    const stored = await record({
      runId,
      accountKey,
      workflowId,
      node: task,
      model: route.model,
      status: "SUCCEEDED",
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cachedInputTokens: usage.cachedInputTokens,
      costMicrousd,
      latencyMs: Math.max(0, finishedMs - startedMs),
      metadata: { tier: route.tier, responseId: result.responseId || null },
      startedAt,
      finishedAt: new Date(finishedMs).toISOString(),
    });
    if (!stored) return { status: "failed", reason: "AI_TELEMETRY_ERROR" };

    return { status: "ok", value, usage, costMicrousd, model: route.model, tier: route.tier, runId };
  }

  async function createBrief({ accountKey, workflowId = null, objective, research = [], analytics = null, brand = null, language = "auto" } = {}) {
    const input = { objective, research, analytics, brand, language };
    const messages = [
      {
        role: "system",
        content: "Create a concise social content brief from only the supplied research and analytics. Never invent facts, numbers, quotes, sources, or performance claims. Return JSON only with objective, audience, angle, keyPoints, evidenceNotes, language.",
      },
      { role: "user", content: JSON.stringify(input) },
    ];
    return execute({
      accountKey, workflowId, task: "createBrief", messages, maxOutputTokens: 1200,
      validate(value) {
        if (!value || typeof value !== "object") throw new Error("brief object required");
        const keyPoints = Array.isArray(value.keyPoints) ? value.keyPoints.map(String).filter(Boolean).slice(0, 12) : [];
        if (!String(value.angle || "").trim()) throw new Error("brief angle required");
        return {
          objective: String(value.objective ?? objective ?? "").trim(),
          audience: String(value.audience || "").trim(),
          angle: String(value.angle).trim(),
          keyPoints,
          evidenceNotes: Array.isArray(value.evidenceNotes) ? value.evidenceNotes.map(String).filter(Boolean).slice(0, 12) : [],
          language: String(value.language || language || "auto").trim(),
        };
      },
    });
  }

  async function generatePost({ accountKey, workflowId = null, brief, platform = "threads", constraints = {}, language = "auto" } = {}) {
    const messages = [
      {
        role: "system",
        content: "Write one publishable social post from the supplied brief. Preserve supported facts exactly; never invent facts or numbers. Keep the requested language and platform constraints. Return JSON only with text and language.",
      },
      { role: "user", content: JSON.stringify({ brief, platform, constraints, language }) },
    ];
    return execute({
      accountKey, workflowId, task: "generatePost", messages, maxOutputTokens: 800,
      validate(value) {
        const text = String(value?.text || "").trim();
        if (!text) throw new Error("post text required");
        return { text, language: String(value?.language || language || "auto").trim() };
      },
    });
  }

  async function reviewContent({ accountKey, workflowId = null, content, brief, policy = null } = {}) {
    const messages = [
      {
        role: "system",
        content: "Review the draft against the supplied brief and policy. Check unsupported claims, invented facts/numbers, tone, relevance, and obvious safety problems. Return JSON only: {decision:PASS|REVISE|REJECT,notes,risks:[...]}. PASS does not mean human approval.",
      },
      { role: "user", content: JSON.stringify({ content, brief, policy }) },
    ];
    return execute({
      accountKey, workflowId, task: "reviewContent", messages, maxOutputTokens: 600,
      validate(value) {
        const decision = String(value?.decision || "").trim().toUpperCase();
        if (!["PASS", "REVISE", "REJECT"].includes(decision)) throw new Error("review decision invalid");
        return {
          decision,
          notes: String(value?.notes || "").trim(),
          risks: Array.isArray(value?.risks) ? value.risks.map(String).filter(Boolean).slice(0, 12) : [],
        };
      },
    });
  }

  return {
    createBrief,
    generatePost,
    reviewContent,
    health: () => ({
      client: client.health?.() || null,
      budget: budgetManager.health?.() || null,
      models: modelRouter.models || null,
      durableTelemetryRequired: true,
    }),
  };
}

module.exports = { createAiGateway, actualUsage };
