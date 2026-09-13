const test = require("node:test");
const assert = require("node:assert/strict");
const {
  createContentControl,
  secureTokenMatch,
  normalizeIdempotencyKey,
} = require("../app/content/contentControl");
const { createContentControlStore } = require("../app/content/contentControlStore");
const { createContentControlRouter } = require("../app/content/contentControlRouter");

const TOKEN = "0123456789abcdef0123456789abcdef";

function runtime({ enabled = true, ready = true } = {}) {
  const calls = [];
  return {
    calls,
    health: () => ({ enabled, ready }),
    async generateBrief(input) { calls.push(["generateBrief", input]); return { status: "ok", briefId: "b1" }; },
    async generateDraft(input) { calls.push(["generateDraft", input]); return { status: "ok", draftId: "d1" }; },
    async reviewDraft(input) { calls.push(["reviewDraft", input]); return { status: "ok", workflowStatus: "AWAITING_APPROVAL" }; },
    async decideApproval(input) { calls.push(["decideApproval", input]); return { status: "APPROVED", draftId: input.draftId }; },
    async scheduleApprovedDraft(input) { calls.push(["scheduleApprovedDraft", input]); return { status: "SCHEDULED", draftId: input.draftId }; },
  };
}

function store({ ready = true } = {}) {
  const records = new Map();
  let initialized = false;
  let beginCalls = 0;
  return {
    records,
    get initialized() { return initialized; },
    get beginCalls() { return beginCalls; },
    async init() { initialized = true; return { ready }; },
    isReady: () => initialized && ready,
    async begin(operation, key) {
      beginCalls += 1;
      const id = `${operation}:${key}`;
      if (records.has(id)) return { claimed: false, reason: "DUPLICATE", existing: records.get(id) };
      records.set(id, { status: "PROCESSING" });
      return { claimed: true };
    },
    async complete(operation, key, result) {
      records.set(`${operation}:${key}`, { status: "COMPLETED", result });
      return true;
    },
    async fail(operation, key, reason) {
      records.set(`${operation}:${key}`, { status: "FAILED", reason });
      return true;
    },
    async close() { initialized = false; },
    health: () => ({ connected: initialized && ready }),
  };
}

test("content control token auth is constant-shape, Bearer-only, and requires at least 32 bytes", () => {
  assert.equal(secureTokenMatch(TOKEN, `Bearer ${TOKEN}`), true);
  assert.equal(secureTokenMatch(TOKEN, `bearer ${TOKEN}`), true);
  assert.equal(secureTokenMatch(TOKEN, TOKEN), false);
  assert.equal(secureTokenMatch(TOKEN, "Bearer wrong"), false);
  assert.equal(secureTokenMatch("short", "Bearer short"), false);
});

test("idempotency keys accept bounded machine-safe values only", () => {
  assert.equal(normalizeIdempotencyKey("req-1:abc.def"), "req-1:abc.def");
  assert.equal(normalizeIdempotencyKey(""), null);
  assert.equal(normalizeIdempotencyKey("contains spaces"), null);
  assert.equal(normalizeIdempotencyKey("x".repeat(129)), null);
});

test("disabled content control does not initialize a second Redis boundary", async () => {
  const state = store();
  const control = createContentControl({ enabled: false, token: TOKEN, runtime: runtime(), store: state });
  assert.deepEqual(await control.init(), { status: "skipped", reason: "CONTENT_CONTROL_DISABLED" });
  assert.equal(state.initialized, false);
  assert.equal(control.authenticate(`Bearer ${TOKEN}`), false);
  assert.equal(control.health().enabled, false);
});

test("enabled content control fails startup for a weak token or unready content runtime", async () => {
  const weak = createContentControl({ enabled: true, token: "short", runtime: runtime(), store: store() });
  await assert.rejects(() => weak.init(), /CONTENT_CONTROL_TOKEN_TOO_SHORT/);

  const unavailable = createContentControl({ enabled: true, token: TOKEN, runtime: runtime({ ready: false }), store: store() });
  await assert.rejects(() => unavailable.init(), /CONTENT_RUNTIME_NOT_READY/);
});

