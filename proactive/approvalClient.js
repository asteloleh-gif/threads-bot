const fetch = require("node-fetch");

function createApprovalClient({ baseUrl, account, secret, fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const configured = () => Boolean(baseUrl && account && secret?.length >= 32);
  async function request(path, options = {}) {
    if (!configured()) return { status: "failed", reason: "APPROVAL_NOT_CONFIGURED" };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${baseUrl}${path}`, {
        ...options,
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${secret}`,
          "x-copilot-account": account,
          "content-type": "application/json",
          ...(options.headers || {}),
        },
      });
      let data = null;
      try { data = await response.json(); } catch (_) {}
      if (!response.ok) return { status: "failed", reason: data?.error || "APPROVAL_HTTP_ERROR", httpStatus: response.status, retryAfter: response.headers?.get?.("retry-after") || null };
      return { status: "ok", data };
    } catch (_) {
      return { status: "failed", reason: "APPROVAL_NETWORK_ERROR" };
    } finally { clearTimeout(timer); }
  }
  async function submit(draft) {
    const result = await request("/api/copilot/drafts", { method: "POST", body: JSON.stringify(draft) });
    return result.status === "ok" ? { status: "ok", ...result.data } : result;
  }
  async function get(draftId) {
    const result = await request(`/api/copilot/drafts/${encodeURIComponent(draftId)}`, { method: "GET" });
    return result.status === "ok" ? { status: "ok", ...result.data } : result;
  }
  async function report(summary) {
    const result = await request("/api/copilot/reports", { method: "POST", body: JSON.stringify(summary) });
    return result.status === "ok" ? { ...result.data, status: "ok" } : result;
  }
  return { configured, submit, get, report };
}

module.exports = { createApprovalClient };
