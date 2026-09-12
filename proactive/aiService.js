const fetch = require("node-fetch");

function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text || "").length / 4));
}

function createProactiveAiService({ apiKey, model = "gpt-5.6-luna", state, config, fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  async function reserve(inputTokens, maxOutputTokens) {
    const total = inputTokens + maxOutputTokens;
    const tokens = await state.takeQuota("ai-tokens", total, config.dailyAiTokenLimit);
    if (tokens.granted !== total) return { allowed: false, reason: "DAILY_TOKEN_BUDGET" };
    // Standard short-context gpt-5.6-luna: $0.20/M input and $1.20/M output.
    const microUsd = Math.ceil(inputTokens * 0.2 + maxOutputTokens * 1.2);
    const cost = await state.takeQuota("ai-cost-microusd", microUsd, config.monthlyAiCostMicrousdLimit, { scope: "month" });
    if (cost.granted !== microUsd) return { allowed: false, reason: "MONTHLY_COST_BUDGET" };
    return { allowed: true, reservedTokens: total, reservedMicroUsd: microUsd };
  }

  async function complete(messages, maxOutputTokens) {
    if (!apiKey) return { status: "failed", reason: "OPENAI_KEY_MISSING" };
    const inputTokens = estimateTokens(JSON.stringify(messages));
    const budget = await reserve(inputTokens, maxOutputTokens);
    if (!budget.allowed) return { status: "budget_exhausted", reason: budget.reason };
    let response;
    try {
      response = await fetchImpl("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        timeout: timeoutMs,
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        body: JSON.stringify({ model, messages, max_completion_tokens: maxOutputTokens, response_format: { type: "json_object" } }),
      });
    } catch (_) { return { status: "failed", reason: "OPENAI_NETWORK_ERROR" }; }
    let data = null;
    try { data = await response.json(); } catch (_) {}
    if (!response.ok) return { status: "failed", reason: "OPENAI_API_ERROR", httpStatus: response.status, apiErrorType: data?.error?.type || null };
    try {
      return { status: "ok", value: JSON.parse(data?.choices?.[0]?.message?.content || "{}"), usage: data?.usage || null };
    } catch (_) { return { status: "failed", reason: "OPENAI_INVALID_JSON" }; }
  }

  async function rank(candidates) {
    const selected = candidates.slice(0, 25);
    const items = selected.map(item => ({ id: item.sourcePostId, text: item.text.slice(0, 700), hasImage: item.media?.kind === "image", altText: item.media?.altText || null }));
    const userContent = [{ type: "text", text: JSON.stringify({ items }) }];
    for (const item of selected.filter(value => value.media?.kind === "image").slice(0, 4)) {
      userContent.push({ type: "text", text: `Image for candidate id ${item.sourcePostId}:` });
      userContent.push({ type: "image_url", image_url: { url: item.media.imageUrl, detail: "low" } });
    }
    const messages = [
      { role: "system", content: "Evaluate public Threads posts for a thoughtful business/tech/e-commerce reply from Leo. Reject spam, engagement bait, hostility, politics, sensitive topics, requests for professional advice, and posts where a reply would feel promotional or intrusive. Detect the post language. Return JSON only: {items:[{id,score,language,reason}]}. score 0-100." },
      { role: "user", content: userContent },
    ];
    const result = await complete(messages, 1000);
    if (result.status !== "ok") return result;
    const byId = new Map(candidates.map(item => [String(item.sourcePostId), item]));
    const ranked = (Array.isArray(result.value?.items) ? result.value.items : [])
      .map(item => ({ candidate: byId.get(String(item.id)), score: Number(item.score), language: String(item.language || "") }))
      .filter(item => item.candidate && Number.isFinite(item.score) && item.score >= 75 && item.language)
      .sort((a, b) => b.score - a.score);
    return { status: "ok", ranked, usage: result.usage };
  }

  async function draft(candidate, language) {
    const source = { sourcePost: candidate.text.slice(0, 1000), detectedLanguage: language, altText: candidate.media?.altText || null };
    const userContent = candidate.media?.kind === "image" ? [
      { type: "text", text: JSON.stringify(source) },
      { type: "image_url", image_url: { url: candidate.media.imageUrl, detail: "low" } },
    ] : JSON.stringify(source);
    const messages = [
      { role: "system", content: "Write one natural public Threads reply from Leo. Use the same language as the source post. One or two short sentences, maximum 350 characters, useful and conversational. Do not sell, promise, invent facts or numbers, reveal automation, mention AI, use insults, or claim personal experience not present in the post. A relevant question is allowed. Return JSON only: {text,language}." },
      { role: "user", content: userContent },
    ];
    const result = await complete(messages, 300);
    if (result.status !== "ok") return result;
    const text = String(result.value?.text || "").trim();
    const outputLanguage = String(result.value?.language || language || "").trim();
    if (!text || [...text].length > 350 || !outputLanguage) return { status: "failed", reason: "INVALID_DRAFT" };
    return { status: "ok", text, language: outputLanguage, usage: result.usage };
  }

  return { rank, draft, estimateTokens };
}

module.exports = { createProactiveAiService, estimateTokens };
