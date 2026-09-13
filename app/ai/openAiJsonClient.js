const fetch = require("node-fetch");

function createOpenAiJsonClient({
  apiKey = process.env.OPENAI_API_KEY || "",
  fetchImpl = fetch,
  endpoint = "https://api.openai.com/v1/chat/completions",
  timeoutMs = 20_000,
} = {}) {
  async function completeJson({ model, messages, maxOutputTokens = 800 } = {}) {
    if (!apiKey) return { status: "failed", reason: "OPENAI_KEY_MISSING" };
    if (!model || !Array.isArray(messages) || !messages.length) {
      return { status: "failed", reason: "INVALID_AI_REQUEST" };
    }

    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        timeout: timeoutMs,
        headers: {
          authorization: `Bearer ${apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: String(model),
          messages,
          max_completion_tokens: Math.max(1, Math.floor(Number(maxOutputTokens) || 800)),
          response_format: { type: "json_object" },
        }),
      });
    } catch (_) {
      return { status: "failed", reason: "OPENAI_NETWORK_ERROR" };
    }

    let data = null;
    try { data = await response.json(); } catch (_) {}
    if (!response.ok) {
      return {
        status: "failed",
        reason: "OPENAI_API_ERROR",
        httpStatus: response.status,
        apiErrorType: data?.error?.type || null,
      };
    }

    let value;
    try {
      value = JSON.parse(data?.choices?.[0]?.message?.content || "");
    } catch (_) {
      return { status: "failed", reason: "OPENAI_INVALID_JSON", usage: data?.usage || null };
    }

    return {
      status: "ok",
      value,
      usage: data?.usage || null,
      responseId: data?.id ? String(data.id) : null,
    };
  }

  return {
    completeJson,
    health: () => ({ configured: Boolean(apiKey), endpointHost: new URL(endpoint).host }),
  };
}

module.exports = { createOpenAiJsonClient };
