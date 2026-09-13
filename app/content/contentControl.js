const crypto = require("crypto");

function normalizeSecret(value) {
  return Buffer.from(String(value || ""), "utf8");
}

function secureTokenMatch(expected, authorizationHeader) {
  const configured = normalizeSecret(expected);
  if (configured.length < 32) return false;
  const match = /^Bearer\s+(.+)$/i.exec(String(authorizationHeader || ""));
  if (!match) return false;
  const supplied = normalizeSecret(match[1]);
  if (supplied.length !== configured.length) return false;
  return crypto.timingSafeEqual(configured, supplied);
}

function normalizeIdempotencyKey(value) {
  const key = String(value || "").trim();
  if (!key || key.length > 128) return null;
  if (!/^[A-Za-z0-9._:-]+$/.test(key)) return null;
  return key;
}

function publicError(error) {
  const message = String(error?.message || "OPERATION_FAILED");
  const safe = [
    "Content runtime is disabled",
    "Content runtime is not ready",
    "Content brief not found",
    "Draft not found",
    "Draft has no approval request",
    "Approval request is not pending",
    "Human reviewer is required",
    "Approval decision must be APPROVED or REJECTED",
    "Human approval is required before scheduling",
    "Publish Engine must be enabled before content scheduling",
    "Publish Engine must be enabled for end-to-end dry-run",
    "End-to-end dry-run requires explicit APPROVED human decision",
    "End-to-end content run requires Publish Engine dry-run",
    "Live content scheduling is not approved",
    "Unknown social account",
  ].find(prefix => message.startsWith(prefix));
  return safe || "OPERATION_FAILED";
}

function createContentControl({
  enabled = false,
  token = "",
  runtime,
  store,
} = {}) {
  if (!runtime) throw new Error("Content control requires content runtime");
  if (!store) throw new Error("Content control requires idempotency store");

  let ready = false;
  let lastError = null;

  async function init() {
    if (!enabled) return { status: "skipped", reason: "CONTENT_CONTROL_DISABLED" };
    if (normalizeSecret(token).length < 32) {
      lastError = "CONTENT_CONTROL_TOKEN_TOO_SHORT";
      throw new Error(lastError);
    }
    const runtimeHealth = runtime.health?.() || {};
    if (!runtimeHealth.enabled || !runtimeHealth.ready) {
      lastError = "CONTENT_RUNTIME_NOT_READY";
      throw new Error(lastError);
    }
    const start = await store.init();
    if (!start?.ready || !store.isReady?.()) {
      lastError = start?.reason || "CONTENT_CONTROL_STORE_UNAVAILABLE";
      throw new Error(lastError);
    }
    ready = true;
    lastError = null;
    return { status: "ok", reason: "READY" };
  }

  function authenticate(authorizationHeader) {
    return enabled && ready && secureTokenMatch(token, authorizationHeader);
  }

  async function run({ operation, idempotencyKey, input = {} } = {}) {
    if (!enabled) return { httpStatus: 404, body: { status: "disabled" } };
    if (!ready) return { httpStatus: 503, body: { status: "unavailable" } };
    const key = normalizeIdempotencyKey(idempotencyKey);
    if (!key) return { httpStatus: 400, body: { status: "failed", reason: "IDEMPOTENCY_KEY_REQUIRED" } };

    const handlers = {
      generateBrief: () => runtime.generateBrief(input),
      generateDraft: () => runtime.generateDraft(input),
      reviewDraft: () => runtime.reviewDraft(input),
      decideApproval: () => runtime.decideApproval(input),
      scheduleApprovedDraft: () => runtime.scheduleApprovedDraft(input),
      runEndToEndDryRun: () => runtime.runEndToEndDryRun(input),
    };
    const handler = handlers[String(operation || "")];
    if (!handler) return { httpStatus: 404, body: { status: "failed", reason: "UNKNOWN_OPERATION" } };

    const claim = await store.begin(operation, key);
    if (!claim.claimed) {
      if (claim.reason === "DUPLICATE" && claim.existing?.status === "COMPLETED") {
        return { httpStatus: 200, body: { ...claim.existing.result, idempotentReplay: true } };
      }
      if (claim.reason === "DUPLICATE") {
        return { httpStatus: 409, body: { status: "duplicate", reason: claim.existing?.status || "PROCESSING" } };
      }
      return { httpStatus: 503, body: { status: "unavailable", reason: claim.reason || "IDEMPOTENCY_STORE_UNAVAILABLE" } };
    }

    try {
      const result = await handler();
      const stored = await store.complete(operation, key, result);
      if (!stored) {
        return { httpStatus: 503, body: { status: "ambiguous", reason: "IDEMPOTENCY_COMMIT_FAILED" } };
      }
      return { httpStatus: 200, body: result };
    } catch (error) {
      const reason = publicError(error);
      await store.fail(operation, key, reason);
      return { httpStatus: 400, body: { status: "failed", reason } };
    }
  }

  async function read({ resource, input = {} } = {}) {
    if (!enabled) return { httpStatus: 404, body: { status: "disabled" } };
    if (!ready) return { httpStatus: 503, body: { status: "unavailable" } };

    const handlers = {
      brief: () => runtime.getBrief(input.briefId),
      draft: () => runtime.getDraft(input.draftId),
      workflow: () => runtime.getWorkflowSnapshot({ draftId: input.draftId }),
    };
    const handler = handlers[String(resource || "")];
    if (!handler) return { httpStatus: 404, body: { status: "failed", reason: "UNKNOWN_RESOURCE" } };

    try {
      const result = await handler();
      if (!result) return { httpStatus: 404, body: { status: "not_found" } };
      return { httpStatus: 200, body: result };
    } catch (error) {
      const reason = publicError(error);
      const notFound = reason === "Content brief not found" || reason === "Draft not found";
      return { httpStatus: notFound ? 404 : 400, body: { status: "failed", reason } };
    }
  }

  async function close() {
    ready = false;
    await store.close?.();
  }

  function health() {
    return {
      enabled: Boolean(enabled),
      ready: Boolean(ready),
      tokenConfigured: normalizeSecret(token).length >= 32,
      lastError,
      store: store.health?.() || null,
      readSide: true,
      e2eDryRun: runtime.health?.().e2eDryRun || null,
    };
  }

  return { init, close, authenticate, run, read, health };
}

module.exports = {
  createContentControl,
  secureTokenMatch,
  normalizeIdempotencyKey,
  publicError,
};