test("authenticated control executes a mutation once and replays the stored result", async () => {
  const rt = runtime();
  const state = store();
  const control = createContentControl({ enabled: true, token: TOKEN, runtime: rt, store: state });
  await control.init();
  assert.equal(control.authenticate(`Bearer ${TOKEN}`), true);

  const first = await control.run({ operation: "generateBrief", idempotencyKey: "request-1", input: { accountKey: "leo:threads" } });
  const second = await control.run({ operation: "generateBrief", idempotencyKey: "request-1", input: { accountKey: "leo:threads" } });
  assert.equal(first.httpStatus, 200);
  assert.equal(second.httpStatus, 200);
  assert.equal(second.body.idempotentReplay, true);
  assert.equal(rt.calls.length, 1);
  assert.equal(state.beginCalls, 2);
});

test("in-progress duplicate is fail-closed with 409 and never invokes runtime", async () => {
  const rt = runtime();
  const state = store();
  state.records.set("generateDraft:same-key", { status: "PROCESSING" });
  const control = createContentControl({ enabled: true, token: TOKEN, runtime: rt, store: state });
  await control.init();
  const result = await control.run({ operation: "generateDraft", idempotencyKey: "same-key", input: { briefId: "b" } });
  assert.equal(result.httpStatus, 409);
  assert.equal(result.body.status, "duplicate");
  assert.equal(rt.calls.length, 0);
});

test("missing idempotency key blocks mutations before runtime execution", async () => {
  const rt = runtime();
  const control = createContentControl({ enabled: true, token: TOKEN, runtime: rt, store: store() });
  await control.init();
  const result = await control.run({ operation: "decideApproval", idempotencyKey: "", input: {} });
  assert.equal(result.httpStatus, 400);
  assert.equal(result.body.reason, "IDEMPOTENCY_KEY_REQUIRED");
  assert.equal(rt.calls.length, 0);
});

test("an idempotency commit failure becomes ambiguous instead of inviting blind retry", async () => {
  const rt = runtime();
  const state = store();
  state.complete = async () => false;
  const control = createContentControl({ enabled: true, token: TOKEN, runtime: rt, store: state });
  await control.init();
  const result = await control.run({ operation: "scheduleApprovedDraft", idempotencyKey: "schedule-1", input: { draftId: "d1" } });
  assert.equal(result.httpStatus, 503);
  assert.deepEqual(result.body, { status: "ambiguous", reason: "IDEMPOTENCY_COMMIT_FAILED" });
  assert.equal(rt.calls.length, 1);
});

test("control does not leak arbitrary runtime errors to callers", async () => {
  const rt = runtime();
  rt.generateBrief = async () => { throw new Error("postgresql://secret@host private stack detail"); };
  const control = createContentControl({ enabled: true, token: TOKEN, runtime: rt, store: store() });
  await control.init();
  const result = await control.run({ operation: "generateBrief", idempotencyKey: "safe-error", input: {} });
  assert.equal(result.httpStatus, 400);
  assert.deepEqual(result.body, { status: "failed", reason: "OPERATION_FAILED" });
});

test("content control router can be composed without exposing a route when server gate is off", () => {
  const control = createContentControl({ enabled: false, token: TOKEN, runtime: runtime(), store: store() });
  const router = createContentControlRouter({ control });
  assert.equal(typeof router, "function");
});

test("dedicated content control Redis store fails closed before init", async () => {
  const state = createContentControlStore({ redisUrl: null });
  assert.deepEqual(await state.init(), { ready: false, reason: "REDIS_URL_MISSING" });
  assert.equal((await state.begin("x", "y")).reason, "STORE_UNAVAILABLE");
  assert.equal(state.health().connected, false);
});
